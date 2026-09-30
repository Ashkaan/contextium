#!/usr/bin/env node
// gen-design-md.ts — deterministically extract a repo's design tokens into a
// DESIGN.md frontmatter block, the file impeccable's detector reads as its
// token allowlist. ONE file, no sidecar. Writes nothing if DESIGN.md exists.
//
// Token extraction is data, not judgment: we grep
// the places tokens actually live — CSS custom properties, a Tailwind theme,
// and font-family declarations — and emit only what we find. Absent classes are
// omitted; impeccable arms each check per-section, so a partial file is safe.
//
// WHAT IT WRITES IS A STUB, AND IT NOW SAYS SO. Every file this generates
// carries `design-authority: generated-stub` in its frontmatter. Extracted
// tokens are not a design system — there is no type ramp, no spacing scale, no
// control sizes, no field or focus anatomy and no empty state in them — and
// without the marker /qa delegated the whole look question to a file that
// answered nothing and reported clean forever. A human DELETING that key is the
// act of claiming the file is now a real system; see design-authority.ts, which
// owns the stub rule and its second limb (a body declaring no contract at all).
//
// Usage: node gen-design-md.ts <repo-path> [--force] [--print]
//        node gen-design-md.ts --mark-existing <repo-path>
//   --force          overwrite an existing DESIGN.md
//   --print          write to stdout instead of the file (for testing)
//   --mark-existing  backfill the stub marker into a DESIGN.md this generator
//                    wrote before the marker existed. Identified by the body
//                    matching the generator's own output shape, so a
//                    hand-written file is never touched.
// Exit: 0 wrote (or would write, or marked); 3 DESIGN.md already exists (no
//       --force) or --mark-existing found nothing to mark; 4 no tokens found —
//       nothing to write; 2 usage.

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith("--"));
  const FORCE = args.includes("--force");
  const PRINT = args.includes("--print");
  const MARK_EXISTING = args.includes("--mark-existing");
  if (!repo) {
    process.stderr.write("usage: gen-design-md.ts <repo-path> [--force] [--print] | --mark-existing <repo-path>\n");
    exit(2);
  }

  const designPath = join(repo, "DESIGN.md");
  const STUB_MARKER = "design-authority: generated-stub";

  /**
   * The sentence this generator has always written into the body it produces.
   * It is the fingerprint: a file carrying it came from here, whatever its
   * frontmatter says. A hand-written design system does not describe itself as
   * omitting its own creative direction.
   */
  const GENERATED_FINGERPRINT =
    "Sections it could not infer (creative direction, elevation philosophy) are intentionally omitted";

  if (MARK_EXISTING) {
    if (!existsSync(designPath)) {
      process.stderr.write(`gen-design-md: no ${designPath} to mark\n`);
      exit(3);
    }
    const current = readFileSync(designPath, "utf8");
    if (current.includes(STUB_MARKER)) {
      process.stderr.write(`gen-design-md: ${designPath} is already marked\n`);
      exit(3);
    }
    if (!current.includes(GENERATED_FINGERPRINT)) {
      // Not ours. A hand-written file that happens to be thin is still a human's
      // claim about the design, and the stub rule's SECOND limb — a body with no
      // contract headings — is what catches it. Rewriting somebody's frontmatter
      // on a guess is not.
      process.stderr.write(`gen-design-md: ${designPath} was not written by this generator — leaving it alone\n`);
      exit(3);
    }
    if (!current.startsWith("---\n")) {
      process.stderr.write(`gen-design-md: ${designPath} has no frontmatter block to mark\n`);
      exit(3);
    }
    const marked = current.replace("---\n", `---\n${STUB_MARKER}\n`);
    writeFileSync(designPath, marked);
    process.stderr.write(`gen-design-md: marked ${designPath} as a generated stub\n`);
    exit(0);
  }

  if (existsSync(designPath) && !FORCE && !PRINT) {
    process.stderr.write(`gen-design-md: ${designPath} already exists (use --force to overwrite)\n`);
    exit(3);
  }

  // ── collect candidate source files ───────────────────────────────────────
  const SCAN_EXT = new Set([
    ".css",
    ".scss",
    ".astro",
    ".tsx",
    ".jsx",
    ".vue",
    ".svelte",
    ".ts",
    ".js",
    ".mjs",
    ".cjs",
  ]);
  const SKIP_DIR = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".open-next",
    ".wrangler",
    ".astro",
    "out",
    "coverage",
  ]);
  const files: string[] = [];
  function walk(dir: string, depth = 0): void {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (SCAN_EXT.has(extname(e.name))) {
        files.push(full);
      }
    }
  }
  walk(repo);

  // Tailwind config gets read whole (it's the theme SSOT when present).
  const tailwindFiles = files.filter((f) => /tailwind\.config\.(js|ts|cjs|mjs)$/.test(f));

  // ── extractors ────────────────────────────────────────────────────────────
  const colors = new Map<string, string>(); // slug -> value
  const radii = new Map<string, string>(); // slug -> value
  const fonts = new Map<string, string>(); // role -> family stack
  const sizes = new Map<string, string>(); // name -> non-fluid length (feeds the typography text-<name> entries)

  const COLOR_VAL = /(#[0-9a-fA-F]{3,8}\b|oklch\([^)]+\)|hsl\([^)]+\)|rgba?\([^)]+\))/;
  // ANCHORED: the whole value must BE a colour, not merely contain one. Distinguishes a real
  // token (`--ink: #1b232c`) from a composite that happens to embed a colour
  // (`--shadow-card: 0 1px 2px rgba(...)`, `--focus-ring: 0 0 0 3px rgba(...)`), which are not
  // colours and would pollute the allowlist.
  const COLOR_VAL_ONLY = /^(#[0-9a-fA-F]{3,8}|oklch\([^)]+\)|hsl\([^)]+\)|rgba?\([^)]+\))$/;
  const LEN_VAL = /(\d*\.?\d+(px|rem|em)|\b0\b|9999px|999px)/;

  function addColor(slug: string, val: string): void {
    slug = slug
      .replace(/^--/, "")
      .replace(/^color-/, "")
      .trim();
    val = val
      .trim()
      .replace(/;$/, "")
      .replace(/^["']|["']$/g, "");
    if (!slug || !COLOR_VAL.test(val)) return;
    if (/var\(/.test(val)) return; // alias, not a literal — skip
    if (!colors.has(slug)) colors.set(slug, val);
  }
  function addRadius(slug: string, val: string): void {
    slug = slug
      .replace(/^--/, "")
      .replace(/^(radius|rounded|border-radius)-/, "")
      .trim();
    val = val
      .trim()
      .replace(/;$/, "")
      .replace(/^["']|["']$/g, "");
    if (!slug || !LEN_VAL.test(val) || /var\(/.test(val)) return;
    if (!radii.has(slug)) radii.set(slug, val);
  }
  // A captured font-family value ends where the CSS value ends, which the regex
  // cannot tell from inside an HTML attribute: `style="font-family:Inter"
  // data-x="foo"` has no `;` or `>` before the next attribute. The rule is the
  // quote: a quote that follows a comma or whitespace (or starts the value)
  // OPENS a family name and its pair is kept verbatim, spaces and all; a quote
  // that follows any other character, spaces aside, CLOSES the attribute and
  // ends the value. A backslash escape inside a quoted family is kept.
  // Outside quotes, a formatter's line wrap collapses to one space.
  function cssFontValue(raw: string): string {
    let out = "";
    let open: string | null = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (open) {
        // A CSS escape (`\"`) is part of the family, not its end.
        if (c === "\\" && i + 1 < raw.length) {
          out += c + raw[++i];
          continue;
        }
        out += c;
        if (c === open) open = null;
        continue;
      }
      // In a plain JS string the attribute's closing quote arrives escaped
      // (`style=\"font-family:Arial\"`); the backslash is the boundary, not a
      // character of the family.
      if (c === "\\" && (raw[i + 1] === '"' || raw[i + 1] === "'")) break;
      if (c === '"' || c === "'") {
        const prev = out.trimEnd().at(-1);
        if (prev !== undefined && prev !== ",") break;
        open = c;
        out += c;
        continue;
      }
      if (/\s/.test(c)) {
        if (out !== "" && !/\s/.test(out.at(-1) ?? "")) out += " ";
        continue;
      }
      out += c;
    }
    return out.trim().replace(/;$/, "");
  }
  function addFont(role: string, stack: string): void {
    // Keep quotes inside the stack intact — a family like 'Lexend Deca' is valid
    // and stripping the outer quote corrupts it.
    stack = cssFontValue(stack);
    const first = stack.split(",")[0]?.replace(/["']/g, "").trim();
    if (!first || /^(inherit|initial|unset|var\()/.test(first)) return;
    // Reject values that are sizes, not families — a `--font-size-*` token or a
    // `font:` shorthand can leak in; a real family never starts with a digit or a
    // clamp/calc, and never carries a length unit as its first token.
    if (/^\d/.test(first) || /clamp\(|calc\(/.test(stack) || /^\d*\.?\d+(px|rem|em|%)$/.test(first)) return;
    if (!fonts.has(role)) fonts.set(role, stack);
  }
  function addSize(slug: string, val: string): void {
    slug = slug
      .replace(/^--/, "")
      .replace(/^(text|font-size|fs)-/, "")
      .trim();
    val = val
      .trim()
      .replace(/;$/, "")
      .replace(/^["']|["']$/g, "");
    // Only DECLARED, non-fluid size tokens — impeccable's hasFontSizes arms only
    // on a non-fluid enumerated step, so reject clamp()/calc()/var() (fluid or
    // aliased). This deliberately does NOT scrape every inline `font-size:` — that
    // would pollute the ramp with one-offs; only named token declarations count.
    if (!slug || /clamp\(|calc\(|var\(/.test(val)) return;
    if (!/^\d*\.?\d+(px|rem|em)$/.test(val)) return;
    if (!sizes.has(slug)) sizes.set(slug, val);
  }

  for (const f of files) {
    let txt: string;
    try {
      txt = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    // CSS custom properties — literal-color form: --color-navy: #10274A
    for (const m of txt.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) addColor(m[1], m[2]);
    // ANY custom property whose value is a bare colour literal: --ink: #1b232c,
    // --brand-teal: #2f4157, --st-on-fg: #0b6e4d. Most repos do not prefix their palette with
    // `--color-`, and before this pass such a repo produced a DESIGN.md with NO colors section
    // at all — which silently disarms impeccable's colour checks rather than failing loudly, so
    // the file reads as an allowlist while allowing everything. COLOR_VAL_ONLY is anchored, so
    // shadows, focus rings, and gradients (composites that merely contain a colour) stay out.
    for (const m of txt.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
      if (COLOR_VAL_ONLY.test(m[2].trim())) addColor(m[1], m[2]);
    }
    // shadcn HSL-channel form: --primary: 215 76% 50%  (consumed as hsl(var(--primary)))
    // Wrap the bare channels in hsl(...) so the value is a real CSS color.
    for (const m of txt.matchAll(/--([a-z0-9-]+)\s*:\s*(\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%)\s*;/gi)) {
      addColor(m[1], `hsl(${m[2].replace(/\s+/g, " ")})`);
    }
    // radii — both --radius-<name>: 4px and the bare shadcn --radius: 0.625rem
    for (const m of txt.matchAll(/--(?:radius|rounded)-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) addRadius(m[1], m[2]);
    for (const m of txt.matchAll(/--radius\s*:\s*([^;]+);/gi)) addRadius("base", m[1]);
    // font-family declarations -> collect distinct stacks as roles. A stack never
    // holds `>` or a backtick, so they end the value too: inside an HTML template
    // string the next `;` can be lines away, which is how one generated stub got
    // 200 characters of email markup as its body font. A newline does NOT end
    // it — a formatter wraps a long stack after a comma.
    for (const m of txt.matchAll(/font-family\s*:\s*([^;{}>`]+)[;}>`]/gi)) addFont("_stack" + fonts.size, m[1]);
    // --font-<role>: stack  (the (?!size-) lookahead keeps --font-size-* out of fonts)
    for (const m of txt.matchAll(/--font-(?!size-)([a-z0-9-]+)\s*:\s*([^;]+);/gi)) addFont(m[1], m[2]);
    // declared font-size tokens: --text-sm / --font-size-lg / --fs-base: 0.875rem
    for (const m of txt.matchAll(/--(?:text|font-size|fs)-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) addSize(m[1], m[2]);
  }

  // Tailwind theme (colors / borderRadius / fontFamily) — best-effort object scrape
  for (const tw of tailwindFiles) {
    let txt: string;
    try {
      txt = readFileSync(tw, "utf8");
    } catch {
      continue;
    }
    const grab = (key: string): string => {
      const i = txt.indexOf(key);
      if (i < 0) return "";
      let depth = 0,
        start = -1;
      for (let j = i + key.length; j < txt.length; j++) {
        const c = txt[j];
        if (c === "{") {
          if (depth === 0) start = j;
          depth++;
        } else if (c === "}") {
          depth--;
          if (depth === 0) return txt.slice(start, j + 1);
        }
      }
      return "";
    };
    for (const m of grab("colors:").matchAll(/['"]?([a-z0-9-]+)['"]?\s*:\s*['"]([^'"]+)['"]/gi)) addColor(m[1], m[2]);
    for (const m of grab("borderRadius:").matchAll(/['"]?([a-z0-9-]+)['"]?\s*:\s*['"]([^'"]+)['"]/gi))
      addRadius(m[1], m[2]);
    for (const m of grab("fontFamily:").matchAll(/['"]?([a-z0-9-]+)['"]?\s*:\s*\[([^\]]+)\]/gi))
      addFont(m[1], m[2].replace(/['"]/g, ""));
    // fontSize: { sm: '0.875rem' } OR { sm: ['0.875rem', { lineHeight }] } — take
    // the first quoted string either way (bare value or first array element).
    for (const m of grab("fontSize:").matchAll(/['"]?([a-z0-9-]+)['"]?\s*:\s*(?:\[\s*)?['"]([^'"]+)['"]/gi))
      addSize(m[1], m[2]);
  }

  // Collapse duplicate anonymous font stacks to named roles by first family.
  const seenFamily = new Set<string>();
  const namedFonts = new Map<string, string>();
  let roleIdx = 0;
  const roleNames = ["body", "display", "mono", "accent"];
  for (const [role, stack] of fonts) {
    const first = stack.split(",")[0].replace(/["']/g, "").trim().toLowerCase();
    if (seenFamily.has(first)) continue;
    seenFamily.add(first);
    const name = role.startsWith("_stack") ? roleNames[roleIdx++] || `family-${roleIdx}` : role;
    namedFonts.set(name, stack);
  }

  const total = colors.size + radii.size + namedFonts.size + sizes.size;
  if (total === 0) {
    process.stderr.write(
      "gen-design-md: no design tokens found (no CSS vars, Tailwind theme, or font-family) — nothing to write\n",
    );
    exit(4);
  }

  // ── emit frontmatter (map syntax only; numeric keys quoted) ────────────────
  const q = (s: string): string => (/^[0-9]/.test(s) ? `"${s}"` : s);
  const lines = [
    "---",
    // FIRST LINE OF THE BLOCK, so a reader and a grep both meet it before the
    // token dump that follows.
    STUB_MARKER,
    `name: ${repoName(repo)}`,
    "description: Auto-extracted design tokens (colors, radii, fonts). Generated by /qa gen-design-md; edit to refine. This frontmatter is impeccable's token allowlist. This file is a STUB, not a design system — remove the design-authority key once it states a real one.",
  ];
  if (colors.size) {
    lines.push("colors:");
    for (const [k, v] of colors) lines.push(`  ${q(k)}: ${JSON.stringify(v)}`);
  }
  if (namedFonts.size || sizes.size) {
    lines.push("typography:");
    // One named entry per size, in the published DESIGN.md shape
    // (google-labs-code/design.md): its linter ignores any other map under
    // `typography`, and impeccable's design-system-font-size check reads the
    // entries' fontSize values as the ramp.
    for (const [k, v] of sizes) {
      lines.push(`  text-${k}:`);
      lines.push(`    fontSize: ${JSON.stringify(v)}`);
    }
    for (const [role, stack] of namedFonts) {
      lines.push(`  ${q(role)}:`);
      lines.push(`    fontFamily: ${JSON.stringify(stack)}`);
    }
  }
  if (radii.size) {
    lines.push("rounded:");
    for (const [k, v] of radii) lines.push(`  ${q(k)}: ${JSON.stringify(v)}`);
  }
  lines.push(
    "---",
    "",
    `# Design System: ${repoName(repo)}`,
    "",
    "## Overview",
    "",
    "Auto-generated from the tokens already in this repo. The frontmatter above is what impeccable checks against — colors, fonts, and corner radii found in the CSS / Tailwind theme. Sections it could not infer (creative direction, elevation philosophy) are intentionally omitted; add them by hand if you want them.",
    "",
    "> **This is a stub, and `/qa` will say so on every run until it is not.** A",
    "> list of the colours a repo already uses cannot tell anyone what the app",
    "> should look like: there is no type ramp here, no spacing scale, no control",
    "> sizes, no field or focus anatomy, no empty/loading/error pattern. Write",
    "> those, then delete the `design-authority: generated-stub` line above —",
    "> deleting it is the claim that this file now holds a design.",
    "",
  );

  const out = lines.join("\n") + "\n";
  if (PRINT) {
    process.stdout.write(out);
    exit(0);
  }
  writeFileSync(designPath, out);
  process.stderr.write(
    `gen-design-md: wrote ${designPath} (${colors.size} colors, ${namedFonts.size} fonts, ${sizes.size} sizes, ${radii.size} radii)\n`,
  );
  exit(0);

  // A repo root is named after its shared checkout: a linked worktree's own
  // folder is a thread id, and the common git dir's parent is the repo it
  // belongs to. An app in a subdirectory keeps its own folder's name.
  function repoName(p: string): string {
    const git = (...a: string[]) => spawnSync("git", ["-C", p, "rev-parse", ...a], { encoding: "utf8" });
    const top = git("--show-toplevel");
    const common = git("--path-format=absolute", "--git-common-dir");
    const atRoot = top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(p);
    const root = atRoot && common.status === 0 ? common.stdout.trim().replace(/\/\.git$/, "") : realpathSync(p);
    const base = root.replace(/\/+$/, "").split("/").pop() || "app";
    return base.split(".")[0].replace(/(^|-)([a-z])/g, (_, s: string, c: string) => s + c.toUpperCase());
  }
}

await runToExit(main);
