/**
 * Вкладка «Сорта кукурузы»: редактируемый справочник.
 *
 * Модель полей ограничена тем, что действительно хранится: название, тип,
 * оригинатор, ФАО, продолжительность вегетации, примечания. Выдуманных
 * агрономических характеристик здесь нет.
 */

import { h } from "../../lib/dom.js";
import { fmtDateTimeRu, fmtInt, NOT_AVAILABLE } from "../../lib/format.js";
import { typeLabel } from "../../services/validation.js";
import { createButton } from "../../components/button.js";
import { createSearchField } from "../../components/field.js";
import { createKeyValue, createPanel } from "../../components/panel.js";
import { createDataTable } from "../../components/data-table.js";
import { createEmptyState, createNoResultsState } from "../../components/empty-state.js";
import { confirmDialog } from "../../components/modal.js";
import { toast } from "../../components/toast.js";
import { deleteVariety, getVariety, listVarieties } from "../../services/repositories.js";
import { openVarietyForm } from "./form.js";

export function createVarietiesPage(context = {}) {
  const { db, state: appState, refreshVarieties } = context;
  const node = h("div", { class: "page" });
  const filters = appState?.state.filters?.varieties ?? { query: "", type: "all", sort: { key: "name", dir: "asc" } };
  let selectedId = null;
  let detailHost = null;
  let listHost = null;
  let table = null;
  let lastRows = [];

  function render() {
    const addButton = createButton({
      label: "Добавить сорт",
      tone: "primary",
      icon: "plus",
      onClick: () => openForm(null),
    });

    const search = createSearchField({
      label: "Поиск по сортам",
      value: filters.query,
      placeholder: "Поиск по названию или оригинатору",
      onInput: (value) => {
        filters.query = value;
        refresh();
      },
    });

    table = createDataTable({
      columns: [
        { key: "name", title: "Название", type: "text", cellClass: "cell-strong", sortable: true },
        { key: "type", title: "Тип", type: "text", render: (row) => typeLabel(row.type) },
        { key: "fao", title: "ФАО", type: "number", align: "right", render: (row) => (row.fao === null ? NOT_AVAILABLE : fmtInt(row.fao)) },
        {
          key: "vegetation",
          title: "Вегетация, дней",
          type: "number",
          align: "right",
          sortValue: (row) => row.vegetationDays,
          render: (row) => (row.vegetationDays === null ? NOT_AVAILABLE : fmtInt(row.vegetationDays)),
        },
        { key: "breeder", title: "Оригинатор", type: "text", render: (row) => row.breeder ?? NOT_AVAILABLE },
      ],
      rows: [],
      pageSize: 50,
      sort: filters.sort,
      panel: false,
      ariaLabel: "Сорта кукурузы",
      minWidth: "760px",
      onSortChange: (sort) => {
        filters.sort = sort;
        refresh();
      },
      onRowClick: (row) => select(row.id),
      rowActions: (row) => [
        { icon: "pencil", label: "Редактировать сорт", onClick: () => openForm(row) },
        { icon: "trash-2", label: "Удалить сорт", tone: "danger", onClick: () => removeVariety(row) },
      ],
    });

    listHost = h("div", { class: "panel" }, [table]);
    detailHost = h("div");

    node.replaceChildren(
      h("div", { class: "page-head" }, [h("h1", { class: "page-title", text: "Сорта кукурузы" }), h("div", { class: "page-head__actions" }, [addButton])]),
      h("div", { class: "toolbar" }, [search]),
      h("div", { class: "split" }, [listHost, detailHost]),
    );

    refresh();
  }

  function refresh() {
    if (!db) return;
    let rows = [];
    let total = 0;
    try {
      rows = listVarieties(db.handle, { query: filters.query, type: filters.type, sort: filters.sort });
      total = db.handle.count("varieties");
    } catch (error) {
      console.error("Не удалось прочитать справочник", error);
      listHost.replaceChildren(
        createEmptyState({ iconName: "cloud-off", title: "Не удалось прочитать справочник", text: error?.message ?? "Ошибка базы данных" }),
      );
      return;
    }

    if (total === 0) {
      listHost.replaceChildren(
        createEmptyState({
          iconName: "sprout",
          title: "Сорта не заведены",
          text: "Добавьте первый сорт или гибрид — он станет доступен при выборе параметров прогноза.",
          action: createButton({ label: "Добавить сорт", tone: "primary", icon: "plus", onClick: () => openForm(null) }),
        }),
      );
    } else if (rows.length === 0) {
      listHost.replaceChildren(
        createNoResultsState({
          query: filters.query,
          onClear: () => {
            filters.query = "";
            filters.type = "all";
            render();
          },
        }),
      );
    } else {
      if (!table.isConnected) listHost.replaceChildren(table);
      table.setRows(rows, { keepPage: true });
      table.setActiveId(selectedId);
    }

    lastRows = rows;
    renderDetail(rows);
  }

  function renderDetail(rows) {
    const variety = rows.find((item) => item.id === selectedId) ?? (selectedId ? safeGet(selectedId) : null);
    if (!variety) {
      detailHost.replaceChildren();
      detailHost.style.display = "none";
      return;
    }
    detailHost.style.display = "";
    detailHost.replaceChildren(
      createPanel({
        title: variety.name,
          body: [
          createKeyValue([
            ["Тип", typeLabel(variety.type)],
            ["ФАО", variety.fao === null ? NOT_AVAILABLE : fmtInt(variety.fao)],
            ["Вегетация, дней", variety.vegetationDays === null ? NOT_AVAILABLE : fmtInt(variety.vegetationDays)],
            ["Оригинатор", variety.breeder ?? NOT_AVAILABLE],
            ["Создан", fmtDateTimeRu(variety.createdAt)],
            ["Изменён", fmtDateTimeRu(variety.updatedAt)],
          ]),
          h("div", { style: "margin-top:16px" }, [
            h("h3", { class: "field__label", text: "Примечания", style: "margin-bottom:4px" }),
            h("p", {
              class: "secondary",
              text: variety.notes ?? NOT_AVAILABLE,
              style: "white-space:pre-line;overflow-wrap:anywhere;font-size:14px;line-height:20px",
            }),
          ]),
        ],
        footer: [
          createButton({ label: "Редактировать", tone: "secondary", icon: "pencil", onClick: () => openForm(variety) }),
          createButton({ label: "Удалить", tone: "danger-soft", icon: "trash-2", onClick: () => removeVariety(variety) }),
        ],
      }),
    );
  }

  function safeGet(id) {
    try {
      return getVariety(db.handle, id);
    } catch {
      return null;
    }
  }

  function select(id) {
    selectedId = id === selectedId ? null : id;
    table.setActiveId(selectedId);
    renderDetail(currentRows());
  }

  function currentRows() {
    return lastRows;
  }

  function openForm(variety) {
    openVarietyForm({
      context,
      variety,
      onSaved: (record) => {
        if (record?.id) selectedId = record.id;
        refresh();
      },
    });
  }

  async function removeVariety(variety) {
    const confirmed = await confirmDialog({
      title: "Удалить сорт",
      message: `Сорт «${variety.name}» будет удалён из справочника.`,
      detail: "Ранее сохранённые отчёты не изменятся: в них есть снимок сорта.",
      confirmLabel: "Удалить сорт",
    });
    if (!confirmed) return;
    try {
      await db.commit((handle) => deleteVariety(handle, variety.id));
      if (selectedId === variety.id) selectedId = null;
      await refreshVarieties?.();
      toast.success("Сорт удалён");
      refresh();
    } catch (error) {
      console.error("Удаление сорта не удалось", error);
      toast.error(error?.message ?? "Не удалось удалить сорт");
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
