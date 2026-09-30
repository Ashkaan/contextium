// Rows for check-standards-refs.ts: a citation that names a bullet passes, one
// that names nothing fails with its file and line, the retired rule-id form
// fails, history folders only count, and --cached reads the staged copies.
// Fixtures are throwaway git repos. The citation strings are assembled at run
// time so this file does not itself cite anything.
//
// Run: node --test --experimental-strip-types .agents/checks/check-standards-refs.test.ts

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = join(import.meta.dirname, "check-standards-refs.ts");
const TMP = mkdtempSync(join(tmpdir(), "check-standards-refs-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const A = "→";
const CITE = `AGENTS.md § Standards ${A}`;
const RETIRED = "@" + "rule:";

const AGENTS_MD = `# AGENTS.md

<!-- contextium:standards -->
## Standards

- **Read before asserting.** A claim needs a reading.
- **Fix the cause.** Not the symptom.
- **A gate you can't pass is not a bug.** Ask.
- **Data is fetched, judgment is prompted.** A name with a comma.
- **A decision that would be expensive to reverse gets a record** in the narrowest folder.
<!-- /contextium -->

## Ours

- **Deploy on Fridays.** Our own standard, outside the block.
`;

function g(repo: string, ...args: string[]): void {
  const p = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(p.status, 0, `git ${args.join(" ")}: ${p.stderr}`);
}
let n = 0;
function newrepo(layer: string): string {
  n++;
  const repo = join(TMP, `r${n}`);
  mkdirSync(join(repo, layer), { recursive: true });
  g(repo, "init", "-q");
  writeFileSync(join(repo, layer, "AGENTS.md"), AGENTS_MD);
  g(repo, "add", `${layer}/AGENTS.md`);
  return repo;
}
function add(repo: string, rel: string, body: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), `${body}\n`);
  g(repo, "add", rel);
}
function run(repo: string, ...args: string[]): { rc: number | null; out: string } {
  const p = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  return { rc: p.status, out: `${p.stdout}${p.stderr}` };
}
function has(name: string, out: string, want: string): void {
  assert.ok(out.includes(want), `${name} — output lacks '${want}':\n${out}`);
}

test("citations that name bullets pass, and say how many were read", () => {
  const repo = newrepo(".agents");
  add(repo, "skills/a.md", `See \`${CITE} Read before asserting\`, and ${CITE} Fix the cause.`);
  add(repo, "skills/b.sh", `# per ${CITE} a gate you can't pass is not a bug (case does not matter)`);
  add(repo, "skills/c.md", `User bullets count: ${CITE} Deploy on Fridays.`);
  add(repo, "skills/d.md", `The form is \`${CITE} <name>\` — a placeholder is not a citation.`);
  add(
    repo,
    "skills/f.md",
    `${CITE} Data is fetched, judgment is prompted — and ${CITE} A decision that would be expensive to reverse gets a record.`,
  );
  const r = run(repo);
  assert.equal(r.rc, 0, `citations that name bullets:\n${r.out}`);
  has("…and it says how many it read (the placeholder is not one)", r.out, "OK — 6 citation(s) checked");

  add(repo, "skills/e.md", `line one\nsee ${CITE} Read before guessing.`);
  const bad = run(repo);
  assert.equal(bad.rc, 1, `a citation naming no bullet:\n${bad.out}`);
  has(
    "…names file, line and the name",
    bad.out,
    "skills/e.md:2: cites 'Read before guessing', which is no bullet in AGENTS.md § Standards",
  );
  add(repo, "skills/g.md", `${CITE} Fix the causes of things`);
  has("a name must end at a word boundary", run(repo).out, "skills/g.md:1: cites 'Fix the causes of things'");
});

test("the retired form fails and says what to write instead", () => {
  const repo = newrepo(".agents");
  add(repo, "skills/x.md", `per ${RETIRED}no-deferral`);
  const r = run(repo);
  assert.equal(r.rc, 1, `a retired rule-id citation:\n${r.out}`);
  has("…says what to write instead", r.out, `skills/x.md:1: ${RETIRED}no-deferral is retired`);
});

test("history is counted, not blocking", () => {
  const repo = newrepo(".agents");
  add(repo, "journal/2026-01-10/0930-x.md", `old: ${RETIRED}gone and ${CITE} Gone standard`);
  add(repo, "projects/web/2026-01-10_x/README.md", `${CITE} Also gone`);
  const r = run(repo);
  assert.equal(r.rc, 0, `stale citations in journal/ and projects/:\n${r.out}`);
  has("…are reported as information", r.out, "3 stale citation(s) in journal/ and projects/");
});

test("templates/agents/AGENTS.md is read in the repo that authors the layer", () => {
  const repo = newrepo("templates/agents");
  add(repo, "skills/a.md", `${CITE} Fix the cause`);
  const r = run(repo);
  assert.equal(r.rc, 0, r.out);
});

test("two bullets with one name are a violation", () => {
  const repo = newrepo(".agents");
  appendFileSync(join(repo, ".agents/AGENTS.md"), "- **Fix the cause.** Twice.\n");
  const r = run(repo);
  assert.equal(r.rc, 1, `two bullets with one name:\n${r.out}`);
  has("…is a violation", r.out, "two bullets named 'fix the cause'");
});

test("--cached reads what is staged", () => {
  const repo = newrepo(".agents");
  add(repo, "skills/a.md", `${CITE} Made up`);
  writeFileSync(join(repo, "skills/a.md"), `${CITE} Fix the cause\n`);
  assert.equal(run(repo, "--cached").rc, 1, "a bad staged citation behind a fixed working copy");
  assert.equal(run(repo).rc, 0, "…while the working copy alone passes");
  g(repo, "add", ".agents/AGENTS.md");
  const md = join(repo, ".agents/AGENTS.md");
  writeFileSync(md, readFileSync(md, "utf8").replace("Fix the cause", "Fix the root"));
  writeFileSync(join(repo, "skills/a.md"), `${CITE} Fix the cause\n`);
  g(repo, "add", "skills/a.md");
  const r = run(repo, "--cached");
  assert.equal(r.rc, 0, `the staged AGENTS.md is the one read:\n${r.out}`);
});

test("a repo without the layer passes; an unknown option is a caller error", () => {
  const repo = join(TMP, "none");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q");
  assert.equal(run(repo).rc, 0, "a repo without the layer");
  assert.equal(run(repo, "--bogus").rc, 2, "an unknown option");
});

// A grep or an index git cannot read is an error, never "no citations".
test("git cannot answer: an unreadable index or a failing grep exits 2", () => {
  const repo = newrepo(".agents");
  add(repo, "skills/a.md", `see ${CITE} Read before guessing.`);
  writeFileSync(join(repo, ".git/index"), "garbage\n");
  assert.equal(run(repo).rc, 2, "an unreadable index fails the scan instead of passing it");
  assert.equal(run(repo, "--cached").rc, 2, "…and so under --cached");
  const r2 = newrepo(".agents");
  add(r2, "skills/a.md", `see ${CITE} Read before asserting.`);
  assert.equal(
    run(r2, ":(bogus)skills").rc,
    2,
    "a git grep that fails (a pathspec it rejects) is an error, not zero citations",
  );
});
