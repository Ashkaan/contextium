// check-decision-records.test.ts — boundary rows for check-decision-records.ts:
// each of the seven parts, the no-args scan (changed, untracked, nested,
// deleted, renamed, committed-sibling collisions), --since, directory walks
// and caller errors.
//
// Run: node --test --experimental-strip-types .agents/checks/check-decision-records.test.ts
//
// Every fixture lives in a real `git init`-ed repo, because the no-args mode
// reads `git diff HEAD` and `git ls-files --others`; a bare scratch directory
// cannot reach it. The fixtures are written by `rec()` below, so the records
// under test are the ones in this file. The program is SPAWNED, never
// imported, with HOME pointed at a scratch folder so no run reads the real
// home's git config.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-decision-records.ts");
const TMP = mkdtempSync(join(tmpdir(), "decision-records-test-"));
const HOME = join(TMP, "home");
mkdirSync(HOME);
after(() => rmSync(TMP, { recursive: true, force: true }));

let REPO = "";
let n = 0;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME },
  });
}

/** A fresh repo with one baseline commit. */
function newrepo(): void {
  n += 1;
  REPO = join(TMP, `repo${n}`);
  mkdirSync(REPO, { recursive: true });
  // `symbolic-ref`, not `init -b`: older git has no `-b`.
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "tester");
  writeFileSync(join(REPO, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
}

function commitAll(msg: string): void {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
}

function write(rel: string, body: string): void {
  const p = join(REPO, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** Rewrite a record in place. */
function edit(rel: string, fn: (s: string) => string): void {
  const p = join(REPO, rel);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}

/** A record, valid unless told otherwise. `null` omits a key entirely; an
 *  empty string writes it blank. */
function rec(
  rel: string,
  status: string | null = "accepted",
  date: string | null = "2026-09-22",
  dm: string | null = "Pat Doe",
): void {
  const lines = ["---"];
  if (status !== null) lines.push(`status: ${status}`);
  if (date !== null) lines.push(`date: ${date}`);
  if (dm !== null) lines.push(`decision-makers: ${dm}`);
  lines.push(
    "---",
    "",
    "# A decision",
    "",
    "## Context and Problem Statement",
    "",
    "Something forced a choice.",
    "",
    "## Considered Options",
    "",
    "* One",
    "* Two",
    "",
    "## Decision Outcome",
    "",
    'Chosen option: "One", because it works.',
    "",
    'Pat Doe 2026-09-22: "agreed"',
  );
  write(rel, `${lines.join("\n")}\n`);
}

const dropApproval = (s: string): string => s.replace(/^Pat Doe 2026-09-22.*\n/m, "");

interface Run {
  out: string;
  err: string;
  rc: number | null;
}

/** Runs the check from `cwd` (the repo by default). */
function run(args: string[] = [], cwd = REPO): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME },
  });
  if (r.error) throw r.error;
  return { out: r.stdout, err: r.stderr, rc: r.status };
}

test("explicit files: one case per part", async (t) => {
  newrepo();
  let r: Run;

  rec("decisions/0001-clean.md");
  r = run(["decisions/0001-clean.md"]);
  await t.test("clean record", () => assert.equal(r.rc, 0));
  await t.test("clean record reports its count", () => assert.match(r.out, /OK — 1 decision record\(s\) checked/));

  write("decisions/0002-no-fm.md", "# No frontmatter\n\nBody.\n");
  r = run(["decisions/0002-no-fm.md"]);
  await t.test("missing frontmatter", () => assert.equal(r.rc, 1));
  await t.test("missing frontmatter is part (a)", () =>
    assert.ok(r.err.includes("decisions/0002-no-fm.md: (a) no frontmatter"), r.err),
  );

  write("decisions/0003-empty.md", "");
  r = run(["decisions/0003-empty.md"]);
  await t.test("zero-byte record", () => assert.equal(r.rc, 1));
  await t.test("zero-byte record is part (a)", () =>
    assert.ok(r.err.includes("decisions/0003-empty.md: (a) no frontmatter"), r.err),
  );

  write("decisions/0004-unclosed.md", "---\nstatus: proposed\ndate: 2026-09-22\n");
  r = run(["decisions/0004-unclosed.md"]);
  await t.test("unclosed frontmatter", () => assert.equal(r.rc, 1));
  await t.test("unclosed frontmatter is part (a)", () =>
    assert.ok(r.err.includes("(a) frontmatter is never closed"), r.err),
  );

  rec("decisions/0005-no-dm.md", "accepted", "2026-09-22", null);
  r = run(["decisions/0005-no-dm.md"]);
  await t.test("missing decision-makers key", () => assert.equal(r.rc, 1));
  await t.test("a missing key is part (a), not unassigned", () =>
    assert.ok(r.err.includes("(a) missing required key: decision-makers"), r.err),
  );

  rec("decisions/0006-no-status.md", null);
  r = run(["decisions/0006-no-status.md"]);
  await t.test("missing status key", () => assert.equal(r.rc, 1));
  await t.test("missing status is part (a)", () =>
    assert.ok(r.err.includes("(a) missing required key: status"), r.err),
  );

  rec("decisions/0007-decided.md", "decided");
  r = run(["decisions/0007-decided.md"]);
  await t.test("status outside the vocabulary", () => assert.equal(r.rc, 1));
  await t.test("bad status word is part (b)", () =>
    assert.ok(r.err.includes("decisions/0007-decided.md: (b) status 'decided'"), r.err),
  );

  rec("decisions/0008-bare.md", "superseded by 0001");
  r = run(["decisions/0008-bare.md"]);
  await t.test("superseded by a bare number", () => assert.equal(r.rc, 1));
  await t.test("bare-number supersession is part (b)", () =>
    assert.ok(r.err.includes("(b) status 'superseded by 0001'"), r.err),
  );

  rec("decisions/0009-by-path.md", "superseded by decisions/0001-clean.md");
  r = run(["decisions/0009-by-path.md"]);
  await t.test("superseded by a repo path", () => assert.equal(r.rc, 0, r.err));

  rec("decisions/0010-nested-path.md", "superseded by projects/web/x/decisions/0002-foo.md");
  r = run(["decisions/0010-nested-path.md"]);
  await t.test("superseded by a nested decisions path", () => assert.equal(r.rc, 0, r.err));

  for (const bad of [
    "/tmp/decisions/0001-clean.md",
    "../decisions/0001-clean.md",
    "projects/../decisions/0001-clean.md",
    "~/decisions/0001-clean.md",
    "./decisions/0001-clean.md",
  ]) {
    rec("decisions/0026-outside.md", `superseded by ${bad}`);
    r = run(["decisions/0026-outside.md"]);
    await t.test(`superseded by a path that is not repo-relative: ${bad}`, () => assert.equal(r.rc, 1));
    await t.test(`…is part (b): ${bad}`, () => assert.ok(r.err.includes(`(b) status 'superseded by ${bad}'`), r.err));
  }
  rmSync(join(REPO, "decisions/0026-outside.md"));

  rec("decisions/0011-quoted.md", '"accepted"');
  r = run(["decisions/0011-quoted.md"]);
  await t.test("a quoted status value parses", () => assert.equal(r.rc, 0, r.err));

  rec("decisions/0024-unclosed.md", '"accepted');
  r = run(["decisions/0024-unclosed.md"]);
  await t.test("an unclosed quote on status", () => assert.equal(r.rc, 1));
  await t.test("unclosed quote is part (a)", () =>
    assert.ok(r.err.includes("decisions/0024-unclosed.md: (a) status has an unclosed quote"), r.err),
  );

  rec("decisions/0025-unclosed-dm.md", "accepted", "2026-09-22", "'Pat Doe");
  r = run(["decisions/0025-unclosed-dm.md"]);
  await t.test("an unclosed quote on decision-makers", () => assert.equal(r.rc, 1));
  await t.test("…is part (a) too", () => assert.ok(r.err.includes("(a) decision-makers has an unclosed quote"), r.err));

  rec("decisions/0027-escaped.md", "accepted", "2026-09-22", '"Pat Doe\\"');
  r = run(["decisions/0027-escaped.md"]);
  await t.test("an escaped closing quote on decision-makers", () => assert.equal(r.rc, 1));
  await t.test("…is an unclosed quote, part (a)", () =>
    assert.ok(r.err.includes("(a) decision-makers has an unclosed quote"), r.err),
  );

  rec("decisions/0028-comment.md", '"accepted" # after review', "2026-09-22", "'Pat O''Brien'");
  r = run(["decisions/0028-comment.md"]);
  await t.test("a comment after a closed quote, and a doubled single quote", () => assert.equal(r.rc, 0, r.err));

  rec("decisions/0029-trailing.md", '"accepted" and then some');
  r = run(["decisions/0029-trailing.md"]);
  await t.test("text after a closed quote", () => assert.equal(r.rc, 1));
  await t.test("…is part (a)", () => assert.ok(r.err.includes("(a) status has text after its closing quote"), r.err));

  rec("decisions/0012-short-date.md", "accepted", "2026-9-1");
  r = run(["decisions/0012-short-date.md"]);
  await t.test("malformed date", () => assert.equal(r.rc, 1));
  await t.test("malformed date is part (c)", () => assert.ok(r.err.includes("(c) date '2026-9-1'"), r.err));

  rec("decisions/0013-feb30.md", "accepted", "2026-02-30");
  r = run(["decisions/0013-feb30.md"]);
  await t.test("a date that does not exist", () => assert.equal(r.rc, 1));
  await t.test("impossible date is part (c)", () => assert.ok(r.err.includes("(c) date '2026-02-30'"), r.err));

  rec("decisions/0014-blank-dm.md", "accepted", "2026-09-22", "");
  r = run(["decisions/0014-blank-dm.md"]);
  await t.test("blank decision-makers", () => assert.equal(r.rc, 1));
  await t.test("blank decision-makers is part (d)", () =>
    assert.ok(r.err.includes("(d) decision-makers is empty"), r.err),
  );

  rec("decisions/0015-empty-list.md", "accepted", "2026-09-22", "[]");
  r = run(["decisions/0015-empty-list.md"]);
  await t.test("decision-makers as an empty list", () => assert.equal(r.rc, 1));
  await t.test("empty list is part (d)", () => assert.ok(r.err.includes("(d) decision-makers is empty"), r.err));

  rec("decisions/0016-block-list.md", "accepted", "2026-09-22", "");
  edit("decisions/0016-block-list.md", (s) => s.replace(/^decision-makers: $/m, "decision-makers:\n  - Pat Doe"));
  r = run(["decisions/0016-block-list.md"]);
  await t.test("decision-makers as a block list", () => assert.equal(r.rc, 0, r.err));

  rec("decisions/no-number.md");
  r = run(["decisions/no-number.md"]);
  await t.test("filename without NNNN", () => assert.equal(r.rc, 1));
  await t.test("missing number is part (e)", () =>
    assert.ok(r.err.includes("decisions/no-number.md: (e) filename"), r.err),
  );

  rec("decisions/0017-Mixed_Case.md");
  r = run(["decisions/0017-Mixed_Case.md"]);
  await t.test("filename not lowercase-with-dashes", () => assert.equal(r.rc, 1));
  await t.test("bad title is part (e)", () =>
    assert.ok(r.err.includes("(e) filename must be NNNN-title-with-dashes.md"), r.err),
  );

  rec("decisions/0018-no-quote.md");
  edit("decisions/0018-no-quote.md", dropApproval);
  r = run(["decisions/0018-no-quote.md"]);
  await t.test("accepted without a body quote", () => assert.equal(r.rc, 1));
  await t.test("missing approval quote is part (g)", () =>
    assert.ok(r.err.includes("decisions/0018-no-quote.md: (g) accepted"), r.err),
  );

  rec("decisions/0019-fm-quote.md");
  edit("decisions/0019-fm-quote.md", (s) =>
    dropApproval(s).replace(/^decision-makers: Pat Doe$/m, 'decision-makers: Pat Doe\nnote: "approved 2026-09-22"'),
  );
  r = run(["decisions/0019-fm-quote.md"]);
  await t.test("accepted whose only quote is in frontmatter", () => assert.equal(r.rc, 1));
  await t.test("frontmatter quote does not satisfy part (g)", () => assert.ok(r.err.includes("(g) accepted"), r.err));

  rec("decisions/0020-date-no-quote.md");
  edit("decisions/0020-date-no-quote.md", (s) =>
    s.replace(/^Pat Doe 2026-09-22: "agreed"$/m, "Pat Doe agreed on 2026-09-22."),
  );
  r = run(["decisions/0020-date-no-quote.md"]);
  await t.test("a dated line with no quoted words", () => assert.equal(r.rc, 1));
  await t.test("date alone is not part (g)", () => assert.ok(r.err.includes("(g) accepted"), r.err));

  rec("decisions/0023-quote-then-date.md");
  edit("decisions/0023-quote-then-date.md", (s) =>
    s.replace(/^Pat Doe 2026-09-22: "agreed"$/m, 'Someone asked "did we decide this?" (2026-09-19).'),
  );
  r = run(["decisions/0023-quote-then-date.md"]);
  await t.test("a quote dated AFTER it is not an approval", () => assert.equal(r.rc, 1));
  await t.test("quote-then-date is part (g)", () =>
    assert.ok(r.err.includes("0023-quote-then-date.md: (g) accepted"), r.err),
  );

  rec("decisions/0021-curly.md");
  edit("decisions/0021-curly.md", (s) => s.replace(/^Pat Doe 2026-09-22: "agreed"$/m, "Pat Doe 2026-09-22: “agreed”"));
  r = run(["decisions/0021-curly.md"]);
  await t.test("typographic quotes satisfy part (g)", () => assert.equal(r.rc, 0, r.err));

  rec("decisions/0022-proposed.md", "proposed");
  edit("decisions/0022-proposed.md", dropApproval);
  r = run(["decisions/0022-proposed.md"]);
  await t.test("proposed needs no approval quote", () => assert.equal(r.rc, 0, r.err));

  r = run(["decisions/does-not-exist.md"]);
  await t.test("nonexistent explicit path", () => assert.equal(r.rc, 2));
  await t.test("caller error names the path", () =>
    assert.ok(r.err.includes("not a file or directory: decisions/does-not-exist.md"), r.err),
  );
});

test("many records, several bad: every violation prints", async (t) => {
  newrepo();
  rec("decisions/0001-all-wrong.md", "decided", "2026-13-01", "");
  rec("decisions/0002-also-wrong.md");
  edit("decisions/0002-also-wrong.md", dropApproval);
  rec("decisions/0003-fine.md");
  const r = run(["decisions/0001-all-wrong.md", "decisions/0002-also-wrong.md", "decisions/0003-fine.md"]);
  await t.test("multi-violation run", () => assert.equal(r.rc, 1));
  await t.test("multi: (b) printed", () => assert.ok(r.err.includes("0001-all-wrong.md: (b)"), r.err));
  await t.test("multi: (c) printed", () => assert.ok(r.err.includes("0001-all-wrong.md: (c)"), r.err));
  await t.test("multi: (d) printed", () => assert.ok(r.err.includes("0001-all-wrong.md: (d)"), r.err));
  await t.test("multi: the second file's (g) printed too", () =>
    assert.ok(r.err.includes("0002-also-wrong.md: (g)"), r.err),
  );
  await t.test("multi: exactly four violation lines", () =>
    assert.equal(r.err.split("\n").filter((l) => /: \([a-g]\) /.test(l)).length, 4),
  );
  await t.test("multi: stdout carries the one summary line", () =>
    assert.equal(r.out, "FAIL — 3 decision record(s) checked, 4 violation(s)\n"),
  );
});

test("directory arguments", async (t) => {
  newrepo();
  rec("decisions/0001-one.md");
  rec("projects/x/decisions/0001-nested.md");
  write("decisions/README.md", "# Decision records\n");
  write("projects/x/notes.md", "not a record\n");
  let r = run(["decisions/"]);
  await t.test("a directory argument is walked", () => assert.equal(r.rc, 0, r.err));
  await t.test("directory walk skips README.md", () => assert.match(r.out, /OK — 1 decision record\(s\) checked/));
  r = run(["."]);
  await t.test("the repo root is walked at any depth", () => assert.equal(r.rc, 0, r.err));
  await t.test("root walk finds nested records and ignores other markdown", () =>
    assert.match(r.out, /OK — 2 decision record\(s\) checked/),
  );

  rec("projects/x/decisions/oops.md");
  r = run(["."]);
  await t.test("a directory walk still applies part (e)", () => assert.equal(r.rc, 1));
  await t.test("misnamed record inside a walked folder is part (e)", () =>
    assert.ok(r.err.includes("projects/x/decisions/oops.md: (e)"), r.err),
  );
});

test("no arguments", async (t) => {
  newrepo();
  let r = run();
  await t.test("no changes at all", () => assert.equal(r.rc, 0, r.err));
  await t.test("nothing to check still prints one line", () =>
    assert.equal(r.out, "OK — 0 decision record(s) checked\n"),
  );

  rec("decisions/0001-brand-new.md");
  write("decisions/README.md", "# Decision records\n");
  r = run();
  await t.test("a brand-new decisions/ folder is scanned file by file", () => assert.equal(r.rc, 0, r.err));
  await t.test("untracked record found, README ignored", () =>
    assert.match(r.out, /OK — 1 decision record\(s\) checked/),
  );

  edit("decisions/0001-brand-new.md", (s) => s.replace(/^status: accepted$/m, "status: decided"));
  r = run();
  await t.test("a bad untracked record fails the no-args scan", () => assert.equal(r.rc, 1));
  await t.test("no-args reports the repo-relative path", () =>
    assert.ok(r.err.includes("decisions/0001-brand-new.md: (b)"), r.err),
  );

  r = run([], join(REPO, "decisions"));
  await t.test("no-args from a subdirectory still scans from the repo root", () => assert.equal(r.rc, 1));

  newrepo();
  rec("decisions/0001-kept.md");
  rec("decisions/0002-unrelated.md", "decided");
  commitAll("records");
  r = run();
  await t.test("a committed bad record is not this close's problem", () => assert.equal(r.rc, 0, r.err));
  await t.test("clean tree checks nothing", () => assert.match(r.out, /OK — 0 decision record\(s\) checked/));

  rec("decisions/0001-collides.md");
  r = run();
  await t.test("a new 0001 beside a COMMITTED 0001", () => assert.equal(r.rc, 1));
  await t.test("collision reported against the new file", () =>
    assert.ok(r.err.includes("decisions/0001-collides.md: (f) number 0001 is also used by 0001-kept.md"), r.err),
  );
  await t.test("…and against the committed sibling", () =>
    assert.ok(r.err.includes("decisions/0001-kept.md: (f) number 0001 is also used by 0001-collides.md"), r.err),
  );
  await t.test("the committed bad sibling is not swept in", () =>
    assert.ok(!r.err.includes("0002-unrelated.md"), r.err),
  );
  rmSync(join(REPO, "decisions/0001-collides.md"));

  rec("projects/y/decisions/0001-nested-new.md");
  r = run();
  await t.test("a changed record in a nested decisions/ is found", () => assert.equal(r.rc, 0, r.err));
  await t.test("nested record counted", () => assert.match(r.out, /OK — 1 decision record\(s\) checked/));
  rmSync(join(REPO, "projects"), { recursive: true });

  edit("decisions/0001-kept.md", (s) => s.replace(/^Chosen option: "One"/m, 'Chosen option: "Two"'));
  r = run();
  await t.test("a modified tracked record is checked", () => assert.equal(r.rc, 0, r.err));
  await t.test("modified record counted", () => assert.match(r.out, /OK — 1 decision record\(s\) checked/));
  git("checkout", "-q", "--", "decisions/0001-kept.md");

  git("rm", "-q", "decisions/0002-unrelated.md");
  r = run();
  await t.test("a deleted record in the changed set is skipped", () => assert.equal(r.rc, 0, r.err));
  await t.test("deleted record not counted", () => assert.match(r.out, /OK — 0 decision record\(s\) checked/));
  git("reset", "-q", "--hard");

  git("mv", "decisions/0001-kept.md", "decisions/0001-kept-renamed.md");
  r = run();
  await t.test("a staged rename within one folder", () => assert.equal(r.rc, 0, r.err));
  await t.test("rename counts the new path once", () => assert.match(r.out, /OK — 1 decision record\(s\) checked/));
  git("reset", "-q", "--hard");

  // A staged move to a WIDER home. Porcelain -z carries the origin as a second
  // field with no status prefix; read as an entry, `xy/decisions/0003-sub.md`
  // loses three characters and becomes the destination path, counted twice.
  rec("xy/decisions/0003-sub.md");
  commitAll("sub record");
  git("mv", "xy/decisions/0003-sub.md", "decisions/0003-sub.md");
  r = run();
  await t.test("a staged move out of a narrower home", () => assert.equal(r.rc, 0, r.err));
  await t.test("the rename origin is not read as an entry", () =>
    assert.match(r.out, /OK — 1 decision record\(s\) checked/),
  );
  git("reset", "-q", "--hard");

  mkdirSync(join(REPO, "projects/z/decisions"), { recursive: true });
  renameSync(join(REPO, "decisions/0001-kept.md"), join(REPO, "projects/z/decisions/0001-kept.md"));
  r = run();
  await t.test("an unstaged move to a narrower home", () => assert.equal(r.rc, 0, r.err));
  await t.test("move counts only the new path", () => assert.match(r.out, /OK — 1 decision record\(s\) checked/));
});

// --since: a record already COMMITTED on this branch — the loop commits
// before its close — differs from nothing at HEAD, so only --since sees it.
test("--since", async (t) => {
  newrepo();
  rec("decisions/0004-old.md", "decided");
  commitAll("a bad record from before this branch");
  git("checkout", "-q", "-b", "work");
  rec("decisions/0001-committed.md", "decided");
  commitAll("a committed bad record");
  let r = run();
  await t.test("a committed record is invisible without --since", () => assert.equal(r.rc, 0, r.err));
  r = run(["--since", "main"]);
  await t.test("--since finds a record committed on the branch", () => assert.equal(r.rc, 1));
  await t.test("…and names its part", () => assert.ok(r.err.includes("decisions/0001-committed.md: (b)"), r.err));
  rec("decisions/0002-uncommitted.md");
  r = run(["--since", "main"]);
  await t.test("--since still counts uncommitted records too", () =>
    assert.match(r.out, /FAIL — 2 decision record\(s\) checked/),
  );

  // Park the uncommitted record, move the trunk on, and bring it back.
  const parked = readFileSync(join(REPO, "decisions/0002-uncommitted.md"), "utf8");
  rmSync(join(REPO, "decisions/0002-uncommitted.md"));
  git("checkout", "-q", "main");
  edit("decisions/0004-old.md", (s) => `${s}trunk edit\n`);
  commitAll("the trunk edits an old record after the branch left it");
  git("checkout", "-q", "work");
  write("decisions/0002-uncommitted.md", parked);
  r = run(["--since", "main"]);
  await t.test("the trunk-only case still fails on the branch's own record", () => assert.equal(r.rc, 1));
  await t.test("…which it still reports", () => assert.ok(r.err.includes("decisions/0001-committed.md: (b)"), r.err));
  await t.test("a record only the TRUNK changed is not this branch's (merge base, not main)", () =>
    assert.ok(!r.err.includes("0004-old.md"), r.err),
  );

  r = run(["--since", "no-such-ref"]);
  await t.test("--since an unknown ref is a caller error", () => assert.equal(r.rc, 2));
  await t.test("…with git's own reason kept, not swallowed", () =>
    assert.ok(r.err.includes("Not a valid object name no-such-ref"), r.err),
  );

  git("checkout", "-q", "--orphan", "unrelated");
  git("commit", "-q", "-m", "no shared history");
  r = run(["--since", "work"]);
  await t.test("--since a ref with no shared history is a caller error", () => assert.equal(r.rc, 2));
  await t.test("…and says so", () => assert.ok(r.err.includes("cannot find where HEAD left work"), r.err));
  git("checkout", "-q", "-f", "work");

  r = run(["--since"]);
  await t.test("--since with no ref is a caller error", () => assert.equal(r.rc, 2));
  r = run(["--since", "main", "decisions/"]);
  await t.test("--since with paths is a caller error", () => assert.equal(r.rc, 2));
});

// A scan git cannot make is an error, never a clean "0 checked": a changed
// record would otherwise go unread.
test("a scan git cannot make", async (t) => {
  newrepo();
  rec("decisions/0001-changed.md");
  writeFileSync(join(REPO, ".git/index"), "garbage\n");
  let r = run();
  await t.test("a git diff that fails is a caller error, not a clean scan", () => assert.equal(r.rc, 2));
  await t.test("…and names the git command", () => assert.ok(r.err.includes("git diff"), r.err));

  const outside = join(TMP, "not-a-repo");
  mkdirSync(outside, { recursive: true });
  r = run([], outside);
  await t.test("no-args outside a git work tree", () => assert.equal(r.rc, 2));
});
