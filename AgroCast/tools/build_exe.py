#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AgroCast 2.5 — сборка EXE (Windows) и упаковка в zip.

Запуск (на Windows, Python 3.11):
    python tools/build_exe.py

Что делает:
  1. проверяет окружение (python 3.10+, зависимости);
  2. доустанавливает requirements (в т.ч. PySide6, pyinstaller);
  3. собирает onedir через AgroCast.spec  ->  dist/AgroCast/AgroCast.exe + _internal/;
  4. пакует dist/AgroCast  ->  dist/AgroCast-2.5-exe.zip;
  5. (по желанию) запускает smoke-тест API из dist.

Ожидаемый результат zip 50–150 МБ (PySide6 + QtWebEngine).
"""
from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP_DIR = DIST / "AgroCast"
ZIP_OUT = DIST / "AgroCast-2.5-exe.zip"


def run(cmd: list[str], cwd: Path = ROOT) -> None:
    print(">>>", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=str(cwd))


def main() -> int:
    print(f"AgroCast 2.5 build | root: {ROOT}")
    if not (ROOT / "static" / "agrocast.png").is_file():
        print("Не найден static/agrocast.png — запустите tools/prepare_assets.py")
        return 1
    py = sys.executable or "python"
    run([py, "-m", "pip", "install", "--upgrade", "-r", str(ROOT / "requirements.txt")])
    if sys.platform != "win32":
        print("PyInstaller-cборку EXE выполняйте на Windows (QtWebEngine).")
        return 2
    run([py, "-m", "PyInstaller", "--noconfirm", "--clean", str(ROOT / "AgroCast.spec")])
    exe = APP_DIR / "AgroCast.exe"
    if not exe.is_file():
        print(f"Сборка не удалась: нет {exe}")
        return 3
    # мини-проверка ресурсов внутри _internal
    internal = APP_DIR / "_internal"
    for sub in ("static", "world", "migrations"):
        if not (internal / sub).is_dir():
            print(f"ВНИМАНИЕ: нет _internal/{sub} (сборка без ресурсов!)")
    # zip
    if ZIP_OUT.exists():
        ZIP_OUT.unlink()
    print("Упаковка dist/AgroCast ->", ZIP_OUT, flush=True)
    with zipfile.ZipFile(ZIP_OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for f in sorted(APP_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(DIST).as_posix())
    size_mb = ZIP_OUT.stat().st_size / 1024 / 1024
    print(f"OK: {ZIP_OUT} ({size_mb:.1f} МБ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
