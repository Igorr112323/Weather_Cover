/**
 * Разбор ввода месяца и подпись месяца (без DOM).
 * Запуск: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fmtMonthRu, parseUserMonth } from "../src/lib/month.js";

describe("подпись месяца", () => {
  it("Месяц с заглавной буквы и год", () => {
    assert.equal(fmtMonthRu("2026-09-01"), "Сентябрь 2026");
    assert.equal(fmtMonthRu("1990-01-15"), "Январь 1990");
    assert.equal(fmtMonthRu("плохо"), "");
  });
});

describe("разбор ввода месяца", () => {
  it("числовые формы", () => {
    assert.deepEqual(parseUserMonth("09.2026"), { ok: true, value: "2026-09-01" });
    assert.deepEqual(parseUserMonth("9.2026"), { ok: true, value: "2026-09-01" });
    assert.deepEqual(parseUserMonth("12/1995"), { ok: true, value: "1995-12-01" });
    assert.deepEqual(parseUserMonth("2001-05"), { ok: true, value: "2001-05-01" });
    assert.deepEqual(parseUserMonth("2001-05-17"), { ok: true, value: "2001-05-01" });
  });

  it("словесные формы", () => {
    assert.deepEqual(parseUserMonth("Сентябрь 2026"), { ok: true, value: "2026-09-01" });
    assert.deepEqual(parseUserMonth("сен 2026"), { ok: true, value: "2026-09-01" });
    assert.deepEqual(parseUserMonth("мая 1999"), { ok: true, value: "1999-05-01" });
  });

  it("ошибки ввода", () => {
    assert.equal(parseUserMonth("").ok, false);
    assert.equal(parseUserMonth("13.2026").ok, false);
    assert.equal(parseUserMonth("0.2026").ok, false);
    assert.equal(parseUserMonth("сентябрь").ok, false);
    assert.equal(parseUserMonth("2026").ok, false);
    assert.equal(parseUserMonth("привет 2026").ok, false);
  });
});
