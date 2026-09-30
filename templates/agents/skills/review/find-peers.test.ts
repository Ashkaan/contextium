// find-peers.test.ts — hermetic tests for find-peers.ts
//
// Builds a throwaway git repo under $TMPDIR (never inside this repo: a
// script's tests run outside it), stages fixtures into it, and
// runs the check against them. Nothing here touches the real working tree.
//
// Run: node --test --experimental-strip-types .agents/skills/review/find-peers.test.ts
//
// Covers the boundary table in find-peers.ts's header: both sweep outcomes,
// the caller error, every branch of the exclusion audit (code hidden, prose
// only, survivor named, alternate exclusion spellings, no exclusions, absent
// path), and every reason mode 2 declines to warn (token re-added, peer
// changed too, peer absent, token below the floor).
//
// peers:
//   .agents/skills/review/find-peers.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_UNDER_TEST = path.join(path.dirname(fileURLToPath(import.meta.url)), "find-peers.ts");
const WORK = mkdtempSync(path.join(os.tmpdir(), "find-peers-test-"));
after(() => rmSync(WORK, { recursive: true, force: true }));

interface Run {
  rc: number | null;
  out: string;
  err: string;
}

function run(cwd: string, args: string[], env: Record<string, string> = {}): Run {
  // --no-warnings: Node 22.6-22.17 warn on type stripping, and several cases
  // assert a silent stderr.
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT_UNDER_TEST, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

const g = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
};

// Fresh single-purpose repo per case, so no case can leak into another.
function newRepo(name: string): string {
  const dir = path.join(WORK, `repo-${name}`);
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "--quiet");
  g(dir, "config", "user.email", "test@example.com");
  g(dir, "config", "user.name", "test");
  return dir;
}

function commitAll(dir: string, msg: string): void {
  g(dir, "add", "--all");
  g(dir, "commit", "--quiet", "--message", msg);
}

/** Write `body` at `rel` inside `dir`, making parents. */
function put(dir: string, rel: string, body: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
}

const DATETIME = "updated_at: z.string().datetime(),\n";
const BARE = "updated_at: z.string(),\n";
const RE = "z\\.string\\(\\),";

// ── Mode 1: --verify-sweep ───────────────────────────────────────────────
describe("mode 1: --verify-sweep", () => {
  test("sweep with no surviving match exits 0", () => {
    const repo = newRepo("sweep-clean");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "apps/b.ts", DATETIME);
    commitAll(repo, "init");
    assert.equal(run(repo, ["--verify-sweep", RE, "--", "apps"]).rc, 0, "sweep with no surviving match should exit 0");
  });

  test("sweep with a surviving match exits 1 and names the file", () => {
    const repo = newRepo("sweep-dirty");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "apps/b.ts", BARE);
    commitAll(repo, "init");
    const r = run(repo, ["--verify-sweep", RE, "--", "apps"]);
    assert.notEqual(r.rc, 0, "sweep with a surviving match should exit 1");
    assert.ok(r.err.includes("apps/b.ts"), "sweep failure should name the surviving file");
  });

  // A negative pathspec is how a deliberate survivor stays legal. It names the
  // FILE: since the exclusion audit below, a bare `:!readers` around runnable
  // code is the blind spot, not the declaration.
  test("negative pathspec excludes a deliberate survivor", () => {
    const repo = newRepo("sweep-excluded");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "readers/r.ts", BARE);
    commitAll(repo, "init");
    assert.equal(
      run(repo, ["--verify-sweep", RE, "--", ".", ":!readers/r.ts"]).rc,
      0,
      "negative pathspec should exclude a deliberate survivor",
    );
  });

  // The records live in this tree: a journal entry quoting the
  // retired pattern is prose about the sweep, not an instance it missed. The
  // default population (no pathspec) must leave journal/, knowledge/ and
  // projects/ out on its own.
  test("a journal entry naming the pattern is not a surviving match", () => {
    const repo = newRepo("sweep-journal-prose");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "journal/2026-01-01/0900-x.md", "Swept z.string(), out of every schema today.\n");
    commitAll(repo, "init");
    const r = run(repo, ["--verify-sweep", RE]);
    assert.equal(r.rc, 0, `journal prose should not fail a repo-wide sweep; got: ${r.err}`);
  });
});

// ── The exclusion audit ──────────────────────────────────────────────────
//
// The shape that slipped: `:!projects` declared as historical prose, hiding a
// .js file that still matched. Prose in the same tree must stay excludable.
describe("the exclusion audit", () => {
  test("excluded directory hiding runnable code exits 1 and names only the code", () => {
    const repo = newRepo("sweep-exclusion-hides-code");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "projects/old/notes.md", "notes about z.string(), last spring\n");
    put(repo, "projects/old/scripts/scan.js", "const s = z.string(),\n");
    commitAll(repo, "init");
    const r = run(repo, ["--verify-sweep", RE, "--", ".", ":!projects"]);
    assert.notEqual(r.rc, 0, "an exclusion hiding runnable code should exit 1");
    assert.ok(
      r.err.includes("projects/old/scripts/scan.js") && !r.err.includes("projects/old/notes.md"),
      `should name scan.js and not notes.md; got: ${r.err}`,
    );
  });

  // Prose-only exclusion is what the directory form is legitimately for.
  test("excluded directory holding only prose still passes", () => {
    const repo = newRepo("sweep-exclusion-prose-only");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "projects/old/notes.md", "notes about z.string(), last spring\n");
    commitAll(repo, "init");
    assert.equal(
      run(repo, ["--verify-sweep", RE, "--", ".", ":!projects"]).rc,
      0,
      "a prose-only exclusion should pass",
    );
  });

  // Naming the file beside the tree is how a deliberate code survivor is
  // recorded rather than hidden.
  test("a code survivor named as its own file-level exclusion is accepted", () => {
    const repo = newRepo("sweep-exclusion-file-named");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "projects/old/scripts/scan.js", "const s = z.string(),\n");
    commitAll(repo, "init");
    assert.equal(
      run(repo, ["--verify-sweep", RE, "--", ".", ":!projects", ":!projects/old/scripts/scan.js"]).rc,
      0,
      "naming the survivor file should be accepted",
    );
  });

  // `:^` and `:(exclude)` are the same pathspec magic under other spellings.
  test(":^ and :(exclude) are audited like :!", () => {
    const repo = newRepo("sweep-exclusion-alt-syntax");
    put(repo, "apps/a.ts", DATETIME);
    put(repo, "projects/scripts/scan.sh", "const s = z.string(),\n");
    commitAll(repo, "init");
    let altOk = 0;
    for (const form of [":^projects", ":(exclude)projects"]) {
      if (run(repo, ["--verify-sweep", RE, "--", ".", form]).rc !== 0) altOk++;
    }
    assert.equal(altOk, 2, "exclusion forms :^ and :(exclude) should be audited");
  });

  // No exclusions at all — nothing to audit, and the clean sweep still passes.
  test("a sweep with no exclusions skips the audit and passes", () => {
    const repo = newRepo("sweep-no-exclusions");
    put(repo, "apps/a.ts", DATETIME);
    commitAll(repo, "init");
    assert.equal(run(repo, ["--verify-sweep", RE, "--", "apps"]).rc, 0, "a sweep with no exclusions should pass");
  });

  // An exclusion pointing at nothing on disk has no candidates to hide.
  test("an exclusion naming a path not on disk passes", () => {
    const repo = newRepo("sweep-exclusion-absent");
    put(repo, "apps/a.ts", DATETIME);
    commitAll(repo, "init");
    assert.equal(
      run(repo, ["--verify-sweep", RE, "--", ".", ":!nosuchdir"]).rc,
      0,
      "an absent excluded path should pass",
    );
  });

  test("sweep with no regex exits 2 (caller error, not a review outcome)", () => {
    const repo = newRepo("sweep-noregex");
    put(repo, "f.txt", "x\n");
    commitAll(repo, "init");
    const r = run(repo, ["--verify-sweep"]);
    assert.equal(r.rc, 2, `sweep with no regex should exit 2, got ${r.rc}`);
  });
});

// ── Mode 2: removed-token vs declared peers ──────────────────────────────
const ONE_OLD = "// peers: apps/two.ts\nconst v = envelope.data.scores;\n";
const ONE_NEW = "// peers: apps/two.ts\nconst v = envelope.scores;\n";

describe("mode 2: removed-token vs declared peers", () => {
  // The shape this exists to catch: a distinctive token deleted here, still
  // alive in a declared peer that this change did not touch.
  test("warns when a removed token survives in an unchanged declared peer", () => {
    const repo = newRepo("peer-left-behind");
    put(repo, "apps/one.ts", ONE_OLD);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", ONE_NEW);
    const r = run(repo, []);
    assert.ok(
      r.err.includes("apps/two.ts") && r.err.includes("data.scores"),
      `should warn about the left-behind peer; got: ${r.err}`,
    );
  });

  // Sweeping the peer in the same commit is the whole point — no warning then.
  test("silent when the declared peer was swept in the same change", () => {
    const repo = newRepo("peer-swept");
    put(repo, "apps/one.ts", ONE_OLD);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", ONE_NEW);
    put(repo, "apps/two.ts", "const v = envelope.scores;\n");
    const r = run(repo, []);
    assert.equal(r.err, "", `a peer changed in the same commit should not warn; got: ${r.err}`);
  });

  // Reformatting moves a token around; it was never actually removed.
  test("silent when the token was moved, not removed", () => {
    const repo = newRepo("token-readded");
    put(repo, "apps/one.ts", ONE_OLD);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", "// peers: apps/two.ts\nconst v =\n  envelope.data.scores;\n");
    const r = run(repo, []);
    assert.equal(r.err, "", `a re-added token should not warn; got: ${r.err}`);
  });

  // Short bare words are what made the old version unreadable.
  test("silent for tokens under the distinctiveness floor", () => {
    const repo = newRepo("token-too-short");
    put(repo, "apps/one.ts", "// peers: apps/two.ts\nconst ab = 1;\n");
    put(repo, "apps/two.ts", "const ab = 1;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", "// peers: apps/two.ts\nconst cd = 1;\n");
    const r = run(repo, []);
    assert.equal(r.err, "", `a below-floor token should not warn; got: ${r.err}`);
  });

  test("silent when the declared peer is not on disk", () => {
    const repo = newRepo("peer-missing");
    put(repo, "apps/one.ts", "// peers: apps/gone.ts\nconst v = envelope.data.scores;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", "// peers: apps/gone.ts\nconst v = envelope.scores;\n");
    const r = run(repo, []);
    assert.equal(r.err, "", `a peer that does not exist should not warn; got: ${r.err}`);
  });

  test("clean tree exits 0 silently", () => {
    const repo = newRepo("no-changes");
    put(repo, "f.txt", "x\n");
    commitAll(repo, "init");
    assert.equal(run(repo, []).rc, 0, "clean tree should exit 0");
  });

  // Warn-only: mode 2 must never fail the run, however much it found.
  test("mode 2 exits 0 even when it warns (warn-only contract)", () => {
    const repo = newRepo("warn-only-exit");
    put(repo, "apps/one.ts", ONE_OLD);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", ONE_NEW);
    assert.equal(run(repo, []).rc, 0, "mode 2 must exit 0 — it is warn-only");
  });

  // A session that COMMITTED its class fix diffs to nothing against HEAD; the
  // caller that knows where the session began passes it, and the committed
  // removal is measured from there.
  test("--base measures a committed removal from that revision", () => {
    const repo = newRepo("base-committed");
    put(repo, "apps/one.ts", ONE_OLD);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\n");
    commitAll(repo, "init");
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    put(repo, "apps/one.ts", ONE_NEW);
    commitAll(repo, "the fix, committed");
    assert.equal(run(repo, []).err, "", "from HEAD a committed removal is no change at all");
    for (const args of [
      ["--base", base],
      ["--base", base, "apps/one.ts"],
    ]) {
      const r = run(repo, args);
      assert.equal(r.rc, 0, r.err);
      assert.ok(
        r.err.includes("apps/two.ts") && r.err.includes("data.scores"),
        `${args.join(" ")} should warn about the left-behind peer; got: ${r.err}`,
      );
    }
    const bad = run(repo, ["--base"]);
    assert.equal(bad.rc, 2, `--base with no revision: ${bad.err}`);
  });
});

// ── The declared-peers reader: `--peers <file>` ─────────────────────────
//
// Skills carry their peers under `metadata:` → `peers:` as one space-separated
// string (the Agent Skills spec); agents and rules still
// carry a top-level `peers:` list. Both must read, and an empty nested value
// names nothing.
describe("the declared-peers reader: --peers <file>", () => {
  test("--peers reads metadata.peers as a space-separated string", () => {
    const repo = newRepo("peers-nested");
    put(
      repo,
      "x/SKILL.md",
      '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "~/tools/x/scripts/a.sh b/c.md"\n---\nbody\n',
    );
    commitAll(repo, "init");
    const got = run(repo, ["--peers", "x/SKILL.md"]).out.replace(/\n+$/, "");
    assert.equal(got, "~/tools/x/scripts/a.sh\nb/c.md", `--peers should list both nested peers; got: ${got}`);
  });

  test("--peers lists nothing for an empty metadata.peers, and exits 0", () => {
    const repo = newRepo("peers-nested-empty");
    put(repo, "x/SKILL.md", '---\nname: x\ndescription: A skill.\nmetadata:\n  peers: ""\n---\nbody\n');
    commitAll(repo, "init");
    const r = run(repo, ["--peers", "x/SKILL.md"]);
    assert.ok(
      r.rc === 0 && r.out === "",
      `empty metadata.peers should list nothing with exit 0; got rc=${r.rc}: ${r.out}`,
    );
  });

  test("--peers still reads a top-level peers: list (agents, rules)", () => {
    const repo = newRepo("peers-top-level");
    put(
      repo,
      ".agents/agents/r.md",
      "---\nname: r\ndescription: An agent.\npeers:\n  - a/b.md\n  - c/d.sh\n---\nbody\n",
    );
    commitAll(repo, "init");
    const got = run(repo, ["--peers", ".agents/agents/r.md"]).out.replace(/\n+$/, "");
    assert.equal(got, "a/b.md\nc/d.sh", `top-level peers: list should still read; got: ${got}`);
  });

  // And mode 2 sees the nested form: a token removed from the skill that
  // survives in its declared peer is warned about.
  test("mode 2 warns through a metadata.peers declaration", () => {
    const repo = newRepo("peer-nested-left-behind");
    const skill = (name: string): string =>
      `---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "b/c.md"\n---\nrun scripts/${name}.sh\n`;
    put(repo, "x/SKILL.md", skill("old-name"));
    put(repo, "b/c.md", "see scripts/old-name.sh\n");
    commitAll(repo, "init");
    put(repo, "x/SKILL.md", skill("new-name"));
    const r = run(repo, []);
    assert.ok(
      r.err.includes("b/c.md") && r.err.includes("old-name.sh"),
      `mode 2 should warn about the nested peer; got: ${r.err}`,
    );
  });

  // A peer declared as a home path is read at that
  // path, so a token left behind there is reported like any other.
  test("mode 2 reads a ~/ peer at the home path", () => {
    const repo = newRepo("peer-home-path");
    const fakeHome = path.join(WORK, "home-peer");
    put(fakeHome, "tools/x/scripts/run.sh", "run scripts/old-name.sh here\n");
    const skill = (name: string): string =>
      `---\nname: x\ndescription: A skill.\nmetadata:\n  peers: "~/tools/x/scripts/run.sh"\n---\nrun scripts/${name}.sh\n`;
    put(repo, "x/SKILL.md", skill("old-name"));
    commitAll(repo, "init");
    put(repo, "x/SKILL.md", skill("new-name"));
    const r = run(repo, [], { HOME: fakeHome });
    assert.ok(
      r.err.includes("scripts/run.sh") && r.err.includes("old-name.sh"),
      `mode 2 should warn about the ~/ peer; got: ${r.err}`,
    );
  });

  // A peer declared by an absolute path INSIDE this repo is the same file as
  // its repo-relative name: touched in the same change, it is the author's
  // to finish and must not warn (the repo-relative form has always been silent
  // here; the token is left in on purpose so the lookup is what decides).
  test("an absolute in-repo peer changed in the same diff is silent", () => {
    const repo = newRepo("peer-absolute-in-repo");
    put(repo, "apps/one.ts", `// peers: ${repo}/apps/two.ts\nconst v = envelope.data.scores;\n`);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\n");
    commitAll(repo, "init");
    put(repo, "apps/one.ts", `// peers: ${repo}/apps/two.ts\nconst v = envelope.scores;\n`);
    put(repo, "apps/two.ts", "const v = envelope.data.scores;\nconst w = 1;\n");
    const r = run(repo, []);
    assert.equal(r.err, "", `an absolute in-repo peer changed in the same diff should not warn; got: ${r.err}`);
  });
});

// ── A git read that FAILS is not an empty one ────────────────────────────
// A `git` that errors on one subcommand (FAKE_GIT_FAIL) stands in for a broken
// repo, a missing HEAD, or a bad pathspec. Read as "no output", each would
// report "no changed files" or "no surviving match" — a clean gate over nothing.
describe("a git read that fails is not an empty one", () => {
  const fakegit = path.join(WORK, "fakegit");
  const realgit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  mkdirSync(fakegit, { recursive: true });
  writeFileSync(
    path.join(fakegit, "git"),
    `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated $a failure" >&2; exit 128; fi
done
exec "${realgit}" "$@"
`,
  );
  chmodSync(path.join(fakegit, "git"), 0o755);
  const repo = newRepo("git-fails");
  put(repo, "apps/a.ts", DATETIME);
  commitAll(repo, "init");
  put(repo, "apps/a.ts", `${DATETIME}x\n`);
  const PATH = `${fakegit}:${process.env.PATH ?? ""}`;

  test("a failed git diff is exit 2, named — not 'no changed files'", () => {
    const r = run(repo, [], { PATH, FAKE_GIT_FAIL: "diff" });
    assert.ok(
      r.rc === 2 && r.err.includes("git diff failed"),
      `a failed git diff should be exit 2 naming it; got rc=${r.rc}: ${r.err}`,
    );
  });

  test("a failed sweep grep is exit 2, named — not a clean sweep", () => {
    const r = run(repo, ["--verify-sweep", "z\\.string", "--", "apps"], { PATH, FAKE_GIT_FAIL: "grep" });
    assert.ok(
      r.rc === 2 && r.err.includes("git grep failed"),
      `a failed sweep grep should be exit 2 naming it; got rc=${r.rc}: ${r.err}`,
    );
  });
});

// The harnesses reach every skill script through a symlink (a home skills link
// into the workbench), and an entry guard comparing the invoked path with the
// resolved module path would skip main() there, exiting 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(path.join(WORK, "symlink-"));
  const link = path.join(dir, "find-peers.ts");
  symlinkSync(SCRIPT_UNDER_TEST, link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...["--verify-sweep"]], {
    encoding: "utf8",
    cwd: path.dirname(SCRIPT_UNDER_TEST),
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /--verify-sweep needs a regex/);
});
