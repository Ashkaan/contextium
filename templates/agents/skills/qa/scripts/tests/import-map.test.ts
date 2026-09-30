#!/usr/bin/env -S node --experimental-strip-types
// import-map.test.ts — the reverse-import map qa-targets.ts walks, against a
// hermetic temp repo. qa-targets.test.ts proves the walk end to end; this proves
// each resolution rule import-map.ts's header states, one edge at a time.
// `importEdges` is imported (qa-targets.ts imports it); the program's printed
// lines and its exit 2 are pinned by spawning it.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/import-map.test.ts
//
// peers:
//   .agents/skills/qa/scripts/import-map.ts
//   .agents/skills/qa/scripts/qa-targets.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { importEdges } from "../import-map.ts";

const MAP = join(dirname(fileURLToPath(import.meta.url)), "..", "import-map.ts");
const TMP = mkdtempSync(join(tmpdir(), "import-map-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const R = join(TMP, "repo");
const git = (...args: string[]): void => {
  execFileSync("git", ["-C", R, ...args], { stdio: "ignore" });
};
const put = (rel: string, body: string): void => {
  mkdirSync(dirname(join(R, rel)), { recursive: true });
  writeFileSync(join(R, rel), body);
};
mkdirSync(R);
git("init", "-q", ".");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
put("packages/ui/button.ts", "export const b = 1\n");
put("packages/ui/index.ts", 'export { b } from "./button"\nimport "./index"\n');
put(
  "apps/web/src/page.ts",
  [
    'import { b } from "../../../packages/ui/button.ts"',
    'import x from "zod"',
    'import y from "/abs/path"',
    'import z from "../../../../outside"',
    'import "./styles.css"',
    'const m = await import("../../../packages/ui/index")',
    '// the prose says "from the import" here',
    'import c from "./card"',
    "",
  ].join("\n"),
);
put(".gitignore", "ignored/\n");
put("ignored/x.ts", 'import { b } from "../packages/ui/button"\n');
git("add", "-A");
git("commit", "-qm", "base");
put("apps/web/src/untracked.ts", 'import { b } from "../../../packages/ui/button"\n');
put("packages/notes.md", 'import { b } from "../packages/ui/button"\n');

const OUT = importEdges(R)
  .map(([target, importer]) => `${target}\t${importer}`)
  .join("\n");
const has = (edge: string): void => assert.ok(OUT.split("\n").includes(edge), `missing edge '${edge}' in:\n${OUT}`);
const lacks = (needle: string): void => assert.ok(!OUT.includes(needle), `unexpected '${needle}' in:\n${OUT}`);

test("the program prints the same edges, exit 0 on a readable repo", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", MAP, R], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${OUT}\n`);
});

test("a relative import, its code extension dropped", () => has("packages/ui/button\tapps/web/src/page.ts"));
test("a sibling re-export", () => has("packages/ui/button\tpackages/ui/index.ts"));
test("a dynamic import()", () => has("packages/ui/index\tapps/web/src/page.ts"));
test("a bare spec resolves against the repo root", () => has("zod\tapps/web/src/page.ts"));
test("a .css import keeps its extension", () => has("apps/web/src/styles.css\tapps/web/src/page.ts"));
test("an untracked importer counts", () => has("packages/ui/button\tapps/web/src/untracked.ts"));
test("an import after a quoted 'from' in a comment", () => has("apps/web/src/card\tapps/web/src/page.ts"));
test("an absolute spec is skipped", () => lacks("abs/path"));
test("a spec outside the repo is skipped", () => lacks("outside"));
test("a gitignored file is not an importer", () => lacks("ignored/x.ts"));
test("a non-source file is not an importer", () => lacks("notes.md"));
test("a self-import is not an edge", () => lacks("packages/ui/index\tpackages/ui/index.ts"));
test("the comment's prose is not an import", () => lacks("from the import"));

test("a directory git cannot list throws, and the program exits 2 naming it", () => {
  mkdirSync(join(TMP, "not-a-repo"));
  assert.throws(() => importEdges(join(TMP, "not-a-repo")), /could not list/);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", MAP, join(TMP, "not-a-repo")], {
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not list/);
});

test("no argument → exit 2", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", MAP], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

// Finding 1 of the R45 review: the harnesses reach every skill script through a
// symlink (~/.agents/skills -> workbench/skills), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "import-map.ts");
  symlinkSync(MAP, link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...[join(dir, "missing")]], {
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /import-map: could not list/);
});
