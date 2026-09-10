/**
 * Географические слои: страны и административные регионы России.
 *
 * Данные лежат локально (src/assets/geo), подготавливаются скриптом
 * npm run prepare:assets. Сеть для них не нужна.
 *
 * Разделение действий (см. ТЗ):
 *   • клик по стране или свободной поверхности — выбор прогнозной точки;
 *   • клик по региону на масштабе 4–6 — приближение региона + спутник,
 *     выбор точки при этом НЕ выполняется;
 *   • Esc — возврат предыдущего вида и слоя.
 */

import L from "leaflet";

export const GEO_SOURCES = Object.freeze({
  countries: new URL("../../assets/geo/countries.geojson", import.meta.url).href,
  russiaRegions: new URL("../../assets/geo/russia-admin1.geojson", import.meta.url).href,
});

export const GEO_MANIFEST_URL = new URL("../../assets/geo/manifest.json", import.meta.url).href;

/** Максимальный масштаб, на котором клик по региону означает «приблизить регион». */
export const REGION_ZOOM_MIN = 4;
export const REGION_CLICK_MAX_ZOOM = 6;

const ACCENT = "#16834a";

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

export function createCountryLayer({ onCountryClick, visible = true } = {}) {
  const layer = L.geoJSON(null, {
    interactive: true,
    bubblingMouseEvents: false,
    smoothFactor: 0.6,
    style: () => ({
      color: ACCENT,
      weight: 1,
      opacity: visible ? 0.45 : 0,
      fillColor: ACCENT,
      fillOpacity: 0,
    }),
    onEachFeature(feature, featureLayer) {
      const name = nameOf(feature);
      if (name) featureLayer.bindTooltip(tipNode(name), { sticky: true, direction: "top", className: "geo-tip", opacity: 1 });

      featureLayer.on({
        mouseover: (event) => {
          event.target.setStyle({ fillOpacity: 0.08, weight: 1.6, opacity: 0.8 });
          // Без bringToFront: вынесенная наверх страна перекрыла бы слой
          // регионов России и клики по регионам перестали бы работать.
        },
        mouseout: (event) => {
          event.target.setStyle({ fillOpacity: 0, weight: 1, opacity: visible ? 0.45 : 0 });
        },
        click: (event) => {
          onCountryClick?.(event);
        },
      });
    },
  });
  return layer;
}

export function createRegionLayer({ onRegionClick, onRegionHover } = {}) {
  let selectedLayer = null;

  const layer = L.geoJSON(null, {
    interactive: true,
    // Свойство слоя + явная остановка события в обработчике: клик по региону
    // не «просыпается» как клик по карте.
    bubblingMouseEvents: false,
    smoothFactor: 0.5,
    style: () => ({
      color: ACCENT,
      weight: 0.9,
      opacity: 0.6,
      fillColor: ACCENT,
      fillOpacity: 0.02,
    }),
    onEachFeature(feature, featureLayer) {
      const name = nameOf(feature);
      if (name) featureLayer.bindTooltip(tipNode(name), { sticky: true, direction: "top", className: "geo-tip", opacity: 1 });

      featureLayer.on({
        mouseover: (event) => {
          const isSelected = event.target === selectedLayer;
          event.target.setStyle({
            fillOpacity: isSelected ? 0.14 : 0.08,
            weight: 1.8,
            opacity: 0.95,
          });
          event.target.bringToFront?.();
          onRegionHover?.(name);
        },
        mouseout: (event) => {
          const isSelected = event.target === selectedLayer;
          event.target.setStyle({
            fillOpacity: isSelected ? 0.14 : 0.02,
            weight: 0.9,
            opacity: 0.6,
          });
        },
        click: (event) => {
          const handled = onRegionClick?.(featureLayer, event);
          // Клик по региону не должен «просочиться» в обработчик выбора точки.
          if (handled !== false) {
            L.DomEvent.stopPropagation(event.originalEvent);
            if (event.originalEvent) event.originalEvent.stopPropagation();
          }
        },
      });
    },
  });

  return {
    layer,
    markSelected(featureLayer) {
      if (selectedLayer && selectedLayer !== featureLayer) {
        selectedLayer.setStyle({ fillOpacity: 0.02, weight: 0.9, opacity: 0.6 });
      }
      selectedLayer = featureLayer ?? null;
      if (selectedLayer) selectedLayer.setStyle({ fillOpacity: 0.14, weight: 1.8, opacity: 0.95 });
    },
    clearSelected() {
      if (selectedLayer) selectedLayer.setStyle({ fillOpacity: 0.02, weight: 0.9, opacity: 0.6 });
      selectedLayer = null;
    },
  };
}
