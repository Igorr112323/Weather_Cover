/**
 * Браузерный smoke-тест основного сценария.
 *
 *   # Терминал 1: сборка и предпросмотр (или dev-сервер)
 *   npm run build && npm run preview
 *   # Терминал 2:
 *   npm run test:smoke
 *
 * Переменные окружения:
 *   AGRO_SMOKE_URL — адрес приложения (по умолчанию http://localhost:4173)
 *   AGRO_SMOKE_SHOTS — каталог скриншотов (по умолчанию tests/smoke/screenshots)
 *   AGRO_SMOKE_HEADED — 1, чтобы смотреть за прогоном в окне браузера
 *
 * Сценарий: запуск → выбор точки → выбор сорта → прогноз → результаты →
 * сохранение отчёта → данные → архив → справочник сортов (добавление,
 * редактирование, удаление). Любая ошибка в консоли браузера роняет прогон.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.AGRO_SMOKE_URL ?? "http://localhost:4173";
const SHOTS_DIR = process.env.AGRO_SMOKE_SHOTS ?? path.join(ROOT, "tests", "smoke", "screenshots");
const HEADED = process.env.AGRO_SMOKE_HEADED === "1";

const failures = [];
const consoleErrors = [];

// Глобальный сторож: прогон обязан уложиться в 10 минут, иначе — fail-fast,
// а не вечное висение шага CI.
setTimeout(() => {
  console.error("SMOKE GLOBAL TIMEOUT: принудительное завершение");
  process.exit(1);
}, 10 * 60 * 1000).unref();

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function shot(page, name) {
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  · скриншот ${path.relative(ROOT, file)}`);
}

async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !HEADED, timeout: 90000 });
  try {
    await scenario(browser);
  } finally {
    // browser.close() иногда виснет в CI — ждём не дольше 8 секунд,
    // результат уже записан, дальше процесс завершается принудительно.
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  }
}

async function scenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(30000);

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error?.message ?? error).slice(0, 300)));

  console.log(`Открываю ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // ── Запуск и оболочка ──────────────────────────────────────────────
  await page.getByText("АгроПрогноз", { exact: true }).first().waitFor({ timeout: 30000 });
  check("оболочка: название приложения", true);
  const sidebar = page.locator(".sidebar__nav");
  for (const item of ["Карта", "Данные", "Отчёты", "Сорта кукурузы"]) {
    check(`оболочка: пункт «${item}»`, (await sidebar.getByRole("button", { name: item }).count()) === 1);
  }
  check("оболочка: версия", await page.getByText(/Версия \d+\.\d+\.\d+/).count() === 1);

  // ── Карта: точка, сорт, прогноз ────────────────────────────────────
  await page.locator(".leaflet-container").first().waitFor({ timeout: 30000 });
  check("карта: контейнер Leaflet", true);
  check("карта: панель прогноза", await page.getByText("Прогноз", { exact: true }).count() >= 1);
  check(
    "карта: точка не выбрана",
    await page.getByText("Выберите точку на карте", { exact: true }).count() === 1,
  );

  const mapBox = await page.locator(".leaflet-container").first().boundingBox();
  // Кандидаты слева и внизу: справа — панель прогноза, в центре —
  // регионы России (клик по региону приближает его, а не ставит точку).
  // После неудачной попытки Esc возвращает прежний вид и слой.
  const candidates = [
    [0.1, 0.78],
    [0.28, 0.22],
    [0.55, 0.8],
    [0.78, 0.62],
  ];
  for (const [fx, fy] of candidates) {
    await page.mouse.click(mapBox.x + mapBox.width * fx, mapBox.y + mapBox.height * fy);
    const selected = await page
      .waitForFunction(() => !document.body.textContent.includes("Выберите точку на карте"), null, {
        timeout: 2500,
      })
      .then(() => true)
      .catch(() => false);
    if (selected) break;
    await page.keyboard.press("Escape");
  }
  check(
    "карта: точка выбрана кликом",
    (await page.getByText("Выберите точку на карте", { exact: true }).count()) === 0,
  );
  check(
    "карта: координаты с пятью знаками",
    await page.getByText(/\d{1,3}\.\d{5}, -?\d{1,3}\.\d{5}/).count() >= 1,
  );
  check(
    "карта: статус деморежима",
    await page.getByText("Демонстрационный режим", { exact: true }).count() === 1,
  );
  await shot(page, "01-map");

  const varietySelect = page.locator(".forecast-panel select").first();
  const varietyCount = await varietySelect.locator("option").count();
  check("карта: в списке сортов есть записи", varietyCount >= 1);
  if (varietyCount > 1) {
    // Первое значение может быть плейсхолдером — выбираем первую непустую опцию.
    const values = await varietySelect.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => node.value).filter(Boolean),
    );
    if (values.length > 0) await varietySelect.selectOption(values[0]);
  }

  await page.getByRole("button", { name: "Спрогнозировать" }).click();
  await page.getByRole("heading", { name: "Результаты прогноза" }).waitFor({ timeout: 30000 });
  check("прогноз: открылись результаты", true);

  // ── Результаты ─────────────────────────────────────────────────────
  check(
    "результаты: отметка демоданных",
    await page.getByText("Демонстрационные данные", { exact: true }).count() === 1,
  );
  check(
    "результаты: предупреждение",
    await page.getByText("Не использовать для агрономических решений.", { exact: true }).count() === 1,
  );
  check("результаты: панель показателей", (await page.locator(".indicators .indicator").count()) === 5);
  check(
    "результаты: САТ и ГТК не рассчитаны",
    (await page.getByText("Не рассчитано").count()) >= 2,
  );
  check(
    "результаты: риски не рассчитаны",
    await page.getByText("Риски не рассчитаны", { exact: true }).count() === 1,
  );
  check("результаты: графики", (await page.locator(".chart-box canvas").count()) === 2);
  await shot(page, "02-results-charts");

  await page.getByRole("button", { name: "Таблица" }).click();
  check("результаты: таблица дневных значений", (await page.locator("table tbody tr").count()) > 20);
  await page.getByRole("button", { name: "Графики" }).click();

  const saveButton = page.getByRole("button", { name: "Сохранить отчёт" });
  await saveButton.click();
  await page.getByRole("button", { name: "Сохранено" }).waitFor({ timeout: 10000 });
  check("результаты: отчёт сохранён без дубликата", true);
  await shot(page, "03-results-saved");

  // ── Данные ─────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Данные", exact: true }).click();
  await page.getByRole("heading", { name: "Данные", exact: true }).waitFor({ timeout: 10000 });
  check("данные: строка набора", (await page.locator("table tbody tr").count()) >= 1);
  check(
    "данные: источник «Демонстрационные»",
    await page.getByText("Демонстрационные", { exact: true }).count() >= 1,
  );
  await shot(page, "04-datasets");

  await page.locator("table tbody tr").first().click();
  await page.getByRole("button", { name: "Назад к данным" }).waitFor({ timeout: 10000 });
  check("данные: карточка набора", true);
  check(
    "данные: экспорт CSV",
    await page.getByRole("button", { name: "Экспорт CSV" }).count() === 1,
  );
  await shot(page, "05-dataset-detail");
  await page.getByRole("button", { name: "Назад к данным" }).click();

  // ── Отчёты ─────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Отчёты", exact: true }).click();
  await page.getByRole("heading", { name: "Отчёты", exact: true }).waitFor({ timeout: 10000 });
  check("отчёты: строка в архиве", (await page.locator("table tbody tr").count()) >= 1);
  await shot(page, "06-reports");

  await page.locator("table tbody tr").first().click();
  await page.getByRole("heading", { name: "Отчёт из архива" }).waitFor({ timeout: 10000 });
  check("отчёты: открытие снимка из архива", true);
  check(
    "отчёты: движок не вызывался",
    await page.getByText(/Движок не вызывался/).count() === 1,
  );
  await page.getByRole("button", { name: "К архиву" }).click();
  await page.getByRole("heading", { name: "Отчёты", exact: true }).waitFor({ timeout: 10000 });

  // ── Сорта: добавление, редактирование, удаление ────────────────────
  await page.getByRole("button", { name: "Сорта кукурузы", exact: true }).click();
  await page.getByRole("heading", { name: "Сорта кукурузы", exact: true }).waitFor({ timeout: 10000 });
  check(
    "сорта: демонстрационная запись",
    await page.getByText("Демонстрационный сорт").count() >= 1,
  );

  const varietyName = `Смоук-сорт ${Date.now() % 100000}`;
  await page.getByRole("button", { name: "Добавить сорт" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  await page.locator(".modal__body input").first().fill(varietyName);
  await page.locator(".modal__body input").nth(1).fill("240");
  await shot(page, "07-variety-form");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByText(varietyName).first().waitFor({ timeout: 10000 });
  check("сорта: создание", true);

  // После сохранения запись уже выбрана и detail открыт (клик по имени лишь снял бы выбор).
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const renamed = `${varietyName}-2`;
  await page.locator(".modal__body input").first().fill(renamed);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByText(renamed).first().waitFor({ timeout: 10000 });
  check("сорта: переименование", true);
  await shot(page, "07b-renamed");

  await page.getByText(renamed).first().click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.getByRole("button", { name: "Удалить сорт" }).click();
  await page.waitForFunction((name) => !document.body.textContent.includes(name), renamed, { timeout: 10000 });
  check("сорта: удаление", true);
  await shot(page, "08-varieties");

  // Персистентность в браузере: перезагрузка не теряет архив отчётов.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("АгроПрогноз", { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Отчёты", exact: true }).click();
  await page.getByRole("heading", { name: "Отчёты", exact: true }).waitFor({ timeout: 10000 });
  check("персистентность: отчёт пережил перезагрузку", (await page.locator("table tbody tr").count()) >= 1);

  if (consoleErrors.length > 0) {
    failures.push(`ошибки консоли (${consoleErrors.length})`);
    console.error("Ошибки консоли:");
    for (const text of consoleErrors.slice(0, 10)) console.error(`  · ${text}`);
  }

  await writeFile(
    path.join(SHOTS_DIR, "smoke-result.json"),
    JSON.stringify({ ok: failures.length === 0, failures, consoleErrors: consoleErrors.length }, null, 2),
  );

  if (failures.length > 0) {
    console.error(`\nSmoke FAILED: ${failures.length} проверок не прошли`);
    process.exitCode = 1;
  } else {
    console.log("\nSmoke OK: все проверки прошли");
  }
}

main()
  .catch((error) => {
    console.error("Smoke упал с исключением:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Гарантированный выход: открытый браузер не должен держать процесс.
    process.exit(process.exitCode ?? 0);
  });
