#!/usr/bin/env -S node --experimental-strip-types
// system-drift.ts — count how far a repo's source has drifted from the design
// system the repo itself declares.
//
// WHY THIS EXISTS. `/qa` delegates the whole question of what an app should look
// like to that app's own `DESIGN.md`, and that delegation is right — every app
// gets a fresh design, so a globally prescribed look gets in the way. What was
// missing was any check that the source still MATCHES the delegated authority.
// So a portal with 467 raw palette literals, 148 hand-patched type sizes and
// eight OS-native select widgets reported a clean `/qa`, run after run.
//
// WHAT IT IS NOT. It holds no opinion about what a good design is. Every measure
// below is a fact about the source read against a scale the repo declared for
// itself. A repo that declares a one-entry ramp is
// measured against that one entry; a key it does not declare disarms its measure
// and never fails. Consistency is the floor this measures, not beauty — a design
// can be perfectly internally consistent and still be ugly, and that judgement
// belongs to `/qa`'s fresh-eyes pass.
//
// COUNTING UNIT: one finding per DISTINCT off-scale value, carrying how many
// times it occurs and up to five `file:line` examples. Not one finding per
// occurrence — 467 findings is a dump, not a review.
//
// SEVERITY, and the reasoning:
//   P1  a native platform widget. The user sees an unstyled OS control; no
//       design system survives that, so it blocks regardless of count.
//   P2  an off-scale value used 10 or more times. That is systemic drift.
//   P3  under 10. A one-off.
//   claim  a class recipe that maps to no declared variant. Reported for the
//       reviewer to adjudicate, never counted as a defect.
//   No measure emits P0. A scanner cannot know what blocks a task.
//
// Usage: system-drift.ts <repo-path>
// Exit: 0 clean (and silent) · 1 findings · 2 unparseable frontmatter or usage
//       · 3 no design authority, or a stub one · 4 no such directory
//
// peers:
//   .agents/skills/qa/scripts/design-authority.ts
//   .agents/skills/qa/scripts/design-frontmatter.ts
//   .agents/skills/qa/scripts/element-scan.ts
//   .agents/skills/qa/scripts/tests/system-drift.test.ts
//   .agents/skills/qa/references/review-rubric.md

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, opendirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FrontmatterError, readDeclared } from "./design-frontmatter.ts";
import { scanElements } from "./element-scan.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const HERE = dirname(fileURLToPath(import.meta.url));

  const arg = process.argv[2] ?? "";
  if (!arg) {
    process.stderr.write("usage: system-drift.ts <repo-path>\n");
    exit(2);
  }
  if (!existsSync(arg) || !statSync(arg).isDirectory()) {
    process.stderr.write(`system-drift: no such directory: ${arg}\n`);
    exit(4);
  }
  const REPO = resolve(arg);

  // ── The authority has to exist, and have a design in it ───────────────────
  // Exit 3 is DISTINCT from clean on purpose. A missing or stub authority means
  // every measure below is unarmed, and "nothing to compare against" must never
  // read as "nothing wrong".
  const auth = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(HERE, "design-authority.ts"), "status", REPO],
    { encoding: "utf8" },
  );
  // design-authority writes each verdict to one stream only, so stdout then
  // stderr is the order a merged `2>&1` capture would have shown.
  const authority = `${auth.stdout ?? ""}${auth.stderr ?? ""}`.replace(/\n+$/, "");
  if (auth.status === 3) {
    process.stdout.write(`${authority}\n`);
    process.stdout.write(
      "[P1] design-authority — this app has no design system. The design-system checks are running against an auto-extracted token list and cannot fail.\n",
    );
    process.stdout.write("system-drift: P1=1 P2=0 P3=0 claims=0\n");
    exit(3);
  }
  if (auth.status !== 0) {
    process.stderr.write(`${authority}\n`);
    exit(2);
  }

  // The declared scales, read through design-frontmatter.ts's KEY/value
  // contract. The name is matched against a fixed list first, so nothing in a
  // hand-edited DESIGN.md can choose which measure it arms — an unexpected key is
  // the reader and this counter disagreeing, and that is a halt, not a guess.
  const declared = new Map<string, string>();
  try {
    for (const [key, value] of readDeclared(REPO)) {
      if (
        /^(TYPE_SCALE|COLORS|SPACING_SCALE|RADIUS_SCALE|CONTROL_HEIGHTS)$/.test(key) ||
        /^VARIANTS_[A-Z_0-9]/.test(key)
      ) {
        declared.set(key, value);
      } else if (key !== "") {
        process.stderr.write(`system-drift: unexpected declaration '${key}' from design-frontmatter.ts\n`);
        exit(2);
      }
    }
  } catch (e) {
    if (!(e instanceof FrontmatterError)) throw e;
    process.stderr.write(`${e.message}\n`);
    exit(2);
  }

  // ── The files that ship ───────────────────────────────────────────────────
  // Tests are excluded: a class asserted in a test is not a pixel a user sees, and
  // including them makes every fixture a finding.
  const PRUNE = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".astro",
    ".wrangler",
    ".open-next",
    "__tests__",
  ]);
  const SHIPPED = /\.(tsx|jsx|ts|js|vue|svelte|astro|html|css|scss)$/;
  const FILES: string[] = [];
  // Depth-first in the directory's own unsorted order, the order `find` walks —
  // the evidence lines are listed in the order the files were scanned, so this
  // reads with `opendirSync`, which does not sort, where `readdirSync` does.
  function walk(dir: string): void {
    const handle = opendirSync(dir);
    const entries: Dirent[] = [];
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) entries.push(entry);
    handle.closeSync();
    for (const entry of entries) {
      if (PRUNE.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SHIPPED.test(entry.name) && !/\.(test|spec)\./.test(path)) FILES.push(path);
    }
  }
  walk(REPO);
  if (FILES.length === 0) {
    process.stderr.write(`system-drift: no source files under ${REPO}\n`);
    exit(2);
  }

  /** Each scanned file's lines, read once. A binary file has none, as grep reports none. */
  const LINES = new Map<string, string[]>();
  function linesOf(file: string): string[] {
    let lines = LINES.get(file);
    if (!lines) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        text = "";
      }
      lines = text.includes("\0") ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
      LINES.set(file, lines);
    }
    return lines;
  }

  // isComment LINE — a hit inside a source comment is not a pixel anybody sees.
  // Line-level, deliberately: a token named in prose ("the old --border was
  // #D8DDE6") is the common case, and a character-offset parser for four comment
  // syntaxes would be more machinery than the problem is worth. A trailing comment
  // after real code is the case this misses, and it under-reports rather than
  // inventing findings.
  const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*|#|<!--)/.test(line);

  // elements TAGS — every opening tag of those kinds in the scanned files, each
  // flattened onto one line. Attributes live on the lines BELOW the tag name in
  // formatted JSX, so a line-based grep sees a fraction of them; element-scan.ts
  // is what makes an attribute scan honest. Every file is handed over by path,
  // whole: when this was an `xargs` pipe, a path containing a space became two
  // unreadable fragments the scanner skipped in silence, and a control in that
  // file then passed by never having been looked at.
  const elements = (tags: string) => scanElements(tags, FILES);

  // rel PATH — the path as the reader will look for it.
  const rel = (path: string): string => (path.startsWith(`${REPO}/`) ? path.slice(REPO.length + 1) : path);

  /** awk's `$1 + 0`: the leading number of a string, 0 when there is none. */
  const num = (s: string): number => {
    const n = Number.parseFloat(s);
    return Number.isNaN(n) ? 0 : n;
  };

  // toPx LENGTH — normalise a CSS length to whole pixels, or undefined when it is
  // not a length this can compare (em, %, calc).
  function toPx(length: string): string | undefined {
    const v = length.toLowerCase();
    if (v.endsWith("px")) return String(Math.trunc(num(v.slice(0, -2)) + 0.5));
    if (v.endsWith("rem")) return String(Math.trunc(num(v.slice(0, -3)) * 16 + 0.5));
    return undefined;
  }

  // setOfPx LIST — the declared scale, as a set of whole-pixel values.
  function setOfPx(list: string): Set<string> {
    const out = new Set<string>();
    for (const v of list.split("|")) {
      const px = toPx(v);
      if (px !== undefined) out.add(px);
    }
    return out;
  }

  /** Byte order, which is `sort`'s order under the C.UTF-8 locale this ran in. */
  const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

  type Severity = "P1" | "P2" | "P3" | "claim";
  const findings: string[] = [];
  const counts: Record<Severity, number> = { P1: 0, P2: 0, P3: 0, claim: 0 };

  function report(sev: Severity, measure: string, value: string, note: string, evidence: string[]): void {
    const n = evidence.length;
    findings.push(`[${sev}] ${measure}  ${value} — ${n} occurrence(s); ${note}`);
    for (const e of evidence.slice(0, 5)) findings.push(`       ${e}`);
    if (n > 5) findings.push(`       …and ${n - 5} more`);
    counts[sev]++;
  }

  // severityFor COUNT — the SPEC's own boundary: 10 or more occurrences of one
  // off-scale value is systemic; fewer is a one-off.
  const severityFor = (count: number): Severity => (count >= 10 ? "P2" : "P3");

  /** Evidence grouped by value, in first-seen order within each value. */
  function group(pairs: Array<[string, string]>): Map<string, string[]> {
    const byValue = new Map<string, string[]>();
    for (const [value, where] of pairs) {
      const list = byValue.get(value) ?? [];
      list.push(where);
      byValue.set(value, list);
    }
    return byValue;
  }

  // groupAndReport MEASURE NOTE PAIRS — PAIRS is `[value, file:line]`. Most
  // occurrences first; a tie falls back to the value, descending, which is where
  // `sort -rn` over `count<TAB>value` lines put it.
  function groupAndReport(measure: string, note: string, pairs: Array<[string, string]>): void {
    const ordered = [...group(pairs)].sort(([va, ea], [vb, eb]) => eb.length - ea.length || byteCompare(vb, va));
    for (const [value, evidence] of ordered) report(severityFor(evidence.length), measure, value, note, evidence);
  }

  /** Every line of every scanned file that is not a comment, with its 1-based number. */
  function* codeLines(): Generator<[string, number, string]> {
    for (const file of FILES) {
      const lines = linesOf(file);
      for (let i = 0; i < lines.length; i++) if (!isComment(lines[i])) yield [file, i + 1, lines[i]];
    }
  }

  // ── Measure 1 — type sizes not on the declared ramp ───────────────────────
  // Only LENGTHS are measured: `text-[13px]` and a raw `font-size:`. A named
  // utility is deliberately not compared, because `text-muted-foreground` and
  // `text-center` are not sizes and a name-based scan reports them as drift.
  const TYPE_SCALE = declared.get("TYPE_SCALE") ?? "";
  if (TYPE_SCALE) {
    const ramp = setOfPx(TYPE_SCALE);
    const pairs: Array<[string, string]> = [];
    for (const [file, line, raw] of codeLines()) {
      for (const hit of raw.match(/text-\[[0-9.]+(px|rem)\]|font-size:\s*[0-9.]+(px|rem)/g) ?? []) {
        for (const len of hit.match(/[0-9.]+(px|rem)/g) ?? []) {
          const px = toPx(len);
          if (px === undefined || ramp.has(px)) continue;
          pairs.push([`${px}px`, `${rel(file)}:${line}`]);
        }
      }
    }
    groupAndReport("type-size", `not in the declared ramp (${TYPE_SCALE})`, pairs);
  }

  // ── Measure 2 — colours not in the declared palette ───────────────────────
  // Two shapes. A raw Tailwind palette step can never be a declared token, so it
  // is off-palette by construction. A raw hex/rgb/hsl literal is compared against
  // the declared values, whitespace-insensitively. `var(--x)` is a token
  // reference, not a literal, and is never a finding.
  const COLORS = declared.get("COLORS") ?? "";
  if (COLORS) {
    const normColors = `|${COLORS.toLowerCase().replaceAll(" ", "")}|`;
    const pairs: Array<[string, string]> = [];
    const PALETTE =
      /\b(bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder)-(slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b/g;
    for (const [file, line, raw] of codeLines()) {
      for (const tok of raw.match(PALETTE) ?? []) pairs.push([tok, `${rel(file)}:${line}`]);
    }
    const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
    for (const [file, line, raw] of codeLines()) {
      // Spaces are dropped before the compare, so `rgb(0, 0, 0)` and
      // `rgb(0,0,0)` are one colour.
      const toks = (raw.match(LITERAL) ?? []).flatMap((m) => m.replaceAll(" ", "").split(/\s+/).filter(Boolean));
      for (const tok of toks) {
        if (tok.includes("var(--")) continue;
        if (normColors.includes(`|${tok.toLowerCase()}|`)) continue;
        pairs.push([tok, `${rel(file)}:${line}`]);
      }
    }
    groupAndReport("off-palette-colour", "not a declared colour token", pairs);
  }

  // ── Measure 3 — control heights not in the declared set ───────────────────
  // Scoped to lines that render an interactive element, so `h-4` on an icon is not
  // reported as a control height. That is a fact about the line, not a threshold.
  const CONTROL_HEIGHTS = declared.get("CONTROL_HEIGHTS") ?? "";
  if (CONTROL_HEIGHTS) {
    const heights = setOfPx(CONTROL_HEIGHTS);
    const pairs: Array<[string, string]> = [];
    for (const { file, line, tag } of elements(
      "button,Button,input,Input,select,Select,SelectTrigger,textarea,Textarea,Checkbox",
    )) {
      // No trailing \b: a word boundary cannot follow the `]` of `h-[41px]`,
      // so every arbitrary-value height walked straight past this scan.
      for (const m of tag.matchAll(/(^|[^a-z0-9-])((?:min-)?h-(?:\[[0-9.]+(?:px|rem)\]|[0-9]+(?:\.[0-9]+)?))/g)) {
        const tok = m[2];
        const len = /[0-9.]+(px|rem)/.exec(tok)?.[0];
        // Tailwind's numeric spacing scale: one step is 4px.
        const px = len ? toPx(len) : String(Math.trunc(num(/[0-9.]+$/.exec(tok)?.[0] ?? "") * 4 + 0.5));
        if (px === undefined || heights.has(px)) continue;
        pairs.push([`${tok} (${px}px)`, `${rel(file)}:${line}`]);
      }
    }
    groupAndReport("control-height", `not one of the declared control heights (${CONTROL_HEIGHTS})`, pairs);
  }

  // ── Measure 4 — recipes that map to no declared variant ───────────────────
  // NOT "how many distinct recipes exist" — the system itself permits several
  // variants and three sizes, so a raw count would invent a threshold. What is
  // reported is an element rendering the RAW html tag for a role the design system
  // has a component for: it cannot map to any declared variant because it does not
  // use the component at all. A claim for the reviewer, never a defect.
  // The role order is the order bash's associative array listed them in, so the
  // claims come out in the order they always have.
  const ROLE_TAG: Array<[string, string]> = [
    ["TABLE", "table"],
    ["INPUT", "input"],
    ["BUTTON", "button"],
    ["TEXTAREA", "textarea"],
    ["SELECT", "select"],
  ];
  for (const [role, tag] of ROLE_TAG) {
    const variants = declared.get(`VARIANTS_${role}`) ?? "";
    if (!variants) continue;
    const evidence = elements(tag).map(({ file, line }) => `${rel(file)}:${line}`);
    if (evidence.length) {
      report(
        "claim",
        "unmapped-recipe",
        `raw <${tag}>`,
        `renders the platform element rather than a declared '${role.toLowerCase()}' variant (${variants}) — adjudicate, not a defect`,
        evidence,
      );
    }
  }

  // ── Measure 5 — native platform widgets (always armed) ────────────────────
  // The one measure that needs no declaration: whatever the design says, an OS
  // picker is not it.
  // Three spellings of one attribute — `type="date"`, `type='date'` and JSX's
  // `type={"date"}`. A regex that knows only the first reports a different answer
  // for markup that renders identically.
  // The value must be a QUOTED literal, or a bare HTML attribute that ends at a
  // delimiter. `type={fileType}` is a variable whose value is unknown at scan
  // time, and matching it on the prefix `file` reported a blocking P1 about a
  // control that may well be a text box.
  // `datetime-local` is listed before `date`: a regex takes the first alternative
  // that fits, where grep took the longest.
  const NATIVE_KINDS = "datetime-local|date|month|week|time|color|file|range|number";
  const NATIVE_TYPE = new RegExp(`type=\\{?["'](${NATIVE_KINDS})["']|type=(${NATIVE_KINDS})(\\s|>|/|$)`);
  const native: Array<[string, string]> = [];
  for (const { file, line, tag } of elements("select")) {
    if (tag.includes("appearance-none")) continue;
    native.push(["native <select>", `${rel(file)}:${line}`]);
  }
  // `<Input type="date">` counts too: a themed wrapper does not change which
  // widget the browser opens, and the OS date picker is the OS date picker.
  for (const { file, line, tag } of elements("input,Input")) {
    if (tag.includes("appearance-none")) continue;
    const m = NATIVE_TYPE.exec(tag);
    const t = m?.[1] ?? m?.[2];
    if (!t) continue;
    native.push([`native <input type=${t}>`, `${rel(file)}:${line}`]);
  }
  for (const [value, evidence] of [...group(native)].sort(([a], [b]) => byteCompare(a, b))) {
    report(
      "P1",
      "native-widget",
      value,
      "renders the operating system's own control, which no design system can style",
      evidence,
    );
  }

  // ── Result ────────────────────────────────────────────────────────────────
  // Zero divergences prints NOTHING. No congratulation: a scanner finding nothing
  // is a floor, not a verdict, and a cheerful "clean!" is exactly what let a
  // stub DESIGN.md pass for months.
  if (findings.length === 0) exit(0);
  process.stdout.write(`${findings.join("\n")}\n`);
  process.stdout.write(`system-drift: P1=${counts.P1} P2=${counts.P2} P3=${counts.P3} claims=${counts.claim}\n`);
  exit(1);
}

await runToExit(main);
