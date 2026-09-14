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

/** 128 символов тела кода: префикс и 16 групп по 8 символов. */
const FULL_CODE = `AGRO-${"ABCDEFGH-".repeat(15)}ABCDEFGH`;

/**
 * Текст заметок экрана: у всех .note display: flex, поэтому «скрытость»
 * проверяется не только атрибутом hidden, но и фактической видимостью.
 */
async function readNotes(target) {
  return target.evaluate(() => {
    const read = (kind) => {
      const node = document.querySelector(`[data-note="${kind}"]`);
      if (!node) return { text: "", visible: false };
      const style = getComputedStyle(node);
      // offsetParent не годится: внутри position:fixed он null и у видимых узлов.
      const shown =
        node.hidden === false &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        node.getClientRects().length > 0;
      return { text: shown ? (node.innerText || node.textContent || "").trim() : "", visible: shown };
    };
    const error = read("error");
    const store = read("store");
    const tamper = read("tamper");
    return {
      error: error.text,
      store: store.text,
      tamper: tamper.text,
      tamperVisible: tamper.visible,
      errorVisible: error.visible,
    };
  });
}

console.log(`Экран активации: ${BASE_URL}/?license=demo и ?license=demo-tampered`);

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
    cardText: document.querySelector(".activate__card")?.innerText ?? "",
    hasInput: Boolean(document.querySelector("#activation-code")),
    sidebar: Boolean(document.querySelector(".sidebar")),
    navItems: document.querySelectorAll(".nav-item").length,
    buttons: [...document.querySelectorAll(".activate .btn__label")].map((node) => node.textContent),
    hiddenBlocks: ["activate__lead", "activate__details", "activate__more", "activate__request", "activate__machine-id"].filter((cls) =>
      Boolean(document.querySelector(`.${cls}`)),
    ),
    drag: Boolean(document.querySelector(".activate .window-drag")),
  }));

  check("заголовок экрана", structure.title === "Активация приложения", structure.title);
  check("приложение не построено вместо активации", structure.sidebar === false && structure.navItems === 0);
  check("поле кода на месте", structure.hasInput === true);
  check("полоса перетаскивания окна есть", structure.drag === true);
  // Экран — ровно два действия: вставить код и скопировать код машины.
  check("на экране две кнопки: «Активировать» и «Скопировать»", structure.buttons.join(",") === "Активировать,Скопировать", structure.buttons.join(", "));
  check("поясняющих абзацев, блоков «условия/серийник/версия», катов и заявки нет", structure.hiddenBlocks.length === 0, structure.hiddenBlocks.join(", "));
  check(
    "на экране нет ни одной даты, ни срока, ни «бессрочно» лишнего текста",
    !/\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(structure.cardText) && !/дн(ей|я|и)|осталось|истека|продл|Условия лицензии|Срок действия/i.test(structure.cardText),
    structure.cardText.replace(/\n/g, " | ").slice(0, 160),
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
  // Предупреждение о порче файлов не должно быть видно без причины: у .note
  // display: flex перебивает атрибут hidden, поэтому в base.css есть [hidden].
  const notesBefore = await readNotes(page);
  check("предупреждение о порче файлов скрыто, когда порчи нет", notesBefore.tamper === "", notesBefore.tamper);
  check("сообщение о нечитаемом хранилище скрыто", notesBefore.store === "");

  await page.getByRole("button", { name: "Активировать", exact: true }).click();
  await page.waitForSelector('[data-note="error"]:not([hidden])', { timeout: 10000 });
  const errorText = (await readNotes(page)).error;
  check("браузерная активация отклонена с понятным сообщением", errorText.length > 10, errorText);
  check("в браузере честно сказано, что активация недоступна", /недоступн/i.test(errorText), errorText);
  check(
    "после отказа приложение не открылось",
    (await page.evaluate(() => Boolean(document.querySelector(".sidebar")))) === false,
  );

  await page.screenshot({ path: path.join(SHOTS_DIR, "activation-error.png") });

  // Неполный код не должен даже пытаться активироваться.
  await page.fill("#activation-code", "AGRO-1234");
  await page.getByRole("button", { name: "Активировать", exact: true }).click();
  await page.waitForFunction(
    () => /неполн|целиком/i.test(document.querySelector('[data-note="error"]')?.textContent ?? ""),
    null,
    { timeout: 10000 },
  );
  const shortError = (await readNotes(page)).error;
  check("неполный код отклоняется на месте", /неполн|целиком/i.test(shortError), shortError);
  check("счётчик после обрезки кода", (await page.textContent(".activate__count")) === "4 / 128");

  // Вставка в поле форматируется сама (кнопки «из буфера» на экране нет):
  // проверка, что Ctrl+V-сценарий (вставка текста с мусором) не ломает ввод.
  await page.fill("#activation-code", "");
  await page.keyboard.type("agro 1234");
  await page.dispatchEvent("#activation-code", "blur");
  check("в поле остаётся то, что набрано", (await page.inputValue("#activation-code")).replace(/\s/g, "").length >= 9, await page.inputValue("#activation-code"));

  await page.fill("#activation-code", FULL_CODE);

  /* ── Код компьютера: нередактируемое поле и копирование ────────────────── */

  const machine = await page.evaluate(() => {
    const field = document.querySelector("[data-activate-machine]");
    return {
      value: field?.value ?? "",
      readOnly: field?.readOnly === true,
      disabled: field?.disabled === true,
      hasCopy: Boolean(document.querySelector("[data-activate-copy]")),
      labels: [...document.querySelectorAll(".activate .btn__label")].map((node) => node.textContent),
      extras: [...document.querySelectorAll(
        "[data-request-toggle],[data-request-panel],[data-request-copy],[data-request-save],[data-request-channel],[data-activate-file],[data-activate-more]",
      )].map((node) => node.className || node.tagName),
    };
  });
  check(
    "код компьютера в нередактируемом поле",
    machine.value === "DEMO-DEMO" && machine.readOnly === true && machine.disabled === false,
    `${machine.value} readOnly=${machine.readOnly} disabled=${machine.disabled}`,
  );
  check("на экране по-прежнему две кнопки", machine.labels.join(",") === "Активировать,Скопировать", machine.labels.join(", "));
  check("кнопка копирования есть, заявки и «активации файлом» нет", machine.hasCopy === true && machine.extras.length === 0, machine.extras.join(", "));

  // Копирование в headless-браузере может быть запрещено политикой буфера:
  // экран обязан пережить это без падения — ответ идёт тостом, не ошибкой.
  await page.click("[data-activate-copy]");
  await page.waitForTimeout(500);
  check("кнопка копирования не роняет экран", (await page.evaluate(() => Boolean(document.querySelector(".activate__card")))) === true);
  const copyToast = await page.evaluate(() => [...document.querySelectorAll(".toast__msg")].map((node) => node.textContent).join(" "));
  check("на копирование есть ответ", /скопирован|Ctrl\+C/i.test(copyToast), copyToast.slice(0, 90));

  await page.screenshot({ path: path.join(SHOTS_DIR, "activation-filled.png") });

  // Второй проход: экран с сообщением о порче файлов (?license=demo-tampered).
  await page.goto(`${BASE_URL}/?license=demo-tampered`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".activate__card", { timeout: 20000 });
  const tampered = await readNotes(page);
  check("при порче файлов показано предупреждение", /изменены/i.test(tampered.tamper), tampered.tamper);
  check("предупреждение о порче видимо (не скрыто стилем)", tampered.tamperVisible === true);
  const disabled = await page.evaluate(() => ({
    actions: [...document.querySelectorAll(".activate__actions .btn")].map((node) => node.disabled === true),
    code: document.querySelector("#activation-code")?.disabled === true,
    machine: document.querySelector("[data-activate-machine]")?.disabled === true,
  }));
  check(
    "кнопка активации и поле кода заблокированы при порче",
    disabled.actions.length === 1 && disabled.actions.every(Boolean) && disabled.code === true,
    JSON.stringify(disabled),
  );
  check("при порче код компьютера всё равно можно скопировать", disabled.machine === false);
  check("при порче интерфейс приложения не построен", (await page.evaluate(() => Boolean(document.querySelector(".sidebar")))) === false);
  await page.screenshot({ path: path.join(SHOTS_DIR, "activation-tampered.png") });

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
