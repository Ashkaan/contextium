#!/usr/bin/env -S node --experimental-strip-types
// run-automated-checks.ts — Step 1 of /implement-audit. Run the 5 deterministic
// checks against the diff between $BASE_SHA and HEAD; emit structured
// pass/fail lines the step-2 reviewer can consume verbatim.
//
// Owns the check block that would otherwise sit inline in
// .agents/skills/implement-audit/SKILL.md.
//
// peers: .agents/skills/implement-audit/scripts/run-automated-checks.test.ts,
//        .agents/skills/implement-audit/SKILL.md,
//        .agents/skills/implement/scripts/layer-1.ts (check 1),
//        .agents/checks/check-standards-refs.ts (check 3),
//        .agents/skills/review/find-peers.ts (check 4),
//        .agents/checks/check-secrets.ts (check 5)
//
// Usage:
//   run-automated-checks.ts --session-base <SHA> [--repo-dir <path>]
//
// Flags:
//   --session-base <SHA>  git rev-parsable start of the session's commits (REQUIRED)
//   --repo-dir <path>     absolute repo path (defaults to $CLAUDE_PROJECT_DIR,
//                         then falls back to `git rev-parse --show-toplevel`)
//
// Output (stdout, one TAP-ish line per check):
//   PASS: lint (3 files)
//   WARN: lint (1 files in no package) — not linted or typechecked: bin/x.sh
//   FAIL: shellcheck apps/foo/bar.sh:12 SC2086 quote to prevent globbing
//   PASS: standards-refs (0 dangling)
//   PASS: find-peers (0 left-behind)
//   PASS: secrets (clean)
//   SUMMARY: 4 PASS, 1 FAIL
//
// stderr: per-check verbose output on failure (capped at 10KB; overflow
// routed to /tmp/implement-audit-checks-<session>.log with a line-pointer).
//
// Exit:
//   0  all PASS or WARN
//   1  any FAIL

import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const err = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
/** `command -v <name>`: an executable file of that name on PATH. */
const onPath = (name: string): boolean =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .some((d) => d !== "" && isFile(join(d, name)) && isExecutable(join(d, name)));

let merged = 0;
/**
 * Run a command with stdout and stderr interleaved into one text, as bash's
 * `out=$(cmd 2>&1)` captured it: both streams share one file descriptor, so the
 * order is the order the command wrote in. Trailing newlines dropped. Stdin is
 * closed unless `input` is given; `env` is added to this process's.
 */
function runMerged(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): { ok: boolean; out: string } {
  const f = join(tmpdir(), `implement-audit-checks-${process.pid}-${++merged}.out`);
  const fd = openSync(f, "w");
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  let out = readFileSync(f, "utf8");
  unlinkSync(f);
  if (r.error) out += `${out === "" ? "" : "\n"}${cmd}: ${r.error.message}`;
  return { ok: !r.error && r.status === 0, out: out.replace(/\n+$/, "") };
}

async function main(): Promise<void> {
  // ── Argument parsing ─────────────────────────────────────────────────
  let SESSION_BASE = "";
  // Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
  // back to git when unset (some callers leave it unset). Applied at the
  // default only; a later --repo-dir flag still overrides. A failing rev-parse
  // outside a repo leaves the default empty, so the guard below surfaces the
  // documented exit code.
  let REPO_DIR = process.env.CLAUDE_PROJECT_DIR ?? "";
  if (REPO_DIR === "") {
    const g = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    REPO_DIR = g.status === 0 ? (g.stdout ?? "").replace(/\n+$/, "") : "";
  }

  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const a = argv[0] ?? "";
    if (a === "--session-base" || a === "--repo-dir") {
      if (argv.length < 2) {
        err(`${process.argv[1]}: $2: unbound variable`);
        exit(1);
      }
      if (a === "--session-base") SESSION_BASE = argv[1] ?? "";
      else REPO_DIR = argv[1] ?? "";
      argv.splice(0, 2);
    } else if (a === "-h" || a === "--help") {
      // The header comment above, from line 2 to its first non-comment line, is the help text.
      const all = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
      const end = all.findIndex((l, i) => i > 0 && !l.startsWith("//"));
      const lines = all.slice(1, end === -1 ? all.length : end);
      process.stderr.write(`${lines.join("\n")}\n`);
      exit(0);
    } else {
      err(`unknown flag: ${a}`);
      exit(1);
    }
  }

  if (SESSION_BASE === "") {
    err("--session-base <SHA> required");
    exit(1);
  }
  if (REPO_DIR === "") {
    err("--repo-dir or CLAUDE_PROJECT_DIR required (and not inside a git repo)");
    exit(1);
  }
  // existence, not directory-ness: a normal repo has a .git dir, a worktree a .git file
  if (!existsSync(`${REPO_DIR}/.git`)) {
    err(`not a git repo: ${REPO_DIR}`);
    exit(1);
  }

  // ── Where the check programs live ──────────────────────────────────────────
  //
  // The workbench has no git hooks at all, so the check programs live in its
  // tree: `find-peers.ts` with the review chain at .agents/skills/review/, the
  // standards-citation and secrets checks land.ts runs at .agents/checks/. A repo
  // without those folders (a product repo) gets the missing-tool WARN each check
  // below already uses, never a FAIL for a missing file.
  //
  // Lint is the package's own: layer-1.ts, beside this skill, runs each touched
  // package's lint and typecheck by convention, so a repo's rules stay its own.
  const CHECKS_DIR = `${REPO_DIR}/.agents/skills/review`;
  const GATE_DIR = `${REPO_DIR}/.agents/checks`;
  const LAYER1 =
    process.env.AUTOMATED_CHECKS_LAYER1 ||
    join(dirname(fileURLToPath(import.meta.url)), "../../implement/scripts/layer-1.ts");

  try {
    process.chdir(REPO_DIR);
  } catch {
    err(`cd: ${REPO_DIR}: No such file or directory`);
    exit(1);
  }

  if (spawnSync("git", ["rev-parse", "--verify", `${SESSION_BASE}^{commit}`], { stdio: "ignore" }).status !== 0) {
    err(`unparseable session-base: ${SESSION_BASE}`);
    exit(1);
  }

  // ── Collect changed files (committed + staged + unstaged + UNTRACKED) ────
  //
  // The `ls-files --others` read is load-bearing. None of the three `git diff`
  // forms sees a file that has never been added, so a session whose new work is
  // entirely new FILES would get "PASS: lint (0 files)", "PASS: shellcheck
  // (0 files)" — a green that had reviewed nothing. `.agents/skills/review/
  // code-review.ts` builds its diff the same way, for the same reason.
  // Each read checked: a failed git that listed nothing would have made every
  // check below report PASS over an empty change.
  let listing = "";
  let untrackedListing = "";
  for (const args of [
    ["diff", "--name-only", SESSION_BASE, "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["diff", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const g = spawnSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
    if (g.status !== 0) {
      err(`could not list the change since ${SESSION_BASE} — git failed; nothing was checked`);
      exit(1);
    }
    listing += g.stdout ?? "";
    if (args[0] === "ls-files") untrackedListing = g.stdout ?? "";
  }
  const changed_files = [...new Set(listing.split("\n").filter((l) => l !== ""))].sort();
  const untracked = untrackedListing.split("\n").filter((u) => u !== "" && isFile(u));

  const code_files: string[] = [];
  const sh_files: string[] = [];
  const present_files: string[] = [];
  for (const f of changed_files) {
    // A deleted file still selects its package for lint — deleting a file is
    // exactly when its package should be re-checked. Markdown selects none.
    if (!f.endsWith(".md")) code_files.push(f);
    if (!isFile(f)) continue;
    present_files.push(f);
    if (f.endsWith(".sh")) sh_files.push(f);
  }

  // ── Output capture (cap stderr at 10KB; overflow → /tmp/implement-audit-checks-*.log) ──
  const SESSION_TAG = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || String(process.pid);
  const OVERFLOW_LOG = `/tmp/implement-audit-checks-${SESSION_TAG}.log`;
  writeFileSync(OVERFLOW_LOG, "");

  let PASS_COUNT = 0;
  let FAIL_COUNT = 0;
  let WARN_COUNT = 0;
  const pass = (s: string): void => {
    process.stdout.write(`PASS: ${s}\n`);
    PASS_COUNT++;
  };
  const fail = (s: string): void => {
    process.stdout.write(`FAIL: ${s}\n`);
    FAIL_COUNT++;
  };
  const warn = (s: string): void => {
    process.stdout.write(`WARN: ${s}\n`);
    WARN_COUNT++;
  };
  /** A failing check's output: its first 10 KB on stderr, all of it in the log. */
  const report = (out: string, overwrite = false): void => {
    process.stderr.write(Buffer.from(`${out}\n`).subarray(0, 10240));
    if (overwrite) writeFileSync(OVERFLOW_LOG, `${out}\n`);
    else appendFileSync(OVERFLOW_LOG, `${out}\n`);
  };

  // ── Check 1: lint (and typecheck) of each touched package ────────────
  //
  // By convention, not by a config this script knows: layer-1.ts finds the
  // package that owns each file and runs its own `lint` then `typecheck`/`check`
  // script or make target. A package that declares none is a WARN line inside
  // layer-1's output, never a FAIL — a lint run on defaults the repo never
  // adopted fails valid code, and a check that cannot come back clean carries no
  // information.
  if (code_files.length === 0) {
    pass("lint (0 files)");
  } else if (!isFile(LAYER1)) {
    warn(`lint missing — no layer-1.ts at ${LAYER1}`);
  } else {
    const l = runMerged(process.execPath, ["--experimental-strip-types", LAYER1], {
      input: `${code_files.join("\n")}\n`,
      env: { CLAUDE_PROJECT_DIR: REPO_DIR },
    });
    if (l.ok) {
      // The lint line reports what layer-1 RAN, never its exit status alone. A
      // step it skipped (a package that declares no lint or typecheck, a file no
      // package owns) is not a step that passed: each is a WARN, and the change
      // is called linted only when some package's lint actually ran.
      const lines = l.out.split("\n");
      let skipped = 0;
      for (const line of lines) {
        if (!line.startsWith("WARN: layer-1 ")) continue;
        warn(line.slice("WARN: layer-1 ".length));
        skipped++;
      }
      const linted = lines.filter((line) => line.startsWith("PASS: layer-1 lint (")).length;
      if (linted > 0) {
        if (skipped === 0) pass(`lint (${code_files.length} files)`);
        else pass(`lint (${code_files.length} files, ${skipped} step(s) skipped — see the WARN lines)`);
      } else if (skipped === 0) {
        // Nothing linted and nothing skipped: only the records and prose layer-1
        // selects no package for, which it says in so many words. Anything else
        // is a layer-1 that ran no step and did not say why.
        if (lines.includes("PASS: layer-1 (no package in scope)")) pass("lint (no package in scope)");
        else warn("lint — layer-1 reported no lint step; nothing was linted");
      }
    } else {
      fail(`lint (${code_files.length} files) — see stderr`);
      report(l.out, true);
    }
  }

  // ── Check 2: shellcheck on changed .sh ──────────────────────────────
  // Bash stays in other repos and in the hook and worktree scripts, so a changed
  // .sh is still linted.
  if (sh_files.length === 0) {
    pass("shellcheck (0 files)");
  } else if (!onPath("shellcheck")) {
    warn("shellcheck missing — skip");
  } else {
    const s = runMerged("shellcheck", sh_files);
    if (s.ok) {
      pass(`shellcheck (${sh_files.length} files)`);
    } else {
      fail(`shellcheck (${sh_files.length} files) — see stderr`);
      report(s.out);
    }
  }

  // ── Check 3: standards citations in changed files ─────────────────────
  // The same script land.ts runs before it commits, over only this change's files.
  const refs_script = `${GATE_DIR}/check-standards-refs.ts`;
  if (present_files.length === 0) {
    pass("standards-refs (nothing-to-check)");
  } else if (!isFile(refs_script)) {
    warn("check-standards-refs.ts missing");
  } else {
    // The checker reads files through git, and git ignores an untracked path even
    // when it is named, so a new file's citations were never seen. A throwaway
    // copy of the index marks the untracked files intent-to-add for this one run;
    // the real index is not touched.
    const refs_idx = join(tmpdir(), `implement-audit-refs-${process.pid}.index`);
    // Each step checked: an index that did not copy, or untracked files that did
    // not mark, would hide files from the checker and read as "0 dangling".
    let refs_ready = false;
    const ip = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      if (ip.status === 0) {
        copyFileSync((ip.stdout ?? "").replace(/\n+$/, ""), refs_idx);
        refs_ready = true;
      }
    } catch {
      refs_ready = false;
    }
    if (refs_ready && untracked.length > 0) {
      const add = spawnSync("git", ["add", "-N", "--", ...untracked], {
        env: { ...process.env, GIT_INDEX_FILE: refs_idx },
        stdio: "ignore",
      });
      if (add.status !== 0) refs_ready = false;
    }
    if (!refs_ready) {
      rmSync(refs_idx, { force: true });
      fail("standards-refs — could not prepare the files for the checker (git failed)");
    } else {
      const c = runMerged(process.execPath, ["--experimental-strip-types", refs_script, ...present_files], {
        env: { GIT_INDEX_FILE: refs_idx },
      });
      rmSync(refs_idx, { force: true });
      if (c.ok) {
        pass("standards-refs (0 dangling)");
      } else {
        fail("standards-refs — see stderr");
        report(c.out);
      }
    }
  }

  // ── Check 4: find-peers.ts on changed files ──────────────────────────
  // Run with node, so it needs to be a file, not an executable one.
  const peers_script = `${CHECKS_DIR}/find-peers.ts`;
  if (changed_files.length === 0) {
    pass("find-peers (nothing-to-check)");
  } else if (!isFile(peers_script)) {
    warn("find-peers.ts missing");
  } else {
    // From the session base, as every other check here: find-peers diffs each
    // file it is handed against its base, and against HEAD a class fix the
    // session had already COMMITTED showed no removal and read as "0 left-behind".
    const p = runMerged(process.execPath, [
      "--experimental-strip-types",
      peers_script,
      "--base",
      SESSION_BASE,
      ...changed_files,
    ]);
    if (p.ok) {
      // Default mode is warn-only: it exits 0 and names each left-behind peer on
      // a `PEER:` line. Swallowing those printed a clean sweep over a class fix
      // that was not finished.
      const peerLines = p.out.split("\n").filter((l) => l.includes("PEER:"));
      if (peerLines.length > 0) {
        warn(`find-peers (${peerLines.length} left-behind) — see below`);
        process.stdout.write(`${peerLines.join("\n")}\n`);
        appendFileSync(OVERFLOW_LOG, `${p.out}\n`);
      } else {
        pass("find-peers (0 left-behind)");
      }
    } else {
      fail("find-peers — see stderr");
      report(p.out);
    }
  }

  // ── Check 5: secrets in the change ────────────────────────────────────
  //
  // The same scan land.ts runs before it commits, over the same span: everything
  // this branch changed since the session base, committed or not, plus untracked
  // files. It exists to give the same answer the close will, early — a check that
  // disagrees with the gate it previews stops being read.
  //
  // A repo with no .agents/checks (a product repo) gets the missing-tool WARN the
  // other checks use; a stock scan with some other ruleset would report what the
  // close never refuses, which is the same uninformative FAIL in a different coat.
  const secrets_script = `${GATE_DIR}/check-secrets.ts`;
  if (changed_files.length === 0) {
    pass("secrets (nothing-to-check)");
  } else if (!isFile(secrets_script)) {
    warn("check-secrets.ts missing — skip");
  } else {
    const g = runMerged(process.execPath, ["--experimental-strip-types", secrets_script, "--since", SESSION_BASE]);
    if (g.ok) {
      pass("secrets (clean)");
    } else {
      fail("secrets — see stderr");
      report(g.out);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  process.stdout.write(
    `SUMMARY: ${PASS_COUNT} PASS, ${FAIL_COUNT} FAIL${WARN_COUNT > 0 ? `, ${WARN_COUNT} WARN` : ""}\n`,
  );

  if (statSync(OVERFLOW_LOG).size > 0) {
    err(`full output captured at: ${OVERFLOW_LOG}`);
  }

  if (FAIL_COUNT !== 0) exit(1);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
