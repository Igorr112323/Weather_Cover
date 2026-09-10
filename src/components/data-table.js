/**
 * Таблица данных: сортировка по всему набору (а не по странице), постраничная
 * выдача, действия в строке, пустые состояния.
 *
 * Ячейки собираются только через DOM-узлы: строковые значения попадают в
 * textContent, разметка из пользовательских полей не интерпретируется.
 */

import { h, icon, setText } from "../lib/dom.js";
import { fmtInt, NOT_AVAILABLE } from "../lib/format.js";
import { createIconButton } from "./button.js";

const DEFAULT_PAGE_SIZE = 50;

/** Компаратор по типу колонки: числа не сравниваются как строки. */
function compareValues(a, b, type) {
  const aMissing = a === null || a === undefined || a === "" || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === null || b === undefined || b === "" || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1; // пустые значения всегда в конце, независимо от направления
  if (bMissing) return -1;

  if (type === "number" || type === "date-number") {
    return Number(a) - Number(b);
  }
  if (type === "date") {
    // ISO-даты сравниваются как строки корректно, но приводим к строке явно
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }
  return String(a).localeCompare(String(b), "ru", { numeric: true, sensitivity: "base" });
}

export function sortRows(rows, sort, columns) {
  if (!sort?.key) return rows;
  const column = columns.find((candidate) => candidate.key === sort.key);
  if (!column) return rows;
  const direction = sort.dir === "desc" ? -1 : 1;
  const extract = (row, index) => ({ row, index, value: column.sortValue ? column.sortValue(row) : row[column.key] });
  return rows
    .map(extract)
    .sort((left, right) => {
      const result = compareValues(left.value, right.value, column.type ?? "text");
      if (result !== 0) return result * direction;
      return left.index - right.index; // устойчивая сортировка
    })
    .map((entry) => entry.row);
}

/**
 * @param {{columns:Array, rows:Array, pageSize?:number, sort?:{key:string,dir:string},
 *          onSortChange?:(sort:object)=>void, rowActions?:(row)=>Array,
 *          onRowClick?:(row)=>void, rowKey?:(row)=>string, activeId?:string|null,
 *          ariaLabel:string, emptyNode?:Node, footNote?:string, stickyHeader?:boolean,
 *          minWidth?:string}} config
 */
export function createDataTable(config = {}) {
  const {
    columns = [],
    rows = [],
    pageSize = DEFAULT_PAGE_SIZE,
    sort = null,
    onSortChange,
    rowActions = null,
    onRowClick = null,
    rowKey = (row) => row?.id ?? null,
    activeId = null,
    ariaLabel = "Таблица данных",
    emptyNode = null,
    footNote = null,
    minWidth = null,
    panel = true,
  } = config;

  const state = {
    rows,
    sort: sort ? { ...sort } : null,
    page: 1,
    emptyNode,
    activeId,
  };

  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  const table = h("table", { class: "table", "aria-label": ariaLabel }, [head, body]);
  const wrap = h("div", { class: "table-wrap" }, [table]);
  if (minWidth) table.style.minWidth = minWidth;

  const foot = h("div", { class: "table-foot" });
  const node = h("div", { class: panel ? "panel" : "" }, [wrap, foot]);
  node.table = table;
  node.wrap = wrap;

  function renderHead() {
    const row = document.createElement("tr");
    for (const column of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      if (column.align === "right") th.classList.add("cell-num");
      if (column.width) th.style.width = column.width;

      if (column.sortable === false || !onSortChange) {
        setText(th, column.title);
      } else {
        const isCurrent = state.sort?.key === column.key;
        const dir = isCurrent ? state.sort.dir : "asc";
        if (isCurrent) th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
        const button = h("button", {
          type: "button",
          class: "th-sort",
          title: `Сортировать по «${column.title}»`,
        }, [
          h("span", { text: column.title }),
          icon(isCurrent ? (dir === "asc" ? "arrow-up" : "arrow-down") : "arrow-up-down", { size: 12 }),
        ]);
        button.addEventListener("click", () => {
          const next = isCurrent ? { key: column.key, dir: dir === "asc" ? "desc" : "asc" } : { key: column.key, dir: "asc" };
          state.sort = next;
          state.page = 1;
          onSortChange(next);
          render();
        });
        th.append(button);
      }
      row.append(th);
    }
    if (rowActions) {
      const th = document.createElement("th");
      th.scope = "col";
      th.classList.add("cell-actions");
      setText(th, "Действия");
      row.append(th);
    }
    head.replaceChildren(row);
  }

  function renderBody(pageRows) {
    if (state.rows.length === 0 && state.emptyNode) {
      body.replaceChildren(h("tr", {}, [h("td", { colspan: String(columns.length + (rowActions ? 1 : 0)) }, [state.emptyNode])]));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of pageRows) {
      const tr = document.createElement("tr");
      const id = rowKey(row);
      if (id) tr.dataset.id = String(id);
      if (state.activeId && id === String(state.activeId)) tr.classList.add("is-active");

      for (const column of columns) {
        const td = document.createElement("td");
        if (column.align === "right") td.classList.add("cell-num");
        if (column.cellClass) td.classList.add(column.cellClass);
        const content = column.render ? column.render(row) : row[column.key];
        if (content instanceof Node) td.append(content);
        else setText(td, content === null || content === undefined || content === "" ? NOT_AVAILABLE : String(content));
        tr.append(td);
      }

      if (rowActions) {
        const td = document.createElement("td");
        td.classList.add("cell-actions");
        const actions = rowActions(row) ?? [];
        for (const action of actions) {
          const button = createIconButton({
            icon: action.icon,
            label: action.label,
            tone: action.tone,
            disabled: action.disabled,
            onClick: (event) => {
              event.stopPropagation();
              action.onClick?.(row);
            },
          });
          if (action.title) button.setAttribute("title", action.title);
          td.append(button);
        }
        tr.append(td);
      }

      if (onRowClick) {
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => onRowClick(row));
        tr.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          // Фокус на кнопке действия: пусть срабатывает сама кнопка, а не строка.
          if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea")) return;
          event.preventDefault();
          onRowClick(row);
        });
      }
      frag.append(tr);
    }
    body.replaceChildren(frag);
  }

  function renderFoot(total) {
    const parts = [];
    if (footNote) parts.push(h("span", { text: footNote }));
    else parts.push(h("span", { text: `${fmtInt(total)} ${pluralRows(total)}` }));

    if (pageSize && total > pageSize) {
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (state.page > pages) state.page = pages;
      const pager = h("div", { class: "table-foot__pager" }, [
        createIconButton({
          icon: "chevron-left",
          label: "Предыдущая страница",
          disabled: state.page <= 1,
          onClick: () => {
            state.page -= 1;
            render({ scroll: true });
          },
        }),
        h("span", { class: "num", text: `Стр. ${state.page} из ${pages}` }),
        createIconButton({
          icon: "chevron-right",
          label: "Следующая страница",
          disabled: state.page >= pages,
          onClick: () => {
            state.page += 1;
            render({ scroll: true });
          },
        }),
      ]);
      parts.push(pager);
    } else {
      parts.push(h("span", { text: pageSize ? "Все строки на одной странице" : "" }));
    }

    foot.replaceChildren(...parts);
    foot.hidden = parts.length === 0;
  }

  function render({ scroll = false } = {}) {
    const sorted = state.sort ? sortRows(state.rows, state.sort, columns) : state.rows;
    const total = sorted.length;
    const pageRows =
      pageSize && total > pageSize
        ? sorted.slice((state.page - 1) * pageSize, (state.page - 1) * pageSize + pageSize)
        : sorted;
    renderHead();
    renderBody(pageRows);
    renderFoot(total);
    if (scroll) node.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  render();

  node.setRows = (nextRows, { keepPage = false } = {}) => {
    state.rows = Array.isArray(nextRows) ? nextRows : [];
    if (!keepPage) state.page = 1;
    render();
  };
  node.setSort = (nextSort) => {
    state.sort = nextSort ? { ...nextSort } : null;
    render();
  };
  node.setActiveId = (id) => {
    state.activeId = id;
    render();
  };
  node.setEmptyNode = (nodeOrText) => {
    state.emptyNode = nodeOrText instanceof Node ? nodeOrText : h("p", { class: "muted", text: String(nodeOrText ?? "") });
    render();
  };
  node.getSort = () => (state.sort ? { ...state.sort } : null);
  node.refresh = () => render();
  return node;
}

function pluralRows(count) {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return "записей";
  if (last === 1) return "запись";
  if (last >= 2 && last <= 4) return "записи";
  return "записей";
}

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
