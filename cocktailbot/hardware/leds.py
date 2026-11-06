"""Optionale LED-Steuerung ueber den Pico 2 (USB-Serial).

Nutzt dasselbe einfache Befehlsprotokoll wie deine main.py auf dem Pico
(READY / BUSY / ERROR / BLINK R G B / COLOR R G B / OFF ...).

Faellt lautlos in einen Mock-Modus zurueck, wenn pyserial fehlt, kein Pico
angeschlossen ist oder led_enabled=False gesetzt ist.
"""

from __future__ import annotations

import threading

try:
    import serial  # type: ignore
    _SERIAL_AVAILABLE = True
except Exception:  # pragma: no cover
    serial = None  # type: ignore
    _SERIAL_AVAILABLE = False


class LedController:
    def __init__(self, enabled: bool = False, port: str = "/dev/ttyACM0", baud: int = 115200):
        self.enabled = enabled and _SERIAL_AVAILABLE
        self.port = port
        self.baud = baud
        self._ser = None
        self._lock = threading.Lock()
        if self.enabled:
            self._open()

    def _open(self):
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.2)
        except Exception:
            self._ser = None
            self.enabled = False

    def send(self, command: str):
        """Schickt einen Befehl an den Pico. Tut im Mock-Modus nichts."""
        if not self.enabled or self._ser is None:
            return
        with self._lock:
            try:
                self._ser.write((command.strip() + "\n").encode("ascii", "ignore"))
            except Exception:
                # Verbindung verloren -> stummschalten, App laeuft weiter
                self.enabled = False

    # bequeme Kurzbefehle
    def ready(self):
        self.send("READY")

    def busy(self):
        self.send("BUSY")

    def error(self):
        self.send("ERROR")

    def blink(self, r=255, g=0, b=0):
        self.send(f"BLINK {r} {g} {b}")

    def color(self, r, g, b):
        self.send(f"COLOR {r} {g} {b}")

    def off(self):
        self.send("OFF")

    def close(self):
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
