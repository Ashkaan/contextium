// live-checks.test.ts — peer of live-checks.ts, run as a program: the form's
// parser and what the reader calls live.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/live-checks.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "live-checks.ts");
const tmp = mkdtempSync(join(tmpdir(), "live-checks-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Res = { rc: number | null; out: string; err: string };
function sut(args: string[], env: Record<string, string> = {}): Res {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: join(tmp, "home"), ...env },
    timeout: 30_000,
  });
  return { rc: r.status, out: r.stdout.trim(), err: r.stderr };
}

let n = 0;
function tasks(body: string): string {
  const p = join(tmp, `tasks-${++n}.md`);
  writeFileSync(p, body);
  return p;
}
const block = (...lines: string[]): string => `# Tasks\n\n\`\`\`live-checks\n${lines.join("\n")}\n\`\`\`\n`;

// ── The form ───────────────────────────────────────────────────────────────

test("a two-line block is two checks, and a command keeps its own pipes", () => {
  const r = sut([
    "parse",
    tasks(
      block(
        "home | workbench | command | curl -s https://x | grep ok",
        "shot | repo:acme/site | evidence | the hero shows the new line",
      ),
    ),
  ]);
  assert.equal(r.rc, 0, r.err);
  const { checks } = JSON.parse(r.out) as { checks: { id: string; target: string; kind: string; body: string }[] };
  assert.deepEqual(
    checks.map((c) => [c.id, c.target, c.kind, c.body]),
    [
      ["home", "workbench", "command", "curl -s https://x | grep ok"],
      ["shot", "repo:acme/site", "evidence", "the hero shows the new line"],
    ],
  );
});

test("no block owes nothing", () => {
  const r = sut(["parse", tasks("# Tasks\n\n- [ ] T001 a task\n")]);
  assert.equal(r.rc, 0);
  assert.deepEqual(JSON.parse(r.out), { checks: [], warnings: [] });
});

test("an empty block owes nothing and warns, naming its line", () => {
  const r = sut(["parse", tasks("# Tasks\n\n```live-checks\n```\n")]);
  assert.equal(r.rc, 0);
  assert.deepEqual(JSON.parse(r.out).checks, []);
  assert.match(r.err, /warning .*tasks-\d+\.md:3: an empty live-checks block/);
});

for (const [name, line, why] of [
  ["fewer than four fields", "home | workbench | command", /:4: 3 field\(s\), not four/],
  ["a blank command", "home | workbench | command |   ", /:4: a blank field/],
  ["a blank description", "shot | workbench | evidence | ", /:4: a blank field/],
  ["an id with a space", "my home | workbench | command | true", /:4: id "my home" is not/],
  ["repo: with no name", "r | repo: | command | true", /:4: target "repo:" names no <owner>\/<name>/],
  ["an unknown kind", "home | workbench | eyes | look", /:4: unknown kind "eyes"/],
  ["an unknown target", "home | staging | command | true", /:4: unknown target "staging"/],
  [
    "a pipe into grep -q",
    "home | workbench | command | curl -s https://x | grep -q ok",
    /:4: id "home" pipes into a reader that stops early/,
  ],
  [
    "a pipe into grep -qF",
    "home | workbench | command | curl -s https://x | grep -qF ok",
    /:4: id "home" pipes into a reader/,
  ],
  [
    "a negated pipe into grep -qx",
    "home | workbench | command | out=$(x) && ! printf '%s' \"$out\" | grep -qx y",
    /:4: id "home" pipes into a reader/,
  ],
  [
    "a pipe into grep -m1",
    "home | workbench | command | curl -s https://x | grep -m1 ok",
    /:4: id "home" pipes into a reader/,
  ],
  ["a pipe into head", "home | workbench | command | curl -s https://x | head -1", /:4: id "home" pipes into a reader/],
] as const) {
  test(`${name} is refused with its line number`, () => {
    const r = sut(["parse", tasks(block(line))]);
    assert.equal(r.rc, 1);
    assert.match(r.err, why);
  });
}

test("grep -q on a captured value, after ||, and an evidence line naming grep -q all pass", () => {
  const r = sut([
    "parse",
    tasks(
      block(
        'a | workbench | command | P=$(curl -fsS https://x) && grep -q ok <<<"$P"',
        'b | workbench | command | O=$(gh repo view x 2>&1) || grep -q gone <<<"$O"',
        "c | workbench | evidence | the page shows what curl | grep -q would find",
      ),
    ),
  ]);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(
    (JSON.parse(r.out) as { checks: { id: string }[] }).checks.map((c) => c.id),
    ["a", "b", "c"],
  );
});

test("a duplicate id is refused at its second line", () => {
  const r = sut(["parse", tasks(block("home | workbench | command | true", "home | workbench | command | true"))]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /:5: id "home" is declared twice/);
});

// ── What is live ───────────────────────────────────────────────────────────

function stub(answers: Record<string, unknown>): Record<string, string> {
  const p = join(tmp, `sources-${++n}.json`);
  writeFileSync(p, JSON.stringify(answers));
  return { LIVE_CHECKS_TEST_SOURCES: p };
}
const A = "a".repeat(40);

/** A checkout whose origin is a bare repo with <commits> on main. */
function checkout(commits: number): { repo: string; tips: string[] } {
  const root = mkdtempSync(join(tmp, "live-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, repo], { encoding: "utf8" });
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  const tips: string[] = [];
  for (let i = 0; i < commits; i++) {
    g(repo, "commit", "-q", "--allow-empty", "-m", `c${i}`);
    g(repo, "push", "-q", "origin", "HEAD:main");
    tips.push(g(repo, "rev-parse", "HEAD"));
  }
  g(repo, "remote", "set-head", "origin", "main");
  return { repo, tips };
}

test("workbench: the trunk as origin holds it now, not the local checkout's", () => {
  const { repo, tips } = checkout(2);
  const tip = tips[1] ?? "";
  assert.deepEqual(JSON.parse(sut(["revision", "workbench", repo]).out), { deploymentId: tip, sourceCommit: tip });
  spawnSync("git", ["-C", repo, "reset", "-q", "--hard", tips[0] ?? ""]);
  assert.equal(JSON.parse(sut(["revision", "workbench", repo]).out).sourceCommit, tip, "a local reset moves nothing live");
  const r = sut(["revision", "repo:acme/site", repo]);
  assert.equal(JSON.parse(r.out).sourceCommit, tip, "a repo: target reads its checkout the same way");
});

test("an origin with no trunk, an unreachable origin, or no repo dir is a failure, never a revision", () => {
  const { repo } = checkout(0);
  const empty = sut(["revision", "workbench", repo]);
  assert.equal(empty.rc, 1);
  assert.equal(empty.out, "");
  const gone = checkout(1).repo;
  spawnSync("git", ["-C", gone, "remote", "set-url", "origin", join(tmp, "no-such-origin.git")]);
  const r = sut(["revision", "workbench", gone]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /ls-remote origin failed/);
  assert.equal(sut(["revision", "workbench"]).rc, 2, "no repo dir is a usage error");
});

test("the seam: a named target is answered from the file, an unnamed one read for real", () => {
  const { repo, tips } = checkout(1);
  assert.equal(JSON.parse(sut(["revision", "workbench", repo], stub({ workbench: A })).out).sourceCommit, A);
  assert.equal(
    JSON.parse(sut(["revision", "workbench", repo], stub({ "repo:acme/site": A })).out).sourceCommit,
    tips[0],
  );
  for (const v of [null, "", "<html>"]) {
    const r = sut(["revision", "workbench", repo], stub({ workbench: v }));
    assert.equal(r.rc, 1, `workbench ${JSON.stringify(v)}`);
    assert.equal(r.out, "");
  }
  const t = sut(["revision", "workbench", repo], stub({ workbench: { throw: "origin 503" } }));
  assert.equal(t.rc, 1);
  assert.match(t.err, /live-checks: origin 503/);
});

test("targets: workbench and repo:<owner>/<name>; anything else is refused at parse", () => {
  for (const [line, why] of [
    ["a | portal | command | true", /unknown target "portal"/],
    ["a | worker:edge | command | true", /unknown target "worker:edge"/],
    ["a | repo:site | command | true", /names no <owner>\/<name>/],
  ] as const) {
    const r = sut(["parse", tasks(block(line))]);
    assert.equal(r.rc, 1, line);
    assert.match(r.err, why);
  }
});

test("source: the repo a repo: target names; workbench names none", () => {
  assert.equal(sut(["source", "repo:acme/site"]).out, "acme/site");
  const r = sut(["source", "workbench"]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /served by a repo the close knows already/);
});

// ── Ancestry ───────────────────────────────────────────────────────────────

test("contains: a descendant contains, an unrelated or older commit does not, an unknown one is unreadable", () => {
  const repo = join(tmp, "repo");
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }).stdout.trim();
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("commit", "-q", "--allow-empty", "-m", "one");
  const one = g("rev-parse", "HEAD");
  g("commit", "-q", "--allow-empty", "-m", "two");
  const two = g("rev-parse", "HEAD");
  g("checkout", "-q", "--orphan", "other");
  g("commit", "-q", "--allow-empty", "-m", "unrelated");
  const other = g("rev-parse", "HEAD");
  assert.equal(sut(["contains", repo, one, two]).rc, 0, "a descendant contains");
  assert.equal(sut(["contains", repo, one, one]).rc, 0, "the commit itself contains");
  assert.equal(sut(["contains", repo, two, one]).out, "not", "an older live commit does not");
  assert.equal(sut(["contains", repo, one, other]).out, "not", "an unrelated one does not");
  assert.equal(sut(["contains", repo, one, "c".repeat(40)]).out, "unreadable");
});
