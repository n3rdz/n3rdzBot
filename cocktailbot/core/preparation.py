"""Ausfuehrung von Zubereitung, Reinigung und Entlueftung in einem Worker-Thread.

Es läuft immer nur EIN Job gleichzeitig. Der Status wird für das Frontend
(Polling) und für API-Aufrufe bereitgestellt.
"""

from __future__ import annotations

import threading
import time

from . import storage
from .dosing import build_plan, Plan


class PreparationManager:
    def __init__(self, pumps, leds, settings_getter):
        self._pumps = pumps
        self._leds = leds
        self._get_settings = settings_getter
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._status = {
            "state": "idle",      # idle | running | done | error
            "job": None,          # prepare | clean | vent
            "title": "",
            "progress": 0.0,      # 0..100
            "message": "",
            "items": [],          # alle automatisch dosierten Zutaten (waehrend Zubereitung)
            "manual": [],         # manuelle Zutaten + Hinweise (nach Zubereitung)
            "instructions": [],
            "started": None,
            "recipe_id": None,
        }

    # ----- Status --------------------------------------------------------
    @property
    def busy(self) -> bool:
        with self._lock:
            return self._status["state"] == "running"

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    def _set(self, **kw):
        with self._lock:
            self._status.update(kw)

    def stop(self):
        """Not-Aus: laufenden Job abbrechen, alle Pumpen aus."""
        self._stop.set()
        self._pumps.all_off()

    # ----- Jobs starten --------------------------------------------------
    def start_prepare(self, recipe_id: int, size_ml: float, strength: float) -> dict:
        if self.busy:
            return {"ok": False, "error": "Es läuft bereits eine Aktion."}

        recipes = storage.load("recipes", [])
        ingredients = storage.load("ingredients", [])
        pumps = storage.load("pumps", [])
        recipe = next((r for r in recipes if int(r["id"]) == int(recipe_id)), None)
        if recipe is None:
            return {"ok": False, "error": "Rezept nicht gefunden."}

        plan = build_plan(recipe, size_ml, strength, ingredients, pumps)
        if not plan.ok:
            return {"ok": False, "error": "; ".join(plan.errors)}

        self._launch(self._run_prepare, (plan,),
                     job="prepare", title=plan.recipe_name, recipe_id=plan.recipe_id)
        return {"ok": True, "title": plan.recipe_name,
                "duration_s": round(plan.total_duration_s, 1)}

    def start_clean(self, pump_ids: list[int], duration_s: float) -> dict:
        if self.busy:
            return {"ok": False, "error": "Es läuft bereits eine Aktion."}
        pumps = storage.load("pumps", [])
        selected = [p for p in pumps if int(p["id"]) in set(pump_ids)] if pump_ids else pumps
        if not selected:
            return {"ok": False, "error": "Keine Pumpen ausgewählt."}
        self._launch(self._run_simple, (selected, float(duration_s), "Reinigung"),
                     job="clean", title="Reinigung")
        return {"ok": True}

    def start_vent(self, pump_ids: list[int], duration_s: float) -> dict:
        """Entlüften: Schläuche befüllen, bis Flüssigkeit kommt."""
        if self.busy:
            return {"ok": False, "error": "Es läuft bereits eine Aktion."}
        pumps = storage.load("pumps", [])
        selected = [p for p in pumps if int(p["id"]) in set(pump_ids)] if pump_ids else pumps
        if not selected:
            return {"ok": False, "error": "Keine Pumpen ausgewählt."}
        self._launch(self._run_simple, (selected, float(duration_s), "Entlüften"),
                     job="vent", title="Entlüften")
        return {"ok": True}

    # ----- intern --------------------------------------------------------
    def _launch(self, target, args, job, title, recipe_id=None):
        self._stop.clear()
        self._set(state="running", job=job, title=title, progress=0.0,
                  message="Start...", items=[], manual=[], instructions=[],
                  started=time.time(), recipe_id=recipe_id)
        if self._leds:
            self._leds.busy()
        self._thread = threading.Thread(target=self._wrap, args=(target, args), daemon=True)
        self._thread.start()

    def _wrap(self, target, args):
        try:
            target(*args)
            if self._stop.is_set():
                self._set(state="idle", message="Abgebrochen", progress=0.0)
                if self._leds:
                    self._leds.ready()
        except Exception as exc:  # pragma: no cover
            self._pumps.all_off()
            self._set(state="error", message=f"Fehler: {exc}")
            if self._leds:
                self._leds.error()

    def _run_prepare(self, plan: Plan):
        if self._leds:
            self._leds.blink(255, 0, 0)

        auto = plan.auto_items
        total = plan.total_duration_s or 1.0

        # Alle automatisch dosierten Zutaten einmal fuer die Anzeige setzen,
        # damit nicht nur eine (durch Ueberschreiben) sichtbar ist.
        items = [{"name": it.ingredient_name, "amount_ml": round(it.amount_ml),
                  "delayed": it.delayed, "done": False} for it in auto]
        self._set(items=items, message="Dosiere Zutaten …")
        idx_of = {id(it): n for n, it in enumerate(auto)}

        # Jede Pumpe läuft in einem eigenen Thread und startet nach ihrem
        # Startversatz (ueberlappend, wie im Originalaufbau).
        threads: list[threading.Thread] = []

        def run_item(item):
            # Startversatz abwarten (abbrechbar)
            t0 = time.monotonic()
            while time.monotonic() - t0 < item.start_offset_s:
                if self._stop.is_set():
                    return
                time.sleep(0.01)
            if self._stop.is_set():
                return
            if item.delayed:
                self._set(message=f"{item.ingredient_name} – zum Schluss")
            self._pumps.run_for(item.gpio_pin, item.duration_s, self._stop)
            with self._lock:
                n = idx_of.get(id(item))
                if n is not None and n < len(self._status["items"]):
                    self._status["items"][n]["done"] = True

        start = time.monotonic()
        for item in auto:
            th = threading.Thread(target=run_item, args=(item,), daemon=True)
            th.start()
            threads.append(th)

        # Fortschritt anhand der verstrichenen Zeit
        while any(t.is_alive() for t in threads):
            if self._stop.is_set():
                break
            elapsed = time.monotonic() - start
            self._set(progress=min(99.0, elapsed / total * 100.0))
            time.sleep(0.1)
        for t in threads:
            t.join(timeout=0.5)

        self._pumps.all_off()

        # Fuellstaende reduzieren (nur wenn nicht abgebrochen)
        ingredients = storage.load("ingredients", [])
        ing_by_id = {int(i["id"]): i for i in ingredients}
        if not self._stop.is_set():
            for item in auto:
                ing = ing_by_id.get(item.ingredient_id)
                if ing is not None:
                    ing["level_ml"] = max(
                        0.0, float(ing.get("level_ml", 0)) - item.amount_ml)
            storage.save("ingredients", ingredients)

        if not self._stop.is_set():
            self._record_stat(plan)
            manual = [{"name": m.ingredient_name, "amount_ml": m.amount_ml,
                       "instruction": m.instruction}
                      for m in plan.manual_items]
            self._set(state="done", progress=100.0, message="Fertig!",
                      manual=manual, instructions=plan.instructions)
            if self._leds:
                if hasattr(self._leds, "done"):
                    self._leds.done()
                self._leds.ready()

    def _run_simple(self, pumps_list, duration_s, label):
        """Reinigung/Entlüften: jede Pumpe nacheinander für duration_s."""
        n = len(pumps_list)
        for idx, p in enumerate(pumps_list):
            if self._stop.is_set():
                break
            name = p.get("name") or f"Pumpe {p['id']}"
            self._set(message=f"{label}: {name}", progress=idx / n * 100.0)
            self._pumps.run_for(int(p["gpio_pin"]), duration_s, self._stop)
        self._pumps.all_off()
        if not self._stop.is_set():
            self._set(state="done", progress=100.0, message=f"{label} abgeschlossen")
            if self._leds:
                self._leds.ready()

    def _record_stat(self, plan: Plan):
        stats = storage.load("stats", {"total": 0, "per_recipe": {}, "volume_ml": 0})
        stats["total"] = int(stats.get("total", 0)) + 1
        key = str(plan.recipe_id)
        stats.setdefault("per_recipe", {})
        stats["per_recipe"][key] = int(stats["per_recipe"].get(key, 0)) + 1
        stats["volume_ml"] = round(float(stats.get("volume_ml", 0)) + plan.size_ml, 1)
        # Einzelereignis mit Zeitstempel fuer den Zeitverlauf (begrenzte Laenge).
        events = stats.setdefault("events", [])
        events.append({"t": int(time.time()), "id": plan.recipe_id,
                       "ml": round(float(plan.size_ml), 1)})
        if len(events) > 5000:
            del events[:len(events) - 5000]
        storage.save("stats", stats)

    def acknowledge(self):
        """Fertig-Dialog quittieren -> zurueck auf idle."""
        with self._lock:
            if self._status["state"] in ("done", "error"):
                self._status.update(state="idle", progress=0.0, message="",
                                    manual=[], instructions=[])
