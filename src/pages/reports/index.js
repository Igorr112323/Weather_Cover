/**
 * Вкладка «Отчёты»: архив сохранённых результатов.
 *
 * Отчёт хранит собственный снимок результата и сорта: открытие из архива
 * не вызывает движок и не зависит от того, удалены ли набор данных или сорт.
 * Фильтры живут в состоянии приложения — возврат из просмотренного отчёта
 * сохраняет прежний вид архива.
 */

import { h } from "../../lib/dom.js";
import { fmtCoord, fmtDateTimeRu, fmtPeriodRu, fmtRangeMonths, withCount } from "../../lib/format.js";
import { createButton, createSegmented } from "../../components/button.js";
import { createBadge } from "../../components/panel.js";
import { createSearchField, createSelectField } from "../../components/field.js";
import { createDataTable } from "../../components/data-table.js";
import { createEmptyState, createNoResultsState } from "../../components/empty-state.js";
import { confirmDialog } from "../../components/modal.js";
import { toast } from "../../components/toast.js";
import { clearReports, deleteReport, listReports } from "../../services/repositories.js";

export function createReportsPage(context = {}) {
  const { db, navigate, state: appState } = context;
  const node = h("div", { class: "page" });
  const filters = appState?.state.filters?.reports ?? { query: "", varietyId: "all", order: "desc" };
  let body = null;
  let table = null;

  function render() {
    const search = createSearchField({
      label: "Поиск по отчётам",
      value: filters.query,
      placeholder: "Поиск по названию или сорту",
      onInput: (value) => {
        filters.query = value;
        refresh();
      },
    });

    const varieties = appState?.state.varieties ?? [];
    const varietySelect = createSelectField({
      label: "Сорт",
      value: filters.varietyId,
      options: [
        { value: "all", label: "Любой сорт" },
        ...varieties.map((variety) => ({ value: variety.id, label: variety.name })),
      ],
    });
    const varietyWrap = h("div", { class: "field", style: "min-width:190px" }, [varietySelect.querySelector(".control")]);
    varietySelect.select.setAttribute("aria-label", "Фильтр по сорту");
    varietySelect.select.addEventListener("change", () => {
      filters.varietyId = varietySelect.getValue() || "all";
      refresh();
    });

    const orderControl = createSegmented({
      label: "Порядок сортировки",
      size: "sm",
      value: filters.order,
      options: [
        { value: "desc", label: "Новые сначала" },
        { value: "asc", label: "Старые сначала" },
      ],
      onChange: (value) => {
        filters.order = value;
        refresh();
      },
    });

    const clearButton = createButton({ label: "Очистить", tone: "ghost", icon: "trash-2", onClick: () => clearAll() });

    const toolbar = h("div", { class: "toolbar" }, [search, varietyWrap, orderControl, h("div", { class: "toolbar__spacer" }, [clearButton])]);

    table = createDataTable({
      columns: [
        {
          key: "name",
          title: "Отчёт",
          type: "text",
          cellClass: "cell-strong",
          render: (row) =>
            h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" }, [
              h("span", { text: row.name }),
              row.mode === "demo" ? createBadge("Демонстрационные", { tone: "warning" }) : null,
            ].filter(Boolean)),
        },
        { key: "variety", title: "Сорт", type: "text", sortValue: (row) => row.variety?.name ?? "", render: (row) => row.variety?.name ?? "Сорт удалён" },
        { key: "coords", title: "Координаты", type: "text", sortable: false, render: (row) => fmtCoord(row.lat, row.lon, 5) },
        {
          key: "start",
          title: "Период",
          type: "date",
          sortValue: (row) => row.startDate,
          render: (row) => h("span", { class: "num", text: `${fmtPeriodRu(row.startDate, row.endDate)} · ${fmtRangeMonths(row.rangeMonths)}` }),
        },
        { key: "created", title: "Создан", type: "date", sortValue: (row) => row.createdAt, render: (row) => h("span", { class: "num", text: fmtDateTimeRu(row.createdAt) }) },
      ],
      rows: [],
      pageSize: 50,
      sort: { key: "created", dir: filters.order === "asc" ? "asc" : "desc" },
      panel: false,
      ariaLabel: "Сохранённые отчёты",
      minWidth: "880px",
      onSortChange: () => {},
      onRowClick: (row) => navigate?.(`/report/${row.id}`),
      rowActions: (row) => [
        { icon: "eye", label: "Открыть отчёт", onClick: () => navigate?.(`/report/${row.id}`) },
        { icon: "trash-2", label: "Удалить отчёт", tone: "danger", onClick: () => removeOne(row) },
      ],
    });

    body = h("div", { class: "panel" }, [table]);

    node.replaceChildren(
      h("div", { class: "page-head" }, [
        h("div", {}, [
          h("h1", { class: "page-title", text: "Отчёты" }),
          h("p", { class: "muted", text: "Сохранённые снимки прогнозов. Открываются без повторного расчёта." }),
        ]),
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
        rows = listReports(db.handle, { query: filters.query, varietyId: filters.varietyId, order: filters.order });
        total = db.handle.count("reports");
      } catch (error) {
        console.error("Не удалось прочитать архив", error);
        body.replaceChildren(
          createEmptyState({ iconName: "cloud-off", title: "Не удалось прочитать архив", text: error?.message ?? "Ошибка базы данных" }),
        );
        return;
      }
      if (total === 0) {
        body.replaceChildren(
          createEmptyState({
            iconName: "file-text",
            title: "Нет сохранённых отчётов",
            text: "Сохраните результат прогноза кнопкой «Сохранить отчёт» — он появится здесь.",
            action: createButton({ label: "К карте", tone: "primary", onClick: () => navigate?.("/map") }),
          }),
        );
        clearButton.setDisabled(true);
        return;
      }
      if (rows.length === 0) {
        body.replaceChildren(
          createNoResultsState({
            query: filters.query,
            onClear: () => {
              filters.query = "";
              filters.varietyId = "all";
              render();
            },
          }),
        );
        return;
      }
      if (!table.isConnected) body.replaceChildren(table);
      table.setRows(rows, { keepPage: true });
      clearButton.setDisabled(false);
    }

    async function clearAll() {
      let count = 0;
      try {
        count = db.handle.count("reports");
      } catch {
        toast.error("Не удалось определить количество отчётов");
        return;
      }
      if (count === 0) {
        toast.info("Архив пуст");
        return;
      }
      const confirmed = await confirmDialog({
        title: "Очистить архив",
        message: `Будет удалено ${withCount(count, ["отчёт", "отчёта", "отчётов"])}.`,
        detail: "Наборы данных останутся в разделе «Данные».",
        confirmLabel: "Удалить всё",
      });
      if (!confirmed) return;
      try {
        const removed = await db.commit((handle) => clearReports(handle));
        toast.success(`Удалено ${withCount(removed, ["отчёт", "отчёта", "отчётов"])}`);
        refresh();
      } catch (error) {
        console.error("Очистка архива не удалась", error);
        toast.error(error?.message ?? "Не удалось очистить архив");
      }
    }

    async function removeOne(row) {
      const confirmed = await confirmDialog({
        title: "Удалить отчёт",
        message: `Отчёт «${row.name}» будет удалён.`,
        detail: "Связанный набор данных останется в разделе «Данные».",
        confirmLabel: "Удалить отчёт",
      });
      if (!confirmed) return;
      try {
        await db.commit((handle) => deleteReport(handle, row.id));
        toast.success("Отчёт удалён");
        refresh();
      } catch (error) {
        console.error("Удаление отчёта не удалось", error);
        toast.error(error?.message ?? "Не удалось удалить отчёт");
      }
    }
  }

  return {
    node,
    show() {
      render();
    },
    hide() {
      table = null;
    },
    destroy() {},
  };
}
