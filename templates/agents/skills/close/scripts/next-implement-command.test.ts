// next-implement-command.test.ts — covers the slug-not-SPEC-name guarantee + the
// status/shard branches.
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

// 1. THE BUG: un-reported sub-SPEC → bare project slug, NOT the SPEC basename.
test("slug-not-spec-name", () => {
  const d = mkproj("2026-05-05_checkout-flow", "active");
  touch(join(d, "guest-checkout.spec.md"));
  touch(join(d, "saved-cards.spec.md"));
  touch(join(d, "saved-cards-report.md")); // this one IS reported
  assert.equal(gen(d), "/implement checkout-flow");
});

// 2. No pending SPEC + active → /project <slug>.
test("active-no-pending-spec", () => {
  const d = mkproj("2026-01-01_done-specs", "active");
  touch(join(d, "foo.spec.md"));
  touch(join(d, "foo-report.md"));
  assert.equal(gen(d), "/project done-specs");
});

// 3. Sharded → one /implement <slug> <shard> per pending shard, sorted.
test("sharded-per-shard", () => {
  const d = mkproj("2026-02-02_big-migration", "active");
  appendFileSync(join(d, "README.md"), "## Shard Status\n| Shard | SPEC | Report | State |\n");
  touch(join(d, "token-refresher.spec.md"));
  touch(join(d, "email-sender.spec.md"));
  touch(join(d, "foundation.spec.md"));
  touch(join(d, "foundation-report.md")); // reported — excluded
  assert.equal(gen(d), "/implement big-migration email-sender\n/implement big-migration token-refresher");
});

// 4. completed → says so, quoting the project's own ## Outcome first line.
test("completed-outcome", () => {
  const d = mkproj("2026-03-03_finished", "completed");
  touch(join(d, "x.spec.md"));
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

// ── The shard-table State column ────────────────────────────────────────────
// The report-presence heuristic reads a part-done shard as finished, so a close
// would offer the `planned` shards while the one in motion has reports written.
function mkshards(folder: string, status: string, ...rows: string[]): string {
  const dir = join(TMP, "projects/ai", folder);
  mkdirSync(dir, { recursive: true });
  let body = `---\nstatus: ${status}\n---\n# project\n## Shard Status\n\n| Shard | SPEC | Report | State |\n|---|---|---|---|\n`;
  for (const row of rows) {
    const shard = row.slice(0, row.indexOf(":"));
    const state = row.slice(row.lastIndexOf(":") + 1);
    body += `| ${shard} | \`${shard}.spec.md\` | — | ${state} |\n`;
  }
  writeFileSync(join(dir, "README.md"), body);
  return dir;
}

// An in-flight shard is the work in motion and comes first, ALONE — even when
// it has reports and the planned ones do not.
test("in-flight-shard-wins", () => {
  const d = mkshards(
    "2026-09-04_data-move",
    "active",
    "export-out:in-flight",
    "archive-repo:planned",
    "log-split:planned",
  );
  touch(join(d, "export-out.spec.md"));
  touch(join(d, "export-out-report.md"));
  touch(join(d, "archive-repo.spec.md"));
  touch(join(d, "log-split.spec.md"));
  assert.equal(gen(d), "/implement data-move export-out");
});

// Two in flight (parallel tabs) → both, sorted.
test("two-in-flight", () => {
  const d = mkshards("2026-03-03_two-open", "active", "alpha:in-flight", "beta:in-flight", "gamma:planned");
  assert.equal(gen(d), "/implement two-open alpha\n/implement two-open beta");
});

// Nothing in flight → the planned ones.
test("planned-when-nothing-in-flight", () => {
  const d = mkshards("2026-04-04_nothing-open", "active", "alpha:closed", "beta:planned");
  assert.equal(gen(d), "/implement nothing-open beta");
});

// A blocked shard is named alongside whatever is next.
test("blocked-named-alongside", () => {
  const d = mkshards("2026-05-05_one-blocked", "active", "alpha:in-flight", "beta:blocked");
  assert.equal(gen(d), "/implement one-blocked alpha\n# one-blocked beta is blocked — see its row in ## Shard Status");
});

// Blocked and nothing else open → the block IS the answer, no command.
test("blocked-only", () => {
  const d = mkshards("2026-06-06_only-blocked", "active", "alpha:closed", "beta:blocked");
  assert.equal(gen(d), "# only-blocked beta is blocked — see its row in ## Shard Status");
});

// Every shard done → the project needs its next phase decided, even though
// `status:` is still active.
test("all-shards-done", () => {
  const d = mkshards("2026-07-07_all-done", "active", "alpha:closed", "beta:reported");
  assert.equal(gen(d), "/project all-done");
});

// A table with a header and NO rows keeps the old behaviour — that is what
// test 3 above covers and this asserts the fallback is deliberate.
test("header-only-falls-back", () => {
  const d = mkproj("2026-08-08_header-only", "active");
  appendFileSync(join(d, "README.md"), "## Shard Status\n| Shard | SPEC | Report | State |\n");
  touch(join(d, "alpha.spec.md"));
  assert.equal(gen(d), "/implement header-only alpha");
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

// A legacy loose spec no row points at prints first; one a row points at is that row.
test("rm-legacy-loose-first", () => {
  const d = mkproj("2026-09-07_rm-mixed", "active");
  mkroadmap(d, "| R1 | a | i | s | — | planned | `a.spec.md` → `a-report.md` |");
  touch(join(d, "a.spec.md"));
  touch(join(d, "loose.spec.md"));
  assert.equal(gen(d), "/implement rm-mixed\n/implement rm-mixed r1");
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
  touch(join(d, "x.spec.md"));
  assert.equal(gen(d), "# rm-bad ROADMAP.md is malformed: no table under `# Roadmap` with ID and Status columns");
});

// ROADMAP beats a legacy shard table
test("rm-beats-shard-table", () => {
  const d = mkshards("2026-09-10_rm-shards", "active", "alpha:planned");
  mkroadmap(d, "| R1 | a | i | s | — | planned | — |");
  assert.equal(gen(d), "/project rm-shards");
});

// monitor still wins over rows
test("rm-status-first", () => {
  const d = mkproj("2026-09-11_rm-mon", "monitor");
  mkroadmap(d, "| R1 | a | i | s | — | planned | — |");
  assert.equal(gen(d), "# rm-mon — work complete, monitor window open (monitoring-until not set)");
});
