// check-materiality.test.ts — peer of check-materiality.ts.
// Run: node --test --experimental-strip-types .agents/skills/spec-audit/scripts/check-materiality.test.ts
//
// A throwaway git repo per run: a spec-kit folder and legacy single-file SPECs,
// each edited, asked about, and put back. A `git` shim first on PATH makes one
// subcommand fail, to prove a failed read is answered material. The script is
// run as a subprocess, never imported.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "check-materiality.ts");
const tmp = mkdtempSync(join(tmpdir(), "check-materiality-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: tmp, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
const w = (rel: string, body: string): void => {
  mkdirSync(dirname(join(tmp, rel)), { recursive: true });
  writeFileSync(join(tmp, rel), body);
};
const r = (rel: string): string => readFileSync(join(tmp, rel), "utf8");
/** `sed -i 's/<from>/<to>/'` on the first match of each line — a plain string here. */
const sub = (rel: string, from: string | RegExp, to: string): void => {
  w(
    rel,
    r(rel)
      .split("\n")
      .map((l) => l.replace(from, to))
      .join("\n"),
  );
};
const dropLine = (rel: string, re: RegExp): void => {
  w(
    rel,
    r(rel)
      .split("\n")
      .filter((l) => !re.test(l))
      .join("\n"),
  );
};

git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
git("config", "commit.gpgsign", "false");

w(
  "specs/001-a/spec.md",
  `# Feature Specification: a

**Input**: User description: "make it go"

## Clarifications

### Session 2026-01-10

- Q: which store? → A: the orders table

## User Scenarios & Testing *(mandatory)*

### Edge Cases

- What happens when the list is empty? Nothing is written.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST write one row per run.

## Assumptions

- The store exists.
`,
);
w(
  "specs/001-a/plan.md",
  `# Implementation Plan: a

## Summary

Write a row.

### Simplest shape

One script.

## Technical Context

### Data sourcing

| What | Where | Transports | Chosen |
|---|---|---|---|
| orders | the orders table | SQL | SQL |
`,
);
w("specs/001-a/tasks.md", "# Tasks: a\n\n- [ ] T001 Write the script\n");
git("add", "-A");
git("commit", "-qm", "init");

interface Res {
  out: string;
  rc: number | null;
  err: string;
}
function exec(args: string[], opts: { cwd?: string; fail?: string } = {}): Res {
  const env: Record<string, string | undefined> = { ...gitEnv };
  if (opts.fail !== undefined) {
    env.PATH = `${join(tmp, "fakegit")}:${process.env.PATH ?? ""}`;
    env.FAKE_GIT_FAIL = opts.fail;
  }
  const p = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? tmp,
    env,
    timeout: 60_000,
  });
  if (p.error) throw p.error;
  return { out: p.stdout.replace(/\n+$/, ""), rc: p.status, err: p.stderr };
}
const run = (...args: string[]): string => exec(args).out;
const reset = (): void => {
  git("checkout", "-q", "--", "specs");
  git("clean", "-qfd", "specs");
};

test("spec-kit folder", () => {
  assert.equal(run("specs/001-a"), "non-material:no-change", "unchanged folder");

  sub("specs/001-a/spec.md", "→ A: the orders table", "→ A: the orders table, the one store");
  assert.equal(
    run("specs/001-a"),
    "material:numbered-section-changed",
    "a changed decision-ledger row under Clarifications is material",
  );
  reset();

  sub("specs/001-a/spec.md", "Nothing is written.", "Nothing is written, and it says so.");
  assert.equal(run("specs/001-a/"), "material:numbered-section-changed", "an edit under Edge Cases is material");
  reset();

  sub("specs/001-a/spec.md", "one row per run", "two rows per run");
  assert.equal(run("specs/001-a"), "material:numbered-section-changed", "an edit under Requirements is material");
  reset();

  sub("specs/001-a/plan.md", /^One script\./, "One script and a test.");
  assert.equal(run("specs/001-a"), "material:numbered-section-changed", "an edit under Simplest shape is material");
  reset();

  sub("specs/001-a/plan.md", "| orders | the orders table | SQL | SQL |", "| orders | the orders API | SQL, API | API |");
  assert.equal(run("specs/001-a"), "material:numbered-section-changed", "an edit under Data sourcing is material");
  reset();

  sub("specs/001-a/spec.md", "make it go", "make it go now");
  assert.equal(run("specs/001-a"), "material:input-changed", "an edit to the Input line is material");
  reset();

  sub("specs/001-a/spec.md", /^- The store exists\./, "- The store already exists.");
  assert.equal(run("specs/001-a"), "non-material:minor-text-edit-2-lines", "an edit under Assumptions is non-material");
  reset();

  dropLine("specs/001-a/spec.md", /^- The store exists\./);
  assert.equal(
    run("specs/001-a"),
    "non-material:minor-text-edit-1-lines",
    "a deleted line is placed under its old heading",
  );
  reset();

  sub("specs/001-a/spec.md", /^- What happens when the list is empty/, "- What happens when the list is full");
  sub("specs/001-a/spec.md", /^### Edge Cases$/, "### Corner cases");
  git("commit", "-qam", "rename");
  git("tag", "renamed");
  sub("specs/001-a/spec.md", "Nothing is written.", "Nothing is written, ever.");
  assert.equal(
    run("specs/001-a", "renamed"),
    "material:numbered-section-changed",
    "an edit under an unlisted sub-heading of a material section is material",
  );
  git("checkout", "-q", "--", "specs");
  git("reset", "-q", "--hard", "HEAD~1");
  git("tag", "-d", "renamed");

  git("rm", "-q", "specs/001-a/tasks.md");
  assert.equal(run("specs/001-a"), "material:file-removed", "a deleted file is material");
  git("reset", "-q", "HEAD", "--", "specs");
  git("checkout", "-q", "--", "specs");

  rmSync(join(tmp, "specs/001-a"), { recursive: true });
  assert.equal(run("specs/001-a"), "material:file-removed", "a deleted spec folder is material");
  git("checkout", "-q", "--", "specs");

  appendFileSync(join(tmp, "specs/001-a/tasks.md"), "- [ ] T002 Test it\n");
  assert.equal(run("specs/001-a"), "material:task-lines-changed", "a new task line is material");
  reset();

  appendFileSync(join(tmp, "specs/001-a/plan.md"), "\n## Notes\n\nx\n");
  assert.equal(run("specs/001-a"), "material:section-changed", "a new heading is material");
  reset();

  w("specs/001-a/research.md", "# Research: a\n");
  assert.equal(run("specs/001-a"), "material:new-file", "an untracked file in the folder is new");
  reset();

  w("specs/002-b/spec.md", "# spec\n");
  assert.equal(run("specs/002-b"), "material:new-file", "a new folder is new-file");
  reset();
});

// The legacy file path is untouched
test("legacy single-file SPECs", () => {
  w("legacy.spec.md", "# x\n");
  assert.equal(run("legacy.spec.md"), "material:new-file", "a new legacy file is still new-file");

  // A single legacy SPEC file: a one-line edit INSIDE a contract section is
  // material. The hunk headers the old check read never name a `#` heading for
  // markdown, so each changed line is walked back to its `##` section instead.
  w(
    "legacy.spec.md",
    `# SPEC: legacy

## § 0 — User's verbatim ask

"make the export faster"

## § 1 — Behavior contract

- Export streams rows instead of buffering them.

## § 5 — Acceptance criteria

\`\`\`bash
# a comment inside a code block is not a heading
npm test   # expected: pass
\`\`\`

## § 6 — Test plan / E2E verification

- run it
`,
  );
  git("add", "legacy.spec.md");
  git("commit", "-qm", "legacy");
  sub("legacy.spec.md", "streams rows instead", "streams rows in batches instead");
  assert.equal(
    run("legacy.spec.md"),
    "material:numbered-section-changed",
    "a one-line Behavior edit in a single file is material",
  );
  git("checkout", "-q", "--", "legacy.spec.md");
  sub("legacy.spec.md", "npm test   # expected: pass", "npm run e2e   # expected: pass");
  assert.equal(
    run("legacy.spec.md"),
    "material:numbered-section-changed",
    "a one-line Acceptance edit (under a code-block comment) is material",
  );
  git("checkout", "-q", "--", "legacy.spec.md");
  sub("legacy.spec.md", '"make the export faster"', '"make the export fastr"');
  assert.equal(
    run("legacy.spec.md"),
    "non-material:minor-text-edit-2-lines",
    "a typo in the verbatim ask stays non-material",
  );
  git("checkout", "-q", "--", "legacy.spec.md");
  sub("legacy.spec.md", "- run it", "- run it twice");
  assert.equal(
    run("legacy.spec.md"),
    "non-material:minor-text-edit-2-lines",
    "an edit under the test plan stays non-material",
  );
  git("checkout", "-q", "--", "legacy.spec.md");

  // The heading forms legacy SPECs actually use, in either case: `## § 10 — AI
  // eval plan`, `## 9. AI Eval Plan`, `## 7. Data-reliability checklist`.
  w(
    "evals.spec.md",
    `# SPEC: evals

## § 9 — Failure modes

- the scorer times out

## § 10 — AI eval plan

- fixture: 20 labelled rows; pass bar 18

## 7. Data-reliability checklist

- stale beats wrong
`,
  );
  git("add", "evals.spec.md");
  git("commit", "-qm", "evals");
  sub("evals.spec.md", "pass bar 18", "pass bar 19");
  assert.equal(
    run("evals.spec.md"),
    "material:numbered-section-changed",
    "a one-line edit under '§ 10 — AI eval plan' is material",
  );
  git("checkout", "-q", "--", "evals.spec.md");
  sub("evals.spec.md", "stale beats wrong", "stale beats wrong, always");
  assert.equal(
    run("evals.spec.md"),
    "material:numbered-section-changed",
    "a one-line edit under '7. Data-reliability checklist' is material",
  );
  git("checkout", "-q", "--", "evals.spec.md");

  // Deleting a tracked single-file SPEC is the most material change there is.
  // The deleted-spec lookup asked only for `<path>/`, which names a folder and
  // never matches a file, so this read as `non-material:spec-file-missing`.
  rmSync(join(tmp, "evals.spec.md"));
  assert.equal(run("evals.spec.md"), "material:file-removed", "a deleted tracked single-file SPEC is material");
  git("checkout", "-q", "--", "evals.spec.md");
  // A path git-ref never had is still just missing.
  assert.equal(run("never.spec.md"), "non-material:spec-file-missing", "an untracked missing path is missing");
});

// ── A lean single file (Contextium's Ask / Behavior / Files / Done) ──
// Each changed line is walked back to its `##` section, so a one-line edit
// under Behavior or Done is material; the Ask (the user's quoted words) is not.
test("lean single-file SPECs", () => {
  w(
    "lean.spec.md",
    `# SPEC: lean

## 1 — Ask

"make the export faster"

## 2 — Behavior

- Export streams rows instead of buffering them.

## 3 — Files

- src/export.ts — UPDATE

## 4 — Done

npm test   # expected: pass
`,
  );
  git("add", "lean.spec.md");
  git("commit", "-qm", "lean");
  const back = (): void => void git("checkout", "-q", "--", "lean.spec.md");
  assert.equal(run("lean.spec.md"), "non-material:no-change", "unchanged file");
  sub("lean.spec.md", '"make the export faster"', '"make the export fastr"');
  assert.equal(run("lean.spec.md"), "non-material:minor-text-edit-2-lines", "a typo in the Ask is non-material");
  back();
  sub("lean.spec.md", "streams rows", "streams rows in batches of 500");
  assert.equal(
    run("lean.spec.md"),
    "material:numbered-section-changed",
    "a one-line Behavior edit in a single file is material",
  );
  back();
  sub("lean.spec.md", "- src/export.ts — UPDATE", "- src/export.ts — UPDATE, src/stream.ts — NEW");
  assert.equal(run("lean.spec.md"), "material:numbered-section-changed", "a one-line Files edit in a single file is material");
  back();
  sub("lean.spec.md", "npm test   # expected: pass", "npm test && npm run e2e");
  assert.equal(run("lean.spec.md"), "material:numbered-section-changed", "a one-line Done edit in a single file is material");
  back();
  appendFileSync(join(tmp, "lean.spec.md"), "\n## 5 — Notes\n");
  assert.equal(run("lean.spec.md"), "material:section-changed", "a new heading in a file is material");
  back();
  w("lean.spec.md", `a\n- b\n- c\n- d\n- e\n- f\n${r("lean.spec.md")}`);
  assert.equal(
    run("lean.spec.md"),
    "material:substantive-changes-6-lines",
    "added bullets outside the contract count as substantive lines",
  );
  back();
  assert.equal(exec(["nothing.spec.md"]).rc, 0, "exit is 0 for a missing file");
});

// ── A git read that FAILS is not "no change" ─────────────────────────────
// FAKE_GIT_FAIL makes one git subcommand error. Read as empty, a failed diff is
// "no-change" and a failed ls-tree is "new-file" or "nothing removed" — each a
// verdict about a spec nobody compared. It is reported, and treated as material
// so the audit runs.
test("a failed git read", () => {
  const realgit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  mkdirSync(join(tmp, "fakegit"), { recursive: true });
  const fake = join(tmp, "fakegit/git");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated $a failure" >&2; exit 128; fi
done
exec "${realgit}" "$@"
`,
  );
  chmodSync(fake, 0o755);
  const both = (x: Res): string => `${x.out}|${x.rc}`;

  for (const s of ["ls-tree", "diff"]) {
    assert.equal(
      both(exec(["specs/001-a"], { fail: s })),
      "material:git-read-failed|1",
      `folder: a failed git ${s} is reported material, exit 1`,
    );
  }
  assert.equal(
    both(exec(["legacy.spec.md"], { fail: "diff" })),
    "material:git-read-failed|1",
    "file: a failed git diff is reported material, exit 1",
  );
  assert.ok(exec(["legacy.spec.md"], { fail: "diff" }).err.includes("git diff failed"), "…and says which read failed");

  // A failed read of the OLD version is not "the file was absent": `git show`
  // failing on a path the ref has is a git error, answered material. Absent at
  // the ref stays the new-file answer.
  dropLine("legacy.spec.md", /npm test/);
  assert.equal(
    run("legacy.spec.md"),
    "material:numbered-section-changed",
    "baseline: deleting the acceptance command is material",
  );
  assert.equal(
    both(exec(["legacy.spec.md"], { fail: "show" })),
    "material:git-read-failed|1",
    "file: a failed git show of the old version is reported, exit 1",
  );
  git("checkout", "-q", "--", "legacy.spec.md");
  sub("specs/001-a/spec.md", "Nothing is written.", "Nothing is written, and it says so.");
  assert.equal(
    both(exec(["specs/001-a"], { fail: "show" })),
    "material:git-read-failed|1",
    "folder: a failed git show of a changed file is reported, exit 1",
  );
  git("checkout", "-q", "--", "specs");

  const fresh = mkdtempSync(join(tmpdir(), "cm-unborn."));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fresh, env: gitEnv });
    writeFileSync(join(fresh, "new.spec.md"), "# SPEC\n");
    assert.equal(
      both(exec(["new.spec.md"], { cwd: fresh })),
      "material:new-file|0",
      "a repo with no commits yet: a spec is new, not a read failure",
    );
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }

  // A ref that fails to resolve is "unborn" ONLY when the repo is readable and
  // HEAD is merely missing (`rev-parse --verify -q HEAD` exit 1). A rev-parse that
  // errors (exit 128) is a failed read, never "every file is new".
  assert.equal(
    both(exec(["legacy.spec.md"], { fail: "--verify" })),
    "material:git-read-failed|1",
    "a rev-parse that errors is a read failure, not an unborn repo",
  );
  assert.equal(both(exec(["specs/001-a"], { fail: "--verify" })), "material:git-read-failed|1", "…in a folder too");
});
