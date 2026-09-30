#!/usr/bin/env -S node --experimental-strip-types
// check-decision-records.ts — hold every decision record to the format stated
// in decisions/README.md, before it is committed.
//
// WHY. A decision written as free prose drifts: status words multiply, and a
// record gets written as decided over a discussion that decided nothing. The
// MADR format fixes the first by vocabulary; part (g) fixes the second, because
// an `accepted` record has to carry the dated words that accepted it.
//
// WHAT IT CHECKS — the seven parts, each with the letter its violations carry:
//   (a) frontmatter parses and carries `status`, `date` and `decision-makers`
//   (b) `status` is proposed | rejected | accepted | deprecated |
//       `superseded by <path>/decisions/NNNN-<slug>.md` — a repo-relative
//       PATH, never a bare number (numbers are per folder) and never an
//       absolute, home or `..` path
//   (c) `date` is a real YYYY-MM-DD
//   (d) `decision-makers` is non-empty
//   (e) the filename is NNNN-title-with-dashes.md, lowercase
//   (f) NNNN is unique among every record ON DISK in the same folder — not
//       among the arguments, or a new 0003 beside a committed 0003 passes
//   (g) an `accepted` record's BODY has a line holding a YYYY-MM-DD date
//       followed by a quoted run ("…" or “…”); frontmatter does not count
//
// WHAT IT SCANS. With no path arguments: the decision files changed in this
// work tree, staged or not, measured from HEAD — or with `--since <ref>` from
// where this branch left <ref>, so a record already committed on the branch is
// seen too. Untracked files come from `git ls-files --others`, one per file, so
// a brand-new `decisions/` folder is read record by record. Paths no longer on
// disk are skipped: a move arrives as a delete plus a new file.
// With arguments: exactly those files, whatever their names, and every
// directory argument walked for decision files at any depth. land.ts calls it
// with `--since origin/<trunk>`, BEFORE its `git add -A`, so a record the
// session already committed and one it has not yet staged are both seen.
//
// peers:
//   decisions/README.md                            (the format this enforces)
//   .agents/skills/close/scripts/land.ts           (the gate that calls it)
//
// A "decision file" is any `.md` directly inside a folder named `decisions`,
// except that folder's README.md. Broader than NNNN-*.md on purpose: a record
// misnamed `001-foo.md` must fail part (e), not slip past unscanned.
//
// Placement — which `decisions/` a record belongs in — is NOT checked: "the
// narrowest home containing everyone who could act contrary" names people, and
// no script can enumerate them. That rule lives in decisions/README.md.
//
// Usage:
//   node --experimental-strip-types check-decision-records.ts                  records changed since HEAD
//   node --experimental-strip-types check-decision-records.ts --since <ref>    …since this branch left <ref>
//   node --experimental-strip-types check-decision-records.ts <path>...        those files / directories
//
// Output (stdout): exactly one line — `OK — N decision record(s) checked`, or
//   `FAIL — N decision record(s) checked, M violation(s)`.
// Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
//
// Exit: 0 clean · 1 one or more violations · 2 caller error

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { yamlScalar } from "./yaml-scalar.ts";

/** A caller error: the message goes to stderr and the run exits with `code`. */
class Exit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
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

/** A decision file: a .md directly inside a `decisions` folder, not its README. */
function isDecisionPath(p: string): boolean {
  return /(^|\/)decisions\/[^/]+\.md$/.test(p) && basename(p) !== "README.md";
}

/** `git <args>`; stderr captured unless `inheritStderr`. */
function git(args: string[], inheritStderr = false) {
  return spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", inheritStderr ? "inherit" : "pipe"],
  });
}

/** `find <dir> -type f -name '*.md'`, sorted: regular files only, symlinked
 *  directories not descended, paths spelled from the argument as find does. */
function findMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d.endsWith("/") ? d : `${d}/`}${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** The paths git says changed since `base`, plus untracked ones. */
function changedPaths(since: string): string[] {
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Exit(2, "check-decision-records: not inside a git work tree");
  process.chdir(top.stdout.replace(/\n$/, ""));
  let base = "HEAD";
  if (since) {
    // git's own stderr stays visible: "not a valid object name" and "no merge
    // base" are different faults with different fixes.
    const mb = git(["merge-base", "HEAD", since], true);
    if (mb.status !== 0) throw new Exit(2, `check-decision-records: cannot find where HEAD left ${since}`);
    base = mb.stdout.replace(/\n+$/, "");
  }
  // Tracked changes against the base, committed, staged or not, plus untracked
  // files one by one. `--no-renames` lists a move as its two halves, and the
  // half no longer on disk is dropped below — so there is no rename field to
  // parse. Each list's exit is checked: a failing git read as "nothing changed"
  // once, and the scan passed without reading a record it was meant to check.
  const diff = git(["diff", "-z", "--name-only", "--no-renames", base]);
  if (diff.status !== 0) {
    throw new Exit(2, `check-decision-records: git diff against ${base} failed: ${diff.stderr.replace(/\n+$/, "")}`);
  }
  const others = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (others.status !== 0) {
    throw new Exit(2, `check-decision-records: git ls-files failed: ${others.stderr.replace(/\n+$/, "")}`);
  }
  return `${diff.stdout}${others.stdout}`.split("\0").filter((p) => p !== "" && isDecisionPath(p) && isFile(p));
}

interface DecisionRecord {
  fm: "ok" | "none" | "unclosed";
  hasStatus: boolean;
  status: string;
  hasDate: boolean;
  date: string;
  hasDm: boolean;
  dm: string;
  quoted: boolean;
  /** The keys YAML would refuse: a quote that never closes (`open`), or text
   *  after a closed one (`trailing`). */
  badQuotes: { key: string; state: "open" | "trailing" }[];
}

const KEYS = ["status", "date", "decision-makers"];

/** Frontmatter and body in one pass. A small state machine, not a YAML
 *  library: the three keys are flat scalars, plus `decision-makers` as a block
 *  list (`  - name`), which MADR's full template also allows. Values are read
 *  by yamlScalar, shared with check-skills.ts. */
function parseRecord(file: string): DecisionRecord {
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const has = new Map<string, boolean>();
  const val = new Map<string, string>();
  const badq = new Map<string, "open" | "trailing">();
  // The value, and the key noted in badq when YAML would refuse it.
  const valueOf = (raw: string, key: string): string => {
    const { value, state } = yamlScalar(raw);
    if (state !== "ok") badq.set(key, state);
    return value;
  };
  let infm = false;
  let closed = false;
  let quoted = false;
  let cur = "";
  if (lines.length === 0 || lines[0] !== "---") {
    return {
      fm: "none",
      hasStatus: false,
      status: "",
      hasDate: false,
      date: "",
      hasDm: false,
      dm: "",
      quoted: false,
      badQuotes: [],
    };
  }
  infm = true;
  for (const line of lines.slice(1)) {
    if (infm && line === "---") {
      infm = false;
      closed = true;
      continue;
    }
    if (infm) {
      const m = /^[A-Za-z0-9_-]+:/.exec(line);
      if (m) {
        cur = m[0].slice(0, -1);
        has.set(cur, true);
        val.set(cur, valueOf(line.slice(m[0].length), cur));
      } else if (cur === "decision-makers" && /^[ \t]+-[ \t]*[^ \t]/.test(line)) {
        const item = line.replace(/^[ \t]+-[ \t]*/, "");
        const prev = val.get(cur) ?? "";
        val.set(cur, `${prev === "" ? "" : `${prev}, `}${valueOf(item, cur)}`);
      }
      continue;
    }
    // The date must come BEFORE the opening quote — `Your Name 2026-01-10: "…"`.
    // Either order would let a line quoting a discussion and dating it after
    // stand in for an approval.
    if (closed && !quoted) {
      const d = /[0-9]{4}-[0-9]{2}-[0-9]{2}/.exec(line);
      if (d) {
        const rest = line.slice(d.index + d[0].length);
        if (/"[^"]+"/.test(rest)) quoted = true;
        const o = rest.indexOf("“");
        if (o !== -1 && rest.slice(o + 1).indexOf("”") > 0) quoted = true;
      }
    }
  }
  return {
    fm: closed ? "ok" : "unclosed",
    hasStatus: has.get("status") === true,
    status: val.get("status") ?? "",
    hasDate: has.get("date") === true,
    date: val.get("date") ?? "",
    hasDm: has.get("decision-makers") === true,
    dm: val.get("decision-makers") ?? "",
    quoted,
    badQuotes: KEYS.flatMap((key) => {
      const state = badq.get(key);
      return state === undefined ? [] : [{ key, state }];
    }),
  };
}

/** The calendar has that day — checked in JS, not with GNU-only `date -d`. */
function realDate(d: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(d);
  if (!m) return false;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, day);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === day;
}

// A supersession names a REPO-RELATIVE path: segments that do not start with a
// dot (so no `..`, no `./`), no leading `/` or `~`.
const STATUS_RE =
  /^(proposed|rejected|accepted|deprecated|superseded by ([A-Za-z0-9_][A-Za-z0-9_.-]*\/)*decisions\/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md)$/;
const NAME_RE = /^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$/;

function check(targets: string[]): number {
  let violations = 0;
  const printed = new Set<string>();
  const violation = (path: string, part: string, what: string): void => {
    const line = `${path}: (${part}) ${what}`;
    if (printed.has(line)) return;
    printed.add(line);
    err(line);
    violations += 1;
  };

  for (const f of targets) {
    const name = basename(f);
    const dir = dirname(f);

    // (e) and (f) read only the name, so they hold even when the content is bad.
    if (!NAME_RE.test(name)) {
      violation(f, "e", `filename must be NNNN-title-with-dashes.md, lowercase (got ${name})`);
    }
    const num = /^([0-9]{4})-/.exec(name)?.[1];
    if (num !== undefined) {
      const siblings = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.startsWith(`${num}-`) && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();
      if (siblings.length > 1) {
        for (const s of siblings) {
          const others = siblings.filter((o) => o !== s);
          violation(`${dir}/${s}`, "f", `number ${num} is also used by ${others.join(" ")} in the same folder`);
        }
      }
    }

    const r = parseRecord(f);
    if (r.fm === "none") {
      violation(f, "a", "no frontmatter — the file must open with a '---' line");
      continue;
    }
    if (r.fm === "unclosed") {
      violation(f, "a", "frontmatter is never closed by a second '---' line");
      continue;
    }

    for (const { key, state } of r.badQuotes) {
      violation(
        f,
        "a",
        state === "open"
          ? `${key} has an unclosed quote — the frontmatter will not parse`
          : `${key} has text after its closing quote — the frontmatter will not parse`,
      );
    }

    if (!r.hasStatus) {
      violation(f, "a", "missing required key: status");
    } else if (!STATUS_RE.test(r.status)) {
      violation(
        f,
        "b",
        `status '${r.status}' is not proposed/rejected/accepted/deprecated/'superseded by <path>/decisions/NNNN-<slug>.md'`,
      );
    }

    if (!r.hasDate) {
      violation(f, "a", "missing required key: date");
    } else if (!realDate(r.date)) {
      violation(f, "c", `date '${r.date}' is not a real YYYY-MM-DD`);
    }

    if (!r.hasDm) {
      violation(f, "a", "missing required key: decision-makers");
    } else if (r.dm === "" || /^\[\s*\]$/.test(r.dm)) {
      violation(f, "d", "decision-makers is empty — name who decided");
    }

    if (r.status === "accepted" && !r.quoted) {
      violation(
        f,
        "g",
        "accepted, but no body line has a YYYY-MM-DD date followed by the quoted words that accepted it (a date after the quote does not count)",
      );
    }
  }

  if (violations > 0) {
    process.stdout.write(`FAIL — ${targets.length} decision record(s) checked, ${violations} violation(s)\n`);
    return 1;
  }
  process.stdout.write(`OK — ${targets.length} decision record(s) checked\n`);
  return 0;
}

function collect(args: string[], targets: string[]): void {
  let rest = args;
  let since = "";
  if (rest[0] === "--since") {
    if (!rest[1]) throw new Exit(2, "check-decision-records: --since needs a ref");
    since = rest[1];
    rest = rest.slice(2);
    if (rest.length !== 0) throw new Exit(2, "check-decision-records: --since takes no paths");
  }
  if (rest.length === 0) {
    targets.push(...changedPaths(since));
    return;
  }
  for (const arg of rest) {
    if (isFile(arg)) {
      targets.push(arg);
    } else if (isDir(arg)) {
      targets.push(...findMarkdown(arg).filter(isDecisionPath));
    } else {
      throw new Exit(2, `check-decision-records: not a file or directory: ${arg}`);
    }
  }
}

function main(): void {
  const targets: string[] = [];
  let code = 0;
  try {
    collect(process.argv.slice(2), targets);
    code = check(targets);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    err(e.message);
    code = e.code;
  }
  process.exitCode = code;
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
