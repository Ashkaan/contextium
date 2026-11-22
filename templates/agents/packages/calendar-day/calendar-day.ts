// packages/calendar-day — does a YYYY-MM-DD string name a day the calendar has?
//
// WHY. The same check was written out by hand in some sixty places across the
// repo — apps, packages, integrations, skills, the toolchain and project
// scripts — in two forms that disagreed. One parses the string as midnight UTC
// and checks that it prints back the same; the other builds the day with
// `Date.UTC(y, m - 1, d)` and compares the parts. `Date.UTC` maps years 0–99
// to 1900–1999, so that form refused `0099-01-02` while the first accepted it,
// and two scripts judging the same date disagreed. This is the one rule now.
//
// THE RULE. True only for a string of exactly four digits, dash, two digits,
// dash, two digits, which `new Date(`${s}T00:00:00Z`)` parses to a valid time
// that prints back as the same ten characters. So `2024-02-29` is a day,
// `2026-02-29`, `2026-02-31` and `2026-13-01` are not, and every year from
// `0000` to `9999` is in range. It never throws: an invalid month makes an
// Invalid Date, whose `toISOString()` would throw, so validity is checked
// first. It accepts any value, and anything not a string is not a day.
//
// It returns a plain boolean, not a `s is string` type guard: a false result
// must not tell TypeScript the value is not a string, because `2026-02-31` is a
// string that fails.
//
// A caller that wants more — a plausible year range, a timestamp with a time
// part, `undefined` allowed, a named error — keeps that in its own wrapper and
// asks this for the day.
//
// Consumers: .agents/skills/close/scripts/roadmap.ts, corrections.ts,
// .agents/skills/project/scripts/check-staleness.ts and
// .agents/checks/check-decision-records.ts.
//
// Import (from an app's src/lib/):
//   import { isCalendarDay } from "../../../../../packages/calendar-day/calendar-day.ts";

const DAY_FORM = /^\d{4}-\d{2}-\d{2}$/;

/** True when `s` is a `YYYY-MM-DD` string naming a day the calendar has. Never throws. */
export function isCalendarDay(s: unknown): boolean {
  if (typeof s !== "string" || !DAY_FORM.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}
