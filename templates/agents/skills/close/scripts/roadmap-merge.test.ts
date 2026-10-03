// roadmap-merge.test.ts — peer of roadmap-merge.ts: every rule of the row-by-row
// merge, and every case that must still conflict.
//
// Each case writes a base, an ours and a theirs, runs the driver the way git
// does (result into ours), and checks the exit status and the merged table.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/roadmap-merge.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "roadmap-merge.ts");
const TMP = mkdtempSync(join(tmpdir(), "roadmap-merge-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
// The worktree top git runs a driver from: projects/x has a table beside its
// README, projects/legacy has none.
const TOP = join(TMP, "top");
mkdirSync(join(TOP, "projects/x"), { recursive: true });
mkdirSync(join(TOP, "projects/legacy"), { recursive: true });
writeFileSync(join(TOP, "projects/x/ROADMAP.md"), "# Roadmap: x\n");

const HDR = `| ID | Sub-feature | Depends on | Status | Sub-spec |
|----|-------------|------------|--------|----------|`;
/** A roadmap with prose around the table. */
function table(name: string, ...rows: string[]): void {
  writeFileSync(
    join(TMP, name),
    `# Roadmap: demo\n\nIntro prose.\n\n${HDR}\n${rows.map((r) => `${r}\n`).join("")}\nTrailing notes.\n`,
  );
}
const R1 = "| R1 | first | — | planned | `specs/001-first/` |";
const R2 = "| R2 | second | — | planned | `specs/002-second/` |";
const R3 = "| R3 | third | R1, R2 | planned | — |";

function driver(...args: string[]): number | null {
  return spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    cwd: TOP,
    encoding: "utf8",
    timeout: 30_000,
  }).status;
}
/** Runs the driver on TMP/<name>.{o,a,b}: the status, and ours afterwards. */
function merge(name: string): { rc: number | null; out: string } {
  const rc = driver(join(TMP, `${name}.o`), join(TMP, `${name}.a`), join(TMP, `${name}.b`), "ROADMAP.md");
  return { rc, out: readFileSync(join(TMP, `${name}.a`), "utf8").replace(/\n+$/, "") };
}
const rows = (out: string): string =>
  out
    .split("\n")
    .filter((l) => l.startsWith("| R"))
    .join("~");
const sed = (name: string, from: string, to: string): void => {
  const p = join(TMP, name);
  writeFileSync(p, readFileSync(p, "utf8").replace(from, to));
};

// ── Two sessions, two adjacent rows: the case git calls a conflict ─────────
test("adjacent rows merge cleanly", () => {
  table("adj.o", R1, R2, R3);
  table("adj.a", "| R1 | first | — | done | `specs/001-first/` |", R2, R3);
  table("adj.b", R1, "| R2 | second | — | done | `specs/002-second/` |", R3);
  copyFileSync(join(TMP, "adj.a"), join(TMP, "adj.git"));
  const g = spawnSync("git", ["merge-file", "-q", join(TMP, "adj.git"), join(TMP, "adj.o"), join(TMP, "adj.b")]);
  assert.equal(g.status, 1, "(git's own line merge conflicts on adjacent rows)");
  const { rc, out } = merge("adj");
  assert.equal(rc, 0, "adjacent rows merge cleanly");
  assert.equal(
    rows(out),
    `| R1 | first | — | done | \`specs/001-first/\` |~| R2 | second | — | done | \`specs/002-second/\` |~${R3}`,
    "…keeping both rows' changes",
  );
  assert.ok(out.includes("Intro prose."), "…and the prose around the table");
  assert.ok(out.includes("Trailing notes."), "…both sides of it");
});

// ── One row, both sides moved its Status: the more advanced wins ───────────
test("in-progress against done merges to done", () => {
  table("st.o", R1, R2);
  table("st.a", "| R1 | first | — | in-progress | `specs/001-first/` |", R2);
  table("st.b", "| R1 | first | — | done | `specs/001-first/` |", R2);
  const { rc, out } = merge("st");
  assert.equal(rc, 0, "in-progress against done merges");
  assert.equal(rows(out), `| R1 | first | — | done | \`specs/001-first/\` |~${R2}`, "…to done");
});

// ── Rows with no trailing pipe (roadmap.ts reads them): the last cell survives ──
test("a cell merge of rows with no trailing pipe keeps the last cell", () => {
  const bare = (name: string, row: string): void =>
    writeFileSync(
      join(TMP, name),
      `# Roadmap: demo\n\n| ID | Sub-feature | Depends on | Status | Sub-spec\n|----|----|----|----|----\n${row}\n`,
    );
  bare("np.o", "| R1 | first | — | planned | `specs/001-first/`");
  bare("np.a", "| R1 | first | — | in-progress | `specs/001-first/`");
  bare("np.b", "| R1 | first | — | done | `specs/001-first/`");
  const { rc, out } = merge("np");
  assert.equal(rc, 0, "rows with no trailing pipe merge");
  assert.equal(rows(out), "| R1 | first | — | done | `specs/001-first/` |", "…keeping the Sub-spec cell");
});

// ── One row: Status on one side, Sub-spec on the other — cell by cell ──────
test("different cells of one row merge", () => {
  table("cell.o", R3);
  table("cell.a", "| R3 | third | R1, R2 | in-progress | — |");
  table("cell.b", "| R3 | third | R1, R2 | planned | `specs/003-third/` |");
  const { rc, out } = merge("cell");
  assert.equal(rc, 0, "different cells of one row merge");
  assert.equal(rows(out), "| R3 | third | R1, R2 | in-progress | `specs/003-third/` |", "…taking each side's cell");
});

// ── Sub-spec set on both sides, one to — : the real one wins ───────────────
test("a Sub-spec both sides changed, one to —, merges", () => {
  table("sub.o", "| R3 | third | R1, R2 | planned | `specs/003-x/` |");
  table("sub.a", "| R3 | third | R1, R2 | in-progress | — |");
  table("sub.b", "| R3 | third | R1, R2 | done | `specs/003-third/` |");
  const { rc, out } = merge("sub");
  assert.equal(rc, 0, "a Sub-spec both sides changed, one to —, merges");
  assert.equal(
    rows(out),
    "| R3 | third | R1, R2 | done | `specs/003-third/` |",
    "…to the one that names a spec, and the more advanced Status",
  );
});

// ── A row added on one side, and a blocked: set on one side ────────────────
test("a new row and a blocked row merge", () => {
  table("add.o", R1, R2);
  table("add.a", R1, R2, "| R4 | fourth | R3 | planned | — |");
  table("add.b", R1, "| R2 | second | — | blocked: vendor reply | `specs/002-second/` |");
  const { rc, out } = merge("add");
  assert.equal(rc, 0, "a new row and a blocked row merge");
  assert.equal(
    rows(out),
    `${R1}~| R2 | second | — | blocked: vendor reply | \`specs/002-second/\` |~| R4 | fourth | R3 | planned | — |`,
    "…with the new row kept and blocked: as written",
  );
});

// ── A row deleted on one side and untouched on the other is deleted ────────
test("a deletion against an unrelated edit merges", () => {
  table("del.o", R1, R2);
  table("del.a", R1);
  table("del.b", "| R1 | first | — | done | `specs/001-first/` |", R2);
  const { rc, out } = merge("del");
  assert.equal(rc, 0, "a deletion against an unrelated edit merges");
  assert.equal(rows(out), "| R1 | first | — | done | `specs/001-first/` |", "…deleting the row");
});

// ── A row theirs inserted mid-table keeps its place ────────────────────────
test("a row theirs inserted between two others merges", () => {
  table("pos.o", R1, R3);
  table("pos.a", "| R1 | first | — | done | `specs/001-first/` |", R3);
  table("pos.b", R1, R2, R3);
  const { rc, out } = merge("pos");
  assert.equal(rc, 0, "a row theirs inserted between two others merges");
  assert.equal(rows(out), `| R1 | first | — | done | \`specs/001-first/\` |~${R2}~${R3}`, "…between the same two");
});

// …after any rows ours appended at the same place, so appends stay in order.
test("rows both sides appended merge", () => {
  table("app.o", R1);
  table("app.a", R1, R2);
  table("app.b", R1, R3);
  const { rc, out } = merge("app");
  assert.equal(rc, 0, "rows both sides appended merge");
  assert.equal(rows(out), `${R1}~${R2}~${R3}`, "…ours first, then theirs");
});

// …and when the row theirs placed it after is one ours deleted, there is no
// place to put it: that is a conflict, not a guess.
test("a row placed after one ours deleted conflicts", () => {
  table("gone.o", R1, R2);
  table("gone.a", R1);
  table("gone.b", R1, R2, R3);
  assert.equal(merge("gone").rc, 1);
});

// ── Header names in either case, as roadmap.ts reads them ──────────────────
test("a lower-case header merges row by row too", () => {
  const lower = (name: string): void =>
    sed(
      name,
      "| ID | Sub-feature | Depends on | Status | Sub-spec |",
      "| id | Sub-feature | Depends on | status | Sub-spec |",
    );
  table("lc.o", R1, R2, R3);
  lower("lc.o");
  table("lc.a", "| R1 | first | — | done | `specs/001-first/` |", R2, R3);
  lower("lc.a");
  table("lc.b", R1, "| R2 | second | — | done | `specs/002-second/` |", R3);
  lower("lc.b");
  assert.equal(merge("lc").rc, 0);
});

// ── A result that cannot be written is a failed merge ──────────────────────
test("an unwritable result fails the merge", { skip: process.getuid?.() === 0 }, () => {
  table("ro.o", R1, R2);
  table("ro.a", "| R1 | first | — | done | `specs/001-first/` |", R2);
  table("ro.b", R1, "| R2 | second | — | done | `specs/002-second/` |");
  chmodSync(join(TMP, "ro.a"), 0o444);
  const rc = driver(join(TMP, "ro.o"), join(TMP, "ro.a"), join(TMP, "ro.b"), "ROADMAP.md");
  chmodSync(join(TMP, "ro.a"), 0o644);
  assert.equal(rc, 1);
});

// ── Real conflicts still conflict ──────────────────────────────────────────
test("the same cell set to two texts conflicts", () => {
  table("txt.o", R1);
  table("txt.a", "| R1 | first thing | — | planned | `specs/001-first/` |");
  table("txt.b", "| R1 | the first | — | planned | `specs/001-first/` |");
  const { rc, out } = merge("txt");
  assert.equal(rc, 1, "the same cell set to two texts conflicts");
  assert.ok(out.includes("<<<<<<< ROADMAP.md (ours)"), "…with git's markers");
});

test("blocked: against done conflicts", () => {
  table("blk.o", R1);
  table("blk.a", "| R1 | first | — | blocked: legal | `specs/001-first/` |");
  table("blk.b", "| R1 | first | — | done | `specs/001-first/` |");
  assert.equal(merge("blk").rc, 1);
});

test("a row deleted on one side and edited on the other conflicts", () => {
  table("de.o", R1, R2);
  table("de.a", R1);
  table("de.b", R1, "| R2 | second | — | done | `specs/002-second/` |");
  assert.equal(merge("de").rc, 1);
});

test("prose changed two ways conflicts", () => {
  table("pr.o", R1);
  table("pr.a", R1);
  sed("pr.a", "Intro prose.", "Ours says this.");
  table("pr.b", R1);
  sed("pr.b", "Intro prose.", "Theirs says that.");
  assert.equal(merge("pr").rc, 1);
});

test("prose changed on one side merges", () => {
  table("p1.o", R1);
  table("p1.a", "| R1 | first | — | done | `specs/001-first/` |");
  table("p1.b", R1);
  sed("p1.b", "Trailing notes.", "New notes.");
  const { rc, out } = merge("p1");
  assert.equal(rc, 0, "prose changed on one side merges");
  assert.ok(out.includes("New notes."), "…taking that side's prose");
});

// ── Not a roadmap: git's own merge, clean or not ───────────────────────────
test("a file with no roadmap table falls back to a clean line merge", () => {
  writeFileSync(join(TMP, "nt.o"), "a\nb\nc\n");
  writeFileSync(join(TMP, "nt.a"), "A\nb\nc\n");
  writeFileSync(join(TMP, "nt.b"), "a\nb\nC\n");
  assert.equal(merge("nt").rc, 0, "a file with no roadmap table falls back to a clean line merge");
  assert.equal(readFileSync(join(TMP, "nt.a"), "utf8").replace(/\n/g, " "), "A b C ", "…with both edits");
});

// ── A project README: next: set aside, the rest merged by line ─────────────
const readme = (name: string, next: string, body: string): void =>
  writeFileSync(
    join(TMP, name),
    `---\nproject: demo\nstatus: active\nnext: ${next}\n---\n\n# Project\n\n${body}\n\nEnd.\n`,
  );

test("a README whose next: both sides rewrote merges", () => {
  readme("rd.o", '"R1: first"', "Body.");
  readme("rd.a", '"R2: second"', "Body.");
  readme("rd.b", '"R3: third"', "Body, edited by theirs.");
  const rc = driver(join(TMP, "rd.o"), join(TMP, "rd.a"), join(TMP, "rd.b"), "projects/x/README.md");
  const out = readFileSync(join(TMP, "rd.a"), "utf8");
  assert.equal(rc, 0, "a README whose next: both sides rewrote merges");
  assert.ok(out.includes('next: "R2: second"'), "…keeping ours, for land.ts to re-derive");
  assert.ok(out.includes("Body, edited by theirs."), "…and theirs' body edit");
});

test("a README whose status both sides re-derived merges", () => {
  const fm = (name: string, lines: string, body: string): void =>
    writeFileSync(join(TMP, name), `---\nproject: demo\n${lines}description: d\n---\n\n# Project\n\n${body}\n`);
  fm("rs.o", 'status: active\nnext: "R1: first"\n', "Body.");
  fm("rs.a", "status: blocked\n", "Body.");
  fm("rs.b", 'status: monitor\nmonitoring-until: "2026-10-20 — R3: watch"\n', "Body, edited by theirs.");
  writeFileSync(
    join(TMP, "rs.a"),
    readFileSync(join(TMP, "rs.a"), "utf8").replace("description: d\n", 'description: d\nblocked-on: "R2: him"\n'),
  );
  const rc = driver(join(TMP, "rs.o"), join(TMP, "rs.a"), join(TMP, "rs.b"), "projects/x/README.md");
  const out = readFileSync(join(TMP, "rs.a"), "utf8");
  assert.equal(rc, 0, "a README whose status both sides re-derived merges");
  assert.equal(
    out,
    '---\nproject: demo\nstatus: blocked\ndescription: d\nblocked-on: "R2: him"\n---\n\n# Project\n\nBody, edited by theirs.\n',
    "…keeping ours' status and companion, dropping theirs' window, taking theirs' body",
  );
});

test("a README's multi-line derived entry is set aside whole", () => {
  const fm = (name: string, lines: string): void =>
    writeFileSync(join(TMP, name), `---\nproject: demo\n${lines}description: d\n---\n\n# Project\n\nBody.\n`);
  fm("rm.o", 'status: active\nnext: "R1: first"\n');
  fm("rm.a", 'status: blocked\nblocked-on: "R2: him"\n');
  fm("rm.b", 'status: monitor\nmonitoring-until: "2026-10-20 — R3:\n  the first send"\n');
  const rc = driver(join(TMP, "rm.o"), join(TMP, "rm.a"), join(TMP, "rm.b"), "projects/x/README.md");
  assert.equal(rc, 0, "a README whose theirs carried a two-line window merges");
  assert.equal(
    readFileSync(join(TMP, "rm.a"), "utf8"),
    '---\nproject: demo\nstatus: blocked\nblocked-on: "R2: him"\ndescription: d\n---\n\n# Project\n\nBody.\n',
    "…keeping ours, with no orphaned continuation line of theirs' window",
  );
  fm("rn.o", 'status: active\nnext: "R1: first"\n');
  fm("rn.a", "status: completed\n");
  fm("rn.b", 'status: monitor\nmonitoring-until: "2026-10-20 — R3:\n  the first send"\n');
  assert.equal(driver(join(TMP, "rn.o"), join(TMP, "rn.a"), join(TMP, "rn.b"), "projects/x/README.md"), 0);
  assert.equal(
    readFileSync(join(TMP, "rn.a"), "utf8"),
    "---\nproject: demo\nstatus: completed\ndescription: d\n---\n\n# Project\n\nBody.\n",
    "…and where ours carries no companion, theirs' continuation line does not survive alone",
  );
});

test("a legacy README, with no ROADMAP.md beside it, merges every line", () => {
  readme("rl.o", '"R1: first"', "Body.");
  readme("rl.a", '"R1: first"', "Body, edited by ours.");
  writeFileSync(
    join(TMP, "rl.b"),
    readFileSync(join(TMP, "rl.o"), "utf8").replace("status: active", "status: completed"),
  );
  const rc = driver(join(TMP, "rl.o"), join(TMP, "rl.a"), join(TMP, "rl.b"), "projects/legacy/README.md");
  const out = readFileSync(join(TMP, "rl.a"), "utf8");
  assert.equal(rc, 0, "a legacy README merges");
  assert.ok(out.includes("status: completed"), `…keeping theirs' completion, which nothing would re-derive: ${out}`);
  assert.ok(out.includes("Body, edited by ours."), "…and ours' body edit");
});

test("a README body both sides rewrote still conflicts", () => {
  readme("rc.o", '"R1: first"', "Body.");
  readme("rc.a", '"R2: second"', "Ours rewrote the body.");
  readme("rc.b", '"R3: third"', "Theirs rewrote the body.");
  assert.equal(driver(join(TMP, "rc.o"), join(TMP, "rc.a"), join(TMP, "rc.b"), "projects/x/README.md"), 1);
});
