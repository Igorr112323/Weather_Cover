/**
 * Подложки карты.
 *
 * Тайлы — единственные сетевые запросы приложения. Оба источника требуют
 * указания авторства, оно сохранено в attribution слоёв (это текст источников,
 * а не пользовательские данные). Условия использования:
 *   • CARTO Positron — https://carto.com/attribution (данные © OpenStreetMap, ODbL)
 *   • Esri World Imagery — https://www.esri.com/legal/licensing
 *
 * Без сети карта показывает сообщение об ошибке, остальные разделы работают.
 */

import L from "leaflet";

export const BASEMAPS = Object.freeze({
  light: {
    id: "light",
    label: "Карта",
    create() {
      return L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd",
        maxZoom: 20,
        maxNativeZoom: 19,
        keepBuffer: 1,
        crossOrigin: true,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      });
    },
  },
  satellite: {
    id: "satellite",
    label: "Спутник",
    create() {
      return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        maxNativeZoom: 19,
        keepBuffer: 1,
        crossOrigin: true,
        attribution: "Спутниковые снимки &copy; Esri, Maxar, Earthstar Geographics",
      });
    },
  },
});

export const DEFAULT_BASEMAP = "light";

export function createBasemap(id) {
  return BASEMAPS[id] ?? BASEMAPS[DEFAULT_BASEMAP];
}

/**
 * Слой, который сообщает о недоступности тайлов.
 * @param {{onFailure:(info:object)=>void, onLoaded:()=>void}} handlers
 */
export function watchTiles(layer, handlers) {
  let loaded = 0;
  let failures = 0;
  layer.on("tileload", () => {
    loaded += 1;
    if (loaded === 1) handlers.onLoaded?.();
  });
  layer.on("tileerror", (event) => {
    failures += 1;
    if (failures >= 3 && loaded === 0) {
      handlers.onFailure?.({ code: "TILES_UNREACHABLE", url: String(event?.tile?.src ?? "").slice(0, 120) });
    }
  });
  return {
    get loaded() {
      return loaded;
    },
    get failures() {
      return failures;
    },
    reset() {
      loaded = 0;
      failures = 0;
    },
  };
}
