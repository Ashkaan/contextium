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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

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
  POLICY_CHAIN_RESOLVER: `${TMP}/resolve-model.sh`,
  CODE_REVIEW_SNAP_STATE_DIR: `${TMP}/snaps`,
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
function runReview(args: string[], extra: NodeJS.ProcessEnv = {}): Result {
  // Round state in this suite's OWN scratch dir. It defaults to a shared
  // /tmp path keyed by session id, so without this the suite both inherits the
  // round count of whatever session is running it — tripping the round-4
  // ceiling and failing with exit 5 on the second run of the day — and leaves
  // its own counts behind for the next one.
  return review(args, {
    ...BASE_ENV,
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/rounds`,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
    ...extra,
  });
}
function snapshot(): string {
  return review(["--snapshot"], { ...BASE_ENV, CODEX_REVIEW_REPO: REPO }).out.replace(/\n+$/, "");
}
const seen = (): string => (existsSync(SEEN) ? readFileSync(SEEN, "utf8").replace(/\n+$/, "") : "");

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

// ── The round-4 ceiling ───────────────────────────────────────────────
//
// The skill's prose said "stop" before this script did, and a 34-round audit is
// what that was worth. These cases assert the mechanism, not the instruction.

const CEIL_STATE = `${TMP}/rounds`;
let CEIL_ERR = "";
function ceilReview(snap: string, sid = "ceiling-test"): Result {
  return review(["--since", snap], {
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

test("the round-4 ceiling", () => {
  rcIs("round 2 is allowed", 0, ceilRound(2));
  rcIs("round 3 is allowed", 0, ceilRound(3));
  rcIs("round 4 is allowed", 0, ceilRound(4));
  rcIs("round 5 is refused", 5, ceilRound(5));
  has("the refusal names the reason", "re-opens ground", CEIL_ERR);
  has("the refusal says what to do instead", "what is still open", CEIL_ERR);

  // A refused round must not have spent the call it was refusing.
  writeFileSync(SEEN, "");
  ceilRound(6);
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

  // No session id: the worktree stands in as the session, so the cap still
  // holds on a harness that exports none.
  const NOSID_STATE = `${TMP}/nosid-rounds`;
  const nosidRound = (n: number): number | null => {
    const env = { ...BASE_ENV, CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "", CODEX_REVIEW_REPO: REPO };
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
    "no session id: the counter is keyed on the worktree",
    "wt-",
    (readdirSync(NOSID_STATE).find((n) => n.startsWith("wt-")) ?? "").slice(0, 3),
  );

  // Sessions are independent: one session's loop cannot exhaust another's budget.
  rmSync(CEIL_STATE, { recursive: true, force: true });
  for (const n of [2, 3, 4]) ceilRound(n);
  const SNAP_OTHER = snapshot();
  appendFileSync(`${REPO}/alpha.txt`, "other session edit\n");
  rcIs("a second session starts at round 2", 0, ceilReview(SNAP_OTHER, "a-different-session").rc);
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

// ── A NEW review starts a NEW fix loop ────────────────────────────────────────
//
// The counter was keyed on the session id alone and only ever climbed, so it
// measured the SESSION rather than the loop. The cap is
// about ONE change's fix loop re-reading its own fixes; a session that reviews
// four unrelated changes is four loops, not one.
//
// Keyed on the session alone, a session's fourth separate change had its FIRST
// follow-up refused as "round 5 of at most 4" — the work that most needed
// re-reviewing got none.
//
// A full review IS the start of a loop, so it resets the counter.
test("a new full review starts a new fix loop", () => {
  rmSync(CEIL_STATE, { recursive: true, force: true });
  ceilRound(2);
  ceilRound(3);
  ceilRound(4);
  rcIs("the budget is spent on the first loop", 5, ceilRound(5));

  // A new full review — a different change, the same session.
  //
  // Its exit status is ASSERTED, not discarded. The reset happens before the
  // review validates its arguments or reaches a vendor, so a full review that
  // failed would still renew the budget — and every assertion below would pass
  // against a broken review, proving nothing.
  const r = review(["HEAD~1", "HEAD"], {
    ...BASE_ENV,
    CODE_REVIEW_ROUND_STATE_DIR: CEIL_STATE,
    CLAUDE_CODE_SESSION_ID: "ceiling-test",
    CODEX_REVIEW_REPO: REPO,
    POLICY_JSON: POLICY,
    CODEX_BIN: STUB,
    GROK_BIN: STUB,
  });
  rcIs("the new full review itself succeeded", 0, r.rc);

  rcIs("a full review starts a new loop, so its first fix round is allowed", 0, ceilRound(2));
  rcIs("the new loop still has its own ceiling", 0, ceilRound(3));
  rcIs("and it still ends at four", 0, ceilRound(4));
  rcIs("the new loop's fifth round is refused like any other", 5, ceilRound(5));
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
