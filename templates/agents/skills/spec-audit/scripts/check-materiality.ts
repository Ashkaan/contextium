#!/usr/bin/env -S node --experimental-strip-types
// check-materiality.ts
//
// Determine whether a SPEC change is material (triggers /spec-audit) or
// non-material (skip with non-material trailer). Deterministic — no AI judgment.
//
// Material triggers (any one fires):
//   - New section added or removed
//   - § 1 Behavior contract changed
//   - § 2 Input contract changed (trigger, params, credentials)
//   - § 3 Output contract changed (KV keys, file paths, SLAs)
//   - § 4 Boundary cases added/removed/changed
//   - § 5 Acceptance command changed
//   - § 7 Data-reliability checklist changed
//   - § 8 Failure modes added/removed/changed
//   - § 9 AI Eval Plan added/removed/changed
//   - ai_judgment_features: frontmatter changed
//
// NOT material: typo fixes, wording polish, link updates, formatting,
// section reorder without content change, clarification edits.
//
// A SPEC FOLDER (`specs/NNN-name/`, the spec-kit layout) is
// accepted wherever a file is. Its triggers are the spec-kit heading names, found
// by walking each changed line back to the heading above it in that version of
// the file — hunk-header context cannot be used, because git's default funcname
// never matches a `#` heading:
//   - a heading added or removed in any file
//   - spec.md: the `**Input**` line, or anything under Clarifications (the
//     grill's decision ledger — a changed decision changes the design), User
//     Scenarios & Testing, User Story, Edge Cases, Requirements, Functional
//     Requirements, Key Entities, Success Criteria, Measurable Outcomes,
//     Acceptance
//   - plan.md: Simplest shape, Technical Context, Data sourcing, Failure modes,
//     Validation Commands
//   - tasks.md: a task line (`- [ ] T…`) added or removed
//   - a file in the folder that git-ref does not have (new or untracked)
//   - more than 5 substantive changed lines in total
// Assumptions, research.md and prose elsewhere are not triggers.
//
// Usage:
//   check-materiality.ts <spec-path | spec-folder> [<git-ref>]
//
// <git-ref> defaults to HEAD (compares staged or working-tree state vs HEAD).
// For a new file not in HEAD, the result is always "material:new-file".
//
// Output (one line to stdout):
//   material:<reason>      → caller MUST run the full /spec-audit protocol
//   non-material:<reason>  → caller MAY skip; emits skipped trailer
//
// Exit code: 0 — caller parses stdout; 1 only when a git read failed, with
// `material:git-read-failed` on stdout so the audit still runs (and when no
// spec path is given).
//
// peers:
//   .agents/skills/spec-audit/scripts/check-materiality.test.ts
//   .agents/skills/spec/references/templates/  (the headings named above)

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** `git` from PATH (a test puts a failing one first), stderr passed through
 *  unless `quiet` — the bash original's `2>&1`-less calls. */
function git(args: string[], quiet = false): { status: number; stdout: string } {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "" };
}

/** `$(…)`: trailing newlines dropped. */
const chomp = (s: string): string => s.replace(/\n+$/, "");

/**
 * A git read that FAILS is not an empty one. Swallowed, a failed diff reads as
 * "no-change" and a failed ls-tree as "new-file" or "nothing removed" — each a
 * verdict about a spec nobody compared. So a failed read is said on stderr and
 * answered `material:git-read-failed` with exit 1: the audit runs rather than
 * being skipped on a read that never happened. "Did git-ref have this file?"
 * is asked of `git ls-tree` (empty output = absent, a real answer), never of a
 * failing `git show`, so a git error can no longer pose as "new file".
 */
function gitReadFailed(sub: string, code: number): never {
  process.stderr.write(
    `check-materiality: git ${sub} failed (exit ${code}) — auditing rather than trusting an empty read\n`,
  );
  process.stdout.write("material:git-read-failed\n");
  exit(1);
}

function say(verdict: string): never {
  process.stdout.write(`${verdict}\n`);
  exit(0);
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Lines of a file as awk's getline reads them. */
function fileLines(text: string): string[] {
  if (text === "") return [];
  const l = text.split("\n");
  if (text.endsWith("\n")) l.pop();
  return l;
}

/**
 * Walk a `-U0` diff and print, for each changed line, what `heads` recorded at
 * that line — git-ref's version for a removed line, the working file's for an
 * added one. Lines past the end print as empty, as awk's unset array entries do.
 * A line starting `---`/`+++` is skipped by shape, as the awk did.
 */
function walkDiff(diff: string, oldHeads: string[], newHeads: string[]): string[] {
  const out: string[] = [];
  let ol = 0;
  let nl = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const f = line.trim().split(/[ \t]+/);
      ol = Number.parseInt((f[1] ?? "").split(",")[0]?.slice(1) ?? "", 10) || 0;
      nl = Number.parseInt((f[2] ?? "").split(",")[0]?.slice(1) ?? "", 10) || 0;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("-")) {
      out.push(...(oldHeads[ol - 1] ?? "").split("\n"));
      ol++;
    } else if (line.startsWith("+")) {
      out.push(...(newHeads[nl - 1] ?? "").split("\n"));
      nl++;
    }
  }
  return out;
}

/** Per line: the nearest heading's text and its enclosing `##` section's text. */
function folderHeads(text: string): string[] {
  let h = "";
  let h2 = "";
  return fileLines(text).map((l) => {
    if (/^#+ /.test(l)) {
      h = l.replace(/^#+ +/, "");
      if (l.startsWith("## ")) h2 = h;
    }
    return `${h}\n${h2}`;
  });
}

/** Per line: the enclosing `## ` heading line, fenced code skipped. */
function legacyHeads(text: string): string[] {
  let h2 = "";
  let fence = false;
  return fileLines(text).map((l) => {
    if (l.startsWith("```")) fence = !fence;
    else if (!fence && l.startsWith("## ")) h2 = l;
    return h2;
  });
}

/** Changed lines with content — the marker is the FIRST character only. */
function substantive(diff: string): number {
  return diff
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l) && /^[+-][ \t\n\v\f\r]*[^ \t\n\v\f\r]/.test(l)).length;
}

const anyLine = (text: string, re: RegExp): boolean => text.split("\n").some((l) => re.test(l));

async function main(): Promise<void> {
  const SPEC_PATH = process.argv[2] ?? "";
  if (SPEC_PATH === "") {
    process.stderr.write(`${process.argv[1]}: 1: spec path required\n`);
    exit(1);
  }
  const GIT_REF = process.argv[3] || "HEAD";

  // The ref itself resolves, or the repo has no commits yet (an unborn HEAD, where
  // every file is new). "Unborn" is claimed only when the repo is readable and
  // HEAD is merely missing: `rev-parse --verify -q HEAD` exits 1 for a missing
  // ref and 128 for an error, and only the 1 counts. Anything else is a failed
  // read.
  let UNBORN = false;
  const rc = git(["rev-parse", "--verify", "--quiet", `${GIT_REF}^{tree}`]).status;
  if (rc !== 0) {
    const gdRc = git(["rev-parse", "--git-dir"], true).status;
    const headRc = git(["rev-parse", "--verify", "--quiet", "HEAD"], true).status;
    if (GIT_REF === "HEAD" && gdRc === 0 && headRc === 1 && git(["symbolic-ref", "-q", "HEAD"]).status === 0) {
      UNBORN = true;
    } else {
      gitReadFailed("rev-parse", rc);
    }
  }
  /** true when git-ref has <path>, false when it does not; a git error stops. */
  const atRef = (path: string): boolean => {
    if (UNBORN) return false;
    const r = git(["ls-tree", "--name-only", GIT_REF, "--", path]);
    if (r.status !== 0) gitReadFailed("ls-tree", r.status);
    return chomp(r.stdout) !== "";
  };
  /** The version git-ref has; a failure stops. */
  const showAtRef = (path: string): string => {
    const r = git(["show", `${GIT_REF}:${path}`]);
    if (r.status !== 0) gitReadFailed("show", r.status);
    return r.stdout;
  };
  const lsTreeR = (path: string): string => {
    const r = git(["ls-tree", "-r", "--name-only", GIT_REF, "--", path]);
    if (r.status !== 0) gitReadFailed("ls-tree", r.status);
    return chomp(r.stdout);
  };
  const diff = (path: string, u0: boolean): string => {
    const r = git(u0 ? ["diff", "-U0", GIT_REF, "--", path] : ["diff", GIT_REF, "--", path]);
    if (r.status !== 0) gitReadFailed("diff", r.status);
    return chomp(r.stdout);
  };
  const trimSlash = (p: string): string => (p.endsWith("/") ? p.slice(0, -1) : p);

  // A spec folder OR single-file SPEC git-ref has and the working tree does not:
  // the whole spec was deleted, which is the most material change there is. The
  // lookup is the exact path — `ls-tree <ref> -- <path>` names a file or a folder
  // alike — never `<path>/`, which matches only a folder, so a deleted
  // single-file SPEC read as `non-material:spec-file-missing` and skipped review.
  if (!existsSync(SPEC_PATH) && atRef(trimSlash(SPEC_PATH))) say("material:file-removed");

  if (isDir(SPEC_PATH)) {
    const FOLDER = trimSlash(SPEC_PATH);
    // Anything git-ref lacks — a new folder, or a new file in an old one.
    const TREE_FILES = UNBORN ? "" : lsTreeR(FOLDER);
    const lf = git(["ls-files", "--others", "--exclude-standard", "--", FOLDER]);
    if (lf.status !== 0) gitReadFailed("ls-files", lf.status);
    if (TREE_FILES === "" || chomp(lf.stdout) !== "") say("material:new-file");
    let names: string[];
    try {
      names = readdirSync(FOLDER)
        .filter((n) => n.endsWith(".md") && !n.startsWith("."))
        .sort();
    } catch {
      names = [];
    }
    const mdFiles = names.map((n) => `${FOLDER}/${n}`).filter(isFile);
    for (const f of mdFiles) {
      if (!atRef(f)) say("material:new-file");
    }
    // A file git-ref has and the folder no longer does — deleting spec.md must
    // not read as no change.
    for (const f of TREE_FILES.split("\n")) {
      if (f !== "" && !existsSync(f)) say("material:file-removed");
    }
    const MATERIAL_SPEC =
      /^(Clarifications|User Scenarios & Testing|User Story|Edge Cases|Requirements|Functional Requirements|Key Entities|Success Criteria|Measurable Outcomes|Acceptance)/;
    const MATERIAL_PLAN = /^(Simplest shape|Technical Context|Data sourcing|Failure modes|Validation Commands)/;
    let TOTAL = 0;
    let ANY = false;
    for (const f of mdFiles) {
      const D = diff(f, true);
      if (D === "") continue;
      ANY = true;
      if (anyLine(D, /^[+-]#{1,6} /)) say("material:section-changed");
      TOTAL += substantive(D);
      const base = f.slice(f.lastIndexOf("/") + 1);
      if (base === "tasks.md" && anyLine(D, /^[+-][ \t\n\v\f\r]*- \[[ xX]\] T[0-9]/))
        say("material:task-lines-changed");
      if (base === "spec.md" && anyLine(D, /^[+-]\*\*Input\*\*/)) say("material:input-changed");
      const want = base === "spec.md" ? MATERIAL_SPEC : base === "plan.md" ? MATERIAL_PLAN : null;
      if (!want) continue;
      // The headings above each changed line, in the version the line lives in:
      // the working file for an added line, git-ref's for a removed one. BOTH the
      // nearest heading and its enclosing `##` section are printed, so a change
      // under any sub-heading of Requirements or User Scenarios counts.
      const oldText = showAtRef(f);
      const HEADS = walkDiff(D, folderHeads(oldText), folderHeads(readFileSync(f, "utf8")));
      if (HEADS.some((l) => want.test(l))) say("material:numbered-section-changed");
    }
    if (!ANY) say("non-material:no-change");
    if (TOTAL > 5) say(`material:substantive-changes-${TOTAL}-lines`);
    say(`non-material:minor-text-edit-${TOTAL}-lines`);
  }

  if (!isFile(SPEC_PATH)) say("non-material:spec-file-missing");

  // New file (no version in git-ref) → always material
  if (!atRef(SPEC_PATH)) say("material:new-file");

  // Compute the diff (staged or working-tree vs git-ref)
  const DIFF = diff(SPEC_PATH, false);
  if (DIFF === "") say("non-material:no-change");

  // Material trigger 1: new section added or removed (# ## ### headings)
  if (anyLine(DIFF, /^[+-]##? /)) say("material:section-changed");

  // Material trigger 2-9: changes within numbered sections (§ 1 - § 9), read off
  // the unified-diff hunk headers (@@ ... @@), which sometimes carry the
  // surrounding context.
  if (
    anyLine(
      DIFF,
      /@@.*##? (1\.|1 |Behavior|2\.|2 |Input|3\.|3 |Output|4\.|4 |Boundary|5\.|5 |Acceptance|7\.|7 |Data.reliability|8\.|8 |Failure|9\.|9 |AI Eval)/,
    )
  ) {
    say("material:numbered-section-changed");
  }

  // The same triggers, found the way the folder branch finds them: hunk headers
  // never name a `#` heading for markdown (git has no funcname rule for it), so
  // the check above almost never fires. Walk each changed line back to its `##`
  // section, in the version the line lives in (git-ref's for a removed line, the
  // working file's for an added one). Fenced code is skipped, so a `# comment`
  // inside an acceptance command cannot pose as a heading.
  const oldText = showAtRef(SPEC_PATH);
  const LEGACY_DIFF = diff(SPEC_PATH, true);
  const LEGACY_HEADS = walkDiff(LEGACY_DIFF, legacyHeads(oldText), legacyHeads(readFileSync(SPEC_PATH, "utf8")));
  // Case-insensitive: legacy SPECs write `§ 10 — AI eval plan` as often as
  // `9. AI Eval Plan`, and `Data-reliability` in either case. Contextium adds
  // the lean spec's Files and Done sections.
  if (
    LEGACY_HEADS.some((l) =>
      /(Behavior|Input|Output|Boundar|Acceptance|Data.reliability|Failure|AI eval|Files|Done)/i.test(l),
    )
  ) {
    say("material:numbered-section-changed");
  }

  // Material trigger 10: ai_judgment_features: frontmatter changed
  if (anyLine(DIFF, /^[+-].*ai_judgment_features:/)) say("material:ai-judgment-features-changed");

  // Material trigger 11 (catch-all): substantive content lines (not whitespace, not comments)
  // changed but no specific trigger matched. Defer to author judgment.
  //
  // The marker is the FIRST character and only the first. This used to be
  // `^[+-][^+-]`, which silently dropped every added Markdown BULLET — an added
  // "- A row is retired only when…" reaches the diff as "+- A row is…", the second
  // character is a "-", and the line was not counted. SPEC section 1 is written
  // almost entirely in bullets, so a six-bullet behavior-contract amendment counted
  // as one changed line and the gate returned non-material — a real narrowing of
  // the behavior contract would have skipped review entirely. File headers
  // (+++ / ---) are excluded by name rather than by shape, and whitespace-only
  // changes still do not count.
  const SUBSTANTIVE_CHANGES = substantive(DIFF);
  if (SUBSTANTIVE_CHANGES > 5) say(`material:substantive-changes-${SUBSTANTIVE_CHANGES}-lines`);

  // Default: small textual change, no specific trigger → non-material
  say(`non-material:minor-text-edit-${SUBSTANTIVE_CHANGES}-lines`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
