#!/usr/bin/env -S node --experimental-strip-types
// triage.ts — `/project triage blocked|monitored|mine`: one numbered markdown
// table, finished, for the agent to paste and the user to answer by number.
//
//   blocked    every Blocked project, by the wait that decides it (README
//              `blocked-on:`): what it waits on, whose move that is, how long
//              it has waited. The user's moves first, then date waits already
//              past (nothing reopens them on its own; `unblock` does), then
//              other people, then other projects, then date waits still to
//              come.
//   monitored  every Monitoring project, by its earliest watch (README
//              `monitoring-until:`): what the watch is waiting to see, when it
//              ends, how long is left. Lapsed first.
//   mine       every step waiting on the user across Active, Blocked and
//              Monitoring projects: each open `blocked:` row whose wait names
//              the user, then each Active project's ready `manual` rows, one line
//              per project with the first row and how many more.
//
// Each view exists so many projects can be changed in one answer: a table of
// what each project waits on, numbered, answered by number, rather than one
// /project session per project.
//
// Read from this worktree, which the caller merges origin/main into first: the
// answers become edits here, and /close lands them. A worktree behind
// origin/main in projects/ is refused (exit 2) rather than shown stale. Rows
// are read through roadmap.ts's `listRows`, the one table parser. "Since" is
// the day the deciding Status text (a `manual` row: the row itself) entered
// ROADMAP.md, from `git log -S`; "—" when git has no such commit.
//
// Whose move is a word match, not judgment: a wait naming you, your, me, my,
// the user or the owner — or the first name in the checkout's `git config
// user.name`, which is the owner's — is the user's. The agent may say a row
// reads otherwise; it does not re-sort the table.
//
// Every table cell is at most 8 words (a chat pane narrower than the table cuts
// a long cell off), so a long wait is cut at 8 words with `…`.
//
// Usage: triage.ts blocked|monitored|mine [--root <dir>] [--today YYYY-MM-DD]
//   --root   the checkout holding projects/ (default: the workbench this
//            script is installed in, four folders up)
//   --today  the day to count from (default: today, local time)
// Exit: 0 printed · 1 a read failed · 2 usage, or behind origin/main.
//
// peers:
//   .agents/skills/project/scripts/triage.test.ts
//   .agents/skills/close/scripts/roadmap.ts   (listRows, watchDate, releaseDate)
//   .agents/skills/project/SKILL.md           (§ Triage)

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../../../generators/parse_frontmatter.ts";
import { listRows, releaseDate, watchDate } from "../../close/scripts/roadmap.ts";
import { Exit, exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const KINDS = ["blocked", "monitored", "mine"] as const;
type Kind = (typeof KINDS)[number];
const USAGE = "usage: triage.ts blocked|monitored|mine [--root <dir>] [--today YYYY-MM-DD]";
/** A narrow chat pane cuts a long cell, so every cell is 8 words at most. A path is one
 *  "word" of 80 characters, so a cell is cut at a length as well. */
const CELL_WORDS = 8;
const CELL_CHARS = 60;

export interface Project {
  /** `projects/<domain>/<folder>` */
  rel: string;
  slug: string;
  status: string;
  /** The row ID README's `blocked-on:` or `monitoring-until:` names, or "". */
  decidingId: string;
}

/** Cut to `n` words and CELL_CHARS characters, `…` when cut; pipes escaped
 *  so the cell stays one cell. */
export function cell(text: string, n = CELL_WORDS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let out = words.slice(0, n).join(" ");
  let cut = words.length > n;
  if (out.length > CELL_CHARS) {
    out = out.slice(0, CELL_CHARS).trimEnd();
    cut = true;
  }
  // A pipe the table already escaped (`\|`) stays as it is.
  return ((cut ? `${out}…` : out) || "—").replace(/(?<!\\)\|/g, "\\|");
}

/** `n days`, singular at one. */
export const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** Whose move a wait is: the user's when it names them — a pronoun, "the
 *  user", "the owner", or `owner`, the owner's first name ("" for none). */
export function names(text: string, owner = ""): boolean {
  if (/\b(you|your|me|my|the user|the owner)\b/i.test(text)) return true;
  // Unicode word boundaries: ASCII \b reads an accented letter as a
  // non-word character, so "Élodie" never matched and "Ana" matched inside
  // "Anaïs" (open-decision.ts reads the name the same way).
  const name = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return owner !== "" && new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

/** The owner's first name: the first word of `git config user.name` in the
 *  checkout, when it is a word of two letters or more; else "". */
function ownerName(root: string): string {
  const r = spawnSync("git", ["-C", root, "config", "user.name"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const first = r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? "") : "";
  return /^\p{L}{2,}$/u.test(first) ? first : "";
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const age = (since: string, today: string) => (since === "" ? "—" : days(daysBetween(since, today)));
const short = (date: string) => date.slice(5);

/** A row of listRows: ID, Status, ready, Sub-spec, Sub-feature. */
type Row = string[];

/** The wait text of a `blocked:` Status, without `blocked:` and any `until <date>`. */
export function waitText(status: string): string {
  return status
    .replace(/^blocked:\s*/i, "")
    .replace(/^until\s+\d{4}-\d{2}-\d{2}\s*/i, "")
    .trim();
}

/** The text a watch row is waiting to see: its Status after the date, else its Sub-feature. */
export function watchText(row: Row): string {
  const after = (row[1] ?? "").replace(/^blocked:\s*\d{4}-\d{2}-\d{2}\s*/i, "").trim();
  return after !== "" ? after : (row[4] ?? "");
}

const isOpen = (status: string) => !/^(done|absorbed by|closed:)/i.test(status.trim());

function readProjects(root: string): Project[] {
  const out: Project[] = [];
  const projects = join(root, "projects");
  for (const domain of readdirSync(projects, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const folder of readdirSync(join(projects, domain.name), { withFileTypes: true })) {
      const readme = join(projects, domain.name, folder.name, "README.md");
      if (!folder.isDirectory() || !existsSync(readme)) continue;
      // Read as the project index reads it: quotes and trailing comments included.
      const fm = parseFrontmatter(readFileSync(readme, "utf8")) ?? {};
      const decides = fm["blocked-on"] ?? (fm["monitoring-until"] ?? "").replace(/^\S+ — /, "");
      out.push({
        rel: `projects/${domain.name}/${folder.name}`,
        slug: folder.name.replace(/^\d{4}-\d{2}-\d{2}_/, ""),
        status: (fm.status ?? "").split(/\s/)[0] ?? "",
        decidingId: /^(\S+?):/.exec(decides)?.[1] ?? "",
      });
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The day `needle` entered `file`, or "". */
function sinceOf(root: string, file: string, needle: string): string {
  const r = spawnSync("git", ["-C", root, "log", "-1", "--format=%cs", `-S${needle}`, "--", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  });
  return r.status === 0 ? r.stdout.trim() : "";
}

function rowsOf(root: string, p: Project): { rows: Row[]; deps: ReturnType<typeof listRows>["deps"] } {
  const r = listRows(join(root, p.rel, "ROADMAP.md"), undefined, { projectsRoot: root });
  if (!r.ok) throw new Error(`${p.rel}/ROADMAP.md: ${r.messages.join("; ") || "unreadable"}`);
  return { rows: r.rows, deps: r.deps };
}

function table(header: string[], lines: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...lines.map((l) => `| ${l.join(" | ")} |`),
  ];
}

// ── blocked ─────────────────────────────────────────────────────────────────

const BLOCKED_ORDER = ["you", "date passed", "others", "project", "date"] as const;

function blocked(root: string, projects: Project[], today: string, owner: string): string[] {
  const items = projects
    .filter((p) => p.status === "blocked")
    .map((p) => {
      const { rows, deps } = rowsOf(root, p);
      const at = rows.findIndex((r) => r[0] === p.decidingId);
      const row = rows[at] ?? rows.find((r) => /^blocked:/i.test(r[1] ?? "") && watchDate(r[1] ?? "") === "");
      const status = row?.[1] ?? "";
      const until = releaseDate(status);
      const openDep = at >= 0 ? deps[at]?.find((d) => d.state === "open" && d.project !== "") : undefined;
      let whose: (typeof BLOCKED_ORDER)[number];
      let what: string;
      if (until !== "") {
        whose = until <= today ? "date passed" : "date";
        what = `until ${short(until)}: ${waitText(status)}`;
      } else if (!/^blocked:/i.test(status) && openDep) {
        whose = "project";
        what = `waits on ${openDep.text}`;
      } else {
        what = waitText(status) || "no blocked row found";
        whose = names(what, owner) ? "you" : "others";
      }
      const since = /^blocked:/i.test(status) ? sinceOf(root, `${p.rel}/ROADMAP.md`, status) : "";
      return { p, id: row?.[0] ?? "—", what, whose, since, until };
    })
    .sort(
      (a, b) =>
        BLOCKED_ORDER.indexOf(a.whose) - BLOCKED_ORDER.indexOf(b.whose) ||
        (a.whose === "date" ? a.until.localeCompare(b.until) : (a.since || "9").localeCompare(b.since || "9")) ||
        a.p.slug.localeCompare(b.p.slug),
    );
  if (items.length === 0) return ["**Blocked — 0**"];
  const whoseCell = (i: (typeof items)[number]) =>
    i.whose === "date"
      ? `date ${short(i.until)}`
      : i.whose === "date passed"
        ? `date passed ${short(i.until)}`
        : i.whose;
  return [
    `**Blocked — ${items.length}**`,
    "",
    ...table(
      ["#", "Project", "Row", "Waiting on", "Whose move", "Waiting"],
      items.map((i, n) => [String(n + 1), i.p.slug, i.id, cell(i.what), whoseCell(i), age(i.since, today)]),
    ),
    "",
    "Answer by number: `unblock`, `until <date>`, `done`, `drop`, or a new wait.",
  ];
}

// ── monitored ───────────────────────────────────────────────────────────────

function monitored(root: string, projects: Project[], today: string): string[] {
  const items = projects
    .filter((p) => p.status === "monitor")
    .map((p) => {
      const { rows } = rowsOf(root, p);
      const watches = rows.filter((r) => isOpen(r[1] ?? "") && watchDate(r[1] ?? "") !== "");
      const row =
        watches.find((r) => r[0] === p.decidingId) ??
        [...watches].sort((a, b) => watchDate(a[1]).localeCompare(watchDate(b[1])))[0];
      const ends = row ? watchDate(row[1]) : "";
      return {
        p,
        id: row?.[0] ?? "—",
        what: row ? watchText(row) : "no watch row found",
        ends,
        more: watches.length - 1,
      };
    })
    .sort((a, b) => (a.ends || "9").localeCompare(b.ends || "9") || a.p.slug.localeCompare(b.p.slug));
  if (items.length === 0) return ["**Monitoring — 0**"];
  const left = (ends: string) => {
    if (ends === "") return "no end date";
    const d = daysBetween(today, ends);
    return d < 0 ? `lapsed ${days(-d)}` : d === 0 ? "ends today" : days(d);
  };
  return [
    `**Monitoring — ${items.length}**`,
    "",
    ...table(
      ["#", "Project", "Row", "Watching for", "Ends", "Left"],
      items.map((i, n) => [
        String(n + 1),
        i.p.slug,
        i.more > 0 ? `${i.id} (+${i.more})` : i.id,
        cell(i.what),
        i.ends === "" ? "—" : i.ends,
        left(i.ends),
      ]),
    ),
    "",
    "Answer by number: `done`, `extend <date>`, or `drop`.",
  ];
}

// ── mine ────────────────────────────────────────────────────────────────────

function mine(root: string, projects: Project[], today: string, owner: string): string[] {
  const waits: Array<{ p: Project; id: string; what: string; kind: string; since: string; more: number }> = [];
  const hands: typeof waits = [];
  for (const p of projects.filter((x) => ["active", "blocked", "monitor"].includes(x.status))) {
    const { rows } = rowsOf(root, p);
    for (const r of rows) {
      const status = r[1] ?? "";
      if (!/^blocked:/i.test(status) || watchDate(status) !== "" || releaseDate(status) !== "") continue;
      const what = waitText(status);
      if (!names(what, owner)) continue;
      // Rows of one project waiting on the same thing are one step.
      const same = waits.find((w) => w.p === p && w.what === what);
      if (same) same.more++;
      else
        waits.push({
          p,
          id: r[0],
          what,
          kind: "waits on you",
          since: sinceOf(root, `${p.rel}/ROADMAP.md`, status),
          more: 0,
        });
    }
    if (p.status !== "active") continue;
    const manual = rows.filter((r) => r[2] === "yes" && r[3] === "manual");
    if (manual.length === 0) continue;
    const first = manual[0];
    hands.push({
      p,
      id: first[0],
      what: first[4] ?? "",
      kind: "hands-on",
      more: manual.length - 1,
      since: sinceOf(root, `${p.rel}/ROADMAP.md`, `| ${first[0]} |`),
    });
  }
  const bySince = (a: { since: string; p: Project }, b: { since: string; p: Project }) =>
    (a.since || "9").localeCompare(b.since || "9") || a.p.slug.localeCompare(b.p.slug);
  const items = [...waits.sort(bySince), ...hands.sort(bySince)];
  if (items.length === 0) return ["**Waiting on you — 0**"];
  return [
    `**Waiting on you — ${items.length}**`,
    "",
    ...table(
      ["#", "Project", "Row", "Your step", "Kind", "Waiting"],
      items.map((i, n) => [
        String(n + 1),
        i.p.slug,
        i.more > 0 ? `${i.id} (+${i.more})` : i.id,
        cell(i.what),
        i.kind,
        age(i.since, today),
      ]),
    ),
    "",
    "A row with (+N) stands for N more rows of that project, the same wait or more hands-on steps.",
    "Answer by number: `done`, `unblock`, or `until <date>`.",
  ];
}

// ── main ────────────────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in the local time zone. */
function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

/** Files under projects/ that origin/main changed after this checkout was cut;
 *  0 when there is no origin/main to compare with (a fixture). */
function behindMain(root: string): number {
  const r = spawnSync(
    "git",
    ["-C", root, "diff", "-z", "--name-only", "HEAD...refs/remotes/origin/main", "--", "projects"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return r.status === 0 ? r.stdout.split("\0").filter((s) => s !== "").length : 0;
}

function main(argv: string[]): number {
  const kind = argv[0] as Kind;
  let root = resolve(HERE, "../../../..");
  let today = todayLocal();
  let bad = !KINDS.includes(kind);
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1] ?? "";
    if (argv[i] === "--root" && value !== "") root = resolve(value);
    else if (argv[i] === "--today" && /^\d{4}-\d{2}-\d{2}$/.test(value)) today = value;
    else bad = true;
  }
  if (bad) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const behind = behindMain(root);
  if (behind > 0) {
    process.stderr.write(
      `triage: origin/main changed ${behind} file(s) under projects/ after this worktree was cut — merge origin/main and run again\n`,
    );
    return 2;
  }
  const projects = readProjects(root);
  const owner = ownerName(root);
  const out =
    kind === "blocked"
      ? blocked(root, projects, today, owner)
      : kind === "monitored"
        ? monitored(root, projects, today)
        : mine(root, projects, today, owner);
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(() => {
    try {
      exit(main(process.argv.slice(2)));
    } catch (err) {
      if (err instanceof Exit) throw err;
      process.stderr.write(`triage: ${err instanceof Error ? err.message : String(err)}\n`);
      exit(1);
    }
  });
}
