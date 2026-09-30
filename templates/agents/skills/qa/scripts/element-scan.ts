#!/usr/bin/env -S node --experimental-strip-types
// element-scan.ts — flatten each JSX/HTML opening tag onto one line, so an
// attribute scan can actually see its attributes.
//
// WHY THIS EXISTS. Formatted JSX puts the tag on one line and its attributes on
// the next five. A single-line `grep '<input[^>]*type="date"'` therefore matches
// only the elements that happen to be short — it found 1 of the 35 native
// date/number/file inputs in one real portal and reported the other 34 as
// absent. Under-reporting that reads as a clean result is the exact failure the
// design-drift check exists to stop, so the scan is not allowed to be
// line-based.
//
// WHY NOT awk. Finding where an opening tag ENDS needs brace and string
// tracking: `onChange={(e) => ...}` contains a `>` that is not the end of the
// tag, and the first attempt at this in awk truncated 33 of 35 elements on
// exactly that. A character scanner is the honest tool and it is ten lines.
//
// Usage: element-scan.ts <tag>[,<tag>...] <file>...
// Output: FILE<TAB>START_LINE<TAB>opening tag, whitespace-collapsed
//
// As a module: `scanElements(tags, files)` returns the same rows as records;
// system-drift.ts imports it.
//
// peers:
//   .agents/skills/qa/scripts/system-drift.ts
//   .agents/skills/qa/scripts/tests/element-scan.test.ts

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

export interface Element {
  file: string;
  line: number;
  tag: string;
}

/** Whole-line comments: a tag named in prose is not a rendered element. */
const COMMENT = /^\s*(\/\/|\*|\/\*|#|<!--)/;

/** Every opening tag named in `tagArg` (comma-separated), file by file, in document order. */
export function scanElements(tagArg: string, files: readonly string[]): Element[] {
  const tags = tagArg.split(",").filter(Boolean);
  const open = new RegExp(`<(${tags.join("|")})(?=[\\s/>])`, "g");
  const out: Element[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (index: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const lines = text.split("\n");

    open.lastIndex = 0;
    for (let m = open.exec(text); m !== null; m = open.exec(text)) {
      const startLine = lineOf(m.index);
      if (COMMENT.test(lines[startLine - 1] ?? "")) continue;

      // Walk forward to the `>` that closes the OPENING tag: depth 0 for
      // braces and brackets, and not inside a string.
      let depth = 0;
      let quote = "";
      let end = -1;
      for (let i = m.index; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = "";
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{" || c === "[" || c === "(") depth++;
        else if (c === "}" || c === "]" || c === ")") depth--;
        else if (c === ">" && depth === 0) {
          end = i;
          break;
        }
        // A tag that has not closed in 4000 characters is not a tag.
        if (i - m.index > 4000) break;
      }
      if (end < 0) continue;
      out.push({ file, line: startLine, tag: text.slice(m.index, end + 1).replace(/\s+/g, " ") });
      open.lastIndex = end + 1;
    }
  }
  return out;
}

function main(): void {
  const [tagArg, ...files] = process.argv.slice(2);
  if (!tagArg || files.length === 0) {
    process.stderr.write("usage: element-scan.ts <tag>[,<tag>...] <file>...\n");
    exit(2);
  }
  for (const { file, line, tag } of scanElements(tagArg, files)) process.stdout.write(`${file}\t${line}\t${tag}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
