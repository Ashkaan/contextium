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

// ── A recorded deployment is what is live ─────────────────────────────────
// When GitHub records deployments for the repo, the newest one whose latest
// status is success is what serves: a push still building does not count, and
// a capture taken before it deploys names the old deployment, which a release
// after it refuses. With none recorded, the trunk is what is live.

test("the seam: a recorded deployment answers ahead of the trunk", () => {
  const { repo, tips } = checkout(1);
  const B = "b".repeat(40);
  const dep = JSON.parse(sut(["revision", "workbench", repo], stub({ "workbench#deployment": { id: "7", sha: B } })).out);
  assert.deepEqual(dep, { deploymentId: "deployment 7", sourceCommit: B });
  const none = JSON.parse(sut(["revision", "workbench", repo], stub({ "workbench#deployment": null })).out);
  assert.equal(none.sourceCommit, tips[0], "no recorded deployment: the trunk is live");
});

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

test("production deployments none of which succeeded are a failure, never the trunk", () => {
  const env = ghStub({
    [`${DEPS}1`]: [
      { id: 12, sha: D, environment: "production" },
      { id: 11, sha: C, environment: "production" },
    ],
    [statuses(12)]: [{ state: "pending" }],
    [statuses(11)]: [],
  });
  const r = sut(["revision", "workbench", onGithub()], env);
  assert.equal(r.rc, 1);
  assert.match(r.err, /2 production deployment\(s\).*none succeeded/);
});

test("a history with only previews leaves the trunk live; a malformed status is a failure", () => {
  const previews = ghStub({ [`${DEPS}1`]: [{ id: 9, sha: D, environment: "Preview" }], [statuses(9)]: [{ state: "success", created_at: "2026-11-01T00:00:00Z" }] });
  const repo = onGithub();
  const p = sut(["revision", "workbench", repo], previews);
  assert.equal(p.rc, 1, "no production deployment: the trunk is read, here an unreachable GitHub origin");
  assert.match(p.err, /ls-remote origin failed/);
  const bad = ghStub({ [`${DEPS}1`]: [{ id: 9, sha: D, environment: "production" }], [statuses(9)]: [{ status: "ok" }] });
  const m = sut(["revision", "workbench", repo], bad);
  assert.equal(m.rc, 1);
  assert.match(m.err, /a malformed status/);
});

test("a GitHub origin whose deployments cannot be read, or with no gh, is a failure, never the trunk", () => {
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

test("an alias for another host is not GitHub: the trunk is live and gh is never asked", () => {
  const { repo, tips } = checkout(1);
  const reach = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", repo, "config", "url." + reach + ".insteadOf", "git@gitlab-work:acme/site.git"]);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "git@gitlab-work:acme/site.git"]);
  const env = ghStub({});
  env.PATH = sshStub({ "gitlab-work": "gitlab.com" }) + ":" + env.PATH;
  const r = sut(["revision", "workbench", repo], env);
  assert.equal(r.rc, 0, r.err);
  assert.equal(JSON.parse(r.out).sourceCommit, tips[0]);
});

test("an SSH alias ssh cannot resolve is a failure, never the trunk", () => {
  const { repo } = checkout(1);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "git@broken-alias:acme/site.git"]);
  const env = ghStub(DEPLOYED);
  env.PATH = sshStub({ "broken-alias": "fail" }) + ":" + env.PATH;
  const r = sut(["revision", "workbench", repo], env);
  assert.equal(r.rc, 1, r.out);
  assert.match(r.err, /could not resolve broken-alias/);
});

test("a history longer than the reading limit with no production success is a failure, never the trunk", () => {
  const answers: Record<string, unknown> = {};
  for (let page = 1; page <= 10; page++)
    answers[`${DEPS}${page}`] = Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, sha: D, environment: "Preview" }));
  const r = sut(["revision", "workbench", onGithub()], ghStub(answers));
  assert.equal(r.rc, 1, r.out);
  assert.match(r.err, /older deployment history is unread/);
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

// With no deployment recorded, the trunk is what is live only once nothing is
// still building it: trunk B, whose deploy check is running, while the site
// still serves A, was returned as live and a capture of A was labelled B
// (Contextium v9.2.0 review). The read refuses until the checks finish.
const checkRuns = (sha: string) => `repos/acme/site/commits/${sha}/check-runs?per_page=100&page=1`;
const combined = (sha: string) => `repos/acme/site/commits/${sha}/status`;
test("no deployment recorded: a trunk still building is not live; once its checks finish, it is", () => {
  const repo = onGithub();
  const B = "b".repeat(40);
  const seam = stub({ "workbench#deployment": null, workbench: B });
  const building = ghStub({
    [checkRuns(B)]: { total_count: 1, check_runs: [{ name: "deploy", status: "in_progress" }] },
    [combined(B)]: { state: "pending", statuses: [] },
  });
  const r = sut(["revision", "workbench", repo], { ...seam, ...building });
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.out, "");
  assert.match(r.err, /still building.*deploy/);
  const statusBuilding = ghStub({
    [checkRuns(B)]: { total_count: 0, check_runs: [] },
    [combined(B)]: { state: "pending", statuses: [{ context: "pages", state: "pending" }] },
  });
  const sb = sut(["revision", "workbench", repo], { ...seam, ...statusBuilding });
  assert.equal(sb.rc, 1, sb.out);
  assert.match(sb.err, /still building.*pages/);
  const settled = ghStub({
    [checkRuns(B)]: { total_count: 1, check_runs: [{ name: "deploy", status: "completed" }] },
    [combined(B)]: { state: "pending", statuses: [] },
  });
  const ok = sut(["revision", "workbench", repo], { ...seam, ...settled });
  assert.equal(ok.rc, 0, ok.err);
  assert.deepEqual(JSON.parse(ok.out), { deploymentId: B, sourceCommit: B });
  const unreadable = sut(["revision", "workbench", repo], { ...seam, ...ghStub({}) });
  assert.equal(unreadable.rc, 1, "checks that cannot be read are a failure, never live");
  assert.match(unreadable.err, /check-runs/);
});
