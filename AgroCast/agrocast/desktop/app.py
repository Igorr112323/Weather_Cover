# -*- coding: utf-8 -*-
"""AgroCast 2.5 — точка входа десктопного приложения.

Схема запуска:
  * поднимается локальный FastAPI-сервер (uvicorn) в фоновом потоке
    на http://127.0.0.1:8765  (static/, world/ и API);
  * QWebEngineView открывает http://127.0.0.1:8765/  (static/desktop.html);
  * QWebChannel мостит window.bridge между JS и Python
    (открытие внешних ссылок, сохранение JSON-файла и т.п.);
  * splash-экран с пульсирующей иконкой ~1.5 сек.

Поиск ресурсов static/world/migrations в 4 местах:
  root/name, root/_internal/name, root/AgroCast/_internal/name, parents[2]/name.
integrity.json читается в try/except (для каркаса он необязателен).
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

# --- Chromium-флаги ДО создания QApplication (важно для контейнеров/CI) ---
_chromium_flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
for flag in ("--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"):
    if flag not in _chromium_flags:
        _chromium_flags = f"{_chromium_flags} {flag}".strip()
os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = _chromium_flags
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")

from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Slot  # noqa: E402
from PySide6.QtGui import QDesktopServices, QIcon, QPixmap  # noqa: E402
from PySide6.QtWebChannel import QWebChannel  # noqa: E402
from PySide6.QtWebEngineCore import QWebEngineDownloadRequest, QWebEngineProfile  # noqa: E402
from PySide6.QtWebEngineWidgets import QWebEnginePage, QWebEngineView  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QFileDialog, QFrame, QLabel, QMainWindow, QProgressBar, QVBoxLayout, QWidget,
)

from ..crops.db import CropDB  # noqa: E402
from ..serve.product import create_app  # noqa: E402

APP_NAME = "AgroCast"
APP_VERSION = "2.5"
DEFAULT_PORT = 8765
INTEGRITY_NAME = "integrity.json"


# ------------------------------------------------------------------ поиск путей
def bundled_root() -> Path:
    """Корень, откуда запущено приложение (PyInstaller _MEIPASS / исходники)."""
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    # в исходниках: AgroCast/agrocast/desktop/app.py -> подняться на 3 уровня
    return Path(__file__).resolve().parent.parent.parent


def _candidate_roots() -> list[Path]:
    """4 места, где лежат ресурсы (root/name, root/_internal/name, ...)."""
    if hasattr(sys, "_MEIPASS"):
        root = Path(sys._MEIPASS)
        return [root, root.parent, root.parent / "AgroCast", root.parents[2]]
    here = Path(__file__).resolve()
    # dev: запуск из каталога AgroCast/ (app.py, package agrocast/, static/, world/)
    project = here.parent.parent
    exe_dir = project  # собранный onedir: exe в корне dist/AgroCast/, _internal рядом
    return [
        project,            # 1) root/name
        project / "_internal",  # 2) root/_internal/name
        project.parent / "AgroCast" / "_internal",  # 3) root/AgroCast/_internal/name
        project.parents[2],  # 4) parents[2]/name
    ]


def _find_dir(name: str) -> Path | None:
    """Ищет каталог name в 4 стандартных местах. Возвращает первый найденный."""
    checked = []
    for root in _candidate_roots():
        cand = root / name
        checked.append(str(cand))
        if cand.is_dir():
            return cand
    # если ничего не нашли — всё равно вернём самый вероятный путь,
    # чтобы сервер стартовал, а пользователь увидел понятное сообщение
    return _candidate_roots()[0] / name


def load_integrity(world_dir: Path | None) -> dict:
    """try/except для integrity.json — файл необязателен в каркасе."""
    data: dict = {"present": False, "ok": False}
    try:
        f = (world_dir or Path("world")) / INTEGRITY_NAME
        if f.is_file():
            data.update({"present": True})
            data.update(json.loads(f.read_text(encoding="utf-8")))
    except Exception as exc:  # noqa: BLE001
        data["error"] = str(exc)
    return data


# -------------------------------------------------------------------- QWebChannel
class DesktopBridge(QObject):
    """Мост JS <-> Python для десктоп-возможностей."""

    @Slot(result=str)
    def info(self) -> str:
        return json.dumps(
            {
                "app": APP_NAME,
                "version": APP_VERSION,
                "desktop": True,
                "stateDir": str(Path.home() / ".agrocast"),
            },
            ensure_ascii=False,
        )

    @Slot(str)
    def openExternal(self, url: str) -> None:
        if url.startswith(("http://", "https://")):
            QDesktopServices.openUrl(QUrl(url))

    @Slot(str, str, result=str)
    def saveTextFile(self, suggested_name: str, text: str) -> str:
        """Стандартный диалог «Сохранить как» (JSON/отчёт). Возвращает путь или ''."""
        path, _ = QFileDialog.getSaveFileName(
            None, f"{APP_NAME} {APP_VERSION} — сохранить", str(Path.home() / suggested_name), "JSON (*.json);;Все файлы (*)"
        )
        if not path:
            return ""
        try:
            Path(path).write_text(text, encoding="utf-8")
            return path
        except Exception as exc:  # noqa: BLE001
            return f"ERR:{exc}"

    @Slot(result=str)
    def cropsDbPath(self) -> str:
        return str(Path.home() / ".agrocast" / "crops.db")


# ---------------------------------------------------------------------- splash
class SplashScreen(QWidget):
    """Полупрозрачный splash: пульсирующая иконка + прогресс."""

    def __init__(self, icon_pixmap: QPixmap, text: str):
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self._k = 1.0
        self._up = True
        self._pix = icon_pixmap
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setFixedSize(380, 300)

        root = QVBoxLayout(self)
        root.setContentsMargins(40, 36, 40, 32)
        card = QFrame(self)
        card.setObjectName("splashCard")
        card.setStyleSheet(
            "QFrame#splashCard{background:#ffffff;border-radius:22px;"
            "border:1px solid #d6e2d8;}"
        )
        lay = QVBoxLayout(card)
        lay.setContentsMargins(24, 26, 24, 20)
        self.icon_label = QLabel(card)
        self.icon_label.setAlignment(Qt.AlignCenter)
        self.icon_label.setFixedHeight(120)
        self.icon_label.setPixmap(self._scaled(1.0))
        lay.addWidget(self.icon_label)

        self.title = QLabel(text, card)
        self.title.setAlignment(Qt.AlignCenter)
        self.title.setStyleSheet("font-size:17px;font-weight:700;color:#18251c;")
        lay.addWidget(self.title)

        self.progress = QProgressBar(card)
        self.progress.setRange(0, 100)
        self.progress.setTextVisible(False)
        self.progress.setFixedHeight(8)
        self.progress.setStyleSheet(
            "QProgressBar{border:none;background:#e6efe8;border-radius:4px;}"
            "QProgressBar::chunk{background:qlineargradient(x1:0,y1:0,x2:1,y2:0,"
            "stop:0 #1c6b3c, stop:1 #2e8b57);border-radius:4px;}"
        )
        lay.addWidget(self.progress)
        lay.addSpacing(4)
        sub = QLabel(f"{APP_NAME} {APP_VERSION} · локальные прогнозы · Краснодарский край", card)
        sub.setAlignment(Qt.AlignCenter)
        sub.setStyleSheet("font-size:11px;color:#5a6e5d;")
        lay.addWidget(sub)
        root.addWidget(card)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._started = time.monotonic()

    def _scaled(self, k: float) -> QPixmap:
        s = int(96 * k)
        if s < 10:
            s = 10
        return self._pix.scaled(s, s, Qt.KeepAspectRatio, Qt.SmoothTransformation)

    def _tick(self) -> None:
        if self._up:
            self._k += 0.02
            if self._k >= 1.1:
                self._up = False
        else:
            self._k -= 0.02
            if self._k <= 1.0:
                self._up = True
        self.icon_label.setPixmap(self._scaled(self._k))
        elapsed = time.monotonic() - self._started
        self.progress.setValue(min(99, int(elapsed / 1.4 * 100)))

    def run(self, seconds: float = 1.5) -> None:
        self._timer.start(30)
        stop = time.monotonic() + seconds
        while time.monotonic() < stop and self.isVisible():
            QApplication.processEvents()
            time.sleep(0.015)
        self._timer.stop()
        self.progress.setValue(100)
        QApplication.processEvents()
        self.close()


# -------------------------------------------------------------------- главное окно
class MainWindow(QMainWindow):
    def __init__(self, url: str, static_dir: Path, world_dir: Path, bridge: DesktopBridge):
        super().__init__()
        self._download_dir = Path.home() / "Downloads"
        self._download_dir.mkdir(parents=True, exist_ok=True)

        self.setWindowTitle(f"{APP_NAME} {APP_VERSION} — локальные агропрогнозы · Краснодарский край")
        self.resize(1440, 900)
        self.setMinimumSize(980, 640)

        icon_path = static_dir / "agrocast.png"
        if icon_path.is_file():
            self.setWindowIcon(QIcon(str(icon_path)))

        self.view = QWebEngineView(self)
        profile = QWebEngineProfile.defaultProfile()
        # JSON-кнопка: сохранение через blob-ссылку (скачивание)
        profile.downloadRequested.connect(self._on_download)
        page = QWebEnginePage(profile, self.view)
        self.view.setPage(page)

        # Печать отчёта: window.print() -> диалог сохранения PDF
        page.printRequested.connect(self._on_print_requested)

        channel = QWebChannel(page)
        channel.registerObject("bridge", bridge)
        page.setWebChannel(channel)
        self.view.load(QUrl(url))
        self.setCentralWidget(self.view)

    def _on_download(self, download: QWebEngineDownloadRequest) -> None:
        suggested = download.downloadFileName() or "agrocast.json"
        dest = self._download_dir / suggested
        download.setDownloadDirectory(str(self._download_dir))
        download.setDownloadFileName(suggested)
        try:
            download.accept()
        except Exception:  # noqa: BLE001
            pass
        self.statusBar().showMessage(f"Скачано: {dest}", 6000)

    def _on_print_requested(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "Печать отчёта в PDF", str(Path.home() / f"{APP_NAME}-report.pdf"), "PDF (*.pdf)"
        )
        if not path:
            return
        try:
            self.view.page().printToPdf(str(path))
            self.statusBar().showMessage(f"Отчёт сохранён: {path}", 6000)
        except Exception as exc:  # noqa: BLE001
            self.statusBar().showMessage(f"Ошибка печати: {exc}", 6000)


# ---------------------------------------------------------------------- сервер
def start_server(static_dir: Path, world_dir: Path, port: int = DEFAULT_PORT,
                 pump=None) -> tuple:
    """Запускает FastAPI (uvicorn) в потоке; возвращает (url, app, thread)."""
    app = create_app(static_dir=static_dir, world_dir=world_dir, desktop=True)

    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True, name="agrocast-api")
    thread.start()

    url = f"http://127.0.0.1:{port}/"
    # ждём, пока порт начнёт слушаться (до 15 сек), подкачивая события Qt
    import socket

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return url, app, thread
        except OSError:
            if pump:
                pump()
            time.sleep(0.1)
    raise RuntimeError(f"API-сервер не поднялся на порту {port}")


# ------------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv)
    argv += ["--disable-dev-shm-usage"]  # запасной вариант для WebEngine
    app_qt = QApplication(argv)
    app_qt.setApplicationName(APP_NAME)
    app_qt.setApplicationVersion(APP_VERSION)

    # --- ресурсы -------------------------------------------------------
    # явные пути из лаунчеров (AgroCast.bat/.sh) имеют приоритет
    static_dir = Path(os.environ["AGROCAST_STATIC_DIR"]) if os.environ.get("AGROCAST_STATIC_DIR") else _find_dir("static")
    world_dir = Path(os.environ["AGROCAST_WORLD_DIR"]) if os.environ.get("AGROCAST_WORLD_DIR") else _find_dir("world")
    migr_dir = Path(os.environ["AGROCAST_MIGRATIONS_DIR"]) if os.environ.get("AGROCAST_MIGRATIONS_DIR") else _find_dir("migrations")
    integrity = load_integrity(world_dir)
    _log = lambda msg: print(f"[agrocast] {msg}", flush=True)  # noqa: E731
    _log(f"static: {static_dir}")
    _log(f"world:  {world_dir}")
    _log(f"migrations: {migr_dir}")
    _log(f"integrity: {json.dumps(integrity, ensure_ascii=False)}")

    # прогреем базу сортов ДО окна (первый запуск — сид из world/artifacts)
    try:
        db = CropDB(state_dir=Path.home() / ".agrocast", seed_dir=world_dir / "artifacts")
        _log(f"crops db: {db.db_path} (сортов: {len(db.list())})")
        db.close()
    except Exception as exc:  # noqa: BLE001
        _log(f"crops db warning: {exc}")

    # --- splash ---------------------------------------------------------
    icon_pix = QPixmap()
    icon_file = static_dir / "agrocast.png"
    if icon_file.is_file():
        icon_pix.load(str(icon_file))
        app_qt.setWindowIcon(QIcon(icon_pix))
    splash = SplashScreen(icon_pix, f"{APP_NAME} {APP_VERSION} · Яндекс.Карта")
    splash.show()
    splash.raise_()
    QApplication.processEvents()

    def _pump():
        QApplication.processEvents()

    # --- локальный API ---------------------------------------------------
    try:
        url, api_app, api_thread = start_server(static_dir, world_dir, pump=_pump)
    except Exception as exc:  # noqa: BLE001
        splash.close()
        _log(f"FATAL: {exc}")
        from PySide6.QtWidgets import QMessageBox

        QMessageBox.critical(None, f"{APP_NAME} {APP_VERSION}", f"Не удалось запустить локальный сервер:\n{exc}")
        return 2

    # --- окно -------------------------------------------------------------
    bridge = DesktopBridge()
    win = MainWindow(url, static_dir, world_dir, bridge)
    win.show()

    # splash живёт ~1.5 сек поверх окна
    splash.run(seconds=1.5)
    win.activateWindow()
    win.raise_()

    rc = app_qt.exec()
    # вежливо гасим поток API
    try:
        api_app.state
    except Exception:  # noqa: BLE001
        pass
    return rc


if __name__ == "__main__":
    sys.exit(main())
