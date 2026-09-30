// audit-dedupe.test.ts — peer of audit-dedupe.ts.
// Run: node --test --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.test.ts
//
// Pins the once-per-session marker: `status` is `fresh` until `mark` stores a
// trailer under <state dir>/<session id>, after which `status` prints `done`
// and the trailer; sessions isolated; the session id read as harness.sh reads
// it (CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID, CLAUDE_SESSION_ID) and
// sanitized so it cannot leave the state dir; the fail-SAFE no-session-id path
// (always fresh, mark skipped with exit 0); and the usage exits (2).
// CONTEXTIUM_AUDIT_STATE_DIR points the markers at a temp dir. The script is
// run as a subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "audit-dedupe.ts");
const TMP = mkdtempSync(join(tmpdir(), "audit-dedupe-test."));
after(() => rmSync(TMP, { recursive: true, force: true }));
const STATE = join(TMP, "state");
const SID = "s1";
const MARKER = `${STATE}/${SID}`;

const baseEnv: Record<string, string | undefined> = { ...process.env, CONTEXTIUM_AUDIT_STATE_DIR: STATE };
delete baseEnv.CONTEXTIUM_SESSION;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
delete baseEnv.CLAUDE_SESSION_ID;

function run(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT, ...args], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.replace(/\n+$/, ""), err: r.stderr.replace(/\n+$/, ""), rc: r.status };
}
const S = { CLAUDE_CODE_SESSION_ID: SID };
const LINE = "implement-audit: codex, round-2, 3 findings (3 fixed, 0 open) — APPROVE";
const markerBody = (): string => readFileSync(MARKER, "utf8").replace(/\n+$/, "");
const markerCount = (): number => {
  try {
    return readdirSync(STATE).length;
  } catch {
    return 0;
  }
};

// ── usage ────────────────────────────────────────────────────────────────
test("usage", () => {
  let r = run({});
  assert.equal(`${r.rc}|${r.err}`, "2|usage: audit-dedupe.ts status|mark", "no verb: exit 2 with usage");
  assert.equal(run(S, "bogus").rc, 2, "an unknown verb is a usage error");
  r = run(S, "mark");
  assert.equal(`${r.rc}|${r.err}`, '2|usage: audit-dedupe.ts mark "<trailer>"', "mark with no trailer: exit 2");
  assert.equal(run(S, "mark", "").rc, 2, "mark with no line is a usage error");
  assert.equal(existsSync(MARKER), false, "usage never creates a marker");
});

// ── first call ───────────────────────────────────────────────────────────
test("first call", () => {
  let r = run(S, "status");
  assert.equal(`${r.out}|${r.rc}`, "fresh|0", "a new session is fresh, exit 0");
  r = run(S, "mark", LINE);
  assert.equal(r.rc, 0, "mark: exit 0");
  assert.equal(
    r.out,
    `implement-audit: marked session ${SID} audited (${MARKER})`,
    "mark: reports the session and the marker path",
  );
  assert.equal(markerBody(), LINE, "mark: stores the trailer verbatim");
});

// ── dedupe hit ───────────────────────────────────────────────────────────
test("dedupe hit", () => {
  let r = run(S, "status");
  assert.equal(r.out, `done\n${LINE}`, "after mark it is done, with the line");
  assert.equal(r.rc, 0, "second status: exit 0");

  run(S, "mark", "implement-audit: second trailer");
  assert.equal(markerBody(), "implement-audit: second trailer", "re-mark overwrites the trailer");
  r = run(S, "status");
  assert.equal(r.out, "done\nimplement-audit: second trailer", "status re-emits the newest trailer");

  assert.ok(run({ CLAUDE_SESSION_ID: SID }, "status").out.includes("done"), "CLAUDE_SESSION_ID alone finds the marker");
  assert.ok(
    run({ ...S, CLAUDE_SESSION_ID: `other-${SID}` }, "status").out.includes("done"),
    "CLAUDE_CODE_SESSION_ID wins over CLAUDE_SESSION_ID",
  );
  assert.equal(run({ CLAUDE_CODE_SESSION_ID: "s2" }, "status").out, "fresh", "another session is still fresh");
});

// ── the harness-neutral id ───────────────────────────────────────────────
test("CONTEXTIUM_SESSION keys the marker too", () => {
  const env = { CONTEXTIUM_SESSION: "cx1" };
  run(env, "mark", LINE);
  assert.equal(run(env, "status").out, `done\n${LINE}`);
  assert.equal(
    run({ CONTEXTIUM_SESSION: "cx1", CLAUDE_CODE_SESSION_ID: SID }, "status").out,
    `done\n${LINE}`,
    "CONTEXTIUM_SESSION wins over CLAUDE_CODE_SESSION_ID",
  );
});

test("a session id with a slash cannot escape the state dir", () => {
  const r = run({ CLAUDE_CODE_SESSION_ID: "../x" }, "mark", LINE);
  assert.equal(r.rc, 0);
  assert.deepEqual(readdirSync(TMP), ["state"], "nothing written beside the state dir");
  assert.ok(existsSync(join(STATE, "---x")), "the id is reduced to [A-Za-z0-9_-]");
});

// ── no session id: fail safe ─────────────────────────────────────────────
test("no session id: fail safe", () => {
  let r = run({}, "status");
  assert.equal(`${r.out}|${r.rc}`, "fresh|0", "no session id: status is always fresh, even with markers on disk");
  const before = markerCount();
  r = run({}, "mark", "implement-audit: orphan");
  assert.equal(r.rc, 0, "no session id: mark is a no-op, exit 0");
  assert.equal(
    r.err,
    "implement-audit: no session id (CONTEXTIUM_SESSION / CLAUDE_CODE_SESSION_ID unset) — dedupe skipped; carry the trailer inline",
    "no session id: says the dedupe was skipped",
  );
  assert.equal(r.out, "", "no session id: nothing on stdout");
  assert.equal(markerCount(), before, "no session id: no marker written anywhere");
  assert.equal(markerBody(), "implement-audit: second trailer", "no session id: the real marker is untouched");
});
