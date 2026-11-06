"""Einfache, thread-sichere JSON-Persistenz im data/-Ordner."""

from __future__ import annotations

import json
import os
import threading

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_HERE, "data")

_lock = threading.RLock()


def _path(name: str) -> str:
    return os.path.join(DATA_DIR, name if name.endswith(".json") else name + ".json")


def load(name: str, default=None):
    with _lock:
        try:
            with open(_path(name), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return default


def save(name: str, data) -> None:
    """Atomisch speichern (erst .tmp schreiben, dann umbenennen)."""
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = _path(name) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(name))


def next_id(items: list[dict]) -> int:
    return (max((int(i.get("id", 0)) for i in items), default=0) + 1)
