#!/usr/bin/env -S node --experimental-strip-types
// code-review.ts — Adversarial code review of a diff, on whichever vendor the
// policy's `adversarial-review` row selects.
//
// The diff-side mirror of spec-audit.ts. The caller supplies verified original
// authors via POLICY_CHAIN_AUTHOR_VENDORS (.agents/skills/review/SKILL.md); the chain
// excludes them. WHICH eligible vendor answers is not decided here — it is read from
// the policy table (policy.json beside this script) via
// .agents/skills/review/policy-chain.ts.
// Renamed from an old vendor-named filename: that name was a pin, and a filename
// naming a vendor is a promise the table cannot keep.
//
// Usage:
//   code-review.ts <base-sha> <head-sha>      full review (round 1)
//   code-review.ts --since <tree>             follow-up round: ONLY what changed
//   code-review.ts --since <tree> --final     the one review past the round-4
//                                             ceiling, of the fixes still unreviewed
//                                             since <tree>
//   code-review.ts --snapshot                 print a tree SHA capturing the
//                                             current working tree
//   code-review.ts --fixture <dir>
//
// ROUNDS 2+ REVIEW ONLY THE FIXES, NOT THE WHOLE DIFF. Until this
// change every round re-read the entire cumulative diff, so the reviewer kept
// re-deciding settled code and each round's own fixes became the next round's
// findings. Measured across 225 audits in the session transcripts: by round 5,
// 61% of must-fix findings landed within 25 lines of a spot an earlier round had
// already flagged, and that share never fell again — the loop was mostly
// re-opening its own work. Fix loops of 14, 17, 24 and 34 rounds are what that
// cost, at one full vendor call per round.
//
// The follow-up round is scoped with `--since <tree>`, where <tree> came from a
// `--snapshot` taken immediately before the PREVIOUS round's review. Snapshots
// are plain git tree objects written through a temporary index: HEAD, the real
// index, the stash and the working tree are all left alone, which matters
// because this script runs mid-session against uncommitted work by design.
// `git stash create` was the obvious alternative and is wrong here — it does not
// capture untracked files, so a file a fix ROUND created would read as new
// surface in every later round, which is the exact loop being closed.
//
// Output (stdout): ONLY triaged findings, one per line. The /implement-audit
// fix loop parses this stream, so nothing else may appear on it.
//   [must-fix]   <file:line> <issue> — <suggested fix> — <the failure it causes>
//   [should-fix] <target> <issue>
//   [nit]        <issue>
//
// Output (stderr): every diagnostic, progress line, and error — including one
// line per chain slot tried and an `answered: <vendor>/<model>` line naming who
// actually did the review.
//
// Exit:
//   0    Review completed. Zero or more findings on stdout.
//   1    Review did NOT complete — the whole chain was exhausted, or the
//        answering vendor produced empty stdout with no sentinel and no
//        parseable triage line. The caller MUST treat this as "not reviewed"
//        even when partial findings were printed; partial findings are never a
//        pass.
//   2    Caller error (bad arity, unresolvable SHA/tree, base not an ancestor).
//   4    `--since` only: nothing changed since the snapshot, so there is nothing
//        to review and the fix loop has converged. NOT a failure — the caller
//        stops the loop and approves. Distinct from the empty-diff exit 1 below,
//        which means a FULL review was pointed at the wrong tree.
//   5    `--since` only: the fix loop hit the round-4 ceiling, or `--final`
//        already ran once in this loop
//        Also not a failure — the caller stops
//        the loop and reports what is still open. Session-keyed (the
//        worktree stands in when no session id is set); see the ceiling block in
//        the --since branch.
//   3    No independent reviewer: the chain reached a CLAUDE slot, or (on the
//        shipped table) every vendor in the row was unavailable. Contextium:
//        the caller runs the implement-audit-reviewer agent in a FRESH context
//        and records `implement-audit: claude-fallback (fresh context, NOT
//        independent) …` — a completed but weaker review, never a clean
//        independent pass. See below.
//   124  Chain exhausted and the last slot's failure was a timeout. The caller
//        treats it exactly like 1.
//
// FALLBACK IS AUTOMATIC. Before it, a
// primary that was absent, non-zero, or hung ended the review at exit 1/124 with
// no second attempt, so a four-day Codex quota lockout took the gate down
// entirely. The `adversarial-review` row already declared a backup; nothing
// walked it. Now the chain walks itself, and only whole-chain exhaustion fails.
//
// A reviewer that cannot run is still a FAILED review. Never substitute an
// artifact author or an undeclared fallback. Exit 3 means no independent
// reviewer can answer here: an eligible Claude slot (this executor has no Claude
// agent dispatch — that is unavailable here, not evidence that Claude authored
// every artifact), or a row whose DECLARED `"fallback": "fresh-context"` found
// no eligible vendor (Contextium: most installs have a single model CLI). The
// caller then runs a FRESH-CONTEXT review with its own agent and records it as
// `claude-fallback (fresh context, NOT independent)` through validate.ts
// --fallback-review, so a weaker review is never mistaken for an independent
// one; no review at all is worse than a weaker one that says so.
//
// CODE_REVIEW_LOOP_ID is the stable audit-owner id across fresh T3 review
// children; set before snapshots and preserve through every round. It does not
// identify the author. Without it the owner is the session (audit-dedupe.ts
// reviewOwner: the T3 task in T3 Code, the close's thread id elsewhere).
//
// CODEX_BIN / GROK_BIN override the vendor binaries so the failure paths
// (absent, non-zero, hang, empty) are testable against stubs without touching
// real auth or quota. Both are honored by policy-chain.ts; see
// .agents/skills/review/policy-chain.test.ts.
//
// CODEX_REVIEW_TIMEOUT_S is now the PER-SLOT budget, not a total one, and this
// script deliberately does NOT wrap the chain in its own `timeout`: an outer
// wrap becomes a total-chain cap that kills the walk mid-fallthrough, the exact
// behavior the per-slot design removes.
//
// THE SUBJECT CARRIES A BLAST-RADIUS PACK. Between the file list
// and the DIFF sits blast-radius.ts's output: who imports each changed file, what
// it imports, and who calls each symbol the diff actually changed. That is the
// whole-repo context a GitHub-app code reviewer sells, computed here at review
// time instead of read out of an index. It is context and never a verdict — the
// packer fails open, and `--fixture` gets no pack at all because there is no
// working tree to walk. See blastRadiusPack below.
//
// policy-chain.ts holds the CLI invocation shapes. Runs on: /implement-audit
// step-2 (via the agent's tool call), not pre-commit.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";
import { inT3ReviewContext } from "../close/scripts/t3-db.ts";
import {
  type Bucket,
  loopKey,
  parseStrictJson,
  readSpend,
  writeSpend,
} from "../implement-audit/scripts/audit-dedupe.ts";
import {
  policyRunChain,
  reviewAuthorVendors,
  salvageTriageLine,
  spawnCapped,
  type ValidatorResult,
} from "./policy-chain.ts";

const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// `$(...)` drops trailing newlines; every captured read below goes through it.
const chomp = (s: string): string => s.replace(/\n+$/, "");

// A file under $TMPDIR with a random suffix, created empty — `mktemp -t`.
function mktempFile(prefix: string): string {
  for (;;) {
    const p = join(tmpdir(), `${prefix}${randomBytes(4).toString("hex")}`);
    try {
      writeFileSync(p, "", { flag: "wx" });
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

interface Captured {
  status: number;
  stdout: string;
}
// Run git with stdout captured and stderr passed through, as `x=$(git …)` did.
function git(args: string[], opts: { env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): Captured {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "inherit"],
    maxBuffer: 1 << 30,
  });
  return { status: r.status ?? (r.error ? 127 : 128), stdout: r.stdout ?? "" };
}

// A byte count, as `printf '%s' "$x" | wc -c` gave it.
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// Lines of a text as `while IFS= read -r` reads them: a final unterminated
// line is dropped.
function readLines(text: string): string[] {
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

// `sort` / `sort -u` in the caller's locale, as the pipeline ran it.
function sortLines(text: string, unique: boolean): string {
  const r = spawnSync("sort", unique ? ["-u"] : [], { input: text, encoding: "utf8", maxBuffer: 1 << 30 });
  return chomp(r.stdout ?? "");
}

// The audit owner, the counter key (owner AND repo) and what the owner has
// spent live with the review receipt, in the implement-audit skill's
// audit-dedupe.ts: one owner of the state, durable across a reboot, and a
// repeated full review no longer resets it. A row whose code is in other repos
// runs one loop per repo (CODEX_REVIEW_REPO); keyed on the session alone they
// shared one budget, and parallel loops in one session reached "round 5" after
// one follow-up apiece.

// The shell's $PWD: the inherited PWD when it still names the working
// directory (it keeps a symlinked path as typed), else the real one.
function logicalCwd(): string {
  const cwd = process.cwd();
  const pwd = process.env.PWD ?? "";
  try {
    if (pwd !== "" && realpathSync(pwd) === realpathSync(cwd)) return pwd;
  } catch {
    // a PWD that no longer exists is not the working directory
  }
  return cwd;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Every caller names the review's owner and the work's original authors, a
  // scripted one too: evals/caller-contract.eval.ts sets its own loop id and
  // names its fixture's author "human", since no model wrote that diff
  // (Contextium v9.2.0 review).
  const isPiece = argv.length === 4 && argv[2] === "--slice";
  const needsReviewContext =
    argv[0] === "--snapshot" || argv[0] === "--since" || argv[0] === "--fixture" || argv.length === 2 || isPiece;
  if (needsReviewContext && inT3ReviewContext() && !process.env.CODE_REVIEW_LOOP_ID?.trim()) {
    err(
      "Error: CODE_REVIEW_LOOP_ID is required in T3; preserve the audit owner's id across snapshots and review children.",
    );
    exit(2);
  }

  if (needsReviewContext && argv[0] !== "--snapshot") {
    const authors = reviewAuthorVendors();
    if ("error" in authors) {
      err(`policy-chain: ${authors.error}`);
      exit(2);
    }
  }

  // Per-slot wall clock. CODEX_REVIEW_TIMEOUT_S is kept as an alias so every
  // existing caller and runbook keeps working; the MEANING changed from total to
  // per-slot, which is stated in the header above. An explicit
  // POLICY_CHAIN_SLOT_TIMEOUT_S wins — writing the walker's own knob and having it
  // silently overwritten here is the kind of "I set it and nothing happened" that
  // makes a timeout look un-tunable.
  process.env.POLICY_CHAIN_SLOT_TIMEOUT_S =
    process.env.POLICY_CHAIN_SLOT_TIMEOUT_S || process.env.CODEX_REVIEW_TIMEOUT_S || "900";
  const SLOT_TIMEOUT = process.env.POLICY_CHAIN_SLOT_TIMEOUT_S;
  // A diff past this budget is REFUSED, not truncated — reviewing a silent slice
  // of a change while reporting a clean pass is the failure this gate prevents.
  const MAX_DIFF_BYTES = Number(process.env.CODEX_REVIEW_MAX_DIFF_BYTES || "400000");

  // The repo whose SHAs get resolved and diffed. CODEX_REVIEW_REPO points it at
  // a SEPARATE repo — a product with its own checkout — so work living there can
  // still get the independent review the gate exists to provide; without it the
  // only way is to copy the script and patch this line, which quietly becomes
  // "we didn't review it".
  // Resolution order: explicit override, then the CALLER's repo — never the
  // script's own location. The caller's repo is the one under review, because
  // every editing session works inside a linked worktree and invokes this script
  // by absolute path out of the main checkout. Deriving the root from the
  // script's path points the review at the main checkout — a tree the session
  // never touched — which yields findings about untouched files, or an EMPTY
  // diff reported as "reviewed clean (NO_FINDINGS)". A gate that reports a pass
  // on work it never read is worse than no gate. That is also why a cwd outside
  // any repo is a one-line failure and not a fallback to the script's checkout.
  const REPO_ROOT =
    process.env.CODEX_REVIEW_REPO ||
    chomp(
      spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .stdout ?? "",
    );

  // Checked by the modes that read a repo — a full review, --since, --snapshot —
  // and not by --fixture or the usage line, which have no repo to need.
  // Ask git, don't stat for a `.git` DIRECTORY. In a linked worktree `.git` is a
  // FILE holding a gitdir pointer, so the directory test rejected every worktree —
  // and every editing session runs in one, which would make this gate unrunnable
  // for the sessions it exists to review. Still a real check:
  // a non-repo path fails exactly as before.
  function requireRepo(): void {
    if (REPO_ROOT === "") {
      err(`code-review: not inside a git repository (cwd ${logicalCwd()}) and CODEX_REVIEW_REPO is unset`);
      exit(2);
    }
    if (git(["-C", REPO_ROOT, "rev-parse", "--git-dir"], { quiet: true }).status !== 0) {
      err(`Error: CODEX_REVIEW_REPO is not a git repo: ${REPO_ROOT}`);
      exit(2);
    }
  }

  // ── Argument parsing ──────────────────────────────────────────────────

  // A git read that FAILS is not an empty one. Swallowed, a failed diff is "the
  // fix loop converged" (exit 4, an approve) or a review of part of the change
  // reported as the whole. The review did not happen: exit 1, named.
  function gitReadFailed(sub: string, code: number): never {
    err(
      `Error: git ${sub} failed (exit ${code}) — the review did NOT happen; not reading the failure as an empty diff.`,
    );
    exit(1);
  }
  // `x=$(git …) || git_read_failed <sub> $?`
  function gitRead(sub: string, args: string[]): string {
    const r = git(args);
    if (r.status !== 0) gitReadFailed(sub, r.status);
    return chomp(r.stdout);
  }
  // A path listing, run with -z at the call site: NUL-separated records, never
  // trimmed, so a name git would C-quote or one holding a newline arrives as it
  // is on disk.
  function gitPaths(sub: string, args: string[]): string[] {
    const r = git(args);
    if (r.status !== 0) gitReadFailed(sub, r.status);
    return r.stdout.split("\0").filter((p) => p !== "");
  }

  function usage(): void {
    const me = basename(process.argv[1] ?? "code-review.ts");
    err(`Usage: ${me} <base-sha> <head-sha>   full review`);
    err(`       ${me} <base-sha> <head-sha> --slice <file>   one piece of a full review`);
    err(`       ${me} --since <tree>          follow-up round`);
    err(`       ${me} --since <tree> --final  the one review past the ceiling`);
    err(`       ${me} --snapshot              print a tree SHA`);
    err(`       ${me} --fixture <dir>`);
  }

  // Capture the working tree as a git tree object without touching HEAD, the real
  // index, the stash, or any file on disk. Includes untracked-but-not-ignored
  // files, which is the whole reason this is not `git stash create` — see the
  // header. Writes through GIT_INDEX_FILE pointed at a temp path so the session's
  // own staged state survives untouched. Returns the tree, or null when git
  // could not build or write it.
  function snapshotTree(): string | null {
    const idx = mktempFile("code-review-index-");
    rmSync(idx, { force: true });
    try {
      const env = { ...process.env, GIT_INDEX_FILE: idx };
      const run = (args: string[], errTo: "ignore" | "inherit", out: "ignore" | "pipe" = "ignore") =>
        spawnSync("git", args, { cwd: REPO_ROOT, env, encoding: "utf8", stdio: ["ignore", out, errTo] });
      if (run(["read-tree", "HEAD"], "ignore").status !== 0 && run(["read-tree", "--empty"], "inherit").status !== 0) {
        return null;
      }
      // A failed add leaves the temp index at HEAD's tree; writing it anyway
      // would snapshot "no edits" and let `--since` report a false converged.
      if (run(["add", "-A"], "ignore").status !== 0) return null;
      const w = run(["write-tree"], "inherit", "pipe");
      if (w.status !== 0) return null;
      return chomp(w.stdout ?? "");
    } finally {
      rmSync(idx, { force: true });
    }
  }

  // ── The blast-radius pack ─────────────────────────────────────────────
  //
  // The reviewer reads a DIFF, and a diff cannot answer "who calls this?". That is
  // a whole finding class an isolated review structurally cannot produce — a
  // signature moves, the three callers in directories the diff never mentions stay
  // broken, and the review comes back clean. Hosted review apps sell exactly that
  // answer over a persistent whole-repo index; blast-radius.ts computes it per
  // review from the working tree instead, so there is no vendor and no index going
  // stale while the session edits.
  //
  // It is pasted into SUBJECT rather than offered as "read any file you need",
  // because the prompt already says that (see the PROMPT block below) and a
  // reviewer that has to choose to go looking mostly does not.
  //
  // FAIL-OPEN, ALWAYS. A missing packer, a packer that exits 2, a packer that
  // hangs — each costs the review its extra context and nothing else. Unknown
  // callers are not a defect, so a packer failure must never become the reason a
  // real diff went unreviewed.
  //
  // Its byte budget is its own (32KiB, inside blast-radius.ts) and is never taken
  // out of MAX_DIFF_BYTES: a large pack shrinking the DIFF would mean reviewing a
  // truncated slice, which is the failure this whole script exists to prevent.
  //
  // CODE_REVIEW_BLAST_RADIUS names the packer program; it is run with node, as
  // every script of this folder is.
  const BLAST_RADIUS = process.env.CODE_REVIEW_BLAST_RADIUS || `${SCRIPT_DIR}/blast-radius.ts`;

  // Bounded, because "fail open" has to include failing to FINISH. The packer
  // greps the repo once per changed symbol, and a pathological pattern or a
  // gigantic tree could sit there — at which point optional context is blocking
  // the review it was only ever meant to enrich, which is worse than no packer.
  const BLAST_RADIUS_TIMEOUT_S = process.env.CODE_REVIEW_BLAST_RADIUS_TIMEOUT_S || "120";

  function blastRadiusPack(files: string[], diffText: string, oldRef: string): string {
    if (files.length === 0) return "";
    if (!existsSync(BLAST_RADIUS) || !statSync(BLAST_RADIUS).isFile()) {
      err(`[code-review] no blast-radius packer at ${BLAST_RADIUS} — reviewing the diff without caller context`);
      return "";
    }

    const dir = mkdtempSync(join(tmpdir(), "code-review-pack-"));
    let rc: number;
    let pack: string;
    try {
      // NUL-separated, as blast-radius.ts reads --files-file.
      writeFileSync(`${dir}/files`, files.map((p) => `${p}\0`).join(""));
      writeFileSync(`${dir}/diff`, `${diffText}\n`);
      // The bound is policy-chain's spawnCapped, which KILLs a packer that
      // ignores TERM; a packer it stops reads as 124.
      const r = spawnCapped(
        Math.max(1, Math.round(Number(BLAST_RADIUS_TIMEOUT_S) * 1000)) || 120_000,
        process.execPath,
        [
          "--experimental-strip-types",
          // Node 22.6-22.17 warn on type stripping; that line is not the packer's.
          "--disable-warning=ExperimentalWarning",
          BLAST_RADIUS,
          "--repo",
          REPO_ROOT,
          "--files-file",
          `${dir}/files`,
          "--diff-file",
          `${dir}/diff`,
          "--old-ref",
          oldRef,
        ],
        {
          env: { ...process.env, CODEX_REVIEW_REPO: REPO_ROOT },
          encoding: "utf8",
          stdio: ["inherit", "pipe", "pipe"],
          maxBuffer: 1 << 30,
        },
      );
      rc = r.status ?? 124;
      pack = chomp(String(r.stdout ?? ""));
      // Forward the packer's stderr BEFORE the temp dir goes. A parser that fell
      // back to regex, or a grammar that would not load, says so here and nowhere
      // else; dropping it makes a degraded pack indistinguishable from a good one.
      for (const l of readLines(String(r.stderr ?? ""))) err(l);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    if (rc === 124) {
      err(
        `[code-review] the blast-radius packer timed out after ${BLAST_RADIUS_TIMEOUT_S}s — reviewing the diff without caller context`,
      );
      return "";
    }
    if (rc !== 0) {
      err(`[code-review] the blast-radius packer exited ${rc} — reviewing the diff without caller context`);
      return "";
    }
    return pack;
  }

  // Where `--snapshot` records every tree it hands out, so `--since` can refuse a
  // ref it did not issue. Same session-keyed shape as the round counter below;
  // overridable for the fixture tests.
  const SNAP_STATE_DIR = process.env.CODE_REVIEW_SNAP_STATE_DIR || "/tmp/code-review-snapshots";

  // The file this session's snapshots are appended to, or null when no key
  // resolves. Callers MUST treat null as "cannot verify" and fall through, never
  // as "reject".
  function snapLedgerPath(): string | null {
    const key = loopKey(REPO_ROOT);
    return key === "" ? null : `${SNAP_STATE_DIR}/${key}`;
  }

  let MODE = "";

  /** `--since <tree> --final`: the one review past the ceiling. */

  let FINAL = false;
  /** A first full review: marked spent once a vendor has answered it. */
  let FULL_PENDING = false;
  let FIXTURE_DIR = "";
  let BASE_SHA = "";
  let HEAD_SHA = "";
  let PREV_TREE = "";
  /** `--slice <file>`: the piece file naming this piece's paths, NUL-separated. */
  let SLICE_FILE = "";

  if (argv.length === 1 && argv[0] === "--snapshot") {
    requireRepo();
    const snap = snapshotTree();
    if (snap === null) {
      err("Error: could not snapshot the working tree.");
      exit(2);
    }
    // Record it before printing, so a tree the caller can see is always a tree
    // `--since` will accept. Ledger failures are non-fatal: the snapshot is still
    // valid, and refusing to emit one because a /tmp write failed would break the
    // loop this guard exists to protect.
    const ledger = snapLedgerPath();
    if (ledger !== null) {
      try {
        mkdirSync(SNAP_STATE_DIR, { recursive: true });
        appendFileSync(ledger, `${snap}\n`);
      } catch {
        // fail open
      }
    }
    process.stdout.write(`${snap}\n`);
    exit(0);
  } else if (argv.length === 2 && argv[0] === "--fixture") {
    MODE = "fixture";
    FIXTURE_DIR = argv[1] as string;
    if (!existsSync(FIXTURE_DIR) || !statSync(FIXTURE_DIR).isDirectory()) {
      err(`Error: fixture dir not found: ${FIXTURE_DIR}`);
      exit(2);
    }
  } else if ((argv.length === 2 || (argv.length === 3 && argv[2] === "--final")) && argv[0] === "--since") {
    requireRepo();
    MODE = "since";
    PREV_TREE = argv[1] as string;
    FINAL = argv.length === 3;
  } else if (argv.length === 2 || (isPiece && !(argv[0] as string).startsWith("--"))) {
    requireRepo();
    MODE = "range";
    BASE_SHA = argv[0] as string;
    HEAD_SHA = argv[1] as string;
    SLICE_FILE = isPiece ? resolve(argv[3] as string) : "";
  } else {
    usage();
    exit(2);
  }

  // ── Receipt mode ──────────────────────────────────────────────────────
  //
  // With CODE_REVIEW_RESULT_FILE set, the reviewer replies inside one frame —
  // BEGIN_REVIEW_V1, a strict JSON object {findings, coverage}, END_REVIEW_V1 —
  // and this script writes the parsed result there for validate.ts to bind to
  // the reviewed content (.agents/skills/implement-audit/scripts/audit-dedupe.ts). The
  // frame is split and validated BEFORE the finding parser sees anything, and
  // that parser reads only the findings field: a severity marker or the clean
  // sentinel inside the coverage evidence or the narration around the frame is
  // never read as a finding. stdout is unchanged — triage lines only. Without
  // the variable the reply is the plain triage lines it always was, and no
  // receipt can come of it.
  const RESULT_FILE = process.env.CODE_REVIEW_RESULT_FILE || "";
  const RECEIPT = RESULT_FILE !== "";
  let ITEMS: { id: string; text: string }[] = [];
  /** Must-fix/should-fix lines the last receipt left open, shown to a follow-up round. */
  let OPEN_FINDINGS: string[] = [];
  if (RECEIPT && process.env.CODE_REVIEW_COVERAGE_FILE) {
    try {
      const v = JSON.parse(readFileSync(process.env.CODE_REVIEW_COVERAGE_FILE, "utf8")) as {
        items?: unknown;
        openFindings?: unknown;
      };
      if (v.openFindings !== undefined) {
        if (!Array.isArray(v.openFindings) || !v.openFindings.every((x) => typeof x === "string"))
          throw new Error("openFindings must be a list of strings");
        OPEN_FINDINGS = v.openFindings as string[];
      }
      if (!Array.isArray(v.items) || !v.items.every((i) => typeof i?.id === "string" && typeof i?.text === "string"))
        throw new Error("items must be a list of {id, text}");
      ITEMS = v.items as { id: string; text: string }[];
    } catch (e) {
      err(`Error: CODE_REVIEW_COVERAGE_FILE could not be read: ${(e as Error).message}`);
      exit(2);
    }
  }
  const FRAME_MAX = 64 * 1024;
  type Coverage = { id: string; status: "checked" | "unchecked"; evidence: string[] };
  function parseFrame(text: string): { findings: string; coverage: Coverage[] } | { error: string } {
    const lines = text.split("\n");
    const at = (w: string): number[] => lines.flatMap((l, i) => (l.trim() === w ? [i] : []));
    const b = at("BEGIN_REVIEW_V1");
    const e = at("END_REVIEW_V1");
    if (b.length === 0 && e.length === 0) return { error: "no BEGIN_REVIEW_V1 frame" };
    if (b.length !== 1 || e.length !== 1 || (b[0] as number) > (e[0] as number))
      return { error: "the reply needs exactly one BEGIN_REVIEW_V1 … END_REVIEW_V1 frame" };
    const body = lines.slice((b[0] as number) + 1, e[0]).join("\n");
    if (bytes(body) > FRAME_MAX) return { error: `the frame is over ${FRAME_MAX} bytes` };
    let v: unknown;
    try {
      v = parseStrictJson(body);
    } catch (x) {
      return { error: `the frame is not strict JSON: ${(x as Error).message}` };
    }
    const obj = (o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null && !Array.isArray(o);
    if (!obj(v)) return { error: "the frame is not a JSON object" };
    const keys = Object.keys(v).sort().join(",");
    if (keys !== "coverage,findings") return { error: `the frame's keys are ${keys}, not coverage,findings` };
    if (typeof v.findings !== "string" || v.findings.trim() === "") return { error: "findings is empty" };
    // The findings field is the review, so it is held to the review's shape here,
    // inside the chain's shape test: exactly NO_FINDINGS, or only triage lines.
    // Narration in it is an unusable answer, and the chain tries the next slot.
    const findingLines = v.findings.split("\n").filter((l) => l.trim() !== "");
    if (
      !(findingLines.length === 1 && findingLines[0]?.trim() === "NO_FINDINGS") &&
      !findingLines.every((l) => /^\[(?:must-fix|should-fix|nit)\]/.test(l.trim()))
    )
      return { error: "findings is neither NO_FINDINGS nor only triage lines" };
    if (!Array.isArray(v.coverage)) return { error: "coverage is not an array" };
    const want = new Set(ITEMS.map((i) => i.id));
    const seen = new Set<string>();
    for (const c of v.coverage) {
      if (!obj(c) || Object.keys(c).sort().join(",") !== "evidence,id,status")
        return { error: "a coverage entry is not exactly {id, status, evidence}" };
      if (typeof c.id !== "string" || !want.has(c.id))
        return { error: `coverage names an unknown item ${String(c.id)}` };
      if (seen.has(c.id)) return { error: `coverage names ${c.id} twice` };
      seen.add(c.id);
      if (c.status !== "checked" && c.status !== "unchecked")
        return { error: `${c.id}'s status is not checked or unchecked` };
      if (!Array.isArray(c.evidence) || !c.evidence.every((x) => typeof x === "string" && x.length <= 4000))
        return { error: `${c.id}'s evidence is not a list of short strings` };
    }
    const missing = [...want].filter((id) => !seen.has(id));
    if (missing.length > 0) return { error: `coverage omits ${missing.join(", ")}` };
    // Handed on trimmed, so the finding parser reads exactly what the shape
    // test accepted ("NO_FINDINGS " is the sentinel in both).
    return { findings: findingLines.map((l) => l.trim()).join("\n"), coverage: v.coverage as Coverage[] };
  }
  const REPLY_FORMAT = RECEIPT
    ? `REPLY FRAME — this review is recorded as a coverage receipt. Reply with exactly
three parts and nothing else: a line holding only BEGIN_REVIEW_V1, one JSON
object, and a line holding only END_REVIEW_V1:

BEGIN_REVIEW_V1
{"findings": "<the triage lines, joined by \\n, or exactly NO_FINDINGS>", "coverage": [{"id": "<item id>", "status": "checked", "evidence": ["<file:line you read, or the recorded run you inspected>"]}]}
END_REVIEW_V1

"findings" holds the triage lines in the strict format above, or exactly
NO_FINDINGS when you reviewed the code and found nothing — never empty.
"coverage" has one entry per COVERAGE ITEM below, every id exactly once:
"checked" with the evidence you actually read, or "unchecked" with why you
could not check it. Never mark an item checked that you did not read. No other
keys, and no text outside the frame.

COVERAGE ITEMS:
${ITEMS.map((i) => `- ${i.id}: ${i.text}`).join("\n") || "(none declared — return an empty coverage array)"}
`
    : `IF YOU REVIEWED THE CODE AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean review. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED
review rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.
`;

  // ── Build the review subject ──────────────────────────────────────────

  let SUBJECT = "";
  let SUBJECT_LABEL = "";
  let DIRTY_NOTE = "";
  let ROUND_NOTE = "";
  let PIECE_NOTE = "";

  if (MODE === "range") {
    // ── A PIECE ──
    //
    // A change too large for one review call is reviewed as pieces: each one
    // a full review over the same base and head that reads only the paths its
    // piece file lists (NUL-separated, repo-relative), so a name holding a
    // space, a newline or a wildcard stays one path. audit-dedupe.ts keeps the
    // completed pieces and combines a set that read every changed file into
    // one receipt. A list that is unreadable, empty or names a path outside
    // the repo is a caller error before anything else, and spends nothing.
    let PIECE: Set<string> | null = null;
    if (SLICE_FILE !== "") {
      let raw: string;
      try {
        raw = readFileSync(SLICE_FILE, "utf8");
      } catch (e) {
        err(`Error: the piece file ${SLICE_FILE} could not be read: ${(e as Error).message}`);
        exit(2);
      }
      const paths = raw.split("\0").filter((p) => p !== "");
      if (paths.length === 0) {
        err(`Error: the piece file ${SLICE_FILE} names no path (paths are NUL-separated).`);
        exit(2);
      }
      for (const p of paths) {
        const parts = p.split("/");
        if (p.startsWith("/") || parts.includes("..") || parts.includes(".") || parts.includes("")) {
          err(`Error: the piece file names ${JSON.stringify(p)}, which is not a repo-relative path inside the repo.`);
          exit(2);
        }
      }
      PIECE = new Set(paths);
    }
    process.chdir(REPO_ROOT);

    const base = git(["rev-parse", "--verify", `${BASE_SHA}^{commit}`], { quiet: true });
    if (base.status !== 0) {
      err(`Error: cannot resolve base SHA: ${BASE_SHA}`);
      exit(2);
    }
    const head = git(["rev-parse", "--verify", `${HEAD_SHA}^{commit}`], { quiet: true });
    if (head.status !== 0) {
      err(`Error: cannot resolve head SHA: ${HEAD_SHA}`);
      exit(2);
    }
    const baseResolved = chomp(base.stdout);
    const headResolved = chomp(head.stdout);

    // Reviewing a nonsense range is worse than refusing one.
    if (git(["merge-base", "--is-ancestor", baseResolved, headResolved], { quiet: true }).status !== 0) {
      err(`Error: base ${BASE_SHA} is not an ancestor of head ${HEAD_SHA}`);
      exit(2);
    }

    // Uncommitted state is reviewed as-is — /implement-audit runs pre-commit by
    // design — but the reviewer is told, so it never reports on a tree it did not
    // see.
    if (
      git(["diff", "--quiet"], { quiet: true }).status !== 0 ||
      git(["diff", "--cached", "--quiet"], { quiet: true }).status !== 0
    ) {
      DIRTY_NOTE = `NOTE: the working tree has uncommitted changes. The diff below is
the committed range PLUS uncommitted work; you are NOT reviewing a clean tree.`;
    }

    // ── A REPEATED FULL REVIEW IS A ROUND, NOT A NEW LOOP ──
    //
    // A full review used to reset this loop's counter, on the theory that a
    // session reviewing four unrelated changes is four loops. It also meant a
    // full retry of the SAME change bought four more rounds and another final
    // pass, so the ceiling bounded nothing. Now one implementation task is one
    // owner: its first full review is round 1, and any later full review of the
    // same owner and repo spends a round like a `--since` does. A genuinely new
    // change starts in a new owning thread, which has its own counter.
    //
    // The ceiling is checked here, before anything is read; the round itself is
    // spent only after the empty-diff and byte-budget refusals below. A
    // refused review made no call, and refusing it again is deterministic, so
    // spending on it bought nothing — and a misjudged piece would burn one of
    // the four rounds a piece set has. The `--since` branch already refused
    // before it spent.
    const BUCKET: Bucket = process.env.CODE_REVIEW_BUCKET === "qa" ? "qa" : "build";
    let repeatSpend: (() => void) | null = null;
    {
      const spent = readSpend(REPO_ROOT, BUCKET);
      if (spent !== null && "unknown" in spent) {
        err(`Error: ${spent.unknown} — treating this audit's review allowance as spent.`);
        err("Restore the counter, or get the user's authorization to exceed the allowance; never reset it.");
        exit(5);
      }
      if (spent !== null && (spent.full || spent.rounds > 0)) {
        const round = spent.rounds + 2;
        if (round > 4) {
          err(`Error: a repeated full review would be round ${round}; the fix loop's ceiling is 4.`);
          err("A full review does not start a new loop for the same change. Review the fixes made");
          err("since the last round with --since <tree> --final (once per loop), then report what is still open.");
          if (PIECE) err("A piece set fits in four pieces; the files no piece has read stay unreviewed.");
          exit(5);
        }
        repeatSpend = () => {
          writeSpend(REPO_ROOT, BUCKET, { ...spent, rounds: spent.rounds + 1 });
          err(`[code-review] a repeated full review — round ${round} of at most 4`);
        };
      } else {
        FULL_PENDING = spent !== null;
      }
    }

    // A piece lists its renames' two names separately, so its name reads keep
    // a rename as two paths, as audit-dedupe.ts counts what changed.
    const renames = PIECE ? ["--no-renames"] : [];
    const allChanged = gitPaths("diff", ["diff", "-z", ...renames, "--name-only", baseResolved, headResolved]);
    const allTracked = gitPaths("diff", ["diff", "-z", ...renames, "--name-only", "HEAD"]);

    // `git diff HEAD` shows only files git already TRACKS, so a file the session
    // created and has not staged is invisible to it. That is a false GREEN, not a
    // gap in coverage: a brand-new script goes through a round-1 review unread
    // and the review still reports clean. The --since
    // path never had this hole (its snapshot writes untracked files into a temp
    // index), so this is the two-arg form catching up. --exclude-standard keeps
    // build output and other gitignored noise out.
    const allUntracked = gitPaths("ls-files", ["ls-files", "-z", "--others", "--exclude-standard"]);
    // A piece keeps the changed paths its file names, compared as exact strings.
    const inPiece = (p: string): boolean => PIECE === null || PIECE.has(p);
    const changedFiles = allChanged.filter(inPiece);
    const trackedFiles = allTracked.filter(inPiece);
    const untrackedList = allUntracked.filter(inPiece);
    const workingFiles = [...trackedFiles, ...untrackedList];
    // Each kept path as a LITERAL pathspec, so `*`, `?`, `[x]` or a leading
    // `:` in a name selects that file alone. A piece whose read holds no path
    // skips the read: `git diff` with no pathspec would read everything.
    const only = (paths: string[]): string[] | null =>
      PIECE === null ? [] : paths.length === 0 ? null : ["--", ...paths.map((p) => `:(literal)${p}`)];

    // Each read is checked on its own: a failed one would drop that part of the
    // change and review the rest as if whole.
    const committedSpec = only(changedFiles);
    const workingSpec = only(trackedFiles);
    const committedDiff =
      committedSpec === null ? "" : gitRead("diff", ["diff", ...renames, baseResolved, headResolved, ...committedSpec]);
    const workingDiff = workingSpec === null ? "" : gitRead("diff", ["diff", ...renames, "HEAD", ...workingSpec]);
    let untrackedDiff = "";
    for (const u of untrackedList) {
      // --no-index against /dev/null renders a whole untracked file as an
      // addition; it exits 1 on any difference, which is the normal case here.
      const one = git(["diff", "--no-index", "--", "/dev/null", u]);
      if (one.status > 1) gitReadFailed("diff", one.status);
      untrackedDiff += `${chomp(one.stdout)}\n`;
    }
    // Trailing newlines dropped, so three empty reads are an empty diff.
    const diffBody = chomp(`${committedDiff}\n${workingDiff}\n${untrackedDiff}`);

    const diffBytes = bytes(diffBody);
    // Backstop for the wrong-tree class above. There is no such thing as a clean
    // review of nothing: an empty diff means the range or the repo is wrong, and
    // reporting NO_FINDINGS on it hands the caller a passing gate for work that was
    // never read. Refuse loudly instead — the caller treats exit 1 as "not
    // reviewed", which is the truth.
    if (diffBytes === 0) {
      err(`Error: the ${PIECE ? "piece's " : ""}diff is empty — nothing was reviewed.`);
      err(`  repo:  ${REPO_ROOT}`);
      err(`  range: ${baseResolved.slice(0, 8)}..${headResolved.slice(0, 8)} (plus uncommitted)`);
      if (PIECE) err(`  piece: ${SLICE_FILE} names no path this range or the working tree changed`);
      err("This usually means the resolved repo is not the tree holding the work");
      err("(a session worktree invoking the script from the main checkout), or the");
      err("SHA range is wrong. Set CODEX_REVIEW_REPO or fix the range and re-run.");
      exit(1);
    }
    if (diffBytes > MAX_DIFF_BYTES) {
      err(`Error: ${PIECE ? "the piece's " : ""}diff is ${diffBytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget.`);
      err("Refusing rather than reviewing a truncated slice. Review it as pieces by file over");
      err("this one base and head (--slice <file>, at most four), or raise");
      err("CODEX_REVIEW_MAX_DIFF_BYTES deliberately. Nothing was spent.");
      exit(1);
    }
    repeatSpend?.();

    // What the reviewer is told about the rest of the change: the changed
    // paths outside this piece, which other pieces read.
    if (PIECE) {
      const read = new Set([...changedFiles, ...workingFiles]);
      const others = [...new Set([...allChanged, ...allTracked, ...allUntracked])].filter((p) => !read.has(p));
      PIECE_NOTE = `THIS IS ONE PIECE OF A LARGER REVIEW (${basename(SLICE_FILE)}): ${read.size} of the
changed files, over the same base and head as the other pieces. ${others.length} other changed file(s)
are reviewed in other pieces; their diff is not below. Read them in the repo for
context whenever a finding depends on them — a caller outside this piece that a
change inside it breaks is a finding in this piece.`;
    }

    SUBJECT_LABEL = `diff ${baseResolved.slice(0, 8)}..${headResolved.slice(0, 8)}${PIECE ? ` (piece ${basename(SLICE_FILE)})` : ""}`;
    // The pack's file list is the UNION of both lists above — the same bytes the
    // reviewer is about to read, so the pack can never cite a file the diff did
    // not show it.
    const packFiles = [...new Set([...changedFiles, ...workingFiles])].sort();
    const packSpec = only(packFiles.filter((p) => !untrackedList.includes(p)));

    // …but the DIFF it gets is not the one above. `diffBody` concatenates two
    // diffs with two different bases (base..head, then HEAD..working-tree), so for
    // a file touched in both, the committed hunks' new-side line numbers index the
    // HEAD version while the packer parses the WORKING TREE — and an export added
    // after the base and then deleted in the working tree exists in neither side
    // it can reach. Both make the pack name the wrong symbol with full confidence.
    //
    // One diff, one pair of endpoints: base on the old side, the working tree on
    // the new side. `git diff <base>` is exactly that for tracked files, and the
    // untracked walk supplies the rest. Now every new-side line number indexes the
    // bytes the packer reads, and `--old-ref $baseResolved` is precisely the tree
    // the `-` lines came from.
    // The pack fails open, so a failed read here does not stop the review — but
    // it is said: a pack built on part of the diff names fewer callers than it
    // should, and "no callers found" must not read as a fact.
    // (`git diff` exits non-zero only on an error; `--no-index` exits 1 for "the
    // files differ", which is the normal case, and 2 or more on an error.)
    let packRc = 0;
    let packDiff = "";
    if (packSpec !== null) {
      const pd = git(["diff", ...renames, baseResolved, ...packSpec], { quiet: true });
      if (pd.status !== 0) packRc = pd.status;
      packDiff = chomp(pd.stdout);
    }
    for (const u of untrackedList) {
      const one = git(["diff", "--no-index", "--", "/dev/null", u], { quiet: true });
      if (one.status > 1) packRc = one.status;
      packDiff += `\n${chomp(one.stdout)}`;
    }
    if (packRc !== 0) {
      err(
        `[code-review] the blast-radius diff could not be read (git exit ${packRc}) — the caller context in this review is incomplete`,
      );
    }
    const blastPack = blastRadiusPack(packFiles, packDiff, baseResolved);
    SUBJECT = `CHANGED FILES (committed range):
${changedFiles.join("\n") || "(none)"}

CHANGED FILES (uncommitted, vs HEAD):
${workingFiles.join("\n") || "(none)"}
${blastPack ? `\n${blastPack}` : ""}

DIFF:
${diffBody}`;
  } else if (MODE === "since") {
    process.chdir(REPO_ROOT);

    if (git(["rev-parse", "--verify", `${PREV_TREE}^{tree}`], { quiet: true }).status !== 0) {
      err(`Error: --since needs a tree written by --snapshot; cannot resolve: ${PREV_TREE}`);
      exit(2);
    }

    // Resolving to a tree is NOT enough, and the gap is not theoretical: EVERY
    // commit resolves to a tree, so a commit sha — the thing a caller reaches for
    // by mistake — passes the check above and gets reviewed as if it were a
    // snapshot, producing confident findings about files the session never
    // touched, because the diff spans other sessions' commits on main.
    //
    // T3 requires a stable audit-owner key and an issued snapshot for this repo.
    // With no owner at all (an ambiguous T3 context) it falls through. An
    // existing ledger missing this tree is always a rejection.
    const ledger = snapLedgerPath();
    if (process.env.CODE_REVIEW_LOOP_ID && (ledger === null || !existsSync(ledger))) {
      err(
        `Error: --since was given a ref this audit's --snapshot never issued: ${PREV_TREE} (no snapshot ledger for this repo)`,
      );
      exit(2);
    }
    if (ledger !== null && existsSync(ledger) && statSync(ledger).isFile()) {
      let issued: string[] = [];
      try {
        issued = readFileSync(ledger, "utf8").split("\n");
      } catch {
        issued = [];
      }
      if (!issued.includes(PREV_TREE)) {
        err(`Error: --since was given a ref this session's --snapshot never issued: ${PREV_TREE}`);
        err("A commit sha resolves to a tree and will pass the resolve check above, so it");
        err("would silently review everything between that commit and now — including other");
        err("sessions' work. Pass the tree printed by the --snapshot taken just before the");
        err("PREVIOUS round. Snapshots issued this session:");
        for (const s of readLines(readFileSync(ledger, "utf8"))) err(`  ${s}`);
        exit(2);
      }
    }

    const nowTree = snapshotTree();
    if (nowTree === null) {
      err("Error: could not snapshot the working tree for the follow-up round.");
      exit(2);
    }

    const changedFiles = gitPaths("diff", ["diff", "-z", "--name-only", PREV_TREE, nowTree]);
    const diffBody = gitRead("diff", ["diff", PREV_TREE, nowTree]);

    // Converged. Nothing was edited between the last review and this one, so there
    // is no new surface and another vendor call would re-read settled code — the
    // precise waste this mode exists to stop. Exit 4 says "stop the loop and
    // approve", which is a different claim from the exit 1 below.
    if (diffBody === "") {
      err("[code-review] nothing changed since the last round — the fix loop has converged.");
      exit(4);
    }

    const diffBytes = bytes(diffBody);
    if (diffBytes > MAX_DIFF_BYTES) {
      err(`Error: follow-up diff is ${diffBytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget.`);
      err("Refusing rather than reviewing a truncated slice.");
      exit(1);
    }

    // ── The round-4 ceiling, enforced here rather than only in the skill ──
    //
    // A review fix loop ends at 4 rounds. Leaving
    // that to the skill's prose alone is what the 34-round audit did: the
    // instruction existed, the loop ran anyway, and nothing could observe it until
    // the vendor calls were already spent. Round 1 is the two-arg full review, so
    // the Nth `--since` call is round N+1 and the 4th one is round 5 — refused.
    //
    // Keyed on `loopKey`: the session id (or the worktree when a harness sets
    // none, so the cap holds on every harness) and the repo under review.
    //
    // It counts rounds within ONE owner's fix loop on one repo. Nothing resets
    // it: not a repeated full review (see the two-arg branch), not a new
    // executor child, not a content, scope or base change.
    // Spending lives with the receipt (audit-dedupe.ts): durable per owner and
    // repo, in the build bucket or, for /qa's edits, the qa bucket.
    const BUCKET: Bucket = process.env.CODE_REVIEW_BUCKET === "qa" ? "qa" : "build";
    const spent = readSpend(REPO_ROOT, BUCKET);
    if (spent !== null && "unknown" in spent) {
      err(`Error: ${spent.unknown} — treating this audit's review allowance as spent.`);
      err("Restore the counter, or get the user's authorization to exceed the allowance; never reset it.");
      exit(5);
    }
    if (spent !== null) {
      const prior = spent.rounds;
      const round = prior + 2;
      // ── One final review past the ceiling ──
      // The ceiling stops the CHURN, but without this round 4's own fixes ship
      // with no review at all, or the loop stalls on them. `--final` reviews
      // exactly those fixes, once per
      // loop; its findings are fixed and reported, never another round.
      if (FINAL) {
        if (round <= 4) {
          err(
            `Error: --final is the one review past the round-4 ceiling, and this loop is at round ${round} — a normal round is the call.`,
          );
          exit(2);
        }
        if (spent.final) {
          err("Error: the final review already ran in this fix loop. Stop: fix what it found, then report");
          err("what is still open in the implement-audit: trailer and the summary.");
          exit(5);
        }
        writeSpend(REPO_ROOT, BUCKET, { ...spent, final: true });
        err("[code-review] final review past the round-4 ceiling — the loop ends after it");
      } else if (round > 4) {
        err(
          "Error: the fix loop has reached the round-4 ceiling — a fifth round mostly re-opens ground earlier rounds already touched.",
        );
        err(`Refusing round ${round}. Stop the loop: fix any held nits, then report`);
        err("what is still open in the implement-audit: trailer and the summary.");
        err("Past round 4 the majority of findings re-open ground an earlier round");
        err("already touched — measured across 225 audits — so another");
        err("vendor call buys churn, not coverage. The fixes made since the last round");
        err("still get one review: --since <tree> --final, once per loop.");
        exit(5);
      } else {
        writeSpend(REPO_ROOT, BUCKET, { ...spent, rounds: prior + 1 });
        err(`[code-review] round ${round} of at most 4`);
      }
    }

    SUBJECT_LABEL = `fixes since ${PREV_TREE.slice(0, 8)}`;
    // The reviewer is told what it is looking at. Without this it reads a diff of
    // fixes as if it were fresh feature code, reports that the surrounding
    // function is missing context it cannot see, and the round produces findings
    // about code that was already dispositioned.
    ROUND_NOTE = `THIS IS A FOLLOW-UP ROUND, NOT A FULL REVIEW. The diff below is
ONLY the changes made since the previous review round — that is, the FIXES
applied in response to earlier findings, plus any work done alongside them.
Earlier rounds already reviewed the rest of the change; do NOT re-report
findings they settled.

Review these fixes for two things specifically:
  1. Does each fix actually close the defect it was meant to close?
  2. Did the fix introduce a NEW defect — an inverted condition, a mirror-image
     bug at the opposite boundary, a broken caller, a contract it no longer
     honors?

Unchanged code is in scope only where these fixes change what it relies on:
when a fix moves a signature, a contract or a behavior, read the unchanged
callers, entry points and instructions that depend on it, and report the one
that now breaks. Do not hunt for something to say about the rest of the file,
and do not reopen settled findings these fixes do not touch.

If the fixes are correct, report no findings (NO_FINDINGS).`;
    if (RECEIPT && OPEN_FINDINGS.length > 0) {
      ROUND_NOTE = `${ROUND_NOTE}

EARLIER FINDINGS STILL OPEN. The last review reported these and no review has
seen them closed. For each, judge whether the fixes below close it; re-report
it (as written, or updated) if they do not. One you do not re-report is
recorded as closed by these fixes.
${OPEN_FINDINGS.map((f) => `  ${f}`).join("\n")}`;
    }
    if (FINAL) {
      ROUND_NOTE = `THIS IS THE FINAL REVIEW of this fix loop: the round-4 ceiling has been
reached and no further round will run. Report only real defects in these
fixes — anything you report is fixed and closed without another review.

${ROUND_NOTE}`;
    }

    // A follow-up round packs ONLY this round's files. Re-packing the original
    // diff's files would put the settled code back in front of the reviewer that
    // `--since` exists to keep out — the 34-round failure described at the top of
    // this file, arriving by a different door.
    const blastPack = blastRadiusPack(changedFiles, diffBody, PREV_TREE);
    SUBJECT = `CHANGED FILES (since the last review round):
${changedFiles.join("\n") || "(none)"}
${blastPack ? `\n${blastPack}` : ""}

DIFF:
${diffBody}`;
  } else {
    SUBJECT_LABEL = `fixture ${FIXTURE_DIR}`;
    const found = spawnSync("find", [FIXTURE_DIR, "-type", "f"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 1 << 30,
    });
    const fixtureFiles = sortLines(found.stdout ?? "", false);
    if (fixtureFiles === "") {
      err(`Error: fixture dir is empty: ${FIXTURE_DIR}`);
      exit(2);
    }
    let fixtureBody = "";
    for (const f of fixtureFiles.split("\n")) {
      let body = "";
      try {
        body = chomp(readFileSync(f, "utf8"));
      } catch (e) {
        err(`cat: ${f}: ${(e as Error).message}`);
      }
      fixtureBody = `${fixtureBody}
--- FILE: ${f} ---
${body}
`;
    }
    SUBJECT = `FILES UNDER REVIEW:
${fixtureBody}`;
  }

  // ── Companion worktrees ───────────────────────────────────────────────
  //
  // A change that spans repos is reviewed one repo at a time, and the reviewer
  // reads the OTHER repo for context. Left to itself it reads the landed
  // checkout, which does not carry this change yet, and a round is lost to
  // findings about code the session's worktree has already changed.
  // CODEX_REVIEW_COMPANIONS lists those worktrees, comma-separated; each must be
  // a git checkout or the review is refused, since a wrong path would send the
  // reviewer to the same stale tree with false confidence.
  let COMPANION_NOTE = "";
  const companions = (process.env.CODEX_REVIEW_COMPANIONS ?? "")
    .split(/[,\n]/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
  if (companions.length > 0) {
    const lines: string[] = [];
    for (const c of companions) {
      const top = git(["-C", c, "rev-parse", "--show-toplevel"], { quiet: true });
      if (top.status !== 0) {
        err(`Error: CODEX_REVIEW_COMPANIONS names ${c}, which is not a git checkout`);
        exit(2);
      }
      const branch = chomp(git(["-C", c, "rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).stdout ?? "");
      lines.push(`- ${chomp(top.stdout ?? "")} (branch ${branch || "unknown"})`);
    }
    COMPANION_NOTE = `
COMPANION WORKTREES — this change spans more than one repo. The diff below is
from ${REPO_ROOT}. Its other half lives in these worktrees; when you need a
file from one of those repos, read it from the worktree listed here, not from
the landed checkout, which does not carry this change yet. Keep every finding
about the diff under review.
${lines.join("\n")}
`;
  }

  // ── Prompt ────────────────────────────────────────────────────────────

  const PROMPT = `You are an adversarial reviewer of freshly-written code in a small repo where
every caller is the owner's own code. You are reviewing CODE, not a SPEC. Assume things were missed and
find them. Do not confirm the work is good; find what is wrong. You have
read access to the repo — read any file you need for context before judging.

The conventions you must hold the code to: behaviour enumerated at 0 / 1 /
empty / max / error inputs; a fix to a shared mechanism lands in every
instance; no enforcement for a failure that has not happened; a bad fetch
keeps the last good value rather than overwriting it; outcomes are validated
for correctness, not just presence; one writer per stored data product;
external data is validated at every boundary; shell scripts run under
\`set -euo pipefail\`; and the simplest mechanism that works wins.

CRITICAL FRAMING — this code runs where every caller is the owner's own code. Defense-in-depth findings (per-caller credentials, allowlists,
retry primitives, isolation layers) MUST be weighed against the simplest
mechanism that works, and nothing is built for a failure mode that has not
occurred. If a finding adds a control surface against an unenumerated threat,
downgrade it to [nit] or omit it. Defense-in-depth is over-engineering until a
real threat is named.

Attack across these dimensions:

1. Correctness — logic errors, off-by-one, wrong operator, inverted condition.
2. Boundary cases — behavior at 0 / 1 / empty / max / error inputs.
3. Error handling — swallowed errors, empty catch, silent degradation, a
   failure path that reports success.
4. Integration — do imports resolve, do callers/callees still agree, does data
   survive the boundaries it crosses.
5. Peer/sibling consistency — does a sibling file do this same thing
   differently, and is one of them now wrong?
6. Class-fix atomicity — if this fixes a shared mechanism, did every peer get
   fixed, or was one quietly left behind?
7. Contract drift — does the code do what its own header/SPEC/comment claims?
8. Entry points and unchanged assumptions — find what reaches the changed
   code (its callers, CLI wiring, the skill step or hook that runs it) and the
   unchanged files whose assumptions it relies on. Read them. A caller the diff
   never touched that now breaks is a finding in this diff.
9. Claims against failure — for each important behavior the change claims,
   name the concrete input that would make it fail, and check that a test or a
   recorded run actually exercises that input and fails without the change. A
   passing suite that never reaches the failure is not evidence; say so.

Required: every [must-fix] finding MUST name the concrete failure it causes
(the wrong output, the lost data, the crash, the silent skip). A finding that
names no failure cannot be must-fix.

OUTPUT CAP: at most 8 findings, ranked by severity. If you have more than 8,
the top 8 displace the rest.

OUTPUT FORMAT — STRICT. Each finding MUST appear on its own line with the
literal bracket prefix at the very start of the line. No markdown bold (no
\`**[must-fix]**\`). No alternate prefixes (no \`must-fix:\`, no \`-- must-fix --\`).
The caller parses by line-anchored match; deviations are silently dropped.

  [must-fix]   <file:line>: <issue> — <suggested fix> — <the failure it causes>
  [should-fix] <file-or-target>: <issue>
  [nit]        <issue>

${REPLY_FORMAT}

REVIEW SUBJECT: ${SUBJECT_LABEL}
${DIRTY_NOTE}${COMPANION_NOTE}
${ROUND_NOTE}${PIECE_NOTE}

${SUBJECT}`;

  // ── Invoke ────────────────────────────────────────────────────────────

  const RAW_OUT = mktempFile("code-review-out-");
  const PROMPT_FILE = mktempFile("code-review-prompt-");
  try {
    // The prompt reaches the chain walker as a FILE and is piped on stdin, never
    // placed on argv. The diff is embedded in it, so passing it as an argument dies
    // with "Argument list too long" (exit 126) on exactly the large changes that
    // most need reviewing — a 26-file, ~2,700-line commit once could not be reviewed
    // at all.
    writeFileSync(PROMPT_FILE, `${PROMPT}\n`);

    err(`[code-review] reviewing ${SUBJECT_LABEL} (per-slot timeout ${SLOT_TIMEOUT}s)`);

    // ── Dispatch, parse, and ONE re-ask ───────────────────────────────────
    //
    // A vendor that answers with only progress narration ("I'll review the full
    // diff...Reading the changed implementations.") has spent the review without
    // delivering one. That is not chain exhaustion — the walk already stopped,
    // because from the chain's side the slot succeeded — so the fall-through cannot
    // help, and the caller gets a FAILED review for work the vendor was willing to
    // do. Observed three times in one session, twice in a row.
    //
    // So: one re-ask, same slot, naming what was missing. ONLY for the
    // answered-but-unusable case — a non-zero RC is a genuinely exhausted chain and
    // stays terminal below, because re-asking a chain that has no live slot left
    // just spends the timeout twice.
    // Deliberately vendor-agnostic ("a previous attempt", not "your previous
    // attempt"): the re-ask re-walks the WHOLE chain rather than pinning the slot
    // that narrated, so the vendor reading this may not be the one that produced the
    // narration. Re-walking is the right default anyway — any slot returning a real
    // review is a valid independent review, and a dead primary re-fails in seconds —
    // but it does mean the text must not accuse its reader of something it may not
    // have done, which would be a confusing instruction to act on.
    const REASK_PREAMBLE = `A previous attempt at this review returned only progress
narration and no review output. Do the review and reply with ONLY ${
      RECEIPT
        ? "the frame the format below specifies"
        : "the triage\nlines the format below specifies (or the bare word NO_FINDINGS if the diff is\nclean)"
    }. No preamble, no narration, no announcement of what you are about to do.

`;

    // ── Parse ─────────────────────────────────────────────────────────────
    //
    // stdout carries triage lines only. Anything else is echoed to stderr rather
    // than dropped silently, so an unparseable review is diagnosable.
    const MARKERS = ["[must-fix]", "[should-fix]", "[nit]"];
    const startsWithMarker = (l: string) => MARKERS.some((m) => l.startsWith(m));
    function parseReviewOutput(): { findings: string; count: number; sentinel: boolean; coverage: Coverage[] } {
      let findings = "";
      let count = 0;
      let sentinel = false;
      let text = readFileSync(RAW_OUT, "utf8");
      let coverage: Coverage[] = [];
      if (RECEIPT) {
        const f = parseFrame(text);
        if ("error" in f) {
          err(`[code-review] unusable framed reply: ${f.error}`);
          return { findings, count, sentinel, coverage };
        }
        text = `${f.findings}\n`;
        coverage = f.coverage;
      }
      for (const raw of readLines(text)) {
        // Salvage a marker an agent CLI glued onto its own progress narration with no
        // newline between them (salvageTriageLine in policy-chain.ts owns the rule and
        // its reasons). Strict line-anchoring once discarded grok's entire review and
        // the caller read that as a dead vendor — a false "chain exhausted" that cost a
        // session while grok was answering correctly the whole time. The
        // contract still ASKS for line-anchored output; this only stops a real finding
        // from being thrown away when a vendor scuffs the prefix.
        const { line, salvaged } = salvageTriageLine(raw, MARKERS, "NO_FINDINGS");
        if (salvaged === "marker") err("[code-review] salvaged a triage marker from a prefixed line");
        if (salvaged === "sentinel") err("[code-review] salvaged the NO_FINDINGS sentinel from a prefixed line");
        if (startsWithMarker(line)) {
          findings += `${line}\n`;
          count += 1;
        } else if (line === "NO_FINDINGS") {
          sentinel = true;
        } else if (line !== "") {
          err(`[code-review] dropped non-triage line: ${line}`);
        }
      }
      return { findings, count, sentinel, coverage };
    }

    // Code review is read-only repo investigation, so scope grok to the read-only
    // ALLOWLIST rather than a denylist. Under the denylist the run was
    // CANCELLED the moment the model reaches for the shell, and the gate reported a
    // healthy vendor as exhausted. Verified: same prompt, denylist ->
    // stopReason "cancelled", 0 findings; allowlist -> end_turn, 9 turns, 8 findings.
    // Complementary to the narration re-ask below: the allowlist removes the cause,
    // the re-ask covers a vendor that narrates for any other reason.
    process.env.POLICY_CHAIN_GROK_TOOLS = "read_file,list_dir,grep";

    // The chain's shape test: is this output a REVIEW at all? Deliberately the
    // cheapest question that separates a review from prose — one triage marker, or
    // the clean-pass sentinel. `parseReviewOutput` still does the full parse
    // afterwards, including its salvage rules; this is only the gate that decides
    // whether the slot answered.
    //
    // It exists because the full parse used to run OUTSIDE the walk. A vendor that
    // replied "Sure, I can help you review that" was banked as the answer, the
    // backup was never tried, and the gate reported the whole chain exhausted while
    // a healthy vendor sat untried behind it.
    //
    // The salvage cases are matched WITHOUT the line anchor for the same reason
    // parseReviewOutput salvages them: grok routinely glues its marker onto the
    // end of a narration line, and anchoring here would reject a review the parser
    // would have accepted — a stricter gate than the parser it feeds, which turns
    // good answers into chain burn.
    const looksLikeAReview = (file: string): ValidatorResult => {
      const text = readFileSync(file, "utf8");
      if (RECEIPT) {
        const f = parseFrame(text);
        return "error" in f ? { rc: 1, stderr: `[code-review] ${f.error}` } : { rc: 0, stderr: "" };
      }
      return { rc: /\[(must-fix|should-fix|nit)\]|NO_FINDINGS/.test(text) ? 0 : 1, stderr: "" };
    };

    // A first full review is spent once a vendor has answered it, so a full
    // retry of the same change is a round (see the two-arg branch). A chain that
    // never answered spent nothing.
    const spendFull = (): void => {
      if (!FULL_PENDING) return;
      FULL_PENDING = false;
      const bucket: Bucket = process.env.CODE_REVIEW_BUCKET === "qa" ? "qa" : "build";
      const s = readSpend(REPO_ROOT, bucket);
      if (s !== null && !("unknown" in s)) writeSpend(REPO_ROOT, bucket, { ...s, full: true });
    };
    // The parsed result, for validate.ts to bind to the content it reviewed. A
    // result that cannot be written is a review that cannot be counted.
    const writeResult = (lines: string, coverage: Coverage[], attempt: number): void => {
      if (!RECEIPT) return;
      try {
        writeFileSync(
          RESULT_FILE,
          `${JSON.stringify({
            vendor: `${process.env.POLICY_CHAIN_VENDOR || "unknown"}/${process.env.POLICY_CHAIN_MODEL || "unknown"}`,
            attempt,
            findings: readLines(lines),
            coverage,
          })}\n`,
        );
      } catch (e) {
        err(`Error: the review result could not be recorded at ${RESULT_FILE}: ${(e as Error).message}`);
        exit(1);
      }
    };

    for (const attempt of [1, 2]) {
      if (attempt === 2) {
        err("[code-review] the chain answered with narration only — re-asking once");
        writeFileSync(PROMPT_FILE, `${REASK_PREAMBLE}${PROMPT}\n`);
      }

      // The shape test is passed per call: policyRunChain drops any validator on
      // return, so one gate's contract cannot bleed onto another's answer.
      const RC = policyRunChain("adversarial-review", PROMPT_FILE, { out: RAW_OUT, validator: looksLikeAReview });
      if (RC === 0 || RC === 125) spendFull();

      // 125: every vendor was alive and answered, and none produced a review. That
      // is exactly what the re-ask below is for, so spend it — and ONLY here. A
      // plain exhaustion (1) means there is nobody left to ask, and re-walking a
      // dead chain would double the outage's cost for no chance of an answer.
      if (RC === 125) {
        if (attempt === 1) continue;
        err("Error: no vendor in the chain produced a parseable review, on two attempts.");
        err("Treating as a FAILED review, not a clean pass.");
        exit(1);
      }

      if (RC === 2) {
        err("Error: the review could not be dispatched (see above). Review did NOT run.");
        exit(2);
      }

      if (RC === 3) {
        err("[code-review] no independent reviewer answered the 'adversarial-review' row.");
        err("Run the implement-audit-reviewer agent (.agents/agents/implement-audit-reviewer.md)");
        err("in a FRESH context on this diff, and record it as");
        err("  implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); …");
        err("(validate.ts --fallback-review <file> records it against the review receipt).");
        err("It is a completed but weaker review — never an independent pass, and never");
        err("an artifact author substituted for the chain. Install codex or grok for an");
        err("independent one.");
        exit(3);
      }

      if (RC === 124) {
        err(`Error: every vendor in the chain timed out at ${SLOT_TIMEOUT}s per slot. Review did NOT complete.`);
        exit(124);
      }

      if (RC !== 0) {
        err("Error: the 'adversarial-review' chain is exhausted. Review did NOT complete.");
        exit(1);
      }

      const { findings, count, sentinel, coverage } = parseReviewOutput();
      const vendor = process.env.POLICY_CHAIN_VENDOR || "unknown";

      if (count > 0) {
        writeResult(findings, coverage, attempt);
        process.stdout.write(findings);
        if (sentinel) err("[code-review] both findings and NO_FINDINGS present; findings win.");
        const via = attempt === 2 ? " (on the re-ask)" : "";
        err(`[code-review] complete — ${count} finding(s) from ${vendor}${via}.`);
        exit(0);
      }

      if (sentinel) {
        writeResult("", coverage, attempt);
        err(`[code-review] complete — reviewed clean (NO_FINDINGS) by ${vendor}.`);
        exit(0);
      }
    }

    // Empty stdout with no sentinel, TWICE. This is the highest-severity failure the
    // contract guards: without the sentinel it is byte-identical to a clean review,
    // so treating it as a pass ships unreviewed code carrying the gate's assurance.
    // It is NOT chain fallthrough — a vendor answered; what it said was unusable —
    // so the walk has already stopped and this verdict is the caller's to make.
    err(
      `Error: ${process.env.POLICY_CHAIN_VENDOR || "the reviewer"} produced no parseable findings and no NO_FINDINGS sentinel, on two attempts.`,
    );
    err("Treating as a FAILED review, not a clean pass.");
    exit(1);
  } finally {
    rmSync(RAW_OUT, { force: true });
    rmSync(PROMPT_FILE, { force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
