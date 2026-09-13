/**
 * Заявка на персональный код — сторона интерфейса.
 *
 * Экран активации предлагает покупателю отправить заявку владельцу: код
 * компьютера, полный идентификатор и версия приложения — этого владельцу
 * достаточно, чтобы выписать персональный код в «Студии лицензий».
 *
 * Что здесь важно:
 *   • интерфейс НЕ знает контактов владельца — текст и каналы связи приходят
 *     из main process (electron/license/request.cjs) по IPC; в этом модуле
 *     нет ни адресов, ни телефонов, и ссылок на мессенджеры он не строит;
 *   • приложение офлайн: никаких запросов наружу, текст заявки уходит только
 *     через собственные мессенджер или почту покупателя;
 *   • дат и сроков в заявке нет — лицензия бессрочная.
 *
 * Запасной путь (браузер без Electron, dev-режим): текст собирается локально
 * из состояния лицензии, а сохранение файла работает через обычную загрузку.
 */

/** Название продукта для локального запасного текста заявки. */
const PRODUCT_TITLE = "АгроПрогноз — Кукуруза";

/**
 * Текст заявки. Повторяет сборку в main process: это запасной путь для
 * браузера, в Electron текст приходит готовым по IPC.
 * @param {{machineShortId?:string, machineId?:string, version?:string}} input
 */
export function buildRequestText({ machineShortId = "", machineId = "", version = "" } = {}) {
  const lines = [
    "Заявка на персональный код активации",
    `Приложение: ${PRODUCT_TITLE}${version ? ` ${version}` : ""}`,
    `Код компьютера: ${machineShortId || "—"}`,
  ];
  if (machineId) lines.push(`Полный идентификатор: ${machineId}`);
  lines.push("Лицензия бессрочная. Прошу выслать персональный код активации для этого компьютера.");
  return lines.join("\n");
}

function bridge() {
  return typeof window !== "undefined" ? window.agro : null;
}

/**
 * Сведения для панели заявки.
 *
 * В Electron — из main process (готовый текст, публичный контакт, доступные
 * каналы). Без main process (dev-режим в браузере) — локальный текст и
 * признак local: канал связи открыть нельзя, но скопировать и сохранить
 * заявку можно.
 *
 * @param {object|null} status состояние лицензии (machineIdShort, machineId)
 * @param {string} [version] версия приложения
 * @returns {Promise<{ok:boolean, local:boolean, text:string, channels:Object, fileName:string}>}
 */
export async function resolveRequestInfo(status, version = "") {
  const api = bridge();
  if (api?.license?.requestInfo) {
    try {
      const info = await api.license.requestInfo();
      if (info?.ok) return { local: false, ...info };
    } catch (error) {
      console.error("Сведения заявки не получены", error);
    }
  }
  return {
    ok: true,
    local: true,
    text: buildRequestText({
      machineShortId: status?.machineIdShort ?? "",
      machineId: status?.machineId ?? "",
      version,
    }),
    contact: {},
    channels: {},
    fileName: "",
  };
}

/**
 * Открыть канал связи (telegram|whatsapp|email) с готовым текстом заявки.
 * Ссылку строит main process: этот модуль не знает контактов владельца.
 * @returns {Promise<{ok:boolean, message?:string, copied?:boolean}>}
 */
export async function openRequestChannel(channel) {
  const api = bridge();
  if (!api?.license?.openRequestChannel) {
    return { ok: false, code: "NO_BRIDGE", message: "Открыть мессенджер можно только в приложении — запустите AgroPrognoz.exe" };
  }
  try {
    return await api.license.openRequestChannel(String(channel ?? ""));
  } catch (error) {
    console.error("Канал связи не открыт", error);
    return { ok: false, code: "IPC_FAILED", message: "Не удалось открыть канал связи" };
  }
}

/**
 * Сохранить заявку файлом (.agrorequest).
 *
 * В Electron путь выбирается в системном диалоге (main process). В браузере —
 * обычная загрузка файла: текст заявки никуда не отправляется.
 * @returns {Promise<{ok:boolean, fileName?:string, message?:string}>}
 */
export async function saveRequestFile(text, fileName = "") {
  const api = bridge();
  if (api?.license?.saveRequestFile) {
    try {
      return await api.license.saveRequestFile();
    } catch (error) {
      console.error("Файл заявки не сохранён", error);
      return { ok: false, message: "Не удалось сохранить файл заявки" };
    }
  }
  try {
    const blob = new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "agroprognoz-request.agrorequest";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { ok: true, fileName: link.download };
  } catch (error) {
    console.error("Файл заявки не сохранён", error);
    return { ok: false, message: "Не удалось сохранить файл заявки" };
  }
}
