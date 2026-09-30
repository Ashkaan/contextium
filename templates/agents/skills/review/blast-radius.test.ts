// blast-radius.test.ts — the packer, against hermetic temp repos.
//
// Every case builds its own git repo in a temp dir, so nothing here depends on
// this checkout's contents, on a vendor, on auth or on a network. The packer
// reads a working tree and greps it; that is the whole surface.
//
// Run: node --test --experimental-strip-types .agents/skills/review/blast-radius.test.ts
//
// The cases that need the REAL TypeScript parser (re-export statements, which
// the regex fallback cannot see) run when a `typescript` package is found —
// under BLAST_RADIUS_TEST_PARSER_ROOT, this repo's node_modules, npm's global
// root or Node's own global node_modules — and are reported as skipped
// otherwise. Every other case runs with exactly that root, or none.
//
// The cases run in file order and share the fixture repos they build, as the
// bash suite's sections did: a section edits a repo, asserts, and restores it
// for the next.
//
// peers:
//   .agents/skills/review/blast-radius.ts
//   .agents/skills/review/blast-radius-symbols.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(HERE, "blast-radius.ts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "blast-radius-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function findParserRoot(): string {
  const top = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  const cands = [
    process.env.BLAST_RADIUS_TEST_PARSER_ROOT ?? "",
    top.status === 0 ? path.join(top.stdout.trim(), "node_modules") : "",
    npmRoot.status === 0 ? npmRoot.stdout.trim() : "",
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
  ];
  for (const c of cands) {
    if (c !== "" && existsSync(path.join(c, "typescript", "package.json"))) return c;
  }
  return "";
}
const PARSER_ROOT = findParserRoot();
const HAVE_TS = PARSER_ROOT !== "";
const NO_TS = "no typescript package found — real-parser case not run (set BLAST_RADIUS_TEST_PARSER_ROOT)";

interface Run {
  rc: number | null;
  out: string;
  err: string;
}

function run(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", PACK, ...args], {
    encoding: "utf8",
    env: { ...process.env, BLAST_RADIUS_PARSER_ROOTS: PARSER_ROOT, ...env },
    timeout: 120_000,
  });
  return { rc: r.status, out: r.stdout.replace(/\n+$/, ""), err: r.stderr };
}

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

// newRepo <name> — an initialized repo with an identity.
function newRepo(name: string): string {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function put(dir: string, rel: string, body: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
}

/** `sed -i 's/from/to/'` on one line of a file (first match per line, whole-line pattern). */
function edit(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  writeFileSync(
    file,
    text
      .split("\n")
      .map((l) => (l === from ? to : l))
      .join("\n"),
  );
}

/** The diff of the working tree, written where a --diff-file can name it. */
function diffTo(dir: string, name: string): string {
  const p = path.join(TMP, name);
  writeFileSync(p, git(dir, "diff"));
  return p;
}

const has = (hay: string, needle: string, msg: string): void =>
  assert.ok(hay.includes(needle), `${msg} — missing '${needle}' in:\n${hay}`);
const lacks = (hay: string, needle: string, msg: string): void =>
  assert.ok(!hay.includes(needle), `${msg} — unexpected '${needle}' in:\n${hay}`);

// ── 1. Nothing to pack ────────────────────────────────────────────────

test("1. nothing to pack", () => {
  const R0 = newRepo("empty");
  put(R0, "seed.txt", "x\n");
  git(R0, "add", "seed.txt");
  git(R0, "commit", "-qm", "init");

  let r = run(["--repo", R0]);
  assert.equal(r.rc, 0, "0 files exits 0");
  assert.equal(r.out, "", "0 files prints nothing");

  r = run(["--repo", R0, "README.md"]);
  assert.equal(r.rc, 0, "a list with no packable language exits 0");
  assert.equal(r.out, "", "a list with no packable language prints nothing");

  assert.equal(run(["--repo", path.join(TMP, "not-a-repo-at-all"), "src/a.ts"]).rc, 2, "a non-repo is a caller error");
  assert.equal(
    run(["--repo", R0, "--files-file", path.join(TMP, "no-such-list")]).rc,
    2,
    "an unreadable --files-file is a caller error",
  );
  assert.equal(
    run(["--repo", R0, "--diff-file", path.join(TMP, "no-such-diff"), "src/a.ts"]).rc,
    2,
    "an unreadable --diff-file is a caller error",
  );
});

// ── The main fixture repo ─────────────────────────────────────────────
//
// One exported function, one exported arrow const, one short-named export, one
// shell library, and four distinct import spellings pointed at them.

const R = path.join(TMP, "main");
const A_TS = `// a comment on the first line
export function doThing() {
  return 1
}
export const arrowThing = () => {
  return 2
}
export const id = 7
`;
const restoreA = (): void => {
  git(R, "checkout", "-q", "--", "src/a.ts");
};
const pack = (...args: string[]): string => run(["--repo", R, ...args]).out;

test("the main fixture repo", () => {
  newRepo("main");
  put(R, "src/a.ts", A_TS);
  put(R, "src/named-import.ts", "import { doThing } from './a'\nexport function useNamed() {\n  return doThing()\n}\n");
  put(R, "src/reexport.ts", "export { arrowThing } from './a'\n");
  put(R, "other/js-specifier.ts", "import { doThing } from '../src/a.js'\nexport const viaJs = doThing\n");
  put(R, "other/aliased.ts", "import { doThing } from '@app/a'\nexport const viaAlias = doThing\n");
  put(R, "lib.sh", "#!/usr/bin/env bash\nhelper_fn() {\n  echo hi\n}\n");
  put(R, "user.sh", "#!/usr/bin/env bash\nsource ./lib.sh\nhelper_fn\n");
  git(R, "add", "src", "other", "lib.sh", "user.sh");
  git(R, "commit", "-qm", "init");
});

// ── 2 + 3. A body-line change names the enclosing symbol ──────────────

test("2 + 3. a body-line change names the enclosing symbol", () => {
  edit(path.join(R, "src/a.ts"), "  return 1", "  return 11");
  let out = pack("--diff-file", diffTo(R, "fn-body.diff"), "src/a.ts");
  has(out, "doThing — callers:", "a function body change names the function");
  has(out, "src/named-import.ts", "the function's caller is listed");
  lacks(out, "arrowThing — callers", "an untouched sibling symbol is not named");
  restoreA();

  // `export const foo = () => {` is the shape a regex walk-up gets wrong: it sees
  // `const`, not a function, and names the previous declaration instead.
  edit(path.join(R, "src/a.ts"), "  return 2", "  return 22");
  out = pack("--diff-file", diffTo(R, "arrow-body.diff"), "src/a.ts");
  has(out, "arrowThing — callers:", "an export-const-arrow body change names the const");
  lacks(out, "doThing — callers", "and does not name the function above it");
  restoreA();
});

// ── 4. A comment-only diff has no symbols, but still has a graph ──────

test("4. a comment-only diff has no symbols, but still has a graph", () => {
  edit(path.join(R, "src/a.ts"), "// a comment on the first line", "// a comment on the first line, reworded");
  const out = pack("--diff-file", diffTo(R, "comment.diff"), "src/a.ts");
  lacks(out, "changed symbols:", "a comment-only diff names no symbols");
  has(out, "imported-by:", "a comment-only diff still prints the import graph");
  restoreA();
});

// ── 5, 7 + 8. Short identifiers; the import graph ─────────────────────

test("5, 7 + 8. identifiers under 4 characters; the import graph; the records", () => {
  let out = pack("src/a.ts");
  has(out, "doThing", "with no diff every export is a changed symbol");
  has(out, "arrowThing", "with no diff the arrow const is one too");
  lacks(out, "    id —", "a 2-character identifier is skipped");

  has(out, "src/named-import.ts", "a bare relative import is an importer");
  has(out, "src/reexport.ts", "an export-from is an importer");
  has(out, "other/js-specifier.ts", "a .js specifier matches the .ts source");
  // `sed -n '/^  imported-by:/,/^  [a-z]/p'`: from the heading to the next section heading.
  const lines = out.split("\n");
  const start = lines.indexOf("  imported-by:");
  let end = lines.findIndex((l, i) => i > start && /^ {2}[a-z]/.test(l));
  if (end === -1) end = lines.length - 1;
  const importedByBlock = lines.slice(start, end + 1).join("\n");
  lacks(importedByBlock, "other/aliased.ts", "a tsconfig alias is NOT resolved as an importer");
  has(out, "other/aliased.ts", "the alias file is still found by the caller grep");

  let shOut = pack("lib.sh");
  has(shOut, "user.sh", "a sourced shell library names its sourcer");
  has(shOut, "helper_fn — callers:", "a shell function's callers are listed");

  // A journal entry that quotes a symbol or a `source` line is prose about the
  // change, not a caller of it.
  put(
    R,
    "journal/2026-01-01/0900-x.md",
    "Renamed doThing() and re-read `source ./lib.sh` in user.sh; helper_fn stays.\n",
  );
  git(R, "add", "journal");
  git(R, "commit", "-qm", "journal");
  out = pack("--diff-file", path.join(TMP, "fn-body.diff"), "src/a.ts");
  has(out, "src/named-import.ts", "the code caller is still listed beside the journal");
  lacks(out, "journal/2026-01-01/0900-x.md", "a journal entry naming the symbol is not a caller");
  shOut = pack("lib.sh");
  lacks(shOut, "journal/2026-01-01/0900-x.md", "a journal entry quoting a source line is not an importer");
  has(shOut, "user.sh", "and the real sourcer is still listed");

  // imports-of runs the same resolution in the other direction, and excludes the
  // files the reviewer is already being shown.
  const impOut = pack("src/named-import.ts");
  has(impOut, "imports (not in this change):", "a file's own imports are listed");
  has(impOut, "src/a.ts", "and name the resolved target");
  lacks(
    pack("src/named-import.ts", "src/a.ts"),
    "imports (not in this change):",
    "an import already in the change list is omitted",
  );
});

// ── A sourced shell specifier resolves to exactly what bash reads ─────
//
// `source x` / `. x` reads the file `x` and nothing else: bash never
// substitutes `x.ts` for a missing `x.sh`, nor `x.sh` for an extensionless `x`.
// The pack names the literal target, and a target that is not on disk is
// shown as missing rather than silently dropped or swapped for a neighbour.

test("a sourced shell specifier resolves to its literal target, and a missing one is shown", () => {
  const S = newRepo("sh-resolve");
  put(S, "both.ts", "export const x = 1\n");
  put(S, "both.sh", "x=1\n");
  put(S, "only-ts.ts", "export const y = 1\n");
  put(S, "only-sh.sh", "y=1\n");
  put(S, "lib", "z=1\n");
  put(S, "bare.sh", "#!/usr/bin/env bash\n. ./lib\n. ./only-sh\n");
  put(S, "named.sh", "#!/usr/bin/env bash\nsource ./both.sh\nsource ./only-ts.sh\n");
  git(S, "add", ".");
  git(S, "commit", "-qm", "init");
  const bare = run(["--repo", S, "bare.sh"]).out;
  has(bare, "    lib\n", "an extensionless target that exists resolves to itself");
  lacks(bare, "    only-sh.sh", "an extensionless stem is not completed to a .sh bash would never read");
  has(bare, "  sources missing:\n    only-sh", "and the stem it names is shown as missing");
  const named = run(["--repo", S, "named.sh"]).out;
  has(named, "    both.sh", "a specifier that spells .sh resolves to that .sh");
  lacks(named, "    both.ts", "and not to the .ts beside it");
  lacks(named, "    only-ts.ts", "a missing .sh is never swapped for the .ts of its stem");
  has(named, "  sources missing:\n    only-ts.sh", "the missing .sh is shown as missing");
});

// ── 7. A deleted file in the list is skipped, the rest are packed ─────

test("7. a deleted file in the list is skipped, the rest are packed", () => {
  rmSync(path.join(R, "src/reexport.ts"));
  const out = pack("src/reexport.ts", "src/a.ts");
  assert.equal(out.split("\n").filter((l) => l === "src/reexport.ts").length, 0, "a deleted file gets no section");
  has(out, "src/a.ts", "its live neighbour is still packed");
  assert.equal(run(["--repo", R, "src/reexport.ts"]).rc, 0, "a list of only deleted files exits 0");
  assert.equal(pack("src/reexport.ts"), "", "and prints nothing");
  git(R, "checkout", "-q", "--", "src/reexport.ts");
});

// ── 9. Uncommitted and untracked files are packed ─────────────────────

test("9. uncommitted and untracked files are packed", () => {
  appendFileSync(path.join(R, "src/a.ts"), "export function uncommittedFn() {\n  return 3\n}\n");
  put(R, "src/untracked-caller.ts", "import { uncommittedFn } from './a'\nexport const viaUntracked = uncommittedFn\n");
  let out = pack("src/a.ts");
  has(out, "uncommittedFn", "an uncommitted export is packed");
  has(out, "src/untracked-caller.ts", "an untracked caller is found");

  const r = run(["--repo", R, "src/untracked-caller.ts"]);
  assert.equal(r.rc, 0, "an untracked file can itself be packed");
  has(r.out, "src/a.ts", "and its import resolves");

  restoreA();
  rmSync(path.join(R, "src/untracked-caller.ts"), { force: true });

  // A gitignored file is not in the population — it is not in the diff either, so
  // citing it would point the reviewer at bytes it was never shown.
  put(R, ".gitignore", "build/\n");
  put(R, "build/generated.ts", "import { doThing } from '../src/a'\nexport const built = doThing\n");
  out = pack("src/a.ts");
  lacks(out, "build/generated.ts", "a gitignored file is not in the search population");
  rmSync(path.join(R, "build"), { recursive: true, force: true });
  rmSync(path.join(R, ".gitignore"), { force: true });
});

// ── 14. A deletion-only hunk of an export still lists callers ─────────

test("14. a deletion-only hunk of an export still lists callers", () => {
  const D = newRepo("deletion");
  const API = "export function survivor() {\n  return 1\n}\nexport function departed() {\n  return 2\n}\n";
  put(D, "src/api.ts", API);
  put(D, "src/consumer.ts", "import { survivor, departed } from './api'\nexport const both = [survivor, departed]\n");
  git(D, "add", "src");
  git(D, "commit", "-qm", "init");

  // The whole export goes; the hunk has `-` lines and no `+` lines at all, so the
  // new side has nothing to point at. The old-side parse is the only way its
  // callers reach the reviewer.
  writeFileSync(path.join(D, "src/api.ts"), API.replace("export function departed() {\n  return 2\n}\n", ""));
  let out = run(["--repo", D, "--diff-file", diffTo(D, "deleted-export.diff"), "src/api.ts"]).out;
  has(out, "departed — callers:", "a deleted export is named from the old side");
  has(out, "src/consumer.ts", "and its caller is listed");
  lacks(out, "survivor — callers", "the surviving sibling is not named");
  git(D, "checkout", "-q", "--", "src/api.ts");

  // A deletion-only hunk INSIDE a surviving export names that export.
  writeFileSync(
    path.join(D, "src/api.ts"),
    API.replace("export function survivor() {\n  return 1\n}", "export function survivor() {\n}"),
  );
  out = run(["--repo", D, "--diff-file", diffTo(D, "body-deletion.diff"), "src/api.ts"]).out;
  has(out, "survivor — callers:", "a deletion inside a body names the enclosing export");
  git(D, "checkout", "-q", "--", "src/api.ts");
});

// ── 14. Parser present vs. parser absent ──────────────────────────────
//
// BLAST_RADIUS_PARSER_ROOTS="" removes every root the symbol parser looks under,
// so the import genuinely fails to resolve and the REAL fallback path runs —
// not a flag that simulates one.

test("14. parser present vs. parser absent", (t) => {
  edit(path.join(R, "src/a.ts"), "  return 2", "  return 22");
  const diff = diffTo(R, "arrow-body.diff");
  const withParser = run(["--repo", R, "--diff-file", diff, "src/a.ts"], { BLAST_RADIUS_PARSER_ROOTS: "" });
  has(withParser.err, "falling back to regex", "a missing parser WARNs on stderr");
  has(withParser.err, "npm i -g typescript@5 web-tree-sitter tree-sitter-bash", "…and says how to install the parser");
  has(withParser.err, "looked in:", "…and where it looked");
  has(withParser.out, "imported-by:", "a missing parser still prints the import graph");
  has(withParser.out, "src/a.ts", "and still names the file");

  // The distinction the real parser buys: the regex walk-up cannot tell that
  // `export const arrowThing = () =>` owns line 6.
  if (HAVE_TS) {
    const real = run(["--repo", R, "--diff-file", diff, "src/a.ts"]);
    has(real.out, "arrowThing — callers:", "the real parser names the arrow const");
    lacks(real.err, "falling back to regex", "and loads without a fallback warning");
  } else {
    t.diagnostic(NO_TS);
  }
  restoreA();
});

// ── An `export { ... }` statement carries no export MODIFIER ──────────
//
// A barrel file is nothing but these, so a parser that only looks for the
// `export` keyword as a modifier finds no symbols in one at all and its
// consumers never reach the reviewer. Needs the real parser.

test("an export { ... } statement carries no export modifier", { skip: HAVE_TS ? false : NO_TS }, () => {
  const B = newRepo("barrel");
  put(B, "src/impl.ts", "export function realWork() {\n  return 1\n}\nexport function otherWork() {\n  return 2\n}\n");
  put(B, "src/index.ts", "export { realWork } from './impl'\nexport { otherWork as renamedWork } from './impl'\n");
  put(
    B,
    "src/uses-barrel.ts",
    "import { realWork, renamedWork } from './index'\nexport const total = realWork() + renamedWork()\n",
  );
  git(B, "add", "src");
  git(B, "commit", "-qm", "init");

  let out = run(["--repo", B, "src/index.ts"]).out;
  has(out, "realWork", "a re-export names the exported symbol");
  has(out, "src/uses-barrel.ts", "and finds its consumer");
  // The name that travels is the one a CALLER writes, which is the alias.
  has(out, "renamedWork", "an aliased re-export names the ALIAS");
  lacks(out, "    otherWork ", "not the local name behind it");

  // A local export list, with no `from` clause.
  put(B, "src/local-list.ts", "function helperThing() {\n  return 3\n}\nexport { helperThing }\n");
  put(B, "src/uses-local.ts", "import { helperThing } from './local-list'\nexport const v = helperThing()\n");
  out = run(["--repo", B, "src/local-list.ts"]).out;
  has(out, "helperThing", "a local export list names the symbol");
  has(out, "src/uses-local.ts", "and finds its consumer");

  // A DELETED re-export, and a multiline export whose `from` clause moves: symbols
  // are ranged on the statement, not the specifier.
  put(B, "src/deletable.ts", "export { realWork } from './impl'\nexport { otherWork } from './impl'\n");
  put(B, "src/uses-deletable.ts", "import { otherWork } from './deletable'\nexport const d = otherWork()\n");
  git(B, "add", "src");
  git(B, "commit", "-qm", "barrel-two");

  writeFileSync(path.join(B, "src/deletable.ts"), "export { realWork } from './impl'\n");
  out = run(["--repo", B, "--diff-file", diffTo(B, "deleted-reexport.diff"), "src/deletable.ts"]).out;
  has(out, "otherWork — callers:", "a DELETED re-export is still named");
  has(out, "src/uses-deletable.ts", "and its consumer is listed");
  git(B, "checkout", "-q", "--", "src/deletable.ts");

  put(B, "src/multiline.ts", "export {\n  realWork,\n  otherWork,\n} from './impl'\n");
  put(B, "src/uses-multiline.ts", "import { realWork } from './multiline'\nexport const m = realWork()\n");
  git(B, "add", "src");
  git(B, "commit", "-qm", "barrel-multiline");

  // Only the `from` clause moves — a line that sits inside NO specifier.
  writeFileSync(path.join(B, "src/impl-moved.ts"), readFileSync(path.join(B, "src/impl.ts")));
  edit(path.join(B, "src/multiline.ts"), "} from './impl'", "} from './impl-moved'");
  out = run(["--repo", B, "--diff-file", diffTo(B, "from-clause.diff"), "src/multiline.ts"]).out;
  has(out, "realWork — callers:", "a moved from-clause names the re-exported symbol");
  has(out, "src/uses-multiline.ts", "and its consumer is listed");
  git(B, "checkout", "-q", "--", "src/multiline.ts");
  rmSync(path.join(B, "src/impl-moved.ts"), { force: true });
});

// ── 6. Caps ───────────────────────────────────────────────────────────

test("6. caps", () => {
  const C = newRepo("caps");
  let many = "";
  for (let i = 1; i <= 40; i++) {
    const n = String(i).padStart(2, "0");
    many += `export function widget${n}() {\n  return ${i}\n}\n`;
  }
  put(C, "src/many.ts", many);
  for (let i = 1; i <= 12; i++) {
    put(
      C,
      `src/caller${i}.ts`,
      `import { widget01 } from "../src/many"\nexport const c${String(i).padStart(2, "0")} = widget01\n`,
    );
  }
  git(C, "add", "src");
  git(C, "commit", "-qm", "init");

  let out = run(["--repo", C, "src/many.ts"]).out;
  has(out, "truncated-symbols: 8", "over the symbol cap prints truncated-symbols");
  has(out, "truncated-callers:", "over the caller cap prints truncated-callers");
  const lines = out.split("\n");
  assert.equal(lines.filter((l) => /^ {4}widget[0-9]+ /.test(l)).length, 32, "exactly the symbol cap is listed");
  // `grep -A 20 '^    widget01 ' | grep -cE '^      src/caller'`
  const at = lines.findIndex((l) => l.startsWith("    widget01 "));
  const worst = lines.slice(at, at + 21).filter((l) => l.startsWith("      src/caller")).length;
  assert.equal(worst, 8, "exactly the caller cap is listed for one symbol");

  const capped = run(["--repo", C, "src/many.ts"], { BLAST_RADIUS_MAX_BYTES: "900" });
  out = capped.out;
  has(out, "truncated-bytes:", "over the byte cap prints truncated-bytes");
  const bytes = Buffer.byteLength(out);
  assert.ok(bytes <= 1000, `the byte cap is enforced — got ${bytes} bytes`);
});

// ── --files-file is the same list as the arguments ────────────────────

test("--files-file is the same list as the arguments", () => {
  const list = path.join(TMP, "list.txt");
  writeFileSync(list, "src/a.ts\n\nsrc/a.ts\n");
  const out = run(["--repo", R, "--files-file", list]).out;
  assert.equal(out.split("\n").filter((l) => l === "src/a.ts").length, 1, "a repeated path is packed once");
  has(out, "doThing", "--files-file packs what it lists");
});

// ── Portability: `..` resolution needs no GNU realpath ──────────────────
// A specifier is resolved inside the program, so a `..` that climbs out of the
// repo is dropped on every host, and one that stays inside resolves.

test("a specifier climbing out of the repo is not an importer", () => {
  const E = newRepo("escape");
  put(E, "root.ts", "export function rootThing() {\n  return 1\n}\n");
  put(E, "deep/escape.ts", "import { rootThing } from '../../root'\nexport const escaped = 1\n");
  put(E, "deep/inside.ts", "import { rootThing } from '../root'\nexport const inside = rootThing\n");
  const out = run(["--repo", E, "root.ts"]).out.split("\n");
  const start = out.findIndex((l) => l === "  imported-by:");
  let end = out.findIndex((l, i) => i > start && /^ {2}[a-z]/.test(l));
  if (end === -1) end = out.length;
  const imp = start === -1 ? "" : out.slice(start, end).join("\n");
  has(imp, "deep/inside.ts", "a specifier inside the repo resolves");
  lacks(imp, "deep/escape.ts", "a specifier climbing out of the repo does not");
});

// ── A git grep that FAILS is said, not read as "no callers" ──────────────
// The packer fails open by design, so it still exits 0 — but a pack built on a
// failed search must say so on stderr, or "no callers found" reads as a fact.

test("a git grep that fails is said, not read as no callers", () => {
  const fakegit = path.join(TMP, "fakegit");
  mkdirSync(fakegit, { recursive: true });
  const realgit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(fakegit, "git"),
    `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated $a failure" >&2; exit 128; fi
done
exec "${realgit}" "$@"
`,
  );
  chmodSync(path.join(fakegit, "git"), 0o755);
  const r = run(["--repo", R, "src/a.ts", "lib.sh"], {
    PATH: `${fakegit}:${process.env.PATH ?? ""}`,
    FAKE_GIT_FAIL: "grep",
  });
  assert.equal(r.rc, 0, "a failed git grep still fails open (exit 0)");
  has(r.err, "git grep failed", "…and says the search failed");
});

// The harnesses reach every skill script through a symlink (a home skills link
// into the workbench), and an entry guard comparing the invoked path with the
// resolved module path would skip main() there, exiting 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(path.join(TMP, "symlink-"));
  const link = path.join(dir, "blast-radius.ts");
  symlinkSync(PACK, link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...["--no-such-flag"]], {
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /unknown flag: --no-such-flag/);
});
