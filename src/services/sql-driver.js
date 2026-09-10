/**
 * Загрузка sql.js (SQLite, собранный в WebAssembly).
 *
 * Библиотека и wasm-файл лежат локально в node_modules и попадают в сборку
 * Vite — CDN не используется. Отдельный модуль нужен, чтобы остальной код
 * работы с базой не зависел от способа загрузки и запускался в тестах Node.
 */

// Импортируем именно браузерную сборку: без require() и без путей Node.
import initSqlJs from "sql.js/dist/sql-wasm-browser.js";
import wasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";

let cached = null;

/** @returns {Promise<any>} конструктор SQL.Database из sql.js */
export async function loadSql() {
  if (cached) return cached;
  try {
    cached = await initSqlJs({ locateFile: () => wasmUrl });
  } catch (error) {
    const wrapped = new Error("Не удалось загрузить движок SQLite");
    wrapped.code = "SQLJS_LOAD_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
  return cached;
}
