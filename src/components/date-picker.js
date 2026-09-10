/**
 * Компактный календарь и поле даты.
 *
 * Диапозон доступных дат задаёт вызывающая сторона (UI-ограничение каркаса):
 * сегодня … сегодня + 12 месяцев. Недоступные даты не выбираются ни мышью,
 * ни клавиатурой; месяцы и годы без допустимых дат в навигации отключены.
 *
 * Панель всегда помещается в окно (placeInViewport) и участвует в стеке
 * слоёв, поэтому Escape сначала закрывает календарь.
 */

import { h, icon, setText } from "../lib/dom.js";
import { MONTHS_GENITIVE, MONTHS_NOMINATIVE, WEEKDAYS_SHORT, fmtDateRu } from "../lib/format.js";
import { addMonths, daysInMonth, isValidIsoDate, toOrdinal, todayIso, weekdayIndexMonday } from "../../calculations/date-period.js";
import { pushEscHandler, placeInViewport, trapFocus, getFocusable } from "../lib/overlays.js";
import { createIconButton } from "./button.js";

/** Разбирает ввод пользователя: «31.12.2026», «31.12», «2026-12-31». */
export function parseUserDate(raw, referenceYear = new Date().getFullYear()) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Укажите дату" };
  const iso = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/.exec(text);
  if (iso) {
    const candidate = `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;
    return isValidIsoDate(candidate) ? { ok: true, value: candidate } : { ok: false, error: "Такой даты нет" };
  }
  const short = /^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/.exec(text);
  if (short) {
    const day = Number(short[1]);
    const month = Number(short[2]);
    const yearRaw = short[3];
    const year = yearRaw ? (yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw)) : referenceYear;
    const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return isValidIsoDate(candidate) ? { ok: true, value: candidate } : { ok: false, error: "Такой даты нет" };
  }
  return { ok: false, error: "Формат: дд.мм.гггг" };
}

/**
 * @param {{value:string, minDate:string, maxDate:string, onSelect:(iso:string)=>void,
 *          anchor?:HTMLElement, closeOnSelect?:boolean, onDismiss?:()=>void}} config
 */
export function openCalendar({ value, minDate, maxDate, onSelect, closeOnSelect = true, anchor, onDismiss }) {
  const minOrdinal = toOrdinal(minDate);
  const maxOrdinal = toOrdinal(maxDate);
  const today = todayIso();

  const selected = isValidIsoDate(value) ? value : null;
  const start = selected ?? (isValidIsoDate(minDate) ? minDate : today);
  const view = { year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) };
  let focused = selected ?? clampToRange(start, minOrdinal, maxOrdinal);
  let mode = "days";
  let released = false;

  const inRange = (iso) => {
    const ordinal = toOrdinal(iso);
    return Number.isFinite(ordinal) && ordinal >= minOrdinal && ordinal <= maxOrdinal;
  };
  const monthHasRange = (year, month) => {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const last = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
    return toOrdinal(last) >= minOrdinal && toOrdinal(first) <= maxOrdinal;
  };
  const yearHasRange = (year) => monthHasRange(year, 1) || monthHasRange(year, 12);

  const caption = h("div", { class: "cal__label", role: "button", tabindex: "0", "aria-label": "Выбрать месяц", title: "Выбрать месяц" });
  const grid = h("div", { class: "cal__grid", role: "grid", "aria-label": "Дни месяца", "aria-multiselectable": "false" });
  const footerNote = h("span", { class: "muted" });

  const panel = h("div", { class: "cal", role: "dialog", "aria-modal": "false", "aria-label": "Календарь" }, [
    h("div", { class: "cal__head" }, [
      h("div", { class: "cal__navs" }, [
        createIconButton({ icon: "chevron-left", label: "Предыдущий год", size: 14, onClick: () => stepYear(-1) }),
        createIconButton({ icon: "chevrons-left", label: "Предыдущий месяц", size: 14, onClick: () => stepMonth(-1) }),
      ]),
      caption,
      h("div", { class: "cal__navs" }, [
        createIconButton({ icon: "chevrons-right", label: "Следующий месяц", size: 14, onClick: () => stepMonth(1) }),
        createIconButton({ icon: "chevron-right", label: "Следующий год", size: 14, onClick: () => stepYear(1) }),
      ]),
    ]),
    grid,
    h("div", { class: "cal__foot" }, [
      h("div", { class: "cal__navs" }, [
        createIconButton({ icon: "calendar", label: "Список месяцев", size: 14, onClick: () => setMode(mode === "months" ? "days" : "months") }),
        h("button", {
          type: "button",
          class: "btn btn--ghost btn--sm",
          text: "Сегодня",
          onClick: () => {
            if (!inRange(today)) return;
            select(today);
          },
        }),
      ]),
      footerNote,
    ]),
  ]);

  function clampToRange(iso) {
    const ordinal = toOrdinal(iso);
    if (!Number.isFinite(ordinal)) return minDate;
    if (ordinal < minOrdinal) return minDate;
    if (ordinal > maxOrdinal) return maxDate;
    return iso;
  }

  function setMode(next) {
    mode = next;
    render();
    const focusables = getFocusable(panel);
    focusables[0]?.focus?.();
  }

  function stepMonth(delta) {
    let month = view.month + delta;
    let year = view.year;
    if (month < 1) {
      month = 12;
      year -= 1;
    } else if (month > 12) {
      month = 1;
      year += 1;
    }
    if (year < -9999 || year > 9999) return;
    // Месяцы без допустимых дат недоступны и с клавиатуры (PageUp/PageDown).
    if (!monthHasRange(year, month)) return;
    view.year = year;
    view.month = month;
    render();
  }

  function stepYear(delta) {
    if (!yearHasRange(view.year + delta)) return;
    view.year += delta;
    render();
  }

  function goTo(iso) {
    view.year = Number(iso.slice(0, 4));
    view.month = Number(iso.slice(5, 7));
    focused = iso;
    render();
  }

  function select(iso) {
    if (!inRange(iso)) return;
    onSelect(iso);
    if (closeOnSelect) close();
    else {
      focused = iso;
      render();
    }
  }

  function renderCaption() {
    if (mode === "months") {
      setText(caption, `${view.year}`);
      caption.setAttribute("aria-label", `Год ${view.year}: выбрать другой год`);
      return;
    }
    setText(caption, `${MONTHS_NOMINATIVE[view.month - 1]} ${view.year}`);
    caption.setAttribute("aria-label", `${MONTHS_NOMINATIVE[view.month - 1]} ${view.year}: выбрать месяц`);
  }

  function renderMonths() {
    const container = h("div", { class: "cal__months" });
    for (let month = 1; month <= 12; month += 1) {
      const available = monthHasRange(view.year, month);
      const button = h("button", {
        type: "button",
        class: "cal__month-btn",
        "aria-pressed": month === view.month ? "true" : "false",
        disabled: !available,
        onclick: () => {
          if (!available) return;
          view.month = month;
          setMode("days");
        },
      });
      setText(button, MONTHS_NOMINATIVE[month - 1]);
      container.append(button);
    }
    const title = h("p", { class: "cal__months-title", text: "Месяцы без доступных дат отключены" });
    grid.replaceChildren();
    grid.className = "";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Месяцы");
    grid.append(title, container);
  }

  function renderDays() {
    grid.className = "cal__grid";
    grid.setAttribute("role", "grid");
    grid.setAttribute("aria-label", "Дни месяца");
    const frag = document.createDocumentFragment();

    for (const day of WEEKDAYS_SHORT) {
      frag.append(h("div", { class: "cal__dow", text: day, "aria-hidden": "true" }));
    }

    const total = daysInMonth(view.year, view.month);
    const offset = weekdayIndexMonday(`${view.year}-${String(view.month).padStart(2, "0")}-01`);
    for (let i = 0; i < offset; i += 1) frag.append(h("span", { "aria-hidden": "true" }));

    for (let day = 1; day <= total; day += 1) {
      const iso = `${view.year}-${String(view.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const available = inRange(iso);
      const isSelected = selected === iso;
      const isToday = today === iso;
      const button = h("button", {
        type: "button",
        class: ["cal__day", isSelected ? "is-selected" : "", isToday ? "is-today" : ""].filter(Boolean).join(" "),
        role: "gridcell",
        tabindex: focused === iso ? "0" : "-1",
        "aria-label": `${day} ${MONTHS_GENITIVE[view.month - 1]} ${view.year}${isToday ? ", сегодня" : ""}`,
        "aria-current": isToday ? "date" : null,
        "aria-selected": isSelected ? "true" : "false",
        disabled: !available,
        "data-iso": iso,
      });
      setText(button, String(day));
      button.addEventListener("click", () => {
        if (!available) return;
        select(iso);
      });
      frag.append(button);
    }
    grid.replaceChildren(frag);
  }

  function render() {
    renderCaption();
    if (mode === "months") renderMonths();
    else renderDays();
    const from = isValidIsoDate(minDate) ? minDate : today;
    const to = isValidIsoDate(maxDate) ? maxDate : addMonths(today, 12);
    setText(footerNote, `Доступно: ${fmtDateRu(from)} — ${fmtDateRu(to)}`);
    syncNavButtons();
  }

  function syncNavButtons() {
    const buttons = panel.querySelectorAll(".cal__head .btn-icon");
    const [prevYear, prevMonth, nextMonth, nextYear] = Array.from(buttons);
    const prevMonthAvailable = (() => {
      let m = view.month - 1;
      let y = view.year;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
      return monthHasRange(y, m);
    })();
    const nextMonthAvailable = (() => {
      let m = view.month + 1;
      let y = view.year;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      return monthHasRange(y, m);
    })();
    if (prevMonth) prevMonth.disabled = !prevMonthAvailable;
    if (nextMonth) nextMonth.disabled = !nextMonthAvailable;
    if (prevYear) prevYear.disabled = !yearHasRange(view.year - 1);
    if (nextYear) nextYear.disabled = !yearHasRange(view.year + 1);
  }

  grid.addEventListener("click", (event) => {
    const target = event.target.closest("[data-iso]");
    if (!target || target.disabled) return;
    focused = target.dataset.iso;
  });

  grid.addEventListener("keydown", (event) => {
    if (mode !== "days") return;
    const step = (days) => {
      const ordinal = toOrdinal(focused);
      if (!Number.isFinite(ordinal)) return;
      moveTo(isoFromOrdinal(ordinal + days), 0);
    };
    const isoFromOrdinal = (ordinal) => {
      const date = new Date(ordinal * 86400000);
      const iso = date.toISOString().slice(0, 10);
      return iso;
    };
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        step(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-7);
        break;
      case "ArrowDown":
        event.preventDefault();
        step(7);
        break;
      case "Home":
        event.preventDefault();
        step(-weekdayIndexMonday(focused));
        break;
      case "End":
        event.preventDefault();
        step(6 - weekdayIndexMonday(focused));
        break;
      case "PageUp":
        event.preventDefault();
        if (event.altKey) stepYear(-1);
        else stepMonth(-1);
        break;
      case "PageDown":
        event.preventDefault();
        if (event.altKey) stepYear(1);
        else stepMonth(1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        if (inRange(focused)) select(focused);
        break;
      }
      default:
        break;
    }
  });

  function moveTo(iso, depth = 0) {
    if (depth > 6) return;
    focused = clampToRange(iso);
    if (Number(focused.slice(0, 4)) !== view.year || Number(focused.slice(5, 7)) !== view.month) {
      view.year = Number(focused.slice(0, 4));
      view.month = Number(focused.slice(5, 7));
    }
    render();
    const node = grid.querySelector(`[data-iso="${focused}"]`);
    if (node) {
      node.focus({ preventScroll: true });
      if (node.disabled) moveTo(iso, depth + 1);
    } else {
      moveTo(iso, depth + 1);
    }
  }

  caption.addEventListener("click", () => setMode(mode === "months" ? "days" : "months"));
  caption.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setMode(mode === "months" ? "days" : "months");
    }
  });

  document.body.append(panel);
  const anchorRect = (anchor ?? caption).getBoundingClientRect();
  placeInViewport(panel, anchorRect, { gap: 6, align: "start" });

  const releaseTrap = trapFocus(panel);
  const popEsc = pushEscHandler({
    node: panel,
    onEscape: () => {
      close();
      return true;
    },
  });

  // Клик мимо календаря и поля закрывает панель (открывающая кнопка — внутри anchor).
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
  const initial = grid.querySelector(`[data-iso="${focused}"]`) ?? grid.querySelector(".cal__day:not([disabled])");
  window.requestAnimationFrame(() => initial?.focus?.());

  return { panel, close, focus: () => initial?.focus?.() };
}

/**
 * Поле «Дата» в дизайн-системе: текст + кнопка календаря + проверка ввода.
 * @param {{label:string, value:string, minDate:string, maxDate:string,
 *          onChange:(iso:string)=>void, hint?:string, id?:string}} config
 */
export function createDateField(config = {}) {
  let { label, value, minDate, maxDate, onChange, hint } = config;
  let current = isValidIsoDate(value) ? value : null;

  const input = h("input", {
    type: "text",
    inputmode: "numeric",
    placeholder: "дд.мм.гггг",
    autocomplete: "off",
    "aria-describedby": hint ? `${label.replace(/\s/g, "")}-hint` : null,
  });

  const openButton = h("button", {
    type: "button",
    class: "btn-icon",
    "aria-label": "Открыть календарь",
    title: "Открыть календарь",
  }, [icon("calendar", { size: 16 })]);

  const control = h("div", { class: "control" }, [input, openButton]);
  const errorNode = h("p", { class: "field__error", hidden: true });
  const hintNode = hint ? h("p", { class: "field__hint", text: hint }) : null;
  const field = h("div", { class: "field" }, [
    h("label", { class: "field__label", text: label, for: "date-field-input" }),
    control,
    hintNode,
    errorNode,
  ].filter(Boolean));
  input.id = "date-field-input";
  if (hint) input.setAttribute("aria-describedby", "date-field-hint");
  if (hintNode) hintNode.id = "date-field-hint";
  errorNode.id = "date-field-error";

  let calendar = null;

  const showError = (message) => {
    if (!message) {
      errorNode.hidden = true;
      setText(errorNode, "");
      control.classList.remove("control--error");
      input.removeAttribute("aria-invalid");
      return;
    }
    setText(errorNode, message);
    errorNode.hidden = false;
    control.classList.add("control--error");
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", errorNode.id);
  };

  function paint() {
    input.value = current ? fmtDateRu(current) : "";
    input.setAttribute("aria-label", current ? `${label}: ${fmtDateRu(current)}` : label);
  }

  function commit(iso, { silent = false } = {}) {
    const ordinal = toOrdinal(iso);
    const minOrdinal = toOrdinal(minDate);
    const maxOrdinal = toOrdinal(maxDate);
    if (!Number.isFinite(ordinal)) {
      if (!silent) showError("Такой даты нет");
      return false;
    }
    if (ordinal < minOrdinal || ordinal > maxOrdinal) {
      if (!silent) showError(`Доступно с ${fmtDateRu(minDate)} по ${fmtDateRu(maxDate)}`);
      return false;
    }
    current = iso;
    showError(null);
    paint();
    onChange?.(iso);
    return true;
  }

  input.addEventListener("change", () => {
    const parsed = parseUserDate(input.value);
    if (!parsed.ok) {
      showError(parsed.error);
      paint();
      return;
    }
    commit(parsed.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && !calendar) {
      event.preventDefault();
      openFrom();
    }
  });

  function openFrom() {
    if (calendar) {
      calendar.close();
      calendar = null;
      return;
    }
    calendar = openCalendar({
      value: current,
      minDate,
      maxDate,
      anchor: control,
      onSelect: (iso) => commit(iso),
      onDismiss: () => {
        calendar = null;
        input.focus({ preventScroll: true });
      },
    });
  }

  openButton.addEventListener("click", openFrom);

  paint();

  field.getValue = () => current;
  field.setValue = (iso, options) => {
    current = isValidIsoDate(iso) ? iso : null;
    showError(null);
    paint();
    if (options?.notify !== false && current) onChange?.(current);
  };
  field.setRange = (nextMin, nextMax) => {
    minDate = nextMin;
    maxDate = nextMax;
  };
  field.setError = (message) => showError(message);
  field.clearError = () => showError(null);
  field.focus = () => input.focus();
  field.closeCalendar = () => calendar?.close();
  field.isOpen = () => Boolean(calendar);
  return field;
}
