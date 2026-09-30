// check-staleness.test.ts — proof-of-catch for check-staleness.ts's EXPIRED scan.
//
// Builds a throwaway project tree in the OS temp dir (never inside the repo), runs
// the script against it, and asserts one row per boundary case (AGENTS.md §
// Standards → Boundaries first):
//
//   past bare date          → EXPIRED with the right days-overdue
//   past quoted date+prose  → EXPIRED (quote + trailing colons must not break it)
//   date == today           → silent (the day is still being watched)
//   future date             → silent
//   missing monitoring-until→ NOWINDOW
//   unparseable value       → NOWINDOW
//   status: active w/ date  → silent (EXPIRED is monitor-only)
//   body prose mentioning the field → silent (frontmatter only)
//   --expired-only          → emits no STALE line even with an empty journal dir
//   empty project tree      → no output, exit 0
//
// Plus two regression rows for the STALE scan (each documented at its
// assertion below): a never-mentioned project must not abort the scan, and a
// folder-form journal mention must count as a mention. And one for daylight
// saving: a clock change between a window's end and today must not cost a day.
//
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/check-staleness.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "check-staleness.ts");

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const mkTmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `check-staleness-${tag}.`));
  made.push(d);
  return d;
};

const pad = (n: number): string => String(n).padStart(2, "0");
/** `date -d "<n> days" +%Y-%m-%d` in the local zone, which the script uses too (negative = ago). */
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const TODAY = day(0);
const PAST = day(-10);
const FUTURE = day(10);

// THE SCRIPT CDs TO THE WRITE ROOT IT RESOLVES, not to the caller's cwd, so a
// fixture only gets scanned if it IS that root. CONTEXT_WRITE_ROOT is the
// resolver's hard override and names the fixture at every call site; without it
// the suite would scan the REAL records and every expectation would fail for a
// reason unrelated to the code under test. The fixture is the repo's shape —
// `projects/` and `journal/` straight under its root.
function run(root: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CHECK, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, CONTEXT_WRITE_ROOT: root, ...env },
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.replace(/\n+$/, ""), rc: r.status };
}
const has = (out: string, re: RegExp): boolean => out.split("\n").some((l) => re.test(l));

const FIXTURE = mkTmp("test");
function mk(domain: string, slug: string, frontmatter: string): void {
  const dir = join(FIXTURE, "projects", domain, `2026-01-01_${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `---\n${frontmatter}\n---\n\n# ${slug}\n`);
}
mk("ai", "bare-past", `status: monitor\npriority: high\nmonitoring-until: ${PAST}`);
mk(
  "ai",
  "quoted-past",
  `status: monitor\npriority: high\nmonitoring-until: "${PAST} — prose: with a colon, and ""quotes"" inside."`,
);
mk("ai", "ends-today", `status: monitor\npriority: high\nmonitoring-until: ${TODAY}`);
mk("ai", "future-window", `status: monitor\npriority: high\nmonitoring-until: ${FUTURE} — still watching.`);
mk("ai", "no-field", "status: monitor\npriority: high");
mk("ai", "garbage-date", "status: monitor\npriority: high\nmonitoring-until: sometime next quarter");
mk("ai", "active-with-date", `status: active\npriority: high\nmonitoring-until: ${PAST}`);
mk("ai", "body-mention", `status: monitor\npriority: high\nmonitoring-until: ${FUTURE}`);
appendFileSync(
  join(FIXTURE, "projects/ai/2026-01-01_body-mention/README.md"),
  "\n## Next Steps\n1. `monitoring-until: 2020-01-01` lapsed long ago — this is prose, not a field.\nmonitoring-until: 2020-01-01\n",
);
mkdirSync(join(FIXTURE, "journal"), { recursive: true });

test("check-staleness EXPIRED scan", () => {
  const { out } = run(FIXTURE, ["--expired-only"]);
  assert.ok(
    has(out, new RegExp(`^EXPIRED:ai/bare-past:monitoring-until=${PAST}:days-overdue=10$`)),
    "past bare date flags with days-overdue=10",
  );
  assert.ok(
    has(out, new RegExp(`^EXPIRED:ai/quoted-past:monitoring-until=${PAST}:days-overdue=10$`)),
    "quoted date + prose with colons still parses",
  );
  assert.ok(!has(out, /ends-today/), "window ending today is not overdue");
  assert.ok(!has(out, /future-window/), "future window is silent");
  assert.ok(has(out, /^NOWINDOW:ai\/no-field$/), "missing monitoring-until is NOWINDOW");
  assert.ok(has(out, /^NOWINDOW:ai\/garbage-date$/), "unparseable date is NOWINDOW");
  assert.ok(!has(out, /active-with-date/), "status: active is not scanned for expiry");
  assert.ok(!has(out, /body-mention/), "body prose is not read as frontmatter");
  assert.ok(!has(out, /^STALE:/), "--expired-only emits no STALE rows");
});

// Regression: under `set -euo pipefail` the first project with NO journal
// mention made `grep -l` fail the pipeline and killed the whole scan — it
// printed nothing and exited 1. Both rows below must appear, and the run must
// exit 0.
test("a never-mentioned project does not abort the scan", () => {
  const NEVER = mkTmp("never");
  for (const s of ["aaa-never", "zzz-later"]) {
    mkdirSync(join(NEVER, "projects/ai", `2026-01-01_${s}`), { recursive: true });
    writeFileSync(
      join(NEVER, "projects/ai", `2026-01-01_${s}`, "README.md"),
      "---\nstatus: active\npriority: high\n---\n",
    );
  }
  mkdirSync(join(NEVER, "journal/2020-01-01"), { recursive: true });
  writeFileSync(join(NEVER, "journal/2020-01-01/0900-nothing.md"), "");
  const { out, rc } = run(NEVER);
  assert.equal(rc, 0, `never-mentioned project aborted the scan (rc=${rc}, out='${out}')`);
  assert.ok(has(out, /^STALE:ai\/aaa-never:days-since-last-mention=never$/), `out='${out}'`);
  assert.ok(has(out, /^STALE:ai\/zzz-later:days-since-last-mention=never$/), `out='${out}'`);
});

// Regression: a `\b` slug matcher cannot match the folder form a journal
// actually writes (`projects/x/2026-01-17_my-slug/`) because `_` is a word
// character, so projects written up yesterday reported `never`. `my-slug` must
// be seen in the folder form; `my-slug-extended` must NOT be matched by a search
// for `my-slug`.
test("folder-form mentions and longer slugs", () => {
  const MATCH = mkTmp("match");
  for (const s of ["my-slug", "lonely-slug"]) {
    mkdirSync(join(MATCH, "projects/ai", `2026-01-01_${s}`), { recursive: true });
    writeFileSync(
      join(MATCH, "projects/ai", `2026-01-01_${s}`, "README.md"),
      "---\nstatus: active\npriority: high\n---\n",
    );
  }
  mkdirSync(join(MATCH, "journal", TODAY), { recursive: true });
  writeFileSync(
    join(MATCH, "journal", TODAY, "0900-a-session.md"),
    "Worked on projects/ai/2026-01-01_my-slug/ and on lonely-slug-extended today.\n",
  );
  const { out } = run(MATCH);
  assert.ok(!has(out, /my-slug/), `folder-form mention still read as stale (out='${out}')`);
  assert.ok(
    has(out, /^STALE:ai\/lonely-slug:days-since-last-mention=never$/),
    `'lonely-slug-extended' wrongly counted as a mention of 'lonely-slug' (out='${out}')`,
  );
});

// A daylight-saving change between the window's end and today must not cost a
// day. The day count is checked against the same calendar difference taken in
// UTC, which has no daylight saving. Two fixed dates on either side of a spring
// change, so whichever half of the year today falls in, one of them crosses an
// odd number of changes.
test("a daylight-saving change does not shift days-overdue", () => {
  const ZONE = "America/New_York";
  const DST = mkTmp("dst");
  const dates = ["2020-03-01", "2020-11-15"];
  for (const d of dates) {
    const dir = join(DST, "projects/web", `2020-01-01_win-${d}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `---\nstatus: monitor\nmonitoring-until: ${d}\n---\n`);
  }
  // "Today" in the zone the script runs in: taken in the local zone, it is a
  // different calendar day for the hours when the two zones straddle midnight.
  const todayThere = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());
  const utc = (d: string): number => Date.parse(`${d}T00:00:00Z`) / 1000;
  const { out } = run(DST, ["--expired-only"], { TZ: ZONE });
  for (const d of dates) {
    const want = (utc(todayThere) - utc(d)) / 86400;
    assert.ok(
      has(out, new RegExp(`^EXPIRED:web/win-${d}:monitoring-until=${d}:days-overdue=${want}$`)),
      `days-overdue off by the daylight-saving hour (out='${out}')`,
    );
  }
});

// Empty tree → empty output, exit 0.
test("no projects: empty output, exit 0", () => {
  const EMPTY = mkTmp("empty");
  mkdirSync(join(EMPTY, "projects"), { recursive: true });
  mkdirSync(join(EMPTY, "journal"), { recursive: true });
  const { out, rc } = run(EMPTY, ["--expired-only"]);
  assert.equal(out, "", `no projects: expected empty output, got out='${out}'`);
  assert.equal(rc, 0, `no projects: expected exit 0, got rc=${rc}`);
});
