# -*- coding: utf-8 -*-
"""AgroCast 2.5 — моковые эндпоинты локального API.

Никаких настоящих расчётов/zarr/моделей: только каркасные данные.
Мир: world/config.json + world/artifacts/krai_grid.json + world/ready.json.
Сорта: SQLite ~/.agrocast/crops.db (класс CropDB).
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..crops.db import CropDB

# --------------------------------------------------------------------- пути мира
WORLD_HINTS = (
    ("world",),                                  # ./world
    ("_internal", "world"),                      # ./_internal/world  (PyInstaller onedir)
    ("AgroCast", "_internal", "world"),          # ./AgroCast/_internal/world
    ("..", "..", "world"),                       # parents[2]
)
ASSETS_HINTS = (
    ("static",),
    ("_internal", "static"),
    ("AgroCast", "_internal", "static"),
    ("..", "..", "static"),
)


def _find_dir(name_hints, base: Path | None = None) -> Path:
    """Ищет каталог по списку подсказок (4 места как в ТЗ)."""
    base = base or Path(__file__).resolve().parent.parent.parent.parent  # AgroCast/
    seen = set()
    for hint in name_hints:
        p = base.joinpath(*hint)
        try:
            p = p.resolve()
        except Exception:
            pass
        if p in seen or not p.is_dir():
            continue
        seen.add(p)
        if p.is_dir():
            return p
    # последний кандидат как есть (может не существовать — отдадим и этот путь)
    return base.joinpath(*name_hints[0])


class _World:
    def __init__(self, world_dir: str | Path | None = None, static_dir: str | Path | None = None):
        if not world_dir:
            world_dir = os.environ.get("AGROCAST_WORLD_DIR") or _find_dir(WORLD_HINTS)
        if not static_dir:
            static_dir = os.environ.get("AGROCAST_STATIC_DIR") or _find_dir(ASSETS_HINTS)
        self.world_dir = Path(world_dir)
        self.static_dir = Path(static_dir)
        self.config = self._json("config.json") or {}
        self.ready = self._json("ready.json") or {}
        self.grid_cells = (self._json("artifacts/krai_grid.json") or {}).get("grid", {}).get("cells", [])
        self.region = self.config.get("region", "Краснодарский край")

    def _json(self, rel: str):
        f = self.world_dir / rel
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            return None


def build_world(world_dir=None, static_dir=None) -> _World:
    return _World(world_dir, static_dir)


# ------------------------------------------------------------- модель запроса
class ForecastRequest(BaseModel):
    point_id: str = Field(default="P01")
    crop_id: str | None = None
    issue: str = Field(default="2026-03", pattern=r"^\d{4}-\d{2}$")
    horizon_months: int = Field(default=3, ge=1, le=12)
    lat: float | None = None
    lon: float | None = None


class CropPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    breeder: str = Field(default="", max_length=120)
    fao: int | None = Field(default=None, ge=50, le=650)
    sat: int | None = Field(default=None, ge=1500, le=3500)
    veg_days: int | None = Field(default=None, ge=60, le=200)
    yield_t_ha: float | None = Field(default=None, ge=0.1, le=30)
    frost_tolerable_c: float | None = Field(default=-2.0, ge=-8, le=0)
    frost_lethal_c: float | None = Field(default=-3.0, ge=-8, le=0)
    sow_from: str | None = Field(default=None, pattern=r"^\d{2}-\d{2}$")
    sow_to: str | None = Field(default=None, pattern=r"^\d{2}-\d{2}$")
    notes: str = Field(default="", max_length=2000)
    id: str | None = None


def make_router(world: _World) -> APIRouter:
    router = APIRouter()
    _state_dir = os.environ.get("AGROCAST_STATE_DIR") or str(Path.home() / ".agrocast")
    crop_db = CropDB(state_dir=_state_dir, seed_dir=world.world_dir / "artifacts")

    # ------------------------------------------------------------------- статус
    @router.get("/api/status")
    def api_status():
        return {
            "ok": True,
            "app": "AgroCast",
            "version": "2.5",
            "desktop": True,
            "ts": datetime.now().isoformat(timespec="seconds"),
        }

    # ------------------------------------------------------------- /api/region/*
    @router.get("/api/region/grid")
    def region_grid():
        return {
            "ok": True,
            "region": world.region,
            "bounds": {
                "lat_min": world.config.get("lat_min", 43.0),
                "lat_max": world.config.get("lat_max", 47.0),
                "lon_min": world.config.get("lon_min", 37.0),
                "lon_max": world.config.get("lon_max", 42.0),
            },
            "cells": world.grid_cells,
        }

    @router.get("/api/region/point/{point_id}")
    def region_point(point_id: str):
        for c in world.grid_cells:
            if c.get("id") == point_id:
                return {"ok": True, "point": c}
        raise HTTPException(status_code=404, detail=f"Точка {point_id} не найдена")

    # ------------------------------------------------------------------ сорта
    @router.get("/api/local/crops")
    def crops_list():
        return {"ok": True, "crops": crop_db.list(), "db": str(crop_db.db_path)}

    @router.post("/api/local/crops", status_code=201)
    def crops_create(payload: CropPayload):
        if not payload.name.strip():
            raise HTTPException(status_code=422, detail="Название сорта обязательно")
        try:
            crop = crop_db.add(
                id=payload.id, name=payload.name.strip(), breeder=payload.breeder.strip(),
                fao=payload.fao, sat=payload.sat, veg_days=payload.veg_days,
                yield_t_ha=payload.yield_t_ha,
                frost_tolerable_c=payload.frost_tolerable_c,
                frost_lethal_c=payload.frost_lethal_c,
                sow_from=payload.sow_from, sow_to=payload.sow_to, notes=payload.notes,
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Сорт с таким id уже существует")
        return {"ok": True, "crop": crop}

    @router.delete("/api/local/crops/{crop_id}")
    def crops_delete(crop_id: str):
        if crop_db.delete(crop_id):
            return {"ok": True, "deleted": crop_id}
        raise HTTPException(status_code=404, detail="Сорт не найден")

    @router.post("/api/local/crops/save")
    def crops_save(payload: CropPayload):
        """Сохранить сорт: создаёт новый или обновляет существующий по id/имени."""
        existing = None
        if payload.id:
            existing = crop_db.get(payload.id)
        if not existing:
            for c in crop_db.list():
                if c["name"].strip().lower() == payload.name.strip().lower():
                    existing = c
                    break
        kw = payload.model_dump()
        kw.pop("id", None)
        if existing:
            crop = crop_db.update(existing["id"], **kw)
            saved = "updated"
        else:
            crop = crop_db.add(**kw)
            saved = "created"
        return {"ok": True, "saved": saved, "crop": crop}

    # ------------------------------------------------------------- мок-прогноз
    @router.post("/api/local/forecast")
    def local_forecast(req: ForecastRequest):
        payload = _mock_payload(world, crop_db, req)
        return {
            "cached": False,
            "elapsed_s": 1.0,
            "payload": payload,
            "log": [
                "моковый расчет: реальная наука в каркасе не выполняется",
                f"точка {req.point_id}, выпуск {req.issue}, горизонт {req.horizon_months} мес.",
                "артефакты мира прочитаны, данные не скачивались",
            ],
        }

    # ------------------------------------------------------ входы и автономность
    @router.get("/api/local/inputs")
    def local_inputs():
        return {
            "ok": True,
            "autonomous": True,
            "inputs": {
                "cpc": {"kind": "CPC daily", "years": "1979-2024"},
                "soil": {"kind": "Почва NCEP"},
                "era5": {"kind": "ERA5 поля"},
                "blend": {"kind": "Модели блендера"},
            },
            "checks": {"world_ready": {"ok": bool(world.ready.get("ok"))}},
        }

    @router.get("/api/local/autonomy")
    def local_autonomy():
        return {
            "autonomous": True,
            "online": True,
            "checks": {"world_ready": {"ok": bool(world.ready.get("ok"))}},
            "services": {
                "yandex_maps": "external (карта грузится из интернета)",
                "science": "mock",
            },
        }

    # ------------------------------------------------------------ справка
    @router.get("/api/local/help")
    def local_help():
        return {
            "ok": True,
            "app": "AgroCast 2.5 (каркас, без расчётов)",
            "endpoints": [
                "GET  /api/region/grid",
                "GET  /api/local/crops",
                "POST /api/local/crops",
                "POST /api/local/crops/save",
                "DELETE /api/local/crops/{id}",
                "POST /api/local/forecast",
                "GET  /api/local/inputs",
                "GET  /api/local/autonomy",
            ],
        }

    return router


# ------------------------------------------------------------------- мок-данные
def _hash_seed(*parts) -> int:
    return int(hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:8], 16)


def _months_from(issue: str, horizon: int) -> list[str]:
    y, m = int(issue[:4]), int(issue[5:7])
    out = []
    for i in range(max(1, horizon)):
        yy, mm = y + (m - 1 + i) // 12, (m - 1 + i) % 12 + 1
        out.append(f"{yy:04d}-{mm:02d}")
    return out


def _mock_payload(world: _World, db: CropDB, req: ForecastRequest) -> dict:
    cells = world.grid_cells
    point = next((c for c in cells if c.get("id") == req.point_id), {})
    crop = db.get(req.crop_id) if req.crop_id else None
    lat = req.lat if req.lat is not None else point.get("lat", 45.04)
    lon = req.lon if req.lon is not None else point.get("lon", 38.98)
    months = _months_from(req.issue, req.horizon_months)
    seed = _hash_seed(req.point_id, req.issue, req.horizon_months)

    seasons = []
    for i, mm in enumerate(months):
        h = _hash_seed(seed, mm)
        base_t = 7.0 + (i * 4.2) + (h % 35) / 10.0
        t2m_q = {
            "p10": round(base_t - 2.2, 1),
            "p50": round(base_t + 0.4, 1),
            "p90": round(base_t + 3.1, 1),
        }
        t2m_ter = [0.15 + (h % 3) * 0.05, 0.45 + ((h >> 3) % 3) * 0.03, 0.0]
        t2m_ter[2] = round(1.0 - t2m_ter[0] - t2m_ter[1], 2)
        tp_mm = {
            "p10": round(18 + (h % 60), 1),
            "p50": round(38 + ((h >> 4) % 70), 1),
            "p90": round(66 + ((h >> 8) % 90), 1),
        }
        tp_ter = [0.2 + ((h >> 2) % 3) * 0.04, 0.42 + ((h >> 6) % 3) * 0.05, 0.0]
        tp_ter[2] = round(1.0 - tp_ter[0] - tp_ter[1], 2)
        seasons.append(
            {
                "months": [mm],
                "t2m": {
                    "quantiles_c": t2m_q,
                    "tercile_probs": {"below": t2m_ter[0], "normal": t2m_ter[1], "above": t2m_ter[2]},
                },
                "tp": {
                    "quantiles_mm": tp_mm,
                    "tercile_probs": {"below": tp_ter[0], "normal": tp_ter[1], "above": tp_ter[2]},
                },
            }
        )

    crop_name = crop["name"] if crop else "—"
    fao = (crop or {}).get("fao") or 200
    sow_from, sow_to = (crop or {}).get("sow_from") or "04-10", (crop or {}).get("sow_to") or "04-30"
    # простая текстовая «подсказка» каркаса (не расчёт)
    hint_sow = f"Сейте в окно {sow_from} – {sow_to}" if req.issue >= "2026" else "Исторический прогон: сравните с фактическими данными"
    what_to_do = [
        {"level": "ok", "action": hint_sow, "reason": f"Вероятность заморозка ~{6 + fao // 50}% после окна"},
        {"level": "info", "action": "Проверьте влагозапас перед севом", "reason": "Осадки марта в норме"},
        {"level": "warn", "action": "Запланируйте подкормку азотом на фазу 3-5 листьев", "reason": "Теплообеспеченность близка к норме"},
    ]
    payload = {
        "start": req.issue,
        "point_id": req.point_id,
        "point_name": point.get("name", req.point_id),
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "crop_id": req.crop_id,
        "crop_name": crop_name,
        "horizon_months": req.horizon_months,
        "seasons": seasons,
        "agro": {
            "what_to_do": what_to_do,
            "insight": {
                "water": {
                    "et0_mm": {"p50": round(96 + fao * 0.05, 1)},
                    "precip_mm": {"p50": round(55 + fao * 0.03, 1)},
                    "deficit_mm": round(60 + fao * 0.08, 1),
                    "irrigation_m3_ha": {"p50": round(540 + fao * 0.5, 0), "p10": round(880 + fao * 0.5, 0)},
                },
                "sat": {"gdd": {"crops": []}},
                "frost": {"span": [sow_from, sow_to], "p_frost_any": round(0.08 + fao / 2000.0, 2)},
                "risks": [
                    {"risk": "засуха в июле", "level": "low", "p": 0.18},
                    {"risk": "переувлажнение при севе", "level": "low", "p": 0.12},
                ],
            },
            "phenology": {"crops": []},
        },
    }
    # фено-карточки (мок): наполняем только текстом для UI
    if crop:
        gdd = {"crops": [{"name": crop_name, "fao": fao, "need_gdd": (crop or {}).get("sat") or 2300, "p_enough": round(0.72 + (fao % 20) / 100.0, 2)}]}
        payload["agro"]["insight"]["sat"]["gdd"] = gdd
        payload["agro"]["phenology"] = {
            "crops": [
                {
                    "name": crop_name,
                    "phases": [
                        {"phase": "всходы", "window": f"{sow_from}+10 дн", "note": "при t почвы > 10 °C"},
                        {"phase": "3-5 листьев", "window": "июнь", "note": "гербицидная обработка"},
                        {"phase": "выметывание", "window": "июль", "note": "контроль влагообеспеченности"},
                        {"phase": "молочно-восковая спелость", "window": "август", "note": "оценка полегания"},
                    ]
                }
            ]
        }
    return payload
