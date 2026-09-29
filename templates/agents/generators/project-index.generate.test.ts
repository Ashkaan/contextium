// Boundary tests for the project-index deriver: the parsing-boundary cases of
// the in-memory structure (buildIndexData), the discovery-drop count and the
// compact view /project pastes.
//
// Run: node --test templates/agents/generators/project-index.generate.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCompact,
  buildReadme,
  buildIndexData,
  type ProjectMeta,
  repoRootPath,
  domainEmoji,
  refuseOutWithDrops,
} from "./project-index.generate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function meta(overrides: Partial<ProjectMeta>): ProjectMeta {
  const domain = overrides.domain ?? "ai";
  const dirName = overrides.dirName ?? "2026-05-25_demo";
  // Object.assign rather than a spread: spreading a Partial<ProjectMeta> widens
  // every optional key to `| undefined`, which no longer satisfies ProjectMeta
  // under a strict tsconfig.
  const base: ProjectMeta = {
    project: "demo",
    status: "active",
    priority: "high",
    created: "2026-05-25",
    description: "demo description",
    next: "next step",
    "blocked-on": "waiting on x",
    "monitoring-until": "2026-07-01",
    domain,
    dirName,
    linkPath: `${domain}/${dirName}/README.md`,
    searchText: "",
  };
  return Object.assign(base, overrides);
}

// ── B0: empty projects dir ──────────────────────────────────────────────────
test("B0: empty input → empty arrays, zero counts, no missing sections", () => {
  const d = buildIndexData([]);
  assert.deepEqual(d.active, []);
  assert.deepEqual(d.blocked, []);
  assert.deepEqual(d.monitor, []);
  assert.equal(d.completedCount, 0);
  assert.deepEqual(d.droppedRowCount, { active: 0, blocked: 0, monitor: 0, total: 0 });
  assert.deepEqual(d.missingRequiredSections, []);
});

// ── B1: single active project round-trips ───────────────────────────────────
test("B1: single active project maps to one row with next→lastColumnValue", () => {
  const d = buildIndexData([meta({ status: "active", next: "ship it" })]);
  assert.equal(d.active.length, 1);
  assert.equal(d.blocked.length, 0);
  assert.equal(d.active[0].lastColumnValue, "ship it");
  assert.equal(d.active[0].status, "active");
});

// ── section → lastColumn field mapping ──────────────────────────────────────
test("blocked uses blocked-on, monitor uses monitoring-until", () => {
  const d = buildIndexData([
    meta({ status: "blocked", "blocked-on": "vendor reply" }),
    meta({ status: "monitor", "monitoring-until": "2026-08-01" }),
  ]);
  assert.equal(d.blocked[0].lastColumnValue, "vendor reply");
  assert.equal(d.monitor[0].lastColumnValue, "2026-08-01");
});

// ── completed counting ──────────────────────────────────────────────────────
test("completed projects are counted, not listed", () => {
  const d = buildIndexData([meta({ status: "completed" }), meta({ status: "completed", dirName: "2026-05-26_x" })]);
  assert.equal(d.completedCount, 2);
  assert.equal(d.active.length, 0);
});

// ── B3/B4: rows missing required fields are dropped + counted ────────────────
test("B4: active row with empty description is dropped + counted", () => {
  const d = buildIndexData([meta({ status: "active", description: "" })]);
  assert.equal(d.active.length, 0);
  assert.equal(d.droppedRowCount.active, 1);
  assert.equal(d.droppedRowCount.total, 1);
});

test("B3: active row with empty next (lastColumnValue) is dropped + counted", () => {
  const d = buildIndexData([meta({ status: "active", next: "" })]);
  assert.equal(d.active.length, 0);
  assert.equal(d.droppedRowCount.active, 1);
});

// ── partial drop: some rows valid, some dropped ─────────────────────────────
test("partial drop: valid row kept, broken row counted", () => {
  const d = buildIndexData([
    meta({ project: "good", status: "active", dirName: "2026-05-25_good" }),
    meta({ project: "bad", status: "active", description: "", dirName: "2026-05-26_bad" }),
  ]);
  assert.equal(d.active.length, 1);
  assert.equal(d.active[0].project, "good");
  assert.equal(d.droppedRowCount.active, 1);
});

// ── B5: duplicate slugs kept (distinct linkPath) ────────────────────────────
test("B5: duplicate project name keeps both rows by distinct linkPath", () => {
  const d = buildIndexData([
    meta({ project: "dup", status: "active", dirName: "2026-05-25_dup1" }),
    meta({ project: "dup", status: "active", dirName: "2026-05-26_dup2" }),
  ]);
  assert.equal(d.active.length, 2);
});

// ── sorting: high before medium before low ──────────────────────────────────
test("sorts active by priority (high → medium)", () => {
  const d = buildIndexData([
    meta({ project: "m", priority: "medium", status: "active", dirName: "2026-05-25_m" }),
    meta({ project: "h", priority: "high", status: "active", dirName: "2026-05-26_h" }),
  ]);
  assert.equal(d.active[0].project, "h");
  assert.equal(d.active[1].project, "m");
});

// ── discovery drops ─────────────────────────────────────────────────────────
test("discovery drops reach droppedRowCount.total", () => {
  // A folder with no frontmatter never reaches buildIndexData, so without the
  // count it would be counted nowhere.
  const d = buildIndexData([meta({ status: "active", next: "ship it" })], 3);
  assert.equal(d.droppedRowCount.total, 3);
  assert.equal(d.droppedRowCount.active, 0, "a discovery drop has no status to be attributed to");
  assert.equal(d.active.length, 1, "the rows that DID parse still render");
});

// ── compact view ────────────────────────────────────────────────────────────
test("buildCompact prints (none) for empty sections + Completed line", () => {
  const out = buildCompact(buildIndexData([meta({ status: "completed" })]));
  assert.match(out, /\*\*Active — 0\*\*\n\(none\)/);
  assert.match(out, /\*\*Completed — 1\*\*/);
});

// The compact view is pasted verbatim into the /project reply, so these assert
// the RENDERED markdown, not just that a slug appears somewhere in the string.
test("buildCompact renders Active as a markdown table with a backticked slug", () => {
  const out = buildCompact(buildIndexData([meta({ project: "alpha", status: "active", priority: "high" })]));
  assert.match(out, /\| \| Project \| One-line \|\n\|---\|---\|---\|\n\|🔴\| `alpha` \|/);
});

// The blank line between the heading and the header row is the whole reason the
// index renders in some chat renderers at all: glued to `**Active — N**` they
// are one paragraph, and a table that cannot interrupt a paragraph never starts.
test("buildCompact puts a blank line between the Active heading and the table", () => {
  const out = buildCompact(buildIndexData([meta({ project: "alpha", status: "active" })]));
  assert.match(out, /\*\*Active — 1\*\*\n\n\| \| Project \|/);
});

test("buildCompact prints a long description whole — the cell wraps, so nothing is clipped", () => {
  const long =
    "Rebuild the checkout flow so a declined card retries once with the fallback processor, a line that runs well past eighty characters and keeps going";
  const out = buildCompact(buildIndexData([meta({ project: "alpha", status: "active", description: long })]));
  assert.match(out, new RegExp(`\\|🔴\\| \`alpha\` \\| ${long} \\|`));
  assert.doesNotMatch(out, /…/);
});

test("buildCompact collapses a multi-line description so it cannot break the row", () => {
  const out = buildCompact(
    buildIndexData([meta({ project: "alpha", status: "active", description: "first line\n  second line" })]),
  );
  assert.match(out, /\|🔴\| `alpha` \| first line second line \|/);
});

test("buildCompact renders Blocked + Monitoring as readable tables", () => {
  const out = buildCompact(
    buildIndexData([
      meta({ project: "b-hi", status: "blocked", priority: "high" }),
      meta({ project: "b-lo", status: "blocked", priority: "low" }),
      meta({ project: "m-one", status: "monitor", priority: "medium" }),
    ]),
  );
  assert.match(out, /\*\*Blocked — 2\*\*\n\n\| \| Project \| One-line \|/);
  assert.match(out, /\|🔴\| `b-hi` \| demo description \|/);
  assert.match(out, /\|⚪\| `b-lo` \| demo description \|/);
  assert.match(out, /\*\*Monitoring — 1\*\*\n\n\| \| Project \| One-line \|/);
  assert.match(out, /\|🟡\| `m-one` \| demo description \|/);
});

test("buildCompact escapes a pipe in a description so the table row survives", () => {
  const out = buildCompact(buildIndexData([meta({ project: "alpha", status: "active", description: "a | b" })]));
  assert.match(out, /`alpha` \| a \\\| b \|/);
});

test("the domain map follows knowledge/README.md § Domains: every project domain there has an emoji", () => {
  const readme = readFileSync(join(repoRootPath(), "knowledge", "README.md"), "utf-8");
  const domains = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).filter((d) => d !== "people");
  assert.ok(domains.length > 0, "knowledge/README.md § Domains lists no domain");
  for (const d of domains) assert.notEqual(domainEmoji(d), "❓", `no emoji for domain ${d}`);
  assert.equal(domainEmoji("no-such-domain"), "❓");
});

test("the projects root is the checkout that holds this script", () => {
  const here = dirname(new URL(import.meta.url).pathname);
  const top = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  assert.equal(realpathSync(repoRootPath()), realpathSync(top));
  assert.ok(existsSync(join(repoRootPath(), ".git")));
});

// ── --out refuses an index built from a discovery that lost records ──
// A bad read must not replace the last good index file with an incomplete one.
test("--out <file> is refused when discovery dropped a project", () => {
  const why = refuseOutWithDrops("/tmp/index.md", 2);
  assert.ok(why, "a write with drops must be refused");
  assert.match(why, /2 project/);
});

test("--out <file> is allowed when nothing was dropped", () => {
  assert.equal(refuseOutWithDrops("/tmp/index.md", 0), null);
});

test("--out <file> is allowed for an empty discovery — a new workbench has no projects", () => {
  assert.equal(refuseOutWithDrops("/tmp/index.md", 0), null);
});

test("stdout (the default, or --out -) is never refused — it replaces nothing", () => {
  assert.equal(refuseOutWithDrops("-", 3), null);
});

// ── table cells ──
// A frontmatter value is one cell: a decoded line break would end the row and
// a `|` would end the cell, in the index and in the compact view alike.
test("buildReadme: a description or next: with a line break and a pipe stays one cell", () => {
  const md = buildReadme([meta({ description: "two\nlines | piped", next: "do x\n| then y" })]);
  const row = md.split("\n").find((l) => l.includes("two lines"));
  assert.ok(row, "the row renders on one line");
  assert.ok(row.includes("two lines \\| piped"), row);
  assert.ok(row.includes("do x \\| then y"), row);
});

test("buildCompact: a description with a line break and a pipe stays one cell", () => {
  const out = buildCompact(buildIndexData([meta({ description: "two\nlines | piped" })]));
  assert.ok(out.includes("two lines \\| piped"), out);
});
