/**
 * «Чёрный ящик» для отладки smoke-теста в CI.
 *
 * Открывает запущенный предпросмотр, ждёт загрузки, сохраняет:
 *   tests/smoke/debug/shot.jpg      — скриншот страницы
 *   tests/smoke/debug/console.txt   — сообщения консоли браузера и ошибки страницы
 *   tests/smoke/debug/body.txt      — видимый текст страницы
 *   tests/smoke/debug/info.txt      — адрес, заголовок, User-Agent
 *
 * Никогда не завершается ошибкой: это диагностика, а не проверка.
 * Запуск: node tests/smoke/debug-capture.mjs (нужен поднятый сервер).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = process.env.AGRO_SMOKE_URL ?? "http://localhost:4173";
const OUT_DIR = path.join(ROOT, "tests", "smoke", "debug");

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const consoleLines = [];

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, timeout: 60000 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (message) => {
      consoleLines.push(`[${message.type()}] ${message.text().slice(0, 500)}`);
    });
    page.on("pageerror", (error) => {
      consoleLines.push(`[pageerror] ${String(error?.message ?? error).slice(0, 500)}`);
      if (error?.stack) consoleLines.push(String(error.stack).split("\n").slice(0, 8).join("\n"));
    });
    page.on("requestfailed", (request) => {
      consoleLines.push(`[requestfailed] ${request.url().slice(0, 200)} — ${request.failure()?.errorText ?? ""}`);
    });

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(10000);

    await page.screenshot({ path: path.join(OUT_DIR, "shot.jpg"), type: "jpeg", quality: 55 });
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "");
    const info = [
      `url: ${page.url()}`,
      `title: ${await page.title()}`,
      `userAgent: ${await page.evaluate(() => navigator.userAgent)}`,
      `indexedDB: ${await page.evaluate(() => ("indexedDB" in window ? "yes" : "NO"))}`,
      `wasm: ${await page.evaluate(() => (typeof WebAssembly === "object" ? "yes" : "NO"))}`,
      `bootNode: ${await page.evaluate(() => document.getElementById("app")?.childElementCount ?? "no #app")}`,
    ].join("\n");

    await writeFile(path.join(OUT_DIR, "body.txt"), bodyText, "utf8");
    await writeFile(path.join(OUT_DIR, "info.txt"), info, "utf8");
    console.log("debug-capture: готово");
  } catch (error) {
    consoleLines.push(`[capture-error] ${String(error?.message ?? error).slice(0, 500)}`);
    console.log(`debug-capture: ${error?.message ?? error}`);
  } finally {
    await writeFile(path.join(OUT_DIR, "console.txt"), consoleLines.join("\n") || "(пусто)", "utf8");
    try {
      await Promise.race([
        browser?.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* диагностика не должна виснуть */
    }
    process.exit(0);
  }
}

main();
