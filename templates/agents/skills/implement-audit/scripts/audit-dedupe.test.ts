// audit-dedupe.test.ts — peer of audit-dedupe.ts: the review receipt.
// Run: node --test --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.test.ts
//
// Pins the receipt's lifecycle as validate.ts drives it — begin (register the
// obligation, check the declaration, reuse or open an incomplete attempt),
// finish (bind the parsed result to the content captured before dispatch) —
// and the readers that consume it: status (the skill's step 0), mark (a
// trailer is a record, never proof) and check (the close). Every case runs the
// script as a program in its own HOME, so no real thread's state is read or
// written; snapshots are real git trees written through a temporary index.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "audit-dedupe.ts");
const TMP = mkdtempSync(join(tmpdir(), "audit-dedupe-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const HOME = join(TMP, "home");

const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME, T3CODE_HOME: join(TMP, "absent-t3") };
delete baseEnv.CLAUDE_CODE_SESSION_ID;
delete baseEnv.CLAUDE_SESSION_ID;
delete baseEnv.WORKBENCH_THREAD_ID;
delete baseEnv.CODE_REVIEW_LOOP_ID;
delete baseEnv.CODE_REVIEW_ROUND_STATE_DIR;
delete baseEnv.POLICY_CHAIN_AUTHOR_VENDORS;
delete baseEnv.POLICY_CHAIN_AUTHOR_THREAD_ID;

interface R {
  out: string;
  err: string;
  rc: number | null;
}
function run(env: NodeJS.ProcessEnv, ...args: string[]): R {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.replace(/\n+$/, ""), err: r.stderr.replace(/\n+$/, ""), rc: r.status };
}
const git = (dir: string, ...a: string[]): string =>
  spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }).stdout.replace(/\n+$/, "");
function repo(name: string): string {
  const d = join(TMP, name);
  mkdirSync(join(d, ".agents/skills/demo"), { recursive: true });
  mkdirSync(join(d, "projects"), { recursive: true });
  git(d, "init", "-q", "-b", "main", ".");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 1;\n");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 1;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  return d;
}
/** A snapshot as code-review.ts takes one: the working tree as a git tree, HEAD and index untouched. */
function snap(dir: string): string {
  const idx = join(TMP, `idx-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  spawnSync("git", ["-C", dir, "read-tree", "HEAD"], { env });
  spawnSync("git", ["-C", dir, "add", "-A"], { env });
  const t = spawnSync("git", ["-C", dir, "write-tree"], { env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  return t;
}
function result(name: string, findings: string[], coverage: unknown[] = [], vendor = "grok/grok-4"): string {
  const f = join(TMP, `${name}.json`);
  writeFileSync(f, JSON.stringify({ vendor, findings, coverage }));
  return f;
}
const owner = (id: string): NodeJS.ProcessEnv => ({
  CODE_REVIEW_LOOP_ID: id,
  CODE_REVIEW_ROUND_STATE_DIR: join(TMP, `rounds-${id}`),
});
function begin(env: NodeJS.ProcessEnv, dir: string, mode = "range", extra: string[] = []): R {
  return run(
    env,
    "begin",
    "--repo",
    dir,
    "--tree",
    snap(dir),
    "--mode",
    mode,
    "--bucket",
    "build",
    "--base",
    "HEAD",
    "--scope",
    ".agents/skills/demo",
    ...extra,
  );
}
function approve(env: NodeJS.ProcessEnv, dir: string, findings: string[] = []): R {
  const b = begin(env, dir);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /RECEIPT=review/);
  return run(env, "finish", "--repo", dir, "--rc", "0", "--result", result(`r-${Math.random()}`, findings));
}

test("usage", () => {
  assert.equal(run({}).rc, 2);
  assert.equal(run({}, "bogus").rc, 2);
  const m = run(owner("u"), "mark");
  assert.equal(m.rc, 2);
  assert.match(m.err, /usage: audit-dedupe\.ts mark/);
  assert.equal(run(owner("u"), "begin", "--repo").rc, 2, "a flag with no value");
  assert.equal(run(owner("u"), "begin", "--repo", TMP).rc, 2, "begin without --tree, --mode, --bucket");
  assert.equal(run(owner("u"), "check").rc, 2, "check without --owner");
});

test("a trailer is a record, never proof of review", () => {
  const d = repo("trailer");
  const env = owner("trailer");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run(env, "status", "--repo", d).out, "fresh");
  const m = run(env, "mark", "implement-audit: round-1; zero findings; APPROVE", "--repo", d);
  assert.equal(m.rc, 1, "mark with no receipt is refused");
  assert.match(m.err, /a trailer is a record, not proof of review/);
  // The old per-session marker is ignored, whatever it says.
  const legacy = join("/tmp/implement-audit-done", `loop-${createHash("sha256").update("trailer").digest("hex")}`);
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, "implement-audit: round-1; zero findings; APPROVE\n");
  try {
    assert.equal(run(env, "status", "--repo", d).out, "fresh", "a legacy trailer marker grants nothing");
  } finally {
    rmSync(legacy, { force: true });
  }
  // Outside T3 Code with no CODE_REVIEW_LOOP_ID the owner is the close's
  // thread id, so a trailer there is refused just the same.
  const noLoop = run({ WORKBENCH_THREAD_ID: "trailer-thread" }, "mark", "implement-audit: x", "--repo", d);
  assert.equal(noLoop.rc, 1, noLoop.err);
  assert.match(noLoop.err, /a trailer is a record, not proof of review/);
});

test("begin, finish, status and mark: one approved receipt for the reviewed content", () => {
  const d = repo("life");
  const env = owner("life");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const f = approve(env, d, ["[nit] tidy"]);
  assert.equal(f.out, "APPROVED=1", f.err);
  let s = run(env, "status", "--repo", d);
  assert.equal(s.out.split("\n")[0], "done");
  assert.match(s.out, /receipt range review by grok\/grok-4/);
  assert.match(s.out, /1 nit\(s\) held/);
  assert.equal(run(env, "mark", "implement-audit: round-1; 1 nit; APPROVE", "--repo", d).rc, 0);
  s = run(env, "status", "--repo", d);
  assert.equal(s.out, "done\nimplement-audit: round-1; 1 nit; APPROVE");
  // The same content again: reuse, no new attempt.
  const again = begin(env, d);
  assert.match(again.out, /RECEIPT=reuse/);
  // A realpath alias of the same worktree is the same receipt.
  const alias = join(TMP, "life-alias");
  symlinkSync(d, alias);
  assert.equal(run(env, "status", "--repo", alias).out.split("\n")[0], "done");
  // Another owner, and a same-named worktree elsewhere, borrow nothing.
  assert.equal(run(owner("someone-else"), "status", "--repo", d).out, "fresh");
  mkdirSync(join(TMP, "elsewhere"), { recursive: true });
  const twin = repo("elsewhere/life");
  writeFileSync(join(twin, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run(env, "status", "--repo", twin).out, "fresh");
  // The receipt lives in the owner's durable thread cache.
  assert.ok(existsSync(join(HOME, ".cache/workbench/threads/life/review.json")));
});

test("an edit after the review makes it stale; a different scope or writer is not reused", () => {
  const d = repo("stale");
  const env = owner("stale");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out, "fresh");
  assert.match(s.err, /changed since the review: \.agents\/skills\/demo\/a\.ts/);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run(env, "status", "--repo", d).out.split("\n")[0], "done", "restoring the bytes recovers");
  const otherScope = run(
    env,
    "begin",
    "--repo",
    d,
    "--tree",
    snap(d),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--scope",
    ".agents/skills/other",
  );
  assert.match(otherScope.out, /RECEIPT=review/, "another scope is reviewed, not borrowed");
  run(env, "finish", "--repo", d, "--rc", "1");
  const writer = begin({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex" }, d);
  assert.match(writer.out, /RECEIPT=review/, "another writer set is reviewed again");
});

test("a failed or interrupted attempt never inherits success, and blockers are never cleared by convergence", () => {
  const d = repo("fail");
  const env = owner("fail");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  assert.match(begin(env, d, "since", ["--since", snap(d)]).out, /RECEIPT=review/);
  const fail = run(env, "finish", "--repo", d, "--rc", "1");
  assert.equal(fail.out, "APPROVED=0");
  assert.match(run(env, "status", "--repo", d).err, /the last review attempt did not complete/);
  assert.match(run({ ...env, CODE_REVIEW_LOOP_ID: "fail" }, "check", "--owner", "fail", d).err, /did not complete/);

  // A round with a blocker, then a converged round: the blocker stands.
  const t = snap(d);
  begin(env, d, "since", ["--since", t]);
  const blocked = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result("blk", ["[must-fix] a.ts:1: x — y — z"]),
  );
  assert.equal(blocked.out, "APPROVED=0");
  begin(env, d, "since", ["--since", snap(d)]);
  const conv = run(env, "finish", "--repo", d, "--rc", "4");
  assert.equal(conv.out, "APPROVED=0", "an empty delta manufactures no approval");
  assert.match(conv.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0").rc, 1, "finish with no open attempt is refused");
});

test("a follow-up round approves only what its delta covered", () => {
  const d = repo("delta");
  const env = owner("delta");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  // The round reviews s1..now: b.ts. a.ts moved since the approved receipt but
  // before s1, so this round never read it.
  begin(env, d, "since", ["--since", s1]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("gap", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/);
  // From the snapshot of the approved content, both are in the delta.
  const d2 = repo("delta2");
  const env2 = owner("delta2");
  writeFileSync(join(d2, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const t0 = snap(d2);
  approve(env2, d2);
  writeFileSync(join(d2, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  writeFileSync(join(d2, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env2, d2, "since", ["--since", t0]);
  assert.equal(run(env2, "finish", "--repo", d2, "--rc", "0", "--result", result("nogap", [])).out, "APPROVED=1");
  // A follow-up with no earlier complete review approves nothing.
  const d3 = repo("delta3");
  const env3 = owner("delta3");
  writeFileSync(join(d3, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  begin(env3, d3, "since", ["--since", snap(d3)]);
  const lone = run(env3, "finish", "--repo", d3, "--rc", "0", "--result", result("lone", []));
  assert.equal(lone.out, "APPROVED=0");
  assert.match(lone.err, /no earlier complete review/);
});

test("the coverage declaration: exactly one strict block, frozen; later prose is free", () => {
  const d = repo("decl");
  const env = owner("decl");
  writeFileSync(join(d, "AGENTS.md"), "rules\n");
  git(d, "add", "AGENTS.md");
  git(d, "commit", "-qm", "rules");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const decl = {
    base: "HEAD",
    scope: ".agents/skills/demo",
    entryPoints: [{ id: "E1", path: ".agents/skills/demo/a.ts" }],
    dependencies: [{ id: "D1", path: "AGENTS.md", why: "instruction" }],
    claims: [
      {
        id: "C1",
        claim: "a is 2",
        negativeTest: { trigger: "a=1", expected: "fails", evidence: [".agents/skills/demo/b.ts"] },
      },
    ],
  };
  const put = (body: string, prose = ""): void =>
    writeFileSync(report, `# r\n${prose}\n<!-- review-coverage:v1 -->\n${body}\n<!-- /review-coverage -->\n`);
  const tryBegin = (): R => begin(env, d, "range", ["--report", report]);
  for (const [why, body] of [
    ["duplicate key", '{"base":"HEAD","base":"x"}'],
    ["not strict JSON", "{base: HEAD}"],
    ['unknown key "extra"', JSON.stringify({ ...decl, extra: 1 })],
    ["exactly one of negativeTest or inapplicable", JSON.stringify({ ...decl, claims: [{ id: "C1", claim: "x" }] })],
    ["used twice", JSON.stringify({ ...decl, dependencies: [{ id: "E1", path: "AGENTS.md", why: "x" }] })],
    ["repo-relative", JSON.stringify({ ...decl, entryPoints: [{ id: "E1", path: "/etc/passwd" }] })],
    ["does not exist", JSON.stringify({ ...decl, entryPoints: [{ id: "E1", path: ".agents/skills/demo/gone.ts" }] })],
    ["omits the applicable instruction AGENTS.md", JSON.stringify({ ...decl, dependencies: [] })],
  ] as const) {
    put(body);
    const b = tryBegin();
    assert.equal(b.rc, 1, `${why}: ${b.out}`);
    assert.ok(b.err.includes(why), `${why}: ${b.err}`);
  }
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify(decl)}\n<!-- /review-coverage -->\n<!-- review-coverage:v1 -->\n`,
  );
  assert.match(tryBegin().err, /exactly one/);

  put(JSON.stringify(decl));
  const b = tryBegin();
  assert.match(b.out, /RECEIPT=review/, b.err);
  const items = JSON.parse(readFileSync(b.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8")).items;
  assert.deepEqual(
    items.map((i: { id: string }) => i.id),
    ["E1", "D1", "C1"],
    "one item per entry point, dependency and claim",
  );
  const cov = ["E1", "D1", "C1"].map((id) => ({ id, status: "checked", evidence: ["read"] }));
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("decl", [], cov)).out, "APPROVED=1");
  put(JSON.stringify(decl), "a paragraph written after the review");
  assert.equal(run(env, "status", "--repo", d).out.split("\n")[0], "done", "prose outside the block is free");
  put(JSON.stringify({ ...decl, scope: ".agents/skills/demo " }));
  assert.match(run(env, "status", "--repo", d).err, /coverage declaration changed/);
  put(JSON.stringify(decl));
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 9;\n");
  assert.match(
    run(env, "status", "--repo", d).err,
    /changed since the review: \.agents\/skills\/demo\/b\.ts/,
    "the evidence is hashed",
  );
});

test("begin carries a /tmp counter's spend into the durable cache, once", () => {
  const d = repo("migrate");
  const id = `migrate-${process.pid}`;
  const env = { CODE_REVIEW_LOOP_ID: id };
  const key = `loop-${createHash("sha256").update(id).digest("hex")}-${createHash("sha256").update(d).digest("hex").slice(0, 12)}`;
  const legacy = `/tmp/code-review-rounds/${key}`;
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, "3\n");
  writeFileSync(`${legacy}.final`, "x\n");
  try {
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
    assert.match(begin(env, d).out, /RECEIPT=review/);
    const durable = join(HOME, ".cache/workbench/threads", id, "review-rounds", key);
    assert.equal(readFileSync(durable, "utf8"), "3\n", "the greatest observed spend");
    assert.ok(existsSync(`${durable}.final`), "and the spent final pass");
    assert.ok(
      existsSync(join(HOME, ".cache/workbench/threads", id, "review-rounds-qa", key)),
      "the qa bucket is initialised",
    );
  } finally {
    rmSync(legacy, { force: true });
    rmSync(`${legacy}.final`, { force: true });
  }
});

test("unreadable state is refused, never read as no review", () => {
  const d = repo("corrupt");
  const env = owner("corrupt");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  mkdirSync(join(HOME, ".cache/workbench/threads/corrupt"), { recursive: true });
  writeFileSync(join(HOME, ".cache/workbench/threads/corrupt/review.json"), "{nope");
  const b = begin(env, d);
  assert.equal(b.rc, 1);
  assert.match(b.err, /could not be read/);
  const c = run({}, "check", "--owner", "corrupt", d);
  assert.equal(c.rc, 1);
  assert.match(c.err, /could not be read/);
});

test("check: an ad-hoc change, a record-only change and a landed branch need no receipt", () => {
  const d = repo("adhoc");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run({}, "check", "--owner", "nobody", d).rc, 0, "no implementation work: judged as before");
  const r = repo("records");
  const env = owner("records");
  writeFileSync(join(r, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, r);
  git(r, "checkout", "-q", "--", "skills");
  mkdirSync(join(r, "journal"), { recursive: true });
  writeFileSync(join(r, "journal/x.md"), "notes\n");
  assert.equal(run({}, "check", "--owner", "records", r).rc, 0, "only records differ from the base");
  const req = repo("required");
  writeFileSync(join(req, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(req, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "<!-- review-coverage:v1 -->\n{}\n<!-- /review-coverage -->\n");
  const c = run({}, "check", "--owner", "required", req);
  assert.equal(c.rc, 1, "a report carrying a coverage block marks implementation work");
  assert.match(c.err, /no review receipt for implementation source \(\.agents\/skills\/demo\/a\.ts\)/);
});

// ── Round-1 audit findings ───────────────────────────────────────────────

test("a gap the last receipt left stays until a round's delta carries it", () => {
  const d = repo("gapcarry");
  const env = owner("gapcarry");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", s1]);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("gc1", [])).out, "APPROVED=0");
  const s2 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  begin(env, d, "since", ["--since", s2]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("gc2", []));
  assert.equal(f.out, "APPROVED=0", "a clean round that never read a.ts does not approve it");
  assert.match(f.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/);
});

test("an open blocker stands until a round reviews a change to its file, and the round is shown it", () => {
  const d = repo("blkcarry");
  const env = owner("blkcarry");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const t0 = snap(d);
  assert.match(begin(env, d).out, /RECEIPT=review/);
  const blocker = "[must-fix] .agents/skills/demo/a.ts:1: wrong — fix — breaks";
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("bc0", [blocker])).out, "APPROVED=0");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b1 = begin(env, d, "since", ["--since", t0]);
  const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
  assert.deepEqual(items.openFindings, [blocker], "the follow-up is shown the open finding");
  const f1 = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("bc1", []));
  assert.equal(f1.out, "APPROVED=0", "a clean round over b.ts does not close a blocker in a.ts");
  assert.match(f1.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 4;\n");
  begin(env, d, "since", ["--since", t1]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("bc2", [])).out,
    "APPROVED=1",
    "a round that reviewed the fix to a.ts and did not re-report it closes it",
  );
});

test("a completed review of the same bytes supersedes an older approval; writer order is not a new writer", () => {
  const d = repo("supersede");
  const env = { ...owner("supersede"), POLICY_CHAIN_AUTHOR_VENDORS: "claude,codex" };
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  assert.match(begin({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex, claude" }, d).out, /RECEIPT=reuse/);
  assert.match(begin({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "grok" }, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "0", "--result", result("sup", ["[should-fix] .agents/skills/demo/a.ts:1: x"]));
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out, "fresh", "the latest judgment of these bytes is the blocking one");
  assert.match(s.err, /1 must-fix\/should-fix/);
});

test("a full review's coverage is the range it actually read, base..head plus uncommitted", () => {
  const d = repo("headrange");
  const env = owner("headrange");
  const base = git(d, "rev-parse", "HEAD");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  git(d, "commit", "-qam", "a");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  git(d, "commit", "-qam", "b");
  const b = run(
    env,
    "begin",
    "--repo",
    d,
    "--tree",
    snap(d),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    base,
    "--head",
    "HEAD~1",
    "--scope",
    ".agents/skills/demo",
  );
  assert.match(b.out, /RECEIPT=review/);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("hr", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /not reviewed: \.agents\/skills\/demo\/b\.ts/);
});

test("every AGENTS.md above a changed path applies, the root included", () => {
  const d = repo("ancestors");
  const env = owner("ancestors");
  writeFileSync(join(d, "AGENTS.md"), "root rules\n");
  writeFileSync(join(d, ".agents/skills/AGENTS.md"), "skill rules\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "rules");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const decl = (deps: { id: string; path: string; why: string }[]) =>
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: deps, claims: [] })}\n<!-- /review-coverage -->\n`;
  writeFileSync(report, decl([{ id: "D1", path: ".agents/skills/AGENTS.md", why: "nearest" }]));
  const b = begin(env, d, "range", ["--report", report]);
  assert.equal(b.rc, 1);
  assert.match(b.err, /omits the applicable instruction AGENTS\.md/);
  writeFileSync(
    report,
    decl([
      { id: "D1", path: ".agents/skills/AGENTS.md", why: "nearest" },
      { id: "D2", path: "AGENTS.md", why: "root" },
    ]),
  );
  assert.match(begin(env, d, "range", ["--report", report]).out, /RECEIPT=review/);
});

// ── Round-2 audit findings ───────────────────────────────────────────────

test("a full review that ended before HEAD does not cover a file a later commit changed again", () => {
  const d = repo("headsame");
  const env = owner("headsame");
  const base = git(d, "rev-parse", "HEAD");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  git(d, "commit", "-qam", "a once");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  git(d, "commit", "-qam", "a twice");
  run(
    env,
    "begin",
    "--repo",
    d,
    "--tree",
    snap(d),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    base,
    "--head",
    "HEAD~1",
    "--scope",
    ".agents/skills/demo",
  );
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("hs", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /not reviewed: commits after the --head/);
});

test("a newly declared unchanged dependency is covered by the reviewer's check, not by the diff", () => {
  const d = repo("newdep");
  const env = owner("newdep");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const decl = (deps: unknown[]) =>
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: deps, claims: [] })}\n<!-- /review-coverage -->\n`;
  writeFileSync(report, decl([]));
  const t0 = snap(d);
  begin(env, d, "range", ["--report", report]);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("nd0", [])).out, "APPROVED=1");
  writeFileSync(report, decl([{ id: "D1", path: ".agents/skills/demo/b.ts", why: "a reads it" }]));
  begin(env, d, "since", ["--since", t0, "--report", report]);
  const checked = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result("nd1", [], [{ id: "D1", status: "checked", evidence: ["b.ts:1"] }]),
  );
  assert.equal(checked.out, "APPROVED=1", checked.err);
  // The same, reported unchecked: not reviewed.
  const d2 = repo("newdep2");
  const env2 = owner("newdep2");
  writeFileSync(join(d2, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report2 = join(d2, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report2), { recursive: true });
  writeFileSync(report2, decl([]));
  const u0 = snap(d2);
  begin(env2, d2, "range", ["--report", report2]);
  run(env2, "finish", "--repo", d2, "--rc", "0", "--result", result("nd2", []));
  writeFileSync(report2, decl([{ id: "D1", path: ".agents/skills/demo/b.ts", why: "a reads it", required: false }]));
  begin(env2, d2, "since", ["--since", u0, "--report", report2]);
  const un = run(
    env2,
    "finish",
    "--repo",
    d2,
    "--rc",
    "0",
    "--result",
    result("nd3", [], [{ id: "D1", status: "unchecked", evidence: ["no time"] }]),
  );
  assert.equal(un.out, "APPROVED=0");
  assert.match(un.err, /not reviewed: \.agents\/skills\/demo\/b\.ts/);
});

test("an inherited gap on the behavior contract clears when a round's diff carries the spec", () => {
  const d = repo("contract");
  const env = owner("contract");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  const spec = join(d, "projects/p/specs/001-x/spec.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(spec, "contract one\n");
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  begin(env, d, "range", ["--report", report]);
  run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ct0", []));
  writeFileSync(spec, "contract two\n");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", s1, "--report", report]);
  const gap = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ct1", []));
  assert.equal(gap.out, "APPROVED=0");
  assert.match(gap.err, /not reviewed: contract:/);
  const s2 = snap(d);
  writeFileSync(spec, "contract three\n");
  begin(env, d, "since", ["--since", s2, "--report", report]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ct2", []));
  assert.equal(f.out, "APPROVED=1", f.err);
});

// ── Round-3 audit finding ────────────────────────────────────────────────

test("a spec beside a product is reviewed through the declared item that names it", () => {
  const prod = repo("product");
  const wb = repo("product-wb");
  const env = owner("product");
  writeFileSync(join(prod, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(wb, "projects/p/specs/001-x/report.md");
  const spec = join(wb, "projects/p/specs/001-x/spec.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(spec, "contract one\n");
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: [{ id: "D1", path: "projects/p/specs/001-x/spec.md", repo: wb, why: "the contract" }], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  const cov = [{ id: "D1", status: "checked", evidence: ["spec.md"] }];
  begin(env, prod, "range", ["--report", report]);
  assert.equal(run(env, "finish", "--repo", prod, "--rc", "0", "--result", result("pr0", [], cov)).out, "APPROVED=1");
  writeFileSync(spec, "contract two\n");
  const t = snap(prod);
  writeFileSync(join(prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, prod, "since", ["--since", t, "--report", report]);
  const f = run(env, "finish", "--repo", prod, "--rc", "0", "--result", result("pr1", [], cov));
  assert.equal(f.out, "APPROVED=1", f.err);
});

// ── Contextium: the owner on any harness, and the fresh-context fallback ──

test("outside T3 with no CODE_REVIEW_LOOP_ID the owner is the close's thread id", () => {
  const d = repo("thread-owner");
  const env = { WORKBENCH_THREAD_ID: "close-thread-1" };
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const b = begin(env, d);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /RECEIPT=review/);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("thread-owner", []));
  assert.equal(f.out, "APPROVED=1", f.err);
  assert.ok(existsSync(join(HOME, ".cache/workbench/threads/close-thread-1/review.json")));
  const c = run({}, "check", "--owner", "close-thread-1", d);
  assert.equal(c.rc, 0, c.err);
  assert.match(c.out, /receipt from grok\/grok-4 covers this content/);
});

test("no independent vendor: pending, then the fresh-context fallback is recorded NOT independent", () => {
  const d = repo("fallback");
  const env = owner("fallback");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const reply = (name: string, text: string): string => {
    const f = join(TMP, `${name}.txt`);
    writeFileSync(f, text);
    return f;
  };
  // Without a pending attempt a fallback is refused: it never stands in for a
  // vendor that answered.
  approve(env, d, ["[must-fix] .agents/skills/demo/a.ts:1: wrong — fix — breaks"]);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  let b = begin(env, d);
  assert.match(b.out, /RECEIPT=review/);
  let f = run(env, "finish", "--repo", d, "--fallback", reply("early", "NO_FINDINGS\n"));
  assert.equal(f.rc, 1, "a fallback for an attempt the chain did not leave pending");
  assert.match(f.err, /not pending a fallback/);
  // Exit 3 leaves the attempt open and pending.
  f = run(env, "finish", "--repo", d, "--rc", "3");
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /pending the fresh-context fallback/);
  assert.equal(run(env, "status", "--repo", d).out, "fresh", "a pending attempt is not a receipt");
  // A reply that says nothing is a review that did not happen.
  f = run(env, "finish", "--repo", d, "--fallback", reply("prose", "looked fine to me\n"));
  assert.equal(f.rc, 1);
  assert.match(f.err, /did NOT happen/);
  // The reviewer's own format: fix-now blocks.
  f = run(
    env,
    "finish",
    "--repo",
    d,
    "--fallback",
    reply("verdict", "1. **bad**: `a.ts:1` — wrong — verdict: **fix-now** — violated rule: none — fix it\n"),
  );
  assert.equal(f.out, "APPROVED=0", f.err);
  assert.match(f.err, /must-fix\/should-fix finding\(s\) unresolved/);
  // A clean fallback of the next attempt approves, and every report says NOT independent.
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 4;\n");
  b = begin(env, d);
  assert.match(b.out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  f = run(env, "finish", "--repo", d, "--fallback", reply("clean", "Zero findings. Work is consistent.\n"));
  assert.equal(f.out, "APPROVED=1", f.err);
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out.split("\n")[0], "done");
  assert.match(s.out, /claude-fallback: fresh context, NOT independent/);
  const c = run({}, "check", "--owner", "fallback", d);
  assert.equal(c.rc, 0, c.err);
  assert.match(c.out, /NOT independent/);
  assert.match(begin(env, d).out, /NOTE: .*NOT independent/, "reuse says so too");
});
