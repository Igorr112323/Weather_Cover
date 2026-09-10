/** Всплывающие сообщения об исходе операций. */

import { h, icon } from "../lib/dom.js";

const TONE_ICON = {
  success: "check",
  danger: "circle-alert",
  warning: "triangle-alert",
  info: "info",
};

let container = null;
const timers = new WeakMap();

function ensureContainer() {
  if (container && container.isConnected) return container;
  container = h("div", {
    class: "toasts",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "false",
  });
  document.body.append(container);
  return container;
}

/**
 * @param {{message:string, tone?:'success'|'danger'|'warning'|'info',
 *          duration?:number, action?:{label:string, onClick:()=>void}}} options
 */
export function showToast({ message, tone = "info", duration = tone === "danger" ? 8000 : 4500, action = null } = {}) {
  const host = ensureContainer();
  const text = typeof message === "string" ? message : String(message ?? "");

  const button = h("button", {
    type: "button",
    class: "btn-icon",
    "aria-label": "Скрыть сообщение",
  }, [icon("x", { size: 14 })]);

  const toast = h("div", {
    class: ["toast", tone !== "info" ? `toast--${tone}` : "", tone === "danger" ? "is-alert" : ""]
      .filter(Boolean)
      .join(" "),
    role: tone === "danger" ? "alert" : null,
  }, [
    h("span", { class: "toast__icon" }, [icon(TONE_ICON[tone] ?? "info", { size: 16 })]),
    h("span", { class: "toast__msg", text }),
    action
      ? h("button", {
          type: "button",
          class: "btn btn--ghost btn--sm",
          text: action.label,
          onClick: () => {
            close();
            action.onClick?.();
          },
        })
      : null,
    button,
  ].filter(Boolean));

  function close() {
    const timer = timers.get(toast);
    if (timer) window.clearTimeout(timer);
    timers.delete(toast);
    toast.remove();
  }

  button.addEventListener("click", close);
  host.append(toast);
  if (duration > 0) timers.set(toast, window.setTimeout(close, duration));
  // Не более четырёх сообщений одновременно: старые уходят первыми.
  while (host.children.length > 4) host.firstElementChild?.remove();
  return close;
}

export const toast = {
  show: showToast,
  success: (message, options = {}) => showToast({ ...options, message, tone: "success" }),
  error: (message, options = {}) => showToast({ ...options, message, tone: "danger" }),
  warning: (message, options = {}) => showToast({ ...options, message, tone: "warning" }),
  info: (message, options = {}) => showToast({ ...options, message, tone: "info" }),
};
