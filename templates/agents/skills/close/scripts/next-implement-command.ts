#!/usr/bin/env -S node --experimental-strip-types
// next-implement-command.ts — emit the EXACT copy-paste next command(s) for a
// touched project, derived deterministically from project state (the next command
// is DATA, not judgment — deterministic over AI). /close step-5 calls this
// and emits its stdout VERBATIM instead of hand-composing the `/implement`
// argument, which is where the SPEC-name-vs-slug bug lives.
//
// THE BUG THIS PREVENTS: a close emitting `/implement guest-checkout` (the SPEC
// basename) instead of `/implement checkout-flow` (the project slug). `/implement` resolves by PROJECT
// slug and HALTs on a sub-SPEC name. The argument is ALWAYS the project slug;
// Phase 1 auto-resolves the un-reported SPEC itself.
//
// Usage: next-implement-command.ts <project-folder>
//   <project-folder> — repo-relative or absolute path to projects/<domain>/<date>_<slug>/
// Output (stdout): zero or more lines, each a literal next command, e.g.
//   /implement checkout-flow
//   /implement data-move token-refresher                 (sharded → one per shard)
//   /project some-slug                                   (active, no pending SPEC)
//   /implement some-slug r4                              (ROADMAP.md → one per ready row)
// Emits a leading `# ` comment line instead of a command for blocked/monitor/
// completed. For the two finished states that line REPLACES the next-phase
// pointer with the finish itself — `# <slug> — project complete: <## Outcome
// first line>`, or `# <slug> — work complete, monitoring until <date>: <what is
// being watched>` — so a project whose last piece just landed says so rather
// than pointing at a phase that does not exist. A ROADMAP.md row whose spec is
// complete but whose Status is not yet `done` prints `# <slug> <ID>'s spec is
// complete — run /close to flip the row to done` in place of a command.
//
// peers:
//   .agents/skills/close/scripts/next-implement-command.test.ts
//   .agents/skills/close/SKILL.md (step-5-reiterate-implement)

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const err = (msg: string): void => {
  process.stderr.write(`Error: ${msg}\n`);
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Run a sibling TypeScript program; stdout with trailing newlines dropped, as `$(…)` reads it. */
function sibling(script: string, args: string[], stderr: "ignore" | "pipe" = "ignore") {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", stderr],
  });
  return { rc: r.status ?? 1, out: (r.stdout ?? "").replace(/\n+$/, ""), err: r.stderr ?? "" };
}

/** The lines of a file, awk's way: a final newline does not start an empty record. */
function linesOf(text: string): string[] {
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `sed -nE 's/<re>/\1/p' file | head -n1` for an anchored-to-end pattern: the first capture, or "". */
function firstCapture(lines: string[], re: RegExp): string {
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1] ?? "";
  }
  return "";
}

/** `IFS=$'\t' read -r a b … z` — tab is IFS whitespace, so runs of tabs are one separator; the last name takes the rest. */
function readTab(line: string, n: number): string[] {
  let rest = line.replace(/^\t+/, "");
  const out: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const m = /\t+/.exec(rest);
    if (m === null) {
      out.push(rest);
      rest = "";
      continue;
    }
    out.push(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
  }
  out.push(rest.replace(/\t+$/, ""));
  return out;
}
/** Lines of a here-string / process substitution: `<<<""` is one empty line. */
const hereLines = (s: string): string[] => s.split("\n");

// [[:space:]] under the C locales.
const SP = "[ \\t\\n\\r\\f\\v]";
const trim = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.replace(new RegExp(`^${SP}+`), "").replace(new RegExp(`${SP}+$`), ""))
    .join("\n")
    .replace(/\n+$/, "");
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const byCodePoint = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    err("usage: next-implement-command.ts <project-folder>");
    exit(2);
  }
  let projectDir = argv[0] ?? "";

  // A REPO-RELATIVE `projects/...` argument is resolved against the session's
  // write root — the thread's worktree, where this session's own status flips are
  // — not against whichever tree the caller happened to be standing in, which
  // may still hold a shard this session's tree has already marked closed. An
  // absolute path is honoured as given.
  if (!projectDir.startsWith("/") && projectDir.startsWith("projects/")) {
    const swr = `${SCRIPT_DIR}/../../implement/scripts/session-write-root.ts`;
    const root = sibling(swr, ["--no-create"]).out;
    if (root !== "" && isDir(`${root}/${projectDir}`)) projectDir = `${root}/${projectDir}`;
  }
  if (!isDir(projectDir)) {
    err(`not a directory: ${projectDir}`);
    exit(2);
  }

  const readme = `${projectDir}/README.md`;
  if (!isFile(readme)) {
    err(`no README.md in ${projectDir}`);
    exit(2);
  }
  const readmeLines = linesOf(readFileSync(readme, "utf8"));
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  // Slug = folder basename with the leading YYYY-MM-DD_ date prefix stripped.
  const base = projectDir.replace(/\/+$/, "").split("/").pop() ?? "";
  const slug = base.replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}_/, "");

  // Frontmatter status (first `status:` line in the README).
  const status = firstCapture(readmeLines, new RegExp(`^status:${SP}*([a-z]+)`));

  // First non-empty line under a `## <heading>` section, stripped of list markers.
  // Used to carry the project's own words into the finished-project lines below
  // rather than inventing a summary at close time.
  const firstLineUnder = (want: string): string => {
    let inSection = false;
    for (const line of readmeLines) {
      if (new RegExp(`^## +${want}(${SP}|$)`).test(line)) {
        inSection = true;
        continue;
      }
      if (inSection && /^## /.test(line)) return "";
      if (inSection && /[^ \t\n]/.test(line)) {
        return line.replace(new RegExp(`^${SP}*[-*]${SP}+`), "").replace(/\n+$/, "");
      }
    }
    return "";
  };

  switch (status) {
    case "completed": {
      // Finished project — no command, but SAY it finished. Emitting nothing here
      // left the close silent about the one outcome the user most wants stated,
      // and silence is indistinguishable from "the generator did not run".
      const outcome = firstLineUnder("Outcome");
      if (outcome !== "") say(`# ${slug} — project complete: ${outcome}`);
      else say(`# ${slug} — project complete (no ## Outcome section written)`);
      exit(0);
      break;
    }
    case "blocked": {
      let blockedOn = firstCapture(readmeLines, new RegExp(`^blocked-on:${SP}*([^\\n]+)`));
      if (blockedOn.length > 1 && blockedOn.startsWith('"') && blockedOn.endsWith('"'))
        blockedOn = blockedOn.slice(1, -1);
      say(`# ${slug} is blocked — waiting on: ${blockedOn || "(blocked-on not set)"}`);
      exit(0);
      break;
    }
    case "monitor": {
      // `monitoring-until:` is either a bare YYYY-MM-DD or `YYYY-MM-DD — reason`;
      // split so the reason (what is being watched) is stated, not just the date.
      let watch = firstCapture(readmeLines, new RegExp(`^monitoring-until:${SP}*([^\\n]+)`));
      if (watch.endsWith('"')) watch = watch.slice(0, -1);
      if (watch.startsWith('"')) watch = watch.slice(1);
      let untilDate = watch;
      let reason = "";
      for (const sep of ["—", " - "]) {
        const at = watch.indexOf(sep);
        if (at >= 0) {
          untilDate = trim(watch.slice(0, at));
          reason = trim(watch.slice(at + sep.length));
          break;
        }
      }
      if (watch === "") say(`# ${slug} — work complete, monitor window open (monitoring-until not set)`);
      else if (reason !== "") say(`# ${slug} — work complete, monitoring until ${untilDate}: ${reason}`);
      else say(`# ${slug} — work complete, monitoring until ${untilDate} (no command — passive observation)`);
      exit(0);
      break;
    }
  }

  // active (or unrecognized → treat as active): collect SPECs still owed work.
  // WHICH SPECS ARE DONE IS NOT A FILENAME QUESTION — see spec-state.ts, which owns
  // the rule for all three readers. `partial` means a report exists but nobody
  // claimed the SPEC finished, so the work is still owed and saying so is the whole
  // point; `none` means no report at all. Both are pending here.
  const SPEC_STATE = `${SCRIPT_DIR}/spec-state.ts`;
  const unreported: string[] = [];
  const partialSpecs: string[] = [];
  const firstStates = sibling(SPEC_STATE, [projectDir], "pipe");
  process.stderr.write(firstStates.err);
  for (const line of firstStates.out === "" ? [] : hereLines(firstStates.out)) {
    const [name = "", state = ""] = readTab(line, 3);
    if (name === "") continue;
    if (state === "none") unreported.push(name);
    else if (state === "partial") {
      unreported.push(name);
      partialSpecs.push(name);
    }
  }

  // ── ROADMAP.md: one command per ready row ────────────────────────────────
  //
  // A spec-kit project's rows carry their own dependencies, so unlike the shard
  // table below this CAN say which work may start now: every ready row (the README
  // template's Ready rule, applied by roadmap.ts — never re-derived here) whose
  // spec is still owed work is its own `/implement <slug> <id>`, and those lines
  // are the parallel set the close prints as separate copyable blocks. Ready rows
  // with no spec yet, or a spec with open NEEDS CLARIFICATION markers, need a
  // planning session: ONE `/project <slug>` covers them all, because /project picks
  // the row. A legacy loose SPEC that no row points at is work already in flight
  // and prints first, as the bare `/implement <slug>` it always was.
  if (isFile(`${projectDir}/ROADMAP.md`)) {
    const rm = sibling(`${SCRIPT_DIR}/roadmap.ts`, [projectDir], "pipe");
    if (rm.rc !== 0) {
      const msgs = rm.err
        .split("\n")
        .filter((l) => l.startsWith("roadmap: "))
        .map((l) => l.slice("roadmap: ".length));
      const msg = msgs[msgs.length - 1] ?? "";
      say(`# ${slug} ROADMAP.md is malformed: ${msg || `roadmap.ts exited ${rm.rc}`}`);
      exit(0);
    }
    const rows = rm.out;
    // `states="$(spec-state.ts …)"` under `set -e`: a failure ends the script with its status.
    const st = sibling(SPEC_STATE, [projectDir], "pipe");
    process.stderr.write(st.err);
    if (st.rc !== 0) exit(st.rc);
    const stateOf = (n: string): string => {
      for (const l of hereLines(st.out)) {
        const f = l.split("\t");
        if (f[0] === n) return f[1] ?? "";
      }
      return "";
    };
    const referenced = hereLines(rows).map((l) => (l.includes("\t") ? (l.split("\t")[3] ?? "") : l));
    const out: string[] = [];
    for (const u of unreported) {
      if (u.startsWith("specs/")) continue;
      if (referenced.includes(u)) continue;
      out.push(`/implement ${slug}`);
      break;
    }
    let needsPlanning = false;
    const comments: string[] = [];
    const rowFields = hereLines(rows).map((l) => l.split("\t"));
    const ordered = [
      ...rowFields.filter((f) => f[2] === "yes" && lowerAscii(f[1] ?? "") === "in-progress"),
      ...rowFields.filter((f) => f[2] === "yes" && lowerAscii(f[1] ?? "") === "planned"),
    ].map((f) => f.join("\t"));
    for (const line of ordered.length === 0 ? [""] : ordered) {
      const [id = "", , , sub = ""] = readTab(line, 5);
      if (id === "") continue;
      if (sub === "—") {
        needsPlanning = true;
        continue;
      }
      const s = stateOf(sub);
      // Awaiting /close's `done` flip: say so, rather than fall through to a
      // `/project` for a row whose work is finished.
      if (s === "complete") {
        comments.push(`# ${slug} ${id}'s spec is complete — run /close to flip the row to done`);
        continue;
      }
      if (s !== "none" && s !== "partial") {
        needsPlanning = true; // the Sub-spec it names is not on disk
        continue;
      }
      if (
        sub.startsWith("specs/") &&
        sibling(`${SCRIPT_DIR}/open-clarifications.ts`, [`${projectDir}/${sub}`]).rc !== 0
      ) {
        needsPlanning = true;
        continue;
      }
      out.push(`/implement ${slug} ${lowerAscii(id)}`);
    }
    if (needsPlanning) out.push(`/project ${slug}`);
    for (const line of hereLines(rows)) {
      const [id = "", st2 = "", ready = ""] = readTab(line, 5);
      if (!(id !== "" && ready === "no")) continue;
      const lower = lowerAscii(st2);
      if (lower.startsWith("blocked:")) comments.push(`# ${slug} ${id} is ${st2}`);
      else if (
        lower === "planned" ||
        lower === "in-progress" ||
        lower === "done" ||
        lower.startsWith("absorbed by ") ||
        lower.startsWith("closed:")
      ) {
        // in the vocabulary, and not ready for a reason the table states
      } else comments.push(`# ${slug} ${id} has a Status outside the vocabulary: ${st2}`);
    }
    if (out.length === 0 && comments.length === 0) out.push(`/project ${slug}`);
    process.stdout.write([...out, ...comments].map((l) => `${l}\n`).join(""));
    exit(0);
  }

  // Sharded project? The opt-in signal is a `## Shard Status` table — the legacy
  // layout, still read; the rule today is the README
  // template's derivation rule (.agents/skills/project/references/templates/README.md,
  // the <!-- --> block). When present, each <shard>.spec.md is a shard and
  // the command is `/implement <slug> <shard>`; otherwise the command is the bare
  // `/implement <slug>` (Phase 1 auto-resolves the single un-reported SPEC, or
  // AskUserQuestion-disambiguates if several — the argument stays the slug).
  const isSharded = readmeLines.some((l) => /^## +Shard Status/.test(l));

  // ── The shard table's State column, which is the SSOT ────────────────────────
  //
  // WHY THIS EXISTS. The report-presence heuristic below is wrong for a sharded
  // project the moment one shard is part-done: an `in-flight` shard with task
  // reports written reads as "has a report", so it drops out of the queue and the
  // `planned` ones are offered instead — including ones the project's own decided
  // order says cannot start until the in-flight shard finishes.
  //
  // In the legacy layout the table is the SSOT for which shards exist and what
  // state each is in, so read THAT: an `in-flight` shard is the work in
  // motion and comes first, exclusively. `planned` shards are only offered when
  // nothing is in flight. `reported` and `closed` are done. A `blocked` shard is
  // named either way, because it is waiting on something a human clears.
  //
  // (A ROADMAP.md project never reaches this table — its rows declare their
  // dependencies and are read above. What follows is the legacy shard layout.)
  //
  // Ordering BETWEEN planned shards is deliberately not attempted here: it lives
  // in each project's own prose (a decided order, a dependency column) and
  // guessing it from a table would be exactly the judgment this script must not
  // make. What the state column CAN say is which
  // shard is already underway, and that is enough to stop offering a later one.
  let shardRowsSeen = false;
  const inflight: string[] = [];
  const planned: string[] = [];
  const blockedShards: string[] = [];
  if (isSharded) {
    let inTable = false;
    for (const line of readmeLines) {
      if (/^## +Shard Status/.test(line)) {
        inTable = true;
        continue;
      }
      if (inTable && /^## /.test(line)) break;
      if (!(inTable && /^\|/.test(line))) continue;
      // Skip the header row and the |---| separator.
      if (/\| *Shard *\|/.test(line)) continue;
      if (/^\|[ :-]*\|/.test(line)) continue;
      const cell = line.split("|");
      const n = cell.length;
      if (n < 4) continue;
      const name = (cell[1] ?? "").replace(/[` ]/g, "");
      const state = (cell[n - 2] ?? "").replace(/[` ]/g, "");
      if (name === "" || state === "") continue;
      shardRowsSeen = true;
      if (state === "in-flight") inflight.push(name);
      else if (state === "planned") planned.push(name);
      else if (state === "blocked") blockedShards.push(name);
    }
  }

  const blockedLine = (shard: string): string => `# ${slug} ${shard} is blocked — see its row in ## Shard Status`;
  if (shardRowsSeen) {
    const nextShards = inflight.length > 0 ? inflight : planned;
    if (nextShards.length > 0) {
      for (const shard of [...nextShards].sort(byCodePoint)) say(`/implement ${slug} ${shard}`);
      for (const shard of blockedShards) say(blockedLine(shard));
      exit(0);
    }
    if (blockedShards.length > 0) {
      for (const shard of blockedShards) say(blockedLine(shard));
      exit(0);
    }
    // Every shard reported or closed → the project needs its next phase decided.
    say(`/project ${slug}`);
    exit(0);
  }

  if (unreported.length > 0) {
    if (isSharded) {
      // One line per pending shard (sorted for stable output).
      for (const shard of [...unreported].sort(byCodePoint)) say(`/implement ${slug} ${shard}`);
    } else {
      // Non-sharded: ALWAYS the bare project slug, never the SPEC basename.
      say(`/implement ${slug}`);
    }
    for (const p of partialSpecs) {
      say(`# ${slug} ${p} is reported but not claimed complete — see its report Status line`);
    }
    exit(0);
  }

  // No pending SPEC but the project is active → the next phase needs a SPEC; the
  // /project router stage-detects and runs the next-phase think flow.
  say(`/project ${slug}`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
