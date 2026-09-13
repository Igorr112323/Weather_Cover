/**
 * Проверка защиты production-сборки в браузере.
 *
 *   # Терминал 1:
 *   npm run build && npm run preview
 *   # Терминал 2:
 *   npm run test:gate
 *
 * Смысл: production-сборка, открытая как обычная страница (именно так её увидел
 * бы человек, распаковавший app.asar и раздавший dist/ статикой), работать не
 * должна. Ни экрана активации, ни данных — только отказ. Это и есть проверка,
 * что ветка «режим разработки» из production-бандла удалена вместе с условием.
 *
 * Переменные окружения:
 *   AGRO_GATE_URL   — адрес предпросмотра (по умолчанию http://localhost:4173)
 *   AGRO_GATE_SHOTS — каталог скриншотов
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.AGRO_GATE_URL ?? "http://localhost:4173";
const SHOTS_DIR = process.env.AGRO_GATE_SHOTS ?? path.join(ROOT, "tests", "smoke", "screenshots");

const failures = [];

setTimeout(() => {
  console.error("GATE GLOBAL TIMEOUT: принудительное завершение");
  process.exit(1);
}, 5 * 60 * 1000).unref();

function check(name, condition, detail = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`Проверка защиты production-сборки: ${BASE_URL}`);

await mkdir(SHOTS_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true, timeout: 90000 });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(30000);

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => document.body?.innerText ?? "");
  const state = await page.evaluate(() => ({
    hasBridge: typeof window.agro !== "undefined",
    sidebar: Boolean(document.querySelector(".sidebar")),
    navItems: document.querySelectorAll(".nav-item").length,
    activation: Boolean(document.querySelector(".activate")),
    bootError: Boolean(document.querySelector(".boot")),
    title: document.querySelector(".page-title")?.textContent ?? "",
  }));

  check("интерфейс приложения не построен", state.sidebar === false && state.navItems === 0, JSON.stringify(state));
  check("экран активации не предлагается (нет main process)", state.activation === false);
  check("показан отказ запускаться вне Electron", /AgroPrognoz\.exe/.test(text) && /браузер/i.test(text), state.title);
  check("моста window.agro в браузере нет", state.hasBridge === false);

  await page.screenshot({ path: path.join(SHOTS_DIR, "gate-browser-refused.png") });
  console.log(`  · скриншот ${path.relative(ROOT, path.join(SHOTS_DIR, "gate-browser-refused.png"))}`);

  // Второй заход: перезагрузка не должна ничего «починить».
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const again = await page.evaluate(() => Boolean(document.querySelector(".sidebar")));
  check("после перезагрузки приложение по-прежнему закрыто", again === false);
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
console.log("\n✔ Защита production-сборки проверена\n");
