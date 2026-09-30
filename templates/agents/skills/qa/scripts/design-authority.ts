#!/usr/bin/env -S node --experimental-strip-types
// design-authority.ts — is this repo's DESIGN.md a real design system, or a stub?
//
// WHY THIS EXISTS. `/qa` delegates the entire question of what an app should
// look like to that app's own `DESIGN.md`, and that reasoning is sound — every
// app gets a fresh design, so a globally prescribed look gets in the way. What
// was missing is a check that the delegated authority contains a design at all.
// `gen-design-md.ts` auto-writes the file on a repo's first run as a token
// inventory whose creative direction is, in its own words, "intentionally
// omitted". So the four design-system checks ran against nothing and the run
// reported clean forever: a clean `/qa` on a portal its owner found plainly bad.
//
// THE RULE, in one place because three callers need it (`/qa` step-2.5,
// `system-drift.ts`, and anyone auditing a repo by hand):
//
//   A DESIGN.md is a STUB iff it carries `design-authority: generated-stub`
//   in its frontmatter, OR its body declares none of the contract headings.
//
// Both limbs, one rule. A marker alone would exempt every DESIGN.md generated
// before the marker existed — which is the whole population that has the
// problem. A heading scan alone would pass a hand-written file that lists tokens
// under a "## Colors" heading and calls it a system.
//
// Usage:
//   design-authority.ts status <repo>   AUTHORITY=real|stub|missing on stdout
//   design-authority.ts headings        the contract-heading vocabulary, one per line
//
// Exit: 0 real · 2 usage or unparseable frontmatter · 3 stub or missing · 4 no repo
//
// peers:
//   .agents/skills/qa/scripts/gen-design-md.ts
//   .agents/skills/qa/scripts/system-drift.ts
//   .agents/skills/qa/scripts/tests/design-authority.test.ts

import { existsSync, readFileSync, statSync } from "node:fs";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  // The vocabulary. A design SYSTEM says something about at least one of these; a
  // token inventory says nothing about any of them. Matched against markdown
  // heading TEXT only, case-insensitively, so a `colors:` frontmatter key does not
  // count as a heading about colour.
  // DELIBERATELY NO `colour`. A generated token inventory is exactly a list of
  // colours under a colour heading, and accepting that word would let the second
  // limb pass the whole population this rule exists to catch.
  const HEADING_VOCAB =
    "type|typography|weight|spacing|radius|radii|control|field|form|focus|status|semantic|empty|loading|error|state|elevation|shadow|motion|anatomy";

  function usage(): never {
    process.stderr.write("usage: design-authority.ts status <repo> | design-authority.ts headings\n");
    exit(2);
  }

  const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
  const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

  function say(authority: string, reason: string, code: number): never {
    process.stdout.write(`AUTHORITY=${authority}\nREASON=${reason}\n`);
    exit(code);
  }

  const verb = process.argv[2] ?? "";
  if (verb === "headings") {
    process.stdout.write(`${HEADING_VOCAB}\n`);
    exit(0);
  }
  if (verb !== "status") usage();

  const repo = process.argv[3] ?? "";
  if (!repo) usage();
  if (!isDir(repo)) {
    process.stderr.write(`design-authority: no such directory: ${repo}\n`);
    exit(4);
  }

  const file = `${repo}/DESIGN.md`;
  if (!isFile(file)) say("missing", `no DESIGN.md in ${repo} — /qa has no design to check this app against`, 3);

  // ── Split frontmatter from body ───────────────────────────────────────────
  // A file that opens with `---` must close it. An unterminated block is a parse
  // failure, not an empty frontmatter: reading it as empty would silently scan a
  // partial file and report a clean result.
  const text = readFileSync(file, "utf8");
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  let frontmatter: string[] = [];
  let body: string[] = lines;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) {
      process.stderr.write(`AUTHORITY=malformed\nREASON=${file} opens a --- frontmatter block that is never closed\n`);
      exit(2);
    }
    frontmatter = lines.slice(1, end);
    body = lines.slice(end + 1);
  }

  // ── Limb one: the generator's own marker ──────────────────────────────────
  // The SCALAR, not the line. `design-authority: "generated-stub"` and
  // `design-authority: generated-stub  # written by /qa` are the same declaration
  // as the bare form, and an anchored line match let both of them through.
  const markerLine = frontmatter.map((l) => /^\s*design-authority:\s*([\s\S]*)$/.exec(l)).find((m) => m !== null);
  const marker = (markerLine?.[1] ?? "")
    .replace(/\s*#[\s\S]*$/, "")
    .replace(/\s*$/, "")
    .replace(/^["']/, "")
    .replace(/["']$/, "")
    .replace(/\s*$/, "");
  if (marker === "generated-stub") {
    say(
      "stub",
      `${file} declares design-authority: generated-stub — it is an auto-extracted token list, not a design system`,
      3,
    );
  }

  // ── Limb two: a body that declares no contract ────────────────────────────
  const contract = new RegExp(`^#{1,4}\\s+.*(${HEADING_VOCAB})`, "i");
  const declared = body.filter((l) => contract.test(l)).length;
  if (declared === 0) {
    say("stub", `${file} declares no design contract — no heading about ${HEADING_VOCAB.replaceAll("|", " ")}`, 3);
  }

  say("real", `${file} declares ${declared} design contract heading(s)`, 0);
}

await runToExit(main);
