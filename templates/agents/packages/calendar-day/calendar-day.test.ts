// calendar-day.test.ts — isCalendarDay answers "does the calendar have this
// YYYY-MM-DD", on every boundary the copies it replaced disagreed about.
//
// Run: node --experimental-strip-types --test packages/calendar-day/calendar-day.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { isCalendarDay } from "./calendar-day.ts";

test("empty and non-string values are not days, and do not throw", () => {
  for (const v of ["", undefined, null, 20260101]) {
    assert.equal(isCalendarDay(v), false, String(v));
  }
});

test("a leap day in a leap year is a day", () => {
  assert.equal(isCalendarDay("2024-02-29"), true);
});

test("a day the month does not have is refused", () => {
  for (const bad of ["2026-02-29", "2026-02-31", "2026-11-99"]) {
    assert.equal(isCalendarDay(bad), false, bad);
  }
});

test("month 13 is refused without throwing", () => {
  assert.doesNotThrow(() => isCalendarDay("2026-13-01"));
  assert.equal(isCalendarDay("2026-13-01"), false);
});

test("the last and first days of the four-digit range are days", () => {
  assert.equal(isCalendarDay("9999-12-31"), true);
  assert.equal(isCalendarDay("0000-01-01"), true);
});

test("a day in years 0000-0099 is a day, not shifted to 19xx", () => {
  assert.equal(isCalendarDay("0099-01-02"), true);
});

test("anything but exactly YYYY-MM-DD is refused", () => {
  for (const bad of ["+02026-01-01", "2026-1-01", " 2026-01-01", "2026-01-01T00:00:00Z"]) {
    assert.equal(isCalendarDay(bad), false, bad);
  }
});
