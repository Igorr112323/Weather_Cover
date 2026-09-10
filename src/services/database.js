/**
 * Слой доступа к SQLite (sql.js).
 *
 * Только параметризованные запросы: значения передаются массивом params,
 * строки в SQL не конкатенируются нигде в приложении.
 *
 * Все изменения данных идут через DatabaseService.commit(), который
 * 1) выполняет правки в транзакции,
 * 2) сериализует базу,
 * 3) ждёт записи на носитель.
 * Успех показывается только после шага 3 — иначе интерфейс врал бы о сохранности.
 */

import { createSerialQueue } from "../lib/async.js";
import { migrate, readVersion, LATEST_VERSION } from "./migrations.js";

export class DatabaseError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DatabaseError";
    this.code = options.code ?? "DB_ERROR";
    this.cause = options.cause;
  }

  /** Сообщение без технических деталей: путь, SQL и стек остаются в консоли. */
  get userMessage() {
    return this.message;
  }
}

/**
 * Узкая обёртка над базой sql.js: объекты вместо кортежей, транзакции,
 * экспорт байтов.
 */
export function createHandle(db) {
  let depth = 0;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new DatabaseError("База закрыта", { code: "DB_CLOSED" });
  };

  function bindParams(statement, params) {
    const values = Array.isArray(params) ? params : params ? Object.values(params) : [];
    if (values.length === 0) return;
    // sql.js принимает массив примитивов; undefined → NULL, boolean → 0/1
    statement.bind(values.map(normalizeParam));
  }

  const handle = {
    get raw() {
      return db;
    },

    /** Все строки результата. */
    all(sql, params = []) {
      assertOpen();
      const statement = db.prepare(sql);
      try {
        bindParams(statement, params);
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } catch (error) {
        throw new DatabaseError(`Запрос завершился ошибкой: ${safeSqlMessage(error)}`, {
          code: "QUERY_FAILED",
          cause: error,
        });
      } finally {
        statement.free();
      }
    },

    /** Первая строка результата или null. */
    get(sql, params = []) {
      const rows = handle.all(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },

    /** Выполняет запрос без возврата строк. Возвращает {changes, lastInsertRowid}. */
    run(sql, params = []) {
      assertOpen();
      try {
        db.run(sql, Array.isArray(params) ? params.map(normalizeParam) : params);
        return { changes: db.getRowsModified(), lastInsertRowid: db.lastInsertRowid };
      } catch (error) {
        throw new DatabaseError(`Запрос завершился ошибкой: ${safeSqlMessage(error)}`, {
          code: "QUERY_FAILED",
          cause: error,
        });
      }
    },

    /** Несколько операторов без параметров (DDL в миграциях). */
    exec(sql) {
      assertOpen();
      try {
        db.exec(sql);
      } catch (error) {
        throw new DatabaseError(`Запрос завершился ошибкой: ${safeSqlMessage(error)}`, {
          code: "QUERY_FAILED",
          cause: error,
        });
      }
    },

    count(table, where = "", params = []) {
      const sql = `SELECT COUNT(*) AS count FROM ${table}${where ? ` ${where}` : ""}`;
      return Number(handle.get(sql, params)?.count ?? 0);
    },

    /**
     * Транзакция с вложенными savepoint'ами.
     * @param {() => T} fn
     */
    transaction(fn) {
      assertOpen();
      const outermost = depth === 0;
      const savepoint = `sp_${depth}`;
      if (outermost) handle.exec("BEGIN IMMEDIATE");
      else handle.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        if (outermost) handle.exec("COMMIT");
        else handle.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth -= 1;
        try {
          if (outermost) handle.exec("ROLLBACK");
          else handle.exec(`ROLLBACK TO ${savepoint}`);
        } catch {
          // соединение уже могло быть закрыто — ошибку ниже покажем как есть
        }
        throw error;
      }
    },

    /** Бинарное представление базы для записи на диск. */
    exportBytes() {
      assertOpen();
      return db.export();
    },

    version() {
      return readVersion(handle);
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* уже закрыто */
      }
    },
  };

  return handle;
}

function normalizeParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** Текст ошибки SQLite без SQL-запроса и путей — их не показываем пользователю. */
function safeSqlMessage(error) {
  const raw = String(error?.message ?? error ?? "").split("\n")[0];
  return raw.slice(0, 180);
}

/**
 * Открывает базу из байтов (или создаёт новую), применяет миграции.
 *
 * @param {{SQL:any, bytes?:Uint8Array|null, persistence?:{write:(bytes:Uint8Array)=>Promise<any>}}} options
 * @returns {{handle:any, needsPersist:boolean, fresh:boolean, version:number}}
 */
export function openDatabase({ SQL, bytes = null, persistence = null }) {
  let db;
  let created = false;
  try {
    db = bytes && bytes.byteLength > 0 ? new SQL.Database(bytes) : new SQL.Database();
  } catch (error) {
    const wrapped = new DatabaseError(
      "Файл базы данных повреждён или не читается. Приложение не стало его изменять.",
      { code: "DB_UNREADABLE", cause: error },
    );
    wrapped.persistence = persistence;
    throw wrapped;
  }

  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 4000");

  const handle = createHandle(db);
  let migration;
  try {
    migration = migrate(handle);
  } catch (error) {
    handle.close();
    if (error instanceof DatabaseError || error?.name === "MigrationError") throw error;
    throw new DatabaseError("Не удалось подготовить структуру базы данных", {
      code: "MIGRATION_FAILED",
      cause: error,
    });
  }

  return {
    handle,
    version: migration.version,
    fresh: migration.fresh,
    needsPersist: migration.applied.length > 0 || created,
  };
}

/**
 * Сервис базы: ручка + персистентность + сериализация записей.
 */
export class DatabaseService {
  constructor({ handle, persistence }) {
    this.handle = handle;
    this.persistence = persistence;
    this.queue = createSerialQueue();
    this.version = handle.version();
    this.latestVersion = LATEST_VERSION;
    this.lastSavedAt = null;
    this.dirty = false;
  }

  get db() {
    return this.handle;
  }

  /**
   * Изменяет данные и дожигается записи на носитель.
   * @template T
   * @param {(db:any) => T} mutator синхронная правка в транзакции
   * @returns {Promise<T>}
   */
  async commit(mutator) {
    const result = this.handle.transaction(() => mutator(this.handle));
    await this.persist();
    return result;
  }

  /** Сериализует базу и отдаёт байты письменной очереди. */
  persist() {
    if (!this.persistence) return Promise.resolve(null);
    const bytes = this.handle.exportBytes();
    return this.queue.enqueue(async () => {
      try {
        await this.persistence.write(bytes);
        this.dirty = false;
        this.lastSavedAt = new Date().toISOString();
        return { savedAt: this.lastSavedAt };
      } catch (error) {
        this.dirty = true;
        const wrapped = new DatabaseError("Не удалось сохранить данные", {
          code: "PERSISTENCE_FAILED",
          cause: error,
        });
        wrapped.details = error?.message;
        throw wrapped;
      }
    });
  }

  async close() {
    try {
      if (this.dirty) await this.persist();
    } finally {
      this.handle.close();
    }
  }
}
