# -*- coding: utf-8 -*-
"""Показ фатальной ошибки запуска (без зависимостей PySide6).

Используется из app.py и agrocast/desktop/__main__.py: если приложение
не смогло стартовать (ошибка импорта Qt и т.п.), на Windows показывается
нативное окно с текстом ошибки — exe не «падает молча».

Ошибка ДОПОЛНИТЕЛЬНО пишется в файл  %USERPROFILE%\.agrocast\agrocast.log —
его содержимое можно прислать для диагностики.
"""
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path


def log_path() -> Path:
    state = os.environ.get("AGROCAST_STATE_DIR") or str(Path.home() / ".agrocast")
    try:
        p = Path(state)
        p.mkdir(parents=True, exist_ok=True)
        return p / "agrocast.log"
    except Exception:
        return Path.home() / "agrocast.log"


def _append(text: str) -> None:
    try:
        with log_path().open("a", encoding="utf-8") as f:
            f.write("\n" + text + "\n")
    except Exception:
        pass


def show_fatal(exc: BaseException, title: str = "AgroCast 2.5 — ошибка запуска") -> None:
    tb = traceback.format_exc(limit=8)
    msg = (
        "AgroCast 2.5 не смог запуститься.\n\n"
        f"{type(exc).__name__}: {exc}\n\n{tb}"
    )
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _append(f"===== {stamp} FATAL =====\n{msg}")
    try:
        if sys.platform == "win32":
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, msg[-2000:], title, 0x10)
        else:
            print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass
