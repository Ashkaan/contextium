#!/usr/bin/env -S node --experimental-strip-types
// resolve-scope.ts — scope resolution for /implement Phase 4. Parse the scope argument and
// emit one repo-relative file path per line to stdout.
//
// Owns the scope-resolution table, formerly in the retired /validate skill.
//
// peers: .agents/skills/implement/scripts/resolve-scope.test.ts,
//        .agents/skills/implement/scripts/layer-1.ts,
//        .agents/skills/implement/scripts/layer-2.ts
//
// Usage:
//   resolve-scope.ts --scope <arg>
//
// Flags:
//   --scope <arg>   blank | apps/<app> | apps/<domain>/<app> | apps/<domain> |
//                   <name> matching apps/* | integrations/<name> |
//                   projects/<path> | glob
//
//                   An apps/ scope must name a DIRECTORY and is never widened to
//                   its parent — see the branch below for what that widening cost.
//
// Output:
//   stdout: one repo-relative path per line (may be empty)
//   stderr: scope-arg errors
//
// Exit:
//   0  scope resolved (zero or more files)
//   1  scope refers to a non-existent app/integration
//   2  a read the resolution depends on failed (an unreadable directory in
//      scope, a failed git command) — never reported as an empty scope

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `git rev-parse --show-toplevel`, or "" outside a repo. */
function gitToplevel(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

/** Byte-order sort with duplicates kept (`sort`) or dropped (`sort -u`). */
function sorted(lines: string[], unique = false): string[] {
  const s = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique ? s.filter((l, i) => i === 0 || l !== s[i - 1]) : s;
}

function emit(lines: string[]): void {
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

/** A read the resolution depends on failed: exit 2, never an empty list. */
function readFailed(what: string, detail: string): never {
  err(`resolve-scope: ${what} failed — refusing to report a partial scope as a whole one.`);
  if (detail !== "") err(`  ${detail.replace(/\n+$/, "")}`);
  exit(2);
}

/** Installed dependencies, build output and git internals: not a package's source. */
const PRUNED = new Set(["node_modules", ".git", "dist", "build"]);

/**
 * Every file a package owns, whatever its language: the layers find each
 * file's package and run that package's own lint and tests, so filtering to
 * *.ts here made a JavaScript-only package an empty scope that passed without
 * running anything. Regular files only, never following a symlink below the
 * start, with the PRUNED directories skipped. A directory it cannot read exits
 * 2: the bash original's `2>/dev/null` turned an unreadable subtree into a
 * short list at exit 0, and validation passed over files it never saw.
 */
function srcFiles(start: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      readFailed(`reading ${d}`, e instanceof Error ? e.message : String(e));
    }
    for (const e of entries) {
      const p = d.endsWith("/") ? `${d}${e.name}` : `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (!PRUNED.has(e.name)) walk(p);
      } else if (e.isFile()) found.push(p);
    }
  };
  walk(start);
  return sorted(found);
}

/**
 * Lines of a git command's stdout. A git that fails, or whose output outgrows
 * the capture, exits 2 with git's own error — a failed read is not "no lines".
 */
function gitLines(args: string[], cwd?: string): string[] {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error) readFailed(`git ${args.join(" ")}`, r.error.message);
  if (r.status !== 0 || typeof r.stdout !== "string") {
    readFailed(`git ${args.join(" ")} (exit ${r.status ?? r.signal})`, typeof r.stderr === "string" ? r.stderr : "");
  }
  return r.stdout.split("\n").filter((l) => l !== "");
}

async function main(): Promise<void> {
  let SCOPE = "";

  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const a = argv[0] ?? "";
    if (a === "--scope") {
      SCOPE = argv[1] ?? "";
      argv.splice(0, 2);
    } else if (a === "-h" || a === "--help") {
      // The header comment above, lines 2-30, is the help text.
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 30);
      process.stderr.write(`${lines.join("\n")}\n`);
      exit(0);
    } else {
      err(`unknown flag: ${a}`);
      exit(1);
    }
  }

  // Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
  // back to git when unset (some callers leave it unset). A failing rev-parse
  // outside a repo reads as "" so the guard below surfaces the documented exit
  // code rather than git's 128.
  const REPO_DIR = process.env.CLAUDE_PROJECT_DIR || gitToplevel();
  if (REPO_DIR === "") {
    err("CLAUDE_PROJECT_DIR unset and not inside a git repo");
    exit(1);
  }
  // `.git` is a DIRECTORY in a normal clone and a FILE (a gitdir pointer) in a
  // linked worktree. A directory test rejected every worktree — and /implement
  // runs Phase 4 (all five Phase 4 layers) inside one, so this guard failed the
  // whole build path. An existence test accepts both; a stray .git in a non-repo
  // still fails downstream.
  if (!existsSync(`${REPO_DIR}/.git`)) {
    err(`not a git repo: ${REPO_DIR}`);
    exit(1);
  }

  process.chdir(REPO_DIR);

  // ── Blank scope → staged files ───────────────────────────────────────
  if (SCOPE === "") {
    // Through gitLines: spawnSync's default 1 MiB capture truncated a large
    // staged list to a prefix at exit 0, and a failing git read as "nothing staged".
    emit(gitLines(["diff", "--cached", "--name-only"]));
    exit(0);
  }

  // ── apps/<name>, apps/<domain>/<app>, or a bare <name> matching apps/* ──
  //
  // THE SCOPE IS USED AS GIVEN WHEN IT NAMES A DIRECTORY. Taking only the FIRST
  // path segment would resolve `--scope apps/<domain>/<app>` to `apps/<domain>` —
  // the whole domain and every sibling app — and layer 1 would then FAIL the
  // caller's phase on a type error in an app the caller never named. Apps may be
  // grouped by domain (`apps/<domain>/<app>/`), and every peer that finds an app's
  // directory (layer-1.ts, layer-2.ts, this) must respect that grouping.
  //
  // There is NO first-segment fallback, and that is deliberate. A flat
  // `apps/<name>` and a domain somebody means literally both already name a
  // directory, so they need no special case — and the only input the fallback
  // could still catch is a path that is NOT a directory, i.e. a typo. Widening a
  // typo to its parent domain silently selects a superset the caller never asked
  // for; failing loud on it is strictly better.
  if (SCOPE.startsWith("apps/")) {
    if (!isDir(SCOPE)) {
      err(`app not found: ${SCOPE.slice("apps/".length)}`);
      err("  an apps/ scope must name a directory — apps/<app>, apps/<domain>/<app>,");
      err("  or apps/<domain> for a whole domain. It is never widened to the parent.");
      exit(1);
    }
    emit(srcFiles(SCOPE));
    exit(0);
  }

  // Bare name — try apps/<name> first
  if (isDir(`apps/${SCOPE}`)) {
    emit(srcFiles(`apps/${SCOPE}`));
    exit(0);
  }

  // ── integrations/<name> ──────────────────────────────────────────────
  if (SCOPE.startsWith("integrations/")) {
    const name = SCOPE.slice("integrations/".length).split("/")[0] ?? "";
    if (!isDir(`integrations/${name}`)) {
      err(`integration not found: ${name}`);
      exit(1);
    }
    emit(srcFiles(`integrations/${name}`));
    exit(0);
  }

  // ── projects/<path> — find code referenced by recent commits in that scope ─
  //
  // The project folder is a record in this repo, read from the session's write
  // root (the thread's worktree, else this checkout). The join is still by SUBJECT
  // rather than by path: a session closes once and `land.ts` commits everything
  // the thread owns under the SAME subject, so the project's recent subjects name
  // the code commits, whichever worktree each was made in. That is a real link,
  // not a guess: it is written by one script from one variable.
  if (SCOPE.startsWith("projects/")) {
    const swr = spawnSync(
      process.execPath,
      ["--experimental-strip-types", `${dirname(fileURLToPath(import.meta.url))}/session-write-root.ts`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const PROJECTS_ROOT = swr.status === 0 ? (swr.stdout ?? "").replace(/\n+$/, "") : "";
    if (PROJECTS_ROOT === "") {
      err("cannot resolve this session's write root — a projects/ scope needs it");
      exit(1);
    }
    if (!isDir(`${PROJECTS_ROOT}/${SCOPE}`)) {
      err(`project not found: ${PROJECTS_ROOT}/${SCOPE}`);
      exit(1);
    }
    // The subjects of the last few commits that touched this project…
    const subjects = sorted(
      gitLines(["-C", PROJECTS_ROOT, "log", "-n", "10", "--pretty=format:%s", "--", SCOPE]),
      true,
    );
    if (subjects.length === 0) exit(0);
    // …then the code files THIS repo committed under those same subjects.
    const code: string[] = [];
    for (const subj of subjects) {
      const sha = gitLines(["log", "-n", "1", "--fixed-strings", `--grep=${subj}`, "--pretty=format:%H"])[0] ?? "";
      if (sha === "") continue;
      for (const f of gitLines(["show", "--name-only", "--pretty=format:", sha])) {
        // Every committed source file, not only *.ts — the same reason as
        // srcFiles; installed dependencies, git internals and docs stay out.
        if (!/(^|\/)(node_modules|\.git)\/|\.md$/.test(f)) code.push(f);
      }
    }
    emit(sorted(code, true));
    exit(0);
  }

  // ── Glob / fallback ──────────────────────────────────────────────────
  // Resolve by expanding the glob, as `compgen -G` did: a match is a path that
  // exists, and a pattern that matches nothing yields nothing.
  //
  // fs.globSync is still experimental on older Node 22 releases (the template's
  // floor is 22.6) and prints an ExperimentalWarning on stderr there; drop that
  // one warning so stderr carries only scope errors. Every other warning still
  // reaches the handlers that were installed.
  const prior = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && w.message.includes("globSync")) return;
    for (const l of prior) l(w);
  });
  let matches: string[] = [];
  try {
    matches = globSync(SCOPE).filter((m) => m !== "");
  } catch {
    matches = [];
  }

  if (matches.length === 0) {
    err(`no files match scope: ${SCOPE}`);
    exit(1);
  }

  emit(sorted(matches));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
