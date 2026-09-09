# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: AgroCast 2.5 — onedir, windowed, contents_directory=_internal.

Сборка (Windows):
    pyinstaller --noconfirm --clean AgroCast.spec
или автоматически:
    python tools/build_exe.py

Структура результата (dist/AgroCast/):
    AgroCast.exe
    _internal/  (все библиотеки + static/ world/ migrations/)
"""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH) if "SPECPATH" in globals() else Path(".")
ICON = str(ROOT / "static" / "agrocast.ico")

# --- PySide6: все данные/библиотеки/скрытые импорты ---------------------
pyside_datas, pyside_binaries, pyside_hidden = collect_all("PySide6")

# --- uvicorn: подкапотные модули (loops/protocols/lifespan) --------------
uvicorn_hidden = collect_submodules("uvicorn")

datas = [
    ("static", "static"),
    ("world", "world"),
    ("migrations", "migrations"),
] + pyside_datas

binaries = pyside_binaries

hiddenimports = (
    pyside_hidden
    + uvicorn_hidden
    + [
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "fastapi",
        "pydantic",
        "anyio",
        "multipart",
    ]
)

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AgroCast",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON,
    contents_directory="_internal",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="AgroCast",
)
