/**
 * Плавающие слои: порядок обработки Escape и ловушки фокуса.
 *
 * Escape обрабатывает верхний слой: сначала модальное окно или календарь,
 * затем активный раздел (например, возврат вида карты). Раздел подписывается
 * через pushEscHandler и получает событие только если открытого слоя нет.
 */

const stack = [];
let listenerAttached = false;

function ensureListener() {
  if (listenerAttached) return;
  listenerAttached = true;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const handler = stack[i];
        if (!handler.node || !handler.node.isConnected) {
          stack.splice(i, 1);
          continue;
        }
        const consumed = handler.onEscape(event);
        if (consumed !== false) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    },
    true,
  );
}

/**
 * @param {{node?: Node, onEscape: (event: KeyboardEvent) => boolean|void}} layer
 * @returns {() => void} снять слой
 */
export function pushEscHandler(layer) {
  ensureListener();
  stack.push(layer);
  return () => {
    const index = stack.indexOf(layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function overlayCount() {
  return stack.length;
}

export function hasOpenOverlay() {
  return stack.some((layer) => layer.node && layer.node.isConnected);
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

export function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    (node) => !node.hasAttribute("inert") && node.getClientRects().length > 0,
  );
}

/** Первый элемент, который логично сфокусировать. */
export function initialFocus(container, preferred) {
  if (preferred && preferred.isConnected && typeof preferred.focus === "function") return preferred;
  const candidates = getFocusable(container);
  const autofocus = candidates.find((node) => node.hasAttribute("data-autofocus"));
  return autofocus ?? candidates[0] ?? container;
}

/**
 * Удерживает фокус внутри контейнера.
 * @returns {() => void} снять ловушку
 */
export function trapFocus(container) {
  const onKeyDown = (event) => {
    if (event.key !== "Tab") return;
    const focusable = getFocusable(container);
    if (focusable.length === 0) {
      event.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", onKeyDown);
  return () => container.removeEventListener("keydown", onKeyDown);
}

/** Позиционирование всплывающей панели внутри окна. */
export function placeInViewport(panel, anchorRect, { gap = 8, align = "start" } = {}) {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  panel.style.position = "fixed";
  panel.style.left = "0px";
  panel.style.top = "0px";
  panel.style.visibility = "hidden";
  if (!panel.isConnected) document.body.append(panel);
  const size = panel.getBoundingClientRect();

  let left = align === "end" ? anchorRect.right - size.width : anchorRect.left;
  if (align === "center") left = anchorRect.left + anchorRect.width / 2 - size.width / 2;
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - size.width - margin));

  let top = anchorRect.bottom + gap;
  if (top + size.height > vh - margin) {
    const above = anchorRect.top - gap - size.height;
    top = above >= margin ? above : Math.max(margin, vh - size.height - margin);
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = "";
  return { left, top };
}
