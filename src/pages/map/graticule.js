/**
 * Координатная сетка. Рисуется локально, без тайлов и без сети: тонкие линии
 * широт и долгот, которые не перекрывают подписи городов. Шаг зависит от масштаба.
 */

import L from "leaflet";

const STEPS = [
  { minZoom: 0, step: 20 },
  { minZoom: 3, step: 10 },
  { minZoom: 5, step: 5 },
  { minZoom: 7, step: 1 },
  { minZoom: 9, step: 0.5 },
  { minZoom: 12, step: 0.25 },
];

function stepFor(zoom) {
  let step = 20;
  for (const entry of STEPS) if (zoom >= entry.minZoom) step = entry.step;
  return step;
}

export function createGraticule(map, { pane = "agroGrid" } = {}) {
  if (!map.getPane(pane)) {
    map.createPane(pane);
    const element = map.getPane(pane);
    if (element) {
      element.style.zIndex = "350"; // под подписями и маркером, над тайлами
      element.style.pointerEvents = "none";
    }
  }

  const group = L.layerGroup([], { pane, interactive: false });
  // Один SVG-рендерер на всю сетку: создавать его на линию — лишняя работа.
  const renderer = L.svg({ pane, padding: 0 });
  group.addTo(map);

  let activeKey = "";

  function update() {
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const step = stepFor(zoom);
    const key = `${zoom}|${step}|${Math.round(bounds.getSouth() / step)}|${Math.round(bounds.getWest() / step)}`;
    if (key === activeKey) return;
    activeKey = key;

    const west = Math.floor(bounds.getWest() / step) * step;
    const east = Math.ceil(bounds.getEast() / step) * step;
    const south = Math.floor(bounds.getSouth() / step) * step;
    const north = Math.ceil(bounds.getNorth() / step) * step;
    if (east - west > 360 || north - south > 180) {
      group.clearLayers();
      return;
    }

    const lines = [];
    for (let lng = west; lng <= east + 1e-9; lng += step) {
      lines.push([
        [Math.max(-85, south), Number(lng.toFixed(4))],
        [Math.min(85, north), Number(lng.toFixed(4))],
      ]);
    }
    for (let lat = south; lat <= north + 1e-9; lat += step) {
      if (Math.abs(lat) > 85) continue;
      lines.push([
        [Number(lat.toFixed(4)), west],
        [Number(lat.toFixed(4)), east],
      ]);
    }

    group.clearLayers();
    for (const line of lines) {
      L.polyline(line, {
        pane,
        interactive: false,
        weight: 1,
        color: "#16834a",
        opacity: zoom >= 7 ? 0.14 : 0.1,
        lineCap: "butt",
        renderer,
      }).addTo(group);
    }
  }

  const onMove = () => update();
  map.on("moveend zoomend viewreset resize", onMove);
  update();

  return {
    layer: group,
    update,
    destroy() {
      map.off("moveend zoomend viewreset resize", onMove);
      map.removeLayer(group);
    },
  };
}
