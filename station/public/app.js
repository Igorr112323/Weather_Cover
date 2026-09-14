/**
 * Интерфейс станции «Активация ключей».
 *
 * Работает без сборки и без зависимостей: обычный DOM + fetch на локальный
 * сервер станции. Закрытого ключа здесь нет и быть не может — станция отдаёт
 * только результат (код, сообщение, журнал), а подписывает на компьютере
 * владельца.
 *
 * Весь текст, который присылает покупатель, считается недоверенным: он
 * попадает в DOM только через esc(), поэтому вставка с чужим HTML безвредна.
 */

(() => {
  const TOKEN = window.AGRO_STATION?.token ?? "";
  const $ = (id) => document.getElementById(id);

  /* ── Утилиты ─────────────────────────────────────────────────────────── */

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function toast(text, kind = "") {
    const node = $("toast");
    node.textContent = text;
    node.className = `toast ${kind}`;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.hidden = true;
    }, 4200);
  }

  async function api(pathname, body) {
    const headers = { "x-agro-token": TOKEN };
    const options = { method: body ? "POST" : "GET", headers };
    if (body) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(pathname, options);
    const data = await response.json().catch(() => ({ ok: false, message: "Станция ответила непонятно" }));
    if (!response.ok && data.ok !== false) return { ok: false, message: `HTTP ${response.status}` };
    return data;
  }

  async function copy(text, label = "Скопировано") {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      toast(label);
    }
  }

  function download(name, content, type = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function box(node, html, { error = false } = {}) {
    node.className = `result ${error ? "is-error" : ""}`;
    node.innerHTML = html;
  }

  const codeBlock = (code) => `<div class="code" data-copy="${esc(code)}"><code>${esc(code)}</code><button class="btn tiny copy">Копировать</button></div>`;
  const kv = (rows) => `<dl class="kv">${rows.filter(([, value]) => value !== "" && value != null).map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value}</dd>`).join("")}</dl>`;

  /* ── Вкладки ──────────────────────────────────────────────────────────── */

  $("tabs").addEventListener("click", (event) => {
    const button = event.target.closest(".tab");
    if (!button) return;
    for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("is-active", tab === button);
    for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("is-active", panel.id === `tab-${button.dataset.tab}`);
    if (button.dataset.tab === "pc") refreshPc();
    if (button.dataset.tab === "ledger") refreshLedger();
    if (button.dataset.tab === "exe") refreshState();
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest(".copy");
    if (button) {
      const source = button.closest("[data-copy]");
      if (source) copy(source.dataset.copy);
      return;
    }
    const revoke = event.target.closest("[data-revoke]");
    if (revoke) revokeSerial(revoke.dataset.revoke, revoke.dataset.confirm);
  });

  /* ── Заявка → код ─────────────────────────────────────────────────────── */

  $("parse").addEventListener("click", () => {
    const text = $("requestText").value;
    if (!text.trim()) {
      $("parseResult").textContent = "Сначала вставьте, что прислал пользователь.";
      return;
    }
    renderParse(quickParse(text));
  });

  /** Разбор на месте: станция отдаёт тот же результат в ответе /api/issue, но показать его надо сразу. */
  function quickParse(text) {
    const shortLabel = /(?:код|id|идентификатор)\s*(?:компьютера|машины|устройства|пк)?\s*[:=]?\s*([0-9A-Za-z-]{4,})/i.exec(text);
    const fullLabel = /полный\s*идентификатор\s*[:=]?\s*([0-9a-fA-F]{64})/i.exec(text);
    const bare = /^\s*([0-9A-Za-z]{4}-?[0-9A-Za-z]{4})\s*$/.exec(text);
    const short = shortLabel?.[1] ?? bare?.[1] ?? "";
    const phone = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.exec(text)?.[0] ?? "";
    const email = /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/.exec(text)?.[0] ?? "";
    const name = /(?:меня зовут|имя)\s*[:\-]?\s*([А-ЯЁA-Z][а-яёa-zA-Z-]+)/i.exec(text)?.[1] ?? "";
    return { short, full: fullLabel?.[1] ?? "", phone, email, name };
  }

  function renderParse(data) {
    const node = $("parseResult");
    if (!data.short && !data.full) {
      node.innerHTML = `<span class="bad">Код компьютера не найден.</span> Вставьте строку вида <code>Код компьютера: ZZG5-9ZKT</code> или просто <code>ZZG5-9ZKT</code>.`;
      return;
    }
    if (data.short && !$("machineCode").value) $("machineCode").value = data.short;
    if (data.name && !$("name").value) $("name").value = data.name;
    if (data.phone && !$("phone").value) $("phone").value = data.phone;
    if (data.email && !$("email").value) $("email").value = data.email;
    node.innerHTML = `Код компьютера: <b class="mono">${esc(data.short || prettyFromFull(data.full))}</b>${data.full ? ` · полный идентификатор найден (${esc(data.full.slice(0, 12))}…)` : ""}${data.phone ? ` · телефон ${esc(data.phone)}` : ""}${data.email ? ` · ${esc(data.email)}` : ""} · поля ниже заполнены из заявки`;
  }

  function prettyFromFull(value) {
    return value ? `${value.slice(0, 4)}-${value.slice(4, 8)}` : "";
  }

  $("pasteRequest").addEventListener("click", async () => {
    try {
      $("requestText").value = await navigator.clipboard.readText();
      $("parse").click();
    } catch {
      toast("Буфер обмена недоступен — вставьте текст вручную (Ctrl+V)", "warn");
    }
  });

  function issueBody(extra = {}) {
    return {
      requestText: $("requestText").value,
      machineCode: $("machineCode").value.trim(),
      name: $("name").value.trim(),
      phone: $("phone").value.trim(),
      email: $("email").value.trim(),
      note: $("note").value.trim(),
      universal: $("universal").checked,
      makeExe: $("makeExe").checked,
      instance: $("instance").value.trim(),
      ...extra,
    };
  }

  $("issue").addEventListener("click", async () => {
    $("issueHint").textContent = "Подписываем код…";
    const result = await api("/api/issue", issueBody());
    $("issueHint").textContent = "";
    if (!result.ok) {
      if (result.needsConfirm === "duplicate") {
        const list = (result.previous ?? []).map((row) => `${row.issuedAt} · ${row.serialPretty} · ${row.name || "без имени"}`).join("<br>");
        box(
          $("result"),
          `<h3>Коду этому компьютеру уже выдан</h3><p>${esc(result.message)}</p><div class="list">${list}</div>
           <p class="hint">«Продолжить» — выписать новый код (новый серийник) и отозвать прежний. Так делают, если покупатель переустановил Windows или перешёл на другой компьютер.</p>
           <div class="row"><button class="btn primary" data-action="force">Продолжить и отозвать старый</button><button class="btn ghost" data-action="keep">Отозвать старый, новый не выдавать</button></div>`,
        );
        $("result").querySelector('[data-action="force"]').addEventListener("click", () => issueConfirmed());
        $("result").querySelector('[data-action="keep"]').addEventListener("click", async () => {
          const serials = (result.previous ?? []).map((row) => row.serial);
          const done = await Promise.all(serials.map((serial) => api("/api/revoke", { serial })));
          toast(done.every((item) => item.ok) ? "Старые коды отозваны" : "Отзыв прошёл не полностью", done.every((item) => item.ok) ? "" : "warn");
        });
        return;
      }
      if (result.needsConfirm === "universal") {
        box(
          $("result"),
          `<h3>Универсальный код</h3><p>${esc(result.message)}</p><p class="hint">Нажмите «Выдать универсальный код», если он действительно нужен (выставка, временный компьютер, замена машины на неделю).</p><div class="row"><button class="btn warn" data-action="universal">Выдать универсальный код</button></div>`,
        );
        $("result").querySelector('[data-action="universal"]').addEventListener("click", () => issueConfirmed({ universal: true }));
        return;
      }
      box($("result"), `<h3>Не получилось</h3><p>${esc(result.message)}</p>`, { error: true });
      return;
    }
    renderIssue(result);
    $("issueHint").textContent = "Запись добавлена в журнал выдачи.";
  });

  async function issueConfirmed(extra = {}) {
    const result = await api("/api/issue", issueBody({ confirm: true, ...extra }));
    if (!result.ok) {
      box($("result"), `<h3>Не получилось</h3><p>${esc(result.message)}</p>`, { error: true });
      return;
    }
    renderIssue(result);
  }

  /** Блок со ссылкой на проверочный EXE: копия того же файла, но с другим именем. */
  function renderExeBlock(exe) {
    if (!exe) return "";
    if (!exe.ready) {
      const link = exe.url ? `<p><a class="btn ghost" href="${esc(exe.url)}" target="_blank" rel="noreferrer">Открыть ссылку на EXE</a></p>` : "";
      const rename = exe.url ? `<p class="hint">После скачивания переименуйте файл в <code class="mono">${esc(exe.fileName)}</code> — и код активации будет запрошен заново.</p>` : "";
      return `<h3>Проверочный EXE</h3><p class="hint">${esc(exe.note)}</p>${link}${rename}`;
    }
    const size = (Number(exe.size || 0) / 1024 / 1024).toFixed(0);
    return [
      "<h3>Проверочный EXE</h3>",
      `<p><a class="btn primary" href="${esc(exe.url)}?token=${esc(TOKEN)}">Скачать ${esc(exe.fileName)}</a>`,
      ` <span class="hint">${size} МБ · тот же файл, что «${esc(exe.base)}»</span></p>`,
      `<p class="hint">${esc(exe.note)}</p>`,
    ].join("");
  }

  /** Предупреждения разбора заявки: их обязан видеть владелец, а не лог сервера. */
  function renderConflicts(request) {
    const list = request?.conflicts ?? [];
    if (!list.length) return "";
    return `<p class="hint warn-box"><b>Проверьте заявку:</b></p><ul class="hint">${list.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  }

  function renderIssue(data) {
    const message = `<div class="row"><button class="btn tiny ghost" data-copy-text="${esc(data.buyerMessage)}">Скопировать сообщение покупателю</button>` +
      ` <button class="btn tiny ghost" data-file="${esc(data.agrolic.fileName)}" data-copy-text="${esc(data.agrolic.content)}">Скачать ${esc(data.agrolic.fileName)}</button></div>`;
    box(
      $("result"),
      `<h3>${data.kind === "universal" ? "Универсальный код" : "Персональный код"} · бессрочно</h3>
       ${codeBlock(data.code)}
       ${kv([
         ["Компьютер", data.machine.bound ? `<b class="mono">${esc(data.machine.shortId)}</b> (на другом компьютере не сработает)` : "любой (универсальный код)"],
         ["Серийник", `<span class="mono">${esc(data.serial)}</span> · key-id=${esc(data.keyId)}`],
         ["Проверка", "подпись сверена открытым ключом приложения"],
       ])}
       ${renderConflicts(data.request)}
       ${message}
       <details><summary>Сообщение покупателю</summary><pre>${esc(data.buyerMessage)}</pre></details>
       <details><summary>SMS (короткий вариант)</summary><pre>${esc(data.sms)}</pre></details>
       ${data.revokeNote ? `<p class="hint">${esc(data.revokeNote.message)}</p>` : ""}
       ${data.replaced?.length ? `<p class="hint">Отозваны прежние коды: ${data.replaced.map((row) => `<span class="mono">${esc(row.serialPretty)}</span>`).join(", ")}</p>` : ""}
       ${renderExeBlock(data.exe)}`,
    );
    $("result").querySelectorAll("[data-copy-text]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.file) {
          download(button.dataset.file, button.dataset.copyText);
          toast("Файл сохранён");
          return;
        }
        copy(button.dataset.copyText, "Скопировано");
      });
    });
    if (data.exe?.ready) $("instance").value = data.exe.instance;
  }

  /* ── Проверка кода ────────────────────────────────────────────────────── */

  $("verify").addEventListener("click", async () => {
    const result = await api("/api/verify", { code: $("codeText").value, machineCode: $("verifyMachine").value.trim() });
    if (!result.ok) {
      box($("verifyResult"), `<h3>Код не принят</h3><p class="bad">${esc(result.message)}</p>${result.reason ? `<p class="hint mono">${esc(result.reason)}</p>` : ""}`, {
        error: true,
      });
      return;
    }
    box(
      $("verifyResult"),
      `<h3>Код действителен</h3>${codeBlock(result.code)}
       ${kv([
         ["Продукт", esc(result.license.productName)],
         ["Серийник", `<span class="mono">${esc(result.license.serial)}</span>`],
         ["Ключ", `key-id=${esc(result.license.keyId)}`],
         ["Срок", "бессрочно — даты в коде нет"],
         ["Привязка", result.license.bound ? "персональный (к компьютеру)" : "универсальный"],
         ["Сверка с машиной", esc(result.machine?.verdict ?? "")],
         ["Журнал", esc(result.ledgerNote)],
       ])}`,
    );
  });

  /* ── Проверочный EXE ──────────────────────────────────────────────────── */

  $("makeExeBtn").addEventListener("click", async () => {
    const result = await api("/api/exe", { instance: $("instance").value.trim(), source: $("exeSource").value });
    if (!result.ready) {
      box($("exeResult"), `<h3>EXE не найден</h3><p>${esc(result.note)}</p>${result.url ? `<p><a class="btn ghost" href="${esc(result.url)}" target="_blank" rel="noreferrer">Открыть ссылку</a></p>` : ""}`, { error: true });
      return;
    }
    $("instance").value = result.instance;
    box(
      $("exeResult"),
      `<h3>Готово</h3><p><a class="btn primary" href="${esc(result.url)}?token=${esc(TOKEN)}">Скачать ${esc(result.fileName)}</a> <span class="hint">${(result.size / 1024 / 1024).toFixed(0)} МБ</span></p>
       <p class="hint">Файл лежит в <code class="mono">${esc(result.outDir)}</code>. Запустите его — он попросит код активации, даже если основная копия на этом компьютере уже активирована.</p>
       <pre class="cmd">"\\${esc(result.fileName)}"  →  экран «Активация приложения»  →  код из этой станции</pre>`,
    );
  });

  $("newInstance").addEventListener("click", () => {
    $("instance").value = `t${Date.now().toString(36).slice(-6)}`;
  });

  /* ── Мой ПК ───────────────────────────────────────────────────────────── */

  async function refreshPc() {
    const data = await api("/api/activation");
    const files = (data.files ?? []).length
      ? `<div class="table"><table><thead><tr><th>файл</th><th>что это значит</th></tr></thead><tbody>${(data.files ?? [])
          .map(
            (item) =>
              `<tr><td class="mono">${esc(item.name)}</td><td>${esc(VERDICT_TEXT[item.verdict] ?? item.verdict)}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<p class="hint">Файлов лицензии не найдено → приложение запросит код.</p>`;
    box(
      $("pcBlock"),
      `${kv([
        ["Код компьютера", `<b class="mono">${esc(data.machine?.shortId ?? "")}</b> · источник ${esc(data.machine?.source ?? "?")} (${esc(data.machine?.quality ?? "?")})`],
        ["Состояние", (data.files ?? []).some((item) => !item.instance && item.verdict === "ACTIVE") ? "активировано — код не спрашивается" : "не активировано — код спрашивается"],
        ["Каталоги", `<span class="mono small">${esc((data.dirs ?? []).join(" · "))}</span>`],
      ])}
       ${files}`,
    );
  }

  const VERDICT_TEXT = {
    ACTIVE: "лицензия есть — код не спрашивается",
    FOREIGN_MACHINE: "файл с другого компьютера — код спросится",
    TAMPERED: "поля файла подменены — код спросится",
    DAMAGED: "файл повреждён — код спросится",
    ARCHIVE: "резервная копия или карантин",
  };

  /** Сброс с подтверждением: сначала показываем, какие файлы будут перемещены. */
  async function resetPc(body, label) {
    const preview = await api("/api/reset", { ...body, dryRun: true });
    const list = (preview.changed ?? []).map((item) => item.file).join("\n");
    if (!(preview.changed ?? []).length) {
      toast(preview.message ?? "Сбрасывать нечего: файлов лицензии нет", "warn");
      return;
    }
    if (!confirm(`${label}\n\nБудут перемещены в резервные копии:\n${list}\n\nПриложение снова запросит код активации. Продолжить?`)) return;
    const result = await api("/api/reset", body);
    toast(result.message ?? "Готово");
    refreshPc();
    refreshState();
  }

  $("refreshPc").addEventListener("click", () => refreshPc());
  $("resetPc").addEventListener("click", () => resetPc({ all: false }, "Сбросить основную активацию"));
  $("resetCheck").addEventListener("click", () => resetPc({ all: false, checks: true }, "Сбросить активацию проверочных копий"));

  /* ── Журнал ───────────────────────────────────────────────────────────── */

  let ledgerRows = [];

  async function refreshLedger() {
    const data = await api("/api/ledger");
    ledgerRows = data.rows ?? [];
    $("ledgerCsv").href = `/api/ledger.csv?token=${encodeURIComponent(TOKEN)}`;
    $("footnote").textContent = `Журнал: ${data.file ?? ""}`;
    renderLedger();
  }

  function renderLedger() {
    const query = $("ledgerSearch").value.trim().toLowerCase();
    const rows = ledgerRows.filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query));
    $("ledger").innerHTML = rows.length
      ? `<table><thead><tr><th>когда</th><th>кому</th><th>компьютер</th><th>тип</th><th>серийник</th><th>статус</th><th>код</th><th></th></tr></thead><tbody>${rows
          .map(
            (row) => `<tr>
            <td class="small">${esc(row.issuedAt)}</td>
            <td>${esc(row.name || "—")}${row.phone ? `<div class="small">${esc(row.phone)}</div>` : ""}${row.email ? `<div class="small">${esc(row.email)}</div>` : ""}</td>
            <td class="mono">${esc(row.shortId || "—")}</td>
            <td>${esc(row.kindLabel)}</td>
            <td class="mono small">${esc(row.serialPretty)}</td>
            <td>${row.status === "revoked" ? `<span class="bad">отозван ${esc(row.revokedAt)}</span>` : '<span class="good">действует</span>'}</td>
            <td><button class="btn tiny ghost copy" data-copy="${esc(row.code)}">код</button></td>
            <td>${row.status === "revoked" ? "" : `<button class="btn tiny warn" data-revoke="${esc(row.serial)}" data-confirm="${esc(row.name || "покупателю")}">Отозвать</button>`}</td>
          </tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="hint">Записей нет. Выдайте первый код — он появится здесь.</p>`;
  }

  $("ledgerSearch").addEventListener("input", renderLedger);
  $("ledgerRefresh").addEventListener("click", refreshLedger);

  async function revokeSerial(serial, name) {
    if (!confirm(`Отозвать лицензию ${serial}?\n\nКод перестанет работать в следующей сборке EXE (приложение при каждом запуске проверяет сохранённую лицензию заново).`)) return;
    const result = await api("/api/revoke", { serial });
    toast(result.ok ? `Отозвано. ${result.message ?? ""}` : result.message ?? "Не получилось", result.ok ? "" : "warn");
    refreshLedger();
  }

  /* ── Сводка сверху ────────────────────────────────────────────────────── */

  async function refreshState() {
    const data = await api("/api/state");
    const chips = [
      ["закрытый ключ", data.secret?.available ? "готов к выдаче" : "не найден", data.secret?.available],
      ["открытые ключи", (data.published?.keyIds ?? []).join(", ") || "нет", (data.published?.keyIds ?? []).length > 0],
      ["журнал", `${data.ledger?.total ?? 0} записей`, true],
      ["проект", data.repoLinked ? "связан" : "ищем в data/", data.repoLinked],
      ["активация на этом ПК", data.license?.activated ? "есть" : "нет", true],
    ];
    $("chips").innerHTML = chips
      .map(([label, value, ok]) => `<span class="chip ${ok ? "ok" : "bad"}"><i></i>${esc(label)}: <b>${esc(value)}</b></span>`)
      .join("");

    const select = $("exeSource");
    const sources = data.exe?.sources ?? [];
    select.innerHTML = sources.length
      ? `<option value="">лучший из найденных</option>` + sources.map((item) => `<option value="${esc(item.name)}">${esc(item.name)} · ${(item.size / 1024 / 1024).toFixed(0)} МБ</option>`).join("")
      : `<option value="">EXE не найдены</option>`;
    $("exeList").innerHTML = sources.length
      ? sources.map((item) => `<div class="item"><b class="mono">${esc(item.name)}</b><span>${(item.size / 1024 / 1024).toFixed(1)} МБ · ${esc(item.file)}</span></div>`).join("")
      : `<div class="item"><span>Ни одного AgroPrognoz*.exe рядом нет. Соберите <code>npm run dist:win</code> в проекте приложения или укажите <code>--exe путь</code>.</span></div>`;
    $("exeConfig").textContent = `Каталог проверочных копий: ${data.exe?.outDir ?? ""}. Ссылка для покупателя: ${data.exe?.downloadUrl || "не настроена (--exe-url)"}`;
    if (!$("instance").value && data.nextInstance) $("instance").value = data.nextInstance;
  }

  refreshState();
  refreshPc();
})();
