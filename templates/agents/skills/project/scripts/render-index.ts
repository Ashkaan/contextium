#!/usr/bin/env -S node --experimental-strip-types
// render-index.ts
//
// The ENTIRE blank-mode `/project` render, as finished markdown on stdout:
//
//   1. the compact priority-sorted project index (project-index.generate.ts)
//   2. the lapsed-monitor-window block (check-staleness.ts --expired-only),
//      already turned into prose lines — not the raw EXPIRED:/NOWINDOW: rows
//   3. the closing "which one to start?" prompt
//
// WHY THIS EXISTS: blank-mode /project has no judgment in it. As two Bash
// calls, their output had to be re-assembled and re-typed into the agent's
// reply — a long skill read plus kilobytes of verbatim retyping, for two
// scripts that together cost half a second. This composes them once so the render is a
// copy (or a plain terminal command with no model in the loop at all).
//
// Composition only: no formatting decision lives here that was not already
// specified in SKILL.md § "Lapsed monitor windows". Zero lapsed windows print
// NOTHING — the block's absence is the all-clear.
//
// Usage:
//   .agents/skills/project/scripts/render-index.ts
//
// Exit code: 0 unless the index generator itself fails (then its status).
//
// peers:
//   .agents/generators/project-index.generate.ts
//   .agents/skills/project/scripts/check-staleness.ts
//   .agents/skills/project/scripts/render-index.test.ts
//   .agents/skills/project/SKILL.md  (step-0.5-render-index + scripts table)

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const die = (msg: string, code = 1): never => {
  process.stderr.write(`${msg}\n`);
  exit(code);
};

async function main(): Promise<void> {
  // ONE CHECKOUT FOR BOTH HALVES. The generator indexes the projects of the repo
  // it sits in, and check-staleness.ts scans the session's write root. Run from
  // the skills home link (the landed checkout) while a session writes in its own
  // worktree, taking the generator from THIS script's repo would render one tree's
  // index above another tree's lapsed windows. So the root is resolved once,
  // through the same resolver check-staleness.ts uses, and both halves read it:
  // the generator is that root's `.agents/generators/`, and the scan is pinned to
  // it with CONTEXT_WRITE_ROOT. `--no-create`: rendering the index is not a
  // reason to create a worktree. CONTEXT_CODE_REPO overrides the root, for a test.
  let CODE_REPO = process.env.CONTEXT_CODE_REPO ?? "";
  if (CODE_REPO === "") {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(SCRIPT_DIR, "../../implement/scripts/session-write-root.ts"), "--no-create"],
      { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"] },
    );
    CODE_REPO = (r.stdout ?? "").replace(/\n+$/, "");
  }
  if (CODE_REPO === "") {
    die("render-index: could not resolve the session's write root (set CONTEXT_CODE_REPO)");
  }
  const GENERATOR = `${CODE_REPO}/.agents/generators/project-index.generate.ts`;
  if (!isFile(GENERATOR)) {
    die(`render-index: no project-index generator at ${GENERATOR} (set CONTEXT_CODE_REPO)`);
  }
  try {
    process.chdir(CODE_REPO);
  } catch {
    die(`render-index: cd: ${CODE_REPO}: No such file or directory`);
  }

  // A non-zero exit still carries a view worth showing: the generator names the
  // projects it could not read on its first line and renders the rest. Print that
  // and stop, so /project shows the warning and the partial index rather than
  // nothing at all.
  const gen = spawnSync(process.execPath, ["--experimental-strip-types", GENERATOR, "--compact"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
  const INDEX = (gen.stdout ?? "").replace(/\n+$/, "");
  const INDEX_RC = gen.status ?? 1;
  if (INDEX_RC !== 0) {
    // Only a render whose first line is the generator's drop line is a partial
    // index worth showing; anything else is an error, and its output is not an
    // index however it looks.
    const first = INDEX.split("\n")[0] ?? "";
    if (first.startsWith("**") && first.slice(2).includes(" project(s) could not be read")) {
      process.stdout.write(`${INDEX}\n`);
      process.stderr.write(
        `render-index: the project index is incomplete (generator exit ${INDEX_RC}) — see the first line above\n`,
      );
    } else {
      process.stderr.write(`render-index: the project index generator failed (exit ${INDEX_RC})\n`);
    }
    exit(INDEX_RC);
  }

  // `Completed — N` sits LAST in the finished render, below Lapsed, so it is held
  // back here and re-printed at the end. The generator emits it as its own final
  // line; that positional coupling is CHECKED rather than assumed — a generator
  // change that moves or renames the line fails loud instead of silently dropping
  // the count or splitting the Monitoring table in half.
  const indexLines = INDEX.split("\n");
  const COMPLETED = indexLines[indexLines.length - 1] ?? "";
  if (!COMPLETED.startsWith("**Completed — ")) {
    die(`render-index: expected the generator's last line to be the Completed heading, got: ${COMPLETED}`);
  }
  if (indexLines.length > 1) process.stdout.write(`${indexLines.slice(0, -1).join("\n")}\n`);

  // Newest lapse LAST, so the block reads oldest-neglect-first; windows with no
  // date at all sort after every dated one (they have no lapse age to rank by).
  const scan = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "check-staleness.ts"), "--expired-only"],
    {
      encoding: "utf8",
      env: { ...process.env, CONTEXT_WRITE_ROOT: CODE_REPO },
      stdio: ["inherit", "pipe", "inherit"],
    },
  );
  if (scan.status !== 0) {
    // A failed scan read as an empty one rendered as "no lapsed projects" and the
    // index shipped without them.
    die("render-index: check-staleness.ts --expired-only failed; not rendering a lapsed list from nothing");
  }
  const ranked: { age: number; line: string }[] = [];
  for (const row of (scan.stdout ?? "").split("\n")) {
    const f = row.split(":");
    if (row.startsWith("EXPIRED:")) {
      const until = (f[2] ?? "").split("=")[1] ?? "";
      const daysRaw = (f[3] ?? "").split("=")[1] ?? "";
      const days = Number.parseInt(daysRaw, 10) || 0; // awk's %d
      ranked.push({ age: days, line: `- ${f[1] ?? ""} — ended ${until} (${daysRaw} days ago)` });
    } else if (row.startsWith("NOWINDOW:")) {
      ranked.push({ age: -1, line: `- ${f[1] ?? ""} — monitor with no monitoring-until date` });
    }
  }
  // `sort -rn` on "<age>\t<line>": age descending, ties by the whole line descending.
  ranked.sort((a, b) => (b.age - a.age !== 0 ? b.age - a.age : `${b.age}\t${b.line}` < `${a.age}\t${a.line}` ? -1 : 1));
  const LAPSED = ranked.map((r) => r.line);

  // Zero lapsed prints NOTHING — no heading, no all-clear line.
  if (LAPSED.length > 0) {
    process.stdout.write(
      `**Lapsed — ${LAPSED.length}**\n${LAPSED.join("\n")}\n\n\`/project <slug>\` to close or extend.\n\n`,
    );
  }

  process.stdout.write(`${COMPLETED}\n`);
  process.stdout.write("\nWhich one to start? Type `/project [slug]`.\n");
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
