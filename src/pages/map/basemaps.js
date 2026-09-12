/**
 * Подложка карты — только спутниковые снимки.
 *
 * Тайлы — единственные сетевые запросы приложения. Источник требует указания
 * авторства, оно сохранено в attribution слоя. Условия использования:
 *   • Esri World Imagery — https://www.esri.com/legal/licensing
 *
 * Без сети карта показывает сообщение об ошибке, остальные разделы работают.
 *
 * Защита от заглушек «Map data not yet available»: сервер с параметром
 * blankTile=false отвечает на отсутствующий тайл кодом 404 вместо серой
 * картинки с надписью, а слой в этом случае берёт снимок более мелкого
 * масштаба и показывает нужную его часть увеличенной. Максимальный масштаб
 * ограничен уровнем, подробнее которого снимков почти нигде нет.
 */

import L from "leaflet";

/** Ближе этого масштаба карта не приближается. */
export const MAX_ZOOM = 18;

/**
 * На сколько уровней вверх подниматься в поисках снимка, если тайла нужного
 * масштаба нет. Над открытым морем снимки заканчиваются около 13-го уровня,
 * так что с 18-го хватает шести шагов; без сети это ограничивает число
 * лишних запросов.
 */
const FALLBACK_LEVELS = 6;

const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false";

/**
 * Слой тайлов с подстраховкой: на ошибку загрузки (в первую очередь 404 для
 * отсутствующего снимка) тайл переключается на родительский снимок соседнего
 * более мелкого масштаба — увеличенный и обрезанный до нужной четверти.
 * Пустых клеток и заглушек с надписью на карте не остаётся; событие
 * tileerror уходит только когда снимка нет ни на одном из уровней (нет сети).
 */
const FallbackTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = L.TileLayer.prototype.createTile.call(this, coords, done);
    tile.agroOrigin = { x: coords.x, y: coords.y, z: coords.z };
    tile.agroFallback = null;
    return tile;
  },

  _tileOnError(done, tile, event) {
    // Тайл уже снят с карты: Leaflet подменил src пустой картинкой.
    if (!this._map || tile.getAttribute("src") === L.Util.emptyImageUrl) return;

    const origin = tile.agroOrigin;
    const current = tile.agroFallback ?? { ...origin, scale: 1 };
    const next = { x: Math.floor(current.x / 2), y: Math.floor(current.y / 2), z: current.z - 1, scale: current.scale * 2 };
    const floor = Math.max(0, origin.z - FALLBACK_LEVELS, this.options.minNativeZoom ?? 0);
    if (next.z < floor) {
      L.TileLayer.prototype._tileOnError.call(this, done, tile, event);
      return;
    }

    tile.agroFallback = next;
    const size = this.getTileSize();
    const width = size.x * next.scale;
    const height = size.y * next.scale;
    // Смещение нужной четверти внутри увеличенного родительского снимка.
    const left = (origin.x - next.x * next.scale) * size.x;
    const top = (origin.y - next.y * next.scale) * size.y;
    const style = tile.style;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.marginLeft = `${-left}px`;
    style.marginTop = `${-top}px`;
    // Обрезка до клетки тайла: увеличенный снимок не наезжает на соседей.
    style.clipPath = `inset(${top}px ${width - left - size.x}px ${height - top - size.y}px ${left}px)`;
    tile.src = this._fallbackUrl(next);
  },

  _fallbackUrl({ x, y, z }) {
    return L.Util.template(this._url, L.Util.extend({ r: "", s: this._getSubdomain({ x, y }), x, y, z }, this.options));
  },
});

/**
 * Границы одной копии мира в Web Mercator (широта ограничена проекцией).
 * Карта не выпускает вид за эти пределы, а слой не запрашивает тайлы
 * соседних копий — мир на экране ровно один.
 */
export const WORLD_BOUNDS = Object.freeze([
  [-85.0511, -180],
  [85.0511, 180],
]);

export const BASEMAPS = Object.freeze({
  satellite: {
    id: "satellite",
    label: "Спутник",
    create() {
      return new FallbackTileLayer(TILE_URL, {
        maxZoom: MAX_ZOOM,
        maxNativeZoom: MAX_ZOOM,
        keepBuffer: 1,
        noWrap: true,
        bounds: WORLD_BOUNDS,
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
