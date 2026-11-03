// project-status.test.ts — runs project-status.ts as a program over fixture
// projects, one per status, and the boundary cases around them.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/project-status.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "project-status.ts");
const TMP = mkdtempSync(join(tmpdir(), "project-status-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HDR = `| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|`;

function proj(folder: string, front: string[], rows: string[] | null = null): string {
  const d = join(TMP, "projects/sales", folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "README.md"), `---\n${front.join("\n")}\n---\n# p\n`);
  if (rows) writeFileSync(join(d, "ROADMAP.md"), `# Roadmap: t\n\n${HDR}\n${rows.join("\n")}\n`);
  return d;
}
function run(d: string): { rc: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, d], { encoding: "utf8" });
  return { rc: r.status, out: (r.stdout ?? "").replace(/\n$/, ""), err: r.stderr ?? "" };
}

test("monitor with planned rows behind the watch: names monitor, full row, count", () => {
  const d = proj(
    "2026-08-12_site-move",
    ["status: monitor", 'monitoring-until: "2026-10-30 — R2: The design review sets the next…"'],
    [
      "| R1 | a | i | s | R2 | planned | manual |",
      "| R2 | The design review sets the next changes | i | s | — | blocked: 2026-10-30 the meeting | — |",
      "| R3 | c | i | s | R2 | planned | manual |",
    ],
  );
  assert.equal(
    run(d).out,
    "site-move is **in monitor** until Fri, Oct 30, watching R2: The design review sets the next changes. 2 planned steps wait on it.",
  );
});

test("monitor with one planned row: singular", () => {
  const d = proj(
    "2026-08-13_one",
    ["status: monitor", 'monitoring-until: "2026-10-30 — R2: watch"'],
    ["| R1 | a | i | s | R2 | planned | manual |", "| R2 | watch | i | s | — | blocked: 2026-10-30 x | — |"],
  );
  assert.equal(run(d).out, "one is **in monitor** until Fri, Oct 30, watching R2: watch. 1 planned step waits on it.");
});

test("monitor with nothing left behind the watch: names monitor, no count", () => {
  const d = proj(
    "2026-08-14_watched",
    ["status: monitor", 'monitoring-until: "2026-11-02 — R1: first run posts a digest"'],
    ["| R1 | first run posts a digest | i | s | — | blocked: 2026-11-02 x | — |"],
  );
  assert.equal(run(d).out, "watched is **in monitor** until Mon, Nov 2, watching R1: first run posts a digest.");
});

test("monitor with no date: names no date, never fails", () => {
  const d = proj("2026-08-15_nodate", ["status: monitor"], null);
  assert.equal(run(d).out, "nodate is **in monitor**.");
});

test("monitor with other watches beside the named one: counts them, implies no order", () => {
  const d = proj(
    "2026-08-14_meeting",
    ["status: monitor", 'monitoring-until: "2026-10-30 — R4: schedule the meeting"'],
    [
      "| R3 | changelog line | i | s | — | closed: done | — |",
      "| R4 | schedule the meeting | i | s | — | blocked: 2026-10-30 the release manager books it | — |",
      "| R5 | four test devices | i | s | R4 | blocked: 2026-10-30 the devices arrive | — |",
      "| R6 | the meeting, then freeze | i | s | R5 | blocked: 2026-10-30 check and freeze | — |",
    ],
  );
  assert.equal(
    run(d).out,
    "meeting is **in monitor** until Fri, Oct 30, watching R4: schedule the meeting. 2 other steps are also being watched.",
  );
});

test("active: the next row's full Sub-feature, not the README's cut copy", () => {
  const d = proj(
    "2026-08-16_portal",
    ["status: active", 'next: "R4: a sales page with a feature list that runs well past…"'],
    ["| R4 | a sales page with a feature list that runs well past sixty characters | i | s | — | planned | — |"],
  );
  assert.equal(
    run(d).out,
    "portal is **active**. Next is R4: a sales page with a feature list that runs well past sixty characters.",
  );
});

test("active with no roadmap and no next: status alone", () => {
  const d = proj("2026-08-17_bare", ["status: active"], null);
  assert.equal(run(d).out, "bare is **active**.");
});

test("blocked: the row and what it waits on, both whole", () => {
  const d = proj(
    "2026-08-18_waiting",
    ["status: blocked", 'blocked-on: "R7: each form used once for…"'],
    ["| R7 | retire-skills | i | s | — | blocked: each form used once for real | — |"],
  );
  assert.equal(run(d).out, "waiting is **blocked** on R7, retire-skills. Waiting for: each form used once for real.");
});

test("blocked until a date: the day it starts again, then what it waits on", () => {
  const d = proj(
    "2026-08-18_paused",
    ["status: blocked", 'blocked-on: "R3: until 2026-11-10 the quarter closes"'],
    ["| R3 | the Q4 report | i | s | — | blocked: until 2026-11-10 the quarter closes | — |"],
  );
  assert.equal(
    run(d).out,
    "paused is **blocked** on R3, the Q4 report, until Tue, Nov 10, when it can be unblocked through /project triage blocked. Waiting for: the quarter closes.",
  );
  const bare = proj(
    "2026-08-18_bare-until",
    ["status: blocked", 'blocked-on: "R3: until 2026-11-10"'],
    ["| R3 | the Q4 report | i | s | — | blocked: until 2026-11-10 | — |"],
  );
  assert.equal(
    run(bare).out,
    "bare-until is **blocked** on R3, the Q4 report, until Tue, Nov 10, when it can be unblocked through /project triage blocked.",
  );
});

test("blocked-on naming no row: the README's words", () => {
  const d = proj("2026-08-19_vendor", ["status: blocked", "blocked-on: vendor API access"], null);
  assert.equal(run(d).out, "vendor is **blocked** on vendor API access.");
});

test("completed", () => {
  const d = proj("2026-08-20_done", ["status: completed"], null);
  assert.equal(run(d).out, "done is **complete**.");
});

test("a ROADMAP.md roadmap.ts cannot read falls back to the README", () => {
  const d = proj("2026-08-21_broken", ["status: active", 'next: "R1: thing"'], null);
  writeFileSync(join(d, "ROADMAP.md"), "not a table\n");
  assert.equal(run(d).out, "broken is **active**. Next is R1: thing.");
});

test("no README: exit 2 with the reason", () => {
  const d = join(TMP, "projects/sales/2026-08-22_empty");
  mkdirSync(d, { recursive: true });
  const r = run(d);
  assert.equal(r.rc, 2);
  assert.match(r.err, /no README\.md/);
});

test("no argument: usage, exit 2", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("monitor with one independent watch and planned work: both counts, singular", () => {
  const d = proj(
    "2026-08-23_beta-launch",
    ["status: monitor", 'monitoring-until: "2026-12-01 — R2: December release notes go out"'],
    [
      "| R1 | crash-rate watch | i | s | — | blocked: 2026-11-15 ongoing | — |",
      "| R2 | December release notes go out | i | s | — | blocked: 2026-12-01 send | — |",
      "| R3 | follow-up | i | s | R2 | planned | — |",
    ],
  );
  assert.equal(
    run(d).out,
    "beta-launch is **in monitor** until Tue, Dec 1, watching R2: December release notes go out. 1 planned step waits on it. 1 other step is also being watched.",
  );
});

// A wait on another project's row names that row whole, from roadmap.ts's
// dependency results rather than the 60-character blocked-on.
test("blocked on another project's row: both rows named whole", () => {
  proj(
    "2026-01-02_other-proj",
    ["status: active"],
    ["| R2 | Hosting decision: provider agreed | i | s | — | planned | manual |"],
  );
  const d = proj(
    "2026-01-01_waiting",
    ["status: blocked", 'blocked-on: "R1: waits on other-proj R2"'],
    ["| R1 | Decide the cutover with the site move | i | s | other-proj R2 | planned | manual |"],
  );
  assert.equal(
    run(d).out,
    "waiting is **blocked** on R1, Decide the cutover with the site move — waiting for other-proj R2, Hosting decision: provider agreed.",
  );
});

test("blocked on two foreign rows, one domain-qualified, the blocked-on cut: one clause each", () => {
  proj("2026-01-03_alpha", ["status: active"], ["| R2 | alpha's step | i | s | — | planned | — |"]);
  proj("2026-01-04_beta", ["status: active"], ["| R5 | beta's step | i | s | — | in-progress | — |"]);
  const d = proj(
    "2026-01-05_both",
    ["status: blocked", 'blocked-on: "R1: waits on sales/alpha R2, beta R5"'],
    [
      "| R0 | gone | i | s | — | done | — |",
      "| R1 | a step whose name runs well past the sixty characters blocked-on keeps | i | s | R0, sales/alpha R2, beta R5 | planned | — |",
    ],
  );
  assert.equal(
    run(d).out,
    "both is **blocked** on R1, a step whose name runs well past the sixty characters blocked-on keeps — waiting for sales/alpha R2, alpha's step; and beta R5, beta's step.",
  );
});
