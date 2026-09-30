#!/usr/bin/env -S node --experimental-strip-types
// project-remaining-work.ts — emit the HARD signals of unfinished work in a
// project, so /close step-2.1 can decide whether the project just finished.
// Counting files and table rows is DATA, not judgment;
// the judgment left to the agent is only "does the remaining Next Steps prose
// describe real work, and does the shipped thing need a watch window?".
//
// Usage: project-remaining-work.ts <project-folder>
//   <project-folder> — repo-relative or absolute path to projects/<domain>/<date>_<slug>/
//
// Output (stdout), key: value lines:
//   status: active|blocked|monitor|completed|         (frontmatter, empty if absent)
//   spec: <name> none|partial (<evidence>)            (one line per SPEC still owed work,
//                                                      per spec-state.ts; printed before the count)
//   unreported_specs: N                               (how many such SPECs)
//   spec-state-error: spec-state.ts exited N          (the SPEC scan failed; work-remains)
//   shard_table: yes|no                               (## Shard Status present)
//   shard_open: N                                     (rows whose State cell is not closed)
//   shard: <name> <state>                             (one line per open shard row)
//   next_steps_section: yes|no                        (always no on a ROADMAP.md project)
//   next_steps_unchecked: N                           (`- [ ]` under ## Next Steps)
//   todo: <text>                                      (one line per unchecked box)
//   next_steps_unparsed: N                            (list items that are NOT checkboxes)
//   unparsed: <text>                                  (one line per such item)
//   roadmap_table: yes                                (ROADMAP.md present — these three
//   roadmap_open: N                                    lines appear ONLY then, so a legacy
//   roadmap: <ID> <status>                             project's output is unchanged; one
//                                                      `roadmap:` per row not done/absorbed)
//   roadmap-error: <message>                          (ROADMAP.md malformed; work-remains)
//   verdict: work-remains|no-hard-signal
//
// `verdict: no-hard-signal` does NOT mean "the project is done" — it means
// nothing countable is outstanding, so the completion call is now the agent's to
// make by reading the README goal against whatever prose sits in Next Steps
// (numbered backlogs carry no done-state and cannot be counted). `work-remains`
// is the deterministic veto: never flip a project holding one.
//
// peers:
//   .agents/skills/close/scripts/project-remaining-work.test.ts
//   .agents/skills/close/scripts/next-implement-command.ts
//   .agents/skills/close/SKILL.md (step-2.1-project-completion)

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const err = (msg: string): void => {
  process.stderr.write(`Error: ${msg}\n`);
};
// [[:space:]] under the C locales.
const SP = "[ \\t\\n\\r\\f\\v]";
const trim = (s: string): string => s.replace(new RegExp(`^${SP}+`), "").replace(new RegExp(`${SP}+$`), "");
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
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
function sibling(script: string, args: string[], stderr: "ignore" | "pipe") {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", stderr],
  });
  return { rc: r.status ?? 1, out: (r.stdout ?? "").replace(/\n+$/, ""), err: r.stderr ?? "" };
}

/** `IFS=$'\t' read -r a b … z` — runs of tabs are one separator; the last name takes the rest. */
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

/** `IFS='|' read -r -a cells` — each `|` ends a field, and one at the very end makes no empty field after it. */
function readPipes(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("|");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    err("usage: project-remaining-work.ts <project-folder>");
    exit(2);
  }
  let projectDir = argv[0] ?? "";

  // A REPO-RELATIVE `projects/...` argument is resolved against the session's
  // write root — the thread's worktree, where this session's own status flips are
  // — not against whichever tree the caller happened to be standing in, which
  // may still hold a shard this session's tree has already marked closed. An
  // absolute path is honoured as given.
  if (!projectDir.startsWith("/") && projectDir.startsWith("projects/")) {
    const root = sibling(`${SCRIPT_DIR}/../../implement/scripts/session-write-root.ts`, [], "ignore").out;
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
  const readmeText = readFileSync(readme, "utf8");
  const lines = readmeText === "" ? [] : readmeText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let out = "";
  const say = (line: string): void => {
    out += `${line}\n`;
  };
  // Printed as it goes in the original, and stderr interleaves with it there:
  // flush before anything that writes to stderr.
  const flush = (): void => {
    process.stdout.write(out);
    out = "";
  };
  let remains = false;

  // ── Frontmatter status ─────────────────────────────────────────────────
  let status = "";
  for (const l of lines) {
    const m = new RegExp(`^status:${SP}*([a-z]+)`).exec(l);
    if (m) {
      status = m[1] ?? "";
      break;
    }
  }
  say(`status: ${status}`);

  // ── Un-reported SPECs ──────────────────────────────────────────────────
  // spec-state.ts owns the rule for what "reported" means — a SPEC whose report is
  // named for the slice it covered rather than the SPEC, or whose report never
  // claimed completion, is exactly the loose end this is supposed to surface.
  const specs: string[] = [];
  const ss = sibling(`${SCRIPT_DIR}/spec-state.ts`, [projectDir], "pipe");
  flush();
  process.stderr.write(ss.err);
  for (const line of ss.out === "" ? [] : ss.out.split("\n")) {
    const [name = "", state = "", evidence = ""] = readTab(line, 3);
    if (name === "") continue;
    if (state === "none") {
      specs.push(name);
      say(`spec: ${name} none`);
    } else if (state === "partial") {
      specs.push(name);
      say(`spec: ${name} partial (${evidence})`);
    }
  }

  say(`unreported_specs: ${specs.length}`);
  if (specs.length > 0) remains = true;
  // A scanner that failed has not said every SPEC is reported: a veto that
  // resolved its crash toward "nothing unreported" would flip the project done.
  if (ss.rc !== 0) {
    say(`spec-state-error: spec-state.ts exited ${ss.rc}`);
    remains = true;
  }

  // ── Shard table rows not yet closed ────────────────────────────────────
  // The State cell is the LAST non-empty column of each `| ... |` row under
  // ## Shard Status. A shard counts as done only when that cell reads closed/
  // done/complete(d)/shipped/dropped; anything else (in-flight, pending,
  // blocked, —) is open.
  const shardRows: string[] = [];
  if (lines.some((l) => /^## +Shard Status/.test(l))) {
    say("shard_table: yes");
    let inSection = false;
    for (const l of lines) {
      if (/^## +Shard Status/.test(l)) {
        inSection = true;
        continue;
      }
      if (inSection && /^## /.test(l)) inSection = false;
      if (inSection && /^\|/.test(l)) shardRows.push(l);
    }
  } else {
    say("shard_table: no");
  }

  const openShards: string[] = [];
  for (const row of shardRows) {
    if (row === "") continue;
    // Skip the |---|---| separator and the header row.
    if (new RegExp(`^\\|${SP}*:?-+`).test(row)) continue;
    if (new RegExp(`^\\|${SP}*Shard${SP}*\\|`).test(row)) continue;
    // Split on |, trim; first cell = shard name, last non-empty = state.
    const cells = readPipes(row.startsWith("|") ? row.slice(1) : row);
    if (cells.length < 2) continue;
    let name = trim(cells[0] ?? "");
    if (name.startsWith("`")) name = name.slice(1);
    if (name.endsWith("`")) name = name.slice(0, -1);
    let state = "";
    for (let i = cells.length - 1; i >= 0; i--) {
      const candidate = trim(cells[i] ?? "");
      if (candidate !== "") {
        state = candidate;
        break;
      }
    }
    if (name === "") continue;
    switch (lowerAscii(state)) {
      // `state` is the header row's own last cell — matched case-insensitively
      // so a lowercase `| shard | ... | state |` header is not read as an open
      // shard named "shard".
      case "state":
      case "closed":
      case "done":
      case "complete":
      case "completed":
      case "shipped":
      case "dropped":
        break;
      default:
        openShards.push(`${name} ${state}`);
    }
  }

  say(`shard_open: ${openShards.length}`);
  for (const row of openShards) say(`shard: ${row}`);
  if (openShards.length > 0) remains = true;

  // ── Remaining work under ## Next Steps ─────────────────────────────────
  //
  // TWO counts, not one, and the second exists because counting only unchecked boxes
  // silently misses real work: a backlog written as a numbered or bulleted list, or under
  // the heading "## Next steps" with a lowercase s, would report `next_steps_section: no`
  // and `verdict: no-hard-signal` — indistinguishable, to a caller, from a project with an
  // empty backlog.
  //
  // The heading match is case-insensitive, and a list item that is not an unchecked box
  // is counted as UNPARSED rather than ignored. Unparsed items still set `work-remains`:
  // this script is the deterministic VETO, and a veto that resolves ambiguity toward
  // "nothing left" is the wrong direction for a gate whose whole job is refusing to close
  // a project with work in it. A checked box (`- [x]`) is done and counts as neither.
  //
  // A project WITH ROADMAP.md is read from its rows alone (below): the roadmap is
  // its one list of outstanding work, and a leftover README list must not hold it
  // open. Its section is reported as absent.
  const todos: string[] = [];
  const unparsed: string[] = [];
  const hasRoadmap = isFile(`${projectDir}/ROADMAP.md`);
  if (!hasRoadmap && lines.some((l) => /^## +next steps/i.test(l))) {
    say("next_steps_section: yes");
    let inSection = false;
    const box = new RegExp(`^${SP}*[-*+] \\[ \\]`);
    const boxPrefix = new RegExp(`^${SP}*[-*+] \\[ \\]${SP}*`);
    const done = new RegExp(`^${SP}*[-*+] \\[[xX]\\]`);
    // All three bullet markers, in the unchecked rule and the checked one. Markdown
    // allows `-`, `*` and `+` interchangeably, and recognizing only two of them means
    // a `+ [ ]` is not a checkbox to this scanner. That was survivable while the
    // unparsed rule scanned every indent (it caught the item as backlog either way),
    // but narrowing unparsed to column zero re-opened it for NESTED `+` boxes, which
    // would then be counted as nothing at all.
    //
    // Any other TOP-LEVEL list item — numbered, lettered in either case, or a plain
    // bullet — is real backlog the counters cannot read a done-state from. Named, not
    // dropped. `[A-Za-z]`, not `[a-z]`: an "A. …" list is the same backlog as an "a. …"
    // one, and matching only one case is how the checkbox-only version missed work.
    //
    // UNINDENTED only, and that is the guard against the opposite failure. An indented
    // item is a CHILD — most often explanatory sub-bullets under a `- [x]` that is
    // already done — and counting those would pin a finished checklist `work-remains`
    // forever, which is the same defect as under-counting pointed the other way. An
    // unchecked `- [ ]` still counts at ANY depth, because a box is an explicit
    // done-state and a nested one is still open work.
    const item = new RegExp(`^([0-9]+[.)]|[A-Za-z][.)]|[-*+])${SP}+`);
    for (const l of lines) {
      if (/^## +next steps/.test(l.toLowerCase())) {
        inSection = true;
        continue;
      }
      if (inSection && /^## /.test(l)) inSection = false;
      if (!inSection) continue;
      if (box.test(l)) {
        todos.push(l.replace(boxPrefix, ""));
        continue;
      }
      // A completed box is done: neither a todo nor unparsed.
      if (done.test(l)) continue;
      if (item.test(l)) {
        const text = l.replace(item, "");
        if (text !== "") unparsed.push(text);
      }
    }
  } else {
    say("next_steps_section: no");
  }

  // Counted and printed as `grep -c .` and `[[ -n "$line" ]]` read them: an
  // empty box text is neither a todo line nor a count. `$(…)` also dropped the
  // trailing empty ones before the count.
  const todoLines = todos.filter((t) => t !== "");
  say(`next_steps_unchecked: ${todoLines.length}`);
  for (const t of todoLines) say(`todo: ${t}`);
  say(`next_steps_unparsed: ${unparsed.length}`);
  for (const u of unparsed) say(`unparsed: ${u}`);
  if (unparsed.length > 0) remains = true;
  if (todoLines.length > 0) remains = true;

  // ── ROADMAP.md rows not done ───────────────────────────────────────────
  // On a spec-kit project the roadmap is the ONE list of outstanding work
  // (project/references/templates/ROADMAP.md), read through roadmap.ts so this
  // cannot disagree with detect-stage.ts or next-implement-command.ts about the
  // table. Every row that is not `done` or `absorbed by …` is open — a `blocked:`
  // watch included, since a watch is exactly what must keep a project from
  // closing. A table roadmap.ts cannot read is also work-remains: a veto that
  // resolves a parse failure toward "nothing left" would flip the project done.
  if (hasRoadmap) {
    say("roadmap_table: yes");
    const rm = sibling(`${SCRIPT_DIR}/roadmap.ts`, [projectDir], "pipe");
    if (rm.rc !== 0) {
      const msgs = rm.err
        .split("\n")
        .filter((l) => l.startsWith("roadmap: "))
        .map((l) => l.slice("roadmap: ".length));
      const msg = msgs[msgs.length - 1] ?? "";
      say("roadmap_open: 0");
      say(`roadmap-error: ${msg || `roadmap.ts exited ${rm.rc}`}`);
      remains = true;
    } else {
      flush();
      process.stderr.write(rm.err);
      const openRows: string[] = [];
      for (const l of rm.out.split("\n")) {
        const f = l.split("\t");
        if ((f[0] ?? "") === "") continue;
        const s = lowerAscii(f[1] ?? "");
        if (s === "done" || /^absorbed by /.test(s)) continue;
        openRows.push(`${f[0]} ${f[1] ?? ""}`);
      }
      say(`roadmap_open: ${openRows.length}`);
      for (const r of openRows) say(`roadmap: ${r}`);
      if (openRows.length > 0) remains = true;
    }
  }

  say(remains ? "verdict: work-remains" : "verdict: no-hard-signal");
  flush();
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
