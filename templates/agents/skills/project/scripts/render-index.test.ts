// render-index.test.ts — peer of render-index.ts.
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/render-index.test.ts
//
// The generator is replaced by a stub that prints a fixed compact index, so the
// suite checks the composition — the Completed line held back to the end, the
// lapsed block built from check-staleness.ts's rows, the closing prompt — and
// not the generator's own output, which its own tests cover.
// CONTEXT_CODE_REPO points render-index.ts at the fixture repo and its stub;
// CONTEXT_WRITE_ROOT points check-staleness.ts at the same fixture's projects.
// The script is run as a subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "render-index.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "render-index-test.")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const baseEnv: Record<string, string | undefined> = { ...process.env };
// Node 22.6 prints an ExperimentalWarning for type stripping on stderr, which
// cases that read stderr would otherwise see.
baseEnv.NODE_NO_WARNINGS = "1";
delete baseEnv.CLAUDE_SESSION_ID;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
delete baseEnv.CONTEXT_CODE_REPO;
delete baseEnv.CONTEXT_WRITE_ROOT;

const pad = (n: number): string => String(n).padStart(2, "0");
/** `date -d "<n> days ago" +%Y-%m-%d`, in the host's zone as the bash suite had it. */
function ago(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const PAST10 = ago(10);
const PAST3 = ago(3);

/** stub <js string expression> → the fixture's generator prints it */
function stub(body: string): void {
  mkdirSync(join(tmp, ".agents/generators"), { recursive: true });
  writeFileSync(
    join(tmp, ".agents/generators/project-index.generate.ts"),
    `process.stdout.write(${body});\n`,
  );
}
const INDEX =
  '"**Active — 1**\\n\\n| | slug | one-line |\\n|-|-|-|\\n|●| `checkout-flow` | Retry failed payments |\\n\\n**Completed — 4**\\n"';
function mon(slug: string, until: string): void {
  const d = join(tmp, "projects/web", `2026-01-01_${slug}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "README.md"),
    until ? `---\nstatus: monitor\nmonitoring-until: ${until}\n---\n` : "---\nstatus: monitor\n---\n",
  );
}

interface Run {
  out: string;
  err: string;
  both: string;
  rc: number | null;
}
function exec(script: string, env: Record<string, string>): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  const strip = (s: string): string => s.replace(/\n+$/, "");
  return { out: strip(r.stdout), err: strip(r.stderr), both: strip(`${r.stdout}${r.stderr}`), rc: r.status };
}
const both = { CONTEXT_CODE_REPO: tmp, CONTEXT_WRITE_ROOT: tmp };
const run = (): Run => exec(SUT, both);

// ── Nothing lapsed ────────────────────────────────────────────────────────
test("no lapsed windows: index, Completed, prompt — no Lapsed block", () => {
  stub(INDEX);
  mkdirSync(join(tmp, "projects"), { recursive: true });
  mkdirSync(join(tmp, "journal"), { recursive: true });
  assert.equal(
    run().both,
    "**Active — 1**\n\n| | slug | one-line |\n|-|-|-|\n|●| `checkout-flow` | Retry failed payments |\n\n**Completed — 4**\n\nWhich one to start? Type `/project [slug]`.",
  );
});

// ── Lapsed windows ────────────────────────────────────────────────────────
test("lapsed windows", () => {
  mon("sync-engine", PAST3);
  mon("export-cap", PAST10);
  mon("no-date", "");
  const out = run().both;
  const lines = out.split("\n");
  const from = lines.findIndex((l) => l.startsWith("**Lapsed"));
  assert.equal(
    from === -1 ? "" : lines.slice(from).join("\n"),
    `**Lapsed — 3**\n- web/export-cap — ended ${PAST10} (10 days ago)\n- web/sync-engine — ended ${PAST3} (3 days ago)\n- web/no-date — monitor with no monitoring-until date\n\n\`/project <slug>\` to close or extend.\n\n**Completed — 4**\n\nWhich one to start? Type \`/project [slug]\`.`,
    "lapsed block sits between the index and Completed, oldest lapse first, undated last",
  );
  assert.equal(
    lines[4],
    "|●| `checkout-flow` | Retry failed payments |",
    "the index above the lapsed block is untouched",
  );
  assert.equal(run().rc, 0, "exit 0 on a full render");
});

// ── Failures are loud ─────────────────────────────────────────────────────
test("a generator whose last line is not Completed is refused", () => {
  stub('"**Active — 1**\\n**Monitoring — 0**\\n"');
  const r = run();
  assert.equal(
    `${r.both.split("\n").join("|")}|rc=${r.rc}`,
    "render-index: expected the generator's last line to be the Completed heading, got: **Monitoring — 0**|rc=1",
  );
});

test("a failing generator's exit status is passed through", () => {
  stub('"x\\n"); process.exit(7');
  assert.equal(run().rc, 7);
});

// A failure whose output is not a partial render shows nothing on stdout.
test("a failure that is not a partial render prints no index", () => {
  stub('"Error: something broke\\n"); process.exit(3');
  assert.equal(run().out, "");
});

// A generator that fails after rendering (an unreadable project) still shows
// what it rendered, its warning first, on stdout.
test("a partial render is still shown, warning first", () => {
  stub(
    '"**1 project(s) could not be read and are missing below: web/broken: no frontmatter.**\\n\\n**Active — 1**\\n"); process.exit(1',
  );
  assert.equal(
    run().out.split("\n")[0],
    "**1 project(s) could not be read and are missing below: web/broken: no frontmatter.**",
  );
});

// A copy of the script beside a check-staleness.ts that fails: the scan reads
// the same root as the index, so its failure is simulated at the scan itself.
// The copy sits three folders deep with cli-exit beside it, where its relative
// import expects it.
test("a failing staleness scan is not rendered as no lapsed projects", () => {
  stub(INDEX);
  const copy = join(tmp, "copy/skills/project/scripts");
  mkdirSync(copy, { recursive: true });
  mkdirSync(join(tmp, "copy/packages/cli-exit"), { recursive: true });
  copyFileSync(SUT, join(copy, "render-index.ts"));
  copyFileSync(join(HERE, "../../../packages/cli-exit/cli-exit.ts"), join(tmp, "copy/packages/cli-exit/cli-exit.ts"));
  writeFileSync(join(copy, "check-staleness.ts"), "process.exit(3);\n");
  const r = exec(join(copy, "render-index.ts"), { CONTEXT_CODE_REPO: tmp });
  assert.equal(
    r.err.split("\n").at(-1),
    "render-index: check-staleness.ts --expired-only failed; not rendering a lapsed list from nothing",
  );
});

// ── --json ────────────────────────────────────────────────────────────────
// The generator's JSON from the same fresh view, and nothing else: no lapsed
// block, no prompt. The stub echoes its own arguments so the test sees the flag
// and the view it was handed.
test("--json passes the generator's JSON through with no lapsed block or prompt", () => {
  stub('JSON.stringify({ args: process.argv.slice(2) }) + "\\n"');
  mon("lapsed-one", PAST10);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, "--json"], {
    encoding: "utf8",
    env: { ...baseEnv, ...both },
  });
  assert.equal(r.status, 0, r.stderr);
  const args = (JSON.parse(r.stdout) as { args: string[] }).args;
  assert.deepEqual(args.slice(0, 2), ["--json", "--projects-dir"]);
  assert.match(args[2], /\/projects$/);
  assert.doesNotMatch(r.stdout, /Lapsed|Which one/);
});

test("--json: a failing generator prints nothing and passes its status through", () => {
  stub('"{\\"partial\\":true}\\n"); process.exit(5');
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, "--json"], {
    encoding: "utf8",
    env: { ...baseEnv, ...both },
  });
  assert.equal(r.status, 5);
  assert.equal(r.stdout, "");
});

test("a missing generator names where it looked", () => {
  rmSync(join(tmp, ".agents"), { recursive: true, force: true });
  const r = run();
  const rc = exec(SUT, { CONTEXT_CODE_REPO: tmp }).rc;
  assert.equal(
    `${r.both.split("\n").join("|")}|rc=${rc}`,
    `render-index: no project-index generator at ${tmp}/.agents/generators/project-index.generate.ts (set CONTEXT_CODE_REPO)|rc=1`,
  );
});

// ── One checkout for both halves ──────────────────────────────────────────
// The index and the lapsed scan read the SAME tree: the session's write root.
// With only CONTEXT_WRITE_ROOT set, the generator that runs is that root's, not
// the one beside this script (which, reached through a home link, is another
// checkout).
test("one checkout for both halves", () => {
  stub('"**Active — 0**\\n\\n**Completed — 9**\\n"');
  assert.equal(
    exec(SUT, { CONTEXT_WRITE_ROOT: tmp })
      .out.split("\n")
      .filter((l) => l.includes("**Completed"))
      .join("\n"),
    "**Completed — 9**",
    "the generator runs from the write root, not the script's checkout",
  );
  rmSync(join(tmp, ".agents"), { recursive: true, force: true });
  assert.equal(
    exec(SUT, { CONTEXT_WRITE_ROOT: tmp }).err.split("\n")[0],
    `render-index: no project-index generator at ${tmp}/.agents/generators/project-index.generate.ts (set CONTEXT_CODE_REPO)`,
    "a write root with no generator is named, not bypassed",
  );
});

// ── Read from origin/main, not from a stale worktree ──────────────────────
// A thread's worktree is cut when the thread opens; the index must show main as
// it is now, with only the thread's own unlanded README edits laid over it. The
// fixture is a bare "origin", a "seed" clone that lands on it, and a "wt" clone
// cut before those landings. The stub generator lists `<folder> <status>` for
// every README under --projects-dir, so the assertions read which copy it saw.
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...baseEnv, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const LISTING_STUB = `import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[process.argv.indexOf("--projects-dir") + 1];
const rows = [];
for (const d of readdirSync(dir).sort()) for (const p of readdirSync(dir + "/" + d).sort()) {
  rows.push(p + " " + /^status: (.*)$/m.exec(readFileSync(dir + "/" + d + "/" + p + "/README.md", "utf8"))[1]);
}
process.stdout.write(rows.join("\\n") + "\\n\\n**Completed — 0**\\n");
`;
function readmeAt(root: string, slug: string, body: string): void {
  const d = join(root, "projects/web", `2026-01-01_${slug}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "README.md"), body);
}
function gitFixture(): { origin: string; seed: string; wt: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "render-index-git.")));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const wt = join(root, "wt");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  mkdirSync(join(seed, ".agents/generators"), { recursive: true });
  writeFileSync(join(seed, ".agents/generators/project-index.generate.ts"), LISTING_STUB);
  for (const s of ["landed", "mine", "gone"]) readmeAt(seed, s, "---\nstatus: active\n---\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, wt);
  return { origin, seed, wt };
}
const listing = (r: Run): string =>
  r.out
    .split("\n")
    .filter((l) => l.startsWith("2026-"))
    .join("|");

test("a status landed on main after the worktree was cut is what the index shows", () => {
  const fx = gitFixture();
  readmeAt(fx.seed, "landed", "---\nstatus: blocked\n---\n");
  readmeAt(fx.seed, "new-on-main", "---\nstatus: active\n---\n");
  git(fx.seed, "commit", "-q", "-am", "block it");
  git(fx.seed, "add", "-A");
  git(fx.seed, "commit", "-q", "-m", "add one");
  git(fx.seed, "push", "-q", "origin", "main");
  const r = exec(SUT, { CONTEXT_CODE_REPO: fx.wt });
  assert.equal(r.rc, 0, r.err);
  assert.equal(
    listing(r),
    "2026-01-01_gone active|2026-01-01_landed blocked|2026-01-01_mine active|2026-01-01_new-on-main active",
    "main's newer README wins over the worktree's stale copy, and main's new project is listed",
  );
});

test("the worktree's own edits — committed, uncommitted, added, deleted — win over main", () => {
  const fx = gitFixture();
  readmeAt(fx.seed, "mine", "---\nstatus: completed\n---\n");
  git(fx.seed, "commit", "-q", "-am", "main moves mine too");
  git(fx.seed, "push", "-q", "origin", "main");
  readmeAt(fx.wt, "mine", "---\nstatus: monitor\n---\n");
  readmeAt(fx.wt, "drafted", "---\nstatus: active\n---\n");
  rmSync(join(fx.wt, "projects/web/2026-01-01_gone"), { recursive: true });
  readmeAt(fx.wt, "landed", "---\nstatus: blocked\n---\n");
  git(fx.wt, "commit", "-q", "-am", "unlanded branch commit");
  readmeAt(fx.wt, "mine", "---\nstatus: monitor\n---\n");
  const r = exec(SUT, { CONTEXT_CODE_REPO: fx.wt });
  assert.equal(r.rc, 0, r.err);
  assert.equal(
    listing(r),
    "2026-01-01_drafted active|2026-01-01_landed blocked|2026-01-01_mine monitor",
    "the thread's own edits are newer than main for this thread",
  );
});

// A folder git would C-quote (`"projects/web/2026-01-01_caf\303\251/README.md"`)
// is laid over main as it is on disk: quoted, the edit read as missing, so
// main's copy won and an added project was not listed at all.
test("the worktree's edits under a folder with an accent win over main", () => {
  const fx = gitFixture();
  readmeAt(fx.seed, "café", "---\nstatus: active\n---\n");
  git(fx.seed, "add", "-A");
  git(fx.seed, "commit", "-q", "-m", "add café");
  git(fx.seed, "push", "-q", "origin", "main");
  git(fx.wt, "pull", "-q", "origin", "main");
  readmeAt(fx.wt, "café", "---\nstatus: monitor\n---\n");
  readmeAt(fx.wt, "thé", "---\nstatus: active\n---\n");
  const r = exec(SUT, { CONTEXT_CODE_REPO: fx.wt });
  assert.equal(r.rc, 0, r.err);
  assert.equal(
    listing(r),
    "2026-01-01_café monitor|2026-01-01_gone active|2026-01-01_landed active|2026-01-01_mine active|2026-01-01_thé active",
    "the worktree's café edit and its added thé project are both in the index",
  );
});

test("a lapsed window landed on main reaches the Lapsed block", () => {
  const fx = gitFixture();
  readmeAt(fx.seed, "watched", `---\nstatus: monitor\nmonitoring-until: ${PAST10}\n---\n`);
  git(fx.seed, "add", "-A");
  git(fx.seed, "commit", "-q", "-m", "watch");
  git(fx.seed, "push", "-q", "origin", "main");
  const r = exec(SUT, { CONTEXT_CODE_REPO: fx.wt });
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, new RegExp(`^- web/watched — ended ${PAST10} \\(10 days ago\\)$`, "m"));
});

test("a fetch that fails renders the last fetched main and says so", () => {
  const fx = gitFixture();
  readmeAt(fx.seed, "landed", "---\nstatus: blocked\n---\n");
  git(fx.seed, "commit", "-q", "-am", "block it");
  git(fx.seed, "push", "-q", "origin", "main");
  git(fx.wt, "remote", "set-url", "origin", join(fx.origin, "missing"));
  const r = exec(SUT, { CONTEXT_CODE_REPO: fx.wt });
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.err, "render-index: could not fetch origin/main; rendering from the last fetched copy");
  assert.match(listing(r), /2026-01-01_landed active/, "the unfetched landing is not invented");
});
