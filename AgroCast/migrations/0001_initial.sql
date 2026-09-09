-- 0001_initial.sql — AgroCast 2.5 (каркас)
-- Таблицы сортов создаются классом CropDB в ~/.agrocast/crops.db.
-- Этот файл кладётся в _internal/migrations как маркер версии схемы.

CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
