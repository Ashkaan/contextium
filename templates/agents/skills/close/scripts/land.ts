#!/usr/bin/env -S node --experimental-strip-types
// land.ts — put everything this thread wrote on its repo's trunk, and prove it.
//
// Close's jobs are six: run the tests for what changed (verify.ts, asked here
// before the first commit), check the journal entry, commit/merge/push, wait
// for the deploy, update the project's status, and print the report. Every
// other check here earned its place by catching a real problem, or keeps work
// from being lost.
//
// For each worktree in the thread's ledger (write-root.sh writes it) this
// commits, merges the trunk IN THE WORKTREE (a conflict stays in this thread's
// tree, where a re-run resumes), runs the checks once on the merged tree, and
// only when every repo has passed pushes each as its trunk and waits for what
// the push started. Then it re-fetches every repo and proves the landing before
// printing the last line, which nothing else may print: a line saying the
// session is safe to close means something only when a script prints it after
// checking. Every worktree but T3's own is removed at the very end — or, when
// the close stays held, at the --release that ends the hold, so a live check's
// fix is made and reviewed in it.
//
// TYPESCRIPT. Every sibling it runs is a `.ts` run with `node
// --experimental-strip-types`, except write-root.sh, which stays bash because
// it runs `git worktree add`, and lock.sh, whose per-repo lock this takes
// through a bash child (see takeLock). Every Node child is started with the
// ExperimentalWarning disabled (NODE_TS), so on Node 22.x it never reaches a
// checker's refusal.
//
// Usage:
//   land.ts "<commit subject>"   — land, check, then emit the final report
//   land.ts --check              — the checks only; land nothing
//   land.ts --verbose            — also print each repo's SHA
//   land.ts --gate               — `fired` / `not-fired`, for the auto-close gate
//   land.ts --landed-projects    — the projects this close put on the trunk:
//                                  every ROADMAP.md its own pushes changed and
//                                  the net range changed, and the projects
//                                  waiting on a row that range finished, read
//                                  by git between where the trunk stood before
//                                  its first push (`landed-pushes`) and its last
//                                  landed SHA; then `unreadable <folder>: …`.
//                                  For open-active.ts --for-landed, the close's
//                                  open step
//   land.ts "<subject>" --hold   — land and wait for the deploy, then stop
//                                  before the report: the live checks run now
//   land.ts --release            — the checks again, every owed live check
//                                  proved on what is live, then the held report
//   land.ts --live-start <spec>/<id>                    — an evidence check:
//                                  record what is live before the capture
//   land.ts --live-pass <spec>/<id> <file> --saw "<…>"  — record the capture,
//                                  refused if what is live moved since the start
//
// A spec that writes a `live-checks` block in its tasks.md (live-checks.ts's
// form) holds the landing that finishes it after the deploy, whatever flag was
// given; --release runs each command check and accepts each evidence check only
// from a --live-pass record taken on the deployment live now.
//
// Rows: a landing sets `done` every row naming a spec its push writes
// `complete`, except a spec it holds for its live checks (heldSpecs), whose row
// keeps its status; the roadmap gate lets exactly those rows ride in-progress,
// told by LAND_HELD_SPECS. A spec this close owes whose last check a
// re-landing removes is set `done` by that landing. Only after --release has
// proved every owed check does it set the held rows `done`, re-derive the
// README's `next:`, and push that through landOne and publish, the merge,
// gates, review receipt and deploy poll of any landing. A release refuses work
// that has not landed before it proves anything, and one whose rows commit
// does not land takes the commit back out, the hold kept.
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts.
//   LAND_PUSH_RETRIES, LAND_PUSH_SLEEP — 3 and 5s; the suite shortens the sleep.
//   LAND_LIVE_CHECK_TIMEOUT — 120 (seconds a command check may run).
//   LAND_GH — the gh binary the push check looks for (default `gh`); the
//                                        suite points it at a stand-in, or at
//                                        nothing to test a machine without one.
//   LIVE_CHECKS_TEST_SOURCES — live-checks.ts's seam; the suite's stubbed answers.
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
//   .agents/skills/close/scripts/tests/land-cases.ts (the suite; land*.test.ts run its ranges)
//   .agents/skills/close/scripts/verify.ts, spec-state.ts, roadmap.ts, roadmap-merge.ts,
//   check-roadmap-decisions.ts, write-root.sh, await-push-checks.ts, live-checks.ts,
//   lock.sh
//   .agents/checks/check-decision-records.ts, check-integration-manifest.ts (when present),
//   check-scripts.ts, check-skills.ts, check-secrets.ts and check-standards-refs.ts
//   (when present), check-harness-config-links.ts (after each landing, from the
//   shared checkout; `--fix` on drift, never refuses)
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
  LIVE_CHECK_GRACE_S,
  liveCheckArgv,
  liveRevision,
  parseLiveChecks,
  type Revision,
  sourceRepo,
  targetParts,
} from "./live-checks.ts";
import { authorizedBy } from "../../review/authorized-by.ts";
import { listRows, projectsNaming, rowsFinished, waitingOn } from "./roadmap.ts";
import { reportClaimsComplete } from "./spec-state.ts";
import { isDir, isFile } from "./trunk.ts";
import { unfinishedHelpers } from "./t3-db.ts";

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
// Each harness home (~/.claude/agents, ~/.agents/skills, …) links into the
// workbench's shared checkout. Every landing checks them and on drift runs
// `--fix`, which parks whatever stood at a link at <path>.pre-link. It never
// refuses: drift is host state, not this thread's diff. The copy run is the
// shared checkout's, from inside it (the check finds the main checkout with
// `git rev-parse`). Its lines are kept in the thread's state and printed under
// **Harness links:** in the report, a held landing's included.
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

// ── Work not landed (the auto-close gate's test) ──────────────────────────
//
// Is anything in this thread's ledger worktrees not on its trunk? `--gate`
// and end-of-turn.ts ask. `clean`: every worktree still on disk has an empty
// status and nothing ahead of `origin/<trunk>`. `unlanded`: one has. A git
// read or trunk that fails is `unreadable`, never clean.
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
    'usage: land.ts "<subject>" [--hold] | --release | --check [--verbose] | --gate | --landed-projects | --live-start <spec>/<id> | --live-pass <spec>/<id> <file> --saw "<what it shows>"';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--check") MODE = "check";
    else if (a === "--gate") MODE = "gate";
    else if (a === "--landed-projects") MODE = "landed-projects";
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

  // The id is thread.ts's stdout alone; stderr (which can carry a Node warning)
  // is read only for the refusal.
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
  // This close's push attempts, one line per event, tab-separated, kind first:
  //   push <id> <repo> <trunk> <trunk before> <SHA>   an attempt, written with
  //                                                   its round before the
  //                                                   round's first push
  //   seen <id> <repo> <trunk> <trunk> <trunk>        a round with nothing to
  //                                                   push in that repo
  //   pushed <id> / refused <id>                      that attempt's outcome,
  //                                                   when it is known
  // Read by --landed-projects for the close's open step
  //.
  const LANDED_PUSHES = `${STATE}/landed-pushes`;
  const JOURNAL_REF = `${STATE}/journal`;
  const CLOSED = `${STATE}/closed`;
  const DEPLOY_LOG = `${STATE}/deploy.log`;
  const DEPLOY_OWED = `${STATE}/deploy-owed`;
  const NEXT_REF = `${STATE}/next`;
  const STATUS_REF = `${STATE}/project-status`;
  const HELD = `${STATE}/held`;
  // Every worktree a held close kept (all but T3's own): a live check's fix is
  // made in it; the --release that ends the hold removes them.
  // `<wt>\t<shared>\t<branch>` lines.
  const HELD_REMOVALS = `${STATE}/held-removals`;
  // The report block is saved before the closed marker, so end-of-turn.ts
  // finds the block of any close that finished; `report-delivered` is its mark.
  const HARNESS_REF = `${STATE}/harness-links`;
  const REPORT_REF = `${STATE}/report`;
  const REPORT_DELIVERED = `${STATE}/report-delivered`;
  // The live checks owed (written before the push), what proved each, and the
  // evidence files --live-pass copied (kept: a delivered report links them).
  const LIVE_OWED = `${STATE}/live-owed`;
  const LIVE_PASSED = `${STATE}/live-passed`;
  const LIVE_DIR = `${STATE}/live`;
  mkdirSync(STATE, { recursive: true });

  // ── The live checks' state ───────────────────────────────────────────────
  //
  // `live-owed`: one entry per check, with the repo whose commit its target
  // serves and that commit once the repo's push is about to happen ("" until
  // then). `live-passed`: what proved each key.
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
  // The live revision is read before the capture and again after it: a deploy
  // in between voids the capture.
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
  // "Has this session closed, with nothing written since?" The closed marker
  // goes stale the moment a worktree has something in it again, so a session
  // that keeps working after its close gets a second one. A held close is
  // neither: it says what it owes.
  if (MODE === "gate") {
    if (isFile(HELD)) {
      say("held");
      for (const l of owedLines()) say(l);
      exit(0);
    }
    if (!isFile(CLOSED) || !isFile(LEDGER)) {
      say("not-fired");
      exit(0);
    }
    say(unlandedWork(LEDGER) === "clean" ? "fired" : "not-fired");
    exit(0);
  }

  // ── The projects this close landed, for its open step ────────────────────
  //
  // Read with git from two proven points per repo: where its trunk stood before
  // this close's first push there, and the last SHA this close landed there
  // (`landed`, written only once a SHA is on the trunk). A table is this
  // close's when the net range between them changes it AND one of this close's
  // own pushes changed it (its range, trunk before → SHA, a SHA the landed one
  // descends from): another writer's table merged in between a hold and its
  // release is not this close's, and a row a refused push finished and a retry
  // put back nets out. The finished rows are the net range's; the projects
  // waiting on them are read from the landed commit's tables. Prints those
  // folders, sorted, once each (a deleted table included), then each table
  // that does not parse as `unreadable <folder>: <message>`. Every failure,
  // a git read included, exits 1 with its reason, so the open step says so.
  // Writes nothing.
  if (MODE === "landed-projects") {
    const fail = (msg: string): never => {
      warn(`land: --landed-projects: ${msg}`);
      return exit(1);
    };
    try {
      const lines = (path: string): string[][] =>
        existsSync(path) ? readLines(readFileSync(path, "utf8")).map((l) => l.split("\t")) : [];
      if (!existsSync(LANDED_PUSHES))
        fail(
          "this close has no landed-pushes record: a land.ts older than its open step landed it, so its projects are not known — /project open active finds their steps",
        );
      const landedLog = lines(LANDED);
      const record = lines(LANDED_PUSHES);
      const events = record.filter((f) => f[0] === "push" || f[0] === "seen");
      const outcome = new Map<string, string>();
      for (const [kind = "", id = ""] of record) if (kind === "pushed" || kind === "refused") outcome.set(id, kind);
      const folders = new Set<string>();
      const unreadable = new Set<string>();
      const ROADMAP_PATH = /^(projects\/[^/]+\/[^/]+)\/ROADMAP\.md$/;
      for (const repo of [...new Set(events.map((f) => f[2] ?? ""))].filter((r) => r !== "")) {
        const mine = events.filter((f) => f[2] === repo);
        const start = mine[0]?.[4] ?? "";
        let end = "";
        for (const [r = "", sha = ""] of landedLog) if (r === repo) end = sha;
        if (start === "" || end === "" || end === start) continue;
        const run = (args: string[], what: string) => {
          const r = git(repo, args, { err: "pipe" });
          if (!r.ok) fail(`${what} in ${repo}: ${lastLine(r.stderr, "git failed")}`);
          return r.stdout;
        };
        const ancestor = (from: string, to: string): boolean => {
          const r = git(repo, ["merge-base", "--is-ancestor", from, to], { err: "pipe" });
          if (!r.ok && r.status !== 1)
            fail(`could not compare ${from} with ${to} in ${repo}: ${lastLine(r.stderr, "git failed")}`);
          return r.ok;
        };
        const descends = (from: string): boolean => ancestor(from, end);
        if (!descends(start)) continue; // landed before this close started
        const show = (ref: string, path: string): Buffer =>
          Buffer.from(run(["show", `${ref}:${path}`], `could not read ${path} at ${ref}`), "utf8");
        const statuses = (from: string, to: string): Array<[string, string]> => {
          const f = run(
            ["diff", "-z", "--name-status", "--no-renames", from, to, "--", "*ROADMAP.md"],
            `could not list the roadmaps ${from}..${to} changed`,
          ).split("\0");
          const out: Array<[string, string]> = [];
          for (let i = 0; i + 1 < f.length; i += 2) out.push([(f[i] ?? "").charAt(0), f[i + 1] ?? ""]);
          return out.filter(([, path]) => ROADMAP_PATH.test(path));
        };
        // The tables this close's own pushes changed, and the rows each of
        // those pushes finished — never a row another writer finished.
        const own = new Map<string, Set<string>>();
        // An attempt reached the trunk when its outcome says pushed; never when
        // it says refused; otherwise (killed, or its answer lost) when the next
        // event here — another attempt or a round with nothing to push — began
        // from a trunk that already held it, or it is the last event and the
        // landed SHA descends from it. A no-op round is an observation, never a
        // push: what another thread published proves nothing about an attempt.
        const reached = (i: number): boolean => {
          const e = mine[i];
          if (!e || e[0] !== "push") return false;
          const sha = e[5] ?? "";
          const o = outcome.get(e[1] ?? "");
          if (sha === "" || o === "refused" || !descends(sha)) return false;
          if (o === "pushed") return true;
          const next = mine[i + 1]?.[4];
          return next === undefined ? true : ancestor(sha, next);
        };
        for (const [i, e] of mine.entries()) {
          const before = e[4] ?? "";
          const sha = e[5] ?? "";
          if (!reached(i)) continue;
          for (const [status, path] of statuses(before, sha)) {
            const ids = own.get(path) ?? new Set<string>();
            own.set(path, ids);
            if (status === "D") continue;
            const rows = rowsFinished(status === "A" ? null : show(before, path), show(sha, path));
            if (Array.isArray(rows)) for (const id of rows) ids.add(id);
            else unreadable.add(`unreadable ${ROADMAP_PATH.exec(path)?.[1]}: ${rows.error}`);
          }
        }
        // Of those, the tables the close's net range still changes, and the
        // rows still finished where it ends.
        const finished = new Map<string, Set<string>>();
        for (const [status, path] of statuses(start, end)) {
          const folder = ROADMAP_PATH.exec(path)?.[1];
          const mineRows = own.get(path);
          if (!folder || !mineRows) continue;
          folders.add(folder);
          if (status === "D" || mineRows.size === 0) continue;
          const atEnd = rowsFinished(null, show(end, path));
          if (!Array.isArray(atEnd)) {
            unreadable.add(`unreadable ${folder}: ${atEnd.error}`);
            continue;
          }
          const still = [...mineRows].filter((id) => atEnd.includes(id));
          if (still.length > 0) finished.set(folder, new Set(still));
        }
        if (finished.size === 0) continue;
        // The landed commit's tables, for the projects waiting on what finished.
        const tables = run(
          ["ls-tree", "-r", "-z", "--name-only", end, "--", "projects"],
          `could not list the tables at ${end}`,
        )
          .split("\0")
          .map((path) => ROADMAP_PATH.exec(path)?.[1])
          .filter((rel): rel is string => rel !== undefined);
        const waiting = waitingOn(tables, (rel) => show(end, `${rel}/ROADMAP.md`), finished);
        for (const folder of waiting.rels) folders.add(folder);
        for (const u of waiting.unreadable) unreadable.add(`unreadable ${u.rel}: ${u.why}`);
      }
      for (const l of [...[...folders].sort(), ...[...unreadable].sort()]) say(l);
    } catch (e) {
      if (e instanceof Exit) throw e;
      fail(e instanceof Error ? e.message : String(e));
    }
    exit(0);
  }

  // A close waits for every helper to report back: a helper that comes back
  // with more information could cause a second, unneeded close; t3-db.ts unfinishedHelpers says when one has. Asked before anything
  // below changes state. An unreadable database warns and lands.
  if (MODE === "land" || MODE === "release") {
    const waiting = unfinishedHelpers(TID);
    if ("error" in waiting) warn(`land: helpers not checked — ${waiting.error}`);
    else if (waiting.helpers.length > 0) {
      const n = waiting.helpers.length;
      const named = waiting.helpers
        .map((h) => `"${h.title || "(untitled)"}" — ${h.status}${h.delivery ? `, delivery ${h.delivery}` : ""}`)
        .join("; ");
      notClosed(
        `${n} helper${n === 1 ? " has" : "s have"} not reported back: ${named}. Wait for each helper's result, or cancel it with T3's task cancel if it is no longer needed, then close again.`,
      );
    }
  }

  // A close that succeeded starts a new reporting window; a failed one keeps
  // its deploy log, because its retry still reports what deployed before.
  if (MODE === "land" && isFile(CLOSED) && !isFile(HELD)) {
    // The open step's record begins again, empty, with the window: one left
    // from the last close would widen this close's range to that close's work.
    // Done first, while `closed` still marks the window: a clear or a create
    // that fails refuses here, and the retry starts the window again.
    // Replaced in one step, so a write that fails leaves the old record whole.
    try {
      if (isDir(LANDED_PUSHES)) rmSync(LANDED_PUSHES, { recursive: true, force: true });
      writeAtomic(LANDED_PUSHES, "");
    } catch (e) {
      notClosed(
        `could not clear ${LANDED_PUSHES}: ${e instanceof Error ? e.message : String(e)} — fix it, then close again`,
      );
    }
    writeAtomic(DEPLOY_LOG, "");
    rmSync(HARNESS_REF, { force: true });
    rmSync(REPORT_REF, { recursive: true, force: true });
    writeAtomic(`${STATE}/closed-once`, "");
    rmSync(CLOSED, { force: true });
  }
  // Made, empty, when a close starts fresh: a new window (above) or this
  // thread's first landing, with no push pending. A close an older land.ts
  // began — a hold it landed, a push it made, one killed before its landed
  // line (its deploy still owed) — has none, and its release or retry does not
  // make one, so --landed-projects says its projects are not known.
  if (MODE === "land" && !isFile(HELD) && !existsSync(LANDED) && !nonEmpty(DEPLOY_OWED) && !existsSync(LANDED_PUSHES)) {
    try {
      writeAtomic(LANDED_PUSHES, "");
    } catch (e) {
      notClosed(
        `could not create ${LANDED_PUSHES}: ${e instanceof Error ? e.message : String(e)} — fix it, then close again`,
      );
    }
  }

  // T3's own worktree, resolved ONCE, before anything is removed: these
  // scripts may run from a worktree this run removes, and a later lookup that
  // returned "" would make the removal below take T3's tree. It also seeds the
  // ledger, for a session that never had to ask where to write. A session
  // outside T3 has no worktree of its own recorded (NO_OWN_WORKTREE).
  const ownRun = run(process.execPath, nodeArgs(THREAD, ["--worktree"]), { out: "pipe", err: "pipe" });
  const T3_WORKTREE = chomp(ownRun.stdout);
  const NO_OWN_WORKTREE = T3_WORKTREE === "" && ownRun.stderr.includes("has no worktree recorded");
  if (T3_WORKTREE && isDir(T3_WORKTREE)) {
    run("bash", [WRITE_ROOT, T3_WORKTREE], { out: "ignore", err: "ignore" });
  }

  if (!isFile(LEDGER)) die("this thread owns no worktrees — nothing to land");
  // The report names the subject of the FIRST held landing.
  if (MODE === "release") {
    if (!isFile(HELD)) notClosed("nothing is held — land with --hold first");
    SUBJECT = firstLine(HELD);
  }
  if (MODE !== "check" && !SUBJECT) die("a commit subject is required");

  // The worktree holding the journal is the one its recorded path
  // (`<worktree>/journal/<date>/<file>`) starts with; its SHA is the last line's.
  const holdsJournal = (wt: string): boolean => {
    if (!isFile(JOURNAL_REF)) return false;
    const p = firstLine(JOURNAL_REF);
    if (!p) return false;
    return p.startsWith(`${wt}/journal/`);
  };

  // The project's Next block and status sentence, captured while the records'
  // worktree exists: here from the thread's own copy (right for --check and a
  // retry with nothing to land), and again by landOne from the merged tree,
  // which may hold another session's rows. A journal with no project has none.
  let NEXT_OUTPUT = "";
  let STATUS_LINE = "";
  let PROJECT_REL = "";
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
      const m = /^project:[ \t]*([^\n]+?)[ \t\r]*$/m.exec(readFileSync(JOURNAL_PATH, "utf8"));
      let PROJECT_REF = (m?.[1] ?? "").replace(/^["']|["']$/g, "");
      // YAML's null is the schema's one-off value, not a folder.
      if (["null", "Null", "NULL", "~"].includes(PROJECT_REF)) PROJECT_REF = "";
      if (PROJECT_REF) {
        const cut = JOURNAL_PATH.indexOf("/journal/");
        const RECORDS_WT = cut === -1 ? JOURNAL_PATH : JOURNAL_PATH.slice(0, cut);
        PROJECT_REL = PROJECT_REF.startsWith("projects/") ? PROJECT_REF : `projects/${PROJECT_REF}`;
        deriveNext(`${RECORDS_WT}/${PROJECT_REL}`);
      }
    }
  }

  // Every satellite worktree is removed last, after the final check — among
  // them the one holding these scripts, whose siblings are opened by name on
  // every call, and the one holding the checkers — and a held close keeps them
  // all until its --release.
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

  // The deploy obligation, one SHARED⇥SHA line per repo: "this push is owed a
  // good run". Only the poller's success removes it, so a retry that finds
  // nothing left to land still polls, and the checks refuse while one is left.
  const readOwed = (): string[][] =>
    isFile(DEPLOY_OWED) ? readLines(readFileSync(DEPLOY_OWED, "utf8")).map((l) => l.split("\t")) : [];
  const owedShaFor = (shared: string): string | null => {
    const hit = readOwed().find((f) => f[0] === shared);
    return hit?.[1] ? hit[1] : null;
  };
  const owedWithout = (shared: string): string =>
    readOwed()
      .filter((f) => f[0] !== shared)
      .map((f) => `${f.join("\t")}\n`)
      .join("");
  const clearOwed = (shared: string): void => writeAtomic(DEPLOY_OWED, owedWithout(shared));
  const setOwed = (shared: string, sha: string): void =>
    writeAtomic(DEPLOY_OWED, `${owedWithout(shared)}${shared}\t${sha}\n`, "owed-replace");

  // owner/name off <shared>'s configured origin, or null when it is not on
  // GitHub — live-checks.ts's githubRepoOf, the one reader (configured URL, not
  // the insteadOf expansion; an SSH host alias resolved through `ssh -G`, no
  // connection made). A read that failed is NOT CLOSED, never "no repo".
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

  // pollDeploy <shared> <sha> — wait for every check and status GitHub reports
  // on the push (await-push-checks.ts says what passing means; its exit 3 is
  // "this repo reports nothing, and nothing was expected"). Anything else not
  // 0 is NOT CLOSED with the obligation kept, and the retry polls again. A repo
  // not on GitHub, or no `gh` on this machine, settles with a line saying so;
  // a `gh` that is present but cannot read the checks is NOT CLOSED.
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

  // The recorded journal path, repo-relative (its worktree may be gone by now).
  const journalRel = (): string | null => {
    if (!isFile(JOURNAL_REF)) return null;
    const p = firstLine(JOURNAL_REF);
    if (!p) return null;
    const at = p.lastIndexOf("/journal/");
    if (at === -1) return null;
    return `journal/${p.slice(at + "/journal/".length)}`;
  };

  // A worktree's `git status --porcelain`; a failed read stops the close, never "clean".
  const wtStatus = (wt: string): string => {
    const r = git(wt, ["status", "--porcelain"]);
    if (!r.ok) notClosed(`could not read the status of ${wt} — git failed; re-run`);
    return chomp(r.stdout);
  };

  // What <wt> changed since <base>, tracked plus untracked; a failed read stops
  // the close rather than reading as "nothing changed".
  const changedPaths = (wt: string, base: string): string[] => {
    const d = git(wt, ["diff", "-z", "--name-only", "--no-renames", base]);
    const u = d.ok ? git(wt, ["ls-files", "-z", "--others", "--exclude-standard"]) : d;
    if (!d.ok || !u.ok) notClosed(`could not list what ${wt} changed since ${base} — git failed; re-run`);
    return `${d.stdout}${u.stdout}`.split("\0").slice(0, -1);
  };


  // THE CHECKS: what a change can break without failing a build, a test or a
  // deploy. All run from ONE copy, the workbench worktree of this thread's
  // ledger (CHECKS_WT, below): the every-repo ones on every repo, the rest on
  // the workbench worktree only. `touches` decides whether a close pays for the
  // check at all; the checker itself scans `--since <base>`, unless the gate
  // gives its own arguments (the standards check reads the tracked tree).
  type Gate = {
    rel: string;
    what: string;
    everyRepo: boolean;
    touches: (p: string[]) => boolean;
    env?: (held: Set<string>) => Record<string, string>;
    args?: string[];
  };
  const any =
    (re: RegExp) =>
    (paths: string[]): boolean =>
      paths.some((p) => re.test(p));
  const GATES: Gate[] = [
    {
      rel: ".agents/checks/check-decision-records.ts",
      what: "decision record",
      everyRepo: true,
      touches: () => true,
    },
    {
      rel: ".agents/checks/check-integration-manifest.ts",
      what: "integration manifest",
      everyRepo: true,
      touches: () => true,
    },
    {
      rel: ".agents/checks/check-scripts.ts",
      what: "script tests",
      everyRepo: true,
      touches: () => true,
    },
    {
      rel: ".agents/checks/check-secrets.ts",
      what: "secret scan",
      everyRepo: true,
      touches: () => true,
    },
    {
      rel: ".agents/checks/check-standards-refs.ts",
      what: "standards citations",
      everyRepo: false,
      touches: () => true,
      args: [],
    },
    {
      rel: ".agents/skills/close/scripts/check-roadmap-decisions.ts",
      what: "something left open in a roadmap or report",
      everyRepo: false,
      touches: any(/^projects\//),
      // The specs this landing holds for their live checks: only their
      // in-progress rows ride.
      env: (held) => ({ LAND_HELD_SPECS: [...held].sort().join("\n") }),
    },
  ];
  let CHECKS_WT = "";

  // Run one checker over what <wt> changed since <base>, in <wt>, and refuse
  // with every violation line it printed (stderr), not just the first.
  const refuseOnCheck = (
    check: string,
    wt: string,
    base: string,
    what: string,
    extraEnv: Record<string, string> = {},
    args: string[] = ["--since", base],
  ): void => {
    const r = run(process.execPath, [...NODE_TS, check, ...args], {
      cwd: wt,
      env: { ...process.env, ...extraEnv, PWD: wt },
      out: "ignore",
      err: "pipe",
    });
    if (r.ok) return;
    const out = chomp(r.stderr);
    if (!out) notClosed(`${what} rejected in ${wt}: ${check} exited non-zero with no message`);
    const lines = out.split("\n");
    process.stderr.write(lines.map((l) => `  ${l}\n`).join(""));
    notClosed(`${what} rejected in ${wt}: ${lines[0]} (${lines.length} line(s) above)`);
  };

  // The journal entry against journal-entry.md's schema, in the worktree that
  // holds it. A missing checker refuses rather than skips.
  const FM_CHECK = `${SCRIPT_DIR}/check-journal-entry.ts`;
  const journalGate = (wt: string): void => {
    const JREL = holdsJournal(wt) ? journalRel() : null;
    if (JREL === null || !isFile(`${wt}/${JREL}`)) return;
    if (!isFile(FM_CHECK)) notClosed(`journal check missing: ${FM_CHECK}`);
    const r = run(process.execPath, nodeArgs(FM_CHECK, [JREL]), {
      cwd: wt,
      env: { ...process.env, PWD: wt },
      out: "inherit",
      err: "inherit",
    });
    if (!r.ok) notClosed(`journal entry fails the schema: ${wt}/${JREL}`);
  };

  /** Every check that applies to <wt>, over what it changed since <base>;
   *  <held> is heldSpecs' answer for it. */
  const runGates = (wt: string, base: string, held: Set<string>): void => {
    const paths = changedPaths(wt, base);
    for (const g of GATES) {
      if (!g.everyRepo && wt !== CHECKS_WT) continue;
      if (!g.touches(paths)) continue;
      // A checker missing from the workbench worktree (a branch older than
      // it) refused no close in the 60 days measured; it is named, not refused.
      if (!CHECKS_WT || !isFile(`${CHECKS_WT}/${g.rel}`)) {
        warn(`  ${g.what}: not checked — ${CHECKS_WT || "no workbench worktree"} holds no ${g.rel}`);
        continue;
      }
      refuseOnCheck(`${CHECKS_WT}/${g.rel}`, wt, base, g.what, g.env?.(held) ?? {}, g.args);
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

  // Each repo's trunk is asked of trunk.ts (origin/HEAD), never spelled, and memoized.
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

  // Wire roadmap-merge.ts into this repo's merges of ROADMAP.md and project
  // READMEs (a driver lives only in config; the attribute in info/attributes).
  // Best effort: without it the merge is git's own.
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
        { out: "inherit" },
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
      } catch {}
    }
  };

  // resyncNext <worktree> <base> — re-derive `status:` and `next:` for every
  // project whose ROADMAP.md, README.md or a spec report this push changes, and
  // every project waiting on one of them, so a README never lands disagreeing
  // with its table. Run before every push; a failed re-derive stops the close.
  const resyncNext = (wt: string, base: string): void => {
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
    // Every project naming one of them (roadmap.ts says why this set is not
    // projectsWaitingOn's).
    for (const dep of projectsNaming(wt, dirs)) if (!dirs.includes(dep)) dirs.push(dep);
    dirs.sort();
    const changed: string[] = [];
    for (const dir of dirs) {
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

  // ── The project's status, kept by the close ──────────────

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

  // Which of <names> (`specs/NNN-name`) spec-state.ts reads `complete` in
  // <wt>/<proj>.
  const completeIn = (wt: string, proj: string, names: Set<string>): Set<string> => {
    const dir = `${wt}/${proj}`;
    if (!isFile(SPEC_STATE)) notClosed(`spec-state.ts missing: ${SPEC_STATE}`);
    const st = run(process.execPath, nodeArgs(SPEC_STATE, [dir]), { out: "pipe", err: "pipe" });
    if (!st.ok) notClosed(`spec-state.ts could not read ${proj}: ${lastLine(st.stderr, `exit ${st.status}`)}`);
    return new Set(
      chomp(st.stdout)
        .split("\n")
        .map((l) => l.split("\t"))
        .filter(([name, state]) => name && state === "complete" && names.has(name))
        .map(([name]) => name ?? ""),
    );
  };

  // The specs whose report this push changes and spec-state.ts reads
  // `complete`, by project. Row promotion and the live checks both ask.
  const completeSpecs = (wt: string, base: string): [string, Set<string>][] => {
    const out: [string, Set<string>][] = [];
    for (const [proj, names] of [...changedReports(wt, base)].sort(([a], [b]) => a.localeCompare(b))) {
      const complete = completeIn(wt, proj, names);
      if (complete.size > 0) out.push([proj, complete]);
    }
    return out;
  };

  // Does <wt>/<spec>/tasks.md declare at least one live check?
  const declaresLive = (wt: string, spec: string): boolean => {
    const tasks = `${wt}/${spec}/tasks.md`;
    return isFile(tasks) && parseLiveChecks(readFileSync(tasks, "utf8")).checks.length > 0;
  };

  const SPEC_DIR = /^(projects\/[^/]+\/[^/]+)\/(specs\/[^/]+)$/;

  // The specs this close already owes a check of whose declaration is in
  // <shared> (`projects/…/specs/NNN-name` each).
  const owedSpecsOf = (shared: string): Set<string> => {
    const declRepo = shared.replace(/\/+$/, "");
    return new Set(
      readLiveOwed()
        .filter((o) => o.declRepo === declRepo)
        .map((o) => o.spec),
    );
  };

  // Which of <specs> (`projects/…/specs/NNN-name`) spec-state.ts reads
  // `complete` in <wt>; a spec whose folder is gone is not.
  const completeOf = (wt: string, specs: Iterable<string>): Set<string> => {
    const byProj = new Map<string, Set<string>>();
    for (const p of specs) {
      const m = SPEC_DIR.exec(p);
      if (!m?.[1] || !m[2] || !isDir(`${wt}/${p}`)) continue;
      byProj.set(m[1], (byProj.get(m[1]) ?? new Set()).add(m[2]));
    }
    const out = new Set<string>();
    for (const [proj, names] of [...byProj].sort(([a], [b]) => a.localeCompare(b)))
      for (const spec of completeIn(wt, proj, names)) out.add(`${proj}/${spec}`);
    return out;
  };

  // heldSpecs <worktree> <shared> <base> — the specs this landing holds for
  // their live checks, `projects/…/specs/NNN-name` each: complete in <wt>,
  // declaring at least one check, and already owed by this close, written
  // complete by this push, or with checks changed since <base> — the specs
  // collectLive owes. Their rows wait for the --release that proves them
  //, and they are the in-progress rows the roadmap gate lets ride
  // (LAND_HELD_SPECS); any other in-progress row it refuses.
  const heldSpecs = (wt: string, shared: string, base: string): Set<string> => {
    const owed = owedSpecsOf(shared);
    const candidates = new Set(owed);
    for (const [proj, names] of changedReports(wt, base)) for (const n of names) candidates.add(`${proj}/${n}`);
    for (const p of changedPaths(wt, base)) {
      const m = /^(projects\/[^/]+\/[^/]+\/specs\/[^/]+)\/tasks\.md$/.exec(p);
      if (m?.[1]) candidates.add(m[1]);
    }
    const held = new Set<string>();
    for (const p of completeOf(wt, candidates))
      if (declaresLive(wt, p) && (owed.has(p) || !wasComplete(wt, base, `${p}/report.md`) || checksMoved(wt, base, p)))
        held.add(p);
    return held;
  };

  // setRowsDone <worktree> <specs by project> — set `done` every row naming
  // one of the specs (never a `closed:` or `absorbed by` row), re-derive that
  // README; the files changed.
  const setRowsDone = (wt: string, specs: [string, Set<string>][]): string[] => {
    const touched: string[] = [];
    for (const [proj, complete] of specs) {
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

  // Set `done` every row naming a spec this push makes complete, or a spec
  // this close owes whose report reads complete, except a spec in <held>: its
  // row is the --release's to set. An owed spec this landing no longer holds
  // is one whose last check was removed, and nothing would set it later.
  const promoteFinishedRows = (wt: string, shared: string, base: string, held: Set<string>): string[] => {
    const candidates = new Set<string>();
    for (const [proj, names] of completeSpecs(wt, base)) for (const n of names) candidates.add(`${proj}/${n}`);
    for (const p of completeOf(wt, owedSpecsOf(shared))) candidates.add(p);
    const finished = new Map<string, Set<string>>();
    for (const p of [...candidates].sort()) {
      const m = SPEC_DIR.exec(p);
      if (!m?.[1] || !m[2]) continue;
      if (!held.has(p)) finished.set(m[1], (finished.get(m[1]) ?? new Set()).add(m[2]));
      else if (MODE !== "release")
        say(
          `  roadmap: ${m[1]} ${m[2]} reads complete — its row is set done when land.ts --release proves its live checks`,
        );
    }
    return setRowsDone(wt, [...finished]);
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
        // the output pipes open past the kill. Its 124 is the timeout; the
        // grace before the KILL is live-checks.ts's LIVE_CHECK_GRACE_S. Stock
        // macOS has no timeout(1): there coreutils' gtimeout, else GROUP_LIMIT, a
        // Node supervisor that does the same — bash in a process group of its
        // own, TERM to the group at the limit, KILL after the grace, exit 124.
        // Under this call's own limit alone, bash was killed and a child it
        // started outlived the check.
        const lc = liveCheckArgv(timeout, o.body);
        const tbin = timeoutBin();
        const argv =
          tbin === null ? [process.execPath, "-e", GROUP_LIMIT, String(timeout), ...lc.slice(3)] : [tbin, ...lc];
        const r = spawnSync(argv[0] ?? "bash", argv.slice(1), {
          cwd: runTree(o.declRepo, o.repo === o.declRepo ? o.commit : ""),
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: (timeout + LIVE_CHECK_GRACE_S + 30) * 1000,
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

  // verify.ts records what it passed on; --stamped answers whether that is
  // still what every worktree holds (the records the close writes after it do
  // not count). Asked once, before the first commit; a missing or crashing
  // verify.ts is refused, never read as a pass.
  let VERIFIED = false;
  const requireVerified = (): void => {
    if (VERIFIED) return;
    if (!isFile(VERIFY)) notClosed(`verify check missing: ${VERIFY}`);
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

  // One lock per repo (the name commitViaSsh derives), so a close and an
  // automation never interleave a fetch and a push. Held for seconds: around
  // the fetch the checks measure from, and around `publish`'s fetch,
  // comparison and push — never across a check or a deploy (held
  // through two app checks for 21 minutes, it failed another push's deploy).
  // A `flock -w 120` child holds it while its stdin stays open.
  const lockOf = (shared: string): string => `/tmp/${basename(shared)}-git.lock`;
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
  /** Run <fn> holding <lock>; NOT CLOSED when it cannot be taken in 120 s. */
  const underLock = async <T>(lock: string, fn: () => T): Promise<T> => {
    const held = await takeLock(lock);
    if (!held) notClosed(`could not take ${lock} within 120s — another writer holds it`);
    try {
      return fn();
    } finally {
      await releaseLock(held);
    }
  };

  // A repo ready to push: the trunk its checks saw, and the three steps
  // `publish` runs — settle an earlier deploy the push cannot take over
  // (unlocked: that deploy takes the lock to fetch), push (locked), and the
  // slow rest once every lock is let go.
  type Landing = {
    WT: string;
    SHARED: string;
    BRANCH: string;
    TRUNK: string;
    LOCK: string;
    /** origin/<trunk> as the merge the checks judged saw it. */
    CHECKED: string;
    settle: () => void;
    /** This round's landed-pushes event for the repo: an attempt, or nothing to push. */
    record: () => string;
    /** null once pushed and recorded; the refusal when the push itself failed. */
    push: () => Promise<string | null>;
    after: () => void;
  };

  // The HEAD each worktree's merged-tree app checks passed on: a trunk that
  // moved again and brought only Markdown does not repeat them.
  const APP_CHECKS_PASSED = new Map<string, string>();

  // A trunk change can pass alone and fail beside this branch (2026-10-15:
  // one branch added an argument to a shared builder, another a caller; it
  // landed and deployed a crash). After a merge, every unit the branch changed
  // and every unit importing a shared file it changed (importers.ts) runs its
  // own `check` over the merged tree.
  const mergedAppChecks = (WT: string, base: string): void => {
    const head = chomp(git(WT, ["rev-parse", "HEAD"]).stdout);
    const passed = APP_CHECKS_PASSED.get(WT);
    if (passed !== undefined && head !== "") {
      const since = git(WT, ["diff", "-z", "--name-only", passed, head]);
      if (since.ok && since.stdout.split("\0").every((p) => p === "" || p.endsWith(".md"))) {
        APP_CHECKS_PASSED.set(WT, head);
        say(`  app checks on the merged tree still stand in ${WT}: the trunk brought only Markdown since they passed`);
        return;
      }
    }
    const changed = changedPaths(WT, base);
    let importers: string[] = [];
    try {
      importers = importerClosure(WT, changed);
    } catch (e) {
      notClosed(
        `could not read the code in ${WT} for importers of the shared code it changed — ${(e as Error).message}`,
      );
    }
    // A file's unit: its integration or package, or the nearest folder under
    // apps/ holding a package.json.
    const unitOf = (p: string): string[] => {
      const shared = sharedUnit(p);
      if (shared !== null) return isFile(`${WT}/${shared}/package.json`) ? [shared] : [];
      for (let dir = dirname(p); dir.startsWith("apps/"); dir = dirname(dir))
        if (isFile(`${WT}/${dir}/package.json`)) return [dir];
      return [];
    };
    for (const unit of [...new Set([...changed, ...importers].flatMap(unitOf))].sort()) {
      const pkg = `${WT}/${unit}/package.json`;
      let check: unknown;
      try {
        check = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, unknown> }).scripts?.check;
      } catch {
        notClosed(`${pkg} is not JSON, so ${unit}'s check cannot run on the merged tree`);
      }
      if (typeof check !== "string") continue;
      const r = run("npm", ["run", "--silent", "check"], {
        cwd: `${WT}/${unit}`,
        env: { ...process.env, PWD: `${WT}/${unit}` },
        out: "pipe",
        err: "pipe",
      });
      if (r.ok) continue;
      const lines = chomp(`${r.stdout}\n${r.stderr}`)
        .split("\n")
        .filter((l) => l.trim() !== "");
      process.stderr.write(lines.map((l) => `  ${l}\n`).join(""));
      const first = lines.find((l) => /\berror\b/i.test(l)) ?? lines[0] ?? `npm run check exited ${r.status}`;
      notClosed(`${unit}'s check fails on the merged tree in ${WT}: ${first.trim()}`);
    }
    if (head !== "") APP_CHECKS_PASSED.set(WT, head);
  };

  // landOne <worktree> <shared> <branch> — everything that can refuse this
  // repo's landing, run without its lock; `publish` pushes only once every
  // repo has passed (one half of a two-repo change must never land while the
  // other is refused later). null: nothing to push. Run
  // again on a repo whose trunk moved, it merges the new trunk and judges the
  // result as a re-run would.
  const landOne = async (WT: string, SHARED: string, BRANCH: string): Promise<Landing | null> => {
    // A deploy an earlier run left owed: a retry with nothing new re-polls it
    // below; new work lands first and its push takes the obligation over.
    const OWED_SHA = owedShaFor(SHARED);
    const SHARED_KEY = SHARED.replace(/\/+$/, "");
    // A worktree gone before it landed took its work with it: say so.
    if (!isDir(WT)) {
      const gone = landedShaFor(SHARED);
      if (gone !== null) {
        if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA);
        LANDED_NOW.set(SHARED_KEY, gone);
        bindLive(SHARED, gone, false);
        return null;
      }
      notClosed(`worktree missing before landing: ${WT}`);
    }

    // Already landed and nothing since: a re-run must not re-land it, but a
    // session that kept working after its close has new commits to land.
    const PREV = landedShaFor(SHARED);
    if (PREV !== null) {
      const status = wtStatus(WT);
      if (PREV === chomp(git(WT, ["rev-parse", "HEAD"]).stdout) && status === "") {
        if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA);
        LANDED_NOW.set(SHARED_KEY, PREV);
        bindLive(SHARED, PREV, false);
        if ((T3_WORKTREE || NO_OWN_WORKTREE) && WT !== T3_WORKTREE) DEFERRED_REMOVALS.push([WT, SHARED, BRANCH]);
        return null;
      }
    }

    const LOCK = lockOf(SHARED);

    // A conflict a refused attempt left is unfinished, not dirty: `git add -A`
    // would commit its markers to the trunk.
    const um = git(WT, ["diff", "-z", "--name-only", "--diff-filter=U"]);
    if (!um.ok) notClosed(`could not list the unmerged paths in ${WT} — git diff failed; re-run`);
    const UNMERGED = um.stdout.split("\0").filter((p) => p !== "");
    if (UNMERGED.length > 0) {
      notClosed(`unresolved conflict in ${WT}: ${UNMERGED.join(" ")} — resolve it, then re-run`);
    }

    const trunk = trunkOf(SHARED);
    if (trunk === null)
      notClosed(`no trunk branch in ${SHARED} (origin/HEAD unset and no origin/main or origin/master)`);
    const TRUNK = trunk;
    // FETCHED is read under the same lock as the fetch: a sibling worktree
    // fetching later moves the shared ref without this HEAD merging it, so
    // the merge, the checks and the push's "still where we checked it" all
    // use FETCHED, never the live ref.
    const fetched = await underLock(LOCK, (): { sha: string } | { failed: "fetch" | "read" } => {
      if (!git(WT, ["fetch", "-q", "origin", TRUNK], { out: "inherit" }).ok) return { failed: "fetch" };
      const r = git(WT, ["rev-parse", `origin/${TRUNK}`]);
      const sha = chomp(r.stdout);
      return r.ok && sha ? { sha } : { failed: "read" };
    });
    if ("failed" in fetched)
      notClosed(
        fetched.failed === "fetch"
          ? `could not fetch origin/${TRUNK} for ${SHARED}`
          : `could not read origin/${TRUNK} in ${WT} — git rev-parse failed; re-run`,
      );
    const FETCHED = fetched.sha;

    // Verify passed on this content (requireVerified), asked after the gates,
    // which refuse on their own terms first, and before anything is staged.
    requireVerified();
    const commitAll = (paths: string[] | null, subject: string): void => {
      if (!git(WT, ["add", ...(paths === null ? ["-A"] : ["--", ...paths])], { out: "inherit", err: "inherit" }).ok)
        notClosed(`could not stage ${WT}`);
      if (git(WT, ["diff", "--cached", "--quiet"]).ok) return;
      if (!git(WT, ["commit", "-q", "-m", subject], { out: "inherit", err: "inherit" }).ok)
        notClosed(`could not commit ${WT}`);
    };
    if (wtStatus(WT) !== "") commitAll(null, SUBJECT);

    // The journal name, re-checked: another thread may have landed the same
    // name since journal-file.ts looked. Taken means taken by a commit this
    // HEAD does not contain — this session's own earlier push is not a clash.
    if (holdsJournal(WT)) {
      const REL = journalRel();
      if (REL !== null) {
        let OWNER = "";
        if (git(WT, ["cat-file", "-e", `${FETCHED}:${REL}`], { out: "inherit" }).ok) {
          OWNER = chomp(git(WT, ["rev-list", "-1", FETCHED, "--", REL]).stdout);
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
            if (git(WT, ["cat-file", "-e", `${FETCHED}:${NEWREL}`], { out: "inherit" }).ok) continue;
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

    // No rebase and no pull: a conflict halts with both sides in this
    // worktree, and a re-run resumes. ROADMAP.md merges row by row.
    registerRoadmapMerge(WT);
    if (!git(WT, ["merge-base", "--is-ancestor", FETCHED, "HEAD"], { out: "inherit" }).ok) {
      if (!git(WT, ["merge", "-q", "--no-edit", FETCHED], { out: "inherit" }).ok) {
        notClosed(`conflict in ${WT}`);
      }
    }

    // From here the tree is what the push publishes. The bookkeeping and every
    // check run once on it, on every attempt — after a merge just made, after
    // one a refused attempt left, or with none needed — measured from where it
    // leaves the trunk. Checked before the merge, a branch behind the trunk
    // would be refused for what the trunk had already fixed.
    const mb = git(WT, ["merge-base", "HEAD", FETCHED]);
    if (!mb.ok) notClosed(`git merge-base HEAD origin/${TRUNK} failed in ${WT}`);
    const BASE = chomp(mb.stdout);
    const HELD_SPECS = heldSpecs(WT, SHARED, BASE);
    const booked = promoteFinishedRows(WT, SHARED, BASE, HELD_SPECS);
    const quoted = holdsJournal(WT) ? quoteAuditLines(WT, BASE) : null;
    if (quoted !== null) booked.push(quoted);
    if (booked.length > 0) commitAll(booked, `${SUBJECT} (rows set done, audit lines quoted)`);
    journalGate(WT);
    runGates(WT, BASE, HELD_SPECS);
    const unpushedMerges = git(WT, ["rev-list", "--merges", `${FETCHED}..HEAD`]);
    if (!unpushedMerges.ok)
      notClosed(`could not list the merges ${WT} holds past origin/${TRUNK} — git failed; re-run`);
    if (CHECKS_WT === WT && chomp(unpushedMerges.stdout) !== "") mergedAppChecks(WT, BASE);
    resyncNext(WT, FETCHED);
    if (PROJECT_REL && holdsJournal(WT)) deriveNext(`${WT}/${PROJECT_REL}`);

    // The review receipt, asked again of what the push publishes: the merge
    // can move a file the review covered or relied on. Stale stops the close
    // with the paths named and the merge kept.
    if (!isFile(AUDIT)) notClosed(`review receipt reader missing: ${AUDIT}`);
    const receipt = run(process.execPath, nodeArgs(AUDIT, ["check", "--owner", TID, WT]), { out: "pipe", err: "pipe" });
    // The user may override it for one landing, in their own words with their
    // name and the date (CLOSE_REVIEW_OVERRIDDEN_BY; .agents/skills/review/authorized-by.ts):
    // what the review does not cover is printed, then the override, and the
    // journal quotes it.
    const overriddenBy = (process.env.CLOSE_REVIEW_OVERRIDDEN_BY ?? "").trim();
    if (!receipt.ok) {
      const why = chomp(receipt.stderr)
        .split("\n")
        .filter((l) => l.startsWith("review: "));
      for (const l of why) say(`  ${l}`);
      if (why.length > 0 && authorizedBy(overriddenBy)) say(`  review: overridden for this landing — ${overriddenBy}`);
      else
        notClosed(
          why.length > 0
            ? `the independent review no longer covers what ${WT} would push — review the change within the remaining allowance, or restore the reviewed content, then close again`
            : `the review receipt check could not run (exit ${receipt.status}): ${lastLine(chomp(receipt.stderr), "no message")}`,
        );
    }

    // Every SHA is read checked: two failed reads once compared equal and a
    // committed change was reported as nothing to push.
    const revParse = (ref: string, err: "ignore" | "inherit" = "ignore"): string => {
      const r = git(WT, ["rev-parse", ref], { err });
      const sha = chomp(r.stdout);
      if (!r.ok || !sha) notClosed(`could not read ${ref} in ${WT} — git rev-parse failed; re-run`);
      return sha;
    };
    // `publish` pushes only while origin still holds the trunk the checks saw.
    const CHECKED = FETCHED;
    let SHA = "";

    // A push takes over an earlier deploy obligation only when it descends from
    // that SHA; otherwise the old SHA is proved first, before any lock (its
    // deploy takes this repo's lock to fetch).
    const settle = (): void => {
      const owed = owedShaFor(SHARED);
      const head = revParse("HEAD", "inherit");
      if (
        owed !== null &&
        owed !== head &&
        !git(WT, ["merge-base", "--is-ancestor", owed, head], { out: "ignore" }).ok
      ) {
        pollDeploy(SHARED, owed);
      }
    };

    // This round's event for --landed-projects: a push attempt (its own id, the
    // trunk it starts from, the SHA it is about to push), or a round with
    // nothing to push here. publish writes every event of a round in one atomic
    // write before the round's first push.
    let ATTEMPT = "";
    const record = (): string => {
      const before = revParse(`origin/${TRUNK}`);
      const head = revParse("HEAD", "inherit");
      ATTEMPT = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      return head === before
        ? `seen\t${ATTEMPT}\t${SHARED}\t${TRUNK}\t${before}\t${before}\n`
        : `push\t${ATTEMPT}\t${SHARED}\t${TRUNK}\t${before}\t${head}\n`;
    };
    // An attempt's outcome, once known: pushed, or refused (a push that failed
    // and that a refetched trunk does not hold; a fetch that fails leaves it
    // unknown, since the push may have been accepted with its answer lost). A
    // write that fails is said; the attempt then reads as unknown.
    const markOutcome = (kind: "pushed" | "refused"): void => {
      try {
        if (!existsSync(LANDED_PUSHES) || ATTEMPT === "") return;
        writeAtomic(LANDED_PUSHES, `${readFileSync(LANDED_PUSHES, "utf8")}${kind}\t${ATTEMPT}\n`);
      } catch (e) {
        say(
          `  landed-pushes: the ${kind} push of ${SHARED} not marked — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };

    const markRefused = (): void => {
      if (!git(WT, ["fetch", "-q", "origin", TRUNK]).ok) return;
      if (git(WT, ["merge-base", "--is-ancestor", SHA, `origin/${TRUNK}`]).ok) return;
      markOutcome("refused");
    };

    // ── The push, under the lock, once every repo has passed and its trunk is
    //    where its checks saw it ──
    const push = async (): Promise<string | null> => {
      // HEAD already at the trunk is nothing to push, never a failed push (an
      // archived repo refuses even an empty push); removal and the proof still run.
      const TRUNK_BEFORE = revParse(`origin/${TRUNK}`);
      SHA = revParse("HEAD", "inherit");

      // The order is the proof: record the live checks and the deploy
      // obligation for the SHA about to be pushed, push, record the landed SHA,
      // poll, clear. A kill anywhere leaves a retry that polls or refuses.
      // A release's push carries only the rows its proof set done: it owes no
      // check, and its commit must not rebind the ones just proved — were the
      // push to fail, each would name a commit no deploy could contain.
      if (MODE !== "release") {
        await collectLive(WT, SHARED, TRUNK_BEFORE);
        for (const [s, sha] of LANDED_NOW) bindLive(s, sha, false);
        bindLive(SHARED, SHA, true);
      }
      LANDED_NOW.set(SHARED_KEY, SHA);
      const OWED_BEFORE = owedShaFor(SHARED);
      setOwed(SHARED, SHA);

      if (SHA === TRUNK_BEFORE) {
        say(`  ${SHARED}: nothing to push (already at origin/${TRUNK})`);
      } else {
        let attempt = 1;
        for (;;) {
          if (git(WT, ["push", "-q", "origin", `HEAD:${TRUNK}`], { out: "inherit" }).ok) {
            markOutcome("pushed");
            break;
          }
          if (attempt >= Number(PUSH_RETRIES)) {
            // Nothing pushed: the obligation goes back, the work stays committed.
            if (OWED_BEFORE === null) clearOwed(SHARED);
            else setOwed(SHARED, OWED_BEFORE);
            markRefused();
            return `push of ${SHARED} failed`;
          }
          attempt += 1;
          run("sleep", [PUSH_SLEEP], { out: "inherit", err: "inherit" });
        }
      }
      killPoint("pushed");

      appendFileSync(LANDED, `${SHARED}\t${SHA}\n`);
      killPoint("landed");
      return null;
    };

    // ── After every push, every lock let go: the deploy can take minutes ──
    const after = (): void => {
      // ── The shared checkout, advanced best effort ──────────────────────────
      // The trunk on the remote is the truth. The shared tree is a convenience,
      // and one that another session may have dirty or on another branch.
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
      }

      // ── Wait for what the push started — the push deploys, not this ──────
      // A run that never starts or fails would look like success if unchecked.
      pollDeploy(SHARED, SHA);

      // ── Remove the satellite, never the harness's own worktree ──────────────
      if (T3_WORKTREE && WT === T3_WORKTREE) {
        say(`  landed ${SHARED} at ${SHA}`);
        return;
      }
      // The own worktree could not be identified at all. Removing on "it is
      // not the empty string" would remove the harness's worktree whenever the
      // lookup failed; refusing to remove is the safe direction. A session with
      // NO own worktree (it started in the main checkout) is a definite answer,
      // not a failed lookup, and its satellites go like any other.
      if (!T3_WORKTREE && !NO_OWN_WORKTREE) {
        warn(`  kept ${WT} — could not confirm it is not the harness's own worktree`);
        say(`  landed ${SHARED} at ${SHA}`);
        return;
      }


      // Removed at the end of the run, or kept there while the close stays held.
      DEFERRED_REMOVALS.push([WT, SHARED, BRANCH]);

      say(`  landed ${SHARED} at ${SHA}`);
    };

    return { WT, SHARED, BRANCH, TRUNK, LOCK, CHECKED, settle, record, push, after };
  };

  // publish — push every Landing once, under every repo's lock (taken in path
  // order), each trunk is confirmed where its checks saw it. A trunk that
  // moved is merged and judged again by landOne, unlocked, and the round
  // repeats; after TRUNK_ROUNDS it is NOT CLOSED with nothing pushed. A push
  // that fails outright finishes the repos already pushed, then refuses.
  const TRUNK_ROUNDS = 3;
  const publish = async (first: Landing[]): Promise<void> => {
    let landings = first;
    for (let round = 1; landings.length > 0; round += 1) {
      for (const l of landings) l.settle();
      const locks: ChildProcess[] = [];
      for (const lock of [...new Set(landings.map((l) => l.LOCK))].sort()) {
        const held = await takeLock(lock);
        if (!held) notClosed(`could not take ${lock} within 120s — another writer holds it`);
        locks.push(held);
      }
      const moved = landings.filter((l) => {
        if (!git(l.WT, ["fetch", "-q", "origin", l.TRUNK], { out: "inherit" }).ok)
          notClosed(`could not fetch origin/${l.TRUNK} for ${l.SHARED}`);
        return chomp(git(l.WT, ["rev-parse", `origin/${l.TRUNK}`]).stdout) !== l.CHECKED;
      });
      if (moved.length === 0) {
        const pushed: Landing[] = [];
        let failed: string | null = null;
        // Every push of the round is recorded, in one atomic write, before the
        // first one goes: a write that fails leaves the record as it was and
        // refuses with nothing pushed in any repo.
        try {
          // Only a close this land.ts began has a record to add to: one an older
          // land.ts began stays without, so --landed-projects says so.
          if (existsSync(LANDED_PUSHES)) {
            const kept = readFileSync(LANDED_PUSHES, "utf8");
            const lines: string[] = [];
            for (const l of landings) {
              lines.push(l.record());
              killPoint("record-built");
            }
            writeAtomic(LANDED_PUSHES, `${kept}${lines.join("")}`);
          }
        } catch (e) {
          for (const held of locks) await releaseLock(held);
          if (e instanceof Exit) throw e;
          notClosed(
            `could not record this round's pushes in ${LANDED_PUSHES}: ${e instanceof Error ? e.message : String(e)} — fix it, then close again`,
          );
        }
        for (const l of landings) {
          failed = await l.push();
          if (failed !== null) break;
          pushed.push(l);
        }
        for (const held of locks) await releaseLock(held);
        if (failed !== null) {
          for (const l of pushed) l.after();
          notClosed(failed);
        }
        break;
      }
      for (const held of locks) await releaseLock(held);
      for (const l of moved) {
        if (round >= TRUNK_ROUNDS)
          notClosed(
            `origin/${l.TRUNK} of ${l.SHARED} kept moving while this close checked it (${TRUNK_ROUNDS} rounds) — nothing was pushed; re-run the close`,
          );
        say(`  origin/${l.TRUNK} of ${l.SHARED} moved while its gates ran — merging it and checking again`);
      }
      const next: Landing[] = [];
      for (const l of landings) {
        if (!moved.includes(l)) {
          next.push(l);
          continue;
        }
        const again = await landOne(l.WT, l.SHARED, l.BRANCH);
        if (again) next.push(again);
      }
      landings = next;
    }
    for (const l of landings) l.after();
  };

  const LEDGER_LINES = readLines(readFileSync(LEDGER, "utf8")).filter((l) => l !== "");

  // The repo whose trunk must hold the journal, resolved before any worktree
  // is removed.
  let JOURNAL_SHARED = "";
  for (const line of LEDGER_LINES) {
    const [jwt = "", jshared = ""] = tabFields(line, 3);
    if (!jwt) continue;
    if (holdsJournal(jwt)) {
      JOURNAL_SHARED = jshared;
      break;
    }
  }

  // The checkers' one copy: the ledger's workbench worktree, resolved before
  // anything is removed (its removal is deferred to the end).
  CHECKS_WT =
    LEDGER_LINES.map((l) => tabFields(l, 3)[0] ?? "").find(
      (wt) => wt && isFile(`${wt}/.agents/skills/close/scripts/land.ts`),
    ) ?? "";

  if (MODE === "land") {
    // Every thread needs its journal entry, before anything is committed.
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

    const landings: Landing[] = [];
    for (const line of LEDGER_LINES) {
      const [WT = "", SHARED = "", BRANCH = ""] = tabFields(line, 3);
      if (!WT) continue;
      const landing = await landOne(WT, SHARED, BRANCH);
      if (landing) landings.push(landing);
    }
    await publish(landings);
    killPoint("landings-done");
    // Appended within one close: a second held landing keeps the first's lines.
    const kept = isFile(HARNESS_REF) ? readLines(readFileSync(HARNESS_REF, "utf8")) : [];
    harnessLinks(LEDGER_LINES, (l) => {
      const line = l.trim();
      if (!kept.includes(line)) kept.push(line);
    });
    if (kept.length > 0) writeAtomic(HARNESS_REF, kept.map((l) => `${l}\n`).join(""));
  }

  // ── The release: the live checks, then the rows they held ────────
  //
  // A release publishes nothing but the rows its proof sets done, so work
  // left in a worktree since its last landing — uncommitted, or committed and
  // on neither the SHA it landed nor the trunk — is refused before any check
  // runs: the checks proved would be the landed ones, not that work's. Every
  // owed check is proved next; any failure is NOT CLOSED, the hold kept and no
  // row moved. Then each row naming an owed spec whose report reads complete
  // is set `done` in the workbench worktree holding it, committed, and pushed
  // through landOne and publish like any landing. A release that stops before
  // that commit reaches origin takes it back out of the worktree, so a later
  // landing (a fix landed --hold) never carries a `done` its checks have not
  // earned; the hold is kept and the next --release sets the rows again. A
  // commit that did land stays, even when a later step fails. A worktree with
  // no row to set lands nothing; only a deploy an earlier run left owed is
  // polled again.
  let LIVE_REPORT: string[] = [];
  if (MODE === "release") {
    for (const line of LEDGER_LINES) {
      const [WT = "", SHARED = ""] = tabFields(line, 3);
      if (!WT || !isDir(WT)) continue;
      if (wtStatus(WT) !== "") notClosed(`uncommitted changes left in ${WT}`);
      const trunk = trunkOf(SHARED);
      if (trunk === null) notClosed(`no trunk branch in ${SHARED} to check ${WT} against`);
      const landed = landedShaFor(SHARED);
      const n = git(WT, ["rev-list", "--count", "HEAD", "--not", `origin/${trunk}`, ...(landed ? [landed] : [])]);
      if (!n.ok) notClosed(`could not count the commits in ${WT} that have not landed — git failed; re-run`);
      if (chomp(n.stdout) !== "0")
        notClosed(
          `${chomp(n.stdout)} commit(s) in ${WT} have not landed, and a release publishes only the rows it sets done — land them with land.ts "<subject>" --hold, then release`,
        );
    }
    const owed = readLiveOwed();
    LIVE_REPORT = await proveLive();
    const specsOf = new Map<string, Map<string, Set<string>>>();
    for (const o of owed) {
      const m = SPEC_DIR.exec(o.spec);
      if (!m?.[1] || !m[2]) continue;
      const byProj = specsOf.get(o.declRepo) ?? new Map<string, Set<string>>();
      byProj.set(m[1], (byProj.get(m[1]) ?? new Set()).add(m[2]));
      specsOf.set(o.declRepo, byProj);
    }
    // Each rows commit made: its worktree, repo, the HEAD before it and the
    // SHA the repo had landed then.
    const made: [string, string, string, string | null][] = [];
    try {
      const landings: Landing[] = [];
      for (const line of LEDGER_LINES) {
        const [WT = "", SHARED = "", BRANCH = ""] = tabFields(line, 3);
        const byProj = specsOf.get(SHARED.replace(/\/+$/, ""));
        if (!WT || !byProj) continue;
        if (!isDir(WT)) {
          warn(
            `  roadmap: ${WT} is gone, so the rows of ${[...byProj.values()].flatMap((s) => [...s]).join(", ")} were not set done`,
          );
          continue;
        }
        const finished: [string, Set<string>][] = [];
        for (const [proj, names] of [...byProj].sort(([a], [b]) => a.localeCompare(b))) {
          const complete = completeIn(WT, proj, names);
          if (complete.size > 0) finished.push([proj, complete]);
        }
        const before = chomp(git(WT, ["rev-parse", "HEAD"]).stdout);
        const touched = setRowsDone(WT, finished);
        if (touched.length > 0) {
          made.push([WT, SHARED, before, landedShaFor(SHARED)]);
          if (!git(WT, ["add", "--", ...touched], { out: "inherit", err: "inherit" }).ok)
            notClosed(`could not stage the rows set done in ${WT}`);
          if (
            !git(WT, ["diff", "--cached", "--quiet"]).ok &&
            !git(WT, ["commit", "-q", "-m", `${SUBJECT} (rows set done: live checks passed)`], {
              out: "inherit",
              err: "inherit",
            }).ok
          )
            notClosed(`could not commit the rows set done in ${WT}`);
        }
        // No row set: nothing of this release's to publish (the check above
        // refused any other work), so no landing, which would record and poll
        // whatever trunk the worktree has since moved to; only a deploy an
        // earlier run left owed is polled again.
        if (touched.length === 0) {
          const owedSha = owedShaFor(SHARED);
          if (owedSha !== null) pollDeploy(SHARED, owedSha);
          continue;
        }
        const landing = await landOne(WT, SHARED, BRANCH);
        if (landing) landings.push(landing);
      }
      await publish(landings);
    } catch (e) {
      // Not landed — the repo's landed SHA never moved: back to the HEAD
      // before the rows commit, any merge landOne made on it included.
      for (const [wt, shared, before, landed] of made) {
        if (landedShaFor(shared) !== landed) continue;
        if (git(wt, ["reset", "-q", "--hard", before]).ok)
          warn(
            `  roadmap: the rows set done in ${wt} did not land, so they are taken back out — land.ts --release again`,
          );
        else
          warn(
            `  roadmap: could not take the rows set done back out of ${wt} — run git reset --hard ${before} there before landing again`,
          );
      }
      throw e;
    }
  }

  // ── The proof, against a freshly fetched trunk in every repo ────────────
  //
  // Every landed SHA is on its trunk, the journal is in the tree, and no
  // worktree still holds anything. A stale ref would hide every failure worth
  // catching here (a push that raced, a journal name another thread took).

  if (!isFile(LANDED)) notClosed("nothing was landed");

  // A deploy obligation left here is a failed run no retry has seen succeed.
  for (const [oshared = "", osha = ""] of readOwed()) {
    if (oshared) notClosed(`the deploy of ${osha} to ${oshared} was never proved — re-run the close`);
  }

  let JOURNAL_MAIN_SHA = "";
  let JOURNAL_TRUNK = "";

  const FETCHED_REPOS = new Set<string>();
  for (const row of readLines(readFileSync(LANDED, "utf8"))) {
    const [SHARED = "", SHA = ""] = tabFields(row, 2);
    if (!SHARED) continue;
    // A repo since retired (merged into another with its history) proved its
    // landing when that close ran — gone,
    // or a folder that is no longer a repository.
    if (!isDir(SHARED) || !git(SHARED, ["rev-parse", "--git-dir"]).ok) continue;
    const chk = trunkOf(SHARED);
    if (chk === null) notClosed(`no trunk branch in ${SHARED} to check against`);
    const CHK_TRUNK = chk;
    if (!git(SHARED, ["fetch", "-q", "origin", CHK_TRUNK], { out: "inherit" }).ok)
      notClosed(`could not re-fetch ${SHARED} to check it`);
    FETCHED_REPOS.add(SHARED);
    if (!git(SHARED, ["merge-base", "--is-ancestor", SHA, `origin/${CHK_TRUNK}`], { out: "inherit" }).ok) {
      notClosed(`${SHA} is not on origin/${CHK_TRUNK} in ${SHARED}`);
    }
    const MAIN_SHA = chomp(git(SHARED, ["rev-parse", `origin/${CHK_TRUNK}`], { err: "inherit" }).stdout);
    if (JOURNAL_SHARED && SHARED === JOURNAL_SHARED) {
      JOURNAL_MAIN_SHA = MAIN_SHA;
      // The line names the journal repo's trunk, the one its SHA is on.
      JOURNAL_TRUNK = CHK_TRUNK;
    }
    if (VERBOSE === 1) say(`${basename(SHARED)}  ${SHA}  ancestor-of-origin/${CHK_TRUNK}`);
  }

  // The journal is proved by path: a rename around a collision must prove the
  // renamed file.
  const REL = journalRel();
  if (REL === null) notClosed("no journal entry for this thread — run journal-file.ts");
  if (!JOURNAL_SHARED) notClosed(`${REL} is in no worktree this thread owns, so nothing landed it`);
  if (landedShaFor(JOURNAL_SHARED) === null) notClosed(`${REL} has not landed — run land.ts`);
  const jt = trunkOf(JOURNAL_SHARED);
  if (jt === null) notClosed(`no trunk branch in ${JOURNAL_SHARED} to check the journal against`);
  if (!git(JOURNAL_SHARED, ["cat-file", "-e", `origin/${jt}:${REL}`], { out: "inherit" }).ok) {
    notClosed(`${REL} is not on origin/${jt} in ${JOURNAL_SHARED}`);
  }
  // Absolute, in the shared checkout: the worktree may be removed, and a
  // relative link resolves against the thread's own project.
  const JOURNAL_LANDED = `${JOURNAL_SHARED}/${REL}`;
  if (VERBOSE === 1) say(`journal  ${REL}  present`);

  // Anything still on disk must have nothing left in it; a worktree that is
  // gone is fine only if its SHA was recorded first.
  for (const line of LEDGER_LINES) {
    const [WT = "", SHARED = ""] = tabFields(line, 3);
    if (!WT) continue;
    if (!isDir(WT)) {
      if (landedShaFor(SHARED) === null) notClosed(`worktree missing before landing: ${WT}`);
      continue;
    }
    if (wtStatus(WT) !== "") notClosed(`uncommitted changes left in ${WT}`);
    const wtTrunk = trunkOf(SHARED);
    if (wtTrunk === null) notClosed(`no trunk branch in ${SHARED} to check ${WT} against`);
    if (!FETCHED_REPOS.has(SHARED)) git(WT, ["fetch", "-q", "origin", wtTrunk], { out: "inherit" });
    // An unreadable count is never zero.
    const ahead = git(WT, ["rev-list", "--count", `origin/${wtTrunk}..HEAD`]);
    if (!ahead.ok) notClosed(`could not count the commits in ${WT} that origin/${wtTrunk} lacks — git failed; re-run`);
    const AHEAD = chomp(ahead.stdout);
    if (AHEAD !== "0") notClosed(`${AHEAD} commit(s) in ${WT} that origin/${wtTrunk} does not have`);
  }

  // ── Passed ───────────────────────────────────────────────────────────────
  //
  // The closed marker is written only here, so a journal written before a
  // failed landing never suppresses the re-run. HELD is landed, deployed and
  // proved but not closed — no marker, report or line — until a --release
  // whose live checks all pass.
  // A landing never ends a hold, with or without --hold: only --release does.
  const STAYS_HELD =
    HOLD || ((MODE === "land" || MODE === "check") && isFile(HELD)) || (MODE === "land" && readLiveOwed().length > 0);
  // Owed checks with no hold: the landing stopped before holding; it runs again.
  if (MODE === "check" && !isFile(HELD) && readLiveOwed().length > 0)
    notClosed(
      'live checks are owed but the landing that owes them did not finish — run land.ts "<subject>" again, which holds on them',
    );

  // The report block /close copies verbatim, each field its own paragraph,
  // saved to the thread's state before the closed marker and printed last.
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
    // The **Project:** sentence replaces next-implement-command's own status comment.
    let nextLines = NEXT_OUTPUT.split("\n").filter((l) => l !== "");
    if (STATUS_LINE) {
      putLine("");
      putLine(`**Project:** ${STATUS_LINE}`);
      const slug = STATUS_LINE.split(" ")[0] ?? "";
      nextLines = nextLines.filter((l) => !l.startsWith(`# ${slug} — `) && !l.startsWith(`# ${slug} is blocked — `));
    }
    // Each command is its own copy block; an `/implement` is a handoff to a
    // fresh session, never started from this one.
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
    const links = isFile(HARNESS_REF) ? readLines(readFileSync(HARNESS_REF, "utf8")).filter((l) => l !== "") : [];
    if (links.length > 0) {
      putLine("");
      putLine("**Harness links:**");
      putLine("");
      for (const l of links) putLine(`- ${l}`);
    }
    if (LIVE_REPORT.length > 0) {
      putLine("");
      putLine("**Live checks:**");
      putLine("");
      for (const l of LIVE_REPORT) putLine(`- ${l}`);
    }
    putLine("");
  }

  // The last line: the journal repo's trunk and SHA, named from the same repo.
  if (!JOURNAL_MAIN_SHA) notClosed(`${REL} landed in ${JOURNAL_SHARED}, but its trunk could not be read to prove it`);
  if (!STAYS_HELD)
    putLine(`origin/${JOURNAL_TRUNK || "main"} is at ${JOURNAL_MAIN_SHA} — closing this tab loses nothing.`);

  // A --check marks a close closed only when a landing already saved its report.
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
    // Kept when a later landing removes `closed` and fails: end-of-turn.ts reads it.
    writeAtomic(`${STATE}/closed-once`, "");
    // A pause for the user's answer (end-of-turn.ts --pause) ends with a new close.
    rmSync(`${STATE}/reopened`, { force: true });
    rmSync(`${STATE}/paused`, { force: true });
    rmSync(HELD, { force: true });
    rmSync(LIVE_OWED, { force: true });
    rmSync(LIVE_PASSED, { force: true });
  }

  // ── Last of all: every satellite worktree, these scripts' own included ───
  //
  // Nothing below needs a sibling script. A held close keeps them for
  // --release, which removes them once the hold ends.
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
