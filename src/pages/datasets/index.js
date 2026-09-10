/**
 * Вкладка «Данные»: сохранённые наборы, которые сформировал демонстрационный
 * движок. Это не скачанные наблюдения — так же они названы в таблице.
 *
 * Каждый успешно завершённый прогноз даёт один набор с устойчивым
 * идентификатором: повторный показ результата новый набор не создаёт.
 */

import { h } from "../../lib/dom.js";
import {
  fmtCoord,
  fmtDateTimeRu,
  fmtInt,
  fmtNum,
  fmtPeriodRu,
  fmtRangeMonths,
  withCount,
  NOT_AVAILABLE,
} from "../../lib/format.js";
import { createButton } from "../../components/button.js";
import { createSelectField } from "../../components/field.js";
import { createSearchField } from "../../components/field.js";
import { createBadge, createKeyValue, createPanel } from "../../components/panel.js";
import { createDataTable } from "../../components/data-table.js";
import { createEmptyState, createNoResultsState } from "../../components/empty-state.js";
import { confirmDialog } from "../../components/modal.js";
import { toast } from "../../components/toast.js";
import { clearDatasets, deleteDataset, getDataset, listDatasetRows, listDatasets } from "../../services/repositories.js";
import { datasetCsv, saveTextFile } from "../../services/export-service.js";

const DAY_COLUMNS = [
  { key: "date", title: "Дата", type: "date" },
  { key: "temperatureMean", title: "Средняя температура, °C", type: "number", align: "right", render: (row) => temp(row.temperatureMean) },
  { key: "temperatureMin", title: "Минимальная температура, °C", type: "number", align: "right", render: (row) => temp(row.temperatureMin) },
  { key: "temperatureMax", title: "Максимальная температура, °C", type: "number", align: "right", render: (row) => temp(row.temperatureMax) },
  { key: "precipitationMm", title: "Осадки, мм", type: "number", align: "right", render: (row) => fmtNum(row.precipitationMm, 1) },
  { key: "relativeHumidityPct", title: "Влажность, %", type: "number", align: "right", render: (row) => fmtNum(row.relativeHumidityPct, 0) },
];

function temp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NOT_AVAILABLE;
  const text = fmtNum(Math.abs(numeric), 1);
  return numeric < 0 ? `−${text}` : text;
}

export function createDatasetsPage(context = {}) {
  const { db, navigate, state: appState } = context;
  const node = h("div", { class: "page" });

  const filters = appState?.state.filters?.datasets ?? { query: "", rangeMonths: "all", sort: { key: "created", dir: "desc" } };
  let currentId = null;
  let listTable = null;
  let detailTable = null;

  /* ── Список ───────────────────────────────────────────────────────────── */

  function renderList() {
    currentId = null;

    const search = createSearchField({
      label: "Поиск по названию набора или сорту",
      value: filters.query,
      placeholder: "Поиск по сорту или периоду",
      onInput: (value) => {
        filters.query = value;
        refresh();
      },
    });

    const rangeSelect = createSelectField({
      label: "Период",
      value: filters.rangeMonths,
      options: [
        { value: "all", label: "Любой период" },
        { value: 1, label: "1 мес." },
        { value: 3, label: "3 мес." },
        { value: 6, label: "6 мес." },
      ],
    });
    const rangeWrap = h("div", { class: "field", style: "min-width:170px" }, [rangeSelect.querySelector(".control")]);
    rangeSelect.select.setAttribute("aria-label", "Фильтр по периоду");
    rangeSelect.select.addEventListener("change", () => {
      filters.rangeMonths = rangeSelect.getValue() === "all" ? "all" : Number(rangeSelect.getValue());
      refresh();
    });

    const clearButton = createButton({
      label: "Очистить",
      tone: "ghost",
      icon: "trash-2",
      onClick: () => clearAll(),
    });

    const toolbar = h("div", { class: "toolbar" }, [search, rangeWrap, h("div", { class: "toolbar__spacer" }, [clearButton])]);

    listTable = createDataTable({
      columns: [
        {
          key: "label",
          title: "Набор",
          type: "text",
          cellClass: "cell-strong",
          render: (row) =>
            h("div", { style: "display:flex;flex-direction:column;gap:2px" }, [
              h("span", { text: row.label }),
              row.mode === "demo" ? createBadge("Демонстрационные", { tone: "warning", iconName: "flask-conical" }) : null,
            ].filter(Boolean)),
        },
        { key: "coords", title: "Координаты", type: "text", sortable: false, render: (row) => fmtCoord(row.lat, row.lon, 5) },
        {
          key: "start",
          title: "Период",
          type: "date",
          sortValue: (row) => row.startDate,
          render: (row) => h("span", { class: "num", text: `${fmtPeriodRu(row.startDate, row.endDate)} · ${fmtRangeMonths(row.rangeMonths)}` }),
        },
        { key: "source", title: "Источник", type: "text" },
        { key: "rowCount", title: "Записей", type: "number", align: "right", render: (row) => fmtInt(row.rowCount) },
        { key: "created", title: "Создан", type: "date", sortValue: (row) => row.createdAt, render: (row) => h("span", { class: "num", text: fmtDateTimeRu(row.createdAt) }) },
      ],
      rows: [],
      pageSize: 50,
      sort: filters.sort,
      panel: false,
      ariaLabel: "Сохранённые наборы данных",
      minWidth: "940px",
      onSortChange: (sort) => {
        filters.sort = sort;
        refresh();
      },
      onRowClick: (row) => navigate?.(`/datasets/${row.id}`),
      rowActions: (row) => [
        {
          icon: "eye",
          label: "Открыть набор",
          onClick: () => navigate?.(`/datasets/${row.id}`),
        },
        {
          icon: "trash-2",
          label: "Удалить набор",
          tone: "danger",
          onClick: () => removeOne(row),
        },
      ],
    });

    const body = h("div", { class: "panel" }, [listTable]);
    node.replaceChildren(
      h("div", { class: "page-head" }, [
        h("div", {}, [h("h1", { class: "page-title", text: "Данные" }), h("p", { class: "muted", text: "Наборы, сформированные демонстрационным движком." })]),
        h("div", { class: "page-head__actions" }, [createButton({ label: "К карте", tone: "secondary", icon: "map", onClick: () => navigate?.("/map") })]),
      ]),
      toolbar,
      body,
    );

    refresh();

    function refresh() {
      if (!db) return;
      let rows = [];
      let total = 0;
      try {
        rows = listDatasets(db.handle, { query: filters.query, rangeMonths: filters.rangeMonths, sort: filters.sort });
        total = db.handle.count("datasets");
      } catch (error) {
        console.error("Не удалось прочитать наборы данных", error);
        body.replaceChildren(
          createEmptyState({ iconName: "cloud-off", title: "Не удалось прочитать данные", text: error?.message ?? "Ошибка базы данных" }),
        );
        return;
      }
      const filtered = rows.length === 0 && (filters.query || filters.rangeMonths !== "all");
      if (total === 0) {
        body.replaceChildren(
          createEmptyState({
            iconName: "database",
            title: "Нет сохранённых наборов",
            text: "Набор создаётся автоматически после успешного прогноза.",
            action: createButton({ label: "К карте", tone: "primary", onClick: () => navigate?.("/map") }),
          }),
        );
        return;
      }
      if (filtered) {
        body.replaceChildren(
          createNoResultsState({
            query: filters.query,
            onClear: () => {
              filters.query = "";
              filters.rangeMonths = "all";
              renderList();
            },
          }),
        );
        return;
      }
      if (!listTable.isConnected) body.replaceChildren(listTable);
      listTable.setRows(rows, { keepPage: true });
      clearButton.setDisabled(rows.length === 0);
    }

    async function clearAll() {
      let count = 0;
      try {
        count = db.handle.count("datasets");
      } catch (error) {
        toast.error("Не удалось определить количество наборов");
        return;
      }
      if (count === 0) {
        toast.info("Сохранённых наборов нет");
        return;
      }
      const confirmed = await confirmDialog({
        title: "Очистить данные",
        message: `Будет удалено ${withCount(count, ["набор", "набора", "наборов"])} данных.`,
        detail: "Сохранённые отчёты останутся: они хранят собственный снимок результата.",
        confirmLabel: "Удалить всё",
      });
      if (!confirmed) return;
      try {
        const removed = await db.commit((handle) => clearDatasets(handle));
        toast.success(`Удалено ${withCount(removed, ["набор", "набора", "наборов"])}`);
        refresh();
      } catch (error) {
        console.error("Очистка не удалась", error);
        toast.error(error?.message ?? "Не удалось удалить наборы");
      }
    }

    async function removeOne(row) {
      const confirmed = await confirmDialog({
        title: "Удалить набор",
        message: `Набор «${row.label}» будет удалён вместе с суточными значениями.`,
        detail: "Сохранённые отчёты не изменятся.",
        confirmLabel: "Удалить набор",
      });
      if (!confirmed) return;
      try {
        await db.commit((handle) => deleteDataset(handle, row.id));
        toast.success("Набор удалён");
        refresh();
      } catch (error) {
        console.error("Удаление не удалось", error);
        toast.error(error?.message ?? "Не удалось удалить набор");
      }
    }
  }

  /* ── Подробности набора ───────────────────────────────────────────────── */

  function renderDetail(id) {
    currentId = id;
    let dataset = null;
    let rows = [];
    try {
      dataset = getDataset(db.handle, id);
      rows = listDatasetRows(db.handle, id, { sort: { key: "date", dir: "asc" } });
    } catch (error) {
      console.error("Не удалось прочитать набор", error);
    }

    if (!dataset) {
      node.replaceChildren(
        h("div", { class: "page-head" }, [h("h1", { class: "page-title", text: "Данные" })]),
        createEmptyState({
          iconName: "database",
          title: "Набор не найден",
          text: "Возможно, он был удалён. Вернитесь к списку данных.",
          action: createButton({ label: "Назад к данным", tone: "primary", icon: "arrow-left", onClick: () => navigate?.("/datasets") }),
        }),
      );
      return;
    }

    detailTable = createDataTable({
      columns: DAY_COLUMNS,
      rows,
      pageSize: 50,
      sort: { key: "date", dir: "asc" },
      onSortChange: () => {},
      panel: false,
      ariaLabel: "Суточные значения набора",
      minWidth: "760px",
    });

    const metaPanel = createPanel({
      title: "Параметры набора",
      actions: h("div", { class: "row" }, [
        createButton({
          label: "Экспорт CSV",
          tone: "secondary",
          icon: "download",
          onClick: async (event, self) => {
            self.setLoading(true, "Готовим файл…");
            try {
              const { content, fileName } = datasetCsv(dataset, rows);
              const result = await saveTextFile({ fileName, content });
              if (result.canceled) toast.info("Сохранение отменено");
              else if (result.saved) toast.success("Файл CSV сохранён");
            } catch (error) {
              console.error("Экспорт CSV не удался", error);
              toast.error(error?.message ?? "Не удалось сохранить файл");
            } finally {
              self.setLoading(false, "Экспорт CSV");
            }
          },
        }),
        createButton({
          label: "Удалить набор",
          tone: "danger-soft",
          icon: "trash-2",
          onClick: async (event, self) => {
            const confirmed = await confirmDialog({
              title: "Удалить набор",
              message: `Набор «${dataset.label}» будет удалён вместе с суточными значениями.`,
              detail: "Сохранённые отчёты не изменятся.",
              confirmLabel: "Удалить набор",
            });
            if (!confirmed) return;
            try {
              await db.commit((handle) => deleteDataset(handle, dataset.id));
              toast.success("Набор удалён");
              navigate?.("/datasets");
            } catch (error) {
              console.error("Удаление не удалось", error);
              toast.error(error?.message ?? "Не удалось удалить набор");
            }
          },
        }),
      ]),
      body: createKeyValue([
        ["Набор", dataset.label],
        ["Сорт", dataset.varietyName ?? NOT_AVAILABLE],
        ["Координаты", fmtCoord(dataset.lat, dataset.lon, 5)],
        ["Период", `${fmtPeriodRu(dataset.startDate, dataset.endDate)} · ${fmtRangeMonths(dataset.rangeMonths)}`],
        ["Источник", dataset.source],
        ["Движок", dataset.engineVersion ?? NOT_AVAILABLE],
        ["Записей", fmtInt(dataset.rowCount)],
        ["Средняя температура", `${fmtNum(dataset.indicators?.meanTemperatureC, 1)} °C`],
        ["Осадки за период", `${fmtNum(dataset.indicators?.totalPrecipitationMm, 1)} мм`],
        ["Создан", fmtDateTimeRu(dataset.createdAt)],
        ["Риски", dataset.risksStatus === "notCalculated" ? "Не рассчитаны" : NOT_AVAILABLE],
      ]),
    });

    node.replaceChildren(
      h("div", { class: "page-head" }, [
        h("div", {}, [h("h1", { class: "page-title", text: dataset.label })]),
        h("div", { class: "page-head__actions" }, [
          createButton({ label: "Назад к данным", tone: "secondary", icon: "arrow-left", onClick: () => navigate?.("/datasets") }),
        ]),
      ]),
      metaPanel,
      createPanel({
        title: "Дневные значения",
        subtitle: `Сортировка применяется ко всему набору, на странице показывается по 50 строк.`,
        body: h("div", { class: "panel__body panel__body--flush" }, [detailTable.wrap, detailTable.querySelector(".table-foot")]),
        flush: true,
      }),
    );
  }

  return {
    node,
    show({ params } = {}) {
      if (params?.id) renderDetail(params.id);
      else renderList();
    },
    hide() {
      detailTable = null;
      listTable = null;
    },
    destroy() {},
  };
}
