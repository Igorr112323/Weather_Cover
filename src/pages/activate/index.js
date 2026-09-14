/**
 * Экран активации.
 *
 * Показывается до оболочки приложения, пока main process не принял лицензию.
 * Интерфейс здесь — только ввод кода и сообщения: подпись проверяется в
 * electron/license/guard.cjs, а данные до активации не отдаются вовсе, поэтому
 * «обойти» этот экран правкой интерфейса нельзя.
 *
 * Лицензия бессрочная: на экране нет ни срока действия, ни обратного отсчёта,
 * ни дат, ни «условий лицензии». На экране ровно два действия:
 *
 *   1. поле для кода и кнопка «Активировать»;
 *   2. ниже — нередактируемое поле с кодом этого компьютера и кнопка
 *      «Скопировать»: его покупатель пересылает владельцу, когда код нужен.
 *
 * Заявки, мессенджеров, телефонов и «активации файлом» здесь нет: канал связи
 * с владельцем он выбирает сам, а текст заявки только добавлял экрану шума.
 * Полный идентификатор машины при копировании прикладывается в скобках — его
 * разбирает «Студия лицензий» (station/), поэтому никаких полей на экране не
 * нужно. Кнопка копирования и поле доступны всегда, даже при повреждённых
 * файлах: скопировать код машины безвредно, а «Активировать» — нет.
 */

import { h, icon } from "../../lib/dom.js";
import { createButton } from "../../components/button.js";
import { toast } from "../../components/toast.js";
import { activateLicense } from "../../services/license.js";
import { CODE_BODY_LENGTH, codeProgress, formatCodeText, isCodeComplete } from "../../services/license-code.js";
import iconUrl from "../../assets/brand/app-icon.svg?url";

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* попробуем запасной путь */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const done = document.execCommand?.("copy") === true;
    area.remove();
    return done;
  } catch {
    return false;
  }
}

/**
 * @param {object} config
 * @param {object|null} config.status состояние лицензии из main process
 * @param {(status:object)=>void} config.onActivated вызывается после успешной активации
 */
export function createActivationPage({ status, onActivated } = {}) {
  let busy = false;
  let finished = false;

  /**
   * Пояснение с иконкой и доступом к тексту: сообщение меняется на месте.
   * data-note нужен проверкам (tests/smoke/run-activation.mjs), чтобы отличать
   * сообщения друг от друга: все они .note--danger и стоят рядом.
   */
  function notice(text, tone, visible, kind) {
    const label = h("span", { text });
    const node = h("div", { class: `note note--${tone}`, "data-note": kind, "aria-live": "polite" }, [
      icon(tone === "danger" ? "circle-alert" : "triangle-alert", { size: 16 }),
      label,
    ]);
    node.hidden = !visible;
    return { node, setText: (next) => (label.textContent = next) };
  }

  const errorNote = notice("Код не принят.", "danger", false, "error");
  const storeNote = notice("Файл лицензии на этом компьютере не читается — введите код активации ещё раз.", "warning", Boolean(status?.storeReason), "store");
  const tamperNote = notice(
    "Файлы приложения изменены. Активация невозможна: запустите оригинальный AgroPrognoz.exe или переустановите приложение.",
    "danger",
    status?.tampered === true,
    "tamper",
  );

  const input = h("textarea", {
    id: "activation-code",
    class: "activate__input",
    rows: "4",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "characters",
    wrap: "hard",
    placeholder: "AGRO-XXXXXXXX-XXXXXXXX-…",
    title: "Вставьте код целиком — пробелы и переносы строк не мешают",
    disabled: status?.tampered ? true : null,
  });

  const lengthHint = h("span", { class: "activate__count", text: `0 / ${CODE_BODY_LENGTH}` });

  function updateCount() {
    const filled = codeProgress(input.value);
    lengthHint.textContent = `${filled} / ${CODE_BODY_LENGTH}`;
    lengthHint.classList.toggle("activate__count--full", filled >= CODE_BODY_LENGTH);
  }

  input.addEventListener("input", () => {
    hideError();
    updateCount();
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) input.value = formatCodeText(input.value);
    updateCount();
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text) return;
    event.preventDefault();
    input.value = formatCodeText(text);
    updateCount();
    hideError();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  });

  function showError(message) {
    errorNote.setText(message);
    errorNote.node.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }

  function hideError() {
    errorNote.node.hidden = true;
    input.removeAttribute("aria-invalid");
  }

  const activateButton = createButton({
    label: "Активировать",
    tone: "primary",
    icon: "check",
    block: true,
    title: "Ctrl+Enter — активировать",
    disabled: status?.tampered === true,
    onClick: () => submit(),
  });

  async function submit() {
    if (busy || finished) return;
    const code = input.value.trim();
    if (!code) {
      showError("Введите код активации.");
      input.focus();
      return;
    }
    if (!isCodeComplete(code)) {
      showError("Код неполный: скопируйте его целиком, вместе со всеми группами символов.");
      input.focus();
      return;
    }

    busy = true;
    hideError();
    activateButton.setLoading(true, "Проверяем код");

    const result = await activateLicense(code);

    activateButton.setLoading(false);
    busy = false;

    if (result?.ok) {
      succeed(result.status);
      return;
    }

    showError(result?.message || result?.status?.message || "Код активации не принят.");
    input.focus();
  }

  function succeed(nextStatus) {
    if (finished) return;
    finished = true;
    card.replaceChildren(
      h("div", { class: "activate__done" }, [
        h("span", { class: "activate__done-icon" }, [icon("check", { size: 28 })]),
        h("h1", { class: "page-title", text: "Приложение активировано" }),
        h("p", { class: "muted", text: "Лицензия бессрочная. Загружаем данные…" }),
        h("div", { class: "progress-line", style: "width:180px;margin:0 auto", "aria-hidden": "true" }),
      ]),
    );
    onActivated?.(nextStatus ?? status ?? {});
  }

  const machineShort = status?.machineIdShort || "—";
  const machineFull = status?.machineId || "";

  // Поле только для чтения: править его смысла нет, а выделить и скопировать
  // руками должно быть можно (кнопка — запасной путь для мыши).
  const machineInput = h("input", {
    id: "activation-machine",
    class: "activate__machine-input",
    type: "text",
    readonly: "",
    spellcheck: "false",
    value: machineShort,
    "data-activate-machine": "",
    "aria-describedby": "activation-machine-hint",
    title: status?.machineQuality === "low"
      ? "Идентификатор приблизительный: системный номер недоступен — попросите у владельца общий код"
      : "По этому коду владелец выписывает код для этого компьютера",
  });

  const machineHint = h("span", {
    id: "activation-machine-hint",
    class: "activate__machine-hint",
    text: status?.machineQuality === "low"
      ? "Идентификатор приблизительный — попросите общий код"
      : "Нужен, только если код ещё не выдан",
  });

  const copyButton = createButton({
    label: "Скопировать",
    tone: "secondary",
    size: "sm",
    icon: "clipboard-list",
    onClick: async () => {
      // Полностью совместимо с полем «Заявка» в «Студии лицензий»: короткий код
      // и в скобках — полный идентификатор.
      const ok = await copyText(machineFull ? `${machineShort} (${machineFull})` : machineShort);
      if (ok) toast.success("Код компьютера скопирован");
      else toast.error("Не скопировалось — выделите код в поле и нажмите Ctrl+C");
    },
  });
  copyButton.setAttribute("data-activate-copy", "");

  const machineBlock = h("div", { class: "activate__machine" }, [
    h("div", { class: "field" }, [
      h("label", { class: "field__label", for: "activation-machine" }, [h("span", { text: "Код этого компьютера" })]),
      h("div", { class: "control control--multiline" }, [machineInput]),
      h("div", { class: "activate__hintrow" }, [machineHint]),
    ]),
    h("div", { class: "activate__copy" }, [copyButton]),
  ]);

  const card = h("div", { class: "activate__card activate__card--minimal" }, [
    h("div", { class: "activate__brand" }, [
      h("img", { class: "activate__logo", src: iconUrl, alt: "", width: "40", height: "40" }),
      h("div", { class: "activate__names" }, [
        h("span", { class: "activate__name", text: "АгроПрогноз" }),
        h("span", { class: "activate__sub", text: "Кукуруза" }),
      ]),
    ]),
    h("h1", { class: "page-title", text: "Активация приложения" }),
    tamperNote.node,
    storeNote.node,
    h("div", { class: "field" }, [
      h("label", { class: "field__label", for: "activation-code" }, [h("span", { text: "Код активации" })]),
      h("div", { class: "control control--multiline" }, [input]),
      h("div", { class: "activate__hintrow" }, [lengthHint]),
    ]),
    errorNote.node,
    h("div", { class: "activate__actions" }, [activateButton]),
    machineBlock,
  ]);

  // Полоса перетаскивания окна: системной строки заголовка нет, поэтому
  // окно активации тянут за верхнюю полосу, как и остальной интерфейс.
  const node = h("div", { class: "activate" }, [
    h("div", { class: "window-drag", "aria-hidden": "true" }),
    h("div", { class: "activate__scroll" }, [card]),
  ]);

  updateCount();
  // Фокус сразу в поле кода: экран активации — единственное, что сейчас можно сделать.
  window.setTimeout(() => {
    if (!finished) input.focus();
  }, 60);

  return { node, input, submit };
}
