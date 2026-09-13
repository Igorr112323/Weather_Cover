/**
 * Заявка на персональный код — контакт владельца и текст заявки (main process).
 *
 * Зачем отдельный модуль: покупатель нажимает «Отправить заявку владельцу», и
 * приложение открывает ЕГО СОБСТВЕННЫЙ мессенджер или почтовую программу с уже
 * готовым текстом. Данные покупателя никуда не «звонят»: приложение офлайн,
 * текст заявки формируется локально и уходит только через выбранный покупателем
 * канал (его Telegram, его почта). Никакого сервера и никакой телеметрии.
 *
 * КОНТАКТ ВЛАДЕЛЬЦА — это публичные реквизиты связи (как адрес поддержки), а
 * не секрет: они нужны покупателю, чтобы отправить заявку. Они живут здесь, в
 * main process (в сборке модуль обфусцирован), а НЕ в renderer — интерфейс
 * получает их через IPC и не содержит ни адресов, ни телефонов. Изменить
 * контакт можно в одном месте — в OWNER_CONTACT ниже.
 *
 * Секретов (закрытых ключей, ключей рассылки, журнала выдачи) в этом модуле и
 * в приложении нет и быть не должно: выдача кодов — только «Студия лицензий»
 * (scripts/license-studio) на машине владельца.
 *
 * В модуле нет обращений к часам: заявка не зависит от даты, лицензия
 * бессрочная.
 */

"use strict";

/** Название продукта для текста заявки. */
const PRODUCT_TITLE = "АгроПрогноз — Кукуруза";

/**
 * Публичный контакт владельца для заявок на код активации.
 *
 * Поля:
 *   phone         телефон в международном формате без «+», пробелов и скобок:
 *                 используется для WhatsApp (wa.me) и как подсказка в тексте
 *                 заявки; пустая строка — канал WhatsApp выключен;
 *   telegramUser  @username владельца в Telegram без «@» (если есть): кнопка
 *                 «Telegram» откроет чат с владельцем; если пусто, но задан
 *                 телефон, откроется экран «Поделиться» с готовым текстом;
 *   email         почта для заявок (mailto:); пустая строка — канал выключен.
 *
 * Поменяйте значения перед сборкой, если принимаете заявки другим адресом.
 */
const OWNER_CONTACT = Object.freeze({
  phone: "79604843463",
  telegramUser: "",
  email: "",
});

/** Тема письма для mailto:. */
const MAIL_SUBJECT = "Заявка на код активации — АгроПрогноз";

/** Расширение файла заявки (запасной путь, когда мессенджер недоступен). */
const REQUEST_FILE_EXTENSION = ".agrorequest";

/** Каналы заявки. Идентификаторы фиксированы: renderer передаёт только их. */
const REQUEST_CHANNELS = Object.freeze(["telegram", "whatsapp", "email"]);

/**
 * Текст заявки: всё, что нужно владельцу, чтобы выписать персональный код.
 * Короткого кода компьютера достаточно для привязки; полный идентификатор
 * прикладывается на случай вопросов поддержки. Дат и сроков в заявке нет.
 *
 * @param {{machineShortId?:string, machineId?:string, version?:string}} input
 */
function buildRequestText({ machineShortId = "", machineId = "", version = "" } = {}) {
  const lines = [
    "Заявка на персональный код активации",
    `Приложение: ${PRODUCT_TITLE}${version ? ` ${version}` : ""}`,
    `Код компьютера: ${machineShortId || "—"}`,
  ];
  if (machineId) lines.push(`Полный идентификатор: ${machineId}`);
  lines.push("Лицензия бессрочная. Прошу выслать персональный код активации для этого компьютера.");
  return lines.join("\n");
}

/** Канал доступен, только если для него задан контакт. */
function channelAvailability(contact = OWNER_CONTACT) {
  const phone = String(contact.phone ?? "").replace(/\D/g, "");
  const telegramUser = String(contact.telegramUser ?? "").replace(/^@+/, "").trim();
  const email = String(contact.email ?? "").trim();
  return {
    telegram: Boolean(telegramUser || phone),
    whatsapp: phone.length >= 8,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  };
}

/** Публичная часть контакта для интерфейса: только то, что видит покупатель. */
function publicContact(contact = OWNER_CONTACT) {
  const availability = channelAvailability(contact);
  const phone = String(contact.phone ?? "").replace(/\D/g, "");
  return {
    phone: availability.whatsapp ? phone : "",
    telegramUser: String(contact.telegramUser ?? "").replace(/^@+/, "").trim(),
    email: availability.email ? String(contact.email ?? "").trim() : "",
  };
}

/**
 * Ссылка канала связи с готовым текстом заявки.
 *
 *   • WhatsApp — wa.me с текстом в параметре: покупателю останется нажать
 *     «Отправить»;
 *   • Telegram — при заданном @username открывается чат с владельцем (текст
 *     уже в буфере обмена — main process копирует его перед открытием), иначе
 *     экран «Поделиться» с готовым текстом;
 *   • почта — mailto: с темой и текстом.
 *
 * Ссылку строит main process из своих настроек: renderer не знает адресов и
 * не умеет собирать такие ссылки.
 *
 * @returns {string|null} null — канал не настроен
 */
function buildChannelUrl(channel, text, contact = OWNER_CONTACT) {
  const availability = channelAvailability(contact);
  const encoded = encodeURIComponent(text ?? "");
  if (channel === "whatsapp") {
    if (!availability.whatsapp) return null;
    const phone = String(contact.phone ?? "").replace(/\D/g, "");
    return `https://wa.me/${phone}?text=${encoded}`;
  }
  if (channel === "telegram") {
    if (!availability.telegram) return null;
    const telegramUser = String(contact.telegramUser ?? "").replace(/^@+/, "").trim();
    if (telegramUser) return `tg://resolve?domain=${encodeURIComponent(telegramUser)}`;
    // Без @username: экран «Поделиться» в Telegram с готовым текстом заявки.
    return `https://t.me/share/url?url=${encodeURIComponent("")}&text=${encoded}`;
  }
  if (channel === "email") {
    if (!availability.email) return null;
    const email = String(contact.email ?? "").trim();
    // Адрес уже проверен правилом доступности; параметры — с кодированием.
    return `mailto:${email}?subject=${encodeURIComponent(MAIL_SUBJECT)}&body=${encoded}`;
  }
  return null;
}

/** Имя файла заявки: короткий код компьютера делает файл узнаваемым. */
function requestFileName(machineShortId = "") {
  const clean = String(machineShortId ?? "").replace(/[^0-9A-Za-z-]/g, "");
  return clean ? `agroprognoz-request-${clean}${REQUEST_FILE_EXTENSION}` : `agroprognoz-request${REQUEST_FILE_EXTENSION}`;
}

module.exports = {
  MAIL_SUBJECT,
  OWNER_CONTACT,
  PRODUCT_TITLE,
  REQUEST_CHANNELS,
  REQUEST_FILE_EXTENSION,
  buildChannelUrl,
  buildRequestText,
  channelAvailability,
  publicContact,
  requestFileName,
};
