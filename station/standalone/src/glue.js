/* ── браузерная обвязка ─────────────────────────────────────────────────────
 * Подпись кода и проверка подписи идут через WebCrypto (Ed25519), поэтому они
 * async. Всё остальное — формат кода, нагрузка, кандидаты, журнал, разбор
 * заявки — берётся дословно из кода приложения блоком выше, поэтому код,
 * выписанный страницей, принимает приложение.
 *
 * Файл инлайнится в автономную страницу (scripts/build-standalone.mjs) и
 * тестируется без браузера (station/tests/standalone.test.mjs). DOM здесь
 * трогать нельзя.
 */
const AGRO = (() => {
  const core = AGRO_CORE;
  const subtle = globalThis.crypto?.subtle ?? null;

  /** DER-префикс открытого ключа Ed25519 в SPKI (32 байта ключа идут за ним). */
  const SPKI_PREFIX_HEX = "302a300506032b6570032100";
  /** Метка закрытого ключа Ed25519 в PKCS#8: 04 20 <32 байта seed>. */
  const SEED_MARK = "0420";
  /** Встроенный в PKCS#8 открытый ключ: a1 21 03 21 00 <32 байта>. */
  const PUB_MARK = "a121032100";

  /* ── кодирование ───────────────────────────────────────────────────────── */

  function bytesFromBase64(value) {
    const binary = atob(String(value ?? "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function base64FromBytes(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64UrlFromBytes(bytes) {
    return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function bytesFromBase64Url(value) {
    const text = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
    return bytesFromBase64(text + "=".repeat((4 - (text.length % 4)) % 4));
  }

  function hexFromBytes(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function bytesFromHex(value) {
    const hex = String(value ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (!hex || hex.length % 2 === 1) throw new Error("Ожидалась hex-строка чётной длины.");
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }

  /* ── ключи ─────────────────────────────────────────────────────────────── */

  /** Браузер должен поддерживать Ed25519 в WebCrypto (Chrome/Edge 137+, FF 130+, Safari 17+). */
  function ed25519Supported() {
    return Boolean(subtle && typeof subtle.importKey === "function" && typeof subtle.sign === "function");
  }

  /**
   * Поддержка ли алгоритм — этим проверяем наличие функций, но его в браузере
   * может не быть: Ed25519 в WebCrypto появился в Chrome/Edge только в 137
   * (май 2025), в Firefox — в 130, в Safari — в 17. Браузеры на старом Chromium
   * (Яндекс, старые Opera/QQ) отдают функции, а на подписи падают DOMException
   * с ПУСТЫМ сообщением — пользователь видит «не получилось», и непонятно почему.
   * Поэтому отдельная проверка: просим браузер сгенерировать ключ Ed25519.
   */
  let ed25519Probe = null;

  async function ed25519Available() {
    if (!ed25519Supported()) return false;
    if (ed25519Probe === null) {
      try {
        await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
        ed25519Probe = true;
      } catch {
        ed25519Probe = false;
      }
    }
    return ed25519Probe;
  }

  /** Человекочитаемая причина провала подписи (у DOMException часто пусто). */
  function signErrorText(error) {
    const text = String(error?.message ?? "").trim();
    if (text) return text;
    const name = String(error?.name ?? "");
    if (/NotSupported/i.test(name)) return "браузер не поддерживает Ed25519 — нужен Chrome/Edge 137+, Firefox 130+ или Safari 17+";
    if (/Invalid|Data|Syntax/i.test(name)) return "ключ прочитан не целиком: вставляйте privateKey без пропусков и переносов";
    return name || "браузер отказался подписывать без объяснения (чаще всего — нет Ed25519 в WebCrypto)";
  }

  /** PKCS#8 base64 → 32-байтный seed (при возможности — и открытый ключ). */
  function readPkcs8(privateKeyBase64) {
    const hex = hexFromBytes(bytesFromBase64(privateKeyBase64));
    const seedAt = hex.indexOf(SEED_MARK);
    if (seedAt === -1) throw new Error("Похоже, это не PKCS#8 Ed25519 (нет метки 0420).");
    const seed = hex.slice(seedAt + SEED_MARK.length, seedAt + SEED_MARK.length + 64);
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("Не удалось прочитать закрытый ключ: seed короче 32 байт.");
    const publicAt = hex.indexOf(PUB_MARK);
    const publicKey = publicAt === -1 ? "" : hex.slice(publicAt + PUB_MARK.length, publicAt + PUB_MARK.length + 64);
    return { seed: bytesFromHex(seed), publicKey: /^[0-9a-f]{64}$/.test(publicKey) ? bytesFromHex(publicKey) : null };
  }

  /** Открытый ключ (SPKI base64) из закрытого, если PKCS#8 его содержит. */
  function publicFromPrivate(privateKeyBase64) {
    const { publicKey } = readPkcs8(privateKeyBase64);
    return publicKey ? base64FromBytes(bytesFromHex(SPKI_PREFIX_HEX + hexFromBytes(publicKey))) : "";
  }

  /**
   * Проверка пары ключей без доверия к тексту: подписываем 32 байта вызова и
   * сверяем открытым ключом приложения. Так страница отвечает «этот закрытый
   * ключ — тот самый», даже когда PKCS#8 открытого ключа не содержит.
   */
  async function matchKey({ privateKeyBase64, keys = [] } = {}) {
    if (!ed25519Supported()) return { ok: false, message: "Браузер не поддерживает Ed25519." };
    let seed;
    let embedded;
    try {
      ({ seed, publicKey: embedded } = readPkcs8(privateKeyBase64));
    } catch (error) {
      return { ok: false, message: error?.message ?? "Закрытый ключ не читается." };
    }
    const challenge = new Uint8Array(32).map((_, index) => (index * 7 + 11) & 0xff);
    for (const entry of keys) {
      try {
        const x = base64UrlFromBytes(embedded ?? rawPublicFromSpki(entry.publicKey));
        const signingKey = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x, d: base64UrlFromBytes(seed) }, { name: "Ed25519" }, false, ["sign"]);
        const verifyKey = await importVerifyKey(entry.publicKey);
        const signature = await subtle.sign({ name: "Ed25519" }, signingKey, challenge);
        if ((await subtle.verify({ name: "Ed25519" }, verifyKey, signature, challenge)) === true) {
          return { ok: true, keyId: Number(entry.keyId) || 1, label: String(entry.label ?? "") };
        }
      } catch {
        /* этот ключ не подошёл — пробуем следующий */
      }
    }
    return { ok: false, message: "Закрытый ключ не соответствует ни одному открытому ключу приложения." };
  }

  /** Открытый ключ для подписи: явный → из PKCS#8 → из списка по keyId. */
  function publicKeyFor({ publicKeyBase64 = "", embedded = null, keys = [], keyId = 1 } = {}) {
    if (publicKeyBase64) return publicKeyBase64;
    if (embedded) return base64FromBytes(bytesFromHex(SPKI_PREFIX_HEX + hexFromBytes(embedded)));
    const found = keys.find((entry) => (Number(entry.keyId) || 1) === (Number(keyId) || 1)) ?? (keys.length === 1 ? keys[0] : null);
    return found?.publicKey ?? "";
  }

  /** 32 байта открытого ключа из SPKI (или из уже голого ключа). */
  function rawPublicFromSpki(base64) {
    const bytes = bytesFromBase64(base64);
    const hex = hexFromBytes(bytes);
    if (hex.startsWith(SPKI_PREFIX_HEX) && hex.length === SPKI_PREFIX_HEX.length + 64) {
      return bytesFromHex(hex.slice(SPKI_PREFIX_HEX.length));
    }
    if (bytes.length === 32) return bytes;
    throw new Error("Открытый ключ должен быть SPKI Ed25519 (44 байта) или голым ключом (32 байта).");
  }

  async function importSigningKey(privateKeyBase64, publicKeyBase64 = "") {
    if (!ed25519Supported()) throw new Error("Браузер не поддерживает Ed25519 в WebCrypto.");
    const { seed, publicKey } = readPkcs8(privateKeyBase64);
    const x = publicKey ? base64UrlFromBytes(publicKey) : publicKeyBase64 ? base64UrlFromBytes(rawPublicFromSpki(publicKeyBase64)) : "";
    if (!x) throw new Error("Нечем подписать: у закрытого ключа нет открытого — вставьте keys.cjs/JSON с publicKey или добавьте ключ в приложение.");
    return subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x, d: base64UrlFromBytes(seed) }, { name: "Ed25519" }, false, ["sign"]);
  }

  async function importVerifyKey(spkiBase64) {
    if (!ed25519Supported()) throw new Error("Браузер не поддерживает Ed25519 в WebCrypto.");
    return subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: base64UrlFromBytes(rawPublicFromSpki(spkiBase64)) }, { name: "Ed25519" }, true, ["verify"]);
  }

  /**
   * Открытые ключи приложения из чего угодно, что удобно вставить: JSON
   * `{keys:[...]}`, содержимое electron/license/keys.cjs или station/keys.json.
   */
  function parseKeysSource(text) {
    const source = String(text ?? "").trim();
    if (!source) return { ok: false, message: "Пусто: вставьте JSON или содержимое electron/license/keys.cjs." };
    try {
      const parsed = JSON.parse(source);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : [];
      const revokedSerials = Array.isArray(parsed?.revokedSerials) ? parsed.revokedSerials.map((value) => String(value).toLowerCase()) : [];
      if (list.length) return { ok: true, value: { keys: normalizeKeyEntries(list), revokedSerials } };
    } catch {
      /* не JSON — пробуем вычитать из модуля keys.cjs */
    }
    const keys = [];
    const entry = /\{\s*keyId\s*:\s*(\d+)\s*,\s*label\s*:\s*["'`]([^"'`]*)["'`]\s*,\s*publicKey\s*:\s*["'`]([A-Za-z0-9+/=\s]+)["'`]\s*\}/g;
    for (const match of source.matchAll(entry)) {
      keys.push({ keyId: Number(match[1]), label: match[2], publicKey: match[3].replace(/\s+/g, "") });
    }
    const revoked = [];
    const revokedBlock = /revokedSerials\s*:\s*\[([\s\S]*?)\]/.exec(source);
    if (revokedBlock) for (const item of revokedBlock[1].matchAll(/["'`]([0-9a-fA-F]{16})["'`]/g)) revoked.push(item[1].toLowerCase());
    if (!keys.length) return { ok: false, message: "Не нашёл ни одного открытого ключа. Нужен keys.cjs целиком или JSON вида {\"keys\":[…]}." };
    return { ok: true, value: { keys, revokedSerials: revoked } };
  }

  function normalizeKeyEntries(list) {
    return list
      .filter((entry) => entry && typeof entry.publicKey === "string")
      .map((entry) => ({ keyId: Number(entry.keyId) || 1, label: String(entry.label ?? ""), publicKey: entry.publicKey.replace(/\s+/g, "") }));
  }

  /* ── выдача кода ───────────────────────────────────────────────────────── */

  /**
   * Выписывает код активации. Нагрузку собирает та же функция проекта, что и
   * scripts/license-tool.mjs (bindPayload/buildPayload), подпись ставит браузер.
   */
  async function issueCode({ privateKeyBase64, publicKeyBase64 = "", keys = [], keyId = 1, bound = false, shortId = "", serial = "" } = {}) {
    const serialBytes = serial ? bytesFromHex(serial) : undefined;
    const cleanShort = bound ? core.normalizeCodeText(shortId) : "";
    if (bound && cleanShort.length !== 8) throw new Error("Для персонального кода нужен код компьютера из 8 символов.");
    const payload = bound
      ? AGRO_L.bindPayload({ keyId, shortId: cleanShort, serial: serialBytes })
      : core.buildPayload({ keyId, serial: serialBytes, bound: false });
    const { publicKey: embedded } = readPkcs8(privateKeyBase64);
    const signingKey = await importSigningKey(privateKeyBase64, publicKeyFor({ publicKeyBase64, embedded, keys, keyId }));
    const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, signingKey, payload));
    const bytes = new Uint8Array(core.LICENSE_LENGTH);
    bytes.set(payload, 0);
    bytes.set(signature, core.PAYLOAD_LENGTH);
    const parsed = core.parsePayload(payload);
    return { code: core.formatCode(bytes), serialHex: parsed.serialHex, keyId: parsed.keyId, bound: parsed.bound, shortId: cleanShort };
  }

  /* ── проверка кода ─────────────────────────────────────────────────────── */

  /**
   * Полная проверка кода — повтор логики core.verifyCode, но подпись проверяет
   * WebCrypto. Возвращает тот же объект, что и приложение (плюс `message` для
   * человека и `code` — канонический текст).
   */
  async function verifyCode({ code, keys, machineId = "", machineShortId = "", revokedSerials = [] } = {}) {
    const candidates = core.codeCandidates(code);
    if (candidates.length === 0) return reject(core.REJECT.EMPTY);

    const entries = (Array.isArray(keys) ? keys : []).filter((entry) => entry && typeof entry.publicKey === "string");
    if (entries.length === 0) return reject(core.REJECT.UNKNOWN_KEY);

    const publicKeys = [];
    for (const entry of entries) {
      try {
        publicKeys.push({ entry, key: await importVerifyKey(entry.publicKey) });
      } catch {
        /* ключ не читается — как в приложении: его просто нет в списке */
      }
    }
    if (publicKeys.length === 0) return reject(core.REJECT.UNKNOWN_KEY);

    const revoked = new Set([...revokedSerials].map((value) => String(value).toLowerCase()));
    const reasons = new Set();

    for (const candidate of candidates) {
      let bytes;
      try {
        bytes = core.parseCode(candidate);
      } catch (error) {
        reasons.add(error instanceof core.CodeFormatError ? error.reason : core.REJECT.MALFORMED);
        continue;
      }

      const payload = bytes.subarray(0, core.PAYLOAD_LENGTH);
      const signature = bytes.subarray(core.PAYLOAD_LENGTH);

      let license;
      try {
        license = core.parsePayload(payload);
      } catch {
        reasons.add(core.REJECT.LENGTH);
        continue;
      }
      if (license.version !== core.FORMAT_VERSION) {
        reasons.add(core.REJECT.VERSION);
        continue;
      }
      if (license.productId !== core.PRODUCT_ID) {
        reasons.add(core.REJECT.PRODUCT);
        continue;
      }
      if (!license.consistent) {
        reasons.add(core.REJECT.MALFORMED);
        continue;
      }
      if (revoked.has(license.serialHex.toLowerCase())) {
        reasons.add(core.REJECT.REVOKED);
        continue;
      }

      const ordered = [
        ...publicKeys.filter((item) => (item.entry.keyId & 0xff) === license.keyId),
        ...publicKeys.filter((item) => (item.entry.keyId & 0xff) !== license.keyId),
      ];

      let signed = false;
      let matchedKeyId = license.keyId;
      for (const { entry, key } of ordered) {
        try {
          signed = (await subtle.verify({ name: "Ed25519" }, key, signature, payload)) === true;
        } catch {
          signed = false;
        }
        if (signed) {
          matchedKeyId = entry.keyId & 0xff;
          break;
        }
      }
      if (!signed) {
        reasons.add(core.REJECT.SIGNATURE);
        continue;
      }

      if (license.bound) {
        const shortId = core.resolveShortId({ machineId, machineShortId });
        if (!shortId) {
          reasons.add(core.REJECT.MACHINE_UNKNOWN);
          continue;
        }
        if (!core.sameBytes(license.fingerprint, core.fingerprintFromShortId(shortId))) {
          reasons.add(core.REJECT.MACHINE_MISMATCH);
          continue;
        }
      }

      const result = {
        ok: true,
        encoded: core.formatCode(bytes),
        license: {
          version: license.version,
          productId: license.productId,
          productName: core.PRODUCT_NAME,
          keyId: matchedKeyId,
          bound: license.bound,
          serialHex: license.serialHex,
          serial: core.prettySerial(license.serialHex),
          ...core.LICENSE_TERMS,
        },
      };
      return { ...result, code: result.encoded, message: "" };
    }

    return reject(pickReason(reasons));

    // тот же порядок «насколько дал код», что в core.verifyCode
    function pickReason(values) {
      const priority = [
        core.REJECT.MACHINE_MISMATCH,
        core.REJECT.MACHINE_UNKNOWN,
        core.REJECT.REVOKED,
        core.REJECT.SIGNATURE,
        core.REJECT.UNKNOWN_KEY,
        core.REJECT.PRODUCT,
        core.REJECT.VERSION,
        core.REJECT.LENGTH,
        core.REJECT.MALFORMED,
        core.REJECT.EMPTY,
      ];
      for (const reason of priority) if (values.has(reason)) return reason;
      return core.REJECT.MALFORMED;
    }
  }

  function reject(reason) {
    return { ok: false, reason, message: AGRO_MESSAGES.REJECT_MESSAGES[reason] ?? "Код не принят." };
  }

  /* ── отзыв ─────────────────────────────────────────────────────────────── */

  /** Серийник кода в том виде, в каком его читает приложение (hex, 16 символов). */
  function serialOfCode(code) {
    try {
      return { ok: true, serialHex: core.parsePayload(core.parseCode(code).subarray(0, core.PAYLOAD_LENGTH)).serialHex };
    } catch (error) {
      return { ok: false, message: error?.message ?? String(error) };
    }
  }

  /** Список отзыва из текста: hex-строки построчно, плюс tolerate полные коды. */
  function parseRevokedList(text) {
    const serials = new Set();
    const notes = [];
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const oneLine = trimmed.replace(/\s+/g, "");
      if (/^[0-9a-f]{16}$/i.test(oneLine)) {
        serials.add(oneLine.toLowerCase());
        continue;
      }
      const fromCode = serialOfCode(trimmed);
      if (fromCode.ok) serials.add(fromCode.serialHex);
      else notes.push(`Пропущено: «${trimmed.slice(0, 32)}» — ${fromCode.message}`);
    }
    return { serials: [...serials].sort(), notes };
  }

  /* ── заявка покупателя ─────────────────────────────────────────────────── */

  /** Разбор заявки — без пересборки объекта: станция и страница отдают одно и то же. */
  const parseRequest = (text) => AGRO_R.parseActivationRequest(text);

  /** Короткий идентификатор из того, что дали (8 символов или полный 64-hex). */
  function resolveMachine(input) {
    const resolved = core.resolveBindTarget(input);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    return { ok: true, shortId: resolved.shortId, pretty: core.prettyShortId(resolved.shortId) };
  }

  /* ── журнал и тексты покупателю ────────────────────────────────────────── */

  const ledgerParse = (text) => AGRO_L.parseLedger(text);
  const ledgerSerialize = (rows) => AGRO_L.serializeLedger(rows);
  const stamp = () => AGRO_L.ledgerNow();

  function buyerMessage({ name = "", code, pretty = "", serial = "", universal = false } = {}) {
    return AGRO_L.buildBuyerMessage({ name, code, shortId: pretty, serialHex: serial, universal });
  }

  function agrolicContent({ name = "", pretty = "", serial = "", code, universal = false } = {}) {
    return AGRO_L.buildAgrolicContent({ name, code, shortId: pretty, serialHex: serial, universal });
  }

  function agrolicName(serialHex) {
    return AGRO_L.agrolicFileName(serialHex);
  }

  function smsText({ code, pretty = "", universal = false } = {}) {
    return AGRO_L.buildBuyerSms({ code, shortId: pretty, universal });
  }

  return {
    // ядро приложения (дословно) — удобно для отладки и для «Проверки кода»
    ...core,
    // имя файла лицензии в проверочном режиме
    licenseFileNameFor: AGRO_CM.licenseFileNameFor,
    sanitizeInstance: AGRO_CM.sanitizeInstance,
    CHECK_EXE_PREFIX: AGRO_CM.CHECK_EXE_PREFIX,
    LICENSE_FILE_NAME: AGRO_CM.LICENSE_FILE_NAME,
    // журнал и сообщения
    ledgerParse,
    ledgerSerialize,
    LEDGER_COLUMNS: AGRO_L.LEDGER_COLUMNS,
    stamp,
    buyerMessage,
    agrolicContent,
    agrolicName,
    smsText,
    // разбор заявки
    parseRequest,
    resolveMachine,
    // криптография браузера
    ed25519Supported,
    ed25519Available,
    signErrorText,
    publicFromPrivate,
    matchKey,
    issueCode,
    verifyCode,
    serialOfCode,
    parseRevokedList,
    parseKeysSource,
    normalizeKeyEntries,
    // утилиты
    bytesFromBase64,
    base64FromBytes,
    hexFromBytes,
    bytesFromHex,
  };
})();
