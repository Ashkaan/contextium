// format-trailer.test.ts — peer of format-trailer.ts.
// Run: node --test --experimental-strip-types .agents/skills/spec-audit/scripts/format-trailer.test.ts
//
// Pins the one line /spec-audit writes into plan.md for each of the four modes,
// and every refusal: a missing or unknown mode, a missing argument, a vendor
// that is not a plain lowercase token (the value lands verbatim in the record),
// a spirit verdict outside MATCH | DRIFT | AMBIGUOUS, and a non-material reason
// outside the fixed list. The script is run as a subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "format-trailer.ts");

function run(...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    // Node 22 prints a type-stripping warning on stderr, which these cases read.
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { rc: r.status, stdout: r.stdout, out: r.stdout.replace(/\n+$/, ""), err: r.stderr };
}

// ── 1. round-1 ────────────────────────────────────────────────────────────
test("round-1", () => {
  let r = run("round-1", "codex", "MATCH");
  assert.equal(r.rc, 0, "round-1 exits 0");
  assert.equal(r.out, "spec-audit: codex round-1; spirit MATCH; user-ask-verbatim in spec.md Input", "round-1 line");
  assert.equal(r.stdout.split("\n").length - 1, 1, "round-1 is exactly one line");
  r = run("round-1", "grok", "DRIFT");
  assert.equal(
    r.out,
    "spec-audit: grok round-1; spirit DRIFT; user-ask-verbatim in spec.md Input",
    "round-1 names the vendor that answered, not a baked-in one",
  );
  r = run("round-1", "codex", "AMBIGUOUS");
  assert.equal(
    r.out,
    "spec-audit: codex round-1; spirit AMBIGUOUS; user-ask-verbatim in spec.md Input",
    "round-1 carries AMBIGUOUS",
  );
});

// ── 2. round-2 ────────────────────────────────────────────────────────────
test("round-2", () => {
  let r = run("round-2", "codex", "2", "1", "MATCH");
  assert.equal(r.rc, 0, "round-2 exits 0");
  assert.equal(
    r.out,
    "spec-audit: codex round-2 (2 accepted by codex, 1 escalated); spirit MATCH; user-ask-verbatim in spec.md Input",
    "round-2 line",
  );
  r = run("round-2", "grok", "0", "0", "MATCH");
  assert.equal(
    r.out,
    "spec-audit: grok round-2 (0 accepted by grok, 0 escalated); spirit MATCH; user-ask-verbatim in spec.md Input",
    "round-2 with zero counts still renders both",
  );
});

// ── 3. skipped modes ──────────────────────────────────────────────────────
test("skipped modes", () => {
  let r = run("skipped-user", "just fix the typo, no audit");
  assert.equal(r.rc, 0, "skipped-user exits 0");
  assert.equal(
    r.out,
    'spec-audit: skipped — user authorized "just fix the typo, no audit"',
    "skipped-user quotes the authorization verbatim",
  );
  r = run("skipped-non-material", "typo");
  assert.equal(r.rc, 0, "skipped-non-material exits 0");
  assert.equal(r.out, "spec-audit: skipped — non-material (typo)", "skipped-non-material names the reason");
  for (const reason of ["formatting", "link", "wording-polish", "section-reorder", "clarification"]) {
    assert.equal(
      run("skipped-non-material", reason).out,
      `spec-audit: skipped — non-material (${reason})`,
      `non-material reason '${reason}' is accepted`,
    );
  }
});

// ── 4. mode errors ────────────────────────────────────────────────────────
test("mode errors", () => {
  let r = run();
  assert.equal(r.rc, 1, "no mode exits 1");
  assert.ok(
    r.err.includes("mode required: round-1 | round-2 | skipped-user | skipped-non-material"),
    "no mode names the four modes",
  );
  assert.equal(r.out, "", "no mode prints nothing on stdout");
  r = run("round-3", "codex", "MATCH");
  assert.equal(r.rc, 1, "unknown mode exits 1");
  assert.ok(r.err.includes("invalid mode 'round-3'"), "unknown mode is named");
  assert.equal(r.out, "", "unknown mode prints no trailer");
});

// ── 5. missing arguments ──────────────────────────────────────────────────
test("missing arguments", () => {
  let r = run("round-1");
  assert.equal(r.rc, 1, "round-1 without vendor exits 1");
  assert.ok(
    r.err.includes("vendor required — the vendor that answered"),
    "round-1 without vendor says where the vendor comes from",
  );
  r = run("round-1", "codex");
  assert.equal(r.rc, 1, "round-1 without spirit exits 1");
  assert.ok(
    r.err.includes("spirit verdict required: MATCH | DRIFT | AMBIGUOUS"),
    "round-1 without spirit lists the verdicts",
  );
  r = run("round-2", "codex", "1");
  assert.equal(r.rc, 1, "round-2 without escalated count exits 1");
  assert.ok(r.err.includes("escalated-to-user count required"), "round-2 without escalated count names it");
  r = run("round-2", "codex", "1", "0");
  assert.equal(r.rc, 1, "round-2 without spirit exits 1");
  r = run("skipped-user");
  assert.equal(r.rc, 1, "skipped-user without a quote exits 1");
  assert.ok(r.err.includes("verbatim user authorization quote required"), "skipped-user without a quote asks for it");
  r = run("skipped-non-material");
  assert.equal(r.rc, 1, "skipped-non-material without a reason exits 1");
});

// ── 6. bad values ─────────────────────────────────────────────────────────
test("bad values", () => {
  let r = run("round-1", "codex", "maybe");
  assert.equal(r.rc, 1, "bad spirit verdict exits 1");
  assert.ok(r.err.includes("invalid spirit verdict 'maybe'"), "bad spirit verdict is named");
  assert.equal(r.out, "", "bad spirit verdict prints no trailer");
  r = run("round-1", "Codex", "MATCH");
  assert.equal(r.rc, 1, "uppercase vendor is refused");
  assert.ok(r.err.includes("invalid vendor 'Codex'"), "uppercase vendor is named");
  r = run("round-1", "co dex; rm -rf", "MATCH");
  assert.equal(r.rc, 1, "vendor with a shell payload is refused");
  assert.equal(r.out, "", "vendor with a shell payload prints no trailer");
  assert.equal(run("round-1", "", "MATCH").rc, 1, "empty vendor is refused");
  assert.equal(run("round-1", "-codex", "MATCH").rc, 1, "vendor starting with a dash is refused");
  assert.equal(run("round-1", "gpt-6-sol", "MATCH").rc, 0, "vendor with digits and dashes after a letter is accepted");
  assert.equal(run("round-2", "co dex", "1", "0", "MATCH").rc, 1, "round-2 validates the vendor too");
  assert.equal(run("round-2", "codex", "1", "0", "NOPE").rc, 1, "round-2 validates the spirit verdict too");
  r = run("skipped-non-material", "rewrite");
  assert.equal(r.rc, 1, "unknown non-material reason exits 1");
  assert.ok(r.err.includes("invalid non-material reason 'rewrite'"), "unknown non-material reason is named");
  assert.equal(r.out, "", "unknown non-material reason prints no trailer");
  assert.equal(run("skipped-non-material", "").rc, 1, "empty non-material reason exits 1");
});

// ── 7. the fresh-context fallback (Contextium) ────────────────────────────
// When no independent reviewer answers, the audit runs in a fresh context of
// the authoring agent and is recorded as `claude-fallback`; the line always
// says so, so it is never read as an independent review.
test("the fresh-context fallback is never recorded as independent", () => {
  assert.equal(
    run("round-1", "claude-fallback", "MATCH").out,
    "spec-audit: claude-fallback (fresh context, NOT independent) round-1; spirit MATCH; user-ask-verbatim in spec.md Input",
    "round-1 fallback carries its caveat",
  );
  assert.equal(
    run("round-2", "claude-fallback", "1", "0", "DRIFT").out,
    "spec-audit: claude-fallback (fresh context, NOT independent) round-2 (1 accepted by claude-fallback, 0 escalated); spirit DRIFT; user-ask-verbatim in spec.md Input",
    "round-2 fallback carries its caveat",
  );
});

test("a refusal names the bad value", () => {
  const r = run("round-1", "co dex", "MATCH");
  assert.equal(r.err.replace(/\n+$/, ""), "error: invalid vendor 'co dex' — expected the answering vendor, e.g. codex | grok");
});
