// project-index.generate.test.ts — the project-index deriver, pinned through
// its own command line.
//
// Run: node --test --experimental-strip-types templates/agents/generators/project-index.generate.test.ts
//
// The program is SPAWNED and never imported: every assertion reads the index
// on stdout (default), the `--compact` view, the file `--out` writes, the
// warnings and refusals on stderr, and the exit code. What it pins:
//   - the row boundaries: an empty tree, one row per section with the right
//     last column, completed counted and not listed, a row with no
//     description or no next step dropped and COUNTED, duplicates kept,
//     high before medium
//   - the --out guard: a tree where a project could not be read refuses the
//     write and leaves the last good file, and an empty tree (a new
//     workbench) is valid
//   - the compact view's rendered markdown: the blank line under each heading
//     that T3 needs, a whole description with no clip, whitespace collapsed
//     and pipes escaped so a row survives, and a first line naming any
//     project that could not be read
//   - the domain legend follows knowledge/README.md § Domains, and the
//     projects root is the script's own checkout
//
// The program finds `projects/` at the top of the git checkout its OWN file is
// in, so each fixture is a scratch git repo with a copy of the generator and
// its sibling modules at the same depth, and a `projects/` tree written to
// order.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const SCRIPT = join(HERE, "project-index.generate.ts");
const GENERATOR_REL = ".agents/generators";
const SIBLINGS = ["project-index.generate.ts", "parse_frontmatter.ts", "table_cell.ts", "validate_outcome.ts"];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Project {
  domain?: string;
  dir?: string;
  /** Frontmatter as key/value pairs; `null` writes a README with no frontmatter. */
  fm: Record<string, string> | null;
}

/** A project README: full frontmatter by default, any key overridable, a
 *  key set to "" written as an empty value (which the parser reads as absent). */
function readme(fm: Record<string, string>): string {
  const base: Record<string, string> = {
    project: "demo",
    status: "active",
    priority: "high",
    created: "2026-05-25",
    description: "demo description",
    next: "next step",
    "blocked-on": "waiting on x",
    "monitoring-until": "2026-07-01",
  };
  const merged = { ...base, ...fm };
  const lines = Object.entries(merged).map(([k, v]) => (v === "" ? `${k}:` : `${k}: ${v}`));
  return `---\n${lines.join("\n")}\n---\n\n# ${merged.project}\n`;
}

/** A scratch checkout holding a copy of the generator and the projects given. */
function fixture(projects: Project[]): { root: string; env: NodeJS.ProcessEnv; script: string } {
  const root = mkdtempSync(join(tmpdir(), "project-index-test-"));
  const init = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  const gen = join(root, GENERATOR_REL);
  mkdirSync(gen, { recursive: true });
  for (const f of SIBLINGS) copyFileSync(join(HERE, f), join(gen, f));

  mkdirSync(join(root, "projects"));
  projects.forEach((p, i) => {
    const domain = p.domain ?? "ai";
    const dir = p.dir ?? `2026-05-${String(25 + i).padStart(2, "0")}_demo${i === 0 ? "" : i}`;
    const body = p.fm === null ? "# no frontmatter here\n" : readme(p.fm);
    mkdirSync(join(root, "projects", domain, dir), { recursive: true });
    writeFileSync(join(root, "projects", domain, dir, "README.md"), body);
  });

  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  return { root, env, script: join(gen, "project-index.generate.ts") };
}

function run(fx: { env: NodeJS.ProcessEnv; script: string }, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", fx.script, ...args], {
    encoding: "utf8",
    env: fx.env,
    timeout: 60000,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The `--compact` view. A tree where a project could not be read or an
 *  active row did not render makes the view exit non-zero (it still prints,
 *  naming them on its first line); `dropped` says which this call expects. */
function compact(projects: Project[], dropped = false): Run {
  const fx = fixture(projects);
  try {
    const r = run(fx, "--compact");
    if (dropped) assert.notEqual(r.code, 0, "a view with a dropped project exits non-zero");
    else assert.equal(r.code, 0, r.stderr);
    return r;
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

// ── B0: empty projects dir ──────────────────────────────────────────────────
test("B0: an empty tree is a new workbench — an empty view, and --out still writes", () => {
  const fx = fixture([]);
  try {
    const r = run(fx, "--compact");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\*\*Active — 0\*\*\n\(none\)/m);
    assert.doesNotMatch(r.stdout, /could not be read/);
    const out = join(fx.root, "index.md");
    const w = run(fx, "--out", out);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /^Wrote the project index to .*index\.md: 0 active, 0 completed$/m);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── B1: single active project round-trips ───────────────────────────────────
test("B1: a single active project is one row whose last column is `next`", () => {
  const fx = fixture([{ fm: { next: "ship it" } }]);
  try {
    const r = run(fx);
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /^\| 🔴 high \| 🤖 \| \[demo\]\(ai\/2026-05-25_demo\/README\.md\) \| demo description \| ship it \|$/m,
    );
    assert.match(r.stdout, /### Blocked[^\n]*\n\n\*None\*/);
    assert.match(r.stdout, /^\*\*Completed projects:\*\* 0$/m);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── section → lastColumn field mapping ──────────────────────────────────────
test("blocked uses blocked-on, monitor uses monitoring-until", () => {
  const fx = fixture([
    { fm: { status: "blocked", "blocked-on": "vendor reply" } },
    { fm: { status: "monitor", "monitoring-until": "2026-08-01" } },
  ]);
  try {
    const r = run(fx);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[demo\]\(ai\/2026-05-25_demo\/README\.md\) \| demo description \| vendor reply \|$/m);
    assert.match(r.stdout, /\[demo\]\(ai\/2026-05-26_demo1\/README\.md\) \| demo description \| 2026-08-01 \|$/m);
    assert.match(r.stdout, /### Active[^\n]*\n\n\*None\*/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── completed counting ──────────────────────────────────────────────────────
test("completed projects are counted, not listed", () => {
  const r = compact([{ fm: { status: "completed" } }, { fm: { status: "completed" } }]);
  assert.match(r.stdout, /^\*\*Completed — 2\*\*$/m);
  assert.match(r.stdout, /^\*\*Active — 0\*\*\n\(none\)/m);
  assert.doesNotMatch(r.stdout, /`demo`/);
});

// ── B3/B4: rows missing required fields are dropped + counted ────────────────
test("B4: an active row with no description is dropped and counted", () => {
  const view = compact([{ fm: { description: "" } }], true);
  assert.match(view.stdout, /^\*\*Active — 0\*\*\n\(none\)/m);
  assert.match(view.stderr, /ai\/2026-05-25_demo: missing description/);
});

test("B3: an active row with no next step is dropped and counted", () => {
  const view = compact([{ fm: { next: "" } }], true);
  assert.match(view.stdout, /^\*\*Active — 0\*\*\n\(none\)/m);
});

// ── partial drop: some rows valid, some dropped ─────────────────────────────
test("partial drop: the valid row is kept and counted in the view; --out is refused, stdout is not", () => {
  const rows: Project[] = [{ fm: { project: "good" } }, { dir: "2026-05-26_bad", fm: null }];
  const view = compact(rows, true);
  assert.match(view.stdout, /^\*\*Active — 1\*\*/m);
  assert.match(view.stdout, /\| `good` \|/);
  assert.doesNotMatch(view.stdout, /`bad`/);
  assert.match(view.stderr, /2026-05-26_bad: no frontmatter/);

  // A read that lost a record must not replace the last good file; stdout
  // replaces nothing, so it is never refused.
  const fx = fixture(rows);
  try {
    const out = join(fx.root, "index.md");
    writeFileSync(out, "last good\n");
    const w = run(fx, "--out", out);
    assert.notEqual(w.code, 0);
    assert.match(
      w.stderr,
      /^--out .*index\.md: refused, 1 project\(s\) could not be read .*; the file was left as it was$/m,
    );
    assert.equal(readFileSync(out, "utf8"), "last good\n");

    const so = run(fx, "--out", "-");
    assert.equal(so.code, 0, so.stderr);
    assert.match(so.stdout, /\[good\]\(/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── B5: duplicate slugs kept (distinct linkPath) ────────────────────────────
test("B5: a duplicate project name keeps both rows, told apart by their folders", () => {
  const r = compact([{ fm: { project: "dup" } }, { fm: { project: "dup" } }]);
  assert.match(r.stdout, /^\*\*Active — 2\*\*/m);
  assert.equal(r.stdout.match(/\| `dup` \|/g)?.length, 2);
});

// ── sorting: high before medium before low ──────────────────────────────────
test("sorts active by priority (high → medium)", () => {
  const r = compact([{ fm: { project: "m", priority: "medium" } }, { fm: { project: "h", priority: "high" } }]);
  assert.match(r.stdout, /\|🔴\| `h` \| demo description \|\n\|🟡\| `m` \| demo description \|/);
});

// ── discovery drops ────────────────────────────────────────────────────────
test("a folder that never became a row is warned about and counted", () => {
  // A folder with no frontmatter, one with no status and one with an unknown
  // status never reach the row builder; counted nowhere, they would vanish
  // from the view without a word.
  const broken: Project[] = [
    { dir: "2026-05-01_no-frontmatter", fm: null },
    { dir: "2026-05-02_no-status", fm: { status: "" } },
    { dir: "2026-05-03_odd-status", fm: { status: "someday" } },
  ];
  const view = compact([{ fm: { next: "ship it" } }, ...broken], true);
  assert.match(view.stdout, /^\*\*Active — 1\*\*/m, "the row that DID parse still renders");
  assert.match(view.stderr, /^Warnings \(3\):$/m);
  assert.match(view.stderr, /2026-05-01_no-frontmatter: no frontmatter/);
  assert.match(view.stderr, /2026-05-02_no-status: missing status/);
  assert.match(view.stderr, /2026-05-03_odd-status: unknown status 'someday'/);
  assert.match(view.stdout.split("\n")[0] ?? "", /3 project\(s\) could not be read/);
});

// ── compact view ────────────────────────────────────────────────────────────
// The compact view is pasted verbatim into the /project reply, so these assert
// the RENDERED markdown, not just that a slug appears somewhere in the string.

test("--compact prints (none) for empty sections and a Completed line", () => {
  const r = compact([{ fm: { status: "completed" } }]);
  assert.match(r.stdout, /\*\*Active — 0\*\*\n\(none\)/);
  assert.match(r.stdout, /\*\*Completed — 1\*\*/);
});

test("--compact renders Active as a markdown table with a backticked slug", () => {
  const r = compact([{ fm: { project: "alpha", priority: "high" } }]);
  assert.match(r.stdout, /\| \| Project \| One-line \|\n\|---\|---\|---\|\n\|🔴\| `alpha` \|/);
});

// The blank line between the heading and the header row is the whole reason the
// index renders on T3 at all: glued to `**Active — N**` they are one paragraph,
// and a table that cannot interrupt a paragraph never starts.
test("--compact puts a blank line between the Active heading and the table", () => {
  const r = compact([{ fm: { project: "alpha" } }]);
  assert.match(r.stdout, /\*\*Active — 1\*\*\n\n\| \| Project \|/);
});

test("--compact prints a long description whole — the cell wraps, so nothing is clipped", () => {
  const long =
    "A description that runs well past the 80 characters this used to be cut at, and keeps going for a good while after that";
  const r = compact([{ fm: { project: "alpha", description: long } }]);
  assert.match(r.stdout, new RegExp(`\\|🔴\\| \`alpha\` \\| ${long} \\|`));
  assert.doesNotMatch(r.stdout, /…/);
});

test("--compact collapses a run of whitespace in a description so it cannot break the row", () => {
  const r = compact([{ fm: { project: "alpha", description: "first line\t\t   second line" } }]);
  assert.match(r.stdout, /\|🔴\| `alpha` \| first line second line \|/);
});

test("--compact renders Blocked + Monitoring as readable tables", () => {
  const r = compact([
    { fm: { project: "b-hi", status: "blocked", priority: "high" } },
    { fm: { project: "b-lo", status: "blocked", priority: "low" } },
    { fm: { project: "m-one", status: "monitor", priority: "medium" } },
  ]);
  assert.match(r.stdout, /\*\*Blocked — 2\*\*\n\n\| \| Project \| One-line \|/);
  assert.match(r.stdout, /\|🔴\| `b-hi` \| demo description \|/);
  assert.match(r.stdout, /\|⚪\| `b-lo` \| demo description \|/);
  assert.match(r.stdout, /\*\*Monitoring — 1\*\*\n\n\| \| Project \| One-line \|/);
  assert.match(r.stdout, /\|🟡\| `m-one` \| demo description \|/);
});

test("--compact escapes a pipe in a description so the table row survives", () => {
  const r = compact([{ fm: { project: "alpha", description: "a | b" } }]);
  assert.match(r.stdout, /`alpha` \| a \\\| b \|/);
});

// ── domains and roots ───────────────────────────────────────────────────────

test("the domain map follows knowledge/README.md § Domains: every project domain there has an emoji", () => {
  const legend = readFileSync(join(REPO, "knowledge", "README.md"), "utf8");
  const domains = [...legend.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).filter((d) => d !== "people");
  assert.ok(domains.length > 0, "knowledge/README.md § Domains lists no domain");
  const fx = fixture([
    ...domains.map((d) => ({ domain: d, fm: { project: `p-${d}` } })),
    { domain: "no-such", fm: { project: "x" } },
  ]);
  try {
    const r = run(fx);
    assert.equal(r.code, 0, r.stderr);
    // The legend lists the domains; a project outside them renders the
    // unknown glyph in its row rather than being dropped.
    for (const d of domains) {
      assert.match(
        r.stdout,
        new RegExp(`^\\| 🔴 high \\| [^❓|]+ \\| \\[p-${d}\\]\\(${d}/`, "m"),
        `no emoji for domain ${d}`,
      );
    }
    assert.match(r.stdout, /^\| 🔴 high \| ❓ \| \[x\]\(no-such\//m);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--out writes the index to a file and says what it wrote; --out with no path is refused", () => {
  const fx = fixture([{ fm: { project: "alpha" } }, { fm: { status: "completed" } }]);
  try {
    const out = join(fx.root, "index.md");
    const r = run(fx, "--out", out);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(out, "utf8"), /\[alpha\]\(ai\/2026-05-25_demo\/README\.md\)/);
    assert.match(r.stdout, /^Wrote the project index to .*index\.md: 1 active, 1 completed$/m);
    assert.doesNotMatch(r.stdout, /# Active Project Status Overview/, "the index went to the file, not stdout");

    const bare = run(fx, "--out");
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /--out flag requires a path/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("the projects root is the script's own checkout", () => {
  // Every fixture above proves it for a copy two levels below a scratch root;
  // this proves it for the file where it lives, against this checkout's own
  // `projects/` tree, and touches nothing.
  assert.ok(existsSync(join(REPO, "projects")), "this checkout carries a projects/ tree");
  const fx = fixture([]);
  try {
    const r = run({ env: fx.env, script: SCRIPT }, "--compact");
    assert.equal(r.code, 0, r.stderr);
    // This checkout may hold no project yet, so the view is its headings.
    assert.match(r.stdout, /^\*\*Active — \d+\*\*$/m);
    assert.match(r.stdout, /^\*\*Completed — \d+\*\*$/m);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── table cells ────────────────────────────────────────────────────────────
// A frontmatter value is one cell: a decoded line break would end the row and
// a `|` would end the cell, in the index and in the compact view alike.
test("a description or next: with a line break and a pipe stays one cell in the index and the compact view", () => {
  const fx = fixture([{ fm: { description: '"two\\nlines | piped"', next: '"do x\\n| then y"' } }]);
  try {
    const out = join(fx.root, "index.md");
    const w = run(fx, "--out", out);
    assert.equal(w.code, 0, w.stderr);
    const row = readFileSync(out, "utf8")
      .split("\n")
      .find((l) => l.includes("two lines"));
    assert.ok(row, "the row renders on one line");
    assert.ok(row.includes("two lines \\| piped"), row);
    assert.ok(row.includes("do x \\| then y"), row);

    const c = run(fx, "--compact");
    assert.equal(c.code, 0, c.stderr);
    assert.ok(c.stdout.includes("two lines \\| piped"), c.stdout);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// A project that could not be read is not silently absent from the /project
// view: the view says so on its first line, and the run exits non-zero.
test("--compact names the dropped projects on its first line and exits non-zero", () => {
  const r = compact([{ fm: {} }, { dir: "2026-05-26_broken", fm: null }], true);
  const first = r.stdout.split("\n")[0] ?? "";
  assert.match(first, /1 project\(s\) could not be read/);
  // …and names which one and why, on the line /project shows (not only stderr).
  assert.match(first, /2026-05-26_broken/);
  assert.match(first, /no frontmatter/);
  assert.match(r.stdout, /`demo`/);
});

test("--compact still names an unrendered row when two projects share a name", () => {
  const r = compact([{ fm: {} }, { dir: "2026-05-26_demo", fm: { next: "" } }], true);
  const first = r.stdout.split("\n")[0] ?? "";
  assert.match(first, /could not be read/);
  // …by its folder, so the README to fix is unambiguous.
  assert.ok(first.includes("ai/2026-05-26_demo/README.md"), r.stdout);
});

test("--compact names an active project whose row does not render, and exits non-zero", () => {
  const r = compact([{ fm: {} }, { dir: "2026-05-27_quiet", fm: { project: "quiet", next: "" } }], true);
  assert.match(r.stdout.split("\n")[0] ?? "", /could not be read.*quiet/);
});

test("--compact with nothing dropped exits 0 and carries no such line", () => {
  const r = compact([{ fm: {} }]);
  assert.doesNotMatch(r.stdout, /could not be read/);
});
