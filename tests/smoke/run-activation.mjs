/**
 * Экран активации в браузере — проверка на dev-сервере.
 *
 *   # Терминал 1:
 *   npm run dev
 *   # Терминал 2:
 *   npm run test:activation
 *
 * В dev-сборке лицензия не требуется, поэтому экран активации открывается
 * специальным адресом ?license=demo (в production-сборке это условие вырезано
 * вместе с веткой import.meta.env.DEV — см. tests/smoke/run-gate.mjs).
 * Активировать приложение в браузере нельзя: main process'а нет, и экран
 * обязан честно сказать об этом, а не «молча пустить дальше».
 *
 * Переменные окружения:
 *   AGRO_ACTIVATION_URL   — адрес dev-сервера (по умолчанию http://localhost:5173)
 *   AGRO_ACTIVATION_SHOTS — каталог скриншотов
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.AGRO_ACTIVATION_URL ?? "http://localhost:5173";
const SHOTS_DIR = process.env.AGRO_ACTIVATION_SHOTS ?? path.join(ROOT, "tests", "smoke", "screenshots");

const failures = [];
const consoleErrors = [];

setTimeout(() => {
  console.error("ACTIVATION GLOBAL TIMEOUT: принудительное завершение");
  process.exit(1);
}, 5 * 60 * 1000).unref();

function check(name, condition, detail = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 128 символов тела кода — ровно столько нужно ввести. */
const FULL_CODE = `AGRO-${"ABCDEFGH-".repeat(14)}ABCDEFGH`;

console.log(`Экран активации: ${BASE_URL}/?license=demo`);

await mkdir(SHOTS_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true, timeout: 90000 });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(30000);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error?.message ?? error)));

  await page.goto(`${BASE_URL}/?license=demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".activate__card", { timeout: 20000 });

  const structure = await page.evaluate(() => ({
    title: document.querySelector(".activate__card .page-title")?.textContent ?? "",
    lead: document.querySelector(".activate__lead")?.textContent ?? "",
    hasInput: Boolean(document.querySelector("#activation-code")),
    sidebar: Boolean(document.querySelector(".sidebar")),
    navItems: document.querySelectorAll(".nav-item").length,
    machineId: document.querySelector(".activate__machine-id")?.textContent ?? "",
    details: document.querySelector(".activate__details")?.innerText ?? "",
    buttons: [...document.querySelectorAll(".activate__actions .btn__label")].map((node) => node.textContent),
    drag: Boolean(document.querySelector(".activate .window-drag")),
  }));

  check("заголовок экрана", structure.title === "Активация приложения", structure.title);
  check("приложение не построено вместо активации", structure.sidebar === false && structure.navItems === 0);
  check("поле кода на месте", structure.hasInput === true);
  check("полоса перетаскивания окна есть", structure.drag === true);
  check("идентификатор компьютера показан", structure.machineId === "DEMO-DEMO", structure.machineId);
  check("кнопки активации", structure.buttons.length >= 2, structure.buttons.join(", "));
  check("в тексте экрана сказано про бессрочность", /бессрочн/i.test(structure.lead) && /бессрочн/i.test(structure.details));
  check(
    "на экране нет ни одной даты и ни одного срока",
    !/\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(structure.details) && !/дн(ей|я|и)|осталось|истека|продл/i.test(structure.details),
    structure.details.replace(/\n/g, " | "),
  );

  await page.screenshot({ path: path.join(SHOTS_DIR, "activation-empty.png") });

  // Ввод «грязного» кода: нижний регистр, пробелы, лишние разделители.
  const dirty = FULL_CODE.toLowerCase().replace(/-/g, " ");
  await page.fill("#activation-code", dirty);
  await page.dispatchEvent("#activation-code", "blur");
  const formatted = await page.inputValue("#activation-code");
  check("код приведён к печатному виду", formatted === FULL_CODE, formatted.slice(0, 40));

  const counter = await page.evaluate(() => {
    const node = document.querySelector(".activate__count");
    return { text: node?.textContent ?? "", full: node?.classList.contains("activate__count--full") === true };
  });
  check("счётчик показывает полный код", counter.text === "128 / 128" && counter.full === true, counter.text);

  // Активация в браузере невозможна: экран обязан сказать об этом и остаться.
  await page.click(".activate__actions .btn--primary");
  await page.waitForSelector(".note--danger:not([hidden])", { timeout: 10000 });
  const errorText = await page.evaluate(() => document.querySelector(".note--danger")?.innerText ?? "");
  check("браузерная активация отклонена с понятным сообщением", errorText.length > 10, errorText);
  check(
    "после отказа приложение не открылось",
    (await page.evaluate(() => Boolean(document.querySelector(".sidebar")))) === false,
  );

  await page.screenshot({ path: path.join(SHOTS_DIR, "activation-error.png") });

  // Неполный код не должен даже пытаться активироваться.
  await page.fill("#activation-code", "AGRO-1234");
  await page.click(".activate__actions .btn--primary");
  const shortError = await page.evaluate(() => document.querySelector(".note--danger")?.innerText ?? "");
  check("неполный код отклоняется на месте", /неполн|целиком/i.test(shortError), shortError);

  // Вставка из буфера: в headless-браузере буфер пуст — экран не должен упасть.
  await page.fill("#activation-code", FULL_CODE);
  await page.click(".activate__actions .btn:nth-child(2)");
  await page.waitForTimeout(600);
  check("кнопка вставки не роняет экран", (await page.evaluate(() => Boolean(document.querySelector(".activate__card")))) === true);

  // Активация файлом в браузере: системного диалога нет, отказ обязателен.
  await page.click(".activate__actions .btn:nth-child(3)");
  await page.waitForTimeout(600);
  check("кнопка файла не роняет экран", (await page.evaluate(() => Boolean(document.querySelector(".activate__card")))) === true);

  await page.screenshot({ path: path.join(SHOTS_DIR, "activation-filled.png") });

  const unexpected = consoleErrors.filter((text) => !/favicon|net::ERR/i.test(text));
  check("в консоли нет ошибок приложения", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
} finally {
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
}

if (failures.length) {
  console.error(`\n✘ Провалено проверок: ${failures.length}\n  ${failures.join("\n  ")}\n`);
  process.exit(1);
}
console.log("\n✔ Экран активации проверен\n");
