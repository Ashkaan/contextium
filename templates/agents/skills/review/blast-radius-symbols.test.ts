// blast-radius-symbols.test.ts — the symbol packer, against fixture files.
//
// Pins the line protocol blast-radius.ts drives: a FILE/LANG/NEWFILE/NEWLINES/
// OLDFILE/REMOVEDFILE request on stdin, a PARSER/SYMBOL/WARN response on stdout.
// Fixture TypeScript and bash files go in as temp-file paths, exactly as the
// caller passes them; the assertions are the symbol lists that come out.
// The typescript and tree-sitter cases need a node_modules holding
// `typescript`, `web-tree-sitter` and `tree-sitter-bash`: BLAST_RADIUS_TEST_ROOTS
// names one, else this repo's node_modules, npm's global root or Node's own
// global node_modules is used; with none, the first case fails naming the
// packages to install rather than reporting the regex fallback as a parser
// failure. The regex fallback runs with BLAST_RADIUS_PARSER_ROOTS="". The script is run as a subprocess with `node
// --experimental-strip-types`, the way blast-radius.ts runs it — never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/review/blast-radius-symbols.test.ts
//
// peers:
//   .agents/skills/review/blast-radius-symbols.ts
//   .agents/skills/review/blast-radius.test.ts   (the packer end to end)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUT = path.join(HERE, "blast-radius-symbols.ts");
const tmp = mkdtempSync(path.join(os.tmpdir(), "blast-radius-symbols-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The first of: BLAST_RADIUS_TEST_ROOTS, this repo's node_modules, npm's global
// root, Node's own global node_modules — whichever holds all three packages.
const PARSER_PKGS = ["typescript", "web-tree-sitter", "tree-sitter-bash"];
function findParserRoot(): string {
  const top = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  const cands = [
    process.env.BLAST_RADIUS_TEST_ROOTS ?? "",
    top.status === 0 ? path.join(top.stdout.trim(), "node_modules") : "",
    npmRoot.status === 0 ? npmRoot.stdout.trim() : "",
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
  ];
  for (const c of cands) {
    if (c !== "" && PARSER_PKGS.every((p) => existsSync(path.join(c, p)))) return c;
  }
  return "";
}
const PARSER_ROOT = findParserRoot();

test("a node_modules holding the parser packages is found", () => {
  assert.notEqual(
    PARSER_ROOT,
    "",
    "no node_modules with typescript, web-tree-sitter and tree-sitter-bash — " +
      "npm i -g typescript@5 web-tree-sitter tree-sitter-bash, or set BLAST_RADIUS_TEST_ROOTS to one",
  );
});

interface Run {
  rc: number | null;
  out: string;
  err: string;
}

function run(input: string, env: Record<string, string> = {}): Run {
  // --disable-warning: Node 22.6-22.17 print an ExperimentalWarning for type
  // stripping, and "stderr is silent" is asserted below.
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SUT], {
    encoding: "utf8",
    input,
    env: { ...process.env, BLAST_RADIUS_PARSER_ROOTS: PARSER_ROOT, ...env },
    timeout: 60_000,
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

const lines = (r: Run): string[] => r.out.split("\n").filter((l) => l !== "");
const symbols = (r: Run): string =>
  lines(r)
    .filter((l) => l.startsWith("SYMBOL "))
    .map((l) => l.split(" ")[2])
    .join(" ");
const parser = (r: Run, file: string): string =>
  lines(r)
    .filter((l) => l.startsWith(`PARSER ${file} `))
    .map((l) => l.split(" ")[2])
    .join("\n");

const A_TS = path.join(tmp, "a.ts");
const A_SH = path.join(tmp, "a.sh");
const OLD_TS = path.join(tmp, "old.ts");
const REMOVED = path.join(tmp, "removed.txt");

writeFileSync(
  A_TS,
  `export const doThing = () => {
  return 1;
};
export function helper(x: number) {
  return x + 1;
}
export class Widget {
  render() {
    return "w";
  }
}
export interface Shape { a: number }
export type Tiny = 1;
export const ab = 2;
const hidden = 3;
export { hidden as revealed };
function local() {}
`,
);
writeFileSync(
  A_SH,
  `#!/usr/bin/env bash
greet() {
  echo hi
}
function farewell {
  echo bye
}
`,
);
writeFileSync(OLD_TS, "export function gone(a: string) {\n  return a.trim();\n}\nexport function kept() {}\n");
writeFileSync(REMOVED, "  return a.trim();\n}\n");

const tsReq = (lines: string): string => `FILE src/a.ts\nLANG ts\nNEWFILE ${A_TS}\nNEWLINES ${lines}\n`;

// ── every symbol (NEWLINES all), real typescript parser ──────────────────
test("NEWLINES all, real typescript parser", () => {
  const r = run(tsReq("all"));
  assert.equal(r.rc, 0, "a well-formed request exits 0");
  assert.equal(parser(r, "src/a.ts"), "typescript", "the typescript package is found under the parser root");
  assert.equal(
    symbols(r),
    "Shape Tiny Widget doThing helper render revealed",
    "NEWLINES all names every exported symbol, sorted, methods included, non-exports and names under 4 chars (ab) dropped",
  );
  assert.equal(r.err, "", "stderr is silent on success");
});

// ── changed lines select the enclosing declaration ───────────────────────
test("changed lines select the enclosing declaration", () => {
  assert.equal(symbols(run(tsReq("8"))), "Widget render", "a line inside a method names the method AND its class");
  assert.equal(
    symbols(run(tsReq("2"))),
    "doThing",
    "a line inside an arrow-function const names the const (the regex walk-up's failure)",
  );
  assert.equal(symbols(run(tsReq("2,5,12"))), "Shape doThing helper", "several lines union their symbols");
  assert.equal(symbols(run(tsReq("15"))), "", "a line in a non-exported declaration names nothing");
  assert.equal(
    symbols(run(tsReq("16"))),
    "revealed",
    "a re-export names the EXPORTED alias, the token a caller writes",
  );
  assert.equal(
    symbols(run(tsReq("x,,7"))),
    "Widget",
    "non-numeric NEWLINES entries are dropped, the numeric one still counts",
  );
  assert.equal(
    parser(run(`FILE src/a.ts\nNEWFILE ${A_TS}\nNEWLINES 4\n`), "src/a.ts"),
    "typescript",
    "LANG defaults to ts",
  );
});

// ── the old side: a removed line located by TEXT names the deleted export ─
test("the old side, located by text", () => {
  const r = run(`FILE src/o.ts\nLANG ts\nOLDFILE ${OLD_TS}\nREMOVEDFILE ${REMOVED}\n`);
  assert.equal(r.rc, 0, "old-side request exits 0");
  assert.equal(
    symbols(r),
    "gone",
    "a removed line inside a deleted function names it; the bare '}' line names nothing",
  );
  assert.equal(
    symbols(run(`FILE src/o.ts\nLANG ts\nOLDFILE ${OLD_TS}\n`)),
    "",
    "OLDFILE without REMOVEDFILE names nothing",
  );
});

// ── bash, through tree-sitter ────────────────────────────────────────────
test("bash, through tree-sitter", () => {
  const r = run(`FILE bin/a.sh\nLANG sh\nNEWFILE ${A_SH}\nNEWLINES 3\n`);
  assert.equal(parser(r, "bin/a.sh"), "tree-sitter-bash", "bash parses with tree-sitter-bash");
  assert.equal(symbols(r), "greet", "a line inside a bash function names that function only");
  assert.equal(
    symbols(run(`FILE bin/a.sh\nLANG sh\nNEWFILE ${A_SH}\nNEWLINES all\n`)),
    "farewell greet",
    "both bash function forms are collected",
  );
});

// ── the regex fallback, when no parser root holds the package ────────────
test("the regex fallback", () => {
  const r = run(tsReq("all"), { BLAST_RADIUS_PARSER_ROOTS: "" });
  assert.equal(r.rc, 0, "no parser roots still exits 0");
  assert.equal(parser(r, "src/a.ts"), "regex", "the response says regex");
  assert.equal(
    symbols(r),
    "Shape Tiny Widget doThing helper",
    "the fallback misses the method and the re-export, as the header warns",
  );
  assert.ok(
    lines(r).some((l) => l.startsWith("WARN the typescript package did not load — falling back to regex")),
    "the fallback is announced",
  );
  const sh = run(`FILE bin/a.sh\nLANG sh\nNEWFILE ${A_SH}\nNEWLINES all\n`, { BLAST_RADIUS_PARSER_ROOTS: "" });
  assert.equal(`${parser(sh, "bin/a.sh")} ${symbols(sh)}`, "regex farewell greet", "bash falls back to regex too");
  assert.ok(
    lines(sh).some((l) => l.startsWith("WARN blast-radius-symbols: web-tree-sitter not found under any parser root")),
    "bash fallback names its missing parser",
  );
});

// ── several records, caller mistakes reported as WARN not as failure ─────
test("several records, caller mistakes reported as WARN", () => {
  const r = run(
    `FILE src/x.ts\nLANG ts\nNEWFILE /nonexistent/x.ts\nBOGUS 1\n\nFILE src/y.ts\nNEWFILE ${A_TS}\nNEWLINES 1\n`,
  );
  assert.equal(r.rc, 0, "an unreadable bytes file and an unknown key do not fail the run");
  assert.equal(lines(r).filter((l) => l.startsWith("PARSER ")).length, 2, "every record still gets a PARSER line");
  assert.equal(symbols(r), "doThing", "the readable record's symbols are unaffected");
  assert.ok(
    r.out.includes('WARN blast-radius-symbols: unknown request key "BOGUS"'),
    "the unknown key is warned by name",
  );
  assert.ok(
    r.out.includes("WARN blast-radius-symbols: could not read new bytes /nonexistent/x.ts"),
    "the unreadable file is warned by path",
  );
  const all = lines(r);
  const firstWarn = all.findIndex((l) => l.startsWith("WARN"));
  assert.ok(
    firstWarn !== -1 && all.slice(firstWarn).every((l) => l.startsWith("WARN")),
    "WARN lines come after every PARSER/SYMBOL line",
  );
  assert.equal(run("LANG ts\nNEWLINES all\n").rc, 0, "a key before the first FILE is ignored");
});

// ── an empty request is an empty response ────────────────────────────────
test("an empty request is an empty response", () => {
  const r = run("");
  assert.equal(r.rc, 0, "empty stdin exits 0");
  assert.equal(r.out, "", "empty stdin writes nothing");
});

// ── A typescript package without the compiler API ────────────────────────
// TypeScript 7 (the native port) ships `typescript` with no createSourceFile:
// its main export is only a version. Loaded blindly it returned no symbols at
// all and said nothing; it must fall back to the regex walk and say why.
test("a typescript package without the compiler API", () => {
  const ts7 = path.join(tmp, "ts7", "node_modules");
  mkdirSync(path.join(ts7, "typescript"), { recursive: true });
  writeFileSync(
    path.join(ts7, "typescript", "package.json"),
    '{"name":"typescript","version":"7.0.2","main":"index.js"}\n',
  );
  writeFileSync(path.join(ts7, "typescript", "index.js"), 'module.exports = { version: "7.0.2" };\n');
  const r = run(tsReq("all"), { BLAST_RADIUS_PARSER_ROOTS: ts7 });
  assert.equal(r.rc, 0, "a typescript with no compiler API: still exit 0");
  assert.equal(parser(r, "src/a.ts"), "regex", "…falls back to the regex walk");
  assert.equal(
    lines(r).filter((l) => /^WARN .*typescript 7\.0\.2, .*createSourceFile/.test(l)).length,
    1,
    "…and says which typescript it could not use",
  );
  assert.ok(symbols(r).includes("Widget"), "…while the regex walk still finds the exported symbols");
  // …and a later root with a working compiler API is still used.
  const realRoot = PARSER_ROOT;
  const later = run(tsReq("all"), { BLAST_RADIUS_PARSER_ROOTS: `${ts7}:${realRoot}` });
  assert.equal(
    parser(later, "src/a.ts"),
    "typescript",
    "an unusable typescript in an earlier root does not hide a usable one later",
  );
});

// ── npm's global root is a default parser root ───────────────────────────
// `npm i -g` installs under `npm root -g`, which differs from Node's own
// <prefix>/lib/node_modules whenever npm has a custom prefix (a user-level
// prefix is the common way to avoid sudo). The install hint says `npm i -g`,
// so the default roots must include where that command puts the packages.
test("the default parser roots include npm's global root", () => {
  const npmGlobal = path.join(tmp, "npm-global", "lib", "node_modules");
  mkdirSync(npmGlobal, { recursive: true });
  for (const p of PARSER_PKGS) symlinkSync(path.join(PARSER_ROOT, p), path.join(npmGlobal, p));
  const bin = path.join(tmp, "fake-npm-bin");
  mkdirSync(bin, { recursive: true });
  const npm = path.join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh\n[ "$1 $2" = "root -g" ] && echo '${npmGlobal}' && exit 0\nexit 1\n`);
  chmodSync(npm, 0o755);
  const emptyRepo = mkdtempSync(path.join(tmp, "repo-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BLAST_RADIUS_REPO_ROOT: emptyRepo,
  };
  delete env.BLAST_RADIUS_PARSER_ROOTS;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SUT], {
    encoding: "utf8",
    input: tsReq("all"),
    env,
    timeout: 60_000,
  });
  const got = { rc: r.status, out: r.stdout, err: r.stderr };
  assert.equal(got.rc, 0, got.err);
  assert.equal(parser(got, "src/a.ts"), "typescript", "the typescript under `npm root -g` is found with no root set");
});
