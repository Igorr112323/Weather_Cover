# -*- coding: utf-8 -*-
"""Показ фатальной ошибки запуска (без зависимостей PySide6).

Используется из app.py и agrocast/desktop/__main__.py: если приложение
не смогло стартовать (ошибка импорта Qt и т.п.), на Windows показывается
нативное окно с текстом ошибки — exe не «падает молча».
"""
import sys
import traceback


def show_fatal(exc: BaseException, title: str = "AgroCast 2.5 — ошибка запуска") -> None:
    msg = (
        "AgroCast 2.5 не смог запуститься.\n\n"
        f"{type(exc).__name__}: {exc}\n\n"
        f"{traceback.format_exc(limit=4)}"
    )
    try:
        if sys.platform == "win32":
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, msg[-2000:], title, 0x10)
        else:
            print(msg, file=sys.stderr, flush=True)
    except Exception:
        pass
