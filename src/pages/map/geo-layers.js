/**
 * Географические слои: границы стран и регионов России поверх спутника.
 *
 * Данные лежат локально (src/assets/geo), подготавливаются скриптом
 * npm run prepare:assets. Сеть для них не нужна.
 *
 * Слои только подсказывают, где что находится (светлые границы + название
 * при наведении). Клик по ним ничем не отличается от клика по свободной
 * поверхности карты — события всплывают до карты, и точка выбирается там.
 */

import L from "leaflet";

export const GEO_SOURCES = Object.freeze({
  countries: new URL("../../assets/geo/countries.geojson", import.meta.url).href,
  russiaRegions: new URL("../../assets/geo/russia-admin1.geojson", import.meta.url).href,
});

export const GEO_MANIFEST_URL = new URL("../../assets/geo/manifest.json", import.meta.url).href;

/** С этого масштаба поверх стран показываются регионы России. */
export const REGION_MIN_ZOOM = 4;

const LINE = "#ffffff";

const COUNTRY_STYLE = Object.freeze({ color: LINE, weight: 1.1, opacity: 0.6, fillColor: LINE, fillOpacity: 0 });
const COUNTRY_HOVER = Object.freeze({ weight: 1.8, opacity: 0.95, fillOpacity: 0.07 });

const REGION_STYLE = Object.freeze({ color: LINE, weight: 0.8, opacity: 0.5, fillColor: LINE, fillOpacity: 0 });
const REGION_HOVER = Object.freeze({ weight: 1.6, opacity: 0.95, fillOpacity: 0.08 });

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
  return Promise.all([
    fetchJson(GEO_SOURCES.countries).catch(() => null),
    fetchJson(GEO_SOURCES.russiaRegions).catch(() => null),
  ]).then(([countries, regions]) => ({ countries, regions, missing: !countries || !regions }));
}

export function loadGeoManifest() {
  return fetchJson(GEO_MANIFEST_URL).catch(() => null);
}

function nameOf(feature) {
  const properties = feature?.properties ?? {};
  const candidate = properties.name ?? properties.NAME ?? properties.admin ?? properties.ADMIN ?? "";
  return typeof candidate === "string" ? candidate.slice(0, 120) : "";
}

/** Тултип создаётся узлом с textContent: имена из GeoJSON не попадают в innerHTML. */
function tipNode(text) {
  const node = document.createElement("div");
  node.textContent = text;
  return node;
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

function boundaryLayer(baseStyle, hoverStyle) {
  return L.geoJSON(null, {
    interactive: true,
    // События всплывают до карты: клик по границе — это клик по карте (выбор точки),
    // двойной клик — приближение, как и везде.
    bubblingMouseEvents: true,
    smoothFactor: 0.6,
    style: () => ({ ...baseStyle }),
    onEachFeature(feature, featureLayer) {
      const name = nameOf(feature);
      if (name) featureLayer.bindTooltip(tipNode(name), { sticky: true, direction: "top", className: "geo-tip", opacity: 1 });
      featureLayer.on({
        mouseover: (event) => event.target.setStyle({ ...hoverStyle }),
        mouseout: (event) => event.target.setStyle({ ...baseStyle }),
      });
    },
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
  return withSplitFeatures(boundaryLayer(COUNTRY_STYLE, COUNTRY_HOVER));
}

export function createRegionLayer() {
  return withSplitFeatures(boundaryLayer(REGION_STYLE, REGION_HOVER));
}
