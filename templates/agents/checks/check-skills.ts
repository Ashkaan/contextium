#!/usr/bin/env -S node --experimental-strip-types
// check-skills.ts — hold every <skill>/SKILL.md in this checkout to the Agent
// Skills specification plus the three local rules AGENTS.md § Skill shape
// states, before a close commits it.
//
// WHY. Skills that carried frontmatter keys the spec does not allow, checked
// by a linter nothing fired at a close, drifted unnoticed: frontmatters stopped
// parsing and cross-skill references went stale. This check runs the PUBLISHED
// validator when it is installed, so the key list lives in one place (the
// pinned `skills-ref` package), and adds only what the spec leaves to us. Where
// it is not installed, a built-in reading of the same rules answers instead,
// in the validator's own wording, so a machine without Python still has a check.
//
// WHAT IT CHECKS, per skill folder:
//   (a) the folder holds a SKILL.md
//   (b) `skills-ref validate` passes — the six allowed keys, name = folder,
//       description length, and so on; its lines are relayed verbatim. Without
//       the validator, builtinValidate checks the same list
//   (c) `metadata`, when present, holds only `peers`, a non-empty string
//   (d) a `state/` folder holds `_doc.md`, and SKILL.md never names a
//       `state/` path — state is what a skill has learned, never loaded at
//       activation (AGENTS.md § Skill shape)
//
// WHAT IT SCANS. With no arguments: every top-level folder with ANY path
// changed beneath it in this worktree, staged or not, plus untracked — a new
// `state/` file or a new folder without SKILL.md selects its folder; a
// root-level file selects nothing. "Changed" is measured from HEAD, or with
// `--since <ref>` from where this branch left <ref> (land.ts calls it that
// way, BEFORE its `git add -A`). Folders no longer on disk are skipped.
// Test and fixture files are part of what it reads: a changed `*.test.ts`
// selects its skill like any other file.
// `--all` reads every top-level folder except .git, node_modules and .trash;
// explicit paths read exactly those folders (a path to SKILL.md works too).
//
// Nothing is borrowed from outside Node: the metadata reader is the built-in
// frontmatter reading (parseFm, over yaml-scalar.ts), so Python is never
// required, and an absolute `state/` token is canonicalized by resolvePath —
// every existing directory resolved physically, a missing tail kept as
// written — rather than GNU `realpath -m`, which macOS does not have.
//
// Usage:
//   node --experimental-strip-types check-skills.ts                    folders changed since HEAD
//   node --experimental-strip-types check-skills.ts --since <ref>      …since this branch left <ref>
//   node --experimental-strip-types check-skills.ts --all              every skill folder
//   node --experimental-strip-types check-skills.ts <skill-dir>...     those folders
//
// Env:
//   SKILLS_ROOT     the skills folder (default: ../skills beside this script,
//                   i.e. .agents/skills)
//   SKILLS_REF_BIN  the validator: `agentskills` on PATH, else the venv below;
//                   `builtin` forces the built-in reading. Set to a path that
//                   does not exist, it is a caller error (exit 2).
//
// Output (stdout): exactly one line — `OK — N skill(s) checked`, or
//   `FAIL — N skill(s) checked, M violation(s)`.
// Output (stderr): one line per violation, `<skill>/SKILL.md: <what>`.
//
// peers:
//   AGENTS.md § Skill shape                          (the rules this enforces)
//   .agents/checks/check-skills.test.ts
//   .agents/checks/yaml-scalar.ts                    (the scalar reader parseFm uses)
//   .agents/skills/close/scripts/land.ts             (the gate that calls it)
//   .agents/skills/author/scripts/verify.ts          (/author's verify step)
//
// Exit: 0 clean · 1 one or more violations · 2 caller error

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../packages/cli-exit/cli-exit.ts";
import { yamlScalar } from "./yaml-scalar.ts";

const INSTALL_LINE =
  "python3 -m venv ~/.local/lib/quality/skills-ref && ~/.local/lib/quality/skills-ref/bin/pip install skills-ref==0.1.1";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Folders that are never skills. */
function isIgnored(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".trash";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** bash `[ -x ]`. */
function isExecutable(p: string): boolean {
  try {
    statSync(p);
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v <name>`: the first executable file of that name on PATH, or "". */
function onPath(name: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = join(d === "" ? "." : d, name);
    if (isFile(p) && isExecutable(p)) return p;
  }
  return "";
}

/**
 * The path with every existing directory resolved physically and a missing
 * tail kept as written — `realpath -m` without GNU. The deepest existing
 * directory is canonicalized, so a symlink is followed BEFORE a `..` after it,
 * as the kernel does; the tail below it is appended verbatim.
 */
function resolvePath(p: string): string {
  let head = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
  let tail = "";
  while (!isDir(head)) {
    tail = `/${basename(head)}${tail}`;
    head = dirname(head);
  }
  return `${realpathSync(head)}${tail}`;
}

/** The frontmatter block without its fences; null when line 1 is not `---` (awk's exit 1). */
function frontmatter(file: string): string | null {
  const text = readFileSync(file, "utf8");
  if (text === "") return "";
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines[0] !== "---") return null;
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    out.push(line);
  }
  return out.join("\n");
}

/** One fact about a frontmatter, as parseFm reads it. */
type Fact =
  | { tag: "E"; message: string } //                    a problem the validator would report
  | { tag: "K"; key: string } //                        a top-level key, once per occurrence
  | { tag: "V"; key: string; value: string } //         a scalar top-level value (block scalars folded)
  | { tag: "L"; key: string } //                        a top-level key whose value is a block list
  | { tag: "N"; key: string } //                        a top-level key whose value is a block map
  | { tag: "M"; key: string; type: "str" | "list"; value: string } // a metadata entry
  | { tag: "MT"; type: string }; //                     metadata that is not a map

function trim(x: string): string {
  return x.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** A block scalar header: `>` or `|`, a chomping and/or indentation indicator
 *  in either order, and an optional ` #` comment. */
function isBlock(v: string): boolean {
  return /^[>|]([+-][1-9]?|[1-9][+-]?)?([ \t]+#.*)?$/.test(v);
}

/**
 * The value a block scalar carries, as YAML reads it (PyYAML's
 * scan_block_scalar, which the validator's parser shares). The indent is the
 * indentation indicator when the header has one (`>2-`, `|4`, `>-2`: a
 * top-level key sits at column 0, so the digit is the indent itself), else the
 * first text line's leading spaces; spaces past it are text. `|` keeps its line
 * breaks; `>` folds a break between two lines that both start with text into
 * one space (a blank line is a break, and a line starting with a space keeps
 * the breaks around it); the chomping indicator decides the end — `-` no final
 * newline, `+` every trailing one, neither exactly one. The validator counts
 * that newline. A text line indented less than the block ends it where YAML
 * would, which in a frontmatter mapping is invalid YAML: `bad` is then true.
 */
function blockValue(header: string, raw: string[]): { value: string; bad: boolean } {
  const ind = header.replace(/[ \t]+#.*$/, "");
  const chomp = ind.includes("-") ? "strip" : ind.includes("+") ? "keep" : "clip";
  const folded = ind.startsWith(">");
  const lead = (l: string): number => l.length - l.replace(/^ +/, "").length;
  const digit = /[1-9]/.exec(ind);
  let i = 0;
  let breaks = 0;
  let indent: number;
  if (digit) indent = Number(digit[0]);
  else {
    // Every leading blank line is a break, and the widest sets the floor.
    let widest = 0;
    for (; i < raw.length && /^[ \t]*$/.test(raw[i] ?? ""); i++) {
      widest = Math.max(widest, lead(raw[i] ?? ""));
      breaks++;
    }
    indent = Math.max(1, widest, i < raw.length ? lead(raw[i] ?? "") : 0);
  }
  // A break line: blank once up to `indent` spaces are consumed.
  const isBreak = (l: string): boolean => /^[ \t]*$/.test(l) && !(lead(l) > indent && !l.includes("\t"));
  const skipBreaks = (): void => {
    while (i < raw.length && isBreak(raw[i] ?? "")) {
      i++;
      breaks++;
    }
  };
  const isText = (l: string): boolean => lead(l) >= indent;
  if (digit) skipBreaks();
  let out = "";
  let lineBreak = "";
  while (i < raw.length && isText(raw[i] ?? "")) {
    out += "\n".repeat(breaks);
    const text = (raw[i] ?? "").slice(indent);
    const leadingText = !/^[ \t]/.test(text);
    out += text;
    lineBreak = "\n";
    i++;
    breaks = 0;
    skipBreaks();
    if (i >= raw.length || !isText(raw[i] ?? "")) break;
    if (folded && leadingText && !/^[ \t]/.test((raw[i] ?? "").slice(indent))) {
      if (breaks === 0) out += " ";
    } else out += lineBreak;
  }
  const bad = i < raw.length;
  if (chomp === "strip") return { value: out, bad };
  return { value: chomp === "keep" ? `${out}${lineBreak}${"\n".repeat(breaks)}` : `${out}${lineBreak}`, bad };
}

/** An indented line that opens a nested mapping entry: `key:` then a space or the end. */
function isMapEntry(line: string): boolean {
  return /^("[^"]*"|'[^']*'|[^'"#\s-][^#]*?|-[^\s][^#]*?)[ \t]*:([ \t]|$)/.test(line);
}

/**
 * parseFm <SKILL.md> — the frontmatter read the way the checks need it, one
 * fact per entry, in file order. Not a YAML library: the flat shape the spec
 * allows — `key: value`, quoted values, `>`/`|` block scalars, one level of
 * map under metadata, and a single-line `{k: v}` metadata map, which the
 * validator refuses but whose keys the local rule still reads. A quoted value
 * that never closes, or text after its closing quote, is reported — at the
 * top level and in a metadata value alike — and so is a plain value holding
 * `: `, which YAML reads as a mapping. A top-level value that is a block list
 * or a block map is reported as such (L, N), never as its text.
 */
function parseFm(file: string): Fact[] {
  const facts: Fact[] = [];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (text === "") lines.length = 0;

  let key = "";
  let val = "";
  let listy = false;
  let mapped = false;
  let block = false;
  let header = "";
  let blines: string[] = [];
  let mkey = "";
  let mval = "";
  let mlisty = false;
  let mblock = false;
  let mind = 0;
  let closed = false;

  const flushMeta = (): void => {
    if (mkey === "") return;
    if (mlisty) facts.push({ tag: "M", key: mkey, type: "list", value: "" });
    else {
      const ys = mblock ? { value: trim(mval), state: "ok" } : yamlScalar(mval);
      if (ys.state === "open")
        facts.push({
          tag: "E",
          message: `Invalid YAML in frontmatter: while scanning a quoted scalar in metadata.${mkey}: found unexpected end of stream`,
        });
      else if (ys.state === "trailing")
        facts.push({ tag: "E", message: `Invalid YAML in frontmatter: text after the closing quote of metadata.${mkey}` });
      facts.push({ tag: "M", key: mkey, type: "str", value: ys.value });
    }
    mkey = "";
    mval = "";
    mlisty = false;
    mblock = false;
  };

  // A key reset to "" by an error or a flow value keeps the rest of its
  // state until the next real key sets it, as the awk reading this ports did.
  const flush = (): void => {
    if (key === "") return;
    if (listy) facts.push({ tag: "L", key });
    else if (mapped) facts.push({ tag: "N", key });
    else if (key !== "metadata") {
      const bv = block ? blockValue(header, blines) : null;
      const ys = bv ? { value: bv.value, state: "ok" } : yamlScalar(val);
      if (bv?.bad)
        facts.push({ tag: "E", message: `Invalid YAML in frontmatter: a line of ${key} is indented less than its block scalar` });
      else if (!block && ys.state === "ok" && !/^["']/.test(trim(val)) && /:([ \t]|$)/.test(ys.value))
        facts.push({ tag: "E", message: `Invalid YAML in frontmatter: mapping values are not allowed here (in ${key})` });
      else if (ys.state === "open")
        facts.push({
          tag: "E",
          message: `Invalid YAML in frontmatter: while scanning a quoted scalar in ${key}: found unexpected end of stream`,
        });
      else if (ys.state === "trailing")
        facts.push({ tag: "E", message: `Invalid YAML in frontmatter: text after the closing quote of ${key}` });
      facts.push({ tag: "V", key, value: ys.value });
    }
    if (key === "metadata") flushMeta();
    key = "";
    val = "";
    listy = false;
    mapped = false;
    block = false;
    header = "";
    blines = [];
  };

  if (lines.length === 0) {
    facts.push({ tag: "E", message: "SKILL.md must start with YAML frontmatter (---)" });
    return facts;
  }
  if (lines[0] !== "---") {
    facts.push({ tag: "E", message: "SKILL.md must start with YAML frontmatter (---)" });
    return facts;
  }

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const nr = i + 1;
    if (raw === "---") {
      closed = true;
      break;
    }
    if (/^[ \t]*$/.test(raw)) {
      if (block && key !== "") blines.push(raw);
      continue;
    }
    if (raw.startsWith("#")) continue;
    if (/^[^ \t]/.test(raw)) {
      flush();
      const km = /^[A-Za-z0-9_-]+:/.exec(raw);
      if (!km) {
        facts.push({ tag: "E", message: `Invalid YAML in frontmatter: line ${nr} is not a key: value line` });
        continue;
      }
      key = km[0].slice(0, -1);
      const rest = trim(raw.slice(km[0].length));
      facts.push({ tag: "K", key });
      if (/^[[{]/.test(rest)) {
        facts.push({
          tag: "E",
          message: `Invalid YAML in frontmatter: found a disallowed JSONesque flow ${rest.startsWith("{") ? "mapping" : "sequence"} in ${key} (${rest})`,
        });
        if (key === "metadata" && /^\{.*\}$/.test(rest)) {
          for (const pair of rest.slice(1, -1).split(",")) {
            const pm = /^[ \t]*[A-Za-z0-9_-]+[ \t]*:/.exec(pair);
            if (!pm) continue;
            const mk = trim(pm[0].slice(0, -1));
            facts.push({ tag: "M", key: mk, type: "str", value: yamlScalar(pair.slice(pm[0].length)).value });
          }
        } else if (key === "metadata") facts.push({ tag: "MT", type: "str" });
        key = "";
        continue;
      }
      if (isBlock(rest)) {
        block = true;
        header = rest;
        blines = [];
        val = "";
      } else {
        block = false;
        val = rest;
      }
      if (key === "metadata" && rest !== "") {
        facts.push({ tag: "MT", type: "str" });
        key = "";
      }
      continue;
    }
    const line = trim(raw);
    if (key === "metadata") {
      const ind = raw.search(/[^ \t]/);
      if (mind === 0 || ind <= mind) {
        const mm = /^[ \t]+[A-Za-z0-9_-]+:/.exec(raw);
        if (mm) {
          flushMeta();
          mind = ind;
          mkey = trim(mm[0].slice(0, -1));
          const mrest = trim(raw.slice(mm[0].length));
          mblock = isBlock(mrest);
          mval = mblock ? "" : mrest;
        }
      } else if (line.startsWith("- ") && trim(mval) === "") {
        mlisty = true;
      } else {
        mval = `${mval} ${line}`;
      }
      continue;
    }
    if (block) {
      blines.push(raw);
      continue;
    }
    if (line.startsWith("#") || listy || mapped) continue;
    // Only the first indented line under an empty value opens a list or a map;
    // after text it continues a plain scalar (where `: ` is then an error).
    if (val === "" && (line === "-" || line.startsWith("- "))) {
      listy = true;
      continue;
    }
    if (val === "" && isMapEntry(line)) {
      mapped = true;
      continue;
    }
    val = val === "" ? line : `${val} ${line}`;
  }

  if (!closed) {
    facts.push({ tag: "E", message: "SKILL.md frontmatter not properly closed with ---" });
    return facts;
  }
  flush();
  return facts;
}

/** Characters, not bytes: a code point counts once. */
function charCount(s: string): number {
  return [...s].length;
}

const ALLOWED = new Set(["name", "description", "license", "compatibility", "allowed-tools", "metadata"]);

/**
 * builtinValidate <dir> — the published validator's rules, in its wording,
 * for a machine without it. Returns "" when the skill is valid, else the
 * validator's shape: a `Validation failed for` header and `  - <error>` lines.
 */
function builtinValidate(dir: string): string {
  const folder = basename(dir);
  const errs: string[] = [];
  if (!isFile(join(dir, "SKILL.md"))) {
    errs.push("Missing required file: SKILL.md");
  } else {
    const facts = parseFm(join(dir, "SKILL.md"));
    // A YAML error is the whole answer, as it is for the validator: nothing
    // else can be read from a frontmatter that does not parse.
    for (const f of facts) if (f.tag === "E") errs.push(f.message);
    if (errs.length === 0) {
      const seen = new Set<string>();
      const extra: string[] = [];
      let name = "";
      let desc = "";
      let hasName = false;
      let hasDesc = false;
      let descList = false;
      let compatNotString = false;
      for (const f of facts) {
        if (f.tag === "K") {
          if (seen.has(f.key)) errs.push(`Invalid YAML in frontmatter: duplicate key ${f.key}`);
          seen.add(f.key);
          if (!ALLOWED.has(f.key)) extra.push(f.key);
        } else if (f.tag === "V") {
          if (f.key === "name") {
            name = f.value;
            hasName = true;
          } else if (f.key === "description") {
            desc = f.value;
            hasDesc = true;
          } else if (f.key === "compatibility") {
            const n = charCount(f.value);
            if (n > 500) errs.push(`Compatibility exceeds 500 character limit (${n} chars)`);
          }
        } else if (f.tag === "L" || f.tag === "N") {
          // A list or a map where a string belongs.
          if (f.key === "name") {
            hasName = true;
            name = "";
          } else if (f.key === "description") {
            hasDesc = true;
            descList = true;
          } else if (f.key === "compatibility") compatNotString = true;
        }
      }
      if (extra.length > 0) {
        // `LC_ALL=C sort`: byte order; the keys are ASCII, so code-unit order is the same.
        const sorted = [...extra].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        errs.push(
          `Unexpected fields in frontmatter: ${sorted.join(", ")}. Only ['allowed-tools', 'compatibility', 'description', 'license', 'metadata', 'name'] are allowed.`,
        );
      }
      if (!hasName) {
        errs.push("Missing required field in frontmatter: name");
      } else if (name.trim() === "") {
        errs.push("Field 'name' must be a non-empty string");
      } else {
        // The validator's _validate_name: the name stripped and NFKC-normalized,
        // letters and digits in any script, and every rule it breaks reported.
        const nm = name.trim().normalize("NFKC");
        const n = charCount(nm);
        if (n > 64) errs.push(`Skill name '${nm}' exceeds 64 character limit (${n} chars)`);
        if (nm !== nm.toLowerCase()) errs.push(`Skill name '${nm}' must be lowercase`);
        if (nm.startsWith("-") || nm.endsWith("-")) errs.push("Skill name cannot start or end with a hyphen");
        if (nm.includes("--")) errs.push("Skill name cannot contain consecutive hyphens");
        if (![...nm].every((c) => c === "-" || /^[\p{L}\p{N}]$/u.test(c)))
          errs.push(`Skill name '${nm}' contains invalid characters. Only letters, digits, and hyphens are allowed.`);
        if (folder.normalize("NFKC") !== nm) errs.push(`Directory name '${folder}' must match skill name '${nm}'`);
      }
      if (!hasDesc) {
        errs.push("Missing required field in frontmatter: description");
      } else if (descList || desc.replace(/\s/g, "") === "") {
        errs.push("Field 'description' must be a non-empty string");
      } else {
        const n = charCount(desc);
        if (n > 1024) errs.push(`Description exceeds 1024 character limit (${n} chars)`);
      }
      if (compatNotString) errs.push("Field 'compatibility' must be a string");
    }
  }
  if (errs.length === 0) return "";
  return `Validation failed for ${dir}:\n${errs.map((e) => `  - ${e}\n`).join("")}`;
}

// A path-like token holding `state/`, as `grep -oE` read it.
const STATE_TOKEN = /[^\s"'`()<>[]*state\/[^\s"'`()<>[]*/g;

let violations = 0;
function violation(name: string, what: string): void {
  err(`${name}/SKILL.md: ${what}`);
  violations += 1;
}

function checkSkill(dir: string, validatorBin: string, home: string): void {
  const name = basename(dir);

  // (a)
  if (!isFile(join(dir, "SKILL.md"))) {
    err(`${name}: no SKILL.md`);
    violations += 1;
    return;
  }

  // (b) The published validator. Its stdout is the `Valid skill:` line;
  //     its stderr is a header plus `  - <error>` lines, relayed.
  //     A multi-line error (a YAML parse failure quotes the offending line)
  //     is folded onto the `  - ` line that opened it, one violation each.
  //     The built-in reading answers in the same shape.
  let failed: boolean;
  let vout: string;
  if (validatorBin === "builtin") {
    vout = builtinValidate(dir);
    failed = vout !== "";
  } else {
    const v = spawnSync(validatorBin, ["validate", dir], { encoding: "utf8", stdio: ["inherit", "ignore", "pipe"] });
    failed = v.status !== 0;
    vout = v.stderr ?? "";
  }
  if (failed) {
    let cur = "";
    for (const raw of vout.replace(/\n+$/, "").split("\n")) {
      if (raw.startsWith("Validation failed for ")) continue;
      if (raw.startsWith("  - ")) {
        if (cur !== "") violation(name, cur);
        cur = raw.slice(4);
        continue;
      }
      const line = raw.replace(/[ \t\n\v\f\r]+/g, " ").replace(/^ /, "");
      if (line !== "") cur = cur !== "" ? `${cur} ${line}` : line;
    }
    if (cur !== "") violation(name, cur);
    else violation(name, "the validator exited non-zero with no message");
  }

  // (c) metadata: only peers, a non-empty string. The built-in reader, so a
  //     block map and an inline `{…}` map read the same.
  if (frontmatter(join(dir, "SKILL.md")) !== null) {
    for (const f of parseFm(join(dir, "SKILL.md"))) {
      if (f.tag === "MT") {
        violation(name, `metadata must be a map of string keys to string values, got ${f.type}`);
      } else if (f.tag === "M") {
        if (f.key === "peers") {
          if (f.type !== "str") {
            violation(name, `metadata.peers must be a string (space-separated paths), got ${f.type}`);
          } else if (f.value.replace(/\s/g, "") === "") {
            violation(name, "metadata.peers must be a non-empty string — name the peers or drop the key");
          }
        } else {
          violation(
            name,
            `metadata.${f.key} is not a key a skill carries — the only custom key is metadata.peers (AGENTS.md § Skill shape)`,
          );
        }
      }
    }
  }

  // (d) state/: described by _doc.md, never named from SKILL.md.
  if (isDir(join(dir, "state")) && !isFile(join(dir, "state/_doc.md"))) {
    violation(
      name,
      "state/ has no _doc.md — a state folder describes what it holds and which script writes and reads it",
    );
  }
  // A reference to THIS skill's state folder. Every path-like token holding
  // `state/` is classified: `state/…` or `./state/…` is this skill's; so is
  // `<name>/state/…` bare or behind `../`; a home-rooted or absolute path is
  // this skill's when it RESOLVES into this folder (checkout, worktree or
  // symlink alike) or names it under a `skills/` folder — the skills live at
  // `<workbench>/.agents/skills/<name>`, so `skills/<name>/state/` in any checkout,
  // worktree or link to one (`~/.agents/skills`, `~/.claude/skills`) is this
  // skill's. A path into another tree (knowledge/<name>/state/x,
  // ~/knowledge/<name>/state/x, /tmp/<name>/state/x) is not one.
  const realDir = resolvePath(dir);
  const lines = readFileSync(join(dir, "SKILL.md"), "utf8").split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(STATE_TOKEN)) {
      const tok = m[0];
      const self =
        tok.startsWith("state/") ||
        tok.startsWith("./state/") ||
        tok.startsWith(`${name}/state/`) ||
        tok.startsWith(`../${name}/state/`);
      if (!self) {
        if (!(tok.startsWith("~/") || tok.startsWith("/"))) continue;
        const resolved = resolvePath(tok.startsWith("~") ? `${home}${tok.slice(1)}` : tok);
        const inside =
          resolved === `${realDir}/state` ||
          resolved.startsWith(`${realDir}/state/`) ||
          new RegExp(`/skills/${escapeRe(name)}/state/`).test(resolved);
        if (!inside) continue;
      }
      violation(name, `line ${i + 1} links ${tok} — state is never loaded at activation, so SKILL.md must not name it`);
    }
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

async function main(): Promise<void> {
  // PHYSICAL path: invoked through a symlink (`~/.agents/skills/...`) a
  // logical path would name the link, not the checkout the skills live in.
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const home = process.env.HOME ?? homedir();
  const skillsRoot = process.env.SKILLS_ROOT || `${here}/../skills`;
  let validatorBin = process.env.SKILLS_REF_BIN || "";
  if (validatorBin === "") {
    const venv = `${home}/.local/lib/quality/skills-ref/bin/agentskills`;
    validatorBin = onPath("agentskills") || (isExecutable(venv) ? venv : "builtin");
  }

  const argv = process.argv.slice(2);
  const targets: string[] = [];
  let mode = "changed";
  let since = "";
  const first = argv[0] ?? "";
  if (first === "--all") {
    if (argv.length !== 1) {
      err("check-skills: --all takes no paths");
      exit(2);
    }
    mode = "all";
  } else if (first === "--since") {
    since = argv[1] ?? "";
    if (since === "") {
      err("check-skills: --since needs a ref");
      exit(2);
    }
    if (argv.length > 2) {
      err("check-skills: --since takes no paths");
      exit(2);
    }
  } else if (first.startsWith("-")) {
    err(`check-skills: unknown option ${first}`);
    exit(2);
  } else if (first !== "") {
    mode = "paths";
  }

  if (validatorBin !== "builtin" && !isExecutable(validatorBin)) {
    err(`check-skills: no validator at ${validatorBin} — install it, or unset SKILLS_REF_BIN for the built-in check:`);
    err(`  ${INSTALL_LINE}`);
    exit(2);
  }

  if (mode === "paths") {
    for (let p of argv) {
      if (p.endsWith("/SKILL.md")) p = p.slice(0, -"/SKILL.md".length);
      if (p.endsWith("/")) p = p.slice(0, -1);
      targets.push(p);
    }
  } else if (mode === "all") {
    // bash's `*/` then `.*/`, each sorted by the locale's collation.
    const collate = new Intl.Collator().compare;
    // An unreadable root is a failed scan, not an empty one: swallowed, it
    // reports `OK — 0 skill(s) checked` over a tree nobody read.
    let entries: string[];
    try {
      entries = readdirSync(skillsRoot);
    } catch (e) {
      err(`check-skills: cannot read ${skillsRoot}: ${e instanceof Error ? e.message : String(e)}`);
      exit(2);
    }
    const visible = entries.filter((n) => !n.startsWith(".")).sort(collate);
    const hidden = entries.filter((n) => n.startsWith(".")).sort(collate);
    for (const name of [...visible, ...hidden]) {
      if (!isDir(join(skillsRoot, name))) continue;
      if (isIgnored(name)) continue;
      targets.push(`${skillsRoot}/${name}`);
    }
  } else {
    if (!git(skillsRoot, ["rev-parse", "--is-inside-work-tree"]).ok) {
      err(`check-skills: ${skillsRoot} is not inside a git work tree`);
      exit(2);
    }
    let base = "HEAD";
    if (since !== "") {
      const mb = git(skillsRoot, ["merge-base", "HEAD", since]);
      if (!mb.ok) {
        err(`check-skills: cannot find where HEAD left ${since}`);
        exit(2);
      }
      base = mb.out.replace(/\n+$/, "");
    }
    // Every changed or untracked path, relative to the root; the first path
    // component of any path that HAS a component is a candidate folder. Both
    // git listings are NUL-delimited and each exit status is checked: a failed
    // scan is an exit 2, never an empty list reported as `OK — 0 skill(s) checked`.
    const diff = git(skillsRoot, ["diff", "-z", "--name-only", "--no-renames", "--relative", base]);
    if (!diff.ok) {
      err(`check-skills: git diff against ${base} failed in ${skillsRoot}`);
      exit(2);
    }
    const untracked = git(skillsRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
    if (!untracked.ok) {
      err(`check-skills: git ls-files failed in ${skillsRoot}`);
      exit(2);
    }
    const seen = new Set<string>();
    for (const path of `${diff.out}${untracked.out}`.split("\0")) {
      if (!path.includes("/")) continue;
      const name = path.slice(0, path.indexOf("/"));
      if (seen.has(name)) continue;
      seen.add(name);
      if (isIgnored(name)) continue;
      if (!isDir(`${skillsRoot}/${name}`)) continue;
      targets.push(`${skillsRoot}/${name}`);
    }
  }

  if (targets.length === 0) {
    process.stdout.write("OK — 0 skill(s) checked\n");
    exit(0);
  }

  for (const t of targets) {
    if (!isDir(t)) {
      err(`${basename(t)}: no such folder ${t}`);
      violations += 1;
      continue;
    }
    checkSkill(t, validatorBin, home);
  }

  if (violations > 0) {
    process.stdout.write(`FAIL — ${targets.length} skill(s) checked, ${violations} violation(s)\n`);
    exit(1);
  }
  process.stdout.write(`OK — ${targets.length} skill(s) checked\n`);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await runToExit(main);
}
