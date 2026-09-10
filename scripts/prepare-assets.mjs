/**
 * Подготовка локальных ресурсов: иконки Lucide, шрифты (через npm), географические данные.
 *
 *   node scripts/prepare-assets.mjs            — скопировать иконки, пересобрать гео
 *   node scripts/prepare-assets.mjs --icons     — только иконки Lucide
 *   node scripts/prepare-assets.mjs --geo       — только географические файлы
 *   node scripts/prepare-assets.mjs --offline    — не обращаться к сети
 *
 * Геоданные берутся из зафиксированных источников (см. GEO_SOURCES ниже):
 *   • страны — world-atlas@2.0.2 (TopoJSON на основе Natural Earth 1:110m);
 *   • регионы России — Natural Earth 1:10m admin 1, отфильтрованные по RUS и
 *     упрощённые. Фиксируется commit репозитория natural-earth-vector, поэтому
 *     результат воспроизводим.
 *
 * Без сети скрипт оставляет уже подготовленные файлы и сообщает об этом:
 * сборка не должна падать из-за недоступности источника границ.
 */

import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICONS_SRC = path.join(ROOT, "node_modules", "lucide-static", "icons");
const ICONS_DST = path.join(ROOT, "src", "assets", "icons");
const GEO_DST = path.join(ROOT, "src", "assets", "geo");
const CACHE_DST = path.join(GEO_DST, "cache");

/** Нужные интерфейсу иконки Lucide — один набор контурных иконок на всё приложение. */
const LUCIDE_ICONS = [
  "arrow-left",
  "arrow-down",
  "arrow-up",
  "arrow-up-down",
  "calendar",
  "chart-line",
  "check",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "chevrons-left",
  "chevrons-right",
  "circle-alert",
  "circle-help",
  "clipboard-list",
  "cloud-off",
  "database",
  "download",
  "eye",
  "file-text",
  "filter",
  "flask-conical",
  "inbox",
  "info",
  "layers",
  "line-chart",
  "list",
  "locate",
  "map",
  "map-pin",
  "minus",
  "pencil",
  "plus",
  "rotate-ccw",
  "save",
  "search",
  "search-x",
  "shield-alert",
  "sliders-horizontal",
  "sparkles",
  "sprout",
  "table",
  "table-2",
  "trash-2",
  "triangle-alert",
  "x",
];

const GEO_SOURCES = {
  worldAtlasPackage: "world-atlas@2.0.2",
  naturalEarthRepo: "nvkelso/natural-earth-vector",
  /**
   * Файл границ зафиксирован по blob SHA — это контрольная сумма содержимого,
   * поэтому ссылка на неё точнее, чем на ветку: данные не поменяются молча.
   */
  admin1File: "ne_10m_admin_1_states_provinces.geojson",
  admin1BlobSha: "4a8438f98ac7dfec7dc1739b1eaf91398ad33f22",
  license: "Natural Earth — public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
  attribution: "Границы: Natural Earth (admin 0 countries, admin 1 states and provinces)",
};

const args = new Set(process.argv.slice(2));
const onlyIcons = args.has("--icons");
const onlyGeo = args.has("--geo");
const offline = args.has("--offline");

/* ── Иконки ─────────────────────────────────────────────────────────────── */

async function prepareIcons() {
  let available;
  try {
    available = await stat(ICONS_SRC).then(() => true);
  } catch {
    available = false;
  }
  if (!available) {
    console.warn(`⚠ Каталог ${path.relative(ROOT, ICONS_SRC)} не найден. Выполните npm install.`);
    return 0;
  }
  await mkdir(ICONS_DST, { recursive: true });
  let copied = 0;
  const missing = [];
  for (const name of LUCIDE_ICONS) {
    const from = path.join(ICONS_SRC, `${name}.svg`);
    const to = path.join(ICONS_DST, `${name}.svg`);
    try {
      const content = await readFile(from, "utf8");
      // Нормализация: фиксируем viewBox и убираем размеры — размер задаёт CSS
      const normalized = content
        .replace(/<svg([^>]*)\swidth="\d+"/, '<svg$1')
        .replace(/<svg([^>]*)\sheight="\d+"/, '<svg$1')
        .replace(/<svg([^>]*)>/, (match, attrs) => (/\sversion=/.test(match) ? match : `<svg${attrs}>`));
      await writeFile(to, normalized, "utf8");
      copied += 1;
    } catch {
      missing.push(name);
    }
  }
  console.log(`✓ ${copied} иконок Lucide → src/assets/icons`);
  if (missing.length > 0) console.warn(`⚠ не найдены в lucide-static: ${missing.join(", ")}`);
  return copied;
}

/* ── Геометрия ──────────────────────────────────────────────────────────── */

/** Douglas-Peucker: удаление почти коллинеарных точек без изменения формы. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDistance = -1;
    let index = -1;
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const denominator = Math.hypot(dx, dy);
    for (let i = start + 1; i < end; i += 1) {
      const [px, py] = points[i];
      const distance = denominator === 0 ? Math.hypot(px - x1, py - y1) : Math.abs((dy * px - dx * py + x2 * y1 - y2 * x1) / denominator);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (maxDistance > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function quantize(points, decimals = 3) {
  const factor = 10 ** decimals;
  return points.map(([x, y]) => [Math.round(x * factor) / factor, Math.round(y * factor) / factor]);
}

function removeDegenerate(points, minPoints) {
  return points.length >= minPoints ? points : null;
}

function simplifyPolygon(rings, tolerance) {
  const out = [];
  for (const ring of rings) {
    const simplified = simplify(quantize(ring, 4), tolerance);
    const closed = simplified.length >= 4 ? simplified : null;
    if (closed) out.push(closed);
  }
  return out;
}

function simplifyGeometry(geometry, tolerance) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    const rings = simplifyPolygon(geometry.coordinates, tolerance);
    return rings && rings.some((ring) => ring.length >= 4) ? { type: "Polygon", coordinates: rings } : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = [];
    for (const polygon of geometry.coordinates ?? []) {
      const rings = simplifyPolygon(polygon, tolerance);
      const valid = rings.filter((ring) => ring.length >= 4);
      if (valid.length > 0) polygons.push(valid);
    }
    return polygons.length > 0 ? { type: "MultiPolygon", coordinates: polygons } : null;
  }
  return null;
}

async function githubRawBlob(ownerRepo, blobSha) {
  const url = `https://api.github.com/repos/${ownerRepo}/git/blobs/${blobSha}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw",
      "User-Agent": "agroprognoz-prepare-assets",
      // Токен читается из переменных окружения и никогда не выводится в лог
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} для blob ${blobSha}`);
  return response.text();
}

async function download(url, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, { headers: { "User-Agent": "agroprognoz-prepare-assets" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} для ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return buffer;
}

async function cachedRead(file, fetcher) {
  try {
    return await readFile(file, "utf8");
  } catch {
    const text = await fetcher();
    await writeFile(file, text, "utf8");
    return text;
  }
}

async function prepareGeo() {
  await mkdir(GEO_DST, { recursive: true });
  await mkdir(CACHE_DST, { recursive: true });
  const meta = { generatedAt: null, sources: {}, outputs: {} };

  /* Страны мира — из локального пакета world-atlas (TopoJSON → GeoJSON) */
  let countriesWritten = false;
  try {
    const topo = JSON.parse(await readFile(path.join(ROOT, "node_modules/world-atlas/countries-110m.json"), "utf8"));
    const { feature } = require("topojson-client");
    const collection = feature(topo, topo.objects.countries);
    const features = [];
    for (const item of collection.features ?? []) {
      const geometry = simplifyGeometry(item.geometry, 0);
      const name = typeof item.properties?.name === "string" ? item.properties.name : String(item.id ?? "");
      if (geometry && name) features.push({ type: "Feature", properties: { name: name.slice(0, 80) }, geometry });
    }
    const output = { type: "FeatureCollection", features };
    await writeFile(path.join(GEO_DST, "countries.geojson"), JSON.stringify(output), "utf8");
    countriesWritten = true;
    meta.sources.countries = {
      package: GEO_SOURCES.worldAtlasPackage,
      file: "countries-110m.json",
      note: "TopoJSON на основе Natural Earth 1:110m; координаты без упрощения, только округление",
      features: features.length,
      license: "ISC (обёртка) + Natural Earth public domain (данные)",
    };
    console.log(`✓ countries.geojson — ${features.length} стран`);
  } catch (error) {
    console.warn(`⚠ countries.geojson не пересобран: ${error.message}`);
  }

  /* Регионы России — Natural Earth 1:10m, отбор RUS + упрощение */
  const target = path.join(GEO_DST, "russia-admin1.geojson");
  let regionsWritten = false;
  const cachePath = path.join(CACHE_DST, GEO_SOURCES.admin1File);
  const cachedAvailable = await stat(cachePath).then(
    () => true,
    () => false,
  );
  if (offline && !cachedAvailable) {
    console.log("• пропуск загрузки границ: --offline, кэша нет");
  } else {
    try {
      const raw = await cachedRead(cachePath, () => githubRawBlob(GEO_SOURCES.naturalEarthRepo, GEO_SOURCES.admin1BlobSha));
      const source = JSON.parse(raw);
      const features = [];
      for (const item of source.features ?? []) {
        const properties = item.properties ?? {};
        const country = (properties.adm0_a3 ?? properties.ADM0_A3 ?? properties.admin ?? "").toString().toUpperCase();
        if (country !== "RUS") continue;
        const nameLatin = (properties.name ?? properties.NAME ?? "").toString().trim();
        // В источнике есть безымянный полигон (adm1_code RUS+99?): его показывать нечем,
        // поэтому в слой он не попадает — количество регионов определяется источником.
        if (!nameLatin) continue;
        const geometry = simplifyGeometry(item.geometry, 0.004);
        if (!geometry) continue;
        const nameRu = (properties.name_ru ?? properties.NAME_RT ?? "").toString().trim();
        const type = (properties.type_en ?? properties.type ?? properties.TYPE ?? "").toString().slice(0, 60);
        const typeRu = (properties.type ?? "").toString().slice(0, 60);
        const code = (properties.iso_3166_2 ?? "").toString().replace(/~$/, "").slice(0, 12);
        features.push({
          type: "Feature",
          properties: {
            name: (nameRu || nameLatin).slice(0, 80),
            nameLatin: nameLatin.slice(0, 80),
            type,
            typeRu,
            code,
          },
          geometry,
        });
      }
      if (features.length > 0) {
        features.sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name), "ru"));
        await writeFile(target, JSON.stringify({ type: "FeatureCollection", features }), "utf8");
        regionsWritten = true;
        meta.sources.russiaRegions = {
          dataset: "Natural Earth admin 1 — states and provinces (1:10m)",
          repo: GEO_SOURCES.naturalEarthRepo,
          blobSha: GEO_SOURCES.admin1BlobSha,
          file: GEO_SOURCES.admin1File,
          filter: "adm0_a3 = RUS, безымянные полигоны источника исключены",
          simplification: "Douglas-Peucker, допуск 0.004°, координаты округлены до 0.0001°",
          features: features.length,
          license: GEO_SOURCES.license,
        };
        console.log(`✓ russia-admin1.geojson — ${features.length} регионов (версия источника зафиксирована)`);
      } else {
        console.warn("⚠ в исходном файле не найдено ни одного региона RUS — файл не перезаписан");
      }
    } catch (error) {
      console.warn(`⚠ russia-admin1.geojson не обновлён: ${error.message}`);
    }
  }

  if (!regionsWritten && !offline) {
    try {
      const existing = await stat(target);
      console.log(`• используется ранее подготовленный russia-admin1.geojson (${(existing.size / 1024).toFixed(0)} KiB)`);
    } catch {
      console.warn("⚠ russia-admin1.geojson отсутствует: слои регионов будут недоступны");
    }
  }

  meta.generatedAt = new Date().toISOString();
  meta.attribution = GEO_SOURCES.attribution;
  for (const [key, file] of Object.entries({ countries: "countries.geojson", russiaRegions: "russia-admin1.geojson" })) {
    try {
      const info = await stat(path.join(GEO_DST, file));
      meta.outputs[key] = { file, bytes: info.size };
    } catch {
      meta.outputs[key] = { file, bytes: null, missing: true };
    }
  }
  await writeFile(path.join(GEO_DST, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  console.log("✓ manifest.json — источники, версия и лицензия зафиксированы");
}

/* ── Запуск ─────────────────────────────────────────────────────────────── */

if (!onlyGeo) await prepareIcons();
if (!onlyIcons) await prepareGeo();
console.log("Готово.");
