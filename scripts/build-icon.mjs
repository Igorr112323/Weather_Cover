/**
 * Иконка приложения: SVG-источник → PNG → ICO.
 *
 *   node scripts/build-icon.mjs
 *
 * Растровые версии собираются sharp (локально, без сети). ICO собирается
 * вручную (PNG-внутри-ICO, поддерживается Windows Vista и новее), поэтому
 * ImageMagick и другие внешние утилиты не нужны.
 *
 * Для 16 и 32 px используется упрощённая геометрия: на малых размерах
 * зёрна сливаются, а целиковый силуэт початка читается лучше.
 */

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND_DIR = path.join(ROOT, "src", "assets", "brand");
const BUILD_DIR = path.join(ROOT, "build");

const MASTER_SVG = path.join(BRAND_DIR, "app-icon.svg");
const SIMPLE_SVG = path.join(BRAND_DIR, "app-icon-16.svg");

/** size → какой исходник использовать */
const RASTER_TARGETS = [
  { size: 16, source: SIMPLE_SVG },
  { size: 32, source: SIMPLE_SVG },
  { size: 48, source: MASTER_SVG },
  { size: 128, source: MASTER_SVG },
  { size: 256, source: MASTER_SVG },
  { size: 512, source: MASTER_SVG },
];

const ICO_SIZES = [16, 32, 48, 256];

async function rasterize(sharp, svgPath, size) {
  const svg = await readFile(svgPath);
  return sharp(svg, { density: Math.max(96, (size / 64) * 96 * 4) })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** ICO-контейнер с PNG-изображениями (формат, который понимает Windows). */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // зарезервировано
  header.writeUInt16LE(1, 2); // тип 1 = иконка
  header.writeUInt16LE(count, 4);

  const entrySize = 16;
  const directory = Buffer.alloc(entrySize * count);
  let offset = header.length + entrySize * count;

  entries.forEach((entry, index) => {
    const at = index * entrySize;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // количество цветов — не используется
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4); // плоскости
    directory.writeUInt16LE(32, at + 6); // бит на пиксель
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

async function main() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (error) {
    console.error("Не найден sharp. Установите зависимости: npm install");
    throw error;
  }

  await mkdir(BUILD_DIR, { recursive: true });
  await mkdir(BRAND_DIR, { recursive: true });

  const bySize = new Map();
  for (const target of RASTER_TARGETS) {
    const buffer = await rasterize(sharp, target.source, target.size);
    const fileName = `icon-${target.size}.png`;
    await writeFile(path.join(BUILD_DIR, fileName), buffer);
    bySize.set(target.size, buffer);
    console.log(`✓ build/${fileName} (${(buffer.length / 1024).toFixed(1)} KiB, ${path.basename(target.source)})`);
  }

  await writeFile(path.join(BUILD_DIR, "icon.png"), bySize.get(256));
  await writeFile(path.join(BRAND_DIR, "app-icon.png"), bySize.get(256));
  await copyFile(MASTER_SVG, path.join(BUILD_DIR, "icon.svg"));
  await copyFile(SIMPLE_SVG, path.join(BUILD_DIR, "icon-simple.svg"));

  const entries = ICO_SIZES.filter((size) => bySize.has(size)).map((size) => ({ size, data: bySize.get(size) }));
  if (entries.length === 0) {
    console.error("Нет растеров для ICO");
    process.exitCode = 1;
    return;
  }
  const ico = buildIco(entries);
  await writeFile(path.join(BUILD_DIR, "icon.ico"), ico);
  console.log(`✓ build/icon.ico (${ico.length} байт, размеры: ${entries.map((entry) => entry.size).join(", ")} px)`);
}

await main();
