#!/usr/bin/env -S node --experimental-strip-types
// session-write-root.ts — SSOT for "where does THIS session write repo files?"
//
// One file, two faces: a program (`node session-write-root.ts [--no-create |
// --slug | --main]`) and a library (`sessionWriteRoot()`, `inWriteRoot()`).
// Both faces call the same `resolveWriteRoot()`, so a scaffold that imports
// this and a hook that runs it cannot get different answers.
//
// The problem this ends: a skill's first action is often a scaffold script, and
// a scaffold script derived its own repo root from its own location. Every
// script under .agents/skills/ is READ FROM THE MAIN CHECKOUT — the harness's
// skills folder is a home link to the workbench's .agents/skills/ — so an
// import.meta.url- or BASH_SOURCE-relative root can only ever resolve to the
// main checkout, never to the session worktree. The scaffold wrote there, the
// session's next write was refused by the shared-checkout guard, and the whole
// scaffolded directory had to be moved by hand.
//
// The fix is not "detect the worktree" — at scaffold time there is usually no
// worktree yet, because nothing has tripped the edit guard. The fix is that a
// scaffold resolves its write root through the SAME creator the edit guard uses,
// so the worktree exists before the first byte is written and every later edit
// is already compliant.
//
// RECORDS AND CODE ARE ONE ANSWER. `knowledge/`, `journal/` and `projects/`
// live in this repo, so a script writing a record asks the same question as a
// script writing code and gets the same root: this thread's worktree of this
// repo, else the checkout the script itself lives in. There is no second
// library function for the records either, for the same reason.
//
// Modes:
//   session-write-root.ts                 — print the write root, CREATING this
//                                           session's worktree if it has none
//   session-write-root.ts --no-create     — print the existing write root
//                                           (session worktree if one exists,
//                                           else the main checkout); never
//                                           creates
//   session-write-root.ts --slug          — print this session's worktree slug
//                                           (SSOT for the `session-<key>` rule;
//                                           a caller reads it instead of
//                                           rebuilding it)
//   session-write-root.ts --main          — print the MAIN checkout root
//
// Library:
//   import { sessionWriteRoot, inWriteRoot } from "…/implement/scripts/session-write-root.ts";
//   sessionWriteRoot()                    — the default mode; throws on failure
//   sessionWriteRoot({ create: false })   — the --no-create mode
//
// Env:
//   CLAUDE_SESSION_ID    — session identity, preferred when a caller passes it.
//   CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID
//                        — the same identity under the names a harness exports
//                          into an ordinary shell call (harness.sh reads them).
//                          Read as a fallback; see the block below for why
//                          omitting them would defeat the entire script.
//                          With none set there is no session to isolate, so
//                          every mode degrades to the main checkout — which is
//                          what keeps a script runnable from its own test suite.
//   CLAUDE_PROJECT_DIR   — main checkout. Optional; derived from git when unset.
//   CONTEXT_WRITE_ROOT   — hard override, wins over everything that prints a
//                          write root. The test suites set it so a test cannot
//                          create a real worktree.
//   CLAUDE_WORKTREE_HOME — passed through to setup-worktree.sh, which owns the
//                          worktree LOCATION. Never re-derived here.
//   SETUP_WORKTREE_SCRIPT, SESSION_KEY_SCRIPT, THREAD_SCRIPT, WRITE_ROOT_SCRIPT
//                        — override the four helpers (tests).
//
// peers:
//   .agents/skills/implement/scripts/session-write-root.test.ts
//   .agents/skills/implement/scripts/setup-worktree.sh   (owns creation + location)
//   .agents/skills/implement/scripts/session-key.ts      (owns id sanitization)
//   .agents/skills/close/scripts/write-root.sh           (this thread's worktree)
//   .agents/skills/close/scripts/thread.ts               (which thread this is)
//   .agents/skills/close/scripts/harness.sh              (the harness's session id)
//
// Exit: 0 ok · 1 unusable context (not a git repo, creator failed)

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

type Mode = "root" | "no-create" | "slug" | "main";

/** What the program would print and leave with; the library reads the same. */
interface Resolution {
  code: number;
  stdout: string;
  stderr: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `$(cmd)`: stdout with trailing newlines cut, and whether it exited 0. */
function capture(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; stderr?: "ignore" | "pipe" } = {},
): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", opts.stderr ?? "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").replace(/\n+$/, ""),
    err: typeof r.stderr === "string" ? r.stderr : "",
  };
}

/**
 * `$(cmd 2>&1)`: stdout and stderr interleaved in the order written, trailing
 * newlines cut. A file rather than two pipes, because two pipes lose the order.
 */
function captureMerged(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-write-root-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  let ok = false;
  try {
    ok = spawnSync(cmd, args, { env, stdio: ["ignore", fd, fd] }).status === 0;
  } finally {
    closeSync(fd);
  }
  const out = readFileSync(file, "utf8").replace(/\n+$/, "");
  rmSync(dir, { recursive: true, force: true });
  return { ok, out };
}

const node = (script: string, args: string[]): string[] => ["--experimental-strip-types", script, ...args];

/**
 * The whole resolver. Reads the environment and the cwd at call time, writes
 * nothing to the process's own streams, and never exits: the program prints
 * what it returns, the library throws on a non-zero code.
 */
export function resolveWriteRoot(mode: Mode): Resolution {
  const env = process.env;
  let stdout = "";
  let stderr = "";
  const print = (line: string): void => {
    stdout += `${line}\n`;
  };
  const err = (line: string): void => {
    stderr += `session-write-root: ${line}\n`;
  };
  const done = (code: number): Resolution => ({ code, stdout, stderr });

  const HOME = env.HOME ?? homedir();
  const SETUP_SCRIPT = env.SETUP_WORKTREE_SCRIPT || `${SCRIPT_DIR}/setup-worktree.sh`;
  const SESSION_KEY_SCRIPT = env.SESSION_KEY_SCRIPT || `${SCRIPT_DIR}/session-key.ts`;

  // The harness's own session id, as harness.sh reads it (CONTEXTIUM_SESSION,
  // CLAUDE_CODE_SESSION_ID, …). harness.sh stays bash and is a library of shell
  // functions, so it is sourced by a bash child and its one function called —
  // the names a harness exports live there and nowhere else. A copy outside the
  // skills tree (a test fixture) has no harness.sh beside it and reads the
  // same names directly.
  const HARNESS_LIB = `${SCRIPT_DIR}/../../close/scripts/harness.sh`;
  const harnessSessionId = (): string => {
    if (isFile(HARNESS_LIB)) {
      return capture("bash", ["-c", 'source "$1" && harness_session_id', "harness", HARNESS_LIB]).out;
    }
    return env.CONTEXTIUM_SESSION || env.CLAUDE_CODE_SESSION_ID || "";
  };

  // Is there a thread at all? T3 Code's, or any harness session thread.ts can
  // name. The answer decides whether a resolver failure is fatal (inside a
  // thread there is no acceptable second answer) or expected (a copy of this
  // script outside every repo, a test suite — neither has a close to land
  // anything, so the shared checkout is right).
  const THREAD_HELPER = env.THREAD_SCRIPT || `${SCRIPT_DIR}/../../close/scripts/thread.ts`;
  const inThread = (): boolean =>
    isFile(THREAD_HELPER) && capture(process.execPath, node(THREAD_HELPER, ["--id"])).ok;

  // The worktree this thread ALREADY has for a shared checkout, read straight out
  // of the ledger. Creates nothing — which is the whole point: `--no-create` is
  // documented side-effect-free and `sessionWriteRoot({create:false})` relies on
  // it, so that mode may look the answer up but must never bring it into being.
  const ledgerLookup = (repo: string): string => {
    const tid = capture(process.execPath, node(THREAD_HELPER, ["--id"]));
    if (!tid.ok) return "";

    const ledger = `${HOME}/.cache/workbench/threads/${tid.out}/worktrees`;
    if (isFile(ledger)) {
      let hit = "";
      for (const line of readFileSync(ledger, "utf8").split("\n")) {
        const f = line.split("\t");
        if (f[1] === repo) {
          hit = f[0] ?? "";
          break;
        }
      }
      // A LEDGER LINE OUTLIVES ITS WORKTREE. `land.ts` removes each satellite
      // once its merge SHA is persisted and deliberately keeps the line as the
      // record of that, so a hit is an answer only while it is still on disk —
      // otherwise this hands back a path that was deleted at the last close.
      if (hit !== "" && isDir(hit)) return hit;
    }

    // NO LEDGER YET IS NOT NO ANSWER. Nothing has needed the resolver in this
    // thread, so no line exists — but the thread's own worktree is still where this
    // session's changes are, and asking for it creates nothing. Without this a
    // reader falls through to the shared checkout and inspects a tree that has
    // none of the session's work in it.
    const own = capture(process.execPath, node(THREAD_HELPER, ["--worktree"]));
    if (!own.ok || own.out === "" || !isDir(own.out)) return "";
    // …but only when it is a worktree OF THE REPO BEING ASKED ABOUT. A caller
    // that pointed CLAUDE_PROJECT_DIR at some other repo must not be told this one.
    const common = capture("git", ["-C", own.out, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok || !isDir(common.out)) return "";
    let physical = "";
    try {
      physical = realpathSync(resolve(common.out, ".."));
    } catch {
      return "";
    }
    return physical === repo ? own.out : "";
  };

  // Hard override wins over every other branch below, so a test never reaches the
  // real creator. Not applied to --slug: the slug is an identity, not a path, and
  // a caller needs the real one; nor to --main, which names the shared checkout
  // rather than a write root.
  //
  // IT SITS ABOVE EVERY RESOLVING BRANCH, and that placement is the whole point:
  // a mode that answered out of its own branch below this check would hand a test
  // the REAL worktree no matter what the test set, and the test's fixtures would
  // land in the real records. That includes the main-checkout resolution just
  // below, which refuses outright from a copy of this script outside every repo.
  // The docblock above claims this wins over everything; keep it literally true
  // for any mode that prints a write root.
  if (env.CONTEXT_WRITE_ROOT && mode !== "slug" && mode !== "main") {
    print(env.CONTEXT_WRITE_ROOT);
    return done(0);
  }

  // ── Main checkout ─────────────────────────────────────────────────────────
  // `--git-common-dir` is the load-bearing choice over `--show-toplevel`. Inside a
  // worktree, toplevel is the WORKTREE; the common dir is always the main
  // checkout's .git, so its parent is the main checkout from anywhere. Without
  // this, invoking a script from inside a worktree would report that worktree as
  // "main" and the marker search below would look in the wrong place.
  // Order is CLAUDE_PROJECT_DIR, then THIS SCRIPT'S OWN REPO, then the CALLER'S
  // CWD. The script's repo comes before the cwd because every caller of this file
  // writes into the repo this file lives in — a record under `knowledge/` or
  // `projects/`, a skill scaffold, a roadmap flip — and the cwd is only ever a
  // different repo when a skill is run from a product checkout, where "the repo
  // you are standing in" is the wrong answer for all of them: the records would
  // go into the product repo. The cwd rung stays for a copy of this file that
  // sits in no repo, which is what a test fixture is.
  // Same `--git-common-dir` reasoning on every rung: this file lives under
  // `.agents/skills/` in a worktree or the main checkout and either way the common dir's
  // parent is the main checkout.
  const resolveMain = (): string => {
    if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
    for (const cmd of [
      ["-C", SCRIPT_DIR, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]) {
      const common = capture("git", cmd);
      const c = common.ok ? common.out : "";
      if (c !== "" && isDir(c)) return resolve(c, "..");
    }
    return "";
  };

  let MAIN_ROOT = resolveMain();
  if (MAIN_ROOT === "") {
    err("not inside a git repo and CLAUDE_PROJECT_DIR unset");
    return done(1);
  }
  if (!isDir(MAIN_ROOT)) {
    err(`repo root does not exist: ${MAIN_ROOT}`);
    return done(1);
  }
  MAIN_ROOT = resolve(MAIN_ROOT);

  if (mode === "main") {
    print(MAIN_ROOT);
    return done(0);
  }

  // ── One worktree per repo per thread ──────────────────────────────────────
  //
  // Below this point is the per-session mechanism: `setup-worktree.sh` makes a
  // worktree keyed on the session id. Beside the ledger's, that is a SECOND
  // isolation mechanism, and a worktree only the second one knows about is one
  // `land.ts` never commits — the close would report success over code still
  // sitting in it.
  //
  // So inside a thread, the answer comes from the same resolver everything else
  // uses (write-root.sh, which records it in the ledger): a worktree the thread
  // already has is the answer in every mode, and the default mode makes one.
  // That includes an id-less session: thread.ts NAMES it, generating an id so
  // the close can land it, and the shared-checkout guard sends its every edit to
  // a write-root.sh worktree — so a scaffold answered the main checkout here
  // would write where nothing else of the session is and no close looks. A
  // READ (detect-stage.ts, find-project.ts, resolve-scope.ts, …) passes
  // --no-create, which answers from the ledger and creates nothing, so looking
  // never makes a worktree.
  //
  // `CLAUDE_PROJECT_DIR` unset is the production tell, and the same one the gate
  // further down already relies on: an ordinary shell call has none, while every
  // suite below points it at a `mktemp` fixture. Delegating for a fixture would
  // ask the resolver to build a worktree of a throwaway directory.
  if (mode !== "slug" && !env.CLAUDE_PROJECT_DIR && inThread()) {
    // Answer from the ledger if this thread already has a worktree for this
    // repo. Creates nothing.
    const root = ledgerLookup(MAIN_ROOT);
    if (root !== "") {
      print(root);
      return done(0);
    }
    if (mode === "root") {
      const WRITE_ROOT_HELPER = env.WRITE_ROOT_SCRIPT || `${SCRIPT_DIR}/../../close/scripts/write-root.sh`;
      if (isFile(WRITE_ROOT_HELPER)) {
        // write-root.sh stays bash (it runs `git worktree add`); its stderr is
        // passed on, as the shell version let it through.
        const wr = capture("bash", [WRITE_ROOT_HELPER, MAIN_ROOT], { stderr: "pipe" });
        stderr += wr.err;
        if (!wr.ok) {
          err(`in a thread but could not resolve a worktree for ${MAIN_ROOT} (above)`);
          err("refusing to fall back to the shared checkout — nothing would land it");
          return done(1);
        }
        print(wr.out);
        return done(0);
      }
    }
  }

  // ── Does session isolation even apply to this root? ───────────────────────
  // Only when the caller's target root IS the repo this script lives in. A caller
  // that points CLAUDE_PROJECT_DIR at some OTHER directory means it, and the
  // session's worktree is not in that tree — every existing test suite for the
  // migrated scripts does exactly this, pointing at a `mktemp -d` fixture that is
  // often not a git repo at all. Overriding those is both wrong and loud: the
  // fixture has no worktree to find, so creation is attempted in a non-repo and
  // the caller dies with a resolver error instead of writing its file.
  //
  // In a real session this branch does NOT trigger: an ordinary shell call has
  // no CLAUDE_PROJECT_DIR at all, so MAIN_ROOT is derived from this script's own
  // git dir and matches by construction. A harness that passes the real main
  // checkout also matches.
  //
  // HOW A REAL CHECKOUT IS TOLD FROM A FIXTURE. Not by FILE IDENTITY (is the copy
  // of this script under that root this very file?): the skills a harness reads
  // are a home link, so no repo is guaranteed to hold a copy at a known path, and
  // that test would answer "not my repo" for the real checkouts as well — sending
  // every /implement session's writes into main, the exact bug this script exists
  // to end.
  //
  // It asks instead whether MAIN_ROOT is a real checkout: a git work tree
  // with at least one configured REMOTE. A fixture built with `mktemp -d` +
  // `git init` has none, and the suites that need isolation anyway set
  // CONTEXT_WRITE_ROOT, which returns above this block. It is a weaker signal than
  // file identity and it is named as such: a fixture that adds a remote reads as
  // real here, so a suite that does that must set the override.
  let SCRIPT_REPO = "";
  if (
    capture("git", ["-C", MAIN_ROOT, "rev-parse", "--is-inside-work-tree"]).ok &&
    capture("git", ["-C", MAIN_ROOT, "remote"]).out !== ""
  ) {
    SCRIPT_REPO = MAIN_ROOT;
  }

  // `--slug` is exempt: it answers "who is this session?", which has no dependency
  // on which root the caller targets.
  if (mode !== "slug" && (SCRIPT_REPO === "" || MAIN_ROOT !== SCRIPT_REPO)) {
    print(MAIN_ROOT);
    return done(0);
  }

  // ── Session key ───────────────────────────────────────────────────────────
  // No session id means no session to isolate: a plain-terminal run or a test.
  // Degrade to the main checkout rather than inventing an identity — a fabricated
  // key would create a worktree nobody ever merges.
  //
  // SEVERAL env vars, and reading only the first one silently breaks the whole
  // fix. CLAUDE_SESSION_ID is what setup-worktree.sh's callers pass explicitly —
  // but it is NOT in the environment of an ordinary shell call. There a harness
  // exports its own name for the id instead (harness.sh knows them). Since a
  // scaffold script IS invoked by an ordinary shell call, reading only
  // CLAUDE_SESSION_ID would degrade every scaffold to the main checkout — the
  // precise bug this script exists to end, reintroduced silently.
  const RAW_SESSION = env.CLAUDE_SESSION_ID || harnessSessionId();
  let SESSION_KEY = "";
  if (RAW_SESSION !== "" && isFile(SESSION_KEY_SCRIPT)) {
    SESSION_KEY = capture(process.execPath, node(SESSION_KEY_SCRIPT, [RAW_SESSION])).out;
  }

  if (SESSION_KEY === "") {
    if (mode === "slug") {
      err("no usable session id (CLAUDE_SESSION_ID, CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID); no slug exists");
      return done(1);
    }
    print(MAIN_ROOT);
    return done(0);
  }

  // The `session-<key>` rule lives HERE and nowhere else.
  const SLUG = `session-${SESSION_KEY}`;

  if (mode === "slug") {
    print(SLUG);
    return done(0);
  }

  // ── Already inside a worktree? ────────────────────────────────────────────
  // A script invoked with cwd inside a worktree writes there, whoever owns it.
  // Checked before the marker search because it needs no marker to be right, and
  // it keeps a script that /implement invokes from its own worktree working even
  // if the marker was removed.
  // The worktree list is read ONCE and checked: read as "nothing" on failure, a
  // git that failed listed nothing, and a session with a worktree was answered the
  // main checkout — its writes then went where no close lands them.
  const listing = captureMerged("git", ["-C", MAIN_ROOT, "worktree", "list", "--porcelain"]);
  if (!listing.ok) {
    const lines = listing.out.split("\n");
    err(`could not list the worktrees of ${MAIN_ROOT}: ${lines[lines.length - 1] ?? ""}`);
    return done(1);
  }
  const worktrees = listing.out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((wt) => wt !== MAIN_ROOT);

  let CWD_NOW = process.cwd();
  try {
    CWD_NOW = realpathSync(CWD_NOW);
  } catch {
    // keep the cwd as the process reports it
  }
  for (const wt of worktrees) {
    if (CWD_NOW === wt || CWD_NOW.startsWith(`${wt}/`)) {
      print(wt);
      return done(0);
    }
  }

  // ── This session's existing worktree ──────────────────────────────────────
  // Discovery is by marker file, the one setup-worktree.sh writes. The path is
  // never rebuilt here.
  const matches = worktrees.filter((wt) => isDir(wt) && isFile(`${wt}/.claude-session-${SESSION_KEY}`));

  if (matches.length === 1) {
    print(matches[0] ?? "");
    return done(0);
  }

  if (matches.length > 1) {
    err(`${matches.length} worktrees claim session ${SESSION_KEY}:`);
    for (const m of matches) err(`  ${m}`);
    err("Not guessing which is yours. Remove the stale marker(s), then retry.");
    return done(1);
  }

  // ── No worktree yet ───────────────────────────────────────────────────────
  if (mode === "no-create") {
    print(MAIN_ROOT);
    return done(0);
  }

  // setup-worktree.sh stays bash (it runs `git worktree add`), so it is run by bash.
  const create = captureMerged("bash", [SETUP_SCRIPT, SLUG], {
    ...env,
    CLAUDE_PROJECT_DIR: MAIN_ROOT,
    CLAUDE_SESSION_ID: RAW_SESSION,
  });
  if (!create.ok) {
    // Fail LOUD, never fall back to the main checkout. Falling back is precisely
    // the bug this script exists to end: the scaffold would land in the main tree,
    // and the session's next write would be refused by the shared-checkout guard,
    // so the caller is not stranded by refusing — it is stranded by succeeding in
    // the wrong place.
    err("could not create this session's worktree; refusing to write to the main checkout.");
    for (const line of create.out.split("\n")) {
      if (line !== "") err(`  ${line}`);
    }
    err(`Diagnose with:  git -C ${MAIN_ROOT} worktree list   |   df -h ${MAIN_ROOT}`);
    return done(1);
  }

  const created = create.out
    .split("\n")
    .filter((l) => l.startsWith("WORKTREE_DIR="))
    .map((l) => l.slice("WORKTREE_DIR=".length));
  const CREATED_DIR = created[created.length - 1] ?? "";
  if (CREATED_DIR === "") {
    err("creator succeeded but printed no WORKTREE_DIR= line; refusing to guess.");
    return done(1);
  }

  print(CREATED_DIR);
  return done(0);
}

// ── The library face ────────────────────────────────────────────────────────
//
// Why every scaffold needs this: a script under .agents/skills/ is read from the
// MAIN checkout, so `import.meta.url` can only ever resolve to the main
// checkout — never to the session worktree. See the header for the failure
// this ends.

/** Per-process memo. The answer cannot change within one run, and an unmemoized
 *  call would re-resolve (and, on the first call, re-enter worktree creation) for
 *  every path a script builds. */
const memo = new Map<string, string>();

export interface SessionWriteRootOptions {
  /** Create the session worktree when it has none. Leave true for anything that
   *  WRITES — that is the whole point. Pass false only to observe the current
   *  root without side effects. */
  create?: boolean;
}

/**
 * Absolute root this session must write repo files under — code AND records:
 * `knowledge/`, `journal/` and `projects/` live in the same root, so a
 * record is joined onto this exactly like a source file. In a thread this is
 * the thread's worktree; outside one it is the checkout the script lives in.
 *
 * Throws when the root cannot be resolved (not a git repo, worktree creation
 * failed, ambiguous markers). Throwing is correct: the caller's alternative is
 * writing into the main checkout, which is the bug.
 */
export function sessionWriteRoot(opts: SessionWriteRootOptions = {}): string {
  const create = opts.create !== false;
  const key = create ? "create" : "no-create";
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const r = resolveWriteRoot(create ? "root" : "no-create");
  if (r.code !== 0) {
    throw new Error(`session-write-root: could not resolve this session's write root.\n${r.stderr.trim()}`);
  }

  const root = r.stdout.trim();
  if (!root) throw new Error("session-write-root: resolver returned an empty path");
  memo.set(key, root);
  return root;
}

/** Convenience: join path segments onto the session write root. */
export function inWriteRoot(...segments: string[]): string {
  return join(sessionWriteRoot(), ...segments);
}

// ── The program face ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let mode: Mode;
  switch (process.argv[2] ?? "") {
    case "--no-create":
      mode = "no-create";
      break;
    case "--slug":
      mode = "slug";
      break;
    case "--main":
      mode = "main";
      break;
    case "":
      mode = "root";
      break;
    default:
      process.stderr.write("session-write-root: usage: session-write-root.ts [--no-create | --slug | --main]\n");
      exit(1);
  }
  const r = resolveWriteRoot(mode);
  process.stderr.write(r.stderr);
  process.stdout.write(r.stdout);
  exit(r.code);
}

/** Run as a program, not imported. Never throws: an importer's argv[1] may name anything. */
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await runToExit(main);
}
