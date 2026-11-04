#!/usr/bin/env -S node --experimental-strip-types
// check-roadmap-decisions.ts — refuse a close that leaves anything open in a
// ROADMAP row or a spec report it adds or changes.
//
// WHY. A close means the work is done: anything still open keeps the session
// open. A close that printed what was open and landed anyway let work ride out
// unfinished: a row added as "blocked: the user rules whether the contrast fixes
// extend past the first seven pages", with the question left at the bottom of
// the reply, or a report reading "Not done, waiting on the user".
//
// WHAT "OPEN" MEANS is defined once, in close/references/auto-close-gate.md
// precondition (iii); this script implements the roadmap and report half, and
// check-journal-entry.ts F12 the journal half.
//
// ROWS. Every row of a changed `projects/**/ROADMAP.md` that is new, or whose
// Status, Sub-spec or Depends on cell differs from the merge base's copy, is
// judged; a row the push left alone in those three cells is not, so a reworded
// Intent and another session's rows never hold this close. A judged row passes
// when it is `done`, `closed: …` or `absorbed by …`; `planned` and not
// `manual`, its spec written or not yet; `planned` and `manual` while a row
// its Depends on names, here or in another project, is open; or a
// `blocked:` watch whose leading date
// (roadmap.ts watchDate), or a `blocked: until` wait whose release date
// (roadmap.ts releaseDate), is today or later in local time. Anything else holds:
// a Depends on entry naming no row; a ready `manual` step not set aside
// `blocked: until <date>`, or a wait that names
// the user (waiting on the user, whatever its date),
// `in-progress` (half-built), a wait with no date or a past one, an unknown status. A `blocked:` status worded as the user's
// decision (open-decision.ts, the words F9 uses) is refused with that wording
// first, and not printed a second time.
//
// SPEC REPORTS. A `projects/**/specs/*/report.md` this branch changed is read
// for lines it ADDS that leave something waiting on the user
// (open-decision.ts parkedOnUser); a line the report already held is left
// alone. And a report spec-state.ts reads as `partial` holds the close unless
// the row naming its spec is `closed: …` or `absorbed by …`.
//
// Rows are read with roadmap.ts's listRows, the table's one parser, once over
// the working tree (each Depends on entry resolved) and once over the merge
// base's copy (cells only); a report's state with spec-state.ts.
//
// Usage:
//   check-roadmap-decisions.ts --since <ref>   the ROADMAP.md and report.md files
//                                              changed since this branch left
//                                              <ref> (merge-base diff, uncommitted
//                                              edits and untracked files), from
//                                              the cwd
//
// Output (stdout): `N roadmaps checked, M open decisions`,
//                  `R rows added or changed, O left open`,
//                  `U roadmaps unreadable` (changed, on disk, and refused by
//                  roadmap.ts's parser — each holds the close; a deleted one
//                  is neither checked nor unreadable),
//                  `K reports checked, J parked lines`, `P reports partial`.
// Output (stderr): one line per refusal — `<roadmap>: <ID> "<status>": …`,
//                  `<roadmap>: roadmap.ts cannot read it — <why>; …`,
//                  `<roadmap>: <ID> "<status>" (Sub-spec <s>): …`,
//                  `<report>:<line>: "<words>": …` or `<report>: reads partial, …`.
//
// peers:
//   .agents/skills/close/references/auto-close-gate.md  (what "open" means)
//   .agents/skills/close/scripts/open-decision.ts       (the words)
//   .agents/skills/close/scripts/check-journal-entry.ts (F9, F12, the journal's half)
//   .agents/skills/close/scripts/roadmap.ts             (the parser, watchDate, releaseDate)
//   .agents/skills/close/scripts/spec-state.ts          (a report's state)
//   .agents/skills/close/scripts/land.ts                (the gate that calls it)
//
// Exit: 0 clean · 1 one or more open items or unreadable roadmaps · 2 caller
// error, a git listing that failed, or a sibling script that could not run

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { namesUser, openDecisionWord, parkedOnUser } from "./open-decision.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { type DepResult, listRows, releaseDate, watchDate } from "./roadmap.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_STATE_TS = join(HERE, "spec-state.ts");

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

type Row = { status: string; sub: string; dependsOn: string; deps: DepResult[] };

/** ID → Status, Sub-spec, the raw Depends on cell and each entry resolved, read
 *  by roadmap.ts's listRows from `ROADMAP.md` — or from `given`, a committed
 *  copy, whose entries are then left unresolved: only its cells are compared.
 *  A table the parser refuses is its messages, joined, instead. */
function readRows(roadmap: string, given?: Buffer): Map<string, Row> | string {
  const r = listRows(roadmap, given, given === undefined ? {} : { projectsRoot: null });
  if (!r.ok) return r.messages.join("; ").trim() || "roadmap.ts gave no reason";
  const rows = new Map<string, Row>();
  r.rows.forEach(([id, status, , sub], i) => {
    if (id && status !== undefined)
      rows.set(id, { status, sub: sub ?? "—", dependsOn: r.dependsOn[i] ?? "", deps: r.deps[i] ?? [] });
  });
  return rows;
}

/** The rows, or null where the parser refused the table. */
function statuses(roadmap: string, given?: Buffer): Map<string, Row> | null {
  const r = readRows(roadmap, given);
  return typeof r === "string" ? null : r;
}

/** Why a judged row holds the close and what clears it, or null when it may
 *  ride (auto-close-gate.md precondition (iii)). `today` is the local date. */
function openKind({ status, sub, deps }: Row, today: string): string | null {
  const s = status.toLowerCase();
  if (s === "done" || /^closed:/.test(s) || /^absorbed by /.test(s)) return null;
  // A Depends on entry that names nothing never reads as a wait.
  const unresolved = deps.filter((x) => x.state === "unresolved").map((x) => x.text);
  if (unresolved.length > 0) {
    return `depends on ${unresolved.join(", ")}, which names no row — fix its Depends on`;
  }
  // A step for the user that cannot start yet — a row it depends on, here or
  // in another project, is still open — is not waiting on them yet, and rides;
  // once ready, it holds the close below.
  if (sub === "manual" && s === "planned" && deps.some((x) => x.state === "open")) return null;
  // A wait that names the user waits on their hands, whatever its date, as a manual
  // row does — unless the manual row is set aside `blocked: until <date>`: nothing is
  // theirs to do before then. Nothing sets it back on its own: once the date
  // passes, `/project triage blocked` lists it and `unblock` there sets it `planned`.
  const parked = sub === "manual" && releaseDate(status) !== "";
  if ((sub === "manual" && !parked) || (/^blocked:/.test(s) && namesUser(status.replace(/^blocked:/i, "")))) {
    return "a step waiting on the user — the session stays open until they have done it; then set the row `done` and close";
  }
  if (s === "planned") return null;
  if (s === "in-progress") {
    return "half-built — finish it, and set the row `done` if its report is complete; the session stays open until then";
  }
  if (/^blocked:/.test(s)) {
    // A watch's date, or the day a `blocked: until <date>` wait is released.
    const day = watchDate(status) || releaseDate(status);
    if (day === "") {
      return "a wait with no date — write `blocked: YYYY-MM-DD <what>` with the day to check, or keep the session open until it clears";
    }
    if (day < today)
      return `a wait whose date ${day} is already past — the check is due: do it now, or set the next date`;
    return null;
  }
  return "not one of the known states (planned, in-progress, done, blocked:, closed:, absorbed by)";
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--since" || !args[1]) {
    process.stderr.write("usage: check-roadmap-decisions.ts --since <ref>\n");
    return 2;
  }
  const mb = git(["merge-base", "HEAD", args[1]]);
  if (!mb.ok) {
    process.stderr.write(`check-roadmap-decisions: no merge base between HEAD and ${args[1]}\n`);
    return 2;
  }
  const base = mb.out.trim();
  // A listing git could not make is not an empty one: read as empty, it judged
  // nothing and passed.
  const diff = git(["diff", "-z", "--name-only", base, "--", "projects"]);
  const others = git(["ls-files", "-z", "--others", "--exclude-standard", "--", "projects"]);
  if (!diff.ok || !others.ok) {
    process.stderr.write(`check-roadmap-decisions: could not list what changed since ${base} — git failed; re-run\n`);
    return 2;
  }
  const touched = [...diff.out.split("\0"), ...others.out.split("\0")];
  const changed = new Set(touched.filter((p) => /^projects\/.+\/ROADMAP\.md$/.test(p)));
  const reports = new Set(touched.filter((p) => /^projects\/.+\/specs\/[^/]+\/report\.md$/.test(p)));

  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  let open = 0;
  let checked = 0;
  let judged = 0;
  let left = 0;
  let unreadable = 0;
  for (const path of [...changed].sort()) {
    if (!existsSync(path)) continue; // deleted on this branch
    // A table the parser refuses is judged by no row below, so it holds the
    // close on its own; skipping it as if deleted passed it unread.
    const now = readRows(path);
    if (typeof now === "string") {
      unreadable++;
      process.stderr.write(`${path}: roadmap.ts cannot read it — ${now}; fix the table so its rows can be judged\n`);
      continue;
    }
    checked++;
    const before = git(["show", `${base}:${path}`]);
    const was = (before.ok ? statuses(path, Buffer.from(before.out)) : null) ?? new Map<string, Row>();
    for (const [id, row] of now) {
      const prior = was.get(id);
      if (prior && prior.status === row.status && prior.sub === row.sub && prior.dependsOn === row.dependsOn) continue;
      judged++;
      const { status } = row;
      if (/^blocked:/i.test(status)) {
        const text = status.replace(/^blocked:\s*/i, "");
        const word = openDecisionWord(text, namesUser(text)) ?? parkedOnUser(text);
        if (word !== null) {
          open++;
          left++;
          process.stderr.write(
            `${path}: ${id} "${status}": "${word}" makes this a question for the user, not something the row waits on — ask it in the reply as a numbered list, recommendation first, and halt; the close runs after they answer (auto-close-gate.md precondition (iii))\n`,
          );
          continue;
        }
      }
      const kind = openKind(row, today);
      if (kind === null) continue;
      left++;
      process.stderr.write(
        `${path}: ${id} "${status}" (Sub-spec ${row.sub}): ${kind} (auto-close-gate.md precondition (iii))\n`,
      );
    }
  }
  process.stdout.write(`${checked} roadmaps checked, ${open} open decisions\n`);
  process.stdout.write(`${judged} rows added or changed, ${left} left open\n`);
  process.stdout.write(`${unreadable} roadmaps unreadable\n`);

  let parked = 0;
  let read = 0;
  for (const path of [...reports].sort()) {
    if (!existsSync(path)) continue; // deleted on this branch
    read++;
    // The base's lines, counted, so a line the report already held is consumed
    // rather than read again; fenced blocks quote, they do not park.
    const was = new Map<string, number>();
    const before = git(["show", `${base}:${path}`]);
    if (before.ok) for (const l of before.out.split("\n")) was.set(l, (was.get(l) ?? 0) + 1);
    let fence = false;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence;
        const held = was.get(l) ?? 0;
        if (held > 0) {
          was.set(l, held - 1);
          return;
        }
        if (fence) return;
        const words = parkedOnUser(l);
        if (!words) return;
        parked++;
        process.stderr.write(
          `${path}:${i + 1}: "${words}" leaves this waiting on the user — ask it in the reply as a numbered list, recommendation first, and halt; the close runs after they answer (auto-close-gate.md precondition (iii)). Something the user DOES keeps the session open until they have done it\n`,
        );
      });
  }
  process.stdout.write(`${read} reports checked, ${parked} parked lines\n`);

  // A report this push writes as partial is a half-built piece, unless the row
  // that names its spec stopped on purpose (closed:, absorbed by).
  const byProject = new Map<string, string[]>();
  for (const path of [...reports].sort()) {
    if (!existsSync(path)) continue;
    const at = path.lastIndexOf("/specs/");
    const project = path.slice(0, at);
    byProject.set(project, [...(byProject.get(project) ?? []), path]);
  }
  let partial = 0;
  for (const [project, paths] of byProject) {
    const st = spawnSync(process.execPath, ["--experimental-strip-types", SPEC_STATE_TS, project], {
      encoding: "utf8",
    });
    if (st.status !== 0) {
      process.stderr.write(
        `check-roadmap-decisions: ${SPEC_STATE_TS} ${project} failed: ${(st.stderr ?? "").trim()}\n`,
      );
      return 2;
    }
    const state = new Map<string, string>();
    for (const line of (st.stdout ?? "").split("\n")) {
      const [name, value] = line.split("\t");
      if (name && value) state.set(name, value);
    }
    const rows = existsSync(join(project, "ROADMAP.md"))
      ? (statuses(join(project, "ROADMAP.md")) ?? new Map<string, Row>())
      : new Map<string, Row>();
    for (const path of paths) {
      const name = path.slice(project.length + 1, -"/report.md".length);
      if (state.get(name) !== "partial") continue; // complete, or not a spec
      const owner = [...rows].find(([, r]) => r.sub === name);
      if (owner && /^(closed:|absorbed by )/i.test(owner[1].status)) continue;
      partial++;
      const who = owner ? `its row ${owner[0]} is "${owner[1].status}"` : `no row names ${name}`;
      process.stderr.write(
        `${path}: reads partial, and ${who} — a half-built piece does not land: finish it and write the report \`complete\`, narrow the spec to what was built, or set the row \`closed: <why>\` (auto-close-gate.md precondition (iii))\n`,
      );
    }
  }
  process.stdout.write(`${partial} reports partial\n`);
  return left > 0 || parked > 0 || partial > 0 || unreadable > 0 ? 1 : 0;
}

// runToExit, not process.exit: a long refusal list must reach a slow reader whole.
await runToExit(() => exit(main()));
