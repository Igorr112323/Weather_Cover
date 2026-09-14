/**
 * Проверка встроенной реализации Ed25519 и SHA-512 (station/standalone/src/ed25519.cjs).
 * Запуск: node --test station/tests/ed25519.test.mjs
 *
 * Эта реализация нужна только для браузеров без Ed25519 в WebCrypto (Chrome/Edge
 * до 137, Firefox до 130, Safari до 17 — например, Яндекс.Браузер). Поэтому и
 * проверка одна, но жёсткая: побайтовое совпадение с Node и с WebCrypto. Пока
 * байты совпадают, код, выписанный страницей, принимает приложение, и не важно,
 * каким кодом он подписан.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ed = require(path.join(STATION_ROOT, "standalone", "src", "ed25519.cjs"));

/** Пара ключей Node + её части, которые нужны встроенному коду. */
function pair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    seed: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
    publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
    spki: Buffer.from(spki),
  };
}

describe("SHA-512 внутри страницы", () => {
  it("совпадает с Node на разных длинах", () => {
    for (const size of [0, 1, 5, 55, 63, 64, 111, 128, 200, 1000, 1119]) {
      const data = crypto.randomBytes(size);
      const mine = Buffer.from(ed.sha512(new Uint8Array(data))).toString("hex");
      const node = crypto.createHash("sha512").update(data).digest("hex");
      assert.equal(mine, node, `SHA-512 разошёлся на ${size} байтах`);
    }
  });

  it("совпадает с контрольным значением из FIPS 180-4", () => {
    assert.equal(
      Buffer.from(ed.sha512(new TextEncoder().encode("abc"))).toString("hex"),
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });
});

describe("Ed25519 внутри страницы", () => {
  it("открытый ключ читается из seed так же, как у Node", () => {
    for (let round = 0; round < 4; round += 1) {
      const keys = pair();
      assert.deepEqual(Array.from(ed.publicKeyFromSeed(keys.seed)), Array.from(keys.publicKey), "публичная часть не совпала");
    }
  });

  it("подпись побайтово совпадает с Node и проходит WebCrypto", async () => {
    for (let round = 0; round < 3; round += 1) {
      const keys = pair();
      for (const size of [0, 1, 32, 111, 1080]) {
        const message = new Uint8Array(crypto.randomBytes(size));
        const nodeSig = new Uint8Array(crypto.sign(null, Buffer.from(message), keys.privateKey));
        const mine = ed.sign(keys.seed, message);
        assert.deepEqual(Array.from(mine), Array.from(nodeSig), `подпись разошлась на ${size} байтах`);

        const key = await crypto.subtle.importKey("spki", keys.spki, { name: "Ed25519" }, true, ["verify"]);
        assert.equal(
          await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(mine), Buffer.from(message)),
          true,
          "WebCrypto не принял подпись, поставленную встроенным кодом",
        );
      }
    }
  });

  it("своя проверка принимает чужую подпись и отвергает подделку", () => {
    const keys = pair();
    const other = pair();
    const message = new Uint8Array(crypto.randomBytes(120));
    const signature = ed.sign(keys.seed, message);

    assert.equal(ed.verify(keys.publicKey, signature, message), true, "не прошла своя подпись");
    assert.equal(
      ed.verify(keys.publicKey, new Uint8Array(crypto.sign(null, Buffer.from(message), keys.privateKey)), message),
      true,
      "не прошла подпись Node",
    );

    const broken = Uint8Array.from(signature);
    broken[7] ^= 0x01;
    assert.equal(ed.verify(keys.publicKey, broken, message), false, "прошла испорченная подпись");
    assert.equal(ed.verify(keys.publicKey, signature, new Uint8Array(crypto.randomBytes(120))), false, "прошла подпись к другому сообщению");
    assert.equal(ed.verify(other.publicKey, signature, message), false, "прошла подпись чужим ключом");

    // S >= порядка группы быть не должно (проверка на каноничность подписи).
    const fake = new Uint8Array(64);
    assert.equal(ed.verify(keys.publicKey, fake, message), false, "прошла пустая подпись");
  });

  it("распаковка: либо точка с кривой, либо отказ", () => {
    assert.equal(ed.decompress(new Uint8Array(32).fill(0xff)), null, "y >= p обязан отклоняться");
    // Случайные 32 байта — в основном точки вне кривой. Что распаковалось —
    // обязано вернуться в те же байты: иначе проверка подписи принимала бы лишнее.
    let accepted = 0;
    for (let round = 0; round < 300; round += 1) {
      const bytes = new Uint8Array(crypto.randomBytes(32));
      const point = ed.decompress(bytes);
      if (!point) continue;
      accepted += 1;
      assert.deepEqual(Array.from(ed.compress(point)), Array.from(bytes), "точка не вернулась в те же байты");
    }
    assert.ok(accepted > 0 && accepted < 300, `распаковка принимает всё подряд или ничего: ${accepted}`);
  });

  it("сжатие и распаковка дают исходные байты", () => {
    for (let round = 0; round < 4; round += 1) {
      const keys = pair();
      const point = ed.decompress(keys.publicKey);
      assert.ok(point, "не распаковался настоящий ключ");
      assert.deepEqual(Array.from(ed.compress(point)), Array.from(keys.publicKey), "распаковка/сжатие разъехались");
    }
  });

  it("подпись считается быстро (иначе страница будет висеть)", () => {
    const keys = pair();
    const message = new Uint8Array(1000);
    ed.sign(keys.seed, message); // прогрев: таблицы SHA-512 считаются лениво
    const started = Date.now();
    for (let round = 0; round < 20; round += 1) ed.sign(keys.seed, message);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `20 подписей заняли ${elapsed} мс — слишком медленно для страницы`);
  });
});
