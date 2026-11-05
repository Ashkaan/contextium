#!/usr/bin/env -S node --experimental-strip-types
// land.ts — put everything this thread wrote on its repo's trunk, and prove it.
//
// The thread owns one worktree per repo it touched (see write-root.sh): its
// workbench worktree, which holds the code, the records and the skills
// together, plus a satellite for each product repo it wrote to.
// This walks that ledger and, for each one: commits, merges the trunk into it,
// pushes it AS that repo's trunk, records the merge SHA, checks that the push
// started a deploy, and removes the worktree. Then it re-fetches every repo and
// checks three things before it will say the session is safe to close.
//
// THE MERGE HAPPENS IN THE WORKTREE, not in the shared checkout. Merging in the
// shared tree puts a conflict in the copy every other session and every
// automation is using, and that tree's index may already be dirty with somebody
// else's work. Here a conflict stays inside this thread's own worktree, where
// re-running the close resumes on it.
//
// THE LAST LINE IS EARNED, NOT ASSERTED. The report ends on a line saying the
// session is safe to close, and the only way a line like that means anything is
// if a script prints it after checking. So it exists nowhere else: the skill copies what
// this prints. The three checks are run against a FRESHLY FETCHED trunk
// because the interesting failures (a push that raced, a journal name another
// thread took) are all invisible against a stale ref.
//
// WHAT REPLACED WHAT. This is one script where there were six: close-attest.sh
// wrote marker files, close-sha.sh recorded a SHA for them, a `closed-by:`
// trailer went on the commit and a script checked it before each commit. Three
// moving parts to prove what one ancestry check proves — and a commit-hook
// checker never runs in a repo whose hooks path points elsewhere.
//
// TYPESCRIPT, ported line for line from land.sh. Every sibling it runs is a
// `.ts` run with `node --experimental-strip-types`, except write-root.sh, which
// stays bash because it runs `git worktree add`, and lock.sh, whose per-repo
// lock this takes through a bash child (see takeLock). Where the
// bash read a command's output through `$(…)`, the port strips trailing
// newlines the same way. Where it merged stderr into stdout (`2>&1`) the port
// reads stdout alone and keeps stderr for the refusal: a Node child prints
// ExperimentalWarning on stderr, which bash's children never did — and every
// Node child is started with that warning disabled (NODE_TS), so on Node 22.x
// it never reaches a checker's refusal.
//
// Usage:
//   land.ts "<commit subject>"   — land, check, then emit the final report
//   land.ts --check              — the checks only; land nothing
//   land.ts --verbose            — also print each repo's SHA
//   land.ts --gate               — `fired` / `not-fired`, for the auto-close gate
//   land.ts "<subject>" --hold   — land and wait for the deploy, then stop
//                                  before the report: the live checks run now
//   land.ts --release            — the checks again, every owed live check
//                                  proved on what is live, then the held report
//   land.ts --live-start <spec>/<id>                    — an evidence check:
//                                  record what is live before the capture
//   land.ts --live-pass <spec>/<id> <file> --saw "<…>"  — record the capture,
//                                  refused if what is live moved since the start
//
// WHAT IT DOES THAT THE MODEL WOULD OTHERWISE HAVE TO REMEMBER. It
// refuses a thread with no journal entry or with no verify pass on the content
// it is about to land; sets a finished spec's row `done` before its gates;
// quotes the changed specs' audit lines in the journal entry; prints the
// harness-link lines in the report; and saves the report block in the
// thread's state (`report`) before it marks the close closed.
//
// THE HOLD. A close that changed something live can only be checked live after
// its push deploys, and without a hold that means after the last line: what
// the live checks found has nowhere to go but a question below it. Held, the
// landing does everything but write the closed marker and print the report;
// the live checks run with the session still open, a fix lands with --hold
// again, a question is asked and the session stops; --release re-proves every
// landing against a fresh trunk and prints the report under the FIRST held
// subject, then the line.
//
// WHEN TO HOLD IS THIS SCRIPT'S. A spec declares its
// live checks in a `live-checks` block of its tasks.md (the form is
// live-checks.ts's). Before the push that writes such a spec `complete`, the
// checks are written to `live-owed`, each bound to the commit its target's repo
// lands; after the deploy the landing holds whether or not --hold was passed.
// --release runs every command check itself, accepts an evidence check only
// from a --live-pass record taken on the deployment live now, and reads each
// target again after the checks: until all of that passes it is NOT CLOSED
// and the hold stays. A landing without --hold while held is refused, and no
// time ends a hold. Left to the model, the hold was entered when it chose, the
// release read no live result, and an ordinary landing cleared it.
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts.
//   LAND_PUSH_RETRIES, LAND_PUSH_SLEEP — 3 and 5s. The test suite shortens the
//                                        sleep; nothing in production sets them.
//   LAND_LIVE_CHECK_TIMEOUT — 120 (seconds a command check may run). The suite
//                                        shortens it.
//   LAND_GH — the gh binary the push check looks for (default `gh`); the
//                                        suite points it at a stand-in, or at
//                                        nothing to test a machine without one.
//   LIVE_CHECKS_TEST_SOURCES — live-checks.ts's seam; the suite's stubbed
//                                        live answers.
//
// THE CHECKS run before each commit, from the ledger worktree that holds
// `.agents/checks/` (the workbench's): decision records, integration manifests
// (when that checker exists), script tests, skill manifests, secrets and
// standards citations — and, in the workbench worktree, its own
// check-roadmap-decisions.ts over the projects it changes.
//
// THE PUSH CHECK waits, for every repo and every push, on everything GitHub
// reports on the pushed commit — workflow runs, hosted builds, a deployer's
// commit status — through await-push-checks.ts, which asks with the `gh` CLI.
// A repo whose origin is not on GitHub, or a machine without `gh`, closes
// saying so (pollDeploy).
//
// peers:
//   .agents/skills/close/scripts/tests/land-cases.ts  (the suite; each of the eight
//                                             land*.test.ts files runs a range)
//   .agents/skills/close/scripts/verify.ts       (its --stamped, before the first commit:
//                                         verify passed on the content landing now)
//   .agents/skills/close/scripts/spec-state.ts, roadmap.ts (a finished spec's row set done)
//   .agents/skills/close/scripts/roadmap-merge.ts   (ROADMAP.md merges row by row)
//   .agents/skills/close/scripts/check-roadmap-decisions.ts (run before each commit;
//                                         refuses a row or report left open)
//   .agents/skills/close/scripts/write-root.sh   (writes the ledger)
//   .agents/skills/close/scripts/await-push-checks.ts (run per landed repo: its push's checks)
//   .agents/skills/close/scripts/live-checks.ts  (the live-checks form, and what is live)
//   .agents/skills/close/scripts/lock.sh         (the per-repo lock)
//   .agents/checks/check-decision-records.ts     (run before each commit)
//   .agents/checks/check-integration-manifest.ts (run before each commit, when present)
//   .agents/checks/check-scripts.ts              (run before each commit)
//   .agents/checks/check-skills.ts               (run before each commit, from the
//                                                 worktree that holds it)
//   .agents/checks/check-secrets.ts              (run before each commit, when present)
//   .agents/checks/check-standards-refs.ts       (run before each commit, when present)
//   .agents/checks/check-harness-config-links.ts (run after each landing, from the
//                                                 shared checkout; `--fix` on drift,
//                                                 never refuses)
//
// Exit: 0 landed and checked (the line on stdout) · 2 no thread · 3 NOT CLOSED
//       · 4 landed and held (no line until --release)

import { type ChildProcess, type SpawnSyncOptions, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Exit, exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { importerClosure, sharedUnit } from "./importers.ts";
import {
  contains,
  githubRepoOf as readGithubRepo,
  liveRevision,
  parseLiveChecks,
  type Revision,
  sourceRepo,
  targetParts,
} from "./live-checks.ts";
import { listRows } from "./roadmap.ts";
import { reportClaimsComplete } from "./spec-state.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const THREAD = `${SCRIPT_DIR}/thread.ts`;
const WRITE_ROOT = `${SCRIPT_DIR}/write-root.sh`;
const LOCK_SH = `${SCRIPT_DIR}/lock.sh`;
const TRUNK_TS = `${SCRIPT_DIR}/trunk.ts`;
const NEXT_COMMAND = `${SCRIPT_DIR}/next-implement-command.ts`;
const PROJECT_STATUS = `${SCRIPT_DIR}/project-status.ts`;
const PUSH_CHECKS = `${SCRIPT_DIR}/await-push-checks.ts`;
const VERIFY = `${SCRIPT_DIR}/verify.ts`;
const AUDIT = `${SCRIPT_DIR}/../../implement-audit/scripts/audit-dedupe.ts`;
const SPEC_STATE = `${SCRIPT_DIR}/spec-state.ts`;
const ROADMAP_TS = `${SCRIPT_DIR}/roadmap.ts`;

// ── Process helpers ────────────────────────────────────────────────────────

type Run = { ok: boolean; status: number; stdout: string; stderr: string };

/** What `$(…)` keeps of a command's output: everything but trailing newlines. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

/**
 * Run a command. `out`/`err` say where its stdout and stderr go, as the bash
 * redirections did: "pipe" captures (a `$(…)`), "ignore" is `/dev/null`,
 * "inherit" is the terminal the close prints to. stdin is always inherited.
 */
function run(
  cmd: string,
  args: string[],
  opt: {
    cwd?: string;
    out?: "pipe" | "ignore" | "inherit";
    err?: "pipe" | "ignore" | "inherit" | number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Run {
  const o: SpawnSyncOptions = {
    cwd: opt.cwd,
    env: opt.env ?? process.env,
    encoding: "utf8",
    stdio: ["inherit", opt.out ?? "pipe", opt.err ?? "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  };
  const r = spawnSync(cmd, args, o);
  const status = r.status ?? (r.error ? 127 : 1);
  return { ok: status === 0 && !r.error, status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

/**
 * How every Node child starts. Node 22.x prints an ExperimentalWarning for type
 * stripping, and a MODULE_TYPELESS_PACKAGE_JSON warning for a `.ts` outside a
 * `"type": "module"` package, on stderr; both are switched off, because a
 * checker's stderr is its refusal. `--disable-warning` is Node 20.11+/21.3+.
 */
const NODE_TS = [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
];

/** Run a sibling TypeScript program the way every caller spells it. */
function nodeArgs(script: string, args: string[]): string[] {
  return [...NODE_TS, script, ...args];
}

/** `git -C <dir> …`, stderr to /dev/null unless told otherwise. */
function git(
  dir: string,
  args: string[],
  opt: { out?: "pipe" | "ignore" | "inherit"; err?: "pipe" | "ignore" | "inherit" } = {},
): Run {
  return run("git", ["-C", dir, ...args], { out: opt.out ?? "pipe", err: opt.err ?? "ignore" });
}

/** `$(cmd || echo X)`: what the command printed, then X when it failed. */
function orEcho(r: Run, fallback: string): string {
  return chomp(r.ok ? r.stdout : `${r.stdout}${fallback}\n`);
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

/** `[ -s file ]`: exists and is not empty. */
function nonEmpty(p: string): boolean {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * The lines `while read -r` visits: every newline-terminated line. A last
 * fragment with no newline is skipped, exactly as bash's `read` skips it.
 */
function readLines(text: string): string[] {
  return text.split("\n").slice(0, -1);
}

/** `IFS=$'\t' read -r a b c`: tab-separated fields, the last taking the rest. */
function tabFields(line: string, n: number): string[] {
  let rest = line.replace(/^\t+/, "").replace(/\t+$/, "");
  const out: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const m = /\t+/.exec(rest);
    if (!m) {
      out.push(rest);
      rest = "";
      continue;
    }
    out.push(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
  }
  out.push(rest);
  return out;
}

/** `head -n 1 file`, without its newline. */
function firstLine(p: string): string {
  return readFileSync(p, "utf8").split("\n")[0] ?? "";
}

/** The last non-empty line of a child's stderr, or <fallback>: its refusal, past any warning. */
function lastLine(text: string, fallback: string): string {
  const ls = chomp(text)
    .split("\n")
    .filter((l) => l !== "");
  return ls[ls.length - 1] ?? fallback;
}

// THE TEST SEAM for an interrupted state write. `LAND_TEST_KILL_AT=<point>:<n>`
// kills this process with SIGKILL the n-th time it reaches <point>, the one
// way a suite can land a kill between two writes of one file. Unset, as in
// every real run, it does nothing.
let killSeen = 0;
function killPoint(name: string): void {
  const at = process.env.LAND_TEST_KILL_AT;
  if (!at) return;
  const [point, n = "1"] = at.split(":");
  if (point !== name) return;
  killSeen += 1;
  if (killSeen === Number(n)) process.kill(process.pid, "SIGKILL");
}

/**
 * Replace a state file in one step: the text goes to a temp file beside it,
 * which is renamed over it. A kill at any point leaves the old file or the new
 * one, never a truncated or half-rewritten one. `seam` names the kill point
 * between the two, for the suite.
 */
function writeAtomic(p: string, text: string, seam = ""): void {
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  if (seam) killPoint(seam);
  renameSync(tmp, p);
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}

// ── The harness home links, on every close ─────────────────────────────────
//
// The home links that point each harness home (~/.claude/agents,
// ~/.agents/skills, …) into the workbench's shared checkout. A check that only
// reports into a log nobody reads lets them dangle unnoticed: a second install
// that repoints them at a temporary tree leaves the safety hooks and reviewer
// agents gone while every report says so.
//
// So every landing runs the check, and on drift runs its `--fix`, which parks
// whatever stood at a link at <path>.pre-link before relinking — nothing is
// lost, and the line naming that file is how the session gets to inspect it.
// It NEVER refuses: drift is host state, not this thread's diff, and a close
// that could not land over it would only strand the work. A missing or
// crashing check is a warning for the same reason. A clean check prints
// nothing, the way an already-current shared checkout does.
//
// The copy that runs is the SHARED checkout's — the trunk checkout this close
// has just advanced and the tree the links point into — resolved from the
// ledger, so a thread opened on any repo finds it. Run in that checkout,
// because the check names the main checkout by `git rev-parse` from where it
// stands. The lines it prints (`fixed: <link> -> <target>`, `kept the displaced
// file at <path>`, `Error: …`) are check-harness-config-links.ts's.
//
// Each line it emits is kept in the thread's state (`harness-links`) and
// printed in the final report under **Harness links:** — on a held landing
// too, whose report only --release prints, when nothing runs the check again.
const HL_CHECK_REL = ".agents/checks/check-harness-config-links.ts";

function harnessLinks(ledgerLines: string[], emit: (line: string) => void): void {
  try {
    const shared = [...new Set(ledgerLines.map((l) => tabFields(l, 3)[1] ?? "").filter((s) => s !== ""))];
    const home = shared.find((s) => isFile(`${s}/${HL_CHECK_REL}`));
    if (!home) {
      emit(`  harness-links: WARNING not checked — no checkout this thread landed holds ${HL_CHECK_REL}`);
      return;
    }
    const check = `${home}/${HL_CHECK_REL}`;
    const opt = {
      cwd: home,
      env: { ...process.env, PWD: home },
      out: "pipe" as const,
      err: "pipe" as const,
    };
    if (run(process.execPath, nodeArgs(check, []), opt).ok) return;

    const fix = run(process.execPath, nodeArgs(check, ["--fix"]), opt);
    const H = process.env.HOME ?? "";
    const tilde = (p: string): string => (H && p.startsWith(`${H}/`) ? `~${p.slice(H.length)}` : p);
    const kept: string[] = [];
    for (const l of chomp(fix.stdout).split("\n")) {
      const f = /^fixed: (.+?) -> (.+)$/.exec(l);
      if (f) emit(`  harness-links: relinked ${tilde(f[1] ?? "")} -> ${f[2] ?? ""}`);
      const k = /^kept the displaced file at (.+)$/.exec(l);
      if (k) kept.push(k[1] ?? "");
    }
    for (const p of kept) emit(`  harness-links: the file that stood there is kept at ${p} — inspect it`);
    if (fix.ok) return;
    const errLines = chomp(fix.stderr)
      .split("\n")
      .filter((l) => l.trim() !== "");
    // The check's own refusal ends with its `Relink with:` footer; anything
    // else that exits non-zero is the program failing, not a finding.
    if (fix.stderr.includes("Relink with: ")) {
      for (const e of errLines.filter((l) => l.startsWith("Error: ")))
        emit(`  harness-links: NOT FIXED — ${e.slice("Error: ".length)}`);
      emit(`  harness-links: details: node --experimental-strip-types ${check}`);
      return;
    }
    // A crash's stderr ends with a stack and `Node.js v…`; its error line is the news.
    const why = [...errLines].reverse().find((l) => /^[A-Za-z]*Error\b/.test(l)) ?? lastLine(fix.stderr, "no message");
    emit(`  harness-links: WARNING the check failed (exit ${fix.status}): ${why} — links not checked`);
  } catch (e) {
    if (e instanceof Exit) throw e;
    emit(`  harness-links: WARNING the check could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Work not landed (the auto-close gate's test) ─────────────────────────
//
// Is anything in this thread's ledger worktrees not on its trunk? `--gate`
// asks it after a close, and so does the end-of-turn check
// (.agents/skills/close/scripts/end-of-turn.ts), which imports it rather than copying
// it. `clean`: every
// worktree that still exists has an empty `git status` and nothing ahead of
// `origin/<trunk>`. `unlanded`: one has something in it or ahead. `unreadable`:
// a git read failed or a trunk did not resolve, and nothing was found
// unlanded — so `unlanded` wins whatever the order. A worktree a landing
// already removed is skipped. `--gate` fires on anything but `clean`; the
// end-of-turn check refuses only on `unlanded`.
export type LandedState = "clean" | "unlanded" | "unreadable";
export function unlandedWork(ledgerFile: string): LandedState {
  let unreadable = false;
  for (const line of readLines(readFileSync(ledgerFile, "utf8"))) {
    const [WT = ""] = tabFields(line, 3);
    if (!WT || !isDir(WT)) continue;
    const st = git(WT, ["status", "--porcelain"]);
    if (!st.ok) {
      unreadable = true;
      continue;
    }
    if (chomp(st.stdout) !== "") return "unlanded";
    // Resolved inline: an unresolvable trunk, or a count git fails to read, is
    // a repo the test cannot vouch for. (Read as `$(… || echo 0)`, a failed
    // count would be zero and the gate would answer `fired`.)
    const gt = chomp(run(process.execPath, nodeArgs(TRUNK_TS, [WT])).stdout);
    if (!gt) {
      unreadable = true;
      continue;
    }
    const ahead = git(WT, ["rev-list", "--count", `origin/${gt}..HEAD`]);
    if (!ahead.ok) {
      unreadable = true;
      continue;
    }
    if (chomp(ahead.stdout) !== "0") return "unlanded";
  }
  return unreadable ? "unreadable" : "clean";
}

// NOT CLOSED is the one phrase the skill looks for, so every refusal uses it and
// nothing else prints it.
function notClosed(msg: string): never {
  say(`NOT CLOSED: ${msg}`);
  return exit(3);
}

function die(msg: string): never {
  warn(`land: ${msg}`);
  return exit(2);
}

async function main(): Promise<void> {
  const PUSH_RETRIES = process.env.LAND_PUSH_RETRIES || "3";
  const PUSH_SLEEP = process.env.LAND_PUSH_SLEEP || "5";

  let MODE = "land";
  let VERBOSE = 0;
  let HOLD = false;
  let SUBJECT = "";
  let LIVE_KEY = "";
  let LIVE_FILE = "";
  let SAW: string | null = null;
  const USAGE =
    'usage: land.ts "<subject>" [--hold] | --release | --check [--verbose] | --gate | --live-start <spec>/<id> | --live-pass <spec>/<id> <file> --saw "<what it shows>"';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--check") MODE = "check";
    else if (a === "--gate") MODE = "gate";
    else if (a === "--release") MODE = "release";
    else if (a === "--hold") HOLD = true;
    else if (a === "--verbose") VERBOSE = 1;
    else if (a === "--live-start") {
      MODE = "live-start";
      LIVE_KEY = argv[++i] ?? "";
    } else if (a === "--live-pass") {
      MODE = "live-pass";
      LIVE_KEY = argv[++i] ?? "";
      LIVE_FILE = argv[++i] ?? "";
    } else if (a === "--saw") SAW = argv[++i] ?? "";
    else if (a.startsWith("-")) {
      warn(USAGE);
      exit(2);
    } else SUBJECT = a;
  }
  if (HOLD && MODE !== "land") {
    warn("usage: --hold goes with a landing, not with --check, --gate or --release");
    exit(2);
  }
  if ((MODE === "live-start" && !LIVE_KEY) || (MODE === "live-pass" && (!LIVE_KEY || !LIVE_FILE))) {
    warn(USAGE);
    exit(2);
  }
  if (SAW !== null && MODE !== "live-pass") {
    warn("usage: --saw goes with --live-pass");
    exit(2);
  }
  // A release prints the report a landing would; it lands nothing.
  const REPORTS = MODE === "land" || MODE === "release";

  // The id is thread.ts's STDOUT alone. Its stderr carries Node 22.x's
  // ExperimentalWarning (type stripping, node:sqlite) as well as its refusal,
  // and captured merged — as the bash `2>&1` did, when thread.sh printed no
  // warning — the warning became part of the id. stderr is read only for the
  // refusal: its `thread: ` line, else its last line.
  const tidRun = run(process.execPath, nodeArgs(THREAD, ["--id"]), { out: "pipe", err: "pipe" });
  const TID = chomp(tidRun.stdout);
  if (!tidRun.ok || !TID) {
    const errLines = chomp(tidRun.stderr)
      .split("\n")
      .filter((l) => l !== "");
    const why = errLines.find((l) => l.startsWith("thread: ")) ?? lastLine(tidRun.stderr, "thread.ts failed");
    die(why.startsWith("thread: ") ? why.slice("thread: ".length) : why);
  }

  const STATE = `${process.env.HOME ?? ""}/.cache/workbench/threads/${TID}`;
  const LEDGER = `${STATE}/worktrees`;
  const LANDED = `${STATE}/landed`;
  const JOURNAL_REF = `${STATE}/journal`;
  const CLOSED = `${STATE}/closed`;
  const DEPLOY_LOG = `${STATE}/deploy.log`;
  const DEPLOY_OWED = `${STATE}/deploy-owed`;
  const NEXT_REF = `${STATE}/next`;
  const STATUS_REF = `${STATE}/project-status`;
  const HELD = `${STATE}/held`;
  // The worktrees a held close left in place because these scripts run from
  // them (or its checkers do), one `<wt>\t<shared>\t<branch>` per line: the
  // close that ends the hold removes them (Contextium v9.2.0 review).
  const HELD_REMOVALS = `${STATE}/held-removals`;
  // The harness-link lines of this close's landings, and the final report
  // block as printed — saved before the closed marker, so a reader of the state
  // (an end-of-turn check) finds the block any close that finished printed.
  // `report-delivered` is that reader's own mark, cleared with each new block.
  const HARNESS_REF = `${STATE}/harness-links`;
  const REPORT_REF = `${STATE}/report`;
  const REPORT_DELIVERED = `${STATE}/report-delivered`;
  // The live checks this close owes (written before the push), what
  // proved each one, and the evidence files --live-pass copied.
  const LIVE_OWED = `${STATE}/live-owed`;
  const LIVE_PASSED = `${STATE}/live-passed`;
  // Kept across closes: a delivered report links the files in it.
  const LIVE_DIR = `${STATE}/live`;
  mkdirSync(STATE, { recursive: true });

  // ── The live checks' state ───────────────────────────────────────────────
  //
  // `live-owed` is a JSON list, one entry per check: the spec that declared it,
  // the repo whose commit the target serves, and that commit once the repo's
  // landing in this close is about to push it ("" until then). `live-passed`
  // maps a key to what proved it: an evidence check's start and pass
  // revisions, file and statement; a command check's last result.
  type Owed = {
    key: string;
    spec: string;
    id: string;
    target: string;
    kind: "command" | "evidence";
    body: string;
    declRepo: string;
    repo: string;
    commit: string;
  };
  type Passed = {
    key: string;
    startRevision?: Revision;
    revision?: Revision;
    file?: string;
    saw?: string;
    result?: { exit: number; tail: string };
    time: string;
  };
  const readJson = <T>(p: string, empty: T): T => {
    if (!isFile(p)) return empty;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      notClosed(`${p} is not JSON — the live-check state is damaged; inspect it, then re-run`);
    }
  };
  const readLiveOwed = (): Owed[] => readJson<Owed[]>(LIVE_OWED, []);
  const writeLiveOwed = (o: Owed[]): void => writeAtomic(LIVE_OWED, `${JSON.stringify(o, null, 2)}\n`);
  const readPassed = (): Record<string, Passed> => readJson<Record<string, Passed>>(LIVE_PASSED, {});
  const writePassed = (p: Record<string, Passed>): void => writeAtomic(LIVE_PASSED, `${JSON.stringify(p, null, 2)}\n`);
  const short = (s: string): string => (/^[0-9a-f]{40}$/.test(s) ? s.slice(0, 12) : s);
  const owedLines = (): string[] =>
    readLiveOwed().map((o) =>
      o.kind === "command"
        ? `  owed: ${o.key} — command on ${o.target}: ${o.body} (land.ts --release runs it)`
        : `  owed: ${o.key} — evidence on ${o.target}: ${o.body} (land.ts --live-start ${o.key}; capture it; land.ts --live-pass ${o.key} <file> --saw "<what it shows>")`,
    );
  // What is live on <target>, served from the checkout <repo> (live-checks.ts).
  const readLive = async (target: string, repo: string): Promise<Revision> => {
    try {
      return await liveRevision(target, repo);
    } catch (e) {
      if (e instanceof Exit) throw e;
      throw new Error(`cannot read the live revision of ${target}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // Where nothing records which commit serves, no live check can be tied to
  // the commit it proves (live-checks.ts's header): a capture shows an unknown
  // deploy, and a command that passes may be probing the last healthy one —
  // with B's deploy failed, a probe of A succeeded and released B (fourth
  // v9.2.0 review). Every live check on such a target is refused.
  const cannotTell = (target: string, rev: Revision): string =>
    `cannot tell which commit is live on ${target} (${rev.deploymentId}) — live checks need a repo whose deploys GitHub records as production deployments; a repo without them can still release, but cannot declare live checks`;

  // ── An evidence check, recorded in two steps ─────────────────────────────
  //
  // The revision is read BEFORE the capture and again after it: a deploy that
  // lands in between makes the capture a picture of something no longer live,
  // so it is refused and retaken. The file is copied into the thread's state,
  // and the statement of what it shows is kept beside the declared
  // expectation, which the release's report prints together.
  if (MODE === "live-start" || MODE === "live-pass") {
    const owed = readLiveOwed();
    const o = owed.find((x) => x.key === LIVE_KEY);
    if (!o) notClosed(`${LIVE_KEY} is not an owed live check — owed: ${owed.map((x) => x.key).join(", ") || "none"}`);
    if (o.kind !== "evidence") notClosed(`${LIVE_KEY} is a command check — land.ts --release runs it`);
    const passed = readPassed();
    if (MODE === "live-start") {
      let rev: Revision;
      try {
        rev = await readLive(o.target, o.repo);
      } catch (e) {
        notClosed(e instanceof Error ? e.message : String(e));
      }
      if (rev.sourceCommit === null) notClosed(`${LIVE_KEY}: ${cannotTell(o.target, rev)}`);
      passed[LIVE_KEY] = { key: LIVE_KEY, startRevision: rev, time: new Date().toISOString() };
      writePassed(passed);
      say(
        `live-start: ${LIVE_KEY} — ${o.target} is at ${short(rev.deploymentId)}; capture it now, then land.ts --live-pass ${LIVE_KEY} <file> --saw "<what it shows>"`,
      );
      exit(0);
    }
    if (!nonEmpty(LIVE_FILE) || !isFile(LIVE_FILE)) notClosed(`${LIVE_FILE} is missing or empty — nothing to record`);
    if (!SAW?.trim()) notClosed(`--saw "<what the evidence shows>" is required — say what the capture shows`);
    const start = passed[LIVE_KEY]?.startRevision;
    if (!start)
      notClosed(
        `${LIVE_KEY} has no --live-start — run land.ts --live-start ${LIVE_KEY} before capturing, then capture again`,
      );
    let rev: Revision;
    try {
      rev = await readLive(o.target, o.repo);
    } catch (e) {
      notClosed(e instanceof Error ? e.message : String(e));
    }
    if (rev.deploymentId !== start.deploymentId) {
      delete passed[LIVE_KEY];
      writePassed(passed);
      notClosed(
        `${o.target} changed since --live-start (${short(start.deploymentId)} → ${short(rev.deploymentId)}), so the capture is void — land.ts --live-start ${LIVE_KEY}, capture again, then --live-pass`,
      );
    }
    mkdirSync(LIVE_DIR, { recursive: true });
    const dest = `${LIVE_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}-${LIVE_KEY.replace(/\//g, "__")}-${basename(LIVE_FILE)}`;
    writeFileSync(dest, readFileSync(LIVE_FILE));
    passed[LIVE_KEY] = {
      key: LIVE_KEY,
      startRevision: start,
      revision: rev,
      file: dest,
      saw: SAW.trim(),
      time: new Date().toISOString(),
    };
    writePassed(passed);
    say(`live-pass: ${LIVE_KEY} recorded on ${o.target} at ${short(rev.deploymentId)} — ${dest}`);
    exit(0);
  }

  // ── The auto-close gate ──────────────────────────────────────────────────
  //
  // It answers "has this session already been closed, with nothing written
  // since?" — rather than "did some skill dispatch a close at some point".
  //
  // WHY THE MARKER ALONE IS NOT THE ANSWER. A bare per-thread marker is a
  // session-wide latch: the first producer skill to close in a session would
  // suppress every later auto-close in it and strand the rest of the session's
  // work uncommitted. A session keeps working after a close — /spec, then
  // /implement, then a standalone /implement-audit — and a later edit
  // legitimately needs a second one. So the marker is treated as STALE the moment
  // any worktree has something in it again — which is the same condition the
  // third check below tests, and needs no key.
  if (MODE === "gate") {
    // A held close is neither closed nor a close to dispatch again: it is
    // waiting on its live checks and --release. Said with what it owes,
    // for as long as it is held — nothing time-based ends a hold.
    if (isFile(HELD)) {
      say("held");
      for (const l of owedLines()) say(l);
      exit(0);
    }
    if (!isFile(CLOSED) || !isFile(LEDGER)) {
      say("not-fired");
      exit(0);
    }
    // An unreadable worktree is not a clean one: the close runs. The gate's
    // job is to prove there is nothing left, and a repo it cannot read is not
    // a repo it can vouch for.
    say(unlandedWork(LEDGER) === "clean" ? "fired" : "not-fired");
    exit(0);
  }

  // A successful prior close starts a new reporting window. Keep the log when a
  // landing failed (there is no CLOSED marker), because its retry must still
  // report deployments completed before the failure. Once a close succeeded,
  // carrying that log into later work falsely attributes old deployments to the
  // new close.
  if (MODE === "land" && isFile(CLOSED) && !isFile(HELD)) {
    writeAtomic(DEPLOY_LOG, "");
    rmSync(HARNESS_REF, { force: true });
    rmSync(REPORT_REF, { recursive: true, force: true });
    // Before `closed` goes: a thread that closed before closed-once existed
    // keeps the record if this landing is refused.
    writeAtomic(`${STATE}/closed-once`, "");
    rmSync(CLOSED, { force: true });
  }

  // SEED THE LEDGER WITH THE THREAD'S OWN WORKTREE, exactly as verify.ts does.
  // A session that only ever edited the tree its harness handed it has never called the
  // resolver — nothing needed to ask where to write. Its ledger is empty, and
  // without this the close refuses with "owns no worktrees" while the work sits
  // right there uncommitted. Whichever step runs first seeds it; the resolver is
  // idempotent, so the second one is free. Deliberately after the gate above,
  // which is a read-only question and must create nothing.
  const T3_WT_SEED = chomp(run(process.execPath, nodeArgs(THREAD, ["--worktree"])).stdout);
  if (T3_WT_SEED && isDir(T3_WT_SEED)) {
    run("bash", [WRITE_ROOT, T3_WT_SEED], { out: "ignore", err: "ignore" });
  }

  if (!isFile(LEDGER)) die("this thread owns no worktrees — nothing to land");
  // The report names what the close shipped: the subject of the FIRST held
  // landing, which a later --hold landing (a fix the live checks found) keeps.
  if (MODE === "release") {
    if (!isFile(HELD)) notClosed("nothing is held — land with --hold first");
    SUBJECT = firstLine(HELD);
  }
  // A HOLD IS NEVER CLEARED BY A LANDING. Otherwise a landing without --hold
  // writes `closed` over an open hold, and the live checks it was waiting for
  // are never proved.
  if (MODE === "land" && !HOLD && isFile(HELD)) notClosed("a hold is open — land with --hold, or --release");
  if (MODE !== "check" && !SUBJECT) die("a commit subject is required");

  // THE WORKTREE THAT HOLDS THE JOURNAL is told from the others by the journal
  // path itself: journal-file.ts records `<worktree>/journal/<date>/<file>`, and
  // the ledger row whose worktree that path starts with is the one whose entry
  // has to reach the trunk and whose SHA the last line quotes. The path is the
  // answer; no second lookup is needed.
  const holdsJournal = (wt: string): boolean => {
    if (!isFile(JOURNAL_REF)) return false;
    const p = firstLine(JOURNAL_REF);
    if (!p) return false;
    return p.startsWith(`${wt}/journal/`);
  };

  // RESOLVED ONCE, HERE, BEFORE ANYTHING IS REMOVED — and this is load-bearing.
  // These scripts live in the workbench, and a thread opened on a product repo
  // holds the workbench as a SATELLITE — one of the worktrees this run removes.
  // Every later run of THREAD would then read a file that is no longer there,
  // return empty, and the own-worktree guard below would compare against "" and
  // remove the harness's worktree instead of skipping it. The rule holds
  // because the worktree these scripts run from is still one this run may
  // remove at the end.
  //
  // NO_OWN_WORKTREE is the one EMPTY answer that is definite: a session outside
  // T3 that started in the main checkout has no worktree of its own (thread.ts
  // says so), so every worktree in its ledger is one write-root.sh made and may go.
  const ownRun = run(process.execPath, nodeArgs(THREAD, ["--worktree"]), { out: "pipe", err: "pipe" });
  const T3_WORKTREE = chomp(ownRun.stdout);
  const NO_OWN_WORKTREE = T3_WORKTREE === "" && ownRun.stderr.includes("has no worktree recorded");

  // Capture the project's deterministic next command while the worktree holding
  // the records still exists. Landing removes it when it is a satellite, and
  // asking the model to run the generator later is exactly how a required Next
  // line was omitted. A journal without a project is a one-off close and
  // legitimately has no Next field.
  //
  // This first capture is from the thread's OWN copy of the project, before the
  // trunk is merged in — right for `--check` and for a retry with nothing to
  // land, wrong once the merge brings another session's rows. So landOne
  // derives it again from the merged tree of the worktree holding the journal,
  // before that tree is pushed or removed (PROJECT_REL). With only this
  // capture, two parallel row closes would print `/implement` for the row the
  // other session had just landed.
  let NEXT_OUTPUT = "";
  let STATUS_LINE = "";
  let PROJECT_REL = "";
  // STDOUT ONLY is the Next block: merged in, as the bash `2>&1` did, Node
  // 22.x's ExperimentalWarning printed as a prose line of the report. stderr
  // is the refusal when it fails.
  const deriveNext = (projectPath: string): void => {
    const r = run(process.execPath, nodeArgs(NEXT_COMMAND, [projectPath]), { out: "pipe", err: "pipe" });
    NEXT_OUTPUT = chomp(r.stdout);
    if (!r.ok) notClosed(`could not derive next action: ${lastLine(r.stderr, NEXT_OUTPUT)}`);
    writeAtomic(NEXT_REF, `${NEXT_OUTPUT}\n`);
    // The report's **Project:** sentence, captured beside Next for the same
    // reason. It describes and gates nothing: a failure leaves the line out.
    const st = run(process.execPath, nodeArgs(PROJECT_STATUS, [projectPath]), { out: "pipe", err: "pipe" });
    STATUS_LINE = st.ok ? chomp(st.stdout) : "";
    writeAtomic(STATUS_REF, `${STATUS_LINE}\n`);
  };
  if (isFile(NEXT_REF)) NEXT_OUTPUT = chomp(readFileSync(NEXT_REF, "utf8"));
  if (isFile(STATUS_REF)) STATUS_LINE = chomp(readFileSync(STATUS_REF, "utf8"));
  if (isFile(JOURNAL_REF)) {
    const JOURNAL_PATH = firstLine(JOURNAL_REF);
    if (isFile(JOURNAL_PATH)) {
      // sed -nE 's/^project:[[:space:]]*(.+)[[:space:]]*$/\1/p' | head -n 1
      let PROJECT_REF = "";
      for (const l of readFileSync(JOURNAL_PATH, "utf8").split("\n")) {
        const m = /^project:[ \t\v\f\r]*([^\n]+)[ \t\v\f\r]*$/.exec(l);
        if (m) {
          PROJECT_REF = m[1] ?? "";
          break;
        }
      }
      if (PROJECT_REF.endsWith('"')) PROJECT_REF = PROJECT_REF.slice(0, -1);
      if (PROJECT_REF.startsWith('"')) PROJECT_REF = PROJECT_REF.slice(1);
      if (PROJECT_REF.endsWith("'")) PROJECT_REF = PROJECT_REF.slice(0, -1);
      if (PROJECT_REF.startsWith("'")) PROJECT_REF = PROJECT_REF.slice(1);
      // `null` / `~` is YAML's null — the schema's one-off value — not a folder.
      if (["null", "Null", "NULL", "~"].includes(PROJECT_REF)) PROJECT_REF = "";
      if (PROJECT_REF) {
        const cut = JOURNAL_PATH.indexOf("/journal/");
        const RECORDS_WT = cut === -1 ? JOURNAL_PATH : JOURNAL_PATH.slice(0, cut);
        PROJECT_REL = PROJECT_REF.startsWith("projects/") ? PROJECT_REF : `projects/${PROJECT_REF}`;
        deriveNext(`${RECORDS_WT}/${PROJECT_REL}`);
      }
    }
  }

  // A worktree that HOLDS THESE SCRIPTS cannot be removed while they are running.
  // Node has already read this file, but the siblings this script shells out
  // to are opened by name, every time. So self-removal is deferred to the very
  // end, after the last helper call.
  let SCRIPT_WORKTREE = "";
  let probe = SCRIPT_DIR;
  while (probe !== "/" && probe) {
    if (existsSync(`${probe}/.git`)) {
      SCRIPT_WORKTREE = probe;
      break;
    }
    probe = dirname(probe);
  }
  const DEFERRED_REMOVALS: [string, string, string][] = [];

  const landedShaFor = (shared: string): string | null => {
    if (!isFile(LANDED)) return null;
    const text = readFileSync(LANDED, "utf8");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    let sha: string | null = null;
    for (const l of lines) {
      const f = l.split("\t");
      if (f[0] === shared) sha = f[1] ?? "";
    }
    return sha ? sha : null;
  };

  // THE DEPLOY OBLIGATION, persisted beside the landed SHA. The SHA is written
  // the moment the push succeeds, before the run is polled, so a retry that
  // finds HEAD at that SHA has nothing to land — and returning there, it
  // would never poll again, and certify a push whose deploy had failed. A line here says "this repo's push at this SHA is owed a good run";
  // only the poller's success removes it, and the checks refuse while any is
  // left. One line per repo: SHARED⇥SHA.
  const readOwed = (): string[][] =>
    isFile(DEPLOY_OWED) ? readLines(readFileSync(DEPLOY_OWED, "utf8")).map((l) => l.split("\t")) : [];
  const owedShaFor = (shared: string): string | null => {
    const hit = readOwed().find((f) => f[0] === shared);
    return hit?.[1] ? hit[1] : null;
  };
  // Both rewrite the whole file in one rename (writeAtomic). As "clear, then
  // append", a kill between the two would leave no obligation on disk for a SHA
  // already recorded as landed.
  const owedWithout = (shared: string): string =>
    readOwed()
      .filter((f) => f[0] !== shared)
      .map((f) => `${f.join("\t")}\n`)
      .join("");
  const clearOwed = (shared: string): void => writeAtomic(DEPLOY_OWED, owedWithout(shared));
  const setOwed = (shared: string, sha: string): void =>
    writeAtomic(DEPLOY_OWED, `${owedWithout(shared)}${shared}\t${sha}\n`, "owed-replace");

  // THE REPO GITHUB IS ASKED ABOUT: owner/name off <shared>'s configured
  // origin, or null when that is not on GitHub — live-checks.ts's githubRepoOf,
  // the one reader (configured URL, not the insteadOf expansion; an SSH alias
  // resolved through `ssh -G`). A read that failed is NOT CLOSED, never "no repo".
  const githubRepoOf = (shared: string): string | null => {
    try {
      return readGithubRepo(shared);
    } catch (e) {
      notClosed(e instanceof Error ? e.message : String(e));
    }
  };

  // Whether the `gh` CLI is on PATH (LAND_GH names another binary to look
  // for, the suite's seam): await-push-checks.ts asks GitHub through it.
  // Asked once per run.
  let GH_PRESENT: boolean | undefined;
  const ghPresent = (): boolean => {
    if (GH_PRESENT === undefined) {
      const r = spawnSync(process.env.LAND_GH || "gh", ["--version"], { stdio: "ignore" });
      GH_PRESENT = !(r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT");
    }
    return GH_PRESENT;
  };

  // pollDeploy <shared> <sha> — wait for everything GitHub reports on the push
  // at <sha>: every check run and commit status, to completion, whatever
  // started it — a GitHub Actions workflow, a hosted build (Cloudflare Pages or
  // Workers Builds, Vercel, Netlify), a deployer's commit status. One reader
  // for all of them: a poller per kind of deploy calls anything it does not
  // know "nothing to wait for", and a failed build of that kind closes green.
  // `await-push-checks.ts` says what passing means; its exit 3 is "this repo
  // reports nothing, and nothing was expected", which settles the obligation
  // with its line. Anything else that is not 0 is NOT CLOSED with the
  // obligation kept, and the retry polls the same SHA again. It is land's own
  // sibling that runs, asked about the repo by name, so nothing of the landed
  // tree is needed — an owed SHA whose worktree is gone is polled the same way.
  //
  // A REPO NOT ON GITHUB, OR NO `gh` ON THIS MACHINE, settles with a line
  // saying so: there is nothing this can ask, and an install without `gh`
  // still closes. A `gh` that is present but cannot read the checks (signed
  // out, no access) is a failed read, and NOT CLOSED.
  const pollDeploy = (shared: string, sha: string): void => {
    const repo = githubRepoOf(shared);
    let LINES: string;
    let r: Run | null = null;
    if (repo === null) {
      LINES = `no deploy reported for ${shared} — its origin is not on GitHub`;
    } else if (!ghPresent()) {
      LINES = `no push checks read for ${repo} — the gh CLI is not installed (install it and run gh auth login to have the close wait on them)`;
    } else {
      const logFd = openSync(DEPLOY_LOG, "a");
      try {
        r = run(process.execPath, nodeArgs(PUSH_CHECKS, ["--repo", repo, "--sha", sha]), {
          cwd: shared,
          out: "pipe",
          err: logFd,
        });
      } finally {
        closeSync(logFd);
      }
      LINES = chomp(r.stdout);
    }
    if (LINES) appendFileSync(DEPLOY_LOG, `${LINES}\n`);
    if (r !== null && !r.ok && r.status !== 3) {
      const lines = LINES.split("\n").filter(Boolean);
      const last = lines.pop() ?? `could not read the checks of ${sha}`;
      for (const l of lines) say(`  ${l}`);
      notClosed(`${last} — ${shared} is on origin but its deploy did not succeed`);
    }
    killPoint("polled");
    clearOwed(shared);
    for (const l of LINES.split("\n")) if (l) say(`  ${l}`);
  };

  // The journal path recorded by journal-file.ts, as a repo-relative path. Taken
  // from the `journal/` segment rather than by stripping a worktree prefix,
  // because by check time that worktree may already have been removed.
  const journalRel = (): string | null => {
    if (!isFile(JOURNAL_REF)) return null;
    const p = firstLine(JOURNAL_REF);
    if (!p) return null;
    const at = p.lastIndexOf("/journal/");
    if (at === -1) return null;
    return `journal/${p.slice(at + "/journal/".length)}`;
  };

  // wtStatus <worktree> — its `git status --porcelain`, or the close stops.
  // Read as `$(git status … 2>/dev/null)`, a failed read was empty, and empty
  // is "clean": the work was never committed and the final check vouched for
  // it.
  const wtStatus = (wt: string): string => {
    const r = git(wt, ["status", "--porcelain"]);
    if (!r.ok) notClosed(`could not read the status of ${wt} — git failed; re-run`);
    return chomp(r.stdout);
  };

  // changedPaths <worktree> <base> — what <worktree> changed since <base>,
  // tracked changes plus untracked files, NUL-separated. The gates below read
  // it. A git read that fails stops the close: read through a process
  // substitution, its failure was invisible, and "could not list the change"
  // became "nothing changed" — a gate that then saw nothing to check.
  const changedPaths = (wt: string, base: string): string[] => {
    const d = git(wt, ["diff", "-z", "--name-only", "--no-renames", base]);
    const u = d.ok ? git(wt, ["ls-files", "-z", "--others", "--exclude-standard"]) : d;
    if (!d.ok || !u.ok) notClosed(`could not list what ${wt} changed since ${base} — git failed; re-run`);
    return `${d.stdout}${u.stdout}`.split("\0").slice(0, -1);
  };

  // Does this worktree change a decision record that is still on disk? Asked only
  // when no checker resolved, to tell "nothing to check" from "cannot check". The
  // same file set check-decision-records.ts scans with `--since` — tracked
  // changes since <base> plus untracked files, a `.md` directly inside a
  // `decisions/` folder, not its README — so a close that only deletes or moves a
  // record away, or edits a README, is not refused for want of a checker.
  const changedDecisionRecords = (wt: string, base: string): boolean => {
    for (const p of changedPaths(wt, base)) {
      if (!/(^|\/)decisions\/[^/]+\.md$/.test(p)) continue;
      if (basename(p) === "README.md") continue;
      if (isFile(`${wt}/${p}`)) return true;
    }
    return false;
  };

  // The same question for integration manifests: an `integrations/<name>/README.md`
  // changed since <base> and still on disk — the file set
  // check-integration-manifest.ts scans with `--since`. Deleting an integration is
  // not refused for want of a checker.
  const changedIntegrationManifests = (wt: string, base: string): boolean => {
    for (const p of changedPaths(wt, base)) {
      if (!/^integrations\/[^/]+\/README\.md$/.test(p)) continue;
      if (isFile(`${wt}/${p}`)) return true;
    }
    return false;
  };

  // The same question for scripts: a file check-scripts.ts would scan — under
  // .agents/ and outside `node_modules/`, with one of the six extensions it
  // reads (`.sh`, `.ts`, `.mjs`, `.js`, `.cjs`, `.py`: parts (a) and (b) pair
  // the scripts, part (c) judges the language of every file there) — changed
  // since <base>. `*.test.*` files count, and DELETED paths count: removing a
  // script's only test is exactly the change the checker must see (the same reasoning as
  // changedSkillTree below), and a deleted script whose test survives is the
  // checker's to judge, not this predicate's to wave through. Read through
  // changedPaths, which stops the close when git fails: read unchecked, a
  // failed listing would be "no script changed" and an untracked script would
  // land with no checker run.
  const changedScripts = (wt: string, base: string): boolean => {
    for (const p of changedPaths(wt, base)) {
      if (/^\.agents\/.*\.(sh|ts|mjs|js|cjs|py)$/s.test(p) && !`/${p}/`.includes("/node_modules/")) return true;
    }
    return false;
  };

  // The skills tree's own gate. `.agents/checks/check-skills.ts` checks the tree
  // at `.agents/skills/` of the workbench, and scans by FOLDER: any
  // path under `.agents/skills/<folder>/` changed since <base> — a SKILL.md, a state/
  // file, a new folder — selects that folder, and a file directly under
  // `.agents/skills/` or anywhere else in the repo selects nothing. That predicate is
  // what decides whether the checker is run at all; the narrower one below (a
  // SKILL.md itself) is what a worktree WITHOUT the checker is refused on. Both
  // are scoped to `.agents/skills/`: when the tree was a repo of its own the predicate
  // was "any top-level folder", and in this repo that would fire on every close,
  // because every close changes `journal/`.
  const changedSkillTree = (wt: string, base: string): boolean => {
    for (const p of changedPaths(wt, base)) {
      if (!/^\.agents\/skills\/[^/]+\//.test(p)) continue;
      // The FOLDER has to exist, not the path: a deleted `state/_doc.md` is
      // exactly the change the checker must see. A whole folder deleted is a
      // skill removed, and the checker skips what is not on disk.
      const folder = p.slice(".agents/skills/".length);
      if (isDir(`${wt}/.agents/skills/${folder.split("/")[0]}`)) return true;
    }
    return false;
  };
  const changedSkillManifests = (wt: string, base: string): boolean => {
    for (const p of changedPaths(wt, base)) {
      if (!/^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(p)) continue;
      if (isFile(`${wt}/${p}`)) return true;
    }
    return false;
  };

  // The workbench gate's question: any path under projects/, where a ROADMAP.md
  // row or a spec report a close leaves open can live.
  const touchesProjects = (paths: string[]): boolean => paths.some((p) => p.startsWith("projects/"));

  // refuseOnCheck <checker> <worktree> <base> <what> — run one pre-commit
  // checker over what <worktree> changed since <base>, and refuse the close with
  // EVERY violation line printed, not just the first: one close per violation is
  // the cost the checkers' accumulate-then-exit design exists to avoid. The
  // interpreter follows the checker's extension: every `.agents/checks/`
  // checker is TypeScript; a `.sh` still runs in bash. It runs IN <worktree>,
  // with PWD set there as a `cd` sets it, and only its stderr is read — its
  // stdout goes to /dev/null. `args` is what the checker is given: `--since
  // <base>`, or nothing for the standards check, which reads the tracked tree.
  const refuseOnCheck = (check: string, wt: string, base: string, what: string, args = ["--since", base]): void => {
    const [cmd, pre] = check.endsWith(".ts")
      ? [process.execPath, NODE_TS]
      : ["bash", []];
    const r = run(cmd, [...pre, check, ...args], {
      cwd: wt,
      env: { ...process.env, PWD: wt },
      out: "ignore",
      err: "pipe",
    });
    if (!r.ok) {
      const out = chomp(r.stderr);
      if (!out) notClosed(`${what} rejected in ${wt}: ${check} exited non-zero with no message`);
      const lines = out.split("\n");
      process.stderr.write(lines.map((l) => `  ${l}\n`).join(""));
      notClosed(`${what} rejected in ${wt}: ${lines[0]} (${lines.length} line(s) above)`);
    }
  };

  // ── Landing ──────────────────────────────────────────────────────────────

  const removeWorktree = (wt: string, shared: string, branch: string): void => {
    if (!git(shared, ["worktree", "remove", "--force", wt], { out: "inherit" }).ok)
      rmSync(wt, { recursive: true, force: true });
    git(shared, ["worktree", "prune"], { out: "inherit" });
    git(shared, ["branch", "-q", "-D", branch], { out: "inherit" });
    if (git(shared, ["ls-remote", "--exit-code", "--heads", "origin", branch], { out: "ignore" }).ok) {
      git(shared, ["push", "-q", "origin", "--delete", branch], { out: "inherit" });
    }
  };

  // THE TRUNK BRANCH IS ASKED FOR, PER REPO, NEVER SPELLED.
  //
  // Spelling it `main` is correct for most repos and wrong for any that predates
  // the rename: a repo whose trunk is `master` would be refused by write-root.sh,
  // landed by hand, and never seen here. The resolution lives in `trunk.ts` and
  // the answer is memoized per repo, because
  // `landOne` and the three checks each ask about the same repo more than once
  // and `git symbolic-ref` should not be run eight times to learn one fact.
  const TRUNK_CACHE = new Map<string, string>();

  const trunkOf = (repo: string): string | null => {
    let key = repo;
    if (isDir(repo)) {
      try {
        key = realpathSync(repo);
      } catch {
        key = repo;
      }
    }
    const hit = TRUNK_CACHE.get(key);
    if (hit) return hit;
    const r = run(process.execPath, nodeArgs(TRUNK_TS, [repo]));
    if (!r.ok) return null;
    const answer = chomp(r.stdout);
    TRUNK_CACHE.set(key, answer);
    return answer;
  };

  // The decision-record checker, RESOLVED ONCE, BEFORE ANYTHING IS REMOVED, for
  // the same reason as T3_WORKTREE above. It lives in the workbench, so it is
  // found in whichever ledger worktree is a workbench checkout — field 1 of each
  // WT⇥SHARED⇥BRANCH line — and that worktree's removal is deferred to the end.
  // The other checkers sit beside it in `.agents/checks/` and are resolved the
  // same way, EACH ON ITS OWN: a worktree holding some of `.agents/checks/` must
  // not hide a checker only a later ledger worktree carries. (Declared here,
  // filled in below from the ledger, as the bash filled its globals in before
  // the landing loop called land_one.)
  const DR_CHECK_REL = ".agents/checks/check-decision-records.ts";
  let DR_CHECK = "";
  let DR_CHECK_WT = "";
  const IM_CHECK_REL = ".agents/checks/check-integration-manifest.ts";
  let IM_CHECK = "";
  let IM_CHECK_WT = "";
  const SEC_CHECK_REL = ".agents/checks/check-secrets.ts";
  let SEC_CHECK = "";
  let SEC_CHECK_WT = "";
  const STD_CHECK_REL = ".agents/checks/check-standards-refs.ts";
  let STD_CHECK = "";
  let STD_CHECK_WT = "";
  const SC_CHECK_REL = ".agents/checks/check-scripts.ts";
  let SC_CHECK = "";
  let SC_CHECK_WT = "";

  // The worktrees whose removal waits until after the final check: the one these
  // scripts run from, and the ones holding the checkers. Asked both when a
  // satellite lands and when a re-run finds it already landed.
  const removalIsDeferred = (wt: string): boolean =>
    (SCRIPT_WORKTREE !== "" && wt === SCRIPT_WORKTREE) ||
    (DR_CHECK_WT !== "" && wt === DR_CHECK_WT) ||
    (IM_CHECK_WT !== "" && wt === IM_CHECK_WT) ||
    (SEC_CHECK_WT !== "" && wt === SEC_CHECK_WT) ||
    (STD_CHECK_WT !== "" && wt === STD_CHECK_WT) ||
    (SC_CHECK_WT !== "" && wt === SC_CHECK_WT);

  // registerRoadmapMerge <worktree> — wire roadmap-merge.ts into this repo's
  // merges of ROADMAP.md and of a project README (its `next:` line): the driver in its config (a driver cannot be committed — git reads it
  // only from config), and the attribute in its info/attributes, so every repo a
  // close merges gets it without carrying a .gitattributes of its own. Both are
  // rewritten on each close, so a moved checkout of this script never leaves a
  // stale path behind. Best effort: without it the merge is git's own, as before.
  const registerRoadmapMerge = (wt: string): void => {
    if (!git(wt, ["config", "merge.roadmap.name", "ROADMAP.md, row by row"], { out: "inherit" }).ok) return;
    if (
      !git(
        wt,
        [
          "config",
          "merge.roadmap.driver",
          `node --experimental-strip-types '${SCRIPT_DIR}/roadmap-merge.ts' %O %A %B %P`,
        ],
        {
          out: "inherit",
        },
      ).ok
    )
      return;
    const common = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok) return;
    const attrs = `${chomp(common.stdout)}/info/attributes`;
    try {
      mkdirSync(dirname(attrs), { recursive: true });
    } catch {
      return;
    }
    for (const line of ["ROADMAP.md merge=roadmap", "projects/**/README.md merge=roadmap"]) {
      let present = false;
      try {
        present = readFileSync(attrs, "utf8").split("\n").includes(line);
      } catch {
        present = false;
      }
      if (present) continue;
      try {
        appendFileSync(attrs, `${line}\n`);
      } catch {
        // best effort, as `|| true`
      }
    }
  };

  // resyncNext <worktree> <trunk ref> — re-derive `status:` and `next:` for every project whose
  // ROADMAP.md OR README.md this push changes against the trunk. That is the
  // whole invariant: a push never changes a project's table or README without the
  // README's `next:` matching the table that lands. Both files, because either
  // side of a merge can be the stale one — two sessions each derived `next:` from
  // their own copy of the table, and when only the trunk moved the table while
  // this branch touched only the README, the README merge keeps OUR `next:` over
  // a table ours never saw. It runs before EVERY push, not only after a merge: a
  // failed re-derive leaves the merge committed, and a re-run that sees nothing
  // left to merge must not push past it. Re-deriving a `next:` that is already
  // right changes nothing. A project whose re-derive fails stops the close:
  // pushing would ship a README whose `next:` names the wrong row.
  // dependents <worktree> <project dirs> — every project under projects/ whose
  // ROADMAP.md names, in Depends on, one of `dirs` (`<slug> <ID>`, or
  // `<domain>/<slug> <ID>`). Read through roadmap.ts's listRows, the cell's one
  // parser; a table that does not read is skipped here and refused by its own
  // re-derive when its files change.
  const dependents = (wt: string, dirs: string[]): string[] => {
    const named = new Set<string>();
    for (const dir of dirs) {
      const m = /(?:^|\/)projects\/([^/]+)\/[0-9]{4}-[0-9]{2}-[0-9]{2}_([^/]+)$/.exec(dir);
      if (m?.[1] && m[2]) named.add(m[2]).add(`${m[1]}/${m[2]}`);
    }
    if (named.size === 0) return [];
    const found: string[] = [];
    let domains: string[] = [];
    try {
      domains = readdirSync(`${wt}/projects`);
    } catch {
      return [];
    }
    for (const domain of domains) {
      let folders: string[] = [];
      try {
        folders = readdirSync(`${wt}/projects/${domain}`);
      } catch {
        continue;
      }
      for (const folder of folders) {
        const table = `${wt}/projects/${domain}/${folder}/ROADMAP.md`;
        if (!isFile(table)) continue;
        // Only the cells are wanted, so nothing is resolved here.
        const { deps } = listRows(table, undefined, { projectsRoot: null });
        if (deps.some((row) => row.some((x) => x.project !== "" && named.has(x.project))))
          found.push(`projects/${domain}/${folder}`);
      }
    }
    return found;
  };

  const resyncNext = (wt: string, base: string): void => {
    // Read first and checked: a diff that fails must not read as "nothing to
    // re-derive" and let the push through. NUL-separated: without -z git
    // C-quotes a folder with an accent, and the quoted path matches nothing.
    // A changed spec report names its project too: promotion edits the
    // table of a project whose only other change may be that report.
    const d = git(
      wt,
      ["diff", "-z", "--name-only", base, "HEAD", "--", "*ROADMAP.md", "*README.md", "*/specs/*/report.md"],
      {
        err: "inherit",
      },
    );
    if (!d.ok) notClosed(`could not list the projects this push changes in ${wt}`);
    const dirs = [
      ...new Set(
        d.stdout
          .split("\0")
          .filter((p) => p !== "")
          .map((p) => /^(.*)\/specs\/[^/]+\/report\.md$/.exec(p)?.[1] ?? dirname(p)),
      ),
    ];
    // A project whose Depends on names one of these waits on it: finishing
    // the row it waits on changes its status too, though none of its files moved.
    for (const dep of dependents(wt, dirs)) if (!dirs.includes(dep)) dirs.push(dep);
    dirs.sort();
    const changed: string[] = [];
    for (const dir of dirs) {
      // Only a project with a table has a next: to derive — and a table this push
      // deletes has none. A project is a folder under projects/; anything else
      // holding the pair (the project templates, rows placeholders on purpose)
      // is not one.
      if (!/(^|\/)projects\/[^/]+\/[^/]+$/.test(dir)) continue;
      if (!(isFile(`${wt}/${dir}/ROADMAP.md`) && isFile(`${wt}/${dir}/README.md`))) continue;
      const r = run(process.execPath, nodeArgs(`${SCRIPT_DIR}/roadmap.ts`, [`${wt}/${dir}`, "--sync-next"]), {
        out: "ignore",
        err: "pipe",
      });
      if (r.ok) {
        if (!git(wt, ["diff", "--quiet", "--", `${dir}/README.md`], { out: "inherit", err: "inherit" }).ok)
          changed.push(`${dir}/README.md`);
      } else {
        const why = chomp(r.stderr).split("\n");
        notClosed(
          `next: could not be re-derived for ${dir}: ${why[why.length - 1]} — fix the table in ${wt}, then re-run`,
        );
      }
    }
    if (changed.length === 0) return;
    if (
      !git(wt, ["add", "--", ...changed], { out: "inherit", err: "inherit" }).ok ||
      !git(wt, ["commit", "-q", "-m", `${SUBJECT} (next: re-derived from the merged table)`], {
        out: "inherit",
        err: "inherit",
      }).ok
    ) {
      notClosed(`could not commit the re-derived next: in ${wt}`);
    }
  };

  // ── Bookkeeping the close does itself, so no step depends on memory ───────

  // The spec reports <wt> changes since <base>, grouped by project: projects
  // relative path → the spec names (`specs/NNN-name`) whose report.md moved.
  const changedReports = (wt: string, base: string): Map<string, Set<string>> => {
    const by = new Map<string, Set<string>>();
    for (const p of changedPaths(wt, base)) {
      const m = /^(projects\/[^/]+\/[^/]+)\/(specs\/[^/]+)\/report\.md$/.exec(p);
      if (!m?.[1] || !m[2] || !isFile(`${wt}/${p}`)) continue;
      by.set(m[1], (by.get(m[1]) ?? new Set()).add(m[2]));
    }
    return by;
  };

  // promoteFinishedRows <worktree> <base> — set `done` every row whose Sub-spec
  // names a spec this push's report makes `complete`, and re-derive that
  // project's README; returns the files it changed. As a command in SKILL.md
  // § 2 the model had to remember, a close that forgot was refused by the
  // roadmap gate for an `in-progress` row whose work was finished. Only
  // reports this push changed: a row another session owns is
  // never judged, here or in check-roadmap-decisions.ts. `closed:` and
  // `absorbed by` rows stopped on purpose and are left as they are. The two
  // readers are the table's and the spec state's own, spawned as the roadmap
  // gate spawns them. A table roadmap.ts cannot read is skipped: the re-derive
  // in resyncNext refuses the close over it.
  // completeSpecs <worktree> <base> — each changed project's specs whose
  // report this push changes and spec-state.ts reads `complete`, sorted by
  // project. Promotion and the live checks both ask it.
  const completeSpecs = (wt: string, base: string): [string, Set<string>][] => {
    const out: [string, Set<string>][] = [];
    for (const [proj, names] of [...changedReports(wt, base)].sort(([a], [b]) => a.localeCompare(b))) {
      const dir = `${wt}/${proj}`;
      if (!isFile(SPEC_STATE)) notClosed(`spec-state.ts missing: ${SPEC_STATE}`);
      const st = run(process.execPath, nodeArgs(SPEC_STATE, [dir]), { out: "pipe", err: "pipe" });
      if (!st.ok) notClosed(`spec-state.ts could not read ${proj}: ${lastLine(st.stderr, `exit ${st.status}`)}`);
      const complete = new Set(
        chomp(st.stdout)
          .split("\n")
          .map((l) => l.split("\t"))
          .filter(([name, state]) => name && state === "complete" && names.has(name))
          .map(([name]) => name ?? ""),
      );
      if (complete.size > 0) out.push([proj, complete]);
    }
    return out;
  };

  const promoteFinishedRows = (wt: string, base: string): string[] => {
    const touched: string[] = [];
    for (const [proj, complete] of completeSpecs(wt, base)) {
      const dir = `${wt}/${proj}`;
      if (!isFile(`${dir}/ROADMAP.md`)) continue;
      const table = run(process.execPath, nodeArgs(ROADMAP_TS, [dir]), { out: "pipe", err: "pipe" });
      if (!table.ok) continue;
      let set = 0;
      for (const line of chomp(table.stdout).split("\n")) {
        const [id = "", status = "", , sub = ""] = line.split("\t");
        if (!id || !complete.has(sub) || /^(done$|closed:|absorbed by )/i.test(status)) continue;
        const r = run(process.execPath, nodeArgs(ROADMAP_TS, [dir, "--set", id, "done"]), { out: "pipe", err: "pipe" });
        if (!r.ok)
          notClosed(`could not set ${id} done in ${proj}/ROADMAP.md: ${lastLine(r.stderr, `exit ${r.status}`)}`);
        say(`  roadmap: ${proj} ${id} set done — ${sub} reads complete`);
        set += 1;
      }
      if (set === 0) continue;
      const sync = run(process.execPath, nodeArgs(ROADMAP_TS, [dir, "--sync-next"]), { out: "pipe", err: "pipe" });
      if (!sync.ok)
        notClosed(
          `next: could not be re-derived for ${proj}: ${lastLine(sync.stderr, `exit ${sync.status}`)} — fix the table in ${wt}, then re-run`,
        );
      touched.push(`${proj}/ROADMAP.md`, `${proj}/README.md`);
    }
    return touched;
  };

  // quoteAuditLines <worktree> <base> — put each `spec-audit:` line of a changed
  // spec's plan.md, and each `implement-audit:` line of its report.md, under the
  // journal entry's **Changes:**, unless the entry already quotes it (spacing
  // aside). These lines are records the close's entry cites, never gates: a
  // trailer that gated a commit would refuse work for a missing line rather
  // than for a defect, so nothing here refuses an entry or a spec without one. Returns
  // the entry's path when it wrote to it.
  const quoteAuditLines = (wt: string, base: string): string | null => {
    const JREL = journalRel();
    if (JREL === null || !isFile(`${wt}/${JREL}`)) return null;
    const specs = new Set<string>();
    for (const p of changedPaths(wt, base)) {
      const m = /^(projects\/[^/]+\/[^/]+\/specs\/[^/]+)\//.exec(p);
      if (m?.[1]) specs.add(m[1]);
    }
    const lineOf = (file: string, keep: (l: string) => boolean): string[] =>
      isFile(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter(keep)
            .map((l) => l.trim())
        : [];
    const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
    let text = readFileSync(`${wt}/${JREL}`, "utf8");
    const add: string[] = [];
    for (const spec of [...specs].sort()) {
      const found = [
        ...lineOf(`${wt}/${spec}/plan.md`, (l) => l.startsWith("- spec-audit:")),
        ...lineOf(`${wt}/${spec}/report.md`, (l) => /^[\s>*`-]*implement-audit:/.test(l)),
      ];
      for (const l of found) {
        const body = l.startsWith("- ") ? l.slice(2) : l;
        if (flat(text).includes(flat(body)) || add.some((a) => flat(a) === flat(`- ${body}`))) continue;
        add.push(`- ${body}`);
      }
    }
    if (add.length === 0) return null;
    const ls = text.split("\n");
    const head = ls.findIndex((l) => /^\*\*Changes:\*\*/.test(l));
    if (head === -1) {
      // No section: one is made, before the next one the schema puts after it
      // (or at the end); the schema check that runs next judges the result.
      const next = ls.findIndex((l) => /^\*\*Findings:\*\*/.test(l));
      const block = ["**Changes:**", ...add, ""];
      if (next === -1) ls.push("", ...block);
      else ls.splice(next, 0, ...block);
    } else {
      let end = ls.findIndex((l, i) => i > head && /^\*\*[A-Za-z][A-Za-z ]*:\*\*/.test(l));
      if (end === -1) end = ls.length;
      let at = head + 1;
      for (let i = head + 1; i < end; i++) if ((ls[i] ?? "").trim() !== "") at = i + 1;
      ls.splice(at, 0, ...add);
    }
    text = ls.join("\n");
    writeFileSync(`${wt}/${JREL}`, text);
    say(`  journal: quoted ${add.length} audit line(s) under **Changes:** in ${JREL}`);
    return JREL;
  };

  // ── The live checks a push owes ──────────────────────────────────────────

  // The repo whose landed commit <target> serves, as its shared checkout in
  // the ledger. `workbench` is the declaring spec's own repo; `repo:<owner>/<name>`
  // is the ledger checkout whose GitHub origin is that repo. A target whose
  // repo this thread lands nothing in has no commit to check, and is refused
  // before the push.
  const targetRepo = async (target: string, declShared: string, where: string): Promise<string> => {
    if (targetParts(target).base === "workbench") return declShared;
    const ledgerShared = LEDGER_LINES.map((l) => (tabFields(l, 3)[1] ?? "").replace(/\/+$/, "")).filter(Boolean);
    let repo = "";
    try {
      repo = sourceRepo(target);
    } catch (e) {
      notClosed(`${where}: cannot tell which repo ${target} serves: ${e instanceof Error ? e.message : String(e)}`);
    }
    const hit = ledgerShared.find((s) => githubRepoOf(s)?.toLowerCase() === repo.toLowerCase());
    if (!hit)
      notClosed(`${where} owes a live check on ${target}, which builds from ${repo} — this thread lands nothing there`);
    return hit;
  };

  // What each repo landed IN THIS RUN, for binding an obligation collected
  // after its repo already landed (the ledger's order is not the specs').
  const LANDED_NOW = new Map<string, string>();

  // bindLive <shared> <sha> <overwrite> — give the obligations whose target is
  // served by <shared> the commit it lands. Before each push, overwriting: the
  // newest landing of the repo is what must be live. On a re-run's early
  // return, only those still unbound.
  const bindLive = (shared: string, sha: string, overwrite: boolean): void => {
    const owed = readLiveOwed();
    let moved = false;
    for (const o of owed) {
      if (o.repo !== shared.replace(/\/+$/, "") || o.commit === sha || (o.commit && !overwrite)) continue;
      o.commit = sha;
      moved = true;
    }
    if (moved) writeLiveOwed(owed);
  };

  // wasComplete <worktree> <base> <report> — did the report already claim its
  // spec complete at <base>, by spec-state.ts's own rule, which also needs the
  // folder's spec.md? Absent there, or unreadable, is not complete.
  const wasComplete = (wt: string, base: string, report: string): boolean => {
    if (!git(wt, ["cat-file", "-e", `${base}:${dirname(report)}/spec.md`]).ok) return false;
    const r = git(wt, ["show", `${base}:${report}`]);
    return r.ok && reportClaimsComplete(r.stdout);
  };

  // checksMoved <worktree> <base> <spec> — does the spec's live-checks block
  // now declare other checks than it did at <base>? Prose around the block is
  // not a change; a block added, emptied or edited is, and so is one that no
  // longer parses, so collectLive refuses it rather than dropping the line.
  const checksMoved = (wt: string, base: string, spec: string): boolean => {
    const rel = `${spec}/tasks.md`;
    const was = git(wt, ["show", `${base}:${rel}`]);
    const now = isFile(`${wt}/${rel}`) ? readFileSync(`${wt}/${rel}`, "utf8") : "";
    if (parseLiveChecks(now).errors.length > 0) return true;
    const decl = (t: string): string =>
      JSON.stringify(parseLiveChecks(t).checks.map((c) => [c.id, c.target, c.kind, c.body]));
    return decl(was.ok ? was.stdout : "") !== decl(now);
  };

  // collectLive <worktree> <shared> <base> — the checks of every spec this
  // push writes `complete`, written to `live-owed` before the push. A spec
  // collected again replaces its obligations and loses its pass records; other
  // specs' stay. A malformed block is refused here, before anything is pushed.
  const collectLive = async (wt: string, shared: string, base: string): Promise<void> => {
    const specs = completeSpecs(wt, base);
    // A complete spec whose live-checks block this push changes is collected
    // too, whether or not its report moved: held, the trunk already holds the
    // report from this close's own push, and a corrected, emptied or restored
    // block must replace what is owed.
    for (const p of changedPaths(wt, base)) {
      const m = /^(projects\/[^/]+\/[^/]+)\/(specs\/[^/]+)\/tasks\.md$/.exec(p);
      if (!m?.[1] || !m[2] || !checksMoved(wt, base, `${m[1]}/${m[2]}`)) continue;
      const report = `${wt}/${m[1]}/${m[2]}/report.md`;
      if (!isFile(`${wt}/${m[1]}/${m[2]}/spec.md`) || !isFile(report)) continue;
      if (!reportClaimsComplete(readFileSync(report, "utf8"))) continue;
      const entry = specs.find(([proj]) => proj === m[1]);
      if (entry) entry[1].add(m[2]);
      else specs.push([m[1], new Set([m[2]])]);
    }
    // And a spec this repo's close already owes whose block now declares other
    // checks than the ones owed, changed or not since <base>: a push that failed
    // after recording them, and was then undone, leaves obligations the
    // declaration no longer says.
    const declRepo = shared.replace(/\/+$/, "");
    const owedBy = new Map<string, string[]>();
    for (const o of readLiveOwed()) {
      if (o.declRepo !== declRepo) continue;
      owedBy.set(o.spec, [...(owedBy.get(o.spec) ?? []), JSON.stringify([o.id, o.target, o.kind, o.body])]);
    }
    for (const [spec, held] of owedBy) {
      const m = /^(projects\/[^/]+\/[^/]+)\/(specs\/[^/]+)$/.exec(spec);
      const rel = `${wt}/${spec}/tasks.md`;
      if (!m?.[1] || !m[2]) continue;
      // A tasks.md no longer there declares nothing, so what it owed is cleared.
      const declared = parseLiveChecks(isFile(rel) ? readFileSync(rel, "utf8") : "").checks.map((c) =>
        JSON.stringify([c.id, c.target, c.kind, c.body]),
      );
      if ([...declared].sort().join("\n") === [...held].sort().join("\n")) continue;
      const entry = specs.find(([proj]) => proj === m[1]);
      if (entry) entry[1].add(m[2]);
      else specs.push([m[1], new Set([m[2]])]);
    }
    if (specs.length === 0) return;
    let owed = readLiveOwed();
    const passed = readPassed();
    let changed = false;
    const declShared = shared.replace(/\/+$/, "");
    for (const [proj, names] of specs) {
      for (const spec of [...names].sort()) {
        // A report already `complete` at the base is not written complete by
        // this push, only edited: its checks were owed, and proved, by the close
        // that finished it, and may serve a repo this thread lands nothing in —
        // otherwise a typo fix in a finished report is refused for checks on a
        // repo it never touched. Not skipped: a spec this close already owes,
        // and one whose live-checks block this push changes.
        const owedHere = owed.some((o) => o.spec === `${proj}/${spec}`);
        if (
          !owedHere &&
          !checksMoved(wt, base, `${proj}/${spec}`) &&
          wasComplete(wt, base, `${proj}/${spec}/report.md`)
        )
          continue;
        const rel = `${proj}/${spec}/tasks.md`;
        // The key names the project too: projects reuse spec names (`001-main`).
        const name = `${basename(proj).replace(/^\d{4}-\d{2}-\d{2}_/, "")}/${spec.replace(/^specs\//, "")}`;
        const before = owed.length;
        owed = owed.filter((o) => o.spec !== `${proj}/${spec}`);
        if (owed.length !== before) changed = true;
        for (const k of Object.keys(passed)) {
          if (!k.startsWith(`${name}/`)) continue;
          delete passed[k];
          changed = true;
        }
        if (!isFile(`${wt}/${rel}`)) continue;
        const p = parseLiveChecks(readFileSync(`${wt}/${rel}`, "utf8"));
        for (const w of p.warnings) say(`  live-checks: ${rel}:${w}`);
        if (p.errors.length > 0) {
          for (const e of p.errors) warn(`  ${rel}:${e}`);
          notClosed(`the live-checks block in ${rel} is malformed — line ${p.errors[0]}`);
        }
        for (const c of p.checks) {
          const key = `${name}/${c.id}`;
          if (owed.some((o) => o.key === key)) notClosed(`two specs declare the live check ${key} — rename one`);
          const repo = await targetRepo(c.target, declShared, `${rel}:${c.line}`);
          owed.push({
            key,
            spec: `${proj}/${spec}`,
            id: c.id,
            target: c.target,
            kind: c.kind,
            body: c.body,
            declRepo: declShared,
            repo,
            commit: LANDED_NOW.get(repo) ?? "",
          });
          changed = true;
        }
      }
    }
    if (!changed) return;
    writePassed(passed);
    writeLiveOwed(owed);
  };

  // proveLive — --release's proof. Returns the report's lines; any
  // failure is one stderr line per check and NOT CLOSED, the hold kept.
  // runTree <repo> — a clean, detached checkout of the commit <repo> last
  // landed, under the thread state, where its command checks run. Not the
  // shared checkout: a landing leaves that behind or dirty when another
  // session holds it, and a check read from it can be older than what deployed.
  // A tree left by a release that stopped is removed before a new one is made.
  const RUN_TREES = new Map<string, string>();
  // timeout(1) where it exists (GNU coreutils), else gtimeout (coreutils on
  // macOS through Homebrew), else null. Asked once per run. LAND_TIMEOUT_BINS
  // (space-separated) replaces the candidates — the suite's seam for a host
  // with neither.
  let TIMEOUT_BIN: string | null | undefined;
  // timeout -k 5 <secs> <cmd…> where neither timeout program exists, run as
  // `node -e GROUP_LIMIT <secs> <cmd…>`: the command leads a process group of
  // its own, and at the limit the whole group is signalled, so a child it
  // started dies with it and the output pipes close.
  const GROUP_LIMIT = `const { spawn } = require("node:child_process");
const [secs, cmd, ...args] = process.argv.slice(1);
const c = spawn(cmd, args, { stdio: "inherit", detached: true });
let timedOut = false;
const group = (sig) => { try { process.kill(-c.pid, sig); } catch {} };
const t = setTimeout(() => {
  timedOut = true;
  group("SIGTERM");
  setTimeout(() => group("SIGKILL"), 5000).unref();
}, Number(secs) * 1000);
c.on("error", () => process.exit(127));
c.on("exit", (code, sig) => {
  clearTimeout(t);
  if (timedOut) { group("SIGKILL"); process.exit(124); }
  process.exit(code ?? (sig ? 128 : 1));
});`;
  const timeoutBin = (): string | null => {
    if (TIMEOUT_BIN !== undefined) return TIMEOUT_BIN;
    TIMEOUT_BIN = null;
    const candidates = process.env.LAND_TIMEOUT_BINS ?? "timeout gtimeout";
    for (const b of candidates.split(/\s+/).filter(Boolean)) {
      if (spawnSync(b, ["--version"], { stdio: "ignore" }).status === 0) {
        TIMEOUT_BIN = b;
        break;
      }
    }
    return TIMEOUT_BIN;
  };
  const runTree = (repo: string, fallback: string): string => {
    const hit = RUN_TREES.get(repo);
    if (hit) return hit;
    const sha = landedShaFor(repo) ?? fallback;
    const dir = `${STATE}/live-run/${basename(repo)}`;
    git(repo, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
    mkdirSync(dirname(dir), { recursive: true });
    if (!sha || !git(repo, ["worktree", "add", "-q", "--detach", dir, sha]).ok)
      notClosed(
        `could not check out ${short(sha)} of ${repo} to run its live checks — git worktree add failed; re-run`,
      );
    // A check imports packages the way the repo's own checkout resolves them: from
    // the nearest node_modules at or above it (a shared one in a parent folder
    // of every checkout included). The run tree sits under the thread state,
    // above which there is none, so it gets a link to that one. Without it no
    // TypeScript check that imports a package could pass ("Cannot find package").
    for (let up = resolve(repo); ; up = dirname(up)) {
      if (existsSync(join(up, "node_modules"))) {
        symlinkSync(join(up, "node_modules"), join(dir, "node_modules"));
        break;
      }
      if (dirname(up) === up) break;
    }
    RUN_TREES.set(repo, dir);
    return dir;
  };
  const dropRunTrees = (): void => {
    for (const [repo, dir] of RUN_TREES) {
      git(repo, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
      git(repo, ["worktree", "prune"]);
    }
    RUN_TREES.clear();
  };

  const proveLive = async (): Promise<string[]> => {
    const owed = readLiveOwed();
    if (owed.length === 0) return [];
    const passed = readPassed();
    const fails: string[] = [];
    const lines: string[] = [];
    const targets = [...new Set(owed.filter((o) => o.commit).map((o) => o.target))];
    // The checkout a target is read from: the repo its obligations bind to.
    const repoOf = (t: string): string => owed.find((o) => o.target === t && o.commit)?.repo ?? "";
    const before = new Map<string, Revision | null>();
    for (const t of targets) {
      try {
        before.set(t, await readLive(t, repoOf(t)));
      } catch (e) {
        before.set(t, null);
        fails.push(`live check(s) on ${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const timeout = Number(process.env.LAND_LIVE_CHECK_TIMEOUT || "120");
    const seen = new Map<string, ReturnType<typeof contains>>();
    for (const o of owed) {
      if (!o.commit) {
        fails.push(
          `live check ${o.key}: ${o.repo} has not landed in this close, so ${o.target} has no commit to check`,
        );
        continue;
      }
      const rev = before.get(o.target);
      if (!rev) continue;
      const live = rev.sourceCommit;
      if (live === null) {
        fails.push(`live check ${o.key}: ${cannotTell(o.target, rev)}`);
        continue;
      }
      const ck = `${o.repo}\t${o.commit}\t${live}`;
      const has = seen.get(ck) ?? contains(o.repo, o.commit, live);
      seen.set(ck, has);
      if (has === "not") {
        fails.push(
          `live check ${o.key}: the live ${o.target} does not contain ${short(o.commit)} (it serves ${short(live)})`,
        );
        continue;
      }
      if (has === "unreadable") {
        fails.push(`live check ${o.key}: the live ${o.target} serves ${short(live)}, which ${o.repo} does not have`);
        continue;
      }
      const at = `${o.target} at ${short(rev.deploymentId)}`;
      if (o.kind === "command") {
        // Through timeout(1), which signals the whole process group of the command:
        // a child the command started (a sleep, a server) would otherwise keep
        // the output pipes open past the kill. Its 124 is the timeout. Stock
        // macOS has no timeout(1): there coreutils' gtimeout, else GROUP_LIMIT, a
        // Node supervisor that does the same — bash in a process group of its
        // own, TERM to the group at the limit, KILL five seconds later, exit 124.
        // Under this call's own limit alone, bash was killed and a child it
        // started outlived the check (Contextium v9.2.0 review).
        const script = ["bash", "-c", `set -euo pipefail\n${o.body}`];
        const tbin = timeoutBin();
        const argv =
          tbin === null
            ? [process.execPath, "-e", GROUP_LIMIT, String(timeout), ...script]
            : [tbin, "-k", "5", String(timeout), ...script];
        const r = spawnSync(argv[0] ?? "bash", argv.slice(1), {
          cwd: runTree(o.declRepo, o.repo === o.declRepo ? o.commit : ""),
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: (timeout + 30) * 1000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024 * 1024,
        });
        const tail = chomp(`${r.stdout ?? ""}${r.stderr ?? ""}`)
          .split("\n")
          .slice(-20)
          .join("\n");
        const timedOut = r.error !== undefined || r.signal !== null || r.status === 124 || r.status === 137;
        const code = timedOut ? -1 : (r.status ?? 1);
        passed[o.key] = { key: o.key, revision: rev, result: { exit: code, tail }, time: new Date().toISOString() };
        if (code !== 0) {
          for (const l of tail.split("\n").filter(Boolean)) warn(`    ${l}`);
          fails.push(
            timedOut
              ? `live check ${o.key} failed: killed after ${timeout} s`
              : `live check ${o.key} failed (exit ${code}): ${lastLine(tail, "no output")}`,
          );
          continue;
        }
        lines.push(`${o.key} — \`${o.body}\` passed on ${at}`);
        continue;
      }
      const rec = passed[o.key];
      if (!rec?.revision || !rec.file) {
        fails.push(
          `live check ${o.key} has no evidence — land.ts --live-start ${o.key}; capture it; land.ts --live-pass ${o.key} <file> --saw "<what it shows>"`,
        );
        continue;
      }
      if (rec.revision.deploymentId !== rev.deploymentId) {
        fails.push(
          `live check ${o.key}: its evidence was taken on ${short(rec.revision.deploymentId)} and ${short(rev.deploymentId)} is live now — the record is void; --live-start ${o.key}, capture again, --live-pass`,
        );
        continue;
      }
      lines.push(
        `${o.key} — expected: ${o.body} — saw: ${rec.saw ?? ""} ([${basename(rec.file)}](<${rec.file}>)) on ${at}`,
      );
    }
    dropRunTrees();
    writePassed(passed);
    // What was checked must still be what is live.
    for (const t of targets) {
      const a = before.get(t);
      if (!a) continue;
      try {
        const b = await readLive(t, repoOf(t));
        if (b.deploymentId !== a.deploymentId)
          fails.push(
            `the live ${t} changed during the checks (${short(a.deploymentId)} → ${short(b.deploymentId)}) — run land.ts --release again`,
          );
      } catch (e) {
        fails.push(`live check(s) on ${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (fails.length > 0) {
      for (const f of fails) warn(`  ${f}`);
      notClosed(fails.length === 1 ? (fails[0] ?? "") : `${fails.length} live checks not proved — ${fails[0]}`);
    }
    return lines;
  };

  // requireVerified — VERIFY RAN, ON THIS CONTENT. § 1 of the close was a step
  // the model had to remember, and nothing here checked it: every `verify` in
  // this file was a comment. verify.ts records what it passed on, and its
  // --stamped answers whether that is still what every worktree holds; the
  // records the close writes after it (journal, project README and ROADMAP,
  // the rows promoted above) do not count. Asked once, at the first commit or
  // push of the run — after the gates, which refuse on their own terms first —
  // and a missing or crashing verify.ts is refused, never read as a pass.
  let VERIFIED = false;
  const requireVerified = (): void => {
    if (VERIFIED) return;
    if (!isFile(VERIFY)) notClosed(`verify check missing: ${VERIFY}`);
    // The thread is named, not looked up again: it is this run's own.
    const stamp = run(process.execPath, nodeArgs(VERIFY, ["--stamped"]), {
      out: "pipe",
      err: "pipe",
      env: { ...process.env, WORKBENCH_THREAD_ID: TID },
    });
    const why = chomp(stamp.stderr)
      .split("\n")
      .filter((l) => l.startsWith("verify: "));
    if (stamp.status === 1 && why.length > 0) {
      for (const l of why) say(`  ${l}`);
      notClosed("verify has not passed on this worktree as it is now — run verify.ts, then close again");
    }
    if (!stamp.ok) {
      const said = lastLine(chomp(`${stamp.stdout}\n${stamp.stderr}`), "no message");
      notClosed(`verify check could not run (exit ${stamp.status}): ${said}`);
    }
    VERIFIED = true;
  };

  // ONE LOCK PER REPO, the same one write-root.sh takes and any automated
  // committer should, so a close and an automation cannot interleave a merge
  // and a push on one remote. It is lock.sh's `lock_repo` — flock(1) where it
  // exists, a portable lock where not (stock macOS) — so only lock.sh itself
  // can take it compatibly with both modes, and Node has no flock(2) anyway.
  // A bash child sources lock.sh, takes the lock with the same 120 s wait, and
  // holds it for as long as its stdin stays open. Closing its stdin releases
  // it through `lock_repo_release`, and so does this process ending on any
  // exit, because the pipe closes with it. It reads stdin with a plain `cat`,
  // not `exec cat`: the portable lock is released by lock.sh's EXIT trap,
  // which an exec would drop.
  const takeLock = (lock: string): Promise<ChildProcess | null> =>
    new Promise((done) => {
      const child = spawn(
        "bash",
        [
          "-c",
          '. "$0"; lock_repo "$1" 120 || exit 1; echo locked; cat >/dev/null; lock_repo_release "$1"',
          LOCK_SH,
          lock,
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let seen = "";
      child.stdout?.on("data", (b: Buffer) => {
        seen += b.toString();
        if (seen.includes("locked\n")) done(child);
      });
      child.on("error", () => done(null));
      child.on("exit", () => done(null));
    });
  const releaseLock = (child: ChildProcess): Promise<void> =>
    new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.on("exit", () => done());
      child.stdin?.end();
    });

  const landOne = async (WT: string, SHARED: string, BRANCH: string): Promise<void> => {
    // A deploy an earlier run left owed. A retry with NOTHING new to land
    // re-polls it on each of the two early returns below. One WITH new work
    // lands first, because the old SHA's run stays failed for good and the fix
    // is exactly that new work: its push, a descendant of the owed SHA, takes
    // the obligation over, and its completed run settles it (see the deploy
    // bookkeeping after the push). A new push that owes no run cannot settle it,
    // so there the old SHA is polled again.
    const OWED_SHA = owedShaFor(SHARED);

    // An obligation is never dropped. A worktree that vanished before it was
    // landed took uncommitted or unpushed work with it, and the close must say so
    // rather than quietly closing without it.
    const SHARED_KEY = SHARED.replace(/\/+$/, "");
    if (!isDir(WT)) {
      const gone = landedShaFor(SHARED);
      if (gone !== null) {
        if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA);
        LANDED_NOW.set(SHARED_KEY, gone);
        bindLive(SHARED, gone, false);
        return;
      }
      notClosed(`worktree missing before landing: ${WT}`);
    }

    // Already landed AND nothing has happened since. Both halves are needed. A
    // partly-failed close re-runs through here and must not re-land what it
    // already landed — but a session that kept working after its close (the
    // mid-graph callers do exactly that) has new commits, and skipping on the
    // mere PRESENCE of a SHA would strand them with no warning at all.
    const PREV = landedShaFor(SHARED);
    if (PREV !== null) {
      const status = wtStatus(WT);
      if (PREV === chomp(git(WT, ["rev-parse", "HEAD"]).stdout) && status === "") {
        // A DEFERRED satellite landed on an earlier run that then failed before
        // the end, so its removal never happened. Queue it again, or the retry
        // that succeeds leaves it and its branch on disk under the proof line.
        if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA);
        LANDED_NOW.set(SHARED_KEY, PREV);
        bindLive(SHARED, PREV, false);
        if ((T3_WORKTREE || NO_OWN_WORKTREE) && WT !== T3_WORKTREE && removalIsDeferred(WT)) {
          DEFERRED_REMOVALS.push([WT, SHARED, BRANCH]);
        }
        return;
      }
    }

    // ONE LOCK PER REPO (see takeLock).
    const LOCK = `/tmp/${basename(SHARED)}-git.lock`;
    const lock = await takeLock(LOCK);
    if (!lock) notClosed(`could not take ${LOCK} within 120s — another writer holds it`);

    // AN UNRESOLVED CONFLICT IS NOT "DIRTY", IT IS UNFINISHED. A close that
    // conflicted left the worktree with unmerged index entries and the markers in
    // the files. Re-running lands here, where `git add -A` would mark every one of
    // them resolved and commit `<<<<<<<` straight to the trunk — the close
    // would then print the safe-to-close line over a corrupted tree. The conflict
    // test covers the retry as well as the first run for this reason.
    const um = git(WT, ["diff", "-z", "--name-only", "--diff-filter=U"]);
    if (!um.ok) notClosed(`could not list the unmerged paths in ${WT} — git diff failed; re-run`);
    const UNMERGED = um.stdout.split("\0").filter((p) => p !== "");
    if (UNMERGED.length > 0) {
      notClosed(`unresolved conflict in ${WT}: ${UNMERGED.join(" ")} — resolve it, then re-run`);
    }

    // WHERE THIS BRANCH LEFT THE TRUNK, which every gate below and the audit
    // lines measure "changed" from. The trunk is resolved and FETCHED here,
    // ahead of them, rather than after the commit where the merge below first
    // needs it: `trunk.ts` can name a trunk from origin/HEAD before
    // `origin/<trunk>` exists locally, and only the fetch creates it. Measuring
    // from a ref that is not there would refuse every close.
    const trunk = trunkOf(SHARED);
    if (trunk === null)
      notClosed(`no trunk branch in ${SHARED} (origin/HEAD unset and no origin/main or origin/master)`);
    const TRUNK = trunk;
    if (!git(WT, ["fetch", "-q", "origin", TRUNK], { out: "inherit" }).ok)
      notClosed(`could not fetch origin/${TRUNK} for ${SHARED}`);
    const mb = git(WT, ["merge-base", "HEAD", `origin/${TRUNK}`]);
    if (!mb.ok)
      notClosed(`git merge-base HEAD origin/${TRUNK} failed in ${WT}, so its decision records cannot be scoped`);
    const DR_BASE = chomp(mb.stdout);

    // The audit lines of every spec this push changed go into the entry before
    // the schema check reads it: written, never required.
    if (holdsJournal(WT)) quoteAuditLines(WT, DR_BASE);

    // THE JOURNAL ENTRY GATE. This is the last point before an entry is committed:
    // front matter a reader cannot parse makes the session invisible to anything
    // that reads the journal rather than loud, and a body outside journal-entry.md's schema
    // is the decision prose the schema exists to stop, so both are checked
    // before the commit, not after. Only the worktree holding the journal path
    // is asked — the workbench row, whichever repo the thread was opened on.
    //
    // A MISSING CHECKER REFUSES, it does not skip. An `isFile(FM_CHECK)` guard
    // would turn the gate off with no word said the day the script is renamed or
    // not shipped — the same silent `[ -f ]` the decision-record gate below
    // refuses to copy. An entry about to be committed
    // with no checker on disk is a close that cannot say it checked.
    const FM_CHECK = `${SCRIPT_DIR}/check-journal-entry.ts`;
    const journalGate = (): void => {
      if (!holdsJournal(WT)) return;
      const JREL = journalRel();
      if (JREL !== null && isFile(`${WT}/${JREL}`)) {
        if (!isFile(FM_CHECK)) notClosed(`journal check missing: ${FM_CHECK}`);
        const r = run(process.execPath, nodeArgs(FM_CHECK, [JREL]), {
          cwd: WT,
          env: { ...process.env, PWD: WT },
          out: "inherit",
          err: "inherit",
        });
        if (!r.ok) notClosed(`journal entry fails the schema: ${WT}/${JREL}`);
      }
    };
    journalGate();

    // THE DECISION-RECORD GATE: check-decision-records.ts, over the records this
    // worktree changed. Before the commit for the same reason as the journal gate
    // above — once `git add -A` runs, a malformed record is on its way to the
    // trunk — but for EVERY repo, not just the records one: a `decisions/` folder
    // lives at a repo root, a project folder or a product repo alike.
    //
    // It FAILS rather than skips when records changed and no checker resolved.
    // A silent `[ -f ]` guard is how a check goes quiet the day its script moves; a
    // gate that stops firing without a word is worse than none, because the close
    // still reads as checked.
    // Nothing changed means nothing to check, so an unresolvable checker costs
    // that close nothing.
    //
    // The checker is resolved once from the ledger's WORKTREES (DR_CHECK, below),
    // never from a shared checkout: a shared checkout is fast-forwarded only after
    // its commit, and only when clean, so the close that ADDS the script could
    // never see it there.
    //
    // "Changed" is measured from where this branch left the trunk, NOT from HEAD:
    // /implement commits in the worktree before it closes, and a record already
    // committed differs from nothing at HEAD: measured from HEAD, a close would
    // count 0 records and land the record unchecked.
    //
    // Every path through this block falls through to the staging below. A
    // `return` here leaves landOne with nothing committed.
    if (DR_CHECK) {
      refuseOnCheck(DR_CHECK, WT, DR_BASE, "decision record");
    } else if (changedDecisionRecords(WT, DR_BASE)) {
      notClosed(
        `decision records changed in ${WT}, but no worktree this thread owns holds ${DR_CHECK_REL} — run write-root.sh on the workbench checkout, then close again`,
      );
    }

    // THE INTEGRATION-MANIFEST GATE: check-integration-manifest.ts, over the
    // integrations/*/README.md this worktree changed, the same way as the
    // decision-record gate above — when the workbench ships that checker. A
    // workbench without one has no manifest schema to hold them to, so a changed
    // manifest is reported, not refused.
    if (IM_CHECK) {
      refuseOnCheck(IM_CHECK, WT, DR_BASE, "integration manifest");
    } else if (changedIntegrationManifests(WT, DR_BASE)) {
      say(`  note: integration manifests changed in ${WT}; no ${IM_CHECK_REL} to check them`);
    }

    // THE SCRIPT-TESTS GATE: check-scripts.ts, over the scripts this worktree
    // changed — every one must carry a paired test, and a program's test must run
    // it rather than import it — and over every file under .agents/ for its
    // language (part (c): no JavaScript or Python, bash only in the tier
    // AGENTS.md § Standards → Scripts are TypeScript names). Same shape and
    // reasons as the two gates above; every repo is asked, and one with no
    // .agents/ has nothing for it to check.
    if (SC_CHECK) {
      refuseOnCheck(SC_CHECK, WT, DR_BASE, "script tests");
    } else if (changedScripts(WT, DR_BASE)) {
      notClosed(
        `scripts changed in ${WT}, but no worktree this thread owns holds ${SC_CHECK_REL} — run write-root.sh on the workbench checkout, then close again`,
      );
    }

    // THE SKILL-MANIFEST GATE: .agents/checks/check-skills.ts, over the skill folders
    // this worktree changed. The checker is the worktree's OWN file (it ships in
    // the same tree as the skills it checks), so there is no ledger lookup and no
    // deferred removal. A worktree branched from before the checker was there is
    // refused rather than landed unchecked, the way a missing workbench checker is.
    const SK_CHECK = `${WT}/.agents/checks/check-skills.ts`;
    if (isFile(SK_CHECK) && changedSkillTree(WT, DR_BASE)) {
      refuseOnCheck(SK_CHECK, WT, DR_BASE, "skill manifest");
    } else if (!isFile(SK_CHECK) && changedSkillManifests(WT, DR_BASE)) {
      notClosed(
        `skill manifests changed in ${WT}, but ${WT} holds no .agents/checks/check-skills.ts — merge origin/${TRUNK} into the branch, then close again`,
      );
    }

    // THE WORKBENCH GATE: check-roadmap-decisions.ts, over the projects this
    // worktree changed — a ROADMAP row or a spec report left open refuses the
    // close (auto-close-gate.md precondition (iii) says what "open" means).
    // Workbench only: the checker is the worktree's OWN copy, like the
    // skill-manifest gate's, and a worktree of any other repo is never run
    // against it. A workbench worktree with a project change and no checker is
    // refused, never skipped.
    //
    // It runs twice: here, over the branch, and after the trunk merge below
    // when it brought commits in, because two branches that each pass can fail
    // together (one adds a row that depends on a row the other closes).
    const IS_WORKBENCH = isFile(`${WT}/.agents/skills/close/scripts/land.ts`);
    const workbenchGates = (base: string): void => {
      if (!IS_WORKBENCH) return;
      const paths = changedPaths(WT, base);
      const gates: Array<[string, (p: string[]) => boolean, string]> = [
        [".agents/skills/close/scripts/check-roadmap-decisions.ts", touchesProjects, "something left open in a roadmap or report"],
      ];
      for (const [rel, touches, what] of gates) {
        if (!touches(paths)) continue;
        if (!isFile(`${WT}/${rel}`)) {
          notClosed(
            `${what} inputs changed in ${WT}, but ${WT} holds no ${rel} — merge origin/${TRUNK} into the branch, then close again`,
          );
        }
        refuseOnCheck(`${WT}/${rel}`, WT, base, what);
      }
    };
    // A finished spec's row is `done` before the gates read it, so the roadmap
    // gate sees what lands rather than refusing an `in-progress` row. The edits
    // ride the commit below.
    promoteFinishedRows(WT, DR_BASE);
    workbenchGates(DR_BASE);

    // THE MERGED TREE, CHECKED BY EACH APP THE BRANCH TOUCHED. verify.ts ran
    // those apps' own `check` on the branch, before the trunk was merged in; a
    // trunk change can pass alone and fail beside this one: a shared builder
    // gains an argument on one branch while another adds a caller of it, each
    // type-checks, and the merged tree does not. So after a merge that brought
    // commits in, each workbench app the branch changed runs its own `check`
    // (not its tests — verify.ts ran those, and the type-check is what a merge
    // breaks without a conflict) over the merged tree, and a failure refuses
    // the push — on the attempt that merged and on every retry until the tree
    // passes.
    //
    // A branch that changes shared code (`integrations/`, `packages/`) breaks
    // the same way through a caller the trunk brought in, and touches no app at
    // all; so every unit in the merged tree importing a changed shared file —
    // an app, an integration or a package, followed through barrels and other
    // shared modules in turn — runs its check too, and so does each
    // integration or package the branch changed. Who imports what is
    // importers.ts's answer, the one verify.ts's importer pass also reads: an
    // app importing a package's index.ts reached no check when p.ts changed
    // (third v9.2.0 review), and a trunk integration calling a package whose
    // signature this branch changed reached none either, because only apps
    // were checked (Contextium v9.2.0 review).
    const mergedAppChecks = (base: string): void => {
      if (!IS_WORKBENCH) return;
      // Each changed file's app is the nearest folder under apps/ holding a
      // package.json, as verify.ts finds it; an integration's or package's is
      // its `integrations/<name>` or `packages/<name>` folder.
      const apps = new Set<string>();
      const appOf = (p: string): void => {
        const unit = sharedUnit(p);
        if (unit !== null) {
          if (isFile(`${WT}/${unit}/package.json`)) apps.add(unit);
          return;
        }
        for (let dir = dirname(p); dir.startsWith("apps/"); dir = dirname(dir)) {
          if (isFile(`${WT}/${dir}/package.json`)) {
            apps.add(dir);
            break;
          }
        }
      };
      const changed = changedPaths(WT, base);
      for (const p of changed) appOf(p);
      let importers: string[] = [];
      try {
        importers = importerClosure(WT, changed);
      } catch (e) {
        notClosed(
          `could not read the code in ${WT} for importers of the shared code it changed — ${(e as Error).message}`,
        );
      }
      for (const p of importers) appOf(p);
      for (const app of [...apps].sort()) {
        const pkg = `${WT}/${app}/package.json`;
        let check: unknown;
        try {
          check = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, unknown> }).scripts?.check;
        } catch {
          notClosed(`${pkg} is not JSON, so ${app}'s check cannot run on the merged tree`);
        }
        if (typeof check !== "string") continue;
        const r = run("npm", ["run", "--silent", "check"], {
          cwd: `${WT}/${app}`,
          env: { ...process.env, PWD: `${WT}/${app}` },
          out: "pipe",
          err: "pipe",
        });
        if (r.ok) continue;
        const lines = chomp(`${r.stdout}\n${r.stderr}`)
          .split("\n")
          .filter((l) => l.trim() !== "");
        process.stderr.write(lines.map((l) => `  ${l}\n`).join(""));
        const first = lines.find((l) => /\berror\b/i.test(l)) ?? lines[0] ?? `npm run check exited ${r.status}`;
        notClosed(`${app}'s check fails on the merged tree in ${WT}: ${first.trim()}`);
      }
    };


    // THE SECRETS GATE: check-secrets.ts over what this worktree changed, for
    // every repo, from the workbench worktree that holds the checks. A credential
    // committed is a credential leaked, whichever repo it lands in.
    if (SEC_CHECK) refuseOnCheck(SEC_CHECK, WT, DR_BASE, "secret scan");

    // Verify passed on this content (requireVerified), asked after the gates,
    // which refuse on their own terms first, and before anything is staged.
    requireVerified();
    const DIRTY = wtStatus(WT) !== "";
    if (DIRTY && !git(WT, ["add", "-A"], { out: "inherit", err: "inherit" }).ok) notClosed(`could not stage ${WT}`);

    // THE STANDARDS GATE: every `§ Standards → <Name>` citation in the workbench
    // names a bullet that exists. Only the worktree that carries AGENTS.md's
    // Standards — the one holding this checker — is asked; the checker reads
    // git's view, not a range, so it runs AFTER staging and over the staged
    // copies (`--cached`): run before `git add`, its `git grep` never saw a new
    // file, and the file was then committed unchecked.
    if (STD_CHECK && WT === STD_CHECK_WT)
      refuseOnCheck(STD_CHECK, WT, DR_BASE, "standards citations", ["--cached"]);

    if (DIRTY && !git(WT, ["commit", "-q", "-m", SUBJECT], { out: "inherit", err: "inherit" }).ok)
      notClosed(`could not commit ${WT}`);

    // THE JOURNAL NAME, RE-CHECKED. journal-file.ts already looked at the trunk,
    // but another thread may have landed the same name in the minutes since. Two
    // sessions' entries merging into one path is the shared-write failure the
    // one-file-per-session shape exists to remove, so this renames rather than
    // merges.
    if (holdsJournal(WT)) {
      const REL = journalRel();
      if (REL !== null) {
        // "THE NAME IS TAKEN" MUST MEAN TAKEN BY SOMEBODY ELSE. A close that runs
        // twice — a failed Land, or a correction to an entry already pushed —
        // finds its OWN file sitting on the trunk, and a bare existence test
        // reads that as a collision and renames it: the second run would move this
        // session's landed entry to `-2` for no reason, and a third to `-3`.
        //
        // The question is whose commit put it there. If the commit that last
        // touched that path on the trunk is an ancestor of this worktree's
        // HEAD, it is ours — we pushed it. Anyone else's is not.
        let OWNER = "";
        if (git(WT, ["cat-file", "-e", `origin/${TRUNK}:${REL}`], { out: "inherit" }).ok) {
          OWNER = chomp(git(WT, ["rev-list", "-1", `origin/${TRUNK}`, "--", REL]).stdout);
        }
        if (OWNER && !git(WT, ["merge-base", "--is-ancestor", OWNER, "HEAD"], { out: "inherit" }).ok) {
          const DIR = dirname(REL);
          const name = basename(REL);
          const STEM = name.endsWith(".md") && name !== ".md" ? name.slice(0, -3) : name;
          let N = 1;
          let NEWREL = "";
          for (;;) {
            N += 1;
            NEWREL = `${DIR}/${STEM}-${N}.md`;
            if (git(WT, ["cat-file", "-e", `origin/${TRUNK}:${NEWREL}`], { out: "inherit" }).ok) continue;
            if (existsSync(`${WT}/${NEWREL}`)) continue;
            break;
          }
          if (!git(WT, ["mv", REL, NEWREL], { out: "inherit", err: "inherit" }).ok)
            notClosed(`could not rename ${REL} around a collision`);
          if (
            !git(WT, ["commit", "-q", "-m", `${SUBJECT} (journal renamed around a collision)`], {
              out: "inherit",
              err: "inherit",
            }).ok
          ) {
            notClosed("could not commit the journal rename");
          }
          writeAtomic(JOURNAL_REF, `${WT}/${NEWREL}\n`);
          say(`  journal renamed: ${REL} was taken on origin/${TRUNK}, using ${NEWREL}`);
        }
      }
    }

    // NO REBASE AND NO PULL. A conflict halts with both sides intact in this
    // thread's own worktree; re-running the close reclaims it and resumes here.
    //
    // ROADMAP.md MERGES ROW BY ROW. Two sessions landing two rows of one project
    // each flip their own row, and git's line merge calls two adjacent rows a
    // conflict — so the second of two parallel closes always stopped here. The
    // driver merges the table by row ID and still conflicts on a real clash.
    registerRoadmapMerge(WT);
    if (!git(WT, ["merge-base", "--is-ancestor", `origin/${TRUNK}`, "HEAD"], { out: "inherit" }).ok) {
      if (!git(WT, ["merge", "-q", "--no-edit", `origin/${TRUNK}`], { out: "inherit" }).ok) {
        notClosed(`conflict in ${WT}`);
      }
      // The merged tree is what the push publishes, and the trunk's commits
      // are new to it: the workbench gates again, measured from the new merge
      // base. A refusal leaves the merge committed here, unpushed; the re-run
      // finds the trunk already merged and judges the same tree before its
      // commit.
      const mb2 = git(WT, ["merge-base", "HEAD", `origin/${TRUNK}`]);
      if (!mb2.ok) notClosed(`git merge-base HEAD origin/${TRUNK} failed in ${WT} after the merge`);
      // Promotion again, on the merged tree: the trunk can bring a row naming
      // this push's finished spec. Measured from the new merge base, the
      // reports are still this push's alone — another session's, merged in,
      // are not, and its rows are never touched.
      const promoted = promoteFinishedRows(WT, chomp(mb2.stdout));
      if (promoted.length > 0) {
        if (
          !git(WT, ["add", "--", ...promoted], { out: "inherit", err: "inherit" }).ok ||
          !git(WT, ["commit", "-q", "-m", `${SUBJECT} (finished rows set done on the merged table)`], {
            out: "inherit",
            err: "inherit",
          }).ok
        ) {
          notClosed(`could not commit the rows set done on the merged table in ${WT}`);
        }
      }
      // The audit lines again, from the merged specs: the trunk can have
      // changed a verdict in a spec this push also changed. The entry is
      // judged again before it is committed.
      const quoted = holdsJournal(WT) ? quoteAuditLines(WT, chomp(mb2.stdout)) : null;
      if (quoted !== null) {
        journalGate();
        if (
          !git(WT, ["add", "--", quoted], { out: "inherit", err: "inherit" }).ok ||
          !git(WT, ["commit", "-q", "-m", `${SUBJECT} (audit lines quoted from the merged specs)`], {
            out: "inherit",
            err: "inherit",
          }).ok
        ) {
          notClosed(`could not commit the audit lines quoted from the merged specs in ${WT}`);
        }
      }
      workbenchGates(chomp(mb2.stdout));
    }
    // On every attempt whose branch holds a trunk merge not yet pushed — the one
    // just made, or one a refused attempt left committed — so a retry of a
    // refusal is judged again rather than pushed.
    const unpushedMerges = git(WT, ["rev-list", "--merges", `origin/${TRUNK}..HEAD`]);
    if (!unpushedMerges.ok)
      notClosed(`could not list the merges ${WT} holds past origin/${TRUNK} — git failed; re-run`);
    if (chomp(unpushedMerges.stdout) !== "") {
      const mb3 = git(WT, ["merge-base", "HEAD", `origin/${TRUNK}`]);
      if (!mb3.ok) notClosed(`git merge-base HEAD origin/${TRUNK} failed in ${WT} before the push`);
      mergedAppChecks(chomp(mb3.stdout));
    }
    // Every attempt, not only the one that merged: a re-run after a failed
    // re-derive finds trunk already merged, and must not push past it.
    resyncNext(WT, `origin/${TRUNK}`);
    // The Next line, from the project as it is about to land (see PROJECT_REL).
    if (PROJECT_REL && holdsJournal(WT)) deriveNext(`${WT}/${PROJECT_REL}`);

    // THE REVIEW RECEIPT, OF WHAT IS ABOUT TO BE PUSHED. verify.ts asked it
    // before the first commit; the trunk merge above
    // can move the covered content since — another session's edit to a file
    // this branch changed, or to a caller or instruction its review depended on.
    // The same reader asks again of the tree the push publishes. A stale
    // receipt is not reviewed here: the close stops, names the moved paths, and
    // leaves the merge and the receipt in place, so the remaining review
    // allowance (validate.ts --phase review --since) or restoring the reviewed
    // bytes recovers it. Nothing here resets an allowance or opens a new owner.
    if (!isFile(AUDIT)) notClosed(`review receipt reader missing: ${AUDIT}`);
    const receipt = run(process.execPath, nodeArgs(AUDIT, ["check", "--owner", TID, WT]), { out: "pipe", err: "pipe" });
    if (!receipt.ok) {
      const why = chomp(receipt.stderr)
        .split("\n")
        .filter((l) => l.startsWith("review: "));
      for (const l of why) say(`  ${l}`);
      notClosed(
        why.length > 0
          ? `the independent review no longer covers what ${WT} would push — review the change within the remaining allowance, or restore the reviewed content, then close again`
          : `the review receipt check could not run (exit ${receipt.status}): ${lastLine(chomp(receipt.stderr), "no message")}`,
      );
    }

    // NOTHING TO PUSH IS NOT A FAILED PUSH. A thread's own worktree is in the
    // ledger whether or not the session wrote to it, and a satellite is opened
    // on the first write — so a worktree that saw no work sits exactly on the
    // trunk. Pushing it is a harmless no-op everywhere except against a repo
    // that refuses writes at all — an archived repo rejects even an empty push,
    // so every close of a thread opened on one would die here while the session's
    // real work sat committed and unpushed in the other worktrees.
    //
    // The test is HEAD against the freshly fetched trunk, NOT "did this
    // session write files": a worktree carrying commits still pushes them, and a
    // repo that went archived mid-flight with work in it must still fail loudly
    // rather than be silently skipped.
    //
    // It skips the push ONLY. The satellite removal and the final all-clear below
    // still run, so a no-work worktree is cleaned up exactly like any other.
    // Where the trunk stood before this push: HEAD already there is nothing to
    // push.
    //
    // Both SHAs are read CHECKED. Read unchecked, two failed reads would be two
    // empty strings, compare equal, and a committed change would be reported as
    // "nothing to push" and left unpushed.
    const revParse = (ref: string, err: "ignore" | "inherit" = "ignore"): string => {
      const r = git(WT, ["rev-parse", ref], { err });
      const sha = chomp(r.stdout);
      if (!r.ok || !sha) notClosed(`could not read ${ref} in ${WT} — git rev-parse failed; re-run`);
      return sha;
    };
    const TRUNK_BEFORE = revParse(`origin/${TRUNK}`);
    const SHA = revParse("HEAD", "inherit");

    // EVERY PUSH IS OWED A CHECK, decided by `pollDeploy`: everything GitHub
    // reports on the pushed commit, to completion, which a repo that reports
    // nothing, and is expected to report nothing, settles at once.
    //
    // THE ORDER IS THE PROOF: record the obligation for the SHA about to be
    // pushed, push, record the landed SHA, poll, clear. A kill anywhere leaves a
    // retry that polls or refuses. Before the push, the obligation names an
    // unpushed SHA, and the retry pushes that SHA again and re-records it.
    // After the push and before the landed SHA, the retry finds HEAD already on
    // origin and has nothing to push, but the obligation on disk is polled all
    // the same. After the landed SHA, the
    // early returns poll it. After a good poll and before the clear, the retry
    // polls a run that already completed. Recorded after the push instead, a
    // kill in that gap would let a retry close unpolled.
    //
    // A push owed a run takes over an earlier obligation when it descends from
    // that SHA, because its completed run deploys that SHA's tree too. One that
    // does not descend cannot take it over, so the old SHA is proved first.
    if (
      OWED_SHA !== null &&
      OWED_SHA !== SHA &&
      !git(WT, ["merge-base", "--is-ancestor", OWED_SHA, SHA], { out: "ignore" }).ok
    ) {
      pollDeploy(SHARED, OWED_SHA);
    }
    // THE LIVE CHECKS THIS PUSH OWES, written before it like the deploy
    // obligation below, so an interrupted push is retried with them. Measured
    // from the trunk this branch now contains: what the push itself changes.
    // Then every obligation this repo serves is bound to the SHA about to be
    // pushed, and any collected for a repo already landed in this run to the
    // SHA that repo landed.
    await collectLive(WT, SHARED, TRUNK_BEFORE);
    for (const [s, sha] of LANDED_NOW) bindLive(s, sha, false);
    bindLive(SHARED, SHA, true);
    LANDED_NOW.set(SHARED_KEY, SHA);
    const OWED_BEFORE = owedShaFor(SHARED);
    setOwed(SHARED, SHA);

    if (SHA === TRUNK_BEFORE) {
      say(`  ${SHARED}: nothing to push (already at origin/${TRUNK})`);
    } else {
      let attempt = 1;
      for (;;) {
        if (git(WT, ["push", "-q", "origin", `HEAD:${TRUNK}`], { out: "inherit" }).ok) break;
        if (attempt >= Number(PUSH_RETRIES)) {
          // The SHA is deliberately NOT persisted: the work is committed and the
          // worktree is intact, so the next close lands it. The obligation goes
          // back to what it was, because nothing was pushed to owe a run. A kill
          // before that leaves the unpushed SHA owed, which the retry pushes and
          // re-records, or refuses on.
          if (OWED_BEFORE === null) clearOwed(SHARED);
          else setOwed(SHARED, OWED_BEFORE);
          notClosed(`push of ${SHARED} failed`);
        }
        attempt += 1;
        run("sleep", [PUSH_SLEEP], { out: "inherit", err: "inherit" });
      }
    }
    killPoint("pushed");

    appendFileSync(LANDED, `${SHARED}\t${SHA}\n`);
    killPoint("landed");

    // Release before the slow parts: the deploy can take minutes and holds up
    // every other writer on this repo for no reason.
    await releaseLock(lock);

    // ── The shared checkout, best effort ──────────────────────────────────
    // The trunk on the remote is the truth. The shared tree is a convenience, and one that
    // another session may have dirty or on another branch.
    if (isDir(`${SHARED}/.git`) || isFile(`${SHARED}/.git`)) {
      const SHARED_BRANCH = orEcho(git(SHARED, ["rev-parse", "--abbrev-ref", "HEAD"]), "?");
      // Unreadable counts as dirty: the shared tree is then left alone. The
      // line names the first dirty path, as git names it.
      const st = git(SHARED, ["status", "--porcelain"]);
      const SHARED_DIRTY = st.ok ? (chomp(st.stdout).split("\n")[0] ?? "").slice(3) : "(status unreadable)";
      if (SHARED_BRANCH !== TRUNK) {
        say(`  shared checkout ${SHARED} not advanced (on ${SHARED_BRANCH}, not ${TRUNK})`);
      } else if (SHARED_DIRTY) {
        say(`  shared checkout ${SHARED} not advanced (uncommitted changes: ${SHARED_DIRTY})`);
      } else {
        git(SHARED, ["fetch", "-q", "origin", TRUNK], { out: "inherit" });
        if (!git(SHARED, ["merge", "--ff-only", "-q", `origin/${TRUNK}`], { out: "inherit" }).ok) {
          say(`  shared checkout ${SHARED} not advanced (fast-forward refused)`);
        }
      }
      // A THREE-CONDITION `SHARED_HAS_LANDED` FLAG USED TO BE COMPUTED HERE, and
      // it is gone rather than kept for a future reader. It existed to answer one
      // question — is this checkout safe to BUILD from — and that question stopped
      // being asked when the deploy moved to its own tree. The three `not advanced`
      // lines above already report every shape of drift it could detect, so what
      // is left is the reporting and none of the branching.
    }

    // ── Check that the push deployed — do NOT deploy ──────────────────────
    //
    // The push is the deployer and this script only CHECKS. A merger that
    // deployed would deploy the shared checkout, which another session may hold
    // dirty; the push deploys the landed commit. But a push-triggered deploy can
    // be lost silently — a workflow that never starts, a runner that is gone, a
    // build that fails — and silence looks exactly like success. So a landing
    // whose checks do not start where they did before, or fail, is NOT CLOSED.
    //
    // FOR EVERY REPO, AND EVERY PUSH OF IT. Every repo is asked what GitHub saw
    // start (`pollDeploy`); a journal-only close waits for its push's checks
    // like any other, because the workflows decide from their own diff what to
    // run, and a list here of which paths deploy would drift from theirs.
    pollDeploy(SHARED, SHA);

    // ── Remove the satellite, never the harness's own worktree ────────────
    // The harness made that one (T3's thread worktree, a `claude -w` one),
    // checkpoints into it, and reaps it itself. The comparison
    // is against the value resolved at startup, NOT a fresh lookup: by the time
    // the second repo lands, the helper that lookup needs may already have been
    // removed with the first one.
    if (T3_WORKTREE && WT === T3_WORKTREE) {
      say(`  landed ${SHARED} at ${SHA}`);
      return;
    }

    // The own worktree could not be identified at all. Removing on "it is not the
    // empty string" would remove the harness's worktree whenever the lookup
    // failed; refusing to remove is the safe direction, since a leftover worktree
    // costs disk and a wrongly removed one costs the thread. A session with NO
    // own worktree (it started in the main checkout) is a definite answer, not a
    // failed lookup, and its satellites go like any other.
    if (!T3_WORKTREE && !NO_OWN_WORKTREE) {
      warn(`  kept ${WT} — could not confirm it is not the harness's own worktree`);
      say(`  landed ${SHARED} at ${SHA}`);
      return;
    }

    if (removalIsDeferred(WT)) {
      // This is the worktree these scripts are running from, or the one holding
      // the decision-record checker. Removing the first now would pull thread.ts
      // and write-root.sh out from under the rest of the run; removing the second
      // would leave every repo landed after it with no checker, and a re-run after
      // any later failure with none either. Both go last, after the final check.
      DEFERRED_REMOVALS.push([WT, SHARED, BRANCH]);
    } else {
      removeWorktree(WT, SHARED, BRANCH);
    }

    say(`  landed ${SHARED} at ${SHA}`);
  };

  const LEDGER_LINES = readLines(readFileSync(LEDGER, "utf8")).filter((l) => l !== "");

  // The shared checkout of the row that holds the journal, RESOLVED FROM THE
  // LEDGER BEFORE ANYTHING IS REMOVED: the checks below run after the worktree
  // may be gone, and they need the repo — not the worktree — to ask the trunk
  // whether the entry arrived. A rename around a collision keeps the path inside
  // the same worktree, so this cannot go stale mid-run. Empty when no journal
  // was allocated; a journal in no ledger row is refused in the checks below,
  // because nothing would ever land it.
  let JOURNAL_SHARED = "";
  for (const line of LEDGER_LINES) {
    const [jwt = "", jshared = ""] = tabFields(line, 3);
    if (!jwt) continue;
    if (holdsJournal(jwt)) {
      JOURNAL_SHARED = jshared;
      break;
    }
  }

  // The checkers, resolved from the ledger's worktrees (see DR_CHECK_REL above).
  for (const line of LEDGER_LINES) {
    const [drwt = ""] = tabFields(line, 3);
    if (!drwt) continue;
    if (!DR_CHECK && isFile(`${drwt}/${DR_CHECK_REL}`)) {
      DR_CHECK = `${drwt}/${DR_CHECK_REL}`;
      DR_CHECK_WT = drwt;
    }
    if (!IM_CHECK && isFile(`${drwt}/${IM_CHECK_REL}`)) {
      IM_CHECK = `${drwt}/${IM_CHECK_REL}`;
      IM_CHECK_WT = drwt;
    }
    if (!SEC_CHECK && isFile(`${drwt}/${SEC_CHECK_REL}`)) {
      SEC_CHECK = `${drwt}/${SEC_CHECK_REL}`;
      SEC_CHECK_WT = drwt;
    }
    if (!STD_CHECK && isFile(`${drwt}/${STD_CHECK_REL}`)) {
      STD_CHECK = `${drwt}/${STD_CHECK_REL}`;
      STD_CHECK_WT = drwt;
    }
    if (!SC_CHECK && isFile(`${drwt}/${SC_CHECK_REL}`)) {
      SC_CHECK = `${drwt}/${SC_CHECK_REL}`;
      SC_CHECK_WT = drwt;
    }
  }

  if (MODE === "land") {
    // ── A prerequisite, before anything is committed ──────────────────────
    //
    // The other one, verify, is asked at the first commit (requireVerified).
    //
    // A JOURNAL ENTRY, for every thread — one opened on a product repo too.
    // Without one a thread would land anyway, and its last line would quote
    // whichever repo landed last; SKILL.md says every session gets an entry.
    const JPATH = isFile(JOURNAL_REF) ? firstLine(JOURNAL_REF) : "";
    const JHELD = LEDGER_LINES.some((l) => {
      const [jwt = ""] = tabFields(l, 3);
      return jwt !== "" && JPATH.startsWith(`${jwt}/journal/`);
    });
    if (!JPATH || !JHELD || !isFile(JPATH)) {
      notClosed(
        `no journal entry for this thread${JPATH ? ` (${JPATH} is in no worktree this thread owns)` : ""} — run journal-file.ts`,
      );
    }

    for (const line of LEDGER_LINES) {
      const [WT = "", SHARED = "", BRANCH = ""] = tabFields(line, 3);
      if (!WT) continue;
      await landOne(WT, SHARED, BRANCH);
    }
    killPoint("landings-done");
    // Kept for the report, which prints them: appended within one close, so a
    // second held landing whose check finds the links already fixed does not
    // erase what the first one did.
    const kept = isFile(HARNESS_REF) ? readLines(readFileSync(HARNESS_REF, "utf8")) : [];
    harnessLinks(LEDGER_LINES, (l) => {
      const line = l.trim();
      if (!kept.includes(line)) kept.push(line);
    });
    if (kept.length > 0) writeAtomic(HARNESS_REF, kept.map((l) => `${l}\n`).join(""));
  }

  // ── The three checks ─────────────────────────────────────────────────────
  //
  // Run against a freshly fetched trunk in every repo, because every
  // failure worth catching here is invisible against a stale ref.

  if (!isFile(LANDED)) notClosed("nothing was landed");

  // A push whose deploy was never proved is not closed, in `--check` as in a
  // landing: landOne settles every obligation it meets, so one left here is a
  // failed run no retry has yet seen succeed.
  for (const [oshared = "", osha = ""] of readOwed()) {
    if (oshared) notClosed(`the deploy of ${osha} to ${oshared} was never proved — re-run the close`);
  }

  let JOURNAL_MAIN_SHA = "";
  let JOURNAL_TRUNK = "";
  let JOURNAL_LANDED = "";

  const landedRows = readLines(readFileSync(LANDED, "utf8"));
  for (const row of landedRows) {
    const [SHARED = "", SHA = ""] = tabFields(row, 2);
    if (!SHARED) continue;
    // A RETIRED REPO. The ledger keeps every repo the thread ever landed in, so a
    // thread that closed into a repo since merged into another still lists a
    // checkout that no longer exists, and every later close of that thread would
    // refuse on it. A merge that keeps the history accounts for the landing: it
    // passes when its SHA is an ancestor of a surviving repo's trunk, and is
    // refused when it is on none.
    if (!git(SHARED, ["rev-parse", "--git-dir"], { out: "ignore" }).ok) {
      let FOUND = "";
      for (const other of landedRows) {
        const [OTHER = ""] = tabFields(other, 2);
        if (!(OTHER && OTHER !== SHARED)) continue;
        const oTrunk = trunkOf(OTHER);
        if (oTrunk === null) continue;
        if (!git(OTHER, ["fetch", "-q", "origin", oTrunk], { out: "inherit" }).ok) continue;
        if (git(OTHER, ["merge-base", "--is-ancestor", SHA, `origin/${oTrunk}`], { out: "inherit" }).ok) {
          FOUND = OTHER;
          break;
        }
      }
      if (!FOUND) notClosed(`${SHARED} is gone and ${SHA} is on no surviving repo's trunk`);
      if (VERBOSE === 1) say(`${basename(SHARED)}  ${SHA}  retired, ancestor-of-${basename(FOUND)}`);
      continue;
    }
    const chk = trunkOf(SHARED);
    if (chk === null) notClosed(`no trunk branch in ${SHARED} to check against`);
    const CHK_TRUNK = chk;
    if (!git(SHARED, ["fetch", "-q", "origin", CHK_TRUNK], { out: "inherit" }).ok)
      notClosed(`could not re-fetch ${SHARED} to check it`);
    if (!git(SHARED, ["merge-base", "--is-ancestor", SHA, `origin/${CHK_TRUNK}`], { out: "inherit" }).ok) {
      notClosed(`${SHA} is not on origin/${CHK_TRUNK} in ${SHARED}`);
    }
    const MAIN_SHA = chomp(git(SHARED, ["rev-parse", `origin/${CHK_TRUNK}`], { err: "inherit" }).stdout);
    if (JOURNAL_SHARED && SHARED === JOURNAL_SHARED) {
      JOURNAL_MAIN_SHA = MAIN_SHA;
      // The trunk the REPORT line names. It is the journal repo's, because that
      // is the repo whose SHA the line carries — naming another repo's trunk
      // beside that SHA would be a false sentence with a real SHA in it.
      JOURNAL_TRUNK = CHK_TRUNK;
    }
    if (VERBOSE === 1) say(`${basename(SHARED)}  ${SHA}  ancestor-of-origin/${CHK_TRUNK}`);
  }

  // The journal is checked by PATH, not by "a journal was written": a close that
  // renamed the file around a collision has to prove the renamed one landed.
  // A thread with no entry is not closed in any mode: the last line
  // quotes the SHA of the repo the entry landed in, and there is no other.
  const REL = journalRel();
  if (REL === null) notClosed("no journal entry for this thread — run journal-file.ts");
  {
    if (!JOURNAL_SHARED) notClosed(`${REL} is in no worktree this thread owns, so nothing landed it`);
    if (landedShaFor(JOURNAL_SHARED) === null) notClosed(`${REL} has not landed — run land.ts`);
    {
      const jt = trunkOf(JOURNAL_SHARED);
      if (jt === null) notClosed(`no trunk branch in ${JOURNAL_SHARED} to check the journal against`);
      if (!git(JOURNAL_SHARED, ["cat-file", "-e", `origin/${jt}:${REL}`], { out: "inherit" }).ok) {
        notClosed(`${REL} is not on origin/${jt} in ${JOURNAL_SHARED}`);
      }
      // The path the close hands back. Absolute, and in the shared checkout
      // rather than the worktree the next block may remove: a relative path is
      // resolved against the thread's OWN project, so a record written from a
      // thread on another repo renders as a link that cannot open.
      JOURNAL_LANDED = `${JOURNAL_SHARED}/${REL}`;
      if (VERBOSE === 1) say(`journal  ${REL}  present`);
    }
  }

  // Anything still on disk must have nothing left in it. A satellite that was
  // removed after landing is covered by its SHA above; the T3 worktree stays, so
  // this is what proves it was emptied.
  for (const line of LEDGER_LINES) {
    const [WT = "", SHARED = ""] = tabFields(line, 3);
    if (!WT) continue;
    // A worktree that is gone is fine ONLY if its SHA was persisted first — that
    // is the whole point of persisting before removing. Skipping on absence alone
    // let `--check` certify a partial landing whose remaining satellite had since
    // been deleted, which is the one thing this line must never do.
    if (!isDir(WT)) {
      if (landedShaFor(SHARED) === null) notClosed(`worktree missing before landing: ${WT}`);
      continue;
    }
    if (wtStatus(WT) !== "") notClosed(`uncommitted changes left in ${WT}`);
    const wtTrunk = trunkOf(SHARED);
    if (wtTrunk === null) notClosed(`no trunk branch in ${SHARED} to check ${WT} against`);
    git(WT, ["fetch", "-q", "origin", wtTrunk], { out: "inherit" });
    // An unreadable count is not zero: read as `$(… || echo 0)`, it would
    // certify a worktree whose commits it never counted.
    const ahead = git(WT, ["rev-list", "--count", `origin/${wtTrunk}..HEAD`]);
    if (!ahead.ok) notClosed(`could not count the commits in ${WT} that origin/${wtTrunk} lacks — git failed; re-run`);
    const AHEAD = chomp(ahead.stdout);
    if (AHEAD !== "0") notClosed(`${AHEAD} commit(s) in ${WT} that origin/${wtTrunk} does not have`);
  }

  // ── Passed ───────────────────────────────────────────────────────────────
  //
  // The marker is what the auto-close gate reads (--gate, above), and it is
  // written HERE rather than when the journal is written: a journal written before a failed Land would otherwise suppress the
  // re-run that lands it.
  //
  // HELD is landed, deployed and checked, but not closed: no marker, no report,
  // no line, while the live checks run with the session open. A landing that
  // owes live checks holds whether or not --hold was passed. A --check
  // while held keeps the hold; only a --release whose live checks all pass
  // ends it.
  const STAYS_HELD = HOLD || (MODE === "land" && readLiveOwed().length > 0) || (MODE === "check" && isFile(HELD));
  // Owed checks with no hold written: a landing that stopped after its push
  // and before it held. Not closed, and not held either, since --release
  // needs the hold the landing writes: the landing is what runs again.
  if (MODE === "check" && !isFile(HELD) && readLiveOwed().length > 0)
    notClosed(
      'live checks are owed but the landing that owes them did not finish — run land.ts "<subject>" again, which holds on them',
    );
  const LIVE_REPORT = MODE === "release" ? await proveLive() : [];

  // This is the final-response block. It is generated here so /close copies one
  // complete artifact instead of manually reconstructing fields and dropping a
  // deterministic result. Deployment diagnostics stay above it; the proof line
  // remains last and retains its existing machine-earned meaning.
  //
  // Each field is its own paragraph: lines separated by a single newline are
  // one paragraph in Markdown, which would run Shipped, Journal and Next
  // together on one line.
  //
  // BUILT FIRST, SAVED BEFORE THE MARKER, PRINTED LAST. The block goes
  // to the thread's state before `closed` is written or `held` removed, so a
  // close that reads as finished always has its report on disk, and one whose
  // save failed is NOT CLOSED with its hold and its retry state intact.
  let BLOCK = "";
  const put = (s: string): void => {
    BLOCK += s;
  };
  const putLine = (s: string): void => put(`${s}\n`);
  if (REPORTS && !STAYS_HELD) {
    putLine(`**Shipped:** ${SUBJECT}`);
    if (JOURNAL_LANDED) {
      putLine("");
      putLine(`**Journal:** [${JOURNAL_LANDED.slice(JOURNAL_LANDED.lastIndexOf("/") + 1)}](<${JOURNAL_LANDED}>)`);
    }
    // With the **Project:** sentence printed, next-implement-command's own
    // status comment (`# <slug> — …`, `# <slug> is blocked — …`) says the same
    // thing in the script's words and is dropped. Its other comments (a manual
    // row, a blocked row) stay.
    let nextLines = NEXT_OUTPUT.split("\n").filter((l) => l !== "");
    if (STATUS_LINE) {
      putLine("");
      putLine(`**Project:** ${STATUS_LINE}`);
      const slug = STATUS_LINE.split(" ")[0] ?? "";
      nextLines = nextLines.filter((l) => !l.startsWith(`# ${slug} — `) && !l.startsWith(`# ${slug} is blocked — `));
    }
    // THE HANDOFF IS FRESH CONTEXT. Nothing starts a row on its own: each
    // `/implement <slug> <row>` is for the user to run in a NEW session (a new
    // thread, tab or terminal), where the build starts from its spec rather
    // than from this session's context. Each command is its own fenced block,
    // so each has its own copy button: rows printed together can run in
    // parallel sessions, and one multi-line block would paste them as one
    // prompt. A `#` comment is a prose list item. NEXT_OUTPUT itself is
    // unchanged: it stays machine-readable, one command or comment per line.
    if (nextLines.length > 0) {
      putLine("");
      putLine("**Next:**");
      if (nextLines.some((l) => l.startsWith("/implement "))) {
        putLine("");
        putLine("Run each `/implement` in a fresh session, one per row; rows listed together can run in parallel.");
      }
      for (const l of nextLines) {
        if (l.startsWith("/")) put(`\n\`\`\`\n${l}\n\`\`\`\n`);
        else if (l.startsWith("# ")) put(`\n- ${l.slice(2)}\n`);
        else put(`\n${l}\n`);
      }
    }
    // What the harness-link check did on this close's landings, a list item
    // each, so the session inspects every `.pre-link` file a line names.
    const links = isFile(HARNESS_REF) ? readLines(readFileSync(HARNESS_REF, "utf8")).filter((l) => l !== "") : [];
    if (links.length > 0) {
      putLine("");
      putLine("**Harness links:**");
      putLine("");
      for (const l of links) putLine(`- ${l}`);
    }
    // What --release proved live: each command check that passed, and
    // each evidence check's declared expectation beside what the capture shows.
    if (LIVE_REPORT.length > 0) {
      putLine("");
      putLine("**Live checks:**");
      putLine("");
      for (const l of LIVE_REPORT) putLine(`- ${l}`);
    }
    putLine("");
  }

  // The SHA of the repo the journal landed in — workbench, the repo every
  // journal close pushes. A thread with no entry is refused above, so there is
  // always one. The trunk
  // is named from the same repo, so the sentence and the SHA always describe
  // the same ref: `origin/main` on every repo here, `origin/master` on a
  // `master` repo rather than a reassuring line about a branch the SHA is not on.
  if (!JOURNAL_MAIN_SHA) notClosed(`${REL} landed in ${JOURNAL_SHARED}, but its trunk could not be read to prove it`);
  if (!STAYS_HELD)
    putLine(`origin/${JOURNAL_TRUNK || "main"} is at ${JOURNAL_MAIN_SHA} — closing this tab loses nothing.`);

  // A --check lands nothing and prints no report, so it marks a close closed
  // only when a landing of this window already saved one: after a landing
  // whose save failed, it must not close what has no report.
  if (STAYS_HELD) {
    if (MODE === "land" && !isFile(HELD)) writeAtomic(HELD, `${SUBJECT}\n`);
  } else if (MODE === "check" && !isFile(REPORT_REF)) {
    say('  closed: not marked — no report of this close is saved; land.ts "<subject>" saves it');
  } else {
    if (REPORTS) {
      try {
        writeAtomic(REPORT_REF, BLOCK);
        rmSync(REPORT_DELIVERED, { force: true });
      } catch (e) {
        if (e instanceof Exit) throw e;
        rmSync(`${REPORT_REF}.tmp.${process.pid}`, { force: true });
        notClosed(
          `could not save the report to ${REPORT_REF}: ${e instanceof Error ? e.message : String(e)} — nothing is marked closed; re-run`,
        );
      }
      rmSync(HARNESS_REF, { force: true });
    }
    writeAtomic(CLOSED, "");
    // That a close finished here at least once, kept when a later landing
    // starts (which removes `closed` above) and fails: the end-of-turn check
    // reads it, so work after a refused second close is still refused.
    writeAtomic(`${STATE}/closed-once`, "");
    // A close paused for the user's answer (end-of-turn.ts --pause) is dealt
    // with once a new close completes.
    rmSync(`${STATE}/reopened`, { force: true });
    rmSync(`${STATE}/paused`, { force: true });
    rmSync(HELD, { force: true });
    rmSync(LIVE_OWED, { force: true });
    rmSync(LIVE_PASSED, { force: true });
  }

  // ── Last of all: the worktree these scripts are running from ────────────
  //
  // Everything above is done, the checks have passed and the marker is written,
  // so nothing left to do needs a sibling script. Only git below. A held close
  // keeps them: --release runs these scripts again from the same worktree, and
  // its landing pass queues the removal once the hold ends (Contextium v9.2.0
  // review).
  if (STAYS_HELD) {
    const kept = isFile(HELD_REMOVALS) ? readFileSync(HELD_REMOVALS, "utf8").split("\n").filter(Boolean) : [];
    for (const r of DEFERRED_REMOVALS) if (!kept.includes(r.join("\t"))) kept.push(r.join("\t"));
    if (kept.length > 0) writeAtomic(HELD_REMOVALS, `${kept.join("\n")}\n`);
  } else {
    const queued = new Set(DEFERRED_REMOVALS.map((r) => r.join("\t")));
    if (isFile(HELD_REMOVALS))
      for (const l of readFileSync(HELD_REMOVALS, "utf8").split("\n").filter(Boolean)) {
        const [dwt = "", dshared = "", dbranch = ""] = l.split("\t");
        if (dwt && !queued.has(l) && isDir(dwt)) DEFERRED_REMOVALS.push([dwt, dshared, dbranch]);
      }
    for (const [dwt, dshared, dbranch] of DEFERRED_REMOVALS) removeWorktree(dwt, dshared, dbranch);
    rmSync(HELD_REMOVALS, { force: true });
  }

  if (nonEmpty(DEPLOY_LOG) && REPORTS) {
    say("");
    say("Deploy:");
    const log = readFileSync(DEPLOY_LOG, "utf8");
    const terminated = log.endsWith("\n");
    const lines = (terminated ? log.slice(0, -1) : log).split("\n");
    process.stdout.write(lines.map((l) => `  ${l}`).join("\n") + (terminated ? "\n" : ""));
    say("");
  }

  if (STAYS_HELD) {
    for (const l of owedLines()) say(l);
    say(
      "HELD: landed and deployed. Run the live checks now; land a fix with --hold again, ask what only the user can answer and stop. When they pass: land.ts --release",
    );
    return exit(4);
  }

  process.stdout.write(BLOCK);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
