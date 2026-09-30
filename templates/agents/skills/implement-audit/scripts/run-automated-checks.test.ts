// run-automated-checks.test.ts — boundary cases for run-automated-checks.ts per
// the boundary inputs (0 / 1 / empty / max / error).
// Run: node --test --experimental-strip-types .agents/skills/implement-audit/scripts/run-automated-checks.test.ts
//
// Hermetic: shims shellcheck via a per-test PATH so we don't touch the real
// binary; the lint step (layer-1.ts) is a stub named by AUTOMATED_CHECKS_LAYER1;
// the standards and secrets checks are stubs planted at the fixture's
// .agents/checks/; find-peers.ts is read from the repo's .agents/skills/review/
// (case16 plants one), so a fixture without it WARNs. Every stub records its
// argv, its stdin and the CLAUDE_PROJECT_DIR it saw, so a case can assert what
// it was handed. The script is run as a subprocess under `env -i`-style
// environments, never imported.
//
// peers: run-automated-checks.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "run-automated-checks.ts");

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const mktemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rac-test-"));
  made.push(d);
  return d;
};

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
const which = (name: string): string =>
  execFileSync("sh", ["-c", `command -v ${name} || true`], { encoding: "utf8" }).trim();

/**
 * A stub check (a .ts file the script runs with node): prints <msg> on stderr
 * and exits <code>. It records its argv at <path>.args, its stdin at
 * <path>.stdin and the CLAUDE_PROJECT_DIR it saw at <path>.env.
 */
function mkstub(path: string, code: number, msg = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  const p = JSON.stringify(path);
  writeFileSync(
    path,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${p} + ".args", process.argv.slice(2).map((a) => a + "\\n").join(""));`,
      "let stdin = \"\";",
      "try { stdin = readFileSync(0, \"utf8\"); } catch {}",
      `writeFileSync(${p} + ".stdin", stdin);`,
      `writeFileSync(${p} + ".env", (process.env.CLAUDE_PROJECT_DIR ?? "") + "\\n");`,
      msg === "" ? "" : `process.stderr.write(${JSON.stringify(`${msg}\n`)});`,
      `process.exit(${code});`,
      "",
    ].join("\n"),
  );
}
const recorded = (path: string, what: "args" | "stdin" | "env"): string =>
  existsSync(`${path}.${what}`) ? readFileSync(`${path}.${what}`, "utf8").replace(/\n+$/, "") : "";

// ── Per-test fixture builder ──────────────────────────────────────────
function makeRepo(): string {
  const d = mktemp();
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  // The standards and secrets checks WARN-skip a repo with no .agents/checks
  // (a product repo), so every case that exercises them needs the pair.
  mkstub(join(d, ".agents/checks/check-standards-refs.ts"), 0);
  mkstub(join(d, ".agents/checks/check-secrets.ts"), 0);
  writeFileSync(join(d, ".gitignore"), "*.args\n*.stdin\n*.env\n_lint/\n_home/\nseen\n");
  // Make a minimal initial commit so HEAD is parseable.
  writeFileSync(join(d, "README.md"), "init\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "init");
  return d;
}

/** A fake binary: prints <msg> on stderr and exits <code>. */
function mkbin(dir: string, name: string, code: number, msg = ""): void {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${msg}" >&2\nexit ${code}\n`);
  chmodSync(join(dir, name), 0o755);
}

interface Res {
  out: string;
  rc: number | null;
}
function exec(env: Record<string, string>, args: string[], cwd?: string): Res {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    // Node 22.6 prints an ExperimentalWarning for type stripping on stderr,
    // which these cases read.
    env: { NODE_NO_WARNINGS: "1", ...env },
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { out: `${r.stdout}${r.stderr}`, rc: r.status };
}
const lintStub = (repo: string): string => join(repo, "_lint/layer-1.ts");
function runScript(repo: string, fakebin: string, args: string[], lint = lintStub(repo)): Res {
  return exec(
    {
      HOME: `${repo}/_home`,
      PATH: `${fakebin}:/usr/bin:/bin`,
      CLAUDE_PROJECT_DIR: repo,
      AUTOMATED_CHECKS_LAYER1: lint,
    },
    args,
  );
}

/** The lint stub every case uses unless it plants its own: exit <code>. */
const setupFakeLint = (repo: string, code: number): void => mkstub(lintStub(repo), code);
/** A shellcheck shim exists, so the script doesn't WARN-skip. */
function setupFakeTools(fakebin: string): void {
  mkdirSync(fakebin, { recursive: true });
  mkbin(fakebin, "shellcheck", 0);
}
/** Changed .ts/.sh/.md files so the file-collection paths fire. */
function addChanges(repo: string, kinds: string): void {
  if (kinds.includes("ts")) writeFileSync(join(repo, "foo.ts"), "x\n");
  if (kinds.includes("sh")) writeFileSync(join(repo, "foo.sh"), "echo\n");
  if (kinds.includes("md")) writeFileSync(join(repo, "foo.md"), "x\n");
  git(repo, "add", "-A");
}
const head = (repo: string): string => git(repo, "rev-parse", "HEAD");
/** A repo, a PATH with a shellcheck shim, and a lint stub exiting <lint>. */
function fixture(lint: number | null = 0): { repo: string; fakebin: string } {
  const repo = makeRepo();
  const fakebin = mktemp();
  setupFakeTools(fakebin);
  if (lint !== null) setupFakeLint(repo, lint);
  return { repo, fakebin };
}

test("the script is executable", () => {
  assert.doesNotThrow(() => accessSync(SCRIPT, constants.X_OK), `not executable: ${SCRIPT}`);
});

// ── Case 1: --session-base missing → fail loud ──
test("case1 missing-session-base-fails", () => {
  const { repo, fakebin } = fixture();
  const r = runScript(repo, fakebin, []);
  assert.notEqual(r.rc, 0, "expected non-zero on missing --session-base");
  assert.match(r.out, /session-base.*required/, "no err message");
});

// ── Case 2: --session-base unparseable → fail loud ──
test("case2 bad-sha-fails", () => {
  const { repo, fakebin } = fixture();
  assert.notEqual(runScript(repo, fakebin, ["--session-base", "not-a-sha"]).rc, 0, "expected non-zero on bad SHA");
});

// ── Case 3: 0 files changed → all checks emit PASS / nothing-to-check ──
test("case3 zero-files-all-pass", () => {
  const { repo, fakebin } = fixture();
  const r = runScript(repo, fakebin, ["--session-base", head(repo)]);
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}: ${r.out}`);
  assert.match(r.out, /SUMMARY:.*PASS/, "missing summary");
  assert.ok(r.out.includes("PASS: lint (0 files)"), "lint (0 files) missing");
});

// ── Case 4: 1 .ts file, lint clean → PASS: lint (1 files) ──
test("case4 one-ts-lint-clean", () => {
  const { repo, fakebin } = fixture();
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("PASS: lint (1 files)"), `lint PASS missing: ${r.out}`);
});

// ── Case 5: 1 .ts file, lint dirty → FAIL: lint ──
test("case5 ts-lint-dirty-fails", () => {
  const { repo, fakebin } = fixture(1);
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.notEqual(r.rc, 0, "expected non-zero on lint dirty");
  assert.ok(r.out.includes("FAIL: lint"), "FAIL: lint missing");
});

// ── Case 6: only .md changed → lint PASS (0), nothing else fires ──
test("case6 md-only", () => {
  const { repo, fakebin } = fixture(1);
  const base = head(repo);
  addChanges(repo, "md");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `expected zero exit (md-only); got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("PASS: lint (0 files)"), "lint (0 files) missing");
});

// ── Case 7: shellcheck-missing-warn ──
// A minimal PATH containing only the binaries the script needs — no SC binary —
// so the PATH lookup for SC comes back empty even on hosts that have real SC
// installed in /usr/bin.
test("case7 shellcheck-missing-warn", () => {
  const repo = makeRepo();
  const fakebin = mktemp();
  for (const bin of "git sed awk grep head find mktemp dirname basename cat sort tail uname tr printf chmod rm bash cut wc cp".split(
    " ",
  )) {
    const p = which(bin);
    if (p) symlinkSync(p, join(fakebin, bin));
  }
  setupFakeLint(repo, 0);
  const base = head(repo);
  addChanges(repo, "sh");
  const r = exec(
    { HOME: `${repo}/_home`, PATH: fakebin, CLAUDE_PROJECT_DIR: repo, AUTOMATED_CHECKS_LAYER1: lintStub(repo) },
    ["--session-base", base],
  );
  assert.equal(r.rc, 0, `WARN should not fail; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("WARN: shellcheck missing"), `WARN missing: ${r.out}`);
});

// ── Case 8: secrets dirty → FAIL, and the scan covers the session's span ──
test("case8 secrets-dirty-fails", () => {
  const { repo, fakebin } = fixture();
  const secrets = join(repo, ".agents/checks/check-secrets.ts");
  mkstub(secrets, 1, "a likely secret");
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.notEqual(r.rc, 0, "expected non-zero on secrets dirty");
  assert.ok(r.out.includes("FAIL: secrets"), `FAIL: secrets missing: ${r.out}`);
  assert.equal(recorded(secrets, "args"), `--since\n${base}`, "scan not run --since the session base");
});

// ── Case 9: --repo-dir not a git repo → fail loud ──
test("case9 not-a-git-repo-fails", () => {
  const d = mktemp();
  const fakebin = mktemp();
  setupFakeTools(fakebin);
  const r = exec({ HOME: "/tmp", PATH: `${fakebin}:/usr/bin:/bin` }, ["--session-base", "HEAD", "--repo-dir", d]);
  assert.notEqual(r.rc, 0, "expected non-zero on non-git dir");
});

// ── Case 10 (Fix B): CLAUDE_PROJECT_DIR unset, no --repo-dir, cwd inside a git
// repo → resolve root via git rev-parse; 0 files → all PASS (exit 0) ──
test("case10 env-unset-in-repo-resolves-via-git", () => {
  const { repo, fakebin } = fixture();
  const r = exec(
    { HOME: `${repo}/_home`, PATH: `${fakebin}:/usr/bin:/bin`, AUTOMATED_CHECKS_LAYER1: lintStub(repo) },
    ["--session-base", head(repo)],
    repo,
  );
  assert.equal(r.rc, 0, `expected zero with env unset inside repo; got ${r.rc}: ${r.out}`);
  assert.match(r.out, /SUMMARY:.*PASS/, `missing summary with env unset: ${r.out}`);
});

// ── Case 11 (Fix B): --repo-dir overrides env/git. Set a bogus CLAUDE_PROJECT_DIR
// but pass --repo-dir "$repo" → the flag wins, run succeeds (exit 0) ──
test("case11 repo-dir-overrides-env", () => {
  const { repo, fakebin } = fixture();
  const r = exec(
    {
      HOME: `${repo}/_home`,
      PATH: `${fakebin}:/usr/bin:/bin`,
      AUTOMATED_CHECKS_LAYER1: lintStub(repo),
      CLAUDE_PROJECT_DIR: "/nonexistent-bogus-path",
    },
    ["--session-base", head(repo), "--repo-dir", repo],
  );
  assert.equal(r.rc, 0, `expected zero; --repo-dir should override bogus env; got ${r.rc}: ${r.out}`);
  assert.match(r.out, /SUMMARY:.*PASS/, `missing summary: ${r.out}`);
});

// ── Case 12: no .agents/checks in the repo → WARN, not FAIL ──
//
// A product repo carries none of the workbench's checks. A FAIL there would be
// for a missing file rather than for the diff.
test("case12 checks-absent-warns", () => {
  const { repo, fakebin } = fixture();
  rmSync(join(repo, ".agents/checks"), { recursive: true, force: true });
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `checks-absent must not fail; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("WARN: check-secrets.ts missing"), `secrets WARN missing: ${r.out}`);
  assert.ok(r.out.includes("WARN: check-standards-refs.ts missing"), `standards WARN missing: ${r.out}`);
  assert.doesNotMatch(r.out, /FAIL: (secrets|standards-refs)/, `still FAILs on absent checks: ${r.out}`);
});

// ── Case 13: no layer-1.ts + a changed .ts → lint WARNs, never FAILs ──
test("case13 lint-step-absent-warns", () => {
  const { repo, fakebin } = fixture(null);
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base], join(repo, "_lint/absent.ts"));
  assert.equal(r.rc, 0, `missing lint step must not fail; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("WARN: lint missing"), `expected lint WARN: ${r.out}`);
  assert.ok(!r.out.includes("FAIL: lint"), `still FAILs with no lint step: ${r.out}`);
});

// ── Case 14: a dangling standards citation → FAIL, over this change's files only ──
test("case14 standards-refs-dangling-fails", () => {
  const { repo, fakebin } = fixture();
  const refs = join(repo, ".agents/checks/check-standards-refs.ts");
  mkstub(refs, 1, "foo.sh:1: no such standard");
  const base = head(repo);
  addChanges(repo, "sh");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.notEqual(r.rc, 0, `expected non-zero on a dangling citation: ${r.out}`);
  assert.ok(r.out.includes("FAIL: standards-refs"), `FAIL: standards-refs missing: ${r.out}`);
  const args = recorded(refs, "args").split("\n");
  assert.ok(args.includes("foo.sh") && !args.includes("README.md"), `not scoped to the change: ${args.join(" ")}`);
});

// ── Case 15: lint runs against THIS repo, over the changed files ──
//
// A stub that only exits 0 cannot tell "ran over the change" from "ran over
// nothing" — both PASS. This one records what it was handed, which is the
// thing under test. The deleted README.md is markdown, so it selects no package.
test("case15 lint-runs-over-the-change", () => {
  const { repo, fakebin } = fixture();
  const base = head(repo);
  addChanges(repo, "ts");
  git(repo, "rm", "-q", "README.md");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `expected zero; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("PASS: lint (1 files)"), `lint should run over foo.ts only: ${r.out}`);
  assert.equal(recorded(lintStub(repo), "stdin"), "foo.ts", "lint handed the wrong files");
  assert.equal(recorded(lintStub(repo), "env"), repo, "lint ran against another repo");
});

// ── Case 16: find-peers.ts is read from .agents/skills/review, nowhere else ──
//
// A copy planted ONLY at another path must not be found; the one under
// .agents/skills/review must run and its verdict must be the one reported.
test("case16 find-peers-read-from-skills-review", () => {
  const { repo, fakebin } = fixture();
  mkdirSync(join(repo, ".agents/skills/review"), { recursive: true });
  mkdirSync(join(repo, "tools"), { recursive: true });
  writeFileSync(join(repo, ".agents/skills/review/find-peers.ts"), 'process.stderr.write("new-path find-peers ran\\n");\n');
  writeFileSync(
    join(repo, "tools/find-peers.ts"),
    'process.stderr.write("old-path find-peers ran\\n");\nprocess.exit(1);\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plant find-peers");
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `expected zero; got ${r.rc}: ${r.out}`);
  assert.ok(
    r.out.includes("PASS: find-peers (0 left-behind)"),
    `find-peers under .agents/skills/review should have run and passed: ${r.out}`,
  );
  assert.ok(!r.out.includes("old-path find-peers ran"), `the copy elsewhere ran: ${r.out}`);
});

// ── Case 17: find-peers' left-behind warnings are surfaced, not swallowed ──
test("case17 find-peers-warnings-surfaced", () => {
  const { repo, fakebin } = fixture();
  mkdirSync(join(repo, ".agents/skills/review"), { recursive: true });
  writeFileSync(
    join(repo, ".agents/skills/review/find-peers.ts"),
    'process.stderr.write("  PEER: lib/other.sh\\n⚠ 1 peer(s) may be mid-sweep\\n");\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plant find-peers");
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `warn-only must not fail; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("WARN: find-peers (1 left-behind)"), `peer warning swallowed: ${r.out}`);
  assert.ok(r.out.includes("PEER: lib/other.sh"), `the peer is not named: ${r.out}`);
  assert.ok(!r.out.includes("PASS: find-peers"), `still reports a clean sweep: ${r.out}`);
});

// ── Case 18: a lint step layer-1 skipped is reported, not counted as linted ──
test("case18 lint-skips-surfaced", () => {
  const { repo, fakebin } = fixture(null);
  mkdirSync(join(repo, "_lint"), { recursive: true });
  writeFileSync(
    lintStub(repo),
    'process.stdout.write("WARN: layer-1 lint (apps/a) — no lint script or make target; skipped\\n");\n',
  );
  const base = head(repo);
  addChanges(repo, "ts");
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 0, `a skipped step must not fail; got ${r.rc}: ${r.out}`);
  assert.ok(
    r.out.includes("WARN: lint (apps/a) — no lint script or make target; skipped"),
    `skip not surfaced: ${r.out}`,
  );
  assert.ok(!r.out.split("\n").includes("PASS: lint (1 files)"), `still reported as linted: ${r.out}`);
});

// ── Case 19: an untracked file is scanned for citations too ──
// check-standards-refs.ts reads files through git, and git ignores an untracked
// path even when it is named — so a brand-new file's citation went unchecked.
test("case19 untracked-files-scanned-for-citations", () => {
  const { repo, fakebin } = fixture();
  const seen = join(repo, ".agents/checks/seen");
  writeFileSync(
    join(repo, ".agents/checks/check-standards-refs.ts"),
    [
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const r = spawnSync("git", ["ls-files", "--", ...process.argv.slice(2)], { encoding: "utf8" });',
      `writeFileSync(${JSON.stringify(seen)}, r.stdout ?? "");`,
      "",
    ].join("\n"),
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stub");
  const base = head(repo);
  writeFileSync(join(repo, "new-note.md"), "See § Standards → X.\n");
  runScript(repo, fakebin, ["--session-base", base]);
  const got = existsSync(seen) ? readFileSync(seen, "utf8") : "";
  assert.ok(got.split("\n").includes("new-note.md"), `the checker could not see the untracked file: ${got}`);
  assert.equal(git(repo, "ls-files", "--", "new-note.md"), "", "the real index was changed");
});

// ── Case 20: a git that cannot list the change is an error, not a clean run ──
// A failed read that listed nothing made every check report PASS over an empty
// change.
test("case20 failed-listing-is-an-error", () => {
  const { repo, fakebin } = fixture();
  const base = head(repo);
  addChanges(repo, "ts");
  writeFileSync(
    join(fakebin, "git"),
    `#!/usr/bin/env bash\ncase " $* " in *" ls-files --others "*) exit 128 ;; esac\nexec "${which("git")}" "$@"\n`,
  );
  chmodSync(join(fakebin, "git"), 0o755);
  const r = runScript(repo, fakebin, ["--session-base", base]);
  assert.equal(r.rc, 1, `a failed listing passed: ${r.rc} ${r.out}`);
  assert.ok(r.out.includes("could not list the change"), `not said: ${r.out}`);
});
