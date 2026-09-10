/**
 * Календарная арифметика: периоды прогноза, концы месяцев, високосный год.
 * Запуск: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  addMonths,
  computePeriod,
  daysInMonth,
  isLeapYear,
  isValidIsoDate,
  listDates,
  toOrdinal,
  weekdayIndexMonday,
} from "../calculations/date-period.js";

describe("isLeapYear / daysInMonth", () => {
  it("високосные годы по григорианскому правилу", () => {
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(2000), true);
    assert.equal(isLeapYear(1900), false);
    assert.equal(isLeapYear(2023), false);
  });

  it("февраль в високосном и обычном году", () => {
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2023, 2), 28);
    assert.equal(daysInMonth(2024, 1), 31);
    assert.equal(daysInMonth(2024, 4), 30);
  });
});

describe("isValidIsoDate", () => {
  it("принимает корректные даты", () => {
    assert.equal(isValidIsoDate("2024-02-29"), true);
    assert.equal(isValidIsoDate("2026-09-10"), true);
  });

  it("отклоняет некорректные даты", () => {
    assert.equal(isValidIsoDate("2023-02-29"), false);
    assert.equal(isValidIsoDate("2024-13-01"), false);
    assert.equal(isValidIsoDate("2024-04-31"), false);
    assert.equal(isValidIsoDate("10.09.2026"), false);
    assert.equal(isValidIsoDate(""), false);
    assert.equal(isValidIsoDate(null), false);
    assert.equal(isValidIsoDate("2024-2-3"), false);
  });
});

describe("addMonths", () => {
  it("день ограничивается последним днём целевого месяца", () => {
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
    assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
    assert.equal(addMonths("2026-08-31", 6), "2027-02-28");
  });

  it("переходит через год", () => {
    assert.equal(addMonths("2026-10-15", 6), "2027-04-15");
    assert.equal(addMonths("2026-12-01", 3), "2027-03-01");
  });

  it("бросает на некорректной дате", () => {
    assert.throws(() => addMonths("2026-02-30", 1), RangeError);
  });
});

describe("computePeriod", () => {
  it("1 месяц: конец — день перед той же датой следующего месяца", () => {
    assert.deepEqual(computePeriod("2026-09-10", 1), {
      startDate: "2026-09-10",
      endDate: "2026-10-09",
      days: 30,
    });
  });

  it("3 и 6 месяцев", () => {
    assert.deepEqual(computePeriod("2026-09-10", 3).endDate, "2026-12-09");
    assert.deepEqual(computePeriod("2026-09-10", 6).endDate, "2027-03-09");
  });

  it("конец месяца: 31 января + 1 месяц = конец февраля", () => {
    const period = computePeriod("2026-01-31", 1);
    assert.equal(period.endDate, "2026-02-27");
    assert.equal(period.days, 28);
  });

  it("високосный февраль: 29.02.2024 + 1 месяц", () => {
    const period = computePeriod("2024-02-29", 1);
    assert.equal(period.endDate, "2024-03-28");
  });

  it("високосный февраль внутри периода: январь 2024 + 3 месяца", () => {
    const period = computePeriod("2024-01-15", 3);
    assert.equal(period.endDate, "2024-04-14");
    assert.equal(period.days, toOrdinal("2024-04-14") - toOrdinal("2024-01-15") + 1);
  });

  it("отклоняет недопустимые периоды и даты", () => {
    assert.throws(() => computePeriod("2026-09-10", 2), RangeError);
    assert.throws(() => computePeriod("2026-09-10", 12), RangeError);
    assert.throws(() => computePeriod("не дата", 1), RangeError);
  });
});

describe("addDays / listDates / weekday", () => {
  it("addDays считает через границы месяцев и отрицательные сдвиги", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addDays("2024-03-01", -1), "2024-02-29");
    assert.equal(addDays("2026-09-10", 0), "2026-09-10");
  });

  it("listDates возвращает сплошной отрезок без пропусков", () => {
    const dates = listDates("2024-02-28", "2024-03-02");
    assert.deepEqual(dates, ["2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02"]);
  });

  it("weekdayIndexMonday: понедельник — 0, воскресенье — 6", () => {
    // 2026-09-07 — понедельник, 2026-09-13 — воскресенье
    assert.equal(weekdayIndexMonday("2026-09-07"), 0);
    assert.equal(weekdayIndexMonday("2026-09-10"), 3);
    assert.equal(weekdayIndexMonday("2026-09-13"), 6);
  });
});
