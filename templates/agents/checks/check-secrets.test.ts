// Rows for check-secrets.ts: a staged private key, cloud key id or hard-coded
// token is refused; clean changes pass; --since reads what the branch changed,
// committed or not, and untracked files too. Fixtures are throwaway git repos,
// and the secrets are assembled at run time so this file holds none.
//
// Run: node --test --experimental-strip-types .agents/checks/check-secrets.test.ts

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const SUT = join(import.meta.dirname, "check-secrets.ts");
const TMP = mkdtempSync(join(tmpdir(), "check-secrets-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const KEY = "-----BEGIN RSA " + "PRIVATE KEY-----";
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const TOK = `api_key = "${"x".repeat(30)}"`;

let n = 0;
function g(r: string, ...args: string[]): void {
  const p = spawnSync("git", ["-C", r, ...args], { encoding: "utf8" });
  assert.equal(p.status, 0, `git ${args.join(" ")}: ${p.stderr}`);
}
function newrepo(): string {
  n++;
  const r = join(TMP, `r${n}`);
  mkdirSync(r, { recursive: true });
  g(r, "init", "-q");
  g(r, "symbolic-ref", "HEAD", "refs/heads/main");
  g(r, "config", "user.email", "t@example.com");
  g(r, "config", "user.name", "t");
  writeFileSync(join(r, "seed"), "seed\n");
  g(r, "add", "-A");
  g(r, "commit", "-q", "-m", "seed");
  return r;
}
function run(r: string, ...args: string[]): { rc: number | null; err: string } {
  const p = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT, ...args], {
    cwd: r,
    encoding: "utf8",
  });
  return { rc: p.status, err: p.stderr };
}
function rcIs(name: string, got: { rc: number | null; err: string }, want: number): void {
  assert.equal(got.rc, want, `${name} — want rc ${want}, got ${got.rc}: ${got.err}`);
}

test("nothing staged, then a clean staged change", () => {
  const r = newrepo();
  rcIs("nothing staged", run(r), 0);
  writeFileSync(join(r, "a"), "plain text\n");
  g(r, "add", "a");
  rcIs("a clean staged change", run(r), 0);
});

for (const s of [KEY, AWS, TOK]) {
  test(`a staged secret (${s.slice(0, 12)}…) is refused`, () => {
    const r = newrepo();
    writeFileSync(join(r, "a"), `${s}\n`);
    g(r, "add", "a");
    rcIs(`a staged secret (${s.slice(0, 12)}…)`, run(r), 1);
  });
}

test("an unstaged secret is not the staged diff's; --since reads untracked files", () => {
  const r = newrepo();
  writeFileSync(join(r, "a"), `${KEY}\n`);
  rcIs("an unstaged secret is not the staged diff's", run(r), 0);
  rcIs("--since reads untracked files too", run(r, "--since", "HEAD"), 1);
});

test("--since reads a secret already committed on the branch; no ref is a caller error", () => {
  const r = newrepo();
  g(r, "checkout", "-q", "-b", "work");
  writeFileSync(join(r, "b"), `${AWS}\n`);
  g(r, "add", "b");
  g(r, "commit", "-q", "-m", "b");
  rcIs("--since reads a secret already committed on the branch", run(r, "--since", "main"), 1);
  rcIs("--since with no ref is a caller error", run(r, "--since"), 2);
});

// Only what the change ADDS is scanned: removing a leaked key must pass the gate
// that exists to get it out, and an untouched line beside an edit is context.
test("removing a committed key passes", () => {
  const r = newrepo();
  writeFileSync(join(r, "a"), `${KEY}\n`);
  g(r, "add", "a");
  g(r, "commit", "-q", "-m", "leak");
  writeFileSync(join(r, "a"), "");
  g(r, "add", "a");
  rcIs("removing a committed key passes", run(r), 0);
});

test("a key that is only context beside an edit is not the change's", () => {
  const r = newrepo();
  writeFileSync(join(r, "a"), `${AWS}\n`);
  g(r, "add", "a");
  g(r, "commit", "-q", "-m", "leak");
  appendFileSync(join(r, "a"), "one more line\n");
  g(r, "add", "a");
  rcIs("a key that is only context beside an edit is not the change's", run(r), 0);
});

test("--since: a removal alone passes", () => {
  const r = newrepo();
  writeFileSync(join(r, "seed"), `${KEY}\n`);
  g(r, "commit", "-q", "-am", "leak");
  g(r, "checkout", "-q", "-b", "work");
  writeFileSync(join(r, "seed"), "");
  g(r, "add", "seed");
  g(r, "commit", "-q", "-m", "clear");
  rcIs("--since: a removal alone passes", run(r, "--since", "main"), 0);
});

// A diff that cannot be read is not a clean diff.
test("an unreadable staged diff is an error, not a pass", () => {
  const r = newrepo();
  writeFileSync(join(r, "a"), "x\n");
  g(r, "add", "a");
  writeFileSync(join(r, ".git", "index"), "garbage\n");
  rcIs("an unreadable staged diff is an error, not a pass", run(r), 2);
});

test("…and so under --since", () => {
  const r = newrepo();
  writeFileSync(join(r, ".git", "index"), "garbage\n");
  rcIs("…and so under --since", run(r, "--since", "HEAD"), 2);
});

test("outside a git repository there is nothing to scan", () => {
  const d = join(TMP, "not-a-repo");
  mkdirSync(d, { recursive: true });
  const p = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT], {
    cwd: d,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP },
  });
  assert.equal(p.status, 0, p.stderr);
});
