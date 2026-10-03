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
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts.
//   LAND_PUSH_RETRIES, LAND_PUSH_SLEEP — 3 and 5s. The test suite shortens the
//                                        sleep; nothing in production sets them.
//
// THE CHECKS run before each commit, from the ledger worktree that holds
// `.agents/checks/` (the workbench's): decision records, integration manifests
// (when that checker exists), script tests, skill manifests, secrets and
// standards citations.
//
// THE DEPLOY CHECK is off unless the repo carries `.agents/deployable-prefixes.json`
// (a JSON array of path prefixes whose push deploys something). With it, a
// landing that touched one of those paths runs `.agents/deploy/await-deploy-run.sh
// --sha <sha>` from the repo, which must confirm a deploy run started for it.
//
// peers:
//   .agents/skills/close/scripts/tests/land-cases.ts  (the suite; land.test.ts, land.gates.test.ts
//                                             and land.rows.test.ts each run a range)
//   .agents/skills/close/scripts/roadmap-merge.ts   (ROADMAP.md merges row by row)
//   .agents/skills/close/scripts/write-root.sh   (writes the ledger)
//   .agents/skills/close/scripts/lock.sh         (the per-repo lock)
//   .agents/checks/check-decision-records.ts     (run before each commit)
//   .agents/checks/check-integration-manifest.ts (run before each commit, when present)
//   .agents/checks/check-scripts.ts              (run before each commit)
//   .agents/checks/check-skills.ts               (run before each commit, from the
//                                                 worktree that holds it)
//   .agents/checks/check-secrets.ts              (run before each commit, when present)
//   .agents/checks/check-standards-refs.ts       (run before each commit, when present)
//   .agents/deploy/await-deploy-run.sh           (polled, per repo, on landing — opt-in)
//
// Exit: 0 landed and checked (the line on stdout) · 2 no thread · 3 NOT CLOSED

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
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const THREAD = `${SCRIPT_DIR}/thread.ts`;
const WRITE_ROOT = `${SCRIPT_DIR}/write-root.sh`;
const LOCK_SH = `${SCRIPT_DIR}/lock.sh`;
const TRUNK_TS = `${SCRIPT_DIR}/trunk.ts`;
const NEXT_COMMAND = `${SCRIPT_DIR}/next-implement-command.ts`;

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
  let SUBJECT = "";
  for (const a of process.argv.slice(2)) {
    if (a === "--check") MODE = "check";
    else if (a === "--gate") MODE = "gate";
    else if (a === "--verbose") VERBOSE = 1;
    else if (a.startsWith("-")) {
      warn('usage: land.ts "<subject>" | --check [--verbose] | --gate');
      exit(2);
    } else SUBJECT = a;
  }

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
  mkdirSync(STATE, { recursive: true });

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
    if (!isFile(CLOSED) || !isFile(LEDGER)) {
      say("not-fired");
      exit(0);
    }
    for (const line of readLines(readFileSync(LEDGER, "utf8"))) {
      const [WT = ""] = tabFields(line, 3);
      if (!WT) continue;
      if (!isDir(WT)) continue;
      // An unreadable worktree is not a clean one: the close runs.
      const st = git(WT, ["status", "--porcelain"]);
      if (!st.ok || chomp(st.stdout) !== "") {
        say("not-fired");
        exit(0);
      }
      // The gate runs BEFORE `trunkOf` is used, so it resolves inline. An
      // unresolvable trunk, or a count git fails to read, reports `not-fired`,
      // which is the safe direction: the gate's job is to prove there is nothing
      // left, and a repo it cannot read is not a repo it can vouch for. (Read
      // as `$(… || echo 0)`, a failed count would be zero and the gate would
      // answer `fired`.)
      const gt = chomp(run(process.execPath, nodeArgs(TRUNK_TS, [WT])).stdout);
      if (!gt) {
        say("not-fired");
        exit(0);
      }
      const ahead = git(WT, ["rev-list", "--count", `origin/${gt}..HEAD`]);
      if (!ahead.ok || chomp(ahead.stdout) !== "0") {
        say("not-fired");
        exit(0);
      }
    }
    say("fired");
    exit(0);
  }

  // A successful prior close starts a new reporting window. Keep the log when a
  // landing failed (there is no CLOSED marker), because its retry must still
  // report deployments completed before the failure. Once a close succeeded,
  // carrying that log into later work falsely attributes old deployments to the
  // new close.
  if (MODE === "land" && isFile(CLOSED)) {
    writeAtomic(DEPLOY_LOG, "");
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
  let PROJECT_REL = "";
  // STDOUT ONLY is the Next block: merged in, as the bash `2>&1` did, Node
  // 22.x's ExperimentalWarning printed as a prose line of the report. stderr
  // is the refusal when it fails.
  const deriveNext = (projectPath: string): void => {
    const r = run(process.execPath, nodeArgs(NEXT_COMMAND, [projectPath]), { out: "pipe", err: "pipe" });
    NEXT_OUTPUT = chomp(r.stdout);
    if (!r.ok) notClosed(`could not derive next action: ${lastLine(r.stderr, NEXT_OUTPUT)}`);
    writeAtomic(NEXT_REF, `${NEXT_OUTPUT}\n`);
  };
  if (isFile(NEXT_REF)) NEXT_OUTPUT = chomp(readFileSync(NEXT_REF, "utf8"));
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

  // pollDeploy <shared> <sha> [<worktree>] — ask the repo's poller whether the
  // push at <sha> started a run that completed, log its line, and settle the
  // obligation: a good run clears it, anything else is NOT CLOSED with the
  // obligation kept for the retry. The obligation is already on disk: landOne
  // records it before it pushes. The poller is the repo's own
  // `.agents/deploy/await-deploy-run.sh`, and the copy that runs is the landing
  // worktree's — the tree that holds the landed commit, never the shared
  // checkout's working tree, which is advanced only when it is clean and on the
  // trunk. Only an owed deploy retried after that worktree vanished (or one
  // without it) falls back to the shared checkout's copy. A repo
  // that opted in with no poller to confirm the deploy is NOT CLOSED too — an
  // opt-in nobody can check is the silent case again. It runs IN the checkout
  // that supplies it: a poller asks git or gh about its repo from where it
  // stands, and started in the caller's directory a satellite's poller asked
  // about the thread's own repo instead.
  const AWAIT_REL = ".agents/deploy/await-deploy-run.sh";
  const LIST_REL = ".agents/deployable-prefixes.json";
  const pollDeploy = (shared: string, sha: string, wt: string | null = null): void => {
    const FROM = wt !== null && wt !== "" && isFile(`${wt}/${AWAIT_REL}`) ? wt : shared;
    const AWAIT = `${FROM}/${AWAIT_REL}`;
    if (!isFile(AWAIT))
      notClosed(`deploy: ${shared} carries ${LIST_REL} but no ${AWAIT_REL} to confirm the deploy of ${sha}`);
    const logFd = openSync(DEPLOY_LOG, "a");
    let r: Run;
    try {
      r = run("bash", [AWAIT, "--sha", sha], { cwd: FROM, out: "pipe", err: logFd });
    } finally {
      closeSync(logFd);
    }
    const DEPLOY_LINE = chomp(r.stdout);
    if (DEPLOY_LINE) appendFileSync(DEPLOY_LOG, `${DEPLOY_LINE}\n`);
    if (!r.ok) {
      notClosed(
        `${DEPLOY_LINE || `deploy: could not read the run for ${sha}`} — ${shared} is on origin but nothing deployed it`,
      );
    }
    killPoint("polled");
    clearOwed(shared);
    say(`  ${DEPLOY_LINE}`);
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
  // checker's to judge, not this predicate's to wave through. Read as the bash
  // read it, through a process substitution whose failures were not checked.
  const changedScripts = (wt: string, base: string): boolean => {
    const all = `${git(wt, ["diff", "-z", "--name-only", "--no-renames", base]).stdout}${git(wt, ["ls-files", "-z", "--others", "--exclude-standard"]).stdout}`;
    for (const p of all.split("\0").slice(0, -1)) {
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
  const resyncNext = (wt: string, base: string): void => {
    // Read first and checked: a diff that fails must not read as "nothing to
    // re-derive" and let the push through.
    const d = git(wt, ["diff", "--name-only", base, "HEAD", "--", "*ROADMAP.md", "*README.md"], { err: "inherit" });
    if (!d.ok) notClosed(`could not list the projects this push changes in ${wt}`);
    const dirs = [
      ...new Set(
        chomp(d.stdout)
          .split("\n")
          .filter((p) => p !== "")
          .map((p) => dirname(p)),
      ),
    ].sort();
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
    if (!isDir(WT)) {
      if (landedShaFor(SHARED) !== null) {
        if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA, null);
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
        if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA, WT);
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
    const UNMERGED = chomp(git(WT, ["diff", "--name-only", "--diff-filter=U"]).stdout);
    if (UNMERGED) {
      notClosed(`unresolved conflict in ${WT}: ${UNMERGED.replace(/\n/g, " ")}— resolve it, then re-run`);
    }

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
    if (holdsJournal(WT)) {
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
    }

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
    //
    // The trunk is resolved and FETCHED here, ahead of the gate, rather than after
    // the commit where the merge below first needs it: `trunk.ts` can name a trunk
    // from origin/HEAD before `origin/<trunk>` exists locally, and only the fetch
    // creates it. Measuring from a ref that is not there would refuse every close.
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

    // THE SECRETS GATE: check-secrets.ts over what this worktree changed, for
    // every repo, from the workbench worktree that holds the checks. A credential
    // committed is a credential leaked, whichever repo it lands in.
    if (SEC_CHECK) refuseOnCheck(SEC_CHECK, WT, DR_BASE, "secret scan");

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
    }
    // Every attempt, not only the one that merged: a re-run after a failed
    // re-derive finds trunk already merged, and must not push past it.
    resyncNext(WT, `origin/${TRUNK}`);
    // The Next line, from the project as it is about to land (see PROJECT_REL).
    if (PROJECT_REL && holdsJournal(WT)) deriveNext(`${WT}/${PROJECT_REL}`);

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
    // Where the trunk stood before this push, for the owed-run rule below: the
    // landed diff is `TRUNK_BEFORE..SHA`, and it is what the deployer saw.
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

    // Decided HERE, from the range about to be pushed, BEFORE the push (the
    // reasoning is at the deploy check below): "poll" (a run is owed), "no"
    // (the paths deploy nothing), or "none" (this repo has not opted in: the
    // landed commit carries no .agents/deployable-prefixes.json).
    let DEPLOY: "poll" | "no" | "none" = "none";
    const list = git(WT, ["show", `${SHA}:${LIST_REL}`]);
    if (list.ok) {
      DEPLOY = "poll";
      if (TRUNK_BEFORE) {
        const diff = git(WT, ["diff", "--name-only", TRUNK_BEFORE, SHA]);
        const touched = diff.ok ? git(WT, ["log", "--format=", "--name-only", `${TRUNK_BEFORE}..${SHA}`]) : diff;
        if (diff.ok && touched.ok) {
          let DECISION = "poll";
          let prefixes: unknown;
          try {
            prefixes = JSON.parse(chomp(list.stdout));
          } catch {
            prefixes = undefined;
          }
          if (
            Array.isArray(prefixes) &&
            prefixes.length > 0 &&
            prefixes.every((p: unknown) => typeof p === "string" && p.length > 0)
          ) {
            const xs = prefixes as string[];
            const paths = `${chomp(diff.stdout)}\n${chomp(touched.stdout)}\n`.split("\n").filter(Boolean);
            DECISION = paths.some((p) => xs.some((x) => p.startsWith(x))) ? "owed" : "not-owed";
          }
          if (DECISION === "not-owed") DEPLOY = "no";
        }
      }
    }

    // THE ORDER IS THE PROOF: record the obligation for the SHA about to be
    // pushed, push, record the landed SHA, poll, clear. A kill anywhere leaves a
    // retry that polls or refuses. Before the push, the obligation names an
    // unpushed SHA, and the retry pushes that SHA again and re-records it.
    // After the push and before the landed SHA, the retry finds HEAD already on
    // origin, sees an empty diff and calls its own push "not owed", but the
    // obligation on disk is polled all the same. After the landed SHA, the
    // early returns poll it. After a good poll and before the clear, the retry
    // polls a run that already completed. Recorded after the push instead, a
    // kill in that gap would let a retry close unpolled.
    //
    // A push owed a run takes over an earlier obligation when it descends from
    // that SHA, because its completed run deploys that SHA's tree too. One that
    // does not descend cannot take it over, so the old SHA is proved first.
    let OWED_BEFORE: string | null = null;
    if (DEPLOY === "poll") {
      if (
        OWED_SHA !== null &&
        OWED_SHA !== SHA &&
        !git(WT, ["merge-base", "--is-ancestor", OWED_SHA, SHA], { out: "ignore" }).ok
      ) {
        pollDeploy(SHARED, OWED_SHA, WT);
      }
      OWED_BEFORE = owedShaFor(SHARED);
      setOwed(SHARED, SHA);
    }

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
          if (DEPLOY === "poll") {
            if (OWED_BEFORE === null) clearOwed(SHARED);
            else setOwed(SHARED, OWED_BEFORE);
          }
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
    // OFF UNLESS THE REPO OPTS IN. A repo whose push deploys something (a CI
    // workflow, a webhook) says so by carrying `.agents/deployable-prefixes.json`:
    // a JSON array of the path prefixes whose change a push deploys. Without it
    // there is nothing to check, and this block is skipped.
    //
    // With it, the push is the deployer and this script only CHECKS. A merger
    // that deployed would deploy the shared checkout, which another session may
    // hold dirty; the push deploys the landed commit. But a push-triggered deploy
    // can be lost silently — a dropped webhook, a runner that is down — and
    // silence looks exactly like success. So a landing that starts no deploy run
    // is NOT CLOSED. The check is the repo's own `.agents/deploy/await-deploy-run.sh
    // --sha <sha>`: it prints one line and exits 0 when a deploy of that commit
    // completed. Opting in without it is NOT CLOSED too (pollDeploy).
    //
    // AND ONLY FOR A PUSH THAT CAN DEPLOY SOMETHING. A close that wrote only its
    // journal would otherwise wait on a run nothing starts. The list is read out
    // of the LANDED commit, never the shared checkout's working tree, and the
    // check runs only when the landed paths match. THE PATHS ARE THE DEPLOYER'S
    // PATHS: the union of every commit's files in the pushed range (`git log
    // --name-only`), which is what a push event carries, plus the net diff. A file
    // added in one commit and deleted in the next is in that union and starts a
    // run, while the net diff alone would call the landing not owed. The list is
    // JSON-parsed, not grepped; a prefix matches at the start of a path and
    // nowhere else. Anything this cannot read — unparseable JSON, no range —
    // checks, rather than skips: skipping on an unknown is the one way a
    // deployed-nothing close ships stale under a green report.
    if (DEPLOY === "no") {
      const NOT_OWED = "deploy: not owed (no deployable path)";
      appendFileSync(DEPLOY_LOG, `${NOT_OWED}\n`);
      say(`  ${NOT_OWED}`);
    }
    if (DEPLOY === "poll") pollDeploy(SHARED, SHA, WT);
    // A push that starts no run cannot stand in for one an earlier push still
    // owes, so that SHA is polled again (and refused if its poller is gone).
    else if (OWED_SHA !== null) pollDeploy(SHARED, OWED_SHA, WT);

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
    for (const line of LEDGER_LINES) {
      const [WT = "", SHARED = "", BRANCH = ""] = tabFields(line, 3);
      if (!WT) continue;
      await landOne(WT, SHARED, BRANCH);
    }
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

  let LAST_SHA = "";
  let JOURNAL_MAIN_SHA = "";
  let JOURNAL_TRUNK = "";
  let LAST_TRUNK = "";
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
    LAST_SHA = MAIN_SHA;
    LAST_TRUNK = CHK_TRUNK;
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
  const REL = journalRel();
  if (REL !== null) {
    if (!JOURNAL_SHARED) notClosed(`${REL} is in no worktree this thread owns, so nothing landed it`);
    if (landedShaFor(JOURNAL_SHARED) !== null) {
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
  writeAtomic(CLOSED, "");

  // ── Last of all: the worktree these scripts are running from ────────────
  //
  // Everything above is done, the checks have passed and the marker is written,
  // so nothing left to do needs a sibling script. Only git below.
  for (const [dwt, dshared, dbranch] of DEFERRED_REMOVALS) removeWorktree(dwt, dshared, dbranch);

  if (nonEmpty(DEPLOY_LOG) && MODE === "land") {
    say("");
    say("Deploy:");
    const log = readFileSync(DEPLOY_LOG, "utf8");
    const terminated = log.endsWith("\n");
    const lines = (terminated ? log.slice(0, -1) : log).split("\n");
    process.stdout.write(lines.map((l) => `  ${l}`).join("\n") + (terminated ? "\n" : ""));
    say("");
  }

  // This is the final-response block. It is generated here so /close copies one
  // complete artifact instead of manually reconstructing fields and dropping a
  // deterministic result. Deployment diagnostics stay above it; the proof line
  // remains last and retains its existing machine-earned meaning.
  if (MODE === "land") {
    say(`**Shipped:** ${SUBJECT}`);
    if (JOURNAL_LANDED) {
      say(`**Journal:** [${JOURNAL_LANDED.slice(JOURNAL_LANDED.lastIndexOf("/") + 1)}](<${JOURNAL_LANDED}>)`);
    }
    // Every command gets its OWN fenced block, so each one has its own copy
    // button: a close on a ROADMAP project can print several `/implement` rows
    // that run in parallel, and one multi-line block would paste them as one
    // prompt. A `#` comment line is prose — escaped so a renderer does not turn
    // it into a heading — and anything else is printed as it came.
    if (NEXT_OUTPUT) {
      say("**Next:**");
      for (const l of NEXT_OUTPUT.split("\n")) {
        if (l === "") continue;
        if (l.startsWith("/")) process.stdout.write(`\n\`\`\`\n${l}\n\`\`\`\n`);
        else if (l.startsWith("#")) process.stdout.write(`\n\\${l}\n`);
        else process.stdout.write(`\n${l}\n`);
      }
    }
    say("");
  }

  // The SHA of the repo the journal landed in, when there is one — workbench,
  // the repo every journal close pushes. Otherwise the last repo landed, so a
  // thread that never wrote a record still gets a checkable line.
  // The trunk is named from whichever repo supplied the SHA, so the sentence and
  // the SHA always describe the same ref. On every repo here that prints
  // `origin/main`; on a `master` repo it prints `origin/master` rather than a
  // reassuring line about a branch the SHA is not on.
  const [REPORT_SHA, REPORT_TRUNK] = JOURNAL_MAIN_SHA
    ? [JOURNAL_MAIN_SHA, JOURNAL_TRUNK || "main"]
    : [LAST_SHA, LAST_TRUNK || "main"];
  say(`origin/${REPORT_TRUNK} is at ${REPORT_SHA} — closing this tab loses nothing.`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
