// validate.test.ts — the fixed-order Phase 4 driver.
//
// The thing worth testing here is not that each layer runs. It is that the ORDER
// cannot be chosen: there is no argument that reaches the reviewer without
// layer 1 passing first, and no phase that skips E2E after a clean review. A
// suite that only asserted "layer 1 ran" would pass against the SKILL.md table
// this script replaced, which had exactly that hole.
//
// The reviewer is stubbed everywhere. What is under test is how this script
// READS a reviewer — every documented exit code, and the difference between a
// [nit] and a [must-fix] — not whether a vendor answers.
//
// validate.ts is spawned (`node --experimental-strip-types validate.ts`), never
// imported. It runs every program it orchestrates — the
// layers, the scope resolver, the reviewer, the automated checks, the QA
// enumerator and the marker helper — with node, so every stand-in below is a
// TypeScript file written at run time. The reviewer and automated-check
// stand-ins keep their bodies in shell (the snapshot half is real git
// plumbing) behind a two-line `.ts` that runs the body with `sh` (`tsWrap`).
// /qa's lib.ts is imported for the one formula this suite needs: where the
// interaction stamp lives.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/validate.test.ts
//
// peers:
//   .agents/skills/implement/scripts/validate.ts
//   .agents/skills/qa/scripts/mark-qa-done.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cksum, qaInteractionStampPath } from "../../qa/scripts/lib.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(SCRIPT_DIR, "validate.ts");
const CLI_EXIT = resolve(SCRIPT_DIR, "../../../packages/cli-exit/cli-exit.ts");
const SKILLS_DIR = resolve(SCRIPT_DIR, "../..");
const MARK_QA_DONE = join(SKILLS_DIR, "qa/scripts/mark-qa-done.ts");

const TMP = mkdtempSync(join(tmpdir(), "validate-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Every run keeps its review receipt and round counters under this suite's own
// HOME, never the thread cache of the session running it, and resolves no T3
// thread or native session from the environment it was started in. Each
// program run is its own audit owner unless a case names one, so one case's
// approved receipt is never reused by the next case's review.
process.env.HOME = join(TMP, "home");
process.env.T3CODE_HOME = join(TMP, "absent-t3");
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.WORKBENCH_THREAD_ID;
delete process.env.CODE_REVIEW_LOOP_ID;
let OWNER = 0;

// These cases test the marker's keys and the gate that reads them, not the
// interaction check behind a served app's marker (tested in
// .agents/skills/qa/scripts/tests/interaction-check.test.ts), so they lay its stamp down.
function stampInteraction(doneDir: string, tree: string, app: string): void {
  const saved = process.env.QA_DONE_DIR;
  process.env.QA_DONE_DIR = doneDir;
  try {
    const f = qaInteractionStampPath(app, tree);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "");
  } finally {
    if (saved === undefined) delete process.env.QA_DONE_DIR;
    else process.env.QA_DONE_DIR = saved;
  }
}

const shq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function writeExec(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}
/**
 * A `.ts` stand-in beside a shell body: validate.ts runs its seams with node, so
 * the stand-in is TypeScript. It hands its argv, environment, cwd and stdio to
 * the shell body and leaves with the body's status.
 */
function tsWrap(shPath: string): string {
  const tsPath = shPath.replace(/\.sh$/, ".ts");
  writeFileSync(
    tsPath,
    `import { spawnSync } from "node:child_process";
const r = spawnSync("sh", [${JSON.stringify(shPath)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );
  return tsPath;
}
/** A copy of the scripts folder, three levels below a planted cli-exit as the real one sits. */
function scriptsCopy(name: string): string {
  const dir = join(TMP, name, ".agents/skills/implement/scripts");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(TMP, name, ".agents/packages/cli-exit"), { recursive: true });
  copyFileSync(CLI_EXIT, join(TMP, name, ".agents/packages/cli-exit/cli-exit.ts"));
  for (const f of [
    "layer-1.ts",
    "layer-2.ts",
    "layer-3.ts",
    "resolve-scope.ts",
    "session-write-root.ts",
    "validate.ts",
  ]) {
    copyFileSync(join(SCRIPT_DIR, f), join(dir, f));
  }
  return dir;
}
const runNode = (script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    ...opts,
    env: { ...(opts.env ?? process.env), CODE_REVIEW_LOOP_ID: opts.env?.CODE_REVIEW_LOOP_ID ?? `vt-owner-${++OWNER}` },
  });
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
}

// ── A worktree that looks like the real one ───────────────────────────

const REPO = join(TMP, "repo");
mkdirSync(join(REPO, ".agents/checks"), { recursive: true });
gitRepo(REPO);
writeFileSync(join(REPO, "seed.txt"), "seed\n");
git(REPO, "add", "seed.txt");
git(REPO, "commit", "-qm", "init");

// The snapshot half of the reviewer contract is real git plumbing, so the stub
// implements it rather than faking it — --since scoping and the tree-moved
// branch both depend on a snapshot that actually reflects the working tree.
const SNAPSHOT_BLOCK = `if [ "\${1:-}" = "--snapshot" ]; then
  idx="$(mktemp)"; rm -f "$idx"
  GIT_INDEX_FILE="$idx" git -C ${shq(REPO)} read-tree HEAD 2>/dev/null || GIT_INDEX_FILE="$idx" git -C ${shq(REPO)} read-tree --empty
  GIT_INDEX_FILE="$idx" git -C ${shq(REPO)} add -A 2>/dev/null
  GIT_INDEX_FILE="$idx" git -C ${shq(REPO)} write-tree
  rm -f "$idx"
  exit 0
fi
`;
/**
 * What a reviewer in receipt mode leaves at CODE_REVIEW_RESULT_FILE: the
 * answering vendor, its triage lines and its coverage (code-review.ts writes it
 * on every completed review when validate.ts asks for one).
 */
function resultBlock(out: string, coverage = "[]"): string {
  const lines = out === "" || out === "NO_FINDINGS" ? [] : out.split("\n").filter((l) => l.startsWith("["));
  const json = `{"vendor":"grok/stub","attempt":1,"findings":${JSON.stringify(lines)},"coverage":${coverage}}`;
  return `if [ -n "\${CODE_REVIEW_RESULT_FILE:-}" ]; then printf '%s\\n' ${shq(json)} >"\$CODE_REVIEW_RESULT_FILE"; fi
`;
}
function makeReviewer(out: string, rc: number, name: string): string {
  return tsWrap(
    writeExec(
      join(TMP, `reviewer-${name}.sh`),
      `#!/bin/sh
${SNAPSHOT_BLOCK}printf '%s\\n' "$@" >>${shq(join(TMP, "reviewer-calls.log"))}
${rc === 0 ? resultBlock(out) : ""}${out !== "" ? `printf '%s\\n' ${shq(out)}\n` : ""}exit ${rc}
`,
    ),
  );
}
/** Take a snapshot through the stand-in's shell body, as the suite always has. */
const snapshot = (stub: string) =>
  execFileSync("bash", [stub.replace(/\.ts$/, ".sh"), "--snapshot"], { encoding: "utf8" }).trim();

// A no-op stand-in for the pieces this script only orchestrates. TypeScript,
// because validate.ts runs every one of them with node.
const NOOP_TS = writeExec(join(TMP, "noop.ts"), "process.exit(0);\n");

interface Stubs {
  STUB_CHECKS?: string;
  STUB_REVIEW?: string;
  STUB_TARGETS?: string;
  CODE_REVIEW_ROUND_STATE_DIR?: string;
  /** The audit owner; each run is its own owner when unset. */
  OWNER?: string;
}
function runValidate(args: string[], stubs: Stubs = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: REPO,
    VALIDATE_AUTOMATED_CHECKS: stubs.STUB_CHECKS ?? NOOP_TS,
    VALIDATE_CODE_REVIEW: stubs.STUB_REVIEW ?? NOOP_TS,
    VALIDATE_QA_TARGETS: stubs.STUB_TARGETS ?? NOOP_TS,
    VALIDATE_MARK_QA_DONE: MARK_QA_DONE,
    QA_DONE_DIR: join(TMP, "qa-done"),
  };
  if (stubs.CODE_REVIEW_ROUND_STATE_DIR !== undefined)
    env.CODE_REVIEW_ROUND_STATE_DIR = stubs.CODE_REVIEW_ROUND_STATE_DIR;
  if (stubs.OWNER !== undefined) env.CODE_REVIEW_LOOP_ID = stubs.OWNER;
  const r = runNode(VALIDATE, ["--repo", REPO, ...args], { env });
  return { rc: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
function bare(args: string[]) {
  const r = runNode(VALIDATE, args);
  return { rc: r.status, all: `${r.stdout}${r.stderr}` };
}
function markQaDone(doneDir: string, args: string[]): string {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", MARK_QA_DONE, ...args], {
    encoding: "utf8",
    env: { ...process.env, QA_DONE_DIR: doneDir },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// ── The order is not choosable ────────────────────────────────────────
//
// This is the whole point of the script existing. There is no phase name, and no
// combination of flags, that spells "review, then lint".

test("an invented phase is refused", () =>
  assert.ok(bare(["--repo", REPO, "--phase", "review-first"]).all.includes("unknown phase")));
test("and refusing it is a caller error", () => assert.equal(bare(["--repo", REPO, "--phase", "review-first"]).rc, 2));
test("no phase at all is a caller error", () => assert.equal(bare(["--repo", REPO]).rc, 2));
test("a non-worktree is a caller error", () =>
  assert.equal(bare(["--repo", join(TMP, "not-a-repo"), "--phase", "checks"]).rc, 2));

// ── --phase checks ────────────────────────────────────────────────────

test("a clean checks phase emits NEED_FIX=0", () =>
  assert.ok(runValidate(["--phase", "checks", "--scope", "seed.txt"]).out.includes("NEED_FIX=0")));
// The first E2E is unconditional: an unchanged review must not buy a skipped one.
test("checks always asks for the E2E walk", () =>
  assert.ok(runValidate(["--phase", "checks", "--scope", "seed.txt"]).out.includes("NEED_E2E=1")));
test("and says so in words", () =>
  assert.ok(runValidate(["--phase", "checks", "--scope", "seed.txt"]).out.includes("walk SPEC § 6")));

// Layer 1 failing must stop everything. A typecheck error makes a test result
// meaningless and a review of it worse than meaningless.
const FAKE_SCRIPTS = scriptsCopy("fake");
writeFileSync(
  join(FAKE_SCRIPTS, "layer-1.ts"),
  'import { readFileSync } from "node:fs";\nreadFileSync(0);\nprocess.stdout.write("FAIL: layer-1 lint (apps/foo)\\n");\nprocess.exitCode = 1;\n',
);
writeFileSync(
  join(FAKE_SCRIPTS, "layer-2.ts"),
  'import { readFileSync } from "node:fs";\nreadFileSync(0);\nprocess.stdout.write("layer-2 RAN\\n");\n',
);
const REVIEW_CALLED = join(TMP, "review-called");
const MARKING_REVIEWER = tsWrap(
  writeExec(
    join(TMP, "marking-reviewer.sh"),
    `#!/bin/sh
if [ "\${1:-}" = "--snapshot" ]; then echo 0000000000000000000000000000000000000000; exit 0; fi
touch ${shq(REVIEW_CALLED)}
echo NO_FINDINGS
exit 0
`,
  ),
);
const layer1Fail = (() => {
  let memo: { rc: number | null; out: string } | undefined;
  return () => {
    if (memo === undefined) {
      const r = runNode(
        join(FAKE_SCRIPTS, "validate.ts"),
        ["--repo", REPO, "--phase", "checks", "--scope", "seed.txt"],
        {
          env: { ...process.env, CLAUDE_PROJECT_DIR: REPO, VALIDATE_CODE_REVIEW: MARKING_REVIEWER },
        },
      );
      memo = { rc: r.status, out: r.stdout };
    }
    return memo;
  };
})();
test("layer-1 FAIL fails the checks phase", () => assert.equal(layer1Fail().rc, 1));
test("layer-1 FAIL still emits NEED_FIX", () => assert.ok(layer1Fail().out.includes("NEED_FIX=1")));
test("layer-1 FAIL does not run layer 2", () => assert.equal(layer1Fail().out.includes("layer-2 RAN"), false));
test("layer-1 FAIL must not reach the reviewer", () => assert.equal(existsSync(REVIEW_CALLED), false));

// ── --phase review reads every documented reviewer exit ───────────────

// A round-1 review: how the driver READS each reviewer exit. (A follow-up round
// with no completed review behind it cannot approve anything — see the
// converged case below — so the exit-code cases are full reviews.)
function reviewCase(name: string, stdout: string, rcIn: number) {
  const stub = makeReviewer(stdout, rcIn, name);
  return runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: stub,
  });
}
/** An owner whose round-1 review of the tree as it is now came back clean. */
const SEED_REVIEWER = makeReviewer("NO_FINDINGS", 0, "seed");
function seededOwner(): string {
  const owner = `vt-seeded-${++OWNER}`;
  const r = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: SEED_REVIEWER,
    OWNER: owner,
  });
  assert.equal(r.rc, 0, r.all);
  return owner;
}

test("NO_FINDINGS is NEED_FIX=0", () => assert.ok(reviewCase("clean", "NO_FINDINGS", 0).out.includes("NEED_FIX=0")));
test("and the phase passes", () => assert.equal(reviewCase("clean2", "NO_FINDINGS", 0).rc, 0));

test("a must-fix sets NEED_FIX=1, and the finding is passed through", async (t) => {
  const out = reviewCase("mustfix", "[must-fix] a.ts:1: broken — fix it — x", 0).out;
  await t.test("a must-fix sets NEED_FIX=1", () => assert.ok(out.includes("NEED_FIX=1"), out));
  await t.test("and the finding is passed through", () => assert.ok(out.includes("[must-fix] a.ts:1"), out));
});
test("and the phase fails", () => assert.equal(reviewCase("mustfix2", "[must-fix] a.ts:1: broken", 0).rc, 1));

test("a should-fix also sets NEED_FIX=1", () =>
  assert.ok(reviewCase("shouldfix", "[should-fix] a.ts: tidy this", 0).out.includes("NEED_FIX=1")));

// A nit is held for the end of the loop, never a reason to re-enter it — nits
// are an unbounded supply.
test("a nit alone is NEED_FIX=0, but the nit is still reported", async (t) => {
  const out = reviewCase("nit", "[nit] name this better", 0).out;
  await t.test("a nit alone is NEED_FIX=0", () => assert.ok(out.includes("NEED_FIX=0"), out));
  await t.test("but the nit is still reported", () => assert.ok(out.includes("[nit] name this better"), out));
});
test("and the phase passes on a nit", () => assert.equal(reviewCase("nit2", "[nit] x", 0).rc, 0));

// Converged with no approved review behind it: nothing was reviewed, so no
// approval is manufactured. It used to exit 4, "stop and approve".
test("a converged round with no approved review behind it is not a pass", () => {
  const r = reviewCase("conv", "", 4);
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("NEED_FIX=1"), r.out);
});
test("and says it converged", () => assert.ok(reviewCase("conv2", "", 4).out.includes("converged")));
test("a convergence result cannot override failing validation of moved bytes", () => {
  const reviewer = makeReviewer("", 4, "converged-failed-check");
  const before = snapshot(reviewer);
  const file = join(REPO, "seed.txt");
  const content = readFileSync(file);
  try {
    writeFileSync(file, "changed since the validation snapshot\n");
    const r = runNode(
      join(FAKE_SCRIPTS, "validate.ts"),
      ["--repo", REPO, "--phase", "review", "--since", before, "--scope", "seed.txt"],
      {
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: REPO,
          VALIDATE_CODE_REVIEW: reviewer,
          VALIDATE_AUTOMATED_CHECKS: NOOP_TS,
        },
      },
    );
    assert.match(r.stdout, /NEED_FIX=1/);
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally {
    writeFileSync(file, content);
  }
});
// At the ceiling the validator runs the one final review of the
// outstanding fixes itself, and its findings count like a round's.
function finalReviewer(name: string, finalOut: string, finalRc: number): string {
  return tsWrap(
    writeExec(
      join(TMP, `reviewer-${name}.sh`),
      `#!/bin/sh
${SNAPSHOT_BLOCK}printf '%s\\n' "$@" >>${shq(join(TMP, `calls-${name}.log`))}
case " $* " in *" --final "*) ${finalRc === 0 ? resultBlock(finalOut).trim().concat("; ") : ""}${finalOut !== "" ? `printf '%s\\n' ${shq(finalOut)}; ` : ""}exit ${finalRc};; esac
exit 5
`,
    ),
  );
}
test("at the ceiling, the final review runs and its findings count", async (t) => {
  const stub = finalReviewer("final1", "[must-fix] f.ts:1: the round-4 fix missed a case — x", 0);
  const r = runValidate(["--phase", "review", "--since", snapshot(stub), "--scope", "seed.txt"], { STUB_REVIEW: stub });
  await t.test("the final pass was asked for", () =>
    assert.ok(readFileSync(join(TMP, "calls-final1.log"), "utf8").includes("--final")),
  );
  await t.test("its finding is passed through", () => assert.ok(r.out.includes("[must-fix] f.ts:1"), r.out));
  await t.test("and sets NEED_FIX=1", () => assert.ok(r.out.includes("NEED_FIX=1"), r.out));
});
test("a final review already spent cannot approve unreviewed fixes", async (t) => {
  const stub = finalReviewer("final2", "", 5);
  const r = runValidate(["--phase", "review", "--since", snapshot(stub), "--scope", "seed.txt"], { STUB_REVIEW: stub });
  await t.test("the phase preserves the review-limit exit", () => assert.equal(r.rc, 5, r.out + r.err));
  await t.test("the phase refuses approval", () => assert.ok(r.out.includes("NEED_FIX=1"), r.out));
  await t.test("and says what is still open", () => assert.ok(r.out.includes("still open"), r.out));
});
test("exit 5 (round ceiling) cannot become a clean review", () => assert.equal(reviewCase("ceil", "", 5).rc, 5));
test("and says what to do", () => assert.ok(reviewCase("ceil2", "", 5).out.includes("still open")));

test("exit 1 (chain exhausted) fails the phase", () => assert.equal(reviewCase("dead", "", 1).rc, 1));
// Exit 3: no independent reviewer answered. That is a review still OWED, not a
// pass and not a failure: the phase exits 3 (pending) until the fresh-context
// fallback reviewer has run and --fallback-review has read its findings. A
// phase that reported success here would let the loop go on with no review.
test("exit 3 (no independent reviewer) leaves the phase pending", () =>
  assert.equal(reviewCase("claude", "", 3).rc, 3));
test("exit 3 asks for the fallback review, names the record, and is not a fix request", async (t) => {
  const out = reviewCase("claude2", "", 3).out;
  await t.test("exit 3 asks for the fresh-context fallback review", () =>
    assert.ok(out.includes("NEED_FALLBACK_REVIEW=1"), out),
  );
  await t.test("exit 3 names the line to record", () =>
    assert.ok(out.includes("claude-fallback (fresh context, NOT independent)"), out),
  );
  await t.test("exit 3 is not a fix request", () => assert.ok(out.includes("NEED_FIX=0"), out));
});
test("a normal review asks for no fallback", () =>
  assert.equal(reviewCase("clean3", "NO_FINDINGS", 0).out.includes("NEED_FALLBACK_REVIEW=1"), false));

// --fallback-review <file> records the fallback reviewer's reply against the
// receipt the pending attempt opened, and is the only way out of pending: a
// finding is NEED_FIX=1 / exit 1, none is a pass. Each case opens its own
// pending attempt (a review whose chain exits 3) under its own owner first.
const fallbackFile = (name: string, body: string): string => {
  const p = join(TMP, `fb-${name}.txt`);
  writeFileSync(p, body);
  return p;
};
const NO_VENDOR = makeReviewer("", 3, "pending");
function pendingOwner(): string {
  const owner = `vt-pending-${++OWNER}`;
  const r = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: NO_VENDOR,
    OWNER: owner,
  });
  assert.equal(r.rc, 3, r.all);
  return owner;
}
const fallback = (file: string, owner = pendingOwner()) => runValidate(["--fallback-review", file], { OWNER: owner });
test("a fallback is refused for an attempt the chain did not leave pending", async (t) => {
  // A dead chain (exit 1) leaves its attempt open but NOT pending: a fallback
  // never stands in for a vendor that ran and failed.
  const owner = `vt-dead-${++OWNER}`;
  const dead = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: makeReviewer("", 1, "dead-for-fallback"),
    OWNER: owner,
  });
  assert.equal(dead.rc, 1, dead.all);
  const r = runValidate(["--fallback-review", fallbackFile("unpending", "NO_FINDINGS\n")], { OWNER: owner });
  await t.test("refused", () => assert.equal(r.rc, 1, r.all));
  await t.test("…because nothing is pending", () => assert.ok(r.err.includes("not pending a fallback"), r.all));
  await t.test("…and not recorded", () => assert.ok(r.err.includes("NOT recorded"), r.all));
  const none = runValidate(["--fallback-review", fallbackFile("unopened", "NO_FINDINGS\n")], { OWNER: seededOwner() });
  await t.test("with no open attempt at all, refused too", () => assert.equal(none.rc, 1, none.all));
});
test("the pending note names the receipt's coverage items file when there is one", () => {
  const owner = `vt-pending-items-${++OWNER}`;
  const r = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: NO_VENDOR,
    OWNER: owner,
  });
  assert.equal(r.rc, 3, r.all);
  assert.match(r.out, /coverage items in \S*review-items-[0-9a-f]+\.json/);
  assert.match(r.out, /--fallback-review <file> --repo /);
});
test("a clean fallback review passes, recorded as not independent, with no fix owed", async (t) => {
  const r = fallback(fallbackFile("clean", "[nit] tidy this\n"));
  await t.test("a clean fallback review passes", () => assert.equal(r.rc, 0, r.all));
  await t.test("…recorded as not independent", () =>
    assert.ok(r.out.includes("claude-fallback (fresh context, NOT independent)"), r.out),
  );
  await t.test("…with no fix owed", () => assert.ok(r.out.includes("NEED_FIX=0"), r.out));
  await t.test("…and the receipt approves", () => assert.ok(r.out.includes("RECEIPT: approved"), r.out));
});
test("a fallback finding fails like any review finding, and is reported", async (t) => {
  const r = fallback(fallbackFile("dirty", "[must-fix] a.ts:1: wrong\n[nit] x\n"));
  await t.test("a fallback finding fails like any review finding", () => assert.equal(r.rc, 1, r.all));
  await t.test("…and is reported", () => assert.ok(r.out.includes("[must-fix] a.ts:1: wrong"), r.out));
});
test("a missing findings file is a caller error", () => assert.equal(fallback(join(TMP, "no-such.txt")).rc, 2));
test("--fallback-review with no file is a caller error", () =>
  assert.equal(runValidate(["--fallback-review"]).rc, 2));
// An empty file, or one with neither a finding nor the NO_FINDINGS sentinel, is
// a review that did not happen — never a clean one.
test("an empty fallback findings file fails", () => assert.equal(fallback(fallbackFile("empty", "")).rc, 1));
test("prose with no finding line and no sentinel fails, saying the review did not happen", async (t) => {
  const r = fallback(fallbackFile("prose", "I looked at the diff and it seems fine overall.\n"));
  await t.test("prose with no finding line and no sentinel fails", () => assert.equal(r.rc, 1, r.all));
  await t.test("…saying the review did not happen", () => assert.ok(r.all.includes("did NOT happen"), r.all));
});
test("NO_FINDINGS is a clean fallback review", () =>
  assert.equal(fallback(fallbackFile("none", "NO_FINDINGS\n")).rc, 0));
// The fallback reviewer's own format (.agents/agents/implement-audit-reviewer.md)
// is read as it is: a fix-now or deferred-batch verdict is a fix owed, and its
// "Zero findings." line is a clean review.
test("the agent's fix-now verdict is a fix owed", () =>
  assert.equal(
    fallback(
      fallbackFile(
        "agent",
        "## Findings\n\n1. **Off by one**: `a.ts:3` — loop bound — verdict: **fix-now** — violated rule: none — use <\n",
      ),
    ).rc,
    1,
  ));
test("the agent's speculative-only verdict is a pass", () =>
  assert.equal(
    fallback(
      fallbackFile(
        "agent-spec",
        "## Findings\n\n1. **Maybe**: `a.ts:3` — hunch — verdict: **speculative** — violated rule: none — none\n",
      ),
    ).rc,
    0,
  ));
test("the agent's Zero findings line is a clean review", () =>
  assert.equal(
    fallback(
      fallbackFile(
        "agent-zero",
        "Zero findings. Work is consistent, complete, and downstream-clean within the reviewed scope.\n",
      ),
    ).rc,
    0,
  ));
test("exit 124 (timeout) fails the phase", () => assert.equal(reviewCase("slow", "", 124).rc, 1));
test("a dead chain says the review did not happen", () =>
  assert.ok(reviewCase("dead2", "", 1).all.includes("did NOT happen")));

// A missing reviewer is a failed audit, never a quiet pass.
test("a missing reviewer fails the phase and sets NEED_FIX=1", async (t) => {
  const r = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: join(TMP, "no-such-reviewer.ts"),
  });
  await t.test("a missing reviewer fails the phase", () => assert.equal(r.rc, 1));
  await t.test("and sets NEED_FIX=1", () => assert.ok(r.out.includes("NEED_FIX=1"), r.out));
});

// Round 1 needs a range; rounds 2+ need a tree. Neither is guessed.
test("review with neither --base/--head nor --since is a caller error", () =>
  assert.equal(
    runValidate(["--phase", "review", "--scope", "seed.txt"], { STUB_REVIEW: makeReviewer("NO_FINDINGS", 0, "arity") })
      .rc,
    2,
  ));

// The automated checks are mandatory: a FAIL there stops the phase before a
// vendor call is spent.
test("a failing automated check fails the phase and sets NEED_FIX=1", async (t) => {
  const failing = tsWrap(
    writeExec(join(TMP, "failing-checks.sh"), '#!/bin/sh\necho "FAIL: check-refs a.ts:1 dangling"\nexit 1\n'),
  );
  const r = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_CHECKS: failing,
    STUB_REVIEW: makeReviewer("NO_FINDINGS", 0, "checksfail"),
  });
  await t.test("a failing automated check fails the phase", () => assert.equal(r.rc, 1));
  await t.test("and sets NEED_FIX=1", () => assert.ok(r.out.includes("NEED_FIX=1"), r.out));
});

// ── The tree moving over a review re-arms E2E ─────────────────────────
//
// The reviewer never edits the tree, so a moved tree means something else did —
// and the layers already ran against bytes that are no longer what ships.

test("a tree that moved over the review re-arms E2E", () => {
  const mover = tsWrap(
    writeExec(
      join(TMP, "tree-mover.sh"),
      `#!/bin/sh
${SNAPSHOT_BLOCK}# Something edits the tree while the round is in flight.
date +%s%N >${shq(join(REPO, "moved.txt"))}
echo NO_FINDINGS
exit 0
`,
    ),
  );
  const out = runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
    STUB_REVIEW: mover,
  }).out;
  rmSync(join(REPO, "moved.txt"), { force: true });
  assert.ok(out.includes("NEED_E2E=1"), out);
});
test("an unmoved tree does not re-arm E2E", () =>
  assert.ok(
    runValidate(["--phase", "review", "--base", "HEAD", "--head", "HEAD", "--scope", "seed.txt"], {
      STUB_REVIEW: makeReviewer("NO_FINDINGS", 0, "still"),
    }).out.includes("NEED_E2E=0"),
  ));

// ── --phase qa-list ───────────────────────────────────────────────────

const NO_TARGETS = writeExec(join(TMP, "no-targets.ts"), "process.exit(0);\n");
test("no web target prints an empty QA_TARGETS, and names the record to keep", async (t) => {
  const out = runValidate(["--phase", "qa-list"], { STUB_TARGETS: NO_TARGETS }).out;
  await t.test("no web target prints an empty QA_TARGETS", () => assert.ok(out.includes("QA_TARGETS="), out));
  await t.test("and names the record to keep", () => assert.ok(out.includes("skipped-not-web"), out));
});

test("two targets are two QA_TARGETS lines, the first and the second", async (t) => {
  const two = writeExec(join(TMP, "two-targets.ts"), 'process.stdout.write("/apps/one\\n/apps/two\\n");\n');
  const out = runValidate(["--phase", "qa-list"], { STUB_TARGETS: two }).out;
  await t.test("two targets are two QA_TARGETS lines", () =>
    assert.equal(out.match(/^QA_TARGETS=\/apps\//gm)?.length, 2, out),
  );
  await t.test("the first target", () => assert.ok(out.includes("QA_TARGETS=/apps/one"), out));
  await t.test("the second target", () => assert.ok(out.includes("QA_TARGETS=/apps/two"), out));
});

// The enumerator failing is a HALT. A detector failure that read as "no UI
// changed" would close a UI session with no QA at all.
test("a failing enumerator is a HALT, and says why", async (t) => {
  const broken = writeExec(join(TMP, "broken-targets.ts"), "process.exit(2);\n");
  const r = runValidate(["--phase", "qa-list"], { STUB_TARGETS: broken });
  await t.test("a failing enumerator is a HALT", () => assert.equal(r.rc, 2));
  await t.test("and says why", () => assert.ok(r.err.includes("must never read as 'no UI changed'"), r.err));
});
test("a missing enumerator is a HALT too", () => {
  const r = runValidate(["--phase", "qa-list"], { STUB_TARGETS: join(TMP, "no-such-enumerator.ts") });
  assert.equal(r.rc, 2);
  assert.ok(r.err.includes("no enumerator at"), r.err);
});

// ── --require-qa ──────────────────────────────────────────────────────
//
// The gate that makes "QA must run fully if there's a UI" a mechanism rather
// than an instruction.

const APP_A = join(TMP, "app-a");
const APP_B = join(TMP, "app-b");
mkdirSync(APP_A);
mkdirSync(APP_B);
const TARGETS = join(TMP, "targets.txt");
writeFileSync(TARGETS, `${APP_A}\n${APP_B}\n`);
const EMPTY_TARGETS = join(TMP, "empty-targets.txt");
writeFileSync(EMPTY_TARGETS, "");
const TREE1 = "1111111111111111111111111111111111111111";
const TREE2 = "2222222222222222222222222222222222222222";
const QA_DONE = join(TMP, "qa-done");
const requireQa = (targets: string, tree: string) =>
  runValidate(["--require-qa", "--targets-file", targets, "--tree", tree]);

test("a web target with no marker blocks the close, and names the target", async (t) => {
  rmSync(QA_DONE, { recursive: true, force: true });
  const r = requireQa(TARGETS, TREE1);
  await t.test("a web target with no marker blocks the close", () => assert.equal(r.rc, 1));
  await t.test("and names the target", () => assert.ok(r.out.includes(`FAIL: qa-marker ${APP_A}`), r.out));
});
test("one of two marked is still a block: the marked one passes, the unmarked one fails", async (t) => {
  stampInteraction(QA_DONE, TREE1, APP_A);
  markQaDone(QA_DONE, ["--tree", TREE1, APP_A]);
  const r = requireQa(TARGETS, TREE1);
  await t.test("one of two marked is still a block", () => assert.equal(r.rc, 1));
  await t.test("the marked one passes", () => assert.ok(r.out.includes(`PASS: qa-marker ${APP_A}`), r.out));
  await t.test("the unmarked one fails", () => assert.ok(r.out.includes(`FAIL: qa-marker ${APP_B}`), r.out));
});
test("both marked passes, and says how many", async (t) => {
  stampInteraction(QA_DONE, TREE1, APP_B);
  markQaDone(QA_DONE, ["--tree", TREE1, APP_B]);
  const r = requireQa(TARGETS, TREE1);
  await t.test("both marked passes", () => assert.equal(r.rc, 0, r.all));
  await t.test("and says how many", () => assert.ok(r.out.includes("2 target(s) complete"), r.out));
});

// The two-target case from SPEC § 4: B's /qa edited source, so the tree moved,
// so A's pass no longer describes what ships. A must run again.
test("a marker from the OLD tree does not satisfy the new one: A and B are re-armed", async (t) => {
  const r = requireQa(TARGETS, TREE2);
  await t.test("a marker from the OLD tree does not satisfy the new one", () => assert.equal(r.rc, 1));
  await t.test("A is re-armed by the tree move", () => assert.ok(r.out.includes(`FAIL: qa-marker ${APP_A}`), r.out));
  await t.test("and so is B", () => assert.ok(r.out.includes(`FAIL: qa-marker ${APP_B}`), r.out));
});

// 0 targets: nothing to require.
test("0 targets is a no-op pass", () => assert.equal(requireQa(EMPTY_TARGETS, TREE2).rc, 0));
test("--require-qa without --tree is a caller error", () =>
  assert.equal(runValidate(["--require-qa", "--targets-file", TARGETS]).rc, 2));
test("--require-qa without --targets-file is a caller error", () =>
  assert.equal(runValidate(["--require-qa", "--tree", TREE1]).rc, 2));
test("an unreadable targets file is a caller error", () =>
  assert.equal(requireQa(join(TMP, "no-such-file"), TREE1).rc, 2));

// ── --phase qa-revalidate ─────────────────────────────────────────────

const UNMOVED = makeReviewer("NO_FINDINGS", 0, "qaclean");
const SNAP_NOW = snapshot(UNMOVED);
const QA_UNMOVED_OWNER = seededOwner();
// Each post-QA case is its own audit: an owner whose build review covered the
// tree before /qa's fix, so the fix is what the qa bucket reviews. Shared, the
// first case's approved receipt would be reused by the next.
function freshQaOwner(): string {
  rmSync(join(REPO, "qa-fix.txt"), { force: true });
  const owner = seededOwner();
  writeFileSync(join(REPO, "qa-fix.txt"), "a fix /qa made\n");
  return owner;
}
test("/qa that changed nothing needs no re-review, and does not re-arm E2E", async (t) => {
  const out = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: UNMOVED,
    OWNER: QA_UNMOVED_OWNER,
  }).out;
  await t.test("/qa that changed nothing needs no re-review", () => assert.ok(out.includes("changed nothing"), out));
  await t.test("and does not re-arm E2E", () => assert.ok(out.includes("NEED_E2E=0"), out));
});

// /qa edited source: those edits are code nobody reviewed.
test("/qa's edits re-arm E2E and come back reviewed clean", async (t) => {
  writeFileSync(join(REPO, "qa-fix.txt"), "a fix /qa made\n");
  const out = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: UNMOVED,
    OWNER: freshQaOwner(),
  }).out;
  await t.test("/qa's edits re-arm E2E", () => assert.ok(out.includes("NEED_E2E=1"), out));
  await t.test("and come back reviewed clean", () => assert.ok(out.includes("NEED_FIX=0"), out));
});
test("a finding in /qa's own edits fails the phase, and is reported", async (t) => {
  const r = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: makeReviewer("[must-fix] qa-fix.txt:1: /qa broke it", 0, "qadirty"),
    OWNER: freshQaOwner(),
  });
  rmSync(join(REPO, "qa-fix.txt"), { force: true });
  await t.test("a finding in /qa's own edits fails the phase", () => assert.equal(r.rc, 1));
  await t.test("and is reported", () => assert.ok(r.out.includes("/qa broke it"), r.out));
});
// No independent reviewer for /qa's edits: pending, exactly as in --phase review.
test("qa-revalidate with no independent reviewer is pending, and asks for the fallback review", async (t) => {
  writeFileSync(join(REPO, "qa-fix.txt"), "another /qa fix\n");
  const r = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: makeReviewer("", 3, "qanorev"),
  });
  rmSync(join(REPO, "qa-fix.txt"), { force: true });
  await t.test("qa-revalidate with no independent reviewer is pending", () => assert.equal(r.rc, 3, r.all));
  await t.test("…and asks for the fallback review", () => assert.ok(r.out.includes("NEED_FALLBACK_REVIEW=1"), r.out));
});

// The final review for the post-QA loop too: /qa can take several fix passes, and when they
// spend the post-QA round budget the newest edits still get their one final
// review — not "unreviewed" and a halt.
test("post-QA at the ceiling: the final review runs and its findings count", async (t) => {
  writeFileSync(join(REPO, "qa-fix.txt"), "a fix /qa made\n");
  const stub = finalReviewer("qafinal1", "[must-fix] qa-fix.txt:1: the last /qa fix missed a case — x", 0);
  const r = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: stub,
    OWNER: freshQaOwner(),
  });
  rmSync(join(REPO, "qa-fix.txt"), { force: true });
  await t.test("the final pass was asked for", () =>
    assert.ok(readFileSync(join(TMP, "calls-qafinal1.log"), "utf8").includes("--final")),
  );
  await t.test("its finding is passed through", () => assert.ok(r.out.includes("[must-fix] qa-fix.txt:1"), r.out));
  await t.test("and fails the phase", () => assert.equal(r.rc, 1));
});
test("post-QA at the ceiling with a clean final review passes", () => {
  writeFileSync(join(REPO, "qa-fix.txt"), "a fix /qa made\n");
  const r = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: finalReviewer("qafinal2", "", 0),
    OWNER: freshQaOwner(),
  });
  rmSync(join(REPO, "qa-fix.txt"), { force: true });
  assert.equal(r.rc, 0, r.out + r.err);
});
test("post-QA with the final review already spent is still unreviewed code: the phase fails", () => {
  writeFileSync(join(REPO, "qa-fix.txt"), "a fix /qa made\n");
  const r = runValidate(["--phase", "qa-revalidate", "--since", SNAP_NOW, "--scope", "seed.txt"], {
    STUB_REVIEW: finalReviewer("qafinal3", "", 5),
    OWNER: freshQaOwner(),
  });
  rmSync(join(REPO, "qa-fix.txt"), { force: true });
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes("unreviewed"), r.err);
});
test("qa-revalidate without --since is a caller error", () =>
  assert.equal(runValidate(["--phase", "qa-revalidate", "--scope", "seed.txt"]).rc, 2));

// A web repo that is NOT the workbench carries no reviewer of its own. It
// borrows the workbench's rather than refusing — otherwise a product repo's
// post-QA gate could never pass.
const SHARED = join(TMP, "shared");
mkdirSync(join(SHARED, ".agents/skills/review"), { recursive: true });
mkdirSync(join(SHARED, "tools"), { recursive: true });
const CLONE_REVIEWER = (says: string) => `#!/bin/sh
if [ "\${1:-}" = "--snapshot" ]; then
  idx="$(mktemp)"; rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree HEAD
  GIT_INDEX_FILE="$idx" git add -A
  GIT_INDEX_FILE="$idx" git write-tree
  rm -f "$idx"; exit 0
fi
echo "${says}" >&2
echo NO_FINDINGS
exit 0
`;
tsWrap(writeExec(join(SHARED, ".agents/skills/review/code-review.sh"), CLONE_REVIEWER("shared-reviewer ran")));
// A reviewer planted anywhere else in the shared checkout must never be the one
// that runs: the fallback reads .agents/skills/review/ and nothing else.
tsWrap(writeExec(join(SHARED, "tools/code-review.sh"), CLONE_REVIEWER("old-path reviewer ran")));
function revalidateIn(repo: string, since: string, validate = VALIDATE, shared: string | null = SHARED) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WORKBENCH_SHARED_DIR;
  if (shared !== null) env.WORKBENCH_SHARED_DIR = shared;
  const r = runNode(validate, ["--repo", repo, "--phase", "qa-revalidate", "--since", since], {
    cwd: repo,
    env: {
      ...env,
      CLAUDE_PROJECT_DIR: repo,
      VALIDATE_AUTOMATED_CHECKS: NOOP_TS,
      VALIDATE_QA_TARGETS: NOOP_TS,
      VALIDATE_MARK_QA_DONE: MARK_QA_DONE,
      QA_DONE_DIR: QA_DONE,
    },
  });
  return `${r.stdout}${r.stderr}`;
}
const OTHER = join(TMP, "other-repo");
gitRepo(OTHER);
writeFileSync(join(OTHER, "page.txt"), "x\n");
git(OTHER, "add", "page.txt");
git(OTHER, "commit", "-qm", "init");
const OTHER_SNAP = git(OTHER, "write-tree").trim();
writeFileSync(join(OTHER, "fix.txt"), "a /qa fix\n");
let otherOut = "";
test("a repo with no reviewer of its own borrows the shared workbench checkout's", () => {
  otherOut = revalidateIn(OTHER, OTHER_SNAP);
  assert.equal(otherOut.includes("no reviewer at"), false, otherOut);
});
test("and the borrowed reviewer is the one that ran", () =>
  assert.ok(otherOut.includes("shared-reviewer ran"), otherOut));
test("and no other path in the shared checkout is consulted", () =>
  assert.equal(otherOut.includes("old-path reviewer ran"), false, otherOut));

// With no WORKBENCH_SHARED_DIR, the borrow is the review skill beside the skills
// this script sits among — the installed .agents/skills/review.
test("with no shared checkout named, the review skill beside this one is borrowed", () => {
  const beside = scriptsCopy("beside");
  const reviewDir = resolve(beside, "../../review");
  mkdirSync(reviewDir, { recursive: true });
  tsWrap(writeExec(join(reviewDir, "code-review.sh"), CLONE_REVIEWER("beside-reviewer ran")));
  const out = revalidateIn(OTHER, OTHER_SNAP, join(beside, "validate.ts"), null);
  assert.ok(out.includes("beside-reviewer ran"), out);
  assert.equal(out.includes("shared-reviewer ran"), false, out);
});

// A repo that carries its own reviewer under .agents/skills/review uses that one, never
// the shared checkout's — the only reviewer root the script reads.
const OWN = join(TMP, "own-repo");
mkdirSync(join(OWN, ".agents/skills/review"), { recursive: true });
gitRepo(OWN);
writeFileSync(join(OWN, "page.txt"), "x\n");
tsWrap(writeExec(join(OWN, ".agents/skills/review/code-review.sh"), CLONE_REVIEWER("own-reviewer ran")));
git(OWN, "add", "-A");
git(OWN, "commit", "-qm", "init");
const OWN_SNAP = git(OWN, "write-tree").trim();
writeFileSync(join(OWN, "fix.txt"), "a /qa fix\n");
let ownOut = "";
test("a repo's own .agents/skills/review reviewer is the one that runs", () => {
  ownOut = revalidateIn(OWN, OWN_SNAP);
  assert.ok(ownOut.includes("own-reviewer ran"), ownOut);
});
test("and the shared checkout's does not", () => assert.equal(ownOut.includes("shared-reviewer ran"), false, ownOut));

// ── The findings of this change's own machine review ──────────────────

// An unresolvable scope is a caller error, not an empty run. Every caller
// invokes run_layers_1_2 in an OR-list, which suspends errexit for the whole
// body — so a failing resolve-scope left the file list empty and the layers
// reported PASS over nothing.
test("an unresolvable scope fails the phase, and does not read as a clean run", async (t) => {
  const r = runValidate(["--phase", "checks", "--scope", "apps/definitely-not-an-app"]);
  await t.test("an unresolvable scope fails the phase", () => assert.equal(r.rc, 1));
  await t.test("and does not read as a clean run", () => assert.ok(r.out.includes("NEED_FIX=1"), r.out));
});

// On a FOLLOW-UP round, $PRE is taken after the fixes were written, so comparing
// POST against it declares them validated. The baseline has to be $SINCE — the
// snapshot from before the previous round — because everything between is this
// round's unvalidated fixes.
const FIXED = makeReviewer("NO_FINDINGS", 0, "roundfix");
test("a follow-up round re-arms E2E for the fixes since --since", () => {
  const before = snapshot(FIXED);
  writeFileSync(join(REPO, "between-rounds.txt"), "a fix written between rounds\n");
  const out = runValidate(["--phase", "review", "--since", before, "--scope", "seed.txt"], { STUB_REVIEW: FIXED }).out;
  rmSync(join(REPO, "between-rounds.txt"), { force: true });
  assert.ok(out.includes("NEED_E2E=1"), out);
});
// …and does not re-arm it when nothing moved since that snapshot.
test("a settled follow-up round does not re-arm E2E", () =>
  assert.ok(
    runValidate(["--phase", "review", "--since", snapshot(FIXED), "--scope", "seed.txt"], {
      STUB_REVIEW: FIXED,
    }).out.includes("NEED_E2E=0"),
  ));

// qa-list passes --base through, so a UI change the session already COMMITTED
// still enumerates.
const ARGS_FILE = join(TMP, "qa-targets-args");
const BASE_PROBE = writeExec(
  join(TMP, "base-probe.ts"),
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ARGS_FILE)}, process.argv.slice(2).map((a) => \`\${a}\\n\`).join(""));\n`,
);
test("qa-list forwards --base to the enumerator, and the value with it", async (t) => {
  runValidate(["--phase", "qa-list", "--base", "deadbeef"], { STUB_TARGETS: BASE_PROBE });
  const args = readFileSync(ARGS_FILE, "utf8");
  await t.test("qa-list forwards --base to the enumerator", () => assert.ok(args.includes("--base"), args));
  await t.test("and the value with it", () => assert.ok(args.includes("deadbeef"), args));
});
test("and omits it when there is none", () => {
  runValidate(["--phase", "qa-list"], { STUB_TARGETS: BASE_PROBE });
  assert.equal(readFileSync(ARGS_FILE, "utf8").includes("--base"), false);
});
test("the enumerator gets --repo", () => {
  runValidate(["--phase", "qa-list"], { STUB_TARGETS: BASE_PROBE });
  assert.equal(readFileSync(ARGS_FILE, "utf8"), `--repo\n${REPO}\n`);
});

// The post-QA review gets its OWN round budget. The implementation fix loop can
// spend all four rounds, and without a separate counter this review would return
// exit 5 without calling a vendor — shipping /qa's own source edits unreviewed
// behind a "ceiling reached" note.
const ROUND_DIR = join(TMP, "round-dir");
const ARGS_PROBE = tsWrap(
  writeExec(
    join(TMP, "round-probe.sh"),
    `#!/bin/sh
${SNAPSHOT_BLOCK}printf '%s %s\\n' "\${CODE_REVIEW_ROUND_STATE_DIR:-unset}" "\${CODE_REVIEW_BUCKET:-unset}" >${shq(ROUND_DIR)}
${resultBlock("")}echo NO_FINDINGS
exit 0
`,
  ),
);
const SNAP_QA_ROUNDS = snapshot(ARGS_PROBE);
test("the post-QA review gets its own round counter", () => {
  writeFileSync(join(REPO, "qa-round-fix.txt"), "a fix /qa made\n");
  runValidate(["--phase", "qa-revalidate", "--since", SNAP_QA_ROUNDS, "--scope", "seed.txt"], {
    STUB_REVIEW: ARGS_PROBE,
    CODE_REVIEW_ROUND_STATE_DIR: join(TMP, "impl-rounds"),
  });
  // The bucket is named, and code-review.ts keeps the qa bucket's counter beside
  // the build one (<dir>-qa) — audit-dedupe.ts's roundDirs owns that suffix.
  assert.equal(readFileSync(ROUND_DIR, "utf8"), `${join(TMP, "impl-rounds")} qa\n`);
});

// And a ceiling whose final review is already spent is unreviewed code, not a note.
test("a ceilinged post-QA review fails the phase, and says NEED_FIX", async (t) => {
  const r = runValidate(["--phase", "qa-revalidate", "--since", SNAP_QA_ROUNDS, "--scope", "seed.txt"], {
    STUB_REVIEW: makeReviewer("", 5, "qaceil"),
  });
  await t.test("a ceilinged post-QA review fails the phase", () => assert.equal(r.rc, 1));
  await t.test("and says NEED_FIX", () => assert.ok(r.out.includes("NEED_FIX=1"), r.out));
});

// The post-QA layers run over what /qa MOVED. Its fixes are routinely unstaged
// or untracked, and a blank scope resolves to the STAGED set — so this used to
// report PASS over files it had never opened.
test("the post-QA layers see /qa's UNTRACKED fix", () => {
  const LAYER_PROBE = scriptsCopy("layer-probe");
  const stdin = join(TMP, "layer1-stdin");
  writeFileSync(
    join(LAYER_PROBE, "layer-1.ts"),
    `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(stdin)}, readFileSync(0));\n`,
  );
  writeFileSync(join(LAYER_PROBE, "layer-2.ts"), 'import { readFileSync } from "node:fs";\nreadFileSync(0);\n');
  const snapFiles = snapshot(ARGS_PROBE);
  writeFileSync(join(REPO, "qa-untracked-fix.txt"), "untracked qa fix\n");
  runNode(
    join(LAYER_PROBE, "validate.ts"),
    ["--repo", REPO, "--phase", "qa-revalidate", "--since", snapFiles, "--scope", ""],
    {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: REPO,
        VALIDATE_CODE_REVIEW: ARGS_PROBE,
        VALIDATE_MARK_QA_DONE: MARK_QA_DONE,
        QA_DONE_DIR: QA_DONE,
      },
    },
  );
  rmSync(join(REPO, "qa-round-fix.txt"), { force: true });
  rmSync(join(REPO, "qa-untracked-fix.txt"), { force: true });
  assert.ok(readFileSync(stdin, "utf8").includes("qa-untracked-fix.txt"));
});

// The list reaches the layers as NUL-terminated records. Without -z git C-quoted
// `café-qa-fix.txt`, and a newline-joined hand-off split `nl<LF>qa-fix.txt` into
// two paths — layer 1 then linted three files that do not exist and none that do.
const nulProbe = (name: string): { dir: string; stdin: string } => {
  const dir = scriptsCopy(name);
  const stdin = join(TMP, `${name}-stdin`);
  writeFileSync(
    join(dir, "layer-1.ts"),
    `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(stdin)}, readFileSync(0));\n`,
  );
  writeFileSync(join(dir, "layer-2.ts"), 'import { readFileSync } from "node:fs";\nreadFileSync(0);\n');
  return { dir, stdin };
};
const probeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  CLAUDE_PROJECT_DIR: REPO,
  VALIDATE_CODE_REVIEW: ARGS_PROBE,
  VALIDATE_AUTOMATED_CHECKS: NOOP_TS,
  VALIDATE_MARK_QA_DONE: MARK_QA_DONE,
  QA_DONE_DIR: QA_DONE,
  ...extra,
});
const records = (file: string): string[] =>
  readFileSync(file, "utf8")
    .split("\0")
    .filter((r) => r !== "");

test("the post-QA layers get a quoted or newline name as one record", () => {
  const { dir, stdin } = nulProbe("nul-probe-since");
  const snap = snapshot(ARGS_PROBE);
  writeFileSync(join(REPO, "café-qa-fix.txt"), "x\n");
  writeFileSync(join(REPO, "nl\nqa-fix.txt"), "x\n");
  try {
    runNode(join(dir, "validate.ts"), ["--repo", REPO, "--phase", "qa-revalidate", "--since", snap, "--scope", ""], {
      env: probeEnv(),
    });
  } finally {
    rmSync(join(REPO, "café-qa-fix.txt"), { force: true });
    rmSync(join(REPO, "nl\nqa-fix.txt"), { force: true });
  }
  const got = records(stdin);
  assert.ok(got.includes("café-qa-fix.txt"), `café-qa-fix.txt missing from layer 1 stdin: ${JSON.stringify(got)}`);
  assert.ok(got.includes("nl\nqa-fix.txt"), `nl<LF>qa-fix.txt missing from layer 1 stdin: ${JSON.stringify(got)}`);
});

// The scope branch hands over resolve-scope's list the same way.
test("the checks layers get a staged newline name as one record", () => {
  const { dir, stdin } = nulProbe("nul-probe-scope");
  writeFileSync(join(REPO, "nl\nstaged.txt"), "x\n");
  git(REPO, "add", "nl\nstaged.txt");
  try {
    runNode(join(dir, "validate.ts"), ["--repo", REPO, "--phase", "checks", "--scope", ""], { env: probeEnv() });
  } finally {
    git(REPO, "rm", "-q", "--cached", "nl\nstaged.txt");
    rmSync(join(REPO, "nl\nstaged.txt"), { force: true });
  }
  const got = records(stdin);
  assert.deepEqual(got, ["nl\nstaged.txt"], `layer 1 stdin: ${JSON.stringify(got)}`);
});

// A git that fails while listing what moved is not "nothing moved": the layers
// would PASS over an empty list. Both reads are checked.
// The shim fails only the listing (`diff … --name-only`, `ls-files … --others`);
// the snapshot's read-tree / add / write-tree go to the real git.
for (const sub of ["diff", "ls-files"]) {
  test(`a failing git ${sub} in the moved-files read fails the phase`, async (t) => {
    const { dir, stdin } = nulProbe(`nul-probe-fail-${sub}`);
    const bin = join(TMP, `failing-${sub}-bin`);
    mkdirSync(bin, { recursive: true });
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeExec(
      join(bin, "git"),
      `#!/bin/sh
case " $* " in
  *" ${sub} "*" ${sub === "diff" ? "--name-only" : "--others"} "*) echo "simulated ${sub} failure" >&2; exit 128 ;;
esac
exec ${shq(realGit)} "$@"
`,
    );
    const snap = snapshot(ARGS_PROBE);
    writeFileSync(join(REPO, "moved-under-failing-git.txt"), "x\n");
    let r: ReturnType<typeof runNode>;
    try {
      r = runNode(
        join(dir, "validate.ts"),
        ["--repo", REPO, "--phase", "qa-revalidate", "--since", snap, "--scope", ""],
        { env: probeEnv({ PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }) },
      );
    } finally {
      rmSync(join(REPO, "moved-under-failing-git.txt"), { force: true });
    }
    await t.test("the phase says NEED_FIX", () => assert.ok(r.stdout.includes("NEED_FIX=1"), r.stdout + r.stderr));
    await t.test("git's own error is surfaced", () =>
      assert.ok(r.stderr.includes(`simulated ${sub} failure`), r.stderr),
    );
    await t.test("layer 1 never ran over the partial list", () => assert.equal(existsSync(stdin), false));
  });
}

// ── The marker keys are two, and only one of them is ours ─────────────
//
// The Stop hook in the context repo computes `$(basename "$repo")-$hash` inline
// and has never heard of this script. Moving the CHANGE-SET marker to the
// collision-safe slug silently stopped every completed /qa from clearing it.

const MARKREPO = join(TMP, "markrepo");
gitRepo(MARKREPO);
writeFileSync(join(MARKREPO, "f.txt"), "x\n");
const MARKER_KEYS = join(TMP, "marker-keys");
let treeMarker = "";
let legacyHash = "";
test("the change-set marker keeps the bare-basename key the Stop hook reads", () => {
  stampInteraction(MARKER_KEYS, TREE1, MARKREPO);
  markQaDone(MARKER_KEYS, ["--tree", TREE1, MARKREPO]);
  const porcelain = git(MARKREPO, "status", "--porcelain");
  legacyHash = cksum(porcelain);
  assert.ok(existsSync(join(MARKER_KEYS, `markrepo-${legacyHash}`)));
});
test("the tree marker was written at its own key", () => {
  treeMarker = markQaDone(MARKER_KEYS, ["--marker-path", "--tree", TREE1, MARKREPO]);
  assert.ok(existsSync(treeMarker), treeMarker);
});
test("and the two keys are not the same file", () =>
  assert.equal(treeMarker.includes(`markrepo-${legacyHash}`), false, treeMarker));

// ── Every phase emits both machine fields ─────────────────────────────
//
// A caller branching on NEED_FIX must never have to tell "0" from "the script
// died before printing it" — an absent field reads as a pass in every shell
// idiom there is.

for (const probe of [
  ["--phase", "checks", "--scope", "seed.txt"],
  ["--phase", "qa-list"],
]) {
  test(`[${probe.join(" ")}] emits NEED_FIX and NEED_E2E`, async (t) => {
    const out = runValidate(probe, { STUB_TARGETS: NO_TARGETS }).out;
    await t.test(`[${probe.join(" ")}] emits NEED_FIX`, () => assert.ok(out.includes("NEED_FIX="), out));
    await t.test(`[${probe.join(" ")}] emits NEED_E2E`, () => assert.ok(out.includes("NEED_E2E="), out));
  });
}
test("[review] emits NEED_FIX and NEED_E2E", async (t) => {
  const out = reviewCase("fields", "NO_FINDINGS", 0).out;
  await t.test("[review] emits NEED_FIX", () => assert.ok(out.includes("NEED_FIX="), out));
  await t.test("[review] emits NEED_E2E", () => assert.ok(out.includes("NEED_E2E="), out));
});

// ── --phase report: a changed test needs a red excerpt ────────────────
//
// A test that has never been seen failing is not
// evidence, so /implement refuses its close when the work touched a test file and
// the report's `test-failure-observed:` line holds nothing. Every case gets its
// own scratch repo, so a test file planted for one cannot leak into another's
// listing the way it would in the shared REPO above.

const REPORT_TMP = join(TMP, "report-phase");
mkdirSync(REPORT_TMP);
let reportSeq = 0;
function put(dir: string, path: string, body = "x\n"): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}
/** A fresh repo with one seed commit; its SHA is the base every case diffs from. */
function scratchRepo(seed: Record<string, string> = {}): { dir: string; base: string } {
  const dir = join(REPORT_TMP, `repo-${++reportSeq}`);
  gitRepo(dir);
  for (const [path, body] of Object.entries({ "seed.txt": "seed\n", ...seed })) put(dir, path, body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return { dir, base: git(dir, "rev-parse", "HEAD").trim() };
}
function commitAll(dir: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
}
/** A report outside the repo, so the report itself is never a changed file. */
function reportWith(...lines: string[]): string {
  const f = join(REPORT_TMP, `report-${++reportSeq}.md`);
  writeFileSync(f, ["---", "spec: 064-x", "spec-status: complete", "---", "", "# Report", "", ...lines, ""].join("\n"));
  return f;
}
const bold = (v: string) => `**test-failure-observed:** \`${v}\``;
const EXCERPT = "not ok 1 - rejects an empty list … expected 0, got 3";
function runReport(dir: string, args: string[]) {
  const r = runNode(VALIDATE, ["--repo", dir, "--phase", "report", ...args]);
  return { rc: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
const reportPhase = (dir: string, base: string, report: string) => runReport(dir, ["--base", base, "--report", report]);
const redFirstFails = (out: string) => out.split("\n").filter((l) => l.startsWith("FAIL: red-first "));

test("report 1: only a source file changed and the line reads none — passes, saying no test changed", () => {
  const { dir, base } = scratchRepo();
  put(dir, "src/x.ts");
  commitAll(dir);
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes(`PASS: red-first (no test file changed since ${base.slice(0, 12)})`), r.all);
  assert.ok(r.out.includes("NEED_FIX=0"), r.out);
});

test("report 2: a committed test change with a red excerpt passes, counting the file", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  commitAll(dir);
  const r = reportPhase(dir, base, reportWith(bold(EXCERPT)));
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: red-first (1 test file(s); excerpt present)"), r.all);
});

test("report 3: a committed test change with the line reading none is refused, naming the file", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  commitAll(dir);
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: red-first tests/a.test.ts"), r.all);
  assert.ok(r.out.includes("NEED_FIX=1") && r.out.includes("NEED_E2E=0"), r.out);
  assert.match(r.err, /reads "none"/, r.err);
});

test("report 4: an untracked new test with no line at all is refused, saying the line is missing", () => {
  const { dir, base } = scratchRepo();
  put(dir, "b.test.ts");
  const r = reportPhase(dir, base, reportWith("**implement-audit:** `clean`"));
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: red-first b.test.ts"), r.all);
  assert.match(r.err, /no `test-failure-observed:` line/, r.err);
});

test("report 5: a line holding only empty backticks counts as missing", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  const r = reportPhase(dir, base, reportWith("**test-failure-observed:** ``"));
  assert.equal(r.rc, 1, r.all);
  assert.match(r.err, /is empty/, r.err);
});

test("report 6: the template's unfilled placeholder counts as missing", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  const r = reportPhase(dir, base, reportWith(bold(`{the RED excerpt from Phase 4's tests, or "none"}`)));
  assert.equal(r.rc, 1, r.all);
  assert.match(r.err, /placeholder/, r.err);
});

test("report 7: 'None — no test changed' starts with the word none and is refused", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  const r = reportPhase(dir, base, reportWith(bold("None — no test changed")));
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: red-first tests/a.test.ts"), r.all);
});

test("report 8: 'not-applicable — <why>' is a written reason and passes", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  const r = reportPhase(dir, base, reportWith(bold("not-applicable — renamed, no assertion changed")));
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: red-first (1 test file(s); excerpt present)"), r.all);
});

test("report 9: a deleted test file is not counted — there is nothing left to see fail", () => {
  const { dir, base } = scratchRepo({ "tests/gone.test.ts": "x\n" });
  rmSync(join(dir, "tests/gone.test.ts"));
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: red-first (no test file changed since"), r.all);
});

test("report 10: product test names count (.test.tsx, __tests__/); .test.json and contest.ts do not", async (t) => {
  await t.test("__tests__/ and .test.tsx are both named", () => {
    const { dir, base } = scratchRepo();
    put(dir, "web/src/__tests__/page.tsx");
    put(dir, "web/src/b.test.tsx");
    const r = reportPhase(dir, base, reportWith(bold("none")));
    assert.equal(r.rc, 1, r.all);
    assert.deepEqual(redFirstFails(r.out), [
      "FAIL: red-first web/src/__tests__/page.tsx",
      "FAIL: red-first web/src/b.test.tsx",
    ]);
  });
  await t.test("send-payload.test.json and contest.ts are not tests", () => {
    const { dir, base } = scratchRepo();
    put(dir, "docs/send-payload.test.json");
    put(dir, "contest.ts");
    const r = reportPhase(dir, base, reportWith(bold("none")));
    assert.equal(r.rc, 0, r.all);
    assert.ok(r.out.includes("PASS: red-first (no test file changed since"), r.all);
  });
});

test("report 11: odd file names reach the FAIL line intact", () => {
  const { dir, base } = scratchRepo();
  put(dir, "café test.test.ts");
  put(dir, "line\nbreak.test.ts");
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: red-first café test.test.ts\n"), r.out);
  assert.ok(r.out.includes("FAIL: red-first line\nbreak.test.ts\n"), r.out);
});

test("report 12: the first test-failure-observed line counts, not a later one", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/a.test.ts");
  const r = reportPhase(dir, base, reportWith(bold("none"), "", bold(EXCERPT)));
  assert.equal(r.rc, 1, r.all);
});

test("report 13: a base git cannot diff against refuses, never a pass over an empty list", () => {
  const { dir } = scratchRepo();
  put(dir, "tests/a.test.ts");
  const r = reportPhase(dir, "deadbeefdeadbeef", reportWith(bold(EXCERPT)));
  assert.equal(r.rc, 1, r.all);
  assert.ok(!r.out.includes("PASS:"), r.out);
  assert.ok(r.out.includes("NEED_FIX=1"), r.out);
});

test("report 14: caller errors exit 2 and name the flag", async (t) => {
  const { dir, base } = scratchRepo();
  const report = reportWith(bold("none"));
  await t.test("missing --base", () => {
    const r = runReport(dir, ["--report", report]);
    assert.equal(r.rc, 2, r.all);
    assert.match(r.err, /--base/, r.err);
  });
  await t.test("missing --report", () => {
    const r = runReport(dir, ["--base", base]);
    assert.equal(r.rc, 2, r.all);
    assert.match(r.err, /--report/, r.err);
  });
  await t.test("--base given last with no value", () => {
    const r = runReport(dir, ["--report", report, "--base"]);
    assert.equal(r.rc, 2, r.all);
    assert.match(r.err, /--base needs a value/, r.err);
  });
  await t.test("--report given last with no value", () => {
    const r = runReport(dir, ["--base", base, "--report"]);
    assert.equal(r.rc, 2, r.all);
    assert.match(r.err, /--report needs a value/, r.err);
  });
  await t.test("--report naming a directory", () => {
    const r = runReport(dir, ["--base", base, "--report", REPORT_TMP]);
    assert.equal(r.rc, 2, r.all);
    assert.ok(r.err.includes(REPORT_TMP), r.err);
  });
  await t.test("any flag with no value, here qa-list's --base", () => {
    const r = runNode(VALIDATE, ["--repo", dir, "--phase", "qa-list", "--base"]);
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--base needs a value/, r.stderr);
  });
});

test("report 15: --help shows the report phase and the exit codes; an unknown phase lists report", async (t) => {
  await t.test("--help", () => {
    const r = runNode(VALIDATE, ["--help"]);
    assert.ok(r.stderr.includes("--phase report"), r.stderr);
    assert.ok(r.stderr.includes("caller error"), r.stderr);
  });
  await t.test("unknown phase", () => {
    const r = bare(["--repo", REPO, "--phase", "reprot"]);
    assert.equal(r.rc, 2, r.all);
    assert.match(r.all, /unknown phase: reprot \(.*\breport\b.*\)/, r.all);
  });
});

test("report 16: nothing changed at all since the base passes whatever the line holds", () => {
  const { dir, base } = scratchRepo();
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes(`PASS: red-first (no test file changed since ${base.slice(0, 12)})`), r.all);
});

test("report 17: a tracked test modified and not committed is counted", () => {
  const { dir, base } = scratchRepo({ "tests/a.test.ts": "old\n" });
  put(dir, "tests/a.test.ts", "new\n");
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: red-first tests/a.test.ts"), r.all);
});

test("report 18: a fixture under tests/ is counted — it changes what a test asserts", () => {
  const { dir, base } = scratchRepo();
  put(dir, "tests/fixtures/x.json", "{}\n");
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: red-first tests/fixtures/x.json"), r.all);
});

test("report 19: three hundred changed tests are all named, none dropped", () => {
  const { dir, base } = scratchRepo();
  for (let i = 0; i < 300; i++) put(dir, `t${i}.test.ts`);
  const r = reportPhase(dir, base, reportWith(bold("none")));
  assert.equal(r.rc, 1, r.all);
  assert.equal(redFirstFails(r.out).length, 300, r.out);
});

test("report 20: the key is read bold, backticked or bare", async (t) => {
  for (const [form, key] of [
    ["bold", "**test-failure-observed:**"],
    ["backticked", "`test-failure-observed:`"],
    ["bare", "test-failure-observed:"],
  ] as const) {
    await t.test(`${form} with an excerpt passes`, () => {
      const { dir, base } = scratchRepo();
      put(dir, "tests/a.test.ts");
      const r = reportPhase(dir, base, reportWith(`${key} \`${EXCERPT}\``));
      assert.equal(r.rc, 0, r.all);
    });
    await t.test(`${form} with none is refused`, () => {
      const { dir, base } = scratchRepo();
      put(dir, "tests/a.test.ts");
      const r = reportPhase(dir, base, reportWith(`${key} \`none\``));
      assert.equal(r.rc, 1, r.all);
      assert.ok(r.out.includes("FAIL: red-first tests/a.test.ts"), r.all);
    });
  }
});

// ── The review receipt: one path, reused only for the content it covered ──
//
// Each case drives the real audit-dedupe.ts through
// validate.ts with a stand-in reviewer that counts its calls, in a repo of its
// own so its files never reach the cases above.
const RREPO = join(TMP, "receipt-repo");
gitRepo(RREPO);
mkdirSync(join(RREPO, ".agents/skills/demo"), { recursive: true });
writeFileSync(join(RREPO, "AGENTS.md"), "rules\n");
writeFileSync(join(RREPO, ".agents/skills/demo/caller.ts"), "export const caller = 1;\n");
writeFileSync(join(RREPO, ".agents/skills/demo/lib.ts"), "export const lib = 1;\n");
git(RREPO, "add", "-A");
git(RREPO, "commit", "-qm", "init");
const RBASE = git(RREPO, "rev-parse", "HEAD").trim();
const RREPORT = join(RREPO, "projects/p/specs/001-x/report.md");
mkdirSync(dirname(RREPORT), { recursive: true });
writeFileSync(join(dirname(RREPORT), "spec.md"), "the contract\n");
const DECL = {
  base: RBASE,
  scope: ".agents/skills/demo",
  entryPoints: [{ id: "E1", path: ".agents/skills/demo/lib.ts" }],
  dependencies: [
    { id: "D1", path: ".agents/skills/demo/caller.ts", why: "calls lib" },
    { id: "D2", path: "AGENTS.md", why: "the nearest instruction" },
  ],
  claims: [{ id: "C1", claim: "lib is 2", inapplicable: "a constant" }],
};
const writeReport = (decl: unknown, prose = ""): void =>
  writeFileSync(
    RREPORT,
    `# report\n${prose}\n<!-- review-coverage:v1 -->\n${JSON.stringify(decl)}\n<!-- /review-coverage -->\n`,
  );
const ALL_CHECKED = JSON.stringify(
  ["E1", "D1", "D2", "C1"].map((id) => ({ id, status: "checked", evidence: ["read"] })),
);
function countingReviewer(name: string, out: string, coverage = ALL_CHECKED): { stub: string; calls: () => number } {
  const log = join(TMP, `rcalls-${name}.log`);
  const stub = tsWrap(
    writeExec(
      join(TMP, `rreviewer-${name}.sh`),
      `#!/bin/sh
if [ "\${1:-}" = "--snapshot" ]; then
  idx="$(mktemp)"; rm -f "$idx"
  GIT_INDEX_FILE="$idx" git -C ${shq(RREPO)} read-tree HEAD
  GIT_INDEX_FILE="$idx" git -C ${shq(RREPO)} add -A
  GIT_INDEX_FILE="$idx" git -C ${shq(RREPO)} write-tree
  rm -f "$idx"
  exit 0
fi
printf '%s\\n' "$*" >>${shq(log)}
${resultBlock(out, coverage)}${out !== "" ? `printf '%s\\n' ${shq(out)}\n` : ""}exit 0
`,
    ),
  );
  return { stub, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
}
function rv(owner: string, stub: string, args: string[]) {
  const r = runNode(VALIDATE, ["--repo", RREPO, ...args], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: RREPO,
      CODE_REVIEW_LOOP_ID: owner,
      VALIDATE_AUTOMATED_CHECKS: NOOP_TS,
      VALIDATE_CODE_REVIEW: stub,
      CODE_REVIEW_ROUND_STATE_DIR: join(TMP, `rrounds-${owner}`),
    },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
const full = (owner: string, stub: string, extra: string[] = []) =>
  rv(owner, stub, [
    "--phase",
    "review",
    "--base",
    RBASE,
    "--head",
    "HEAD",
    "--scope",
    ".agents/skills/demo",
    "--report",
    RREPORT,
    ...extra,
  ]);
const check = (owner: string) => {
  const r = runNode(join(SKILLS_DIR, "implement-audit/scripts/audit-dedupe.ts"), ["check", "--owner", owner, RREPO], {
    env: { ...process.env },
  });
  return { rc: r.status, all: `${r.stdout}${r.stderr}` };
};
function resetRepo(): void {
  git(RREPO, "checkout", "-q", "--", ".");
  git(RREPO, "clean", "-qfd", "--", "skills", "journal");
  writeFileSync(join(RREPO, ".agents/skills/demo/lib.ts"), "export const lib = 2;\n");
  writeReport(DECL);
}

test("receipt: an unchanged repeat of an approved review spends no reviewer call", () => {
  resetRepo();
  const { stub, calls } = countingReviewer("repeat", "NO_FINDINGS");
  const first = full("r-repeat", stub);
  assert.equal(first.rc, 0, first.all);
  assert.match(first.out, /RECEIPT: approved/);
  const again = full("r-repeat", stub);
  assert.equal(again.rc, 0, again.all);
  assert.match(again.out, /still covers this content — no review call/);
  assert.equal(calls(), 1, "the repeat made no reviewer call");
  assert.equal(check("r-repeat").rc, 0, "the close accepts it");
  // Report prose outside the frozen block is not a reason to review again.
  writeReport(DECL, "a later paragraph about the run");
  assert.match(full("r-repeat", stub).out, /no review call/);
  assert.equal(calls(), 1);
});

test("receipt: a changed source, unchanged caller or contract makes it stale, with the change named", () => {
  resetRepo();
  const { stub, calls } = countingReviewer("stale", "NO_FINDINGS");
  assert.equal(full("r-stale", stub).rc, 0);
  for (const [what, path] of [
    ["the implementation", ".agents/skills/demo/lib.ts"],
    ["an unchanged declared caller", ".agents/skills/demo/caller.ts"],
    ["the applicable instruction", "AGENTS.md"],
  ] as const) {
    const was = readFileSync(join(RREPO, path));
    writeFileSync(join(RREPO, path), `${was}// moved\n`);
    const c = check("r-stale");
    assert.equal(c.rc, 1, `${what}: the close refuses`);
    assert.ok(c.all.includes(`changed since the review: ${path}`), `${what}: names ${path} — ${c.all}`);
    writeFileSync(join(RREPO, path), was);
    assert.equal(check("r-stale").rc, 0, `${what}: undoing the edit restores the reviewed content`);
  }
  const contract = join(dirname(RREPORT), "spec.md");
  writeFileSync(contract, "the contract, changed\n");
  assert.match(check("r-stale").all, /changed since the review: contract:/, "the behavior contract");
  writeFileSync(contract, "the contract\n");
  writeFileSync(join(RREPO, ".agents/skills/demo/lib.ts"), "export const lib = 3;\n");
  assert.equal(full("r-stale", stub).rc, 0);
  assert.equal(calls(), 2, "a stale receipt is reviewed again");
});

test("receipt: a declared item the reviewer did not check is not approved", () => {
  resetRepo();
  const cov = JSON.stringify([
    ...["E1", "D1", "C1"].map((id) => ({ id, status: "checked", evidence: ["read"] })),
    { id: "D2", status: "unchecked", evidence: ["could not open it"] },
  ]);
  const { stub } = countingReviewer("unchecked", "NO_FINDINGS", cov);
  const r = full("r-unchecked", stub);
  assert.equal(r.rc, 1, r.all);
  assert.match(r.out, /NEED_FIX=1/);
  assert.match(r.err, /did not check D2: could not open it/);
  assert.match(check("r-unchecked").all, /did not check D2/);
});

test("receipt: a blocking finding is not approved, a nit alone is", () => {
  resetRepo();
  const blocked = countingReviewer("blocked", "[should-fix] .agents/skills/demo/lib.ts: x");
  assert.equal(full("r-blocked", blocked.stub).rc, 1);
  assert.match(check("r-blocked").all, /1 must-fix\/should-fix finding\(s\) unresolved/);
  const nit = countingReviewer("nit", "[nit] tidy");
  assert.equal(full("r-nit", nit.stub).rc, 0);
  assert.equal(check("r-nit").rc, 0);
});

test("receipt: a declaration that omits the applicable instruction is refused before any call", () => {
  resetRepo();
  writeReport({ ...DECL, dependencies: [DECL.dependencies[0]] });
  const { stub, calls } = countingReviewer("omits", "NO_FINDINGS");
  const r = full("r-omits", stub);
  assert.equal(r.rc, 1, r.all);
  assert.match(r.err, /omits the applicable instruction AGENTS\.md/);
  assert.equal(calls(), 0);
  for (const [bad, why] of [
    [`<!-- review-coverage:v1 -->\n{}\n<!-- /review-coverage -->\n<!-- review-coverage:v1 -->`, /exactly one/],
    [`<!-- review-coverage:v1 -->\n{"base":"x","base":"y"}\n<!-- /review-coverage -->`, /duplicate key/],
    [`no block at all`, /has no <!-- review-coverage:v1 --> block/],
  ] as const) {
    writeFileSync(RREPORT, bad);
    const b = full("r-omits", stub);
    assert.equal(b.rc, 1, b.all);
    assert.match(b.err, why);
  }
  assert.equal(calls(), 0, "no declaration problem spends a call");
});

test("receipt: /qa that changed only records reuses the receipt; a source change is reviewed on the qa bucket", () => {
  resetRepo();
  const { stub, calls } = countingReviewer("qa", "NO_FINDINGS");
  assert.equal(full("r-qa", stub).rc, 0);
  const pre = execFileSync("bash", [stub.replace(/\.ts$/, ".sh"), "--snapshot"], { encoding: "utf8" }).trim();
  mkdirSync(join(RREPO, "journal"), { recursive: true });
  writeFileSync(join(RREPO, "journal/today.md"), "notes\n");
  // qa-revalidate re-runs layers 1+2 over what moved; this repo has none of
  // the toolchain, so the record-only case asserts the receipt, not the layers.
  const qa = rv("r-qa", stub, ["--phase", "qa-revalidate", "--since", pre, "--report", RREPORT]);
  assert.match(qa.out, /no review call/, qa.all);
  assert.equal(calls(), 1, "records alone spent nothing");
  writeFileSync(join(RREPO, ".agents/skills/demo/lib.ts"), "export const lib = 4;\n");
  const qa2 = rv("r-qa", stub, ["--phase", "qa-revalidate", "--since", pre, "--report", RREPORT]);
  assert.equal(calls(), 2, qa2.all);
  assert.match(readFileSync(join(TMP, "rcalls-qa.log"), "utf8"), /--since/);
});

test("receipt: an interrupted attempt never inherits the earlier approval for new content", () => {
  resetRepo();
  const { stub } = countingReviewer("intr", "NO_FINDINGS");
  assert.equal(full("r-intr", stub).rc, 0);
  writeFileSync(join(RREPO, ".agents/skills/demo/lib.ts"), "export const lib = 5;\n");
  const dead = makeReviewer("", 1, "intr-dead");
  assert.equal(full("r-intr", dead).rc, 1);
  const c = check("r-intr");
  assert.equal(c.rc, 1);
  assert.match(c.all, /the last review attempt did not complete/);
  writeFileSync(join(RREPO, ".agents/skills/demo/lib.ts"), "export const lib = 2;\n");
  assert.equal(check("r-intr").rc, 0, "restoring the reviewed bytes is the recovery");
});
