/**
 * Проверка личной страницы выдачи кода (`station/personal/moy-klyuch.html`).
 * Запуск: node --test tests/personal.test.mjs   (из каталога station/)
 *
 * Страница намеренно крошечная: поле «что прислал покупатель» → кнопка → поле
 * с кодом. Поэтому и проверок две группы:
 *
 *   1) файл актуален и собран из тех же исходников, что приложение (иначе
 *      страница выдаст код, который EXE не примет);
 *   2) связка «кнопка → подпись → код → проверка ключом приложения» работает на
 *      фиктивном DOM, а чужой/не тот ключ не даёт выдать код молча.
 *
 * Открытые ключи приложения вшиваются из vendor/keys.cjs (копия
 * electron/license/keys.cjs), поэтому в тестах их приходится подменять через
 * localStorage — ровно как это делает владелец, если ключ в проекте сменили.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fakePage } from "./fake-page.mjs";

const require = createRequire(import.meta.url);
const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(STATION_ROOT, "..");
const HTML_FILE = path.join(STATION_ROOT, "personal", "moy-klyuch.html");
const TEMPLATE = path.join(STATION_ROOT, "personal", "template.html");

const builder = await import(pathToFileURL(path.join(STATION_ROOT, "scripts", "build-standalone.mjs")).href);
const core = require(path.join(STATION_ROOT, "vendor", "core.cjs"));
const appKeys = require(path.join(STATION_ROOT, "vendor", "keys.cjs"));

const PAGE_SCRIPT = () => /<script>([\s\S]*)<\/script>/.exec(fs.readFileSync(HTML_FILE, "utf8"))[1];

/* Тестовая пара ключей: страница сверяет код с списком из localStorage,
   поэтому выдача проверяется на реальном алгоритме, а не на боевом ключе. */
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const SPKI_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PKCS8_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const TEST_KEYS = [{ keyId: 1, label: "тест", publicKey: SPKI_B64 }];

const MACHINE_HEX = "1c722cc7bfe23bfae5f2ba334bc6c420d76caed935cb65ff71b4d9c1f0e8bc78";
const SHORT = core.machineShortId(MACHINE_HEX);
const PRETTY = core.prettyShortId(SHORT);

describe("личная страница собрана из исходников проекта", () => {
  it("шаблон не содержит переписанной руками криптографии и формата кода", () => {
    const template = fs.readFileSync(TEMPLATE, "utf8");
    assert.ok(template.includes("<!-- @BUNDLE@ -->"), "в шаблоне должна быть метка сборки @BUNDLE@");
    assert.ok(!/function buildPayload|function parsePayload|Crockford/.test(template), "формат кода и подпись берутся из бандла, а не из шаблона");
  });

  it("готовый файл совпадает со сборкой (не забыли npm run station:standalone)", () => {
    assert.equal(fs.readFileSync(HTML_FILE, "utf8"), builder.buildPersonal(), "файл устарел: выполните npm run station:standalone");
  });

  it("открытые ключи приложения вшиты копией из vendor/keys.cjs", () => {
    const bundle = builder.buildBundle({ indent: "" });
    assert.ok(bundle.includes("const AGRO_APP_KEYS ="), "бандл не отдаёт ключи приложения странице");
    const injected = JSON.parse(/const AGRO_APP_KEYS = (\{.*\});/.exec(bundle)[1]);
    assert.deepEqual(injected, { keys: appKeys.keys, revokedSerials: appKeys.revokedSerials }, "в страницах не тот список ключей, что у приложения");
  });

  it("в странице из репозитория ключ НЕ вшит", () => {
    // Иначе закрытый ключ утёк бы в публичный репозиторий вместе с файлом.
    const text = fs.readFileSync(HTML_FILE, "utf8");
    assert.ok(text.includes('const BAKED_SECRET = "";'), "в репозиторий должен попадать файл с пустым BAKED_SECRET");
    assert.ok(!text.includes(["MC4CAQAw", "BQYDK2Vw"].join(""), "в файле из git не должно быть закрытого ключа"));
  });

  it("страница не ходит в сеть и не содержит закрытого ключа", () => {
    const text = fs.readFileSync(HTML_FILE, "utf8");
    const script = PAGE_SCRIPT();
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|import\(/.test(script), "страница не должна делать сетевых запросов");
    assert.ok(!script.includes("</script"), "в коде встретился </script> — HTML сломается");
    assert.ok(!script.includes("<!--"), "последовательность «<!--» внутри скрипта опасна для парсера");
    assert.ok(!text.includes(["MC4CAQAw", "BQYDK2Vw"].join(""), "в файле не должно быть метки PKCS#8 закрытого ключа"));
    assert.ok(!/privateKey"\s*:\s*"[A-Za-z0-9+/=]{40,}/.test(text), "в файл не должен попадать закрытый ключ");
  });

  it("разметка и скрипт согласованы: интерфейс — два поля и одна кнопка", () => {
    const markup = fs.readFileSync(HTML_FILE, "utf8").slice(0, fs.readFileSync(HTML_FILE, "utf8").indexOf("<script>"));
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const used = new Set([...PAGE_SCRIPT().matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
    assert.deepEqual([...used].filter((id) => !ids.has(id)), [], "скрипт обращается к элементам, которых нет в разметке");
    // Основное действие одно; остальные кнопки — только про ключ (скрытый блок).
    assert.equal((markup.match(/<button/g) ?? []).length, 4, "на экране должно быть 4 кнопки: выдача + три про ключ");
    assert.ok(markup.includes('id="go"'), "нет кнопки «Получить код активации»");
    assert.ok(/<textarea id="out"[^>]*readonly/.test(markup), "поле с кодом активации должно быть только для чтения");
    assert.ok(markup.includes('id="keybox"'), "нет блока для закрытого ключа");
  });
});

describe("личная страница выдаёт код, который принимает приложение", () => {
  function page({ keys = true, secret = true } = {}) {
    const dom = fakePage(PAGE_SCRIPT());
    if (keys) dom.storage.set("agro.personal.keys", JSON.stringify({ keys: TEST_KEYS, revokedSerials: [] }));
    if (secret) {
      dom.set("key", JSON.stringify({ keyId: 1, label: "тест", privateKey: PKCS8_B64, publicKey: SPKI_B64 }));
      void dom.click("saveKey"); // обработчик синхронный: ключ лежит в localStorage сразу
    }
    return dom;
  }

  it("заявка покупателя → код в поле результата", async () => {
    const dom = page();
    dom.set("src", `Здравствуйте, программа просит код.\nКод компьютера: ${PRETTY}\n${MACHINE_HEX}\nИван`);
    await dom.click("go");
    const code = dom.get("out").value;
    assert.match(code, /^AGRO-/, `код не выдан: ${dom.get("msg").textContent}`);
    // узкое место: код должен принимать тот же код, что и EXE
    const check = core.verifyCode({ code, keys: TEST_KEYS, machineShortId: SHORT });
    assert.equal(check.ok, true, `Node-ядро не приняло код страницы: ${JSON.stringify(check)}`);
    assert.match(dom.get("msg").textContent, new RegExp(PRETTY), "в ответе нет кода компьютера, для которого выдан ключ");
    dom.close();
  });

  it("голый код компьютера (XXXX-XXXX) тоже принимается", async () => {
    const dom = page();
    dom.set("src", PRETTY);
    await dom.click("go");
    assert.match(dom.get("out").value, /^AGRO-/);
    dom.close();
  });

  it("повторная выдача на тот же компьютер помечена в ответе", async () => {
    const dom = page();
    dom.set("src", PRETTY);
    await dom.click("go");
    const first = dom.get("out").value;
    await dom.click("go");
    assert.match(dom.get("msg").textContent, /уже был выдан|уже был/, "повторная выдача не должна быть незаметной");
    assert.notEqual(dom.get("out").value, first, "серийник у повторной выдачи обязан быть новым");
    dom.close();
  });

  it("без закрытого ключа страница просит ключ и ничего не выдаёт", async () => {
    const dom = page({ secret: false });
    dom.set("src", PRETTY);
    await dom.click("go");
    assert.equal(dom.get("out").value, "");
    assert.match(dom.get("msg").textContent, /ключ/i, "страница не объяснила, что нужен ключ");
    assert.equal(dom.get("keybox").hidden, false, "блок с ключом должен открыться сам");
    dom.close();
  });

  it("ключ от другого набора не выдаёт код молча", async () => {
    // Список ключей — боевой (вшитый), а подпись ставим тестовым ключом.
    const dom = page({ keys: false });
    dom.set("src", PRETTY);
    await dom.click("go");
    assert.equal(dom.get("out").value, "", "код не должен появляться, если его не принимает ключ приложения");
    assert.match(dom.get("msg").textContent, /не принят|не тот|другого набора/i, `нет объяснения отказа: ${dom.get("msg").textContent}`);
    dom.close();
  });

  it("мусор вместо кода компьютера — честная подсказка", async () => {
    const dom = page();
    dom.set("src", "привет, не работает программа, помоги пожалуйста");
    await dom.click("go");
    assert.equal(dom.get("out").value, "");
    assert.match(dom.get("msg").textContent, /код компьютера|идентификатор/i);
    dom.close();
  });

  it("образец из подсказки вместо ключа объясняется по-человечески", async () => {
    // Реальная жалоба: вставили пример с «…» из документации — WebCrypto падал
    // с «characters outside of the Latin1 range», что ничего не объясняет.
    const dom = fakePage(PAGE_SCRIPT());
    dom.set("key", '{ "keys": [ { "keyId": 2, "privateKey": "MC4CAQAw…", "publicKey": "MCowBQY…" } ] }');
    await dom.click("saveKey");
    assert.match(dom.get("msg").textContent, /образец из подсказки|не ключ/, dom.get("msg").textContent);
    assert.equal(dom.storage.get("agro.personal.secret") ?? "", "", "образец нельзя сохранять как ключ");

    dom.set("src", PRETTY);
    await dom.click("go");
    assert.equal(dom.get("out").value, "");
    assert.doesNotMatch(dom.get("msg").textContent, /Latin1|atob/i, "техническая ошибка WebCrypto пользователю не показывается");
    dom.close();
  });

  it("код компьютера вместо ключа — сказано, куда его на самом деле", async () => {
    // Реальный случай: в поле ключа оказалась 64-символьная hex-строка (её
    // скопировали из подсказки про контрольную сумму файла).
    const dom = fakePage(PAGE_SCRIPT());
    dom.set("key", "603afb3b95a53615ea5f0967fd2aaa421a11687dfa86c6a404f1d3c07244cf1e");
    await dom.click("saveKey");
    const msg = dom.get("msg").textContent;
    assert.match(msg, /шестнадцатеричн|код компьютера|контрольн/i, msg);
    assert.match(msg, /верхн|заявк|не закрытый ключ/i, `не сказано, что это не ключ: ${msg}`);
    assert.equal(dom.get("out").value, "", "код выдавать нечем");
    assert.equal(dom.storage.get("agro.personal.secret") ?? "", "", "такое нельзя сохранять как ключ");
    dom.close();
  });

  it("разорванный переносом полный идентификатор разбирается", async () => {
    const dom = fakePage(PAGE_SCRIPT());
    dom.storage.set("agro.personal.keys", JSON.stringify({ keys: TEST_KEYS, revokedSerials: [] }));
    dom.set("key", JSON.stringify({ keyId: 1, privateKey: PKCS8_B64, publicKey: SPKI_B64 }));
    await dom.click("saveKey");
    const hex = MACHINE_HEX;
    dom.set("src", `S5HX-XRMK\n(${hex.slice(0, 40)}\n${hex.slice(40)})`);
    await dom.click("go");
    const code = dom.get("out").value;
    assert.match(code, /^AGRO-/, `не выдан код: ${dom.get("msg").textContent}`);
    const check = core.verifyCode({ code, keys: TEST_KEYS, machineShortId: SHORT });
    assert.equal(check.ok, true, `привязка не совпала с полным идентификатором: ${JSON.stringify(check)}`);
    dom.close();
  });

  it("ключ вставляется и целиком файлом, и одной строкой privateKey", async () => {
    const entry = JSON.stringify({ keyId: 1, privateKey: PKCS8_B64, publicKey: SPKI_B64 });
    for (const pasted of [entry, PKCS8_B64, `  ${entry}\n\n`]) {
      const dom = fakePage(PAGE_SCRIPT());
      dom.storage.set("agro.personal.keys", JSON.stringify({ keys: TEST_KEYS, revokedSerials: [] }));
      dom.set("key", pasted);
      await dom.click("saveKey");
      assert.match(dom.get("msg").textContent, /сохранён/i, `не принят вариант вставки: ${pasted.slice(0, 24)}`);
      dom.set("src", PRETTY);
      await dom.click("go");
      assert.match(dom.get("out").value, /^AGRO-/, `не выдан код для варианта: ${pasted.slice(0, 24)}`);
      dom.close();
    }
  });

  it("клик по полю с кодом копирует его", async () => {
    const dom = page();
    dom.set("src", PRETTY);
    await dom.click("go");
    const value = dom.get("out").value;
    assert.ok(value.startsWith("AGRO-"), "клик копировал бы пустое поле");
    // Сетевой буфер в фиктивном DOM не проверяем: важен ответ на действие.
    await dom.click("out");
    assert.match(dom.get("msg").textContent, /скопирован|Ctrl\+C/, "клик по полю с кодом не отреагировал");
    dom.close();
  });
});

/* ─────────────────── страница с вшитым ключом (license:page) ─────────────── */

const personalBuilder = await import(pathToFileURL(path.join(STATION_ROOT, "scripts", "build-personal.mjs")).href);

describe("сборка страницы с вшитым ключом", () => {
  const secretFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agro-key-")), "license-key.json");
  fs.writeFileSync(
    secretFile,
    JSON.stringify({ keys: [{ keyId: 1, label: "тест", privateKey: PKCS8_B64, publicKey: SPKI_B64 }] }),
    "utf8",
  );

  it("ключ сверяется с electron/license/keys.cjs и не принимается чужой", () => {
    // Тестовый ключ с key-id=1 не совпадает с боевым publicKey из keys.cjs.
    assert.throws(() => personalBuilder.readKeyEntry(secretFile, 1), /не совпадает/);
    assert.throws(() => personalBuilder.readKeyEntry(secretFile, 7), /нет ключа key-id=7/);
    assert.throws(() => personalBuilder.readKeyEntry(path.join(STATION_ROOT, "нет-такого.json"), 0), /нет файла ключа/);
  });

  it("вшивка заменяет метку и страница остаётся пригодной", () => {
    const entry = { keyId: 1, privateKey: PKCS8_B64, publicKey: SPKI_B64 };
    const baked = personalBuilder.bake(builder.buildPersonal(), entry);
    assert.ok(baked.includes("const BAKED_SECRET = "), "метка не заменена");
    assert.ok(!baked.includes('const BAKED_SECRET = "";'), "пустая метка осталась");
    assert.ok(baked.includes(PKCS8_B64), "ключ не вшился");
    assert.ok(personalBuilder.stripComments(baked).length < baked.length, "зачистка не сократила файл");
  });

  it("в напечатанном файле поля для ключа нет вовсе, и код всё равно выдаётся", async () => {
    const entry = { keyId: 1, privateKey: PKCS8_B64, publicKey: SPKI_B64 };
    const page = personalBuilder.stripComments(personalBuilder.bake(builder.buildPersonal(), entry));

    // Ни разметки, ни обработчиков, ни текстов про поле ключа.
    for (const trace of personalBuilder.KEYUI_TRACES) {
      assert.ok(!page.includes(trace), `в файле остался след блока ключа: ${trace}`);
    }
    assert.equal((page.match(/<textarea/g) ?? []).length, 2, "полей ввода должно быть ровно два");
    assert.equal((page.match(/<button/g) ?? []).length, 1, "кнопка на экране должна быть одна");

    const dom = fakePage(/<script>([\s\S]*)<\/script>/.exec(page)[1]);
    // Открытые ключи приложения подменяем на тестовые — как это делает владелец,
    // если ключ в проекте сменили, а страницу не пересобирают.
    dom.storage.set("agro.personal.keys", JSON.stringify({ keys: TEST_KEYS, revokedSerials: [] }));
    dom.set("src", `Код компьютера: ${PRETTY} (${MACHINE_HEX})`);
    await dom.click("go");
    const code = dom.get("out").value;
    assert.match(code, /^AGRO-/, `нет кода: ${dom.get("msg").textContent}`);
    const check = core.verifyCode({ code, keys: TEST_KEYS, machineShortId: SHORT });
    assert.equal(check.ok, true, `ядро приложения не приняло код: ${JSON.stringify(check)}`);
    // Повторный клик на той же странице выдаёт другой серийник, но валидный код.
    await dom.click("go");
    assert.notEqual(dom.get("out").value, code, "повторная выдача обязана давать новый код");
    dom.close();
  });

  it("голая строка privateKey: keyId берётся из списка приложения", async () => {
    // Раньше ключ по умолчанию считался keyId 1 — и код подписывался не тем
    // открытым ключом, а страница потом не могла объяснить отказ.
    const dom = fakePage(PAGE_SCRIPT());
    dom.storage.set("agro.personal.keys", JSON.stringify({ keys: [{ keyId: 7, label: "магазин", publicKey: SPKI_B64 }], revokedSerials: [] }));
    dom.set("key", PKCS8_B64);
    await dom.click("saveKey");
    dom.set("src", PRETTY);
    await dom.click("go");

    const code = dom.get("out").value;
    assert.match(code, /^AGRO-/, `код не выдан: ${dom.get("msg").textContent}`);
    const check = core.verifyCode({ code, keys: [{ keyId: 7, publicKey: SPKI_B64 }], machineShortId: SHORT });
    assert.equal(check.ok, true, `приложение не приняло код: ${JSON.stringify(check)}`);
    assert.match(dom.get("msg").textContent, /ключ key-id=7/, "не сказано, каким ключом выдан код");
    dom.close();
  });

  it("браузер без Ed25519 в WebCrypto всё равно выдаёт код", async () => {
    // Реальная жалоба: на старом Chromium (Яндекс.Браузер) WebCrypto не знает
    // алгоритм Ed25519 и бросает DOMException с ПУСТЫМ сообщением — страница
    // печатала «Не получилось подписать: » без причины. Теперь подпись ставит
    // встроенный в страницу код, и выдача не зависит от браузера.
    const broken = async () => {
      throw Object.assign(new Error(""), { name: "NotSupportedError" });
    };
    const dom = fakePage(PAGE_SCRIPT(), {
      crypto: { subtle: { importKey: broken, sign: broken, verify: broken, generateKey: broken }, getRandomValues: (array) => array },
    });
    dom.storage.set("agro.personal.keys", JSON.stringify({ keys: TEST_KEYS, revokedSerials: [] }));
    dom.set("key", PKCS8_B64);
    await dom.click("saveKey");
    dom.set("src", PRETTY);
    await dom.click("go");

    const code = dom.get("out").value;
    assert.match(code, /^AGRO-/, `без браузерной подписи код не выдан: ${dom.get("msg").textContent}`);
    const check = core.verifyCode({ code, keys: TEST_KEYS, machineShortId: SHORT });
    assert.equal(check.ok, true, `приложение не приняло код, подписанный встроенным кодом: ${JSON.stringify(check)}`);
    dom.close();
  });

  it("браузер вовсе без WebCrypto тоже выдаёт код", async () => {
    // Полностью отключаем subtle: страница обязана подписать встроенным кодом,
    // а не упасть на пустом месте (именно так и было в старых Chromium).
    const dom = fakePage(PAGE_SCRIPT(), { crypto: { getRandomValues: (array) => array } });
    dom.storage.set("agro.personal.keys", JSON.stringify({ keys: TEST_KEYS, revokedSerials: [] }));
    dom.set("key", JSON.stringify({ keyId: 1, privateKey: PKCS8_B64, publicKey: SPKI_B64 }));
    await dom.click("saveKey");
    dom.set("src", PRETTY);
    await dom.click("go");

    const code = dom.get("out").value;
    assert.match(code, /^AGRO-/, `без subtle код не выдан: ${dom.get("msg").textContent}`);
    const check = core.verifyCode({ code, keys: TEST_KEYS, machineShortId: SHORT });
    assert.equal(check.ok, true, `приложение не приняло код: ${JSON.stringify(check)}`);
    dom.close();
  });

  it("совсем древний браузер (без BigInt) получает объяснение, а не пустоту", async () => {
    const dom = fakePage(PAGE_SCRIPT(), { BigInt: undefined });
    dom.set("key", PKCS8_B64);
    await dom.click("saveKey");
    dom.set("src", PRETTY);
    await dom.click("go");
    const msg = dom.get("msg").textContent;
    assert.equal(dom.get("out").value, "", "без BigInt подписи быть не должно");
    assert.match(msg, /BigInt/, `нет слова про BigInt: ${msg}`);
    assert.match(msg, /license:studio/, "не предложена выдача на Node");
    assert.ok(!/:\s*$/.test(msg), `сообщение обрывается: ${msg}`);
    dom.close();
  });
});
