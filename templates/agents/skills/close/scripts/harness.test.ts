// harness.test.ts — peer of harness.sh: the recorded harness, its override,
// the worktree root and branch per harness, and the session id.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/harness.test.ts
//
// harness.sh stays bash (write-root.sh and setup-worktree.sh source it), so each
// case spawns bash, sources the library and calls one function, with an
// environment built from nothing but PATH and a fixed HOME.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "harness.sh");
const TMP = mkdtempSync(join(tmpdir(), "harness-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** Source harness.sh in a fresh bash and eval `cmd`; stdout as the caller's `$(…)` reads it. */
function h(cmd: string, env: Record<string, string> = {}): string {
  const r = spawnSync("bash", ["-c", 'source "$0"; eval "$1"', LIB, cmd], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: "/home/u", ...env },
  });
  assert.equal(r.status, 0, `${cmd}: exit ${r.status} — ${r.stderr}`);
  return r.stdout.replace(/\n+$/, "");
}

const R = join(TMP, "shop");
mkdirSync(join(R, ".agents"), { recursive: true });
const record = (text: string): void => writeFileSync(join(R, ".agents/harness"), text);

test("harness_name: the installer's record, its absence, and the override", () => {
  assert.equal(h(`harness_name ${R}`), "default", "nothing recorded: default");
  record("agent=claude-code\n");
  assert.equal(h(`harness_name ${R}`), "default", "a record with no harness= key: default");
  record("harness=claude\nagent=claude-code\n");
  assert.equal(h(`harness_name ${R}`), "claude", "the installer's record: the harness= line of .agents/harness");
  record("agent=x\n harness = gemini \n");
  assert.equal(h(`harness_name ${R}`), "gemini", "…in any order, spaces around =");
  assert.equal(h(`harness_name ${R}`, { CONTEXTIUM_HARNESS: "codex" }), "codex", "CONTEXTIUM_HARNESS overrides it");
});

test("harness_worktree_root: where each harness keeps its worktrees", () => {
  const root = (harness: string, codexHome = ""): string =>
    h(`harness_worktree_root ${R}`, { CONTEXTIUM_HARNESS: harness, CODEX_HOME: codexHome });
  assert.equal(root("claude"), `${R}/.claude/worktrees`, "claude: in the repo, where claude -w puts them");
  assert.equal(root("gemini"), `${R}/.gemini/worktrees`, "gemini: in the repo");
  assert.equal(root("grok"), "/home/u/.grok/worktrees/shop", "grok: under ~/.grok, per repo");
  assert.match(root("codex", "/opt/cx"), /^\/opt\/cx\/worktrees\/shop-[0-9a-f]{8}$/, "codex: under CODEX_HOME, one folder per repo");
  assert.notEqual(
    h(`harness_worktree_root ${TMP}/elsewhere/shop`, { CONTEXTIUM_HARNESS: "codex", CODEX_HOME: "/opt/cx" }),
    root("codex", "/opt/cx"),
    "codex: two checkouts both called shop get two roots",
  );
  assert.equal(root("t3"), `${TMP}/shop.worktrees`, "t3 local mode: beside the repo");
  assert.equal(root("cursor"), `${TMP}/shop.worktrees`, "cursor: beside the repo");
  assert.equal(root("something-new"), `${TMP}/shop.worktrees`, "unknown: beside the repo");
  assert.equal(
    h(`harness_worktree_root ${R}/`, { CONTEXTIUM_HARNESS: "vscode" }),
    `${TMP}/shop.worktrees`,
    "a trailing slash reads the same",
  );
});

test("harness_worktree_branch: claude's worktree-<name>, everyone else's session/<name>", () => {
  assert.equal(h(`harness_worktree_branch s1 ${R}`, { CONTEXTIUM_HARNESS: "claude" }), "worktree-s1");
  assert.equal(h(`harness_worktree_branch s1 ${R}`, { CONTEXTIUM_HARNESS: "codex" }), "session/s1");
});

test("harness_session_id: the harness's own id, made safe for a path", () => {
  assert.equal(h("harness_session_id"), "", "no session id: empty");
  assert.equal(
    h("harness_session_id", { CONTEXTIUM_SESSION: "mine", CLAUDE_CODE_SESSION_ID: "theirs" }),
    "mine",
    "CONTEXTIUM_SESSION wins",
  );
  assert.equal(h("harness_session_id", { CLAUDE_CODE_SESSION_ID: "2e53-aa" }), "2e53-aa", "Claude Code's id is used");
  assert.equal(h("harness_session_id", { CONTEXTIUM_SESSION: "a b/c:d" }), "a-b-c-d", "unsafe characters become dashes");
  assert.equal(h("harness_session_id", { CONTEXTIUM_SESSION: "x".repeat(80) }).length, 64, "…and it is cut to 64");
});
