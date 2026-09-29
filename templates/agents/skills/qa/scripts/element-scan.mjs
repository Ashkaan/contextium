#!/usr/bin/env node
// element-scan.mjs — flatten each JSX/HTML opening tag onto one line, so an
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
// Usage: element-scan.mjs <tag>[,<tag>...] <file>...
// Output: FILE<TAB>START_LINE<TAB>opening tag, whitespace-collapsed
//
// peers:
//   .agents/skills/qa/scripts/system-drift.sh
//   .agents/skills/qa/scripts/tests/system-drift.test.sh

import { readFileSync } from "node:fs";

const [tagArg, ...files] = process.argv.slice(2);
if (!tagArg || files.length === 0) {
  process.stderr.write("usage: element-scan.mjs <tag>[,<tag>...] <file>...\n");
  process.exit(2);
}
const tags = tagArg.split(",").filter(Boolean);
const OPEN = new RegExp(`<(${tags.join("|")})(?=[\\s/>])`, "g");

/** Whole-line comments: a tag named in prose is not a rendered element. */
const COMMENT = /^\s*(\/\/|\*|\/\*|#|<!--)/;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index) => {
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

  OPEN.lastIndex = 0;
  let m;
  while ((m = OPEN.exec(text)) !== null) {
    const startLine = lineOf(m.index);
    if (COMMENT.test(lines[startLine - 1] ?? "")) continue;

    // Walk forward to the `>` that closes the OPENING tag: depth 0 for braces
    // and brackets, and not inside a string.
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
    const tag = text.slice(m.index, end + 1).replace(/\s+/g, " ");
    process.stdout.write(`${file}\t${startLine}\t${tag}\n`);
    OPEN.lastIndex = end + 1;
  }
}
