/**
 * Выбор месяца (без дней): сетка 12 месяцев + переключение года.
 *
 * Дни пользователю не нужны — период прогноза всегда начинается с 1-го числа
 * выбранного месяца. Диапазон доступных месяцев задаёт вызывающая сторона
 * (первый и последний доступный месяц в формате "YYYY-MM-01"); месяцы вне
 * диапазона отключены, стрелки не уводят за пределы допустимых годов.
 *
 * Панель помещается в окно (placeInViewport) и участвует в стеке слоёв,
 * поэтому Escape сначала закрывает её, а затем действует на страницу.
 */

import { h, icon, setText } from "../lib/dom.js";
import { MONTHS_NOMINATIVE } from "../lib/format.js";
import { fmtMonthRu, parseUserMonth } from "../lib/month.js";
import { isValidIsoDate, monthIndex, isoFromMonthIndex, startOfMonth } from "../../calculations/date-period.js";
import { pushEscHandler, placeInViewport, trapFocus } from "../lib/overlays.js";
import { createIconButton } from "./button.js";

export { fmtMonthRu, parseUserMonth };

let seq = 0;

/**
 * Всплывающая панель выбора месяца.
 * @param {{value:string|null, minMonth:string, maxMonth:string, onSelect:(iso:string)=>void,
 *          anchor?:HTMLElement, onDismiss?:()=>void}} config
 */
export function openMonthPicker({ value, minMonth, maxMonth, onSelect, anchor, onDismiss }) {
  const minIndex = monthIndex(minMonth);
  const maxIndex = monthIndex(maxMonth);
  const minYear = Math.floor(minIndex / 12);
  const maxYear = Math.floor(maxIndex / 12);

  const selected = isValidIsoDate(value) ? startOfMonth(value) : null;
  const selectedIndex = selected ? monthIndex(selected) : NaN;
  const startIndex = Number.isFinite(selectedIndex) ? clampIndex(selectedIndex) : maxIndex;
  let viewYear = Math.floor(startIndex / 12);
  let released = false;

  const inRange = (index) => Number.isFinite(index) && index >= minIndex && index <= maxIndex;

  function clampIndex(index) {
    return Math.min(maxIndex, Math.max(minIndex, index));
  }

  const yearInput = h("input", {
    class: "mp__year",
    type: "text",
    inputmode: "numeric",
    maxlength: "4",
    "aria-label": "Год",
    title: "Год: введите или листайте стрелками",
    autocomplete: "off",
  });
  const grid = h("div", { class: "mp__grid", role: "grid", "aria-label": "Месяцы" });
  const footerNote = h("span", { class: "muted" });

  const prevYear = createIconButton({ icon: "chevron-left", label: "Предыдущий год", size: 16, onClick: () => stepYear(-1) });
  const nextYear = createIconButton({ icon: "chevron-right", label: "Следующий год", size: 16, onClick: () => stepYear(1) });

  const panel = h("div", { class: "mp", role: "dialog", "aria-modal": "false", "aria-label": "Выбор месяца" }, [
    h("div", { class: "mp__head" }, [prevYear, yearInput, nextYear]),
    grid,
    h("div", { class: "mp__foot" }, [
      h("button", {
        type: "button",
        class: "btn btn--ghost btn--sm",
        text: "Текущий месяц",
        onClick: () => select(maxIndex),
      }),
      footerNote,
    ]),
  ]);

  function stepYear(delta) {
    const next = viewYear + delta;
    if (next < minYear || next > maxYear) return;
    viewYear = next;
    render();
  }

  function select(index) {
    if (!inRange(index)) return;
    onSelect(isoFromMonthIndex(index));
    close();
  }

  function render() {
    yearInput.value = String(viewYear);
    prevYear.disabled = viewYear - 1 < minYear;
    nextYear.disabled = viewYear + 1 > maxYear;

    const frag = document.createDocumentFragment();
    for (let month = 1; month <= 12; month += 1) {
      const index = viewYear * 12 + (month - 1);
      const available = inRange(index);
      const isSelected = index === selectedIndex;
      const isCurrent = index === maxIndex;
      const button = h("button", {
        type: "button",
        class: ["mp__month", isSelected ? "is-selected" : "", isCurrent ? "is-current" : ""].filter(Boolean).join(" "),
        role: "gridcell",
        "aria-label": `${MONTHS_NOMINATIVE[month - 1]} ${viewYear}${isCurrent ? ", текущий месяц" : ""}`,
        "aria-selected": isSelected ? "true" : "false",
        disabled: !available,
        "data-index": String(index),
      });
      setText(button, MONTHS_NOMINATIVE[month - 1]);
      button.addEventListener("click", () => select(index));
      frag.append(button);
    }
    grid.replaceChildren(frag);
    setText(footerNote, `${fmtMonthRu(minMonth)} — ${fmtMonthRu(maxMonth)}`);
  }

  // Ввод года вручную: четыре цифры в пределах диапазона → переход к году.
  yearInput.addEventListener("input", () => {
    const digits = yearInput.value.replace(/\D/g, "");
    if (digits !== yearInput.value) yearInput.value = digits;
    if (digits.length !== 4) return;
    const year = Number(digits);
    if (year < minYear || year > maxYear) return;
    viewYear = year;
    render();
  });
  yearInput.addEventListener("blur", () => {
    yearInput.value = String(viewYear);
  });
  yearInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      stepYear(1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      stepYear(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const year = Number(yearInput.value);
      if (Number.isInteger(year) && year >= minYear && year <= maxYear && year !== viewYear) {
        viewYear = year;
        render();
      } else {
        yearInput.value = String(viewYear);
      }
      grid.querySelector(".mp__month:not([disabled])")?.focus();
    }
  });

  grid.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    const current = active instanceof HTMLElement ? Number(active.dataset.index) : NaN;
    if (!Number.isFinite(current)) return;
    const move = (delta) => {
      event.preventDefault();
      focusIndex(current + delta);
    };
    switch (event.key) {
      case "ArrowLeft":
        move(-1);
        break;
      case "ArrowRight":
        move(1);
        break;
      case "ArrowUp":
        move(-3);
        break;
      case "ArrowDown":
        move(3);
        break;
      case "PageUp":
        move(-12);
        break;
      case "PageDown":
        move(12);
        break;
      case "Home":
        event.preventDefault();
        focusIndex(viewYear * 12);
        break;
      case "End":
        event.preventDefault();
        focusIndex(viewYear * 12 + 11);
        break;
      default:
        break;
    }
  });

  function focusIndex(index) {
    const target = clampIndex(index);
    const year = Math.floor(target / 12);
    if (year !== viewYear) {
      viewYear = year;
      render();
    }
    grid.querySelector(`[data-index="${target}"]`)?.focus({ preventScroll: true });
  }

  document.body.append(panel);
  const anchorRect = (anchor ?? document.body).getBoundingClientRect();
  placeInViewport(panel, anchorRect, { gap: 6, align: "start" });

  const releaseTrap = trapFocus(panel);
  const popEsc = pushEscHandler({
    node: panel,
    onEscape: () => {
      close();
      return true;
    },
  });

  // Клик мимо панели и поля закрывает её (кнопка открытия — внутри anchor).
  const onPointerDown = (event) => {
    const target = event.target;
    if (target instanceof Node && (panel.contains(target) || (anchor instanceof Node && anchor.contains(target)))) return;
    close();
  };
  document.addEventListener("pointerdown", onPointerDown, true);

  function close() {
    if (released) return;
    released = true;
    releaseTrap();
    popEsc();
    document.removeEventListener("pointerdown", onPointerDown, true);
    panel.remove();
    onDismiss?.();
  }

  render();
  const initial =
    grid.querySelector(`[data-index="${Number.isFinite(selectedIndex) ? selectedIndex : maxIndex}"]`) ??
    grid.querySelector(".mp__month:not([disabled])");
  window.requestAnimationFrame(() => {
    if (!released) initial?.focus?.({ preventScroll: true });
  });

  return { panel, close };
}

/**
 * Поле «Месяц» в дизайн-системе: текст + кнопка выбора + проверка ввода.
 * Значение — ISO-дата первого дня месяца ("YYYY-MM-01").
 *
 * @param {{label:string, value:string|null, minMonth:string, maxMonth:string,
 *          onChange:(iso:string)=>void, hint?:string}} config
 */
export function createMonthField(config = {}) {
  let { label, value, minMonth, maxMonth, onChange, hint } = config;
  let current = isValidIsoDate(value) ? startOfMonth(value) : null;
  seq += 1;
  const id = `month-field-${seq}`;

  const input = h("input", {
    id,
    type: "text",
    inputmode: "numeric",
    placeholder: "мм.гггг",
    autocomplete: "off",
  });

  const openButton = h(
    "button",
    { type: "button", class: "btn-icon", "aria-label": "Выбрать месяц", title: "Выбрать месяц" },
    [icon("calendar", { size: 16 })],
  );

  const control = h("div", { class: "control" }, [input, openButton]);
  const errorNode = h("p", { class: "field__error", id: `${id}-error`, hidden: true });
  const hintNode = hint ? h("p", { class: "field__hint", id: `${id}-hint`, text: hint }) : null;
  const field = h("div", { class: "field" }, [h("label", { class: "field__label", text: label, for: id }), control, hintNode, errorNode].filter(Boolean));
  if (hintNode) input.setAttribute("aria-describedby", hintNode.id);

  let picker = null;

  function showError(message) {
    if (!message) {
      errorNode.hidden = true;
      setText(errorNode, "");
      control.classList.remove("control--error");
      input.removeAttribute("aria-invalid");
      if (hintNode) input.setAttribute("aria-describedby", hintNode.id);
      else input.removeAttribute("aria-describedby");
      return;
    }
    setText(errorNode, message);
    errorNode.hidden = false;
    control.classList.add("control--error");
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", errorNode.id);
  }

  function paint() {
    input.value = current ? fmtMonthRu(current) : "";
    input.setAttribute("aria-label", current ? `${label}: ${fmtMonthRu(current)}` : label);
  }

  function commit(iso) {
    const index = monthIndex(iso);
    if (!Number.isFinite(index)) {
      showError("Такого месяца нет");
      paint();
      return false;
    }
    if (index < monthIndex(minMonth) || index > monthIndex(maxMonth)) {
      showError(`Доступно с ${fmtMonthRu(minMonth)} по ${fmtMonthRu(maxMonth)}`);
      paint();
      return false;
    }
    current = startOfMonth(iso);
    showError(null);
    paint();
    onChange?.(current);
    return true;
  }

  input.addEventListener("change", () => {
    const parsed = parseUserMonth(input.value);
    if (!parsed.ok) {
      showError(parsed.error);
      paint();
      return;
    }
    commit(parsed.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && !picker) {
      event.preventDefault();
      toggle();
    }
  });

  function toggle() {
    if (picker) {
      picker.close();
      return;
    }
    picker = openMonthPicker({
      value: current,
      minMonth,
      maxMonth,
      anchor: control,
      onSelect: (iso) => commit(iso),
      onDismiss: () => {
        picker = null;
        input.focus({ preventScroll: true });
      },
    });
  }

  openButton.addEventListener("click", toggle);
  paint();

  field.input = input;
  field.getValue = () => current;
  field.setValue = (iso, options) => {
    current = isValidIsoDate(iso) ? startOfMonth(iso) : null;
    showError(null);
    paint();
    if (options?.notify !== false && current) onChange?.(current);
  };
  field.setRange = (nextMin, nextMax) => {
    minMonth = nextMin;
    maxMonth = nextMax;
  };
  field.setError = (message) => showError(message);
  field.clearError = () => showError(null);
  field.focus = () => input.focus();
  field.closePicker = () => picker?.close();
  field.isOpen = () => Boolean(picker);
  return field;
}
