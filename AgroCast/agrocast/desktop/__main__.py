# -*- coding: utf-8 -*-
"""AgroCast 2.5 — python -m agrocast.desktop.

Любая ошибка на старте (включая ошибки импорта Qt) показывается
нативным окном на Windows — exe никогда не «падает молча».
"""
import sys

if __name__ == "__main__":
    from agrocast.desktop.errors import show_fatal

    try:
        from .app import main
    except Exception as exc:  # noqa: BLE001
        show_fatal(exc)
        raise SystemExit(1)
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        show_fatal(exc)
        raise SystemExit(2)
