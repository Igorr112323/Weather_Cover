/**
 * Доставка кода покупателю — НЕОБЯЗАТЕЛЬНЫЙ модуль «Студии лицензий».
 *
 * Работает ТОЛЬКО на машине владельца из студии (scripts/license-studio) и
 * никогда — из приложения: в EXE нет ни этого кода, ни ключей рассылки.
 * Если переменные окружения не заданы, модуль просто не включается — выдача
 * кодов работает и без него (копирование сообщения, файл .agrolic).
 *
 * Каналы и их настройки (только переменные окружения, ничего не хранится):
 *
 *   СМС через SMS.ru   AGRO_SMS_PROVIDER=smsru  AGRO_SMS_API_KEY=<api_id>
 *   СМС через SMSC.ru  AGRO_SMS_PROVIDER=smsc   AGRO_SMSC_LOGIN=… AGRO_SMSC_PASSWORD=…
 *   Telegram-бот       AGRO_TG_BOT_TOKEN=<token бота>; chat_id покупателя —
 *                      покупатель должен один раз написать боту /start
 *   Почта (SMTP)       AGRO_SMTP_HOST, AGRO_SMTP_PORT (по умолчанию 587),
 *                      AGRO_SMTP_USER, AGRO_SMTP_PASS, AGRO_SMTP_FROM (опц.)
 *
 * Все отправки идут через injectable-транспорты (fetch, net, tls), поэтому
 * unit-тесты проверяют протоколы без сети и без списания денег.
 */

import net from "node:net";
import tls from "node:tls";

/** Тестовый номер владельца для проверки доставки СМС. */
export const TEST_PHONE = "+7 960 484-34-63";

/**
 * Какие каналы доставки включены. Ключей нет — канала нет, остальное работает.
 * @param {object} [env] окружение (по умолчанию process.env)
 */
export function deliveryCapabilities(env = process.env) {
  const provider = String(env.AGRO_SMS_PROVIDER ?? "").trim().toLowerCase();
  let sms = null;
  if (provider === "smsru" && String(env.AGRO_SMS_API_KEY ?? "").length > 0) {
    sms = { provider: "smsru" };
  } else if (provider === "smsc" && env.AGRO_SMSC_LOGIN && env.AGRO_SMSC_PASSWORD) {
    sms = { provider: "smsc" };
  }
  return {
    sms,
    telegram: String(env.AGRO_TG_BOT_TOKEN ?? "").length > 0,
    smtp: Boolean(env.AGRO_SMTP_HOST && env.AGRO_SMTP_USER && env.AGRO_SMTP_PASS),
  };
}

/** Телефон в международном виде без «+»: +7 960 484-34-63 → 79604843463. */
export function normalizePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits;
}

/** Похоже ли значение на телефон (после нормализации — 11 цифр с 7). */
export function isPhoneLike(raw) {
  const digits = normalizePhone(raw);
  return digits.length === 11 && digits.startsWith("7");
}

/** Похоже ли значение на адрес почты. */
export function isEmailLike(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw ?? "").trim());
}

async function postForm(url, params, fetchImpl) {
  const body = new URLSearchParams(params).toString();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  return { status: response.status, text };
}

/**
 * СМС через SMS.ru. Ответ JSON: {"status":"OK"} — иначе ошибка.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function sendSmsRu({ apiKey, to, text, fetchImpl = fetch }) {
  const phone = normalizePhone(to);
  if (!isPhoneLike(phone)) return { ok: false, message: "Номер телефона не похож на российский мобильный" };
  const { status, text: body } = await postForm(
    "https://api.sms.ru/sms/send",
    { api_id: apiKey, to: phone, msg: text },
    fetchImpl,
  );
  try {
    const parsed = JSON.parse(body);
    if (status === 200 && parsed?.status === "OK") return { ok: true, message: `СМС отправлена на +${phone}` };
    const smsStatus = parsed?.sms?.[phone]?.status_text;
    const detail = parsed?.status_text ?? parsed?.description ?? (typeof smsStatus === "string" ? smsStatus : "");
    return { ok: false, message: `SMS.ru ответил: ${parsed?.status ?? status} ${String(detail).slice(0, 120)}`.trim() };
  } catch {
    return { ok: false, message: `SMS.ru ответил не JSON (HTTP ${status})` };
  }
}

/**
 * СМС через SMSC.ru. Ответ JSON (fmt=3): {"error_code":0} / errmsg.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function sendSmsC({ login, password, to, text, fetchImpl = fetch }) {
  const phone = normalizePhone(to);
  if (!isPhoneLike(phone)) return { ok: false, message: "Номер телефона не похож на российский мобильный" };
  const { status, text: body } = await postForm(
    "https://smsc.ru/sys/send.php",
    { login, psw: password, phones: phone, mes: text, fmt: 3 },
    fetchImpl,
  );
  try {
    const parsed = JSON.parse(body);
    if (Number(parsed?.error_code) === 0 && (parsed?.id || status === 200)) {
      return { ok: true, message: `СМС отправлена на +${phone} (id ${parsed?.id ?? "—"})` };
    }
    return { ok: false, message: `SMSC.ru ответил: ${parsed?.errmsg ?? `HTTP ${status}`}` };
  } catch {
    return { ok: false, message: `SMSC.ru ответил не JSON (HTTP ${status})` };
  }
}

/** СМС выбранным провайдером (какой включён — см. deliveryCapabilities). */
export async function sendSms({ env, capabilities, to, text, fetchImpl = fetch }) {
  const provider = capabilities?.sms?.provider;
  if (!provider) return { ok: false, message: "СМС не настроено: задайте AGRO_SMS_PROVIDER и ключ провайдера" };
  if (provider === "smsru") {
    return sendSmsRu({ apiKey: env.AGRO_SMS_API_KEY, to, text, fetchImpl });
  }
  return sendSmsC({ login: env.AGRO_SMSC_LOGIN, password: env.AGRO_SMSC_PASSWORD, to, text, fetchImpl });
}

/**
 * Сообщение покупателю через Telegram-бота. Покупатель должен один раз
 * написать боту (/start) — иначе Telegram не позволит боту написать первым.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
  const chat = String(chatId ?? "").trim();
  if (!/^-?\d+$/.test(chat) && !/^@[A-Za-z0-9_]{4,}$/.test(chat)) {
    return { ok: false, message: "Укажите числовой chat_id покупателя (он появляется после того, как покупатель напишет боту /start)" };
  }
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (error) {
    return { ok: false, message: `Telegram не отвечает: ${error?.message ?? error}` };
  }
  const parsed = await response.json().catch(() => null);
  if (response.status === 200 && parsed?.ok === true) return { ok: true, message: "Сообщение в Telegram отправлено" };
  return { ok: false, message: `Telegram ответил: ${parsed?.description ?? `HTTP ${response.status}`}` };
}

/* ── Минимальный SMTP-клиент (без зависимостей) ─────────────────────────── */

/**
 * Кодирует тему письма по RFC 2047 (UTF-8 base64) — кириллица доедет целой.
 */
function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(String(subject), "utf8").toString("base64")}?=`;
}

/**
 * Тело письма кодируется base64: никаких проблем с точками в начале строк и
 * длинными строками SMTP.
 */
function buildEmailBody(text) {
  const encoded = Buffer.from(String(text ?? ""), "utf8").toString("base64");
  const lines = encoded.match(/.{1,76}/g) ?? [];
  return lines.join("\r\n");
}

/**
 * Посылает письмо через SMTP с STARTTLS и AUTH LOGIN.
 * Все сокеты передаются параметрами (netImpl/tlsImpl) — тесты подменяют их.
 *
 * @param {{host:string, port?:number, user:string, password:string, from?:string,
 *          to:string, subject?:string, text:string, timeoutMs?:number,
 *          netImpl?:object, tlsImpl?:object}} input
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function sendEmail(input) {
  const {
    host,
    port = Number(process.env.AGRO_SMTP_PORT ?? 587),
    user,
    password,
    from = user,
    to,
    subject = "Код активации АгроПрогноз",
    text,
    timeoutMs = 20000,
    netImpl = net,
    tlsImpl = tls,
  } = input;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to ?? ""))) {
    return { ok: false, message: "Адрес почты покупателя не похож на настоящий" };
  }

  let socket = netImpl.connect(port, host);
  socket.setTimeout(timeoutMs);

  const log = [];
  try {
    await expect(socket, /^220/);

    const ehlo = await dialogue(socket, "EHLO agro-studio", log);
    const supportsStartTls = /^250[- ]STARTTLS/im.test(ehlo.text);

    if (supportsStartTls) {
      await dialogue(socket, "STARTTLS", log);
      socket = tlsImpl.connect({ socket, servername: host, rejectUnauthorized: true });
      socket.setTimeout(timeoutMs);
      await dialogue(socket, "EHLO agro-studio", log);
    }

    await dialogue(socket, "AUTH LOGIN", log);
    await dialogue(socket, Buffer.from(user, "utf8").toString("base64"), log);
    await dialogue(socket, Buffer.from(password, "utf8").toString("base64"), log);

    await dialogue(socket, `MAIL FROM:<${from}>`, log);
    await dialogue(socket, `RCPT TO:<${to}>`, log);
    await dialogue(socket, "DATA", log, /^354/);

    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodeSubject(subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      buildEmailBody(text),
      "",
      ".",
      "",
    ].join("\r\n");
    socket.write(message);
    await expect(socket, /^250/, log);

    socket.write("QUIT\r\n");
    socket.end();
    return { ok: true, message: `Письмо отправлено на ${to}` };
  } catch (error) {
    socket.destroy?.();
    return { ok: false, message: `SMTP: ${error?.message ?? error}` };
  }
}

/** Последняя непустая строка многострочного SMTP-ответа. */
function lastResponseLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

/** Читает строки сокета, пока не придёт финальная строка ответа «NNN …». */
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const last = lastResponseLine(buffer);
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ text: buffer.trim() });
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`таймаут ответа (получено: ${buffer.trim().slice(0, 80) || "ничего"})`));
    };
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
  });
}

function expect(socket, pattern) {
  return readResponse(socket).then((response) => {
    if (!pattern.test(response.text)) throw new Error(`ожидалось ${pattern}, получено: ${lastResponseLine(response.text)}`);
    return response;
  });
}

/** Команда → ответ; сверяет код ответа с шаблоном (по умолчанию 2xx/3xx). */
async function dialogue(socket, command, log, pattern = /^[23]/) {
  socket.write(`${command}\r\n`);
  const response = await readResponse(socket);
  const lastLine = lastResponseLine(response.text);
  log.push(`${command.slice(0, 24)} → ${lastLine.slice(0, 60)}`);
  if (!pattern.test(lastLine)) throw new Error(`на «${command.slice(0, 20)}» сервер ответил: ${lastLine}`);
  return response;
}
