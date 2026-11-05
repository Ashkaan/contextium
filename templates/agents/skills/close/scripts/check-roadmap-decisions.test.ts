// check-roadmap-decisions.test.ts — the test harness for
// .agents/skills/close/scripts/check-roadmap-decisions.ts
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/check-roadmap-decisions.test.ts
//
// The check is spawned as a program in a scratch git repo, never imported.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "check-roadmap-decisions.ts");
const scratch: string[] = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const HEAD =
  "# Roadmap\n\n| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |\n|----|----|----|----|----|----|----|\n";
const row = (id: string, status: string, sub = "—", intent = "intent") =>
  `| ${id} | ${id.toLowerCase()}-row | ${intent} | in | — | ${status} | ${sub} |\n`;
const PROJECT = "projects/sales/2026-01-01_demo";
const ROADMAP = `${PROJECT}/ROADMAP.md`;
const LOCAL = new Intl.DateTimeFormat("en-CA");
const today = LOCAL.format(new Date());
const yesterday = LOCAL.format(new Date(Date.now() - 36 * 3600 * 1000));

/** Write `specs/<name>/spec.md` (and `report.md` when given) under the demo project, uncommitted. */
function spec(dir: string, name: string, body = "# Spec\n", report?: string): void {
  const folder = join(dir, PROJECT, "specs", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "spec.md"), body);
  if (report !== undefined) writeFileSync(join(folder, "report.md"), report);
}
const stderrLines = (err: string): string[] => err.split("\n").filter((l) => l !== "");

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/** A repo whose main holds `base` rows, with `branch` rows written on top (uncommitted unless `commit`). */
function repo(base: string[] | null, branch: string[], commit = false): string {
  const dir = mkdtempSync(join(tmpdir(), "roadmap-decisions-test-"));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, dirname(ROADMAP)), { recursive: true });
  writeFileSync(join(dir, "README.md"), "x\n");
  if (base) writeFileSync(join(dir, ROADMAP), HEAD + base.join(""));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, ROADMAP), HEAD + branch.join(""));
  if (commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "work");
  }
  return dir;
}

function run(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CHECK, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("check-roadmap-decisions", () => {
  it("refuses a new row parked on a question for the user, naming the row and the word", () => {
    const dir = repo(
      [row("R1", "done")],
      [row("R1", "done"), row("R2", "blocked: the user rules whether the fixes extend past R1")],
    );
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /ROADMAP\.md: R2 "blocked: the user rules whether the fixes extend past R1": "whether"/);
    assert.match(r.out, /^1 roadmaps checked, 1 open decisions$/m);
  });

  it("refuses a row changed to wait on the user's decision, committed on the branch", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "blocked: the user to decide the colour palette")], true);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /R1 .*"decide"/);
    assert.equal(stderrLines(r.err).length, 1, "printed once, as a decision, not again as an undated wait");
    assert.match(r.out, /^1 rows added or changed, 1 left open$/m);
  });

  it("refuses a new roadmap file holding a question", () => {
    const dir = repo(null, [row("R1", "blocked: which vendor?")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /R1 .*"\?"/);
  });

  it("refuses a status worded as waiting on the user", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "blocked: the user to confirm the vendor")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /R1 .*"confirm"/);
  });

  it("passes a dated watch; an act of the user's waits on them; the rest are undated waits", () => {
    const dir = repo(
      [row("R1", "planned")],
      [
        row("R1", "blocked: the user sends the drafted message"),
        row("R2", "blocked: the editor's sign-off on the draft"),
        row("R3", "blocked: 2099-11-01"),
        row("R4", "blocked: the vendor fixes `GET /x?y=1`"),
      ],
    );
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.out, /^1 roadmaps checked, 0 open decisions$/m);
    assert.match(r.out, /^4 rows added or changed, 3 left open$/m);
    const lines = stderrLines(r.err);
    assert.equal(lines.length, 3, r.err);
    assert.ok(
      lines.some((l) => l.includes(": R1 ") && /waiting on the user/.test(l)),
      r.err,
    );
    for (const id of ["R2", "R4"])
      assert.ok(
        lines.some((l) => l.includes(`: ${id} `) && /no date/.test(l)),
        id,
      );
    assert.ok(!r.err.includes(": R3 "), r.err);
  });

  it("leaves alone a decision row this branch did not change", () => {
    const old = row("R1", "blocked: the user to answer how far near is");
    const dir = repo([old, row("R2", "planned")], [old, row("R2", "done")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
  });

  it("checks nothing when no roadmap changed", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0);
    assert.match(r.out, /^0 roadmaps checked, 0 open decisions$/m);
    assert.match(r.out, /^0 rows added or changed, 0 left open$/m);
  });

  // A changed roadmap the parser cannot read was skipped as if deleted: exit 0
  // and "0 roadmaps checked" over a table nobody judged (Contextium v9.2.0 review).
  it("refuses a changed roadmap the parser cannot read, apart from a deleted one", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned")]);
    writeFileSync(join(dir, ROADMAP), "# Wrong heading\n");
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /^projects\/sales\/2026-01-01_demo\/ROADMAP\.md: roadmap\.ts cannot read it — /m);
    assert.match(r.out, /^0 roadmaps checked, 0 open decisions$/m);
    assert.match(r.out, /^1 roadmaps unreadable$/m);
  });

  it("passes a roadmap the branch deleted, counting it neither checked nor unreadable", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned")]);
    rmSync(join(dir, ROADMAP));
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^0 roadmaps checked, 0 open decisions$/m);
    assert.match(r.out, /^0 roadmaps unreadable$/m);
  });

  it("stops, rather than seeing no change, when git cannot list what changed", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "blocked: the user rules whether")]);
    writeFileSync(join(dir, ".git/index"), "not an index\n");
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /check-roadmap-decisions: could not list what changed since /);
  });

  it("is a caller error without --since, or with a ref that has no merge base", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned")]);
    assert.equal(run(dir).code, 2);
    assert.equal(run(dir, "--since", "no-such-ref").code, 2);
  });
});

// A close means the work is done: every row the push adds or changes is judged.
describe("check-roadmap-decisions on rows a push adds or changes — what passes", () => {
  const passes = (name: string, base: string[] | null, branch: string[], setup?: (dir: string) => void) =>
    it(name, () => {
      const dir = repo(base, branch);
      setup?.(dir);
      const r = run(dir, "--since", "main");
      assert.equal(r.code, 0, r.err);
      assert.equal(r.err, "");
      assert.match(r.out, /, 0 left open$/m);
    });
  passes(
    "the /spec shape: planned with a written spec",
    [row("R1", "planned")],
    [row("R1", "planned", "specs/001-x/")],
    (d) => spec(d, "001-x"),
  );
  passes(
    "a new planned row with no spec yet",
    [row("R1", "done")],
    [row("R1", "done"), row("R2", "planned")],
  );
  passes(
    "a new planned row whose spec folder is not written",
    [row("R1", "done")],
    [row("R1", "done"), row("R2", "planned", "specs/009-missing/")],
  );
  passes(
    "a new planned row whose spec still holds an open clarification",
    [row("R1", "done")],
    [row("R1", "done"), row("R2", "planned", "specs/002-y/")],
    (d) => spec(d, "002-y", "# Spec\n\n- FR-001 [NEEDS CLARIFICATION: which vendor?]\n"),
  );
  passes(
    "rows moved to done, closed: and absorbed by",
    [row("R1", "planned"), row("R2", "planned"), row("R3", "in-progress")],
    [row("R1", "done"), row("R2", "closed: dropped"), row("R3", "absorbed by R9")],
  );
  passes(
    "a watch dated today in local time, and one far ahead",
    [row("R1", "planned")],
    [row("R1", `blocked: ${today}`), row("R2", "blocked: 2099-01-01 the editor's sign-off")],
  );
  passes(
    "a wait released on a date, today in local time and far ahead",
    [row("R1", "planned")],
    [row("R1", `blocked: until ${today}`), row("R2", "blocked: until 2099-01-01 the quarter closes")],
  );
  passes(
    "an old wait on the user and an old manual row this branch left alone",
    [row("R1", "blocked: the user sends the draft"), row("R2", "planned", "manual"), row("R3", "planned")],
    [row("R1", "blocked: the user sends the draft"), row("R2", "planned", "manual"), row("R3", "done")],
  );
  passes(
    "an Intent-only edit of an old manual row",
    [row("R1", "planned", "manual")],
    [row("R1", "planned", "manual", "reworded intent")],
  );
  passes("a manual row moved to done", [row("R1", "planned", "manual")], [row("R1", "done", "manual")]);
  passes(
    "a manual row set aside until a date",
    [row("R5", "planned", "manual")],
    [row("R5", "blocked: until 2099-01-01 the app store releases the build", "manual")],
  );

  it("counts 0 rows when the Status and Sub-spec cells are unchanged", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned", "—", "reworded")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^1 roadmaps checked, 0 open decisions$/m);
    assert.match(r.out, /^0 rows added or changed, 0 left open$/m);
  });
});

describe("check-roadmap-decisions on rows a push adds or changes — what holds the close", () => {
  /** One open row: exit 1 and one stderr line naming the row, its Status and Sub-spec, and `kind`. */
  const holds = (name: string, base: string[], branch: string[], id: string, kind: RegExp) =>
    it(name, () => {
      const dir = repo(base, branch);
      const r = run(dir, "--since", "main");
      assert.equal(r.code, 1, r.out);
      const lines = stderrLines(r.err);
      assert.equal(lines.length, 1, r.err);
      const status =
        branch
          .find((b) => b.startsWith(`| ${id} `))
          ?.split("|")[6]
          ?.trim() ?? "";
      const sub =
        branch
          .find((b) => b.startsWith(`| ${id} `))
          ?.split("|")[7]
          ?.trim()
          .replace(/\/$/, "") ?? ""; // roadmap.ts prints `specs/NNN-name` without the slash
      assert.ok(lines[0]?.includes(`ROADMAP.md: ${id} "${status}" (Sub-spec ${sub})`), lines[0]);
      assert.match(lines[0] ?? "", kind);
      assert.match(r.out, /^1 rows added or changed, 1 left open$/m);
    });
  holds("a new manual row", [], [row("R5", "planned", "manual")], "R5", /waiting on the user/);
  holds(
    "a row whose Sub-spec alone changes to manual",
    [row("R5", "planned")],
    [row("R5", "planned", "manual")],
    "R5",
    /waiting on the user/,
  );
  holds(
    "a dated manual row",
    [],
    [row("R5", "blocked: 2099-01-01 the user renews the domain", "manual")],
    "R5",
    /waiting on the user/,
  );
  holds(
    "a manual row set aside until a date already past",
    [row("R5", "planned", "manual")],
    [row("R5", "blocked: until 2000-01-01 the app store releases the build", "manual")],
    "R5",
    /already past/,
  );
  holds(
    "a manual row set aside until a date that names the user",
    [row("R5", "planned", "manual")],
    [row("R5", "blocked: until 2099-01-01 the user sends the form", "manual")],
    "R5",
    /waiting on the user/,
  );
  holds(
    "a manual watch with no until",
    [row("R5", "planned", "manual")],
    [row("R5", "blocked: 2099-01-01 the app store releases the build", "manual")],
    "R5",
    /waiting on the user/,
  );
  holds(
    "a manual row moved to in-progress",
    [row("R5", "planned", "manual")],
    [row("R5", "in-progress", "manual")],
    "R5",
    /waiting on the user/,
  );
  holds(
    "a dated wait that names the user is a step waiting on them",
    [row("R3", "planned")],
    [row("R3", "blocked: 2099-01-01 the user sends the drafted reply")],
    "R3",
    /waiting on the user/,
  );
  holds(
    "a wait with no date",
    [row("R3", "planned")],
    [row("R3", "blocked: vendor reply")],
    "R3",
    /no date.*blocked: YYYY-MM-DD/,
  );
  holds(
    "a wait whose date does not lead",
    [row("R3", "planned")],
    [row("R3", "blocked: vendor reply by 2026-11-01")],
    "R3",
    /no date/,
  );
  holds(
    "a wait dated yesterday",
    [row("R3", "planned")],
    [row("R3", `blocked: ${yesterday} vendor reply`)],
    "R3",
    /already past/,
  );
  holds(
    "a wait released on a date already past",
    [row("R3", "planned")],
    [row("R3", `blocked: until ${yesterday} the quarter closes`)],
    "R3",
    /already past/,
  );
  holds(
    "a release that names the user is a step waiting on them",
    [row("R3", "planned")],
    [row("R3", "blocked: until 2099-01-01 the user renews the domain")],
    "R3",
    /waiting on the user/,
  );
  holds(
    "a date that is not a calendar day",
    [row("R3", "planned")],
    [row("R3", "blocked: 2099-99-99 vendor reply")],
    "R3",
    /no date/,
  );
  holds(
    "a date with a digit after it",
    [row("R3", "planned")],
    [row("R3", "blocked: 2099-01-010 vendor reply")],
    "R3",
    /no date/,
  );
  holds(
    "a row set in-progress",
    [row("R3", "planned", "specs/003-z/")],
    [row("R3", "in-progress", "specs/003-z/")],
    "R3",
    /half-built.*.done. if its report is complete/,
  );
  holds("an unknown status", [row("R3", "planned")], [row("R3", "paused")], "R3", /not one of the known states/);

  it("prints every open row on its own line", () => {
    const dir = repo(
      [row("R1", "done")],
      [row("R1", "done"), row("R2", "planned", "manual"), row("R3", "blocked: vendor reply"), row("R4", "in-progress")],
    );
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    const lines = stderrLines(r.err);
    assert.equal(lines.length, 3, r.err);
    for (const id of ["R2", "R3", "R4"])
      assert.ok(
        lines.some((l) => l.includes(`: ${id} `)),
        id,
      );
    assert.match(r.out, /^3 rows added or changed, 3 left open$/m);
  });
});

// A report can say "Not done, waiting on the user" and close, when only the
// roadmap and the journal are read.
const REPORT = "projects/sales/2026-01-01_demo/specs/001-x/report.md";

function withReport(baseText: string | null, branchText: string): string {
  const dir = repo([row("R1", "planned")], [row("R1", "planned")]);
  if (baseText !== null) {
    git(dir, "checkout", "-q", "main");
    mkdirSync(join(dir, dirname(REPORT)), { recursive: true });
    writeFileSync(join(dir, REPORT), baseText);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "report");
    git(dir, "checkout", "-q", "work");
    git(dir, "merge", "-q", "main");
  }
  mkdirSync(join(dir, dirname(REPORT)), { recursive: true });
  writeFileSync(join(dir, REPORT), branchText);
  return dir;
}

describe("check-roadmap-decisions on spec reports", () => {
  it("refuses a report line this branch adds that waits on the user", () => {
    const dir = withReport(
      null,
      "# Report\n\n- **Not done, waiting on the user** (the decision record clears only this change)\n",
    );
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /report\.md:3: "waiting on the user"/);
    assert.match(r.out, /^1 reports checked, 1 parked lines$/m);
  });

  it("refuses a report line waiting for your answer, written as a possessive", () => {
    const dir = withReport(null, "# Report\n\n- Not done, waiting for your answer on the copy\n");
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /report\.md:3: "waiting for your"/);
  });

  it("leaves alone a parked line the report already held", () => {
    const old = "# Report\n\n- R1 waits on the user\n";
    const dir = withReport(old, `${old}- a new deviation, settled\n`);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
  });

  it("passes a report that leaves nothing waiting", () => {
    const dir = withReport(null, "# Report\n\n- the user chose option 1 on 2026-10-19\n");
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
  });
});

// A half-built piece: a spec report this push writes as `partial`
// holds the close unless its row stopped on purpose.
const PARTIAL = "---\nspec: 001-x\nspec-status: partial\n---\n\n# Report\n";
const COMPLETE = "---\nspec: 001-x\nspec-status: complete\n---\n\n# Report\n";

describe("check-roadmap-decisions output", () => {
  it("delivers every refusal and the summary to a reader that is slow to read", () => {
    const many = Array.from({ length: 600 }, (_, i) => row(`R${i + 1}`, "blocked: vendor reply"));
    const dir = repo([], many);
    // The reader sleeps before reading, so the 64 KiB pipe fills while the check writes.
    const r = spawnSync(
      "bash",
      ["-c", `"${process.execPath}" --experimental-strip-types "${CHECK}" --since main 2>&1 | { sleep 1; cat; }`],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const refusals = r.stdout.split("\n").filter((l) => /: R\d+ "blocked: vendor reply"/.test(l));
    assert.equal(refusals.length, 600);
    assert.match(r.stdout, /^0 reports partial$/m);
  });
});

describe("check-roadmap-decisions on partial spec reports", () => {
  it("refuses a partial report whose row is still open, naming the report and the row", () => {
    const dir = repo([row("R1", "in-progress", "specs/001-x/")], [row("R1", "in-progress", "specs/001-x/")]);
    spec(dir, "001-x", "# Spec\n", PARTIAL);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /specs\/001-x\/report\.md: reads partial, and its row R1 is "in-progress"/);
    assert.match(r.out, /^1 reports partial$/m);
  });

  it("passes a partial report whose row is closed: or absorbed by", () => {
    for (const status of ["closed: approach dropped", "absorbed by R9"]) {
      const dir = repo([row("R1", "in-progress", "specs/001-x/")], [row("R1", status, "specs/001-x/")]);
      spec(dir, "001-x", "# Spec\n", PARTIAL);
      const r = run(dir, "--since", "main");
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /^0 reports partial$/m);
    }
  });

  it("refuses a partial report no row names", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned")]);
    spec(dir, "001-x", "# Spec\n", PARTIAL);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /specs\/001-x\/report\.md: reads partial, and no row names specs\/001-x/);
  });

  it("passes a complete report", () => {
    const dir = repo([row("R1", "in-progress", "specs/001-x/")], [row("R1", "done", "specs/001-x/")]);
    spec(dir, "001-x", "# Spec\n", COMPLETE);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^1 reports checked, 0 parked lines$/m);
    assert.match(r.out, /^0 reports partial$/m);
  });

  it("is a caller error, never a pass, when spec-state.ts cannot run", () => {
    const tree = mkdtempSync(join(tmpdir(), "roadmap-decisions-copy-"));
    scratch.push(tree);
    const here = dirname(CHECK);
    mkdirSync(join(tree, ".agents/skills/close/scripts"), { recursive: true });
    mkdirSync(join(tree, ".agents/packages/cli-exit"), { recursive: true });
    for (const f of ["check-roadmap-decisions.ts", "open-decision.ts", "roadmap.ts"]) {
      copyFileSync(join(here, f), join(tree, ".agents/skills/close/scripts", f));
    }
    copyFileSync(join(here, "../../../packages/cli-exit/cli-exit.ts"), join(tree, ".agents/packages/cli-exit/cli-exit.ts"));
    const dir = repo([row("R1", "in-progress", "specs/001-x/")], [row("R1", "in-progress", "specs/001-x/")]);
    spec(dir, "001-x", "# Spec\n", PARTIAL);
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(tree, ".agents/skills/close/scripts/check-roadmap-decisions.ts"), "--since", "main"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /spec-state\.ts/);
  });
});

// A step for the user that cannot start yet does not hold the close:
// a `manual` row rides while a row it depends on, here or in another project,
// is open; once ready, or when an entry names nothing, it holds the close.
describe("check-roadmap-decisions: a manual row waiting on an open row", () => {
  const dep = (id: string, status: string, depends: string, sub = "manual") =>
    `| ${id} | ${id.toLowerCase()}-row | intent | in | ${depends} | ${status} | ${sub} |\n`;
  /** Another project whose R2 has `status`, an ordinary row: added on the branch, it rides. */
  function other(dir: string, status: string): void {
    const p = join(dir, "projects/ops/2026-01-02_other-proj");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "ROADMAP.md"), `${HEAD}| R2 | the decision | i | s | — | ${status} | — |\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "other");
  }

  it("passes an added manual row depending on an open local row", () => {
    const dir = repo([row("R1", "planned")], [row("R1", "planned"), dep("R2", "planned", "R1")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
  });

  it("passes an added manual row depending on another project's open row", () => {
    const dir = repo([row("R1", "done")], [row("R1", "done"), dep("R2", "planned", "other-proj R2")]);
    other(dir, "planned");
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 0, r.err);
  });

  it("refuses it once ready: every dependency done", () => {
    const dir = repo([row("R1", "done")], [row("R1", "done"), dep("R2", "planned", "R1")]);
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /R2 "planned" \(Sub-spec manual\): a step waiting on the user/);
  });

  it("refuses it when another project's row is done", () => {
    const dir = repo([row("R1", "done")], [row("R1", "done"), dep("R2", "planned", "other-proj R2")]);
    other(dir, "done");
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1);
    assert.match(r.err, /R2 "planned" \(Sub-spec manual\): a step waiting on the user/);
  });

  it("refuses an unknown entry, alone or beside an open one", () => {
    for (const cell of ["nobody R1", "R1, nobody R1"]) {
      const dir = repo([row("R1", "planned")], [row("R1", "planned"), dep("R2", "planned", cell)]);
      const r = run(dir, "--since", "main");
      assert.equal(r.code, 1, cell);
      assert.match(r.err, /R2 "planned" \(Sub-spec manual\): .*fix its Depends on/, cell);
    }
  });

  it("judges a row whose only change is its Depends on cell", () => {
    const dir = repo(
      [row("R1", "done"), dep("R2", "planned", "R3"), row("R3", "planned")],
      [row("R1", "done"), dep("R2", "planned", "R1"), row("R3", "planned")],
    );
    const r = run(dir, "--since", "main");
    assert.equal(r.code, 1, "removing the last open dependency makes the step the user's now");
    assert.match(r.err, /R2 "planned" \(Sub-spec manual\): a step waiting on the user/);
    assert.match(r.out, /^1 rows added or changed, 1 left open$/m);
  });
});
