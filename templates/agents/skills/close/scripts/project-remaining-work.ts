#!/usr/bin/env -S node --experimental-strip-types
// project-remaining-work.ts — emit the HARD signals of unfinished work in a
// project, so /close step-2.1 can decide whether the project just finished.
// Counting specs and table rows is DATA, not judgment; the judgment left to
// the agent is only "does the shipped thing need a watch window?".
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
//   roadmap_table: yes|no                             (ROADMAP.md present)
//   roadmap_open: N                                   (rows not done/absorbed/closed)
//   roadmap: <ID> <status>                            (one line per such row)
//   roadmap-error: <message>                          (ROADMAP.md missing or malformed;
//                                                      work-remains)
//   verdict: work-remains|no-hard-signal
//
// `verdict: no-hard-signal` does NOT mean "the project is done" — it means
// nothing countable is outstanding, so the completion call is now the agent's to
// make by reading the README goal against what shipped. `work-remains` is the
// deterministic veto: never flip a project holding one.
//
// The README's `## Shard Status` table and `## Next Steps` list are not read:
// ROADMAP.md replaced both, so a leftover list cannot hold a roadmap project
// open, and a project without ROADMAP.md reports `roadmap-error` (work-remains)
// until `/project <slug>` gives it one.
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
    const root = sibling(`${SCRIPT_DIR}/../../implement/scripts/session-write-root.ts`, ["--no-create"], "ignore").out;
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

  // ── ROADMAP.md rows not done ───────────────────────────────────────────
  // The roadmap is the project's ONE list of outstanding work
  // (project/references/templates/ROADMAP.md), read through roadmap.ts so this
  // cannot disagree with detect-stage.ts or next-implement-command.ts about the
  // table. Every row that is not `done`, `absorbed by …` or `closed: …` is open — a `blocked:`
  // watch included, since a watch is exactly what must keep a project from
  // closing. A table roadmap.ts cannot read, or no table at all, is also
  // work-remains: a veto that resolves a parse failure toward "nothing left"
  // would flip the project done.
  if (!isFile(`${projectDir}/ROADMAP.md`)) {
    say("roadmap_table: no");
    say("roadmap_open: 0");
    say("roadmap-error: no ROADMAP.md");
    remains = true;
  } else {
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
        if (s === "done" || /^absorbed by /.test(s) || /^closed:/.test(s)) continue;
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
