/** Состояния экрана: загрузка, пусто, ничего не найдено, ошибка. */

import { h, icon } from "../lib/dom.js";
import { createButton } from "./button.js";
import { spinner } from "./button.js";

export function createEmptyState({ title, text = null, iconName = "inbox", action = null, compact = false }) {
  return h("div", { class: "empty", style: compact ? "padding:24px 16px" : null }, [
    h("div", { class: "empty__icon" }, [icon(iconName, { size: 20 })]),
    h("p", { class: "empty__title", text: title }),
    text ? h("p", { class: "empty__text", text }) : null,
    action ? h("div", { style: "margin-top:8px" }, [action]) : null,
  ].filter(Boolean));
}

/** Нет ни одной записи — есть смысл предложить действие. */
export function createFirstRunState({ title, text, actionLabel, onAction, iconName = "inbox" }) {
  return createEmptyState({
    iconName,
    title,
    text,
    action: actionLabel ? createButton({ label: actionLabel, tone: "primary", onClick: onAction }) : null,
  });
}

/** Поиск не дал результата — это не пустая база, действие другое. */
export function createNoResultsState({ query = "", onClear = null, label = "Ничего не найдено" } = {}) {
  const children = [
    h("div", { class: "empty__icon" }, [icon("search-x", { size: 20 })]),
    h("p", { class: "empty__title", text: label }),
    h("p", {
      class: "empty__text",
      text: query ? `По запросу «${query}» записей нет. Измените запрос или сбросьте фильтры.` : "Под текущие фильтры записей нет.",
    }),
  ];
  if (onClear) {
    children.push(h("div", { style: "margin-top:8px" }, [createButton({ label: "Сбросить фильтры", tone: "secondary", onClick: onClear })]));
  }
  return h("div", { class: "empty" }, children);
}

/** Ошибка: что случилось и что делать. Технические подробности — в консоли. */
export function createErrorState({ title = "Не удалось выполнить действие", text = "", onRetry = null, retryLabel = "Повторить", details = null }) {
  const children = [
    h("div", { class: "empty__icon", style: "background:var(--danger-bg);color:var(--danger)" }, [icon("cloud-off", { size: 20 })]),
    h("p", { class: "empty__title", text: title }),
    text ? h("p", { class: "empty__text", text }) : null,
    details ? h("p", { class: "empty__text", style: "font-size:11px;color:var(--text-muted)", text: details }) : null,
    onRetry ? h("div", { style: "margin-top:8px" }, [createButton({ label: retryLabel, tone: "secondary", icon: "rotate-ccw", onClick: onRetry })]) : null,
  ];
  return h("div", { class: "empty" }, children.filter(Boolean));
}

/** Загрузка: индикатор без фиктивных процентов. */
export function createLoadingState({ label = "Загрузка", indeterminate = true } = {}) {
  return h("div", { class: "empty", role: "status", "aria-live": "polite" }, [
    indeterminate ? spinner(20) : null,
    h("p", { class: "empty__title", text: label }),
  ].filter(Boolean));
}

export function createProgressBar({ label = "Выполняется операция" } = {}) {
  return h("div", { class: "note note--info", role: "status", "aria-live": "polite" }, [
    h("div", { style: "display:flex;flex-direction:column;gap:8px;width:100%" }, [
      h("span", { text: label }),
      h("div", { class: "progress-line", "aria-hidden": "true" }),
    ]),
  ]);
}
