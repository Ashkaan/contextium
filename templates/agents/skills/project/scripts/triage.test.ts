// triage.test.ts — run triage.ts as a program over a fixture git checkout:
// how each view orders and words its rows, how a cell is cut, the dates it
// counts from git, whose move a wait is, and its refusals.
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/triage.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "triage.ts");
const tmp = mkdtempSync(join(tmpdir(), "triage-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const TODAY = "2026-10-31";

const HDR =
  "| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |\n" +
  "|----|-------------|--------|----------------|-----------|--------|----------|";

function git(root: string, args: string[], date = "2026-10-01T12:00:00Z"): void {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A project folder: README front matter and ROADMAP rows `[id, sub, depends, status, subSpec]`. */
function project(
  root: string,
  slug: string,
  fm: Record<string, string>,
  rows: Array<[string, string, string, string, string]>,
): void {
  const dir = join(root, "projects", "t", `2026-01-01_${slug}`);
  mkdirSync(dir, { recursive: true });
  const front = Object.entries({ project: slug, ...fm })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, "README.md"), `---\n${front}\n---\n\n# P\n`);
  const table = rows.map(([id, sub, dep, st, ss]) => `| ${id} | ${sub} | i | s | ${dep} | ${st} | ${ss} |`).join("\n");
  writeFileSync(join(dir, "ROADMAP.md"), `# Roadmap: ${slug}\n\n${HDR}\n${table}\n`);
}

/** A fixture checkout: one commit per call of `stage`, each on its own date. */
function repo(build: (root: string, commit: (date: string) => void) => void): string {
  const root = mkdtempSync(join(tmp, "r-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "Robin Tester"]);
  build(root, (date) => {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "x"], `${date}T12:00:00Z`);
  });
  return root;
}

function run(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args, "--root", root, "--today", TODAY], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const rowsOf = (out: string) =>
  out
    .split("\n")
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => l.split(" | ").map((c) => c.replace(/^\| | \|$/g, "")));

const BLOCKED = repo((root, commit) => {
  project(root, "zeta-vendor", { status: "blocked", "blocked-on": '"R1: the supplier\'s next firmware build"' }, [
    ["R1", "a", "—", "blocked: the supplier's next firmware build", "manual"],
  ]);
  project(root, "alpha-later", { status: "blocked", "blocked-on": '"R2: until 2026-11-15 the quote"' }, [
    ["R2", "b", "—", "blocked: until 2026-11-15 the quote", "manual"],
  ]);
  project(root, "beta-passed", { status: "blocked", "blocked-on": '"R3: until 2026-10-30 x"' }, [
    ["R3", "c", "—", "blocked: until 2026-10-30 the quote expired", "manual"],
  ]);
  project(root, "gamma-dep", { status: "blocked", "blocked-on": '"R4: waits on zeta-vendor R1"' }, [
    ["R4", "d", "zeta-vendor R1", "planned", "—"],
  ]);
  project(root, "idle-active", { status: "active" }, [["R1", "a", "—", "planned", "—"]]);
  commit("2026-10-01");
  project(root, "delta-mine", { status: "blocked", "blocked-on": '"R5: Robin to sign the form"' }, [
    ["R5", "e", "—", "blocked: Robin to sign the \\| form", "manual"],
  ]);
  commit("2026-10-21");
});

test("blocked: the user's moves first, then passed dates, others, projects, future dates; each with its wait", () => {
  const r = run(BLOCKED, "blocked");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\*\*Blocked — 5\*\*\n\n\| # \| Project \| Row \| Waiting on \| Whose move \| Waiting \|\n/);
  assert.deepEqual(rowsOf(r.out), [
    ["1", "delta-mine", "R5", "Robin to sign the \\| form", "you", "10 days"],
    ["2", "beta-passed", "R3", "until 10-30: the quote expired", "date passed 10-30", "30 days"],
    ["3", "zeta-vendor", "R1", "the supplier's next firmware build", "others", "30 days"],
    ["4", "gamma-dep", "R4", "waits on zeta-vendor R1", "project", "—"],
    ["5", "alpha-later", "R2", "until 11-15: the quote", "date 11-15", "30 days"],
  ]);
  assert.match(r.out, /\nAnswer by number: `unblock`, `until <date>`, `done`, `drop`, or a new wait\.\n$/);
});

const MONITORED = repo((root, commit) => {
  project(root, "watch-soon", { status: "monitor", "monitoring-until": '"2026-11-01 — R1: soon"' }, [
    ["R1", "soon-watch", "—", "blocked: 2026-11-01", "—"],
    ["R2", "later", "—", "blocked: 2026-12-01 a second watch", "—"],
  ]);
  project(root, "watch-lapsed", { status: "monitor", "monitoring-until": '"2026-10-30 — R7: x"' }, [
    ["R7", "x", "—", "blocked: 2026-10-30 the first nightly run posts its report and a summary", "—"],
  ]);
  project(root, "watch-today", { status: "monitor", "monitoring-until": '"2026-10-31 — R1: t"' }, [
    ["R1", "t", "—", "blocked: 2026-10-31 today's check", "—"],
    ["R2", "done-one", "—", "done", "—"],
  ]);
  commit("2026-10-01");
});

test("monitored: lapsed first, what each watch waits for, the end and what is left", () => {
  const r = run(MONITORED, "monitored");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rowsOf(r.out), [
    ["1", "watch-lapsed", "R7", "the first nightly run posts its report and…", "2026-10-30", "lapsed 1 day"],
    ["2", "watch-today", "R1", "today's check", "2026-10-31", "ends today"],
    ["3", "watch-soon", "R1 (+1)", "soon-watch", "2026-11-01", "1 day"],
  ]);
  assert.match(r.out, /^\*\*Monitoring — 3\*\*\n/);
});

const MINE = repo((root, commit) => {
  project(root, "release", { status: "blocked", "blocked-on": '"R1: Robin to ask"' }, [
    ["R1", "a", "—", "blocked: Robin to ask at the next standup", "manual"],
    ["R2", "b", "—", "blocked: Robin to ask at the next standup", "manual"],
    ["R3", "c", "—", "blocked: Robin to book the security review", "manual"],
    ["R4", "d", "—", "blocked: the vendor's support replies", "manual"],
    ["R5", "e", "—", "blocked: until 2026-11-20 Robin checks the staging deploy", "manual"],
    ["R6", "f", "—", "blocked: 2026-12-01 Robin watches the error rate", "—"],
  ]);
  project(root, "outreach", { status: "active" }, [
    ["R1", "Send the release notes", "—", "planned", "manual"],
    ["R2", "Fix the docs link", "—", "planned", "manual"],
    ["R3", "build it", "—", "planned", "—"],
  ]);
  project(root, "old-done", { status: "completed" }, [["R1", "a", "—", "blocked: Robin once", "manual"]]);
  commit("2026-10-11");
});

test("mine: waits naming the user, same wait grouped, then each active project's hands-on steps", () => {
  const r = run(MINE, "mine");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(rowsOf(r.out), [
    ["1", "release", "R1 (+1)", "Robin to ask at the next standup", "waits on you", "20 days"],
    ["2", "release", "R3", "Robin to book the security review", "waits on you", "20 days"],
    ["3", "outreach", "R1 (+1)", "Send the release notes", "hands-on", "20 days"],
  ]);
  assert.match(r.out, /^\*\*Waiting on you — 3\*\*\n/);
});

test("a cell is cut at 8 words or 60 characters, whichever comes first", () => {
  const root = repo((rt, commit) => {
    project(rt, "long-words", { status: "blocked", "blocked-on": '"R1: x"' }, [
      ["R1", "a", "—", "blocked: one two three four five six seven eight nine ten", "manual"],
    ]);
    project(rt, "long-path", { status: "blocked", "blocked-on": '"R1: x"' }, [
      ["R1", "a", "—", `blocked: read ${"a/".repeat(40)}file.md first`, "manual"],
    ]);
    commit("2026-10-01");
  });
  const cells = rowsOf(run(root, "blocked").out).map((r) => r[3]);
  assert.deepEqual(cells.sort(), [`read ${"a/".repeat(27)}a…`, "one two three four five six seven eight…"].sort());
});

test("nothing to show prints the heading with 0 and nothing else", () => {
  const root = repo((rt, commit) => {
    project(rt, "only-active", { status: "active" }, [["R1", "a", "—", "planned", "—"]]);
    commit("2026-10-01");
  });
  assert.equal(run(root, "blocked").out, "**Blocked — 0**\n");
  assert.equal(run(root, "monitored").out, "**Monitoring — 0**\n");
  assert.equal(run(root, "mine").out, "**Waiting on you — 0**\n");
});

test("a checkout behind origin/main under projects/ is refused", () => {
  const root = repo((rt, commit) => {
    project(rt, "p-one", { status: "blocked", "blocked-on": '"R1: x"' }, [["R1", "a", "—", "blocked: x", "manual"]]);
    commit("2026-10-01");
  });
  git(root, ["checkout", "-q", "-b", "ahead"]);
  writeFileSync(join(root, "projects", "t", "2026-01-01_p-one", "README.md"), "---\nstatus: active\n---\n");
  git(root, ["commit", "-qam", "main moved"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "ahead"]);
  git(root, ["checkout", "-q", "main"]);
  const r = run(root, "blocked");
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
  assert.equal(
    r.err,
    "triage: origin/main changed 1 file(s) under projects/ after this worktree was cut — merge origin/main and run again\n",
  );
  git(root, ["merge", "-q", "--ff-only", "ahead"]);
  assert.equal(run(root, "blocked").code, 0, "after the merge it reads");
});

test("an unreadable roadmap fails the run with its path", () => {
  const root = repo((rt, commit) => {
    project(rt, "broken", { status: "blocked", "blocked-on": '"R1: x"' }, []);
    writeFileSync(join(rt, "projects", "t", "2026-01-01_broken", "ROADMAP.md"), "no table here\n");
    commit("2026-10-01");
  });
  const r = run(root, "blocked");
  assert.equal(r.code, 1);
  assert.match(r.err, /^triage: projects\/t\/2026-01-01_broken\/ROADMAP\.md: /);
});

test("usage errors exit 2", () => {
  for (const args of [[], ["stale"], ["blocked", "--today", "soon"], ["blocked", "--wat", "x"]]) {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /^usage: triage\.ts /);
  }
});

// Whose move: a pronoun, "the user" or "the owner", or the first word of the
// checkout's git user.name — never someone else's name.
test("whose move: the owner's first name from git config, pronouns, and nobody else", () => {
  const root = repo((rt, commit) => {
    project(rt, "w-name", { status: "blocked", "blocked-on": '"R1: x"' }, [["R1", "a", "—", "blocked: robin approves the copy", "manual"]]);
    project(rt, "w-pronoun", { status: "blocked", "blocked-on": '"R1: x"' }, [["R1", "a", "—", "blocked: your sign-off", "manual"]]);
    project(rt, "w-user", { status: "blocked", "blocked-on": '"R1: x"' }, [["R1", "a", "—", "blocked: the user picks a date", "manual"]]);
    project(rt, "w-other", { status: "blocked", "blocked-on": '"R1: x"' }, [["R1", "a", "—", "blocked: Robinson replies", "manual"]]);
    commit("2026-10-01");
  });
  const whose = Object.fromEntries(rowsOf(run(root, "blocked").out).map((r) => [r[1], r[4]]));
  assert.deepEqual(whose, { "w-name": "you", "w-pronoun": "you", "w-user": "you", "w-other": "others" });
  git(root, ["config", "user.name", "Q"]);
  const noName = Object.fromEntries(rowsOf(run(root, "blocked").out).map((r) => [r[1], r[4]]));
  assert.equal(noName["w-name"], "others", "a one-letter user.name names nobody");
  assert.equal(noName["w-pronoun"], "you", "pronouns still count without a name");
});
