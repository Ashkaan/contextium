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
// NO MANIFEST TO RUN. A unit with no package.json, or one that declares
// neither half, runs its own `*.test.ts` suites with `node --test` from the
// worktree root, exactly as a project's do, and is `ok` when they pass.
// Printing nothing for it let a close record a pass with none of its tests
// run. With no suites either it is `unverified`, never silent.
//
// WHICH INTEGRATIONS. The ones whose own files moved AND which declare a
// `check` or `test` of their own — verified in pass 1 beside the apps, on the
// same narrow rule. This is not the importer fallback: pass 2 fires only when
// pass 1 verified NOTHING, so a session touching an app AND an integration would
// otherwise verify the app and skip the integration's own suite. An integration
// that declares neither half and carries no `*.test.ts` suite prints nothing at
// all, rather than `unverified`: by convention an integration has no typecheck
// target of its own, so its silence is the norm and not a gap. One that declares
// neither half but carries suites runs them.
//
// AND WHICH PACKAGES. A `packages/<name>` folder is held to the same rule:
// verified when its own files moved and it declares a `test` or `check`,
// silent when it declares neither (most have no package.json). Without it no
// close would run any package's own tests.
//
// THE RECORD. Every run ends by
// writing `<thread state>/verified`: the run's result, and a content digest of
// every path each ledger worktree changes — the same changed-path listing the
// passes below read, so the importer fallback's integration edits are in it —
// leaving out only the records /close writes AFTER verify (`journal/`,
// `knowledge/`, a project's ROADMAP.md and README.md). `land.ts` asks
// `--stamped` before it commits anything and refuses a thread whose code moved
// since verify passed: otherwise nothing proves verify ran at all, and the step
// lives only as a SKILL.md sentence. The digests are
// taken at the START of the run, so a file edited while the suites ran reads
// as changed, and a run that halts before its end leaves `incomplete`, never
// the pass an earlier run wrote. The file, whose one reader is `--stamped`:
//
//   {"result":"pass"|"fail"|"incomplete","repos":{"<shared>":{"<path>":"<digest>"}}}
//
// Usage:
//   verify.ts              — verify every app, integration, package, product
//                            repo and skill folder this thread touched
//   verify.ts --stamped    — run nothing: exit 0 when the last run passed and no
//                            worktree changed since (or none changed at all),
//                            else 1 with one stderr line per worktree saying why
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
// WHICH PROJECTS. A project that carries suites of its own is a unit when any
// of its files but markdown moved in the workbench worktree — code, or a
// fixture a suite reads — and every `*.test.ts` beneath it runs with
// `node --test`, bounded like a skill suite; otherwise a project's own suites
// run on no close. A project's markdown records (README, ROADMAP, specs) move
// nothing a test reads, so they select nothing. One with code and no suites
// is `unverified`, never silent.
//
// Output, one line per app (and per integration, package or product repo,
// labelled `integrations/<name>`, `packages/<name>` or the repo's name):
//   ok <app>
//   unverified <app> — no <check|test|check or test> script
//   unverified <app> — no package.json and no test suites
//   unverified <app> — imports <path>, and N importers is past the cap
//   FAIL <app> <half> — rerun: cd <dir> && npm run <half>
//   FAIL <app> <half> — <dir>/package.json could not be parsed   (an app or integration)
//   FAIL <app> <suite> — rerun: cd <worktree> && node --test … <suite>   (no manifest to run)
//   FAIL <app> <suite> — timed out after <N>s
//   FAIL <app> — could not list its node:test suites (find exited <N>)
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
// and one line per project unit:
//   ok projects/<domain>/<slug>
//   unverified projects/<domain>/<slug> — no test suites
//   FAIL projects/<domain>/<slug> <suite> — rerun: cd <worktree> && node --test … <suite>
//   FAIL projects/<domain>/<slug> <suite> — timed out after <N>s
//   FAIL projects/<domain>/<slug> — could not list its node:test suites (find exited <N>)
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts.
//   VERIFY_RUNNER — the command used to run a script, default `npm run`. The
//                   test suite replaces it; nothing in production does.
//   VERIFY_IMPORTER_CAP — how many importer apps may be RUN in the fallback pass
//                   before they are named unverified instead. Default 8.
//   VERIFY_SKILLS_TIMEOUT — seconds one suite of any unit may take. Default 180.
//                   Enforced by a watchdog in this process (the suite runs in a
//                   process group of its own, TERMed at the limit and KILLed 5s
//                   later), not by timeout(1), which stock macOS does not have.
//
// peers:
//   .agents/skills/close/scripts/verify.test.ts
//   .agents/skills/close/scripts/write-root.sh   (writes the ledger walked here)
//
// Exit: 0 all green (or nothing to verify) · 1 at least one FAIL · 2 no thread
//       --stamped: 0 stamped, or nothing changed · 1 not stamped · 2 no thread

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const THREAD = join(SCRIPT_DIR, "thread.ts");
const TRUNK = join(SCRIPT_DIR, "trunk.ts");
const WRITE_ROOT = join(SCRIPT_DIR, "write-root.sh");
// The review receipt's reader, run as a program.
const AUDIT = join(SCRIPT_DIR, "../../implement-audit/scripts/audit-dedupe.ts");
const RUNNER = process.env.VERIFY_RUNNER || "npm run";
// Seconds one suite may take, whatever unit it belongs to.
const SUITE_TIMEOUT = process.env.VERIFY_SKILLS_TIMEOUT || "180";

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
// rows (`R old -> new`) need a real parser, and getting it wrong silently drops
// an app from the verify set. Each read is NUL-separated (`-z`): without it git
// C-quotes a name holding a tab or a non-ASCII byte, and `"apps/x/…` maps to no
// app at all.
//
// A READ THAT FAILED HALTS. Each git read's status is checked: a failed diff or
// untracked listing contributed no lines, dropped every app it would have named,
// and the close printed "no app files changed" and exited 0 having run nothing.
// The trunk lookup and the `origin/<trunk>` probe are questions whose "no" is an
// answer — a repo with no origin has no committed range to diff — so only the
// three reads that list paths are held to it.
//
// ASKED ONCE PER WORKTREE PER RUN. Every pass and the record ask it again, and
// each answer costs a `trunk.ts` start; the tree they ask about is the one the
// record's digests were taken from at the start.
const CHANGED = new Map<string, string[]>();
function changedPaths(wt: string): string[] {
  const hit = CHANGED.get(wt);
  if (hit) return hit;
  const paths = listChangedPaths(wt);
  CHANGED.set(wt, paths);
  return paths;
}

function listChangedPaths(wt: string): string[] {
  const all: string[] = [];
  const read = (args: string[]): string[] => {
    const r = spawnSync("git", ["-C", wt, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      const why = (r.stderr ?? r.error?.message ?? "").trim().split("\n").pop() || `exited ${r.status}`;
      say(`FAIL verify — could not list the changed files in ${wt}: git ${args.join(" ")}: ${why}`);
      exit(1);
    }
    return (r.stdout ?? "").split("\0");
  };
  // The trunk is asked for per repo rather than spelled `main`: a repo whose
  // trunk is `master` would otherwise fall through to the untracked-only
  // branch below and verify NOTHING it had committed.
  const t = out(process.execPath, ["--experimental-strip-types", TRUNK, wt]);
  const vtrunk = t.ok ? t.stdout : "";
  // A trunk `trunk.ts` names from origin/HEAD before `origin/<trunk>` is a
  // local ref hid every COMMITTED change: only a fetch creates the ref, and
  // land.ts fetches before it measures. Fetched here too, once, so verify sees
  // what the landing will push (otherwise the stamp disagrees with land).
  const hasTrunk = (): boolean => out("git", ["-C", wt, "rev-parse", "--verify", "-q", `origin/${vtrunk}`]).ok;
  if (vtrunk !== "" && !hasTrunk()) out("git", ["-C", wt, "fetch", "-q", "origin", vtrunk]);
  if (vtrunk !== "" && hasTrunk()) {
    all.push(...read(["diff", "-z", `origin/${vtrunk}...HEAD`, "--name-only"]));
  }
  all.push(...read(["diff", "-z", "HEAD", "--name-only"]));
  all.push(...read(["ls-files", "-z", "--others", "--exclude-standard"]));
  return sortUnique(all);
}

// The app a repo-relative path belongs to: the nearest folder under `apps/`
// holding a package.json, returned without `apps/` — `<name>` in a flat layout,
// `<domain>/<name>` in a grouped one. With no manifest above the path the app
// is still one (it runs its own `*.test.ts` suites, or is `unverified`), told
// by layout: `<domain>/<name>` when `apps/<domain>/` holds folders and no file
// of its own, else `<name>`. Nothing for a file directly under `apps/`.
function appOf(wt: string, rel: string): string[] {
  const f = rel.split("/");
  if (f[0] !== "apps") return [];
  for (let n = f.length - 1; n >= 2; n--) {
    const d = f.slice(0, n).join("/");
    if (isFile(`${wt}/${d}/package.json`)) return [d.slice("apps/".length)];
  }
  if (f.length < 3) return [];
  const top = `${wt}/apps/${f[1]}`;
  let grouped = false;
  if (f.length >= 4) {
    try {
      grouped = !readdirSync(top, { withFileTypes: true }).some((e) => e.isFile() && !e.name.startsWith("."));
    } catch {
      grouped = true; // a removed domain folder: its app went with it
    }
  }
  return [grouped ? `${f[1]}/${f[2]}` : (f[1] as string)];
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
      return (f[0] === "integrations" || f[0] === "packages") && f.length >= 2 ? [`${f[0]}/${f[1]}`] : [];
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
//
// A UNIT WITH NO package.json, OR ONE THAT DECLARES NEITHER HALF, RUNS ITS OWN
// `*.test.ts` SUITES, the way a project's run (runNodeSuites): returning at
// once with no line at all let a close record a pass with none of a unit's
// tests run. Neither a manifest nor a suite is named `unverified`, never
// silence. A path that names no folder is a deleted unit (the deletion is the
// intent) or a file directly under `apps/<domain>/`: nothing to run, nothing
// to say.
async function verifyUnit(logs: string, wt: string, rel: string, app: string, note = ""): Promise<void> {
  const dir = `${wt}/${rel}`;
  const pkg = `${dir}/package.json`;
  if (!isDir(dir)) return;
  const manifest = isFile(pkg);
  if (!manifest || (hasScript(pkg, "check") === 1 && hasScript(pkg, "test") === 1)) {
    const r = await runNodeSuites(logs, SUITE_TIMEOUT, wt, rel === "." ? wt : dir, app);
    if (r === "ok") say(`ok ${app}${note}`);
    else if (r === "none" && manifest) say(`unverified ${app} — no check or test script`);
    else if (r === "none") say(`unverified ${app} — no package.json and no test suites`);
    return;
  }
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
function verifyApp(logs: string, wt: string, app: string, note = ""): Promise<void> {
  return verifyUnit(logs, wt, `apps/${app}`, app, note);
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

// `<domain>/<slug>` of every project whose files other than markdown moved.
function projectUnitsFor(wt: string): string[] {
  return sortUnique(
    changedPaths(wt).flatMap((p) => {
      const f = p.split("/");
      return f[0] === "projects" && f.length >= 4 && !p.endsWith(".md") ? [`${f[1]}/${f[2]}`] : [];
    }),
  );
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

/** `find <dir> [-maxdepth 1] -type f -name <pattern> | sort`, and find's status.
 *  `node_modules` and `.git` are pruned: a product repo's root is searched
 *  when it has no manifest, and a dependency's suite is not the repo's own. */
function findSuites(dir: string, root: boolean, pattern: string): { rc: number; suites: string[] } {
  const prune = ["(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune", "-o"];
  const r = spawnSync(
    "find",
    [dir, ...(root ? ["-maxdepth", "1"] : []), ...prune, "-type", "f", "-name", pattern, "-print"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const suites = (r.stdout ?? "")
    .split("\n")
    .filter((l) => l !== "")
    .sort();
  return { rc: r.status ?? 1, suites };
}

// Signal numbers for a child that died by one, the way a shell reports it (128+n).
const SIGNUM: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

// Run one suite in `cwd` with stdout and stderr both in `log`, bounded by
// `secs`; its exit status. The bound is a watchdog here, not timeout(1):
// timeout(1) signals the group once and exits with the leader, so a child that
// ignores TERM outlived it; stock macOS has neither timeout nor gtimeout; and
// the clock in the caller — not this status — decides "timed out" anyway. The suite runs as the leader of a
// process group of its own, and the watchdog signals the GROUP, as timeout(1)
// does: a suite's own children (the `sleep` a hung suite waits on) die with it
// rather than outliving the close. TERM first; KILL five seconds later for a
// suite that traps TERM and keeps going.
//
// The leader's exit does not end the cleanup. A leader that exits on TERM can
// leave a child that ignores TERM; once TERM has gone out, the promise settles
// only after the group is empty or the KILL has been sent — resolving on the
// leader's exit cancelled the KILL, and that child outlived the close for good.
function runBounded(argv: string[], cwd: string, log: string, secs: number, env?: NodeJS.ProcessEnv): Promise<number> {
  const fd = openSync(log, "w");
  return new Promise((done) => {
    const [cmd, ...args] = argv;
    let settled = false;
    let dog: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let exitRc: number | undefined;
    let killSent = false;
    const settle = (rc: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(dog);
      clearTimeout(killer);
      closeSync(fd);
      done(rc);
    };
    const child = spawn(cmd ?? "", args, { cwd, env, stdio: ["ignore", fd, fd], detached: true });
    const signal = (sig: NodeJS.Signals | 0): boolean => {
      try {
        if (child.pid === undefined) return false;
        process.kill(-child.pid, sig);
        return true;
      } catch {
        return false; // The group is already gone.
      }
    };
    child.on("error", () => {
      writeSync(fd, `${cmd ?? ""}: command not found\n`);
      settle(127);
    });
    child.on("exit", (code, sig) => {
      exitRc = code ?? (sig ? 128 + (SIGNUM[sig] ?? 0) : 1);
      // TERM sent and the group still has members: the KILL is due, and the
      // run settles when it has gone out.
      if (killer !== undefined && !killSent && signal(0)) return;
      settle(exitRc);
    });
    dog = setTimeout(() => {
      signal("SIGTERM");
      killer = setTimeout(() => {
        killSent = true;
        signal("SIGKILL");
        if (exitRc !== undefined) settle(exitRc);
      }, 5000);
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

// Every `*.test.ts` beneath `dir`, each run from the worktree root `wt` with
// the flags layer-2.ts gives a test run in place (`--experimental-test-module-mocks`
// so a mock.module() suite does not read as a regression). Same vocabulary and
// clock as verifySkillUnit. Prints each FAIL under `label` and sets FAILED; the
// caller prints the `ok` or `unverified` line, because what a unit with no
// suites is called depends on what kind of unit it is. One runner for every
// unit that has no manifest to run: a project, and an app, integration, package
// or product repo with no package.json or one declaring neither half.
async function runNodeSuites(
  logs: string,
  timeout: string,
  wt: string,
  dir: string,
  label: string,
): Promise<"ok" | "none" | "failed"> {
  const ts = findSuites(dir, false, "*.test.ts");
  if (ts.rc !== 0) {
    say(`FAIL ${label} — could not list its node:test suites (find exited ${ts.rc})`);
    FAILED = 1;
    return "failed";
  }
  if (ts.suites.length === 0) return "none";
  const limit = Number(timeout);
  const flags = [
    "--test",
    "--experimental-strip-types",
    "--experimental-test-module-mocks",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
  ];
  // A `node --test` started under another one reports to it and exits 0
  // whatever its tests did, so the parent's NODE_TEST_CONTEXT is not passed on.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  let unitFailed = false;
  for (const suite of ts.suites) {
    const rel = suite.startsWith(`${wt}/`) ? suite.slice(wt.length + 1) : suite;
    const log = `${logs}/${rel.replace(/\//g, "-")}.log`;
    const start = Date.now();
    const rc = await runBounded([process.execPath, ...flags, rel], wt, log, limit, env);
    const elapsed = Date.now() - start;
    if (elapsed >= limit * 1000) {
      say(`FAIL ${label} ${rel} — timed out after ${timeout}s`);
    } else if (rc !== 0) {
      say(`FAIL ${label} ${rel} — rerun: cd ${wt} && node ${flags.join(" ")} ${rel}`);
    } else {
      continue;
    }
    say(`     log: ${log}`);
    unitFailed = true;
    FAILED = 1;
  }
  return unitFailed ? "failed" : "ok";
}

// A project with code and no suites is named `unverified`, as a skill folder
// is, so no unit kind's gap is silent.
async function verifyProjectUnit(logs: string, timeout: string, wt: string, unit: string): Promise<void> {
  const dir = `${wt}/projects/${unit}`;
  if (!isDir(dir)) return;
  const r = await runNodeSuites(logs, timeout, wt, dir, `projects/${unit}`);
  if (r === "ok") say(`ok projects/${unit}`);
  else if (r === "none") say(`unverified projects/${unit} — no test suites`);
}

// ── The record ─────────────────────────────────────────────────────────────

// The records /close writes after verify has run: § 2's project README and
// ROADMAP (and land.ts's promotion of a finished row in them), § 3's journal
// entry, and anything under knowledge/. Every other changed path is code or a
// spec, and moving one after verify passed makes the pass stale.
function isAfterVerifyRecord(p: string): boolean {
  return /^(?:journal|knowledge)\//.test(p) || /^projects\/(?:.*\/)?(?:ROADMAP|README)\.md$/.test(p);
}

// One path's content as git would record it: absent, a symlink's target, or
// the exec bit and the bytes. A directory is a nested repo `ls-files` lists
// whole; its own contents are its own repo's business. Exported for the review
// receipt (.agents/skills/implement-audit/scripts/audit-dedupe.ts), which compares the
// content a review covered the same way.
export function digest(p: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return `link:${readlinkSync(p)}`;
  if (!st.isFile()) return "dir";
  return `${st.mode & 0o111 ? "x" : "-"}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
}

type Digests = Record<string, string>;

// Every live ledger worktree's changed paths and their digests, keyed by the
// row's shared checkout: a worktree removed and made again for the same repo
// is the same repo, and unchanged content still matches.
function snapshot(rows: LedgerRow[]): Record<string, { wt: string; paths: Digests }> {
  const out: Record<string, { wt: string; paths: Digests }> = {};
  for (const { wt, shared } of rows) {
    if (wt === "" || !isDir(wt)) continue;
    const paths: Digests = {};
    for (const p of changedPaths(wt)) if (!isAfterVerifyRecord(p)) paths[p] = digest(join(wt, p));
    out[shared || wt] = { wt, paths };
  }
  return out;
}

function writeRecord(file: string, result: string, snap: ReturnType<typeof snapshot>): void {
  const repos: Record<string, Digests> = {};
  for (const [key, { paths }] of Object.entries(snap)) repos[key] = paths;
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ result, repos })}\n`);
  renameSync(tmp, file);
}

// THE REVIEW RECEIPT. Implementation source
// lands only on an independent review of the content as it is now: the same
// reader validate.ts's review path writes for, asked of every live ledger
// worktree. It says nothing about a thread with no implementation work (no
// registered audit, no report carrying a coverage block), so an ad-hoc fix or a
// planning close is judged exactly as before. A missing or crashing reader is
// a failure, never a pass. Returns the lines to print and whether it passed.
function reviewReceipts(tid: string, rows: LedgerRow[]): { ok: boolean; lines: string[] } {
  const wts = rows.map((r) => r.wt).filter((wt) => wt !== "" && isDir(wt));
  if (wts.length === 0) return { ok: true, lines: [] };
  if (!isFile(AUDIT)) return { ok: false, lines: [`FAIL review — the receipt reader is missing: ${AUDIT}`] };
  const r = spawnSync(process.execPath, ["--experimental-strip-types", AUDIT, "check", "--owner", tid, ...wts], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [
    ...(r.stdout ?? "")
      .split("\n")
      .filter((l) => l.startsWith("review: "))
      .map((l) => `ok ${l}`),
    ...(r.stderr ?? "")
      .split("\n")
      .filter((l) => l.startsWith("review: "))
      .map((l) => `FAIL ${l}`),
  ];
  if (r.status === 0) return { ok: true, lines };
  if (r.status === 1 && lines.some((l) => l.startsWith("FAIL "))) return { ok: false, lines };
  const why = (r.stderr ?? r.error?.message ?? "").trim().split("\n").pop() || `exited ${r.status}`;
  return { ok: false, lines: [...lines, `FAIL review — the receipt check could not run: ${why}`] };
}

// --stamped: the record against the worktrees as they are now. Runs no suite.
// A worktree with nothing changed needs no stamp — a thread that wrote only
// records, or one whose earlier landing already put its work on the trunk.
function stamped(file: string, rows: LedgerRow[], tid: string): never {
  const now = snapshot(rows);
  const receipts = reviewReceipts(tid, rows);
  const unreviewed = receipts.lines.filter((l) => l.startsWith("FAIL ")).map((l) => `verify: ${l.slice(5)}`);
  const moved = Object.entries(now).filter(([, { paths }]) => Object.keys(paths).length > 0);
  if (moved.length === 0 && unreviewed.length === 0) return exit(0);
  let rec: { result?: unknown; repos?: Record<string, Digests> } | null = null;
  if (isFile(file)) {
    try {
      rec = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      rec = null;
    }
  }
  const why: string[] = [...unreviewed];
  for (const [key, { wt, paths }] of moved) {
    if (rec === null) {
      why.push(`verify: ${wt}: verify never ran on this worktree`);
      continue;
    }
    if (rec.result !== "pass") {
      why.push(`verify: ${wt}: the last run ${rec.result === "incomplete" ? "did not finish" : "failed"}`);
      continue;
    }
    const was = rec.repos?.[key];
    if (!was) {
      why.push(`verify: ${wt}: verify never ran on this worktree`);
      continue;
    }
    const differ = sortUnique([...Object.keys(paths), ...Object.keys(was)]).filter((p) => paths[p] !== was[p]);
    if (differ.length > 0) why.push(`verify: ${wt}: changed since verify passed: ${differ.join(", ")}`);
  }
  if (why.length === 0) return exit(0);
  process.stderr.write(why.map((l) => `${l}\n`).join(""));
  return exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const STAMPED = args[0] === "--stamped";
  if (args.length > (STAMPED ? 1 : 0)) {
    process.stderr.write("usage: verify.ts [--stamped]\n");
    exit(2);
  }
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

  const threadDir = `${process.env.HOME ?? homedir()}/.cache/workbench/threads/${TID}`;
  const LEDGER = `${threadDir}/worktrees`;
  const RECORD = `${threadDir}/verified`;

  // A question about the last run, asked of the ledger as it stands: it
  // registers nothing, because land.ts has seeded the ledger by the time it asks.
  if (STAMPED) {
    if (!isFile(LEDGER)) exit(0);
    stamped(RECORD, ledgerRows(LEDGER), TID);
  }

  // Whatever an earlier run recorded stops counting now: a run that halts
  // anywhere below leaves `incomplete` behind, never that run's pass.
  mkdirSync(threadDir, { recursive: true });
  writeRecord(RECORD, "incomplete", {});

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
  // A worktree the ledger already lists is registered: the resolver would
  // change nothing, and it costs a second of every run (land.ts's own suite
  // repeats verify in every landing case).
  const listed =
    isFile(LEDGER) &&
    readFileSync(LEDGER, "utf8")
      .split("\n")
      .some((l) => l.split("\t")[0] === T3_WT);
  if (T3_WT !== "" && isDir(T3_WT) && !listed) {
    const reg = spawnSync("bash", [WRITE_ROOT, T3_WT], { encoding: "utf8", stdio: ["inherit", "ignore", "pipe"] });
    if (reg.status !== 0) {
      const why = (reg.stderr ?? reg.error?.message ?? "").trim().split("\n").pop() || `exited ${reg.status}`;
      say(`FAIL verify — could not register ${T3_WT}: ${why.replace(/^write-root: /, "")}`);
      exit(1);
    }
  }

  // What `land.ts` has already put on a trunk, one `<shared-path>\t<sha>` row per
  // landing. Read here for one question only: is a ledger row whose worktree is
  // gone a LOSS or a completed landing?
  const LANDED = `${threadDir}/landed`;
  const LOGS = `${threadDir}/verify`;

  if (!isFile(LEDGER)) {
    say("verify: this thread owns no worktrees yet — nothing to verify");
    writeRecord(RECORD, "pass", {});
    exit(0);
  }

  mkdirSync(LOGS, { recursive: true });
  const rows = ledgerRows(LEDGER);
  const SEEN: string[] = [];
  // The content this run verifies, taken before any suite runs.
  const SNAP = snapshot(rows);

  // ── Pass 1: apps whose own files moved ─────────────────────────────────────

  for (const { wt } of rows) {
    if (wt === "" || !isDir(wt)) continue;

    for (const app of appDirsFor(wt)) {
      // A worktree per repo means one app can only come from one of them, but a
      // rename across worktrees would otherwise verify it twice.
      if (SEEN.includes(app)) continue;
      SEEN.push(app);
      await verifyApp(LOGS, wt, app);
    }

    // The integrations whose own files moved AND which declare a half to run.
    // Kept out of SEEN: SEEN is what pass 2 tests for "did pass 1 verify an APP",
    // and an integration verifying itself must not suppress the importer fallback
    // for the apps that read it.
    // One that exists and cannot be parsed (hasScript's 2) goes to verifyUnit,
    // which fails it — skipping it read a broken package.json as "declares no
    // suite" and let the close through. One with no manifest, or declaring
    // neither half, goes too when it carries `*.test.ts` suites: skipping it ran
    // none of the suites such an integration carries. Silence is
    // kept only for one with nothing at all to run, the convention above.
    for (const integ of integrationDirsFor(wt)) {
      const pkg = `${wt}/${integ}/package.json`;
      const declares = isFile(pkg) && !(hasScript(pkg, "test") === 1 && hasScript(pkg, "check") === 1);
      if (!declares) {
        const found = findSuites(`${wt}/${integ}`, false, "*.test.ts");
        if (!isDir(`${wt}/${integ}`) || (found.rc === 0 && found.suites.length === 0)) continue;
      }
      await verifyUnit(LOGS, wt, integ, integ);
    }
  }

  // ── Pass 1b: product repos whose own files moved ───────────────────────────
  //
  // A ledger row that is not the workbench worktree is a product repo's (a
  // site, an app with a repo of its own). When anything in it moved and its
  // root carries a package.json, its own `check` and `test` run from that
  // root, exactly as an app's do, and a red half fails the close: a product
  // repo whose push builds without testing is tested here or nowhere.
  // Labelled by the repo's name. Kept out of SEEN, which is about APPS.
  // A root with no package.json runs its own `*.test.ts` suites, or is named
  // `unverified`, as an app is.
  const PRODUCT_SKIP = workbenchWorktree(rows);
  for (const { wt, shared } of rows) {
    if (wt === "" || wt === PRODUCT_SKIP || !isDir(wt)) continue;
    const moved = changedPaths(wt);
    if (moved.length === 0) continue;
    // A product repo with apps/ of its own has those verified as apps; its root
    // suites still run when any moved file is not an app's with a suite of its
    // own — a root config, a contract test, or an app file the root tests
    // (Contextium v9.2.0 review).
    if (isDir(`${wt}/apps`)) {
      const ownSuite = (p: string): boolean => {
        // The app pass 1 verifies this file under (appOf).
        const [app] = appOf(wt, p);
        if (app === undefined) return false;
        const dir = `${wt}/apps/${app}`;
        const pkg = `${dir}/package.json`;
        // A manifest that declares a test is a suite, and so is a broken one,
        // since the app pass reports it. One that declares a check alone runs
        // only that. With no manifest, or one declaring neither half, the
        // app's own *.test.ts files are what the app pass runs.
        if (isFile(pkg)) {
          if (hasScript(pkg, "test") !== 1) return true;
          if (hasScript(pkg, "check") !== 1) return false;
        }
        const found = findSuites(dir, false, "*.test.ts");
        return found.rc === 0 && found.suites.length > 0;
      };
      if (!moved.some((p) => !ownSuite(p))) continue;
    }
    await verifyUnit(LOGS, wt, ".", basename(shared || wt));
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
          await verifyApp(LOGS, wt, app, " (imports shared code this thread changed)");
        }
      }
    }
  }

  // ── Pass 3: the skills tree ────────────────────────────────────────────────

  const SKILLS_SEEN: string[] = [];
  const SKILLS_TIMEOUT = SUITE_TIMEOUT;
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

    for (const unit of projectUnitsFor(WB_WT)) {
      await verifyProjectUnit(LOGS, SKILLS_TIMEOUT, WB_WT, unit);
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
    //
    // NUL-separated, so a quoted name is read as it is on disk: each record is
    // `XY path`, and a rename or copy is followed by one more record, the old
    // path, which is skipped — the new path is the file in the tree.
    const dirty: string[] = [];
    const recs = out("git", ["-C", WB_SHARED, "status", "--porcelain", "-z", "--", ".agents/skills"]).stdout.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i] ?? "";
      if (rec.length < 4) continue;
      dirty.push(rec.slice(3));
      if (/[RC]/.test(rec.slice(0, 2))) i++;
    }
    const DIRT = sortUnique(dirty);

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

  const receipts = reviewReceipts(TID, rows);
  for (const l of receipts.lines) say(l);
  if (!receipts.ok) {
    say("     an independent review must cover this content before it lands — run /implement-audit (its");
    say("     driver reuses what is still covered), or restore the reviewed bytes");
    FAILED = 1;
  }

  writeRecord(RECORD, FAILED ? "fail" : "pass", SNAP);
  exit(FAILED);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
