#!/usr/bin/env -S node --experimental-strip-types
// install-legacy-projection.ts — what the v6/v7 projector would have written at
// one path, regenerated from the layer it was generated from. install.sh uses it
// to tell a generated file nobody touched (removed on upgrade) from one the user
// edited (kept): the "Generated from .agents/AGENTS.md" marker and the
// "# skill definition" fence survive an edit, so they prove only who wrote the
// file first, not that it is still as written.
//
// The functions below reproduce v6.0.0's and v7.0.0's
// scripts/projector/project-rules.sh output code, byte for byte in what they
// print (the two tags agree on it). That code was awk, sed and bash command
// substitution, so each step here keeps their rules: a file is read as lines the
// way awk reads records (a last line without its newline still counts, and is
// printed with one), a value taken through $(...) loses its trailing newlines,
// and files are read and written as bytes (latin1), so nothing is re-encoded.
//
// Usage:
//   node --experimental-strip-types install-legacy-projection.ts <snapshot of .agents/> <path from the workbench root>
//     <path> is one of GEMINI.md, .cursor/rules/contextium.mdc,
//     .github/copilot-instructions.md, .gemini/commands/<skill>.toml,
//     .github/prompts/<skill>.prompt.md
// Prints the file's expected content. Exit: 0 printed · 1 nothing to compare
// against (no such skill, or a path the projector never wrote), or a usage error
//
// Node 22.6 or later.

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: install-legacy-projection.ts <snapshot> <path>";

const GEN_NOTE =
  "<!-- Generated from .agents/AGENTS.md + .agents/rules/*.md. Do not edit by hand; edit the source in .agents/ and re-run the installer. -->";

// awk's [[:space:]] in the C locale. Not \s: read as latin1, byte 0xA0 would
// be a space to JavaScript and not to awk.
const SPACE = "[ \\t\\n\\v\\f\\r]";

/** The records awk reads from a file's text. */
function records(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** What `$(...)` keeps of a command's output: all of it but the trailing newlines. */
function substituted(out: string): string {
  return out.replace(/\n+$/, "");
}

function read(path: string): string {
  return readFileSync(path, "latin1");
}

/** `[ -f path ]`: a regular file, through a symlink. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file's lines, the first dropped when it is an H1: awk 'NR==1 && /^# / {next} {print}'. */
function withoutH1(path: string): string {
  let out = "";
  records(read(path)).forEach((line, i) => {
    if (i === 0 && line.startsWith("# ")) return;
    out += `${line}\n`;
  });
  return out;
}

/**
 * `find <dir> -type f -name '*.md' ! -name README.md | LC_ALL=C sort`: regular
 * files only (a symlink is neither followed nor listed), in byte order of the
 * whole path.
 */
function ruleFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.endsWith(".md") && name !== "README.md") found.push(p);
    }
  };
  walk(dir);
  return found.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function buildBody(agentsDir: string): string {
  let out = withoutH1(join(agentsDir, "AGENTS.md"));
  out += "\n# Principles\n\nThese are the always-on rules, identical in every tool.\n\n";
  for (const f of ruleFiles(join(agentsDir, "rules"))) {
    out += `${withoutH1(f)}\n`;
  }
  return out;
}

/**
 * A front-matter field of a SKILL.md, as the projector's awk read it: the
 * first `---` opens the front matter and the second ends it; `field: value`
 * gives the value, and `field: >` / `|` / `>-` / `|-` folds the indented lines
 * after it into one, space-joined, until a line that is not indented.
 */
function skillField(path: string, field: string): string {
  const lines = records(read(path));
  const notIndented = new RegExp(`^[^${SPACE.slice(1)}`);
  const leading = new RegExp(`^${SPACE}+`);
  let d = 0;
  let folding = false;
  let out = "";
  for (const line of lines) {
    if (line === "---") {
      d++;
      if (d >= 2) break;
      continue;
    }
    if (d !== 1) continue;
    if (folding) {
      if (notIndented.test(line)) break;
      const s = line.replace(leading, "");
      if (s !== "") out = out === "" ? s : `${out} ${s}`;
      continue;
    }
    if ([">", "|", ">-", "|-"].some((m) => line === `${field}: ${m}`)) {
      folding = true;
      out = "";
      continue;
    }
    if (line.startsWith(`${field}: `)) return substituted(line.slice(field.length + 2));
  }
  return folding ? substituted(out) : "";
}

/** sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' — the projector's YAML and TOML escape alike. */
function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The SKILL.md with its front matter fenced as a yaml block. */
function skillBodyFenced(path: string): string {
  let out = "";
  let infm = false;
  records(read(path)).forEach((line, i) => {
    if (i === 0 && line === "---") {
      out += "```yaml\n# skill definition\n";
      infm = true;
    } else if (infm && line === "---") {
      out += "```\n";
      infm = false;
    } else {
      out += `${line}\n`;
    }
  });
  return out;
}

/** Everything the projector would have written at <rel>, or null when it wrote nothing there. */
function project(agentsDir: string, rel: string): string | null {
  const agentsMd = join(agentsDir, "AGENTS.md");
  if (rel === "GEMINI.md" || rel === ".github/copilot-instructions.md") {
    if (!isFile(agentsMd)) return null;
    return `${GEN_NOTE}\n\n${buildBody(agentsDir)}`;
  }
  if (rel === ".cursor/rules/contextium.mdc") {
    if (!isFile(agentsMd)) return null;
    return `---\ndescription: Contextium methodology and principles\nalwaysApply: true\n---\n\n${GEN_NOTE}\n\n${buildBody(agentsDir)}`;
  }
  // The shell's case patterns: `*` matches a `/` too, so the skill name is
  // whatever lies between the prefix and the suffix.
  const skill = (prefix: string, suffix: string): string | null => {
    if (!rel.startsWith(prefix) || !rel.endsWith(suffix) || rel.length < prefix.length + suffix.length) return null;
    const md = `${agentsDir}/skills/${rel.slice(prefix.length, rel.length - suffix.length)}/SKILL.md`;
    return isFile(md) ? md : null;
  };
  if (rel.startsWith(".gemini/commands/") && rel.endsWith(".toml")) {
    const md = skill(".gemini/commands/", ".toml");
    if (md === null) return null;
    const desc = skillField(md, "description");
    const body = substituted(skillBodyFenced(md));
    let out = `description = "${escape(desc)}"\n`;
    if (body.includes("'''")) out += `prompt = """\n${escape(body)}\n"""\n`;
    else out += `prompt = '''\n${body}\n'''\n`;
    return out;
  }
  if (rel.startsWith(".github/prompts/") && rel.endsWith(".prompt.md")) {
    const md = skill(".github/prompts/", ".prompt.md");
    if (md === null) return null;
    const desc = skillField(md, "description");
    return `---\ndescription: "${escape(desc)}"\n---\n\n${skillBodyFenced(md)}`;
  }
  return null;
}

function main(argv: string[]): number {
  const [agentsDir, rel] = argv;
  if (!agentsDir || !rel) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const out = project(agentsDir, rel);
  if (out === null) return 1;
  process.stdout.write(Buffer.from(out, "latin1"));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
