#!/usr/bin/env -S node --experimental-strip-types
// open-clarifications.ts — list the `NEEDS CLARIFICATION` markers still open in
// one spec folder. /implement does not start while any remain: a marker is a
// decision nobody made, and building past it is the misalignment the grill in
// /project exists to prevent. setup-worktree.sh refuses on exit 1,
// detect-stage.ts routes the row back to planning, next-implement-command.ts
// prints `/project` for it.
//
// Read: spec.md, plan.md and tasks.md. research.md is not — it is where an open
// question is SUPPOSED to be written down and resolved.
//
// Skipped: anything inside an HTML comment, single- or multi-line. The spec
// template's own instructions name the marker inside one
// (spec/references/templates/spec.md), and those are directions to the writer,
// not open questions.
//
// Usage: open-clarifications.ts <spec-folder>
// Output: `<file>:<line>: <text>` per marker, with the file's own line number.
// Exit: 0 none · 1 some · 2 usage, not a directory, or a spec file that cannot
// be read (an unread file must never pass as one with no markers).
//
// peers:
//   .agents/skills/close/scripts/open-clarifications.test.ts
//   .agents/skills/implement/scripts/setup-worktree.sh
//   .agents/skills/project/scripts/detect-stage.ts
//   .agents/skills/close/scripts/next-implement-command.ts

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

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

/** The marker lines of one file, `<name>:<line>: <text>`, comments cut out first. */
function markers(name: string, text: string): string[] {
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const hits: string[] = [];
  // An HTML comment may span lines, so whether we are inside one carries over.
  let inComment = false;
  lines.forEach((whole, i) => {
    let line = whole;
    let out = "";
    while (line !== "") {
      if (inComment) {
        const p = line.indexOf("-->");
        if (p < 0) {
          line = "";
          break;
        }
        line = line.slice(p + 3);
        inComment = false;
      } else {
        const p = line.indexOf("<!--");
        if (p < 0) {
          out += line;
          line = "";
          break;
        }
        out += line.slice(0, p);
        line = line.slice(p + 4);
        inComment = true;
      }
    }
    if (out.includes("NEEDS CLARIFICATION")) {
      hits.push(`${name}:${i + 1}: ${out.replace(/^[ \t]+|[ \t]+$/g, "")}`);
    }
  });
  return hits;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    err("usage: open-clarifications.ts <spec-folder>");
    exit(2);
  }
  const arg = argv[0] ?? "";
  const folder = arg.endsWith("/") ? arg.slice(0, -1) : arg;
  if (!isDir(folder)) {
    err(`not a directory: ${folder}`);
    exit(2);
  }

  let found = 0;
  let out = "";
  for (const name of ["spec.md", "plan.md", "tasks.md"]) {
    const f = `${folder}/${name}`;
    if (!existsSync(f)) continue;
    let text: string;
    try {
      if (!isFile(f)) throw new Error("not a file");
      text = readFileSync(f, "utf8");
    } catch {
      process.stdout.write(out);
      err(`cannot read ${f}`);
      exit(2);
    }
    const hits = markers(name, text);
    if (hits.length > 0) {
      out += `${hits.join("\n")}\n`;
      found = 1;
    }
  }
  process.stdout.write(out);
  exit(found);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
