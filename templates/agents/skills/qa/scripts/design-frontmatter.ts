#!/usr/bin/env -S node --experimental-strip-types
// design-frontmatter.ts — read the declared design scales out of a repo's
// DESIGN.md frontmatter, and fail loudly on anything it cannot parse.
//
// WHY A SEPARATE FILE. `system-drift.ts` counts drift; this reads the thing
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
// Usage: design-frontmatter.ts <repo-path>
// Output: `KEY=value1|value2|...` lines on stdout, one per armed measure. A key
//         that is absent prints nothing, which disarms its measure downstream.
// Exit: 0 parsed · 2 parse error (message on stderr) · 3 no DESIGN.md
//
// As a module: `readDeclared(repo)` returns the same KEY/value pairs, in the
// same order, and throws a `FrontmatterError` carrying the exit code and the
// message the program would have printed. system-drift.ts imports it.
//
// peers:
//   .agents/skills/qa/scripts/system-drift.ts
//   .agents/skills/qa/scripts/design-authority.ts
//   .agents/skills/qa/scripts/tests/design-frontmatter.test.ts

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** A parse failure (code 2) or a missing DESIGN.md (code 3). */
export class FrontmatterError extends Error {
  readonly code: 2 | 3;
  constructor(message: string, code: 2 | 3) {
    super(message);
    this.code = code;
  }
}

/** A scalar, a block list, or a nested map. */
type YamlNode = string | YamlNode[] | YamlMap;
interface YamlMap {
  [key: string]: YamlNode;
}

interface Frame {
  indent: number;
  node: YamlMap;
  parent: YamlMap | null;
  key: string | undefined;
  list?: string[];
}

/** `key: value` / `key:` / `  subkey: value`, and nothing else. */
const ENTRY = /^( *)([A-Za-z0-9_.-]+):[ \t]*(.*)$/;

function isMap(node: YamlNode | undefined): node is YamlMap {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** `node.key` when node is a map; undefined for a scalar or a list, as in JS. */
function get(node: YamlNode | undefined, key: string): YamlNode | undefined {
  return isMap(node) ? node[key] : undefined;
}

/**
 * Strip a trailing `# comment`, then the surrounding quotes.
 *
 * The `#` has to be OUTSIDE quotes and preceded by whitespace, because half the
 * values in these files are hex colours: a naive strip turns `"#abcdef"` into
 * nothing. Applied to list items and scalars alike — `- "2rem" # standard` and
 * `ink: "#101010" # brand` are the same mistake one line apart.
 */
function scalar(raw: string): string {
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
  return raw
    .slice(0, cut)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/** Parse the frontmatter block into a tree; throws FrontmatterError. */
function parse(file: string, lines: string[], close: number): YamlMap {
  const fail = (line: number, msg: string): never => {
    throw new FrontmatterError(`design-frontmatter: ${file}:${line} ${msg}`, 2);
  };
  const tree: YamlMap = {};
  // Each frame remembers the key it belongs to, so a `- item` line underneath
  // can find its owner. `list` collects those items and is flushed onto the
  // parent when the frame closes.
  const stack: Frame[] = [{ indent: -1, node: tree, parent: null, key: undefined }];
  const popFrame = (): void => {
    const frame = stack.pop();
    if (frame?.list && frame.parent && frame.key !== undefined) frame.parent[frame.key] = frame.list;
  };
  const closeFrames = (indent: number): void => {
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) popFrame();
  };
  // Flush every open frame at end of block.
  //
  // NOT `closeFrames(Infinity)`, which was the first shape and is wrong: the
  // condition is `indent <= frame.indent`, so Infinity matches nothing and the
  // LAST key in the file never had its list written back. A top-level
  // `controlHeights:` block list read as absent, which disarmed that measure in
  // silence — the exact failure the reader exists to make impossible.
  const flushAll = (): void => {
    while (stack.length > 1) popFrame();
  };

  for (let i = 1; i < close; i++) {
    const raw = lines[i];
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (/^\t/.test(raw) || / \t/.test(raw)) fail(i + 1, "tab indentation is not valid YAML");
    // A block list — `- item` under the key above it. These used to be
    // skipped, which DISCARDED the values and silently disarmed that key's
    // measure: a declared scale read as an absent one, which is the failure
    // mode this whole mechanism exists to close.
    const item = /^( *)- +(.*)$/.exec(raw);
    if (item) {
      const owner = stack[stack.length - 1];
      if (owner.key === undefined) fail(i + 1, "a list item with no key above it");
      const value = item[2].trim();
      // `- key: value` is a list of MAPS, which this subset does not cover.
      // Keeping it as a scalar stored "key: value" as if it were a token and
      // dropped every continuation field — a corrupted scale that exits 0,
      // which is worse than the parse error it is supposed to be. The key may
      // be quoted: `- "name": xs` is the same shape and used to slip past.
      if (/^(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)[ \t]*:(\s|$)/.test(value)) {
        fail(i + 1, `a list of maps is not supported: ${value}`);
      }
      owner.list ??= [];
      owner.list.push(scalar(value));
      continue;
    }
    const m = ENTRY.exec(raw);
    // A multi-line scalar, an anchor, a merge key: shapes this subset does not
    // cover. Say so rather than guessing.
    if (!m) return fail(i + 1, `cannot parse: ${raw.trim()}`);
    const [, pad, key, rawRest] = m;
    // Strip the comment BEFORE deciding whether this line opens a container.
    // `scale: # the ramp` is an empty key with a note on it; reading the note
    // as the value made `scale` a scalar, so the block list under it had no
    // owner and TYPE_SCALE came back absent — the measure disarmed by a comment.
    const rest = scalar(rawRest);
    const indent = pad.length;
    closeFrames(indent);
    const parent = stack[stack.length - 1].node;
    if (rest === "") {
      const child: YamlMap = {};
      parent[key] = child;
      stack.push({ indent, node: child, parent, key });
    } else {
      parent[key] = rest;
    }
  }
  flushAll();
  return tree;
}

/**
 * Split an inline array on the commas that SEPARATE items, not the ones inside
 * them. `["rgb(0, 0, 0)"]` is one colour; splitting on every comma turned it
 * into three values and then reported the declared colour as drift.
 */
function splitInline(body: string): string[] {
  const out: string[] = [];
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
    else if (c === "(" || c === "[") {
      depth++;
      buf += c;
    } else if (c === ")" || c === "]") {
      depth--;
      buf += c;
    } else if (c === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** Strip quotes; turn `[a, b]` into a list; leave a scalar as a one-item list. */
function values(node: YamlNode | undefined): string[] {
  if (node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap(values);
  if (isMap(node)) return Object.values(node).flatMap(values);
  const s = node.trim();
  if (s.startsWith("[") && s.endsWith("]")) return splitInline(s.slice(1, -1));
  return [s.replace(/^["']|["']$/g, "")];
}

function entryFontSizes(typography: YamlNode | undefined): YamlNode[] | undefined {
  if (!isMap(typography)) return undefined;
  const sizes: YamlNode[] = [];
  for (const entry of Object.values(typography)) {
    const size = get(entry, "fontSize");
    if (size !== undefined) sizes.push(size);
  }
  return sizes.length ? sizes : undefined;
}

// The published schema has no `controlHeights` key: a control's height is the
// `height` of a `components` entry. Only entries named `control-*` count — an
// app may declare `person-row: 64px`, and a row or card height is not a
// control height.
function controlHeights(components: YamlNode | undefined): YamlNode[] | undefined {
  if (!isMap(components)) return undefined;
  const heights: YamlNode[] = [];
  for (const [name, entry] of Object.entries(components)) {
    const height = get(entry, "height");
    if (name.startsWith("control-") && height !== undefined) heights.push(height);
  }
  return heights.length ? heights : undefined;
}

// Nor has it a `componentVariants` key: a variant is an entry named
// `<role>-<variant>` (`button-ghost`). A two-word role groups under its first
// word (`status-pill-success` lands in `status`), which measure 4 ignores — it
// reads only BUTTON, INPUT, SELECT, TEXTAREA and TABLE.
function variantsByRole(components: YamlNode | undefined): YamlMap | undefined {
  if (!isMap(components)) return undefined;
  const roles: Record<string, string[]> = {};
  for (const name of Object.keys(components)) {
    const dash = name.indexOf("-");
    if (dash <= 0 || dash === name.length - 1) continue;
    roles[name.slice(0, dash)] ??= [];
    roles[name.slice(0, dash)].push(name.slice(dash + 1));
  }
  return Object.keys(roles).length ? roles : undefined;
}

/**
 * The declared scales of `<repo>/DESIGN.md`, as ordered KEY/value pairs — the
 * value is the `|`-joined list the program prints after `KEY=`.
 * Throws FrontmatterError (code 3 no file, code 2 unparseable).
 */
export function readDeclared(repo: string): Array<[string, string]> {
  const file = join(repo, "DESIGN.md");
  if (!existsSync(file)) throw new FrontmatterError(`design-frontmatter: no ${file}`, 3);
  const lines = readFileSync(file, "utf8").split("\n");
  // No frontmatter at all is not a parse error — it is an unarmed file, and
  // design-authority.ts is what calls that a stub.
  if (lines[0] !== "---") return [];
  const close = lines.indexOf("---", 1);
  if (close < 0) {
    throw new FrontmatterError(`design-frontmatter: ${file}:1 opens a --- block that is never closed`, 2);
  }
  const tree = parse(file, lines, close);

  const out: Array<[string, string]> = [];
  const emit = (name: string, node: YamlNode | undefined): void => {
    const list = values(node).filter(Boolean);
    if (list.length) out.push([name, list.join("|")]);
  };
  // `typography.scale` is impeccable's existing key and the one DESIGN.md
  // declares; `typeScale` is accepted as an alias so a repo that adopted the
  // newer name is not silently unarmed. Declaring BOTH would be two copies of
  // one fact, so whichever is present wins and neither is required.
  // A file in the published DESIGN.md shape has neither: its ramp is the
  // fontSize of each named typography entry, so that is the last fallback.
  // The same rule covers the other three: `spacing` is the published key and
  // `spacingScale` the older one; a control height's home in the schema is a
  // `components` entry's `height`; a variant's home is an entry named
  // `<role>-<variant>`. The older key is read first each time — a file that
  // declared both would be two copies of one fact, so neither is required and
  // the old key wins.
  emit("TYPE_SCALE", get(tree.typography, "scale") ?? tree.typeScale ?? entryFontSizes(tree.typography));
  emit("COLORS", tree.colors);
  emit("SPACING_SCALE", tree.spacingScale ?? tree.spacing);
  emit("RADIUS_SCALE", tree.radiusScale ?? tree.rounded);
  emit("CONTROL_HEIGHTS", tree.controlHeights ?? controlHeights(tree.components));
  const variants = tree.componentVariants ?? variantsByRole(tree.components);
  if (typeof variants === "object") {
    const entries: Array<[string, YamlNode]> = Array.isArray(variants)
      ? variants.map((v, i): [string, YamlNode] => [String(i), v])
      : Object.entries(variants);
    for (const [role, v] of entries) {
      const list = values(v);
      if (list.length) out.push([`VARIANTS_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, list.join("|")]);
    }
  }
  return out;
}

function main(): void {
  const repo = process.argv[2];
  if (!repo) {
    process.stderr.write("usage: design-frontmatter.ts <repo-path>\n");
    exit(2);
  }
  let declared: Array<[string, string]>;
  try {
    declared = readDeclared(repo);
  } catch (e) {
    if (e instanceof FrontmatterError) {
      process.stderr.write(`${e.message}\n`);
      exit(e.code);
    }
    throw e;
  }
  for (const [key, value] of declared) process.stdout.write(`${key}=${value}\n`);
  exit(0);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
