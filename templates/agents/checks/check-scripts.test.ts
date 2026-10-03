// check-scripts.test.ts — boundary rows for check-scripts.ts: all three parts,
// the script definition, the six pairing shapes, the library carve-out with its
// specifier resolution, the bash tier part (c) derives, the no-args / --since
// scans land.ts actually calls, --all, explicit paths, caller errors and
// Contextium's shipped-script rule.
//
// Run: node --test --experimental-strip-types .agents/checks/check-scripts.test.ts
//
// Every fixture lives in a real `git init`-ed repo, because the incremental
// modes read `git diff` and `git ls-files --others`; a bare scratch directory
// cannot reach them. The program is SPAWNED, never imported. HOME points into
// the scratch folder, so nothing it runs can reach a real home.
//
// Part (c) refuses bash outside its tier under .agents/, so the (a)/(b) rows
// plant TypeScript programs (`prog`), and the rows that are about how a shell
// `source` resolves make their bash files tier 1 the way a workbench does — a
// hook command in a harness's hook config, here `.claude/settings.json`
// (`tier`).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-scripts.ts");
const TMP = mkdtempSync(join(tmpdir(), "check-scripts-test-"));
const HOME = join(TMP, "home");
mkdirSync(HOME);
after(() => rmSync(TMP, { recursive: true, force: true }));

interface Run {
  out: string;
  err: string;
  rc: number;
}

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

/** A fresh repo with one baseline commit. */
let n = 0;
function newrepo(): string {
  n += 1;
  const repo = join(TMP, `repo${n}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "tester");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  commitAll(repo, "seed");
  return repo;
}

function commitAll(repo: string, msg: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

/** A file under the repo, folders made; `printf '%s\n'` of the content. */
function f(repo: string, rel: string, content = "# a file"): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), `${content}\n`);
}

/** Runs the check from `cwd`; stdout and stderr lose their trailing newlines,
 *  as `$(…)` did. */
function run(cwd: string, ...args: string[]): Run {
  const res = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME },
  });
  return {
    out: (res.stdout ?? "").replace(/\n+$/, ""),
    err: (res.stderr ?? "").replace(/\n+$/, ""),
    rc: res.status ?? -1,
  };
}

const SHEBANG = "#!/usr/bin/env -S node --experimental-strip-types";

/** A TypeScript program: a shebang makes it a script wherever it sits. */
function prog(repo: string, rel: string, body = "process.argv;"): void {
  f(repo, rel, `${SHEBANG}\n${body}`);
}

/** Every `.sh` in the fixture named by a hook command in
 *  `.claude/settings.json`, so part (c) puts it in the tier and the row tests
 *  only what it was written for. Called again after the fixture changes. */
function tier(repo: string): void {
  const out = execFileSync("git", ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  const shs = out.split("\n").filter((p) => p.endsWith(".sh") && !p.includes("node_modules/"));
  const hooks = shs.map((p) => ({ type: "command", command: `bash "$CLAUDE_PROJECT_DIR/${p}"` }));
  f(repo, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks }] } }));
}

/** The stderr lines of one part. */
function part(err: string, letter: string): string[] {
  return err.split("\n").filter((l) => l.includes(`: (${letter}) `));
}

function lines(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

// ── (1)(2) Part (a): a script with no test, then with one ────────────────

test("part (a): a script with no test, then with one", async (t) => {
  const repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/a.ts");
  let r = run(repo, "--all");
  await t.test("an uncovered script fails", () => assert.equal(r.rc, 1));
  await t.test("…with the one-line FAIL summary", () =>
    assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"),
  );
  await t.test("…and the (a) line naming the six shapes", () =>
    assert.equal(
      r.err,
      ".agents/skills/x/scripts/a.ts: (a) no test — expected a.test.ts beside it, or tests/a.test.ts in its folder or parent",
    ),
  );

  f(repo, ".agents/skills/x/scripts/a.test.ts", 'spawnSync("node", ["a.ts"]);');
  r = run(repo, "--all");
  await t.test("a sibling .test.ts covers it", () => assert.equal(r.rc, 0));
  await t.test("…and the summary counts one", () => assert.equal(r.out, "OK — 1 script(s) checked"));
  await t.test("…with nothing on stderr", () => assert.equal(r.err, ""));
});

// ── (3)(4) Pairing shapes: cross-extension, tests/, ../tests/ ────────────

test("pairing shapes", async (t) => {
  const repo = newrepo();
  f(repo, ".agents/skills/x/scripts/a.sh");
  f(repo, ".agents/skills/x/scripts/a.test.ts", 'spawnSync("bash", ["a.sh"])');
  f(repo, ".agents/skills/x/scripts/b.ts", "process.argv");
  f(repo, ".agents/skills/x/scripts/tests/b.test.sh", "bash ../b.ts");
  f(repo, ".agents/skills/x/scripts/c.ts", "process.argv");
  f(repo, ".agents/skills/x/tests/c.test.ts", "spawnSync");
  f(repo, ".agents/skills/y/scripts/d.sh");
  f(repo, ".agents/skills/y/tests/d.test.ts", "spawnSync");
  tier(repo);
  const r = run(repo, "--all");
  await t.test(".test.ts pairs a .sh, tests/ and ../tests/ pair", () => assert.equal(r.rc, 0));
  await t.test("…four scripts counted (the tests are not scripts)", () =>
    assert.equal(r.out, "OK — 4 script(s) checked"),
  );
});

// ── (5)(6)(6b)(6c) Part (b): a program's test imports it; then it is a library ─

test("part (b): program versus library", async (t) => {
  let repo = newrepo();
  f(repo, ".agents/skills/x/scripts/b.ts", "export const f = 1;");
  f(repo, ".agents/skills/x/scripts/b.test.ts", 'import { f } from "./b.ts";');
  let r = run(repo, "--all");
  await t.test("a program test that imports its subject fails", () => assert.equal(r.rc, 1));
  await t.test("…one violation", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));
  await t.test("…naming the test and the subject", () =>
    assert.equal(
      r.err,
      ".agents/skills/x/scripts/b.test.ts: (b) imports its subject .agents/skills/x/scripts/b.ts — run it as a subprocess",
    ),
  );

  f(repo, ".agents/skills/x/scripts/c.ts", 'import { f } from "./b.ts";');
  f(repo, ".agents/skills/x/scripts/c.test.ts", 'spawnSync("node", ["c.ts"]);');
  r = run(repo, "--all");
  await t.test("once a non-test file imports it, b.ts is a library and its import test passes", () =>
    assert.equal(r.rc, 0),
  );
  await t.test("…two scripts counted", () => assert.equal(r.out, "OK — 2 script(s) checked"));

  // (6b) Another file with the same stem, imported from a different folder.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/b.ts", "export const f = 1;");
  f(repo, ".agents/skills/x/scripts/b.test.ts", 'import { f } from "./b.ts";');
  f(repo, ".agents/skills/y/scripts/b.ts", "export const g = 2;");
  f(repo, ".agents/skills/y/scripts/b.test.ts", 'spawnSync("node", ["b.ts"]);');
  f(repo, ".agents/skills/y/scripts/c.ts", 'import { g } from "./b.ts";');
  f(repo, ".agents/skills/y/scripts/c.test.ts", 'spawnSync("node", ["c.ts"]);');
  r = run(repo, "--all");
  await t.test("an import of a same-stem file elsewhere does not make this one a library", () => assert.equal(r.rc, 1));
  await t.test("…the x one is still a program", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/b.test.ts: (b) imports its subject .agents/skills/x/scripts/b.ts"), r.err),
  );
  await t.test("…the y one is a library", () => assert.ok(!r.err.includes(".agents/skills/y/scripts/b.test.ts"), r.err));

  // (6c) The only importer is deleted in a worktree: --since catches it
  // although neither the subject nor its test changed.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/b.ts", "export const f = 1;");
  f(repo, ".agents/skills/x/scripts/b.test.ts", 'import { f } from "./b.ts";');
  f(repo, ".agents/skills/x/scripts/c.ts", 'import { f } from "./b.ts";');
  f(repo, ".agents/skills/x/scripts/c.test.ts", 'spawnSync("node", ["c.ts"]);');
  commitAll(repo, "library and importer");
  r = run(repo, "--since", "main");
  await t.test("clean at the trunk", () => assert.equal(r.rc, 0));
  git(repo, "checkout", "-q", "-b", "work");
  git(repo, "rm", "-q", ".agents/skills/x/scripts/c.ts", ".agents/skills/x/scripts/c.test.ts");
  git(repo, "commit", "-q", "-m", "drop the importer");
  r = run(repo, "--since", "main");
  await t.test("deleting the only importer turns the import test into a (b) violation", () => assert.equal(r.rc, 1));
  await t.test("…naming b.test.ts", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/b.test.ts: (b) imports its subject .agents/skills/x/scripts/b.ts"), r.err),
  );
  await t.test("…while the deleted script is skipped and nothing else changed", () =>
    assert.equal(r.out, "FAIL — 0 script(s) checked, 1 violation(s)"),
  );
});

// ── (7) Shell source, sibling-library import, comments ───────────────────

test("shell source, sibling libraries, comments", async (t) => {
  let repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "echo program");
  f(repo, ".agents/skills/x/scripts/p.test.sh", 'source "$(dirname "$0")/p.sh"');
  tier(repo);
  let r = run(repo, "--all");
  await t.test("a test that sources a program .sh fails (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming it", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/lib.sh", "helper() { :; }");
  f(repo, ".agents/skills/x/scripts/lib.test.sh", 'source "$(dirname "$0")/lib.sh"; helper');
  f(repo, ".agents/skills/x/scripts/p.sh", 'source "$(dirname "$0")/lib.sh"; helper');
  f(repo, ".agents/skills/x/scripts/p.test.sh", '. "$(dirname "$0")/lib.sh"\nbash "$(dirname "$0")/p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a test that spawns its subject and sources a sibling library passes", () => assert.equal(r.rc, 0));
  await t.test("…two scripts", () => assert.equal(r.out, "OK — 2 script(s) checked"));

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "echo program");
  f(
    repo,
    ".agents/skills/x/scripts/p.test.sh",
    '# see p.sh for the contract; source p.sh is NOT what we do\nbash "$(dirname "$0")/p.sh"',
  );
  f(repo, ".agents/skills/x/scripts/q.ts", "process.argv");
  f(
    repo,
    ".agents/skills/x/scripts/q.test.ts",
    '// this test used to `import { x } from "./q.ts"` — it spawns now\nspawnSync("node", ["q.ts"]);',
  );
  tier(repo);
  r = run(repo, "--all");
  await t.test("a comment mentioning the file is not an import", () => assert.equal(r.rc, 0));

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/q.ts", "process.argv");
  f(repo, ".agents/skills/x/scripts/q.test.ts", 'import { x } from "./q.ts";\nspawnSync("node", ["q.ts"]);');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a test that both imports and spawns its subject is still (b)", () => assert.equal(r.rc, 1));

  // A tests/ subfolder test importing ../subject resolves to the subject.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/r.ts", "process.argv");
  f(repo, ".agents/skills/x/scripts/tests/r.test.ts", 'import { r } from "../r.ts";');
  tier(repo);
  r = run(repo, "--all");
  await t.test("tests/<stem>.test.ts importing ../<stem>.ts is (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming the tests/ path", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/tests/r.test.ts: (b) imports its subject .agents/skills/x/scripts/r.ts"), r.err),
  );

  // A library source built at run time from a tests/ folder: `$HERE/../lib.sh`.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/lib.sh", "helper() { :; }");
  f(repo, ".agents/skills/x/scripts/tests/lib.test.sh", 'DIR="$(dirname "$0")"\nsource "$DIR/../lib.sh"');
  f(repo, ".agents/skills/x/scripts/user.sh", 'SCRIPT_DIR="$(dirname "$0")"\nsource "$SCRIPT_DIR/lib.sh"');
  f(repo, ".agents/skills/x/scripts/tests/user.test.sh", "bash ../user.sh");
  tier(repo);
  r = run(repo, "--all");
  await t.test("a run-time-built source from a sibling makes lib.sh a library", () => assert.equal(r.rc, 0));

  // A run-time-built source from a tests/ folder up to its program: still (b).
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "echo program");
  f(repo, ".agents/skills/x/scripts/tests/p.test.sh", 'source "$(dirname "$0")/../p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("tests/<stem>.test.sh sourcing ../<stem>.sh at run time is (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming the tests/ path", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // Two paired tests: the clean one does not excuse the importing one.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/q.ts", "process.argv");
  f(repo, ".agents/skills/x/scripts/q.test.sh", 'bash "$(dirname "$0")/../../run.sh" x/scripts/q.ts');
  f(repo, ".agents/skills/x/scripts/q.test.ts", 'import { q } from "./q.ts";');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a clean .test.sh beside an importing .test.ts is still (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming the importing one", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/q.test.ts: (b) imports its subject .agents/skills/x/scripts/q.ts"), r.err),
  );
});

// ── (8)(9) The script definition ─────────────────────────────────────────

test("the script definition", async (t) => {
  let repo = newrepo();
  prog(repo, ".agents/skills/x/references/x.ts");
  prog(repo, ".agents/skills/x/scripts/x.template.ts");
  prog(repo, ".agents/skills/x/scripts/x.test.ts");
  prog(repo, ".agents/skills/x/scripts/tests/helper.ts");
  prog(repo, ".agents/skills/x/templates/t.ts");
  f(repo, ".agents/skills/x/node_modules/m/bin.sh");
  let r = run(repo, "--all");
  await t.test("references/, templates, tests, node_modules and .test. are not scripts", () => assert.equal(r.rc, 0));
  await t.test("…zero counted", () => assert.equal(r.out, "OK — 0 script(s) checked"));

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/a.py", "#!/usr/bin/env python3");
  f(repo, ".agents/skills/x/scripts/b.mjs", "#!/usr/bin/env node");
  f(repo, ".agents/skills/x/scripts/c.ts", "process.argv");
  f(repo, ".agents/skills/x/lib/d.ts", "export const d = 1;");
  f(repo, ".agents/skills/x/e.py", "#!/usr/bin/env python3");
  f(repo, ".agents/skills/x/g.js", "module.exports = 1;");
  f(repo, ".agents/checks/h.ts", "process.argv");
  f(repo, ".agents/hooks/i.ts", "process.argv");
  f(repo, ".agents/generators/j.ts", "process.argv");
  f(repo, ".agents/skills/x/hooks/k.ts", "process.argv");
  prog(repo, "apps/other/scripts/outside.ts");
  r = run(repo, "--all");
  const a = part(r.err, "a").join("\n");
  await t.test("shebang or scripts-folder files are scripts; lib/ and shebang-less root files are not", () =>
    assert.equal(r.rc, 1),
  );
  await t.test("…eight scripts counted, none outside the roots; (c) adds the four non-TypeScript files", () =>
    assert.equal(r.out, "FAIL — 8 script(s) checked, 12 violation(s)"),
  );
  await t.test("…eight (a) lines", () => assert.equal(part(r.err, "a").length, 8, r.err));
  await t.test("…lib/d.ts is not a script", () => assert.ok(!r.err.includes("lib/d.ts"), r.err));
  await t.test("…g.js without a shebang outside a scripts folder is not a script", () =>
    assert.ok(!a.includes("g.js"), r.err),
  );
  await t.test("…apps/other is outside the universe", () => assert.ok(!r.err.includes("apps/other"), r.err));
  await t.test("…e.py with a shebang at the skill root is one", () =>
    assert.ok(r.err.includes(".agents/skills/x/e.py: (a)"), r.err),
  );
  await t.test("…hooks/ is a scripts folder", () => assert.ok(r.err.includes(".agents/skills/x/hooks/k.ts: (a)"), r.err));
});

// ── Review round: sibling tests/, unreadable tests, run-time paths, absolute paths ─

test("sibling tests/, unreadable tests, run-time paths, absolute paths", async (t) => {
  // A test in <skill>/tests/ pairs a script in any sibling folder of it
  // (findTests' `../tests/` shape), so deleting that only test selects the script.
  let repo = newrepo();
  f(repo, ".agents/skills/x/scripts/c.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/c.test.sh", "bash ../scripts/c.sh");
  tier(repo);
  commitAll(repo, "c with its test in the skill's tests/");
  git(repo, "rm", "-q", ".agents/skills/x/tests/c.test.sh");
  let r = run(repo);
  await t.test("deleting a script's only ../tests/ test fails (a)", () => assert.equal(r.rc, 1));
  await t.test("…naming the script in the sibling folder", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/c.sh: (a)"), r.err),
  );

  // A test that cannot be read is an error, never a clean scan.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/u.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/scripts/u.test.sh", "bash u.sh");
  chmodSync(join(repo, ".agents/skills/x/scripts/u.test.sh"), 0o000);
  tier(repo);
  r = run(repo, "--all");
  chmodSync(join(repo, ".agents/skills/x/scripts/u.test.sh"), 0o644);
  await t.test("an unreadable paired test is rc 2", () => assert.equal(r.rc, 2));
  await t.test("…naming it", () => assert.ok(r.err.includes("cannot read .agents/skills/x/scripts/u.test.sh"), r.err));

  // A <skill>/tests/ test sourcing its program through $HERE/../scripts/ is (b).
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$HERE/../scripts/p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a ../tests/ test sourcing ../scripts/<stem>.sh at run time is (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming it", () =>
    assert.ok(r.err.includes(".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // A run-time path names its folder: sourcing ../other/c.sh is not ../scripts/c.sh.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/c.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/other/c.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/c.test.sh", 'source "$HERE/../other/c.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a ../tests/ test sourcing ../other/<stem>.sh does not import scripts/<stem>.sh", () =>
    assert.ok(!r.err.includes("imports its subject .agents/skills/x/scripts/c.sh"), r.err),
  );
  await t.test("…it imports other/<stem>.sh, which it names", () =>
    assert.ok(r.err.includes("imports its subject .agents/skills/x/other/c.sh"), r.err),
  );

  // The usual spelling nests one substitution in another; its tail is `/p.sh`.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/scripts/p.test.sh", 'source "$(dirname "${BASH_SOURCE[0]}")/p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test('a test sourcing $(dirname "${BASH_SOURCE[0]}")/<stem>.sh is (b)', () => assert.equal(r.rc, 1));
  await t.test("…naming it", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/q.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/scripts/tests/q.test.sh", 'source "$(dirname "${BASH_SOURCE[0]}")/../q.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("…and from tests/ through ../<stem>.sh", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/tests/q.test.sh: (b) imports its subject .agents/skills/x/scripts/q.sh"), r.err),
  );

  // A `)` in a literal folder name is part of the path, not the end of a
  // substitution: `../other)/p.sh` is not `scripts/p.sh`.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/other)/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$HERE/../other)/p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a literal ) in a folder name is kept in the path", () =>
    assert.ok(!r.err.includes("imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // A quoted ) inside a substitution does not close it.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$(dirname "$0" | tr -d ")")/../scripts/p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a quoted ) inside $( ) does not end it", () =>
    assert.ok(r.err.includes(".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // A substitution nested inside a double-quoted one, with quoted parens of its own.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$(dirname "$(echo "$0" | tr -d ")(")")/../scripts/p.sh"');
  tier(repo);
  r = run(repo, "--all");
  await t.test("a nested, quoted substitution is skipped whole", () =>
    assert.ok(r.err.includes(".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // An explicit path given absolute is the same file as its relative form.
  repo = newrepo();
  f(repo, ".agents/skills/y/scripts/b.sh");
  tier(repo);
  r = run(repo, join(repo, ".agents/skills/y/scripts/b.sh"));
  await t.test("an absolute explicit path is checked", () => assert.equal(r.rc, 1));
  await t.test("…and counted", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));
});

// ── (15) Empty test file passes both parts ───────────────────────────────

test("an empty test file", async (t) => {
  const repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/a.ts");
  writeFileSync(join(repo, ".agents/skills/x/scripts/a.test.ts"), "");
  const r = run(repo, "--all");
  await t.test("an empty test file passes (a) and (b)", () => assert.equal(r.rc, 0));
});

// ── (10) No-args mode ────────────────────────────────────────────────────

test("no-args mode", async (t) => {
  let repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/old.ts");
  f(repo, ".agents/skills/x/scripts/old.test.ts", "spawnSync");
  prog(repo, ".agents/skills/x/scripts/gone.ts");
  f(repo, ".agents/skills/x/scripts/gone.test.ts", "spawnSync");
  prog(repo, ".agents/skills/x/scripts/orphan.ts");
  f(repo, ".agents/skills/x/scripts/orphan.test.ts", "spawnSync");
  prog(repo, ".agents/skills/x/scripts/untested.ts");
  commitAll(repo, "baseline with an untested script");
  let r = run(repo);
  await t.test("no-args with nothing changed is clean", () => assert.equal(r.rc, 0));
  await t.test("…and counts nothing (the untested committed script is not selected)", () =>
    assert.equal(r.out, "OK — 0 script(s) checked"),
  );

  prog(repo, ".agents/skills/x/scripts/new.ts"); // untracked, no test
  rmSync(join(repo, ".agents/skills/x/scripts/gone.ts")); // script deleted, test stays
  rmSync(join(repo, ".agents/skills/x/scripts/orphan.test.ts")); // test deleted, script stays
  writeFileSync(join(repo, ".agents/skills/x/scripts/old.ts"), `${SHEBANG}\n// touched\n`); // changed, covered
  r = run(repo);
  await t.test("no-args: untracked and orphaned scripts fail", () => assert.equal(r.rc, 1));
  await t.test("…three selected: new, orphan and old (gone is skipped)", () =>
    assert.equal(r.out, "FAIL — 3 script(s) checked, 2 violation(s)"),
  );
  await t.test("…the untracked one", () => assert.ok(r.err.includes(".agents/skills/x/scripts/new.ts: (a)"), r.err));
  await t.test("…the one whose test was deleted", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/orphan.ts: (a)"), r.err),
  );
  await t.test("…not the deleted script", () => assert.ok(!r.err.includes("gone.ts"), r.err));
  await t.test("…not the covered change", () => assert.ok(!r.err.includes("old.ts"), r.err));
  await t.test("…not the untested script nothing touched", () => assert.ok(!r.err.includes("untested.ts"), r.err));

  // A script whose only test lives under tests/ — deleting that test must
  // select the script, although tests/ is an excluded segment for SCRIPTS.
  repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/deep.ts");
  f(repo, ".agents/skills/x/scripts/tests/deep.test.ts", "spawnSync");
  commitAll(repo, "a script tested from tests/");
  rmSync(join(repo, ".agents/skills/x/scripts/tests/deep.test.ts"));
  r = run(repo);
  await t.test("no-args: deleting a script's only test under tests/ fails (a)", () => assert.equal(r.rc, 1));
  await t.test("…naming the script", () => assert.ok(r.err.includes(".agents/skills/x/scripts/deep.ts: (a)"), r.err));

  // The change listing failing is a caller error, never an empty change set.
  r = run(repo, "--since", "no-such-ref");
  await t.test("--since a ref git cannot resolve is rc 2", () => assert.equal(r.rc, 2));

  // A universe listing that cannot be completed is rc 2, never a shorter OK:
  // a folder find cannot enter makes find fail, and every mode reads the universe.
  repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/p.ts");
  f(repo, ".agents/skills/x/scripts/p.test.ts", "spawnSync");
  const locked = join(repo, ".agents/skills/y/scripts/locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  r = run(repo, "--all");
  chmodSync(locked, 0o755);
  await t.test("--all with an unreadable folder under a root is rc 2", () => assert.equal(r.rc, 2));
  await t.test("…naming find", () => assert.ok(r.err.includes("check-scripts: find failed under .agents"), r.err));
  await t.test("…and prints no OK", () => assert.ok(!r.out.includes("OK"), r.out));
  chmodSync(locked, 0o000);
  r = run(repo);
  chmodSync(locked, 0o755);
  await t.test("no-args mode reads the universe for part (b), so it is rc 2 too", () => assert.equal(r.rc, 2));
});

// ── (11) --since ─────────────────────────────────────────────────────────

test("--since", async (t) => {
  const repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/a.ts");
  f(repo, ".agents/skills/x/scripts/a.test.ts", "spawnSync");
  commitAll(repo, "trunk");
  git(repo, "checkout", "-q", "-b", "work");
  prog(repo, ".agents/skills/x/scripts/b.ts");
  commitAll(repo, "committed on the branch, no test");
  let r = run(repo);
  await t.test("no-args misses a change already committed", () => assert.equal(r.rc, 0));
  r = run(repo, "--since", "main");
  await t.test("--since main sees it", () => assert.equal(r.rc, 1));
  await t.test("…naming it", () => assert.ok(r.err.includes(".agents/skills/x/scripts/b.ts: (a)"), r.err));
  await t.test("…one selected", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));

  git(repo, "checkout", "-q", "--orphan", "lonely");
  git(repo, "rm", "-rqf", ".");
  writeFileSync(join(repo, "alone.txt"), "alone\n");
  commitAll(repo, "no shared history");
  r = run(repo, "--since", "main");
  await t.test("--since a ref with no merge base is a caller error", () => assert.equal(r.rc, 2));
  await t.test("…and says so", () => assert.ok(r.err.includes("cannot find where HEAD left main"), r.err));
  git(repo, "checkout", "-q", "-f", "work");
});

// ── (12)(13) --all counts everything; explicit paths; caller errors ──────

test("--all, explicit paths, caller errors", async (t) => {
  const repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/a.ts");
  f(repo, ".agents/skills/x/scripts/a.test.ts", "spawnSync");
  prog(repo, ".agents/skills/y/scripts/b.ts");
  prog(repo, ".agents/checks/c.ts");
  prog(repo, ".agents/hooks/d.ts");
  prog(repo, ".agents/generators/e.ts");
  f(repo, ".agents/generators/g.ts", "process.argv");
  f(repo, "apps/web/src/h.ts", "process.argv");
  f(repo, "apps/web/scripts/outside.sh");
  commitAll(repo, "the roots");
  let r = run(repo, "--all");
  await t.test("--all walks all of .agents/", () => assert.equal(r.rc, 1));
  await t.test("…six scripts, five violations", () =>
    assert.equal(r.out, "FAIL — 6 script(s) checked, 5 violation(s)"),
  );
  await t.test("…an app's src/ is outside the universe", () => assert.ok(!r.err.includes("src/h.ts"), r.err));
  await t.test("…and so is an app's scripts/", () => assert.ok(!r.err.includes("apps/web/scripts"), r.err));

  r = run(repo, ".agents/skills/x/scripts/a.ts");
  await t.test("an explicit covered file", () => assert.equal(r.rc, 0));
  await t.test("…counts one", () => assert.equal(r.out, "OK — 1 script(s) checked"));
  r = run(repo, ".agents/skills/y/scripts/b.ts", ".agents/hooks/d.ts");
  await t.test("explicit uncovered files", () => assert.equal(r.rc, 1));
  await t.test("…count two", () => assert.equal(r.out, "FAIL — 2 script(s) checked, 2 violation(s)"));
  r = run(repo, ".agents/checks");
  await t.test("a directory argument walks it for scripts", () => assert.equal(r.rc, 1));
  await t.test("…one script beneath it", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));
  r = run(repo, ".agents/skills/x/scripts/a.test.ts");
  await t.test("an explicit path that is not a script counts nothing", () => assert.equal(r.rc, 0));
  await t.test("…zero", () => assert.equal(r.out, "OK — 0 script(s) checked"));

  r = run(repo, "--all", ".agents/skills/x/scripts/a.ts");
  await t.test("--all with paths is a caller error", () => assert.equal(r.rc, 2));
  r = run(repo, "--bogus");
  await t.test("an unknown flag is a caller error", () => assert.equal(r.rc, 2));
  r = run(repo, "--since");
  await t.test("--since with no ref is a caller error", () => assert.equal(r.rc, 2));
  r = run(repo, "--since", "main", ".agents");
  await t.test("--since with paths is a caller error", () => assert.equal(r.rc, 2));
  r = run(repo, ".agents/skills/no-such-file.sh");
  await t.test("an explicit path that does not exist is a caller error", () => assert.equal(r.rc, 2));
  await t.test("…naming it", () =>
    assert.equal(r.err, "check-scripts: no such file or directory: .agents/skills/no-such-file.sh"),
  );

  const outside = join(TMP, "not-a-repo");
  mkdirSync(outside, { recursive: true });
  r = run(outside);
  await t.test("no-args outside a git work tree", () => assert.equal(r.rc, 2));
});

// ── (14) stdout is exactly one line in every mode ────────────────────────

test("stdout is exactly one line in every mode", async (t) => {
  const repo = newrepo();
  prog(repo, ".agents/skills/x/scripts/a.ts");
  f(repo, ".agents/skills/y/scripts/b.ts", "export const b = 1;");
  f(repo, ".agents/skills/y/scripts/b.test.ts", 'import { b } from "./b.ts";');
  let r = run(repo, "--all");
  await t.test("--all: one stdout line", () => assert.equal(lines(r.out), 1));
  r = run(repo);
  await t.test("no-args: one stdout line", () => assert.equal(lines(r.out), 1));
  r = run(repo, ".agents/skills/x/scripts/a.ts");
  await t.test("paths: one stdout line", () => assert.equal(lines(r.out), 1));
  commitAll(repo, "all");
  r = run(repo, "--since", "main");
  await t.test("--since: one stdout line", () => assert.equal(lines(r.out), 1));
});

// ── Part (c): the language and the bash tier ─────────────────────────────
//
// Part (c) judges the files under .agents/ only — the rest of the worktree is
// the owner's own work, read for the tier alone — so these rows plant their
// files there. A bash file under .agents/ is a part-(a) script as well, so a
// row about the tier reads part (c)'s lines (`cErr`), not all of stderr.

/** A `.claude/settings.json` whose hooks run these commands, in the real
 *  file's shape: the path sits inside a longer shell string. */
function settings(repo: string, ...paths: string[]): void {
  const hooks = paths.map((p) => ({
    type: "command",
    command: `d="\${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"; h="$d/${p}"; [ -f "$h" ] || exit 0; exec bash "$h"`,
  }));
  f(repo, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks }] } }));
}

const BASH_OUT = "bash outside the hook/bootstrap tier — AGENTS.md § Standards → Scripts are TypeScript";

/** Part (c)'s stderr lines, joined. */
function cErr(r: Run): string {
  return part(r.err, "c").join("\n");
}

test("part (c): a hook, its sourced library, a worktree maker, and a stray", async (t) => {
  const repo = newrepo();
  settings(repo, ".agents/hooks/h.sh");
  f(repo, ".agents/hooks/h.sh", 'LIB="$(dirname "$0")/lib/l.sh"; . "$LIB"\nhelper');
  f(repo, ".agents/hooks/lib/l.sh", "helper() { :; }");
  f(repo, ".agents/w.sh", 'repo="$1"\ngit -C "$repo" worktree add "$2" 2>&1');
  f(repo, ".agents/s.sh", "echo stray");
  commitAll(repo, "tier fixture");
  let r = run(repo, "--all");
  await t.test("(c1) the stray is the one (c) violation", () => assert.equal(cErr(r), `.agents/s.sh: (c) ${BASH_OUT}`));
  await t.test("…the four bash files are part-(a) scripts; (c) adds one violation to their four", () =>
    assert.equal(r.out, "FAIL — 4 script(s) checked, 5 violation(s)"),
  );
  await t.test("(c2)(c3)(c4) the hook, its library through a variable, and the worktree maker are tier 1", () =>
    assert.ok(!cErr(r).includes("h.sh") && !cErr(r).includes("l.sh") && !cErr(r).includes("w.sh"), r.err),
  );

  // (c9) The settings entry deleted, nothing else changed: incremental mode
  // re-derives the tier and the hook and its library fall out of it.
  f(repo, ".claude/settings.json", JSON.stringify({ hooks: {} }));
  r = run(repo);
  await t.test("(c9) incremental: deleting the hook entry puts the hook in (c)", () =>
    assert.ok(cErr(r).includes(`.agents/hooks/h.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("…and the library it sourced", () =>
    assert.ok(cErr(r).includes(`.agents/hooks/lib/l.sh: (c) ${BASH_OUT}`), r.err),
  );
  git(repo, "checkout", "-q", "--", ".claude/settings.json");

  f(repo, ".agents/w.sh", 'repo="$1"\n# git -C "$repo" worktree add "$2" — moved to w2.ts');
  r = run(repo);
  await t.test("(c9) incremental: deleting the worktree line puts the file in (c)", () =>
    assert.ok(cErr(r).includes(`.agents/w.sh: (c) ${BASH_OUT}`), r.err),
  );
  git(repo, "checkout", "-q", "--", ".agents/w.sh");

  f(repo, ".agents/hooks/h.sh", "helper");
  r = run(repo);
  await t.test("(c9) incremental: deleting the source line puts the library in (c)", () =>
    assert.ok(cErr(r).includes(`.agents/hooks/lib/l.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("…not the hook", () => assert.ok(!cErr(r).includes(".agents/hooks/h.sh:"), r.err));
});

test("part (c): the deploy poller land.ts runs by name is in the tier", async (t) => {
  const repo = newrepo();
  f(repo, ".agents/deploy/await-deploy-run.sh", 'echo "polling $1"');
  f(repo, ".agents/deploy/other.sh", "echo other");
  commitAll(repo, "poller fixture");
  const r = run(repo, "--all");
  await t.test("the poller is not a (c) violation", () =>
    assert.ok(!cErr(r).includes("await-deploy-run.sh"), r.err),
  );
  await t.test("…another bash file beside it still is", () =>
    assert.equal(cErr(r), `.agents/deploy/other.sh: (c) ${BASH_OUT}`),
  );
});

test("part (c): a file outside .agents/ is the owner's own, never judged", async (t) => {
  const repo = newrepo();
  f(repo, "a.js", "module.exports = 1;");
  f(repo, "apps/web/tool.py", "print(1)");
  f(repo, "scripts/run.sh", "echo run");
  f(repo, "tools/bad.ts", "#!/usr/bin/env node --experimental-strip-types\nprocess.argv;");
  const r = run(repo, "--all");
  await t.test("JavaScript, Python, untiered bash and a flagged shebang outside .agents/ pass", () =>
    assert.equal(r.rc, 0, r.err),
  );
  await t.test("…and count no script", () => assert.equal(r.out, "OK — 0 script(s) checked"));
});

test("part (c): the tier's shapes", async (t) => {
  let repo = newrepo();
  f(repo, ".agents/comment.sh", "# git worktree add /tmp/x");
  f(repo, ".agents/string.sh", 'echo "run: git -C repo worktree add /tmp/x"');
  f(repo, ".agents/single.sh", "echo 'git clone https://x/y.git'");
  f(repo, ".agents/heredoc.sh", "cat <<'EOF'\ngit worktree add /tmp/x\nEOF");
  f(repo, ".agents/clone.sh", 'git clone --depth 1 "$url" "$dir"');
  f(repo, ".agents/subst.sh", 'out="$(git -C "$repo" worktree add "$@" 2>&1)"');
  f(repo, ".agents/continued.sh", 'git -C "$repo" \\\n  worktree add "$dir"');
  let r = run(repo, "--all");
  await t.test("(c3) a worktree line only in a comment is not tier 1", () =>
    assert.ok(cErr(r).includes(`.agents/comment.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("…nor only in a double-quoted string", () =>
    assert.ok(cErr(r).includes(`.agents/string.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("…nor only in a single-quoted string", () =>
    assert.ok(cErr(r).includes(`.agents/single.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("…nor only in a heredoc body", () =>
    assert.ok(cErr(r).includes(`.agents/heredoc.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("(c3b) git clone with options is tier 1", () => assert.ok(!cErr(r).includes("clone.sh"), r.err));
  await t.test("…and so is a worktree add inside a quoted $( )", () => assert.ok(!cErr(r).includes("subst.sh"), r.err));
  await t.test("…and one continued over a backslash-newline", () =>
    assert.ok(!cErr(r).includes("continued.sh"), r.err),
  );

  // Another tree's `reset --hard`, not this one's.
  repo = newrepo();
  f(repo, ".agents/deploy.sh", 'git -C "$IDLE" reset --quiet --hard "origin/$TRUNK" || die "could not reset"');
  f(repo, ".agents/local.sh", "git reset --hard HEAD");
  r = run(repo, "--all");
  await t.test("(c3c) git -C <tree> reset --hard is tier 1", () => assert.ok(!cErr(r).includes("deploy.sh"), r.err));
  await t.test("…a reset of the tree it runs in is not", () =>
    assert.equal(cErr(r), `.agents/local.sh: (c) ${BASH_OUT}`),
  );

  // (c13) The README's curl | bash installer.
  repo = newrepo();
  f(repo, ".agents/install.sh", "echo installing");
  f(repo, ".agents/other.sh", "echo other");
  f(repo, "README.md", "# x\n\n```bash\ncurl -sSL example.com/.agents/install.sh | bash\n```");
  r = run(repo, "--all");
  await t.test("(c13) the script a README curl | bash line names is tier 1", () =>
    assert.equal(cErr(r), `.agents/other.sh: (c) ${BASH_OUT}`),
  );
  f(repo, "README.md", "# x");
  r = run(repo, "--all");
  await t.test("…and is not once the line is gone", () =>
    assert.ok(cErr(r).includes(`.agents/install.sh: (c) ${BASH_OUT}`), r.err),
  );

  // (c14) Provisioning a stock host: apt-get install, run over ssh.
  repo = newrepo();
  f(repo, ".agents/provision.sh", `ssh "$HOST" 'sudo apt-get install -y nodejs git'`);
  f(repo, ".agents/apt.sh", "sudo apt-get install -y jq");
  r = run(repo, "--all");
  await t.test("(c14) apt-get install sent over ssh is tier 1", () =>
    assert.equal(cErr(r), `.agents/apt.sh: (c) ${BASH_OUT}`),
  );

  // Hook configs other than .claude/settings.json: a path relative to the
  // config's folder, and an installed layout matched by its last two parts.
  repo = newrepo();
  f(
    repo,
    ".agents/hooks.json",
    JSON.stringify({ g: { PreToolUse: [{ hooks: [{ type: "command", command: "bash ../.agents/hooks/x.sh" }] }] } }),
  );
  f(repo, ".agents/hooks/x.sh", "echo x");
  f(repo, ".agents/hooks/x.test.ts", 'spawnSync("bash", ["x.sh"]);');
  f(
    repo,
    ".agents/templates/agents/hooks/claude-hooks.json",
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: 'h="$d/.agents/hooks/y.sh"; bash "$h"' }] }] },
    }),
  );
  f(repo, ".agents/templates/agents/hooks/y.sh", "echo y");
  r = run(repo, "--all");
  await t.test("a hook named relative to its config's folder, or by its installed path, is tier 1", () =>
    assert.equal(r.rc, 0, r.err),
  );
});

test("part (c): sourcing", async (t) => {
  let repo = newrepo();
  settings(repo, ".agents/h.sh");
  f(repo, ".agents/h.sh", 'X="$(dirname "$0")/x.ts"\n. "$X"');
  f(repo, ".agents/x.ts", "export {};");
  let r = run(repo, "--all");
  await t.test("(c5) a tier file sourcing a .ts through a variable", () =>
    assert.equal(cErr(r), '.agents/h.sh: (c) tier-1 bash sources a TypeScript file — line 2: "$X"'),
  );

  repo = newrepo();
  settings(repo, ".agents/h.sh");
  f(repo, ".agents/h.sh", '[ -n "$1" ] && . "$NOPE"');
  r = run(repo, "--all");
  await t.test("(c4) a source line whose variable is never assigned is reported, never silently tier 1", () =>
    assert.equal(cErr(r), '.agents/h.sh: (c) unresolvable source line — line 1: "$NOPE"'),
  );

  repo = newrepo();
  settings(repo, ".agents/hooks/h.sh");
  f(
    repo,
    ".agents/hooks/h.sh",
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nLIB_DIR="$HERE/../lib"\nsource "${LIB_DIR}/a.sh"',
  );
  f(repo, ".agents/lib/a.sh", 'if true; then . "$(dirname "$0")/b.sh"; fi');
  f(repo, ".agents/lib/b.sh", "b() { :; }");
  f(repo, ".agents/lib/c.sh", "c() { :; }");
  f(repo, ".agents/lib/d.sh", 'echo ". ./c.sh is not a source line"');
  r = run(repo, "--all");
  await t.test("(c4) the closure follows a chain of variables, then a source after `then`", () =>
    assert.ok(!cErr(r).includes(".agents/lib/a.sh") && !cErr(r).includes(".agents/lib/b.sh"), r.err),
  );
  await t.test("…a library nothing in the tier sources is (c)", () =>
    assert.ok(cErr(r).includes(`.agents/lib/c.sh: (c) ${BASH_OUT}`), r.err),
  );
  await t.test("…a `. x` inside a string is not a source", () =>
    assert.ok(cErr(r).includes(`.agents/lib/d.sh: (c) ${BASH_OUT}`), r.err),
  );

  // An executed file is not sourced: the closure is over `source` only.
  repo = newrepo();
  settings(repo, ".agents/h.sh");
  f(repo, ".agents/h.sh", 'bash "$(dirname "$0")/run.sh"');
  f(repo, ".agents/run.sh", "echo run");
  r = run(repo, "--all");
  await t.test("a file a tier script merely executes is not in the tier", () =>
    assert.equal(cErr(r), `.agents/run.sh: (c) ${BASH_OUT}`),
  );
});

test("part (c): JavaScript, Python, the listing, the shebang", async (t) => {
  let repo = newrepo();
  f(repo, ".agents/a.js", "module.exports = 1;");
  f(repo, ".agents/site/b.mjs", "export default 1;");
  f(repo, ".agents/c.cjs", "module.exports = 1;");
  f(repo, ".agents/tools/d.py", "print(1)");
  f(repo, ".agents/node_modules/m/x.js", "module.exports = 1;");
  f(repo, ".agents/site/node_modules/m/y.py", "print(1)");
  f(repo, ".agents/skills/s/vendor/v.js", "module.exports = 1;");
  let r = run(repo, "--all");
  await t.test("(c6) every .js, .mjs, .cjs and .py is (c)", () =>
    assert.deepEqual(r.err.split("\n"), [
      ".agents/a.js: (c) JavaScript — TypeScript everywhere",
      ".agents/c.cjs: (c) JavaScript — TypeScript everywhere",
      ".agents/site/b.mjs: (c) JavaScript — TypeScript everywhere",
      ".agents/skills/s/vendor/v.js: (c) JavaScript — TypeScript everywhere",
      ".agents/tools/d.py: (c) Python — TypeScript everywhere",
    ]),
  );
  await t.test("(c7) …node_modules/ is not read; vendor/ is", () => assert.ok(!r.err.includes("node_modules"), r.err));

  repo = newrepo();
  r = run(repo, "--all");
  await t.test("(c8) a repo with no scripts", () => assert.equal(r.out, "OK — 0 script(s) checked"));
  await t.test("…exits 0", () => assert.equal(r.rc, 0));

  // (c10) land.ts runs the check before `git add -A`: an untracked file counts.
  f(repo, ".gitignore", "ignored/");
  commitAll(repo, "ignore");
  f(repo, ".agents/x/new.js", "module.exports = 1;");
  f(repo, ".agents/ignored/built.js", "module.exports = 1;");
  r = run(repo);
  await t.test("(c10) an untracked .js is refused before any git add", () =>
    assert.equal(r.err, ".agents/x/new.js: (c) JavaScript — TypeScript everywhere"),
  );
  await t.test("…an ignored one is not read", () => assert.ok(!r.err.includes("ignored/"), r.err));
  rmSync(join(repo, ".agents/x/new.js"));

  // A tracked file deleted in the worktree is not on disk, so not judged.
  repo = newrepo();
  f(repo, ".agents/old.js", "module.exports = 1;");
  commitAll(repo, "legacy");
  rmSync(join(repo, ".agents/old.js"));
  r = run(repo);
  await t.test("a tracked file deleted in the worktree is not judged", () => assert.equal(r.rc, 0, r.err));

  // (c11) env passes everything after the program as ONE argument without -S.
  repo = newrepo();
  f(repo, ".agents/tools/bad.ts", "#!/usr/bin/env node --experimental-strip-types\nprocess.argv;");
  f(repo, ".agents/tools/good.ts", "#!/usr/bin/env -S node --experimental-strip-types\nprocess.argv;");
  f(repo, ".agents/tools/plain.ts", "#!/usr/bin/env node\nprocess.argv;");
  f(repo, ".agents/tools/lib.ts", "export {};");
  r = run(repo, "--all");
  await t.test("(c11) a flagged shebang without -S is (c)", () =>
    assert.equal(
      cErr(r),
      ".agents/tools/bad.ts: (c) shebang needs env -S — `#!/usr/bin/env -S node --experimental-strip-types`",
    ),
  );
});

test("part (c): resolution and matching edges", async (t) => {
  // A literal relative source is read from the working directory (the repo
  // root a hook runs in) before the file's own folder.
  let repo = newrepo();
  settings(repo, ".agents/hooks/h.sh");
  // The root's lib/ sits outside .agents/: it is read for the tier, never judged.
  f(repo, ".agents/hooks/h.sh", ". lib/l.sh");
  f(repo, "lib/l.sh", "l() { :; }");
  f(repo, ".agents/hooks/lib/l.sh", "decoy() { :; }");
  let r = run(repo, "--all");
  await t.test("a literal source path resolves from the repo root first", () =>
    assert.equal(cErr(r), `.agents/hooks/lib/l.sh: (c) ${BASH_OUT}`),
  );

  // A variable the file never assigns is unresolvable even when its tail
  // happens to name a file beside the script.
  repo = newrepo();
  settings(repo, ".agents/hooks/h.sh");
  f(repo, ".agents/hooks/h.sh", '. "$NOPE/l.sh"');
  f(repo, ".agents/hooks/l.sh", "l() { :; }");
  r = run(repo, "--all");
  await t.test("an unassigned prefix is unresolvable, not its tail's file", () =>
    assert.ok(cErr(r).includes('.agents/hooks/h.sh: (c) unresolvable source line — line 1: "$NOPE/l.sh"'), r.err),
  );

  // The assignment that wins is the last one BEFORE the source, on its own
  // line or after a `;` on the source's line.
  repo = newrepo();
  settings(repo, ".agents/hooks/h.sh");
  f(repo, ".agents/hooks/h.sh", 'LIB="$(dirname "$0")/a.sh"\nX=1; LIB="$(dirname "$0")/b.sh"; . "$LIB"');
  f(repo, ".agents/hooks/a.sh", "a() { :; }");
  f(repo, ".agents/hooks/b.sh", "b() { :; }");
  r = run(repo, "--all");
  await t.test("an assignment after `;` on the source's own line wins", () =>
    assert.equal(cErr(r), `.agents/hooks/a.sh: (c) ${BASH_OUT}`),
  );

  // A variable inside an assignment takes its value where THAT assignment
  // stands, as the shell expands it: reassigning it later does not move a path
  // already built from it.
  repo = newrepo();
  settings(repo, ".agents/hooks/h.sh");
  f(repo, ".agents/hooks/h.sh", 'BASE="$(dirname "$0")/a"\nLIB="$BASE/lib.sh"\nBASE="$(dirname "$0")/b"\n. "$LIB"');
  f(repo, ".agents/hooks/a/lib.sh", "a() { :; }");
  f(repo, ".agents/hooks/b/lib.sh", "b() { :; }");
  r = run(repo, "--all");
  await t.test("a nested variable expands at its alias's assignment, not at the source", () =>
    assert.equal(cErr(r), `.agents/hooks/b/lib.sh: (c) ${BASH_OUT}`),
  );

  // A path a hook command only prints is not a hook.
  repo = newrepo();
  f(
    repo,
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: 'echo ".agents/old.sh migrated"; bash .agents/hooks/h.sh' }] }],
      },
    }),
  );
  f(repo, ".agents/hooks/h.sh", "echo h");
  f(repo, ".agents/old.sh", "echo old");
  r = run(repo, "--all");
  await t.test("a .sh named only by an echo in a hook command is not tier 1", () =>
    assert.equal(cErr(r), `.agents/old.sh: (c) ${BASH_OUT}`),
  );

  // …nor one printed after a control keyword; but a substitution an echo
  // carries does run.
  repo = newrepo();
  f(
    repo,
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: 'if true; then echo ".agents/old.sh migrated"; fi' },
              { type: "command", command: 'echo "$(bash .agents/hooks/h.sh)"' },
            ],
          },
        ],
      },
    }),
  );
  f(repo, ".agents/hooks/h.sh", "echo h");
  f(repo, ".agents/old.sh", "echo old");
  r = run(repo, "--all");
  await t.test("a .sh printed after `then` is not tier 1; one run inside an echo's $( ) is", () =>
    assert.equal(cErr(r), `.agents/old.sh: (c) ${BASH_OUT}`),
  );

  // What an echo carries runs only where the shell would run it.
  const cmds: [string, string][] = [
    ["echo '$(bash .agents/old.sh)'", "a $( ) in single quotes"],
    ["echo \\$(bash .agents/old.sh)", "an escaped $("],
    ['echo "$(bash .agents/hooks/h.sh; true)"', "a $( ) holding a ;"],
    ['if true; then echo "`bash .agents/hooks/h.sh`"; fi', "a backtick after `then`"],
  ];
  for (const [command, what] of cmds) {
    repo = newrepo();
    f(
      repo,
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command },
                { type: "command", command: "bash .agents/hooks/h.sh" },
              ],
            },
          ],
        },
      }),
    );
    f(repo, ".agents/hooks/h.sh", "echo h");
    f(repo, ".agents/old.sh", "echo old");
    r = run(repo, "--all");
    await t.test(`${what}: only what runs is a hook`, () => assert.equal(cErr(r), `.agents/old.sh: (c) ${BASH_OUT}`));
  }
  //   A comment is not code, and an echo inside a kept command's substitution
  //   still only prints.
  for (const [command, what] of [
    ["echo ok # ; bash .agents/old.sh\nbash .agents/hooks/h.sh", "a ; inside a comment"],
    ["x=$(true; echo .agents/old.sh); bash .agents/hooks/h.sh", "an echo inside an assignment's $( )"],
  ] as [string, string][]) {
    repo = newrepo();
    f(repo, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }));
    f(repo, ".agents/hooks/h.sh", "echo h");
    f(repo, ".agents/old.sh", "echo old");
    r = run(repo, "--all");
    await t.test(`${what}: only what runs is a hook`, () => assert.equal(cErr(r), `.agents/old.sh: (c) ${BASH_OUT}`));
  }
  repo = newrepo();
  f(
    repo,
    ".claude/settings.json",
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: 'echo ok # "\nbash .agents/hooks/h.sh' }] }] },
    }),
  );
  f(repo, ".agents/hooks/h.sh", "echo h");
  r = run(repo, "--all");
  await t.test("a quote inside a comment does not swallow the next line's hook", () =>
    assert.deepEqual(part(r.err, "c"), [], r.err),
  );

  //   …and the same shapes with ONLY the echo naming the hook.
  for (const command of [
    'echo "$(bash .agents/hooks/h.sh; true)"',
    'if true; then echo "`bash .agents/hooks/h.sh`"; fi',
  ]) {
    repo = newrepo();
    f(repo, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }));
    f(repo, ".agents/hooks/h.sh", "echo h");
    r = run(repo, "--all");
    await t.test(`a hook run inside an echo — ${command}`, () => assert.deepEqual(part(r.err, "c"), [], r.err));
  }

  // A direct interpreter takes the rest of the line as one argument: one flag
  // works, two do not.
  repo = newrepo();
  f(repo, ".agents/tools/one.ts", "#!/usr/bin/node --experimental-strip-types\nprocess.argv;");
  f(repo, ".agents/tools/two.ts", "#!/usr/bin/node --experimental-strip-types --test\nprocess.argv;");
  r = run(repo, "--all");
  await t.test("a direct interpreter with one flag passes, with two is (c)", () =>
    assert.equal(
      cErr(r),
      ".agents/tools/two.ts: (c) shebang needs env -S — `#!/usr/bin/env -S node --experimental-strip-types`",
    ),
  );
});

test("part (c): a tier-1 hook answers to part (a), not (c)", async (t) => {
  const repo = newrepo();
  settings(repo, ".agents/hooks/g.sh");
  f(repo, ".agents/hooks/g.sh", "echo guard");
  let r = run(repo, "--all");
  await t.test("(c12) a hook with no test is (a), and not (c)", () =>
    assert.equal(
      r.err,
      ".agents/hooks/g.sh: (a) no test — expected g.test.ts beside it, or tests/g.test.ts in its folder or parent",
    ),
  );
  await t.test("…counted as a script", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));
  f(repo, ".agents/hooks/g.test.ts", 'spawnSync("bash", ["g.sh"]);');
  r = run(repo, "--all");
  await t.test("…and passes with its test", () => assert.equal(r.out, "OK — 1 script(s) checked"));
});

// ── Contextium's own scripts: tested in its repo, until edited here ──────

/** `cksum <file | awk '{print $1, $2}'`, the form the installer records. */
function cksumOf(file: string): string {
  const out = execFileSync("cksum", { input: readFileSync(file), encoding: "utf8" });
  return out.trim().split(/\s+/).slice(0, 2).join(" ");
}

test("a script Contextium shipped", async (t) => {
  const repo = newrepo();
  f(repo, ".agents/skills/x/scripts/ours.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/scripts/mine.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/checks/gate.ts", "#!/usr/bin/env -S node --experimental-strip-types\nprocess.argv");
  f(repo, ".agents/hooks/guard.sh", "#!/usr/bin/env bash");
  tier(repo);
  writeFileSync(
    join(repo, ".agents/skills/.contextium-manifest"),
    `# Written by the Contextium installer\n.agents/skills/x/scripts/ours.sh\t${cksumOf(join(repo, ".agents/skills/x/scripts/ours.sh"))}\n`,
  );
  writeFileSync(
    join(repo, ".agents/checks/.contextium-manifest"),
    `.agents/checks/gate.ts\t${cksumOf(join(repo, ".agents/checks/gate.ts"))}\n`,
  );
  // the hooks manifest lists guard.sh with a checksum it does not have
  writeFileSync(join(repo, ".agents/hooks/.contextium-manifest"), ".agents/hooks/guard.sh\t1 2\n");
  let r = run(repo, "--all");
  await t.test("a shipped script, unchanged, needs no test here", () => assert.equal(r.rc, 1));
  await t.test("…ours.sh passes (a)", () => assert.ok(!r.err.includes("ours.sh"), r.err));
  await t.test("…and so does a shipped .ts, by the same checksum", () => assert.ok(!r.err.includes("gate.ts"), r.err));
  await t.test("…a script the manifest does not list is yours", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/mine.sh: (a)"), r.err),
  );
  await t.test("…and one that no longer matches its checksum is yours too", () =>
    assert.ok(r.err.includes(".agents/hooks/guard.sh: (a)"), r.err),
  );
  appendFileSync(join(repo, ".agents/skills/x/scripts/ours.sh"), "# my edit\n");
  r = run(repo, "--all");
  await t.test("an edited shipped script is yours, test included", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/ours.sh: (a)"), r.err),
  );
});

// ── The bash hooks pair their .test.ts suites ────────────────────────────

test("a changed bash hook selects and pairs its .test.ts", async (t) => {
  const repo = newrepo();
  f(repo, ".agents/hooks/lib/paths.sh", "paths_root() { :; }");
  f(repo, ".agents/hooks/lib/paths.test.ts", 'spawnSync("bash", ["-c", "paths_root"]);');
  f(repo, ".agents/hooks/check-shared-checkout-write.sh", '#!/usr/bin/env bash\nsource "$(dirname "$0")/lib/paths.sh"');
  f(repo, ".agents/hooks/check-shared-checkout-write.test.ts", 'spawnSync("bash", [HOOK]);');
  f(repo, ".agents/skills/close/scripts/lock.sh", "lock_repo() { :; }");
  tier(repo);
  commitAll(repo, "hooks with their suites");
  appendFileSync(join(repo, ".agents/hooks/lib/paths.sh"), "# touched\n");
  appendFileSync(join(repo, ".agents/hooks/check-shared-checkout-write.sh"), "# touched\n");
  appendFileSync(join(repo, ".agents/skills/close/scripts/lock.sh"), "# touched\n");
  const r = run(repo);
  await t.test("the changed hook and its library are covered by their .test.ts", () =>
    assert.ok(!r.err.includes(".agents/hooks/"), r.err),
  );
  await t.test("…a changed lock.sh with no suite is not", () =>
    assert.equal(
      r.err,
      ".agents/skills/close/scripts/lock.sh: (a) no test — expected lock.test.ts beside it, or tests/lock.test.ts in its folder or parent",
    ),
  );
  await t.test("…three selected", () => assert.equal(r.out, "FAIL — 3 script(s) checked, 1 violation(s)"));
});
