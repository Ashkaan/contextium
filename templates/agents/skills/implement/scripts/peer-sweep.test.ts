// Paired test for peer-sweep.ts. The subject is spawned as a program against a
// fixture repo built in a tmpdir.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/peer-sweep.test.ts
//
// peers: peer-sweep.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "peer-sweep.ts");
const TMP = mkdtempSync(join(tmpdir(), "peer-sweep-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

function makeRepo(): string {
  const d = mkdtempSync(join(TMP, `r${++n}-`));
  const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(d, "src"), { recursive: true });
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "src/a.ts"), "callOld();\nother();\n");
  writeFileSync(join(d, "src/b.ts"), "callOld(1);\n");
  writeFileSync(join(d, "docs/notes.md"), "callOld is deprecated\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return d;
}

interface Run {
  rc: number;
  out: string;
  err: string;
}
function run(repo: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    timeout: 30000,
  });
  return { rc: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test("every match is listed, with the command and the count", () => {
  const r = run(makeRepo(), "--pattern", "callOld");
  assert.equal(r.rc, 0, r.err);
  const lines = r.out.split("\n").filter((l) => l !== "");
  assert.equal(lines[0], "# git grep -nE --untracked 'callOld'");
  assert.ok(lines.includes("src/a.ts:1:callOld();"), r.out);
  assert.ok(lines.includes("src/b.ts:1:callOld(1);"), r.out);
  assert.ok(lines.includes("docs/notes.md:1:callOld is deprecated"), r.out);
  assert.equal(lines.at(-1), "MATCHES: 3");
});

test("scope and exclude narrow the sweep and show in the command", () => {
  const r = run(makeRepo(), "--pattern", "callOld", "--scope", "src", "--exclude", "src/b.ts");
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.startsWith("# git grep -nE --untracked 'callOld' -- src :^src/b.ts\n"), r.out);
  assert.ok(r.out.includes("src/a.ts:1:"), r.out);
  assert.equal(r.out.includes("src/b.ts:"), false, r.out);
  assert.equal(r.out.includes("docs/"), false, r.out);
  assert.ok(r.out.endsWith("MATCHES: 1\n"), r.out);
});

// A brand-new peer this session just created must not read as "no match".
test("an untracked file is swept", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "src/new.ts"), "callOld();\n");
  const r = run(repo, "--pattern", "callOld", "--scope", "src");
  assert.ok(r.out.includes("src/new.ts:1:callOld();"), r.out);
  assert.ok(r.out.endsWith("MATCHES: 3\n"), r.out);
});

test("zero matches is a real answer, exit 0", () => {
  const r = run(makeRepo(), "--pattern", "neverPresent");
  assert.equal(r.rc, 0, r.err);
  assert.ok(r.out.endsWith("MATCHES: 0\n"), r.out);
});

test("a scope matching no files fails loud", () => {
  const r = run(makeRepo(), "--pattern", "callOld", "--scope", "nope/*.ts");
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes("scope matches no files: nope/*.ts"), r.err);
  assert.equal(r.err.includes("globSync"), false, `glob's experimental warning leaked: ${r.err}`);
});

test("a malformed pattern exits 1", () => {
  const r = run(makeRepo(), "--pattern", "(unclosed");
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes("invalid pattern: (unclosed"), r.err);
});

test("a missing --pattern exits 1", () => {
  const r = run(makeRepo());
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes("--pattern <extended-regex> required"), r.err);
});

test("an unknown flag exits 1", () => assert.equal(run(makeRepo(), "--bogus").rc, 1));

test("a directory that is not a repo exits 1", () => {
  const d = mkdtempSync(join(TMP, "nongit-"));
  const r = run(d, "--pattern", "x");
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes("not a git repo"), r.err);
});
