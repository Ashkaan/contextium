// code-review.test.ts — the INCREMENTAL review modes (`--snapshot`, `--since`),
// which stop the fix loop from re-reading settled code every round.
//
// The vendor-chain behaviors of this same script (fall-through on a dead or hung
// primary, hard failure on exhaustion, `--fixture`, the diff-byte budget) are
// asserted in policy-chain.test.ts's "caller-scoped rows" section and are NOT
// duplicated here — one fact, one home. What lives here is everything about
// WHICH BYTES reach the reviewer, which that suite does not look at.
//
// It also pins the BLAST-RADIUS PACK — the caller context
// blast-radius.ts computes and this script splices into SUBJECT. Same question,
// same reason: the packer has its own suite for whether the pack is RIGHT, and
// what lives here is whether it reaches the prompt, stays scoped on `--since`,
// and fails open when it cannot run.
//
// Every case drives a stub vendor that dumps its stdin, so the assertions are
// about the prompt actually sent, not about what a live model said. No case
// needs auth, quota, or a network. The stand-in packers are small .ts programs,
// because code-review.ts runs its packer with node.
//
// The snapshot ledger lives in this suite's own scratch dir
// (CODE_REVIEW_SNAP_STATE_DIR) for every call, so a run never reads or writes the
// ledger of the session running it.
//
// The cases share one scratch repo and run in order, as the bash suite did:
// each section builds on the commits and edits of the one before it.
//
// Run: node --test --experimental-strip-types .agents/skills/review/code-review.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
// node:sqlite through a child Node that has it (tests/sqlite-child.ts): on
// Node 22.5–22.12 it loads only behind a flag this suite cannot give itself.
import { DatabaseSync } from "../close/scripts/tests/sqlite-child.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(SCRIPT_DIR, "code-review.ts");

const TMP = mkdtempSync(join(tmpdir(), "code-review-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── Fixtures ──────────────────────────────────────────────────────────

const POLICY = `${TMP}/policy.json`;
writeFileSync(
  POLICY,
  `{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    }
  }
}
`,
);

function exe(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Model resolution reads a vendor's live catalog; these cases stub the vendor,
// so they stub the resolver too (POLICY_CHAIN_RESOLVER, policy-chain.ts). It
// resolves the fixture families the way a real catalog would and
// fails a family named `unresolvable-{v}`.
exe(
  `${TMP}/resolve-model.sh`,
  `#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2 in the $1 catalog" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
`,
);

// Dumps the prompt it was handed, then reviews clean. Every assertion about what
// the reviewer SAW reads the dump.
const SEEN = `${TMP}/seen.txt`;
const STUB = `${TMP}/dump-prompt.sh`;
exe(STUB, `#!/usr/bin/env bash\ncat > "${SEEN}"\necho NO_FINDINGS\n`);

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  POLICY_CHAIN_AUTHOR_VENDORS: "claude",
  HOME: TMP,
  T3CODE_HOME: `${TMP}/absent-t3`,
  WORKBENCH_THREAD_ID: "",
  POLICY_CHAIN_RESOLVER: `${TMP}/resolve-model.sh`,
  CODE_REVIEW_SNAP_STATE_DIR: `${TMP}/snaps`,
  // Every loop below walks a 4-round ceiling, which keeps this suite inside the
  // close's 180 s per suite; "the shipped ceiling" walks the real one.
  CODE_REVIEW_MAX_ROUNDS: "4",
};

// A scratch repo standing in for a session worktree: two committed files, so a
// later `--since` diff can be shown to carry ONE of them and not the other.
const REPO = `${TMP}/repo`;
mkdirSync(REPO, { recursive: true });
function g(...args: string[]): string {
  const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
  return (r.stdout ?? "").replace(/\n+$/, "");
}
g("init", "-q", ".");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
writeFileSync(`${REPO}/alpha.txt`, "alpha one\nalpha two\nalpha three\n");
writeFileSync(`${REPO}/beta.txt`, "beta one\nbeta two\nbeta three\n");
writeFileSync(`${REPO}/.gitignore`, "ignored/\n");
g("add", "-A");
g("commit", "-qm", "init");

interface Result {
  rc: number | null;
  out: string;
  err: string;
}
function review(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Result {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", REVIEW, ...args], {
    encoding: "utf8",
    env,
    cwd,
    timeout: 120_000,
    maxBuffer: 1 << 26,
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

test("original-author exclusion reaches the executable review and missing provenance refuses it", () => {
  const fixture = join(SCRIPT_DIR, "tests/fixtures/planted-bugs");
  const env = { ...BASE_ENV, POLICY_JSON: POLICY, CODEX_BIN: STUB, GROK_BIN: STUB };
  const r = review(["--fixture", fixture], { ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex" });
  assert.equal(r.rc, 0, r.err);
  assert.match(r.err, /excluded codex\/codex: artifact author/);
  assert.match(r.err, /answered: grok\//);
  const missing: NodeJS.ProcessEnv = { ...env };
  delete missing.POLICY_CHAIN_AUTHOR_VENDORS;
  const refused = review(["--fixture", fixture], missing);
  assert.equal(refused.rc, 2, refused.err);
  assert.match(refused.err, /original-author provenance/);
  writeFileSync(SEEN, "");
});
// Each call is its own fix loop, with its own round state in this suite's
// scratch dir. A repeated full review of one owner spends a round
// (it no longer resets the loop), so cases that only look at WHICH BYTES reach
// the reviewer must not share a counter, or the sixth full review in the file
// would be refused at the ceiling for a reason unrelated to its assertion.
let LOOP = 0;
// The shipped ceiling as the program states it — read from its text, never
// imported — and the lowered one BASE_ENV sets for every other loop here.
const SHIPPED = Number(
  /^const MAX_ROUNDS = (\d+);$/m.exec(readFileSync(new URL("./code-review.ts", import.meta.url), "utf8"))?.[1],
);
assert.ok(SHIPPED > 4, "code-review.ts states a MAX_ROUNDS ceiling above the suite's lowered one");
const MAX = 4;
/** Round numbers a..b, inclusive. */
const upTo = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function runReview(args: string[], extra: NodeJS.ProcessEnv = {}): Result {
  LOOP += 1;
  return review(args, {
    ...BASE_ENV,
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/rounds-${LOOP}`,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
    ...extra,
  });
}
function snapshot(): string {
  return review(["--snapshot"], { ...BASE_ENV, CODEX_REVIEW_REPO: REPO }).out.replace(/\n+$/, "");
}
const seen = (): string => (existsSync(SEEN) ? readFileSync(SEEN, "utf8").replace(/\n+$/, "") : "");

test("T3 identity enforces the review ceiling and isolates another thread without Claude ids", () => {
  const env = {
    ...BASE_ENV,
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    WORKBENCH_THREAD_ID: "t3-ceiling-test",
    CODEX_REVIEW_REPO: REPO,
    CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/t3-rounds`,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  };
  for (const round of upTo(2, MAX + 1)) {
    const snap = review(["--snapshot"], env);
    assert.equal(snap.rc, 0, snap.err);
    appendFileSync(`${REPO}/alpha.txt`, `T3 round ${round}\n`);
    const result = review(["--since", snap.out.trim()], env);
    assert.equal(result.rc, round === MAX + 1 ? 5 : 0, result.err);
  }
  const other = { ...env, WORKBENCH_THREAD_ID: "t3-other-thread" };
  const snap = review(["--snapshot"], other);
  appendFileSync(`${REPO}/alpha.txt`, "other T3 thread\n");
  assert.equal(review(["--since", snap.out.trim()], other).rc, 0);
  writeFileSync(SEEN, "");
});

test("fresh T3 review children share only their declared audit owner's round budget", () => {
  const base = {
    ...BASE_ENV,
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    CODE_REVIEW_LOOP_ID: "original-audit-owner",
    CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/delegated-rounds`,
  };
  for (const round of upTo(2, MAX + 1)) {
    const env = { ...base, WORKBENCH_THREAD_ID: `thread:fresh-review-child:${round}` };
    const snap = review(["--snapshot"], env);
    appendFileSync(`${REPO}/alpha.txt`, `delegated review round ${round}\n`);
    const result = review(["--since", snap.out.trim()], env);
    assert.equal(result.rc, round === MAX + 1 ? 5 : 0, result.err);
  }
  const other = { ...base, CODE_REVIEW_LOOP_ID: "another-audit-owner", WORKBENCH_THREAD_ID: "thread:another-review" };
  const snap = review(["--snapshot"], other);
  appendFileSync(`${REPO}/alpha.txt`, "other audit's independent budget\n");
  assert.equal(review(["--since", snap.out.trim()], other).rc, 0);
  writeFileSync(SEEN, "");
});

test("T3 child composition requires explicit writer and owner before spending a round, and binds issued snapshots", () => {
  const home = join(TMP, "composition-t3");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata/statev2.sqlite"));
  db.exec(
    "create table orchestration_v2_projection_threads(thread_id text,title text,created_at text,deleted_at text,payload_json text); create table orchestration_v2_projection_provider_sessions(thread_id text,provider text,driver text)",
  );
  for (const [id, provider] of [
    ["writer-owner", "codex"],
    ["another-owner", "codex"],
    ["review-child", "grok"],
  ]) {
    db.prepare("insert into orchestration_v2_projection_threads values (?,'fixture','0',null,?)").run(
      id,
      JSON.stringify({ worktreePath: REPO, branch: "fixture" }),
    );
    db.prepare("insert into orchestration_v2_projection_provider_sessions values (?,?,?)").run(id, provider, provider);
  }
  db.close();
  const rounds = join(TMP, "composition-rounds");
  const inContext = (args: string[], context: NodeJS.ProcessEnv) => review(args, context, REPO);
  const env = {
    ...BASE_ENV,
    T3CODE_HOME: home,
    WORKBENCH_THREAD_ID: "review-child",
    CODE_REVIEW_LOOP_ID: "writer-owner",
    POLICY_CHAIN_AUTHOR_THREAD_ID: "writer-owner",
    POLICY_CHAIN_AUTHOR_VENDORS: "codex",
    CODEX_REVIEW_REPO: REPO,
    CODE_REVIEW_ROUND_STATE_DIR: rounds,
    CODE_REVIEW_SNAP_STATE_DIR: join(TMP, "composition-snaps"),
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  };
  const tree = g("rev-parse", "HEAD^{tree}");
  appendFileSync(`${REPO}/alpha.txt`, "T3 composition fixture\n");
  const missingOwner = inContext(["--since", tree], { ...env, CODE_REVIEW_LOOP_ID: "" });
  assert.equal(missingOwner.rc, 2, missingOwner.err);
  assert.match(missingOwner.err, /CODE_REVIEW_LOOP_ID/);
  const ambiguousOwner = inContext(["--since", tree], { ...env, CODE_REVIEW_LOOP_ID: "", WORKBENCH_THREAD_ID: "" });
  assert.equal(ambiguousOwner.rc, 2, ambiguousOwner.err);
  assert.match(ambiguousOwner.err, /CODE_REVIEW_LOOP_ID/);
  const missingWriter = inContext(["--since", tree], {
    ...env,
    POLICY_CHAIN_AUTHOR_THREAD_ID: "",
    POLICY_CHAIN_AUTHOR_VENDORS: "grok",
  });
  assert.equal(missingWriter.rc, 2, missingWriter.err);
  assert.match(missingWriter.err, /POLICY_CHAIN_AUTHOR_THREAD_ID/);
  const wrongAuthors = inContext(["--since", tree], { ...env, POLICY_CHAIN_AUTHOR_VENDORS: "grok" });
  assert.equal(wrongAuthors.rc, 2, wrongAuthors.err);
  assert.match(wrongAuthors.err, /recorded.*codex/);
  assert.deepEqual(existsSync(rounds) ? readdirSync(rounds) : [], [], "input failures spend no review round");
  const unissued = inContext(["--since", tree], env);
  assert.equal(unissued.rc, 2, unissued.err);
  assert.match(unissued.err, /never issued/);
  const snap = inContext(["--snapshot"], env);
  assert.equal(snap.rc, 0, snap.err);
  const clone = join(TMP, "composition-other-repo");
  assert.equal(spawnSync("git", ["clone", "-q", "--shared", REPO, clone]).status, 0);
  const wrongRepo = inContext(["--since", snap.out.trim()], { ...env, CODEX_REVIEW_REPO: clone });
  assert.equal(wrongRepo.rc, 2, wrongRepo.err);
  assert.match(wrongRepo.err, /never issued/);
  appendFileSync(`${REPO}/alpha.txt`, "only these fixes were reviewed\n");
  const otherOwner = inContext(["--since", snap.out.trim()], { ...env, CODE_REVIEW_LOOP_ID: "another-owner" });
  assert.equal(otherOwner.rc, 2, otherOwner.err);
  const good = inContext(["--since", snap.out.trim()], env);
  assert.equal(good.rc, 0, good.err);
  assert.match(good.err, /answered: grok\//);
  writeFileSync(SEEN, "");
});

function rcIs(name: string, expect: number, got: number | null): void {
  assert.equal(got, expect, `${name} — expected rc=${expect}, got rc=${got}`);
}
function has(name: string, needle: string, hay: string): void {
  assert.ok(hay.includes(needle), `${name} — missing '${needle}'`);
}
function lacks(name: string, needle: string, hay: string): void {
  assert.ok(!hay.includes(needle), `${name} — unexpected '${needle}'`);
}
function eq(name: string, expect: string | number, got: string | number): void {
  assert.equal(got, expect, `${name} — expected '${expect}', got '${got}'`);
}

// ── --snapshot ────────────────────────────────────────────────────────

let SNAP_UNTRACKED = "";

test("--snapshot", () => {
  const SNAP0 = snapshot();
  assert.match(SNAP0, /^[0-9a-f]{40}$/, `snapshot prints a 40-hex object id — got '${SNAP0}'`);
  eq("snapshot's object is a tree", "tree", g("cat-file", "-t", SNAP0));

  // The script runs mid-session against uncommitted work, so a snapshot that
  // disturbed the session's own git state would be worse than no snapshot at all.
  appendFileSync(`${REPO}/beta.txt`, "staged edit\n");
  g("add", "beta.txt");
  const HEAD_BEFORE = g("rev-parse", "HEAD");
  const STATUS_BEFORE = g("status", "--porcelain");
  const STASH_BEFORE = g("stash", "list");
  const BETA_BEFORE = readFileSync(`${REPO}/beta.txt`, "utf8");
  snapshot();
  eq("snapshot leaves HEAD alone", HEAD_BEFORE, g("rev-parse", "HEAD"));
  eq("snapshot leaves the index alone", STATUS_BEFORE, g("status", "--porcelain"));
  eq("snapshot leaves the stash alone", STASH_BEFORE, g("stash", "list"));
  eq("snapshot leaves the working tree alone", BETA_BEFORE, readFileSync(`${REPO}/beta.txt`, "utf8"));

  // Untracked capture is the reason this is not `git stash create`: a file a fix
  // round CREATES must not read as new surface in every round after it.
  g("reset", "-q", "--hard");
  writeFileSync(`${REPO}/helper.txt`, "untracked helper\n");
  mkdirSync(`${REPO}/ignored`, { recursive: true });
  writeFileSync(`${REPO}/ignored/junk.txt`, "noise\n");
  SNAP_UNTRACKED = snapshot();
  const TREE_FILES = g("ls-tree", "-r", "--name-only", SNAP_UNTRACKED);
  has("snapshot captures untracked files", "helper.txt", TREE_FILES);
  lacks("snapshot honors .gitignore", "ignored/junk.txt", TREE_FILES);
});

test("--since: the converged case, and the delta only", () => {
  let r = runReview(["--since", SNAP_UNTRACKED]);
  rcIs("--since with nothing changed exits 4 (converged)", 4, r.rc);
  has("the converged exit says so", "converged", r.err);
  eq("the converged exit spends no vendor call", "", seen());

  const SNAP1 = snapshot();
  writeFileSync(`${REPO}/alpha.txt`, "alpha one\nalpha two FIXED\nalpha three\n");
  r = runReview(["--since", SNAP1]);
  rcIs("--since with a fix reviews and exits 0", 0, r.rc);
  const SEEN_TEXT = seen();
  has("the fixed file reaches the reviewer", "alpha two FIXED", SEEN_TEXT);
  // The point of the whole change: settled code stops being re-sent every round.
  lacks("the untouched file does NOT reach the reviewer", "beta two", SEEN_TEXT);
  has("the reviewer is told this is a follow-up round", "FOLLOW-UP ROUND", SEEN_TEXT);
  has("the follow-up brief asks about fix-induced defects", "introduce a NEW defect", SEEN_TEXT);
  // AGENTS.md § Standards names no validation library; neither may the reviewer.
  lacks("the conventions do not demand Zod", "Zod", SEEN_TEXT);
  has("the conventions still ask for validation at the boundary", "validated at every boundary", SEEN_TEXT);

  // A file created BY a fix round belongs in that round's diff — and, once
  // snapshotted, must not reappear in the next one.
  const SNAP2 = snapshot();
  writeFileSync(`${REPO}/created-by-fix.ts`, "export const shared = 1\n");
  r = runReview(["--since", SNAP2]);
  rcIs("a file created by a fix round is reviewable", 0, r.rc);
  has("the newly created file reaches the reviewer", "created-by-fix.ts", seen());

  const SNAP3 = snapshot();
  r = runReview(["--since", SNAP3]);
  rcIs("the created file does not re-review forever", 4, r.rc);
});

test("a git read that FAILS is not 'nothing changed'", () => {
  // A failed `git diff` read as empty would print "converged" (exit 4) — an
  // APPROVE over a review that never compared anything. It is a failed review.
  const fakegit = `${TMP}/fakegit`;
  mkdirSync(fakegit, { recursive: true });
  const realgit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  exe(
    `${fakegit}/git`,
    `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated $a failure" >&2; exit 128; fi
done
exec "${realgit}" "$@"
`,
  );
  const PATHX = `${fakegit}:${process.env.PATH ?? ""}`;
  const SNAP_GF = snapshot();
  appendFileSync(`${REPO}/created-by-fix.ts`, "export const afterGitFail = 1\n");
  let r = runReview(["--since", SNAP_GF], { PATH: PATHX, FAKE_GIT_FAIL: "diff" });
  rcIs("a failed git diff on --since is exit 1, not converged", 1, r.rc);
  has("…and names the failed read", "git diff failed", r.err);
  r = runReview(["HEAD", "HEAD"], { PATH: PATHX, FAKE_GIT_FAIL: "diff" });
  rcIs("a failed git diff on a full review is exit 1", 1, r.rc);
  has("…and names the failed read", "git diff failed", r.err);

  // The blast-radius pack's own diff read fails open — the review still runs —
  // but it says so: silently incomplete caller context is not acceptable.
  exe(
    `${fakegit}/git`,
    `#!/usr/bin/env bash
if [ "$*" = "\${FAKE_GIT_FAIL_ARGV:-}" ]; then echo "fatal: simulated failure" >&2; exit 128; fi
exec "${realgit}" "$@"
`,
  );
  writeFileSync(`${REPO}/pack-probe.ts`, "export const packProbe = 1\n");
  g("add", "-A");
  g("commit", "-qm", "pack-probe");
  const PACK_BASE = g("rev-parse", "HEAD~1");
  r = runReview(["HEAD~1", "HEAD"], { PATH: PATHX, FAKE_GIT_FAIL_ARGV: `diff ${PACK_BASE}` });
  rcIs("a failed pack diff still reviews (fails open)", 0, r.rc);
  has("…and says the caller context is incomplete", "blast-radius diff could not be read", r.err);

  // A failed `git add -A` inside the snapshot leaves the temp index at HEAD's
  // tree, and writing that tree anyway reads as "nothing changed" — a false
  // converged (exit 4) over an edit the snapshot never staged.
  const SNAP_ADD = snapshot();
  appendFileSync(`${REPO}/pack-probe.ts`, "export const afterAddFail = 1\n");
  r = runReview(["--since", SNAP_ADD], { PATH: PATHX, FAKE_GIT_FAIL_ARGV: "add -A" });
  rcIs("a failed git add in the --since snapshot is exit 2, not converged", 2, r.rc);
  has("…and says the snapshot failed", "could not snapshot the working tree", r.err);
  const snapFail = review(["--snapshot"], {
    ...BASE_ENV,
    CODEX_REVIEW_REPO: REPO,
    PATH: PATHX,
    FAKE_GIT_FAIL_ARGV: "add -A",
  });
  rcIs("a failed git add in --snapshot is exit 2", 2, snapFail.rc);
});

test("--since: caller errors, and the byte budget", () => {
  let r = runReview(["--since", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
  rcIs("an unresolvable --since tree is a caller error", 2, r.rc);
  has("the caller error names the snapshot contract", "written by --snapshot", r.err);

  r = runReview(["--since"]);
  rcIs("--since with no tree is a caller error", 2, r.rc);

  // An over-budget follow-up is refused rather than truncated, exactly as the full
  // review is — a partial review reported as clean is the failure this script exists
  // to prevent, and the follow-up path must not be the hole in it.
  const SNAP4 = snapshot();
  writeFileSync(`${REPO}/big.txt`, "x".repeat(2000));
  r = review(["--since", SNAP4], {
    ...BASE_ENV,
    CODEX_REVIEW_MAX_DIFF_BYTES: "500",
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  });
  rcIs("an over-budget follow-up is refused, not truncated", 1, r.rc);
  has("the refusal says why", "Refusing rather than reviewing a truncated slice", r.err);
});

// ── The round ceiling ───────────────────────────────────────────────────
//
// The skill's prose said "stop" before this script did, and a 34-round audit is
// what that was worth. These cases assert the mechanism, not the instruction.

const CEIL_STATE = `${TMP}/rounds`;
let CEIL_ERR = "";
function ceilReview(snap: string, sid = "ceiling-test", extra: string[] = []): Result {
  return review(["--since", snap, ...extra], {
    ...BASE_ENV,
    CODE_REVIEW_ROUND_STATE_DIR: CEIL_STATE,
    CLAUDE_CODE_SESSION_ID: sid,
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  });
}
// Each round needs a real edit, or the converged exit fires before the ceiling.
function ceilRound(n: number | string): number | null {
  const snap = snapshot();
  appendFileSync(`${REPO}/alpha.txt`, `round ${n} edit\n`);
  const r = ceilReview(snap);
  CEIL_ERR = r.err;
  return r.rc;
}

test("the round ceiling", () => {
  for (const n of upTo(2, MAX)) rcIs(`round ${n} is allowed`, 0, ceilRound(n));
  has("the last allowed round says it is the last", `round ${MAX} of at most ${MAX}`, CEIL_ERR);
  rcIs(`round ${MAX + 1} is refused`, 5, ceilRound(MAX + 1));
  has("the refusal names the reason", "re-opens ground", CEIL_ERR);
  has("the refusal says what to do instead", "what is still open", CEIL_ERR);

  // A refused round must not have spent the call it was refusing.
  writeFileSync(SEEN, "");
  ceilRound(MAX + 2);
  eq("a refused round spends no vendor call", "", seen());

  // A converged round is not a round — otherwise a clean loop would burn ceiling
  // budget it never used.
  rmSync(CEIL_STATE, { recursive: true, force: true });
  const SNAP_CONV = snapshot();
  const r = ceilReview(SNAP_CONV);
  rcIs("a converged round exits 4, not 5", 4, r.rc);
  const files = existsSync(CEIL_STATE) ? readdirSync(CEIL_STATE) : [];
  const first =
    files.length > 0 ? (readFileSync(join(CEIL_STATE, files[0] as string), "utf8").split("\n")[0] ?? "") : "0";
  eq("a converged round does not consume ceiling budget", "0", first);

  // No session id: the owner is the close's thread id (thread.ts generates one
  // once and remembers it for the tree), so the cap still holds on a harness
  // that exports none.
  const NOSID_STATE = `${TMP}/nosid-rounds`;
  const nosidRound = (n: number): number | null => {
    const env = {
      ...BASE_ENV,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
      CONTEXTIUM_SESSION: "",
      CODEX_REVIEW_REPO: REPO,
    };
    const snap = review(["--snapshot"], env).out.replace(/\n+$/, "");
    appendFileSync(`${REPO}/alpha.txt`, `no-session round ${n} edit\n`);
    return review(["--since", snap], {
      ...env,
      CODE_REVIEW_ROUND_STATE_DIR: NOSID_STATE,
      POLICY_JSON: POLICY,
      CODEX_BIN: STUB,
      GROK_BIN: STUB,
    }).rc;
  };
  rcIs("no session id: round 2 is allowed", 0, nosidRound(2));
  rcIs("no session id: round 3 is allowed", 0, nosidRound(3));
  rcIs("no session id: round 4 is allowed", 0, nosidRound(4));
  rcIs("no session id: round 5 is still refused", 5, nosidRound(5));
  eq(
    "no session id: the counter is keyed on the generated thread id",
    "session-",
    (readdirSync(NOSID_STATE).find((n) => n.startsWith("session-")) ?? "").slice(0, 8),
  );

  // Sessions are independent: one session's loop cannot exhaust another's budget.
  rmSync(CEIL_STATE, { recursive: true, force: true });
  for (const n of upTo(2, MAX)) ceilRound(n);
  const SNAP_OTHER = snapshot();
  appendFileSync(`${REPO}/alpha.txt`, "other session edit\n");
  rcIs("a second session starts at round 2", 0, ceilReview(SNAP_OTHER, "a-different-session").rc);
});

test("the shipped ceiling is MAX_ROUNDS, and the override cannot raise it", () => {
  rmSync(CEIL_STATE, { recursive: true, force: true });
  const walk = (n: number): Result => {
    const snap = snapshot();
    appendFileSync(`${REPO}/alpha.txt`, `shipped round ${n} edit\n`);
    return review(["--since", snap], {
      ...BASE_ENV,
      CODE_REVIEW_MAX_ROUNDS: "50",
      CODE_REVIEW_ROUND_STATE_DIR: CEIL_STATE,
      CLAUDE_CODE_SESSION_ID: "shipped-ceiling",
      CODEX_REVIEW_REPO: REPO,
      POLICY_JSON: POLICY,
      CODEX_BIN: STUB,
      GROK_BIN: STUB,
    });
  };
  let last: Result | null = null;
  for (const n of upTo(2, SHIPPED)) {
    last = walk(n);
    rcIs(`shipped round ${n} is allowed`, 0, last.rc);
  }
  has("the last one says the shipped ceiling", `round ${SHIPPED} of at most ${SHIPPED}`, last?.err ?? "");
  rcIs("a value that would raise the ceiling is ignored", 5, walk(SHIPPED + 1).rc);
  rmSync(CEIL_STATE, { recursive: true, force: true });
});

// ── One final review past the ceiling ─────────────────────────────────
// Round 4's fixes used to ship unreviewed: the ceiling refused round 5 and the
// skill said stop, so final fixes were either approved without review or the
// loop stalled on them. `--final` reviews just those fixes, once.
function finalRound(n: string, sid = "ceiling-test"): Result {
  const snap = snapshot();
  appendFileSync(`${REPO}/alpha.txt`, `final ${n} edit\n`);
  return ceilReview(snap, sid, ["--final"]);
}
test("past the ceiling, --final reviews the outstanding fixes exactly once", () => {
  rmSync(CEIL_STATE, { recursive: true, force: true });
  const early = finalRound("early");
  rcIs("--final before the ceiling is a caller error", 2, early.rc);
  has("and says a normal round is the call", "normal round", early.err);

  rmSync(CEIL_STATE, { recursive: true, force: true });
  for (const n of upTo(2, MAX)) ceilRound(n);
  rcIs("the round past the ceiling is still refused", 5, ceilRound(MAX + 1));
  has("the refusal points at the final review", "--final", CEIL_ERR);

  writeFileSync(SEEN, "");
  const fin = finalRound("one");
  rcIs("the final review runs past the ceiling", 0, fin.rc);
  has("the reviewer is told it is the final pass", "FINAL REVIEW", seen());

  writeFileSync(SEEN, "");
  const again = finalRound("two");
  rcIs("a second final review is refused", 5, again.rc);
  has("and says why", "final review already ran", again.err);
  eq("a refused final review spends no vendor call", "", seen());
});

// ── One fix loop per repo ─────────────────────────────────────────────
//
// A row whose code is in another repo reviews each repo as its own loop
// (CODEX_REVIEW_REPO). Keyed on the session alone, the loops shared one budget:
// a row that reviewed three repos in parallel had the third round of each
// refused as "round 5" after one
// follow-up apiece — and each repo's full review reset the others' counts.
test("each repo's fix loop has its own ceiling", () => {
  rmSync(CEIL_STATE, { recursive: true, force: true });
  const REPO2 = `${TMP}/repo2`;
  mkdirSync(REPO2, { recursive: true });
  const g2 = (...args: string[]) => spawnSync("git", ["-C", REPO2, ...args], { encoding: "utf8" });
  g2("init", "-q", ".");
  g2("config", "user.email", "t@t");
  g2("config", "user.name", "t");
  writeFileSync(`${REPO2}/gamma.txt`, "gamma\n");
  g2("add", "-A");
  g2("commit", "-qm", "init");
  const env2 = {
    ...BASE_ENV,
    CODE_REVIEW_ROUND_STATE_DIR: CEIL_STATE,
    CLAUDE_CODE_SESSION_ID: "ceiling-test",
    CODEX_REVIEW_REPO: REPO2,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  };
  const round2 = (n: number): number | null => {
    // Taken as snapshot() takes them, so this repo adds nothing to the test
    // session's snapshot ledger that the first repo's rounds are checked against.
    const snap = review(["--snapshot"], { ...BASE_ENV, CODEX_REVIEW_REPO: REPO2 }).out.replace(/\n+$/, "");
    appendFileSync(`${REPO2}/gamma.txt`, `round ${n} edit\n`);
    return review(["--since", snap], env2).rc;
  };
  rcIs("the first repo's loop runs to its ceiling", 0, ceilRound(2));
  for (const n of upTo(3, MAX)) ceilRound(n);
  rcIs("the second repo's first fix round is round 2, not past the ceiling", 0, round2(2));
  for (const n of upTo(3, MAX - 1)) round2(n);
  rcIs("and its own last round is allowed", 0, round2(MAX));
  rcIs("the round past it is refused like any other", 5, round2(MAX + 1));
  rcIs("the first repo is still at its own ceiling", 5, ceilRound(MAX + 1));
});

// ── Round 1 is unchanged ──────────────────────────────────────────────
//
// The two-arg form is what every round-1 review and every existing caller uses;
// adding the incremental modes must not have moved it.
test("round 1 is unchanged", () => {
  g("add", "-A");
  g("commit", "-qm", "second");
  const r = runReview(["HEAD~1", "HEAD"]);
  rcIs("the two-arg full review still works", 0, r.rc);
  const SEEN_TEXT = seen();
  has("the full review carries the committed range", "CHANGED FILES (committed range)", SEEN_TEXT);
  lacks("the full review is not framed as a follow-up", "FOLLOW-UP ROUND", SEEN_TEXT);
});

// ── A repeated full review is a round, never a new loop ───────────────
//
// A full review used to reset the loop's counter, so a full retry of the
// SAME change bought four more rounds and another final pass: the ceiling
// bounded nothing. One owner's implementation task is one loop now; a second
// full review spends a round like a --since does, and a genuinely new change
// starts in a new owning thread with its own counter.
function fullReview(env: NodeJS.ProcessEnv = {}): Result {
  return review(["HEAD~1", "HEAD"], {
    ...BASE_ENV,
    CODE_REVIEW_ROUND_STATE_DIR: CEIL_STATE,
    CLAUDE_CODE_SESSION_ID: "ceiling-test",
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
    ...env,
  });
}
test("a repeated full review spends a round and never resets the loop", () => {
  rmSync(CEIL_STATE, { recursive: true, force: true });
  rcIs("the first full review is round 1", 0, fullReview().rc);
  const retry = fullReview();
  rcIs("a full retry of the same loop runs", 0, retry.rc);
  has("and is counted as round 2", `round 2 of at most ${MAX}`, retry.err);
  rcIs("so the next follow-up is round 3", 0, ceilRound(3));
  for (const n of upTo(4, MAX)) rcIs(`and round ${n}`, 0, ceilRound(n));
  rcIs("and the round past the ceiling is refused, as without the retry", 5, ceilRound(MAX + 1));
  writeFileSync(SEEN, "");
  const again = fullReview();
  rcIs("a full review cannot renew a spent budget", 5, again.rc);
  has("and says the full review is not a new loop", "does not start a new loop", again.err);
  eq("the refused full review spends no vendor call", "", seen());
  rcIs("the one final review is still available", 0, finalRound("after a refused full review").rc);
});

test("a full review the chain never answered spends nothing; one it answered is round 1", () => {
  const dir = `${TMP}/unanswered-rounds`;
  const dead = `${TMP}/dead-vendor.sh`;
  exe(dead, "#!/usr/bin/env bash\nexit 1\n");
  const env = {
    CODE_REVIEW_ROUND_STATE_DIR: dir,
    CLAUDE_CODE_SESSION_ID: "unanswered",
    CODEX_BIN: dead,
    GROK_BIN: dead,
  };
  rcIs("a dead chain fails the review", 1, fullReview(env).rc);
  const ok = fullReview({ CODE_REVIEW_ROUND_STATE_DIR: dir, CLAUDE_CODE_SESSION_ID: "unanswered" });
  rcIs("the retry after a dead chain runs", 0, ok.rc);
  lacks("and is still round 1", "round 2", ok.err);
});

test("the counters are durable under the owner's thread cache and carry a /tmp counter's spend", () => {
  const home = `${TMP}/durable-home`;
  const owner = `durable-owner-${process.pid}`;
  const env = {
    ...BASE_ENV,
    HOME: home,
    CODE_REVIEW_ROUND_STATE_DIR: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODE_REVIEW_LOOP_ID: owner,
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  };
  const legacyDir = "/tmp/code-review-rounds";
  // The key code-review.ts has always used: loop-<sha256(owner)>-<repo hash>.
  const sid = `loop-${createHash("sha256").update(owner).digest("hex")}`;
  const key = `${sid}-${createHash("sha256").update(realpathSync(REPO)).digest("hex").slice(0, 12)}`;
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(`${legacyDir}/${key}`, `${MAX - 2}\n`);
  try {
    const snap = review(["--snapshot"], env).out.trim();
    appendFileSync(`${REPO}/alpha.txt`, "durable edit\n");
    const r = review(["--since", snap], env);
    rcIs("a /tmp counter at MAX - 2 makes the next follow-up the last round", 0, r.rc);
    has("and says so", `round ${MAX} of at most ${MAX}`, r.err);
    const durable = `${home}/.cache/workbench/threads/${owner}/review-rounds/${key}`;
    eq("the spend is written durably under the owner", String(MAX - 1), readFileSync(durable, "utf8").trim());
    rmSync(`${legacyDir}/${key}`, { force: true });
    const snap2 = review(["--snapshot"], env).out.trim();
    appendFileSync(`${REPO}/alpha.txt`, "durable edit 2\n");
    rcIs(
      `with /tmp cleared (a reboot) the durable counter still refuses round ${MAX + 1}`,
      5,
      review(["--since", snap2], env).rc,
    );

    writeFileSync(durable, "garbage\n");
    const snap3 = review(["--snapshot"], env).out.trim();
    appendFileSync(`${REPO}/alpha.txt`, "durable edit 3\n");
    const corrupt = review(["--since", snap3, "--final"], env);
    rcIs("an unreadable counter is spent, never zero", 5, corrupt.rc);
    has("and says why", "unreadable", corrupt.err);

    // A registered audit whose counter vanished is spent too — even with an
    // older /tmp counter still on disk, which is behind what was spent since.
    rmSync(durable, { force: true });
    writeFileSync(`${legacyDir}/${key}`, "1\n");
    const state = `${home}/.cache/workbench/threads/${owner}/review.json`;
    writeFileSync(
      state,
      JSON.stringify({
        version: 1,
        owner,
        repos: {
          [realpathSync(REPO)]: {
            required: true,
            base: "",
            scope: "",
            report: null,
            registeredAt: "",
            spendInit: { build: true, qa: true },
          },
        },
      }),
    );
    const snap4 = review(["--snapshot"], env).out.trim();
    appendFileSync(`${REPO}/alpha.txt`, "durable edit 4\n");
    const missing = review(["--since", snap4], env);
    rcIs("a counter missing after the audit registered one is spent", 5, missing.rc);
    has("and says why", "missing although this audit registered one", missing.err);
  } finally {
    rmSync(`${legacyDir}/${key}`, { force: true });
  }
});

// ── Receipt mode: one framed reply, split before the finding parser ────
const RESULT = `${TMP}/result.json`;
const ITEMS = `${TMP}/items.json`;
writeFileSync(
  ITEMS,
  JSON.stringify({
    items: [
      { id: "E1", text: "entry point a.ts" },
      { id: "C1", text: "claim x" },
    ],
  }),
);
function framed(reply: string, extra: NodeJS.ProcessEnv = {}): Result & { result: string } {
  const stub = `${TMP}/framed-${createHash("sha256").update(reply).digest("hex").slice(0, 8)}.sh`;
  writeFileSync(`${stub}.reply`, reply);
  exe(stub, `#!/usr/bin/env bash\ncat > "${SEEN}"\ncat "${stub}.reply"\n`);
  rmSync(RESULT, { force: true });
  const r = runReview(["HEAD~1", "HEAD"], {
    CODEX_BIN: stub,
    GROK_BIN: stub,
    CODE_REVIEW_RESULT_FILE: RESULT,
    CODE_REVIEW_COVERAGE_FILE: ITEMS,
    ...extra,
  });
  return { ...r, result: existsSync(RESULT) ? readFileSync(RESULT, "utf8") : "" };
}
const frame = (obj: unknown, pre = "", post = ""): string =>
  `${pre}BEGIN_REVIEW_V1\n${typeof obj === "string" ? obj : JSON.stringify(obj)}\nEND_REVIEW_V1\n${post}`;
const cov = [
  { id: "E1", status: "checked", evidence: ["a.ts:1 [must-fix] text inside evidence is not a finding"] },
  { id: "C1", status: "unchecked", evidence: ["NO_FINDINGS appears here too"] },
];

test("receipt mode: a clean frame is a clean review, and the result records coverage", () => {
  const r = framed(frame({ findings: "NO_FINDINGS", coverage: cov }, "[must-fix] narration before the frame\n"));
  rcIs("a clean frame exits 0", 0, r.rc);
  eq("stdout stays triage lines only — empty on a clean review", "", r.out);
  has("the reviewer was asked for the frame", "BEGIN_REVIEW_V1", seen());
  has("and given the coverage items", "- E1: entry point a.ts", seen());
  const res = JSON.parse(r.result);
  eq("no finding is read from the evidence or the narration", 0, res.findings.length);
  eq("the coverage is recorded", "checked,unchecked", res.coverage.map((c: { status: string }) => c.status).join(","));
  has("with the answering vendor", "codex/", res.vendor);
});

test("receipt mode: findings come only from the findings field", () => {
  const r = framed(frame({ findings: "[must-fix] a.ts:1: broken — fix — crash\n[nit] tidy", coverage: cov }));
  rcIs("findings exit 0", 0, r.rc);
  eq("stdout carries exactly the two lines", "[must-fix] a.ts:1: broken — fix — crash\n[nit] tidy\n", r.out);
  eq("the result carries them too", 2, JSON.parse(r.result).findings.length);
});

test("receipt mode: a malformed frame is not a review", () => {
  for (const [name, reply] of [
    ["no frame (the old triage format)", "NO_FINDINGS\n"],
    [
      "two frames",
      frame({ findings: "NO_FINDINGS", coverage: cov }) + frame({ findings: "NO_FINDINGS", coverage: cov }),
    ],
    ["a duplicate key", frame(`{"findings":"NO_FINDINGS","findings":"[nit] x","coverage":${JSON.stringify(cov)}}`)],
    [
      "an unknown item",
      frame({ findings: "NO_FINDINGS", coverage: [...cov, { id: "Z9", status: "checked", evidence: [] }] }),
    ],
    ["a missing item", frame({ findings: "NO_FINDINGS", coverage: [cov[0]] })],
    ["a bad status", frame({ findings: "NO_FINDINGS", coverage: [cov[0], { ...cov[1], status: "maybe" }] })],
    ["an extra key", frame({ findings: "NO_FINDINGS", coverage: cov, note: "x" })],
    ["empty findings", frame({ findings: "", coverage: cov })],
    ["narration as findings", frame({ findings: "Reading the files", coverage: cov })],
    ["a sentinel beside a finding", frame({ findings: "NO_FINDINGS\n[nit] x", coverage: cov })],
    [
      "over 64 KiB",
      frame({ findings: "NO_FINDINGS", coverage: [cov[0], { ...cov[1], evidence: Array(40).fill("x".repeat(3000)) }] }),
    ],
  ] as const) {
    const r = framed(reply);
    rcIs(`${name}: not a review`, 1, r.rc);
    eq(`${name}: no result is written`, "", r.result);
    eq(`${name}: nothing on stdout`, "", r.out);
  }
});

// ── The blast-radius pack reaches the reviewer ────────────────────────

// Every case below is its OWN fix loop, not a fifth round of one, so each gets a
// fresh round counter. Sharing the ceiling budget with the sections above made
// these fail with exit 5 for a reason that has nothing to do with the pack.
const PACK_ROUNDS = `${TMP}/pack-rounds`;
function packReview(args: string[], packer?: string, extra: NodeJS.ProcessEnv = {}): Result {
  rmSync(PACK_ROUNDS, { recursive: true, force: true });
  return review(args, {
    ...BASE_ENV,
    ...(packer !== undefined ? { CODE_REVIEW_BLAST_RADIUS: packer } : {}),
    CODE_REVIEW_ROUND_STATE_DIR: PACK_ROUNDS,
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
    ...extra,
  });
}

test("the blast-radius pack reaches the reviewer", () => {
  // Everything above this point edits .txt files, so the pack is empty for all of
  // it — which is itself the first assertion: a change in no packable language
  // must not put an empty heading in front of the reviewer.
  lacks("a .txt-only change carries no pack", "BLAST RADIUS", seen());

  // A .ts change with a real caller in another file. This is the finding class the
  // pack exists for: the caller lives in a file the diff never mentions.
  mkdirSync(`${REPO}/pack`, { recursive: true });
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 1\n}\n");
  writeFileSync(`${REPO}/pack/consumer.ts`, "import { packedThing } from './api'\nexport const used = packedThing()\n");
  g("add", "pack");
  g("commit", "-qm", "pack-fixture");

  const SNAP_PACK = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 2\n}\n");
  let r = packReview(["--since", SNAP_PACK]);
  rcIs("a .ts change reviews normally with a pack attached", 0, r.rc);
  let SEEN_TEXT = seen();
  has("the pack reaches the reviewer", "BLAST RADIUS", SEEN_TEXT);
  has("the pack names the changed symbol", "packedThing", SEEN_TEXT);
  has("the pack names the caller the diff never shows", "pack/consumer.ts", SEEN_TEXT);
  // Order matters: the pack is context for the diff, so it must arrive before it.
  const lines = SEEN_TEXT.split("\n");
  const packAt = lines.findIndex((l) => l.includes("BLAST RADIUS"));
  const diffAt = lines.findIndex((l) => l.startsWith("DIFF:"));
  assert.ok(
    packAt >= 0 && diffAt >= 0 && packAt < diffAt,
    `the pack sits between the file list and DIFF: — pack at '${packAt + 1}', DIFF at '${diffAt + 1}'`,
  );

  // A follow-up round packs only ITS files. Re-packing the settled ones would put
  // back exactly the code `--since` exists to keep out.
  const SNAP_SCOPE = snapshot();
  writeFileSync(`${REPO}/pack/later.ts`, "export function laterThing() {\n  return 3\n}\n");
  r = packReview(["--since", SNAP_SCOPE]);
  rcIs("the follow-up round reviews the new file", 0, r.rc);
  SEEN_TEXT = seen();
  has("the follow-up pack names this round's symbol", "laterThing", SEEN_TEXT);
  eq(
    "the follow-up pack does NOT re-pack the settled file",
    0,
    SEEN_TEXT.split("\n").filter((l) => l === "pack/api.ts").length,
  );

  g("add", "pack");
  g("commit", "-qm", "pack-second");
});

// ── The pack fails open ───────────────────────────────────────────────
//
// Unknown callers are not a defect, so a packer that is missing or broken costs
// the review its extra context and NOTHING else. A packer failure that took a
// real review down would be strictly worse than having no packer.
test("the pack fails open", () => {
  const SNAP_MISSING = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 4\n}\n");
  let r = packReview(["--since", SNAP_MISSING], `${TMP}/definitely-not-here.ts`);
  rcIs("a missing packer still reviews", 0, r.rc);
  let SEEN_TEXT = seen();
  has("a missing packer still sends the diff", "DIFF:", SEEN_TEXT);
  lacks("a missing packer sends no pack", "BLAST RADIUS", SEEN_TEXT);
  has("a missing packer says so on stderr", "no blast-radius packer", r.err);

  const BROKEN = `${TMP}/broken-packer.ts`;
  writeFileSync(BROKEN, 'process.stderr.write("packer broke\\n");\nprocess.exitCode = 2;\n');
  const SNAP_BROKEN = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 5\n}\n");
  r = packReview(["--since", SNAP_BROKEN], BROKEN);
  rcIs("a packer exiting 2 still reviews", 0, r.rc);
  has("a packer exiting 2 still sends the diff", "DIFF:", seen());
  has("a packer exiting 2 says so on stderr", "exited 2", r.err);

  // A packer that prints nothing (nothing to say about this change) must not leave
  // an empty heading behind.
  const QUIET = `${TMP}/quiet-packer.ts`;
  writeFileSync(QUIET, "process.exitCode = 0;\n");
  const SNAP_QUIET = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 6\n}\n");
  r = packReview(["--since", SNAP_QUIET], QUIET);
  rcIs("an empty pack still reviews", 0, r.rc);
  SEEN_TEXT = seen();
  lacks("an empty pack leaves no heading", "BLAST RADIUS", SEEN_TEXT);
});

// ── The packer's cap holds against a packer that ignores TERM ─────────
//
// The cap is what keeps a stuck packer from holding the review; TERM alone
// waited on one that ignored it for as long as it chose to run.
test("a packer that ignores TERM is KILLed at its cap, and the review goes on", () => {
  const STUCK = `${TMP}/stuck-packer.ts`;
  writeFileSync(STUCK, 'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 12_000);\n');
  const SNAP_STUCK = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 7\n}\n");
  const start = Date.now();
  const r = packReview(["--since", SNAP_STUCK], STUCK, { CODE_REVIEW_BLAST_RADIUS_TIMEOUT_S: "1" });
  const elapsed = (Date.now() - start) / 1000;
  rcIs("a stuck packer still reviews", 0, r.rc);
  has("a stuck packer is reported as a timeout", "packer timed out after 1s", r.err);
  assert.ok(elapsed < 10, `a TERM-ignoring packer held the review ${elapsed}s past its 1s cap`);
});

// ── The range-mode pack gets ONE diff, not a concatenation ────────────
//
// The review body glues `base..head` onto `HEAD..working-tree`. For a file
// touched in BOTH, the committed hunks' new-side line numbers index the HEAD
// version while the packer parses the WORKING TREE — so a working-tree insertion
// above them shifts every committed coordinate and the lookup lands somewhere
// else entirely. The symbol that actually changed is then never named, and its
// callers never reach the reviewer: a pack that is confidently about the wrong
// code.
//
// The fixture makes the miss total rather than partial. The committed edit is
// ADD-ONLY, so there is no removed line for the old-side text match to rescue it
// with, and the working tree then prepends 40 lines.
test("the range-mode pack gets ONE diff, not a concatenation", () => {
  mkdirSync(`${REPO}/skew`, { recursive: true });
  let api = "";
  for (let i = 1; i <= 5; i++) api += `export const base${String(i).padStart(2, "0")} = ${i}\n`;
  api += "export function deepSymbol() {\n  return 1\n}\n";
  api += "export function tailSymbol() {\n  return 2\n}\n";
  writeFileSync(`${REPO}/skew/api.ts`, api);
  writeFileSync(`${REPO}/skew/consumer.ts`, "import { deepSymbol } from './api'\nexport const used = deepSymbol()\n");
  g("add", "skew");
  g("commit", "-qm", "skew-base");
  const SKEW_BASE = g("rev-parse", "HEAD");

  const s = readFileSync(`${REPO}/skew/api.ts`, "utf8");
  writeFileSync(`${REPO}/skew/api.ts`, s.replaceAll("  return 1\n", "  const extra = 42\n  return 1\n"));
  g("add", "skew/api.ts");
  g("commit", "-qm", "skew-insert");

  let pad = "";
  for (let i = 1; i <= 40; i++) pad += `export const newpad${String(i).padStart(2, "0")} = ${i}\n`;
  writeFileSync(`${REPO}/skew/api.ts`, pad + readFileSync(`${REPO}/skew/api.ts`, "utf8"));

  const r = packReview([SKEW_BASE, "HEAD"]);
  rcIs("a range with committed+uncommitted work reviews", 0, r.rc);
  const SEEN_TEXT = seen();
  has("the pack names the symbol the committed hunk changed", "deepSymbol — callers:", SEEN_TEXT);
  has("and its caller, which the diff never shows", "skew/consumer.ts", SEEN_TEXT);

  g("checkout", "-q", "--", "skew/api.ts");
});

// ── The packer is bounded, and its stderr is not swallowed ────────────
//
// "Fail open" has to include failing to FINISH: optional context that hangs is
// blocking the review it was only meant to enrich.
test("the packer is bounded, and its stderr is not swallowed", () => {
  const HANG = `${TMP}/hanging-packer.ts`;
  writeFileSync(HANG, "setTimeout(() => {}, 30_000);\n");
  const SNAP_HANG = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 8\n}\n");
  const start = Date.now();
  let r = packReview(["--since", SNAP_HANG], HANG, { CODE_REVIEW_BLAST_RADIUS_TIMEOUT_S: "2" });
  const elapsed = Math.floor((Date.now() - start) / 1000);
  rcIs("a hanging packer still reviews", 0, r.rc);
  assert.ok(elapsed < 20, `the packer timeout is enforced — took ${elapsed}s`);
  has("the timeout says so", "timed out", r.err);
  has("and the diff still reached the reviewer", "DIFF:", seen());

  // A packer that WARNs (a parser that fell back to regex, say) must have that
  // warning reach a human. Dropping it makes a degraded pack look like a good one.
  const NOISY = `${TMP}/noisy-packer.ts`;
  writeFileSync(
    NOISY,
    'process.stderr.write("blast-radius: WARN the parser fell back to regex\\n");\nprocess.stdout.write("BLAST RADIUS\\nnoisy/file.ts\\n");\n',
  );
  const SNAP_NOISY = snapshot();
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 9\n}\n");
  r = packReview(["--since", SNAP_NOISY], NOISY);
  rcIs("a warning packer still reviews", 0, r.rc);
  has("the packer's warning reaches stderr", "fell back to regex", r.err);
  has("and its pack still reaches the reviewer", "BLAST RADIUS", seen());
});

// ── --fixture gets no pack ────────────────────────────────────────────
//
// There is no working tree behind a fixture directory, so there is nothing to
// compute a blast radius from.
test("--fixture gets no pack; the two-arg full review carries one", () => {
  const FIXTURE = `${TMP}/fixture`;
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(`${FIXTURE}/thing.ts`, "export function fixtureThing() {\n  return 1\n}\n");
  let r = packReview(["--fixture", FIXTURE]);
  rcIs("a fixture review still works", 0, r.rc);
  let SEEN_TEXT = seen();
  has("the fixture files reach the reviewer", "fixtureThing", SEEN_TEXT);
  lacks("a fixture review carries no pack", "BLAST RADIUS", SEEN_TEXT);

  // ── The two-arg full review carries a pack too ──
  g("add", "pack");
  g("commit", "-qm", "pack-third");
  writeFileSync(`${REPO}/pack/api.ts`, "export function packedThing() {\n  return 7\n}\n");
  g("add", "pack/api.ts");
  g("commit", "-qm", "pack-fourth");
  r = packReview(["HEAD~1", "HEAD"]);
  rcIs("the two-arg full review still works with a pack", 0, r.rc);
  SEEN_TEXT = seen();
  has("the full review carries the pack", "BLAST RADIUS", SEEN_TEXT);
  has("the full review's pack names the caller", "pack/consumer.ts", SEEN_TEXT);
  has("the full review still carries the committed range", "CHANGED FILES (committed range)", SEEN_TEXT);
});

// ── A name git would C-quote reaches the reviewer and the pack ─────────
// Without -z, `ls-files --others` prints `"caf\303\251.ts"`, and
// `diff --no-index` on that missing path drops the file from the reviewed diff;
// a name holding a newline split into two records on its way to the packer.
test("an untracked file with a quoted name is in the reviewed diff and the pack", () => {
  writeFileSync(`${REPO}/pack/café.ts`, "export function cafeThing() {\n  return 1\n}\n");
  writeFileSync(`${REPO}/pack/nl\nname.ts`, "export function newlineThing() {\n  return 2\n}\n");
  try {
    const r = packReview(["HEAD", "HEAD"]);
    rcIs("the review of an untracked quoted name runs", 0, r.rc);
    const SEEN_TEXT = seen();
    has("the file list names the file as it is on disk", "pack/café.ts", SEEN_TEXT);
    has("the untracked file's body is in the reviewed diff", "return 1", SEEN_TEXT);
    // The pack alone: both symbols are in the diff body too.
    const PACK = SEEN_TEXT.slice(SEEN_TEXT.indexOf("BLAST RADIUS"), SEEN_TEXT.indexOf("\nDIFF:"));
    has("the pack names its symbol", "cafeThing —", PACK);
    has("a name holding a newline reaches the pack as one file", "newlineThing —", PACK);
  } finally {
    rmSync(`${REPO}/pack/café.ts`, { force: true });
    rmSync(`${REPO}/pack/nl\nname.ts`, { force: true });
  }
});

// ── Companion worktrees: the other half of a cross-repo change ──
// A change reviewed from the product repo had the reviewer read the LANDED
// workbench for the workbench half — findings about code the active worktree
// had already changed.
test("companion worktrees reach the reviewer, named with their branch; a non-repo is refused", () => {
  const COMP = `${TMP}/companion`;
  mkdirSync(COMP, { recursive: true });
  const gc = (...args: string[]) => spawnSync("git", ["-C", COMP, ...args], { encoding: "utf8" });
  gc("init", "-q", "-b", "t3/companion-half", ".");
  gc("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c");
  writeFileSync(`${REPO}/companion-subject.txt`, "under review\n");
  g("add", "companion-subject.txt");
  g("commit", "-qm", "companion subject");
  let r = runReview(["HEAD~1", "HEAD"], { CODEX_REVIEW_COMPANIONS: COMP });
  rcIs("a review with a companion still works", 0, r.rc);
  const SEEN_TEXT = seen();
  has("the prompt names the companion section", "COMPANION WORKTREES", SEEN_TEXT);
  has("the prompt names the companion path", COMP, SEEN_TEXT);
  has("the prompt names the companion branch", "t3/companion-half", SEEN_TEXT);
  has("the prompt says to read it, not the landed checkout", "which does not carry this change yet", SEEN_TEXT);

  r = runReview(["HEAD~1", "HEAD"], { CODEX_REVIEW_COMPANIONS: `${TMP}/no-such-worktree` });
  rcIs("a companion that is not a git repo is refused", 2, r.rc);
  has("the refusal names the path", `${TMP}/no-such-worktree`, r.err);
});

// ── No repo anywhere: a one-line failure, never the script's own checkout ──
// A cwd outside any repo must not fall back to the folder above the script —
// the main checkout, the tree a session never touched.
test("no repo anywhere: a one-line failure", (t) => {
  if (spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: TMP, stdio: "ignore" }).status === 0) {
    t.skip(`${TMP} is inside a git checkout; skipping the no-repo case`);
    return;
  }
  const env: NodeJS.ProcessEnv = { ...BASE_ENV };
  delete env.CODEX_REVIEW_REPO;
  let r = review(["HEAD~1", "HEAD"], env, TMP);
  rcIs("outside any repo with no CODEX_REVIEW_REPO: exit 2", 2, r.rc);
  has("and the line names the cause", "code-review: not inside a git repository", r.err);
  // --fixture reads a directory, not a repo, so it runs from anywhere; the
  // usage line likewise. Neither may die on the repo check first.
  r = review([], env, TMP);
  rcIs("usage outside any repo is still the usage line", 2, r.rc);
  has("and prints it", "Usage:", r.err);
  lacks("not the repo error", "not inside a git repository", r.err);
  mkdirSync(`${TMP}/fixture-norepo`, { recursive: true });
  writeFileSync(`${TMP}/fixture-norepo/thing.ts`, "export function norepoThing() {\n  return 1\n}\n");
  r = review(["--fixture", `${TMP}/fixture-norepo`], { ...env, CODEX_BIN: STUB, GROK_BIN: STUB }, TMP);
  rcIs("--fixture outside any repo still reviews the directory", 0, r.rc);
  lacks("and never hits the repo check", "not inside a git repository", r.err);
});

// ── The eval's free half finds the scripts one level above evals/ ─────
test("caller-contract.eval.ts --pack-only resolves the scripts from .agents/skills/review/evals/", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "evals/caller-contract.eval.ts"), "--pack-only"],
    { encoding: "utf8", timeout: 120_000 },
  );
  rcIs("caller-contract.eval.ts --pack-only resolves the scripts from .agents/skills/review/evals/", 0, r.status);
});

// The loop skills run this program by path, without `node`, so it must stay
// executable and its shebang must run it.
test("invoked directly by path, the program runs", () => {
  const r = spawnSync(REVIEW, [], { encoding: "utf8" });
  assert.equal(r.error, undefined, `direct invocation failed to start: ${r.error?.message}`);
  assert.equal(r.status, 2, `no arguments is a usage error — got ${r.status}`);
  assert.match(r.stderr, /Usage: /);
});

// ── A finding glued onto narration is kept, not dropped ───────────────────────
//
// The salvage rule had no test. Both review entry points now read answers
// through policy-chain.ts's salvageTriageLine; this pins code-review's side of
// that shared reading.
test("a prefixed finding and a prefixed sentinel are salvaged", () => {
  const glued = `${TMP}/glued.sh`;
  exe(
    glued,
    `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'Reading alpha [first] now.[should-fix] alpha.txt:1: first\\n[nit] beta.txt:2: second\\n'\n`,
  );
  const fixture = join(SCRIPT_DIR, "tests/fixtures/planted-bugs");
  const env = { ...BASE_ENV, POLICY_JSON: POLICY, CODEX_BIN: glued, GROK_BIN: glued };
  const r = review(["--fixture", fixture], env);
  rcIs("a review with a salvaged finding", 0, r.rc);
  eq("both findings reach stdout", "[should-fix] alpha.txt:1: first\n[nit] beta.txt:2: second\n", r.out);
  has("the salvage is reported", "salvaged a triage marker from a prefixed line", r.err);
  const clean = `${TMP}/glued-clean.sh`;
  exe(clean, `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'All read.NO_FINDINGS\\n'\n`);
  const c = review(["--fixture", fixture], { ...env, CODEX_BIN: clean, GROK_BIN: clean });
  rcIs("a prefixed sentinel is a clean review", 0, c.rc);
  eq("a clean review prints nothing", "", c.out);
});

// The plain shape test reads an answer as the parser does. A sentence that only
// names the sentinel once passed the shape test (a bare substring match), failed
// the parser, and the primary was re-asked twice while a healthy backup sat
// untried (Contextium v9.2.0 review).
test("a sentence that merely mentions the sentinel falls through to a working backup", () => {
  const prose = `${TMP}/prose-sentinel.sh`;
  exe(
    prose,
    `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'I could not complete the audit and cannot return NO_FINDINGS\\n'\n`,
  );
  const good = `${TMP}/prose-backup.sh`;
  exe(good, `#!/usr/bin/env bash\ncat >/dev/null\nprintf '[nit] beta.txt:2: from the backup\\n'\n`);
  const fixture = join(SCRIPT_DIR, "tests/fixtures/planted-bugs");
  const r = review(["--fixture", fixture], { ...BASE_ENV, POLICY_JSON: POLICY, CODEX_BIN: prose, GROK_BIN: good });
  rcIs("the backup's review completes", 0, r.rc);
  eq("the backup's finding is the answer", "[nit] beta.txt:2: from the backup\n", r.out);
  has("answered by the backup", "1 finding(s) from grok", r.err);
});

test("receipt mode: a follow-up round is shown the findings still open", () => {
  const items = `${TMP}/open-items.json`;
  writeFileSync(
    items,
    JSON.stringify({ items: [{ id: "E1", text: "e" }], openFindings: ["[must-fix] alpha.txt:1: still wrong — x — y"] }),
  );
  const snap = snapshot();
  appendFileSync(`${REPO}/alpha.txt`, "open findings edit\n");
  const stub = `${TMP}/open-stub.sh`;
  exe(
    stub,
    `#!/usr/bin/env bash\ncat > "${SEEN}"\nprintf 'BEGIN_REVIEW_V1\\n{"findings":"NO_FINDINGS","coverage":[{"id":"E1","status":"checked","evidence":["r"]}]}\\nEND_REVIEW_V1\\n'\n`,
  );
  const r = runReview(["--since", snap], {
    CODEX_BIN: stub,
    GROK_BIN: stub,
    CODE_REVIEW_RESULT_FILE: `${TMP}/open-result.json`,
    CODE_REVIEW_COVERAGE_FILE: items,
  });
  rcIs("the follow-up runs", 0, r.rc);
  has("the open finding is in the prompt", "EARLIER FINDINGS STILL OPEN", seen());
  has("verbatim", "[must-fix] alpha.txt:1: still wrong", seen());
  // The result names what the prompt showed: a finding the round was shown and
  // did not re-raise is closed by the receipt, one it never saw stays open.
  eq(
    "the result records the open findings the prompt listed",
    JSON.stringify(["[must-fix] alpha.txt:1: still wrong — x — y"]),
    JSON.stringify(JSON.parse(readFileSync(`${TMP}/open-result.json`, "utf8")).shown),
  );
});

// ── REPEAT SPOT: the same place flagged two reviews running ───────────────
// A save handler patched through seven reviews drew a new finding beside the
// last each time; the warning tells the build to redesign the piece instead.
function repeatRound(name: string, open: string[], findings: string): Result {
  const items = `${TMP}/repeat-${name}.json`;
  writeFileSync(items, JSON.stringify({ items: [{ id: "E1", text: "e" }], openFindings: open }));
  const snap = snapshot();
  appendFileSync(`${REPO}/alpha.txt`, `repeat ${name} edit\n`);
  const stub = `${TMP}/repeat-${name}.sh`;
  const frame = JSON.stringify({ findings, coverage: [{ id: "E1", status: "checked", evidence: ["r"] }] });
  writeFileSync(`${TMP}/repeat-${name}.frame`, `BEGIN_REVIEW_V1\n${frame}\nEND_REVIEW_V1\n`);
  exe(stub, `#!/usr/bin/env bash\ncat >/dev/null\ncat "${TMP}/repeat-${name}.frame"\n`);
  return runReview(["--since", snap], {
    CODEX_BIN: stub,
    GROK_BIN: stub,
    CODE_REVIEW_RESULT_FILE: `${TMP}/repeat-${name}-result.json`,
    CODE_REVIEW_COVERAGE_FILE: items,
  });
}
test("a finding beside one the last review left open is a repeat spot", () => {
  const open = ["[must-fix] src/Editor.tsx:153: readKey advances early — x — y"];
  const near = repeatRound("near", open, "[must-fix] src/Editor.tsx:165: the race remains — x — y");
  rcIs("the review completes", 0, near.rc);
  has(
    "the warning names both spots",
    "REPEAT SPOT: src/Editor.tsx:165 — the last review flagged src/Editor.tsx:153 too",
    near.err,
  );
  has("and says what to do", "redesign it as a whole", near.err);
  eq("stdout stays triage lines only", "[must-fix] src/Editor.tsx:165: the race remains — x — y\n", near.out);
  const edge = repeatRound("edge", open, "[should-fix] src/Editor.tsx:178: still stale — x");
  has("25 lines away still counts", "REPEAT SPOT: src/Editor.tsx:178", edge.err);
  const far = repeatRound("far", open, "[must-fix] src/Editor.tsx:179: a new hole — x — y");
  lacks("26 lines away is a new spot", "REPEAT SPOT", far.err);
  const other = repeatRound("other", open, "[must-fix] src/Invoice.tsx:153: same line, other file — x — y");
  lacks("the same line in another file is a new spot", "REPEAT SPOT", other.err);
  const nit = repeatRound("nit", open, "[nit] src/Editor.tsx:154: wording");
  lacks("a nit is never a repeat spot", "REPEAT SPOT", nit.err);
  const ticked = repeatRound("ticked", open, "[must-fix] `src/Editor.tsx:160`: backticked — x — y");
  has("a backticked location is read", "REPEAT SPOT: src/Editor.tsx:160", ticked.err);
  const linked = repeatRound(
    "linked",
    ["[must-fix] [src/Editor.tsx:153](/abs/src/Editor.tsx:153): linked — x — y"],
    "[should-fix] [src/Editor.tsx:170](/abs/src/Editor.tsx:170): linked again — x",
  );
  has(
    "a markdown-link location is read on both sides",
    "REPEAT SPOT: src/Editor.tsx:170 — the last review flagged src/Editor.tsx:153",
    linked.err,
  );
  const none = repeatRound("none", [], "[must-fix] src/Editor.tsx:153: first sighting — x — y");
  lacks("with nothing open there is nothing to repeat", "REPEAT SPOT", none.err);
  eq(
    "a round shown nothing records an empty shown list",
    "[]",
    JSON.stringify(JSON.parse(readFileSync(`${TMP}/repeat-none-result.json`, "utf8")).shown),
  );
  // The spot's file is the finding's file, read by the one rule every reader
  // of a finding uses (audit-dedupe.ts leadingPath): a path holding a colon was
  // cut at it, so its repeat was never seen.
  const colon = repeatRound(
    "colon",
    ["[must-fix] src/x:y.tsx:153: first — x — y"],
    "[must-fix] src/x:y.tsx:160: again — x — y",
  );
  has(
    "a path holding a colon is one file",
    "REPEAT SPOT: src/x:y.tsx:160 — the last review flagged src/x:y.tsx:153",
    colon.err,
  );
});

test("receipt mode: a primary whose findings are narration falls through to a working backup", () => {
  const narrator = `${TMP}/narrator.sh`;
  exe(
    narrator,
    `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'BEGIN_REVIEW_V1\\n{"findings":"Reading the files","coverage":[{"id":"E1","status":"checked","evidence":["r"]},{"id":"C1","status":"checked","evidence":["r"]}]}\\nEND_REVIEW_V1\\n'\n`,
  );
  const good = `${TMP}/good-backup.sh`;
  exe(
    good,
    `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'BEGIN_REVIEW_V1\\n{"findings":"NO_FINDINGS","coverage":[{"id":"E1","status":"checked","evidence":["r"]},{"id":"C1","status":"checked","evidence":["r"]}]}\\nEND_REVIEW_V1\\n'\n`,
  );
  rmSync(RESULT, { force: true });
  const r = runReview(["HEAD~1", "HEAD"], {
    CODEX_BIN: narrator,
    GROK_BIN: good,
    CODE_REVIEW_RESULT_FILE: RESULT,
    CODE_REVIEW_COVERAGE_FILE: ITEMS,
  });
  rcIs("the backup's review completes", 0, r.rc);
  has("answered by the backup", "grok/", JSON.parse(readFileSync(RESULT, "utf8")).vendor);
});

test("receipt mode: the sentinel with stray whitespace is the same clean review to the shape test and the parser", () => {
  const r = framed(frame({ findings: "NO_FINDINGS \n", coverage: cov }));
  rcIs("accepted and parsed as clean", 0, r.rc);
  eq("no finding", "", r.out);
  eq("the result is clean", 0, JSON.parse(r.result).findings.length);
});

// ── Pieces: a full review of a declared subset of the changed files ──
//
// A change too large for one review call is reviewed as pieces over one base
// and head, each listing its files in a NUL-separated piece file. These cases
// pin which bytes a piece hands the reviewer, and that a refused review —
// a piece or a repeated full review — spends nothing. Their own repo, so the
// shared one above keeps its history.
const SREPO = `${TMP}/slice-repo`;
mkdirSync(SREPO, { recursive: true });
function sg(...args: string[]): string {
  const r = spawnSync("git", ["-C", SREPO, ...args], { encoding: "utf8" });
  return (r.stdout ?? "").replace(/\n+$/, "");
}
sg("init", "-q", ".");
sg("config", "user.email", "t@t");
sg("config", "user.name", "t");
for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "*.ts", "?.ts", "[x].ts", ":lead.ts"])
  writeFileSync(join(SREPO, f), `export const base_${f.replace(/[^a-z]/g, "_")} = 0;\n`);
sg("add", "-A");
sg("commit", "-qm", "init");
const SBASE = sg("rev-parse", "HEAD");
writeFileSync(join(SREPO, "a.ts"), "export const committedA = 1;\n");
writeFileSync(join(SREPO, "b.ts"), "export const committedB = 1;\n");
sg("commit", "-qam", "pieces");
writeFileSync(join(SREPO, "c.ts"), "export const workingC = 1;\n");
writeFileSync(join(SREPO, "d.ts"), "export const workingD = 1;\n");
writeFileSync(join(SREPO, "e.ts"), "export const untrackedE = 1;\n");
writeFileSync(join(SREPO, "f.ts"), "export const untrackedF = 1;\n");
// A stand-in packer that names the files it was handed, so the pack's scope is visible.
const SPACKER = `${TMP}/slice-packer.ts`;
writeFileSync(
  SPACKER,
  `import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const files = readFileSync(a[a.indexOf("--files-file") + 1], "utf8").split("\\0").filter(Boolean);
process.stdout.write("BLAST RADIUS (stand-in)\\n" + files.map((f) => "PACKED " + f).join("\\n") + "\\n");
`,
);
function pieceFile(name: string, paths: string[]): string {
  const f = `${TMP}/piece-${name}`;
  writeFileSync(f, paths.map((p) => `${p}\0`).join(""));
  return f;
}
function sliceReview(args: string[], extra: NodeJS.ProcessEnv = {}): Result {
  writeFileSync(SEEN, "");
  return review(args, {
    ...BASE_ENV,
    CODEX_REVIEW_REPO: SREPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
    CODE_REVIEW_BLAST_RADIUS: SPACKER,
    CLAUDE_CODE_SESSION_ID: "slice-session",
    ...extra,
  });
}
/** The build counter for one round-state dir: its single counter file, or 0. */
function rounds(dir: string): number {
  if (!existsSync(dir)) return 0;
  const f = readdirSync(dir).find((n) => !n.includes("."));
  return f ? Number(readFileSync(join(dir, f), "utf8").trim()) : 0;
}

test("a refused repeated full review spends no round: over the budget, or an empty diff", () => {
  const dir = `${TMP}/refusal-rounds`;
  rmSync(dir, { recursive: true, force: true });
  rcIs("the first full review is round 1", 0, sliceReview([SBASE, "HEAD"], { CODE_REVIEW_ROUND_STATE_DIR: dir }).rc);
  eq("round 1 spends the full flag, not a counted round", 0, rounds(dir));
  const big = sliceReview([SBASE, "HEAD"], { CODE_REVIEW_ROUND_STATE_DIR: dir, CODEX_REVIEW_MAX_DIFF_BYTES: "10" });
  rcIs("an over-budget repeated full review is refused", 1, big.rc);
  has("and says why", "over the 10-byte budget", big.err);
  eq("and spends no round", 0, rounds(dir));
  eq("and makes no reviewer call", "", seen());
  const empty = sliceReview(["HEAD", "HEAD", "--slice", pieceFile("unchanged", ["?.ts"])], {
    CODE_REVIEW_ROUND_STATE_DIR: dir,
  });
  rcIs("an empty diff is refused", 1, empty.rc);
  has("and says the diff is empty", "diff is empty", empty.err);
  eq("and spends no round", 0, rounds(dir));
  const real = sliceReview([SBASE, "HEAD"], { CODE_REVIEW_ROUND_STATE_DIR: dir });
  rcIs("a repeated full review that is reviewed", 0, real.rc);
  eq("spends its round", 1, rounds(dir));
});

test("a piece hands the reviewer only its files: committed, uncommitted and untracked, and the pack", () => {
  const r = sliceReview([SBASE, "HEAD", "--slice", pieceFile("ace", ["a.ts", "c.ts", "e.ts"])], {
    CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/piece-rounds-1`,
  });
  rcIs("the piece is reviewed", 0, r.rc);
  const s = seen();
  for (const want of ["committedA", "workingC", "untrackedE"]) has(`the piece carries ${want}`, want, s);
  for (const not of ["committedB", "workingD", "untrackedF"]) lacks(`the piece leaves out ${not}`, not, s);
  const pack = s.slice(s.indexOf("BLAST RADIUS"), s.indexOf("\nDIFF:"));
  for (const want of ["PACKED a.ts", "PACKED c.ts", "PACKED e.ts"]) has("the pack is the piece's", want, pack);
  for (const not of ["PACKED b.ts", "PACKED d.ts", "PACKED f.ts"]) lacks("the pack is the piece's only", not, pack);
  has("the reviewer is told it reads a piece", "THIS IS ONE PIECE OF A LARGER REVIEW", s);
  has("and how many changed files other pieces read", "3 other changed file(s)", s);
  has("and which piece", "piece-ace", s);
});

test("a piece's names are literal: a wildcard or pathspec magic selects only itself", () => {
  for (const f of ["*.ts", "?.ts", "[x].ts", ":lead.ts"])
    writeFileSync(join(SREPO, f), `export const edited = "${f}";\n`);
  try {
    for (const name of ["*.ts", "?.ts", "[x].ts", ":lead.ts"]) {
      const r = sliceReview([SBASE, "HEAD", "--slice", pieceFile(`lit-${name.length}`, [name])], {
        CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/piece-rounds-lit`,
        CODE_REVIEW_LOOP_ID: `lit-${name}`,
      });
      rcIs(`${name} is reviewed`, 0, r.rc);
      const diff = seen().slice(seen().indexOf("\nDIFF:"));
      has(`${name} reaches the reviewer`, `edited = "${name}"`, diff);
      for (const other of ["committedA", "workingC", "untrackedE"]) lacks(`${name} matches no other file`, other, diff);
      for (const o of ["*.ts", "?.ts", "[x].ts", ":lead.ts"].filter((o) => o !== name))
        lacks(`${name} does not match ${o}`, `edited = "${o}"`, diff);
    }
  } finally {
    sg("checkout", "-q", "--", "*.ts");
  }
});

test("a malformed piece file is a caller error before any call", () => {
  for (const [why, file] of [
    ["empty", pieceFile("empty", [])],
    ["absolute", pieceFile("abs", ["/etc/passwd"])],
    ["outside", pieceFile("dotdot", ["../x.ts"])],
    ["missing", `${TMP}/no-such-piece`],
  ] as const) {
    const r = sliceReview([SBASE, "HEAD", "--slice", file], { CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/piece-bad` });
    rcIs(`${why} piece file`, 2, r.rc);
    eq(`${why}: no reviewer call`, "", seen());
  }
  const misplaced = sliceReview([SBASE, "--slice", pieceFile("ok", ["a.ts"]), "HEAD"], {});
  rcIs("--slice in the wrong place is a usage error", 2, misplaced.rc);
});

test("a piece in T3 needs the audit owner, as the two-arg form does", () => {
  const home = join(TMP, "slice-t3");
  mkdirSync(join(home, "userdata"), { recursive: true });
  const db = new DatabaseSync(join(home, "userdata/statev2.sqlite"));
  db.exec(
    "create table orchestration_v2_projection_threads(thread_id text,title text,created_at text,deleted_at text,payload_json text); create table orchestration_v2_projection_provider_sessions(thread_id text,provider text,driver text)",
  );
  db.prepare("insert into orchestration_v2_projection_threads values (?,'fixture','0',null,?)").run(
    "slice-child",
    JSON.stringify({ worktreePath: SREPO, branch: "fixture" }),
  );
  db.prepare("insert into orchestration_v2_projection_provider_sessions values (?,?,?)").run(
    "slice-child",
    "grok",
    "grok",
  );
  db.close();
  const r = review(
    [SBASE, "HEAD", "--slice", pieceFile("t3", ["a.ts"])],
    {
      ...BASE_ENV,
      T3CODE_HOME: home,
      WORKBENCH_THREAD_ID: "slice-child",
      CODE_REVIEW_LOOP_ID: "",
      CODEX_REVIEW_REPO: SREPO,
      POLICY_JSON: POLICY,
      CODEX_BIN: STUB,
      GROK_BIN: STUB,
    },
    SREPO,
  );
  rcIs("refused without CODE_REVIEW_LOOP_ID", 2, r.rc);
  has("and says so", "CODE_REVIEW_LOOP_ID is required in T3", r.err);
});
