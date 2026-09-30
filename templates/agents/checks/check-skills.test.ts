// check-skills.test.ts — the boundary rows of check-skills.ts: the validator
// relayed, the three local rules (metadata, a folder without SKILL.md, the
// state/ convention), the scan modes land.ts calls, and the two caller errors.
//
// Run: node --test --experimental-strip-types templates/agents/checks/check-skills.test.ts
//      VALIDATOR=<path to agentskills> node --test … to run the rows against the
//      published validator instead of the built-in reading (the default here,
//      because it is what a machine without Python runs).
//
// Fixtures are throwaway skill trees under a temp dir; the scan-mode rows use
// a real `git init`-ed tree, because those modes read `git diff` and
// `git ls-files --others`. The script is spawned as a program, never imported.
// The rows assert the validator's own wording, so they hold for either one.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "check-skills.ts");
const VALIDATOR = process.env.VALIDATOR || "builtin";
const TMP = mkdtempSync(join(tmpdir(), "check-skills-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let ROOT = join(TMP, "skills");
mkdirSync(ROOT, { recursive: true });

/** make_skill <name> <frontmatter-body> [body-text] — writes $ROOT/<name>/SKILL.md */
function makeSkill(name: string, fm: string, body = `# ${name}`): void {
  mkdirSync(join(ROOT, name), { recursive: true });
  writeFileSync(join(ROOT, name, "SKILL.md"), `---\n${fm}\n---\n${body}\n`);
}

function runCheck(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CHECK, ...args], {
    cwd: ROOT,
    env: { ...process.env, SKILLS_ROOT: ROOT, SKILLS_REF_BIN: VALIDATOR, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}`.replace(/\n+$/, ""), rc: r.status };
}

/**
 * expect <ok|violation|caller-error> <needle-or-empty> <args…> — runs the check
 * with SKILLS_ROOT=ROOT, asserts the exit code (0 / 1 / 2) and, when a needle
 * is given, that the combined output mentions it.
 */
function expect(want: "ok" | "violation" | "caller-error", needle: string, ...args: string[]): void {
  const { out, rc } = runCheck(args);
  const got = rc === 0 ? "ok" : rc === 1 ? "violation" : rc === 2 ? "caller-error" : `exit ${rc}`;
  assert.equal(got, want, `expected ${want}, got ${got}: ${out}`);
  if (needle !== "") assert.ok(out.includes(needle), `output lacks "${needle}": ${out}`);
}

const MINIMAL = "name: alpha\ndescription: Does one thing, and is used when that thing is asked for.";

// 1. A minimal valid skill.
test("minimal valid skill", () => {
  makeSkill("alpha", MINIMAL);
  expect("ok", "OK — 1 skill(s) checked", "alpha");
});

// 2. A retired key is relayed from the validator.
test("argument-hint is an unexpected field", () => {
  makeSkill("alpha", `${MINIMAL}\nargument-hint: "[x]"`);
  expect("violation", "alpha/SKILL.md: Unexpected fields in frontmatter: argument-hint", "alpha");
});

// 3. name ≠ folder, relayed.
test("name must equal the folder name", () => {
  makeSkill("alpha", "name: beta\ndescription: Does one thing.");
  expect("violation", "alpha/SKILL.md:", "alpha");
});

// 3b. The validator's own rules, one row each, in its wording — what the
//     built-in reading must reproduce where the published validator is absent.
function rowsSkill(name: string, fm: string, want: "ok" | "violation", needle: string): void {
  rmSync(join(ROOT, name), { recursive: true, force: true });
  makeSkill(name, fm);
  try {
    expect(want, needle, name);
  } finally {
    rmSync(join(ROOT, name), { recursive: true, force: true });
  }
}
const LONG = "a".repeat(65);
const ROWS: [string, string, string, "ok" | "violation", string][] = [
  ["an uppercase name", "Alpha", "name: Alpha\ndescription: x", "violation", "must be lowercase"],
  ["a doubled hyphen", "a--b", "name: a--b\ndescription: x", "violation", "consecutive hyphens"],
  ["a trailing hyphen", "ab-", "name: ab-\ndescription: x", "violation", "cannot start or end with a hyphen"],
  ["an underscore", "a_b", "name: a_b\ndescription: x", "violation", "contains invalid characters"],
  ["a 65-character name", LONG, `name: ${LONG}\ndescription: x`, "violation", "exceeds 64 character limit (65 chars)"],
  ["no description", "alpha", "name: alpha", "violation", "Missing required field in frontmatter: description"],
  ["no name", "alpha", "description: x", "violation", "Missing required field in frontmatter: name"],
  ["an empty description", "alpha", 'name: alpha\ndescription: ""', "violation", "Field 'description' must be a non-empty string"],
  [
    "a 1025-character description",
    "alpha",
    `name: alpha\ndescription: ${"x".repeat(1025)}`,
    "violation",
    "Description exceeds 1024 character limit (1025 chars)",
  ],
  ["a 1024-character description", "alpha", `name: alpha\ndescription: ${"x".repeat(1024)}`, "ok", "OK — 1 skill(s) checked"],
  [
    "a 501-character compatibility",
    "alpha",
    `name: alpha\ndescription: x\ncompatibility: ${"x".repeat(501)}`,
    "violation",
    "Compatibility exceeds 500 character limit (501 chars)",
  ],
  ["an unclosed quote", "alpha", 'name: alpha\ndescription: "unclosed', "violation", "Invalid YAML in frontmatter"],
  [
    "an unclosed quote in a metadata value",
    "alpha",
    'name: alpha\ndescription: x\nmetadata:\n  peers: "unclosed',
    "violation",
    "Invalid YAML in frontmatter",
  ],
  [
    "text after a metadata value's closing quote",
    "alpha",
    'name: alpha\ndescription: x\nmetadata:\n  peers: "a b" trailing',
    "violation",
    "Invalid YAML in frontmatter",
  ],
  [
    "allowed-tools as a block list",
    "alpha",
    "name: alpha\ndescription: x\nallowed-tools:\n  - Bash\n  - Read",
    "ok",
    "OK — 1 skill(s) checked",
  ],
];
for (const [label, name, fm, want, needle] of ROWS) {
  test(label, () => rowsSkill(name, fm, want, needle));
}
test("no frontmatter", () => {
  mkdirSync(join(ROOT, "alpha"), { recursive: true });
  writeFileSync(join(ROOT, "alpha/SKILL.md"), "# no frontmatter\n");
  expect("violation", "must start with YAML frontmatter", "alpha");
});
test("frontmatter never closed", () => {
  writeFileSync(join(ROOT, "alpha/SKILL.md"), "---\nname: alpha\ndescription: x\n");
  expect("violation", "not properly closed", "alpha");
  rmSync(join(ROOT, "alpha"), { recursive: true, force: true });
});

// 4. metadata.peers as a string is fine.
test("metadata.peers string", () => {
  makeSkill("alpha", `${MINIMAL}\nmetadata:\n  peers: "a/b.sh c/d.md"`);
  expect("ok", "OK — 1 skill(s) checked", "alpha");
});
// The published validator reads strictyaml, which rejects flow syntax
// outright — so an inline `{…}` map is a validator violation before the local
// rule ever sees it. The block form above is the only one a skill may use.
test("metadata inline map is rejected by the validator", () => {
  makeSkill("alpha", `${MINIMAL}\nmetadata: {peers: "a b"}`);
  expect("violation", "flow mapping", "alpha");
});

// 5. A metadata key other than peers — inline and block forms alike.
test("metadata.version inline", () => {
  makeSkill("alpha", `${MINIMAL}\nmetadata: {version: "1"}`);
  expect("violation", "metadata.version", "alpha");
});
test("metadata.version block", () => {
  makeSkill("alpha", `${MINIMAL}\nmetadata:\n  version: "1"`);
  expect("violation", "metadata.version", "alpha");
});

// 6. peers as a YAML list.
test("metadata.peers list", () => {
  makeSkill("alpha", `${MINIMAL}\nmetadata:\n  peers:\n    - a/b.sh`);
  expect("violation", "must be a string", "alpha");
});

// 7. peers as an empty string.
test("metadata.peers empty", () => {
  makeSkill("alpha", `${MINIMAL}\nmetadata: {peers: ""}`);
  expect("violation", "metadata.peers", "alpha");
});

// 8. --all: a top-level folder without SKILL.md; .git, node_modules, .trash ignored.
test("--all flags a folder without SKILL.md", () => {
  makeSkill("alpha", MINIMAL);
  for (const d of ["stray/scripts", ".git", "node_modules/x", ".trash/old"])
    mkdirSync(join(ROOT, d), { recursive: true });
  writeFileSync(join(ROOT, "stray/scripts/x.sh"), "");
  expect("violation", "stray: no SKILL.md", "--all");
});
test("--all ignores .git, node_modules and .trash", () => {
  rmSync(join(ROOT, "stray"), { recursive: true, force: true });
  expect("ok", "OK — 1 skill(s) checked", "--all");
  for (const d of [".git", "node_modules", ".trash"]) rmSync(join(ROOT, d), { recursive: true, force: true });
});

// 9. state/ without _doc.md.
test("state/ without _doc.md", () => {
  makeSkill("alpha", MINIMAL);
  mkdirSync(join(ROOT, "alpha/state"), { recursive: true });
  writeFileSync(join(ROOT, "alpha/state/notes.md"), "x\n");
  expect("violation", "_doc.md", "alpha");
});

// 10. _doc.md present but SKILL.md links into state/.
test("SKILL.md linking into state/", () => {
  writeFileSync(join(ROOT, "alpha/state/_doc.md"), "doc\n");
  makeSkill("alpha", MINIMAL, "# alpha\n\nSee [notes](state/notes.md).");
  expect("violation", "never loaded at activation", "alpha");
});

// 11. _doc.md present and no link → ok; the other spellings of a self link
//     are violations; another tree's state/ is not one.
test("state/ with _doc.md and no link", () => {
  makeSkill("alpha", MINIMAL);
  expect("ok", "OK — 1 skill(s) checked", "alpha");
});
test("./state/ is a self link", () => {
  makeSkill("alpha", MINIMAL, "# alpha\n\nread ./state/notes.md");
  expect("violation", "never loaded at activation", "alpha");
});
test("home-path skills/<name>/state/ is a self link", () => {
  makeSkill("alpha", MINIMAL, "# alpha\n\nread ~/code/workbench/.agents/skills/alpha/state/notes.md");
  expect("violation", "never loaded at activation", "alpha");
});
test("<name>/state/ is a self link", () => {
  makeSkill("alpha", MINIMAL, "# alpha\n\nread alpha/state/notes.md");
  expect("violation", "never loaded at activation", "alpha");
});
test("../<name>/state/ is a self link", () => {
  makeSkill("alpha", MINIMAL, "# alpha\n\nread ../alpha/state/notes.md");
  expect("violation", "never loaded at activation", "alpha");
});
test("an absolute path into another checkout's skills/<name>/state/ is a self link", () => {
  makeSkill(
    "alpha",
    MINIMAL,
    "# alpha\n\nread /home/someone/.t3/worktrees/workbench/t3code-0000/.agents/skills/alpha/state/notes.md",
  );
  expect("violation", "never loaded at activation", "alpha");
});
test("an absolute path that resolves into this skill's state/ is a self link", () => {
  makeSkill("alpha", MINIMAL, `# alpha\n\nread ${ROOT}/alpha/state/notes.md`);
  expect("violation", "never loaded at activation", "alpha");
});
test("a home-rooted or absolute path into ANOTHER tree's <name>/state/ is not a self link", () => {
  makeSkill(
    "alpha",
    MINIMAL,
    "# alpha\n\nread ~/knowledge/alpha/state/notes.md and /tmp/knowledge/alpha/state/notes.md",
  );
  expect("ok", "OK — 1 skill(s) checked", "alpha");
});
test("another tree's state/ is not a self link, even under a folder of the same name", () => {
  makeSkill(
    "alpha",
    MINIMAL,
    "# alpha\n\nread knowledge/state/notes.md, ~/.local/state/x and knowledge/alpha/state/notes.md",
  );
  expect("ok", "OK — 1 skill(s) checked", "alpha");
  makeSkill("alpha", MINIMAL);
  rmSync(join(ROOT, "alpha/state"), { recursive: true, force: true });
});

// 11b. A skill that keeps state: state/entity-map.json is refused until
//      _doc.md sits beside it, passes with it, and SKILL.md may not name the file.
const NOTES = MINIMAL.replace("alpha", "notes");
test("notes/state/entity-map.json without _doc.md", () => {
  makeSkill("notes", NOTES);
  mkdirSync(join(ROOT, "notes/state"), { recursive: true });
  writeFileSync(join(ROOT, "notes/state/entity-map.json"), "{}\n");
  expect("violation", "_doc.md", "notes");
});
test("notes/state/ with _doc.md", () => {
  writeFileSync(join(ROOT, "notes/state/_doc.md"), "doc\n");
  expect("ok", "OK — 1 skill(s) checked", "notes");
});
test("SKILL.md naming state/entity-map.json", () => {
  makeSkill("notes", NOTES, "# notes\n\nlabels persist to `state/entity-map.json`.");
  expect("violation", "never loaded at activation", "notes");
  rmSync(join(ROOT, "notes"), { recursive: true, force: true });
});

// 12. --all over 0 skills.
test("--all over an empty root", () => {
  const saved = ROOT;
  ROOT = join(TMP, "empty");
  mkdirSync(ROOT, { recursive: true });
  try {
    expect("ok", "OK — 0 skill(s) checked", "--all");
  } finally {
    ROOT = saved;
  }
});

// 12b. --all over a root that cannot be read is a caller error, never an empty
// inventory reported as `OK — 0 skill(s) checked`.
test("--all over a missing or unreadable root exits 2", () => {
  const missing = runCheck(["--all"], { SKILLS_ROOT: join(TMP, "no-such-root") });
  assert.equal(missing.rc, 2, `missing root: got exit ${missing.rc}: ${missing.out}`);
  assert.ok(missing.out.includes("cannot read"), `missing root: output lacks "cannot read": ${missing.out}`);
  assert.ok(!missing.out.includes("OK —"), `missing root: reported OK: ${missing.out}`);
  const notDir = join(TMP, "a-file");
  writeFileSync(notDir, "x\n");
  const file = runCheck(["--all"], { SKILLS_ROOT: notDir });
  assert.equal(file.rc, 2, `root is a file: got exit ${file.rc}: ${file.out}`);
});

// 13. The validator missing → exit 2 naming the install line.
test("missing validator exits 2 with the install line", () => {
  const r = runCheck(["alpha"], { SKILLS_REF_BIN: join(TMP, "no-such-validator") });
  assert.equal(r.rc, 2, `missing validator: got exit ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("pip install skills-ref==0.1.1"), `missing validator: got exit ${r.rc}: ${r.out}`);
});

// 14. An unknown flag; and a scan asked of a root that is not a git tree.
test("unknown flag", () => {
  expect("caller-error", "", "--bogus");
});
test("no-args scan outside a git tree exits 2", () => {
  const saved = ROOT;
  ROOT = join(TMP, "nogit");
  mkdirSync(join(ROOT, "alpha"), { recursive: true });
  try {
    expect("caller-error", "not inside a git work tree");
  } finally {
    ROOT = saved;
  }
});

// 15. Scan modes, in a git repo.
const REPO = join(TMP, "repo");
function g(...args: string[]): void {
  execFileSync("git", ["-C", REPO, ...args], { stdio: "ignore" });
}

test("scan modes, in a git repo", async (t) => {
  mkdirSync(REPO, { recursive: true });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "tester");
  ROOT = REPO;
  makeSkill("alpha", MINIMAL);
  makeSkill("gamma", "name: gamma\ndescription: Does another thing.");
  writeFileSync(join(REPO, "AGENTS.md"), "# skills\n");
  g("add", "-A");
  g("commit", "-q", "-m", "seed");

  await t.test("no args, nothing changed", () => {
    expect("ok", "OK — 0 skill(s) checked");
  });
  await t.test("no args, one SKILL.md edited", () => {
    makeSkill("alpha", `${MINIMAL}\nargument-hint: "[x]"`);
    expect("violation", "alpha/SKILL.md: Unexpected fields");
  });
  await t.test("…and only that skill is counted", () => {
    assert.equal(runCheck([]).stdout.replace(/\n+$/, ""), "FAIL — 1 skill(s) checked, 1 violation(s)");
    makeSkill("alpha", MINIMAL);
  });
  await t.test("an untracked new skill is checked", () => {
    makeSkill("delta", "name: delta\ndescription: New and untracked.");
    expect("ok", "OK — 1 skill(s) checked");
    rmSync(join(REPO, "delta"), { recursive: true, force: true });
  });
  await t.test("a change only under state/ selects the skill", () => {
    mkdirSync(join(REPO, "alpha/state"), { recursive: true });
    writeFileSync(join(REPO, "alpha/state/notes.md"), "x\n");
    expect("violation", "alpha/SKILL.md:");
  });
  await t.test("…and reports the missing _doc.md", () => {
    const { stderr } = runCheck([]);
    assert.ok(stderr.includes("_doc.md"), `…state violation: ${stderr}`);
    rmSync(join(REPO, "alpha/state"), { recursive: true, force: true });
  });
  await t.test("a new folder without SKILL.md is checked", () => {
    mkdirSync(join(REPO, "beta/scripts"), { recursive: true });
    writeFileSync(join(REPO, "beta/scripts/x.sh"), "");
    expect("violation", "beta: no SKILL.md");
    rmSync(join(REPO, "beta"), { recursive: true, force: true });
  });
  await t.test("a root-level file change selects nothing", () => {
    writeFileSync(join(REPO, "AGENTS.md"), "# skills, edited\n");
    expect("ok", "OK — 0 skill(s) checked");
    g("checkout", "-q", "--", "AGENTS.md");
  });
  // --since catches a change committed on the branch; no-args does not
  await t.test("no args misses a change already committed", () => {
    g("checkout", "-q", "-b", "feature");
    makeSkill("gamma", "name: gamma\ndescription: Does another thing.\nsteps:\n  - id: one");
    g("add", "-A");
    g("commit", "-q", "-m", "a bad skill, committed");
    expect("ok", "OK — 0 skill(s) checked");
  });
  await t.test("--since <ref> catches it", () => {
    expect("violation", "gamma/SKILL.md: Unexpected fields in frontmatter: steps", "--since", "main");
  });
  // a deleted skill folder is skipped
  await t.test("a deleted skill folder is skipped", () => {
    g("rm", "-rq", "gamma");
    g("commit", "-q", "-m", "gamma removed");
    expect("ok", "OK — 0 skill(s) checked", "--since", "main");
  });
  await t.test("--since with an unknown ref", () => {
    expect("caller-error", "", "--since", "no-such-ref");
  });
});
