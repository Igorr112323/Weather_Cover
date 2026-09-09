# -*- coding: utf-8 -*-
"""AgroCast 2.5 — справочник сортов кукурузы (SQLite).

База живёт в ~/.agrocast/crops.db и создаётся классом CropDB.
При первом запуске сидится из world/artifacts/crop_seed.json
(обязательно read_text(encoding='utf-8') — иначе кракозябры).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from pathlib import Path

_SEED_NAME = "crop_seed.json"
_DB_NAME = "crops.db"


def _num(value):
    """Приводит значение к float/int без падения (база терпит «12», 12, None)."""
    if value is None:
        return None
    try:
        f = float(value)
        return f if f % 1 else int(f)
    except (TypeError, ValueError):
        return None


class CropDB:
    def __init__(self, state_dir: str | Path | None = None, seed_dir: str | Path | None = None):
        self.state_dir = Path(state_dir or (Path.home() / ".agrocast"))
        self.db_path = self.state_dir / _DB_NAME
        self.seed_dir = Path(seed_dir) if seed_dir else None
        self.state_dir.mkdir(parents=True, exist_ok=True)
        # API (FastAPI) ходит в БД из потоков threadpool — разрешаем кросс-поток,
        # а доступ сериализуем локом
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._ensure_schema()
        if self._is_empty():
            self.seed_from_file()

    # ------------------------------------------------------------------ schema
    def _ensure_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS crops (
                    id           TEXT PRIMARY KEY,
                    name         TEXT NOT NULL,
                    breeder      TEXT DEFAULT '',
                    fao          INTEGER,
                    sat          INTEGER,
                    veg_days     INTEGER,
                    yield_t_ha   REAL,
                    frost_tolerable_c REAL,
                    frost_lethal_c    REAL,
                    sow_from     TEXT,
                    sow_to       TEXT,
                    notes        TEXT DEFAULT '',
                    created_at   TEXT DEFAULT (datetime('now')),
                    updated_at   TEXT DEFAULT (datetime('now'))
                )
                """
            )
            self._conn.commit()

    def _is_empty(self) -> bool:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM crops").fetchone()
            return int(row["n"]) == 0

    # -------------------------------------------------------------------- seed
    def seed_from_file(self, seed_dir: str | Path | None = None) -> int:
        """Заполняет пустую базу сортами из crop_seed.json (UTF-8!)."""
        roots = [Path(seed_dir)] if seed_dir else []
        if self.seed_dir:
            roots.append(self.seed_dir)
        roots += self._candidate_roots()
        for root in roots:
            f = root / _SEED_NAME
            if f.is_file():
                try:
                    text = f.read_text(encoding="utf-8")
                    data = json.loads(text)
                    return self._import_seed(data)
                except Exception:
                    continue
        return 0

    def _candidate_roots(self):
        here = Path(__file__).resolve()
        return [
            here.parent.parent.parent / "world" / "artifacts",     # AgroCast/world/artifacts
            here.parent.parent / "world" / "artifacts",
            here.parent.parent.parent.parent / "world" / "artifacts",
        ]

    def _import_seed(self, data: dict) -> int:
        items = data.get("crops") if isinstance(data, dict) else None
        if not items:
            return 0
        n = 0
        for it in items:
            row = {
                "id": it.get("id") or f"crop_{uuid.uuid4().hex[:10]}",
                "name": it.get("name", "").strip(),
                "breeder": it.get("breeder") or "",
                "fao": _num(it.get("fao")),
                "sat": _num(it.get("sat")),
                "veg_days": _num(it.get("veg_days")),
                "yield_t_ha": _num(it.get("yield_t_ha")),
                "frost_tolerable_c": _num(it.get("frost_tolerable_c")),
                "frost_lethal_c": _num(it.get("frost_lethal_c")),
                "sow_from": it.get("sow_from") or "",
                "sow_to": it.get("sow_to") or "",
                "notes": it.get("notes") or "",
            }
            if not row["name"]:
                continue
            if self.get(row["id"]):
                self.update(**row)
            else:
                self.add(**row)
            n += 1
        return n

    # --------------------------------------------------------------------- CRUD
    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        # JSON-ответ должен быть чистым: все числа — числа
        for k in ("fao", "sat", "veg_days"):
            if d.get(k) is not None:
                d[k] = int(d[k])
        for k in ("yield_t_ha", "frost_tolerable_c", "frost_lethal_c"):
            if d.get(k) is not None:
                d[k] = float(d[k])
        return d

    def add(self, **kw) -> dict:
        cid = kw.get("id") or f"crop_{uuid.uuid4().hex[:10]}"
        with self._lock:
            self._conn.execute(
                """INSERT INTO crops
                   (id, name, breeder, fao, sat, veg_days, yield_t_ha,
                    frost_tolerable_c, frost_lethal_c, sow_from, sow_to, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    cid, kw.get("name", "").strip(), kw.get("breeder", ""),
                    _num(kw.get("fao")), _num(kw.get("sat")), _num(kw.get("veg_days")),
                    _num(kw.get("yield_t_ha")), _num(kw.get("frost_tolerable_c")),
                    _num(kw.get("frost_lethal_c")), kw.get("sow_from", ""),
                    kw.get("sow_to", ""), kw.get("notes", ""),
                ),
            )
            self._conn.commit()
        return self.get(cid)

    def update(self, crop_id: str | None = None, **kw) -> dict | None:
        cid = crop_id or kw.get("id")
        if not cid or not self.get(cid):
            return None
        fields = ["name", "breeder", "fao", "sat", "veg_days", "yield_t_ha",
                  "frost_tolerable_c", "frost_lethal_c", "sow_from", "sow_to", "notes"]
        sets, vals = [], []
        for f in fields:
            if f in kw:
                v = kw[f]
                sets.append(f"{f}=?")
                vals.append(v if f in ("name", "breeder", "notes", "sow_from", "sow_to") else _num(v))
        vals.append(cid)
        if sets:
            with self._lock:
                self._conn.execute(
                    f"UPDATE crops SET {', '.join(sets)}, updated_at=datetime('now') WHERE id=?",
                    vals,
                )
                self._conn.commit()
        return self.get(cid)

    def get(self, crop_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM crops WHERE id=?", (crop_id,)).fetchone()
            return self._row_to_dict(row) if row else None

    def list(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM crops ORDER BY fao IS NULL, fao, name COLLATE NOCASE"
            ).fetchall()
            return [self._row_to_dict(r) for r in rows]

    def delete(self, crop_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM crops WHERE id=?", (crop_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass
