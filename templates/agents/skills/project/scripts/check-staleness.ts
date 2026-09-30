#!/usr/bin/env -S node --experimental-strip-types
// check-staleness.ts
//
// Two independent "this project needs a decision" scans over projects/*/*/.
//
//   1. STALE   — active/blocked/monitor project with no journal mention in the
//                last N days (default 14). Optional; fire when the user asks
//                "anything I'm forgetting?".
//   2. EXPIRED — monitor project whose `monitoring-until:` date has already
//                passed. Fires on every blank-mode /project via
//                `step-0.5-render-index`.
//
// The two answer different questions and a project can trip either alone: a
// monitor window can lapse while the project is still being mentioned daily,
// and a stale project can sit well inside its window.
//
// WHY EXPIRED EXISTS: a monitor window that lapses silently is a decision
// nobody made — the project stops being watched, the defects the window was
// there to catch go unnoticed, and nothing says so. Lapsed windows pile up
// unless something prints them.
//
// Deterministic — filesystem + frontmatter + journal grep, no AI.
//
// Usage:
//   check-staleness.ts                # both scans, 14-day staleness cutoff
//   check-staleness.ts [days]         # both scans, custom staleness cutoff
//   check-staleness.ts --expired-only # frontmatter only, no journal grep
//
// Output (zero or more lines to stdout):
//   STALE:<domain>/<slug>:days-since-last-mention=<N|never>
//   EXPIRED:<domain>/<slug>:monitoring-until=<YYYY-MM-DD>:days-overdue=<N>
//   NOWINDOW:<domain>/<slug>            # status: monitor, no parseable date
//
// Output is empty if nothing is flagged. Exit code: 0 always (1 only when the
// write root cannot be resolved).
//
// PERFORMANCE — why frontmatter is read in ONE pass, not per-project children.
// `--expired-only` runs on every blank-mode /project, in front of the user, so
// it is on the interactive path. Shelling out per project (basename x2, awk,
// sed, grep, date) costs seconds across a few hundred projects — slower than
// the full journal-grep scan it is supposed to be a fast subset of. One pass
// over the frontmatter costs about a tenth of a second. Keep it that way: no
// child process inside the per-project loop. The journal is read once
// and every project's mention search runs over that one in-memory copy, where
// the bash original ran one `grep -r` per project.
//
// Dates are compared in the machine's local timezone, so a window does not
// read as lapsed for the last hours of its final day. A window whose date IS
// today is NOT overdue — the day is still being watched. Day counts round to
// the nearest day, so a daylight-saving hour does not turn 10 days into 9.
//
// peers:
//   .agents/skills/project/scripts/check-staleness.test.ts
//   .agents/skills/project/SKILL.md  (step-0.5-render-index + scripts table)

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * THE WRITE ROOT. This script reads projects and journals with repo-relative
 * paths, so it runs FROM the root the session resolves — the thread's worktree,
 * else the checkout it lives in — never from whichever cwd invoked it, because a
 * wrong cwd here reports "no projects" rather than failing.
 */
function enterWriteRoot(): void {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "../../implement/scripts/session-write-root.ts")],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (r.status !== 0) exit(1);
  const root = (r.stdout ?? "").replace(/\n+$/, "");
  if (root === "") return; // `cd ""` is a no-op in bash
  try {
    process.chdir(root);
  } catch {
    process.stderr.write(`check-staleness: cd: ${root}: No such file or directory\n`);
    exit(1);
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Epoch seconds of local (TZ) midnight on YYYY-MM-DD — `date -d <day> +%s` —
 *  or null for a day `date` rejects (2026-13-45, 2026-02-30). */
function dayEpoch(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(y, mo - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null;
  return Math.floor(t.getTime() / 1000);
}

/** Every `projects/*\/*\/README.md`, in glob order. */
function readmes(): string[] {
  const out: string[] = [];
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p).filter((n) => !n.startsWith("."));
    } catch {
      return [];
    }
  };
  for (const a of dirs("projects")) {
    for (const b of dirs(`projects/${a}`)) {
      const f = `projects/${a}/${b}/README.md`;
      try {
        statSync(f);
        out.push(f);
      } catch {
        // not there: the glob would not have named it
      }
    }
  }
  return out.sort();
}

interface Row {
  readme: string;
  status: string;
  untilRaw: string;
}

/**
 * One pass over every project README: `path, status, until-value`.
 * Frontmatter ONLY — the body quotes `monitoring-until:` when narrating a lapse
 * (a lapse note in the body often does), and a prose mention is not a field.
 * The frontmatter is the block between a first line of exactly `---` and the
 * next `---`; `status` is the value's first whitespace-separated word (awk's
 * `$2`); the first `status:` and `monitoring-until:` lines win.
 */
function scanFrontmatter(): Row[] {
  const rows: Row[] = [];
  for (const file of readmes()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text === "") continue; // awk never sees a first record of an empty file
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    let status = "";
    let until = "";
    let infm = lines[0] === "---";
    for (const line of lines.slice(1)) {
      if (!infm) break;
      if (line === "---") {
        infm = false;
        continue;
      }
      if (/^status:[ \t]/.test(line) && status === "") status = line.split(/[ \t]+/)[1] ?? "";
      if (/^monitoring-until:[ \t]/.test(line) && until === "") until = line.replace(/^monitoring-until:[ \t]*/, "");
    }
    // The bash original read these rows back with `IFS=$'\t' read`, where a tab
    // is whitespace: an empty status collapsed its field and the until-value
    // moved into it. Kept, so a project reads the same.
    if (status === "") {
      status = until.replace(/^[\t]+|[\t]+$/g, "");
      until = "";
    }
    rows.push({ readme: file, status, untilRaw: until.replace(/\t+$/, "") });
  }
  return rows;
}

/** Every file under journal/, recursively, with its text — read once. */
function journalFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}${e.name}`;
      if (e.isDirectory()) walk(`${p}/`);
      else if (e.isFile()) {
        try {
          out.push({ path: p, text: readFileSync(p, "utf8") });
        } catch {
          // unreadable: grep -s would have skipped it too
        }
      }
    }
  };
  walk("journal/");
  return out;
}

async function main(): Promise<void> {
  enterWriteRoot();

  let RUN_STALE = true;
  let DAYS = "14";
  const arg = process.argv[2] ?? "";
  if (arg === "--expired-only") RUN_STALE = false;
  else if (arg !== "") DAYS = arg;

  // `date -d "<N> days ago"`: N calendar days back, same time of day. A value
  // `date` cannot read leaves the cutoff empty, as it did in bash: nothing then
  // sorts before it, so only `never` rows print.
  let CUTOFF_DATE = "";
  if (/^[+-]?\d+$/.test(DAYS)) {
    const c = new Date();
    c.setDate(c.getDate() - Number(DAYS));
    CUTOFF_DATE = ymd(c);
  }
  const TODAY = ymd(new Date());
  const TODAY_EPOCH = dayEpoch(TODAY) ?? 0;

  let journal: { path: string; text: string }[] | null = null;

  for (const { readme, status, untilRaw } of scanFrontmatter()) {
    if (status !== "active" && status !== "blocked" && status !== "monitor") continue;

    const dir = readme.slice(0, -"/README.md".length);
    const slug = dir.slice(dir.lastIndexOf("/") + 1).replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}_/, "");
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    const domain = parent.slice(parent.lastIndexOf("/") + 1);

    // --- EXPIRED (monitor only) ---
    if (status === "monitor") {
      // Value shapes in the wild: a bare date; `2026-01-05 — trailing prose`; and
      // `"2026-01-27 — prose containing colons and quotes"`. Take the leading ISO
      // date and ignore the rest.
      let untilDate = untilRaw.replace(/^"/, "").replace(/^'/, "");
      untilDate = [...untilDate].slice(0, 10).join("");
      // Shape is right; the calendar still rejects an impossible day (2026-13-45).
      const untilEpoch = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(untilDate) ? dayEpoch(untilDate) : null;

      if (untilEpoch === null) {
        process.stdout.write(`NOWINDOW:${domain}/${slug}\n`);
      } else if (untilDate < TODAY) {
        process.stdout.write(
          `EXPIRED:${domain}/${slug}:monitoring-until=${untilDate}:days-overdue=${Math.trunc((TODAY_EPOCH - untilEpoch + 43200) / 86400)}\n`,
        );
      }
    }

    if (!RUN_STALE) continue;

    // --- STALE (active/blocked/monitor) ---
    // The boundary is hand-rolled, not `\b`: a journal almost always names a
    // project by its FOLDER (`projects/web/2026-01-10_checkout-flow/`), and
    // `_` is a word character, so `\bcheckout-flow` never matches there — the
    // scan would report `never` for a project written up the day before.
    // Excluding `-` on both sides keeps a slug from matching a longer one that
    // merely contains it.
    // A DAY IS A FOLDER, `journal/<date>/<HHMM>-<slug>.md`, so the scan recurses
    // and the date comes from the FOLDER name rather than the file's.
    journal ??= journalFiles();
    let re: RegExp | null;
    try {
      re = new RegExp(`(^|[^A-Za-z0-9-])${slug}([^A-Za-z0-9-]|$)`, "m");
    } catch {
      re = null; // grep refused the pattern: no file listed
    }
    let latestMention = "";
    if (re) {
      for (const { path, text } of journal) {
        const m = /^journal\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/.*/.exec(path);
        if (!m?.[1] || m[1] <= latestMention) continue;
        if (re.test(text)) latestMention = m[1];
      }
    }

    if (latestMention === "") {
      process.stdout.write(`STALE:${domain}/${slug}:days-since-last-mention=never\n`);
      continue;
    }

    // Compare date strings (YYYY-MM-DD sorts lexicographically)
    if (latestMention < CUTOFF_DATE) {
      const mentionEpoch = dayEpoch(latestMention);
      if (mentionEpoch === null) {
        // bash died on the arithmetic here; say so and move on.
        process.stderr.write(`check-staleness: not a date: journal/${latestMention}/\n`);
        continue;
      }
      process.stdout.write(
        `STALE:${domain}/${slug}:days-since-last-mention=${Math.trunc((TODAY_EPOCH - mentionEpoch + 43200) / 86400)}\n`,
      );
    }
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
