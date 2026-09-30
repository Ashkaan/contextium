// roadmap.test.ts — peer of roadmap.ts.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/roadmap.test.ts
//
// Each case builds a project folder in a temp dir and spawns roadmap.ts on it.
// The `--set` and `--sync-next` cases run in order on one folder each, as the
// bash suite's did: each step reads what the one before it wrote.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "roadmap.ts");
const TEMPLATE = join(HERE, "../../project/references/templates/ROADMAP.md");
const tmp = mkdtempSync(join(tmpdir(), "roadmap-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const HDR = `| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|`;

/** A project with a README and a ROADMAP holding those rows. */
function mk(name: string, ...rows: string[]): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "README.md"), "---\nproject: x\nstatus: active\ndescription: A thing\n---\n\n# Project\n");
  writeFileSync(
    join(d, "ROADMAP.md"),
    `# Roadmap: test\n\nIntro.\n\n**Status legend**: planned · in-progress · done\n\n${HDR}\n${rows.map((r) => `${r}\n`).join("")}\nTrailing prose.\n`,
  );
  return d;
}

const NODE_ARGS = ["--no-warnings", "--experimental-strip-types", SUT];
function sut(...args: string[]): { rc: number | null; stdout: string; stderr: string } {
  return sutEnv({}, ...args);
}
function sutEnv(env: Record<string, string>, ...args: string[]): { rc: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** `$(…)`: trailing newlines dropped. */
const cs = (s: string): string => s.replace(/\n+$/, "");
const list = (d: string): string => cs(sut(d).stdout);
const rcOf = (...args: string[]): number | null => sut(...args).rc;
const errs = (...args: string[]): string => cs(sut(...args).stderr);
/** Field `f` (1-based) of the TSV row whose ID is `id`. */
const field = (d: string, id: string, f: number): string =>
  list(d)
    .split("\n")
    .filter((l) => l.split("\t")[0] === id)
    .map((l) => l.split("\t")[f - 1] ?? "")
    .join("\n");
const read = (p: string): string => readFileSync(p, "utf8");
const grepLines = (text: string, re: RegExp, keep: boolean): string[] =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => re.test(l) === keep);

// 0 rows: header only
test("header only", () => {
  const d = mk("empty");
  assert.equal(list(d), "", "header-only prints nothing");
  assert.equal(rcOf(d), 0, "header-only exits 0");
  assert.equal(cs(sut(d, "--next").stdout), "", "header-only has no next");
  assert.equal(cs(sut(d, "--ready").stdout), "", "header-only has no ready rows");
});

// 1 row
test("one row", () => {
  const d = mk("one", "| R1 | alpha | i | s | — | planned | — |");
  assert.equal(list(d), "R1\tplanned\tyes\t—\talpha", "one row TSV");
  assert.equal(cs(sut(d, "--next").stdout), '"R1: alpha"', "one row next");
});

// The unfilled template: placeholder rows are a malformed table, not three rows
test("unfilled template", () => {
  const d = join(tmp, "tpl");
  mkdirSync(d, { recursive: true });
  copyFileSync(TEMPLATE, join(d, "ROADMAP.md"));
  assert.equal(rcOf(d), 1, "unfilled template exits 1");
  assert.equal(
    errs(d),
    "roadmap: placeholder row R1 — the template was never filled in",
    "unfilled template names the placeholder",
  );
});

// Wrong cell count
test("short row", () => {
  const d = mk("cells", "| R1 | alpha | i | s | — | planned |");
  assert.equal(rcOf(d), 1, "short row exits 1");
  assert.ok(errs(d).includes("has 6 cells, the header has 7"), `short row message: ${errs(d)}`);
});

// blocked: with spaces; absorbed by satisfies a dependency
test("blocked and absorbed", () => {
  const d = mk(
    "blk",
    "| R1 | alpha | i | s | — | blocked: vendor reply | — |",
    "| R2 | beta | i | s | — | absorbed by R3 | — |",
    "| R3 | gamma | i | s | R2 | planned | — |",
    "| R4 | delta | i | s | R1 | planned | — |",
  );
  assert.equal(field(d, "R1", 2), "blocked: vendor reply", "blocked keeps its spaces");
  assert.equal(field(d, "R1", 3), "no", "blocked is never ready");
  assert.equal(field(d, "R2", 3), "no", "absorbed is never ready");
  assert.equal(field(d, "R3", 3), "yes", "absorbed by satisfies a dependency");
  assert.equal(field(d, "R4", 3), "no", "a blocked dependency is unsatisfied");
});

// Unknown dependency: not ready, warned, exit 0
test("unknown dependency", () => {
  const d = mk("unk", "| R5 | eps | i | s | R99 | planned | — |");
  assert.equal(field(d, "R5", 3), "no", "unknown dep not ready");
  assert.equal(errs(d), "roadmap: R5 depends on unknown R99", "unknown dep warns");
  assert.equal(rcOf(d), 0, "unknown dep exits 0");
});

// Unknown status: warned, not ready
test("unknown status", () => {
  const d = mk("ust", "| R16 | fut | i | s | — | waiting on the vendor | — |");
  assert.equal(errs(d), "roadmap: R16 has unknown status", "unknown status warns");
  assert.equal(field(d, "R16", 3), "no", "unknown status not ready");
});

// Depends on: several IDs, whitespace trimmed, all must be satisfied
test("several dependencies", () => {
  const d = mk(
    "deps",
    "| R1 | a | i | s | — | done | — |",
    "| R2 | b | i | s | — | planned | — |",
    "| R3 | c | i | s | R1 ,  R2 | planned | — |",
    "| R4 | d | i | s | R1,R1 | planned | — |",
  );
  assert.equal(field(d, "R3", 3), "no", "one unsatisfied among several");
  assert.equal(field(d, "R4", 3), "yes", "all satisfied");
  assert.equal(field(d, "R1", 3), "no", "done is never ready");
});

// in-progress beats an EARLIER planned row for --next and --ready
test("in-progress beats earlier planned", () => {
  const d = mk(
    "ord",
    "| R1 | first planned | i | s | — | planned | — |",
    "| R2 | the one moving | i | s | — | in-progress | — |",
    "| R3 | finished | i | s | — | done | — |",
  );
  assert.equal(cs(sut(d, "--next").stdout), '"R2: the one moving"', "in-progress beats earlier planned");
  assert.equal(
    cs(sut(d, "--ready").stdout)
      .split("\n")
      .map((l) => l.split("\t")[0])
      .join(" "),
    "R2 R1",
    "--ready lists in-progress then planned, never done",
  );
  assert.equal(
    cs(sut(d, "--ready").stdout).split("\n")[0],
    "R2\tin-progress\tyes\t—\tthe one moving",
    "--ready prints the same TSV as the list",
  );
});

// A 70-character Sub-feature is cut at a whole word with an ellipsis
test("long next is cut at a word", () => {
  const long = "loop skills adopt the shape and every reader follows along with them ok";
  const d = mk("long", `| R3 | ${long} | i | s | — | planned | — |`);
  const nxt = cs(sut(d, "--next").stdout);
  assert.equal(nxt, '"R3: loop skills adopt the shape and every reader follows…"', "long next is cut at a word");
  const v = nxt.replace(/^"/, "").replace(/"$/, "");
  assert.ok(Array.from(v).length <= 60, "cut value is at most 60 characters");
});

// Multi-byte characters count once each
test("multi-byte next is cut by characters", () => {
  const d = mk(
    "utf",
    "| R4 | café señor — naïve résumé über straße déjà vu façade coöp élan ok |  i | s | — | planned | — |",
  );
  assert.equal(
    cs(sut(d, "--next").stdout),
    '"R4: café señor — naïve résumé über straße déjà vu façade…"',
    "multi-byte next is cut by characters",
  );
});

// Sub-spec forms
test("Sub-spec forms", () => {
  const d = mk(
    "subs",
    "| R1 | a | i | s | — | done | `decision-records.spec.md` → `decision-records-report.md` |",
    "| R2 | b | i | s | — | planned | `specs/004-mech/` |",
    "| R3 | c | i | s | — | planned | specs/005-bare/ |",
  );
  assert.equal(field(d, "R1", 4), "decision-records", "legacy Sub-spec gives the stem");
  assert.equal(field(d, "R2", 4), "specs/004-mech", "folder Sub-spec gives specs/NNN-name");
  assert.equal(field(d, "R3", 4), "specs/005-bare", "unticked folder Sub-spec");
});

// --set changes only the target row's Status and Sub-spec cells
test("--set", () => {
  const d = mk(
    "set",
    "| R1 | a | i | s | — | planned | — |",
    "| R2 |   b spaced   | i | s | R1 | planned | — |",
    "| R3 | c | i | s | — | planned | — |",
  );
  const rm = join(d, "ROADMAP.md");
  const before = read(rm);
  assert.equal(rcOf(d, "--set", "r2", "in-progress", "--sub-spec", "specs/001-b/"), 0, "--set exits 0");
  assert.equal(
    grepLines(read(rm), /^\| R2/, true).join("\n"),
    "| R2 |   b spaced   | i | s | R1 | in-progress | `specs/001-b/` |",
    "--set rewrote the row",
  );
  assert.deepEqual(
    grepLines(read(rm), /^\| R2/, false),
    grepLines(before, /^\| R2/, false),
    "--set left every other line alone",
  );
  assert.equal(read(rm).split("\n").length, before.split("\n").length, "--set line count unchanged");
  assert.equal(rcOf(d, "--set", "R9", "done"), 1, "--set missing row exits 1");
  assert.equal(
    errs(d, "--set", "R9", "done"),
    "roadmap: no row R9 in ROADMAP.md (rows: R1, R2, R3)",
    "--set missing row lists the IDs",
  );
  assert.equal(rcOf(d, "--set", "R1", "finished"), 2, "--set bad status is usage");
  sut(d, "--set", "R1", "blocked: 2026-10-02");
  assert.equal(
    grepLines(read(rm), /^\| R1/, true).join("\n"),
    "| R1 | a | i | s | — | blocked: 2026-10-02 | — |",
    "--set status only leaves Sub-spec",
  );
  // A file with no final newline keeps having none.
  writeFileSync(rm, read(rm).replace(/\n+$/, ""));
  sut(d, "--set", "R3", "done");
  assert.equal(read(rm).slice(-1), ".", "--set keeps a missing final newline missing");
  assert.equal(
    grepLines(read(rm), /^\| R3/, true).join("\n"),
    "| R3 | c | i | s | — | done | — |",
    "--set on a no-newline file still rewrote",
  );
});

// --sync-next: insert after description, replace, remove
test("--sync-next", () => {
  const d = mk("sync", "| R1 | alpha | i | s | — | planned | — |");
  const readme = join(d, "README.md");
  const linesOf = (from: number, to: number): string =>
    read(readme)
      .split("\n")
      .slice(from - 1, to)
      .join("\n");
  sut(d, "--sync-next");
  assert.equal(linesOf(4, 5), 'description: A thing\nnext: "R1: alpha"', "--sync-next inserts after description");
  sut(d, "--set", "R1", "in-progress");
  const rm = join(d, "ROADMAP.md");
  writeFileSync(rm, read(rm).replace("| alpha |", "| alpha renamed |"));
  sut(d, "--sync-next");
  assert.equal(linesOf(5, 5), 'next: "R1: alpha renamed"', "--sync-next replaces in place");
  assert.equal(grepLines(read(readme), /^next:/, true).length, 1, "--sync-next leaves one next line");
  const before = read(readme);
  sut(d, "--set", "R1", "done");
  sut(d, "--sync-next");
  assert.equal(grepLines(read(readme), /^next:/, true).length, 0, "--sync-next removes when none ready");
  assert.equal(
    `${grepLines(before, /^next:/, false).join("\n")}\n`,
    read(readme),
    "--sync-next removal changes nothing else",
  );

  const d2 = mk("nodesc", "| R1 | alpha | i | s | — | planned | — |");
  writeFileSync(join(d2, "README.md"), "---\nproject: x\nstatus: active\n---\n\n# P\n");
  sut(d2, "--sync-next");
  assert.equal(
    read(join(d2, "README.md")).split("\n").slice(3, 5).join("\n"),
    'next: "R1: alpha"\n---',
    "--sync-next with no description goes before ---",
  );
  rmSync(join(d2, "README.md"));
  assert.equal(rcOf(d2, "--sync-next"), 1, "--sync-next with no README exits 1");
});

// Columns are found by header name
test("reordered columns read by name", () => {
  const d = join(tmp, "reorder");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "ROADMAP.md"),
    "# Roadmap: r\n\n| Status | Sub-spec | ID | Depends on | Sub-feature |\n|---|---|---|---|---|\n| done | — | R1 | — | a |\n| planned | `specs/002-b/` | R2 | R1 | b |\n",
  );
  assert.equal(list(d).split("\n")[1], "R2\tplanned\tyes\tspecs/002-b\tb");
});

// Malformed: no Status column / no heading / no file
test("malformed tables", () => {
  const d = join(tmp, "nostatus");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "ROADMAP.md"), "# Roadmap: r\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n");
  assert.equal(rcOf(d), 1, "no Status column exits 1");
  assert.equal(errs(d), "roadmap: no table under `# Roadmap` with ID and Status columns", "no Status column message");
  const nohead = join(tmp, "nohead");
  mkdirSync(nohead, { recursive: true });
  writeFileSync(join(nohead, "ROADMAP.md"), "| ID | Status |\n|---|---|\n| R1 | planned |\n");
  assert.equal(rcOf(nohead), 1, "no heading exits 1");
  const nofile = join(tmp, "nofile");
  mkdirSync(nofile, { recursive: true });
  assert.equal(rcOf(nofile), 1, "no ROADMAP.md exits 1");
  assert.equal(rcOf(nofile, "--bogus"), 2, "usage exits 2");
  const dup = mk("dup", "| R1 | a | i | s | — | planned | — |", "| R1 | b | i | s | — | planned | — |");
  assert.equal(rcOf(dup), 1, "duplicate ID exits 1");
});

// Not in the bash suite: the bytes the rewrite does not compose are the bytes
// it read. The TypeScript holds lines as latin1 to keep this true; a UTF-8
// round trip would turn an invalid byte into U+FFFD on every --set.
test("--set keeps the bytes of every other line, and a missing final newline", () => {
  const d = mk("bytes", "| R1 | a | i | s | — | planned | — |");
  const rm = join(d, "ROADMAP.md");
  const raw = Buffer.concat([readFileSync(rm), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from("tail without newline")]);
  writeFileSync(rm, raw);
  assert.equal(rcOf(d, "--set", "R1", "done"), 0);
  const after = readFileSync(rm);
  const want = Buffer.from(raw.toString("latin1").replace("| planned |", "| done |"), "latin1");
  assert.ok(after.equals(want), "bytes outside the Status cell changed");
});

// --check: an explicit row may be built only when it is ready, names a spec,
// and that spec is on disk and still owed work; every reason is named
test("--check", () => {
  const d = mk(
    "chk",
    "| R1 | a | i | s | — | done | — |",
    "| R2 | b | i | s | — | planned | — |",
    "| R3 | c | i | s | R1, R2 | planned | `specs/003-c/` |",
    "| R4 | d | i | s | R1 | planned | `specs/004-d/` |",
    "| R5 | e | i | s | R1 | planned | — |",
    "| R6 | f | i | s | — | blocked: vendor reply | `specs/006-f/` |",
    "| R7 | g | i | s | R1 | in-progress | `specs/007-g/` |",
    "| R8 | h | i | s | R1 | planned | `specs/008-h/` |",
  );
  for (const n of ["003-c", "004-d", "006-f", "007-g"]) {
    mkdirSync(join(d, "specs", n), { recursive: true });
    writeFileSync(join(d, "specs", n, "spec.md"), "# spec\n");
  }
  writeFileSync(join(d, "specs/007-g/report.md"), "---\nspec: 007-g\nspec-status: complete\n---\n");
  assert.equal(cs(sut(d, "--check", "r4").stdout), "specs/004-d", "--check a ready row prints its Sub-spec");
  assert.equal(rcOf(d, "--check", "R4"), 0, "--check a ready row exits 0");
  assert.equal(
    errs(d, "--check", "R3"),
    "roadmap: R3 not ready: depends on R2, which is `planned`",
    "--check names the unmet dependency",
  );
  assert.equal(rcOf(d, "--check", "R6"), 1, "--check a blocked row exits 1");
  assert.equal(
    errs(d, "--check", "R6"),
    "roadmap: R6 not ready: its Status is `blocked: vendor reply`",
    "--check a blocked row says why",
  );
  assert.equal(
    errs(d, "--check", "R1"),
    "roadmap: R1 not ready: its Status is `done`\nroadmap: R1 not ready: no spec yet (Sub-spec is —) — run /project",
    "--check a done row says why",
  );
  assert.equal(
    errs(d, "--check", "R5"),
    "roadmap: R5 not ready: no spec yet (Sub-spec is —) — run /project",
    "--check a row with no spec",
  );
  assert.equal(
    errs(d, "--check", "R7"),
    "roadmap: R7 not ready: its spec specs/007-g is already complete — /close flips the row to done",
    "--check a spec already complete",
  );
  assert.equal(
    errs(d, "--check", "R8"),
    "roadmap: R8 not ready: its Sub-spec specs/008-h is not on disk — run /project",
    "--check a Sub-spec not on disk",
  );
  assert.equal(rcOf(d, "--check", "R99"), 1, "--check a missing row exits 1");
  assert.equal(rcOf(d, "--check"), 2, "--check with no ID is usage");
});

// Writers lock the project: a live holder makes --set wait, then give up
// without writing; a dead holder's lock is taken over; the mode survives
test("writers lock the project", async () => {
  const d = mk("lock", "| R1 | a | i | s | — | planned | — |", "| R2 | b | i | s | — | planned | — |");
  const rm = join(d, "ROADMAP.md");
  const lock = join(d, ".roadmap.lock");
  chmodSync(rm, 0o640);
  const live = spawn("sleep", ["30"], { stdio: "ignore" });
  const gone = new Promise((res) => live.once("exit", res));
  try {
    symlinkSync(String(live.pid), lock);
    const before = readFileSync(rm);
    assert.equal(
      sutEnv({ ROADMAP_LOCK_WAIT: "1" }, d, "--set", "R1", "done").rc,
      1,
      "--set waits out a live lock, then exits 1",
    );
    assert.ok(readFileSync(rm).equals(before), "…having written nothing");
    assert.match(
      sutEnv({ ROADMAP_LOCK_WAIT: "1" }, d, "--sync-next").stderr,
      /another session is writing this project/,
      "--sync-next honours the lock too",
    );
  } finally {
    live.kill();
    await gone;
  }
  assert.equal(sutEnv({ ROADMAP_LOCK_WAIT: "5" }, d, "--set", "R1", "done").rc, 0, "a dead holder's lock is taken over");
  let held = true;
  try {
    lstatSync(lock);
  } catch {
    held = false;
  }
  assert.equal(held, false, "…and released after");
  assert.equal(existsSync(`${lock}.takeover`), false, "…and the takeover guard is gone");
  assert.equal(statSync(rm).mode & 0o777, 0o640, "…and the file mode is kept");
  assert.deepEqual(
    readdirSync(d).filter((n) => n.startsWith("ROADMAP.md.")),
    [],
    "…and no temp file is left",
  );
});

// Many writers at once: every row's update survives
test("parallel --set loses no row", async () => {
  const rows: string[] = [];
  for (let i = 1; i <= 12; i++) rows.push(`| R${i} | f${i} | i | s | — | planned | — |`);
  const d = mk("par", ...rows);
  const codes = await Promise.all(
    rows.map(
      (_, i) =>
        new Promise<number | null>((res) => {
          const c = spawn(process.execPath, [...NODE_ARGS, d, "--set", `R${i + 1}`, "in-progress"], {
            stdio: "ignore",
          });
          c.once("exit", (code) => res(code));
        }),
    ),
  );
  assert.deepEqual(codes, Array(12).fill(0), "every writer exits 0");
  assert.equal(grepLines(read(join(d, "ROADMAP.md")), /\| in-progress \|/, true).length, 12, "parallel --set loses no row");
});
