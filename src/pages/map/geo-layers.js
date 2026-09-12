/**
 * Географический слой: границы стран поверх спутника.
 *
 * Данные лежат локально (src/assets/geo), подготавливаются скриптом
 * npm run prepare:assets. Сеть для них не нужна.
 *
 * Слой только подсказывает, где что находится: тонкие светлые контуры без
 * подсветки, подписей и реакции на мышь (interactive: false). Клик в любом
 * месте — в том числе внутри России — это клик по карте, и точка выбирается
 * там. Границы регионов не рисуются: для выбора точки они не нужны.
 */

import L from "leaflet";

export const GEO_SOURCES = Object.freeze({
  countries: new URL("../../assets/geo/countries.geojson", import.meta.url).href,
});

export const GEO_MANIFEST_URL = new URL("../../assets/geo/manifest.json", import.meta.url).href;

const LINE = "#ffffff";

const COUNTRY_STYLE = Object.freeze({ color: LINE, weight: 1.1, opacity: 0.6, fill: false });

const cache = new Map();

async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  if (cache.has(url)) return cache.get(url);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const promise = (async () => {
    const response = await fetch(url, { signal: controller.signal, cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json || typeof json !== "object") throw new Error("Некорректный формат геоданных");
    return json;
  })()
    .then((value) => {
      cache.set(url, value);
      return value;
    })
    .catch((error) => {
      cache.delete(url);
      throw error;
    })
    .finally(() => window.clearTimeout(timer));
  cache.set(url, promise);
  return promise;
}

export function loadGeoData() {
  return fetchJson(GEO_SOURCES.countries)
    .catch(() => null)
    .then((countries) => ({ countries, missing: !countries }));
}

export function loadGeoManifest() {
  return fetchJson(GEO_MANIFEST_URL).catch(() => null);
}

/**
 * Контур, пересекающий 180-й меридиан (Россия, Фиджи, Антарктида в Natural
 * Earth), Leaflet рисует одной линией через весь мир. Такое кольцо режется
 * на два: восточное (…180) и западное (−180…).
 */
function splitAntimeridian(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return feature;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : null;
  if (!polygons) return feature;

  let touched = false;
  const out = [];
  for (const polygon of polygons) {
    const ring = polygon[0] ?? [];
    const crosses = ring.some((point, index) => index > 0 && Math.abs(point[0] - ring[index - 1][0]) > 180);
    if (!crosses) {
      out.push(polygon);
      continue;
    }
    touched = true;
    const east = [];
    const west = [];
    for (const [lng, lat] of ring) {
      if (lng >= 0) east.push([lng, lat]);
      else west.push([lng, lat]);
    }
    for (const part of [east, west]) {
      if (part.length < 3) continue;
      const first = part[0];
      const last = part[part.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) part.push([first[0], first[1]]);
      out.push([part]);
    }
  }
  if (!touched) return feature;
  return { ...feature, geometry: { type: "MultiPolygon", coordinates: out } };
}

function boundaryLayer(baseStyle) {
  return L.geoJSON(null, {
    // Контуры — только подложка-ориентир: без реакции на наведение и клики.
    interactive: false,
    smoothFactor: 0.6,
    style: () => ({ ...baseStyle }),
  });
}

function withSplitFeatures(layer) {
  const addData = layer.addData.bind(layer);
  layer.addData = (geojson) => {
    if (geojson && Array.isArray(geojson.features)) {
      return addData({ ...geojson, features: geojson.features.map(splitAntimeridian) });
    }
    return addData(geojson);
  };
  return layer;
}

export function createCountryLayer() {
  return withSplitFeatures(boundaryLayer(COUNTRY_STYLE));
}
