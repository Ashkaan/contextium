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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("check: a project's own code is implementation source a receipt must cover", () => {
  const p = repo("project-code");
  const code = join(p, "projects/web/demo/scripts/main.ts");
  mkdirSync(dirname(code), { recursive: true });
  writeFileSync(code, "export const main = 1;\n");
  const report = join(p, "projects/web/demo/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "<!-- review-coverage:v1 -->\n{}\n<!-- /review-coverage -->\n");
  const c = run({}, "check", "--owner", "project-code", p);
  assert.equal(c.rc, 1, "project code with a coverage report and no receipt is refused");
  assert.match(c.err, /no review receipt for implementation source \(projects\/web\/demo\/scripts\/main\.ts\)/);
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

test("a fallback frame naming one item twice is refused, never the last entry wins", () => {
  const d = repo("fallback-dup");
  const env = owner("fallback-dup");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const f = join(TMP, "dup-frame.txt");
  writeFileSync(
    f,
    `BEGIN_REVIEW_V1\n${JSON.stringify({
      findings: "NO_FINDINGS",
      coverage: [
        { id: "E1", status: "unchecked", evidence: ["not read"] },
        { id: "E1", status: "checked", evidence: ["read"] },
      ],
    })}\nEND_REVIEW_V1\n`,
  );
  const r = run(env, "finish", "--repo", d, "--fallback", f);
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.err, /E1.*more than once|twice/);
});

test("a full review the fallback completed is spent, so a repeated full review is round 2", () => {
  const d = repo("fallback-spend");
  const env = owner("fallback-spend");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const f = join(TMP, "spend-clean.txt");
  writeFileSync(f, "NO_FINDINGS\n");
  assert.equal(run(env, "finish", "--repo", d, "--fallback", f).out, "APPROVED=1");
  const dir = join(TMP, "rounds-fallback-spend");
  assert.ok(
    readdirSync(dir).some((n) => n.endsWith(".full")),
    `the completed full review is marked spent in ${dir}: ${readdirSync(dir).join(" ")}`,
  );
});

// ── Pieces: piece-by-piece reviews approve together ──────────────────────
//
// A change too large for one review call is reviewed as pieces: full reviews
// over one base and head, each reading a disjoint list of the changed files.
// The receipt keeps the completed pieces and combines a set that read every
// changed file, at its current content, into one ordinary full-review receipt.

function pieceFile(paths: string[]): string {
  const f = join(TMP, `piece-${Math.random()}`);
  writeFileSync(f, paths.map((p) => `${p}\0`).join(""));
  return f;
}
interface PieceOpts {
  base?: string;
  head?: string;
  scope?: string;
  report?: string;
}
function beginPiece(env: NodeJS.ProcessEnv, dir: string, paths: string[], o: PieceOpts = {}): R {
  return run(
    env,
    "begin",
    "--repo",
    dir,
    "--tree",
    snap(dir),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    o.base ?? "HEAD",
    "--head",
    o.head ?? "HEAD",
    "--scope",
    o.scope ?? ".agents/skills/demo",
    "--slice",
    pieceFile(paths),
    ...(o.report ? ["--report", o.report] : []),
  );
}
function piece(
  env: NodeJS.ProcessEnv,
  dir: string,
  paths: string[],
  findings: string[] = [],
  o: PieceOpts & { coverage?: unknown[]; vendor?: string } = {},
): R {
  const b = beginPiece(env, dir, paths, o);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /RECEIPT=review/, b.err);
  return run(
    env,
    "finish",
    "--repo",
    dir,
    "--rc",
    "0",
    "--result",
    result(`p-${Math.random()}`, findings, o.coverage ?? [], o.vendor),
  );
}
const stateBytes = (id: string): string => {
  const f = join(HOME, ".cache/workbench/threads", id, "review.json");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
function edit(d: string, files: string[], v = 2): void {
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), `export const x = ${v};\n`);
  }
}
const A = ".agents/skills/demo/a.ts";
const B = ".agents/skills/demo/b.ts";
const C = ".agents/skills/demo/c.ts";
const D = ".agents/skills/demo/d.ts";
const REPORT = "projects/p/specs/001-x/report.md";
const declared = (scope: string): string =>
  `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope, entryPoints: [], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`;

test("pieces: two over one base and head approve together; the first alone names what is unread", () => {
  const d = repo("pc-two");
  const env = owner("pc-two");
  edit(d, [A, B]);
  const first = piece(env, d, [A]);
  assert.match(first.out, /^APPROVED=0$/m, first.err);
  assert.match(first.out, /^SLICE_PENDING=1$/m);
  assert.match(first.out, /^unread: \.agents\/skills\/demo\/b\.ts$/m);
  assert.doesNotMatch(first.err, /must-fix|not reviewed/, "pending files are not a failure");
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out, "fresh");
  assert.match(s.err, /pieces pending: 1 changed file\(s\) unread by any piece: \.agents\/skills\/demo\/b\.ts/);
  const c1 = run({}, "check", "--owner", "pc-two", d);
  assert.equal(c1.rc, 1);
  assert.match(c1.err, /unread by any piece: \.agents\/skills\/demo\/b\.ts/);
  const second = piece(env, d, [B]);
  assert.match(second.out, /^APPROVED=1$/m, second.err);
  assert.doesNotMatch(second.out, /SLICE_PENDING/);
  assert.equal(run({}, "check", "--owner", "pc-two", d).rc, 0, "the close accepts the combined receipt");
  const done = run(env, "status", "--repo", d);
  assert.equal(done.out.split("\n")[0], "done");
  assert.match(done.out, /in 2 pieces/);
  assert.match(begin(env, d).out, /RECEIPT=reuse/, "the combined receipt is reused like any other");
});

test("pieces: one piece listing every changed file approves on its own; four pieces approve", () => {
  const d = repo("pc-one");
  const env = owner("pc-one");
  edit(d, [A, B]);
  assert.match(piece(env, d, [A, B]).out, /^APPROVED=1$/m);
  const d4 = repo("pc-four");
  const env4 = owner("pc-four");
  edit(d4, [A, B, C, D]);
  for (const [i, f] of [A, B, C].entries()) {
    const r = piece(env4, d4, [f]);
    assert.match(r.out, /^APPROVED=0$/m);
    assert.match(r.out, new RegExp(`^SLICE_PENDING=${3 - i}$`, "m"));
  }
  assert.match(piece(env4, d4, [D]).out, /^APPROVED=1$/m);
  assert.equal(run({}, "check", "--owner", "pc-four", d4).rc, 0);
});

test("pieces: a bad piece is refused before any state change", () => {
  const d = repo("pc-bad");
  const env = owner("pc-bad");
  edit(d, [A, B, "journal/x.md"]);
  writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
  git(d, "add", ".agents/skills/demo/c.ts");
  git(d, "commit", "-qm", "c unchanged since");
  edit(d, [A, B]);
  assert.match(piece(env, d, [A]).out, /SLICE_PENDING=1/);
  const before = stateBytes("pc-bad");
  for (const [why, paths] of [
    ["overlap", [A]],
    ["not changed", [C]],
    ["record", ["journal/x.md"]],
    ["outside", ["../x.ts"]],
    ["absolute", ["/etc/passwd"]],
    ["empty", []],
  ] as const) {
    const r = beginPiece(env, d, [...paths]);
    assert.equal(r.rc, 2, `${why}: ${r.out} ${r.err}`);
    assert.doesNotMatch(r.out, /RECEIPT=/, why);
    assert.equal(stateBytes("pc-bad"), before, `${why}: the state is untouched`);
  }
  assert.match(beginPiece(env, d, [A]).err, /piece 1 already read \.agents\/skills\/demo\/a\.ts/);
  assert.match(beginPiece(env, d, [C]).err, /not changed since the branch base: \.agents\/skills\/demo\/c\.ts/);
  assert.match(beginPiece(env, d, ["journal/x.md"]).err, /a record/);
  assert.equal(
    run(env, "begin", "--repo", d, "--tree", snap(d), "--mode", "since", "--bucket", "build", "--slice", pieceFile([B]))
      .rc,
    2,
    "a piece is a full review",
  );
  assert.match(piece(env, d, [B]).out, /^APPROVED=1$/m, "the set still completes");
});

test("pieces: a different scope, writer set, declaration, base or head starts a new set", () => {
  for (const [what, second] of [
    ["scope", (env: NodeJS.ProcessEnv, d: string) => beginPiece(env, d, [B], { scope: ".agents/skills/other" })],
    [
      "writers",
      (env: NodeJS.ProcessEnv, d: string) => beginPiece({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex" }, d, [B]),
    ],
    ["base", (env: NodeJS.ProcessEnv, d: string) => beginPiece(env, d, [B], { base: "HEAD~1" })],
    ["head", (env: NodeJS.ProcessEnv, d: string) => beginPiece(env, d, [B], { head: "HEAD~1" })],
    [
      "declaration",
      (env: NodeJS.ProcessEnv, d: string) => {
        writeFileSync(join(d, REPORT), declared(".agents/skills/demo"));
        return beginPiece(env, d, [B], { report: join(d, REPORT) });
      },
    ],
  ] as const) {
    const d = repo(`pc-key-${what}`);
    const env = owner(`pc-key-${what}`);
    writeFileSync(join(d, ".agents/skills/demo/z.ts"), "export const z = 1;\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "z");
    edit(d, [A, B]);
    mkdirSync(dirname(join(d, REPORT)), { recursive: true });
    writeFileSync(join(d, REPORT), declared("s"));
    assert.match(piece(env, d, [A], [], { report: join(d, REPORT) }).out, /SLICE_PENDING=1/);
    const b = second(env, d);
    assert.equal(b.rc, 0, `${what}: ${b.err}`);
    assert.match(b.err, new RegExp(`1 earlier piece\\(s\\) no longer count: the ${what} differs`), `${what}: ${b.err}`);
    const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result(`k-${what}`, []));
    assert.match(f.out, /^APPROVED=0$/m, what);
    assert.match(f.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m, `${what}: the earlier piece no longer counts`);
  }
});

test("pieces: two explicit bases sharing one branch base are different sets", () => {
  const d = repo("pc-bases");
  const env = owner("pc-bases");
  const c0 = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", c0);
  writeFileSync(join(d, ".agents/skills/demo/z.ts"), "export const z = 1;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "z");
  const c1 = git(d, "rev-parse", "HEAD");
  edit(d, [A, B]);
  assert.match(piece(env, d, [A, ".agents/skills/demo/z.ts"], [], { base: c0 }).out, /SLICE_PENDING=1/);
  const b = beginPiece(env, d, [B], { base: c1 });
  assert.match(b.err, /no longer count: the base differs/);
});

test("pieces: a file edited after its piece is unread until a piece reads it again", () => {
  const d = repo("pc-moved");
  const env = owner("pc-moved");
  edit(d, [A, B]);
  piece(env, d, [A]);
  edit(d, [A], 3);
  const second = piece(env, d, [B]);
  assert.match(second.out, /^APPROVED=0$/m);
  assert.match(second.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m);
  const again = piece(env, d, [A]);
  assert.match(again.out, /^APPROVED=1$/m, again.err);
});

test("pieces: a commit between pieces leaves the set unapproved with the head reason", () => {
  const d = repo("pc-commit");
  const env = owner("pc-commit");
  const base = git(d, "rev-parse", "HEAD");
  edit(d, [A, B]);
  git(d, "commit", "-qam", "work");
  const head = git(d, "rev-parse", "HEAD");
  piece(env, d, [A], [], { base, head });
  writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "later");
  const f = piece(env, d, [B, C], [], { base, head });
  assert.match(f.out, /^APPROVED=0$/m);
  assert.match(f.err, /not reviewed: commits after the --head/);
  assert.equal(run({}, "check", "--owner", "pc-commit", d).rc, 1);
});

test("pieces: a blocker in one piece rides into the combined receipt and a --since round closes it", () => {
  const d = repo("pc-blocker");
  const env = owner("pc-blocker");
  edit(d, [A, B]);
  const blocker = "[must-fix] .agents/skills/demo/a.ts:1: wrong — fix — breaks";
  const p1 = piece(env, d, [A], [blocker]);
  assert.match(p1.out, /SLICE_PENDING=1/);
  assert.match(p1.out, /^SLICE_BLOCKED=1$/m, "a finding is not merely pending");
  const p2 = piece(env, d, [B], ["[nit] tidy"]);
  assert.match(p2.out, /^APPROVED=0$/m);
  assert.doesNotMatch(p2.out, /SLICE_PENDING/, "the set is complete");
  assert.match(p2.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  const t = snap(d);
  edit(d, [A], 4);
  const b = begin(env, d, "since", ["--since", t]);
  const open = JSON.parse(readFileSync(b.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8")).openFindings;
  assert.deepEqual(open, [blocker], "the follow-up is shown the combined receipt's open finding");
  assert.match(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("pcb", [])).out, /^APPROVED=1$/m);
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out.split("\n")[0], "done", s.err);
});

test("pieces: a declared item counts from the piece that checked it, and not after its file moved", () => {
  const mk = (name: string): { d: string; env: NodeJS.ProcessEnv; report: string } => {
    const d = repo(name);
    writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "c");
    edit(d, [A, B]);
    const report = join(d, "projects/p/specs/001-x/report.md");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(
      report,
      `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [{ id: "E1", path: A }], dependencies: [{ id: "D1", path: C, why: "a reads it" }], claims: [] })}\n<!-- /review-coverage -->\n`,
    );
    return { d, env: owner(name), report };
  };
  const cov = (e1: string, d1: string) => [
    { id: "E1", status: e1, evidence: ["x"] },
    { id: "D1", status: d1, evidence: ["x"] },
  ];
  const ok = mk("pc-items");
  piece(ok.env, ok.d, [A], [], { report: ok.report, coverage: cov("checked", "unchecked") });
  const f = piece(ok.env, ok.d, [B], [], { report: ok.report, coverage: cov("unchecked", "checked") });
  assert.match(f.out, /^APPROVED=1$/m, f.err);
  const moved = mk("pc-items-moved");
  piece(moved.env, moved.d, [A], [], { report: moved.report, coverage: cov("checked", "checked") });
  edit(moved.d, [C], 5);
  const g = piece(moved.env, moved.d, [B, C], [], { report: moved.report, coverage: cov("unchecked", "unchecked") });
  assert.match(g.out, /^APPROVED=0$/m);
  assert.match(g.err, /no piece checked D1 at its current content/);
  const none = mk("pc-items-none");
  piece(none.env, none.d, [A], [], { report: none.report, coverage: cov("checked", "unchecked") });
  const h = piece(none.env, none.d, [B], [], { report: none.report, coverage: cov("checked", "unchecked") });
  assert.match(h.out, /^APPROVED=0$/m);
  assert.match(h.err, /no piece checked D1/);
});

test("pieces: a listed file the reviewed diff did not hold stays unread", () => {
  const d = repo("pc-absent");
  const env = owner("pc-absent");
  git(d, "update-ref", "refs/remotes/origin/main", git(d, "rev-parse", "HEAD"));
  edit(d, [A]);
  git(d, "commit", "-qam", "a");
  const c1 = git(d, "rev-parse", "HEAD");
  edit(d, [B]);
  const f = piece(env, d, [A, B], [], { base: c1 });
  assert.match(f.out, /^APPROVED=0$/m);
  assert.match(f.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m, "a.ts was listed but base..head did not hold it");
});

test("pieces: two of three done — status and check name only the third piece's files", () => {
  const d = repo("pc-three");
  const env = owner("pc-three");
  edit(d, [A, B, C]);
  piece(env, d, [A]);
  piece(env, d, [B]);
  const s = run(env, "status", "--repo", d);
  assert.match(s.err, /unread by any piece: \.agents\/skills\/demo\/c\.ts$/m);
  assert.doesNotMatch(s.err, /a\.ts|b\.ts/);
  const c = run({}, "check", "--owner", "pc-three", d);
  assert.equal(c.rc, 1);
  assert.match(c.err, /\.agents\/skills\/demo\/c\.ts/);
  assert.doesNotMatch(c.err, /\.agents\/skills\/demo\/[ab]\.ts/);
});

test("pieces: a failed, interrupted or unrecorded piece keeps the earlier pieces and records no read", () => {
  const d = repo("pc-fail");
  const env = owner("pc-fail");
  edit(d, [A, B]);
  piece(env, d, [A]);
  // A chain failure.
  assert.equal(beginPiece(env, d, [B]).rc, 0);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "1").out, "APPROVED=0");
  // An interrupted piece: begun, never finished — the next begin replaces it.
  assert.equal(beginPiece(env, d, [B]).rc, 0);
  let c = run({}, "check", "--owner", "pc-fail", d);
  assert.match(c.err, /unread by any piece: \.agents\/skills\/demo\/b\.ts/);
  assert.doesNotMatch(c.err, /a\.ts/, "piece 1 still counts");
  // An unreadable result.
  const bad = join(TMP, "unreadable.json");
  writeFileSync(bad, "{nope");
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", bad).out, "APPROVED=0");
  // A state write that fails while combining.
  assert.equal(beginPiece(env, d, [B]).rc, 0);
  const dir = join(HOME, ".cache/workbench/threads/pc-fail");
  const before = stateBytes("pc-fail");
  chmodSync(dir, 0o555);
  let w: R;
  try {
    w = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("pcw", []));
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.equal(w.rc, 1);
  assert.equal(w.out, "APPROVED=0");
  assert.equal(stateBytes("pc-fail"), before, "nothing was recorded");
  c = run({}, "check", "--owner", "pc-fail", d);
  assert.doesNotMatch(c.err, /a\.ts/, "piece 1 still counts");
  assert.match(piece(env, d, [B]).out, /^APPROVED=1$/m, "the retry completes the set");
});

test("pieces: a writer answering one piece blocks the combined receipt", () => {
  const d = repo("pc-writer");
  const env = { ...owner("pc-writer"), POLICY_CHAIN_AUTHOR_VENDORS: "codex" };
  edit(d, [A, B]);
  piece(env, d, [A], [], { vendor: "codex/gpt" });
  const f = piece(env, d, [B]);
  assert.match(f.out, /^APPROVED=0$/m);
  assert.match(f.err, /the reviewer codex\/gpt is one of the writers/);
});

test("pieces: an unsliced full review after a partial set replaces it", () => {
  const d = repo("pc-replace");
  const env = owner("pc-replace");
  edit(d, [A, B]);
  piece(env, d, [A]);
  const b = begin(env, d);
  assert.match(b.err, /1 earlier piece\(s\) no longer count: a full review reads the whole change/);
  assert.match(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("rep", [])).out, /^APPROVED=1$/m);
  assert.equal(run({}, "check", "--owner", "pc-replace", d).rc, 0);
});

test("pieces: names with spaces, tabs and newlines stay one path each", () => {
  const d = repo("pc-names");
  const env = owner("pc-names");
  const odd = [".agents/skills/demo/sp ace.ts", ".agents/skills/demo/t\tab.ts", ".agents/skills/demo/new\nline.ts"];
  edit(d, odd);
  const p1 = piece(env, d, [odd[0] as string]);
  assert.match(p1.out, /SLICE_PENDING=2/);
  assert.match(p1.out, /^unread: "\.agents\/skills\/demo\/new\\nline\.ts"$/m, "a newline in a name cannot split its line");
  assert.match(p1.out, /^unread: "\.agents\/skills\/demo\/t\\tab\.ts"$/m);
  piece(env, d, [odd[1] as string]);
  assert.match(piece(env, d, [odd[2] as string]).out, /^APPROVED=1$/m);
});

test("pieces: state written before pieces existed reads as no set", () => {
  const d = repo("pc-legacy");
  const env = owner("pc-legacy");
  edit(d, [A]);
  approve(env, d);
  const f = join(HOME, ".cache/workbench/threads/pc-legacy/review.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  for (const rs of Object.values(st.repos) as Record<string, unknown>[]) delete rs.slices;
  writeFileSync(f, JSON.stringify(st));
  assert.equal(run(env, "status", "--repo", d).out.split("\n")[0], "done");
});

test("pieces: a follow-up round built on one piece of an incomplete set approves nothing", () => {
  const d = repo("pc-since");
  const env = owner("pc-since");
  edit(d, [A, B]);
  piece(env, d, [A]);
  const t = snap(d);
  edit(d, [A], 3);
  assert.match(begin(env, d, "since", ["--since", t]).out, /RECEIPT=review/);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("pcs", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /built on one piece of an incomplete piece set/);
});

// ── Findings from the pieces change's own review ─────────────────────────

test("pieces: claims sharing one evidence file each stay bound to it", () => {
  const d = repo("pc-shared-ev");
  const env = owner("pc-shared-ev");
  edit(d, [A, B]);
  const ev = "projects/p/specs/001-x/evidence/runs.md";
  mkdirSync(dirname(join(d, ev)), { recursive: true });
  writeFileSync(join(d, ev), "red then green\n");
  const report = join(d, REPORT);
  const claim = (id: string) => ({
    id,
    claim: `claim ${id}`,
    negativeTest: { trigger: "t", expected: "e", evidence: [ev] },
  });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [], claims: [claim("C1"), claim("C2")] })}\n<!-- /review-coverage -->\n`,
  );
  const cov = (c1: string, c2: string) => [
    { id: "C1", status: c1, evidence: ["x"] },
    { id: "C2", status: c2, evidence: ["x"] },
  ];
  // Piece 1 checks C1 against the evidence as it was; the evidence then moves,
  // and piece 2 checks only C2 against the new bytes.
  piece(env, d, [A], [], { report, coverage: cov("checked", "unchecked") });
  writeFileSync(join(d, ev), "red then green, rewritten\n");
  const f = piece(env, d, [B], [], { report, coverage: cov("unchecked", "checked") });
  assert.match(f.out, /^APPROVED=0$/m, "C1 was checked against evidence that has since moved");
  assert.match(f.err, /no piece checked C1 at its current content/);
});

test("pieces: a piece whose result names no reviewer is not kept and reads nothing", () => {
  const d = repo("pc-novendor");
  const env = owner("pc-novendor");
  edit(d, [A, B]);
  assert.equal(beginPiece(env, d, [A]).rc, 0);
  const anon = join(TMP, "anon.json");
  writeFileSync(anon, JSON.stringify({ findings: [], coverage: [] }));
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", anon);
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /no answering reviewer/);
  const second = piece(env, d, [B]);
  assert.match(second.out, /^APPROVED=0$/m, "the anonymous piece's file is still unread");
  assert.match(second.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m);
});
