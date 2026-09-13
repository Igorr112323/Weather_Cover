/**
 * Preload: единственный мост между renderer'ом и диском.
 *
 * contextIsolation включён, nodeIntegration выключен, sandbox включён.
 * Наружу отдаются только операции с данными, каждая с проверкой аргументов:
 * чтение базы, запись базы, сохранение копии повреждённой базы, запись файла
 * выгрузки (путь выбирает человек в системном диалоге), состояние лицензии и
 * активация, — и два односторонних сигнала: «интерфейс построен» для экрана
 * загрузки и «под кнопками окна тёмное содержимое» для цвета их значков.
 *
 * ТОКЕН СЕССИИ. Активированное приложение получает от main process одноразовый
 * токен. Он хранится в замыкании этого файла и подставляется в каждый запрос
 * данных; из ответа он вырезается, поэтому в renderer (и в его консоль, и в
 * перехваченный IPC) токен не попадает. Следствие: правка интерфейса ничего не
 * даёт — без активации main process не отдаст ни байта данных, а токен нельзя
 * ни прочитать, ни придумать на стороне renderer'а.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const MAX_BYTES = 64 * 1024 * 1024;
/** Предел текста кода активации: длиннее кода в природе не бывает. */
const MAX_CODE_CHARS = 4000;

/** Токен сессии: живёт только здесь, наружу не возвращается. */
let sessionToken = null;

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

/** Код активации: текст ограниченной длины, всё лишнее отбрасывает main process. */
function toCode(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, MAX_CODE_CHARS);
}

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).catch((error) => ({
    ok: false,
    code: "IPC_FAILED",
    message: String(error?.message ?? "Канал приложения недоступен"),
  }));
}

/**
 * Забирает токен из ответа main process и возвращает ответ без него.
 * Возвращаемый объект уходит в renderer через contextBridge копией,
 * поэтому удалённое поле восстановить оттуда нельзя.
 */
function takeToken(response) {
  if (!response || typeof response !== "object") return response;
  if (typeof response.token === "string" && response.token.length > 0) {
    sessionToken = response.token;
    const rest = { ...response };
    delete rest.token;
    return rest;
  }
  return response;
}

/** Добавляет токен к запросу данных. */
function sealed(payload) {
  return { ...(payload ?? {}), token: sessionToken };
}

contextBridge.exposeInMainWorld("agro", {
  isElectron: true,

  async getAppInfo() {
    return invoke("agro:get-app-info");
  },

  /**
   * Лицензия. Проверка подписи выполняется в main process; здесь — только
   * передача текста кода и приём состояния. Дат в ответах нет: лицензия
   * бессрочная (permanent: true).
   */
  license: {
    async status() {
      return takeToken(await invoke("agro:license-status"));
    },

    async activate(code) {
      return takeToken(await invoke("agro:license-activate", toCode(code)));
    },

    /** Файл выбирается в системном диалоге: путь и содержимое renderer не видит. */
    async activateFromFile() {
      return takeToken(await invoke("agro:license-activate-file"));
    },
  },

  /** Интерфейс построен: главное окно можно показать вместо экрана загрузки. */
  notifyReady() {
    ipcRenderer.send("agro:app-ready");
  },

  /** Под кнопками окна тёмное содержимое (карта) — значки кнопок станут светлыми. */
  setWindowControlsOnDark(onDark) {
    ipcRenderer.send("agro:window-controls", onDark === true);
  },

  async readDatabase() {
    return invoke("agro:read-database", sealed());
  },

  async writeDatabase(bytes) {
    const payload = toBytes(bytes);
    if (!payload) return { ok: false, code: "INVALID_INPUT", message: "Некорректные данные для записи" };
    if (payload.byteLength === 0) return { ok: false, code: "INVALID_INPUT", message: "Пустые данные" };
    if (payload.byteLength > MAX_BYTES) return { ok: false, code: "TOO_LARGE", message: "Слишком большой файл" };
    return invoke("agro:write-database", sealed({ bytes: payload }));
  },

  async preserveDatabase(reason) {
    return invoke("agro:preserve-database", sealed({ reason: toReason(reason) }));
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
    return invoke("agro:save-file", sealed({ fileName, bytes: payload }));
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
