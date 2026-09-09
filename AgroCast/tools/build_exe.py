#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AgroCast 2.5 — сборка EXE (Windows) и упаковка в zip.

Запуск (на Windows, Python 3.11):
    python tools/build_exe.py

Что делает:
  1. доустанавливает requirements (в т.ч. PySide6, pyinstaller);
  2. собирает onedir через AgroCast.spec  ->  dist/AgroCast/AgroCast.exe + _internal/;
     если spec-сборка не удалась — повторяет эквивалентной CLI-командой PyInstaller;
  3. пакует dist/AgroCast  ->  dist/AgroCast-2.5-exe.zip;
  4. весь вывод пишется в dist/build_exe.log (для диагностики CI).

Ожидаемый результат zip 50–150 МБ (PySide6 + QtWebEngine).
"""
from __future__ import annotations

import subprocess
import sys
import traceback
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP_DIR = DIST / "AgroCast"
ZIP_OUT = DIST / "AgroCast-2.5-exe.zip"
LOG = DIST / "build_exe.log"


def log(msg: str = "") -> None:
    # сначала в файл — консоль CI может оборваться, а лог должен уцелеть
    try:
        if LOG:
            with LOG.open("a", encoding="utf-8") as f:
                f.write(str(msg) + "\n")
    except Exception:
        pass
    try:
        print(msg, flush=True)
    except Exception:
        pass


def run(cmd: list[str], cwd: Path = ROOT, check: bool = True, timeout: int = 900) -> int:
    log(">>> " + " ".join(cmd))
    # stdout пишем напрямую в файл-лог (без pipe — пайп может «зависнуть»,
    # если внучатый процесс унаследовал дескриптор)
    with LOG.open("ab") as logf:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), stdout=logf, stderr=subprocess.STDOUT,
        )
        try:
            rc = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log(f"TIMEOUT {timeout}s — убиваю процесс")
            try:
                proc.kill()
            except Exception:
                pass
            proc.wait(timeout=30)
            rc = -1
    log("")
    if check and rc != 0:
        raise subprocess.CalledProcessError(rc, cmd)
    return rc or 0


def emit_error(title: str) -> None:
    """Печатает аннотацию GitHub Actions с КОНЦОМ лога (видно через API)."""
    body = title
    try:
        if LOG.is_file():
            text = LOG.read_text(encoding="utf-8", errors="replace")
            body = text[-3800:] or title
    except Exception:
        pass
    enc = body.replace("\r", "").replace("%", "%25").replace("\n", "%0A")
    print(f"::error title={title}::{enc}", flush=True)


def build_pyinstaller() -> None:
    sep = ";" if sys.platform == "win32" else ":"
    spec = ROOT / "AgroCast.spec"
    cli = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--onedir", "--windowed", "--name", "AgroCast",
        "--icon", str(ROOT / "static" / "agrocast.ico"),
        "--add-data", f"static{sep}static",
        "--add-data", f"world{sep}world",
        "--add-data", f"migrations{sep}migrations",
        # без --collect-all PySide6: нужные Qt-модули подтянутся сами по импортам
        str(ROOT / "app.py"),
    ]
    attempts = [("spec", [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(spec)]),
                ("cli-fallback", cli)]
    for i, (label, cmd) in enumerate(attempts, 1):
        try:
            run(cmd)
            log(f"PyInstaller OK ({label}, попытка {i})")
            return
        except subprocess.CalledProcessError as exc:
            log(f"попытка {i} ({label}) не удалась: rc={exc.returncode}")
    raise RuntimeError("PyInstaller: все попытки сборки не удались")


def main() -> int:
    DIST.mkdir(parents=True, exist_ok=True)
    if LOG.exists():
        LOG.unlink()
    log("AgroCast 2.5 build | root: " + str(ROOT))
    if not (ROOT / "static" / "agrocast.png").is_file():
        log("Не найден static/agrocast.png — запустите tools/prepare_assets.py")
        emit_error("AgroCast build: missing assets")
        return 1
    try:
        run([sys.executable, "-m", "pip", "install", "--upgrade", "-q", "-r", str(ROOT / "requirements.txt")])
        if sys.platform != "win32":
            log("PyInstaller-сборку EXE выполняйте на Windows (QtWebEngine).")
            return 2
        build_pyinstaller()
        exe = APP_DIR / "AgroCast.exe"
        if not exe.is_file():
            log(f"Сборка не удалась: нет {exe}")
            emit_error("AgroCast build: AgroCast.exe not produced")
            return 3
        internal = APP_DIR / "_internal"
        missing = [s for s in ("static", "world", "migrations") if not (internal / s).is_dir()]
        if missing:
            log("ВНИМАНИЕ: нет _internal/" + ", ".join(missing))
        if ZIP_OUT.exists():
            ZIP_OUT.unlink()
        log("Упаковка dist/AgroCast -> " + str(ZIP_OUT))
        with zipfile.ZipFile(ZIP_OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for f in sorted(APP_DIR.rglob("*")):
                if f.is_file():
                    zf.write(f, f.relative_to(DIST).as_posix())
        size_mb = ZIP_OUT.stat().st_size / 1024 / 1024
        log(f"OK: {ZIP_OUT} ({size_mb:.1f} МБ)")
        return 0
    except Exception as exc:  # noqa: BLE001
        log("")
        log("===== TRACEBACK =====")
        tb = traceback.format_exc()
        log(tb)
        # дополнительная страховка: traceback отдельным файлом
        try:
            (DIST / "build_error.txt").write_text(tb, encoding="utf-8")
        except Exception:
            pass
        emit_error(f"AgroCast build failed: {exc}")
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
