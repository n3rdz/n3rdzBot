"""PayPal-Bezahlung fuer den Kassenmodus (lokal ueber den Raspberry Pi).

Ablauf wie in der Original-App:
  1. Bestellung erstellen (intent=CAPTURE) -> Approval-URL
  2. QR-Code der Approval-URL anzeigen, Gast bezahlt am Handy
  3. Status pollen; sobald APPROVED -> einziehen (capture) -> COMPLETED
  4. Zahlung als "verwendet" markieren, danach Cocktail zubereiten

Zugangsdaten kommen aus Umgebungsvariablen (nie aus dem Frontend):
  COCKTAILBOT_PAYPAL_MODE=sandbox|live
  COCKTAILBOT_PAYPAL_CLIENT_ID=...
  COCKTAILBOT_PAYPAL_CLIENT_SECRET=...
  COCKTAILBOT_PAYPAL_BRAND_NAME=CocktailBot
  COCKTAILBOT_PAYPAL_RETURN_URL=...   (optional)
  COCKTAILBOT_PAYPAL_CANCEL_URL=...   (optional)

Ohne Zugangsdaten oder bei test_mode=True laeuft ein Testmodus: Bestellungen
werden simuliert und koennen per Knopf als bezahlt markiert werden. So ist der
komplette Ablauf ohne echtes PayPal-Konto pruefbar.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.parse
import urllib.request
import uuid


def _env(name, default=""):
    return os.environ.get(name, default)


class PayPalError(Exception):
    pass


class PaymentManager:
    def __init__(self):
        self._orders: dict[str, dict] = {}
        self._tally: dict[str, dict] = {}   # Konsum je Gast (payer-key)
        self._lock = threading.Lock()
        self._tokens: dict[str, tuple] = {}   # mode -> (access_token, expires_at)

    # ----- Konsum-Zaehler (pro Gast) ------------------------------------
    def _record(self, order: dict):
        """Zaehlt einen bezahlten Cocktail dem Gast zu (einmalig je Bestellung)."""
        if order.get("recorded"):
            return
        order["recorded"] = True
        payer = order.get("payer") or {"key": "gast", "name": "Gast"}
        meta = order.get("meta", {})
        with self._lock:
            t = self._tally.setdefault(payer["key"], {
                "name": payer.get("name") or "Gast", "count": 0,
                "volume_ml": 0.0, "alcohol_g": 0.0, "drinks": []})
            t["name"] = payer.get("name") or t["name"]
            t["count"] += 1
            t["volume_ml"] += float(meta.get("volume_ml", 0) or 0)
            t["alcohol_g"] += float(meta.get("alcohol_g", 0) or 0)
            t["drinks"].append(meta.get("recipe_name", "Cocktail"))
            t["drinks"] = t["drinks"][-20:]

    def tally(self, key: str) -> dict:
        with self._lock:
            t = self._tally.get(key)
            return dict(t) if t else {"name": "Gast", "count": 0,
                                      "volume_ml": 0.0, "alcohol_g": 0.0, "drinks": []}

    def reset_tally(self):
        with self._lock:
            self._tally.clear()

    def find_by_paypal(self, token: str):
        with self._lock:
            for oid, o in self._orders.items():
                if o.get("paypal_id") == token:
                    return oid
        return None

    # ----- Konfiguration ------------------------------------------------
    @staticmethod
    def _norm_mode(mode) -> str:
        return "live" if str(mode or "").strip().lower() == "live" else "sandbox"

    @property
    def default_mode(self) -> str:
        """Standard-Umgebung aus der ENV (Fallback, wenn die App nichts waehlt)."""
        return self._norm_mode(_env("COCKTAILBOT_PAYPAL_MODE", "sandbox"))

    def base_url_for(self, mode) -> str:
        return ("https://api-m.paypal.com" if self._norm_mode(mode) == "live"
                else "https://api-m.sandbox.paypal.com")

    def creds_for(self, mode):
        """Zugangsdaten je Umgebung: bevorzugt eigene SANDBOX_/LIVE_-Variablen,
        sonst die generischen (Rueckwaertskompatibilitaet)."""
        M = self._norm_mode(mode).upper()
        cid = _env("COCKTAILBOT_PAYPAL_%s_CLIENT_ID" % M) or _env("COCKTAILBOT_PAYPAL_CLIENT_ID")
        sec = _env("COCKTAILBOT_PAYPAL_%s_CLIENT_SECRET" % M) or _env("COCKTAILBOT_PAYPAL_CLIENT_SECRET")
        return cid, sec

    @property
    def brand_name(self) -> str:
        return _env("COCKTAILBOT_PAYPAL_BRAND_NAME", "CocktailBot")

    def has_credentials(self, mode=None) -> bool:
        cid, sec = self.creds_for(self.default_mode if mode is None else mode)
        return bool(cid and sec)

    def credentials_overview(self) -> dict:
        """Welche Umgebungen haben Zugangsdaten? (fuer die Oberflaeche)"""
        return {"sandbox": self.has_credentials("sandbox"),
                "live": self.has_credentials("live")}

    def effective_test_mode(self, settings_test_mode: bool, mode=None) -> bool:
        # Ohne Zugangsdaten (fuer die gewaehlte Umgebung) immer Test; sonst wie eingestellt.
        return settings_test_mode or not self.has_credentials(mode)

    # ----- HTTP-Hilfen --------------------------------------------------
    def _request(self, method, path, mode, headers=None, data=None, timeout=15):
        url = self.base_url_for(mode) + path
        body = None
        if data is not None:
            body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=body, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")
            raise PayPalError(f"PayPal {e.code}: {detail[:200]}")
        except Exception as e:
            raise PayPalError(str(e))

    def _access_token(self, mode) -> str:
        mode = self._norm_mode(mode)
        now = time.time()
        cached = self._tokens.get(mode)
        if cached and now < cached[1] - 30:
            return cached[0]
        cid, sec = self.creds_for(mode)
        auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
        req = urllib.request.Request(
            self.base_url_for(mode) + "/v1/oauth2/token", data=data, method="POST")
        req.add_header("Authorization", "Basic " + auth)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                tok = json.loads(resp.read().decode())
        except Exception as e:
            raise PayPalError(f"OAuth fehlgeschlagen: {e}")
        access = tok["access_token"]
        self._tokens[mode] = (access, now + float(tok.get("expires_in", 3000)))
        return access

    def test_connection(self, mode=None) -> dict:
        mode = self._norm_mode(self.default_mode if mode is None else mode)
        if not self.has_credentials(mode):
            return {"ok": False, "error": "Keine Zugangsdaten gesetzt", "mode": mode}
        try:
            self._access_token(mode)
            return {"ok": True, "mode": mode}
        except PayPalError as e:
            return {"ok": False, "error": str(e), "mode": mode}

    # ----- Bestellungen -------------------------------------------------
    def create_order(self, amount: float, currency: str, label: str,
                     test_mode: bool, meta: dict,
                     return_url: str = "", cancel_url: str = "", mode=None) -> dict:
        mode = self._norm_mode(self.default_mode if mode is None else mode)
        order_id = uuid.uuid4().hex[:16]
        value = f"{amount:.2f}"

        if test_mode:
            approval = f"/api/pay/simulate/{order_id}"
            rec = {"status": "pending", "amount": amount, "currency": currency,
                   "approval_url": approval, "used": False, "test": True,
                   "payer": {"key": "test", "name": "Testgast"},
                   "meta": meta, "created": time.time(), "mode": mode}
            with self._lock:
                self._orders[order_id] = rec
            return {"order_id": order_id, "approval_url": approval,
                    "amount": value, "currency": currency, "test": True}

        # Echte PayPal-Bestellung
        token = self._access_token(mode)
        ctx = {"brand_name": self.brand_name, "user_action": "PAY_NOW",
               "shipping_preference": "NO_SHIPPING"}
        ret = return_url or _env("COCKTAILBOT_PAYPAL_RETURN_URL")
        can = cancel_url or _env("COCKTAILBOT_PAYPAL_CANCEL_URL") or ret
        if ret:
            ctx["return_url"] = ret
        if can:
            ctx["cancel_url"] = can
        payload = {
            "intent": "CAPTURE",
            "purchase_units": [{
                "amount": {"currency_code": currency, "value": value},
                "description": label[:120],
            }],
            "application_context": ctx,
        }
        res = self._request("POST", "/v2/checkout/orders", mode,
                            headers={"Authorization": "Bearer " + token,
                                     "Content-Type": "application/json"},
                            data=payload)
        approval = next((l["href"] for l in res.get("links", [])
                         if l.get("rel") == "approve"), "")
        rec = {"status": "pending", "amount": amount, "currency": currency,
               "approval_url": approval, "used": False, "test": False,
               "paypal_id": res.get("id"), "meta": meta, "created": time.time(),
               "mode": mode}
        with self._lock:
            self._orders[order_id] = rec
        return {"order_id": order_id, "approval_url": approval,
                "amount": value, "currency": currency, "test": False}

    def _order(self, order_id):
        with self._lock:
            return self._orders.get(order_id)

    def simulate_paid(self, order_id) -> bool:
        with self._lock:
            o = self._orders.get(order_id)
            ok = bool(o and o.get("test"))
            if ok:
                o["status"] = "paid"
        if ok:
            self._record(self._orders[order_id])
        return ok

    def status(self, order_id) -> dict:
        o = self._order(order_id)
        if not o:
            return {"status": "unknown"}
        if o["used"]:
            return {"status": "used"}
        if o["status"] == "paid":
            return {"status": "paid"}
        if o.get("test"):
            return {"status": o["status"]}  # pending bis simuliert

        # Echt: Status bei PayPal abfragen, ggf. einziehen
        def _payer(info):
            p = info.get("payer") or {}
            name = ((p.get("name") or {}).get("given_name")
                    or (p.get("name") or {}).get("surname") or "Gast")
            email = (p.get("email_address") or "").lower()
            key = email or name.lower()
            return {"key": key, "name": name}

        try:
            omode = o.get("mode", self.default_mode)
            token = self._access_token(omode)
            info = self._request("GET", f"/v2/checkout/orders/{o['paypal_id']}", omode,
                                 headers={"Authorization": "Bearer " + token})
            st = info.get("status")
            paid = False
            if st == "APPROVED":
                cap = self._request(
                    "POST", f"/v2/checkout/orders/{o['paypal_id']}/capture", omode,
                    headers={"Authorization": "Bearer " + token,
                             "Content-Type": "application/json"}, data={})
                if cap.get("status") == "COMPLETED":
                    o["payer"] = _payer(cap)
                    paid = True
            elif st == "COMPLETED":
                o["payer"] = _payer(info)
                paid = True
            if paid:
                with self._lock:
                    o["status"] = "paid"
                self._record(o)
                return {"status": "paid"}
        except PayPalError as e:
            return {"status": "pending", "error": str(e)}
        return {"status": "pending"}

    def consume(self, order_id) -> dict | None:
        """Bezahlte Bestellung als verwendet markieren und Metadaten liefern."""
        with self._lock:
            o = self._orders.get(order_id)
            if not o or o["status"] != "paid" or o["used"]:
                return None
            o["used"] = True
            return dict(o["meta"])
