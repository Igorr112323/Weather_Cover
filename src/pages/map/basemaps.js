/**
 * Подложка карты — только спутниковые снимки.
 *
 * Тайлы — единственные сетевые запросы приложения. Источник требует указания
 * авторства, оно сохранено в attribution слоя. Условия использования:
 *   • Esri World Imagery — https://www.esri.com/legal/licensing
 *
 * Без сети карта показывает сообщение об ошибке, остальные разделы работают.
 */

import L from "leaflet";

export const BASEMAPS = Object.freeze({
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

export const DEFAULT_BASEMAP = "satellite";

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
