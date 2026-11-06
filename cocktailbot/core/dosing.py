"""Rezeptlogik: Skalierung auf Groesse/Staerke, Verfuegbarkeit, Pumpenplan.

Reines Rechnen, keine Hardware. Dadurch leicht testbar.
"""

from __future__ import annotations

from dataclasses import dataclass, field


DEFAULT_START_SPACING_MS = 100   # Versatz beim Start, wie im Originalaufbau


@dataclass
class PlanItem:
    ingredient_id: int
    ingredient_name: str
    amount_ml: float
    manual: bool
    pump_id: int | None = None
    gpio_pin: int | None = None
    duration_s: float = 0.0
    delayed: bool = False
    start_offset_s: float = 0.0
    instruction: str = ""


@dataclass
class Plan:
    recipe_id: int
    recipe_name: str
    size_ml: float
    items: list[PlanItem] = field(default_factory=list)
    instructions: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    hardware_ok: bool = True   # False = Pumpe fehlt/deaktiviert/unkalibriert
    level_ok: bool = True      # False = nur Fuellstand zu niedrig

    @property
    def ok(self) -> bool:
        return not self.errors

    @property
    def auto_items(self) -> list[PlanItem]:
        return [i for i in self.items if not i.manual]

    @property
    def manual_items(self) -> list[PlanItem]:
        return [i for i in self.items if i.manual]

    @property
    def total_duration_s(self) -> float:
        """Gesamtdauer bei ueberlappendem Start (nicht die Summe)."""
        if not self.auto_items:
            return 0.0
        return max(i.start_offset_s + i.duration_s for i in self.auto_items)


def _index(items: list[dict]) -> dict[int, dict]:
    return {int(i["id"]): i for i in items}


def scale_recipe(recipe: dict, size_ml: float, strength: float = 1.0) -> list[dict]:
    """Skaliert die Rezeptzutaten auf die gewuenschte Gesamtgroesse.

    Bezugsgroesse ist base_volume_ml (falls gesetzt), sonst die Summe der
    Zutaten. strength (0.5..1.5) veraendert den Anteil alkoholischer Zutaten;
    die Gesamtmenge bleibt konstant (alkoholfreie Zutaten gleichen aus).
    """
    ings = recipe.get("ingredients", [])
    base_total = float(recipe.get("base_volume_ml") or 0) or \
        sum(float(i["amount_ml"]) for i in ings) or 1.0
    factor = float(size_ml) / base_total

    scaled = []
    for i in ings:
        scaled.append({
            "ingredient_id": int(i["ingredient_id"]),
            "amount_ml": float(i["amount_ml"]) * factor,
            "manual": bool(i.get("manual", False)),
            "alcoholic": bool(i.get("alcoholic", False)),
            "delayed": bool(i.get("delayed", False)),
            "instruction": str(i.get("instruction", "")),
        })

    if abs(strength - 1.0) > 1e-6:
        alc = [i for i in scaled if i["alcoholic"]]
        non = [i for i in scaled if not i["alcoholic"]]
        if alc and non:
            delta = 0.0
            for i in alc:
                new_amount = i["amount_ml"] * strength
                delta += new_amount - i["amount_ml"]
                i["amount_ml"] = new_amount
            # Differenz auf die alkoholfreien Zutaten verteilen (Gesamtmenge halten)
            non_total = sum(i["amount_ml"] for i in non) or 1.0
            for i in non:
                share = i["amount_ml"] / non_total
                i["amount_ml"] = max(0.0, i["amount_ml"] - delta * share)
    return scaled


def build_plan(recipe: dict, size_ml: float, strength: float,
               ingredients: list[dict], pumps: list[dict]) -> Plan:
    ing_by_id = _index(ingredients)
    pump_by_ing = {int(p["ingredient_id"]): p
                   for p in pumps if p.get("ingredient_id") is not None}

    plan = Plan(
        recipe_id=int(recipe["id"]),
        recipe_name=recipe.get("name", ""),
        size_ml=float(size_ml),
        instructions=list(recipe.get("instructions", recipe.get("manualNotes", []))),
    )

    # "alcoholic" pro Zutat aus dem Alkoholgehalt der Zutat ableiten, damit es
    # nicht doppelt gepflegt werden muss.
    enriched = {**recipe, "ingredients": [
        {**i, "alcoholic": float((ing_by_id.get(int(i["ingredient_id"])) or {})
                                 .get("abv", 0) or 0) > 0}
        for i in recipe.get("ingredients", [])
    ]}
    scaled = scale_recipe(enriched, size_ml, strength)
    for s in scaled:
        iid = s["ingredient_id"]
        ing = ing_by_id.get(iid)
        if ing is None:
            plan.errors.append(f"Zutat {iid} unbekannt")
            continue

        name = ing.get("name", f"Zutat {iid}")
        amount = round(s["amount_ml"], 1)
        manual = s["manual"] or not ing.get("automatic", True)

        item = PlanItem(ingredient_id=iid, ingredient_name=name,
                        amount_ml=amount, manual=manual,
                        delayed=bool(s.get("delayed", False)),
                        instruction=str(s.get("instruction", "")))

        if not manual:
            pump = pump_by_ing.get(iid)
            if pump is None or not pump.get("enabled", True):
                plan.errors.append(f"Keine Pumpe für '{name}'")
                plan.hardware_ok = False   # Pumpe fehlt/deaktiviert -> ausblenden
            else:
                cal = float(pump.get("calibration_ml_per_s", 0) or 0)
                if cal <= 0:
                    plan.errors.append(f"'{name}' ist nicht kalibriert")
                    plan.hardware_ok = False
                else:
                    item.pump_id = int(pump["id"])
                    item.gpio_pin = int(pump["gpio_pin"])
                    item.duration_s = amount / cal
                # Füllstand pruefen (nur Stand -> weiter anzeigen, nur markieren)
                level = float(ing.get("level_ml", 0) or 0)
                if level < amount:
                    plan.errors.append(
                        f"'{name}': Füllstand zu niedrig "
                        f"({level:.0f} < {amount:.0f} ml)")
                    plan.level_ok = False
        plan.items.append(item)

    _assign_offsets(plan, DEFAULT_START_SPACING_MS / 1000.0)
    return plan


def _assign_offsets(plan: Plan, spacing_s: float) -> None:
    """Startzeiten wie im Originalaufbau: normale Zutaten versetzt parallel,
    'delayed'-Zutaten erst nach dem Ende der normalen (ebenfalls versetzt)."""
    auto = [i for i in plan.items if not i.manual and i.gpio_pin is not None]
    normal = [i for i in auto if not i.delayed]
    delayed = [i for i in auto if i.delayed]

    normal_end = 0.0
    for idx, item in enumerate(normal):
        item.start_offset_s = idx * spacing_s
        normal_end = max(normal_end, item.start_offset_s + item.duration_s)
    for idx, item in enumerate(delayed):
        item.start_offset_s = normal_end + idx * spacing_s


def is_available(recipe: dict, ingredients: list[dict], pumps: list[dict],
                 default_size_ml: float) -> tuple[bool, list[str]]:
    """Schnelle Pruefung für die Kartenanzeige (ohne Staerke-Anpassung)."""
    plan = build_plan(recipe, default_size_ml, 1.0, ingredients, pumps)
    return plan.ok, plan.errors


def calc_abv(recipe: dict, ingredients: list[dict]) -> float:
    ing_by_id = _index(ingredients)
    total = 0.0
    alcohol = 0.0
    for i in recipe.get("ingredients", []):
        amount = float(i["amount_ml"])
        total += amount
        ing = ing_by_id.get(int(i["ingredient_id"]))
        if ing:
            alcohol += amount * float(ing.get("abv", 0) or 0) / 100.0
    if total <= 0:
        return 0.0
    return round(alcohol / total * 100.0, 1)
