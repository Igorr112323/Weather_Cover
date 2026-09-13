/**
 * Экран активации.
 *
 * Показывается до оболочки приложения, пока main process не принял лицензию.
 * Интерфейс здесь — только ввод кода и сообщения: подпись проверяется в
 * electron/license/guard.cjs, а данные до активации не отдаются вовсе, поэтому
 * «обойти» этот экран правкой интерфейса нельзя.
 *
 * Лицензия бессрочная: на экране нет ни срока действия, ни обратного отсчёта,
 * ни дат — только серийный номер лицензии и идентификатор компьютера
 * (нужен для персональных кодов и для обращений в поддержку).
 *
 * Заявка владельцу: кнопка формирует текст заявки (код компьютера, полный
 * идентификатор, версия) и открывает мессенджер/почту покупателя с готовым
 * текстом. Контакт владельца в renderer не хранится — его присылает main
 * process. Запасные пути: скопировать заявку и сохранить файл .agrorequest.
 */

import { h, icon } from "../../lib/dom.js";
import { createButton } from "../../components/button.js";
import { toast } from "../../components/toast.js";
import { activateLicense, activateLicenseFromFile } from "../../services/license.js";
import { openRequestChannel, resolveRequestInfo, saveRequestFile } from "../../services/license-request.js";
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
 * @param {string} [config.version] версия приложения
 * @param {(status:object)=>void} config.onActivated вызывается после успешной активации
 */
export function createActivationPage({ status, version = "", onActivated } = {}) {
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
    "aria-describedby": "activation-hint",
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
    disabled: status?.tampered === true,
    onClick: () => submit(),
  });

  const pasteButton = createButton({
    label: "Вставить из буфера",
    tone: "secondary",
    icon: "clipboard-list",
    disabled: status?.tampered === true,
    onClick: async (_event, button) => {
      let text = "";
      try {
        text = (await navigator.clipboard?.readText?.()) ?? "";
      } catch {
        text = "";
      }
      if (!text.trim()) {
        toast.info("В буфере обмена пусто или браузер не дал к нему доступ");
        return;
      }
      button.setLoading(true, "Проверяем");
      input.value = formatCodeText(text);
      updateCount();
      button.setLoading(false);
      await submit();
    },
  });

  const fileButton = createButton({
    label: "Активировать файлом…",
    tone: "secondary",
    icon: "file-text",
    disabled: status?.tampered === true,
    title: "Файл лицензии (.agrolic, .txt) выбирается в системном диалоге",
    onClick: async (_event, button) => {
      if (busy) return;
      busy = true;
      button.setLoading(true, "Выбор файла");
      hideError();
      const result = await activateLicenseFromFile();
      button.setLoading(false);
      busy = false;
      if (result?.code === "canceled") return;
      if (result?.ok) {
        succeed(result.status);
        return;
      }
      showError(result?.message || "Файл не принят: проверьте, что это файл лицензии этого приложения.");
    },
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
    pasteButton.setDisabled(true);
    fileButton.setDisabled(true);

    const result = await activateLicense(code);

    activateButton.setLoading(false);
    busy = false;

    if (result?.ok) {
      succeed(result.status);
      return;
    }

    pasteButton.setDisabled(false);
    fileButton.setDisabled(false);
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
  const machineRow = h("div", { class: "activate__machine" }, [
    h("div", { class: "activate__machine-text" }, [
      h("span", { class: "block-title", text: "Этот компьютер" }),
      h("code", { class: "activate__machine-id", text: machineShort }),
      h(
        "span", { class: "muted", text: status?.machineQuality === "low"
          ? "Идентификатор приблизительный: системный номер недоступен. Персональный код может не подойти — используйте общий."
          : "Понадобится только для персонального кода" },
      ),
    ]),
    createButton({
      label: "Скопировать",
      tone: "ghost",
      size: "sm",
      icon: "clipboard-list",
      onClick: async () => {
        const ok = await copyText(status?.machineId ? `${machineShort} (${status.machineId})` : machineShort);
        if (ok) toast.success("Идентификатор скопирован");
        else toast.error("Скопировать не удалось — выпишите идентификатор вручную");
      },
    }),
  ]);

  /* ── Заявка владельцу ─────────────────────────────────────────────────── */

  /**
   * Панель заявки: текст (код компьютера, полный идентификатор, версия),
   * каналы связи и запасные пути — копирование и файл .agrorequest. Контакты
   * владельца интерфейс не хранит: они приходят из main process вместе с
   * готовым текстом. Приложение при этом остаётся офлайн — заявка уходит
   * только через собственные мессенджер или почту покупателя.
   */
  const requestText = h("textarea", {
    class: "activate__request-text",
    rows: "7",
    readonly: "",
    spellcheck: "false",
    "data-request-text": "",
    "aria-label": "Текст заявки владельцу",
  });

  const contactHint = h("p", { class: "muted activate__request-hint", "data-request-contact": "" });

  function channelButton(channel, label) {
    const button = createButton({
      label,
      tone: "secondary",
      onClick: async (_event, self) => {
        self.setLoading(true);
        const result = await openRequestChannel(channel);
        self.setLoading(false);
        if (result?.ok) {
          toast.success(result.copied ? "Текст заявки скопирован — вставьте его в открывшемся чате" : "Заявка отправляется");
          return;
        }
        toast.warning(result?.message || "Не удалось открыть канал связи");
      },
    });
    button.setAttribute("data-request-channel", channel);
    return button;
  }

  const requestState = { fileName: "", loaded: false };

  const requestPanel = h("div", { class: "activate__request-panel", "data-request-panel": "", hidden: "" }, [
    h("div", { class: "field" }, [
      h("div", { class: "control control--multiline" }, [requestText]),
    ]),
    contactHint,
    h("div", { class: "activate__request-actions" }, [
      channelButton("telegram", "Telegram"),
      channelButton("whatsapp", "WhatsApp"),
      channelButton("email", "Почта"),
      (() => {
        const button = createButton({
          label: "Скопировать заявку",
          tone: "secondary",
          icon: "clipboard-list",
          onClick: async () => {
            const ok = await copyText(requestText.value);
            if (ok) toast.success("Заявка скопирована");
            else toast.error("Скопировать не удалось — выделите текст заявки и скопируйте вручную");
          },
        });
        button.setAttribute("data-request-copy", "");
        return button;
      })(),
      (() => {
        const button = createButton({
          label: "Сохранить файл .agrorequest",
          tone: "ghost",
          icon: "save",
          title: "Файл заявки можно переслать владельцу любым удобным способом",
          onClick: async (_event, self) => {
            self.setLoading(true);
            const result = await saveRequestFile(requestText.value, requestState.fileName);
            self.setLoading(false);
            if (result?.ok) toast.success(`Файл заявки сохранён${result.fileName ? `: ${result.fileName}` : ""}`);
            else toast.warning(result?.message || "Не удалось сохранить файл заявки");
          },
        });
        button.setAttribute("data-request-save", "");
        return button;
      })(),
    ]),
  ]);

  async function loadRequestInfo() {
    const info = await resolveRequestInfo(status, version);
    requestText.value = info.text ?? "";
    requestState.fileName = info.fileName ?? "";
    if (info.contact?.phone) {
      const pretty = info.contact.phone.replace(/^(\d)(\d{3})(\d{3})(\d{2})(\d{2})$/, "+$1 $2 $3-$4-$5");
      contactHint.textContent = `Владелец: ${info.contact.telegramUser ? `@${info.contact.telegramUser}` : pretty}${
        info.contact.email ? ` · ${info.contact.email}` : ""
      }`;
    } else if (info.local) {
      contactHint.textContent = "В браузере заявку можно скопировать или сохранить файлом; мессенджер откроется в приложении.";
    } else {
      contactHint.textContent = "";
    }
    // Каналы, которые владелец не настроил, не показываются вовсе.
    if (!info.local && info.channels && typeof info.channels === "object") {
      for (const button of [...requestPanel.querySelectorAll("[data-request-channel]")]) {
        const channel = button.getAttribute("data-request-channel");
        if (info.channels[channel] !== true) button.hidden = true;
      }
    }
    requestState.loaded = true;
  }

  const requestToggle = createButton({
    label: "Отправить заявку владельцу",
    tone: "secondary",
    icon: "inbox",
    disabled: status?.tampered === true,
    onClick: async (_event, self) => {
      const opening = requestPanel.hidden;
      requestPanel.hidden = !opening;
      if (opening && !requestState.loaded) {
        self.setLoading(true, "Готовим заявку");
        await loadRequestInfo();
        self.setLoading(false);
      }
    },
  });
  requestToggle.setAttribute("data-request-toggle", "");

  const requestSection = h("div", { class: "activate__request" }, [
    h("span", { class: "block-title", text: "Заявка владельцу" }),
    h("p", {
      class: "muted activate__lead",
      text: "Нужен персональный код? Нажмите кнопку — откроется мессенджер или почта с готовой заявкой: владельцу понадобится только код этого компьютера. Если вы переустановили Windows и прежний код больше не подходит — владелец выпустит новый по этой же заявке.",
    }),
    requestToggle,
    requestPanel,
  ]);


  const details = h("dl", { class: "kv activate__details" }, [
    h("dt", { text: "Условия лицензии" }),
    h("dd", { class: "num", text: "Бессрочная, без ограничения по дате" }),
    h("dt", { text: "Серийный номер" }),
    h("dd", { class: "num", text: status?.serial || "присваивается при активации" }),
    h("dt", { text: "Версия приложения" }),
    h("dd", { class: "num", text: version || "—" }),
  ]);

  const card = h("div", { class: "activate__card" }, [
    h("div", { class: "activate__brand" }, [
      h("img", { class: "activate__logo", src: iconUrl, alt: "", width: "40", height: "40" }),
      h("div", { class: "activate__names" }, [
        h("span", { class: "activate__name", text: "АгроПрогноз" }),
        h("span", { class: "activate__sub", text: "Кукуруза" }),
      ]),
    ]),
    h("h1", { class: "page-title", text: "Активация приложения" }),
    h("p", {
      class: "muted activate__lead",
      text: "Введите код активации. Лицензия бессрочная: срок действия кода не ограничен, дата окончания не задаётся.",
    }),
    tamperNote.node,
    storeNote.node,
    h("div", { class: "field" }, [
      h("label", { class: "field__label", for: "activation-code" }, [h("span", { text: "Код активации" })]),
      h("div", { class: "control control--multiline" }, [input]),
      h("div", { class: "activate__hintrow" }, [
        h("p", { class: "field__hint", id: "activation-hint", text: "Код можно вставить из письма целиком — пробелы и переносы строк не мешают. Ctrl+Enter активирует." }),
        lengthHint,
      ]),
    ]),
    errorNote.node,
    h("div", { class: "activate__actions" }, [activateButton, pasteButton, fileButton]),
    h("div", { class: "activate__divider", "aria-hidden": "true" }),
    machineRow,
    h("div", { class: "activate__divider", "aria-hidden": "true" }),
    requestSection,
    details,
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
