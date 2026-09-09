# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: AgroCast 2.5 — onedir, windowed, contents_directory=_internal.

Сборка (Windows):
    pyinstaller --noconfirm --clean AgroCast.spec
или автоматически:
    python tools/build_exe.py

Структура результата (dist/AgroCast/):
    AgroCast.exe
    _internal/  (все библиотеки + static/ world/ migrations/)

Важно: НЕ используем --collect-all PySide6 — это тянет весь Qt (QML, 3D,
мультимедиа и т.п.) и валит сборку. PyInstaller сам находит нужные модули Qt
по импортам (hook-PySide6 + hook-PySide6.QtWebEngineWidgets/QtWebChannel).
"""
from pathlib import Path

import sys
sys.setrecursionlimit(10000)

ROOT = Path(SPECPATH) if "SPECPATH" in globals() else Path(".")
ICON = str(ROOT / "static" / "agrocast.ico")

datas = [
    ("static", "static"),
    ("world", "world"),
    ("migrations", "migrations"),
]

# Только те модули PySide6, что реально используются в app.py
hiddenimports = [
    "PySide6",
    "PySide6.QtCore",
    "PySide6.QtGui",
    "PySide6.QtWidgets",
    "PySide6.QtNetwork",
    "PySide6.QtWebEngineCore",
    "PySide6.QtWebEngineWidgets",
    "PySide6.QtWebChannel",
    "shiboken6",
    # FastAPI/uvicorn-стек
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "fastapi",
    "pydantic",
    "multipart",
]

# Всё лишнее из PySide6 — не тащим (QML/3D/мультимедиа и пр.)
excludes = [
    "PySide6.QtQml", "PySide6.QtQuick", "PySide6.QtQuick3D",
    "PySide6.QtQuickControls2", "PySide6.QtQuickWidgets",
    "PySide6.Qt3DCore", "PySide6.Qt3DRender", "PySide6.Qt3DInput",
    "PySide6.Qt3DAnimation", "PySide6.Qt3DExtras", "PySide6.Qt3DLogic",
    "PySide6.QtCharts", "PySide6.QtDataVisualization",
    "PySide6.QtMultimedia", "PySide6.QtMultimediaWidgets",
    "PySide6.QtPdf", "PySide6.QtPdfWidgets",
    "PySide6.QtWebEngineQuick", "PySide6.QtWebView", "PySide6.QtWebSockets",
    "PySide6.QtPositioning", "PySide6.QtLocation",
    "PySide6.QtBluetooth", "PySide6.QtNfc", "PySide6.QtSensors",
    "PySide6.QtSerialPort", "PySide6.QtSerialBus", "PySide6.QtSql",
    "PySide6.QtTest", "PySide6.QtTextToSpeech", "PySide6.QtRemoteObjects",
    "PySide6.QtScxml", "PySide6.QtStateMachine", "PySide6.QtSvg",
    "PySide6.QtSvgWidgets", "PySide6.QtUiTools", "PySide6.QtDesigner",
    "PySide6.QtHelp", "PySide6.QtHttpServer", "PySide6.QtNetworkAuth",
    "PySide6.QtOpenGL", "PySide6.QtOpenGLWidgets", "PySide6.QtOpenGLFunctions",
    "PySide6.QtDBus", "PySide6.QtAxContainer", "PySide6.QtSpatialAudio",
    "PySide6.QtVirtualKeyboard", "PySide6.QtXml",
    "PySide6.QtXmlPatterns", "PySide6.QtGraphs", "PySide6.QtGraphsWidgets",
]

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
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
