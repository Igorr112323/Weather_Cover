# -*- coding: utf-8 -*-
"""AgroCast 2.5 — точка входа для запуска из исходников: python app.py

Полноценный запуск каркаса: локальный FastAPI + окно PySide6 (QtWebEngine).
Собранный exe использует тот же код через `python -m agrocast.desktop`
(см. AgroCast.bat / AgroCast.sh).
"""
import sys

from agrocast.desktop.app import main

if __name__ == "__main__":
    sys.exit(main(sys.argv))
