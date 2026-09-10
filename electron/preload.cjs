/**
 * Preload: единственный мост между renderer'ом и диском.
 *
 * contextIsolation включён, nodeIntegration выключен, sandbox включён.
 * Наружу отдаются только четыре операции, каждая с проверкой аргументов:
 * чтение базы, запись базы, сохранение копии повреждённой базы, запись
 * файла выгрузки (путь выбирает человек в системном диалоге).
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const MAX_BYTES = 64 * 1024 * 1024;

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Причина сохранения копии — короткая метка без перевода строк. */
function toReason(value) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
  return cleaned || "error";
}

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).catch((error) => ({
    ok: false,
    code: "IPC_FAILED",
    message: String(error?.message ?? "Канал приложения недоступен"),
  }));
}

contextBridge.exposeInMainWorld("agro", {
  isElectron: true,

  async getAppInfo() {
    return invoke("agro:get-app-info");
  },

  async readDatabase() {
    return invoke("agro:read-database");
  },

  async writeDatabase(bytes) {
    const payload = toBytes(bytes);
    if (!payload) return { ok: false, code: "INVALID_INPUT", message: "Некорректные данные для записи" };
    if (payload.byteLength === 0) return { ok: false, code: "INVALID_INPUT", message: "Пустые данные" };
    if (payload.byteLength > MAX_BYTES) return { ok: false, code: "TOO_LARGE", message: "Слишком большой файл" };
    return invoke("agro:write-database", payload);
  },

  async preserveDatabase(reason) {
    return invoke("agro:preserve-database", toReason(reason));
  },

  async saveFile({ fileName, bytes } = {}) {
    if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 120) {
      return { ok: false, code: "INVALID_INPUT", message: "Некорректное имя файла" };
    }
    if (/[\\/\u0000-\u001f]/.test(fileName)) {
      return { ok: false, code: "INVALID_INPUT", message: "Имя файла содержит недопустимые символы" };
    }
    const payload = toBytes(bytes);
    if (!payload || payload.byteLength === 0 || payload.byteLength > MAX_BYTES) {
      return { ok: false, code: "INVALID_INPUT", message: "Некорректное содержимое файла" };
    }
    return invoke("agro:save-file", { fileName, bytes: payload });
  },

  /** Renderer сообщает, что незаписанные изменения выгружены, и окно можно закрывать. */
  notifyFlushed() {
    try {
      ipcRenderer.send("agro:flushed");
    } catch {
      /* окно уже закрывается */
    }
  },

  /** Main просит дописать данные перед закрытием окна. */
  onFlushRequest(handler) {
    if (typeof handler !== "function") return () => {};
    const listener = () => handler();
    ipcRenderer.on("agro:flush-request", listener);
    return () => ipcRenderer.removeListener("agro:flush-request", listener);
  },
});
