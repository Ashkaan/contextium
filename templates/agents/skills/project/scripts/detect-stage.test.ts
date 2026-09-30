// detect-stage.test.ts — peer of detect-stage.ts.
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/detect-stage.test.ts
//
// detect-stage.ts reads project paths relative to the write root, which it
// asks session-write-root.ts for; CONTEXT_WRITE_ROOT points that at a fixture.
// It calls three sibling helpers in close/scripts/ (roadmap.ts, spec-state.ts,
// open-clarifications.ts). They are used as they are, not stubbed, so this suite
// also pins their contract; CONTEXTIUM_CLOSE_SCRIPTS points at another copy.
// The script is run as a subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "detect-stage.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "detect-stage-test-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const baseEnv: Record<string, string | undefined> = { ...process.env, CONTEXT_WRITE_ROOT: tmp };
delete baseEnv.CLAUDE_SESSION_ID;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
delete baseEnv.CONTEXTIUM_CLOSE_SCRIPTS;

/** mk <slug> <status> → creates projects/t/2026-01-01_<slug>, returns the relative path */
function mk(slug: string, status: string): string {
  const rel = `projects/t/2026-01-01_${slug}`;
  mkdirSync(join(tmp, rel), { recursive: true });
  writeFileSync(join(tmp, rel, "README.md"), `---\nproject: ${slug}\nstatus: ${status}\n---\n\n# P\n`);
  return rel;
}
const HDR =
  "| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |\n" +
  "|----|-------------|--------|----------------|-----------|--------|----------|";
function roadmap(rel: string, ...rows: string[]): void {
  writeFileSync(join(tmp, rel, "ROADMAP.md"), `# Roadmap: t\n\n${HDR}\n${rows.map((r) => `${r}\n`).join("")}`);
}
const touch = (rel: string, body = ""): void => {
  mkdirSync(dirname(join(tmp, rel)), { recursive: true });
  writeFileSync(join(tmp, rel), body);
};

/** A run's stdout (stderr dropped — the bash suite's `2>/dev/null`) and exit. */
function exec(p: string, env: Record<string, string> = {}): { out: string; rc: number | null } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, p], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.replace(/\n+$/, ""), rc: r.status };
}
const run = (p: string, env: Record<string, string> = {}): string => exec(p, env).out;
/** `sed -n "s/^<name>: \{0,1\}//p"` over the run's stdout. */
function field(p: string, name: string, env: Record<string, string> = {}): string {
  return run(p, env)
    .split("\n")
    .filter((l) => l.startsWith(`${name}:`))
    .map((l) => l.slice(name.length + 1).replace(/^ /, ""))
    .join("\n");
}

// ── Legacy layout ────────────────────────────────────────────────────────
test("legacy: no spec", () => {
  const p = mk("never", "active");
  assert.equal(field(p, "stage"), "needs-planning", "legacy: no spec is needs-planning");
  assert.equal(
    run(p)
      .split("\n")
      .filter((l) => l.startsWith("next-row"))
      .join("\n"),
    "",
    "legacy: no next-row line",
  );
});

test("legacy: unreported spec", () => {
  const p = mk("pending", "active");
  touch(`${p}/a.spec.md`);
  assert.equal(field(p, "stage"), "ready-to-implement", "legacy: unreported spec is ready-to-implement");
  assert.equal(field(p, "active-spec"), `${p}/a.spec.md`, "legacy: active-spec is the file");
});

test("legacy: every spec reported", () => {
  const p = mk("reported", "active");
  touch(`${p}/a.spec.md`);
  touch(`${p}/a-report.md`, "x\n");
  assert.equal(field(p, "stage"), "all-specs-reported", "legacy: every spec reported");
  assert.equal(
    run(p),
    "stage: all-specs-reported\nstatus: active\nspecs: 1\nreports: 1\nactive-spec: ",
    "legacy: exact output shape",
  );
});

test("legacy: an unreported *.plan.md is ready-to-implement", () => {
  const p = mk("legacy-plan", "active");
  touch(`${p}/a.plan.md`);
  assert.equal(`${field(p, "stage")} ${field(p, "active-spec")}`, `ready-to-implement ${p}/a.plan.md`);
});

for (const st of ["monitor", "blocked", "completed"]) {
  test(`legacy: status ${st}`, () => {
    assert.equal(field(mk(`s-${st}`, st), "stage"), st);
  });
}

test("missing README", () => {
  assert.equal(field("projects/t/none", "stage"), "unknown", "missing README is unknown");
  assert.equal(field("projects/t/none", "status"), "missing-readme", "missing README status");
});

// ── ROADMAP layout ───────────────────────────────────────────────────────
test("header-only roadmap", () => {
  const p = mk("rm-empty", "active");
  roadmap(p);
  assert.equal(field(p, "stage"), "needs-planning", "header-only roadmap, no rows, no specs is needs-planning");
  assert.ok(run(p).split("\n").includes("next-row: "), "header-only roadmap prints an empty next-row");
});

test("row with no spec", () => {
  const p = mk("rm-plan", "active");
  roadmap(p, "| R1 | a | i | s | — | planned | — |");
  assert.equal(field(p, "stage"), "needs-planning", "row with no spec is needs-planning");
  assert.equal(field(p, "next-row"), "R1", "row with no spec names the row");
});

test("row with a folder spec", () => {
  const p = mk("rm-impl", "active");
  roadmap(p, "| R1 | a | i | s | — | planned | `specs/001-a/` |");
  touch(`${p}/specs/001-a/spec.md`, "# spec\n");
  assert.equal(field(p, "stage"), "ready-to-implement", "row with an unreported spec is ready-to-implement");
  assert.equal(field(p, "active-spec"), `${p}/specs/001-a/spec.md`, "active-spec is the folder's spec.md");
  assert.equal(field(p, "next-row"), "R1", "next-row is the row");
  assert.equal(field(p, "specs"), "1", "folder spec is counted");

  touch(`${p}/specs/001-a/report.md`, "---\nspec: 001-a\nspec-status: partial\n---\n");
  assert.equal(field(p, "stage"), "ready-to-implement", "partial report keeps the row ready-to-implement");
  assert.equal(field(p, "reports"), "1", "folder report is counted");

  touch(`${p}/specs/001-a/report.md`, "---\nspec: 001-a\nspec-status: complete\n---\n");
  assert.equal(
    `${field(p, "stage")} ${field(p, "next-row")}`,
    "ready-to-close R1",
    "complete report, row not yet done → ready-to-close",
  );
});

test("open clarification", () => {
  const p = mk("rm-clar", "active");
  roadmap(p, "| R1 | a | i | s | — | planned | `specs/001-a/` |");
  touch(`${p}/specs/001-a/spec.md`, "FR-1 [NEEDS CLARIFICATION: which?]\n");
  assert.equal(field(p, "stage"), "needs-planning", "open clarification routes to planning");
  assert.equal(field(p, "next-row"), "R1", "open clarification names the row");
});

test("in-progress row wins over an earlier planned one", () => {
  const p = mk("rm-order", "active");
  roadmap(
    p,
    "| R1 | a | i | s | — | planned | `specs/001-a/` |",
    "| R2 | b | i | s | — | in-progress | `specs/002-b/` |",
  );
  touch(`${p}/specs/001-a/spec.md`);
  touch(`${p}/specs/002-b/spec.md`);
  assert.equal(field(p, "next-row"), "R2");
});

test("only blocked or dependent rows → all-specs-reported", () => {
  const p = mk("rm-dep", "active");
  roadmap(
    p,
    "| R1 | a | i | s | — | blocked: vendor reply | — |",
    "| R2 | b | i | s | R1 | planned | `specs/002-b/` |",
  );
  touch(`${p}/specs/002-b/spec.md`);
  assert.equal(field(p, "stage"), "all-specs-reported");
});

test("legacy loose spec in flight", () => {
  const p = mk("rm-legacy", "active");
  roadmap(
    p,
    "| R1 | a | i | s | — | planned | `specs/001-a/` |",
    "| R2 | b | i | s | — | planned | `b.spec.md` → `b-report.md` |",
  );
  touch(`${p}/specs/001-a/spec.md`);
  touch(`${p}/b.spec.md`);
  assert.equal(field(p, "active-spec"), `${p}/b.spec.md`, "legacy loose spec in flight wins active-spec");
  assert.equal(field(p, "next-row"), "R2", "legacy loose spec names its row");
});

test("legacy-form done row is satisfied; next needs planning", () => {
  const p = mk("rm-legrow", "active");
  roadmap(p, "| R1 | a | i | s | — | done | `a.spec.md` → `a-report.md` |", "| R2 | b | i | s | R1 | planned | — |");
  touch(`${p}/a.spec.md`);
  touch(`${p}/a-report.md`, "x\n");
  assert.equal(`${field(p, "stage")} ${field(p, "next-row")}`, "needs-planning R2");
});

test("malformed roadmap", () => {
  const p = mk("rm-bad", "active");
  writeFileSync(join(tmp, p, "ROADMAP.md"), "# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n");
  touch(`${p}/a.spec.md`);
  assert.equal(field(p, "stage"), "unknown", "malformed roadmap is unknown, not the legacy answer");
  assert.equal(
    field(p, "roadmap-error"),
    "no table under `# Roadmap` with ID and Status columns",
    "malformed roadmap names the problem",
  );
});

test("unfilled template is unknown", () => {
  const p = mk("rm-tpl", "active");
  copyFileSync(join(HERE, "../references/templates/ROADMAP.md"), join(tmp, p, "ROADMAP.md"));
  assert.equal(field(p, "stage"), "unknown");
});

test("monitor status still overrides the rows", () => {
  const p = mk("rm-mon", "monitor");
  roadmap(p, "| R1 | a | i | s | — | planned | — |");
  assert.equal(field(p, "stage"), "monitor");
});

// A finished project keeps naming the spec still owed work, whichever layout it
// is in: the rows only order work on an ACTIVE project.
test("completed with a roadmap: active-spec is the folder spec owed work", () => {
  const p = mk("rm-done", "completed");
  roadmap(p, "| R1 | a | i | s | — | in-progress | `specs/001-a/` |");
  touch(`${p}/specs/001-a/spec.md`);
  assert.equal(`${field(p, "stage")} ${field(p, "active-spec")}`, `completed ${p}/specs/001-a/spec.md`);
});

// A ready row whose Sub-spec is not on disk has no spec to build: plan it.
test("row pointing at a missing spec folder is needs-planning", () => {
  const p = mk("rm-missing", "active");
  roadmap(p, "| R1 | a | i | s | — | planned | `specs/001-gone/` |");
  assert.equal(`${field(p, "stage")} ${field(p, "next-row")}`, "needs-planning R1");
});

// An unfinished close outranks new work: the row it would flip may unblock others.
test("a complete row awaiting close wins over a buildable row", () => {
  const p = mk("rm-close-first", "active");
  roadmap(
    p,
    "| R1 | a | i | s | — | in-progress | `specs/001-a/` |",
    "| R2 | b | i | s | — | planned | `specs/002-b/` |",
  );
  touch(`${p}/specs/001-a/spec.md`);
  touch(`${p}/specs/002-b/spec.md`);
  touch(`${p}/specs/001-a/report.md`, "---\nspec: 001-a\nspec-status: complete\n---\n");
  assert.equal(`${field(p, "stage")} ${field(p, "next-row")}`, "ready-to-close R1");
});

// Rows that are all done: nothing to plan, nothing to build.
test("every row done is all-specs-reported", () => {
  const p = mk("rm-alldone", "active");
  roadmap(p, "| R1 | a | i | s | — | done | `specs/001-a/` |");
  touch(`${p}/specs/001-a/spec.md`);
  touch(`${p}/specs/001-a/report.md`, "---\nspec: 001-a\nspec-status: complete\n---\n");
  assert.equal(field(p, "stage"), "all-specs-reported");
});

// A helper that fails must be reported in the output, never end the run before
// `stage:` is printed.
test("failing helpers: every line printed, exit 0", () => {
  const broken = join(tmp, "broken-close");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "spec-state.ts"), "process.exit(1);\n");
  writeFileSync(join(broken, "roadmap.ts"), "process.exit(3);\n");
  const p = mk("helpers-fail", "active");
  touch(`${p}/a.spec.md`);
  roadmap(p, "| R1 | a | i | s | — | planned | — |");
  const r = exec(p, { CONTEXTIUM_CLOSE_SCRIPTS: broken });
  assert.equal(
    `${r.out.split("\n").join("|")}|rc=${r.rc}`,
    "stage: unknown|status: active|specs: 1|reports: 0|active-spec: |spec-state-error: spec-state.ts exited 1|next-row: |roadmap-error: roadmap.ts exited 3|rc=0",
  );
});

// A spec-state.ts that CRASHES is not "no spec owed work": its silence would
// send an already specified row back to planning. `stage: unknown`, named.
test("a crashed spec-state helper", () => {
  const ssonly = join(tmp, "ss-only");
  mkdirSync(ssonly, { recursive: true });
  const real = realpathSync(join(HERE, "../../close/scripts"));
  for (const h of ["roadmap.ts", "open-clarifications.ts"]) symlinkSync(join(real, h), join(ssonly, h));
  writeFileSync(join(ssonly, "spec-state.ts"), 'process.stderr.write("boom\\n");\nprocess.exit(7);\n');
  const env = { CONTEXTIUM_CLOSE_SCRIPTS: ssonly };
  let p = mk("ss-crash", "active");
  roadmap(p, "| R1 | a | i | s | — | planned | `specs/001-a/` |");
  touch(`${p}/specs/001-a/spec.md`);
  assert.equal(field(p, "stage", env), "unknown", "a crashed spec-state.ts is stage unknown");
  assert.equal(field(p, "spec-state-error", env), "spec-state.ts exited 7", "…and names the failure");
  p = mk("ss-crash-mon", "monitor");
  touch(`${p}/a.spec.md`);
  assert.equal(field(p, "stage", env), "monitor", "a status that wins still wins over a crashed helper");
});

// Folder specs with no ROADMAP.md: the folder spec owed work is the active one.
test("folder spec, no roadmap", () => {
  const p = mk("folders-only", "active");
  touch(`${p}/specs/001-a/spec.md`);
  assert.equal(
    `${field(p, "stage")} ${field(p, "active-spec")}`,
    `ready-to-implement ${p}/specs/001-a/spec.md`,
    "folder spec, no roadmap: ready-to-implement",
  );
  assert.ok(!run(p).split("\n").some((l) => l.startsWith("next-row")), "folder spec, no roadmap: no next-row line");
});

// The status is read from the frontmatter only; a body line is prose.
test("a body status: line is not the field", () => {
  const p = mk("body-status", "active");
  appendFileSync(join(tmp, p, "README.md"), "\nstatus: completed\n");
  assert.equal(field(p, "status"), "active");
});

test("a trailing slash on the path reads the same", () => {
  const p = mk("slash", "active");
  touch(`${p}/a.spec.md`);
  assert.equal(field(`${p}/`, "active-spec"), `${p}/a.spec.md`);
});

test("no status field is unknown", () => {
  const p = mk("no-status", "active");
  writeFileSync(join(tmp, p, "README.md"), "---\nproject: x\n---\n");
  assert.equal(`${field(p, "stage")} ${field(p, "status")}`, "unknown unknown", "no status field is unknown");
  appendFileSync(join(tmp, p, "README.md"), "\nstatus: active\n");
  assert.equal(
    `${field(p, "stage")} ${field(p, "status")}`,
    "unknown unknown",
    "a body status: line does not stand in for a missing field",
  );
});
