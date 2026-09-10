/**
 * Версионированные миграции схемы.
 *
 * Правила:
 *   - номер версии только растёт, откат не выполняется;
 *   - каждая миграция идёт в транзакции;
 *   - база с версией новее, чем умеет приложение, не «чинится» молча —
 *     вместо сброса показывается ошибка (данные пользователя важнее);
 *   - повреждённый файл сохраняет копия, сделанная слоем персистентности.
 */

export const LATEST_VERSION = 2;

export class MigrationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MigrationError";
    this.code = options.code ?? "MIGRATION_FAILED";
    this.cause = options.cause;
  }
}

/** Демонстрационная запись сорта — создаётся только при инициализации новой базы. */
const DEMO_VARIETY_NAME = "Демонстрационный сорт";

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "init",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS varieties (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('sort', 'hybrid')),
          breeder TEXT,
          fao INTEGER CHECK (fao IS NULL OR (typeof(fao) = 'integer' AND fao > 0)),
          vegetation_days INTEGER
            CHECK (vegetation_days IS NULL OR (typeof(vegetation_days) = 'integer' AND vegetation_days > 0)),
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_varieties_name ON varieties (name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS datasets (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          mode TEXT NOT NULL,
          source TEXT NOT NULL,
          engine_version TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          variety_id TEXT REFERENCES varieties (id) ON DELETE SET NULL,
          variety_name TEXT NOT NULL,
          range_months INTEGER NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          indicators TEXT NOT NULL,
          risks TEXT NOT NULL,
          risks_status TEXT NOT NULL,
          provenance TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dataset_rows (
          dataset_id TEXT NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          temperature_mean REAL NOT NULL,
          temperature_min REAL NOT NULL,
          temperature_max REAL NOT NULL,
          precipitation_mm REAL NOT NULL,
          relative_humidity_pct REAL NOT NULL,
          PRIMARY KEY (dataset_id, date)
        );

        CREATE INDEX IF NOT EXISTS idx_dataset_rows_date ON dataset_rows (date);
      `);
    },
  },
  {
    version: 2,
    name: "reports-and-settings",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          result_key TEXT NOT NULL UNIQUE,
          dataset_id TEXT REFERENCES datasets (id) ON DELETE SET NULL,
          variety_id TEXT REFERENCES varieties (id) ON DELETE SET NULL,
          variety_snapshot TEXT NOT NULL,
          result TEXT NOT NULL,
          mode TEXT NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          range_months INTEGER NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reports_variety ON reports (variety_id);

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Только при первой инициализации базы: одна явно помеченная запись.
      const existing = db.get("SELECT id FROM varieties LIMIT 1");
      if (!existing) {
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO varieties (id, name, type, breeder, fao, vegetation_days, notes, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
          ["00000000-0000-4000-8000-000000000001", DEMO_VARIETY_NAME, "sort", "Тестовая запись для проверки интерфейса.", now, now],
        );
      }
    },
  },
]);

export function readVersion(db) {
  if (!hasTable(db, "schema_migrations")) return 0;
  const row = db.get("SELECT MAX(version) AS version FROM schema_migrations");
  return Number(row?.version ?? 0);
}

export function hasTable(db, name) {
  const row = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", [name]);
  return Boolean(row);
}

/** Есть ли в базе хоть одна пользовательская таблица. */
export function hasUserData(db) {
  const row = db.get(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return Number(row?.count ?? 0) > 0;
}

/**
 * Применяет недостающие миграции.
 * @returns {{applied:number[], version:number, fresh:boolean}}
 */
export function migrate(db) {
  const current = readVersion(db);
  const hadTables = hasUserData(db);
  if (current > LATEST_VERSION) {
    throw new MigrationError(
      "База создана более новой версией приложения. Автоматический сброс отключён, данные не изменены.",
      { code: "DB_TOO_NEW" },
    );
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > current).sort(
    (a, b) => a.version - b.version,
  );
  const applied = [];

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.version);
  }

  // «Новая база» — до миграций не было ни одной пользовательской таблицы.
  const fresh = current === 0 && !hadTables;

  if (fresh) {
    db.run(
      "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ["databaseInitializedAt", new Date().toISOString(), new Date().toISOString()],
    );
  }

  return { applied, version: readVersion(db), fresh };
}
