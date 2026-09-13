/**
 * Заставка portable-сборки: build/splash.bmp.
 *
 *   npm run build && npm run splash
 *
 * NSIS показывает картинку, пока распаковывает portable EXE (portable.splashImage
 * в package.json). Чтобы заставка совпадала с экраном загрузки Electron, снимок
 * делается с той же страницы dist/splash.html: Chromium (Playwright) рендерит
 * её в размере окна заставки, sharp отдаёт пиксели, BMP собирается вручную —
 * плагину BgImage нужен именно 24-битный BMP v3 с ненулевым разрешением.
 *
 * Переменные окружения:
 *   AGRO_CHROMIUM — путь к исполняемому файлу Chromium, если браузер Playwright
 *                   не установлен (npx playwright install chromium).
 *
 * Результат коммитится в репозиторий: сборка EXE в CI браузер не запускает.
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");
const OUTPUT = path.join(ROOT, "build", "splash.bmp");

/** Размер совпадает с окном заставки Electron (SPLASH_SIZE в electron/main.cjs). */
const WIDTH = 440;
const HEIGHT = 280;
/** 72 dpi в пикселях на метр: нулевое разрешение BgImage не принимает. */
const PIXELS_PER_METER = 2835;

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

/** Мини-сервер для dist/: file:// не подходит из-за crossorigin у стилей Vite. */
function serveDist() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const target = path.normalize(path.join(DIST_DIR, pathname === "/" ? "/index.html" : pathname));
      if (!target.startsWith(DIST_DIR + path.sep)) throw new Error("outside dist");
      const info = await stat(target);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, { "Content-Type": MIME.get(path.extname(target)) ?? "application/octet-stream" });
      response.end(await readFile(target));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** BMP v3 (BITMAPINFOHEADER), 24 бита, строки снизу вверх, BGR, выравнивание по 4 байта. */
function encodeBmp24(rgb, width, height) {
  const rowBytes = (width * 3 + 3) & ~3;
  const pixelBytes = rowBytes * height;
  const headerBytes = 14 + 40;
  const buffer = Buffer.alloc(headerBytes + pixelBytes);

  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(0, 6);
  buffer.writeUInt32LE(headerBytes, 10);

  buffer.writeUInt32LE(40, 14); // размер BITMAPINFOHEADER
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22); // положительная высота — строки снизу вверх
  buffer.writeUInt16LE(1, 26); // плоскости
  buffer.writeUInt16LE(24, 28); // бит на пиксель
  buffer.writeUInt32LE(0, 30); // BI_RGB, без сжатия
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(PIXELS_PER_METER, 38);
  buffer.writeInt32LE(PIXELS_PER_METER, 42);
  buffer.writeUInt32LE(0, 46);
  buffer.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = (height - 1 - y) * width * 3;
    const targetRow = headerBytes + y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 3;
      const target = targetRow + x * 3;
      buffer[target] = rgb[source + 2];
      buffer[target + 1] = rgb[source + 1];
      buffer[target + 2] = rgb[source];
    }
  }
  return buffer;
}

async function main() {
  const sharp = require("sharp");
  await stat(path.join(DIST_DIR, "splash.html")).catch(() => {
    throw new Error("Нет dist/splash.html — сначала выполните npm run build");
  });

  const { server, port } = await serveDist();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.AGRO_CHROMIUM || undefined,
    args: process.env.AGRO_CHROMIUM ? ["--no-sandbox", "--disable-gpu"] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    // Статичная полоса прогресса: заставка — неподвижная картинка.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${port}/splash.html`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const png = await page.screenshot({ type: "png" });

    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== WIDTH || info.height !== HEIGHT || info.channels !== 3) {
      throw new Error(`Неожиданный размер снимка: ${info.width}×${info.height}×${info.channels}`);
    }
    const bmp = encodeBmp24(data, WIDTH, HEIGHT);
    await writeFile(OUTPUT, bmp);
    console.log(`✓ ${path.relative(ROOT, OUTPUT)} (${WIDTH}×${HEIGHT}, 24 бита, ${(bmp.length / 1024).toFixed(0)} KiB)`);
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
