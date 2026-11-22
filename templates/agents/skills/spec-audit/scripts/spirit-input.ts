#!/usr/bin/env -S node --experimental-strip-types
// spirit-input.ts — the fidelity check's input, cut from a SPEC by heading.
//
// The fidelity reviewer (.agents/agents/spirit-check.md) refuses a brief that
// carries the SPEC's full body and reads only the sections that file names.
// /spec-audit used to hand policy-review.ts the whole spec.md and leave the
// cutting to the session, so sessions cut excerpts by hand and the fidelity
// check refused or drifted.
// This writes exactly those sections, verbatim and in order, to one file that
// becomes policy-review.ts's artifact, and the spirit-check subagent's input
// when the chain falls back to it.
//
// Usage:
//   spirit-input.ts <spec-folder | single-file SPEC> <out-file>
//
//   A spec folder (holds spec.md and plan.md): spec.md's `**Input**` paragraph,
//     `## Clarifications`, `## User Scenarios & Testing` and `## Requirements`,
//     then plan.md's `### Simplest shape`.
//   A single-file SPEC: `## 0.` (the verbatim ask), `## 0a.`, `## 0b.` and `## 1.`.
//
// Each section runs from its heading to the next heading of the same or a
// higher level. Each is printed under a `=== <file> § <name> ===` line.
//
// Exit: 0 = written, and the out-file path printed on stdout; 1 = a required
// section is missing (each one named on stderr, nothing written); 2 = caller
// error (usage, an unreadable path).
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

type Want = { file: string; name: string; start: RegExp };

const FOLDER: Want[] = [
  { file: "spec.md", name: "Input", start: /^\*\*Input\*\*/ },
  { file: "spec.md", name: "Clarifications", start: /^## Clarifications\b/ },
  { file: "spec.md", name: "User Scenarios & Testing", start: /^## User Scenarios & Testing\b/ },
  { file: "spec.md", name: "Requirements", start: /^## Requirements\b/ },
  { file: "plan.md", name: "Simplest shape", start: /^### Simplest shape\b/ },
];
const SINGLE: Want[] = [
  { file: "", name: "0", start: /^## 0\.\s/ },
  { file: "", name: "0a", start: /^## 0a\.\s/ },
  { file: "", name: "0b", start: /^## 0b\.\s/ },
  { file: "", name: "1", start: /^## 1\.\s/ },
];

const level = (line: string): number => /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** The section starting at the first line matching `start`, up to the next
 *  heading of its level or higher; an `**Input**` paragraph ends at a heading
 *  or at a blank line, unless the next non-blank line is a list item, which
 *  keeps a lead line and the list of turns under it together (specs that wrote
 *  "User description, in order:", a blank line, then the quoted turns, kept
 *  only the lead line), or is indented, which
 *  is a list item's own continuation paragraph (a spec that
 *  wrote each turn's answered options as an indented paragraph under it, and the
 *  cut stopped at the first one, so the fidelity check saw 4 of 11 turns). Null
 *  when no line matches. */
export function section(text: string, start: RegExp): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => start.test(l));
  if (at < 0) return null;
  const own = level(lines[at] ?? "");
  const listFollows = (i: number): boolean => {
    let j = i;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
    const next = lines[j] ?? "";
    return j < lines.length && (LIST_ITEM.test(next) || /^[ \t]+\S/.test(next));
  };
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const lv = level(l);
    if (own === 0 ? (l.trim() === "" && !listFollows(i)) || lv > 0 : lv > 0 && lv <= own) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end).join("\n").trimEnd();
}

function main(argv: string[]): number {
  const [path, out] = argv;
  if (!path || !out || argv.length !== 2) {
    process.stderr.write("usage: spirit-input.ts <spec-folder | single-file SPEC> <out-file>\n");
    return 2;
  }
  if (!existsSync(path)) {
    process.stderr.write(`spirit-input: no such path ${path}\n`);
    return 2;
  }
  const folder = statSync(path).isDirectory();
  const wants = folder ? FOLDER : SINGLE;
  const texts = new Map<string, string>();
  const read = (file: string): string | null => {
    const p = folder ? join(path, file) : path;
    if (!texts.has(p)) {
      if (!existsSync(p)) return null;
      texts.set(p, readFileSync(p, "utf8"));
    }
    return texts.get(p) ?? null;
  };
  const parts: string[] = [];
  const missing: string[] = [];
  for (const w of wants) {
    const label = folder ? w.file : basename(path);
    const text = read(w.file);
    const body = text === null ? null : section(text, w.start);
    if (body === null) {
      missing.push(`${label} § ${w.name}`);
      continue;
    }
    parts.push(`=== ${label} § ${w.name} ===\n${body}`);
  }
  if (missing.length > 0) {
    for (const m of missing) process.stderr.write(`spirit-input: missing ${m}\n`);
    return 1;
  }
  writeFileSync(out, `${parts.join("\n\n")}\n`);
  process.stdout.write(`${out}\n`);
  return 0;
}

if (process.argv[1] && import.meta.filename === (await import("node:fs")).realpathSync(process.argv[1]))
  await runToExit(() => exit(main(process.argv.slice(2))));
