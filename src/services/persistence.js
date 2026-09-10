/**
 * Единый интерфейс персистентности.
 *
 * Два носителя, один API: read / write / preserve.
 *   • Electron — файл userData/agroprognoz.sqlite, запись идёт через узкий
 *     preload API в main process (renderer не трогает файловую систему);
 *     запись атомарная: временный файл + замена, операции сериализуются.
 *   • Браузерный предпросмотр — бинарный экспорт SQLite в IndexedDB.
 *
 * preserve() вызывается при проблемах с базой: исходный файл сохраняется,
 * данные никогда не удаляются молча.
 */

export const DB_FILE_NAME = "agroprognoz.sqlite";
const IDB_NAME = "agroprognoz";
const IDB_STORE = "kv";
const IDB_KEY = "sqlite";

export class PersistenceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "PersistenceError";
    this.code = options.code ?? "PERSISTENCE_FAILED";
    this.cause = options.cause;
  }
}

function asBytes(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/* ── Electron ───────────────────────────────────────────────────────────── */

function createElectronPersistence(api) {
  return {
    kind: "electron",
    label: `Файл профиля приложения · ${DB_FILE_NAME}`,
    supportsPreserve: true,
    async read() {
      const result = await api.readDatabase();
      if (!result || result.ok === false) {
        throw new PersistenceError(result?.message ?? "Не удалось прочитать файл базы данных", {
          code: "DB_READ_FAILED",
        });
      }
      return asBytes(result.bytes);
    },
    async write(bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new PersistenceError("Некорректные данные для записи", { code: "INVALID_BYTES" });
      }
      const result = await api.writeDatabase(bytes);
      if (!result || result.ok === false) {
        throw new PersistenceError(result?.message ?? "Не удалось записать файл базы данных", {
          code: "DB_WRITE_FAILED",
        });
      }
      return result;
    },
    async preserve(reason) {
      const result = await api.preserveDatabase(String(reason ?? "error").slice(0, 40));
      return result?.ok ? result.fileName : null;
    },
  };
}

/* ── Браузер ────────────────────────────────────────────────────────────── */

function openIndexedDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new PersistenceError("IndexedDB недоступен в этом браузере", { code: "NO_IDB" }));
      return;
    }
    const request = indexedDB.open(IDB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      reject(new PersistenceError("Не удалось открыть хранилище браузера", { code: "IDB_OPEN", cause: request.error }));
    });
  });
}

async function idbRequest(database, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IDB_STORE, mode);
    const store = transaction.objectStore(IDB_STORE);
    let result;
    transaction.addEventListener("complete", () => resolve(result));
    transaction.addEventListener("abort", () => {
      reject(new PersistenceError("Операция с хранилищем браузера прервана", { code: "IDB_ABORT" }));
    });
    transaction.addEventListener("error", () => {
      reject(new PersistenceError("Хранилище браузера недоступно или заполнено", { code: "IDB_ERROR", cause: transaction.error }));
    });
    run(store, (request) => {
      request.addEventListener("success", () => {
        result = request.result;
      });
      request.addEventListener("error", () => {
        reject(new PersistenceError("Не удалось прочитать хранилище браузера", { code: "IDB_REQUEST", cause: request.error }));
      });
    });
  });
}

function createBrowserPersistence() {
  let databasePromise = null;
  const database = () => {
    if (!databasePromise) databasePromise = openIndexedDb();
    return databasePromise;
  };

  return {
    kind: "browser",
    label: "Хранилище браузера · IndexedDB",
    supportsPreserve: true,
    async read() {
      const db = await database();
      const stored = await idbRequest(db, "readonly", (store, done) => done(store.get(IDB_KEY)));
      return asBytes(stored);
    },
    async write(bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new PersistenceError("Некорректные данные для записи", { code: "INVALID_BYTES" });
      }
      const db = await database();
      await idbRequest(db, "readwrite", (store, done) => done(store.put(bytes, IDB_KEY)));
      return { ok: true };
    },
    async preserve(reason) {
      const safe = String(reason ?? "error").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
      const key = `sqlite-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}`;
      const db = await database();
      const stored = await idbRequest(db, "readonly", (store, done) => done(store.get(IDB_KEY)));
      if (!stored) return null;
      await idbRequest(db, "readwrite", (store, done) => done(store.put(stored, key)));
      return key;
    },
  };
}

/** Выбирает носитель по окружению. */
export async function createPersistence() {
  const api = typeof window !== "undefined" ? window.agro : null;
  if (api?.readDatabase && api?.writeDatabase) return createElectronPersistence(api);
  return createBrowserPersistence();
}
