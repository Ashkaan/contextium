#!/usr/bin/env -S node --experimental-strip-types
// code-review.ts — Adversarial code review of a diff, on whichever vendor the
// policy's `adversarial-review` row selects.
//
// The diff-side mirror of spec-audit.ts. One model writes nearly all the code in
// a workbench (Claude, usually), so a reviewer of that model is not independent
// in the sense the assignment policy asks for; this script puts the review on a
// different vendor by construction. WHICH vendor is not decided here — it is
// read from the policy table (policy.json beside this script) via
// .agents/skills/review/policy-chain.ts, which also skips the vendor recorded
// as the author in .agents/harness.
// Renamed from an old vendor-named filename: that name was a pin, and a filename
// naming a vendor is a promise the table cannot keep.
//
// Usage:
//   code-review.ts <base-sha> <head-sha>      full review (round 1)
//   code-review.ts --since <tree>             follow-up round: ONLY what changed
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
//   5    `--since` only: the fix loop hit the round-4 ceiling
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
// What that does NOT relax: this script never reviews with the author's model
// itself. Contextium's one exception to the source is the exit-3 path: when no
// independent vendor can answer, the caller runs a FRESH-CONTEXT review with its
// own agent and records it as `claude-fallback (fresh context, NOT
// independent)`, so a weaker review is never mistaken for an independent one.
// Most installs have a single model CLI; no review at all is worse than a weaker
// one that says so.
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
import { createHash, randomBytes } from "node:crypto";
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
import { policyRunChain, type ValidatorResult } from "./policy-chain.ts";

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

// `grep -v '^[[:space:]]*$'` over newline-joined parts, then `$(...)`.
function dropBlankLines(text: string): string {
  return chomp(
    text
      .split("\n")
      .filter((l) => !/^[ \t\n\v\f\r]*$/.test(l))
      .join("\n"),
  );
}

// `sort` / `sort -u` in the caller's locale, as the pipeline ran it.
function sortLines(text: string, unique: boolean): string {
  const r = spawnSync("sort", unique ? ["-u"] : [], { input: text, encoding: "utf8", maxBuffer: 1 << 30 });
  return chomp(r.stdout ?? "");
}

// The key the snapshot ledger and the round counter are filed under, with every
// character outside [A-Za-z0-9_-] replaced. The session id when the harness
// exports one; otherwise one is derived from the worktree's own git dir — every
// session works in its own worktree, so the worktree IS the session — rather
// than leaving the ledger and the round cap unenforced on a harness that sets no
// id. "" only when no repo resolves at all.
function sessionKey(repoRoot: string): string {
  let sid = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (sid === "" && repoRoot !== "") {
    const gd = spawnSync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dir = gd.status === 0 ? chomp(gd.stdout ?? "") : "";
    if (dir !== "") sid = `wt-${createHash("sha1").update(dir).digest("hex").slice(0, 12)}`;
  }
  return sid.replace(/[^A-Za-z0-9_-]/g, "_");
}

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

  function usage(): void {
    const me = basename(process.argv[1] ?? "code-review.ts");
    err(`Usage: ${me} <base-sha> <head-sha>   full review`);
    err(`       ${me} --since <tree>          follow-up round`);
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

  function blastRadiusPack(files: string, diffText: string, oldRef: string): string {
    if (files === "") return "";
    if (!existsSync(BLAST_RADIUS) || !statSync(BLAST_RADIUS).isFile()) {
      err(`[code-review] no blast-radius packer at ${BLAST_RADIUS} — reviewing the diff without caller context`);
      return "";
    }

    const dir = mkdtempSync(join(tmpdir(), "code-review-pack-"));
    let rc: number;
    let pack: string;
    try {
      writeFileSync(`${dir}/files`, `${files}\n`);
      writeFileSync(`${dir}/diff`, `${diffText}\n`);
      // The bound is spawnSync's own clock, not coreutils `timeout`, which a
      // stock macOS does not ship; a packer killed by it reads as 124.
      const r = spawnSync(
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
          timeout: Math.max(1, Math.round(Number(BLAST_RADIUS_TIMEOUT_S) * 1000)) || 120_000,
          killSignal: "SIGTERM",
        },
      );
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      rc = timedOut ? 124 : (r.status ?? 124);
      pack = chomp(r.stdout ?? "");
      // Forward the packer's stderr BEFORE the temp dir goes. A parser that fell
      // back to regex, or a grammar that would not load, says so here and nowhere
      // else; dropping it makes a degraded pack indistinguishable from a good one.
      for (const l of readLines(r.stderr ?? "")) err(l);
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
    const key = sessionKey(REPO_ROOT);
    return key === "" ? null : `${SNAP_STATE_DIR}/${key}`;
  }

  let MODE = "";
  let FIXTURE_DIR = "";
  let BASE_SHA = "";
  let HEAD_SHA = "";
  let PREV_TREE = "";

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
  } else if (argv.length === 2 && argv[0] === "--since") {
    requireRepo();
    MODE = "since";
    PREV_TREE = argv[1] as string;
  } else if (argv.length === 2) {
    requireRepo();
    MODE = "range";
    BASE_SHA = argv[0] as string;
    HEAD_SHA = argv[1] as string;
  } else {
    usage();
    exit(2);
  }

  // ── Build the review subject ──────────────────────────────────────────

  let SUBJECT = "";
  let SUBJECT_LABEL = "";
  let DIRTY_NOTE = "";
  let ROUND_NOTE = "";

  if (MODE === "range") {
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

    // ── A FULL REVIEW STARTS A NEW FIX LOOP, so the round counter resets ──
    //
    // The counter below used to be keyed on the session id alone and only ever
    // climbed, which measured the SESSION rather than the loop.
    // The cap is about one change's fix loop re-reading its
    // own fixes; a session that reviews four unrelated changes is four loops, and
    // the evidence behind the cap — 61% of round-5 findings re-opening earlier
    // ground — is about repeated passes over the SAME diff.
    //
    // Keyed on the session alone, a session that shipped four separate fixes saw
    // its fourth change's FIRST follow-up refused as "round 5 of at most 4" — the
    // cap stopping coverage on whatever came last instead of stopping churn.
    //
    // Reset here rather than expiring the counter on a timer, because "a new full
    // review" is exactly the event that means a new loop — no clock has to guess.
    const resetDir = process.env.CODE_REVIEW_ROUND_STATE_DIR || "/tmp/code-review-rounds";
    const resetKey = sessionKey(REPO_ROOT);
    if (resetKey !== "") {
      try {
        mkdirSync(resetDir, { recursive: true });
      } catch {
        // fail open
      }
      try {
        rmSync(`${resetDir}/${resetKey}`, { force: true });
      } catch {
        // fail open
      }
    }

    const changedFiles = gitRead("diff", ["diff", "--name-only", baseResolved, headResolved]);
    let workingFiles = gitRead("diff", ["diff", "--name-only", "HEAD"]);

    // `git diff HEAD` shows only files git already TRACKS, so a file the session
    // created and has not staged is invisible to it. That is a false GREEN, not a
    // gap in coverage: a brand-new script goes through a round-1 review unread
    // and the review still reports clean. The --since
    // path never had this hole (its snapshot writes untracked files into a temp
    // index), so this is the two-arg form catching up. --exclude-standard keeps
    // build output and other gitignored noise out.
    const untracked = gitRead("ls-files", ["ls-files", "--others", "--exclude-standard"]);
    if (untracked !== "") {
      workingFiles = dropBlankLines(`${workingFiles}\n${untracked}`);
    }
    const untrackedList = untracked.split("\n").filter((u) => u !== "");

    // Each read is checked on its own: a failed one would drop that part of the
    // change and review the rest as if whole.
    const committedDiff = gitRead("diff", ["diff", baseResolved, headResolved]);
    const workingDiff = gitRead("diff", ["diff", "HEAD"]);
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
      err("Error: the diff is empty — nothing was reviewed.");
      err(`  repo:  ${REPO_ROOT}`);
      err(`  range: ${baseResolved.slice(0, 8)}..${headResolved.slice(0, 8)} (plus uncommitted)`);
      err("This usually means the resolved repo is not the tree holding the work");
      err("(a session worktree invoking the script from the main checkout), or the");
      err("SHA range is wrong. Set CODEX_REVIEW_REPO or fix the range and re-run.");
      exit(1);
    }
    if (diffBytes > MAX_DIFF_BYTES) {
      err(`Error: diff is ${diffBytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget.`);
      err("Refusing rather than reviewing a truncated slice. Split the range or");
      err("raise CODEX_REVIEW_MAX_DIFF_BYTES deliberately.");
      exit(1);
    }

    SUBJECT_LABEL = `diff ${baseResolved.slice(0, 8)}..${headResolved.slice(0, 8)}`;
    // The pack's file list is the UNION of both lists above — the same bytes the
    // reviewer is about to read, so the pack can never cite a file the diff did
    // not show it.
    const packFiles = sortLines(`${dropBlankLines(`${changedFiles}\n${workingFiles}`)}\n`, true);

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
    const pd = git(["diff", baseResolved], { quiet: true });
    if (pd.status !== 0) packRc = pd.status;
    let packDiff = chomp(pd.stdout);
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
${changedFiles || "(none)"}

CHANGED FILES (uncommitted, vs HEAD):
${workingFiles || "(none)"}
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
    // With no ledger yet for this key (no --snapshot taken) it falls through. A
    // ledger that exists but lacks this tree IS a rejection — that is the whole
    // check.
    const ledger = snapLedgerPath();
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

    const changedFiles = gitRead("diff", ["diff", "--name-only", PREV_TREE, nowTree]);
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
    // Keyed on sessionKey: the session id, or the worktree when a harness sets
    // none — so the cap holds on every harness.
    //
    // It counts rounds within ONE fix loop, not within the session. The two-arg
    // branch above clears it, because a full review IS the start of a loop — see
    // the reset there for what keying it on the session alone cost.
    const ROUND_STATE_DIR = process.env.CODE_REVIEW_ROUND_STATE_DIR || "/tmp/code-review-rounds";
    const key = sessionKey(REPO_ROOT);
    if (key !== "") {
      mkdirSync(ROUND_STATE_DIR, { recursive: true });
      const counter = `${ROUND_STATE_DIR}/${key}`;
      let prior = 0;
      if (existsSync(counter) && statSync(counter).isFile()) {
        let raw = "0";
        try {
          raw = chomp(readFileSync(counter, "utf8"));
        } catch {
          raw = "0";
        }
        prior = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
      }
      const round = prior + 2;
      if (round > 4) {
        err(
          "Error: the fix loop has reached the round-4 ceiling — a fifth round mostly re-opens ground earlier rounds already touched.",
        );
        err(`Refusing round ${round}. Stop the loop: fix any held nits, then report`);
        err("what is still open in the implement-audit: trailer and the summary.");
        err("Past round 4 the majority of findings re-open ground an earlier round");
        err("already touched — measured across 225 audits — so another");
        err("vendor call buys churn, not coverage.");
        exit(5);
      }
      writeFileSync(counter, `${prior + 1}\n`);
      err(`[code-review] round ${round} of at most 4`);
    }

    SUBJECT_LABEL = `fixes since ${PREV_TREE.slice(0, 8)}`;
    // The reviewer is told what it is looking at. Without this it reads a diff of
    // fixes as if it were fresh feature code, reports that the surrounding
    // function is missing context it cannot see, and the round produces findings
    // about code that was already dispositioned.
    ROUND_NOTE = `THIS IS A FOLLOW-UP ROUND, NOT A FULL REVIEW. The diff below is
ONLY the changes made since the previous review round — that is, the FIXES
applied in response to earlier findings, plus any work done alongside them.
Earlier rounds already reviewed the rest of the change and their findings are
dispositioned; do NOT re-report them.

Review these fixes for two things specifically:
  1. Does each fix actually close the defect it was meant to close?
  2. Did the fix introduce a NEW defect — an inverted condition, a mirror-image
     bug at the opposite boundary, a broken caller, a contract it no longer
     honors?

If the fixes are correct, emit NO_FINDINGS. Do not hunt for something to say
about the surrounding file: code outside this diff is out of scope for this
round.`;

    // A follow-up round packs ONLY this round's files. Re-packing the original
    // diff's files would put the settled code back in front of the reviewer that
    // `--since` exists to keep out — the 34-round failure described at the top of
    // this file, arriving by a different door.
    const blastPack = blastRadiusPack(changedFiles, diffBody, PREV_TREE);
    SUBJECT = `CHANGED FILES (since the last review round):
${changedFiles || "(none)"}
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

IF YOU REVIEWED THE CODE AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean review. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED
review rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.

REVIEW SUBJECT: ${SUBJECT_LABEL}
${DIRTY_NOTE}
${ROUND_NOTE}

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
narration and no review output. Do the review and reply with ONLY the triage
lines the format below specifies (or the bare word NO_FINDINGS if the diff is
clean). No preamble, no narration, no announcement of what you are about to do.

`;

    // ── Parse ─────────────────────────────────────────────────────────────
    //
    // stdout carries triage lines only. Anything else is echoed to stderr rather
    // than dropped silently, so an unparseable review is diagnosable.
    const MARKERS = ["[must-fix]", "[should-fix]", "[nit]"];
    const startsWithMarker = (l: string) => MARKERS.some((m) => l.startsWith(m));
    function parseReviewOutput(): { findings: string; count: number; sentinel: boolean } {
      let findings = "";
      let count = 0;
      let sentinel = false;
      for (let line of readLines(readFileSync(RAW_OUT, "utf8"))) {
        // Salvage a marker an agent CLI glued onto its own progress narration with no
        // newline between them. Grok does this on every call ("Reading the engine
        // paths...[must-fix] engine.ts:1: ..."), so strict line-anchoring silently
        // discarded its entire review and the caller read that as a dead vendor — a
        // false "chain exhausted" that cost a session while grok was answering
        // correctly the whole time. The contract still ASKS for line-anchored
        // output; this only stops a real finding from being thrown away when a vendor
        // scuffs the prefix. Ordered marker-first so a findings line that merely
        // mentions the sentinel is not misread as a clean review.
        if (startsWithMarker(line)) {
          // already anchored
        } else if (MARKERS.some((m) => line.includes(m))) {
          err("[code-review] salvaged a triage marker from a prefixed line");
          // Cut at the LEFTMOST marker on the line. A "strip non-bracket prefix"
          // cannot do this: narration containing any earlier "[" would stop the
          // strip short and the finding would still drop. Leftmost rather than
          // highest-severity: when a vendor glues two findings onto one line, the
          // first one is the one whose text follows, so picking by severity would
          // keep the wrong marker for that text.
          let best = "";
          let bestAt = 0;
          for (const mk of MARKERS) {
            const at = line.indexOf(mk);
            if (at < 0) continue;
            if (best === "" || at < bestAt) {
              best = mk;
              bestAt = at;
            }
          }
          if (best !== "") line = line.slice(line.indexOf(best));
        } else if (line === "NO_FINDINGS") {
          // the sentinel
        } else if (line.includes("NO_FINDINGS")) {
          err("[code-review] salvaged the NO_FINDINGS sentinel from a prefixed line");
          line = "NO_FINDINGS";
        }
        if (startsWithMarker(line)) {
          findings += `${line}\n`;
          count += 1;
        } else if (line === "NO_FINDINGS") {
          sentinel = true;
        } else if (line !== "") {
          err(`[code-review] dropped non-triage line: ${line}`);
        }
      }
      return { findings, count, sentinel };
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
    const looksLikeAReview = (file: string): ValidatorResult => ({
      rc: /\[(must-fix|should-fix|nit)\]|NO_FINDINGS/.test(readFileSync(file, "utf8")) ? 0 : 1,
      stderr: "",
    });

    for (const attempt of [1, 2]) {
      if (attempt === 2) {
        err("[code-review] the chain answered with narration only — re-asking once");
        writeFileSync(PROMPT_FILE, `${REASK_PREAMBLE}${PROMPT}\n`);
      }

      // The shape test is passed per call: policyRunChain drops any validator on
      // return, so one gate's contract cannot bleed onto another's answer.
      const RC = policyRunChain("adversarial-review", PROMPT_FILE, { out: RAW_OUT, validator: looksLikeAReview });

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
        err("It is a completed but weaker review — never an independent pass. Install");
        err("codex or grok for an independent one.");
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

      const { findings, count, sentinel } = parseReviewOutput();
      const vendor = process.env.POLICY_CHAIN_VENDOR || "unknown";

      if (count > 0) {
        process.stdout.write(findings);
        if (sentinel) err("[code-review] both findings and NO_FINDINGS present; findings win.");
        const via = attempt === 2 ? " (on the re-ask)" : "";
        err(`[code-review] complete — ${count} finding(s) from ${vendor}${via}.`);
        exit(0);
      }

      if (sentinel) {
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
