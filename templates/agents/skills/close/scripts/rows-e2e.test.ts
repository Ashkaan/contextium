// rows-e2e.test.ts — roadmap rows, end to end, in a scratch install.
//
// Every other suite tests one script against a fixture. This one proves the
// loop the scripts make together: a fresh install, a project with three rows
// (R1 and R2 independent, R3 depending on both), two sessions building R1 and
// R2 in parallel, each closed with the close's own scripts — and afterwards R1
// and R2 `done`, `next:` re-derived to R3, R3 ready, and origin carrying both
// merges. No model is called: the scripts are driven directly, in the order
// /implement and /close run them.
//
// Scratch only: a temp HOME, the installer run into a temp folder with
// --harness claude, and a bare local "origin". Nothing outside the temp folder
// is read or written.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/rows-e2e.test.ts
// (from the Contextium repo; the installer is five folders above this one, and
// the suite skips where there is none — an installed workbench has no install.sh)
//
// The cases run in order and share the scratch world; each builds on the one
// before it.
//
// peers:
//   install.sh
//   .agents/skills/implement/scripts/setup-worktree.sh
//   .agents/skills/project/scripts/detect-stage.ts
//   .agents/skills/close/scripts/roadmap.ts
//   .agents/skills/close/scripts/next-implement-command.ts
//   .agents/skills/close/scripts/journal-file.ts
//   .agents/skills/close/scripts/land.ts

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../../..");
const INSTALL = join(REPO_ROOT, "install.sh");
const skip = existsSync(INSTALL) ? false : `no install.sh at ${INSTALL} (run from the Contextium repo)`;

const S = realpathSync(mkdtempSync(join(tmpdir(), "rows-e2e-")));
// The basename is unique per run: land.ts's repo lock is keyed on it.
const WB = join(S, `rows-e2e-${process.pid}`);
after(() => {
  if (existsSync(WB)) spawnSync("git", ["-C", WB, "worktree", "prune"]);
  rmSync(S, { recursive: true, force: true });
  rmSync(`/tmp/${basename(WB)}-git.lock`, { force: true });
  rmSync(`/tmp/${basename(WB)}-git.lock.lnk`, { force: true });
});

const P = "projects/demo/2026-01-01_rows-demo";
const C = ".agents/skills/close/scripts";

// The scratch world. The session variables of the shell running the suite must
// not leak in: each session below names its own. NODE_OPTIONS=--no-warnings so
// Node 22.6–22.17's type-stripping warning stays out of the outputs read here.
const ENV: NodeJS.ProcessEnv = { ...process.env, HOME: join(S, "home"), T3CODE_HOME: join(S, "no-t3"), LAND_PUSH_SLEEP: "0" };
for (const k of [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CONTEXTIUM_SESSION",
  "CONTEXTIUM_HARNESS",
  "WORKBENCH_THREAD_ID",
  "CLAUDE_PROJECT_DIR",
  "CONTEXT_WRITE_ROOT",
  "CLAUDE_WORKTREE_HOME",
  "CODEX_HOME",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
]) {
  delete ENV[k];
}
ENV.NODE_OPTIONS = `${ENV.NODE_OPTIONS ?? ""} --no-warnings`.trim();
mkdirSync(ENV.HOME as string, { recursive: true });

/** Run a command; stdout (and stderr when `merge`), trailing newlines dropped. */
function sh(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; merge?: boolean } = {}): { rc: number | null; out: string; err: string } {
  const r: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    cwd: o.cwd ?? WB,
    env: o.env ?? ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  const out = o.merge ? `${r.stdout}${r.stderr}` : r.stdout;
  return { rc: r.status, out: (out ?? "").replace(/\n+$/, ""), err: r.stderr ?? "" };
}
const git = (...args: string[]): string => {
  const r = sh("git", args);
  if (r.rc !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
};
const ts = (script: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; merge?: boolean } = {}) =>
  sh(process.execPath, ["--experimental-strip-types", script, ...args], o);
const as = (session: string): NodeJS.ProcessEnv => ({ ...ENV, CONTEXTIUM_SESSION: session });

// ── Install, then make it a repo with an origin ────────────────────────────

test("install.sh --yes --harness claude makes the scratch workbench", { skip }, () => {
  const r = sh("bash", [INSTALL, WB, "--yes", "--harness", "claude", "--name", "Tester", "--no-integrations"], {
    cwd: S,
  });
  assert.equal(r.rc, 0, `install.sh failed: ${`${r.out}\n${r.err}`.split("\n").slice(-5).join("\n")}`);
  const rec = readFileSync(join(WB, ".agents/harness"), "utf8");
  assert.match(rec, /^harness=claude$/m, "the install records the harness");

  // The installer makes the workbench a repo when it is not one; this names the
  // branch the same either way.
  if (!existsSync(join(WB, ".git"))) git("init", "-q", WB);
  git("-C", WB, "symbolic-ref", "HEAD", "refs/heads/main");
  git("-C", WB, "config", "user.email", "tester@example.com");
  git("-C", WB, "config", "user.name", "Tester");

  // The project: three rows, each with a spec folder whose one task is a file.
  mkdirSync(join(WB, P), { recursive: true });
  writeFileSync(
    join(WB, P, "README.md"),
    `---
project: rows-demo
status: active
priority: medium
created: 2026-01-01
tags: [demo]
description: Three rows, two of them in parallel
next: "R1: first"
---

# Project: Rows demo

## Goal

Show that roadmap rows ship: two in parallel, then the one that needs both.
`,
  );
  writeFileSync(
    join(WB, P, "ROADMAP.md"),
    `# Roadmap: rows demo

| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|
| R1 | first | write notes/r1.txt | in | — | planned | \`specs/001-first/\` |
| R2 | second | write notes/r2.txt | in | — | planned | \`specs/002-second/\` |
| R3 | third | write notes/r3.txt | in | R1, R2 | planned | \`specs/003-third/\` |
`,
  );
  for (const [i, name] of [
    ["1", "first"],
    ["2", "second"],
    ["3", "third"],
  ] as const) {
    const d = join(WB, P, `specs/00${i}-${name}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "spec.md"), `# Feature Specification: ${name}\n\n**Input**: "write notes/r${i}.txt"\n`);
    writeFileSync(join(d, "plan.md"), `# Implementation Plan: ${name}\n`);
    writeFileSync(join(d, "tasks.md"), `# Tasks: ${name}\n\n- [ ] T001 Write notes/r${i}.txt containing r${i}\n`);
  }

  git("-C", WB, "add", "-A");
  git("-C", WB, "commit", "-qm", "Seed the workbench");
  git("init", "-q", "--bare", "-b", "main", join(S, "origin.git"));
  git("-C", WB, "remote", "add", "origin", join(S, "origin.git"));
  git("-C", WB, "push", "-q", "-u", "origin", "main");
  git("-C", WB, "remote", "set-head", "origin", "main");
});

// ── Before: R1 and R2 are the parallel set ─────────────────────────────────

const ready = (): string =>
  ts(`${C}/roadmap.ts`, [P, "--ready"])
    .out.split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\t")[0])
    .join(" ");

test("before: R1 and R2 are the parallel set", { skip }, () => {
  const stage = ts(".agents/skills/project/scripts/detect-stage.ts", [P], { merge: true }).out;
  assert.ok(stage.includes("stage: ready-to-implement"), `detect-stage: ready to implement — ${stage}`);
  assert.ok(stage.includes("next-row: R1"), `…starting with R1 — ${stage}`);
  assert.equal(ready(), "R1 R2", "roadmap --ready lists R1 and R2 together");
  assert.equal(
    ts(`${C}/next-implement-command.ts`, [P]).out,
    "/implement rows-demo r1\n/implement rows-demo r2",
    "next-implement-command prints one command per ready row",
  );
  assert.equal(git("worktree", "list").split("\n").length, 1, "reading the project made no worktree");
});

// ── Two sessions start, one row each ───────────────────────────────────────

let WT1 = "";
let WT2 = "";
const start = (session: string, row: string): string => {
  const r = sh("bash", [".agents/skills/implement/scripts/setup-worktree.sh", "--slug", "rows-demo", "--shard", row], {
    env: as(session),
  });
  writeFileSync(join(S, `setup-${row}.err`), r.err);
  return (r.out.split("\n").find((l) => l.startsWith("WORKTREE_DIR=")) ?? "").slice("WORKTREE_DIR=".length);
};
const rowStatus = (wt: string, id: string): string => {
  for (const line of readFileSync(join(wt, P, "ROADMAP.md"), "utf8").split("\n")) {
    const f = line.split("|");
    if ((f[1] ?? "").trim() === id) return (f[6] ?? "").trim();
  }
  return "";
};

test("two sessions start, one row each", { skip }, () => {
  WT1 = start("e2e-one", "r1");
  WT2 = start("e2e-two", "r2");
  assert.equal(existsSync(WT1) ? basename(WT1) : WT1, "rows-demo-r1", `session one gets a worktree for R1: ${readFileSync(join(S, "setup-r1.err"), "utf8")}`);
  assert.equal(existsSync(WT2) ? basename(WT2) : WT2, "rows-demo-r2", `session two gets its own for R2: ${readFileSync(join(S, "setup-r2.err"), "utf8")}`);
  assert.equal(git("-C", WB, "status", "--porcelain"), "", "the shared checkout is untouched");
  assert.equal(rowStatus(WT1, "R1"), "in-progress", "R1 is in progress in session one's worktree");
  assert.equal(rowStatus(WT2, "R2"), "in-progress", "R2 is in progress in session two's worktree");
});

// ── Each session builds its row and closes ─────────────────────────────────

// build — the task, the report, the close's project step.
function build(wt: string, n: number, spec: string): void {
  mkdirSync(join(wt, "notes"), { recursive: true });
  writeFileSync(join(wt, `notes/r${n}.txt`), `r${n}\n`);
  writeFileSync(
    join(wt, P, "specs", spec, "report.md"),
    `---\nspec: ${spec}\nspec-status: complete\n---\n\n# Implementation Report\n\n**Status**: COMPLETE\n`,
  );
  const set = ts(`${C}/roadmap.ts`, [P, "--set", `R${n}`, "done"], { cwd: wt, merge: true });
  assert.equal(set.rc, 0, `roadmap --set R${n} done: ${set.out}`);
  const sync = ts(`${C}/roadmap.ts`, [P, "--sync-next"], { cwd: wt, merge: true });
  assert.equal(sync.rc, 0, `roadmap --sync-next: ${sync.out}`);
}

// journal — the close's journal step.
function journal(session: string, wt: string, n: number): void {
  const j = ts(`${C}/journal-file.ts`, [`row r${n}`], { cwd: wt, env: as(session) });
  assert.equal(j.rc, 0, `session ${session}'s journal path: ${j.err}`);
  const day = basename(dirname(j.out));
  const name = basename(j.out);
  writeFileSync(
    j.out,
    `---
date: ${day}
time: "${name.slice(0, 2)}:${name.slice(2, 4)}"
slug: row-r${n}
project: demo/2026-01-01_rows-demo
tags: []
---

### row-r${n}
**Action:** Built row R${n} of rows-demo.
**Changes:** notes/r${n}.txt; R${n} done.
`,
  );
  const check = ts(`${C}/journal-file.ts`, ["--check"], { cwd: wt, env: as(session), merge: true });
  assert.equal(check.rc, 0, `session ${session}'s journal entry fails its check: ${check.out}`);
}

const land = (session: string, wt: string, subject: string) =>
  ts(`${C}/land.ts`, [subject], { cwd: wt, env: as(session), merge: true });

test("each session builds its row and closes; the second lands with no hand step", { skip }, () => {
  build(WT1, 1, "001-first");
  build(WT2, 2, "002-second");
  journal("e2e-one", WT1, 1);
  journal("e2e-two", WT2, 2);

  const one = land("e2e-one", WT1, "Ship R1 of rows-demo");
  assert.equal(one.rc, 0, `session one's close lands:\n${one.out}`);
  assert.ok(one.out.includes("closing this tab loses nothing."), "…and proves it against origin");

  // Session two's branch and the trunk both changed ROADMAP.md on adjacent rows
  // (R1 on the trunk, R2 here) and both re-derived `next:`. git's line merge
  // calls that a conflict; land.ts merges the table row by row
  // (roadmap-merge.ts), so this close lands with no hand step, and then
  // re-derives README.md's `next:` from the merged table — each session's value
  // described only its own copy. Both are checked on origin below.
  const two = land("e2e-two", WT2, "Ship R2 of rows-demo");
  assert.equal(two.rc, 0, `session two's close lands:\n${two.out}`);
  assert.ok(two.out.includes("closing this tab loses nothing."), "…and proves it against origin");
});

// ── After: both merged, R3 is next ─────────────────────────────────────────

test("after: both merged on origin, R3 is next", { skip }, () => {
  git("-C", WB, "fetch", "-q", "origin");
  const at = (path: string): string => sh("git", ["-C", WB, "show", `origin/main:${path}`]).out;
  assert.equal(at("notes/r1.txt"), "r1", "origin carries R1's change");
  assert.equal(at("notes/r2.txt"), "r2", "origin carries R2's change");
  const subjects = git("-C", WB, "log", "--format=%s", "origin/main");
  assert.ok(subjects.includes("Ship R1 of rows-demo"), "both closes' commits are on origin");
  assert.ok(subjects.includes("Ship R2 of rows-demo"), "…session two's too");
  const rows = at(`${P}/ROADMAP.md`)
    .split("\n")
    .map((l) => l.split("|"))
    .filter((f) => /^ *R\d/.test(f[1] ?? ""))
    .map((f) => `${(f[1] ?? "").trim()}=${(f[6] ?? "").trim()}`)
    .join(" ");
  assert.equal(rows, "R1=done R2=done R3=planned", "R1 and R2 are done on origin, R3 still planned");
  const next = (at(`${P}/README.md`).split("\n").find((l) => l.startsWith("next: ")) ?? "").slice("next: ".length);
  assert.equal(next, '"R3: third"', "next: is re-derived to R3");
  assert.equal(git("-C", WB, "rev-parse", "HEAD"), git("-C", WB, "rev-parse", "origin/main"), "the shared checkout was fast-forwarded to origin");
  assert.equal(ready(), "R3", "R3 is now the ready row");
  assert.equal(ts(`${C}/next-implement-command.ts`, [P]).out, "/implement rows-demo r3", "the next command is R3's");
  assert.equal(git("-C", WB, "worktree", "list").split("\n").length, 1, "no worktree is left behind");
});
