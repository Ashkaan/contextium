// next-implement-command.test.ts — covers the status branches and the ROADMAP.md
// rows: one command per ready row, the project slug never a spec name.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/next-implement-command.test.ts
//
// The generator calls spec-state.ts, roadmap.ts and open-clarifications.ts
// beside it, so these cases exercise the real ones. Every fixture is written by
// the test itself into a temporary folder; the generator is spawned with
// --no-warnings so Node 22's type-stripping warning stays out of the output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const GEN = join(dirname(fileURLToPath(import.meta.url)), "next-implement-command.ts");
const TMP = mkdtempSync(join(tmpdir(), "next-implement-command-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** The generator's stdout, `$(…)`-trimmed. */
function gen(d: string): string {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", GEN, d], { encoding: "utf8", timeout: 60_000 });
  return r.stdout.replace(/\n+$/, "");
}
const touch = (p: string, body = ""): void => writeFileSync(p, body);

function mkproj(folder: string, status: string, blockedOn = ""): string {
  const dir = join(TMP, "projects/web", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    `---\nstatus: ${status}\n${blockedOn !== "" ? `blocked-on: ${blockedOn}\n` : ""}---\n# project\n`,
  );
  return dir;
}

// 1. An active project with no ROADMAP.md needs planning: loose spec files are
//    not read, so they never become an /implement.
test("no-roadmap-is-project", () => {
  const d = mkproj("2026-05-05_checkout-flow", "active");
  touch(join(d, "guest-checkout.spec.md"));
  touch(join(d, "saved-cards.spec.md"));
  appendFileSync(
    join(d, "README.md"),
    "## Shard Status\n| Shard | SPEC | Report | State |\n|---|---|---|---|\n| a | — | — | in-flight |\n",
  );
  assert.equal(gen(d), "/project checkout-flow");
});

// 4. completed → says so, quoting the project's own ## Outcome first line.
test("completed-outcome", () => {
  const d = mkproj("2026-03-03_finished", "completed");
  appendFileSync(
    join(d, "README.md"),
    "\n## Outcome\n\n- Every order confirmation now arrives within a minute.\n",
  );
  assert.equal(gen(d), "# finished — project complete: Every order confirmation now arrives within a minute.");
});

// 4b. completed with no ## Outcome → still says complete, names the gap.
test("completed-no-outcome", () => {
  const d = mkproj("2026-03-04_finished-bare", "completed");
  assert.equal(gen(d), "# finished-bare — project complete (no ## Outcome section written)");
});

// 5. blocked → comment with blocked-on, no command.
test("blocked-comment", () => {
  const d = mkproj("2026-04-04_waiting", "blocked", "vendor API access");
  assert.equal(gen(d), "# waiting is blocked — waiting on: vendor API access");
});

// 5b. blocked-on as roadmap.ts derives it, quoted → printed without the quotes.
test("blocked-comment-quoted", () => {
  const d = mkproj("2026-04-05_waiting-quoted", "blocked", '"R12: the owner grants access"');
  assert.equal(gen(d), "# waiting-quoted is blocked — waiting on: R12: the owner grants access");
});

// 6. monitor with a reason on monitoring-until → date AND what is being watched.
test("monitor-with-reason", () => {
  const d = mkproj("2026-05-05_observe", "monitor");
  appendFileSync(
    join(d, "README.md"),
    "monitoring-until: 2026-08-15 — first scheduled run must post a non-empty digest\n",
  );
  assert.equal(
    gen(d),
    "# observe — work complete, monitoring until 2026-08-15: first scheduled run must post a non-empty digest",
  );
});

// 6b. monitor with a bare date → date only, still says the build finished.
test("monitor-bare-date", () => {
  const d = mkproj("2026-05-06_observe-bare", "monitor");
  appendFileSync(join(d, "README.md"), "monitoring-until: 2026-08-20\n");
  assert.equal(
    gen(d),
    "# observe-bare — work complete, monitoring until 2026-08-20 (no command — passive observation)",
  );
});

// 6c. monitor with no monitoring-until → names the missing field, never silent.
test("monitor-no-date", () => {
  const d = mkproj("2026-05-07_observe-nodate", "monitor");
  assert.equal(gen(d), "# observe-nodate — work complete, monitor window open (monitoring-until not set)");
});

// ── ROADMAP.md projects ─────────────────────────────────────────────
const RM_HDR = `| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|`;
const mkroadmap = (d: string, ...rows: string[]): void =>
  writeFileSync(join(d, "ROADMAP.md"), `# Roadmap: t\n\n${RM_HDR}\n${rows.map((r) => `${r}\n`).join("")}`);
function spec(d: string, name: string, body = "# spec"): void {
  mkdirSync(join(d, "specs", name), { recursive: true });
  writeFileSync(join(d, "specs", name, "spec.md"), `${body}\n`);
}

test("rm-header-only", () => {
  const d = mkproj("2026-09-01_rm-empty", "active");
  mkroadmap(d);
  assert.equal(gen(d), "/project rm-empty");
});

test("rm-row-needs-planning", () => {
  const d = mkproj("2026-09-02_rm-plan", "active");
  mkroadmap(d, "| R1 | a | i | s | — | planned | — |");
  assert.equal(gen(d), "/project rm-plan");
});

// A manual row has no command: it is named, and never sends the close to /project.
test("rm-manual-rows-named-not-planned", () => {
  const d = mkproj("2026-09-02_rm-manual", "active");
  mkroadmap(
    d,
    "| R1 | reply to the vendor | i | s | — | planned | manual |",
    "| R2 | b | i | s | — | planned | `specs/002-b/` |",
  );
  spec(d, "002-b");
  assert.equal(gen(d), "/implement rm-manual r2\n# rm-manual R1 is a manual step: reply to the vendor");
  mkroadmap(d, "| R1 | reply to the vendor | i | s | — | planned | manual |");
  assert.equal(gen(d), "# rm-manual R1 is a manual step: reply to the vendor", "manual rows alone print no command");
});

test("rm-row-with-spec, then complete awaiting done", () => {
  const d = mkproj("2026-09-03_rm-impl", "active");
  mkroadmap(d, "| R1 | a | i | s | — | planned | `specs/001-a/` |");
  spec(d, "001-a");
  assert.equal(gen(d), "/implement rm-impl r1", "rm-row-with-spec");
  writeFileSync(join(d, "specs/001-a/report.md"), "---\nspec: 001-a\nspec-status: complete\n---\n");
  // A complete spec whose row is not yet `done` is /close's to flip — said so,
  // rather than a `/project` for a row whose work is finished.
  assert.equal(
    gen(d),
    "# rm-impl R1's spec is complete — run /close to flip the row to done",
    "rm-complete-awaiting-done",
  );
});

// Several ready rows: one /implement per row with a pending spec, plus ONE
// /project for every row that needs planning; blocked rows named, in that order.
test("rm-parallel-set", () => {
  const d = mkproj("2026-09-04_rm-par", "active");
  mkroadmap(
    d,
    "| R1 | a | i | s | — | done | — |",
    "| R2 | b | i | s | R1 | planned | `specs/002-b/` |",
    "| R3 | c | i | s | R1 | planned | `specs/003-c/` |",
    "| R4 | d | i | s | — | planned | — |",
    "| R5 | e | i | s | — | planned | — |",
    "| R6 | f | i | s | — | blocked: vendor reply | — |",
    "| R7 | g | i | s | R6 | planned | `specs/007-g/` |",
    "| R8 | h | i | s | — | closed: never built | — |",
  );
  spec(d, "002-b");
  spec(d, "003-c");
  spec(d, "007-g");
  assert.equal(
    gen(d),
    "/implement rm-par r2\n/implement rm-par r3\n/project rm-par\n# rm-par R6 is blocked: vendor reply",
  );
});

// An open clarification sends the row to planning instead of /implement.
test("rm-clarification-routes-to-project", () => {
  const d = mkproj("2026-09-05_rm-clar", "active");
  mkroadmap(
    d,
    "| R1 | a | i | s | — | planned | `specs/001-a/` |",
    "| R2 | b | i | s | — | planned | `specs/002-b/` |",
  );
  spec(d, "001-a", "[NEEDS CLARIFICATION: which store?]");
  spec(d, "002-b");
  assert.equal(gen(d), "/implement rm-clar r2\n/project rm-clar");
});

// in-progress before planned
test("rm-in-progress-first", () => {
  const d = mkproj("2026-09-06_rm-order", "active");
  mkroadmap(
    d,
    "| R1 | a | i | s | — | planned | `specs/001-a/` |",
    "| R2 | b | i | s | — | in-progress | `specs/002-b/` |",
  );
  spec(d, "001-a");
  spec(d, "002-b");
  assert.equal(gen(d), "/implement rm-order r2\n/implement rm-order r1");
});

// Status outside the vocabulary, and only blocked rows left
test("rm-unknown-status-named", () => {
  const d = mkproj("2026-09-08_rm-blk", "active");
  mkroadmap(d, "| R1 | a | i | s | — | done | — |", "| R16 | f | i | s | — | waiting on the vendor | — |");
  assert.equal(gen(d), "# rm-blk R16 has a Status outside the vocabulary: waiting on the vendor");
});

// Malformed: only the comment, exit 0
test("rm-malformed", () => {
  const d = mkproj("2026-09-09_rm-bad", "active");
  writeFileSync(join(d, "ROADMAP.md"), "# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n");
  assert.equal(gen(d), "# rm-bad ROADMAP.md is malformed: no table under `# Roadmap` with ID and Status columns");
});

// A README shard table is not read: the rows decide
test("rm-ignores-shard-table", () => {
  const d = mkproj("2026-09-10_rm-shards", "active");
  appendFileSync(
    join(d, "README.md"),
    "## Shard Status\n| Shard | SPEC | Report | State |\n|---|---|---|---|\n| alpha | — | — | in-flight |\n",
  );
  touch(join(d, "alpha.spec.md"));
  mkroadmap(d, "| R1 | a | i | s | — | planned | — |");
  assert.equal(gen(d), "/project rm-shards");
});

// monitor still wins over rows
test("rm-status-first", () => {
  const d = mkproj("2026-09-11_rm-mon", "monitor");
  mkroadmap(d, "| R1 | a | i | s | — | planned | — |");
  assert.equal(gen(d), "# rm-mon — work complete, monitor window open (monitoring-until not set)");
});
