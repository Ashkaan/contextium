#!/usr/bin/env -S node --experimental-strip-types
// check-journal-entry.ts — refuse a journal session entry that does not follow
// close/references/journal-entry.md: front matter a reader cannot parse
// (F1–F5), and a body outside the schema (F6–F8).
//
// Usage:
//   check-journal-entry.ts [session-files...]
//   # no args: scan all staged journal/YYYY-MM-DD/*.md files via git diff --cached
//
// Exit: 0 if clean, 1 on any violation, and 1 when the staged files cannot be
// read (a failed read is never "nothing staged").
//
// It is only ever handed THIS thread's own entry — by `journal-file.ts --check`
// during /close § 3 and by `land.ts` before the commit — so entries written
// before a schema change are never re-read; a schema change applies to new
// entries only.
//
// WHY THIS EXISTS
//
// A day kept as ONE SHARED FILE, `journal/<date>.md`, with every session that
// closed that day appending its own `- slug:` entry to one `sessions:` list, is
// written by concurrent sessions from different worktrees, and git resolves
// their adjacent insertions WITHOUT a conflict. The result parses as valid
// markdown and valid-looking YAML, so nothing downstream complains — a reader
// just reads less than was written:
//
//   A front-matter parser reads only the FIRST `---` block. A second `---` /
//   `date:` / `tags:` / `sessions:` / `---` fragment appended further down the
//   file is dropped whole, taking that session with it.
//
//   A sessions-list parser opens a new session on every `- slug:` and attaches
//   each following indented `key: value` to whichever slug it saw last. A
//   `- slug:` inserted between another session's slug and its fields silently
//   re-parents those fields; the duplicate key that results just overwrites.
//
// Neither failure raises anything at the time. It surfaces later as a report
// built from the journal that under-counts, which is indistinguishable from a
// quiet week.
//
// A day is a FOLDER and a session is its own file, so the concurrency that
// caused both modes cannot recur — two sessions closing in the same minute take
// different filenames, and neither one opens the other's file. The checks stay
// for what survives: a `0000-day.md` may still carry a `sessions:` list, a hand
// edit can still duplicate a column-0 key, and F5 below keys a file to its own
// `slug:`, so a file whose first heading disagrees with its front matter would
// file its record under a session that does not exist.
//
// CHECKS
//   F1 — exactly one frontmatter block: one `date:` and at most one `sessions:`
//        at column 0 in the whole file. A second of either means a concurrent
//        session's block landed mid-file and no reader will ever see it.
//   F2 — no duplicate field key inside a single `- slug:` entry. This is the
//        fingerprint of a foreign `- slug:` splitting an entry in two.
//   F3 — no session field before the first `- slug:` in the `sessions:` block,
//        which is the same split seen from the orphaned end.
//   F5 — a session file's `slug:` matches its first body heading. Skipped for
//        every `0000-*.md`, which belongs to the DAY rather than to a session:
//        `0000-day.md` (the day's own prose) and any daily record a loop keeps.
//        None is a session, so none carries a slug a reader should count.
//   F4 — no duplicate key at column 0 inside the frontmatter block. YAML is
//        last-wins, so a second `tags:` discards the first line's tags outright:
//        nothing errors, the day just indexes under a subset of its own topics.
//        F1 sees this only when the duplicate is `date:` or `sessions:`, and
//        then reports it as a second frontmatter block — the wrong diagnosis
//        when both keys sit in ONE block.
//   F6 — every column-0 `**Label:**` in the body is one of the eight sections.
//        `**Next:**` and `**Issues:**` are retired: outstanding work is the
//        project's ROADMAP.md, and an investigation's results are Findings.
//   F7 — a `**Decisions:**` bullet is a link and nothing else, or one
//        `rejected:` line of at most 500 characters. Decision prose in a journal
//        restates reasoning that lives in a spec, a report or a decisions/
//        record; the entry links those. The `rejected:` line keeps its
//        reasoning because it IS the record of what was turned down, read by a
//        grep for that prefix.
//   F8 — `root_cause_status:` is one of its four values. A value outside them
//        splits one meaning across several buckets for anything counting them.
//   F6–F8 skip `0000-*.md`, as F5 does, and skip lines inside a ``` or ~~~
//   fence — an entry quoting an old entry is not writing a section.
//
// Schema SSOT is close/references/journal-entry.md. The two lists below are
// copies of its § Section set and § Field reference, because the check does not
// parse a markdown table at every close; check-journal-entry.test.ts
// asserts the copies match the file, so the file stays the definition. For the
// front matter this check validates STRUCTURE only — that each entry's fields
// belong to the slug above them — never the field names, so it does not have
// to move when the schema gains a field.
//
// Runs from close/scripts/land.ts before each commit of the records worktree
// and from journal-file.ts --check during /close § 3.

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

// Copies of close/references/journal-entry.md § Section set and § Field
// reference; the test fails when either drifts from the file.
const SECTION_LABELS = "Action|Changes|Findings|Decisions|Corrections|Lessons|Blocked|Root-Cause Status";
const ROOT_CAUSE_VALUES = "fixed|unknown-pending-verification|deferred-by-user-directive|n/a";

// awk's and grep's [[:space:]] in the C locale.
const SP = "[ \\t\\n\\v\\f\\r]";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The file as awk and grep see it: one entry per line, a final newline ending
 *  the last line rather than opening an empty one. */
function linesOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// The value of a front-matter key, as the awk one-liners read it: only inside
// a block the FIRST line opens, the first match wins, and a double-quoted value
// is compared by what the quotes contain.
function frontMatterValue(lines: string[], key: string, unescape: boolean): { line: number; value: string } | null {
  if (lines[0] !== "---") return null;
  const head = new RegExp(`^${key}:${SP}`);
  const strip = new RegExp(`^${key}:${SP}*`);
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === "---") return null;
    if (!head.test(l)) continue;
    let v = l.replace(strip, "");
    if (/^".*"$/.test(v)) {
      v = v.replace(/^"/, "").replace(/"$/, "");
      if (unescape) v = v.replace(/\\"/g, '"');
    }
    return { line: i + 1, value: v };
  }
  return null;
}

// ANY heading level: an older session written under `## ` inside another
// session's block keeps that heading when it gets a file of its own.
function firstBodyHeading(lines: string[]): string {
  if (lines[0] !== "---") return "";
  let infm = true;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (infm) {
      if (l === "---") infm = false;
      continue;
    }
    if (/^#+ /.test(l)) return l.replace(new RegExp(`^#+${SP}*`), "");
  }
  return "";
}

// ─── F6 + F7: the body's sections and the Decisions bullets ──────────
// One pass over the body (after the closing `---`). A fence opener flips
// `fence` and an unclosed fence runs to the end of the file, so quoted
// text is never read as a section. The length is counted in CHARACTERS (code
// points), never bytes, and needs no locale: a `rejected:` line usually
// carries an em-dash, and a byte count would refuse a 499-character line.
function bodyChecks(lines: string[], file: string): string[] {
  const out: string[] = [];
  const allowed = new Set(SECTION_LABELS.split("|"));
  const report = (n: number, id: string, msg: string): void => {
    out.push(`${file}:${n}: ${id} — ${msg}`);
  };
  let infm = false;
  let fence = false;
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const n = i + 1;
    if (n === 1) {
      infm = l === "---";
      fence = false;
      section = "";
      if (infm) continue;
    }
    if (infm) {
      if (l === "---") infm = false;
      continue;
    }
    if (/^(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^#+ /.test(l)) {
      section = "";
      continue;
    }
    if (/^\*\*[A-Za-z][A-Za-z -]*:\*\*/.test(l)) {
      const label = l.replace(/^\*\*/, "").replace(/:\*\*.*$/, "");
      if (!allowed.has(label)) {
        let where: string;
        if (label === "Next")
          where =
            "retired: outstanding project work belongs in the project ROADMAP.md, work waiting on the user under **Blocked:**";
        else if (label === "Issues")
          where = "retired: what an investigation found belongs under **Findings:**, each bullet naming its reading";
        else
          where =
            "not a section in journal-entry.md § Section set; fold it into **Changes:**, **Findings:** or **Lessons:**";
        report(n, "F6", `\`**${label}:**\` is not one of the eight sections (${SECTION_LABELS}) — ${where}`);
      }
      section = label;
      continue;
    }
    if (section !== "Decisions") continue;
    if (new RegExp(`^${SP}*$`).test(l)) continue;
    if (/^[ \t]/.test(l)) {
      report(
        n,
        "F7",
        "a Decisions bullet wraps onto an indented line — each bullet is one line, because a grep for what was turned down reads a line that STARTS with `rejected:`",
      );
      continue;
    }
    if (new RegExp(`^- \\[[^\\]]+\\]\\([^)]+\\)${SP}*$`).test(l)) continue;
    if (/^- rejected: /.test(l)) {
      const len = [...l].length - 2;
      if (len > 500)
        report(
          n,
          "F7",
          `this \`rejected:\` line is ${len} characters after the \`- \` — the ceiling is 500`,
        );
      continue;
    }
    report(
      n,
      "F7",
      "a Decisions bullet is neither a link nor a `rejected:` line — link the file that holds the choice (a decisions/ record, spec.md § Clarifications, research.md, report.md § Deviations) with nothing after the link, or write `- rejected: <what was not done> — <why>` on one line; a one-off session small choice goes under **Changes:**",
    );
  }
  return out;
}

// ─── F2 + F3: entry integrity inside the sessions: block ─────────────
// State machine over the FIRST frontmatter block only. `fieldIndent` is
// derived from each `- slug:` line (dash indent + 2), so nested
// `runtime_identity:` entries sit deeper and are skipped rather than
// mistaken for duplicate entry fields.
function structureChecks(lines: string[], file: string): string[] {
  const out: string[] = [];
  const report = (n: number, msg: string): void => {
    out.push(`${file}:${n}: ${msg}`);
  };
  const leading = new RegExp(`^${SP}*`);
  const indentOf = (l: string): number => (leading.exec(l)?.[0] ?? "").length;
  const sessionsKey = new RegExp(`^sessions:${SP}*$`);
  const slugLine = new RegExp(`^${SP}*-${SP}+slug:`);
  const slugPrefix = new RegExp(`^${SP}*-${SP}+slug:${SP}*`);
  const blank = new RegExp(`^${SP}*$`);
  const fieldLine = new RegExp(`^${SP}*[A-Za-z_][A-Za-z0-9_-]*:`);

  let state = 0;
  let inSessions = false;
  let seenSlug = false;
  let slug = "";
  let fieldIndent = 0;
  let topKeys = new Set<string>();
  let keys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const n = i + 1;
    if (n === 1) {
      state = l === "---" ? 1 : 2;
      inSessions = false;
      seenSlug = false;
      slug = "";
      topKeys = new Set();
      continue;
    }

    // Frontmatter closes; nothing after it is our business.
    if (state === 1 && l === "---") {
      state = 2;
      inSessions = false;
      continue;
    }
    if (state !== 1) continue;

    // F4. Deliberately falls through rather than continuing: the sessions-block
    // rules below still have to see `sessions:` itself.
    if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(l)) {
      const top = l.replace(/:.*$/, "");
      if (topKeys.has(top)) {
        report(
          n,
          `duplicate \`${top}:\` at column 0 — YAML keeps the LAST one, so everything on the earlier line is discarded`,
        );
      }
      topKeys.add(top);
    }

    if (sessionsKey.test(l)) {
      inSessions = true;
      seenSlug = false;
      keys = new Set();
      continue;
    }

    // Any other column-0 key ends the sessions block.
    if (inSessions && /^[A-Za-z_]/.test(l)) inSessions = false;
    if (!inSessions) continue;

    // Entry start.
    if (slugLine.test(l)) {
      fieldIndent = indentOf(l) + 2;
      slug = l.replace(slugPrefix, "");
      seenSlug = true;
      keys = new Set();
      continue;
    }

    if (blank.test(l)) continue;

    const ind = indentOf(l);
    if (!seenSlug) {
      report(
        n,
        "session field appears before any `- slug:` — a concurrent session split an entry and orphaned these fields",
      );
      continue;
    }

    // Deeper than an entry field => nested (runtime_identity list). Shallower
    // is not a session field either. Only exact-depth keys are entry fields.
    if (ind !== fieldIndent) continue;
    if (!fieldLine.test(l)) continue;

    const key = l.replace(leading, "").replace(/:.*$/, "");
    if (keys.has(key)) {
      report(
        n,
        `duplicate \`${key}:\` inside session \`${slug}\` — a foreign \`- slug:\` was inserted into this entry, re-parenting its fields`,
      );
    }
    keys.add(key);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── Collect files to scan ──────────────────────────────────────────────
  let STAGED_MODE = false;
  let files: string[];
  if (args.length > 0) {
    files = args;
  } else {
    STAGED_MODE = true;
    // Read and checked before it is filtered: a failed read that listed
    // nothing would exit 0 on "nothing staged" — a gate passed.
    const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    const staged = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\n+$/, "");
    if (r.status !== 0) {
      const last = staged.slice(staged.lastIndexOf("\n") + 1);
      process.stderr.write(`check-journal-entry: could not read the staged files: ${last}\n`);
      exit(1);
    }
    files = staged.split("\n").filter((f) => /^journal\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[^/]+\.md$/.test(f));
  }

  if (files.length === 0) exit(0);

  // THE INDEX COPY IS WHAT COMMITS, and this scanned the working-tree copy — so
  // staging a journal with a duplicated frontmatter block and then repairing only
  // the file on disk committed the corruption while the check reported clean. In
  // staged mode each file is materialised from the index and scanned there, in
  // a scratch folder removed on the way out.
  const SCRATCH = STAGED_MODE ? mkdtempSync(join(tmpdir(), "check-journal-entry-")) : "";
  try {
    scanAll(files, STAGED_MODE, SCRATCH);
  } finally {
    if (SCRATCH !== "") rmSync(SCRATCH, { recursive: true, force: true });
  }
}

function scanTarget(f: string, staged: boolean, scratch: string): string {
  if (!staged) return f;
  const dest = join(scratch, f.replace(/\//g, "_"));
  // git writes the index copy straight into the scratch file: no buffer in
  // between, so no size past which the read fails. A copy the index cannot hand
  // back is a failure, never a fall back to the working copy — that copy is not
  // what commits, and scanning it passed corruption staged before an unstaged
  // repair.
  const fd = openSync(dest, "w");
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("git", ["show", `:${f}`], { encoding: "utf8", stdio: ["ignore", fd, "pipe"] });
  } finally {
    closeSync(fd);
  }
  if (r.status !== 0) {
    const why = String(r.stderr ?? r.error?.message ?? "").replace(/\n+$/, "");
    const last = why.slice(why.lastIndexOf("\n") + 1);
    process.stderr.write(
      `check-journal-entry: could not read the staged copy of ${f}: ${last || `git show exited ${r.status}`}\n`,
    );
    exit(1);
  }
  return dest;
}

function scanAll(files: string[], staged: boolean, scratch: string): void {
  const issues: string[] = [];

  for (const journalPath of files) {
    const journal = scanTarget(journalPath, staged, scratch);
    if (!isFile(journal)) continue;
    const lines = linesOf(journal);

    // ─── F1: one frontmatter block per file ──────────────────────────────
    // Column-0 `date:` / `sessions:` only appear in frontmatter — journal bodies
    // are `###` headings and `**Label:**` bullets — so a count above one is a
    // stray block, not prose.
    const dateKey = new RegExp(`^date:${SP}`);
    const sessionsKey = new RegExp(`^sessions:${SP}*$`);
    const dateCount = lines.filter((l) => dateKey.test(l)).length;
    const sessionsCount = lines.filter((l) => sessionsKey.test(l)).length;

    if (dateCount > 1 || sessionsCount > 1) {
      issues.push(
        `${journalPath}: ${dateCount} 'date:' and ${sessionsCount} 'sessions:' keys at column 0 — expected at most 1 of each.`,
      );
      issues.push("  A concurrent session appended a SECOND frontmatter block mid-file. A reader");
      issues.push("  reads only the first, so every session in the later block is invisible to it.");
      issues.push("  offending lines:");
      const offending = lines
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => dateKey.test(l) || sessionsKey.test(l))
        .slice(0, 20);
      for (const { l, n } of offending) issues.push(`    ${n}:${l}`);
    }

    if (dateCount === 0) {
      issues.push(`${journalPath}: no 'date:' key at column 0 — frontmatter block missing or malformed.`);
    }

    // ─── F5: the file's slug is the session its body is about ────────────
    if (!basename(journalPath).startsWith("0000-")) {
      // The value may be QUOTED — a session name containing `: ` has to be, or the
      // front matter is not valid YAML — so compare what the quotes contain.
      const fmSlug = frontMatterValue(lines, "slug", true)?.value ?? "";
      const firstHeading = firstBodyHeading(lines);
      if (fmSlug === "") {
        issues.push(`${journalPath}: no 'slug:' key — a reader of the journal keys this session to it.`);
      } else if (fmSlug !== firstHeading) {
        issues.push(
          `${journalPath}: front matter says slug '${fmSlug}' but the first body heading is '### ${firstHeading}'.`,
        );
        issues.push("  A reader files this file under the front matter's slug, so its record");
        issues.push("  would land on a session whose write-up is somewhere else.");
      }

      // ─── F8: root_cause_status is one of four ────────────────────────────
      // Optional key; when present its value is compared unquoted. The line
      // number comes from the same pass so the message can point at it.
      const rcs = frontMatterValue(lines, "root_cause_status", false);
      if (rcs && rcs.value !== "" && !`|${ROOT_CAUSE_VALUES}|`.includes(`|${rcs.value}|`)) {
        issues.push(
          `${journalPath}:${rcs.line}: F8 — root_cause_status '${rcs.value}' is not one of ${ROOT_CAUSE_VALUES.replace(/\|/g, " | ")} — journal-entry.md § Field reference says which each case is; a detail goes on the **Root-Cause Status:** line, not in the key.`,
        );
      }

      issues.push(...bodyChecks(lines, journalPath));
    }

    // Reported against the file actually read — in staged mode, the copy
    // materialised from the index.
    const structure = structureChecks(lines, journal);
    if (structure.length > 0) {
      issues.push(`${journalPath}: corrupt frontmatter structure.`);
      for (const line of structure) issues.push(`    ${line}`);
    }
  }

  // ─── Report ─────────────────────────────────────────────────────────────
  if (issues.length > 0) {
    const err = [
      "",
      "JOURNAL ENTRY GATE FAILED — the entry does not follow close/references/journal-entry.md:",
      ...issues.map((i) => `  ${i}`),
      "",
      "Fix (do NOT delete the other session's content — it is someone else's close):",
      "  0. Slug/heading disagreement: make the front matter's 'slug:' and the first",
      "     '### ' heading identical — both contain the full session title, not the",
      "     filename stem. Keep the allocated filename and ledger path unchanged.",
      "  1. Two frontmatter blocks: fold the later block's '- slug:' entries and its",
      "     tags into the FIRST block, then delete the stray '---'/'date:'/'tags:'/",
      "     'sessions:'/'---' fragment. Leave its body '###' section where it is.",
      "  2. Duplicate key / orphaned fields: find the '- slug:' that was inserted",
      "     mid-entry and move it (with its own fields) below the entry it split,",
      "     so every field sits under the slug that actually produced it.",
      "  3. Duplicate key at column 0: MERGE the two lines' values into the first",
      "     one and delete the second. Do not just delete a line — for 'tags:' that",
      "     throws away whichever topics were unique to it.",
      "  4. F6 (a label outside the set): move the content where the message says and",
      "     delete the label. F7 (a Decisions bullet): replace prose with a link to the",
      "     file that holds the choice, or a one-line 'rejected: <what> — <why>'.",
      "     F8 (root_cause_status): pick one of the four values.",
      "  5. Schema: close/references/journal-entry.md",
      "",
    ];
    process.stderr.write(`${err.join("\n")}\n`);
    exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
