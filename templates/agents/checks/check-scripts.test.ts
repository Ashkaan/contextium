// check-scripts.test.ts — boundary rows for check-scripts.ts: both parts, the
// script definition, the six pairing shapes, the library carve-out with its
// specifier resolution, the no-args / --since scans land.ts actually calls,
// --all, explicit paths, caller errors and Contextium's shipped-script rule.
//
// Run: node --test --experimental-strip-types .agents/checks/check-scripts.test.ts
//
// Every fixture lives in a real `git init`-ed repo, because the incremental
// modes read `git diff` and `git ls-files --others`; a bare scratch directory
// cannot reach them. The program is SPAWNED, never imported. HOME points into
// the scratch folder, so nothing it runs can reach a real home.

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

function lines(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

// ── (1)(2) Part (a): a script with no test, then with one ────────────────

test("part (a): a script with no test, then with one", async (t) => {
  const repo = newrepo();
  f(repo, ".agents/skills/x/scripts/a.sh", "#!/usr/bin/env bash");
  let r = run(repo, "--all");
  await t.test("uncovered .sh fails", () => assert.equal(r.rc, 1));
  await t.test("…with the one-line FAIL summary", () =>
    assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"),
  );
  await t.test("…and the (a) line naming the six shapes", () =>
    assert.equal(
      r.err,
      ".agents/skills/x/scripts/a.sh: (a) no test — expected a.test.sh or a.test.ts beside it, or tests/a.test.* in its folder or parent",
    ),
  );

  f(repo, ".agents/skills/x/scripts/a.test.sh", 'bash "$(dirname "$0")/a.sh"');
  r = run(repo, "--all");
  await t.test("a sibling .test.sh covers it", () => assert.equal(r.rc, 0));
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
  f(repo, ".agents/skills/x/scripts/c.test.sh", "node c.ts");
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
  f(repo, ".agents/skills/y/scripts/b.test.sh", "node b.ts");
  f(repo, ".agents/skills/y/scripts/c.ts", 'import { g } from "./b.ts";');
  f(repo, ".agents/skills/y/scripts/c.test.sh", "node c.ts");
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
  f(repo, ".agents/skills/x/scripts/c.test.sh", "node c.ts");
  commitAll(repo, "library and importer");
  r = run(repo, "--since", "main");
  await t.test("clean at the trunk", () => assert.equal(r.rc, 0));
  git(repo, "checkout", "-q", "-b", "work");
  git(repo, "rm", "-q", ".agents/skills/x/scripts/c.ts", ".agents/skills/x/scripts/c.test.sh");
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
  r = run(repo, "--all");
  await t.test("a comment mentioning the file is not an import", () => assert.equal(r.rc, 0));

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/q.ts", "process.argv");
  f(repo, ".agents/skills/x/scripts/q.test.ts", 'import { x } from "./q.ts";\nspawnSync("node", ["q.ts"]);');
  r = run(repo, "--all");
  await t.test("a test that both imports and spawns its subject is still (b)", () => assert.equal(r.rc, 1));

  // A tests/ subfolder test importing ../subject resolves to the subject.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/r.ts", "process.argv");
  f(repo, ".agents/skills/x/scripts/tests/r.test.ts", 'import { r } from "../r.ts";');
  r = run(repo, "--all");
  await t.test("tests/<stem>.test.ts importing ../<stem>.ts is (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming the tests/ path", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/tests/r.test.ts: (b) imports its subject .agents/skills/x/scripts/r.ts"), r.err),
  );

  // A library source built at run time from a tests/ folder: `$HERE/../lib.sh`.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/lib.sh", "helper() { :; }");
  f(repo, ".agents/skills/x/scripts/tests/lib.test.sh", 'source "$DIR/../lib.sh"');
  f(repo, ".agents/skills/x/scripts/user.sh", 'source "$SCRIPT_DIR/lib.sh"');
  f(repo, ".agents/skills/x/scripts/tests/user.test.sh", "bash ../user.sh");
  r = run(repo, "--all");
  await t.test("a run-time-built source from a sibling makes lib.sh a library", () => assert.equal(r.rc, 0));

  // A run-time-built source from a tests/ folder up to its program: still (b).
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "echo program");
  f(repo, ".agents/skills/x/scripts/tests/p.test.sh", 'source "$(dirname "$0")/../p.sh"');
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
  r = run(repo, "--all");
  await t.test("a clean .test.sh beside an importing .test.ts is still (b)", () => assert.equal(r.rc, 1));
  await t.test("…naming the importing one", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/q.test.ts: (b) imports its subject .agents/skills/x/scripts/q.ts"), r.err),
  );
});

// ── (8)(9) The script definition ─────────────────────────────────────────

test("the script definition", async (t) => {
  let repo = newrepo();
  f(repo, ".agents/skills/x/references/x.sh");
  f(repo, ".agents/skills/x/scripts/x.template.sh");
  f(repo, ".agents/skills/x/scripts/x.test.sh");
  f(repo, ".agents/skills/x/scripts/tests/helper.sh");
  f(repo, ".agents/skills/x/templates/t.sh");
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
  f(repo, "apps/other/scripts/outside.sh");
  r = run(repo, "--all");
  await t.test("shebang or scripts-folder files are scripts; lib/ and shebang-less root files are not", () =>
    assert.equal(r.rc, 1),
  );
  await t.test("…eight scripts counted, none outside the roots", () =>
    assert.equal(r.out, "FAIL — 8 script(s) checked, 8 violation(s)"),
  );
  await t.test("…lib/d.ts is not a script", () => assert.ok(!r.err.includes("lib/d.ts"), r.err));
  await t.test("…g.js without a shebang outside a scripts folder is not a script", () =>
    assert.ok(!r.err.includes("g.js"), r.err),
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
  r = run(repo, "--all");
  chmodSync(join(repo, ".agents/skills/x/scripts/u.test.sh"), 0o644);
  await t.test("an unreadable paired test is rc 2", () => assert.equal(r.rc, 2));
  await t.test("…naming it", () => assert.ok(r.err.includes("cannot read .agents/skills/x/scripts/u.test.sh"), r.err));

  // A <skill>/tests/ test sourcing its program through $HERE/../scripts/ is (b).
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$HERE/../scripts/p.sh"');
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
  r = run(repo, "--all");
  await t.test('a test sourcing $(dirname "${BASH_SOURCE[0]}")/<stem>.sh is (b)', () => assert.equal(r.rc, 1));
  await t.test("…naming it", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/q.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/scripts/tests/q.test.sh", 'source "$(dirname "${BASH_SOURCE[0]}")/../q.sh"');
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
  r = run(repo, "--all");
  await t.test("a literal ) in a folder name is kept in the path", () =>
    assert.ok(!r.err.includes("imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // A quoted ) inside a substitution does not close it.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$(dirname "$0" | tr -d ")")/../scripts/p.sh"');
  r = run(repo, "--all");
  await t.test("a quoted ) inside $( ) does not end it", () =>
    assert.ok(r.err.includes(".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // A substitution nested inside a double-quoted one, with quoted parens of its own.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh", "#!/usr/bin/env bash");
  f(repo, ".agents/skills/x/tests/p.test.sh", 'source "$(dirname "$(echo "$0" | tr -d ")(")")/../scripts/p.sh"');
  r = run(repo, "--all");
  await t.test("a nested, quoted substitution is skipped whole", () =>
    assert.ok(r.err.includes(".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"), r.err),
  );

  // An explicit path given absolute is the same file as its relative form.
  repo = newrepo();
  f(repo, ".agents/skills/y/scripts/b.sh");
  r = run(repo, join(repo, ".agents/skills/y/scripts/b.sh"));
  await t.test("an absolute explicit path is checked", () => assert.equal(r.rc, 1));
  await t.test("…and counted", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));
});

// ── (15) Empty test file passes both parts ───────────────────────────────

test("an empty test file", async (t) => {
  const repo = newrepo();
  f(repo, ".agents/skills/x/scripts/a.sh");
  writeFileSync(join(repo, ".agents/skills/x/scripts/a.test.sh"), "");
  const r = run(repo, "--all");
  await t.test("an empty test file passes (a) and (b)", () => assert.equal(r.rc, 0));
});

// ── (10) No-args mode ────────────────────────────────────────────────────

test("no-args mode", async (t) => {
  let repo = newrepo();
  f(repo, ".agents/skills/x/scripts/old.sh");
  f(repo, ".agents/skills/x/scripts/old.test.sh", "bash old.sh");
  f(repo, ".agents/skills/x/scripts/gone.sh");
  f(repo, ".agents/skills/x/scripts/gone.test.sh", "bash gone.sh");
  f(repo, ".agents/skills/x/scripts/orphan.sh");
  f(repo, ".agents/skills/x/scripts/orphan.test.sh", "bash orphan.sh");
  f(repo, ".agents/skills/x/scripts/untested.sh");
  commitAll(repo, "baseline with an untested script");
  let r = run(repo);
  await t.test("no-args with nothing changed is clean", () => assert.equal(r.rc, 0));
  await t.test("…and counts nothing (the untested committed script is not selected)", () =>
    assert.equal(r.out, "OK — 0 script(s) checked"),
  );

  f(repo, ".agents/skills/x/scripts/new.sh"); // untracked, no test
  rmSync(join(repo, ".agents/skills/x/scripts/gone.sh")); // script deleted, test stays
  rmSync(join(repo, ".agents/skills/x/scripts/orphan.test.sh")); // test deleted, script stays
  writeFileSync(join(repo, ".agents/skills/x/scripts/old.sh"), "# a file\n# touched\n"); // changed, covered
  r = run(repo);
  await t.test("no-args: untracked and orphaned scripts fail", () => assert.equal(r.rc, 1));
  await t.test("…three selected: new, orphan and old (gone is skipped)", () =>
    assert.equal(r.out, "FAIL — 3 script(s) checked, 2 violation(s)"),
  );
  await t.test("…the untracked one", () => assert.ok(r.err.includes(".agents/skills/x/scripts/new.sh: (a)"), r.err));
  await t.test("…the one whose test was deleted", () =>
    assert.ok(r.err.includes(".agents/skills/x/scripts/orphan.sh: (a)"), r.err),
  );
  await t.test("…not the deleted script", () => assert.ok(!r.err.includes("gone.sh"), r.err));
  await t.test("…not the covered change", () => assert.ok(!r.err.includes("old.sh"), r.err));
  await t.test("…not the untested script nothing touched", () => assert.ok(!r.err.includes("untested.sh"), r.err));

  // A script whose only test lives under tests/ — deleting that test must
  // select the script, although tests/ is an excluded segment for SCRIPTS.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/deep.sh");
  f(repo, ".agents/skills/x/scripts/tests/deep.test.sh", "bash ../deep.sh");
  commitAll(repo, "a script tested from tests/");
  rmSync(join(repo, ".agents/skills/x/scripts/tests/deep.test.sh"));
  r = run(repo);
  await t.test("no-args: deleting a script's only test under tests/ fails (a)", () => assert.equal(r.rc, 1));
  await t.test("…naming the script", () => assert.ok(r.err.includes(".agents/skills/x/scripts/deep.sh: (a)"), r.err));

  // The change listing failing is a caller error, never an empty change set.
  r = run(repo, "--since", "no-such-ref");
  await t.test("--since a ref git cannot resolve is rc 2", () => assert.equal(r.rc, 2));

  // A universe listing that cannot be completed is rc 2, never a shorter OK:
  // a folder find cannot enter makes find fail, and every mode reads the universe.
  repo = newrepo();
  f(repo, ".agents/skills/x/scripts/p.sh");
  f(repo, ".agents/skills/x/scripts/p.test.sh", "bash p.sh");
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
  f(repo, ".agents/skills/x/scripts/a.sh");
  f(repo, ".agents/skills/x/scripts/a.test.sh", "bash a.sh");
  commitAll(repo, "trunk");
  git(repo, "checkout", "-q", "-b", "work");
  f(repo, ".agents/skills/x/scripts/b.sh");
  commitAll(repo, "committed on the branch, no test");
  let r = run(repo);
  await t.test("no-args misses a change already committed", () => assert.equal(r.rc, 0));
  r = run(repo, "--since", "main");
  await t.test("--since main sees it", () => assert.equal(r.rc, 1));
  await t.test("…naming it", () => assert.ok(r.err.includes(".agents/skills/x/scripts/b.sh: (a)"), r.err));
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
  f(repo, ".agents/skills/x/scripts/a.sh");
  f(repo, ".agents/skills/x/scripts/a.test.sh", "bash a.sh");
  f(repo, ".agents/skills/y/scripts/b.sh");
  f(repo, ".agents/checks/c.sh");
  f(repo, ".agents/hooks/d.sh");
  f(repo, ".agents/generators/e.sh");
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

  r = run(repo, ".agents/skills/x/scripts/a.sh");
  await t.test("an explicit covered file", () => assert.equal(r.rc, 0));
  await t.test("…counts one", () => assert.equal(r.out, "OK — 1 script(s) checked"));
  r = run(repo, ".agents/skills/y/scripts/b.sh", ".agents/hooks/d.sh");
  await t.test("explicit uncovered files", () => assert.equal(r.rc, 1));
  await t.test("…count two", () => assert.equal(r.out, "FAIL — 2 script(s) checked, 2 violation(s)"));
  r = run(repo, ".agents/checks");
  await t.test("a directory argument walks it for scripts", () => assert.equal(r.rc, 1));
  await t.test("…one script beneath it", () => assert.equal(r.out, "FAIL — 1 script(s) checked, 1 violation(s)"));
  r = run(repo, ".agents/skills/x/scripts/a.test.sh");
  await t.test("an explicit path that is not a script counts nothing", () => assert.equal(r.rc, 0));
  await t.test("…zero", () => assert.equal(r.out, "OK — 0 script(s) checked"));

  r = run(repo, "--all", ".agents/skills/x/scripts/a.sh");
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
  f(repo, ".agents/skills/x/scripts/a.sh");
  f(repo, ".agents/skills/y/scripts/b.ts", "export const b = 1;");
  f(repo, ".agents/skills/y/scripts/b.test.ts", 'import { b } from "./b.ts";');
  let r = run(repo, "--all");
  await t.test("--all: one stdout line", () => assert.equal(lines(r.out), 1));
  r = run(repo);
  await t.test("no-args: one stdout line", () => assert.equal(lines(r.out), 1));
  r = run(repo, ".agents/skills/x/scripts/a.sh");
  await t.test("paths: one stdout line", () => assert.equal(lines(r.out), 1));
  commitAll(repo, "all");
  r = run(repo, "--since", "main");
  await t.test("--since: one stdout line", () => assert.equal(lines(r.out), 1));
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
  commitAll(repo, "hooks with their suites");
  appendFileSync(join(repo, ".agents/hooks/lib/paths.sh"), "# touched\n");
  appendFileSync(join(repo, ".agents/hooks/check-shared-checkout-write.sh"), "# touched\n");
  appendFileSync(join(repo, ".agents/skills/close/scripts/lock.sh"), "# touched\n");
  const r = run(repo);
  await t.test("the changed hook and its library are covered by their .test.ts", () =>
    assert.ok(!r.err.includes(".agents/hooks/"), r.err),
  );
  await t.test("…a changed lock.sh with no suite is not", () =>
    assert.equal(r.err, ".agents/skills/close/scripts/lock.sh: (a) no test — expected lock.test.sh or lock.test.ts beside it, or tests/lock.test.* in its folder or parent"),
  );
  await t.test("…three selected", () => assert.equal(r.out, "FAIL — 3 script(s) checked, 1 violation(s)"));
});
