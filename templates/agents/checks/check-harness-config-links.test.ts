// check-harness-config-links.test.ts — boundary rows for
// check-harness-config-links.ts: every link correct, a link replaced by a plain
// file, a dangling link, a real directory, a home that does not exist, --fix,
// and NEGATIVE manifest fixtures.
//
// Run: node --test --experimental-strip-types .agents/checks/check-harness-config-links.test.ts
//
// Hermetic — a fresh temp dir per case, with HARNESS_LINKS_HOME and
// HARNESS_LINKS_REPO standing in for the real ones and HOME pointed at a
// scratch folder, so nothing here reads or writes a live profile. The program
// is SPAWNED, never imported.
//
// The negative fixtures are the point of the suite, not an extra. A gate that
// only ever sees a correct tree proves nothing: the two failures worth catching
// are a manifest whose scripts are all present behind a matcher that never fires
// them, and a Codex manifest that quietly grew a second top-level key, which
// makes Codex ignore the whole file in silence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-harness-config-links.ts");
const TMP = mkdtempSync(join(tmpdir(), "harness-links-test-"));
const SCRATCH_HOME = join(TMP, "scratch-home");
mkdirSync(SCRATCH_HOME);
after(() => rmSync(TMP, { recursive: true, force: true }));

// The gate matches a handler by the SCRIPT its command names, so the fixture
// carries the bare path.
const INFRA_CMD = "bash .agents/hooks/check-host-infra-safety.sh";
const WRITE_CMD = "bash .agents/hooks/check-shared-checkout-write.sh";

type Json = { [key: string]: unknown };

function readJson(p: string): Json {
  return JSON.parse(readFileSync(p, "utf8")) as Json;
}

function writeJson(p: string, v: unknown): void {
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}

const cmd = (command: string) => ({ type: "command", command });

function claudeManifest(p: string, writeMatcher = "Edit|Write|MultiEdit|NotebookEdit|apply_patch|write|search_replace"): void {
  writeJson(p, {
    hooks: {
      PreToolUse: [
        { matcher: "Bash|run_terminal_command", hooks: [cmd(INFRA_CMD), cmd(WRITE_CMD)] },
        { matcher: writeMatcher, hooks: [cmd(WRITE_CMD)] },
      ],
    },
  });
}

/** A complete, correct sandbox. Every later case starts here and breaks ONE
 *  thing, so a failure names the break rather than the scaffolding. Returns
 *  the sandbox root; `home/` and `repo/` sit inside it. */
function mkfix(): string {
  const root = mkdtempSync(join(TMP, "case"));
  const h = join(root, "home");
  const r = join(root, "repo");
  for (const d of [
    `${h}/.claude`,
    `${h}/.agents`,
    `${h}/.codex`,
    `${h}/.gemini/config`,
    `${h}/.grok/hooks`,
    `${r}/.agents/skills/close`,
    `${r}/.agents/agents`,
    `${r}/.agents/hooks`,
    `${r}/.gemini`,
    `${r}/.agents/output-styles`,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  claudeManifest(`${h}/.claude/settings.json`);
  claudeManifest(`${r}/.agents/hooks/claude-hooks.json`);
  writeJson(`${r}/.agents/gemini-settings.json`, {
    context: { fileName: ["AGENTS.md"] },
    hooks: {
      BeforeTool: [
        { matcher: "run_shell_command", hooks: [cmd(INFRA_CMD), cmd(WRITE_CMD)] },
        { matcher: "write_file|replace", hooks: [cmd(WRITE_CMD)] },
      ],
    },
  });
  symlinkSync("../.agents/gemini-settings.json", `${r}/.gemini/settings.json`);
  writeJson(`${h}/.gemini/trustedFolders.json`, { [r]: "TRUST_FOLDER" });
  symlinkSync(`${r}/.agents/hooks/claude-hooks.json`, `${h}/.grok/hooks/contextium.json`);
  writeJson(`${r}/.agents/hooks.json`, {
    "host-infra-safety": {
      PreToolUse: [{ matcher: "run_command", hooks: [cmd("bash hooks/check-host-infra-safety.sh")] }],
    },
    "shared-checkout-write": {
      PreToolUse: [
        {
          matcher: "run_command|write_to_file|replace_file_content",
          hooks: [cmd("bash hooks/check-shared-checkout-write.sh")],
        },
      ],
    },
  });
  symlinkSync(`${r}/.agents/hooks/claude-hooks.json`, `${h}/.codex/hooks.json`);
  symlinkSync(`${r}/.agents/skills`, `${h}/.agents/skills`);
  symlinkSync(`${r}/.agents/agents`, `${h}/.claude/agents`);
  symlinkSync(`${r}/.agents/output-styles`, `${h}/.claude/output-styles`);
  symlinkSync(`${h}/.agents/skills`, `${h}/.claude/skills`);
  symlinkSync(`${h}/.agents/skills`, `${h}/.gemini/config/skills`);
  return root;
}

interface Run {
  out: string;
  rc: number | null;
}

/** Runs the gate against a sandbox; `out` is stdout and stderr together. */
function run(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: SCRATCH_HOME,
      HARNESS_LINKS_HOME: join(root, "home"),
      HARNESS_LINKS_REPO: join(root, "repo"),
    },
  });
  if (r.error) throw r.error;
  return { out: `${r.stdout}${r.stderr}`, rc: r.status };
}

/** Replace a link or file with a plain file holding `body`. */
function clobber(p: string, body: string): void {
  rmSync(p, { force: true });
  writeFileSync(p, body);
}

/** Rewrite a JSON file through `f`. */
function edit(p: string, f: (j: Json) => Json): void {
  writeJson(p, f(readJson(p)));
}

function says(out: string, needle: string): void {
  assert.ok(out.includes(needle), `output never mentions '${needle}':\n${out}`);
}

// ── Links ─────────────────────────────────────────────────────────────────

test("a correct tree", async (t) => {
  const r = run(mkfix());
  await t.test("passes", () => assert.equal(r.rc, 0, r.out));
  await t.test("and counts what it checked", () =>
    says(r.out, "OK — 8 links verified, 5 manifests carry the required hooks"),
  );
});

test("a link replaced by a plain file", async (t) => {
  const F = mkfix();
  clobber(`${F}/home/.claude/skills`, "# copy\n");
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named as a regular file", () => says(r.out, "is a regular file, not a symlink"));
});

test("a link pointing somewhere else", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.agents/skills`);
  symlinkSync(`${F}/repo/nowhere`, `${F}/home/.agents/skills`);
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names where it points", () => says(r.out, `points at ${F}/repo/nowhere`));
});

test("a dangling link", async (t) => {
  const F = mkfix();
  rmSync(`${F}/repo/.agents/agents`, { recursive: true });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named dangling", () => says(r.out, "DANGLING"));
});

// A wired Gemini CLI that does not trust the workbench loads none of it.
test("Gemini CLI not trusting the workbench is not ready", async (t) => {
  let F = mkfix();
  writeFileSync(`${F}/home/.gemini/trustedFolders.json`, "{}\n");
  let r = run(F);
  await t.test("no entry exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and says so", () => says(r.out, "does not trust"));
  F = mkfix();
  writeJson(`${F}/home/.gemini/trustedFolders.json`, { [`${F}/repo`]: "DO_NOT_TRUST" });
  r = run(F);
  await t.test("an entry that says anything but TRUST_FOLDER is not trust", () => assert.equal(r.rc, 1, r.out));
  await t.test("and says so too", () => says(r.out, "does not trust"));
});

test("a missing link", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.gemini/config/skills`);
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named missing", () => says(r.out, "is missing"));
});

test("a real directory at a link path", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.claude/skills`);
  mkdirSync(`${F}/home/.claude/skills`);
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named a real directory", () => says(r.out, "is a real directory"));
});

test("a home that does not exist is not drift", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.gemini`, { recursive: true });
  const r = run(F);
  await t.test("exits 0", () => assert.equal(r.rc, 0, r.out));
  await t.test("and is counted as skipped", () => says(r.out, "(1 skipped: no such home)"));
});

// ── --fix ─────────────────────────────────────────────────────────────────

test("--fix relinks a clobbered link", async (t) => {
  const F = mkfix();
  clobber(`${F}/home/.claude/skills`, "# machine-written\n");
  const r = run(F, "--fix");
  await t.test("exits 0", () => assert.equal(r.rc, 0, r.out));
  await t.test("keeping the displaced file", () =>
    says(r.out, `kept the displaced file at ${F}/home/.claude/skills.pre-link`),
  );
  await t.test("whose content survives", () =>
    assert.match(readFileSync(`${F}/home/.claude/skills.pre-link`, "utf8"), /machine-written/),
  );
  const again = run(F);
  await t.test("and the link is right afterwards", () => assert.equal(again.rc, 0, again.out));
});

test("a second --fix never overwrites an earlier .pre-link", () => {
  const F = mkfix();
  writeFileSync(`${F}/home/.claude/skills.pre-link`, "first\n");
  clobber(`${F}/home/.claude/skills`, "second\n");
  run(F, "--fix");
  assert.match(readFileSync(`${F}/home/.claude/skills.pre-link`, "utf8"), /first/);
});

test("--fix repoints a link that points elsewhere", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.agents/skills`);
  symlinkSync(`${F}/repo/wrong`, `${F}/home/.agents/skills`);
  const r = run(F, "--fix");
  await t.test("exits 0", () => assert.equal(r.rc, 0, r.out));
  await t.test("to the workbench", () => says(readlinkSync(`${F}/home/.agents/skills`), `${F}/repo/.agents/skills`));
});

test("--fix refuses a real directory", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.claude/skills`);
  mkdirSync(`${F}/home/.claude/skills`);
  const r = run(F, "--fix");
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and says to move it aside", () => says(r.out, "it is a real directory"));
});

test("--fix refuses a target that does not exist", async (t) => {
  const F = mkfix();
  rmSync(`${F}/repo/.agents/agents`, { recursive: true });
  rmSync(`${F}/home/.claude/agents`);
  const r = run(F, "--fix");
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and says why", () => says(r.out, "its target does not exist"));
});

// ── Manifests (negative fixtures) ─────────────────────────────────────────

test("a Claude manifest whose matcher misses Write", async (t) => {
  const F = mkfix();
  claudeManifest(`${F}/home/.claude/settings.json`, "Edit|MultiEdit");
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names the tool", () =>
    says(r.out, "does not route Write to check-shared-checkout-write.sh"),
  );
});

test("the workbench manifest lost the infra guard", async (t) => {
  const F = mkfix();
  edit(`${F}/repo/.agents/hooks/claude-hooks.json`, (j) => {
    const groups = (j.hooks as Json).PreToolUse as Array<{ hooks: unknown[] }>;
    groups[0]?.hooks.shift();
    return j;
  });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and Codex, which links to it, is named", () =>
    says(r.out, "Codex manifest does not route Bash to check-host-infra-safety.sh"),
  );
});

test("a Codex manifest with an extra top-level key", async (t) => {
  const F = mkfix();
  edit(`${F}/repo/.agents/hooks/claude-hooks.json`, (j) => ({ ...j, skillOverrides: {} }));
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is refused for what Codex does with it", () =>
    says(r.out, "carries top-level key(s) besides hooks: skillOverrides"),
  );
});

test("an Antigravity manifest without the write guard", async (t) => {
  const F = mkfix();
  edit(`${F}/repo/.agents/hooks.json`, (j) => {
    delete j["shared-checkout-write"];
    return j;
  });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names a tool it no longer guards", () =>
    says(r.out, "Antigravity manifest does not route write_to_file"),
  );
});

// With a tools= record, a tool it does not name is not wired here: its links
// and guards are not asked for. One it names still is.
test("tools= without claude or antigravity: their links and guards are not asked for", () => {
  const F = mkfix();
  writeFileSync(`${F}/repo/.agents/harness`, "harness=codex\nagent=codex\ntools=codex grok\n");
  for (const p of [".claude/skills", ".claude/agents", ".claude/output-styles", ".gemini/config/skills"]) {
    rmSync(`${F}/home/${p}`);
  }
  writeFileSync(`${F}/home/.claude/settings.json`, "{}\n");
  const r = run(F);
  assert.equal(r.rc, 0, r.out);
});

test("tools= naming claude still asks for its links", () => {
  const F = mkfix();
  writeFileSync(`${F}/repo/.agents/harness`, "harness=claude\nagent=claude\ntools=claude\n");
  rmSync(`${F}/home/.claude/agents`);
  const r = run(F);
  assert.equal(r.rc, 1, r.out);
});

// A tool tools= does not name: a kept (customized) manifest or a foreign link
// of it is not checked, since the installer no longer wires that tool.
test("a dropped Antigravity's kept manifest and a foreign Grok link are not asked about", () => {
  const F = mkfix();
  writeFileSync(`${F}/repo/.agents/harness`, "harness=claude\nagent=claude\ntools=claude codex gemini\n");
  writeFileSync(`${F}/repo/.agents/hooks.json`, '{"mine": true}\n');
  rmSync(`${F}/home/.gemini/config/skills`);
  rmSync(`${F}/home/.grok/hooks/contextium.json`);
  symlinkSync(`${F}/repo/elsewhere.json`, `${F}/home/.grok/hooks/contextium.json`);
  const r = run(F);
  assert.equal(r.rc, 0, r.out);
});

test("no Antigravity manifest is a workbench that does not use Antigravity, not drift", () => {
  const F = mkfix();
  rmSync(`${F}/repo/.agents/hooks.json`);
  const r = run(F);
  assert.equal(r.rc, 0, r.out);
});

test("the workbench manifest without Grok's write tools", async (t) => {
  const F = mkfix();
  claudeManifest(`${F}/repo/.agents/hooks/claude-hooks.json`, "Edit|Write|MultiEdit|NotebookEdit|apply_patch");
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names Grok's tool", () =>
    says(r.out, "Grok Build manifest does not route write to check-shared-checkout-write.sh"),
  );
});

test("a Gemini settings file without the write guard", async (t) => {
  const F = mkfix();
  edit(`${F}/repo/.agents/gemini-settings.json`, (j) => {
    ((j.hooks as Json).BeforeTool as unknown[]).splice(1, 1);
    return j;
  });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names the tool", () =>
    says(r.out, "Gemini CLI manifest does not route write_file to check-shared-checkout-write.sh"),
  );
});

test("a harness that was not wired has no link, and that is not drift", () => {
  const F = mkfix();
  rmSync(`${F}/home/.grok/hooks/contextium.json`);
  const r = run(F);
  assert.equal(r.rc, 0, r.out);
});

test("a real ~/.claude/output-styles where the link goes", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.claude/output-styles`);
  mkdirSync(`${F}/home/.claude/output-styles`);
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named", () => says(r.out, "output-styles is a real directory"));
});

test("a Grok hooks link that points elsewhere", async (t) => {
  const F = mkfix();
  rmSync(`${F}/home/.grok/hooks/contextium.json`);
  symlinkSync(`${F}/repo/elsewhere.json`, `${F}/home/.grok/hooks/contextium.json`);
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named", () => says(r.out, `contextium.json points at ${F}/repo/elsewhere.json`));
});

test("a real .gemini/settings.json where the link goes", async (t) => {
  const F = mkfix();
  clobber(`${F}/repo/.gemini/settings.json`, "{}\n");
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and is named a regular file", () => says(r.out, ".gemini/settings.json is a regular file"));
});

test("an unreadable manifest", async (t) => {
  const F = mkfix();
  writeFileSync(`${F}/home/.claude/settings.json`, "{not json");
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and says so", () => says(r.out, "is not readable JSON"));
});

test("no ~/.codex means no Codex manifest to check", () => {
  const F = mkfix();
  rmSync(`${F}/home/.codex`, { recursive: true });
  const r = run(F);
  assert.equal(r.rc, 0, r.out);
});

// Hook groups and a group's handlers are ARRAYS in every harness's format;
// an object in their place is a manifest no harness can run, however its
// values read. Only Antigravity's top level is a map (hook name → events).
const asObject = (a: unknown[]): Json => Object.fromEntries(a.map((v, i) => [String(i), v]));

test("hook groups that are an object, not an array", async (t) => {
  const F = mkfix();
  edit(`${F}/home/.claude/settings.json`, (j) => {
    const h = j.hooks as Json;
    h.PreToolUse = asObject(h.PreToolUse as unknown[]);
    return j;
  });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names a tool", () =>
    says(r.out, "Claude Code manifest does not route Bash to check-host-infra-safety.sh"),
  );
});

test("a group's handlers that are an object, not an array", async (t) => {
  const F = mkfix();
  edit(`${F}/repo/.agents/gemini-settings.json`, (j) => {
    for (const g of (j.hooks as Json).BeforeTool as Json[]) g.hooks = asObject(g.hooks as unknown[]);
    return j;
  });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names a tool", () =>
    says(r.out, "Gemini CLI manifest does not route run_shell_command to check-host-infra-safety.sh"),
  );
});

test("Antigravity events that are an object, not an array", async (t) => {
  const F = mkfix();
  edit(`${F}/repo/.agents/hooks.json`, (j) => {
    for (const spec of Object.values(j) as Json[]) spec.PreToolUse = asObject(spec.PreToolUse as unknown[]);
    return j;
  });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names a tool", () =>
    says(r.out, "Antigravity manifest does not route run_command to check-host-infra-safety.sh"),
  );
});

// A tool tools= names was wired by the installer, so its manifest must be
// there: a deleted one is guards that stopped running, not a harness that was
// never picked.
test("tools= naming every harness requires every manifest", async (t) => {
  const F = mkfix();
  writeFileSync(`${F}/repo/.agents/harness`, "harness=claude\nagent=claude\ntools=claude codex grok gemini antigravity\n");
  const ok = run(F);
  await t.test("present, they pass", () => assert.equal(ok.rc, 0, ok.out));
  for (const p of [
    `${F}/home/.claude/settings.json`,
    `${F}/home/.codex/hooks.json`,
    `${F}/home/.grok/hooks/contextium.json`,
    `${F}/repo/.gemini/settings.json`,
    `${F}/repo/.agents/hooks.json`,
  ]) {
    rmSync(p);
  }
  const r = run(F);
  await t.test("deleted, exits 1", () => assert.equal(r.rc, 1, r.out));
  for (const [label, p] of [
    ["Claude Code", ".claude/settings.json"],
    ["Codex", ".codex/hooks.json"],
    ["Grok Build", ".grok/hooks/contextium.json"],
    ["Gemini CLI", ".gemini/settings.json"],
    ["Antigravity", ".agents/hooks.json"],
  ]) {
    await t.test(`and names ${label}'s`, () => says(r.out, `${label} manifest missing at`) );
    await t.test(`at ${p}`, () => says(r.out, p));
  }
});

test("tools= naming claude requires its settings even where ~/.claude is gone", async (t) => {
  const F = mkfix();
  writeFileSync(`${F}/repo/.agents/harness`, "harness=claude\nagent=claude\ntools=claude\n");
  rmSync(`${F}/home/.claude`, { recursive: true });
  const r = run(F);
  await t.test("exits 1", () => assert.equal(r.rc, 1, r.out));
  await t.test("and names the manifest", () => says(r.out, "Claude Code manifest missing at"));
});

test("an unknown flag", () => {
  const r = run(mkfix(), "--bogus");
  assert.equal(r.rc, 1, r.out);
});
