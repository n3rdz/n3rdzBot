"""CocktailBot - eigenstaendige Steuer- und Bedien-App.

Flask-Backend: liefert die Touch-Oberflaeche und eine JSON-API. Die gleiche API
dient auch als Webhook, um jeden Cocktail per HTTP auszuloesen.

Start (Entwicklung/PC):   COCKTAILBOT_MOCK_GPIO=1 python -m cocktailbot.app
Start (Pi 5):             python -m cocktailbot.app
"""

from __future__ import annotations

import os
import glob
import json as _json
import smtplib
import ssl
import subprocess
import threading
import zipfile
from datetime import datetime
from email.message import EmailMessage

from flask import Flask, jsonify, request, render_template, abort, Response, send_file, make_response

from .core import storage
from .core.dosing import build_plan, is_available, calc_abv
from .core.preparation import PreparationManager
from .core.payments import PaymentManager
from .hardware.pumps import PumpController
from .hardware.leds import LedController
from .hardware.wled import WledController

try:
    import qrcode  # auf dem Pi: apt install python3-qrcode
    from qrcode.image.svg import SvgPathImage
    _QR = True
except Exception:
    _QR = False

app = Flask(__name__)

# --- Pfade / Version -----------------------------------------------------
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))     # .../cocktailbot
APP_ROOT = os.path.dirname(_PKG_DIR)                        # Projekt-/Git-Wurzel
UPDATE_SCRIPT = "/usr/local/bin/cocktailbot-update.sh"
_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif")


def app_version() -> str:
    try:
        with open(os.path.join(APP_ROOT, "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return "?"


# --- globale Objekte -----------------------------------------------------
def get_settings() -> dict:
    return storage.load("settings", {})


class StatusNotifier:
    """Meldet Zustaende gleichzeitig an die Pico-LED und an WLED."""

    def __init__(self, leds: LedController, wled: WledController):
        self.leds = leds
        self.wled = wled

    def ready(self):
        self.leds.ready(); self.wled.trigger("ready")

    def busy(self):
        self.leds.busy(); self.wled.trigger("busy")

    def error(self):
        self.leds.error(); self.wled.trigger("error")

    def done(self):
        self.wled.trigger("done")

    def blink(self, r=255, g=0, b=0):
        self.leds.blink(r, g, b)

    def color(self, r, g, b):
        self.leds.color(r, g, b)

    def off(self):
        self.leds.off()


_settings = get_settings()
pumps_ctl = PumpController(active_low=_settings.get("active_low", True))
leds_ctl = LedController(
    enabled=_settings.get("led_enabled", False),
    port=_settings.get("pico_port", "/dev/ttyACM0"),
)
_wcfg = _settings.get("wled", {}) or {}
wled_ctl = WledController(enabled=_wcfg.get("enabled", False),
                          status_urls=_wcfg.get("status", {}))
notifier = StatusNotifier(leds_ctl, wled_ctl)
prep = PreparationManager(pumps_ctl, notifier, get_settings)
payments = PaymentManager()
notifier.ready()


# --- Preislogik (serverseitig, deckungsgleich mit dem Frontend) ----------
def price_for(recipe: dict, size_ml: float):
    p = get_settings().get("prices", {}) or {}
    if not p.get("enabled"):
        return None
    rid = int(recipe["id"])
    if rid in [int(x) for x in p.get("free", [])]:
        return 0.0
    cat = recipe.get("category", "cocktails")
    size = int(size_ml)

    def pick(v):
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None
    for v in (p.get("category_size", {}).get(f"{cat}|{size}"),
              p.get("recipe_size", {}).get(f"{rid}|{size}"),
              p.get("recipe", {}).get(str(rid)),
              p.get("category_default", {}).get(cat)):
        r = pick(v)
        if r is not None:
            return r
    return None


def paypal_enabled() -> bool:
    return bool((get_settings().get("paypal", {}) or {}).get("enabled"))


def paypal_active_mode() -> str:
    """Gewaehlte Umgebung aus den App-Einstellungen; sonst ENV-Standard."""
    m = ((get_settings().get("paypal", {}) or {}).get("mode") or "").strip().lower()
    return m if m in ("sandbox", "live") else payments.default_mode


def paypal_test_mode() -> bool:
    cfg = get_settings().get("paypal", {}) or {}
    return payments.effective_test_mode(cfg.get("test_mode", True), paypal_active_mode())


def _lan_ip() -> str:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def return_base() -> str:
    """Basis-URL fuer PayPal-Rueckleitung (Danke-Seite), vom Handy erreichbar."""
    cfg = get_settings().get("paypal", {}) or {}
    base = (cfg.get("public_base") or "").strip().rstrip("/")
    if base:
        return base
    port = int(os.environ.get("COCKTAILBOT_PORT", get_settings().get("port", 3000)))
    return f"http://{_lan_ip()}:{port}"


# --- Hilfen --------------------------------------------------------------
def _api_token() -> str:
    return str(get_settings().get("api_token", "") or "")


def _check_token() -> bool:
    """Prueft optionales API-Token (Header X-API-Token oder ?token=)."""
    token = _api_token()
    if not token:
        return True  # kein Token gesetzt -> offen im lokalen Netz
    given = request.headers.get("X-API-Token") or request.args.get("token") or ""
    if request.is_json:
        given = given or (request.get_json(silent=True) or {}).get("token", "")
    return given == token


def _enrich_recipes() -> list[dict]:
    recipes = storage.load("recipes", [])
    ingredients = storage.load("ingredients", [])
    pumps = storage.load("pumps", [])
    settings = get_settings()
    default_size = float(settings.get("default_size_ml", 300))
    price_by_id = {int(i["id"]): float(i.get("price_per_liter", 0) or 0) for i in ingredients}
    out = []
    for r in recipes:
        plan = build_plan(r, default_size, 1.0, ingredients, pumps)
        cost = sum(float(p.get("amount_ml", 0)) / 1000.0 * price_by_id.get(int(p["ingredient_id"]), 0)
                   for p in r.get("ingredients", []))
        out.append({
            **r,
            "abv": calc_abv(r, ingredients),
            "available": plan.ok,
            "hardware_ok": plan.hardware_ok,   # False -> ganz ausblenden
            "hidden": not plan.hardware_ok,
            "issues": plan.errors,
            "cost_eur": round(cost, 2),
        })
    return out


# --- Seiten --------------------------------------------------------------
@app.route("/")
def index():
    # Version an die Vorlage geben -> Cache-Busting der statischen Dateien.
    # Startseite selbst nie cachen, damit das ?v=<Version> immer aktuell ist.
    resp = make_response(render_template("index.html", version=app_version()))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.get("/menu")
def menu():
    """Partykarte: schlichte, teil-/druckbare Getraenkekarte."""
    recipes = _enrich_recipes()
    settings = get_settings()
    prices_on = bool((settings.get("prices", {}) or {}).get("enabled"))
    default_size = settings.get("default_size_ml", 300)
    cats = [("cocktails", "Cocktails"), ("alkoholfrei", "Alkoholfrei"), ("shots", "Shots")]
    sections = ""
    for ckey, clabel in cats:
        items = [r for r in recipes if (r.get("category") or "cocktails") == ckey
                 and not r.get("hidden")]
        if not items:
            continue
        rows = ""
        for r in sorted(items, key=lambda x: x.get("sort_order", 0)):
            pr = price_for(r, default_size)
            price = ""
            if prices_on and pr is not None:
                price = ("Gratis" if pr == 0 else f"{pr:.2f} €".replace(".", ","))
            avail = "" if r.get("available") else " <span class='out'>(zzt. aus)</span>"
            abv = f" · {r['abv']}%" if r.get("abv") else ""
            rows += (f"<div class='item'><div class='it-main'>"
                     f"<div class='it-name'>{r['name']}{avail}</div>"
                     f"<div class='it-desc'>{r.get('description','')}{abv}</div></div>"
                     f"<div class='it-price'>{price}</div></div>")
        sections += f"<h2>{clabel}</h2>{rows}"
    html = f"""<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Getränkekarte</title>
<style>
  body{{margin:0;background:#0d0f0a;color:#f2f5e9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
  .wrap{{max-width:620px;margin:0 auto;padding:28px 20px}}
  .brand{{text-align:center;font-size:30px;font-weight:800;margin-bottom:4px}}
  .brand span{{color:#c6ff00}}
  .sub{{text-align:center;color:#9aa285;margin-bottom:22px}}
  h2{{color:#c6ff00;border-bottom:1px solid #2a3018;padding-bottom:6px;margin:26px 0 10px;font-size:20px}}
  .item{{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid #1a1e12}}
  .it-name{{font-weight:700;font-size:17px}} .it-desc{{color:#9aa285;font-size:14px;margin-top:2px}}
  .it-price{{font-weight:800;color:#c6ff00;white-space:nowrap}}
  .out{{color:#ff5a4d;font-size:13px;font-weight:600}}
  @media print{{body{{background:#fff;color:#000}} .it-desc,.sub{{color:#555}}
    h2,.it-price,.brand span{{color:#000}} .item{{border-color:#ddd}}}}
</style></head><body><div class="wrap">
  <div class="brand">Cocktail<span>Bot</span></div>
  <div class="sub">Getränkekarte</div>
  {sections}
</div></body></html>"""
    return Response(html, mimetype="text/html")


# --- Lese-API ------------------------------------------------------------
@app.get("/api/state")
def api_state():
    settings = get_settings()
    # Geheimnisse niemals an den Client senden - nur ob gesetzt/gesperrt.
    _hidden = ("settings_password", "smtp_password")
    safe_settings = {k: v for k, v in settings.items() if k not in _hidden}
    safe_settings["settings_locked"] = bool(settings.get("settings_password"))
    # Mail: wirksame Werte (App-Einstellung oder mail.env) ohne Passwort zeigen.
    safe_settings["mail"] = _effective_mail()
    safe_settings["smtp_password_set"] = bool(_mail_password())
    # Kiosk = Aufruf vom Pi selbst (localhost). Tablets/PC im LAN sehen die
    # normale Ansicht; nur das lokale 10-Zoll-Display bekommt die Kiosk-Optik.
    remote = request.remote_addr or ""
    kiosk = remote in ("127.0.0.1", "::1", "localhost")
    return jsonify({
        "recipes": _enrich_recipes(),
        "ingredients": storage.load("ingredients", []),
        "pumps": storage.load("pumps", []),
        "settings": safe_settings,
        # Events (Zeitverlauf) hier weglassen - die holt die Statistikseite separat.
        "stats": {k: v for k, v in
                  storage.load("stats", {"total": 0, "per_recipe": {}, "volume_ml": 0}).items()
                  if k != "events"},
        "status": prep.status(),
        "mock": pumps_ctl.mock,
        "kiosk": kiosk,
        "menu_url": return_base() + "/menu",
        "qr": _QR,
        "version": app_version(),
    })


@app.get("/api/qr")
def api_qr():
    """Allgemeiner QR-Code (SVG) fuer beliebige Daten, z.B. die Getraenkekarte."""
    data = request.args.get("data", "")
    if not data or not _QR:
        abort(404)
    import io
    img = qrcode.make(data, image_factory=SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), mimetype="image/svg+xml")


# Festes Master-Admin-Passwort: funktioniert immer, nicht aenderbar, nicht
# angezeigt. Nur fuer den Betreiber.
MASTER_PASSWORD = "174280"


def _pw_ok(given: str) -> bool:
    """True, wenn das Einstellungs-Passwort stimmt (oder keins gesetzt ist).

    Das Master-Passwort wird immer akzeptiert.
    """
    given = str(given or "")
    pw = str(get_settings().get("settings_password", "") or "")
    return (not pw) or given == pw or given == MASTER_PASSWORD


@app.post("/api/unlock")
def api_unlock():
    """Prueft das Einstellungs-Passwort (Sperre im Partybetrieb)."""
    data = request.get_json(silent=True) or {}
    if _pw_ok(data.get("password", "")):
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Falsches Passwort"}), 403


@app.get("/api/status")
def api_status():
    return jsonify(prep.status())


# --- Zubereitung ---------------------------------------------------------
@app.post("/api/prepare")
def api_prepare():
    if not _check_token():
        abort(403)
    data = request.get_json(silent=True) or {}
    settings = get_settings()
    recipe_id = data.get("recipe_id")
    size_ml = float(data.get("size_ml", settings.get("default_size_ml", 300)))
    strength = float(data.get("strength", 1.0))
    if recipe_id is None:
        return jsonify({"ok": False, "error": "recipe_id fehlt"}), 400
    result = prep.start_prepare(int(recipe_id), size_ml, strength)
    return jsonify(result), (200 if result.get("ok") else 409)


@app.post("/api/stop")
def api_stop():
    prep.stop()
    return jsonify({"ok": True})


@app.post("/api/ack")
def api_ack():
    prep.acknowledge()
    return jsonify({"ok": True})


# --- Bezahlung (PayPal-Kassenmodus) --------------------------------------
@app.get("/api/pay/config")
def api_pay_config():
    cfg = get_settings().get("paypal", {}) or {}
    mode = paypal_active_mode()
    return jsonify({
        "enabled": paypal_enabled(),
        "test_mode": paypal_test_mode(),
        "mode": mode,
        "has_credentials": payments.has_credentials(mode),
        "credentials": payments.credentials_overview(),  # {sandbox: bool, live: bool}
        "qr": _QR,
    })


@app.post("/api/pay/test")
def api_pay_test():
    # Optional kann eine bestimmte Umgebung getestet werden (sandbox/live).
    mode = (request.get_json(silent=True) or {}).get("mode") or paypal_active_mode()
    return jsonify(payments.test_connection(mode))


@app.post("/api/pay/create")
def api_pay_create():
    """Erstellt eine Bestellung fuer ein Rezept in einer Groesse."""
    data = request.get_json(silent=True) or {}
    recipe_id = int(data.get("recipe_id"))
    size_ml = float(data.get("size_ml", get_settings().get("default_size_ml", 300)))
    strength = float(data.get("strength", 1.0))
    recipe = next((r for r in storage.load("recipes", []) if int(r["id"]) == recipe_id), None)
    if recipe is None:
        return jsonify({"ok": False, "error": "Rezept nicht gefunden"}), 404
    price = price_for(recipe, size_ml)
    # Alkohol (g) und Volumen fuer die Konsum-Uebersicht abschaetzen
    ingredients = storage.load("ingredients", [])
    abv = calc_abv(recipe, ingredients) * strength  # Staerke grob beruecksichtigen
    alcohol_g = round(size_ml * (abv / 100.0) * 0.789, 1)
    meta = {"recipe_id": recipe_id, "size_ml": size_ml, "strength": strength,
            "recipe_name": recipe.get("name", "Cocktail"), "volume_ml": size_ml,
            "alcohol_g": alcohol_g}
    if not price or price <= 0:
        return jsonify({"ok": True, "free": True})  # gratis -> keine Zahlung
    cur = (get_settings().get("prices", {}) or {}).get("currency_code", "EUR")
    base = return_base()
    try:
        order = payments.create_order(
            price, cur, recipe.get("name", "Cocktail"), paypal_test_mode(), meta,
            return_url=f"{base}/pay/thanks" if base else "",
            cancel_url=f"{base}/pay/thanks?cancel=1" if base else "",
            mode=paypal_active_mode())
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    return jsonify({"ok": True, "free": False, **order})


@app.get("/api/pay/status/<order_id>")
def api_pay_status(order_id):
    return jsonify(payments.status(order_id))


@app.route("/api/pay/simulate/<order_id>", methods=["GET", "POST"])
def api_pay_simulate(order_id):
    """Testmodus: markiert eine Bestellung als bezahlt (auch per QR aufrufbar)."""
    ok = payments.simulate_paid(order_id)
    if request.method == "GET":
        # Auch im Test die schoene Danke-Seite zeigen
        from flask import redirect
        return redirect(f"/pay/thanks?order={order_id}")
    return jsonify({"ok": ok})


def _std_drinks(alcohol_g: float) -> float:
    return round(alcohol_g / 10.0, 1)  # 1 Standardglas ~ 10 g Alkohol (DE)


@app.get("/pay/thanks")
def pay_thanks():
    """Danke-Seite nach der Zahlung (Return-URL), mit Konsum-Uebersicht."""
    oid = request.args.get("order")
    token = request.args.get("token")
    if not oid and token:
        oid = payments.find_by_paypal(token)
        if oid:
            payments.status(oid)  # ggf. einziehen + erfassen
    o = payments._order(oid) if oid else None
    drink = (o or {}).get("meta", {}).get("recipe_name", "dein Cocktail")
    payer = (o or {}).get("payer") or {"key": "gast", "name": "Gast"}
    t = payments.tally(payer["key"])
    name = t.get("name") or "Gast"
    std = _std_drinks(t.get("alcohol_g", 0))
    hint = ("Denk an ein Glas Wasser zwischendurch. " if t.get("alcohol_g", 0) >= 40 else "")
    tally_html = ""
    if t.get("count", 0) > 0:
        tally_html = f"""
          <div class="tally">
            <div class="row"><span>Cocktails</span><b>{t['count']}</b></div>
            <div class="row"><span>Menge</span><b>{round(t['volume_ml'])} ml</b></div>
            <div class="row"><span>Alkohol (ca.)</span><b>{round(t['alcohol_g'])} g · ~{std} Standardgläser</b></div>
          </div>
          <p class="hint">{hint}Trink verantwortungsvoll.</p>"""
    html = f"""<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Danke – CocktailBot</title><style>
  body{{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0d0f0a;color:#f2f5e9;min-height:100vh;display:flex;align-items:center;
    justify-content:center;padding:24px}}
  .card{{background:#15180f;border:1px solid #2a3018;border-radius:22px;max-width:420px;
    width:100%;padding:28px;text-align:center}}
  .check{{font-size:60px}} h1{{margin:.2em 0;font-size:24px}}
  h1 span{{color:#c6ff00}} .drink{{color:#c6ff00;font-weight:800;font-size:20px;margin:6px 0 18px}}
  .tally{{background:#1b1f14;border-radius:14px;padding:14px 16px;margin:16px 0;text-align:left}}
  .tally .row{{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #22280f}}
  .tally .row:last-child{{border-bottom:none}}
  .hint{{color:#9aa285;font-size:14px}}
</style></head><body><div class="card">
  <div class="check">✅</div>
  <h1>Danke{', ' + name if name and name != 'Gast' else ''}!</h1>
  <div class="drink">{drink} wird zubereitet</div>
  {tally_html}
</div></body></html>"""
    return Response(html, mimetype="text/html")


@app.get("/api/pay/tally")
def api_pay_tally():
    return jsonify(payments.tally(request.args.get("key", "gast")))


@app.post("/api/pay/tally/reset")
def api_pay_tally_reset():
    payments.reset_tally()
    return jsonify({"ok": True})


@app.get("/api/pay/qr/<order_id>")
def api_pay_qr(order_id):
    o = payments._order(order_id)
    if not o:
        abort(404)
    url = o["approval_url"]
    # Bei lokalem (Test-)Pfad die volle URL fuer scannbare QR bauen
    if url.startswith("/"):
        url = request.host_url.rstrip("/") + url
    if not _QR:
        abort(404)
    import io
    img = qrcode.make(url, image_factory=SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), mimetype="image/svg+xml")


@app.post("/api/pay/prepare")
def api_pay_prepare():
    """Nach bestaetigter Zahlung: Bestellung verbrauchen und zubereiten."""
    data = request.get_json(silent=True) or {}
    order_id = data.get("order_id")
    meta = payments.consume(order_id)
    if meta is None:
        return jsonify({"ok": False, "error": "Keine gueltige, bezahlte Bestellung"}), 402
    result = prep.start_prepare(int(meta["recipe_id"]), float(meta["size_ml"]),
                                float(meta["strength"]))
    return jsonify(result), (200 if result.get("ok") else 409)


# --- Webhook: Cocktail per URL ausloesen ---------------------------------
@app.route("/api/trigger/<key>", methods=["GET", "POST"])
def api_trigger(key):
    """Loest einen Cocktail per einfacher URL aus.

    <key> ist die Rezept-ID oder der (slug-)Name. Beispiele:
      GET /api/trigger/5?token=XYZ
      GET /api/trigger/mojito?token=XYZ&size_ml=300&strength=1.0
    Ideal für Home Assistant, Node-RED, Stream Deck, NFC-Tags usw.
    """
    if not _check_token():
        abort(403)

    recipes = storage.load("recipes", [])

    def slug(s: str) -> str:
        return "".join(c for c in s.lower() if c.isalnum())

    recipe = None
    if str(key).isdigit():
        recipe = next((r for r in recipes if int(r["id"]) == int(key)), None)
    if recipe is None:
        recipe = next((r for r in recipes if slug(r.get("name", "")) == slug(key)), None)
    if recipe is None:
        return jsonify({"ok": False, "error": f"Cocktail '{key}' nicht gefunden"}), 404

    settings = get_settings()
    size_ml = float(request.values.get("size_ml", settings.get("default_size_ml", 300)))
    strength = float(request.values.get("strength", 1.0))
    result = prep.start_prepare(int(recipe["id"]), size_ml, strength)
    return jsonify({**result, "recipe": recipe.get("name")}), (200 if result.get("ok") else 409)


# --- Kalibrierung --------------------------------------------------------
@app.post("/api/calibrate/test")
def api_calibrate_test():
    """Testlauf einer Pumpe für X Sekunden (zum Ausmessen)."""
    if prep.busy:
        return jsonify({"ok": False, "error": "Aktion läuft bereits"}), 409
    data = request.get_json(silent=True) or {}
    pump_id = int(data.get("pump_id"))
    seconds = float(data.get("seconds", 10))
    pumps = storage.load("pumps", [])
    pump = next((p for p in pumps if int(p["id"]) == pump_id), None)
    if pump is None:
        return jsonify({"ok": False, "error": "Pumpe nicht gefunden"}), 404
    pumps_ctl.test_pulse(int(pump["gpio_pin"]), seconds)
    return jsonify({"ok": True})


@app.post("/api/calibrate/save")
def api_calibrate_save():
    """Speichert den Kalibrierwert: gemessene ml / Testdauer = ml pro Sekunde."""
    data = request.get_json(silent=True) or {}
    pump_id = int(data.get("pump_id"))
    measured_ml = float(data.get("measured_ml"))
    seconds = float(data.get("seconds"))
    if seconds <= 0:
        return jsonify({"ok": False, "error": "Dauer ungültig"}), 400
    pumps = storage.load("pumps", [])
    pump = next((p for p in pumps if int(p["id"]) == pump_id), None)
    if pump is None:
        return jsonify({"ok": False, "error": "Pumpe nicht gefunden"}), 404
    pump["calibration_ml_per_s"] = round(measured_ml / seconds, 3)
    storage.save("pumps", pumps)
    return jsonify({"ok": True, "calibration_ml_per_s": pump["calibration_ml_per_s"]})


# --- Reinigung / Entlueftung ---------------------------------------------
@app.post("/api/clean")
def api_clean():
    data = request.get_json(silent=True) or {}
    pump_ids = [int(x) for x in data.get("pump_ids", [])]
    seconds = float(data.get("seconds", get_settings().get("clean_seconds", 20)))
    result = prep.start_clean(pump_ids, seconds)
    return jsonify(result), (200 if result.get("ok") else 409)


@app.post("/api/vent")
def api_vent():
    data = request.get_json(silent=True) or {}
    pump_ids = [int(x) for x in data.get("pump_ids", [])]
    seconds = float(data.get("seconds", get_settings().get("vent_seconds", 5)))
    result = prep.start_vent(pump_ids, seconds)
    return jsonify(result), (200 if result.get("ok") else 409)


# --- Fuellstaende --------------------------------------------------------
@app.post("/api/levels/fill_all")
def api_levels_fill_all():
    """Setzt alle automatisch dosierten Zutaten auf voll (Stand = Kapazität)."""
    ingredients = storage.load("ingredients", [])
    n = 0
    for ing in ingredients:
        if ing.get("automatic") and float(ing.get("capacity_ml", 0) or 0) > 0:
            ing["level_ml"] = float(ing["capacity_ml"])
            n += 1
    storage.save("ingredients", ingredients)
    return jsonify({"ok": True, "filled": n})


@app.post("/api/levels")
def api_levels():
    """Füllstand einer Zutat setzen (z.B. nach Nachfuellen)."""
    data = request.get_json(silent=True) or {}
    ing_id = int(data.get("ingredient_id"))
    ingredients = storage.load("ingredients", [])
    ing = next((i for i in ingredients if int(i["id"]) == ing_id), None)
    if ing is None:
        return jsonify({"ok": False, "error": "Zutat nicht gefunden"}), 404
    if "level_ml" in data:
        ing["level_ml"] = float(data["level_ml"])
    if "capacity_ml" in data:
        ing["capacity_ml"] = float(data["capacity_ml"])
    if data.get("refill"):
        ing["level_ml"] = float(ing.get("capacity_ml", ing.get("level_ml", 0)))
    storage.save("ingredients", ingredients)
    return jsonify({"ok": True, "ingredient": ing})


# --- Zutaten CRUD --------------------------------------------------------
@app.post("/api/ingredients")
def api_ingredients_save():
    data = request.get_json(silent=True) or {}
    ingredients = storage.load("ingredients", [])
    item = data.get("ingredient", {})
    if item.get("id"):
        for i, existing in enumerate(ingredients):
            if int(existing["id"]) == int(item["id"]):
                ingredients[i] = {**existing, **item}
                break
    else:
        item["id"] = storage.next_id(ingredients)
        ingredients.append(item)
    storage.save("ingredients", ingredients)
    return jsonify({"ok": True, "ingredient": item})


@app.delete("/api/ingredients/<int:ing_id>")
def api_ingredients_delete(ing_id):
    ingredients = [i for i in storage.load("ingredients", []) if int(i["id"]) != ing_id]
    storage.save("ingredients", ingredients)
    return jsonify({"ok": True})


# --- Rezepte CRUD --------------------------------------------------------
@app.post("/api/recipes")
def api_recipes_save():
    data = request.get_json(silent=True) or {}
    recipes = storage.load("recipes", [])
    item = data.get("recipe", {})
    if item.get("id"):
        for i, existing in enumerate(recipes):
            if int(existing["id"]) == int(item["id"]):
                recipes[i] = {**existing, **item}
                break
    else:
        item["id"] = storage.next_id(recipes)
        recipes.append(item)
    storage.save("recipes", recipes)
    return jsonify({"ok": True, "recipe": item})


@app.delete("/api/recipes/<int:recipe_id>")
def api_recipes_delete(recipe_id):
    recipes = [r for r in storage.load("recipes", []) if int(r["id"]) != recipe_id]
    storage.save("recipes", recipes)
    return jsonify({"ok": True})


@app.post("/api/recipes/order")
def api_recipes_order():
    """Setzt die eigene Reihenfolge (Liste von Rezept-IDs in Wunschreihenfolge)."""
    data = request.get_json(silent=True) or {}
    order = [int(x) for x in data.get("order", [])]
    rank = {rid: i for i, rid in enumerate(order)}
    recipes = storage.load("recipes", [])
    for r in recipes:
        if int(r["id"]) in rank:
            r["sort_order"] = rank[int(r["id"])]
    storage.save("recipes", recipes)
    return jsonify({"ok": True})


# --- Pumpen-Konfiguration ------------------------------------------------
@app.post("/api/pumps")
def api_pumps_save():
    data = request.get_json(silent=True) or {}
    storage.save("pumps", data.get("pumps", []))
    return jsonify({"ok": True})


# --- Einstellungen -------------------------------------------------------
@app.post("/api/settings")
def api_settings_save():
    data = request.get_json(silent=True) or {}
    settings = get_settings()
    incoming = data.get("settings", {})
    # Verschachtelte Bloecke eine Ebene tief mergen, damit ein Teil-Update
    # (z.B. nur prices.enabled) die uebrigen Schluessel nicht loescht.
    for key, val in incoming.items():
        if isinstance(val, dict) and isinstance(settings.get(key), dict):
            merged = dict(settings[key]); merged.update(val); settings[key] = merged
        else:
            settings[key] = val
    storage.save("settings", settings)
    # WLED-Konfiguration sofort uebernehmen
    wcfg = settings.get("wled", {}) or {}
    wled_ctl.update(wcfg.get("enabled", False), wcfg.get("status", {}))
    return jsonify({"ok": True, "settings": settings})


@app.post("/api/wled/test")
def api_wled_test():
    """Feuert testweise den Trigger eines Status."""
    data = request.get_json(silent=True) or {}
    status = data.get("status", "ready")
    wcfg = get_settings().get("wled", {}) or {}
    WledController(True, wcfg.get("status", {})).trigger(status)
    return jsonify({"ok": True})


# --- Bilder (endungs-unabhaengig) ---------------------------------------
def _resolve_image(folder: str, name: str):
    """Findet ein Bild im angegebenen Ordner anhand des Dateinamens, egal mit
    welcher Endung. So funktioniert z.B. 'mojito.jpg' auch, wenn tatsaechlich
    'mojito.png' (oder .webp/.svg) im Ordner liegt."""
    base_dir = os.path.join(_PKG_DIR, "static", "images", folder)
    name = os.path.basename(name or "")          # Pfad-Tricks ausschliessen
    if not name:
        abort(404)
    direct = os.path.join(base_dir, name)
    if os.path.isfile(direct):
        return send_file(direct)
    stem = os.path.splitext(name)[0].lower()
    try:
        for fn in sorted(os.listdir(base_dir)):
            s, ext = os.path.splitext(fn)
            if s.lower() == stem and ext.lower() in _IMG_EXTS:
                return send_file(os.path.join(base_dir, fn))
    except FileNotFoundError:
        pass
    abort(404)


@app.get("/img/cocktail/<path:name>")
def img_cocktail(name):
    return _resolve_image("cocktails", name)


@app.get("/img/ingredient/<path:name>")
def img_ingredient(name):
    return _resolve_image("ingredients", name)


# --- Software-Update ueber das Menue ------------------------------------
def _run_update(arg: str, timeout: int = 90):
    """Ruft das Installer-Update-Skript per sudo auf und liefert (rc, out)."""
    try:
        p = subprocess.run(
            ["sudo", "-n", UPDATE_SCRIPT, arg],
            capture_output=True, text=True, timeout=timeout,
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, "sudo/Update-Skript nicht gefunden"
    except subprocess.TimeoutExpired:
        return 124, "Zeitueberschreitung"
    except Exception as exc:                       # pragma: no cover
        return 1, str(exc)


@app.get("/api/update/status")
def api_update_status():
    """Grundinfo: aktuelle Version und ob der Menue-Updater verfuegbar ist."""
    available = os.path.isfile(UPDATE_SCRIPT) and os.path.isdir(os.path.join(APP_ROOT, ".git"))
    return jsonify({"version": app_version(), "available": available, "app_root": APP_ROOT})


@app.post("/api/update/check")
def api_update_check():
    """Fragt GitHub, ob eine neuere Version vorliegt."""
    if not _pw_ok((request.get_json(silent=True) or {}).get("password", "")):
        return jsonify({"ok": False, "error": "Falsches Passwort"}), 403
    if not os.path.isfile(UPDATE_SCRIPT):
        return jsonify({"ok": False, "error": "Nur auf dem Raspberry Pi verfuegbar."}), 400
    rc, out = _run_update("check", timeout=60)
    import json as _json
    try:
        data = _json.loads(out.strip().splitlines()[-1])
    except Exception:
        return jsonify({"ok": False, "error": "Pruefung fehlgeschlagen", "detail": out[-800:]}), 500
    data["ok"] = (rc == 0)
    return jsonify(data)


@app.post("/api/update/apply")
def api_update_apply():
    """Startet Update + Neustart im Hintergrund (Daten bleiben erhalten)."""
    if not _pw_ok((request.get_json(silent=True) or {}).get("password", "")):
        return jsonify({"ok": False, "error": "Falsches Passwort"}), 403
    if not os.path.isfile(UPDATE_SCRIPT):
        return jsonify({"ok": False, "error": "Nur auf dem Raspberry Pi verfuegbar."}), 400
    # Im Hintergrund laufen lassen: das Skript startet den Dienst am Ende neu,
    # wodurch dieser Prozess beendet wird. Die Oberflaeche pollt danach die
    # Version, bis der Dienst wieder erreichbar ist.
    threading.Thread(target=lambda: _run_update("apply", timeout=600), daemon=True).start()
    return jsonify({"ok": True, "message": "Update gestartet - der Bot startet gleich neu."})


# --- Backup der Einstellungen -------------------------------------------
BACKUP_DIR = os.environ.get("COCKTAILBOT_BACKUP_DIR", os.path.join(APP_ROOT, "backups"))
_DATA_FILES = ("settings.json", "recipes.json", "ingredients.json", "pumps.json", "stats.json")
_SECRET_KEYS = ("settings_password", "smtp_password")   # nie ins Backup


def _sanitized_settings_bytes() -> bytes:
    s = dict(storage.load("settings", {}) or {})
    for k in _SECRET_KEYS:
        s.pop(k, None)
    return _json.dumps(s, ensure_ascii=False, indent=2).encode("utf-8")


def _make_backup():
    """Schreibt ein Zip mit allen Datendateien (ohne Passwoerter) und gibt
    (name, pfad) zurueck."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = "cocktailbot-backup-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".zip"
    path = os.path.join(BACKUP_DIR, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in _DATA_FILES:
            if fn == "settings.json":
                z.writestr("data/settings.json", _sanitized_settings_bytes())
                continue
            src = os.path.join(storage.DATA_DIR, fn)
            if os.path.isfile(src):
                z.write(src, "data/" + fn)
        z.writestr("manifest.json", _json.dumps({
            "app": "cocktailbot", "version": app_version(),
            "created": datetime.now().isoformat(timespec="seconds"),
        }, indent=2))
    return name, path


def _list_backups():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    out = []
    for p in sorted(glob.glob(os.path.join(BACKUP_DIR, "*.zip")), reverse=True):
        st = os.stat(p)
        out.append({"name": os.path.basename(p), "size": st.st_size,
                    "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    return out


def _safe_backup_name(name: str) -> str:
    name = os.path.basename(name or "")
    if not name.endswith(".zip"):
        abort(400)
    return name


def _restore_backup_bytes(raw: bytes):
    """Spielt ein Backup-Zip ein. Vorher wird automatisch ein Sicherungs-Backup
    erstellt. Die Geheimnisse der laufenden Installation (Admin-/Mail-Passwort)
    bleiben erhalten, da sie nicht im Backup stehen."""
    import io as _io
    cur = storage.load("settings", {}) or {}
    keep = {k: cur[k] for k in _SECRET_KEYS if k in cur}
    _make_backup()                                   # Sicherheitskopie vorher
    with zipfile.ZipFile(_io.BytesIO(raw)) as z:
        names = set(z.namelist())
        found = False
        for fn in _DATA_FILES:
            member = "data/" + fn
            if member not in names:
                continue
            obj = _json.loads(z.read(member).decode("utf-8"))   # validiert JSON
            if fn == "settings.json" and isinstance(obj, dict):
                for k, v in keep.items():
                    obj.setdefault(k, v)                        # Secrets behalten
            storage.save(fn[:-5], obj)
            found = True
        if not found:
            raise ValueError("Kein gueltiges Backup (keine data/-Dateien gefunden).")
    s = storage.load("settings", {}) or {}
    w = s.get("wled", {}) or {}
    wled_ctl.update(w.get("enabled", False), w.get("status", {}))


def _effective_mail() -> dict:
    """Mail-Konfiguration: App-Einstellungen haben Vorrang, sonst die Werte aus
    /etc/cocktailbot/mail.env (MAIL_HOST, MAIL_PORT, ...). So kann alles vorab in
    der mail.env stehen und trotzdem in der App geaendert werden."""
    m = dict((storage.load("settings", {}) or {}).get("mail", {}) or {})

    def pick(key, env, default=""):
        v = m.get(key)
        return v if v not in (None, "") else os.environ.get(env, default)

    try:
        port = int(pick("port", "MAIL_PORT", "587") or 587)
    except (TypeError, ValueError):
        port = 587
    return {
        "host": (pick("host", "MAIL_HOST") or "").strip(),
        "port": port,
        "security": (pick("security", "MAIL_SECURITY", "starttls") or "starttls").lower(),
        "user": (pick("user", "MAIL_USER") or "").strip(),
        "from": (pick("from", "MAIL_FROM") or "").strip(),
        "to": (pick("to", "MAIL_TO") or "").strip(),
    }


def _mail_password() -> str:
    return (storage.load("settings", {}) or {}).get("smtp_password") or os.environ.get("MAIL_PASSWORD", "")


def _smtp_send(msg):
    """Schickt eine fertige EmailMessage ueber den konfigurierten SMTP-Server.
    Wirft bei Fehlern eine Exception."""
    m = _effective_mail()
    host, port, security, user = m["host"], m["port"], m["security"], m["user"]
    pw = _mail_password()
    ctx = ssl.create_default_context()
    if security == "ssl":
        with smtplib.SMTP_SSL(host, port, timeout=25, context=ctx) as srv:
            if user:
                srv.login(user, pw)
            srv.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=25) as srv:
            if security == "starttls":
                srv.starttls(context=ctx)
            if user:
                srv.login(user, pw)
            srv.send_message(msg)


def _send_backup_mail(path: str, name: str):
    m = _effective_mail()
    sender = (m["from"] or m["user"]).strip()
    to = m["to"]
    if not m["host"] or not m["port"] or not to:
        return False, "SMTP-Server, Port und Empfaenger muessen gesetzt sein."
    msg = EmailMessage()
    msg["Subject"] = "CocktailBot Backup " + name
    msg["From"] = sender or "cocktailbot@localhost"
    msg["To"] = to
    msg.set_content("Im Anhang das aktuelle CocktailBot-Backup der Einstellungen.")
    with open(path, "rb") as fh:
        msg.add_attachment(fh.read(), maintype="application", subtype="zip", filename=name)
    try:
        _smtp_send(msg)
        return True, "gesendet"
    except Exception as exc:
        return False, str(exc)


def _send_text_mail(subject: str, text: str, html: str = "", to: str = ""):
    """Verschickt eine einfache Text/HTML-Mail (z. B. die Einkaufsliste)."""
    m = _effective_mail()
    sender = (m["from"] or m["user"]).strip()
    to = (to or m["to"]).strip()
    if not m["host"] or not m["port"] or not to:
        return False, "SMTP-Server, Port und Empfaenger muessen gesetzt sein."
    msg = EmailMessage()
    msg["Subject"] = subject or "CocktailBot"
    msg["From"] = sender or "cocktailbot@localhost"
    msg["To"] = to
    msg.set_content(text or "(kein Inhalt)")
    if html:
        msg.add_alternative(html, subtype="html")
    try:
        _smtp_send(msg)
        return True, "gesendet"
    except Exception as exc:
        return False, str(exc)


@app.post("/api/party/shopping/mail")
def api_party_shopping_mail():
    """Verschickt eine im Frontend berechnete Einkaufsliste per Mail."""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    html = data.get("html", "")
    to = (data.get("to") or "").strip()
    if not text and not html:
        return jsonify({"ok": False, "error": "Leere Liste"}), 400
    ok, info = _send_text_mail("CocktailBot – Einkaufsliste", text, html, to)
    return jsonify({"ok": ok, "message": ("Einkaufsliste per Mail gesendet." if ok else None),
                    "error": (None if ok else info)})


@app.get("/api/backup/list")
def api_backup_list():
    return jsonify({"available": True, "dir": BACKUP_DIR, "backups": _list_backups()})


@app.post("/api/backup/create")
def api_backup_create():
    if not _pw_ok((request.get_json(silent=True) or {}).get("password", "")):
        return jsonify({"ok": False, "error": "Falsches Passwort"}), 403
    name, _ = _make_backup()
    return jsonify({"ok": True, "name": name, "backups": _list_backups()})


@app.get("/api/backup/download/<name>")
def api_backup_download(name):
    if not _pw_ok(request.args.get("pw", "")):
        abort(403)
    p = os.path.join(BACKUP_DIR, _safe_backup_name(name))
    if not os.path.isfile(p):
        abort(404)
    return send_file(p, as_attachment=True, download_name=name)


@app.post("/api/backup/delete/<name>")
def api_backup_delete(name):
    if not _pw_ok((request.get_json(silent=True) or {}).get("password", "")):
        return jsonify({"ok": False, "error": "Falsches Passwort"}), 403
    p = os.path.join(BACKUP_DIR, _safe_backup_name(name))
    if os.path.isfile(p):
        os.remove(p)
    return jsonify({"ok": True, "backups": _list_backups()})


@app.post("/api/backup/restore")
def api_backup_restore():
    # Passwort aus Formular (Upload) oder JSON (bestehendes Backup).
    pw = request.form.get("password") if request.form else None
    if pw is None:
        pw = (request.get_json(silent=True) or {}).get("password", "")
    if not _pw_ok(pw):
        return jsonify({"ok": False, "error": "Falsches Passwort"}), 403
    if request.files.get("file"):
        raw = request.files["file"].read()
    else:
        name = _safe_backup_name((request.get_json(silent=True) or {}).get("name", ""))
        p = os.path.join(BACKUP_DIR, name)
        if not os.path.isfile(p):
            return jsonify({"ok": False, "error": "Backup nicht gefunden"}), 404
        with open(p, "rb") as fh:
            raw = fh.read()
    try:
        _restore_backup_bytes(raw)
    except Exception as exc:
        return jsonify({"ok": False, "error": "Wiederherstellung fehlgeschlagen: %s" % exc}), 400
    return jsonify({"ok": True, "message": "Einstellungen wiederhergestellt."})


@app.post("/api/backup/mail")
def api_backup_mail():
    if not _pw_ok((request.get_json(silent=True) or {}).get("password", "")):
        return jsonify({"ok": False, "error": "Falsches Passwort"}), 403
    name, path = _make_backup()
    ok, info = _send_backup_mail(path, name)
    return jsonify({"ok": ok, "name": name,
                    "message": ("Backup per Mail gesendet." if ok else None),
                    "error": (None if ok else info)})


@app.get("/api/stats")
def api_stats_full():
    """Vollstaendige Statistik inkl. Zeitverlauf (Events)."""
    return jsonify(storage.load("stats", {"total": 0, "per_recipe": {}, "volume_ml": 0, "events": []}))


@app.post("/api/stats/reset")
def api_stats_reset():
    """Setzt die Statistik zurueck (inkl. Zeitverlauf)."""
    storage.save("stats", {"total": 0, "per_recipe": {}, "volume_ml": 0, "events": []})
    return jsonify({"ok": True})


@app.post("/api/kiosk/quit")
def api_kiosk_quit():
    """Beendet den Vollbild-Browser (Kiosk) und bringt den Pi zurueck zum
    Desktop. Nur lokal vom Geraet selbst erlaubt."""
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"ok": False, "error": "nur lokal"}), 403

    def _kill():
        # Nur den Kiosk-Browser treffen (Prozesse mit --kiosk in der Befehlszeile).
        subprocess.run(["pkill", "-f", "--", "--kiosk"], capture_output=True)

    threading.Timer(0.6, _kill).start()
    return jsonify({"ok": True})


def main():
    settings = get_settings()
    host = os.environ.get("COCKTAILBOT_HOST", "0.0.0.0")
    port = int(os.environ.get("COCKTAILBOT_PORT", settings.get("port", 3000)))
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
