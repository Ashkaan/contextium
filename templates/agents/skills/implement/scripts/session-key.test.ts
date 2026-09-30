// Paired test for session-key.ts: the boundary cases of the session-key rule.
//
// The subject is spawned as a program, never imported. The composed slug is
// checked against setup-worktree.sh's own --validate-slug (bash — that
// resolver stays bash), not a copy of its regex.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/session-key.test.ts
//
// peers: session-key.ts, setup-worktree.sh

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "session-key.ts");
const SETUP = join(HERE, "setup-worktree.sh");

function run(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 30000,
  });
  return { rc: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** The key, as `$(node --experimental-strip-types session-key.ts <raw> 2>/dev/null)` captured it: stdout, trailing newline cut. */
const key = (raw: string): string => run([raw]).out.replace(/\n+$/, "");

/** `[[ "$got" == prefix* || "$got" == exact ]]`. */
function prefixOrExact(got: string, prefix: string, exact: string): boolean {
  return got.startsWith(prefix) || got === exact;
}

// ── Identity: a normal UUID session id must pass through unchanged ──
// Load-bearing: every worktree already on disk was created with a raw-UUID
// marker name, so if this were not identity the change would orphan them.
test("uuid is identity", () =>
  assert.equal(key("b764f990-6c1c-4d79-905b-be05dca8524f"), "b764f990-6c1c-4d79-905b-be05dca8524f"));

// ── Uppercase ──
test("uppercase lowercased", () => {
  const got = key("ABC123");
  assert.ok(prefixOrExact(got, "abc123-", "abc123"), `got '${got}'`);
});

// ── Underscore (the observed `cse_01HFo2Jk` shape) ──
// Lossy input, so the key carries a digest of the raw id — see the collision
// block below for why. Assert the readable prefix, not the exact digest.
test("underscore becomes hyphen", () => {
  const got = key("cse_01HFo2Jk");
  assert.ok(got.startsWith("cse-01hfo2jk-"), `got '${got}'`);
});

// ── Glob metacharacters — the reason the sanitizer is shared ──
test("asterisk neutralized", () => {
  const got = key("a*b");
  assert.ok(prefixOrExact(got, "a-b-", "a-b"), `got '${got}'`);
});
test("question mark neutralized", () => {
  const got = key("a?b");
  assert.ok(prefixOrExact(got, "a-b-", "a-b"), `got '${got}'`);
});
test("brackets neutralized", () => {
  const got = key("a[b]c");
  assert.ok(prefixOrExact(got, "a-b-c-", "a-b-c"), `got '${got}'`);
});
for (const meta of ["*", "?", "[", "]"]) {
  test(`output carries no '${meta}'`, () => {
    const got = key(`sess${meta}id`);
    assert.equal(got.includes(meta), false, `got '${got}'`);
  });
}

// ── Repeated separators collapse ──
test("repeated underscores collapse", () => {
  const got = key("a__b");
  assert.ok(prefixOrExact(got, "a-b-", "a-b"), `got '${got}'`);
});
test("repeated hyphens collapse", () => {
  const got = key("a---b");
  assert.ok(prefixOrExact(got, "a-b-", "a-b"), `got '${got}'`);
});
test("mixed separators collapse", () => {
  const got = key("a_-_b");
  assert.ok(prefixOrExact(got, "a-b-", "a-b"), `got '${got}'`);
});

// ── Leading / trailing separators stripped ──
test("leading+trailing underscores stripped", () => {
  const got = key("_abc_");
  assert.ok(prefixOrExact(got, "abc-", "abc"), `got '${got}'`);
});
test("leading+trailing hyphens stripped", () => {
  const got = key("--abc--");
  assert.ok(prefixOrExact(got, "abc-", "abc"), `got '${got}'`);
});

// ── Over-length truncation ──
const MAXLEN = Number(run(["--max-key-len"]).out.trim());
const long = "a".repeat(200);
test(`over-length truncated to ${MAXLEN}`, () => {
  const got = key(long);
  assert.equal(got.length, MAXLEN, `got length ${got.length}, want ${MAXLEN}`);
});

// Truncation must never leave a trailing hyphen.
// Build an input whose char at MAXLEN+1 is the first of a hyphen run, so a
// naive truncate would end on `-`.
const trailingProbe = `${"a".repeat(MAXLEN - 1)}_____tail`;
test("truncation leaves no trailing hyphen", () => {
  const got = key(trailingProbe);
  assert.equal(got.endsWith("-"), false, `got '${got}'`);
});

// ── The composed name must satisfy the real slug gate, not a copy of it ──
// This is the assertion that matters: session-key.ts and setup-worktree.sh must
// agree, so validate against setup-worktree.sh's own --validate-slug.
for (const raw of [
  "b764f990-6c1c-4d79-905b-be05dca8524f",
  "cse_01HFo2Jk",
  "ABC123",
  "a*b[c]?d",
  long,
  trailingProbe,
  "___x___",
]) {
  const k = key(raw);
  test(`session-${k} accepted by setup-worktree --validate-slug`, () => {
    const r = spawnSync("bash", [SETUP, "--validate-slug", `session-${k}`], { encoding: "utf8" });
    assert.equal(r.status, 0, `session-${k} rejected (from raw '${raw}')`);
  });
}

// ── Distinct raw ids must never share a key ──────────────────────────────
// Sanitizing is many-to-one: `a_b`, `a__b`, and `a*b` all reduce to `a-b`. If the
// key stopped there, three live sessions would share one marker name and one
// worktree — the index-sharing this whole mechanism exists to end, reintroduced
// by its own key function.
test("distinct raw ids produce distinct keys", () => {
  const seen = new Map<string, string>();
  let collision = "";
  for (const raw of ["a_b", "a__b", "a*b", "a-b", "a?b", "a[b]", "A_B", "a_B", "a.b", "a/b"]) {
    const k = key(raw);
    const prior = seen.get(k);
    if (prior !== undefined) {
      collision = `'${raw}' and '${prior}' both map to '${k}'`;
      break;
    }
    seen.set(k, raw);
  }
  assert.equal(collision, "", collision);
});

// Over-length ids that share a prefix must also stay distinct.
test("over-length ids sharing a prefix stay distinct", () => {
  const a = key(`${"a".repeat(80)}x`);
  const b = key(`${"a".repeat(80)}y`);
  assert.notEqual(a, b, `both '${a}'`);
});

// And the key stays a deterministic function of the id.
test("key is deterministic", () => assert.equal(key("a_b"), key("a_b"), "two calls differed"));

// ── Empty and all-invalid input → exit 2 ──
for (const [raw, label] of [
  ["", "empty input exits 2"],
  ["___", "all-separator input exits 2"],
  ["!!!", "all-invalid input exits 2"],
  ["***", "all-glob input exits 2"],
] as const) {
  test(label, () => assert.equal(run([raw]).rc, 2));
}

// No-arg invocation (distinct from empty-string arg) must also refuse.
test("no-arg exits 2", () => assert.equal(run([]).rc, 2));
