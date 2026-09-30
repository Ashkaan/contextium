#!/usr/bin/env -S node --experimental-strip-types
// detect-stage.ts
//
// Detect the stage of an existing project from filesystem + frontmatter.
// Deterministic — no AI judgment. Routes /project to the right next action.
//
// Stages:
//   needs-planning     → status:active + no *.spec.md or *.plan.md (legacy) at all
//                        — or, with ROADMAP.md, no rows yet, or a ready row whose
//                        Sub-spec is `—`, missing on disk, or carries an open
//                        NEEDS CLARIFICATION marker
//   all-specs-reported → status:active + at least one SPEC + every one of them reported
//   ready-to-implement → status:active + *.spec.md (or legacy *.plan.md) exists + no matching *-report.md
//   ready-to-close     → status:active + ROADMAP.md, and a ready row's spec is
//                        reported complete while the row is not yet `done` — a
//                        close that did not finish; /close flips the row
//   monitor            → status:monitor
//   blocked            → status:blocked
//   completed          → status:completed
//
// Recognizes both *.spec.md (new) AND *.plan.md
// (legacy back-compat). Multiple SPECs/plans: pick the most-recent that has no
// sibling *-report.md as the active SPEC.
//
// "no unreported SPEC" is TWO different situations and this script used to
// collapse them into one. A project with zero SPECs has never been planned, so
// the think flow is right. A project whose every SPEC is reported may be about
// to start its next chunk OR may simply be finished, and nothing in the file
// counts tells them apart — the remaining item can be a watch window rather than
// a build. Returning needs-planning for that second case points /project at a
// think flow that invents scope for a project that may be done. It is its own
// stage, and the caller reads the remaining-work counts before deciding.
//
// A PROJECT WITH ROADMAP.md (the spec-kit layout) is staged from
// its rows, read through close/scripts/roadmap.ts — the one parser — and the
// README template's Ready rule (project/references/templates/README.md), in this
// order, status active only:
//   1. a legacy loose SPEC still owed work wins: that work is already in flight
//   2. a table with no rows → needs-planning: nothing has been planned yet
//   3. a ready row whose spec is reported complete → ready-to-close, ahead of new
//      work, because the row the close flips may be what unblocks the next one
//   4. the first ready row (in-progress before planned, table order) whose spec
//      is none/partial and carries no open NEEDS CLARIFICATION → ready-to-implement
//   5. else a ready row with Sub-spec `—`, a spec missing on disk, or open
//      clarifications → needs-planning
//   6. else → all-specs-reported
// A malformed ROADMAP.md is `stage: unknown` plus `roadmap-error:`, never a
// fallback to the legacy signals, which could offer work from stale data.
//
// The status is read from the README's frontmatter only: a body line that
// starts `status:` is prose, not the field.
//
// CONTEXTIUM_CLOSE_SCRIPTS points the three close/ helpers (roadmap.ts,
// spec-state.ts, open-clarifications.ts) at another copy; the tests use it.
//
// Usage:
//   detect-stage.ts <project-path>
//
// Output (multi-line to stdout):
//   stage: <stage-name>
//   status: <frontmatter status>
//   specs: <count>      (spec.md + plan.md + specs/*/spec.md)
//   reports: <count>    (*-report.md + specs/*/report.md)
//   active-spec: <path or empty>
//   next-row: <ID or empty>       (ROADMAP.md projects only)
//   roadmap-error: <message>      (only when ROADMAP.md is malformed)
//   spec-state-error: <message>   (only when spec-state.ts crashed; stage unknown)
//
// Exit code: 0 always (1 when no path is given or the write root cannot be
// resolved).
//
// peers:
//   .agents/skills/project/scripts/detect-stage.test.ts
//   .agents/skills/close/scripts/roadmap.ts
//   .agents/skills/close/scripts/spec-state.ts
//   .agents/skills/close/scripts/open-clarifications.ts

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLOSE_SCRIPTS = process.env.CONTEXTIUM_CLOSE_SCRIPTS || join(SCRIPT_DIR, "../../close/scripts");

/**
 * THE WRITE ROOT. This script reads projects and journals with repo-relative
 * paths, so it runs FROM the root the session resolves — the thread's worktree,
 * else the checkout it lives in — never from whichever cwd invoked it, because a
 * wrong cwd here reports "no projects" rather than failing.
 */
function enterWriteRoot(): void {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "../../implement/scripts/session-write-root.ts"), "--no-create"],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (r.status !== 0) exit(1);
  const root = (r.stdout ?? "").replace(/\n+$/, "");
  if (root === "") return; // `cd ""` is a no-op in bash
  try {
    process.chdir(root);
  } catch {
    process.stderr.write(`detect-stage: cd: ${root}: No such file or directory\n`);
    exit(1);
  }
}

/** Run another loop script with node; stdout and stderr captured apart. */
function runTs(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const entries = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** `find <dir> -maxdepth 1 -type f` names, joined the way find prints them. */
const child = (dir: string, name: string): string => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

/** `find <dir> -mindepth 3 -maxdepth 3 -path <re> -type f`, sorted. */
function depth3(dir: string, pathRe: RegExp): string[] {
  const out: string[] = [];
  for (const a of entries(dir)) {
    if (!a.isDirectory()) continue;
    const pa = child(dir, a.name);
    for (const b of entries(pa)) {
      if (!b.isDirectory()) continue;
      const pb = `${pa}/${b.name}`;
      for (const c of entries(pb)) {
        const pc = `${pb}/${c.name}`;
        if (c.isFile() && pathRe.test(pc)) out.push(pc);
      }
    }
  }
  return out.sort();
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const stemOf = (p: string): string => base(p).replace(/\.(spec|plan)\.md$/, "");
/** Lines of `printf '%s\n' "$X"` — an empty X is one empty line. */
const linesOf = (s: string): string[] => s.split("\n");
/** `$(…)`: trailing newlines dropped. */
const chomp = (s: string): string => s.replace(/\n+$/, "");

async function main(): Promise<void> {
  enterWriteRoot();

  let PROJECT_PATH = process.argv[2] ?? "";
  if (PROJECT_PATH === "") {
    process.stderr.write(`${process.argv[1]}: 1: project path required\n`);
    exit(1);
  }
  PROJECT_PATH = PROJECT_PATH.replace(/\/$/, "");
  const README = `${PROJECT_PATH}/README.md`;

  if (!isFile(README)) {
    process.stdout.write("stage: unknown\nstatus: missing-readme\nspecs: 0\nreports: 0\nactive-spec:\n");
    return;
  }

  // Frontmatter only: a body line starting `status:` is prose, not the field.
  // The first `status:` line between a first line of exactly `---` and the next
  // `---`, its second blank-separated field.
  let STATUS = "";
  const readmeLines = readFileSync(README, "utf8").split("\n");
  for (const line of readmeLines[0] === "---" ? readmeLines.slice(1) : []) {
    if (line === "---") break;
    if (line.startsWith("status:")) {
      STATUS = line.replace(/^[ \t]+/, "").split(/[ \t]+/)[1] ?? "";
      break;
    }
  }
  if (STATUS === "") STATUS = "unknown";

  // Recognize both *.spec.md (new) and *.plan.md (legacy back-compat)
  const top = entries(PROJECT_PATH).filter((e) => e.isFile());
  const SPEC_FILES = top
    .filter((e) => e.name.endsWith(".spec.md") || e.name.endsWith(".plan.md"))
    .map((e) => child(PROJECT_PATH, e.name))
    .sort();
  const REPORT_FILES = top
    .filter((e) => e.name.endsWith("-report.md"))
    .map((e) => child(PROJECT_PATH, e.name))
    .sort();

  // spec-kit folders, `specs/NNN-name/{spec,report}.md`, count alongside.
  const FOLDER_SPECS = depth3(PROJECT_PATH, /^.*\/specs\/.*\/spec\.md$/s);
  const FOLDER_REPORTS = depth3(PROJECT_PATH, /^.*\/specs\/.*\/report\.md$/s);
  const SPEC_COUNT = SPEC_FILES.length + FOLDER_SPECS.length;
  const REPORT_COUNT = REPORT_FILES.length + FOLDER_REPORTS.length;

  // Find the active SPEC — the most-recent one still owed work.
  // `spec-state.ts` owns what "still owed" means for every reader; it is not a
  // filename question. A SPEC reported under a name describing the slice it covered
  // (`phase-2-sync-freshness-report.md`), or reported without anyone claiming it
  // finished, is still active work and used to read here as done.
  const SPEC_STATE_TS = join(CLOSE_SCRIPTS, "spec-state.ts");
  let ACTIVE_SPEC = "";
  let SPEC_STATE_ERR = "";
  let SPEC_STATES = "";
  let PENDING = "";
  if (SPEC_COUNT > 0 && isFile(SPEC_STATE_TS)) {
    // A helper that CRASHES is not a helper that found nothing owed: read as
    // silence, every spec would look missing or finished and the router would
    // send an already specified row back to planning. It is recorded, and the
    // stage becomes `unknown` below.
    const ss = runTs(SPEC_STATE_TS, [PROJECT_PATH]);
    SPEC_STATES = chomp(ss.stdout);
    if (ss.status !== 0) SPEC_STATE_ERR = `spec-state.ts exited ${ss.status}`;
    PENDING = chomp(
      linesOf(SPEC_STATES)
        .map((l) => l.split("\t"))
        .filter((f) => f[1] === "none" || f[1] === "partial")
        .map((f) => `${f[0]}\n`)
        .join(""),
    );
    const pending = linesOf(PENDING);
    for (const specPath of SPEC_FILES) {
      if (pending.includes(stemOf(specPath))) ACTIVE_SPEC = specPath;
    }
  } else if (SPEC_COUNT > 0) {
    // Helper missing (a partial install) — fall back to the old filename rule
    // rather than claiming every SPEC is done.
    for (const specPath of SPEC_FILES) {
      if (!isFile(`${PROJECT_PATH}/${stemOf(specPath)}-report.md`)) ACTIVE_SPEC = specPath;
    }
  }

  const hasRoadmap = isFile(`${PROJECT_PATH}/ROADMAP.md`);

  // A folder spec still owed work, on a project with no ROADMAP.md to order it —
  // or one whose ROADMAP.md orders nothing because the project is not active (the
  // rows below are read for active projects only). Without the second case a
  // finished project lost its active-spec the moment its specs moved into folders.
  if (ACTIVE_SPEC === "" && PENDING !== "" && (!hasRoadmap || STATUS !== "active")) {
    const pending = linesOf(PENDING);
    for (const specPath of FOLDER_SPECS) {
      const name = `specs/${base(dirname(specPath))}`;
      if (pending.includes(name)) ACTIVE_SPEC = specPath;
    }
  }

  // ── ROADMAP.md: the rows decide ──────────────────────────────────────────
  let HAS_ROADMAP = false;
  let NEXT_ROW = "";
  let ROADMAP_ERR = "";
  let ROADMAP_STAGE = "";
  const specStateOf = (n: string): string =>
    linesOf(SPEC_STATES)
      .map((l) => l.split("\t"))
      .find((f) => f[0] === n)?.[1] ?? "";
  if (hasRoadmap && STATUS === "active") {
    HAS_ROADMAP = true;
    const rm = runTs(join(CLOSE_SCRIPTS, "roadmap.ts"), [PROJECT_PATH]);
    if (rm.status !== 0) {
      const errs = chomp(rm.stderr)
        .split("\n")
        .filter((l) => l.startsWith("roadmap: "))
        .map((l) => l.slice("roadmap: ".length));
      ROADMAP_ERR = errs[errs.length - 1] ?? "";
      if (ROADMAP_ERR === "") ROADMAP_ERR = `roadmap.ts exited ${rm.status}`;
      ROADMAP_STAGE = "unknown";
    } else {
      process.stderr.write(rm.stderr);
      const ROWS = linesOf(chomp(rm.stdout)).map((l) => l.split("\t"));
      if (ACTIVE_SPEC !== "") {
        // 1. Legacy loose SPEC in flight: name the row that points at it, if any.
        const stem = stemOf(ACTIVE_SPEC);
        NEXT_ROW = ROWS.find((f) => f[3] === stem)?.[0] ?? "";
        ROADMAP_STAGE = "ready-to-implement";
      } else if (chomp(rm.stdout) === "") {
        // 2. A table with no rows: nothing has been planned yet.
        ROADMAP_STAGE = "needs-planning";
      } else {
        let planRow = "";
        let closeRow = "";
        // Ready rows, in-progress first then planned, each in table order.
        const ready = (st: string) => ROWS.filter((f) => f[2] === "yes" && (f[1] ?? "").toLowerCase() === st);
        const READY = [...ready("in-progress"), ...ready("planned")].map((f) =>
          // `IFS=$'\t' read` collapsed empty fields; the row is read the same.
          f
            .join("\t")
            .replace(/^\t+|\t+$/g, "")
            .split(/\t+/),
        );
        for (const [id = "", , , sub = ""] of READY) {
          if (id === "") continue;
          if (sub === "—") {
            if (planRow === "") planRow = id;
            continue;
          }
          const st = specStateOf(sub);
          if (st === "complete") {
            // 3. Reported complete, row not yet done: the close did not finish.
            if (closeRow === "") closeRow = id;
            continue;
          }
          if (st !== "none" && st !== "partial") {
            // 5. The row names a spec that is not on disk: nothing to build.
            if (planRow === "") planRow = id;
            continue;
          }
          // An implementable row is already chosen; keep reading only for a
          // complete row awaiting its close, which outranks it.
          if (ROADMAP_STAGE !== "") continue;
          if (sub.startsWith("specs/")) {
            if (runTs(join(CLOSE_SCRIPTS, "open-clarifications.ts"), [`${PROJECT_PATH}/${sub}`]).status !== 0) {
              if (planRow === "") planRow = id;
              continue;
            }
            ACTIVE_SPEC = `${PROJECT_PATH}/${sub}/spec.md`;
          } else {
            ACTIVE_SPEC = SPEC_FILES.find((p) => stemOf(p) === sub) ?? "";
          }
          NEXT_ROW = id;
          ROADMAP_STAGE = "ready-to-implement";
        }
        if (closeRow !== "") {
          NEXT_ROW = closeRow;
          ROADMAP_STAGE = "ready-to-close";
          ACTIVE_SPEC = "";
        } else if (ROADMAP_STAGE === "") {
          if (planRow !== "") {
            NEXT_ROW = planRow;
            ROADMAP_STAGE = "needs-planning";
          } else ROADMAP_STAGE = "all-specs-reported";
        }
      }
    }
  } else if (hasRoadmap) {
    HAS_ROADMAP = true;
  }

  // Stage from status first (monitor / blocked / completed override filesystem state)
  let STAGE: string;
  switch (STATUS) {
    case "monitor":
    case "blocked":
    case "completed":
      STAGE = STATUS;
      break;
    case "active":
      if (SPEC_STATE_ERR !== "") STAGE = "unknown";
      else if (ROADMAP_STAGE !== "") STAGE = ROADMAP_STAGE;
      // Never planned — no SPEC has ever been written here.
      else if (ACTIVE_SPEC === "" && SPEC_COUNT === 0) STAGE = "needs-planning";
      // Every SPEC written here has a report. Could be the next chunk, could be
      // a finished project; the file counts cannot tell. Caller decides.
      else if (ACTIVE_SPEC === "") STAGE = "all-specs-reported";
      // SPECs exist and one still has no report. With reports present this could
      // also be ready-to-close; the caller decides, and ready-to-implement is
      // preferred while an active SPEC exists.
      else STAGE = "ready-to-implement";
      break;
    default:
      STAGE = "unknown";
  }

  let out =
    `stage: ${STAGE}\nstatus: ${STATUS}\nspecs: ${SPEC_COUNT}\nreports: ${REPORT_COUNT}\n` +
    `active-spec: ${ACTIVE_SPEC}\n`;
  if (SPEC_STATE_ERR !== "") out += `spec-state-error: ${SPEC_STATE_ERR}\n`;
  if (HAS_ROADMAP) {
    out += `next-row: ${NEXT_ROW}\n`;
    if (ROADMAP_ERR !== "") out += `roadmap-error: ${ROADMAP_ERR}\n`;
  }
  process.stdout.write(out);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
