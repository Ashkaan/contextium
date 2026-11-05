// rows-taken.test.ts — peer of rows-taken.ts.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/rows-taken.test.ts
//
// Each case builds a throwaway T3 home (a v2 state database) and a set of real
// linked worktrees of one throwaway repository, each with its own uncommitted
// copy of one project, then runs rows-taken.ts as a program from "this thread's"
// worktree. The repository's origin/main is its first commit, which holds no
// project, so every mark a worktree carries is its own unless a case commits one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// node:sqlite through a child Node that has it (tests/sqlite-child.ts): on
// Node 22.5–22.12 it loads only behind a flag this suite cannot give itself.
import { DatabaseSync } from "./tests/sqlite-child.ts";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "rows-taken.ts");
const TMP = mkdtempSync(join(tmpdir(), "rows-taken-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PROJECT = "projects/t/2026-01-01_p";
const HDR =
  "| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |\n" +
  "|----|-------------|--------|----------------|-----------|--------|----------|";
const row = (id: string, status: string): string => `| ${id} | f | i | s | — | ${status} | — |`;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...a: string[]): void {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(r.status, 0, r.stderr);
}

interface Thread {
  id: string;
  title?: string | null;
  wt: string;
  settled?: boolean;
}

function scenario(name: string) {
  const root = join(TMP, name);
  const home = join(root, "t3");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = join(home, "userdata/statev2.sqlite");

  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");

  /** A linked worktree of `repo` holding the project with these rows, uncommitted, or no project when rows is null. */
  const worktree = (wtName: string, rows: string[] | null, roadmapBody?: string): string => {
    const wt = join(root, wtName);
    git(repo, "worktree", "add", "-q", "-b", wtName, wt);
    if (rows !== null || roadmapBody !== undefined) {
      mkdirSync(join(wt, PROJECT), { recursive: true });
      writeFileSync(join(wt, PROJECT, "README.md"), "---\nstatus: active\n---\n");
      writeFileSync(
        join(wt, PROJECT, "ROADMAP.md"),
        roadmapBody ?? `# Roadmap: t\n\n${HDR}\n${(rows ?? []).map((r) => `${r}\n`).join("")}`,
      );
    }
    return wt;
  };
  const own = worktree("own", [row("R1", "in-progress"), row("R2", "planned"), row("R3", "planned")]);

  const threads = (list: Thread[], extraRows: [string, string][] = []): void => {
    const w = new DatabaseSync(db);
    w.exec(
      "create table if not exists orchestration_v2_projection_threads (thread_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);",
    );
    const ins = w.prepare("insert into orchestration_v2_projection_threads values (?, ?, ?, null, ?)");
    let n = 0;
    for (const t of list) {
      const lineage = JSON.stringify({ parentThreadId: null, relationshipToParent: null, rootThreadId: t.id });
      const payload = { archivedAt: null, settledAt: t.settled ? "2026-10-24" : null, worktreePath: t.wt, lineage };
      ins.run(
        t.id,
        t.title === undefined ? `Thread ${t.id}` : t.title,
        String(n++).padStart(3, "0"),
        JSON.stringify(payload),
      );
    }
    for (const [id, payload] of extraRows) ins.run(id, "x", String(n++).padStart(3, "0"), payload);
    w.close();
  };

  const run = (project = PROJECT, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, project], {
      cwd: own,
      encoding: "utf8",
      env: { ...process.env, T3CODE_HOME: home, CONTEXT_WRITE_ROOT: own, ...env },
      timeout: 30_000,
    });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  };
  return { root, home, db, repo, own, worktree, threads, run };
}

test("one holder is one line: ID, title, thread id, worktree", () => {
  const s = scenario("one");
  const wt = s.worktree("a", [row("R2", "in-progress"), row("R3", "planned")]);
  s.threads([{ id: "t-a", title: "Building R2", wt }]);
  const r = s.run();
  assert.equal(r.rc, 0);
  assert.equal(r.out, `R2\tBuilding R2\tt-a\t${wt}\n`);
});

test("a settled holder holds nothing", () => {
  const s = scenario("settled");
  const wt = s.worktree("a", [row("R2", "in-progress")]);
  s.threads([{ id: "t-a", wt, settled: true }]);
  assert.equal(s.run().out, "");
});

test("this thread's own worktree, the shared checkout, a missing worktree and one without the project hold nothing", () => {
  const s = scenario("excluded");
  const shared = join(s.root, "shared");
  mkdirSync(join(shared, ".git"), { recursive: true }); // a main checkout: `.git` is a directory
  mkdirSync(join(shared, PROJECT), { recursive: true });
  writeFileSync(join(shared, PROJECT, "ROADMAP.md"), `# Roadmap: t\n\n${HDR}\n${row("R2", "in-progress")}\n`);
  const bare = s.worktree("bare", null);
  s.threads([
    { id: "t-own", wt: s.own },
    { id: "t-shared", wt: shared },
    { id: "t-gone", wt: join(s.root, "deleted-worktree") },
    { id: "t-bare", wt: bare },
  ]);
  const r = s.run();
  assert.equal(r.rc, 0);
  assert.equal(r.out, "", "own R1 in-progress is not held; nothing else counts");
});

test("a malformed ROADMAP.md is skipped with a warning naming it, and a valid holder beside it still prints", () => {
  const s = scenario("malformed");
  const bad = s.worktree("bad", null, `# Roadmap: t\n\n${HDR}\n| R2 | f | i | s | — | in-progress | specs/002-x |\n`);
  const good = s.worktree("good", [row("R3", "in-progress")]);
  s.threads([
    { id: "t-bad", wt: bad },
    { id: "t-good", wt: good },
  ]);
  const r = s.run();
  assert.equal(r.rc, 0);
  assert.equal(r.out, `R3\tThread t-good\tt-good\t${good}\n`);
  assert.match(r.err, new RegExp(`rows-taken: .*${join(bad, PROJECT, "ROADMAP.md")}`), "the warning names the file");
});

test("two threads on one worktree print once; two worktrees holding one row print twice", () => {
  const s = scenario("dupes");
  const a = s.worktree("a", [row("R2", "in-progress")]);
  const b = s.worktree("b", [row("R2", "in-progress"), row("R10", "in-progress")]);
  s.threads([
    { id: "t-b", wt: b },
    { id: "t-a1", wt: a },
    { id: "t-a2", wt: a },
  ]);
  assert.equal(
    s.run().out,
    `R2\tThread t-a1\tt-a1\t${a}\nR2\tThread t-b\tt-b\t${b}\nR10\tThread t-b\tt-b\t${b}\n`,
    "sorted by ID (R2 before R10) then thread id; t-a2 shares t-a1's worktree",
  );
});

test("a title's tabs and newlines become spaces, and an empty title is (untitled)", () => {
  const s = scenario("titles");
  const a = s.worktree("a", [row("R2", "in-progress")]);
  const b = s.worktree("b", [row("R3", "in-progress")]);
  s.threads([
    { id: "t-a", title: "two\tparts\nhere", wt: a },
    { id: "t-b", title: null, wt: b },
  ]);
  assert.equal(s.run().out, `R2\ttwo parts here\tt-a\t${a}\nR3\t(untitled)\tt-b\t${b}\n`);
});

test("an absolute and a relative project path give the same answer", () => {
  const s = scenario("paths");
  const wt = s.worktree("a", [row("R2", "in-progress")]);
  s.threads([{ id: "t-a", wt }]);
  const rel = s.run();
  assert.equal(rel.out, `R2\tThread t-a\tt-a\t${wt}\n`);
  assert.equal(s.run(join(s.own, PROJECT)).out, rel.out);
  assert.equal(s.run(`${join(s.own, PROJECT)}/`).out, rel.out, "a trailing slash too");
});

test("a malformed thread payload is skipped with a warning; the valid holder still prints", () => {
  const s = scenario("payload");
  const wt = s.worktree("a", [row("R2", "in-progress")]);
  s.threads([{ id: "t-a", wt }], [["t-broken", "{nope"]]);
  const r = s.run();
  assert.equal(r.out, `R2\tThread t-a\tt-a\t${wt}\n`);
  assert.match(r.err, /t-broken/);
});

test("no database, an empty one, or an unreadable one: nothing held, exit 0, a note", () => {
  const none = scenario("no-db");
  const r1 = none.run();
  assert.deepEqual([r1.rc, r1.out], [0, ""]);
  assert.match(r1.err, /rows-taken: no T3 database at /);

  const empty = scenario("empty-db");
  writeFileSync(empty.db, "");
  const r2 = empty.run();
  assert.deepEqual([r2.rc, r2.out], [0, ""]);
  assert.match(r2.err, /rows-taken: cannot read /);

  const locked = scenario("unreadable-db");
  locked.threads([{ id: "t-a", wt: locked.worktree("a", [row("R2", "in-progress")]) }]);
  chmodSync(locked.db, 0o000);
  const r3 = locked.run();
  chmodSync(locked.db, 0o600);
  assert.deepEqual([r3.rc, r3.out], [0, ""]);
  assert.match(r3.err, /rows-taken: cannot read /);
});

test("a path that is not a project folder is a usage error", () => {
  const s = scenario("usage");
  assert.equal(s.run("somewhere/else").rc, 2);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

// A mark committed on main is in every worktree cut from it, so it is nobody's
// claim: a project with ten manual rows `in-progress` on main would name every
// open thread as building them. Only a
// mark the thread's worktree has and origin/main does not counts — uncommitted,
// or in a commit of the thread's own branch.
test("a row in-progress on origin/main is not held; one the worktree added is, committed or not", () => {
  const s = scenario("inherited");
  const repo = join(s.root, "main-repo");
  const road = (rows: string[]): string => `# Roadmap: t\n\n${HDR}\n${rows.map((r) => `${r}\n`).join("")}`;
  const onMain = [row("R1", "in-progress"), row("R2", "planned"), row("R3", "planned")];
  mkdirSync(join(repo, PROJECT), { recursive: true });
  writeFileSync(join(repo, PROJECT, "ROADMAP.md"), road(onMain));
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const a = join(s.root, "wt-a");
  const b = join(s.root, "wt-b");
  git(repo, "worktree", "add", "-q", "-b", "a", a);
  git(repo, "worktree", "add", "-q", "-b", "b", b);
  writeFileSync(
    join(a, PROJECT, "ROADMAP.md"),
    road([row("R1", "in-progress"), row("R2", "in-progress"), row("R3", "planned")]),
  );
  writeFileSync(
    join(b, PROJECT, "ROADMAP.md"),
    road([row("R1", "in-progress"), row("R2", "planned"), row("R3", "in-progress")]),
  );
  git(b, "commit", "-qam", "wip");
  s.threads([
    { id: "t-a", wt: a },
    { id: "t-b", wt: b },
  ]);
  assert.equal(
    s.run().out,
    `R2\tThread t-a\tt-a\t${a}\nR3\tThread t-b\tt-b\t${b}\n`,
    "R1, in-progress on main, is held by neither",
  );

  // Main moves on: R1 is finished there. The two worktrees never touched R1 and
  // were cut before that, so they still show it in-progress — inherited, not theirs.
  writeFileSync(
    join(repo, PROJECT, "ROADMAP.md"),
    road([row("R1", "done"), row("R2", "planned"), row("R3", "planned")]),
  );
  git(repo, "commit", "-qam", "R1 done");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(
    s.run().out,
    `R2\tThread t-a\tt-a\t${a}\nR3\tThread t-b\tt-b\t${b}\n`,
    "after main moved R1 on, the worktrees cut before it still hold only their own rows",
  );
});

test("a worktree whose base cannot be read is skipped with a note, not read as holding everything", () => {
  const s = scenario("no-base");
  const wt = s.worktree("a", [row("R2", "in-progress")]);
  const good = s.worktree("b", [row("R3", "in-progress")]);
  // a's history is cut off from origin/main: an orphan commit with no common ancestor.
  git(wt, "checkout", "-q", "--orphan", "lonely");
  git(wt, "commit", "-q", "--allow-empty", "-m", "orphan");
  s.threads([
    { id: "t-a", wt },
    { id: "t-b", wt: good },
  ]);
  const r = s.run();
  assert.equal(r.rc, 0);
  assert.equal(r.out, `R3\tThread t-b\tt-b\t${good}\n`, "the readable worktree still counts");
  assert.match(r.err, new RegExp(`rows-taken: ${wt}: no merge-base with origin/main; skipped`));
});

test("a base whose copy is not a readable table is skipped with a note, never read as having no marks", () => {
  for (const [name, commit, want] of [
    // The base holds a folder where the ROADMAP.md should be: git reads a tree, not the file.
    ["base-tree", (p: string) => mkdirSync(join(p, "ROADMAP.md"), { recursive: true }), / tree \d+; skipped/],
    // The base holds a ROADMAP.md the parser refuses.
    [
      "base-malformed",
      (p: string) => writeFileSync(join(p, "ROADMAP.md"), "# Roadmap: t\n\n| ID |\n|---|\n"),
      /is malformed/,
    ],
  ] as const) {
    const s = scenario(name);
    const p = join(s.repo, PROJECT);
    mkdirSync(p, { recursive: true });
    commit(p);
    writeFileSync(join(p, "keep"), "");
    if (name === "base-tree") writeFileSync(join(p, "ROADMAP.md", "x"), "");
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-qm", "base copy");
    git(s.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const wt = s.worktree(`${name}-wt`, null);
    rmSync(join(wt, PROJECT, "ROADMAP.md"), { recursive: true, force: true });
    writeFileSync(join(wt, PROJECT, "ROADMAP.md"), `# Roadmap: t\n\n${HDR}\n${row("R2", "in-progress")}\n`);
    s.threads([{ id: "t-a", wt }]);
    const r = s.run();
    assert.equal(r.out, "", `${name}: nothing held`);
    assert.match(r.err, want, `${name}: the note says why: ${r.err}`);
  }
});
