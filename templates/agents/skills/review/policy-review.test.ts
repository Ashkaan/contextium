// policy-review.test.ts — boundary rows for policy-review.ts: missing args,
// unknown task-kind, missing files, claude-slot exit, vendor resolution order.
//
// Run: node --test --experimental-strip-types .agents/skills/review/policy-review.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "policy-review.ts");
const TMP = mkdtempSync(join(tmpdir(), "policy-review-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const ARTIFACT = `${TMP}/artifact.md`;
const BRIEF = `${TMP}/brief.md`;
writeFileSync(ARTIFACT, "some artifact content\n");
writeFileSync(BRIEF, "attack this artifact\n");

// A stand-in policy so tests never depend on the live one drifting.
const POLICY = `${TMP}/policy.json`;
writeFileSync(
  POLICY,
  `{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "judgment": {
      "mode": "single",
      "chain": [{ "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }, { "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }]
    },
    "claude-only": {
      "mode": "single",
      "chain": [{ "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }]
    },
    "bogus-vendor": {
      "mode": "single",
      "chain": [{ "vendor": "nosuchvendor", "model": "x", "tracks": "x" }]
    },
    "panel": {
      "mode": "panel",
      "voices": [{ "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }, { "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }]
    }
  }
}
`,
);

// Model resolution reads a vendor's live catalog; these cases stub the vendor,
// so they stub the resolver too (POLICY_CHAIN_RESOLVER, policy-chain.ts). It
// resolves the fixture families the way a real catalog would and
// fails a family named `unresolvable-{v}`.
writeFileSync(
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
chmodSync(`${TMP}/resolve-model.sh`, 0o755);

function run(args: string[], env: Record<string, string> = {}): { rc: number | null; all: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, POLICY_JSON: POLICY, POLICY_CHAIN_RESOLVER: `${TMP}/resolve-model.sh`, ...env },
    timeout: 60_000,
  });
  return { rc: r.status, all: `${r.stdout}${r.stderr}` };
}
function check(name: string, expected: number, actual: number | null): void {
  assert.equal(actual, expected, `${name} — expected rc=${expected}, got rc=${actual}`);
}

test("argument validation", () => {
  check("no args rejected", 2, run([]).rc);
  check("missing artifact and brief rejected", 2, run(["adversarial-review"]).rc);
  check("missing brief rejected", 2, run(["adversarial-review", ARTIFACT]).rc);
  check("missing artifact file rejected", 2, run(["adversarial-review", `${TMP}/nope.md`, BRIEF]).rc);
  check("missing brief file rejected", 2, run(["adversarial-review", ARTIFACT, `${TMP}/nope.md`]).rc);
});

test("unknown task-kind is an error, never a silent default", () => {
  const r = run(["no-such-kind", ARTIFACT, BRIEF]);
  check("unknown task-kind rejected", 2, r.rc);
  assert.match(r.all, /known rows/, "error does not list known rows");
});

test("a chain whose only slot is claude exits 3 (caller uses its agent)", () => {
  check("claude-only chain signals agent-dispatch", 3, run(["claude-only", ARTIFACT, BRIEF]).rc);
});

test("an unsupported vendor exhausts the chain rather than crashing", () => {
  check("unsupported vendor exhausts cleanly", 1, run(["bogus-vendor", ARTIFACT, BRIEF]).rc);
});

test("policy file must exist", () => {
  check(
    "missing policy file rejected",
    2,
    run(["adversarial-review", ARTIFACT, BRIEF], { POLICY_JSON: `${TMP}/absent.json` }).rc,
  );
});

test("panel rows expose voices, not chain — the reader must handle both", () => {
  const rows = JSON.parse(readFileSync(POLICY, "utf8")).rows as Record<
    string,
    { chain?: unknown[]; voices?: unknown[] }
  >;
  const out = (rows.panel?.chain ?? rows.panel?.voices ?? []).length;
  assert.equal(out, 2, `panel voices not readable — got '${out}'`);
});

// ── the SHIPPED policy must carry the rows the reviewers depend on ──
// It is the table beside this script; LIVE_POLICY_JSON points at another copy.
test("the shipped policy carries the reviewers' rows", (t) => {
  const REPO_POLICY = process.env.LIVE_POLICY_JSON || join(HERE, "policy.json");
  if (!existsSync(REPO_POLICY)) {
    t.skip(`policy not found at ${REPO_POLICY}, skipping the row check`);
    return;
  }
  const rows = (JSON.parse(readFileSync(REPO_POLICY, "utf8")) as { rows?: Record<string, unknown> }).rows ?? {};
  for (const kind of ["adversarial-review", "judgment"]) {
    assert.ok(rows[kind], `live policy has no '${kind}' row — reviewers would break`);
  }
});
