#!/usr/bin/env node

// blast-radius-symbols.mjs — name the symbols a diff actually changed, with a
// REAL parser rather than a regex walk-up.
//
// blast-radius.sh knows which LINES moved; this knows which DECLARATION those
// lines sit inside. A regex walk-up gets that wrong in the two most common
// shapes — `export const foo = () => {` (the walk-up sees `const`, not a
// function) and a class method (the walk-up sees the class, not the method) —
// and a wrong symbol name means the caller grep below it searches for the wrong
// token, so the pack reports the wrong blast radius with full confidence.
//
// Protocol: a line-oriented request on stdin, a line-oriented response on
// stdout. One process for the whole file list, because starting node per file
// costs more than the parse does. Line-oriented rather than JSON in both
// directions so the shell caller neither builds nor parses JSON — file BYTES
// travel as temp-file paths, never inline, which is what makes that possible.
//
//   request (one blank-line-separated record per file; every key optional
//            except FILE and LANG):
//
//     FILE apps/foo/bar.ts          repo-relative path, rest of line
//     LANG ts                       ts | sh
//     NEWFILE /tmp/.../new.3        current bytes
//     NEWLINES 12,13                changed new-side lines; `all` = every symbol
//     OLDFILE /tmp/.../old.3        bytes at the base ref
//     REMOVEDFILE /tmp/.../rm.3     one removed line per line
//
//   response (one record per line, any order):
//
//     PARSER apps/foo/bar.ts typescript
//     SYMBOL apps/foo/bar.ts doThing
//     WARN   <diagnostic>
//
// WHY THE OLD SIDE IS LOCATED BY TEXT, NOT BY LINE NUMBER. A deleted export has
// to be read off the `-` side or its callers never appear in the pack, and the
// `-` line numbers of a hunk index the old file while `@@` gives the new-side
// position — so locating a removed line in the old bytes means maintaining a
// second coordinate space for one lookup. The removed line's TEXT needs none:
// it is matched against each old-side symbol's own source slice. A line that
// occurs in two symbols lists both — over-listing in a context pack costs a
// reviewer one extra name, and this is not a gate.
//
// Removed lines shorter than 4 characters, or carrying no letter at all (`}`,
// `})`, `);`), are dropped before that match — they sit inside every symbol in
// the file and would name all of them.
//
// PARSER RESOLUTION. `typescript` for .ts/.tsx, `web-tree-sitter` +
// `tree-sitter-bash`'s shipped .wasm for .sh, looked for under each root in
// BLAST_RADIUS_PARSER_ROOTS (colon-separated), defaulting to
// $BLAST_RADIUS_REPO_ROOT/node_modules, then Node's own global node_modules.
// A root that has no such package is skipped; when none of them load, the
// regex fallback runs and says so in `warnings` and in `parser`. Setting
// BLAST_RADIUS_PARSER_ROOTS to the empty string removes every root, which is how
// the fallback is tested against a genuinely unloadable import rather than
// against a flag.
//
// Plain JavaScript in an .mjs file, so any supported Node runs it without a
// type-stripping flag.
//
// peers:
//   .agents/skills/review/blast-radius.sh
//   .agents/skills/review/blast-radius.test.sh
//
// Exit: 0 response written · 2 unreadable / unparseable request

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const warnings = [];

// ── Parser resolution ──────────────────────────────────────────────────

// The repo's own node_modules first — where a project that uses TypeScript
// already has it — then Node's global prefix (<prefix>/bin/node →
// <prefix>/lib/node_modules), where a global `npm i -g typescript` lands.
function parserRoots() {
  const env = process.env.BLAST_RADIUS_PARSER_ROOTS;
  if (env !== undefined) return env.split(":").filter(Boolean);
  const roots = [];
  const repo = process.env.BLAST_RADIUS_REPO_ROOT;
  if (repo) roots.push(path.join(repo, "node_modules"));
  roots.push(path.join(path.dirname(process.execPath), "..", "lib", "node_modules"));
  return roots;
}

// Resolve a package under one of the roots and import it. Returns the module
// namespace with a CJS default unwrapped, or null when no root holds it.
async function loadPackage(pkg) {
  for (const root of parserRoots()) {
    if (!existsSync(path.join(root, pkg))) continue;
    try {
      const req = createRequire(path.join(root, "__blast-radius-resolver__.cjs"));
      const entry = req.resolve(pkg);
      const mod = await import(pathToFileURL(entry).href);
      return mod?.default ?? mod;
    } catch (err) {
      warnings.push(`blast-radius-symbols: ${pkg} under ${root} failed to load: ${err.message}`);
    }
  }
  return null;
}

// The bash grammar ships as a .wasm inside the tree-sitter-bash package, so no
// node-gyp build and no native binding is involved.
function bashGrammarPath() {
  for (const root of parserRoots()) {
    const wasm = path.join(root, "tree-sitter-bash", "tree-sitter-bash.wasm");
    if (existsSync(wasm)) return wasm;
  }
  return null;
}

// ── Symbol collection ──────────────────────────────────────────────────
//
// Every collector returns the same record shape, so the matcher below never
// asks which one produced it:
//   { name, start, end, text }   1-indexed inclusive line range + source slice

let tsModule;
async function tsCollector() {
  if (tsModule === undefined) tsModule = await loadPackage("typescript");
  if (!tsModule) return null;
  const ts = tsModule;
  return (filePath, text) => {
    const out = [];
    const sf = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (name, node) => {
      if (!name) return;
      const start = node.getStart(sf);
      const end = node.getEnd();
      out.push({
        name,
        start: lineOf(start),
        end: lineOf(end),
        text: text.slice(start, end),
      });
    };
    const exported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;

    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st)) {
        if (exported(st)) add(st.name?.text, st);
      } else if (ts.isClassDeclaration(st)) {
        if (!exported(st)) continue;
        add(st.name?.text, st);
        // A method is its own call target: a caller of `Foo.render` never
        // mentions `Foo` on the same line, so the class name alone would grep
        // for the wrong token.
        for (const member of st.members) {
          if (member.name && ts.isIdentifier(member.name)) add(member.name.text, member);
        }
      } else if (ts.isVariableStatement(st)) {
        if (!exported(st)) continue;
        // Ranged on the DECLARATOR, not the statement: `export const a = 1, b = 2`
        // must not report both names for a change that touched one of them.
        for (const decl of st.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) add(decl.name.text, decl);
        }
      } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
        if (exported(st)) add(st.name?.text, st);
      } else if (ts.isExportDeclaration(st)) {
        // `export { doThing }` and `export { doThing as other } from './a'`.
        // These carry no `export` MODIFIER — the export-ness is the statement
        // itself — so `exported()` is false for them and the branches above
        // skip them entirely. That mattered: a barrel file is nothing but these
        // statements, so an edit to one produced no symbols at all and its
        // consumers never reached the reviewer.
        //
        // The name that travels is the EXPORTED one (the alias where there is
        // one), because that is the token a caller in another file writes.
        //
        // NAME from the specifier, RANGE from the whole statement. Ranging on
        // the specifier looked tighter and lost two cases outright: the
        // old-side lookup matches a removed line's TEXT against a symbol's
        // source slice, and `export { removedWork } from './impl'` is not
        // inside the slice `removedWork` — so a DELETED re-export produced no
        // symbol at all. Nor is a change to a multiline export's `from` clause
        // inside any specifier. An `export { a, b }` edit now names both, which
        // is the right unit anyway: the statement is what changed.
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) add(el.name.text, st);
        }
      }
    }
    return out;
  };
}

let bashParser;
async function shCollector() {
  if (bashParser === undefined) {
    bashParser = null;
    const wts = await loadPackage("web-tree-sitter");
    const grammar = bashGrammarPath();
    if (wts && grammar) {
      try {
        const Parser = wts.Parser ?? wts;
        const Language = wts.Language;
        await Parser.init();
        const lang = await Language.load(grammar);
        const parser = new Parser();
        parser.setLanguage(lang);
        bashParser = parser;
      } catch (err) {
        warnings.push(`blast-radius-symbols: tree-sitter-bash failed to load: ${err.message}`);
      }
    } else if (!wts) {
      warnings.push("blast-radius-symbols: web-tree-sitter not found under any parser root");
    } else {
      warnings.push("blast-radius-symbols: tree-sitter-bash.wasm not found under any parser root");
    }
  }
  if (!bashParser) return null;
  return (_filePath, text) => {
    const out = [];
    const tree = bashParser.parse(text);
    const visit = (node) => {
      if (node.type === "function_definition") {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          out.push({
            name,
            start: node.startPosition.row + 1,
            end: node.endPosition.row + 1,
            text: text.slice(node.startIndex, node.endIndex),
          });
        }
      }
      for (let i = 0; i < node.childCount; i++) visit(node.child(i));
    };
    visit(tree.rootNode);
    return out;
  };
}

// The fallback, and ONLY the fallback. It is wrong in exactly the ways the
// header names; it exists so a missing package degrades the pack instead of
// killing the review that carries it.
const TS_DECL = [
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
];
const SH_DECL = [/^\s*function\s+([A-Za-z_][\w:.-]*)\s*(?:\(\s*\))?\s*\{/, /^\s*([A-Za-z_][\w:.-]*)\s*\(\s*\)\s*\{/];

function regexCollector(lang) {
  const patterns = lang === "sh" ? SH_DECL : TS_DECL;
  return (_filePath, text) => {
    const lines = text.split("\n");
    const found = [];
    lines.forEach((line, idx) => {
      for (const re of patterns) {
        const m = re.exec(line);
        if (m) {
          found.push({ name: m[1], start: idx + 1 });
          break;
        }
      }
    });
    return found.map((sym, i) => {
      const end = i + 1 < found.length ? found[i + 1].start - 1 : lines.length;
      return {
        name: sym.name,
        start: sym.start,
        end,
        text: lines.slice(sym.start - 1, end).join("\n"),
      };
    });
  };
}

// ── Matching ───────────────────────────────────────────────────────────

// A removed line worth matching: long enough and lettered enough to belong to
// one symbol rather than to all of them.
function usableRemovedLine(line) {
  const trimmed = line.trim();
  return trimmed.length >= 4 && /[A-Za-z_]/.test(trimmed);
}

function symbolsForFile(file, collect) {
  const names = new Set();

  if (file.new && typeof file.new.text === "string") {
    const syms = collect(file.path, file.new.text);
    if (file.new.lines === null || file.new.lines === undefined) {
      for (const s of syms) names.add(s.name);
    } else {
      for (const line of file.new.lines) {
        for (const s of syms) if (line >= s.start && line <= s.end) names.add(s.name);
      }
    }
  }

  if (file.old && typeof file.old.text === "string") {
    const syms = collect(file.path, file.old.text);
    const removed = (file.old.removed || []).filter(usableRemovedLine).map((l) => l.trim());
    for (const line of removed) {
      for (const s of syms) if (s.text.includes(line)) names.add(s.name);
    }
  }

  // Boundary inputs — an identifier under 4 characters greps to noise in
  // any sizable repo, so it is never a changed symbol.
  return [...names].filter((n) => n.length >= 4).sort();
}

// ── Main ───────────────────────────────────────────────────────────────

// Parse the request stream into records. A key repeated inside one record is a
// caller error rather than a merge — last wins, and the shell never writes one.
function parseRequest(text) {
  const records = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const sep = line.indexOf(" ");
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1);
    if (key === "FILE") {
      if (current) records.push(current);
      current = { path: value, lang: "ts" };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case "LANG":
        current.lang = value === "sh" ? "sh" : "ts";
        break;
      case "NEWFILE":
        current.newFile = value;
        break;
      case "NEWLINES":
        current.newLines =
          value === "all"
            ? null
            : value
                .split(",")
                .map((n) => Number.parseInt(n, 10))
                .filter((n) => Number.isFinite(n));
        break;
      case "OLDFILE":
        current.oldFile = value;
        break;
      case "REMOVEDFILE":
        current.removedFile = value;
        break;
      default:
        warnings.push(`blast-radius-symbols: unknown request key "${key}"`);
    }
  }
  if (current) records.push(current);
  return records;
}

// A bytes file that cannot be read is a caller bug, not a parse result: say so
// and treat the side as absent rather than silently reporting zero symbols.
function readBytes(file, label) {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    warnings.push(`blast-radius-symbols: could not read ${label} ${file}: ${err.message}`);
    return null;
  }
}

let stdinText = "";
try {
  stdinText = readFileSync(0, "utf8");
} catch (err) {
  process.stderr.write(`blast-radius-symbols: could not read the request: ${err.message}\n`);
  process.exit(2);
}

const records = parseRequest(stdinText);

const collectors = { ts: null, sh: null };
const collectorNames = { ts: "regex", sh: "regex" };

if (records.some((r) => r.lang === "ts")) {
  const tsc = await tsCollector();
  if (tsc) {
    collectors.ts = tsc;
    collectorNames.ts = "typescript";
  } else {
    warnings.push(
      "the typescript package did not load — falling back to regex; " +
        "`export const foo = () =>` and class methods will be named imprecisely",
    );
  }
}

if (records.some((r) => r.lang === "sh")) {
  const shc = await shCollector();
  if (shc) {
    collectors.sh = shc;
    collectorNames.sh = "tree-sitter-bash";
  } else {
    warnings.push("the bash parser did not load — falling back to regex");
  }
}

// Contextium: a fallback says where the parsers were looked for and how to get
// them — the installer does not install them, so the warning is the install path.
if (collectorNames.ts === "regex" || collectorNames.sh === "regex") {
  if (warnings.some((w) => w.includes("falling back to regex"))) {
    const roots = parserRoots();
    warnings.push(
      `parsers looked in: ${roots.length ? roots.join(", ") : "(no roots: BLAST_RADIUS_PARSER_ROOTS is empty)"}; ` +
        "install them with `npm i -g typescript web-tree-sitter tree-sitter-bash` " +
        "(Node's global node_modules), or into the workbench's own node_modules",
    );
  }
}

const out = [];
for (const record of records) {
  const lang = record.lang;
  const collect = collectors[lang] || regexCollector(lang);
  const file = {
    path: record.path,
    new: record.newFile
      ? {
          text: readBytes(record.newFile, "new bytes"),
          lines: record.newLines ?? null,
        }
      : null,
    old: record.oldFile
      ? {
          text: readBytes(record.oldFile, "old bytes"),
          removed: (readBytes(record.removedFile, "removed lines") ?? "").split("\n"),
        }
      : null,
  };
  let symbols = [];
  try {
    symbols = symbolsForFile(file, collect);
  } catch (err) {
    warnings.push(`${record.path}: ${err.message}`);
  }
  out.push(`PARSER ${record.path} ${collectors[lang] ? collectorNames[lang] : "regex"}`);
  for (const name of symbols) out.push(`SYMBOL ${record.path} ${name}`);
}

for (const w of warnings) out.push(`WARN ${w}`);
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
