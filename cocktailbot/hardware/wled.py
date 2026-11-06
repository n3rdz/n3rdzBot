"""WLED-Statustrigger: ruft pro Status eine konfigurierbare URL auf (GET).

Damit kann z.B. eine WLED-Instanz je nach Zustand (bereit / beschaeftigt /
Fehler / fertig) eine andere Voreinstellung schalten. Beispiel-URLs:
  http://wled.local/win&PL=1       (Preset 1)
  http://192.168.1.50/win&A=255&FX=0
Die Aufrufe laufen in einem Thread und blockieren die App nicht.
"""

from __future__ import annotations

import threading
import urllib.request


class WledController:
    def __init__(self, enabled: bool = False, status_urls: dict | None = None):
        self.enabled = enabled
        self.status_urls = status_urls or {}

    def update(self, enabled: bool, status_urls: dict):
        self.enabled = enabled
        self.status_urls = status_urls or {}

    def _fire(self, url: str):
        if not url:
            return
        def go():
            try:
                urllib.request.urlopen(url, timeout=3).read(0)
            except Exception:
                pass  # WLED nicht erreichbar -> App laeuft normal weiter
        threading.Thread(target=go, daemon=True).start()

    def trigger(self, status: str):
        if not self.enabled:
            return
        self._fire(str(self.status_urls.get(status, "")))
