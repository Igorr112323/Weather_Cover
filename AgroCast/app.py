# -*- coding: utf-8 -*-
"""AgroCast 2.5 — точка входа для запуска из исходников: python app.py

Полноценный запуск каркаса: локальный FastAPI + окно PySide6 (QtWebEngine).
Собранный exe использует тот же код через `python -m agrocast.desktop`
(см. AgroCast.bat / AgroCast.sh).

Любая ошибка на старте показывается нативным окном на Windows.
"""
import sys

if __name__ == "__main__":
    try:
        from agrocast.desktop.errors import show_fatal
        from agrocast.desktop.app import main
    except Exception as exc:  # noqa: BLE001
        try:
            from agrocast.desktop.errors import show_fatal

            show_fatal(exc)
        except Exception:
            pass
        raise SystemExit(1)

    try:
        rc = main(sys.argv)
    except SystemExit as e:
        rc = e.code if isinstance(e.code, int) else 1
    except Exception as exc:  # noqa: BLE001
        show_fatal(exc)
        rc = 2
    raise SystemExit(rc if isinstance(rc, int) else 1)
