# -*- coding: utf-8 -*-
"""Smoke-тесты каркаса AgroCast 2.5 (только API, без Qt).

Запуск:  pytest tests/ -v
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Отдельный state_dir на каждый тест — база сидится заново из seed."""
    monkeypatch.setenv("AGROCAST_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("AGROCAST_STATIC_DIR", str(ROOT / "static"))
    monkeypatch.setenv("AGROCAST_WORLD_DIR", str(ROOT / "world"))
    from agrocast.serve.product import create_app

    app = create_app(static_dir=ROOT / "static", world_dir=ROOT / "world")
    with TestClient(app) as c:
        yield c


def test_index_serves_desktop_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "AgroCast" in r.text
    assert "2.5" in r.text
    csp = r.headers.get("content-security-policy", "")
    assert "img-src 'self' data: https://tile.openstreetmap.org" in csp, "потеряна тестовая подстрока CSP"
    assert "api-maps.yandex.ru" in csp


def test_assets_served(client):
    for path in ("/assets/desktop.html", "/assets/desktop.js", "/assets/desktop.css",
                 "/assets/agrocast.png", "/assets/markers/marker-green.svg",
                 "/assets/vendor/leaflet/leaflet.js", "/assets/vendor/leaflet/leaflet.css",
                 "/assets/favicon.png"):
        r = client.get(path)
        assert r.status_code == 200, path
    r = client.get("/assets/nope.png")
    assert r.status_code == 404


def test_grid_28_points(client):
    r = client.get("/api/region/grid")
    d = r.json()
    assert d["ok"] and len(d["cells"]) == 28
    ids = [c["id"] for c in d["cells"]]
    assert ids[0] == "P01" and ids[-1] == "P28"
    for c in d["cells"]:
        assert 43.0 < c["lat"] < 47.0 and 37.0 < c["lon"] < 42.0


def test_crops_seed_utf8_and_crud(client):
    r = client.get("/api/local/crops")
    d = r.json()
    crops = d["crops"]
    assert len(crops) >= 7
    # без кракозябр: русские названия читаемы
    names = " ".join(c["name"] for c in crops)
    assert "Краснодарский 194 МВ" in names and "СИ Фуэго" in names
    assert "Ð" not in names  # признак UTF-8-поломки
    # create
    r = client.post("/api/local/crops/save", json={"name": "Тест К-77", "fao": 180, "sat": 2100,
                                                   "veg_days": 100, "yield_t_ha": 6.5})
    assert r.status_code == 200
    crop_id = r.json()["crop"]["id"]
    assert r.json()["saved"] == "created"
    # update
    r = client.post("/api/local/crops/save", json={"id": crop_id, "name": "Тест К-77 v2", "fao": 190})
    assert r.status_code == 200 and r.json()["saved"] == "updated"
    # list contains updated
    names2 = " ".join(c["name"] for c in client.get("/api/local/crops").json()["crops"])
    assert "Тест К-77 v2" in names2
    # delete
    r = client.delete(f"/api/local/crops/{crop_id}")
    assert r.status_code == 200


def test_crop_validation(client):
    r = client.post("/api/local/crops/save", json={"name": "X", "fao": 9999})
    # fao вне диапазона -> 422
    assert r.status_code == 422


def test_forecast_mock_shape(client):
    r = client.post("/api/local/forecast", json={
        "point_id": "P01", "crop_id": "crop_krasnodar_194_mv",
        "issue": "2026-03", "horizon_months": 3,
    })
    assert r.status_code == 200
    d = r.json()
    assert d["cached"] is False
    p = d["payload"]
    assert p["start"] == "2026-03" and p["point_id"] == "P01"
    months = [s["months"][0] for s in p["seasons"]]
    assert months == ["2026-03", "2026-04", "2026-05"]
    s0 = p["seasons"][0]
    for key in ("t2m", "tp"):
        assert "quantiles_c" in s0[key] or "quantiles_mm" in s0[key]
        assert "tercile_probs" in s0[key]
    assert p["agro"]["what_to_do"] and p["agro"]["insight"]["water"]["deficit_mm"]
    assert p["agro"]["insight"]["sat"]["gdd"]["crops"][0]["p_enough"] > 0
    assert p["agro"]["phenology"]["crops"][0]["phases"]


def test_autonomy_and_inputs(client):
    a = client.get("/api/local/autonomy").json()
    assert a["autonomous"] is True and a["checks"]["world_ready"]["ok"] is True
    i = client.get("/api/local/inputs").json()
    assert i["checks"]["world_ready"]["ok"] is True


def test_world_ready(client):
    # world/ready.json == {"ok": true}
    r = client.get("/api/local/autonomy").json()
    assert r["checks"]["world_ready"]["ok"] is True


def test_uvicorn_windowed_no_stdout(monkeypatch):
    """Регрессия: windowed-exe имеет sys.stdout=None, uvicorn.Config падал
    с 'Unable to configure formatter default' -> с log_config=None не падает."""
    import sys

    import uvicorn

    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    class _App:
        pass

    cfg = uvicorn.Config(
        _App(), host="127.0.0.1", port=0,
        log_level="warning", access_log=False, log_config=None,
    )
    assert cfg.log_config is None
