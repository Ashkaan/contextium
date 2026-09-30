#!/usr/bin/env -S node --experimental-strip-types
// find-peers.ts — catch incomplete class fixes
//
// Two jobs, one script:
//
//   1. VERIFY A DECLARED SWEEP (--verify-sweep). A class fix names the query
//      that defines its population; this re-runs the query and fails if
//      anything still matches. Run by `/implement` after a class fix and
//      quoted in report.md with its regex and pathspec (a record, not a
//      gate on any commit). This is the blocking half. It also audits
//      what the query EXCLUDES: a negative pathspec naming a whole
//      directory must not be hiding runnable source that still matches.
//
//   2. SURFACE AN UNDECLARED ONE (default mode). Warns when a token this
//      diff REMOVED still exists in a file the changed file declares as a
//      peer. Warn-only.
//
// A peer is only reported when the diff gives positive evidence it was left
// behind. Warning whenever a changed file had ANY declared peer, stale or not,
// once printed 16 warnings in a session that caught none of its five
// incomplete sweeps, so the output had stopped being read.
//
// Usage:
//   find-peers.ts                        # changed files (staged + unstaged)
//   find-peers.ts file1 file2 ...        # only the given files
//   find-peers.ts --verify-sweep <regex> [-- <pathspec>...]
//   find-peers.ts --peers <file>         # print the peers <file> declares
//
// Exit:
//   default mode   — 0 (warn-only; warnings on stderr), or 2 when a git read
//                    fails: a failed read is not "no changed files".
//   --verify-sweep — 0 when the population is clean, 1 when matches remain,
//                    2 on caller error (missing regex) or a failed git grep —
//                    an error is never read as "no surviving match".
//   --peers        — 0, one declared peer per line on stdout; 2 without a file.
//
// Boundary inputs:
//   - 0 files:          exit 0 silently
//   - 1 file:           checked; peer lookup unchanged
//   - N files:          all checked
//   - deleted file:     skipped (delete intent, no peer sweep)
//   - no removed lines: no tokens, so no warnings
//   - token re-added:   skipped (moved/reformatted, not removed)
//   - peer not on disk: skipped
//   - peer named ~/… or /…: read at that path
//   - peer also staged: skipped (it was swept)
//   - git failure:      empty via `|| true`
//   - sweep, no match:  exit 0
//   - sweep, matches:   exit 1, every match printed with file:line
//   - sweep, no regex:  exit 2 with usage
//   - sweep, no pathspec:           whole tree minus knowledge/ journal/
//                                   projects/, which are audited as below
//   - sweep, prose in a record:     not a match, exit 0
//   - exclusion names one file:     acknowledged survivor, never audited
//   - exclusion names a directory:  audited for runnable source
//   - excluded dir, prose only:     exit 0
//   - excluded dir, runnable match: exit 1, every match printed
//   - excluded path not on disk:    no candidates, exit 0
//
// The three frontmatter readers are the three functions below; `[[:space:]]`
// is spelled `[\t\n\v\f\r ]` so a header's whitespace means what it means
// to awk.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";

interface GitResult {
  status: number;
  stdout: string;
}

// git's stderr reaches the caller as it did from bash's `$(git …)`; its stdout
// is the answer, with the trailing newlines `$(…)` strips.
function git(args: string[]): GitResult {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  return { status: r.status ?? 128, stdout: (r.stdout ?? "").replace(/\n+$/, "") };
}

// A git read that FAILS is not an empty one. Swallowed, a broken repo, a
// missing HEAD or a bad pathspec reads as "no changed files" or "no surviving
// match" — a clean gate over nothing. Every read below checks its exit and
// stops here instead. `git grep` exits 1 for "no match", which is a real
// answer; 2 and up is an error.
function gitFailed(what: string, code: number): never {
  process.stderr.write(
    `find-peers: git ${what} failed (exit ${code}) — refusing to read the failure as a clean result\n`,
  );
  exit(2);
}

const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The lines a reader walks, as awk sees them: no phantom empty last line. */
function fileLines(file: string): string[] | null {
  let text: string;
  try {
    if (!statSync(file).isFile()) return null;
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** `gsub(/^["']|["']$/, "", s)` — one quote off each end. */
const unquote = (s: string): string => s.replace(/^["']|["']$/g, "");
/** `gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)`. */
const trimSpace = (s: string): string => s.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");

// Read `peers:` frontmatter field from a file. Supports three YAML forms:
//   peers: [path1, path2, path3]
//   peers:
//     - path1
//     - path2
//   metadata:
//     peers: "path1 path2"        # skills: the Agent Skills spec allows no
//                                 # top-level peers key
// Returns one path per entry. Empty if no frontmatter or no `peers:`.
function readFrontmatterPeers(file: string): string[] {
  const lines = fileLines(file);
  if (!lines) return [];
  const out: string[] = [];
  let inFm = false;
  let inPeers = false;
  let inMetadata = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i === 0 && line === "---") {
      inFm = true;
      continue;
    }
    if (inFm && line === "---") break;
    if (!inFm) continue;
    // Nested form: metadata:\n  peers: "a b" — one scalar, split on spaces.
    if (/^metadata:[\t\n\v\f\r ]*$/.test(line)) {
      inMetadata = true;
      inPeers = false;
      continue;
    }
    if (inMetadata) {
      if (/^[\t\n\v\f\r ]+peers:/.test(line)) {
        const val = unquote(trimSpace(line.replace(/^[\t\n\v\f\r ]+peers:[\t\n\v\f\r ]*/, "")));
        for (const p of val.split(/[\t\n\v\f\r ]+/)) if (p !== "") out.push(p);
        continue;
      }
      if (/^[\t\n\v\f\r ]/.test(line)) continue;
      inMetadata = false;
    }
    // Inline array form: peers: [a, b, c]
    if (/^peers:[\t\n\v\f\r ]*\[[^\]]*\]/.test(line)) {
      const inner = line.replace(/^peers:[\t\n\v\f\r ]*\[/, "").replace(/\].*$/, "");
      for (const part of inner.split(/[\t\n\v\f\r ]*,[\t\n\v\f\r ]*/)) {
        const p = unquote(trimSpace(part));
        if (p !== "") out.push(p);
      }
      inPeers = false;
      continue;
    }
    // Block form: peers:\n  - path
    if (/^peers:[\t\n\v\f\r ]*$/.test(line)) {
      inPeers = true;
      continue;
    }
    if (inPeers) {
      if (/^[\t\n\v\f\r ]+-[\t\n\v\f\r ]+./.test(line)) {
        const item = unquote(trimSpace(line.replace(/^[\t\n\v\f\r ]+-[\t\n\v\f\r ]+/, "")));
        if (item !== "") out.push(item);
        continue;
      }
      // Left the block (dedented or sibling key) — stop reading peers
      inPeers = false;
    }
  }
  return out;
}

// Read `peers:` from a script's leading comment block, where `marker` is the
// comment leader: `#` for shell (a shell script cannot carry YAML `---`
// frontmatter, the shebang must be on line 1) and `//` for TS/JS (frontmatter
// would be a parse error). Scans only the first 30 lines (headers are short by
// convention). One function where the bash had two awk programs that differed
// only in that leader.
//
// Supported forms:
//   // peers: apps/shared/x.ts, apps/shared/y.ts     (single-line, comma-sep)
//   // peers: apps/shared/x.ts                       (single path)
//   // peers:                                        (block form)
//   //   - apps/shared/x.ts
//   //   - apps/shared/y.ts
//
// Returns one path per entry. Empty if no `peers:` declaration found.
function readCommentPeers(file: string, marker: "#" | "//"): string[] {
  const lines = fileLines(file);
  if (!lines) return [];
  const m = marker === "#" ? "#" : "\\/\\/";
  const S = "[\\t\\n\\v\\f\\r ]";
  const single = new RegExp(`^${S}*${m}${S}*peers:${S}*.`);
  const singlePrefix = new RegExp(`^${S}*${m}${S}*peers:${S}*`);
  const opener = new RegExp(`^${S}*${m}${S}*peers:${S}*$`);
  const item = new RegExp(`^${S}*${m}${S}+-${S}+.`);
  const itemPrefix = new RegExp(`^${S}*${m}${S}+-${S}+`);
  const out: string[] = [];
  let inPeers = false;
  for (const line of lines.slice(0, 30)) {
    // Single-line form: // peers: a, b, c
    if (single.test(line)) {
      // Strip leading [ and trailing ] if present
      const rhs = line.replace(singlePrefix, "").replace(/^\[|\][\t\n\v\f\r ]*$/g, "");
      for (const part of rhs.split(/[\t\n\v\f\r ]*,[\t\n\v\f\r ]*/)) {
        const p = unquote(trimSpace(part));
        if (p !== "") out.push(p);
      }
      inPeers = false;
      continue;
    }
    // Block form opener: // peers:
    if (opener.test(line)) {
      inPeers = true;
      continue;
    }
    if (inPeers) {
      // Block continuation: //   - path
      if (item.test(line)) {
        const p = unquote(trimSpace(line.replace(itemPrefix, "")));
        if (p !== "") out.push(p);
        continue;
      }
      // Left the block — stop
      inPeers = false;
    }
  }
  return out;
}

/** Every peer path a file (read at `absPath`) declares, by whichever syntax its type uses. */
function declaredPeersAt(absPath: string): string[] {
  const out = readFrontmatterPeers(absPath);
  if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(absPath)) out.push(...readCommentPeers(absPath, "//"));
  else if (/\.(sh|bash)$/.test(absPath)) out.push(...readCommentPeers(absPath, "#"));
  return out;
}

/** `sort -u`, in the C.UTF-8 order the shell sorted in. */
const sortUnique = (xs: string[]): string[] => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// Tokens this diff took OUT of a file and did not put back.
//
// The 8-char floor plus the required separator is what keeps this from
// becoming the noise generator it replaces: bare short words (`const`, a
// renamed loop variable) are never distinctive enough to mean anything in
// another file, while the things that actually get left behind — a dotted
// access path, a schema name, a file path, a slug — all clear it.
//
// A token still present in the additions was moved or reformatted, not
// removed, so it is dropped before any peer is searched.
// The diff is read by the CALLER and handed in, so a failed read stops the
// program there rather than reading as an empty diff here.
function removedTokens(diffOut: string): string[] {
  if (diffOut === "") return [];
  const lines = diffOut.split("\n");
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
  if (removed.length === 0) return [];
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  const candidates: string[] = [];
  for (const line of removed) {
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*[._/-][A-Za-z0-9_./-]*/g)) {
      if (m[0].length >= 8) candidates.push(m[0]);
    }
  }
  return sortUnique(candidates).filter((tok) => !(added !== "" && added.includes(tok)));
}

function verifySweep(REPO_ROOT: string, rest: string[]): never {
  const args = [...rest];
  const sweepRegex = args[0] ?? "";
  if (args.length > 0) args.shift();
  if (args[0] === "--") args.shift();

  if (sweepRegex === "") {
    err("find-peers: --verify-sweep needs a regex");
    err("  usage: find-peers.ts --verify-sweep <regex> [-- <pathspec>...]");
    exit(2);
  }

  if (args.length === 0) args.push(REPO_ROOT);
  const pathspec = args.join(" ");

  // The records (knowledge/, journal/, projects/) live in this tree. A
  // journal entry quoting the retired pattern is prose about
  // the sweep, not an instance it missed, so the three are out of every
  // population whether or not the trailer names them — and audited below
  // exactly like a declared exclusion, so runnable source under projects/
  // cannot hide behind the default either.
  const recordExcludes = [":!knowledge", ":!journal", ":!projects/**/*.md"];

  const sweep = git(["grep", "-nE", "-e", sweepRegex, "--", ...args, ...recordExcludes]);
  if (sweep.status > 1) gitFailed("grep", sweep.status);

  if (sweep.stdout !== "") {
    err("");
    err("CLASS-SWEEP INCOMPLETE: the declared population still has matches.");
    err("");
    err(`  pattern:  ${sweepRegex}`);
    err(`  pathspec: ${pathspec}`);
    err("");
    for (const l of sweep.stdout.split("\n")) err(`  ${l}`);
    err("");
    err("Every line above is an instance the sweep claimed to have closed.");
    err("Fix them, or exclude a deliberate survivor with a negative");
    err("pathspec (:!path/to/keep) so the exception is explicit.");
    err("");
    err("A class fix lands in every instance in the same session.");
    exit(1);
  }

  // ── The exclusion audit ────────────────────────────────────────────────
  //
  // Everything above re-runs the query AS DECLARED, which makes a negative
  // pathspec naming a whole DIRECTORY a blind spot: the gate that exists to
  // verify the sweep cannot see anything inside it.
  //
  // A sweep that excluded `:!projects` as historical prose once left an
  // executable script under projects/ still mirroring the file the commit
  // deleted. The machine reviewer found it; this gate passed.
  //
  // So every exclusion that is NOT a single named file is re-grepped for the
  // same regex, restricted to executable source. Prose stays excludable by
  // directory; a code survivor stays legal but has to be named as its own
  // file-level exclusion, which is the exception-on-the-record that
  // a class fix asks for. The two coexist:
  // `:!projects :!projects/x/scripts/scan.js` excludes the tree AND
  // acknowledges the one runnable file inside it.

  const broadExcludes: string[] = [];
  const fileExcludes: string[] = [];
  for (const spec of [...args, ...recordExcludes]) {
    let bare: string;
    if (spec.startsWith(":!")) bare = spec.slice(2);
    else if (spec.startsWith(":^")) bare = spec.slice(2);
    else if (spec.startsWith(":(exclude)")) bare = spec.slice(":(exclude)".length);
    else continue;
    if (bare === "") continue;
    if (broadExcludes.includes(bare)) continue; // the trailer named a record tree itself
    let isFile = false;
    try {
      isFile = statSync(`${REPO_ROOT}/${bare}`).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      // A single file named in the trailer IS the recorded exception.
      fileExcludes.push(`:!${bare}`);
    } else {
      broadExcludes.push(bare);
    }
  }

  // Executable source only. A .md, .json or .yaml inside an excluded tree is
  // the prose the exclusion is legitimately for; a file that RUNS is not.
  // Filtering the OUTPUT by extension rather than narrowing the pathspec
  // keeps this out of git's glob semantics, where `dir/*.ts` crossing `/`
  // is a behaviour to depend on rather than a thing to read.
  const runnableRe = /^[^:]+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|py|rb):/;

  let hidden = "";
  for (const bare of broadExcludes) {
    const hits = git(["grep", "-nE", "-e", sweepRegex, "--", bare, ...fileExcludes]);
    if (hits.status > 1) gitFailed("grep", hits.status);
    if (hits.stdout === "") continue;
    const runnable = hits.stdout.split("\n").filter((l) => runnableRe.test(l));
    if (runnable.length === 0) continue;
    hidden += `(excluded by :!${bare})\n${runnable.join("\n")}\n`;
  }

  if (hidden !== "") {
    err("");
    err("CLASS-SWEEP EXCLUSION HIDES RUNNABLE CODE.");
    err("");
    err(`  pattern:  ${sweepRegex}`);
    err(`  pathspec: ${pathspec}`);
    err("");
    for (const l of hidden.replace(/\n$/, "").split("\n")) err(`  ${l}`);
    err("");
    err("The sweep passed only because these paths were excluded.");
    err("Every file above RUNS, so it is a peer of this class fix,");
    err("not the historical prose the exclusion was written for.");
    err("");
    err("Fix them, or — if a match is deliberate — keep the directory");
    err("exclusion and add the file by name beside it, so the survivor");
    err("is on the record instead of hidden by the tree it sits in:");
    err("");
    err("  find-peers.ts --verify-sweep <regex> -- . :!<dir> :!<dir>/path/to/that/file.ts");
    err("");
    err("A class fix lands in every instance in the same session.");
    exit(1);
  }
  exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) exit(top.status);
  const REPO_ROOT = top.stdout;
  process.chdir(REPO_ROOT);

  // ── Mode 1: verify a declared sweep ────────────────────────────────────
  //
  // The trailer carries a PATTERN and a PATHSPEC, never a shell command, so
  // nothing arbitrary from a commit message is executed. A deliberate
  // survivor is excluded via a negative pathspec (`:!path`), which forces
  // exceptions to be written down instead of silently tolerated.
  if (argv[0] === "--verify-sweep") verifySweep(REPO_ROOT, argv.slice(1));

  // ── The reader on its own: --peers <file> ──────────────────────────────
  //
  // What a file declares, by whichever syntax its type uses. This is the
  // lookup mode 2 runs per changed file; exposed so a caller (or a test) can
  // ask it directly instead of staging a removal to observe it.
  if (argv[0] === "--peers") {
    if (!argv[1]) {
      err("find-peers: --peers needs a file");
      exit(2);
    }
    // An absolute path is read where it is (some peers: lines spell a file in
    // another checkout that way). Declaration order is kept; only repeats are dropped.
    const peersFile = argv[1].startsWith("/") ? argv[1] : `${REPO_ROOT}/${argv[1]}`;
    const seen = new Set<string>();
    for (const p of declaredPeersAt(peersFile)) {
      if (seen.has(p)) continue;
      seen.add(p);
      process.stdout.write(`${p}\n`);
    }
    exit(0);
  }

  // ── Mode 2: surface an undeclared one ──────────────────────────────────

  let changed: string[];
  if (argv.length > 0) {
    changed = argv;
  } else {
    const diff = git(["diff", "--name-only", "HEAD"]);
    if (diff.status !== 0) gitFailed("diff", diff.status);
    changed = diff.stdout.split("\n").filter((l) => l !== "");
  }

  if (changed.length === 0) exit(0);

  const changedSet = new Set(changed);

  let warnCount = 0;
  const warn = (msg: string): void => {
    err(`  PEER: ${msg}`);
    warnCount++;
  };

  const HOME = process.env.HOME ?? "";

  for (const file of changed) {
    // Skip deleted files — a peer sweep only applies to adds/edits.
    if (!existsSync(`${REPO_ROOT}/${file}`)) continue;

    const filePeers = sortUnique(declaredPeersAt(`${REPO_ROOT}/${file}`));
    if (filePeers.length === 0) continue;

    // Only peers that exist and were NOT themselves changed can be left behind.
    // A peer is repo-relative unless it names a home path (`~/…`, the form
    // skills use for their own scripts and references) or is absolute; those
    // are read where they are and can never be "changed in this diff".
    const livePeers: string[] = [];
    const livePaths: string[] = [];
    for (const peer of filePeers) {
      if (peer === "") continue;
      let peerPath: string;
      if (peer.startsWith("~/")) peerPath = `${HOME}/${peer.slice(2)}`;
      else if (peer.startsWith("/")) peerPath = peer;
      else peerPath = `${REPO_ROOT}/${peer}`;
      if (!existsSync(peerPath)) continue;
      // A path that resolves inside this repo is looked up by its repo-relative
      // name, which is how the diff names it.
      const peerKey = peerPath.startsWith(`${REPO_ROOT}/`) ? peerPath.slice(REPO_ROOT.length + 1) : peer;
      if (changedSet.has(peerKey)) continue;
      livePeers.push(peer);
      livePaths.push(peerPath);
    }
    if (livePeers.length === 0) continue;

    const fileDiff = git(["diff", "-U0", "HEAD", "--", file]);
    if (fileDiff.status !== 0) gitFailed("diff", fileDiff.status);

    for (const token of removedTokens(fileDiff.stdout)) {
      livePeers.forEach((peer, i) => {
        let body: string;
        try {
          body = readFileSync(livePaths[i] ?? "", "utf8");
        } catch {
          return;
        }
        if (body.includes(token)) warn(`${peer} still has '${token}', which ${file} just removed`);
      });
    }
  }

  if (warnCount > 0) {
    err(`⚠ ${warnCount} peer(s) may be mid-sweep — see the tokens above`);
    err("  If this IS a class fix, verify the sweep and quote it in report.md:");
    err("  find-peers.ts --verify-sweep <regex> -- <pathspec>  ");
  }

  exit(0);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
