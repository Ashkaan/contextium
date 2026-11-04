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
//   validate.ts --phase review --base <sha> --head <sha> [--since <tree>] --scope <arg> [--report <path>]
//   validate.ts --phase review --base <sha> --head <sha> --slice <file> --scope <arg> [--report <path>]
//   validate.ts --phase qa-list [--base <sha>]
//   validate.ts --phase qa-revalidate --since <tree> [--report <path>]
//   validate.ts --require-qa --targets-file <path> --tree <sha>
//   validate.ts --phase report --base <sha> --report <path>
//   validate.ts --fallback-review <reply-file> [--repo <dir>]
//
// Flags:
//   --phase <name>       checks | review | qa-list | qa-revalidate | report
//   --scope <arg>        passed through to resolve-scope.ts (blank = staged)
//   --base / --head      the full review's range (phase review, round 1).
//                        --base is ALSO read by qa-list, so a UI change that is
//                        already committed still enumerates, and by report, as
//                        the point the changed test files are counted from.
//   --since <tree>       a tree from `code-review.ts --snapshot`; scopes the
//                        review to what changed since it (phase review rounds
//                        2+, and every qa-revalidate)
//   --slice <file>       one piece of the full review: a NUL-separated
//                        list of the changed files this piece reviews, over
//                        the same --base and --head as the set's other pieces.
//                        Only with --phase review --base/--head, never --since
//   --targets-file PATH  the QA_TARGETS list (one absolute path per line)
//   --tree <sha>         the tree every target's QA marker must be keyed on
//   --report <path>      the spec's report.md, whose `test-failure-observed:`
//                        line phase report reads; for review and
//                        qa-revalidate, the report whose review-coverage block
//                        the review receipt binds (audit-dedupe.ts)
//   --repo <dir>         the worktree (default: CLAUDE_PROJECT_DIR, then git)
//
// Output (stdout): TAP-ish layer lines from the layer scripts, then the two
// machine fields the skill branches on, always both, always last:
//
//   NEED_FIX=0|1     the reviewer asked for changes
//   NEED_E2E=0|1     the tree moved since the phase started, so SPEC § 6 has to
//                    be walked again
//
// A piece whose set has not read every changed file yet also prints
// `SLICE_PENDING=<n>` and one `unread: <path>` line per file still unread,
// before the two fields. That alone is not NEED_FIX — the next piece reads them
// — but the phase still exits 1, because nothing is approved yet.
// `--phase review` / `qa-revalidate` additionally print `NEED_FALLBACK_REVIEW=1`
// when no independent reviewer answered (code-review.ts exit 3), and exit 3:
// the review is PENDING, not passed. Run the implement-audit-reviewer agent in a
// fresh context on the same diff (handing it the `ITEMS_FILE=` the note names,
// when there is one), save its reply to a file, and hand it to
// `--fallback-review <file>` — that call records the reply against the review
// receipt (audit-dedupe.ts finish --fallback) and is the phase's pass (exit 0)
// or its findings (exit 1), recorded as `claude-fallback (fresh context, NOT
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
//      reviewer chain failed, --require-qa found a target with no marker for
//      the given tree, or phase report found a changed test file and no red
//      excerpt in the report
//   2  caller error (including range or original-author provenance)
//   3  the review is pending: no independent reviewer answered — run the
//      fallback reviewer, then --fallback-review <file>
//   4  review phase converged; distinct from a fresh clean review
//
// ONE REVIEW PATH. Review and qa-revalidate call
// the same runReview below: reuse a review receipt that still covers this
// content (no vendor call), else record the attempt incomplete, run the
// reviewer — falling back to the one final pass at the ceiling — and record
// what it returned against the content captured before dispatch. They differ
// only in their order (review runs the deterministic checks first, and on a
// follow-up round layers 1+2 over its fixes; QA re-runs layers 1+2 over what
// /qa moved first — a failure in either stops before any review), the bucket
// they spend (build or qa),
// and the range they hand the reviewer. Approval is the receipt's, read from
// the parsed result, never the reviewer's exit 0 alone.
//   5  review phase exhausted its final pass; NEED_FIX=1, approval blocked
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
//   - layer-1 FAIL:                exit 1, and review NEVER runs — in checks,
//                                  over a follow-up round's fixes (run before
//                                  its review) and over /qa's edits
//   - layer-3 FAIL:                advisory, does not fail the phase
//   - reviewer NO_FINDINGS:        NEED_FIX=0, exit 0
//   - reviewer [nit] only:         NEED_FIX=0 — a nit is not a change request
//   - reviewer [must-fix]:         NEED_FIX=1, exit 1
//   - reviewer exit 4 (converged): NEED_FIX=0, exit 4, with a note
//   - reviewer exit 5 (ceiling):   the one `--final` review runs instead, in
//                                  qa-revalidate too, on its own counter;
//                                  a second exit 5 is NEED_FIX=1, exit 5
//                                  (in qa-revalidate, exit 1: the edits went unreviewed)
//   - reviewer exit 3 (no independent vendor): NEED_FALLBACK_REVIEW=1, exit 3 —
//                                  pending until --fallback-review records one
//   - reviewer exit 1/124:         exit 1 — the audit did not happen
//   - tree unchanged over review:  NEED_E2E=0
//   - tree changed over review:    layers 1+2 re-run, NEED_E2E=1
//   - a follow-up round's fixes:   layers 1+2 before the review, NEED_E2E=1
//   - 0 QA targets:                `QA_TARGETS=`, --require-qa is a no-op
//   - target with no marker:       --require-qa exit 1
//   - target with a STALE marker:  --require-qa exit 1 (the tree moved)
//   - report, no test file changed: PASS whatever the line holds
//   - report, a test changed, the line missing, empty, `none…` or the
//     template's `{…}` placeholder: one FAIL line per test file, exit 1
//   - report, an untracked new test: counted, like a committed one
//   - report, a deleted test:       not counted — nothing is left to see fail
//   - report, git cannot list what changed: exit 1, never a pass over nothing

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  let REPORT = "";
  let SLICE = "";
  let REQUIRE_QA = false;
  let FALLBACK_FILE = "";
  let REPO_DIR = process.env.CLAUDE_PROJECT_DIR ?? "";

  const argv = process.argv.slice(2);
  // A flag that takes a value and has none is a caller error like any other.
  // It ended the bash original silently with status 1 (`shift 2` failing under
  // `set -e`), which read as a refusal with no reason given.
  const value = (): string => {
    if (argv.length < 2) {
      err(`validate: ${argv[0]} needs a value`);
      exit(2);
    }
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
      case "--report":
        REPORT = value();
        break;
      case "--slice":
        SLICE = resolve(value());
        break;
      case "--repo":
        REPO_DIR = value();
        break;
      case "--require-qa":
        REQUIRE_QA = true;
        argv.shift();
        break;
      case "--fallback-review":
        FALLBACK_FILE = value();
        if (FALLBACK_FILE === "") {
          err("validate: --fallback-review needs the fallback reviewer's reply file");
          exit(2);
        }
        break;
      case "-h":
      case "--help": {
        // The header comment above, from line 2 through its Exit block, is the
        // help text. Found by the paragraph that follows the block rather than
        // by a line number, which went stale the first time the Usage grew.
        const all = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
        const lines = all.slice(1, all.findIndex((l) => l.startsWith("// WHAT THIS SCRIPT DOES NOT DO")) - 1);
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
  // A piece is one part of the build bucket's full review, and nothing else.
  if (SLICE !== "" && PHASE !== "review") {
    err("validate: --slice applies only to --phase review's full review (--base and --head)");
    exit(2);
  }
  if (SLICE !== "" && SINCE !== "") {
    err("validate: --slice is a piece of the full review; a --since round reviews the fixes across the whole change");
    exit(2);
  }

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
  const AUDIT = process.env.VALIDATE_AUDIT_DEDUPE || `${SKILLS_DIR}/implement-audit/scripts/audit-dedupe.ts`;

  let NEED_FIX = 0;
  let NEED_E2E = 0;
  // Set when no independent reviewer answered: the phase ends in exit 3, pending.
  let PENDING_FALLBACK = false;

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
  //
  // Both reads take -z and split on NUL: without it git C-quotes `café.ts` as
  // `"caf\303\251.ts"` and a newline in a name splits it in two, and layer 1 then
  // lints paths that do not exist. A git that fails is null, never an empty list
  // — when neither exit status was read, a failed listing ran the layers over
  // nothing and they reported PASS.
  const filesSince = (tree: string): string[] | null => {
    const paths: string[] = [];
    for (const args of [
      ["-C", REPO_DIR, "diff", "-z", "--name-only", tree],
      ["-C", REPO_DIR, "ls-files", "-z", "--others", "--exclude-standard"],
    ]) {
      const r = spawnSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      });
      if (r.error || r.status !== 0) {
        err(
          `validate: git ${args.slice(2).join(" ")} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`}) — refusing to validate a partial list of what moved.`,
        );
        if (r.stderr) err(`  ${r.stderr.replace(/\n+$/, "")}`);
        return null;
      }
      paths.push(...r.stdout.split("\0"));
    }
    const kept = paths.filter((p) => p !== "");
    // `sort -u` under LC_ALL=C: byte order, duplicates dropped.
    return [...new Set(kept)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  };

  // Layers 1 and 2, in that order, with layer 1 gating layer 2 — type errors mask
  // runtime errors, so a failing typecheck makes a test result meaningless.
  //
  // `files`, when given, is an explicit file list; otherwise the scope is resolved.
  // null is a list that could not be read (filesSince said why): the layers fail.
  const runLayers12 = (files?: string[] | null): boolean => {
    if (files === null) return false;
    let list = files;
    if (list === undefined) {
      // A scope that does not resolve is NOT an empty scope. In the bash original
      // every caller invoked this as `run_layers_1_2 || rc=$?`, which suspended
      // errexit for the whole body — so a failing resolve-scope left `files` empty
      // and the layers cheerfully reported PASS over nothing, for a scope naming an
      // app that does not exist. The status is checked explicitly.
      const r = runTs(`${SCRIPT_DIR}/resolve-scope.ts`, ["-z", "--scope", SCOPE], { env: withRepo(), capture: true });
      if (statusOf(r) !== 0) {
        err(`validate: the scope '${SCOPE}' did not resolve — refusing to validate an empty file list.`);
        err("  An unresolvable scope is a caller error, not a clean run over zero files.");
        return false;
      }
      list = r.stdout.split("\0").filter((p) => p !== "");
    }
    // NUL-terminated records, which both layers split on: a newline-joined list
    // broke a path holding a newline back into two.
    const input = list.map((p) => `${p}\0`).join("");
    const l1 = runTs(`${SCRIPT_DIR}/layer-1.ts`, [], { env: withRepo(), input });
    if (statusOf(l1) !== 0) {
      err("validate: layer 1 failed — stopping. Nothing downstream runs on a tree that does not type-check.");
      return false;
    }
    const l2 = runTs(`${SCRIPT_DIR}/layer-2.ts`, [], { env: withRepo(), input });
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

  // The one review path. `tree` is the snapshot taken before dispatch; the
  // receipt binds the result to the content as it was then. Returns the
  // reviewer's exit (2 for a caller error in the receipt's inputs, 1 when the
  // attempt could not be recorded) and its stdout. NEED_FIX for an unapproved
  // receipt is the caller's, which knows whether findings explain it.
  type Reviewed = {
    rc: number;
    out: string;
    approved: boolean | null;
    items: string;
    /** A piece whose set is not complete: the changed files still unread, and whether anything else already blocks it. */
    pending?: { unread: number; lines: string[]; blocked: boolean };
  };
  const runReview = (bucket: "build" | "qa", tree: string): Reviewed => {
    const mode = SINCE !== "" ? "since" : "range";
    let itemsFile = "";
    const keep = isFile(AUDIT);
    if (!keep) err(`validate: WARN no receipt keeper at ${AUDIT} — this review cannot be reused or satisfy a close`);
    else {
      const args = ["begin", "--repo", REPO_DIR, "--tree", tree, "--mode", mode, "--bucket", bucket];
      if (BASE !== "") args.push("--base", BASE);
      if (SINCE === "" && HEAD_REF !== "") args.push("--head", HEAD_REF);
      if (bucket === "build") args.push("--scope", SCOPE);
      if (SINCE !== "") args.push("--since", SINCE);
      if (REPORT !== "") args.push("--report", REPORT);
      if (SLICE !== "") args.push("--slice", SLICE);
      const b = runTs(AUDIT, args, { env: withRepo(), capture: true });
      const said = b.stdout ?? "";
      if (statusOf(b) === 2) return { rc: 2, out: "", approved: false, items: "" };
      if (statusOf(b) !== 0) {
        err("validate: the review could not be bound to its content (above) — no review call was made.");
        return { rc: 1, out: "", approved: false, items: "" };
      }
      if (said.includes("RECEIPT=reuse")) {
        for (const l of said.split("\n")) if (l.startsWith("NOTE:")) out(l);
        return { rc: 0, out: "", approved: true, items: "" };
      }
      itemsFile = said.match(/^ITEMS_FILE=(.*)$/m)?.[1] ?? "";
    }
    const dir = mkdtempSync(join(tmpdir(), "validate-review-"));
    const resultFile = join(dir, "result.json");
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_REVIEW_REPO: REPO_DIR, CODE_REVIEW_BUCKET: bucket };
      if (keep) {
        env.CODE_REVIEW_RESULT_FILE = resultFile;
        if (itemsFile !== "") env.CODE_REVIEW_COVERAGE_FILE = itemsFile;
      }
      const call = (extra: string[]) =>
        runTs(
          REVIEW,
          SINCE !== "" ? ["--since", SINCE, ...extra] : [BASE, HEAD_REF, ...(SLICE !== "" ? ["--slice", SLICE] : [])],
          { env, capture: true },
        );
      let review = call([]);
      let rc = statusOf(review);
      // At the ceiling, the fixes made since the last round still get their one
      // review: `--final`, once per loop and bucket. Its findings count
      // like a round's; a second ceiling — the final pass already spent — stands.
      if (rc === 5 && SINCE !== "") {
        const fin = call(["--final"]);
        if (statusOf(fin) !== 5) {
          out(
            bucket === "qa"
              ? "NOTE: the post-QA round ceiling was reached — this is the final review of /qa's newest edits"
              : "NOTE: the round-4 ceiling was reached — this is the final review of the fixes since the last round",
          );
          review = fin;
          rc = statusOf(fin);
        }
      }
      let approved: boolean | null = null;
      let pending: Reviewed["pending"];
      if (keep) {
        const fargs = ["finish", "--repo", REPO_DIR, "--rc", String(rc)];
        if (rc === 0 && isFile(resultFile)) fargs.push("--result", resultFile);
        const f = runTs(AUDIT, fargs, { env: withRepo(), capture: true });
        approved = /^APPROVED=1$/m.test(f.stdout ?? "");
        const sp = (f.stdout ?? "").match(/^SLICE_PENDING=(\d+)$/m);
        if (sp)
          pending = {
            unread: Number(sp[1]),
            lines: (f.stdout ?? "").split("\n").filter((l) => /^(?:unread|unchecked): /.test(l)),
            blocked: /^SLICE_BLOCKED=1$/m.test(f.stdout ?? ""),
          };
        if (statusOf(f) !== 0) {
          err("validate: the review's outcome could not be recorded — it cannot count.");
          if (rc === 0) rc = 1;
        } else if (rc === 0 || rc === 4) out(`RECEIPT: ${approved ? "approved" : "not approved (reasons above)"}`);
      }
      return { rc, out: review.stdout ?? "", approved, items: itemsFile, ...(pending ? { pending } : {}) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // The note a pending review prints: who reviews, over what, and the one call
  // that records it. `items` is the receipt's coverage items file, when there is one.
  const pendingNote = (what: string, items: string): string =>
    `NOTE: no independent reviewer — the review of ${what} is PENDING. Run the implement-audit-reviewer agent in a fresh context on it${
      items !== "" ? `, with the coverage items in ${items} (it ends its reply with the BEGIN_REVIEW_V1 frame)` : ""
    }, save its reply to a file, then: node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --fallback-review <file> --repo ${REPO_DIR}. Record: implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); …`;

  // ── --fallback-review ─────────────────────────────────────────────────
  //
  // The way out of a pending review (exit 3). The fallback reviewer's reply is
  // recorded against the review receipt the pending attempt opened
  // (audit-dedupe.ts finish --fallback), which reads it the way code-review.ts
  // reads a vendor's — the BEGIN_REVIEW_V1 frame when there is one, else triage
  // lines or the reviewer's own verdict format — and refuses an attempt the chain
  // did not leave pending. A [must-fix] or [should-fix] (fix-now, deferred-batch)
  // is a fix owed (exit 1), a [nit] is held, and a receipt that does not approve
  // — an unchecked coverage item, say — is a change request too. It is a pass of
  // a WEAKER review, and the line it prints says so, because the report and the
  // journal carry it and nothing may read it as an independent one.
  if (FALLBACK_FILE !== "") {
    if (!isFile(FALLBACK_FILE)) {
      err(`validate: --fallback-review file not found: ${FALLBACK_FILE}`);
      exit(2);
    }
    const text = readFileSync(FALLBACK_FILE, "utf8");
    if (!isFile(AUDIT)) {
      err(`validate: no receipt keeper at ${AUDIT} — the fallback review cannot be recorded or satisfy a close.`);
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    const f = runTs(AUDIT, ["finish", "--repo", REPO_DIR, "--fallback", FALLBACK_FILE], {
      env: withRepo(),
      capture: true,
    });
    const approved = /^APPROVED=1$/m.test(f.stdout ?? "");
    if (statusOf(f) !== 0) {
      err("validate: the fallback review was NOT recorded (above) — it cannot count.");
      NEED_FIX = 1;
      emitFields();
      exit(statusOf(f) === 2 ? 2 : 1);
    }
    process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
    // A piece whose set is not complete: the next piece reads what is unread,
    // so that alone is not a change request — but nothing is approved yet.
    const fsaid = f.stdout ?? "";
    const sp = fsaid.match(/^SLICE_PENDING=(\d+)$/m);
    if (sp) {
      out(`SLICE_PENDING=${sp[1]}`);
      for (const l of fsaid.split("\n")) if (/^(?:unread|unchecked): /.test(l)) out(l);
    }
    const onlyPending = sp !== null && !/^SLICE_BLOCKED=1$/m.test(fsaid);
    if (/^\[(must-fix|should-fix)\]|verdict: \*\*(fix-now|deferred-batch-[0-9]+)\*\*/m.test(text) || (!approved && !onlyPending)) NEED_FIX = 1;
    out(`RECEIPT: ${approved ? "approved" : "not approved (reasons above)"}`);
    out("NOTE: recorded as claude-fallback (fresh context, NOT independent)");
    emitFields();
    exit(NEED_FIX === 0 && !sp ? 0 : 1);
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
    case "report":
      break;
    case "":
      err(`validate: --phase is required (${PHASES})`);
      exit(2);
      break;
    default:
      err(`validate: unknown phase: ${PHASE} (${PHASES})`);
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

    if (SINCE === "" && (BASE === "" || HEAD_REF === "")) {
      err("validate: --phase review needs --base and --head (round 1) or --since <tree> (rounds 2+)");
      exit(2);
    }
    // A follow-up round's fixes are what no layer has seen. They run layers 1+2
    // BEFORE the review, which records a receipt: run after it, a fix that does
    // not type-check held an approval the next begin reused (the peer of the
    // post-QA case, Contextium v9.2.0 review).
    let layeredAt = "";
    if (SINCE !== "" && PRE !== SINCE) {
      NEED_E2E = 1;
      if (!runLayers12(filesSince(SINCE))) {
        err("validate: this round's fixes fail layers 1+2 — fix them and re-run before they are reviewed.");
        NEED_FIX = 1;
        emitFields();
        exit(1);
      }
      layeredAt = PRE;
    }
    const reviewed = runReview("build", PRE);
    const reviewRc = reviewed.rc;
    const reviewOut = reviewed.out;

    switch (reviewRc) {
      case 0:
        break;
      case 4:
        out("NOTE: the fix loop converged — nothing changed since the last round");
        break;
      case 3:
        // No independent reviewer answered. A completed-but-weaker path, not a
        // failure: the agent runs the fresh-context fallback reviewer and records
        // it as NOT independent, against the same receipt.
        out(pendingNote("this diff", reviewed.items));
        out("NEED_FALLBACK_REVIEW=1");
        PENDING_FALLBACK = true;
        break;
      case 5:
        out("NOTE: the fix loop hit the round-4 ceiling and its final review already ran — report what is still open");
        NEED_FIX = 1;
        break;
      case 2:
        err("validate: reviewer input error (exit 2). Correct the range or original-author provenance named above.");
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
    // A review that completed but did not approve — an unchecked declared item,
    // a reviewed range missing a changed path, or blockers a converged round
    // left standing — is a change request, never a pass.
    // A piece set still being read is not a change request: the next piece
    // reads the files it names. Anything else that already blocks the
    // set — a finding, a writer as reviewer, a later commit — still is.
    const pending = reviewed.pending;
    if (pending) {
      out(`SLICE_PENDING=${pending.unread}`);
      for (const l of pending.lines) out(l);
    }
    const onlyPending = pending !== undefined && !pending.blocked;
    if ((reviewRc === 0 || reviewRc === 4) && reviewed.approved === false && !onlyPending) NEED_FIX = 1;

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
    //
    // Layers that already ran over SINCE..PRE before the review need not run
    // again unless the tree moved during it.
    const baseline = layeredAt || SINCE || PRE;
    if (POST !== "" && POST !== baseline) {
      err(`validate: the tree moved since ${baseline.slice(0, 12)} — re-running layers 1+2 over what moved.`);
      if (!runLayers12(filesSince(baseline))) {
        NEED_FIX = 1;
        // A review left pending is finished later by --fallback-review, which
        // runs no layer: the failure goes on the pending receipt, or a clean
        // fallback reply would approve it and exit 0 with NEED_FIX=0.
        if (PENDING_FALLBACK && isFile(AUDIT)) {
          const k = runTs(AUDIT, ["finish", "--repo", REPO_DIR, "--rc", "3", "--checks-failed"], { env: withRepo(), capture: true });
          if (statusOf(k) !== 0) err("validate: the layer failure could NOT be kept on the pending review — do not run the fallback review; fix and re-run this phase.");
        }
      }
      NEED_E2E = 1;
    }

    emitFields();
    exit(reviewRc === 5 ? 5 : NEED_FIX !== 0 || pending ? 1 : PENDING_FALLBACK ? 3 : reviewRc === 4 ? 4 : 0);
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
  // and those edits are code nobody has reviewed. They go through the same
  // runReview path as a fix round, on the qa bucket: the receipt is reused when
  // /qa moved only records, and anything else /qa changed is reviewed before
  // the receipt can approve the content again.
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
    //
    // A failure stops here, before any vendor call: the review below records a
    // receipt, and one approving edits that fail layers 1+2 was reused as an
    // approval of that content (Contextium v9.2.0 review). Fix and re-run.
    if (!runLayers12(filesSince(SINCE))) {
      err("validate: /qa's edits fail layers 1+2 — fix them and re-run before they are reviewed.");
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }

    if (!isFile(REVIEW)) {
      err(`validate: no reviewer at ${REVIEW} — /qa's edits cannot be reviewed.`);
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }

    // ITS OWN ROUND BUDGET: the qa bucket. The implementation fix loop that
    // ran before this may have spent all four build rounds — at which point the
    // post-QA review would return exit 5 without ever calling a vendor, and
    // /qa's own source edits would ship unreviewed behind a "ceiling reached"
    // note. /qa can take several fix passes, each its own qa-revalidate, and
    // they can spend the qa bucket's four rounds too; the newest edits then
    // still get the one final review, as the implementation loop's do — never a
    // halt over code one more call would have reviewed (a fifth /qa pass was
    // refused that way). Edits to records alone reuse the receipt and spend nothing.
    if (POST === "") {
      err("validate: could not snapshot the working tree; /qa's edits cannot be bound to a review.");
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    const reviewed = runReview("qa", POST);
    const review = { stdout: reviewed.out };
    const reviewRc = reviewed.rc;
    if ((reviewRc === 0 || reviewRc === 4) && reviewed.approved === false) NEED_FIX = 1;
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
        out(pendingNote("/qa's edits", reviewed.items));
        out("NEED_FALLBACK_REVIEW=1");
        PENDING_FALLBACK = true;
        break;
      case 5:
        // The final review already spent: /qa's newest edits were NOT reviewed.
        // That is not a note to carry to the close; it is the same
        // unreviewed-code failure exit 1 and 124 are.
        err("validate: the post-QA review hit the round ceiling — /qa's edits are unreviewed.");
        NEED_FIX = 1;
        break;
      default:
        err(`validate: the post-QA review exited ${reviewRc} — /qa's edits are unreviewed.`);
        NEED_FIX = 1;
    }

    emitFields();
    exit(NEED_FIX !== 0 ? 1 : PENDING_FALLBACK ? 3 : 0);
  }

  // ── --phase report ────────────────────────────────────────────────────
  //
  // A test never seen failing is not evidence: it may assert against a field the
  // code never reads, and pass forever. /implement
  // asks for the red run's excerpt on the report's `test-failure-observed:` line,
  // and until this phase nothing read it, so `none` over a new test closed
  // cleanly. Run after Phase 5 fills the report in; Phase 6 will not auto-close
  // until it exits 0. It trusts what the line says — a made-up excerpt passes.
  if (PHASE === "report") {
    if (BASE === "") {
      err("validate: --phase report needs --base <sha>");
      exit(2);
    }
    if (REPORT === "") {
      err("validate: --phase report needs --report <path to report.md>");
      exit(2);
    }
    if (!isFile(REPORT)) {
      err(`validate: --report is not a file: ${REPORT}`);
      exit(2);
    }
    const changed = filesSince(BASE);
    if (changed === null) {
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    const tests = changed.filter((p) => isTestPath(p) && isFile(`${REPO_DIR}/${p}`));
    const line = redFirstLine(readFileSync(REPORT, "utf8"));
    if (tests.length > 0 && line !== "present") {
      for (const t of tests) out(`FAIL: red-first ${t}`);
      err("");
      err(
        `validate: ${tests.length} test file(s) changed since ${BASE.slice(0, 12)}, and the report's ${LINE_STATE[line]}.`,
      );
      err("A test nobody saw fail proves nothing. Break the code or the fixture on purpose,");
      err("run the test, check the failure names the thing the test claims, restore it,");
      err("and put that failure's excerpt on the line. A test or fixture changed without");
      err("changing what any test expects is written `not-applicable — <why>`.");
      NEED_FIX = 1;
      emitFields();
      exit(1);
    }
    out(
      tests.length === 0
        ? `PASS: red-first (no test file changed since ${BASE.slice(0, 12)})`
        : `PASS: red-first (${tests.length} test file(s); excerpt present)`,
    );
    emitFields();
    exit(0);
  }
}

const PHASES = "checks | review | qa-list | qa-revalidate | report";

// What counts as a test file for --phase report. Wider than the workbench's own
// `*.test.ts`, because /implement builds product rows too (`--repo`), and the
// products name tests `.test.tsx`, `.spec.js` and `__tests__/…`. A file under
// `tests/` counts whatever its name, since a fixture there changes what a test
// asserts. The extension list keeps out data records named like `x.test.json`.
function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  return (
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/.test(name) ||
    parts.some((d) => d === "tests" || d === "__tests__")
  );
}

type LineState = "absent" | "empty" | "none" | "placeholder" | "present";
const LINE_STATE: Record<Exclude<LineState, "present">, string> = {
  absent: "has no `test-failure-observed:` line",
  empty: "`test-failure-observed:` line is empty",
  none: '`test-failure-observed:` line reads "none"',
  placeholder: "`test-failure-observed:` line is still the template's placeholder",
};

// The report's first `test-failure-observed:` line, key bold, backticked or bare.
// `none` is the template's answer for a run that changed no test, and the
// unfilled `{…}` is the template itself; neither is an excerpt.
function redFirstLine(report: string): LineState {
  const m = report.match(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*|`)?test-failure-observed:(?:\*\*|`)?(.*)$/m);
  if (!m) return "absent";
  const value = (m[1] ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
  if (value === "") return "empty";
  if (/^none\b/i.test(value)) return "none";
  if (/^\{.*\}$/.test(value)) return "placeholder";
  return "present";
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
