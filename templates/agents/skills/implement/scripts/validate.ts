#!/usr/bin/env -S node --experimental-strip-types
// validate.ts — the fixed-order driver for /implement Phase 4.
//
// The order used to live in implement/SKILL.md as a table, and a table is a
// suggestion. The one it printed had the code review as "layer 4", BEFORE the
// E2E walk — so a review that came back clean landed on a session that had run
// no E2E, and audit-dedupe then no-op'd the real review when it finally came.
// A model reading a table decides when to read it. A model calling a script
// does not decide anything: this script exposes PHASES, and no argument spells
// "review before lint".
//
// Usage:
//   validate.ts --phase checks --scope <arg>
//   validate.ts --phase review --base <sha> --head <sha> [--since <tree>] --scope <arg>
//   validate.ts --phase qa-list [--base <sha>]
//   validate.ts --phase qa-revalidate --since <tree> --scope <arg>
//   validate.ts --require-qa --targets-file <path> --tree <sha>
//   validate.ts --fallback-review <findings-file>
//
// Flags:
//   --phase <name>       checks | review | qa-list | qa-revalidate
//   --scope <arg>        passed through to resolve-scope.ts (blank = staged)
//   --base / --head      the full review's range (phase review, round 1).
//                        --base is ALSO read by qa-list, so a UI change that is
//                        already committed still enumerates.
//   --since <tree>       a tree from `code-review.ts --snapshot`; scopes the
//                        review to what changed since it (phase review rounds
//                        2+, and every qa-revalidate)
//   --targets-file PATH  the QA_TARGETS list (one absolute path per line)
//   --tree <sha>         the tree every target's QA marker must be keyed on
//   --repo <dir>         the worktree (default: CLAUDE_PROJECT_DIR, then git)
//
// Output (stdout): TAP-ish layer lines from the layer scripts, then the two
// machine fields the skill branches on, always both, always last:
//
//   NEED_FIX=0|1     the reviewer asked for changes
//   NEED_E2E=0|1     the tree moved since the phase started, so SPEC § 6 has to
//                    be walked again
//
// `--phase review` / `qa-revalidate` additionally print `NEED_FALLBACK_REVIEW=1`
// when no independent reviewer answered (code-review.ts exit 3), and exit 3:
// the review is PENDING, not passed. Run the implement-audit-reviewer agent in a
// fresh context on the same diff, save its triage lines to a file, and hand it
// to `--fallback-review <file>` — that call is the phase's pass (exit 0) or its
// findings (exit 1), recorded as `claude-fallback (fresh context, NOT
// independent)`: weaker than an independent review, never reported as one.
//
// `--phase qa-list` additionally prints one `QA_TARGETS=<abs path>` line per web
// target, and `QA_TARGETS=` with nothing after it when there are none. A path
// per line rather than one space-joined value, because a directory name may
// contain a space and a caller splitting on one would half-QA it.
//
// Exit:
//   0  the phase passed
//   1  a layer failed, the reviewer left [must-fix]/[should-fix] open, the
//      reviewer chain failed, or --require-qa found a target with no marker for
//      the given tree
//   2  caller error
//   3  the review is pending: no independent reviewer answered — run the
//      fallback reviewer, then --fallback-review <file>
//
// WHAT THIS SCRIPT DOES NOT DO. It never calls /qa, never calls impeccable, and
// never looks at a screenshot. Impeccable stays inside /qa on `@latest` against
// the live page, where its findings are 3x what they are against source —
// pulling it in here would pin a version behind a second caller and split one
// fact across two files.
// Looking at screenshots stays in the skill because it is judgment.
//
// E2E IS NOT A PHASE HERE, ON PURPOSE. Walking SPEC § 6 against a running app is
// human-attestable; a script that "ran E2E" would be a script that marked it
// green. What this script owns is WHEN it has to happen: always once after
// `--phase checks`, and again on every `NEED_E2E=1`.
//
// peers:
//   .agents/skills/implement/scripts/validate.test.ts
//   .agents/skills/implement/scripts/layer-1.ts
//   .agents/skills/implement/scripts/layer-2.ts
//   .agents/skills/implement/scripts/layer-3.ts
//   .agents/skills/implement/scripts/resolve-scope.ts
//   .agents/skills/implement-audit/scripts/run-automated-checks.ts
//   .agents/skills/qa/scripts/qa-targets.ts
//   .agents/skills/qa/scripts/mark-qa-done.ts
//   .agents/skills/review/code-review.ts
//
// Boundary inputs:
//   - empty scope:                 layers run over the staged set; 0 files is a PASS
//   - layer-1 FAIL:                exit 1, and review NEVER runs
//   - layer-3 FAIL:                advisory, does not fail the phase
//   - reviewer NO_FINDINGS:        NEED_FIX=0, exit 0
//   - reviewer [nit] only:         NEED_FIX=0 — a nit is not a change request
//   - reviewer [must-fix]:         NEED_FIX=1, exit 1
//   - reviewer exit 4 (converged): NEED_FIX=0, exit 0, with a note
//   - reviewer exit 5 (ceiling):   NEED_FIX=0, exit 0, with a note
//   - reviewer exit 1/3/124:       exit 1 — the audit did not happen
//   - tree unchanged over review:  NEED_E2E=0
//   - tree changed over review:    layers 1+2 re-run, NEED_E2E=1
//   - 0 QA targets:                `QA_TARGETS=`, --require-qa is a no-op
//   - target with no marker:       --require-qa exit 1
//   - target with a STALE marker:  --require-qa exit 1 (the tree moved)

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(SCRIPT_DIR, "../..");

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A converted program, run as the other inventory scripts are: this node, types stripped. */
function runTs(
  script: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string; capture?: boolean; quietErr?: boolean } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    env: opts.env ?? process.env,
    input: opts.input,
    stdio: [
      opts.input === undefined ? "inherit" : "pipe",
      opts.capture ? "pipe" : "inherit",
      opts.quietErr ? "ignore" : "inherit",
    ],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `$(…)`: captured stdout with its trailing newlines cut. */
const chomp = (s: string | null | undefined): string => (s ?? "").replace(/\n+$/, "");

/** The exit status a shell would report: a signal or a spawn failure is not 0. */
const statusOf = (r: SpawnSyncReturns<string>): number => r.status ?? 1;

async function main(): Promise<void> {
  // Byte-order everything this script and its children sort, as the bash
  // original's `export LC_ALL=C` did.
  process.env.LC_ALL = "C";

  let PHASE = "";
  let SCOPE = "";
  let BASE = "";
  let HEAD_REF = "";
  let SINCE = "";
  let TARGETS_FILE = "";
  let TREE = "";
  let REQUIRE_QA = false;
  let FALLBACK_FILE = "";
  let REPO_DIR = process.env.CLAUDE_PROJECT_DIR ?? "";

  const argv = process.argv.slice(2);
  // A flag that takes a value and has none ended the bash original silently
  // with status 1 (`shift 2` failing under `set -e`); kept.
  const value = (): string => {
    if (argv.length < 2) exit(1);
    const v = argv[1] ?? "";
    argv.splice(0, 2);
    return v;
  };
  while (argv.length > 0) {
    const a = argv[0] ?? "";
    switch (a) {
      case "--phase":
        PHASE = value();
        break;
      case "--scope":
        SCOPE = value();
        break;
      case "--base":
        BASE = value();
        break;
      case "--head":
        HEAD_REF = value();
        break;
      case "--since":
        SINCE = value();
        break;
      case "--targets-file":
        TARGETS_FILE = value();
        break;
      case "--tree":
        TREE = value();
        break;
      case "--repo":
        REPO_DIR = value();
        break;
      case "--require-qa":
        REQUIRE_QA = true;
        argv.shift();
        break;
      case "--fallback-review":
        FALLBACK_FILE = argv[1] ?? "";
        if (FALLBACK_FILE === "") {
          err("validate: --fallback-review needs a findings file");
          exit(2);
        }
        argv.splice(0, 2);
        break;
      case "-h":
      case "--help": {
        // The header comment above, lines 2-40, is the help text.
        const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1, 40);
        process.stderr.write(`${lines.join("\n")}\n`);
        exit(0);
        break;
      }
      default:
        err(`validate: unknown argument: ${a}`);
        exit(2);
    }
  }

  if (REPO_DIR === "") {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    REPO_DIR = r.status === 0 ? chomp(r.stdout) : "";
  }
  if (REPO_DIR === "" || !existsSync(`${REPO_DIR}/.git`)) {
    err(`validate: --repo must be a git worktree (got '${REPO_DIR}')`);
    exit(2);
  }
  REPO_DIR = resolve(REPO_DIR);

  // The reviewer is read from the repo under test first: the workbench carries it
  // at .agents/skills/review/.
  const REVIEW_DIR = `${REPO_DIR}/.agents/skills/review`;
  // THE REVIEWER IS REPO-AGNOSTIC: it reviews the git diff of whatever worktree it
  // runs in. So a repo that carries none — every product repo a web app `/qa`
  // runs on lives in — borrows the workbench's: the one under
  // `WORKBENCH_SHARED_DIR` when that is set (the test suite sets it), else the
  // review skill beside the skills this script sits among. Without the borrow,
  // `--phase qa-revalidate` on a product repo prints "no reviewer" and refuses,
  // so the post-QA gate could never pass for any repo but the workbench. Each
  // package's lint and typecheck stay repo-local on purpose (layer-1.ts runs the
  // package's own scripts) — those are that repo's own rules.
  let REVIEW_DEFAULT = `${REVIEW_DIR}/code-review.ts`;
  if (!isFile(REVIEW_DEFAULT)) {
    const shared = process.env.WORKBENCH_SHARED_DIR ?? "";
    REVIEW_DEFAULT =
      shared !== "" ? `${shared}/.agents/skills/review/code-review.ts` : `${SKILLS_DIR}/review/code-review.ts`;
  }
  const REVIEW = process.env.VALIDATE_CODE_REVIEW || REVIEW_DEFAULT;
  const AUTOMATED_CHECKS =
    process.env.VALIDATE_AUTOMATED_CHECKS || `${SKILLS_DIR}/implement-audit/scripts/run-automated-checks.ts`;
  const QA_TARGETS_TS = process.env.VALIDATE_QA_TARGETS || `${SKILLS_DIR}/qa/scripts/qa-targets.ts`;
  const MARK_QA_DONE = process.env.VALIDATE_MARK_QA_DONE || `${SKILLS_DIR}/qa/scripts/mark-qa-done.ts`;

  let NEED_FIX = 0;
  let NEED_E2E = 0;
  // Set when no independent reviewer answered: the phase ends in exit 3, pending.
  let PENDING_FALLBACK = false;
  const FALLBACK_CMD =
    "node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --fallback-review <file>";

  // Both fields, every time, on every exit path. A caller that branches on
  // NEED_FIX must never have to distinguish "0" from "the script died before
  // printing it" — an absent field reads as a pass in every shell idiom there is.
  const emitFields = (): void => {
    out(`NEED_FIX=${NEED_FIX}`);
    out(`NEED_E2E=${NEED_E2E}`);
  };

  const withRepo = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    CLAUDE_PROJECT_DIR: REPO_DIR,
    ...extra,
  });

  // Files that changed between a snapshot tree and the working tree, plus the
  // untracked ones git diff cannot see.
  //
  // The layers need THIS list, not the scope, whenever they re-run after something
  // moved the tree. `/qa`'s fixes and a fix round's edits are routinely unstaged or
  // untracked, and a blank `--scope` resolves to the STAGED set — so the re-run
  // reported PASS over files it had never opened.
  const filesSince = (tree: string): string => {
    const lines: string[] = [];
    for (const args of [
      ["-C", REPO_DIR, "diff", "--name-only", tree],
      ["-C", REPO_DIR, "ls-files", "--others", "--exclude-standard"],
    ]) {
      const r = spawnSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      });
      lines.push(...(r.stdout ?? "").split("\n"));
    }
    const kept = lines.filter((l) => !/^[ \t\n\v\f\r]*$/.test(l));
    // `sort -u` under LC_ALL=C: byte order, duplicates dropped.
    const sorted = [...new Set(kept)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return sorted.join("\n");
  };

  // Layers 1 and 2, in that order, with layer 1 gating layer 2 — type errors mask
  // runtime errors, so a failing typecheck makes a test result meaningless.
  //
  // `files`, when given, is an explicit file list; otherwise the scope is resolved.
  const runLayers12 = (files?: string): boolean => {
    let list = files;
    if (list === undefined) {
      // A scope that does not resolve is NOT an empty scope. In the bash original
      // every caller invoked this as `run_layers_1_2 || rc=$?`, which suspended
      // errexit for the whole body — so a failing resolve-scope left `files` empty
      // and the layers cheerfully reported PASS over nothing, for a scope naming an
      // app that does not exist. The status is checked explicitly.
      const r = runTs(`${SCRIPT_DIR}/resolve-scope.ts`, ["--scope", SCOPE], { env: withRepo(), capture: true });
      if (statusOf(r) !== 0) {
        err(`validate: the scope '${SCOPE}' did not resolve — refusing to validate an empty file list.`);
        err("  An unresolvable scope is a caller error, not a clean run over zero files.");
        return false;
      }
      list = chomp(r.stdout);
    }
    // `<<<"$files"`: the list, plus the newline a here-string adds.
    const l1 = runTs(`${SCRIPT_DIR}/layer-1.ts`, [], { env: withRepo(), input: `${list}\n` });
    if (statusOf(l1) !== 0) {
      err("validate: layer 1 failed — stopping. Nothing downstream runs on a tree that does not type-check.");
      return false;
    }
    const l2 = runTs(`${SCRIPT_DIR}/layer-2.ts`, [], { env: withRepo(), input: `${list}\n` });
    return statusOf(l2) === 0;
  };

  // The reviewer's snapshot of the working tree: its stdout, whatever it exited
  // with (`$(snapshot || true)`), and nothing at all when there is no reviewer.
  const snapshot = (): string => {
    if (!isFile(REVIEW)) return "";
    const r = runTs(REVIEW, ["--snapshot"], {
      env: { ...process.env, CODEX_REVIEW_REPO: REPO_DIR },
      capture: true,
      quietErr: true,
    });
    return chomp(r.stdout);
  };

  // ── --fallback-review ─────────────────────────────────────────────────
  //
  // The way out of a pending review (exit 3). The fallback reviewer's triage lines
  // are read exactly as code-review.ts's are: a [must-fix] or [should-fix] is a
  // fix owed (exit 1), a [nit] is held, and none — with the NO_FINDINGS sentinel
  // or only nits — is a pass (exit 0). A file with neither is exit 1. It is a pass
  // of a WEAKER review, and the line it prints says so, because the report and the
  // journal carry it and nothing may read it as an independent one.
  if (FALLBACK_FILE !== "") {
    if (!isFile(FALLBACK_FILE)) {
      err(`validate: --fallback-review file not found: ${FALLBACK_FILE}`);
      exit(2);
    }
    const text = readFileSync(FALLBACK_FILE, "utf8");
    // A review says something: at least one finding, or a clean-review line —
    // the same rule code-review.ts holds a vendor to. An empty file or loose
    // prose is a review that did not happen. Two spellings are read: triage lines
    // with NO_FINDINGS, and the fallback reviewer's own format
    // (.agents/agents/implement-audit-reviewer.md: `verdict: **fix-now**`, …, and
    // its "Zero findings." line), so its output can be saved as it is.
    const anyLine =
      /^(\[(must-fix|should-fix|nit)\] |NO_FINDINGS[^\S\n]*$|Zero findings\.)|verdict: \*\*(fix-now|deferred-batch-[0-9]+|speculative|out-of-scope)\*\*/m;
    if (!anyLine.test(text)) {
      err(`validate: ${FALLBACK_FILE} holds no finding line and no NO_FINDINGS — the fallback review did NOT happen.`);
      emitFields();
      exit(1);
    }
    process.stdout.write(text);
    if (/^\[(must-fix|should-fix)\]|verdict: \*\*(fix-now|deferred-batch-[0-9]+)\*\*/m.test(text)) NEED_FIX = 1;
    out("NOTE: recorded as claude-fallback (fresh context, NOT independent)");
    emitFields();
    exit(NEED_FIX === 0 ? 0 : 1);
  }

  // ── --require-qa ──────────────────────────────────────────────────────
  //
  // The gate that makes "QA must run fully if there's a UI" a mechanism. It is not
  // a commit trailer, because nothing in the close reads those, and not a Stop
  // hook, because a Stop hook fires after the reply has already been sent.
  //
  // Every target needs a marker for THIS tree. A /qa run that edited source moved
  // the tree, which is exactly when an earlier target's pass stopped describing
  // what is about to ship — so a stale marker is a missing marker, deliberately.
  if (REQUIRE_QA) {
    if (TREE === "") {
      err("validate: --require-qa needs --tree <sha>");
      exit(2);
    }
    if (TARGETS_FILE === "") {
      err("validate: --require-qa needs --targets-file <path>");
      exit(2);
    }
    if (!isFile(TARGETS_FILE)) {
      err(`validate: --targets-file not found: ${TARGETS_FILE}`);
      exit(2);
    }
    if (!isFile(MARK_QA_DONE)) {
      err(`validate: no marker helper at ${MARK_QA_DONE} — cannot verify QA.`);
      exit(2);
    }
    let missing = 0;
    let checked = 0;
    const text = readFileSync(TARGETS_FILE, "utf8");
    const targets = text.split("\n");
    // `while read` sees a last line with no newline too, and nothing after a final one.
    if (targets[targets.length - 1] === "") targets.pop();
    for (const target of targets) {
      if (target === "") continue;
      checked++;
      if (!isDir(target)) {
        err(`validate: QA target no longer exists: ${target}`);
        missing++;
        continue;
      }
      // mark-qa-done is run as the bash original ran it: this node, types stripped.
      const r = spawnSync(process.execPath, ["--experimental-strip-types", MARK_QA_DONE, "--marker-path", "--tree", TREE, target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      // `marker="$(…)"` under `set -e`: a helper that fails ends the gate with its status.
      if (statusOf(r) !== 0) exit(statusOf(r));
      const marker = chomp(r.stdout);
      if (isFile(marker)) {
        out(`PASS: qa-marker ${target}`);
      } else {
        out(`FAIL: qa-marker ${target}`);
        err(`validate: ${target} has no completed /qa for tree ${TREE.slice(0, 12)}`);
        missing++;
      }
    }
    if (missing > 0) {
      err("");
      err(`${missing} of ${checked} web target(s) have not finished /qa on this tree.`);
      err("A UI change closes only after /qa completed on it — impeccable on");
      err("@latest, screenshots, sight-check, visual review. Run /qa on each");
      err("target above and let it write its marker; do not write one by hand.");
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    out(`PASS: qa-marker (${checked} target(s) complete for tree ${TREE.slice(0, 12)})`);
    emitFields();
    exit(0);
  }

  switch (PHASE) {
    case "checks":
    case "review":
    case "qa-list":
    case "qa-revalidate":
      break;
    case "":
      err("validate: --phase is required (checks | review | qa-list | qa-revalidate)");
      exit(2);
      break;
    default:
      err(`validate: unknown phase: ${PHASE}`);
      exit(2);
  }

  // ── --phase checks ────────────────────────────────────────────────────
  //
  // Layer 1 (lint + typecheck) → layer 2 (tests) → layer 3 (quality, advisory). Then
  // the SKILL walks SPEC § 6 and the mechanism-match line. Always — an unchanged
  // review does not buy a skipped E2E, and that is the whole reason E2E moved off
  // the review's tail.
  if (PHASE === "checks") {
    if (!runLayers12()) {
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    // Advisory by contract: land.ts's checks are the blocking surface for shape.
    runTs(`${SCRIPT_DIR}/layer-3.ts`, ["--scope", SCOPE], { env: withRepo() });
    NEED_E2E = 1;
    out("NOTE: walk SPEC § 6 end-to-end now, then the mechanism-match line, before --phase review");
    emitFields();
    exit(0);
  }

  // ── --phase review ────────────────────────────────────────────────────
  if (PHASE === "review") {
    if (!isFile(REVIEW)) {
      err(`validate: no reviewer at ${REVIEW} — the audit cannot run and the session cannot close.`);
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }

    const PRE = snapshot();
    if (PRE === "") {
      err("validate: could not snapshot the working tree; the review cannot be scoped.");
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    out(`PRE_TREE=${PRE}`);

    // MANDATORY, not optional. These are the six deterministic checks; skipping
    // them to save a few seconds is how a dangling rule ref reaches a vendor call.
    if (isFile(AUTOMATED_CHECKS)) {
      const checks = runTs(AUTOMATED_CHECKS, ["--session-base", BASE || "HEAD", "--repo-dir", REPO_DIR], {
        env: withRepo(),
      });
      if (statusOf(checks) !== 0) {
        err("validate: the automated checks reported a FAIL — fix those before spending a vendor call.");
        NEED_FIX = 1;
        emitFields();
        exit(1);
      }
    } else {
      err(`validate: WARN no automated checks at ${AUTOMATED_CHECKS}`);
    }

    let review: SpawnSyncReturns<string>;
    const reviewEnv = { ...process.env, CODEX_REVIEW_REPO: REPO_DIR };
    if (SINCE !== "") {
      review = runTs(REVIEW, ["--since", SINCE], { env: reviewEnv, capture: true });
    } else {
      if (BASE === "" || HEAD_REF === "") {
        err("validate: --phase review needs --base and --head (round 1) or --since <tree> (rounds 2+)");
        exit(2);
      }
      review = runTs(REVIEW, [BASE, HEAD_REF], { env: reviewEnv, capture: true });
    }
    const reviewRc = statusOf(review);
    const reviewOut = review.stdout ?? "";

    switch (reviewRc) {
      case 0:
        break;
      case 4:
        out("NOTE: the fix loop converged — nothing changed since the last round");
        break;
      case 3:
        // No independent reviewer answered. A completed-but-weaker path, not a
        // failure: the agent runs the fresh-context fallback reviewer and records
        // it as NOT independent.
        out(
          `NOTE: no independent reviewer — the review is PENDING. Run the implement-audit-reviewer agent in a fresh context on the same diff, save its triage lines, then: ${FALLBACK_CMD}. Record: implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); …`,
        );
        out("NEED_FALLBACK_REVIEW=1");
        PENDING_FALLBACK = true;
        break;
      case 5:
        out("NOTE: the fix loop hit the round-4 ceiling — report what is still open");
        break;
      case 2:
        err("validate: the reviewer was called wrong (exit 2). Fix the range and re-run.");
        exit(2);
        break;
      default:
        err(`validate: the reviewer exited ${reviewRc} — the review did NOT happen.`);
        err("That is not a clean pass and it is not a nit to hold: there is no audit,");
        err("so there is no close. Restore a vendor and re-run.");
        NEED_FIX = 1;
        emitFields();
        exit(1);
    }

    // Only exit 0 carries findings; 4 and 5 print none by construction.
    if (reviewRc === 0) {
      process.stdout.write(reviewOut);
      // A [nit] is held for the end of the loop, never a reason to re-enter it —
      // nits are an unbounded supply and re-reviewing after fixing one is how the
      // loop finds the next one forever.
      if (/^\[(must-fix|should-fix)\]/m.test(reviewOut)) NEED_FIX = 1;
    }

    const POST = snapshot();
    out(`POST_TREE=${POST}`);

    // WHAT THIS COMPARES AGAINST, and why it is not PRE on a follow-up round.
    //
    // The reviewer never edits the tree, so PRE and POST are equal in the common
    // case and comparing them answers nothing. The question that matters is "has
    // anything changed since the last state the layers actually validated?" — and
    // on a follow-up round that state is SINCE, the snapshot taken before the
    // PREVIOUS round. Everything between them is this round's FIXES, which by
    // definition no layer and no E2E has seen. Comparing against PRE declared
    // them validated because PRE was taken after they were written.
    const baseline = SINCE || PRE;
    if (POST !== "" && POST !== baseline) {
      err(`validate: the tree moved since ${baseline.slice(0, 12)} — re-running layers 1+2 over what moved.`);
      if (!runLayers12(filesSince(baseline))) NEED_FIX = 1;
      NEED_E2E = 1;
    }

    emitFields();
    if (NEED_FIX !== 0) exit(1);
    exit(PENDING_FALLBACK ? 3 : 0);
  }

  // ── --phase qa-list ───────────────────────────────────────────────────
  if (PHASE === "qa-list") {
    if (!isFile(QA_TARGETS_TS)) {
      err(`validate: no enumerator at ${QA_TARGETS_TS} — cannot tell whether a UI changed.`);
      exit(2);
    }
    // --base matters: /implement-audit reviews BASE_SHA..HEAD *plus* uncommitted,
    // so a session that committed its UI change has it in the review and nowhere
    // in `git diff HEAD`. Without this the enumerator saw a clean-ish worktree and
    // answered "skipped-not-web" for a change that was all pixels.
    const targetsArgs = ["--repo", REPO_DIR];
    if (BASE !== "") targetsArgs.push("--base", BASE);
    // qa-targets is run as the bash original ran it: this node, types stripped.
    const r = spawnSync(process.execPath, ["--experimental-strip-types", QA_TARGETS_TS, ...targetsArgs], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
      maxBuffer: 256 * 1024 * 1024,
    });
    const targetsRc = statusOf(r);
    if (targetsRc !== 0) {
      err(`validate: the QA target enumerator failed (exit ${targetsRc}). HALT —`);
      err("a detector failure must never read as 'no UI changed'.");
      exit(2);
    }
    const targets = chomp(r.stdout);
    if (targets === "") {
      out("QA_TARGETS=");
      out("NOTE: no web target in this change — record qa: skipped-not-web");
    } else {
      for (const t of targets.split("\n")) {
        if (t === "") continue;
        out(`QA_TARGETS=${t}`);
      }
    }
    emitFields();
    exit(0);
  }

  // ── --phase qa-revalidate ─────────────────────────────────────────────
  //
  // /qa fixes things. Impeccable findings get fixed, visual findings get fixed,
  // and those edits are code nobody has reviewed. Re-reviewing them goes through
  // code-review.ts --since directly rather than through a second /implement-audit
  // dispatch, because audit-dedupe would no-op that dispatch and re-emit the
  // stored trailer — a clean-looking audit over unreviewed bytes.
  if (PHASE === "qa-revalidate") {
    if (SINCE === "") {
      err("validate: --phase qa-revalidate needs --since <tree>");
      exit(2);
    }
    const POST = snapshot();
    out(`POST_TREE=${POST}`);

    if (POST !== "" && POST === SINCE) {
      out("NOTE: /qa changed nothing — no re-review needed");
      emitFields();
      exit(0);
    }

    NEED_E2E = 1;
    // Over what /qa MOVED, not over the scope. /qa's fixes are routinely unstaged
    // or untracked, and a blank scope resolves to the staged set — so this used to
    // report PASS over files it had never opened.
    if (!runLayers12(filesSince(SINCE))) NEED_FIX = 1;

    if (!isFile(REVIEW)) {
      err(`validate: no reviewer at ${REVIEW} — /qa's edits cannot be reviewed.`);
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }

    // ITS OWN ROUND BUDGET. The round counter is keyed on the session, and the
    // implementation fix loop that ran before this may have spent all four rounds
    // — at which point the post-QA review would return exit 5 without ever
    // calling a vendor, and /qa's own source edits would ship unreviewed behind a
    // "ceiling reached" note. This is a DIFFERENT loop reviewing DIFFERENT code,
    // so it gets a different counter, which is the same reasoning code-review.ts
    // uses when a full two-arg review resets the count.
    const review = runTs(REVIEW, ["--since", SINCE], {
      env: {
        ...process.env,
        CODEX_REVIEW_REPO: REPO_DIR,
        CODE_REVIEW_ROUND_STATE_DIR: `${process.env.CODE_REVIEW_ROUND_STATE_DIR || "/tmp/code-review-rounds"}-qa`,
      },
      capture: true,
    });
    const reviewRc = statusOf(review);
    switch (reviewRc) {
      case 0: {
        const reviewOut = review.stdout ?? "";
        process.stdout.write(reviewOut);
        if (/^\[(must-fix|should-fix)\]/m.test(reviewOut)) NEED_FIX = 1;
        break;
      }
      case 4:
        out("NOTE: nothing to re-review after /qa");
        break;
      case 3:
        out(
          `NOTE: no independent reviewer — the review of /qa's edits is PENDING. Run the implement-audit-reviewer agent on them in a fresh context, save its triage lines, then: ${FALLBACK_CMD}. Record it as claude-fallback (fresh context, NOT independent)`,
        );
        out("NEED_FALLBACK_REVIEW=1");
        PENDING_FALLBACK = true;
        break;
      case 5:
        // With a dedicated counter this cannot fire on the first qa-revalidate,
        // and if it somehow does it means the post-QA review did NOT happen. That
        // is not a note to carry to the close; it is the same unreviewed-code
        // failure exit 1 and 124 are.
        err("validate: the post-QA review hit the round ceiling — /qa's edits are unreviewed.");
        NEED_FIX = 1;
        break;
      default:
        err(`validate: the post-QA review exited ${reviewRc} — /qa's edits are unreviewed.`);
        NEED_FIX = 1;
    }

    emitFields();
    if (NEED_FIX !== 0) exit(1);
    exit(PENDING_FALLBACK ? 3 : 0);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
