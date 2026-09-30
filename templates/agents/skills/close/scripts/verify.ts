#!/usr/bin/env -S node --experimental-strip-types
// verify.ts — run the checks of every app this thread touched, before anything
// is recorded.
//
// Verify comes first in the close — before the project update, the journal, the
// landing and the report — so a fix it forces lands before anything records the
// session. A red check found after the journal is written means the entry
// describes a session that did not happen the way it says.
//
// WHICH APPS. The ones whose own files moved in one of this thread's worktrees —
// not the ones that import them. Chasing importers fans out: a single edit can
// pull in ten apps, so the narrow scope is the rule.
//
// AN APP is the nearest folder under `apps/` that holds a package.json, above a
// changed file — `apps/<name>/` or `apps/<domain>/<name>/`, whichever the
// workbench uses — and its label is that path without `apps/`.
//
// THE ONE EXCEPTION: a session that changed NO app files at all. The narrow rule
// is about an edit touching an app AND a shared file, where the app's own checks
// already cover the change. A session confined to `integrations/` or `packages/`
// is a different animal — the narrow rule yields NOTHING, prints "no app files
// changed", and exits 0 having verified precisely nothing, while the apps that
// consume the change go unchecked. So when, and only when, the direct set is
// empty, this falls back to the apps that import the changed files. The fan-out
// is still capped — past IMPORTER_CAP the apps are NAMED as unverified rather
// than run, because a close that takes ten minutes is its own kind of failure.
//
// WHAT COUNTS AS VERIFIED. An app's own `check` and `test` scripts, run from its
// own directory, because that is where its package.json resolves its toolchain
// from. An app missing one is reported `unverified` rather than `FAIL`: a
// missing script is a gap in the app, not a defect this session introduced, and
// halting the close on it would make every session that brushed that app
// unclosable.
//
// WHICH INTEGRATIONS. The ones whose own files moved AND which declare a
// `check` or `test` of their own — verified in pass 1 beside the apps, on the
// same narrow rule. This is not the importer fallback: pass 2 fires only when
// pass 1 verified NOTHING, so a session touching an app AND an integration would
// otherwise verify the app and skip the integration's own suite. An integration
// that declares neither half prints nothing at all, rather than `unverified`: by
// convention an integration has no typecheck target of its own, so its silence
// is the norm and not a gap.
//
// Usage:
//   verify.ts              — verify every app this thread touched
//
// WHICH SKILLS. The same question, asked of the skills tree: every top-level
// folder under `.agents/skills/` whose files moved in this thread's WORKBENCH
// worktree — the ledger row holding the code, the records and the skills
// together — with a `(root)` unit for a changed file directly under
// `.agents/skills/`. Every `*.test.sh` AND every `*.test.ts` beneath such a
// folder runs — the shell suites with bash, the node:test suites through
// `node --experimental-strip-types .agents/skills/run.ts` when the workbench has
// that launcher, else with `node --experimental-strip-types` directly — and a
// red one halts the close exactly as a red app half does. `.agents/checks/` and
// `.agents/generators/` are one unit each, on the same rule: they are the
// workbench's own toolchain, and nothing else runs their suites before a close.
// See pass 3 below for why the unit is the folder rather than the file,
// and for the backstop that catches a write which never reached a worktree.
//
// Output, one line per app:
//   ok <app>
//   unverified <app> — no <check|test|check or test> script
//   unverified <app> — imports <path>, and N importers is past the cap
//   FAIL <app> <half> — rerun: cd <dir> && npm run <half>
//   FAIL <app> <half> — <dir>/package.json could not be parsed   (an app or integration)
//
// and, halting at once with exit 1:
//   FAIL verify — could not register <worktree>: <write-root's reason>
//   FAIL verify — could not list the changed files in <worktree>: git <args>: <reason>
//
// and one line per skill unit (`<unit>` below is `.agents/skills/<folder>`,
// `.agents/skills/(root)`, `.agents/checks` or `.agents/generators`):
//   ok <unit>
//   unverified <unit> — no test suites
//   unverified skills — no worktree this thread owns holds .agents/skills/, so no
//                       skill folder was checked
//   unverified skills — ledger worktree <path> already landed and was removed
//   unverified skills — N uncommitted file(s) under .agents/skills/ in the shared
//                       checkout, owner unknown
//   FAIL <unit> <suite> — rerun: cd <worktree> && bash <suite>
//   FAIL <unit> <suite> — rerun: cd <worktree> && node --experimental-strip-types .agents/skills/run.ts <path under .agents/skills/>
//   FAIL <unit> <suite> — rerun: cd <worktree> && node --experimental-strip-types <suite>
//                         (a node:test suite with no run.ts launcher, or outside .agents/skills/)
//   FAIL <unit> <suite> — timed out after <N>s
//   FAIL skills — ledger worktree <path> is missing
//   FAIL skills — N uncommitted file(s) under .agents/skills/ in the shared checkout
//                 this thread's worktree does not account for
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts.
//   VERIFY_RUNNER — the command used to run a script, default `npm run`. The
//                   test suite replaces it; nothing in production does.
//   VERIFY_IMPORTER_CAP — how many importer apps may be RUN in the fallback pass
//                   before they are named unverified instead. Default 8.
//   VERIFY_SKILLS_TIMEOUT — seconds one skill suite may take. Default 180.
//                   Enforced by a watchdog in this process (the suite runs in a
//                   process group of its own, TERMed at the limit and KILLed 5s
//                   later), not by timeout(1), which stock macOS does not have.
//
// peers:
//   .agents/skills/close/scripts/verify.test.ts
//   .agents/skills/close/scripts/write-root.sh   (writes the ledger walked here)
//
// Exit: 0 all green (or nothing to verify) · 1 at least one FAIL · 2 no thread

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const THREAD = join(SCRIPT_DIR, "thread.ts");
const TRUNK = join(SCRIPT_DIR, "trunk.ts");
const WRITE_ROOT = join(SCRIPT_DIR, "write-root.sh");
const RUNNER = process.env.VERIFY_RUNNER || "npm run";

let FAILED = 0;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

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

/** Run a command; stdout back with `$(…)`'s trailing newlines removed, stderr dropped. */
function out(cmd: string, args: string[], cwd?: string): { ok: boolean; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").replace(/\n+$/, "") };
}

/** Non-empty lines, sorted and deduplicated — `sed '/^$/d' | sort -u`. */
function sortUnique(lines: string[]): string[] {
  return [...new Set(lines.filter((l) => l !== ""))].sort();
}

type LedgerRow = { wt: string; shared: string; branch: string };

// `while IFS=$'\t' read -r WT SHARED BRANCH`: tabs are IFS whitespace, so runs
// of them collapse and the ends are trimmed; the last field keeps the rest of
// the line; and a final line with no newline is never read.
function ledgerRows(ledger: string): LedgerRow[] {
  const lines = readFileSync(ledger, "utf8").split("\n");
  lines.pop();
  return lines.map((line) => {
    const f = line.replace(/^\t+|\t+$/g, "").split(/\t+/);
    return { wt: f[0] ?? "", shared: f[1] ?? "", branch: f.slice(2).join("\t") };
  });
}

// Every path this worktree changed, committed or not. Deliberately three
// questions rather than one `git status --porcelain` parse: porcelain's rename
// rows (`R old -> new`) and its quoting of unusual filenames both need a real
// parser, and getting either wrong silently drops an app from the verify set.
//
// A READ THAT FAILED HALTS. Each git read's status is checked: a failed diff or
// untracked listing contributed no lines, dropped every app it would have named,
// and the close printed "no app files changed" and exited 0 having run nothing.
// The trunk lookup and the `origin/<trunk>` probe are questions whose "no" is an
// answer — a repo with no origin has no committed range to diff — so only the
// three reads that list paths are held to it.
function changedPaths(wt: string): string[] {
  const all: string[] = [];
  const read = (args: string[]): string[] => {
    const r = spawnSync("git", ["-C", wt, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      const why = (r.stderr ?? r.error?.message ?? "").trim().split("\n").pop() || `exited ${r.status}`;
      say(`FAIL verify — could not list the changed files in ${wt}: git ${args.join(" ")}: ${why}`);
      exit(1);
    }
    return (r.stdout ?? "").split("\n");
  };
  // The trunk is asked for per repo rather than spelled `main`: a repo whose
  // trunk is `master` would otherwise fall through to the untracked-only
  // branch below and verify NOTHING it had committed.
  const t = out(process.execPath, ["--experimental-strip-types", TRUNK, wt]);
  const vtrunk = t.ok ? t.stdout : "";
  if (vtrunk !== "" && out("git", ["-C", wt, "rev-parse", "--verify", "-q", `origin/${vtrunk}`]).ok) {
    all.push(...read(["diff", `origin/${vtrunk}...HEAD`, "--name-only"]));
  }
  all.push(...read(["diff", "HEAD", "--name-only"]));
  all.push(...read(["ls-files", "--others", "--exclude-standard"]));
  return sortUnique(all);
}

// The app a repo-relative path belongs to: the nearest folder under `apps/`
// holding a package.json, returned without `apps/` — `<name>` in a flat layout,
// `<domain>/<name>` in a grouped one. Nothing for a path in no such folder.
function appOf(wt: string, rel: string): string[] {
  const f = rel.split("/");
  if (f[0] !== "apps") return [];
  for (let n = f.length - 1; n >= 2; n--) {
    const d = f.slice(0, n).join("/");
    if (isFile(`${wt}/${d}/package.json`)) return [d.slice("apps/".length)];
  }
  return [];
}

// `apps/…` and nothing else. A row with no `apps/` — a product repo's —
// contributes no lines and is silently skipped.
function appDirsFor(wt: string): string[] {
  return sortUnique(changedPaths(wt).flatMap((p) => appOf(wt, p)));
}

// `integrations/<name>/…`, for the ones that declare their own check or test.
//
// WHY THIS EXISTS. Pass 1 mapped `apps/` alone, and pass 2's importer fallback
// fires only when pass 1 verified NOTHING — so a session that touched an app AND
// an integration verified the app and nothing else. That is harmless while no
// integration owns a suite, and stops being harmless the day one does: its tests
// would run on no close at all.
//
// NARROW, on purpose, and the same rule pass 1 applies to an app: only folders
// whose OWN files moved, and only the halves they declare. An integration with
// no scripts contributes nothing and is not even reported — it is not a gap in
// the integration, which by convention has no tsc target of its own.
function integrationDirsFor(wt: string): string[] {
  return sortUnique(
    changedPaths(wt).flatMap((p) => {
      const f = p.split("/");
      return f[0] === "integrations" && f.length >= 2 ? [`${f[0]}/${f[1]}`] : [];
    }),
  );
}

// Does this app declare the script? Read as JSON rather than grepped: a
// package.json where "test" appears in a dependency name would match a grep and
// then fail to run.
//
// THREE ANSWERS, NOT TWO. 0 declared, 1 absent, 2 the manifest could not be
// read at all. Collapsing 2 into 1 reported a syntactically broken package.json
// as "unverified" and let the close through — a manifest that cannot be parsed
// is a defect this session may well have just introduced, and it is exactly the
// case where running no checks is least safe.
function hasScript(pkg: string, name: string): 0 | 1 | 2 {
  let scripts: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
    if (parsed === null || parsed === undefined) return 2;
    const s = typeof parsed === "object" && "scripts" in parsed ? parsed.scripts : undefined;
    scripts = s || {};
  } catch {
    return 2;
  }
  const v = typeof scripts === "object" && scripts !== null && name in scripts ? Reflect.get(scripts, name) : undefined;
  return typeof v === "string" && v ? 0 : 1;
}

// Shared changed files that an app could import: `integrations/…`, `packages/…`.
// The importer pass below asks who reads these.
function sharedPathsFor(wt: string): string[] {
  return changedPaths(wt).filter((p) => {
    const f = p.split("/");
    return (f[0] === "integrations" || f[0] === "packages") && f.length >= 2;
  });
}

// Which apps import this path? Imports in this repo are relative and carry the
// extension (`../../../../integrations/komodo/komodo.ts` from an app's `src/`,
// four levels below the root), so the repo-relative path is a literal substring
// of the import specifier. A fixed-string grep is therefore both sufficient and
// immune to the path's dots being read as regex.
function importersOf(wt: string, rel: string): string[] {
  if (!isDir(`${wt}/apps`)) return [];
  const g = out("grep", [
    "-rlF",
    "--include=*.ts",
    "--include=*.tsx",
    "--include=*.mjs",
    "--include=*.js",
    "--",
    rel,
    `${wt}/apps`,
  ]);
  return sortUnique(
    g.stdout.split("\n").flatMap((line) => appOf(wt, line.startsWith(`${wt}/`) ? line.slice(wt.length + 1) : line)),
  );
}

/** Run `argv` in `cwd` with stdout and stderr both in `log`; its exit status. */
function runLogged(argv: string[], cwd: string, log: string): number {
  const fd = openSync(log, "w");
  try {
    const [cmd, ...args] = argv;
    const r = spawnSync(cmd ?? "", args, { cwd, stdio: ["inherit", fd, fd] });
    if (r.error) {
      // What the shell would have said: the command was not there to run.
      spawnSync("bash", ["-c", 'echo "$1: command not found" >&2; exit 127', "verify", cmd ?? ""], {
        stdio: ["ignore", fd, fd],
      });
      return 127;
    }
    return r.status ?? 1;
  } finally {
    closeSync(fd);
  }
}

// Verify one unit. `rel` is its repo-relative DIRECTORY (`apps/sales/sync`,
// `integrations/github`); `app` is the LABEL its result lines carry. The two
// are separate on purpose: an app has always printed `ok <domain>/<app>` with no
// `apps/` prefix, and the result lines are what `/close` quotes and what this
// suite asserts on, so generalizing the directory must not rename the unit.
// `verifyApp` below is the `apps/<domain>/<app>` caller's shorthand.
function verifyUnit(logs: string, wt: string, rel: string, app: string, note = ""): void {
  const dir = `${wt}/${rel}`;
  const pkg = `${dir}/package.json`;
  if (!isFile(pkg)) return;
  let missing = "";
  let appFailed = false;

  for (const half of ["check", "test"]) {
    const has = hasScript(pkg, half);
    if (has === 1) {
      missing = `${missing}${missing ? " or " : ""}${half}`;
      continue;
    }
    if (has === 2) {
      say(`FAIL ${app} ${half} — ${pkg} could not be parsed`);
      appFailed = true;
      FAILED = 1;
      continue;
    }
    const log = `${logs}/${app.replace(/\//g, "-")}-${half}.log`;
    // `${RUNNER} ${HALF}` unquoted: the runner is split into words.
    const runner = RUNNER.split(/[ \t\n]+/).filter((w) => w !== "");
    if (runLogged([...runner, half], dir, log) === 0) continue;
    say(`FAIL ${app} ${half} — rerun: cd ${dir} && ${RUNNER} ${half}`);
    say(`     log: ${log}`);
    appFailed = true;
    FAILED = 1;
  }

  if (appFailed) return;
  if (missing !== "") say(`unverified ${app} — no ${missing} script`);
  else say(`ok ${app}${note}`);
}

// The two `apps/<domain>/<app>` call sites keep their short unit name, so the
// result lines and the SEEN keys they compare against are unchanged.
function verifyApp(logs: string, wt: string, app: string, note = ""): void {
  verifyUnit(logs, wt, `apps/${app}`, app, note);
}

// ── Pass 3 helpers: the skills tree ────────────────────────────────────────
//
// A skill is code, and without this pass it is the only code that closes with
// nothing run against it: `appDirsFor` maps `apps/…` and nothing else, so a
// change under the skills tree contributes zero lines and the close says "no
// app files changed" over a rewritten `land.ts`.
//
// THE UNIT IS THE TOP-LEVEL FOLDER UNDER `.agents/skills/`, not the file. A change to a
// skill's SKILL.md or its references would otherwise run nothing at all, and
// those are exactly the changes that break the scripts beneath them. A changed
// path directly under `.agents/skills/` — `.agents/skills/run.ts`, `.agents/skills/AGENTS.md` — is its
// own unit, `(root)`, whose suites are the ones at `.agents/skills/` itself: the
// launcher every other script depends on was otherwise the single ungated file
// in the tree. A changed path outside `.agents/skills/` is no unit at all —
// except under `.agents/checks/` and `.agents/generators/`, each one unit whose
// suites are every one beneath it: those folders hold the checks and generators
// the close itself leans on, they carry no package.json for pass 1 to find, and
// without a unit of their own their suites would run on no close.
//
// WHICH WORKTREE. The WORKBENCH row. The skills live at `.agents/skills/` of the
// same repo as the code, so the row to read is the one whose worktree holds
// `.agents/skills/` — proven by its tree, in `workbenchWorktree` below, rather
// than matched on a SHARED column. A row without it is a product repo's and
// carries no skills.
//
// COST. A suite runs only for a folder that changed, so a session touching one
// skill pays for that skill's suites, each node:test file one Node start. There
// is no folder cap — the per-suite timeout is the only bound, and a hung suite
// hanging the close is the failure that bound exists to prevent.

/** One pass-3 unit: the label its result lines carry, its repo-relative folder,
 *  and whether only the suites directly in that folder are its own. */
type SkillUnit = { label: string; dir: string; root: boolean; skill: boolean };

// The segment after `.agents/skills/` of every changed path under it, plus `(root)` for
// a file directly under `.agents/skills/`; and `.agents/checks` / `.agents/generators`
// for a changed path anywhere beneath those. Paths anywhere else in the repo —
// `apps/`, `journal/`, `knowledge/` — are not units. Never an empty unit name.
function skillUnitsFor(wt: string): SkillUnit[] {
  const units = new Map<string, SkillUnit>();
  for (const p of changedPaths(wt)) {
    const f = p.split("/");
    if (f[0] !== ".agents" || f.length < 3) continue;
    if (f[1] === "skills") {
      const u: SkillUnit =
        f.length === 3
          ? { label: ".agents/skills/(root)", dir: ".agents/skills", root: true, skill: true }
          : { label: `.agents/skills/${f[2]}`, dir: `.agents/skills/${f[2]}`, root: false, skill: true };
      if (f.length === 3 || f[2]) units.set(u.label, u);
    } else if (f[1] === "checks" || f[1] === "generators") {
      units.set(`.agents/${f[1]}`, { label: `.agents/${f[1]}`, dir: `.agents/${f[1]}`, root: false, skill: false });
    }
  }
  return [...units.keys()].sort().map((k) => units.get(k) as SkillUnit);
}

// Which of this thread's worktrees is the WORKBENCH row — the one holding the
// skills? Proven by its tree rather than by its ledger position or its SHARED
// column: `.agents/skills/` is the tree this pass reads. Asking write-root.sh
// which checkout is the workbench would need a cwd inside it, and matching the
// SHARED column would need to know that path first.
function workbenchWorktree(rows: LedgerRow[]): string {
  for (const { wt } of rows) {
    if (wt === "") continue;
    if (isDir(`${wt}/.agents/skills`)) return wt;
  }
  return "";
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Two paths holding the same FILE — bytes, type, and the one permission bit git
// records. Bytes alone called a shared `chmod +x` accounted for, so a mode
// change that nothing would ever land was reported as this session's own work.
function sameFile(a: string, b: string): boolean {
  if (!exists(a) || !exists(b)) return false;
  if (isSymlink(a) || isSymlink(b)) {
    if (!(isSymlink(a) && isSymlink(b))) return false;
    return readlinkSync(a) === readlinkSync(b);
  }
  if (isExecutable(a) !== isExecutable(b)) return false;
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** `find <dir> [-maxdepth 1] -type f -name <pattern> | sort`, and find's status. */
function findSuites(dir: string, root: boolean, pattern: string): { rc: number; suites: string[] } {
  const r = spawnSync("find", [dir, ...(root ? ["-maxdepth", "1"] : []), "-type", "f", "-name", pattern], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const suites = (r.stdout ?? "")
    .split("\n")
    .filter((l) => l !== "")
    .sort();
  return { rc: r.status ?? 1, suites };
}

// Signal numbers for a child that died by one, the way a shell reports it (128+n).
const SIGNUM: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

// Run one suite in `cwd` with stdout and stderr both in `log`, bounded by
// `secs`; its exit status. The bound is a watchdog here, not timeout(1): stock
// macOS has neither timeout nor gtimeout, and the clock in the caller — not
// this status — decides "timed out" anyway. The suite runs as the leader of a
// process group of its own, and the watchdog signals the GROUP, as timeout(1)
// does: a suite's own children (the `sleep` a hung suite waits on) die with it
// rather than outliving the close. TERM first; KILL five seconds later for a
// suite that traps TERM and keeps going.
function runBounded(argv: string[], cwd: string, log: string, secs: number): Promise<number> {
  const fd = openSync(log, "w");
  return new Promise((done) => {
    const [cmd, ...args] = argv;
    let settled = false;
    let dog: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const finish = (rc: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(dog);
      clearTimeout(killer);
      closeSync(fd);
      done(rc);
    };
    const child = spawn(cmd ?? "", args, { cwd, stdio: ["ignore", fd, fd], detached: true });
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // The group is already gone.
      }
    };
    child.on("error", () => {
      writeSync(fd, `${cmd ?? ""}: command not found\n`);
      finish(127);
    });
    child.on("exit", (code, sig) => finish(code ?? (sig ? 128 + (SIGNUM[sig] ?? 0) : 1)));
    dog = setTimeout(() => {
      signal("SIGTERM");
      killer = setTimeout(() => signal("SIGKILL"), 5000);
    }, secs * 1000);
  });
}

// Every `*.test.sh` and `*.test.ts` beneath one unit. Prints its own result
// line(s) and sets FAILED on a red suite. Mirrors verifyApp's vocabulary
// exactly — two output formats in one verify is one too many.
//
// NO CLAUDE_PROJECT_DIR IS EXPORTED TO A SUITE. Skill scripts that need the
// repo climb from their own real directory, which lands on this worktree, so
// none needs it — and it is not harmless: `session-write-root.ts` takes the T3
// branch only when CLAUDE_PROJECT_DIR is unset, so with it set a suite asking
// for the session's write root would be handed a Claude-session worktree keyed
// on the harness session — a stale tree — and fail here while passing from a
// shell.
async function verifySkillUnit(logs: string, timeout: string, wt: string, unit: SkillUnit): Promise<void> {
  const { label, root } = unit;
  const dir = `${wt}/${unit.dir}`;
  // A path naming a directory that no longer exists is a DELETED skill folder,
  // and the deletion is the intent. Nothing to run, nothing to say.
  if (!root && !isDir(dir)) return;
  let unitFailed = false;
  let found = false;
  const limit = Number(timeout);

  const sh = findSuites(dir, root, "*.test.sh");
  if (sh.rc !== 0) {
    // Discovery that FAILED is not discovery that found nothing. Swallowing it
    // reported an unreadable folder as `no test suites`, which reads as a gap
    // in the folder rather than as the close having looked and been unable to.
    say(`FAIL ${label} — could not list its test suites (find exited ${sh.rc})`);
    FAILED = 1;
    return;
  }

  // THE CLOCK, not the exit code, says whether a suite finished. Every
  // exit-code scheme can be forged by the suite: `timeout` returns 124 both
  // when it kills a suite and when a suite exits 124 by itself, and a suite
  // that traps TERM and exits cleanly hands back 0 — which would report a hung
  // suite as green, the one outcome this bound exists to prevent. Wall time
  // cannot be forged. A suite that takes the whole budget is called a timeout
  // whatever it returned; at 180s that is a suite worth looking at either way.
  const runSuite = async (argv: string[], rel: string, rerun: string): Promise<boolean> => {
    // The WHOLE repo-relative path is flattened, not the filename taken: suites
    // recurse (`.agents/skills/qa/scripts/tests/lib.test.sh`) and two folders can each
    // hold a `verify.test.ts`, which would otherwise write one log over the
    // other. It begins `skills-` (the `.agents/` prefix dropped), so it cannot
    // collide with an app's `<domain>-<app>-<half>.log`.
    const log = `${logs}/${rel.replace(/^\.agents\//, "").replace(/\//g, "-")}.log`;
    const start = Date.now();
    const rc = await runBounded(argv, wt, log, limit);
    const elapsed = Date.now() - start;
    if (elapsed >= limit * 1000) {
      // "It never finished" and "it finished and failed" are different problems.
      say(`FAIL ${label} ${rel} — timed out after ${timeout}s`);
    } else if (rc !== 0) {
      say(`FAIL ${label} ${rel} — rerun: cd ${wt} && ${rerun}`);
    } else {
      return true;
    }
    say(`     log: ${log}`);
    unitFailed = true;
    FAILED = 1;
    return false;
  };

  // Bash suites stay bash: the hooks and a workbench's own folders may still
  // carry them, and a `.test.sh` is run the way it always was.
  for (const suite of sh.suites) {
    found = true;
    const rel = suite.startsWith(`${wt}/`) ? suite.slice(wt.length + 1) : suite;
    await runSuite(["bash", rel], rel, `bash ${rel}`);
  }

  // ── node:test suites (`*.test.ts`) ───────────────────────────────────
  //
  // A folder may keep its suites as `*.test.ts` and carry no `*.test.sh` at
  // all; discovering only shell suites would report it `unverified ... no test
  // suites`, which reads as a folder with no tests rather than as a close that
  // could not see the tests it has.
  //
  // They run out of the SAME worktree, through `.agents/skills/run.ts` when the
  // workbench has that launcher and the suite is a skill's (it owns the
  // type-stripping flag some Node versions need, and its argument is the path
  // under `.agents/skills/`), else with this Node and
  // `--experimental-strip-types` directly — the one form every Node from 22.6
  // parses. A skill script that needs repo code climbs `../../..` from its own
  // directory to `<repo>/…`; the script's real path is inside the repo, so the
  // climb lands on the code under test.
  //
  // A node:test file run directly executes its tests and exits non-zero if any
  // failed, so each file reports for itself and needs no `--test` flag.
  const ts = findSuites(dir, root, "*.test.ts");
  if (ts.rc !== 0) {
    say(`FAIL ${label} — could not list its node:test suites (find exited ${ts.rc})`);
    FAILED = 1;
    return;
  }

  const launcher = unit.skill && isFile(`${wt}/.agents/skills/run.ts`);
  for (const suite of ts.suites) {
    found = true;
    const rel = suite.startsWith(`${wt}/`) ? suite.slice(wt.length + 1) : suite;
    if (launcher) {
      const skRel = rel.startsWith(".agents/skills/") ? rel.slice(".agents/skills/".length) : rel;
      await runSuite(
        [process.execPath, "--experimental-strip-types", ".agents/skills/run.ts", skRel],
        rel,
        `node --experimental-strip-types .agents/skills/run.ts ${skRel}`,
      );
    } else {
      await runSuite(
        [process.execPath, "--experimental-strip-types", rel],
        rel,
        `node --experimental-strip-types ${rel}`,
      );
    }
  }

  if (unitFailed) return;
  if (!found) {
    // Most folders carry no suites of either kind, so this is the COMMON case
    // and must not halt — the same reasoning that reports an app with no
    // `check` unverified.
    say(`unverified ${label} — no test suites`);
  } else {
    say(`ok ${label}`);
  }
}

async function main(): Promise<void> {
  const tid = spawnSync(process.execPath, ["--experimental-strip-types", THREAD, "--id"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  // The id is stdout alone: a Node 22.x writes a type-stripping warning to
  // stderr on every run, and merged in it named a thread with no ledger, so the
  // close verified nothing and exited 0. stderr is read only for the refusal.
  if (tid.status !== 0) {
    const err = (tid.stderr ?? "").split("\n").filter((l) => l !== "");
    const why = err.filter((l) => l.startsWith("thread: ")).pop() ?? err.pop() ?? `thread.ts exited ${tid.status}`;
    process.stderr.write(`verify: ${why.replace(/^thread: /, "")}\n`);
    exit(2);
  }
  const TID = (tid.stdout ?? "").replace(/\n+$/, "");

  // REGISTER THE THREAD'S OWN WORKTREE BEFORE READING THE LEDGER. A session that
  // edited only app code has never called the resolver — nothing asked it where
  // to write, because the harness had already put it in the right tree. Its
  // ledger is therefore empty, and a verify that just reads the ledger prints
  // "nothing to verify" and exits 0. The journal step then registers that
  // worktree anyway, and Land commits app changes no check ever ran against — a
  // case fixtures that pre-seed a ledger never see. The resolver is idempotent,
  // so this is free on every later close.
  const t3 = out(process.execPath, ["--experimental-strip-types", THREAD, "--worktree"]);
  const T3_WT = t3.stdout;
  // A registration that failed is a FAIL, never skipped: with no ledger behind it
  // the close would print "nothing to verify" over outstanding app changes.
  if (T3_WT !== "" && isDir(T3_WT)) {
    const reg = spawnSync("bash", [WRITE_ROOT, T3_WT], { encoding: "utf8", stdio: ["inherit", "ignore", "pipe"] });
    if (reg.status !== 0) {
      const why = (reg.stderr ?? reg.error?.message ?? "").trim().split("\n").pop() || `exited ${reg.status}`;
      say(`FAIL verify — could not register ${T3_WT}: ${why.replace(/^write-root: /, "")}`);
      exit(1);
    }
  }

  const threadDir = `${process.env.HOME ?? homedir()}/.cache/workbench/threads/${TID}`;
  const LEDGER = `${threadDir}/worktrees`;
  // What `land.ts` has already put on a trunk, one `<shared-path>\t<sha>` row per
  // landing. Read here for one question only: is a ledger row whose worktree is
  // gone a LOSS or a completed landing?
  const LANDED = `${threadDir}/landed`;
  const LOGS = `${threadDir}/verify`;

  if (!isFile(LEDGER)) {
    say("verify: this thread owns no worktrees yet — nothing to verify");
    exit(0);
  }

  mkdirSync(LOGS, { recursive: true });
  const rows = ledgerRows(LEDGER);
  const SEEN: string[] = [];

  // ── Pass 1: apps whose own files moved ─────────────────────────────────────

  for (const { wt } of rows) {
    if (wt === "" || !isDir(wt)) continue;

    for (const app of appDirsFor(wt)) {
      // A worktree per repo means one app can only come from one of them, but a
      // rename across worktrees would otherwise verify it twice.
      if (SEEN.includes(app)) continue;
      SEEN.push(app);
      verifyApp(LOGS, wt, app);
    }

    // The integrations whose own files moved AND which declare a half to run.
    // Kept out of SEEN: SEEN is what pass 2 tests for "did pass 1 verify an APP",
    // and an integration verifying itself must not suppress the importer fallback
    // for the apps that read it.
    // A manifest that is absent is silence; one that exists and cannot be parsed
    // (hasScript's 2) goes to verifyUnit, which fails it — skipping it read a
    // broken package.json as "declares no suite" and let the close through.
    for (const integ of integrationDirsFor(wt)) {
      const pkg = `${wt}/${integ}/package.json`;
      if (!isFile(pkg)) continue;
      if (hasScript(pkg, "test") === 1 && hasScript(pkg, "check") === 1) continue;
      verifyUnit(LOGS, wt, integ, integ);
    }
  }

  // ── Pass 2: nothing moved in any app, but shared code did ──────────────────
  //
  // Only reached when pass 1 verified nothing, so the narrow scope is untouched
  // for every session that edited an app.

  if (SEEN.length === 0) {
    const CAP = process.env.VERIFY_IMPORTER_CAP || "8";
    const candidates: { wt: string; app: string }[] = [];
    for (const { wt } of rows) {
      if (wt === "" || !isDir(wt)) continue;
      for (const rel of sharedPathsFor(wt)) {
        for (const app of importersOf(wt, rel)) {
          if (candidates.some((c) => c.wt === wt && c.app === app)) continue;
          candidates.push({ wt, app });
        }
      }
    }

    const COUNT = candidates.length;
    if (COUNT > 0) {
      say(`verify: no app files changed — verifying ${COUNT} app(s) that import the shared code this thread touched`);
      for (const { wt, app } of candidates) {
        SEEN.push(app);
        if (COUNT > Number(CAP)) {
          // Named, not run. Silence would be the real failure here; a close that
          // takes ten minutes is its own kind of failure.
          say(`unverified ${app} — imports shared code, and ${COUNT} importers is past the cap of ${CAP}`);
        } else {
          verifyApp(LOGS, wt, app, " (imports shared code this thread changed)");
        }
      }
    }
  }

  // ── Pass 3: the skills tree ────────────────────────────────────────────────

  const SKILLS_SEEN: string[] = [];
  const SKILLS_TIMEOUT = process.env.VERIFY_SKILLS_TIMEOUT || "180";
  const WB_WT = workbenchWorktree(rows);

  if (WB_WT === "") {
    // NO LIVE WORKBENCH ROW. SILENCE HERE WAS A FALSE SUCCESS: everything below
    // keys off this one row, so without it a session that edited skills closes
    // having verified none of it and exits 0 saying nothing.
    //
    // A LANDED ROW IS NOT A LOST ONE. `land.ts` removes each worktree after it
    // lands and does NOT prune the ledger — so after any successful close the rows
    // outlive the directories, and a SECOND close of the same thread halted here
    // every time with nothing actually wrong. `land.ts` itself reads the same
    // state and treats those rows as spent; this said they were missing. The two
    // now agree, and on the same evidence: the repo's own row in `landed`. A row
    // that vanished WITHOUT landing took uncommitted or unpushed work with it, and
    // `land.ts` refuses that too (`worktree missing before landing`).
    //
    // The apps pass skips an unreadable row. Here that silence would suppress
    // the only evidence left, in exactly the case that needs noise.
    const landed = isFile(LANDED)
      ? readFileSync(LANDED, "utf8")
          .split("\n")
          .filter((l, i, all) => !(i === all.length - 1 && l === ""))
          .map((l) => l.split("\t")[0] ?? "")
      : [];
    for (const { wt, shared } of rows) {
      if (wt === "") continue;
      if (isDir(wt)) continue;
      if (landed.includes(shared)) {
        say(`unverified skills — ledger worktree ${wt} already landed and was removed`);
        SKILLS_SEEN.push("(landed)");
      } else {
        say(`FAIL skills — ledger worktree ${wt} is missing`);
        SKILLS_SEEN.push("(ledger)");
        FAILED = 1;
      }
    }
    if (SKILLS_SEEN.length === 0) {
      // Every row is live and none is the workbench. Reported in the vocabulary a
      // gap already has — `unverified`, not `FAIL` — because a thread with no
      // workbench row is not a defect this session introduced, and halting every
      // such close would be the same over-reach the backstop's attribution rule
      // exists to avoid.
      say(
        "unverified skills — no worktree this thread owns holds .agents/skills/, so no skill folder was checked",
      );
      SKILLS_SEEN.push("(unresolved)");
    }
  } else {
    // The SHARED column of the workbench row: the checkout the `~/.agents/skills`
    // link points into, read by the backstop below. Split on single tabs, as
    // `awk -F'\t'` does.
    const WB_SHARED =
      readFileSync(LEDGER, "utf8")
        .split("\n")
        .map((l) => l.split("\t"))
        .find((f) => f[0] === WB_WT)?.[1] ?? "";
    const SKILLS_OWNED = new Set(changedPaths(WB_WT));
    let SKILLS_TOUCHED = false;

    for (const unit of skillUnitsFor(WB_WT)) {
      // Only a skills unit is evidence for the backstop's attribution below: the
      // link exposes `.agents/skills/`, and a checks-only session touched none of it.
      if (unit.skill) SKILLS_TOUCHED = true;
      SKILLS_SEEN.push(unit.label);
      await verifySkillUnit(LOGS, SKILLS_TIMEOUT, WB_WT, unit);
    }

    // ── The backstop ─────────────────────────────────────────────────────────
    //
    // The write guard fails OPEN on any Bash form it cannot parse, and the
    // `~/.agents/skills` link still points into `.agents/skills/` of the landed checkout,
    // so a write through it lands in the SHARED checkout of the workbench row — in
    // no worktree, where no close will ever commit it. Only `.agents/skills/` is asked:
    // that is the tree the link exposes, and the rest of that checkout is
    // land.ts's report (`shared checkout ... not advanced`), not this pass's.
    //
    // ATTRIBUTION decides what happens next, because the shared checkout cannot
    // say who wrote what. If this worktree changed something under `.agents/skills/`, a
    // dirty path there it does not account for is a write that escaped the guard
    // IN A SESSION ALREADY EDITING SKILLS, and it halts. If it changed nothing
    // under `.agents/skills/`, there is no evidence this session touched skills at all —
    // another session's uncommitted work must not stop an unrelated close.
    const DIRT = sortUnique(
      out("git", ["-C", WB_SHARED, "status", "--porcelain", "--", ".agents/skills"])
        .stdout.split("\n")
        .map((l) => (l.length >= 3 ? l.slice(3) : l).replace(/^.* -> /, "")),
    );

    if (DIRT.length > 0) {
      if (SKILLS_TOUCHED) {
        const STRAY: string[] = [];
        for (const p of DIRT) {
          // SAME PATH IS NOT THE SAME FILE. Exempting on the path alone let a
          // DIFFERENT edit at that path sit in the shared checkout unmentioned:
          // the worktree's version lands, the shared one is stranded, and the
          // close reports neither. Only identical content is this session's own
          // work showing up twice — and a path the worktree DELETED never matches,
          // which is right, because then nothing will land the shared copy.
          if (SKILLS_OWNED.has(p) && sameFile(`${WB_SHARED}/${p}`, `${WB_WT}/${p}`)) continue;
          STRAY.push(p);
        }
        if (STRAY.length > 0) {
          say(
            `FAIL skills — ${STRAY.length} uncommitted file(s) under .agents/skills/ in the shared checkout this thread's worktree does not account for`,
          );
          // Line by line, not word by word: a path with a space in it would
          // otherwise be listed as two files that do not exist.
          for (const p of STRAY) say(`       ${p}`);
          say(`     they are in no ledger, so nothing will commit them — move them under ${WB_WT}/.agents/skills`);
          SKILLS_SEEN.push("(shared)");
          FAILED = 1;
        }
      } else {
        say(
          `unverified skills — ${DIRT.length} uncommitted file(s) under .agents/skills/ in the shared checkout, owner unknown`,
        );
        for (const p of DIRT) say(`       ${p}`);
        SKILLS_SEEN.push("(shared)");
      }
    }
  }

  // The apps line is about APPS. A session that changed only skills has verified
  // something real, and telling it "no app files changed" as the whole story read
  // as "nothing ran" — which was true before pass 3 existed and is not now.
  if (SEEN.length === 0 && SKILLS_SEEN.length === 0) {
    say("verify: no app files changed in this thread's worktrees");
  } else if (SEEN.length === 0) {
    say("verify: no app files changed in this thread's worktrees — skills units above");
  }

  exit(FAILED);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
