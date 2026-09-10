/**
 * Файловый слой персистентности (main process).
 *
 * Renderer не получает доступа к файловой системе: он может только попросить
 * прочитать, записать или сохранить копию базы через preload API.
 *
 * Запись атомарная: данные пишутся в временный файл в том же каталоге,
 * синхронизируются с диском и только затем заменяют целевой файл.
 * Операции записи сериализованы — параллельные вызовы не перемешиваются.
 */

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_BYTES = 64 * 1024 * 1024; // 64 MiB на файл базы — с запасом для десятков тысяч строк

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Имя файла без пути: только безопасные символы. */
function safeFileBase(name, fallback) {
  const base = path.basename(String(name ?? "")).replace(/[^A-Za-z0-9._-]/g, "").replace(/\.{2,}/g, ".");
  const withoutExt = base.replace(/\.[A-Za-z0-9]+$/, "");
  return (withoutExt || fallback).slice(0, 80);
}

class HeadTail {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  enqueue(task) {
    this.pending += 1;
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return run;
  }
}

/**
 * @param {{dir:string, fileName:string, log?:(...args:any[])=>void}} options
 */
function createFileStore({ dir, fileName, log = () => {} }) {
  const dbPath = path.join(dir, fileName);
  const queue = new HeadTail();

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true });
  }

  return {
    dbPath,
    fileName,
    dir,

    async read() {
      return queue.enqueue(async () => {
        try {
          const handle = await fs.open(dbPath, "r");
          try {
            const { size } = await handle.stat();
            if (size === 0) return null;
            const buffer = Buffer.allocUnsafe(size);
            await handle.read(buffer, 0, size, 0);
            return new Uint8Array(buffer.buffer, buffer.byteOffset, size);
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (error && error.code === "ENOENT") return null;
          log("Не удалось прочитать файл базы", error?.code ?? error?.message);
          const wrapped = new Error("Файл базы данных не читается");
          wrapped.code = "READ_FAILED";
          throw wrapped;
        }
      });
    },

    async write(bytes) {
      const payload = toBytes(bytes);
      if (!payload) {
        const error = new Error("Ожидаются байты Uint8Array");
        error.code = "INVALID_INPUT";
        throw error;
      }
      if (payload.byteLength > MAX_BYTES) {
        const error = new Error("Слишком большой файл базы данных");
        error.code = "TOO_LARGE";
        throw error;
      }
      return queue.enqueue(async () => {
        await ensureDir();
        const tempPath = path.join(dir, `${fileName}.${crypto.randomBytes(6).toString("hex")}.tmp`);
        let handle;
        try {
          handle = await fs.open(tempPath, "w", 0o600);
          await handle.writeFile(payload);
          // Синхронизация до замены: иначе после сбоя питания может остаться пустой файл
          if (typeof handle.sync === "function") {
            try {
              await handle.sync();
            } catch (error) {
              log("fsync не выполнен", error?.code ?? error?.message);
            }
          }
          await handle.close();
          handle = null;
          await fs.rename(tempPath, dbPath);
          return { ok: true, bytes: payload.byteLength };
        } catch (error) {
          log("Не удалось записать файл базы", error?.code ?? error?.message);
          const wrapped = new Error("Не удалось записать файл базы данных");
          wrapped.code = "WRITE_FAILED";
          wrapped.cause = error;
          throw wrapped;
        } finally {
          if (handle) {
            try {
              await handle.close();
            } catch {
              /* уже закрыт */
            }
          }
          await fs.rm(tempPath, { force: true }).catch(() => {});
        }
      });
    },

    /**
     * Сохраняет копию текущего файла (например, перед тем как пользователь
     * согласится начать с чистой базы). Исходник при этом не удаляется.
     */
    async preserve(reason) {
      return queue.enqueue(async () => {
        try {
          const stat = await fs.stat(dbPath);
          if (!stat.isFile() || stat.size === 0) return null;
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const suffix = safeFileBase(reason, "error").slice(0, 24);
          const copyName = `${fileName}.${stamp}.${suffix}.bak`;
          await fs.copyFile(dbPath, path.join(dir, copyName));
          return copyName;
        } catch (error) {
          log("Не удалось сохранить копию базы", error?.code ?? error?.message);
          return null;
        }
      });
    },

    /** Запись файла выгрузки по абсолютному пути, выбранному в диалоге. */
    async writeTo(absolutePath, bytes) {
      const payload = toBytes(bytes);
      if (!payload) {
        const error = new Error("Ожидаются байты Uint8Array");
        error.code = "INVALID_INPUT";
        throw error;
      }
      if (payload.byteLength > MAX_BYTES) {
        const error = new Error("Слишком большой файл выгрузки");
        error.code = "TOO_LARGE";
        throw error;
      }
      // Путь выбирает человек в системном диалоге сохранения и может указывать
      // на любой каталог. Здесь проверяется только то, что это корректный
      // абсолютный путь, а не обход каталогов через относительные сегменты.
      if (typeof absolutePath !== "string" || absolutePath.length === 0 || !path.isAbsolute(absolutePath)) {
        const error = new Error("Недопустимый путь записи");
        error.code = "INVALID_PATH";
        throw error;
      }
      const target = path.normalize(absolutePath);
      return queue.enqueue(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, payload, { mode: 0o600 });
        return { ok: true, fileName: path.basename(target) };
      });
    },

    /** Резервный вариант, когда диалог недоступен: writes в каталог exports. */
    async saveExport({ fileName: requestedName, bytes }) {
      const payload = toBytes(bytes);
      if (!payload) {
        const error = new Error("Ожидаются байты Uint8Array");
        error.code = "INVALID_INPUT";
        throw error;
      }
      if (payload.byteLength > MAX_BYTES) {
        const error = new Error("Слишком большой файл выгрузки");
        error.code = "TOO_LARGE";
        throw error;
      }
      const safeName = `${safeFileBase(requestedName, "export")}.csv`;
      return queue.enqueue(async () => {
        const target = path.join(dir, "exports", safeName);
        await ensureDir();
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, payload, { mode: 0o600 });
        return { ok: true, fileName: safeName, directoryName: path.basename(path.dirname(target)) };
      });
    },
  };
}

module.exports = { createFileStore, safeFileBase, toBytes, MAX_BYTES };
