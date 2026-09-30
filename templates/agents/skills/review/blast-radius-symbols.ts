#!/usr/bin/env -S node --experimental-strip-types

// blast-radius-symbols.ts — name the symbols a diff actually changed, with a
// REAL parser rather than a regex walk-up.
//
// blast-radius.ts knows which LINES moved; this knows which DECLARATION those
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
// $BLAST_RADIUS_REPO_ROOT/node_modules, then `npm root -g`, then Node's own
// global node_modules.
// A root that has no such package is skipped; when none of them load, the
// regex fallback runs and says so in `warnings` and in `parser`. Setting
// BLAST_RADIUS_PARSER_ROOTS to the empty string removes every root, which is how
// the fallback is tested against a genuinely unloadable import rather than
// against a flag.
//
// peers:
//   .agents/skills/review/blast-radius.ts
//   .agents/skills/review/blast-radius.test.ts
//
// Exit: 0 response written · 2 unreadable / unparseable request

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Types ──────────────────────────────────────────────────────────────
//
// Both parsers are loaded at run time from roots found at run time (see
// PARSER RESOLUTION above), so neither package's own .d.ts is reachable from
// the tsconfig that checks this file. What follows is the SLICE of each API
// this file calls, written structurally: the real modules satisfy it, and a
// module that does not (TypeScript 7's compiler-less `typescript`) is refused
// by the guards below before any of it is called.

/** One declaration a collector found: 1-indexed inclusive line range + source slice. */
interface Sym {
  name: string;
  start: number;
  end: number;
  text: string;
}
type Collector = (filePath: string, text: string) => Sym[];

interface TsNode {
  getStart(sourceFile?: TsSourceFile): number;
  getEnd(): number;
}
interface TsIdentifier extends TsNode {
  readonly text: string;
}
interface TsSourceFile extends TsNode {
  readonly statements: readonly TsNode[];
  getLineAndCharacterOfPosition(pos: number): { line: number; character: number };
}
interface TsNamedDeclaration extends TsNode {
  readonly name?: TsIdentifier;
}
interface TsClassDeclaration extends TsNamedDeclaration {
  readonly members: readonly { readonly name?: TsNode; getStart(sf?: TsSourceFile): number; getEnd(): number }[];
}
interface TsVariableStatement extends TsNode {
  readonly declarationList: { readonly declarations: readonly (TsNode & { readonly name: TsNode })[] };
}
interface TsExportDeclaration extends TsNode {
  readonly exportClause?: TsNode;
}
interface TsNamedExports extends TsNode {
  readonly elements: readonly { readonly name: TsIdentifier }[];
}
/** The compiler API calls tsCollector makes — typescript@5's, structurally. */
interface TsApi {
  createSourceFile(fileName: string, text: string, target: number, setParentNodes: boolean, kind: number): TsSourceFile;
  readonly ScriptTarget: { readonly Latest: number };
  readonly ScriptKind: { readonly TS: number; readonly TSX: number };
  readonly ModifierFlags: { readonly Export: number };
  getCombinedModifierFlags(node: TsNode): number;
  isFunctionDeclaration(node: TsNode): node is TsNamedDeclaration;
  isClassDeclaration(node: TsNode): node is TsClassDeclaration;
  isVariableStatement(node: TsNode): node is TsVariableStatement;
  isInterfaceDeclaration(node: TsNode): node is TsNamedDeclaration;
  isTypeAliasDeclaration(node: TsNode): node is TsNamedDeclaration;
  isEnumDeclaration(node: TsNode): node is TsNamedDeclaration;
  isExportDeclaration(node: TsNode): node is TsExportDeclaration;
  isNamedExports(node: TsNode): node is TsNamedExports;
  isIdentifier(node: TsNode): node is TsIdentifier;
}

/** The web-tree-sitter calls shCollector makes — its Parser, Language and Node, structurally. */
interface BashNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number };
  readonly endPosition: { readonly row: number };
  readonly childCount: number;
  child(index: number): BashNode | null;
  childForFieldName(fieldName: string): BashNode | null;
}
interface BashParser {
  setLanguage(language: unknown): void;
  parse(text: string): { readonly rootNode: BashNode } | null;
}
interface BashParserClass {
  new (): BashParser;
  init(): Promise<void>;
}
interface BashLanguageClass {
  load(input: string): Promise<unknown>;
}

type Lang = "ts" | "sh";

/** One blank-line-separated record of the request. */
interface RequestRecord {
  path: string;
  lang: Lang;
  newFile?: string;
  newLines?: number[] | null;
  oldFile?: string;
  removedFile?: string;
}

/** What symbolsForFile reads: each side's bytes, and which of them changed. */
interface FileSides {
  path: string;
  new: { text: string | null; lines: number[] | null } | null;
  old: { text: string | null; removed: string[] } | null;
}

/** A property of a loaded module, whatever shape the module turned out to be. */
function field(obj: unknown, key: string): unknown {
  if ((typeof obj === "object" && obj !== null) || typeof obj === "function") return Reflect.get(obj, key);
  return undefined;
}

function errMessage(err: unknown): unknown {
  return field(err, "message");
}

function isTsApi(mod: unknown): mod is TsApi {
  return typeof field(mod, "createSourceFile") === "function";
}

function isBashParserClass(v: unknown): v is BashParserClass {
  return typeof v === "function" && typeof field(v, "init") === "function";
}

function isBashLanguageClass(v: unknown): v is BashLanguageClass {
  return typeof field(v, "load") === "function";
}

const warnings: string[] = [];

// ── Parser resolution ──────────────────────────────────────────────────

// The repo's own node_modules first — where a project that uses TypeScript
// already has it — then `npm root -g`, where a global `npm i -g typescript`
// lands (a custom npm prefix moves it away from Node's), then Node's own
// global prefix (<prefix>/bin/node → <prefix>/lib/node_modules) for a machine
// with no npm on PATH. Computed once: `npm root -g` is a process spawn.
let rootsMemo: string[] | undefined;
function parserRoots(): string[] {
  const env = process.env.BLAST_RADIUS_PARSER_ROOTS;
  if (env !== undefined) return env.split(":").filter(Boolean);
  if (rootsMemo) return rootsMemo;
  const roots: string[] = [];
  const repo = process.env.BLAST_RADIUS_REPO_ROOT;
  if (repo) roots.push(path.join(repo, "node_modules"));
  const npm = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15_000 });
  const npmRoot = npm.status === 0 ? npm.stdout.trim() : "";
  if (npmRoot) roots.push(npmRoot);
  const nodeRoot = path.join(path.dirname(process.execPath), "..", "lib", "node_modules");
  if (path.resolve(nodeRoot) !== path.resolve(npmRoot || ".")) roots.push(nodeRoot);
  rootsMemo = roots;
  return roots;
}

// Resolve a package under one of the roots and import it. Returns the module
// namespace with a CJS default unwrapped, or null when no root holds it.
// `unusable(mod)` names why a loaded package cannot serve (or returns null);
// such a root is warned about and the next one tried.
async function loadPackage(pkg: string, unusable: (mod: unknown) => string | null = () => null): Promise<unknown> {
  for (const root of parserRoots()) {
    if (!existsSync(path.join(root, pkg))) continue;
    try {
      const req = createRequire(path.join(root, "__blast-radius-resolver__.cjs"));
      const entry = req.resolve(pkg);
      const imported: unknown = await import(pathToFileURL(entry).href);
      const mod = field(imported, "default") ?? imported;
      const why = unusable(mod);
      if (why) {
        warnings.push(`blast-radius-symbols: ${pkg} under ${root} ${why}`);
        continue;
      }
      return mod;
    } catch (err) {
      warnings.push(`blast-radius-symbols: ${pkg} under ${root} failed to load: ${errMessage(err)}`);
    }
  }
  return null;
}

// The bash grammar ships as a .wasm inside the tree-sitter-bash package, so no
// node-gyp build and no native binding is involved.
function bashGrammarPath(): string | null {
  for (const root of parserRoots()) {
    const wasm = path.join(root, "tree-sitter-bash", "tree-sitter-bash.wasm");
    if (existsSync(wasm)) return wasm;
  }
  return null;
}

// ── Symbol collection ──────────────────────────────────────────────────
//
// Every collector returns the same record shape (`Sym`), so the matcher below
// never asks which one produced it:
//   { name, start, end, text }   1-indexed inclusive line range + source slice

let tsModule: TsApi | null | undefined;
async function tsCollector(): Promise<Collector | null> {
  // TypeScript 7 (the native port) ships `typescript` without the compiler
  // API; loaded blindly, it produced no symbols and no word about why. Such a
  // root is skipped for the next one, and with none left, the regex walk.
  if (tsModule === undefined) {
    const loaded = await loadPackage("typescript", (mod) =>
      isTsApi(mod)
        ? null
        : `is typescript ${field(mod, "version") ?? "(unknown version)"}, which has no createSourceFile (TypeScript 7 dropped the compiler API) — install typescript@5`,
    );
    tsModule = isTsApi(loaded) ? loaded : null;
  }
  if (!tsModule) return null;
  const ts = tsModule;
  return (filePath, text) => {
    const out: Sym[] = [];
    const sf = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (name: string | undefined, node: { getStart(sf?: TsSourceFile): number; getEnd(): number }): void => {
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
    const exported = (node: TsNode): boolean => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;

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

let bashParser: BashParser | null | undefined;
async function shCollector(): Promise<Collector | null> {
  if (bashParser === undefined) {
    bashParser = null;
    const wts = await loadPackage("web-tree-sitter");
    const grammar = bashGrammarPath();
    if (wts && grammar) {
      try {
        const Parser = field(wts, "Parser") ?? wts;
        const Language = field(wts, "Language");
        if (!isBashParserClass(Parser)) throw new TypeError("Parser.init is not a function");
        await Parser.init();
        if (!isBashLanguageClass(Language)) throw new TypeError("Cannot read properties of undefined (reading 'load')");
        const lang = await Language.load(grammar);
        const parser = new Parser();
        parser.setLanguage(lang);
        bashParser = parser;
      } catch (err) {
        warnings.push(`blast-radius-symbols: tree-sitter-bash failed to load: ${errMessage(err)}`);
      }
    } else if (!wts) {
      warnings.push("blast-radius-symbols: web-tree-sitter not found under any parser root");
    } else {
      warnings.push("blast-radius-symbols: tree-sitter-bash.wasm not found under any parser root");
    }
  }
  if (!bashParser) return null;
  const parser = bashParser;
  return (_filePath, text) => {
    const out: Sym[] = [];
    const tree = parser.parse(text);
    if (!tree) throw new TypeError("Cannot read properties of null (reading 'rootNode')");
    const visit = (node: BashNode): void => {
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
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
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

function regexCollector(lang: Lang): Collector {
  const patterns = lang === "sh" ? SH_DECL : TS_DECL;
  return (_filePath, text) => {
    const lines = text.split("\n");
    const found: { name: string; start: number }[] = [];
    lines.forEach((line, idx) => {
      for (const re of patterns) {
        const m = re.exec(line);
        if (m) {
          found.push({ name: m[1] ?? "", start: idx + 1 });
          break;
        }
      }
    });
    return found.map((sym, i) => {
      const next = found[i + 1];
      const end = next ? next.start - 1 : lines.length;
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
function usableRemovedLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 4 && /[A-Za-z_]/.test(trimmed);
}

function symbolsForFile(file: FileSides, collect: Collector): string[] {
  const names = new Set<string>();

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
function parseRequest(text: string): RequestRecord[] {
  const records: RequestRecord[] = [];
  let current: RequestRecord | null = null;
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
function readBytes(file: string | undefined, label: string): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    warnings.push(`blast-radius-symbols: could not read ${label} ${file}: ${errMessage(err)}`);
    return null;
  }
}

let stdinText = "";
try {
  stdinText = readFileSync(0, "utf8");
} catch (err) {
  process.stderr.write(`blast-radius-symbols: could not read the request: ${errMessage(err)}\n`);
  process.exit(2);
}

const records = parseRequest(stdinText);

const collectors: Record<Lang, Collector | null> = { ts: null, sh: null };
const collectorNames: Record<Lang, string> = { ts: "regex", sh: "regex" };

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
        "install them with `npm i -g typescript@5 web-tree-sitter tree-sitter-bash` " +
        "(npm's global root), or into the workbench's own node_modules",
    );
  }
}

const out: string[] = [];
for (const record of records) {
  const lang = record.lang;
  const collect = collectors[lang] || regexCollector(lang);
  const file: FileSides = {
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
  let symbols: string[] = [];
  try {
    symbols = symbolsForFile(file, collect);
  } catch (err) {
    warnings.push(`${record.path}: ${errMessage(err)}`);
  }
  out.push(`PARSER ${record.path} ${collectors[lang] ? collectorNames[lang] : "regex"}`);
  for (const name of symbols) out.push(`SYMBOL ${record.path} ${name}`);
}

for (const w of warnings) out.push(`WARN ${w}`);
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
