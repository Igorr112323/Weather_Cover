/**
 * Экран результата прогноза.
 *
 * Два режима:
 *   • «расчёт» — снимок из состояния приложения, есть кнопка «Сохранить отчёт»;
 *   • «архив» — сохранённый отчёт (#/report/:id): движок не вызывается,
 *     результат берётся из снимка в базе и не зависит от того, живы ли
 *     исходный набор данных и сорт.
 */

import { h } from "../../lib/dom.js";
import { fmtCoord, fmtDateRu, fmtDateTimeRu, fmtInt, fmtNum, fmtPeriodRu, fmtRangeMonths, NOT_AVAILABLE } from "../../lib/format.js";
import { createButton, createSegmented } from "../../components/button.js";
import { createBadge, createNote, createPanel } from "../../components/panel.js";
import { createDataTable } from "../../components/data-table.js";
import { createEmptyState } from "../../components/empty-state.js";
import { createForecastCharts } from "./charts.js";
import { createIndicatorsPanel } from "./indicators.js";
import { isReportSaved, saveReport } from "../../services/forecast-service.js";
import { getReport } from "../../services/repositories.js";
import { toast } from "../../components/toast.js";

/** Отрицательные числа с настоящим минусом, а не дефисом. */
function tempText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NOT_AVAILABLE;
  const text = fmtNum(Math.abs(numeric), 1);
  return numeric < 0 ? `−${text}` : text;
}

function numberText(value, digits) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NOT_AVAILABLE;
  return fmtNum(numeric, digits);
}

const TABLE_COLUMNS = [
  { key: "date", title: "Дата", type: "date" },
  { key: "temperatureMean", title: "Средняя температура, °C", type: "number", align: "right", render: (row) => tempText(row.temperatureMean) },
  { key: "temperatureMin", title: "Минимальная температура, °C", type: "number", align: "right", render: (row) => tempText(row.temperatureMin) },
  { key: "temperatureMax", title: "Максимальная температура, °C", type: "number", align: "right", render: (row) => tempText(row.temperatureMax) },
  { key: "precipitationMm", title: "Осадки, мм", type: "number", align: "right", render: (row) => numberText(row.precipitationMm, 1) },
  { key: "relativeHumidityPct", title: "Влажность, %", type: "number", align: "right", render: (row) => numberText(row.relativeHumidityPct, 0) },
];

export function createResultsPage(context = {}) {
  const { navigate, state: appState } = context;
  const charts = createForecastCharts();

  let current = null;
  let view = "charts";
  let dynamicsPanel = null;

  const node = h("div", { class: "page results-page" });

  /* ── Сборка ───────────────────────────────────────────────────────────── */

  function render(target) {
    current = target;
    node.replaceChildren();
    charts.destroy();

    if (!target?.result) {
      node.append(
        h("div", { class: "page-head" }, [h("h1", { class: "page-title", text: "Результаты прогноза" })]),
        createEmptyState({
          iconName: "clipboard-list",
          title: "Результат не сформирован",
          text: "Выберите точку на карте и запустите прогноз либо откройте отчёт из архива.",
          action: createButton({ label: "К карте", tone: "primary", onClick: () => navigate?.("/map") }),
        }),
      );
      return;
    }

    const { result, mode, report, variety } = target;
    const request = result.request ?? {};
    const isArchive = mode === "report";

    node.append(
      h("div", { class: "page-head" }, [
        h("h1", { class: "page-title", text: isArchive ? "Отчёт из архива" : "Результаты прогноза" }),
        h("div", { class: "page-head__actions" }, isArchive
          ? [createButton({ label: "К архиву", tone: "secondary", icon: "arrow-left", onClick: () => navigate?.("/reports") })]
          : [
              createButton({ label: "К карте", tone: "secondary", icon: "arrow-left", onClick: () => navigate?.("/map") }),
              createSaveButton(result, variety, target.datasetId),
            ]),
      ]),
    );

    node.append(
      h("div", { style: "display:flex;flex-direction:column;gap:8px" }, [
        h("div", { class: "meta-row" }, [
          h("span", { class: "strong", text: variety?.name ?? request.varietyName ?? NOT_AVAILABLE }),
          h("span", { class: "meta-row__dot", text: "·" }),
          h("span", { class: "num", text: fmtCoord(request.lat, request.lon, 5) }),
          h("span", { class: "meta-row__dot", text: "·" }),
          h("span", { class: "num", text: fmtPeriodRu(result.period?.startDate, result.period?.endDate) }),
          h("span", { class: "meta-row__dot", text: "·" }),
          h("span", { text: fmtRangeMonths(request.rangeMonths) }),
        ]),
        h("div", { class: "meta-row" }, [
          createBadge("Демонстрационные данные", { tone: "warning", iconName: "flask-conical" }),
          h("span", { class: "secondary", text: "Не использовать для агрономических решений." }),
        ]),
        isArchive && report
          ? h("p", { class: "muted", text: `Снимок из архива, сохранён ${fmtDateTimeRu(report.createdAt)}. Движок не вызывался.` })
          : null,
      ].filter(Boolean)),
    );

    dynamicsPanel = createDynamicsPanel(result);

    node.append(
      h("div", { class: "results-wrap" }, [
        h("div", { class: "results-grid" }, [
          h("div", { class: "results-grid__main" }, [createIndicatorsPanel(result.indicators), dynamicsPanel]),
          h("aside", { class: "results-grid__side" }, [createRisksPanel(result), createProvenancePanel(result, report)]),
        ]),
      ]),
    );
  }

  /* ── Сохранение отчёта ────────────────────────────────────────────────── */

  function createSaveButton(result, variety, datasetId) {
    const alreadySaved = isReportSaved(context.db, result);
    const button = createButton({
      label: alreadySaved ? "Сохранено" : "Сохранить отчёт",
      tone: alreadySaved ? "secondary" : "primary",
      icon: alreadySaved ? "check" : "save",
      disabled: alreadySaved,
      onClick: async (_event, self) => {
        self.setLoading(true, "Сохраняем…");
        try {
          const outcome = await saveReport({ db: context.db, result, variety: variety ?? null, datasetId: datasetId ?? null });
          self.setLoading(false, "Сохранено");
          self.classList.remove("btn--primary");
          self.classList.add("btn--secondary");
          self.setDisabled(true);
          toast.success(outcome.created ? "Отчёт сохранён" : "Такой отчёт уже был сохранён");
          appState?.set({ reportsDirty: (appState.state.reportsDirty ?? 0) + 1 });
        } catch (error) {
          console.error("Сохранение отчёта не удалось", error);
          self.setLoading(false, "Сохранить отчёт");
          toast.error(error?.message ?? "Не удалось сохранить отчёт");
        }
      },
    });
    return button;
  }

  /* ── Динамика: графики или таблица ────────────────────────────────────── */

  function createDynamicsPanel(result) {
    const chartsHost = h("div", { style: "display:flex;flex-direction:column;gap:16px" });
    const bodyHost = h("div", { class: "panel__body" });

    const tabs = createSegmented({
      label: "Формат отображения",
      size: "sm",
      value: view,
      options: [
        { value: "charts", label: "Графики", iconName: "chart-line" },
        { value: "table", label: "Таблица", iconName: "table-2" },
      ],
      onChange: (value) => {
        view = value;
        paint();
      },
    });

    const panel = createPanel({
      title: "Динамика по дням",
      subtitle: `${fmtInt(result.series?.length ?? 0)} суточных записей · ${fmtDateRu(result.period?.startDate)} — ${fmtDateRu(result.period?.endDate)}`,
      actions: tabs,
      body: bodyHost,
    });

    function paintCharts() {
      chartsHost.replaceChildren(chartBlock("Температура, °C", "temperature"), chartBlock("Осадки, мм", "precipitation"));
      bodyHost.replaceChildren(chartsHost);
      charts.render(
        chartsHost.querySelector("[data-chart='temperature'] canvas"),
        chartsHost.querySelector("[data-chart='precipitation'] canvas"),
        result.series ?? [],
      );
    }

    function paintTable() {
      charts.destroy();
      bodyHost.replaceChildren(
        createDataTable({
          columns: TABLE_COLUMNS,
          rows: result.series ?? [],
          pageSize: 50,
          sort: { key: "date", dir: "asc" },
          onSortChange: () => {},
          ariaLabel: "Дневные значения прогноза",
          minWidth: "720px",
          panel: false,
        }),
      );
    }

    function paint() {
      if (view === "charts") paintCharts();
      else paintTable();
    }

    panel.paint = paint;
    paint();
    return panel;
  }

  function chartBlock(title, key) {
    return h("div", { dataset: { chart: key } }, [
      h("h3", { class: "block-title", text: title, style: "margin-bottom:12px" }),
      h("div", { class: "chart-box" }, [h("canvas", { role: "img", "aria-label": `График: ${title}` })]),
    ]);
  }

  /* ── Боковая колонка ──────────────────────────────────────────────────── */

  function createRisksPanel(result) {
    const notCalculated = result.risksStatus === "notCalculated" || !Array.isArray(result.risks);
    const body = notCalculated
      ? h("div", { style: "display:flex;flex-direction:column;gap:8px" }, [
          h("p", { class: "block-title", text: "Риски не рассчитаны" }),
          h("p", { class: "muted", text: "Демонстрационный движок не вычисляет риски. Это не утверждение, что рисков нет." }),
        ])
      : result.risks.length === 0
        ? h("p", { class: "muted", text: "Список рисков пуст." })
        : h("ul", { style: "margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px" }, result.risks.map((risk) => h("li", { text: describeRisk(risk) })));

    return createPanel({
      title: "Риски",
      actions: createBadge(notCalculated ? "Не рассчитано" : "Рассчитано", {
        tone: notCalculated ? "neutral" : "default",
        iconName: notCalculated ? "circle-help" : "shield-alert",
      }),
      body,
    });
  }

  function describeRisk(risk) {
    if (typeof risk === "string") return risk;
    return [risk?.title, risk?.level && `уровень: ${risk.level}`, risk?.window && `период: ${risk.window}`].filter(Boolean).join(" · ");
  }

  function createProvenancePanel(result, report) {
    const provenance = result.provenance ?? {};
    const rows = [
      ["Источник", provenance.source === "synthetic" ? "Синтетические данные (демонстрация)" : (provenance.source ?? NOT_AVAILABLE)],
      ["Движок", result.engineVersion ?? NOT_AVAILABLE],
      ["Сформировано", provenance.generatedAt ? fmtDateTimeRu(provenance.generatedAt) : NOT_AVAILABLE],
      ["Записей в ряду", fmtInt(result.series?.length ?? 0)],
    ];
    if (report) {
      rows.push(["Название отчёта", report.name ?? NOT_AVAILABLE]);
      rows.push(["Сохранён", fmtDateTimeRu(report.createdAt)]);
    }

    const dl = h("dl", { class: "kv" });
    for (const [label, value] of rows) dl.append(h("dt", { text: label }), h("dd", { class: "num", text: String(value) }));

    const panel = createPanel({ title: "О результате", body: dl });
    if (result.mode === "demo") {
      panel.querySelector(".panel__body").append(
        h("div", { style: "margin-top:12px" }, [createNote("Показатели посчитаны по демонстрационному ряду и не описывают реальную погоду.", { tone: "info" })]),
      );
    }
    return panel;
  }

  /* ── Жизненный цикл ───────────────────────────────────────────────────── */

  return {
    node,
    show({ params } = {}) {
      const appForecast = appState?.state.forecast ?? {};
      if (params?.id) {
        const report = getReport(context.db.handle, params.id);
        if (!report?.result) {
          render(null);
          toast.error("Отчёт не найден в архиве");
          return;
        }
        render({ mode: "report", result: report.result, report, variety: report.variety ?? null, datasetId: report.datasetId });
        return;
      }
      if (appForecast.result) {
        const result = appForecast.result;
        const variety = (appState?.state.varieties ?? []).find((item) => item.id === result.request?.varietyId) ?? null;
        render({ mode: "preview", result, variety, datasetId: appForecast.datasetId ?? null, report: null });
        return;
      }
      render(null);
    },
    hide() {
      charts.destroy();
    },
    destroy() {
      charts.destroy();
    },
    setError(error) {
      node.replaceChildren(
        h("div", { class: "page-head" }, [h("h1", { class: "page-title", text: "Результаты прогноза" })]),
        createNote(error?.message ?? "Не удалось показать результат", { tone: "danger" }),
      );
    },
  };
}
