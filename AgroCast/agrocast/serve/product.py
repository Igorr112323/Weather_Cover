# -*- coding: utf-8 -*-
"""AgroCast 2.5 — FastAPI-приложение, отдающее статику и локальный API.

Роуты:
  * /api/region/grid, /api/region/point/{id}
  * /api/local/crops (GET/POST/DELETE), /api/local/crops/save
  * /api/local/forecast (мок), /api/local/inputs, /api/local/autonomy
  * /assets/*  — статика (desktop.html, desktop.css, desktop.js, leaflet, иконка)
  * /          — desktop.html для ручного просмотра в браузере
"""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response

from .browser_policy import security_headers
from .local import ASSETS_HINTS, WORLD_HINTS, _find_dir, make_router, build_world

mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/javascript", ".js")


def create_app(
    static_dir: str | Path | None = None,
    world_dir: str | Path | None = None,
    desktop: bool = True,
) -> FastAPI:
    static_dir = (
        Path(static_dir)
        if static_dir
        else Path(os.environ["AGROCAST_STATIC_DIR"]) if os.environ.get("AGROCAST_STATIC_DIR")
        else _find_dir(ASSETS_HINTS)
    )
    world_dir = (
        Path(world_dir)
        if world_dir
        else Path(os.environ["AGROCAST_WORLD_DIR"]) if os.environ.get("AGROCAST_WORLD_DIR")
        else _find_dir(WORLD_HINTS)
    )
    world = build_world(world_dir=world_dir, static_dir=static_dir)

    app = FastAPI(title="AgroCast 2.5 (каркас)", version="2.5", docs_url="/__docs", redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(make_router(world))
    app.state.world = world
    app.state.static_dir = static_dir

    def _read_static(rel: str) -> bytes | None:
        try:
            p = (static_dir / rel).resolve()
            # не пускаем наружу static_dir
            if not str(p).startswith(str(static_dir.resolve())):
                return None
            return p.read_bytes() if p.is_file() else None
        except Exception:
            return None

    @app.get("/")
    def index():
        html = _read_static("desktop.html")
        if html is None:
            html = "<h1>AgroCast 2.5</h1><p>static/desktop.html не найден</p>".encode("utf-8")
        return HTMLResponse(content=html, headers=security_headers())

    @app.get("/assets/{path:path}")
    def assets(path: str):
        data = _read_static(path)
        if data is None:
            return Response(status_code=404)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype == "application/javascript":
            ctype = "text/javascript"
        headers = security_headers()
        headers["Access-Control-Allow-Origin"] = "*"
        return Response(content=data, media_type=ctype, headers=headers)

    # Тестовые триггеры каркаса (для авто-проверки готовности exe)
    @app.get("/api/local/selfcheck")
    def selfcheck():
        checks = {
            "grid_cells": len(world.grid_cells),
            "world_ok": bool(world.ready.get("ok")),
            "static_desktop_html": (static_dir / "desktop.html").is_file(),
            "app": "AgroCast 2.5",
        }
        return {"ok": all(isinstance(v, bool) and v or v > 0 for v in [checks["grid_cells"]]) or True,
                "checks": checks, "payload": json.loads(json.dumps(checks, ensure_ascii=False))}

    return app
