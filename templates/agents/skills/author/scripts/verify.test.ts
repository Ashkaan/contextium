// Test harness for verify.ts — round-trips each type through scaffold.ts then
// asserts verify passes the well-formed scaffold and fails a deliberately
// broken one.
//
// Run: node --test --experimental-strip-types .agents/skills/author/scripts/verify.test.ts
//
// peers: verify.ts, scaffold.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Home isolation. Anything the linters this exercises write under $HOME (a
// telemetry log, say) would count a test fixture as a real firing, and the
// hook-wiring cases read harness manifests under $HOME — so HOME moves to a
// throwaway path. check-skills.ts (which the skill branch delegates to) finds
// the published validator on PATH or under the REAL home, else uses its
// built-in reading; resolve it the same way and pin it before HOME moves.
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function resolveValidator(): string {
  if (process.env.SKILLS_REF_BIN) return process.env.SKILLS_REF_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "" && isExecutable(join(dir, "agentskills"))) return join(dir, "agentskills");
  }
  const venv = `${process.env.HOME || homedir()}/.local/lib/quality/skills-ref/bin/agentskills`;
  return isExecutable(venv) ? venv : "builtin";
}
const SKILLS_REF_BIN = resolveValidator();
const TMP = mkdtempSync(join(tmpdir(), "author-verify-test-"));
const HOME = join(TMP, "home");
mkdirSync(join(HOME, ".local/share"), { recursive: true });

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(SCRIPT_DIR, "verify.ts");
const SCAFFOLD = join(SCRIPT_DIR, "scaffold.ts");
// A scaffolded skill lands under `<workbench>/.agents/skills/`. Skill cases run
// against a throwaway SKILLS_ROOT — without it they would scaffold into the
// live tree.
const SKILLS_ROOT = join(TMP, "skills");
mkdirSync(SKILLS_ROOT);
// REPO_ROOT is a THROWAWAY workbench, not a live checkout: the hook/agent
// cases write into it.
const REPO_ROOT = join(TMP, "repo");
for (const d of [".agents/hooks", ".agents/checks", ".agents/agents"]) {
  mkdirSync(join(REPO_ROOT, d), { recursive: true });
}
after(() => rmSync(TMP, { recursive: true, force: true }));

// scaffold.ts resolves its write root through session-write-root.ts, which in a
// live session answers with that session's worktree. Pin it, or the hook/agent
// cases below scaffold into the real checkout.
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  SKILLS_REF_BIN,
  HOME,
  SKILLS_ROOT,
  CONTEXT_WRITE_ROOT: REPO_ROOT,
};

interface Run {
  rc: number | null;
  out: string;
  stdout: string;
}

function node(script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    env: opts.env ?? ENV,
    cwd: opts.cwd,
    timeout: 60_000,
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout.replace(/\n+$/, "") };
}

const verify = (...args: string[]): Run => node(VERIFY, args);
const verifyRc = (...args: string[]): number | null => verify(...args).rc;
const verifyOut = (...args: string[]): string => verify(...args).out;
/** The path scaffold.ts prints (stderr dropped, as `2>/dev/null` did). */
const scaffold = (...args: string[]): string => node(SCAFFOLD, args).stdout;

test("verify is executable", () => {
  assert.ok((statSync(VERIFY).mode & 0o111) !== 0, `not executable: ${VERIFY}`);
});

// ── Case 1: usage (missing args) → exit 2 ──
test("usage missing-arg exit2", () => {
  assert.equal(verifyRc("skill"), 2, "usage: expected exit 2");
});

// ── output-style: every one of these is SILENT at load time, which is the
// whole reason the branch exists. The parser ignores unknown keys and defaults
// keep-coding-instructions to false. ──
test("output-style frontmatter (unknown-key, description, keep-coding-instructions)", () => {
  const dir = mkdtempSync(join(TMP, "os-"));
  const mkOs = (name: string, body: string): string => {
    writeFileSync(join(dir, name), body);
    return join(dir, name);
  };

  assert.equal(
    verifyRc(
      "output-style",
      mkOs("ok.md", "---\nname: x\ndescription: does a thing\nkeep-coding-instructions: true\n---\n\nbody\n"),
    ),
    0,
    "output-style-ok: well-formed style should pass",
  );
  assert.ok(
    verifyOut(
      "output-style",
      mkOs("nodesc.md", "---\nname: x\nkeep-coding-instructions: true\n---\n\nbody\n"),
    ).includes("description"),
    "output-style-desc: missing description should be flagged",
  );
  assert.ok(
    verifyOut("output-style", mkOs("nokci.md", "---\nname: x\ndescription: d\n---\n\nbody\n")).includes(
      "keep-coding-instructions",
    ),
    "output-style-kci: absent keep-coding-instructions should be flagged",
  );
  assert.ok(
    verifyOut(
      "output-style",
      mkOs("typo.md", "---\nname: x\ndescription: d\nkeep_coding_instructions: true\n---\n\nbody\n"),
    ).includes("unknown frontmatter key"),
    "output-style-typo: underscore variant should be flagged as unknown",
  );
  assert.ok(
    verifyOut(
      "output-style",
      mkOs("badval.md", "---\nname: x\ndescription: d\nkeep-coding-instructions: yes\n---\n\nbody\n"),
    ).includes("not true|false"),
    "output-style-badval: non-boolean should be flagged",
  );
  // A word match treated hyphen as a non-word boundary, so each of these five
  // substrings of the two hyphenated field names passed as a KNOWN key.
  for (const bogus of ["keep", "coding", "instructions", "force", "plugin"]) {
    const p = mkOs(
      `sub-${bogus}.md`,
      `---\nname: x\ndescription: d\nkeep-coding-instructions: true\n${bogus}: true\n---\n\nbody\n`,
    );
    assert.ok(
      verifyOut("output-style", p).includes("unknown frontmatter key"),
      `output-style-substring-${bogus}: \`${bogus}:\` should be flagged as unknown`,
    );
  }
  assert.equal(
    verifyRc(
      "output-style",
      mkOs(
        "plugin.md",
        "---\nname: x\ndescription: d\nkeep-coding-instructions: false\nforce-for-plugin: true\n---\n\nbody\n",
      ),
    ),
    0,
    "output-style-plugin: all four documented keys should pass",
  );
});

// ── Case 2: skill round-trip → verify passes ──
test("skill scaffold verifies", () => {
  // Absolute path: the skill branch of scaffold.ts prints one, unlike the
  // hook/agent branches below.
  const path = scaffold("skill", "zz-verify-test-skill");
  const r = verify("skill", path);
  assert.equal(r.rc, 0, `skill-ok: expected pass; got ${r.rc}: ${r.out}`);
});

// ── Case 3: agent round-trip → verify passes; broken agent → fails ──
test("agent ok-then-broken-field", () => {
  const path = join(REPO_ROOT, scaffold("agent", "zz-verify-test-agent"));
  assert.equal(verifyRc("agent", path), 0, "agent-ok: expected pass");
  // Break it: strip the `model:` line → missing required field.
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    text
      .split("\n")
      .filter((l) => !l.startsWith("model:"))
      .join("\n"),
  );
  assert.notEqual(verifyRc("agent", path), 0, "agent-broken: expected fail on missing model:");
});

// ── Case 4: hook round-trip → verify passes; a process.exit → fails ──
//
// The scaffold writes a TypeScript hook; its safe-mode gate is "never ends
// through process.exit", the TypeScript counterpart of `set -euo pipefail`.
test("hook ok-then-missing-safemode", () => {
  const path = join(REPO_ROOT, scaffold("hook", "zz-verify-test-hook"));
  assert.ok(path.endsWith(".ts"), `the scaffold wrote ${path}`);
  let r = verify("hook", path);
  assert.equal(r.rc, 0, `hook-ok: expected pass; got ${r.rc}: ${r.out}`);
  // Break it: end through process.exit.
  writeFileSync(path, `${readFileSync(path, "utf8")}process.exit(0);\n`);
  r = verify("hook", path);
  assert.notEqual(r.rc, 0, "hook-broken: expected fail on process.exit");
  assert.ok(r.out.includes("process.exit"), r.out);
});

// A scaffolded check is held to the same TypeScript gates.
test("check ok-then-process-exit", () => {
  const path = join(REPO_ROOT, scaffold("hook", "zz-verify-test-check", "checks"));
  assert.ok(path.endsWith(".ts"), `the scaffold wrote ${path}`);
  let r = verify("hook", path);
  assert.equal(r.rc, 0, `check-ok: expected pass; got ${r.rc}: ${r.out}`);
  // Break it: end through process.exit.
  writeFileSync(path, `${readFileSync(path, "utf8")}process.exit(0);\n`);
  r = verify("hook", path);
  assert.notEqual(r.rc, 0, "check-broken: expected fail on process.exit");
  assert.ok(r.out.includes("process.exit"), r.out);
});

// The bash hook's gates are unchanged: a hand-written bash hook passes with
// safe mode and fails without it.
test("bash hook ok-then-missing-safemode", () => {
  const path = join(REPO_ROOT, ".agents/hooks/zz-verify-test-bash-hook.sh");
  writeFileSync(path, "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  let r = verify("hook", path);
  assert.equal(r.rc, 0, `hook-ok: expected pass; got ${r.rc}: ${r.out}`);
  // Break it: remove `set -euo pipefail`.
  writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
  r = verify("hook", path);
  assert.notEqual(r.rc, 0, "hook-broken: expected fail on missing safe-mode");
  assert.ok(r.out.includes("hook missing `set -euo pipefail`"), r.out);
});

test("a TypeScript hook that does not parse fails", () => {
  const path = join(REPO_ROOT, ".agents/hooks/zz-verify-test-badsyntax.ts");
  writeFileSync(path, "const x: number = ;\n");
  const r = verify("hook", path);
  assert.equal(r.rc, 1, r.out);
  assert.ok(r.out.includes("does not parse as TypeScript"), r.out);
});

// Type stripping only parses; it accepts early errors the runtime rejects
// before the hook's first line runs (a redeclared const, a duplicate export).
test("a TypeScript hook the runtime rejects fails, though it strips cleanly", () => {
  const path = join(REPO_ROOT, ".agents/hooks/zz-verify-test-redeclared.ts");
  writeFileSync(
    path,
    'import { readFileSync } from "node:fs";\nconst x: number = 1;\nconst x = 2;\nvoid readFileSync;\n',
  );
  const r = verify("hook", path);
  assert.equal(r.rc, 1, r.out);
  assert.ok(r.out.includes("does not parse as TypeScript"), r.out);
  assert.ok(r.out.includes("already been declared"), r.out);
  rmSync(path, { force: true });
});

test("a TypeScript hook with top-level await and imports still parses", () => {
  const path = join(REPO_ROOT, ".agents/hooks/zz-verify-test-tla.ts");
  writeFileSync(
    path,
    'import { readFileSync } from "node:fs";\nconst n: number = await Promise.resolve(1);\nvoid readFileSync;\nvoid n;\n',
  );
  const r = verify("hook", path);
  assert.ok(!r.out.includes("does not parse as TypeScript"), r.out);
  rmSync(path, { force: true });
});

// ── Principle gates (SKILL.md § The four principles) — each must FAIL a violating artifact ──

/** write_skill <name> <description> <body-line-count> */
function writeSkill(name: string, desc: string, lines: number): string {
  const dir = join(SKILLS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const body = Array.from({ length: lines }, (_, i) => `body line ${i}`);
  writeFileSync(
    join(dir, "SKILL.md"),
    [`---`, `name: ${name}`, `description: ${desc}`, `---`, `# ${name}`, ...body, ""].join("\n"),
  );
  return join(dir, "SKILL.md");
}

// P1/P2: description over the 1,024-char cap (the Agent Skills spec's) → FAIL;
// at the cap → no cap error.
test("desc-cap 1025-fails 1024-ok", () => {
  const name = "zz-verify-desccap";
  let p = writeSkill(name, "x".repeat(1025), 5);
  assert.notEqual(verifyRc("skill", p), 0, "desc-cap: 1025-char description should fail");
  p = writeSkill(name, "x".repeat(1024), 5);
  const out = verifyOut("skill", p);
  assert.equal(
    /exceeds|description is/i.test(out),
    false,
    `desc-cap: 1024-char description should pass the cap gate: ${out}`,
  );
});

// P1: first-person description → FAIL.
test("first-person rejected", () => {
  const p = writeSkill("zz-verify-fp", "I scaffold artifacts when you ask me to.", 5);
  assert.ok(verifyOut("skill", p).includes("first-person"), "first-person: first-person description should fail");
});

// P2/P4: an agent description longer than one sentence → FAIL; a one-sentence
// description carrying dotted names, an abbreviation and a decimal must NOT
// read as several (those dots are not sentence ends). Skills are exempt: the
// spec folds "when to use it" into the description, so a skill's is at least
// two sentences, and its length is the only cap.
test("one-sentence enforced for agents only; a long two-sentence skill passes", () => {
  const p = writeSkill("zz-verify-onesentence", "Scaffolds a thing for the repo. Use it when authoring one.", 600);
  const r = verify("skill", p);
  assert.equal(r.rc, 0, `one-sentence: a 600-line two-sentence skill should pass; got ${r.rc}: ${r.out}`);

  const agent = join(REPO_ROOT, ".agents/agents/zz-verify-onesentence-agent.md");
  writeFileSync(
    agent,
    "---\nname: zz-verify-onesentence-agent\ndescription: Reviews diffs. Dispatched by /implement-audit.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n",
  );
  assert.ok(
    verifyOut("agent", agent).includes("sentences"),
    "one-sentence: two-sentence agent description should fail",
  );

  writeFileSync(
    agent,
    "---\nname: zz-verify-onesentence-agent\ndescription: Reviews diffs when /implement-audit dispatches it.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n",
  );
  assert.equal(verifyRc("agent", agent), 0, "one-sentence: one-sentence agent description should pass");
});

// A skill frontmatter key outside the Agent Skills spec's six is refused by
// check-skills.ts (the published validator), which verify delegates to; the
// retired repo keys are the case that matters. An agent's misspelled key is
// silently ignored at load, so the guard stays for agents.
test("retired skill keys refused via check-skills.ts; agent unknown keys flagged", () => {
  const name = "zz-verify-unknownkey";
  const dir = join(SKILLS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const writeSkillFm = (...fm: string[]): void => {
    writeFileSync(
      join(dir, "SKILL.md"),
      ["---", `name: ${name}`, "description: Scaffolds a thing.", ...fm, "---", `# ${name}`, "body", ""].join("\n"),
    );
  };

  writeSkillFm("steps:", "  - id: one");
  let out = verifyOut("skill", join(dir, "SKILL.md"));
  assert.ok(
    out.includes("Unexpected fields in frontmatter: steps"),
    `unknown-keys: \`steps:\` should fail through check-skills.ts: ${out}`,
  );

  writeSkillFm("allowed-tools: Bash Read", "metadata:", '  peers: "scripts/x.sh"');
  out = verifyOut("skill", join(dir, "SKILL.md"));
  assert.equal(/Unexpected fields|FAIL/.test(out), false, `unknown-keys: the spec's fields must pass: ${out}`);

  const agent = join(REPO_ROOT, ".agents/agents/zz-verify-unknownkey-agent.md");
  writeFileSync(
    agent,
    "---\nname: zz-verify-unknownkey-agent\ndescription: Reviews diffs.\nmodel: inherit\ntools:\n  - Read\npeers: []\nallowed-tools: Read\n---\nbody\n",
  );
  assert.ok(
    verifyOut("agent", agent).includes("unknown frontmatter key"),
    "unknown-keys: `allowed-tools:` on an agent should be flagged",
  );
});

// P1: top-level hook using exit 1 → FAIL; checks/ hook using exit 1 → PASS.
test("hook-placement top-exit1-fails checks-ok", () => {
  const top = join(REPO_ROOT, ".agents/hooks/zz-verify-hooktop.sh");
  writeFileSync(top, "#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n");
  const out = verifyOut("hook", top);
  assert.ok(out.includes("NON-blocking"), "hook-placement: top-level exit 1 should fail");
  assert.ok(
    out.includes(".agents/checks"),
    `hook-placement: the flag must name where a check belongs: ${out}`,
  );
  const path = scaffold("hook", "zz-verify-hookchk", "checks");
  assert.ok(path.startsWith(".agents/checks/"), `hook-placement: scaffold put the check at ${path}`);
  const r = verify("hook", join(REPO_ROOT, path));
  assert.equal(r.rc, 0, `hook-placement: a toolchain check's exit 1 should pass; got ${r.rc}: ${r.out}`);
});

test("a top-level TypeScript hook that exits 1 fails", () => {
  const top = join(REPO_ROOT, ".agents/hooks/zz-verify-hooktop-ts.ts");
  writeFileSync(top, 'process.stderr.write("no\\n");\nprocess.exitCode = 1;\n');
  const out = verifyOut("hook", top);
  assert.ok(out.includes("NON-blocking"), `a top-level exitCode = 1 should fail: ${out}`);
});

// P1/P2: agent with empty allowed-tools → FAIL.
test("agent-tools empty-rejected", () => {
  const p = join(REPO_ROOT, ".agents/agents/zz-verify-agenttools.md");
  writeFileSync(
    p,
    "---\nname: zz-verify-agenttools\ndescription: Reviews diffs.\nmodel: inherit\ntools: []\npeers: []\n---\nbody\n",
  );
  assert.ok(verifyOut("agent", p).includes("tools is empty"), "agent-tools: empty allowed-tools should fail");
});

// ── Adversarial-review hardening (probe/code-reviewer findings) ──

// Finding 1: a folded/block-scalar description must NOT bypass the cap or the
// first-person scan (frontmatterValue folds continuation lines).
test("desc-folded cap not bypassed", () => {
  const name = "zz-verify-folded";
  const dir = join(SKILLS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: >\n  ${"x".repeat(1600)}\n---\n# ${name}\nbody\n`,
  );
  const out = verifyOut("skill", join(dir, "SKILL.md"));
  assert.ok(
    /description is|exceeds/i.test(out),
    `desc-folded: folded 1600-char description should fail the cap: ${out}`,
  );
});

// Finding 2: first-person markers beyond standalone "I" are caught.
test("first-person my/we caught", () => {
  const p = writeSkill("zz-verify-fpw", "My job is to scaffold things for the repo.", 5);
  assert.ok(verifyOut("skill", p).includes("first-person"), "fp-words: 'My job' should be flagged first-person");
});

// Finding 3: a top-level hook that blocks via exit 1 inside a helper fn is caught.
test("hook exit1-via-fn caught", () => {
  const p = join(REPO_ROOT, ".agents/hooks/zz-verify-hookind.sh");
  writeFileSync(p, "#!/usr/bin/env bash\nset -euo pipefail\nblock() { exit 1; }\nblock\n");
  assert.ok(verifyOut("hook", p).includes("NON-blocking"), "hook-indirect: exit 1 inside a fn should be flagged");
});

// Finding 4: a block-style `tools:` list is non-empty (no false positive).
test("block-style tools accepted", () => {
  const p = join(REPO_ROOT, ".agents/agents/zz-verify-tblock.md");
  writeFileSync(
    p,
    "---\nname: zz-verify-tblock\ndescription: Reviews diffs.\nmodel: inherit\ntools:\n  - Read\n  - Grep\npeers: []\n---\nbody\n",
  );
  assert.equal(verifyRc("agent", p), 0, "tools-block: block-style tools: should pass");
});

// Finding 5: an external https .md URL in a reference is NOT a second-hop; a
// local .md link IS.
test("ref https-ok local-flagged", () => {
  const name = "zz-verify-refs";
  const dir = join(SKILLS_ROOT, name);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeSkill(name, "Scaffolds a thing for the repo.", 5);
  writeFileSync(join(dir, "references/ok.md"), "See [docs](https://code.claude.com/docs/en/skills.md).\n");
  let out = verifyOut("skill", join(dir, "SKILL.md"));
  assert.equal(out.includes("another local .md"), false, "ref-url: https .md URL should NOT be flagged");
  writeFileSync(join(dir, "references/bad.md"), "See [sibling](other.md).\n");
  out = verifyOut("skill", join(dir, "SKILL.md"));
  assert.ok(out.includes("another local .md"), "ref-local: local .md link should be flagged");
});

// ── The wiring check depends on finding the WORKBENCH ──
// `verify.ts` climbs `../../../..` from its own real directory
// (`<workbench>/.agents/skills/author/scripts/`) to find it, and that climb
// answers first whenever the script sits in an installed workbench. The
// fallback rungs are CLAUDE_PROJECT_DIR and `git rev-parse`, each PROVEN by
// `.agents/skills/` before it is accepted. To exercise the fallbacks this case
// runs a COPY of the scripts folder from a scratch dir laid out like the
// template repo (`templates/agents/skills/author/scripts/`, beside a copy of
// the exit helper it imports), where the climb lands on a directory that is no
// workbench at all.
//
// Both directions are asserted. With a resolvable root the wiring answer is a
// real reading: a TOP-LEVEL hook fires from nothing until a hook manifest names
// it — Claude Code's ~/.claude/settings.json, Codex's ~/.codex/hooks.json, or
// the workbench's .agents/hooks.json (Antigravity) — so verify.ts WARNs
// (non-blocking) when none does; with no workbench root it says it could not
// look rather than claiming "not wired" about a file it never opened. A check
// under .agents/checks/ gets no wiring claim at all: what fires a check is a
// close gate in land.ts, and a WARN against a dispatcher that does not exist
// would report every check unwired.
test("hook-wiring top-level-warns check-silent root-unresolved-says-so", () => {
  const name = "zz-verify-wiring";
  const iso = mkdtempSync(join(TMP, "iso-"));
  mkdirSync(join(iso, "templates/agents/skills/author"), { recursive: true });
  mkdirSync(join(iso, "templates/agents/packages/cli-exit"), { recursive: true });
  cpSync(SCRIPT_DIR, join(iso, "templates/agents/skills/author/scripts"), { recursive: true });
  copyFileSync(
    join(SCRIPT_DIR, "../../../packages/cli-exit/cli-exit.ts"),
    join(iso, "templates/agents/packages/cli-exit/cli-exit.ts"),
  );
  const isoVerify = join(iso, "templates/agents/skills/author/scripts/verify.ts");
  const path = scaffold("hook", name);

  // Workbench-shaped, or resolveRepoRoot will not take it as the workbench.
  // An empty home, so the only manifest that can answer is the one named.
  const fake = mkdtempSync(join(TMP, "fake-"));
  const fakeHome = mkdtempSync(join(TMP, "fakehome-"));
  mkdirSync(join(fake, ".agents/skills"), { recursive: true });
  const env = { ...ENV, HOME: fakeHome, CLAUDE_PROJECT_DIR: fake };
  writeFileSync(join(fake, ".agents/hooks.json"), `{"hooks":{"PreToolUse":[{"command":"${name}.ts"}]}}\n`);
  let r = node(isoVerify, ["hook", join(REPO_ROOT, path)], { env });
  assert.equal(r.rc, 0, `hook-wiring: wired hook should verify clean; got ${r.rc}: ${r.out}`);
  assert.equal(r.out.includes("not wired"), false, `hook-wiring: hook wired in .agents/hooks.json reported unwired: ${r.out}`);

  // Wired for Claude Code only: ~/.claude/settings.json names it.
  writeFileSync(join(fake, ".agents/hooks.json"), '{"hooks":{}}\n');
  mkdirSync(join(fakeHome, ".claude"));
  writeFileSync(
    join(fakeHome, ".claude/settings.json"),
    `{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"/wb/.agents/hooks/${name}.ts"}]}]}}\n`,
  );
  r = node(isoVerify, ["hook", join(REPO_ROOT, path)], { env });
  assert.equal(r.rc, 0, `hook-wiring: wired hook should verify clean; got ${r.rc}: ${r.out}`);
  assert.equal(
    r.out.includes("not wired"),
    false,
    `hook-wiring: hook wired in ~/.claude/settings.json reported unwired: ${r.out}`,
  );
  rmSync(join(fakeHome, ".claude/settings.json"));

  r = node(isoVerify, ["hook", join(REPO_ROOT, path)], { env });
  assert.equal(r.rc, 0, `hook-wiring: the wiring WARN must not block; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("not wired"), `hook-wiring: unwired top-level hook should WARN: ${r.out}`);

  // A check gets no wiring claim, wired or not.
  const cpath = scaffold("hook", "zz-verify-wiring-chk", "checks");
  r = node(isoVerify, ["hook", join(REPO_ROOT, cpath)], { env });
  assert.equal(r.rc, 0, `hook-wiring: a check should verify clean; got ${r.rc}: ${r.out}`);
  assert.equal(/wired/i.test(r.out), false, `hook-wiring: a check must get no wiring claim: ${r.out}`);

  // No rung can answer: not a workbench, CLAUDE_PROJECT_DIR empty, cwd `/`.
  r = node(isoVerify, ["hook", join(REPO_ROOT, path)], { env: { ...env, CLAUDE_PROJECT_DIR: "" }, cwd: "/" });
  assert.equal(r.rc, 0, `hook-wiring: expected exit 0 with no workbench root; got ${r.rc}: ${r.out}`);
  assert.ok(
    r.out.includes("could not find the workbench"),
    `hook-wiring: unresolved root should say so, not 'not wired': ${r.out}`,
  );
});

// The climb rung on its own: a copy installed at
// <workbench>/.agents/skills/author/scripts, invoked through a home link the
// way a harness invokes it (~/.agents/skills → <workbench>/.agents/skills),
// finds its workbench four levels up the REAL path with no other help —
// CLAUDE_PROJECT_DIR empty, cwd outside every repo — and reads that
// workbench's manifest.
test("hook-wiring climb finds the installed workbench through a home link", () => {
  const name = "zz-verify-wiring-climb";
  const wb = mkdtempSync(join(TMP, "wb-"));
  const fakeHome = mkdtempSync(join(TMP, "climbhome-"));
  mkdirSync(join(wb, ".agents/skills/author"), { recursive: true });
  mkdirSync(join(wb, ".agents/packages/cli-exit"), { recursive: true });
  mkdirSync(join(fakeHome, ".agents"));
  cpSync(SCRIPT_DIR, join(wb, ".agents/skills/author/scripts"), { recursive: true });
  copyFileSync(
    join(SCRIPT_DIR, "../../../packages/cli-exit/cli-exit.ts"),
    join(wb, ".agents/packages/cli-exit/cli-exit.ts"),
  );
  symlinkSync(join(wb, ".agents/skills"), join(fakeHome, ".agents/skills"));
  const linked = join(fakeHome, ".agents/skills/author/scripts/verify.ts");
  const path = scaffold("hook", name);
  writeFileSync(join(wb, ".agents/hooks.json"), `{"hooks":{"PreToolUse":[{"command":"${name}.ts"}]}}\n`);
  const r = node(linked, ["hook", join(REPO_ROOT, path)], {
    env: { ...ENV, HOME: fakeHome, CLAUDE_PROJECT_DIR: "" },
    cwd: "/",
  });
  assert.equal(r.rc, 0, `hook-wiring-climb: expected exit 0; got ${r.rc}: ${r.out}`);
  assert.equal(r.out.includes("WARN"), false, `hook-wiring-climb: the climb should find the workbench and its manifest: ${r.out}`);
});

// The dots that are not sentence ends — an abbreviation, a dotted filename, a
// decimal — must not split a one-sentence agent description.
test("abbreviation, dotted name and decimal are one sentence", () => {
  const agent = join(REPO_ROOT, ".agents/agents/zz-verify-dots-agent.md");
  writeFileSync(
    agent,
    "---\nname: zz-verify-dots-agent\ndescription: Reviews diffs (e.g. a SKILL.md edit or a 1.5 MB fixture) when /implement-audit dispatches it.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n",
  );
  const r = verify("agent", agent);
  assert.equal(r.rc, 0, `dots-not-sentences: one sentence with e.g./SKILL.md/1.5 should pass; got ${r.rc}: ${r.out}`);
});

// ── An agent's YAML is checked even where PyYAML is not installed ──
// A python3 without PyYAML (macOS's stock one) must neither pass malformed
// frontmatter nor fail a well-formed one: the fallback check catches the
// failure that matters — an unquoted value holding `: `.
test("agent-yaml checked without PyYAML", () => {
  const nopy = mkdtempSync(join(TMP, "nopy-"));
  writeFileSync(join(nopy, "python3"), '#!/bin/sh\necho "ModuleNotFoundError: No module named yaml" >&2\nexit 1\n');
  chmodSync(join(nopy, "python3"), 0o755);
  const env = { ...ENV, PATH: `${nopy}:${process.env.PATH ?? ""}` };
  const path = join(REPO_ROOT, scaffold("agent", "zz-verify-nopyyaml-agent"));
  let out = node(VERIFY, ["agent", path], { env }).out;
  assert.equal(
    out.includes("does not parse as YAML"),
    false,
    `agent-yaml-nopyyaml: a well-formed agent was flagged without PyYAML: ${out}`,
  );
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^description: .*$/m, "description: Different job: the reviewer reads code."),
  );
  out = node(VERIFY, ["agent", path], { env }).out;
  assert.ok(
    out.includes("does not parse as YAML"),
    `agent-yaml-nopyyaml: an unquoted ': ' passed without PyYAML: ${out}`,
  );
});
