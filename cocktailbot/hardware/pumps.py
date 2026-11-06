"""Pumpensteuerung - hardware-identisch zum bestehenden CocktailBot-Aufbau.

- 18 Pumpen, Relais LOW-aktiv: GPIO HIGH = Pumpe AUS, GPIO LOW = Pumpe EIN.
- Feste Pin-Belegung (BCM), Pumpe N -> PUMP_PINS[N-1].
- Raspberry Pi 5: RPi.GPIO ueber python3-rpi-lgpio, RP1-gpiochip wird per
  gpiodetect automatisch gewaehlt (wie in der bestehenden Software).
- Mock-Modus auf jedem PC: COCKTAILBOT_MOCK_GPIO=1 oder wenn RPi.GPIO fehlt.

Diese feste Pin-Reihenfolge stammt aus dem bestehenden Aufbau und darf NICHT
veraendert werden, solange die Verdrahtung gleich bleibt.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from pathlib import Path

# Pumpe 1..18 -> GPIO (BCM). Identisch zum bestehenden cocktailbot_server.py.
PUMP_PINS: tuple[int, ...] = (
    17, 18, 27, 22, 23, 24, 25, 4, 5,
    6, 13, 19, 26, 16, 20, 21, 12, 15,
)
PUMP_COUNT = len(PUMP_PINS)
MAX_DURATION_S = 120.0  # Sicherheitsgrenze pro Pumpenlauf

_FORCE_MOCK = os.environ.get("COCKTAILBOT_MOCK_GPIO") == "1"


def pin_for_pump(number: int) -> int:
    if number < 1 or number > PUMP_COUNT:
        raise ValueError(f"Ungueltige Pumpennummer {number}")
    return PUMP_PINS[number - 1]


def _resolve_rp1_chip() -> int | None:
    """Findet den RP1-gpiochip des Pi 5 (wie in der bestehenden Software)."""
    configured = os.getenv("COCKTAILBOT_GPIO_CHIP", "auto").strip().lower()
    if configured and configured != "auto":
        return int(configured) if configured.isdigit() else None
    try:
        result = subprocess.run(["gpiodetect"], capture_output=True,
                                text=True, timeout=3, check=False)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if "[pinctrl-rp1]" in line:
            m = re.match(r"^gpiochip(\d+)\s", line.strip())
            if m and Path(f"/dev/gpiochip{m.group(1)}").exists():
                return int(m.group(1))
    return None


# --- GPIO-Backend waehlen -------------------------------------------------
GPIO = None
if not _FORCE_MOCK:
    try:
        _chip = _resolve_rp1_chip()
        if _chip is not None:
            os.environ["RPI_LGPIO_CHIP"] = str(_chip)
        import RPi.GPIO as GPIO  # type: ignore
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
    except Exception:
        GPIO = None


class PumpController:
    """Schaltet Pumpen ueber ihre GPIO-Pins (oder simuliert sie im Mock)."""

    def __init__(self, active_low: bool = True):
        self.active_low = active_low
        self.mock = GPIO is None
        self._on_level = 0 if active_low else 1   # LOW = an bei Active-Low
        self._off_level = 1 if active_low else 0
        self._setup: set[int] = set()
        self._lock = threading.Lock()

    def _ensure(self, pin: int):
        if self.mock:
            return
        if pin not in self._setup:
            GPIO.setup(pin, GPIO.OUT)
            GPIO.output(pin, self._off_level)  # sicher: aus
            self._setup.add(pin)

    # ----- Pin-Ebene -----------------------------------------------------
    def on(self, pin: int):
        with self._lock:
            self._ensure(pin)
            if not self.mock:
                GPIO.output(pin, self._on_level)

    def off(self, pin: int):
        with self._lock:
            self._ensure(pin)
            if not self.mock:
                GPIO.output(pin, self._off_level)

    def all_off(self):
        """Sicherheitsabschaltung ALLER Pumpenpins (auch nie benutzter)."""
        with self._lock:
            for pin in PUMP_PINS:
                self._ensure(pin)
                if not self.mock:
                    GPIO.output(pin, self._off_level)

    # ----- Pumpen-Ebene --------------------------------------------------
    def run_for(self, pin: int, duration_s: float,
                stop_event: threading.Event | None = None):
        """Schaltet eine Pumpe fuer duration_s ein. Schaltet immer sicher ab."""
        duration_s = max(0.0, min(float(duration_s), MAX_DURATION_S))
        if duration_s <= 0:
            return
        try:
            self.on(pin)
            end = time.monotonic() + duration_s
            while time.monotonic() < end:
                if stop_event is not None and stop_event.is_set():
                    break
                time.sleep(0.02)
        finally:
            self.off(pin)

    def test_pulse(self, pin: int, duration_s: float):
        """Blockierender Testlauf fuer die Kalibrierung."""
        self.run_for(pin, duration_s)

    def cleanup(self):
        self.all_off()
        if not self.mock:
            try:
                GPIO.cleanup()
            except Exception:
                pass
        self._setup.clear()
