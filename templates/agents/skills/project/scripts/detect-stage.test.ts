// detect-stage.test.ts — peer of detect-stage.ts.
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/detect-stage.test.ts
//
// detect-stage.ts reads project paths relative to the write root, which it
// asks session-write-root.ts for; CONTEXT_WRITE_ROOT points that at a fixture.
// It calls four sibling helpers in close/scripts/ (roadmap.ts, spec-state.ts,
// open-clarifications.ts, rows-taken.ts). The first three are used as they are,
// not stubbed, so this suite also pins their contract; CONTEXTIUM_CLOSE_SCRIPTS
// points at another copy. rows-taken.ts is stubbed through
// DETECT_STAGE_ROWS_TAKEN, except in the one case that replays it for real.
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
delete baseEnv.DETECT_STAGE_ROWS_TAKEN;
// No real T3 database: rows another open thread is building come from the
// DETECT_STAGE_ROWS_TAKEN stub below, never from this machine's live threads.
baseEnv.T3CODE_HOME = join(tmp, "no-t3");

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

// ── No ROADMAP.md ────────────────────────────────────────────────────────
// The layout before ROADMAP.md is retired: an
// active project without one is reported, never staged from loose files.
test("active with no ROADMAP.md is unknown", () => {
  for (const [slug, loose] of [
    ["no-rm", false],
    ["no-rm-loose", true],
  ] as const) {
    const p = mk(slug, "active");
    if (loose) {
      touch(`${p}/a.spec.md`);
      touch(`${p}/b.plan.md`);
    }
    assert.equal(field(p, "stage"), "unknown", `${slug}: stage unknown`);
    assert.equal(field(p, "roadmap-error"), "no ROADMAP.md", `${slug}: names the missing ROADMAP.md`);
    assert.equal(field(p, "active-spec"), "", `${slug}: no active spec read from loose files`);
  }
});

test("specs and reports count folders only", () => {
  const p = mk("counts", "active");
  roadmap(p, "| R1 | a | i | s | — | done | `specs/001-a/` |");
  touch(`${p}/a.spec.md`);
  touch(`${p}/a-report.md`, "x\n");
  touch(`${p}/specs/001-a/spec.md`);
  touch(`${p}/specs/001-a/report.md`, "---\nspec: 001-a\nspec-status: complete\n---\n");
  assert.equal(
    run(p),
    "stage: all-specs-reported\nstatus: active\nspecs: 1\nreports: 1\nactive-spec: \nnext-row: \nplan-row: \nmanual-row: ",
    "exact output shape",
  );
});

for (const st of ["monitor", "blocked", "completed"]) {
  test(`status ${st} wins`, () => {
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

test("manual rows are never planned", () => {
  const p = mk("rm-manual", "active");
  roadmap(p, "| R1 | a | i | s | — | planned | manual |", "| R2 | b | i | s | — | planned | `manual` |");
  assert.equal(field(p, "stage"), "manual-steps", "only manual rows ready is manual-steps, not needs-planning");
  assert.equal(field(p, "next-row"), "R1", "manual-steps names the first manual row");

  roadmap(p, "| R1 | a | i | s | — | planned | manual |", "| R2 | b | i | s | — | planned | — |");
  assert.equal(
    `${field(p, "stage")} ${field(p, "next-row")}`,
    "needs-planning R2",
    "a row with no spec is planned ahead of an earlier manual row",
  );

  roadmap(p, "| R1 | a | i | s | — | planned | manual |", "| R2 | b | i | s | — | planned | `specs/002-b/` |");
  touch(`${p}/specs/002-b/spec.md`);
  assert.equal(
    `${field(p, "stage")} ${field(p, "next-row")}`,
    "ready-to-implement R2",
    "a spec owed work is implemented ahead of an earlier manual row",
  );
});

test("plan-row and manual-row name the first of each kind, even behind a row to build", () => {
  const p = mk("rm-lanes", "active");
  roadmap(
    p,
    "| R1 | a | i | s | — | planned | `specs/001-a/` |",
    "| R2 | b | i | s | — | planned | manual |",
    "| R3 | c | i | s | — | planned | — |",
    "| R4 | d | i | s | — | planned | — |",
    "| R5 | e | i | s | — | planned | manual |",
  );
  touch(`${p}/specs/001-a/spec.md`);
  assert.equal(
    ["stage", "next-row", "plan-row", "manual-row"].map((f) => field(p, f)).join(" "),
    "ready-to-implement R1 R3 R2",
    "the build stays the stage and next-row; the first planning and first manual row follow it",
  );

  // A spec still carrying an open question after the build row is planning work.
  roadmap(
    p,
    "| R1 | a | i | s | — | planned | `specs/001-a/` |",
    "| R6 | f | i | s | — | planned | `specs/006-f/` |",
  );
  touch(`${p}/specs/006-f/spec.md`, "# spec\n\n[NEEDS CLARIFICATION: which vendor?]\n");
  assert.equal(
    ["stage", "next-row", "plan-row", "manual-row"].map((f) => field(p, f)).join("|"),
    "ready-to-implement|R1|R6|",
    "an open question after the build row is the plan-row; no manual row prints empty",
  );

  // Nothing but the build: both lanes empty.
  roadmap(p, "| R1 | a | i | s | — | planned | `specs/001-a/` |");
  assert.equal(`${field(p, "plan-row")}|${field(p, "manual-row")}`, "|", "no planning or manual row prints both empty");
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

test("a legacy Sub-spec is a malformed table", () => {
  const p = mk("rm-legrow", "active");
  roadmap(p, "| R1 | a | i | s | — | done | `a.spec.md` → `a-report.md` |", "| R2 | b | i | s | R1 | planned | — |");
  touch(`${p}/a.spec.md`);
  touch(`${p}/a-report.md`, "x\n");
  assert.equal(field(p, "stage"), "unknown");
  assert.equal(
    field(p, "roadmap-error"),
    'R1: Sub-spec "`a.spec.md` → `a-report.md`" is not —, manual or specs/NNN-name/',
  );
});

test("malformed roadmap", () => {
  const p = mk("rm-bad", "active");
  writeFileSync(join(tmp, p, "ROADMAP.md"), "# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n");
  touch(`${p}/a.spec.md`);
  assert.equal(field(p, "stage"), "unknown", "malformed roadmap is unknown, not read from loose files");
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
  touch(`${p}/specs/001-a/spec.md`);
  roadmap(p, "| R1 | a | i | s | — | planned | — |");
  const r = exec(p, { CONTEXTIUM_CLOSE_SCRIPTS: broken });
  assert.equal(
    `${r.out.split("\n").join("|")}|rc=${r.rc}`,
    "stage: unknown|status: active|specs: 1|reports: 0|active-spec: |spec-state-error: spec-state.ts exited 1|next-row: |plan-row: |manual-row: |roadmap-error: roadmap.ts exited 3|rc=0",
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
  touch(`${p}/specs/001-a/spec.md`);
  assert.equal(field(p, "stage", env), "monitor", "a status that wins still wins over a crashed helper");
});

// A worktree is cut when its thread opens. When origin/main has changed the
// project since, the stage is still this tree's, but `behind-main:` says so, and
// a project main has not touched carries no such line.
test("behind-main: only when origin/main changed this project after the cut", () => {
  const repo = mkdtempSync(join(tmpdir(), "detect-stage-git-"));
  const git = (...args: string[]): void => {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    const readme = (slug: string, status: string): string => {
      const rel = `projects/t/2026-01-01_${slug}`;
      mkdirSync(join(repo, rel), { recursive: true });
      writeFileSync(join(repo, rel, "README.md"), `---\nproject: ${slug}\nstatus: ${status}\n---\n`);
      writeFileSync(join(repo, rel, "ROADMAP.md"), `# Roadmap: t\n\n${HDR}\n| R1 | a | i | s | — | planned | — |\n`);
      return rel;
    };
    git("init", "-q");
    const moved = readme("moved", "active");
    const still = readme("still", "active");
    git("add", "-A");
    git("commit", "-q", "-m", "cut");
    readme("moved", "blocked");
    // A name holding a newline is ONE changed file; the listing is -z, so a count
    // of newline-split lines would make it two.
    writeFileSync(join(repo, moved, "café\nnotes.md"), "x\n");
    writeFileSync(join(repo, moved, "plain.md"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed after the cut");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("reset", "-q", "--hard", "HEAD~1");
    const env = { CONTEXT_WRITE_ROOT: repo };
    assert.equal(field(moved, "stage", env), "needs-planning", "the stage is this tree's");
    assert.equal(
      field(moved, "behind-main", env),
      "origin/main changed 3 file(s) in this project after this worktree was cut; merge origin/main and re-run",
    );
    assert.equal(field(still, "behind-main", env), "", "a project main did not touch is not behind");
    git("merge", "-q", "--ff-only", "refs/remotes/origin/main");
    assert.equal(field(moved, "behind-main", env), "", "after the merge it is current");
    assert.equal(field(moved, "stage", env), "blocked");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The status is read from the frontmatter only; a body line is prose.
test("a body status: line is not the field", () => {
  const p = mk("body-status", "active");
  appendFileSync(join(tmp, p, "README.md"), "\nstatus: completed\n");
  assert.equal(field(p, "status"), "active");
});

test("a trailing slash on the path reads the same", () => {
  const p = mk("slash", "active");
  touch(`${p}/specs/001-a/spec.md`);
  roadmap(p, "| R1 | a | i | s | — | in-progress | `specs/001-a/` |");
  assert.equal(run(`${p}/`), run(p));
  assert.equal(field(`${p}/`, "active-spec"), `${p}/specs/001-a/spec.md`);
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

// ── Rows another open thread is building ─────────────────────────────────
// rows-taken.ts is replaced by a stub that prints its lines; its own reading of
// T3 and the other worktrees is covered in rows-taken.test.ts.
function takenStub(name: string, lines: string[], code = 0): Record<string, string> {
  const path = join(tmp, `rows-taken-${name}.ts`);
  writeFileSync(
    path,
    `process.stdout.write(${JSON.stringify(lines.map((l) => `${l}\n`).join(""))});\nprocess.exit(${code});\n`,
  );
  return { DETECT_STAGE_ROWS_TAKEN: path };
}
const held = (id: string, title = "Other thread", wt = "/w/other"): string => `${id}\t${title}\tt-${id}\t${wt}`;

test("a held row is skipped: the next free row is named, and the holder printed", () => {
  const p = mk("tk-next", "active");
  roadmap(
    p,
    "| R2 | a | i | s | — | in-progress | `specs/002-a/` |",
    "| R3 | b | i | s | — | planned | `specs/003-b/` |",
  );
  touch(`${p}/specs/002-a/spec.md`);
  touch(`${p}/specs/003-b/spec.md`);
  const env = takenStub("next", [held("R2")]);
  assert.equal(field(p, "stage", env), "ready-to-implement");
  assert.equal(field(p, "next-row", env), "R3");
  assert.equal(field(p, "active-spec", env), `${p}/specs/003-b/spec.md`);
  assert.equal(field(p, "taken", env), 'R2 by "Other thread" (/w/other)');
  assert.equal(field(p, "next-row", takenStub("none", [])), "R2", "nothing held → R2 as before");
});

test("a held planning or manual row is not a plan-row or manual-row", () => {
  const p = mk("tk-lanes", "active");
  roadmap(
    p,
    "| R2 | a | i | s | — | in-progress | — |",
    "| R3 | b | i | s | — | planned | — |",
    "| R4 | c | i | s | — | in-progress | manual |",
  );
  const env = takenStub("lanes", [held("R2"), held("R4")]);
  assert.equal(`${field(p, "plan-row", env)}|${field(p, "manual-row", env)}`, "R3|", "R2 and R4 are held");
});

test("every ready row held → stage taken, one line per holder", () => {
  const p = mk("tk-all", "active");
  roadmap(p, "| R2 | a | i | s | — | planned | `specs/002-a/` |", "| R3 | b | i | s | — | done | `specs/003-b/` |");
  touch(`${p}/specs/002-a/spec.md`);
  const env = takenStub("all", [held("R2", "First", "/w/1"), `R2\tSecond\tt-x\t/w/2`, held("R9")]);
  assert.equal(field(p, "stage", env), "taken");
  assert.equal(field(p, "next-row", env), "");
  assert.equal(field(p, "active-spec", env), "");
  assert.equal(
    field(p, "taken", env),
    'R2 by "First" (/w/1)\nR2 by "Second" (/w/2)',
    "both holders of R2; R9 is not a ready row here",
  );
});

// An unfinished close still outranks a held row: the close is this thread's to
// finish, and the holder is named beside it.
test("held beside a complete-not-done row is ready-to-close, with the taken line", () => {
  const p = mk("tk-complete", "active");
  roadmap(p, "| R2 | a | i | s | — | planned | `specs/002-a/` |", "| R3 | b | i | s | — | planned | `specs/003-b/` |");
  touch(`${p}/specs/002-a/spec.md`);
  touch(`${p}/specs/003-b/spec.md`);
  touch(`${p}/specs/003-b/report.md`, "---\nspec: 003-b\nspec-status: complete\n---\n");
  const env = takenStub("complete", [held("R2")]);
  assert.equal(`${field(p, "stage", env)} ${field(p, "next-row", env)}`, "ready-to-close R3");
  assert.equal(field(p, "taken", env), 'R2 by "Other thread" (/w/other)');
});

test("every ready row held, a done row beside them → taken, not all-specs-reported", () => {
  const p = mk("tk-held-done", "active");
  roadmap(p, "| R2 | a | i | s | — | planned | `specs/002-a/` |", "| R3 | b | i | s | — | done | `specs/003-b/` |");
  touch(`${p}/specs/002-a/spec.md`);
  touch(`${p}/specs/003-b/spec.md`);
  touch(`${p}/specs/003-b/report.md`, "---\nspec: 003-b\nspec-status: complete\n---\n");
  assert.equal(field(p, "stage", takenStub("held-done", [held("R2")])), "taken");
});

test("held beside an unheld manual row stays manual-steps, with the taken line", () => {
  const p = mk("tk-manual", "active");
  roadmap(p, "| R2 | a | i | s | — | planned | `specs/002-a/` |", "| R3 | b | i | s | — | planned | manual |");
  touch(`${p}/specs/002-a/spec.md`);
  const env = takenStub("manual", [held("R2")]);
  assert.equal(`${field(p, "stage", env)} ${field(p, "next-row", env)}`, "manual-steps R3");
  assert.equal(field(p, "taken", env), 'R2 by "Other thread" (/w/other)');
});

test("a crashed rows-taken helper routes as without it, and says so on stderr", () => {
  const p = mk("tk-crash", "active");
  roadmap(p, "| R2 | a | i | s | — | planned | `specs/002-a/` |");
  touch(`${p}/specs/002-a/spec.md`);
  const env = takenStub("crash", [held("R2")], 3);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, p], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 60_000,
  });
  assert.match(r.stdout, /^stage: ready-to-implement$/m);
  assert.match(r.stdout, /^next-row: R2$/m);
  assert.doesNotMatch(r.stdout, /^taken:/m, "a crashed helper's output is not read");
  assert.match(r.stderr, /^rows-taken-error: rows-taken\.ts exited 3$/m);
});

// One open thread has R12 in-progress in its own worktree and is not settled;
// a second thread's /project must not be sent to R12 too. Here the real
// rows-taken.ts reads a fixture T3 database and the first thread's worktree.
test("two threads at once: the second thread is not sent to the row the first is building", async () => {
  // node:sqlite through a child Node that has it (tests/sqlite-child.ts): on
  // Node 22.5–22.12 it loads only behind a flag this suite cannot give itself.
    const { DatabaseSync } = await import("../../close/scripts/tests/sqlite-child.ts");
  const p = mk("tk-replay", "active");
  const rows = [
    "| R12 | a | i | s | — | planned | `specs/012-a/` |",
    "| R13 | b | i | s | — | planned | `specs/013-b/` |",
  ];
  roadmap(p, ...rows);
  touch(`${p}/specs/012-a/spec.md`);
  touch(`${p}/specs/013-b/spec.md`);
  // Thread 13's worktree: a real linked worktree of a repository whose
  // origin/main does not hold the project, so its R12 mark is its own.
  const repo = mkdtempSync(join(tmpdir(), "detect-stage-replay-"));
  after(() => rmSync(repo, { recursive: true, force: true }));
  const t13 = join(repo, "wt-13");
  for (const args of [
    ["init", "-q"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ["worktree", "add", "-q", "-b", "t13", t13],
  ]) {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  mkdirSync(join(t13, p), { recursive: true });
  writeFileSync(
    join(t13, p, "ROADMAP.md"),
    `# Roadmap: t\n\n${HDR}\n${rows[0]?.replace("planned", "in-progress")}\n${rows[1]}\n`,
  );
  const home = join(tmp, "t3-replay");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata/statev2.sqlite"));
  db.exec(
    "create table orchestration_v2_projection_threads (thread_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);",
  );
  db.prepare("insert into orchestration_v2_projection_threads values (?, ?, ?, null, ?)").run(
    "t13",
    "build-thread-13",
    "1",
    JSON.stringify({ archivedAt: null, settledAt: null, worktreePath: t13, lineage: '{"parentThreadId":null}' }),
  );
  db.close();
  const env = { T3CODE_HOME: home };
  assert.equal(field(p, "next-row", env), "R13");
  assert.equal(field(p, "taken", env), `R12 by "build-thread-13" (${t13})`);
});

test("a held row after the next free one is still printed", () => {
  const p = mk("tk-after", "active");
  roadmap(p, "| R2 | a | i | s | — | planned | `specs/002-a/` |", "| R3 | b | i | s | — | planned | `specs/003-b/` |");
  touch(`${p}/specs/002-a/spec.md`);
  touch(`${p}/specs/003-b/spec.md`);
  const env = takenStub("after", [held("R3")]);
  assert.equal(field(p, "next-row", env), "R2");
  assert.equal(field(p, "taken", env), 'R3 by "Other thread" (/w/other)');
});
