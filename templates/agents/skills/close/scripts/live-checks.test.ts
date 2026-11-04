// live-checks.test.ts — peer of live-checks.ts, run as a program: the form's
// parser and what the reader calls live.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/live-checks.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// No reader can tell on an origin GitHub does not host: what is live is
// "cannot tell" (sourceCommit null), never the trunk, which a deploy may still
// be building or may have failed to ship.
test("an origin not on GitHub: cannot tell which commit is live, never the trunk", () => {
  const { repo } = checkout(2);
  const r = sut(["revision", "workbench", repo]);
  assert.equal(r.rc, 0, r.err);
  const rev = JSON.parse(r.out) as { deploymentId: string; sourceCommit: string | null };
  assert.equal(rev.sourceCommit, null);
  assert.match(rev.deploymentId, /^none — .*not on GitHub/);
  assert.equal(sut(["revision", "workbench"]).rc, 2, "no repo dir is a usage error");
});

test("the seam: a named target is answered from the file, an unnamed one read for real", () => {
  const { repo } = checkout(1);
  const dep = JSON.parse(sut(["revision", "workbench", repo], stub({ workbench: { id: "7", sha: A } })).out);
  assert.deepEqual(dep, { deploymentId: "deployment 7", sourceCommit: A });
  const none = JSON.parse(sut(["revision", "workbench", repo], stub({ workbench: null })).out);
  assert.equal(none.sourceCommit, null, "none recorded: cannot tell");
  const real = JSON.parse(sut(["revision", "workbench", repo], stub({ "repo:acme/site": { id: "7", sha: A } })).out);
  assert.match(real.deploymentId, /not on GitHub/, "an unnamed target is read for real");
  for (const v of ["", "<html>", { id: "7", sha: "<html>" }]) {
    const r = sut(["revision", "workbench", repo], stub({ workbench: v }));
    assert.equal(r.rc, 1, `workbench ${JSON.stringify(v)}`);
    assert.equal(r.out, "");
  }
  const t = sut(["revision", "workbench", repo], stub({ workbench: { throw: "gh 503" } }));
  assert.equal(t.rc, 1);
  assert.match(t.err, /live-checks: gh 503/);
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

// ── A recorded deployment is what is live ─────────────────────────────────
// When GitHub records production deployments for the repo, the one whose
// latest status is success and came last is what serves: a push still
// building, or one whose deploy failed, does not count, and a capture taken
// before a deploy lands names the old deployment, which a release after it
// refuses.

/** A gh on PATH that answers the deployments API from <answers> (exact path →
 *  JSON), wrapping it in ANSI when colour is forced, as the real gh does. */
function ghStub(answers: Record<string, unknown>): Record<string, string> {
  const bin = mkdtempSync(join(tmp, "ghbin-"));
  const file = join(bin, "answers.json");
  writeFileSync(file, JSON.stringify(answers));
  const script = join(bin, "gh");
  writeFileSync(
    script,
    `#!/usr/bin/env node\nconst a = require(${JSON.stringify(file)});\nconst p = process.argv[3] ?? "";\nif (!(p in a)) { process.stderr.write("gh: stub has no " + p + "\\n"); process.exit(1); }\nconst body = JSON.stringify(a[p]);\nconst c = process.env.FORCE_COLOR || process.env.CLICOLOR_FORCE;\nprocess.stdout.write(c ? "\\u001b[1;37m" + body + "\\u001b[m" : body);\n`,
  );
  chmodSync(script, 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}
const DEPS = "repos/acme/site/deployments?per_page=100&page=";
const statuses = (id: number) => `repos/acme/site/deployments/${id}/statuses?per_page=1`;
const onGithub = (): string => {
  const { repo } = checkout(1);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "git@github.com:acme/site.git"]);
  return repo;
};
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);

test("a GitHub origin: the newest successful production deployment, past one building and a newer preview", () => {
  const env = ghStub({
    [`${DEPS}1`]: [
      { id: 13, sha: E, environment: "Preview" },
      { id: 12, sha: D, environment: "Production" },
      { id: 11, sha: C, environment: "production" },
    ],
    [statuses(13)]: [{ state: "success", created_at: "2026-11-01T00:00:00Z" }],
    [statuses(12)]: [{ state: "in_progress" }],
    [statuses(11)]: [{ state: "success", created_at: "2026-11-01T00:00:00Z" }],
  });
  const r = sut(["revision", "workbench", onGithub()], env);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { deploymentId: "deployment 11", sourceCommit: C });
});

test("a success on the second page of history is found; forced colour does not break the read", () => {
  const failed = Array.from({ length: 100 }, (_, i) => ({ id: 200 - i, sha: D, production_environment: true }));
  const answers: Record<string, unknown> = { [`${DEPS}1`]: failed, [`${DEPS}2`]: [{ id: 50, sha: C, environment: "github-pages" }] };
  for (const d of failed) answers[statuses(d.id)] = [{ state: "failure" }];
  answers[statuses(50)] = [{ state: "success", created_at: "2026-11-01T00:00:00Z" }];
  const env = { ...ghStub(answers), FORCE_COLOR: "1", CLICOLOR_FORCE: "1" };
  const r = sut(["revision", "workbench", onGithub()], env);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { deploymentId: "deployment 50", sourceCommit: C });
});

// A deploy that completed and failed is not live: its latest status is
// failure, and an older success is what still serves; with no success at all,
// nothing can be named.
test("a failed latest status is not counted: an older success serves, and with none it cannot tell", () => {
  const failedNewest = ghStub({
    [`${DEPS}1`]: [
      { id: 12, sha: D, environment: "production" },
      { id: 11, sha: C, environment: "production" },
    ],
    [statuses(12)]: [{ state: "failure", created_at: "2026-11-02T00:00:00Z" }],
    [statuses(11)]: [{ state: "success", created_at: "2026-11-01T00:00:00Z" }],
  });
  const r = sut(["revision", "workbench", onGithub()], failedNewest);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { deploymentId: "deployment 11", sourceCommit: C });
  const noneOk = ghStub({
    [`${DEPS}1`]: [
      { id: 12, sha: D, environment: "production" },
      { id: 11, sha: C, environment: "production" },
    ],
    [statuses(12)]: [{ state: "error", created_at: "2026-11-02T00:00:00Z" }],
    [statuses(11)]: [],
  });
  const n = sut(["revision", "workbench", onGithub()], noneOk);
  assert.equal(n.rc, 0, n.err);
  const rev = JSON.parse(n.out) as { deploymentId: string; sourceCommit: string | null };
  assert.equal(rev.sourceCommit, null);
  assert.match(rev.deploymentId, /no production deployment whose latest status is success/);
});

test("no deployments, or only previews: cannot tell; a malformed status is a failure", () => {
  const repo = onGithub();
  for (const answers of [
    { [`${DEPS}1`]: [] },
    { [`${DEPS}1`]: [{ id: 9, sha: D, environment: "Preview" }], [statuses(9)]: [{ state: "success", created_at: "2026-11-01T00:00:00Z" }] },
  ]) {
    const r = sut(["revision", "workbench", repo], ghStub(answers));
    assert.equal(r.rc, 0, r.err);
    assert.equal(JSON.parse(r.out).sourceCommit, null);
  }
  const bad = ghStub({ [`${DEPS}1`]: [{ id: 9, sha: D, environment: "production" }], [statuses(9)]: [{ status: "ok" }] });
  const m = sut(["revision", "workbench", repo], bad);
  assert.equal(m.rc, 1);
  assert.match(m.err, /a malformed status/);
});

test("a GitHub origin whose deployments cannot be read, or with no gh, is a failure, never 'cannot tell'", () => {
  const repo = onGithub();
  const r = sut(["revision", "workbench", repo], ghStub({}));
  assert.equal(r.rc, 1);
  assert.match(r.err, /deployments/);
  // A PATH holding git and nothing else: no gh to find.
  const nogh = mkdtempSync(join(tmp, "nogh-"));
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(nogh, "git"), `#!/bin/sh\nexec ${realGit} "$@"\n`);
  chmodSync(join(nogh, "git"), 0o755);
  const n = sut(["revision", "workbench", repo], { PATH: nogh });
  assert.equal(n.rc, 1);
  assert.match(n.err, /needs the gh CLI/);
});

/** An ssh on PATH whose -G answers <hosts> (alias → real host name), as
 *  ~/.ssh/config would; any other host resolves to itself; "fail" fails. */
function sshStub(hosts: Record<string, string>): string {
  const bin = mkdtempSync(join(tmp, "sshbin-"));
  const cases = Object.entries(hosts)
    .map(([alias, real]) => (real === "fail" ? alias + ") exit 255 ;;" : alias + ') echo "hostname ' + real + '" ;;'))
    .join("\n");
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\n[ "$1" = -G ] || exit 255\ncase "$2" in\n' + cases + '\n*) echo "hostname $2" ;;\nesac\n');
  chmodSync(join(bin, "ssh"), 0o755);
  return bin;
}
const DEPLOYED = {
  [DEPS + "1"]: [{ id: 11, sha: C, environment: "production" }],
  [statuses(11)]: [{ state: "success", created_at: "2026-11-01T00:00:00Z" }],
};

test("an SSH host alias for github.com is read as GitHub, the way land.ts reads it", () => {
  const { repo } = checkout(1);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "git@github-work:acme/site.git"]);
  const env = ghStub(DEPLOYED);
  env.PATH = sshStub({ "github-work": "github.com" }) + ":" + env.PATH;
  const r = sut(["revision", "workbench", repo], env);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { deploymentId: "deployment 11", sourceCommit: C });
});

test("the configured origin decides, not the URL an insteadOf rewrite reaches it by", () => {
  const { repo } = checkout(1);
  const reach = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", repo, "config", "url." + reach + ".insteadOf", "https://github.com/acme/site.git"]);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "https://github.com/acme/site.git"]);
  const r = sut(["revision", "workbench", repo], ghStub(DEPLOYED));
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { deploymentId: "deployment 11", sourceCommit: C });
});

test("an alias for another host is not GitHub: cannot tell, and gh is never asked", () => {
  const { repo } = checkout(1);
  const reach = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", repo, "config", "url." + reach + ".insteadOf", "git@gitlab-work:acme/site.git"]);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "git@gitlab-work:acme/site.git"]);
  const env = ghStub({});
  env.PATH = sshStub({ "gitlab-work": "gitlab.com" }) + ":" + env.PATH;
  const r = sut(["revision", "workbench", repo], env);
  assert.equal(r.rc, 0, r.err);
  assert.equal(JSON.parse(r.out).sourceCommit, null);
});

test("an SSH alias ssh cannot resolve is a failure, never 'cannot tell'", () => {
  const { repo } = checkout(1);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "git@broken-alias:acme/site.git"]);
  const env = ghStub(DEPLOYED);
  env.PATH = sshStub({ "broken-alias": "fail" }) + ":" + env.PATH;
  const r = sut(["revision", "workbench", repo], env);
  assert.equal(r.rc, 1, r.out);
  assert.match(r.err, /could not resolve broken-alias/);
});

// The whole history is read or none of it counts: a production deployment
// older than the read limit may be what serves, so a success inside the limit
// is no answer while more history lies past it.
test("a history longer than the read limit is refused, even with a success inside it", () => {
  const answers: Record<string, unknown> = {};
  for (let page = 1; page <= 10; page++)
    answers[`${DEPS}${page}`] = Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, sha: D, environment: "Preview" }));
  (answers[`${DEPS}1`] as unknown[])[0] = { id: 1000, sha: C, environment: "production" };
  answers[statuses(1000)] = [{ state: "success", created_at: "2026-11-01T00:00:00Z" }];
  answers[`${DEPS}11`] = [{ id: 1, sha: E, environment: "production" }];
  const r = sut(["revision", "workbench", onGithub()], ghStub(answers));
  assert.equal(r.rc, 1, r.out);
  assert.match(r.err, /more than 1000 deployments/);
  answers[`${DEPS}11`] = [];
  const exact = sut(["revision", "workbench", onGithub()], ghStub(answers));
  assert.equal(exact.rc, 0, exact.err);
  assert.deepEqual(JSON.parse(exact.out), { deploymentId: "deployment 1000", sourceCommit: C }, "exactly the limit is the whole history");
});

// GitHub marks earlier successes inactive only outside production
// (auto_inactive, "Create a deployment status"), so several production
// deployments can all read success. The one serving is the one whose success
// came last: putting an older deployment back (a rollback) gives it the newest
// success, and the newer deployment it replaced is no longer what serves
// (Contextium v9.2.0 review).
test("a rollback to an older production deployment is what is live, not the newer one it replaced", () => {
  const env = ghStub({
    [`${DEPS}1`]: [
      { id: 12, sha: D, environment: "production" },
      { id: 11, sha: C, environment: "production" },
    ],
    [statuses(12)]: [{ state: "success", created_at: "2026-11-01T10:00:00Z" }],
    [statuses(11)]: [{ state: "success", created_at: "2026-11-02T10:00:00Z" }],
  });
  const r = sut(["revision", "workbench", onGithub()], env);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { deploymentId: "deployment 11", sourceCommit: C });
  const inactive = ghStub({
    [`${DEPS}1`]: [
      { id: 12, sha: D, environment: "production" },
      { id: 11, sha: C, environment: "production" },
    ],
    [statuses(12)]: [{ state: "inactive", created_at: "2026-11-02T10:00:00Z" }],
    [statuses(11)]: [{ state: "success", created_at: "2026-11-01T10:00:00Z" }],
  });
  assert.equal(JSON.parse(sut(["revision", "workbench", onGithub()], inactive).out).sourceCommit, C, "an inactive one is not live");
  const undated = ghStub({
    [`${DEPS}1`]: [{ id: 11, sha: C, environment: "production" }],
    [statuses(11)]: [{ state: "success" }],
  });
  const u = sut(["revision", "workbench", onGithub()], undated);
  assert.equal(u.rc, 1, "a success with no time cannot be ordered");
  assert.match(u.err, /a malformed status/);
});
