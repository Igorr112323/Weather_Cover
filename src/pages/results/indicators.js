/** Панель показателей: одна белая панель с пятью ячейками, без выдуманных значений. */

import { h } from "../../lib/dom.js";
import { fmtNum, NOT_AVAILABLE } from "../../lib/format.js";

const MISSING_HINT = "Не рассчитано";

/**
 * @param {object|null} indicators
 * @param {{activeTemperatureSum:number|null, hydrothermalCoefficient:number|null}} options
 */
export function createIndicatorsPanel(indicators = {}) {
  const cells = [
    { label: "Средняя температура, °C", value: indicators?.meanTemperatureC, digits: 1 },
    { label: "Осадки, мм", value: indicators?.totalPrecipitationMm, digits: 1 },
    { label: "Сумма активных температур, °C·сут", value: indicators?.activeTemperatureSum, digits: 0 },
    { label: "ГТК", value: indicators?.hydrothermalCoefficient, digits: 2 },
    { label: "Влажность, %", value: indicators?.meanRelativeHumidityPct, digits: 0 },
  ];

  const panel = h("section", { class: "panel indicators", "aria-label": "Показатели за период" });

  for (const cell of cells) {
    const missing = typeof cell.value !== "number" || !Number.isFinite(cell.value);
    const valueText = missing ? NOT_AVAILABLE : fmtNum(cell.value, cell.digits);
    const valueNode = h("div", { class: "indicator__value" }, [h("span", { text: valueText })]);
    const labelNode = h("div", { class: "indicator__label" }, [h("span", { text: cell.label })]);

    panel.append(
      h("div", {
        class: ["indicator", missing ? "indicator--na" : ""].filter(Boolean).join(" "),
        title: missing ? `${cell.label}: ${MISSING_HINT}` : undefined,
      }, [
        labelNode,
        valueNode,
        missing ? h("span", { class: "muted", text: MISSING_HINT }) : null,
        missing ? h("span", { class: "sr-only", text: `${cell.label}: ${MISSING_HINT}` }) : null,
      ].filter(Boolean)),
    );
  }

  return panel;
}
