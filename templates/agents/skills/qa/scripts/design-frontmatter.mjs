#!/usr/bin/env node
// design-frontmatter.mjs — read the declared design scales out of a repo's
// DESIGN.md frontmatter, and fail loudly on anything it cannot parse.
//
// WHY A SEPARATE FILE. `system-drift.sh` counts drift; this reads the thing
// drift is measured against. Keeping them apart means the counter never has to
// carry a YAML parser, and a frontmatter shape nobody anticipated fails HERE,
// with a line number, instead of silently disarming a measure downstream — the
// failure mode that made a stub DESIGN.md report clean forever.
//
// THE SUBSET. DESIGN.md frontmatter is hand-written YAML of a narrow shape:
// `key: scalar`, `key:` followed by two-space-indented `subkey: scalar`, and
// inline arrays `key: [a, b, c]`. That is what this parses. A tab indent, an
// unterminated block, or a nested list-of-maps is reported as a parse error
// rather than guessed at — a partial scan that reads as a pass is the exact
// defect this whole mechanism exists to close.
//
// Usage: node design-frontmatter.mjs <repo-path>
// Output: shell-safe `KEY=value1|value2|...` lines on stdout, one per armed
//         measure. A key that is absent prints nothing, which disarms its
//         measure downstream.
// Exit: 0 parsed · 2 parse error (message on stderr) · 3 no DESIGN.md
//
// peers:
//   .agents/skills/qa/scripts/system-drift.sh
//   .agents/skills/qa/scripts/design-authority.sh
//   .agents/skills/qa/scripts/tests/system-drift.test.sh

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2];
if (!repo) {
  process.stderr.write("usage: design-frontmatter.mjs <repo-path>\n");
  process.exit(2);
}
const file = join(repo, "DESIGN.md");
if (!existsSync(file)) {
  process.stderr.write(`design-frontmatter: no ${file}\n`);
  process.exit(3);
}

const text = readFileSync(file, "utf8");
const lines = text.split("\n");
if (lines[0] !== "---") {
  // No frontmatter at all is not a parse error — it is an unarmed file, and
  // design-authority.sh is what calls that a stub.
  process.exit(0);
}
const close = lines.indexOf("---", 1);
if (close < 0) {
  process.stderr.write(`design-frontmatter: ${file}:1 opens a --- block that is never closed\n`);
  process.exit(2);
}

/** `key: value` / `key:` / `  subkey: value`, and nothing else. */
const ENTRY = /^( *)([A-Za-z0-9_.-]+):[ \t]*(.*)$/;

/**
 * Strip a trailing `# comment`, then the surrounding quotes.
 *
 * The `#` has to be OUTSIDE quotes and preceded by whitespace, because half the
 * values in these files are hex colours: a naive strip turns `"#abcdef"` into
 * nothing. Applied to list items and scalars alike — `- "2rem" # standard` and
 * `ink: "#101010" # brand` are the same mistake one line apart.
 */
function scalar(raw) {
  let quote = "";
  let cut = raw.length;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      cut = i;
      break;
    }
  }
  return raw.slice(0, cut).trim().replace(/^["']|["']$/g, "");
}

const tree = {};
// Each frame remembers the key it belongs to, so a `- item` line underneath can
// find its owner. `list` collects those items and is flushed onto the parent
// when the frame closes.
const stack = [{ indent: -1, node: tree, parent: null, key: undefined }];
function popFrame() {
  const frame = stack.pop();
  if (frame.list && frame.parent && frame.key !== undefined) frame.parent[frame.key] = frame.list;
}
function closeFrames(indent) {
  while (stack.length > 1 && indent <= stack[stack.length - 1].indent) popFrame();
}
/**
 * Flush every open frame at end of block.
 *
 * NOT `closeFrames(Infinity)`, which was the first shape and is wrong: the
 * condition is `indent <= frame.indent`, so Infinity matches nothing and the
 * LAST key in the file never had its list written back. A top-level
 * `controlHeights:` block list read as absent, which disarmed that measure in
 * silence — the exact failure the reader exists to make impossible.
 */
function flushAll() {
  while (stack.length > 1) popFrame();
}
for (let i = 1; i < close; i++) {
  const raw = lines[i];
  if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
  if (/^\t/.test(raw) || / \t/.test(raw)) {
    process.stderr.write(`design-frontmatter: ${file}:${i + 1} tab indentation is not valid YAML\n`);
    process.exit(2);
  }
  // A block list — `- item` under the key above it. These used to be skipped,
  // which DISCARDED the values and silently disarmed that key's measure: a
  // declared scale read as an absent one, which is the failure mode this whole
  // mechanism exists to close.
  const item = /^( *)- +(.*)$/.exec(raw);
  if (item) {
    const owner = stack[stack.length - 1];
    if (!owner || owner.key === undefined) {
      process.stderr.write(`design-frontmatter: ${file}:${i + 1} a list item with no key above it\n`);
      process.exit(2);
    }
    const value = item[2].trim();
    // `- key: value` is a list of MAPS, which this subset does not cover.
    // Keeping it as a scalar stored "key: value" as if it were a token and
    // dropped every continuation field — a corrupted scale that exits 0, which
    // is worse than the parse error it is supposed to be. The key may be
    // quoted: `- "name": xs` is the same shape and used to slip past.
    if (/^(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)[ \t]*:(\s|$)/.test(value)) {
      process.stderr.write(`design-frontmatter: ${file}:${i + 1} a list of maps is not supported: ${value}\n`);
      process.exit(2);
    }
    (owner.list ??= []).push(scalar(value));
    continue;
  }
  const m = ENTRY.exec(raw);
  if (!m) {
    // A multi-line scalar, an anchor, a merge key: shapes this subset does not
    // cover. Say so rather than guessing.
    process.stderr.write(`design-frontmatter: ${file}:${i + 1} cannot parse: ${raw.trim()}\n`);
    process.exit(2);
  }
  const [, pad, key, rawRest] = m;
  // Strip the comment BEFORE deciding whether this line opens a container.
  // `scale: # the ramp` is an empty key with a note on it; reading the note as
  // the value made `scale` a scalar, so the block list under it had no owner
  // and TYPE_SCALE came back absent — the measure disarmed by a comment.
  const rest = scalar(rawRest);
  const indent = pad.length;
  closeFrames(indent);
  const parent = stack[stack.length - 1].node;
  if (rest === "") {
    const child = {};
    parent[key] = child;
    stack.push({ indent, node: child, parent, key });
  } else {
    parent[key] = rest;
  }
}
flushAll();

/** Strip quotes; turn `[a, b]` into a list; leave a scalar as a one-item list. */
function values(node) {
  if (node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap(values);
  if (typeof node === "object") return Object.values(node).flatMap(values);
  const s = String(node).trim();
  if (s.startsWith("[") && s.endsWith("]")) return splitInline(s.slice(1, -1));
  return [s.replace(/^["']|["']$/g, "")];
}

/**
 * Split an inline array on the commas that SEPARATE items, not the ones inside
 * them. `["rgb(0, 0, 0)"]` is one colour; splitting on every comma turned it
 * into three values and then reported the declared colour as drift.
 */
function splitInline(body) {
  const out = [];
  let buf = "";
  let depth = 0;
  let quote = "";
  for (const c of body) {
    if (quote) {
      if (c === quote) quote = "";
      else buf += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") (depth++, (buf += c));
    else if (c === ")" || c === "]") (depth--, (buf += c));
    else if (c === "," && depth === 0) (out.push(buf.trim()), (buf = ""));
    else buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function entryFontSizes(typography) {
  if (!typography || typeof typography !== "object") return undefined;
  const sizes = Object.values(typography)
    .filter((entry) => entry && typeof entry === "object" && entry.fontSize !== undefined)
    .map((entry) => entry.fontSize);
  return sizes.length ? sizes : undefined;
}

function emit(name, node) {
  const list = values(node).filter(Boolean);
  if (list.length) process.stdout.write(`${name}=${list.join("|")}\n`);
}

// `typography.scale` is impeccable's existing key and the one DESIGN.md
// declares; `typeScale` is accepted as an alias so a repo that adopted the
// newer name is not silently unarmed. Declaring BOTH would be two copies of one
// fact, so whichever is present wins and neither is required.
// A file in the published DESIGN.md shape has neither: its ramp is the fontSize
// of each named typography entry, so that is the last fallback.
emit("TYPE_SCALE", tree.typography?.scale ?? tree.typeScale ?? entryFontSizes(tree.typography));
emit("COLORS", tree.colors);
emit("SPACING_SCALE", tree.spacingScale);
emit("RADIUS_SCALE", tree.radiusScale ?? tree.rounded);
emit("CONTROL_HEIGHTS", tree.controlHeights);
if (tree.componentVariants && typeof tree.componentVariants === "object") {
  for (const [role, v] of Object.entries(tree.componentVariants)) {
    const list = values(v);
    if (list.length) process.stdout.write(`VARIANTS_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}=${list.join("|")}\n`);
  }
}
process.exit(0);
