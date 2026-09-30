// Tests for check-host-infra-safety.sh: its own `--self-test`, which feeds every
// `block:` / `pass:` / `raw:` example in the hook's header through the hook in
// each harness's payload shape, and then the unit-enable fixture rows (a
// scratch HOME whose user unit links into the main checkout, a linked
// worktree, another repo and a `<repo>-evil` sibling). The examples live in
// the hook so the explanation and its proof cannot drift apart; this suite
// runs them the way every other suite runs, and fails on any mismatch.
//
// Run: node --test --experimental-strip-types templates/agents/hooks/check-host-infra-safety.test.ts
//
// The hook stays bash (the harness fires it as a hook command), so it is
// SPAWNED with bash. The self-test needs jq, as the hook does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const HOOK = join(import.meta.dirname, "check-host-infra-safety.sh");
const jq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

test("check-host-infra-safety.sh --self-test: every example and unit fixture holds", { skip: jq ? false : "no jq here" }, () => {
  const r = spawnSync("bash", [HOOK, "--self-test"], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /self-test: pass=\d+ fail=0/);
});
