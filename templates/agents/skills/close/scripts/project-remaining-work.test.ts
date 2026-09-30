// project-remaining-work.test.ts — covers the veto signals (un-reported SPEC,
// open shard row, unchecked Next Steps box) and the clean no-hard-signal case
// that lets /close step-2.1 flip a finished project.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/project-remaining-work.test.ts
//
// Every fixture is written by the test itself into a temporary folder; the
// script is spawned with --no-warnings so Node 22's type-stripping warning stays
// out of the output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const GEN = join(dirname(fileURLToPath(import.meta.url)), "project-remaining-work.ts");
const TMP = mkdtempSync(join(tmpdir(), "project-remaining-work-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function gen(d: string): { rc: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", GEN, d], { encoding: "utf8", timeout: 60_000 });
  return { rc: r.status, out: r.stdout.replace(/\n+$/, "") };
}
/** The value of the first `<key>: ` line. */
function field(key: string, out: string): string {
  for (const l of out.split("\n")) if (l.startsWith(`${key}: `)) return l.slice(key.length + 2);
  return "";
}
const touch = (p: string): void => writeFileSync(p, "");
function mkproj(folder: string, status: string): string {
  const dir = join(TMP, "projects/web", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `---\nstatus: ${status}\n---\n# project\n`);
  return dir;
}
const append = (d: string, ...lines: string[]): void =>
  appendFileSync(join(d, "README.md"), lines.map((l) => `${l}\n`).join(""));

// A spec scanner that crashed has not said every SPEC is reported: its status
// vetoes completion rather than reading as zero unreported SPECs.
test("a failed spec scan is work-remains", () => {
  const root = join(TMP, "crashed-scanner");
  const scripts = join(root, ".agents/skills/close/scripts");
  mkdirSync(scripts, { recursive: true });
  symlinkSync(join(dirname(GEN), "../../../packages"), join(root, ".agents/packages"));
  copyFileSync(GEN, join(scripts, "project-remaining-work.ts"));
  writeFileSync(join(scripts, "spec-state.ts"), 'process.stderr.write("spec-state: boom\\n");\nprocess.exit(3);\n');
  const d = mkproj("2026-01-01_crashed-scanner", "active");
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", join(scripts, "project-remaining-work.ts"), d], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(field("verdict", r.stdout), "work-remains", "a crashed spec scan vetoes completion");
  assert.equal(field("spec-state-error", r.stdout), "spec-state.ts exited 3", "…naming the scanner's failure");
  assert.match(r.stderr, /spec-state: boom/, "…and passing its stderr through");
});

// 1. Un-reported SPEC → work-remains (the deterministic veto).
test("pending spec", () => {
  const d = mkproj("2026-01-01_pending-spec", "active");
  touch(join(d, "foo.spec.md"));
  const { out } = gen(d);
  assert.equal(field("verdict", out), "work-remains", "pending-spec-verdict");
  assert.equal(field("unreported_specs", out), "1", "pending-spec-count");
});

// 2. Every SPEC reported, no Next Steps → no-hard-signal (flip candidate).
test("all reported", () => {
  const d = mkproj("2026-02-02_all-reported", "active");
  touch(join(d, "foo.spec.md"));
  touch(join(d, "foo-report.md"));
  const { out } = gen(d);
  assert.equal(field("verdict", out), "no-hard-signal", "all-reported-verdict");
  assert.equal(field("unreported_specs", out), "0", "all-reported-specs");
  assert.equal(field("next_steps_section", out), "no", "all-reported-next-steps");
});

// 3. Open shard row → work-remains even with every SPEC reported.
test("open shard", () => {
  const d = mkproj("2026-03-03_sharded", "active");
  for (const f of ["a.spec.md", "a-report.md", "b.spec.md", "b-report.md"]) touch(join(d, f));
  append(
    d,
    "## Shard Status",
    "",
    "| Shard | SPEC | Report | State |",
    "|---|---|---|---|",
    "| a | `a.spec.md` | `a-report.md` | closed |",
    "| b | `b.spec.md` | — | in-flight |",
  );
  const { out } = gen(d);
  assert.equal(field("verdict", out), "work-remains", "open-shard-verdict");
  assert.equal(field("shard_open", out), "1", "open-shard-count");
  assert.equal(field("shard", out), "b in-flight", "open-shard-row");
  assert.equal(field("shard_table", out), "yes", "shard-table-present");
});

// 4. All shard rows closed → no-hard-signal (header + separator not counted).
test("closed shards", () => {
  const d = mkproj("2026-04-04_shards-closed", "active");
  touch(join(d, "a.spec.md"));
  touch(join(d, "a-report.md"));
  append(
    d,
    "## Shard Status",
    "",
    "| Shard | SPEC | Report | State |",
    "|---|---|---|---|",
    "| a | `a.spec.md` | `a-report.md` | closed |",
    "| b | `b.spec.md` | `b-report.md` | dropped |",
  );
  const { out } = gen(d);
  assert.equal(field("verdict", out), "no-hard-signal", "closed-shards-verdict");
  assert.equal(field("shard_open", out), "0", "closed-shards-count");
});

// 5. Unchecked box under ## Next Steps → work-remains; checked ones ignored,
//    and a box in a LATER section does not leak in.
test("open todos", () => {
  const d = mkproj("2026-05-05_open-todos", "active");
  append(
    d,
    "## Next Steps",
    "",
    "- [x] shipped the parser",
    "- [ ] wire the dashboard",
    "",
    "## Notes",
    "",
    "- [ ] not a next step",
  );
  const { out } = gen(d);
  assert.equal(field("verdict", out), "work-remains", "open-todo-verdict");
  assert.equal(field("next_steps_unchecked", out), "1", "open-todo-count");
  assert.equal(field("todo", out), "wire the dashboard", "open-todo-text");
});

// 6. All boxes checked → no-hard-signal.
test("todos done", () => {
  const d = mkproj("2026-06-06_todos-done", "active");
  append(d, "## Next Steps", "", "- [x] shipped the parser", "- [x] wired the dashboard");
  const { out } = gen(d);
  assert.equal(field("verdict", out), "no-hard-signal", "done-todos-verdict");
  assert.equal(field("next_steps_unchecked", out), "0", "done-todos-count");
});

// 7. Status is echoed verbatim for the caller's gate.
test("status-echo", () => {
  const d = mkproj("2026-07-07_monitoring", "monitor");
  assert.equal(field("status", gen(d).out), "monitor");
});

// 8. Missing README → exit 2, not a silent pass.
test("missing-readme-exit2", () => {
  const d = join(TMP, "projects/web/2026-08-08_no-readme");
  mkdirSync(d, { recursive: true });
  assert.equal(gen(d).rc, 2);
});

// ── Backlogs that are not checkboxes ───────────────────────────────────
//
// Counting only unchecked boxes under a case-SENSITIVE heading clears projects that
// carry written backlogs, and misses one whose heading is "## Next steps". Each
// shape below is one of those cases.

// 9. A numbered backlog is real work, not an empty one.
test("numbered backlog", () => {
  const d = mkproj("2026-08-10_numbered", "active");
  append(d, "## Next Steps", "", "1. approve the wording", "2. watch two mornings");
  const { out } = gen(d);
  assert.equal(field("verdict", out), "work-remains", "numbered-verdict");
  assert.equal(field("next_steps_unparsed", out), "2", "numbered-unparsed");
  assert.equal(field("next_steps_unchecked", out), "0", "numbered-not-counted-as-boxes");
});

// 10. The heading matches whatever case the author used.
test("lowercase heading", () => {
  const d = mkproj("2026-08-10_lowercase", "active");
  append(d, "## Next steps", "", "- [ ] a real checkbox under a lowercase heading");
  const { out } = gen(d);
  assert.equal(field("next_steps_section", out), "yes", "lowercase-heading-section");
  assert.equal(field("verdict", out), "work-remains", "lowercase-heading-verdict");
});

// 11. Plain bullets and lettered items, in BOTH cases, all count.
test("bullets and letters", () => {
  const d = mkproj("2026-08-10_bullets", "active");
  append(d, "## Next Steps", "", "- a plain bullet", "a. a lowercase lettered item", "A. an uppercase lettered item");
  const { out } = gen(d);
  assert.equal(field("next_steps_unparsed", out), "3", "bullets-unparsed");
  assert.equal(field("verdict", out), "work-remains", "bullets-verdict");
});

// 12. It must NOT over-fire. Narrative prose with no list markers is not a backlog,
//     and pinning those projects active forever would make the veto useless the other way.
test("prose", () => {
  const d = mkproj("2026-08-10_prose", "active");
  append(d, "## Next Steps", "", "Nothing further. Watch it for a week and close.");
  const { out } = gen(d);
  assert.equal(field("verdict", out), "no-hard-signal", "prose-verdict");
  assert.equal(field("next_steps_unparsed", out), "0", "prose-unparsed");
});

// 13. A checked box is DONE — neither a todo nor unparsed.
test("checked boxes", () => {
  const d = mkproj("2026-08-10_checked", "active");
  append(d, "## Next Steps", "", "- [x] shipped", "- [X] also shipped");
  const { out } = gen(d);
  assert.equal(field("next_steps_unparsed", out), "0", "checked-unparsed");
  assert.equal(field("verdict", out), "no-hard-signal", "checked-verdict");
});

// 14. Mixed: an open box AND a numbered leftover are counted separately, both remain.
test("mixed", () => {
  const d = mkproj("2026-08-10_mixed", "active");
  append(d, "## Next Steps", "", "- [ ] a real box", "1. and a numbered leftover");
  const { out } = gen(d);
  assert.equal(field("next_steps_unchecked", out), "1", "mixed-unchecked");
  assert.equal(field("next_steps_unparsed", out), "1", "mixed-unparsed");
  assert.equal(field("verdict", out), "work-remains", "mixed-verdict");
});

// 15. A list under a DIFFERENT heading is not this section's backlog.
test("other section", () => {
  const d = mkproj("2026-08-10_other-section", "active");
  append(d, "## Next Steps", "", "- [x] done", "", "## Notes", "", "1. not a next step");
  const { out } = gen(d);
  assert.equal(field("next_steps_unparsed", out), "0", "other-section-unparsed");
  assert.equal(field("verdict", out), "no-hard-signal", "other-section-verdict");
});

// 16. Sub-bullets under a COMPLETED box are explanation, not backlog. Counting them
//     would pin a finished checklist work-remains forever — the same defect as
//     under-counting, pointed the other way.
test("nested under done", () => {
  const d = mkproj("2026-08-10_nested-under-done", "active");
  append(
    d,
    "## Next Steps",
    "",
    "- [x] shipped the parser",
    "  - it handles the fullwidth mark",
    "  - and the inverted one",
    "- [x] wired the dashboard",
    "  1. behind the feature flag",
  );
  const { out } = gen(d);
  assert.equal(field("next_steps_unparsed", out), "0", "nested-under-done-unparsed");
  assert.equal(field("verdict", out), "no-hard-signal", "nested-under-done-verdict");
});

// 17. A nested UNCHECKED box is still open work, at any depth.
test("nested open box", () => {
  const d = mkproj("2026-08-10_nested-open-box", "active");
  append(d, "## Next Steps", "", "- [x] the parent shipped", "  - [ ] but this child has not");
  const { out } = gen(d);
  assert.equal(field("next_steps_unchecked", out), "1", "nested-open-box-count");
  assert.equal(field("verdict", out), "work-remains", "nested-open-box-verdict");
});

// 18. All three markdown bullet markers are checkboxes, at any depth. Recognizing only
//     `-` and `*` meant a `+ [ ]` was not a box, and once unparsed narrowed to column
//     zero a NESTED one was counted as nothing at all.
test("plus boxes", () => {
  const d = mkproj("2026-08-10_plus-boxes", "active");
  append(d, "## Next Steps", "", "+ [ ] a top-level plus box", "- [x] a done parent", "  + [ ] a nested plus box");
  const { out } = gen(d);
  assert.equal(field("next_steps_unchecked", out), "2", "plus-box-count");
  assert.equal(field("next_steps_unparsed", out), "0", "plus-box-unparsed");
  assert.equal(field("verdict", out), "work-remains", "plus-box-verdict");
});

// 19. A completed `+ [x]` is done, same as its two siblings.
test("plus-done-verdict", () => {
  const d = mkproj("2026-08-10_plus-done", "active");
  append(d, "## Next Steps", "", "+ [x] shipped");
  assert.equal(field("verdict", gen(d).out), "no-hard-signal");
});

// ── ROADMAP.md projects ─────────────────────────────────────────────
const RM_HDR = `| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|`;
const mkroadmap = (d: string, ...rows: string[]): void =>
  writeFileSync(join(d, "ROADMAP.md"), `# Roadmap: t\n\n${RM_HDR}\n${rows.map((r) => `${r}\n`).join("")}`);
const roadmapLines = (out: string, prefix: string): string =>
  out
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .join("\n");

// A legacy project prints no roadmap lines at all.
test("legacy-no-roadmap-lines", () => {
  const d = mkproj("2026-09-01_no-roadmap", "active");
  assert.equal(roadmapLines(gen(d).out, "roadmap"), "");
});

// Header-only table: nothing open.
test("rm-empty", () => {
  const d = mkproj("2026-09-02_rm-empty", "active");
  mkroadmap(d);
  const { out } = gen(d);
  assert.equal(field("roadmap_table", out), "yes", "rm-empty-table");
  assert.equal(field("roadmap_open", out), "0", "rm-empty-open");
  assert.equal(field("verdict", out), "no-hard-signal", "rm-empty-verdict");
});

// Open rows — planned, blocked watch, unknown status — are named; done and
// absorbed are not.
test("rm-open", () => {
  const d = mkproj("2026-09-03_rm-open", "active");
  mkroadmap(
    d,
    "| R1 | a | i | s | — | done | — |",
    "| R2 | b | i | s | — | absorbed by R1 | — |",
    "| R3 | c | i | s | — | planned | — |",
    "| R4 | d | i | s | — | blocked: 2026-10-02 | — |",
    "| R5 | e | i | s | — | waiting on the vendor | — |",
  );
  const { out } = gen(d);
  assert.equal(field("roadmap_open", out), "3", "rm-open-count");
  assert.equal(
    roadmapLines(out, "roadmap: "),
    "roadmap: R3 planned\nroadmap: R4 blocked: 2026-10-02\nroadmap: R5 waiting on the vendor",
    "rm-open-rows",
  );
  assert.equal(field("verdict", out), "work-remains", "rm-open-verdict");
  assert.equal(out.split("\n").pop(), "verdict: work-remains", "rm-block-before-verdict");
});

// Every row done → no-hard-signal.
test("rm-done-verdict", () => {
  const d = mkproj("2026-09-04_rm-done", "active");
  mkroadmap(d, "| R1 | a | i | s | — | done | — |", "| R2 | b | i | s | — | absorbed by R1 | — |");
  assert.equal(field("verdict", gen(d).out), "no-hard-signal");
});

// Malformed table → roadmap-error and work-remains, never a completion.
test("rm-bad", () => {
  const d = mkproj("2026-09-05_rm-bad", "active");
  writeFileSync(join(d, "ROADMAP.md"), "# Roadmap: t\n\n| ID | Sub-feature |\n|---|---|\n| R1 | a |\n");
  const { out } = gen(d);
  assert.equal(field("roadmap-error", out), "no table under `# Roadmap` with ID and Status columns", "rm-bad-error");
  assert.equal(field("verdict", out), "work-remains", "rm-bad-verdict");
});

// A folder spec still owed work counts as an unreported spec.
test("rm-folder-spec", () => {
  const d = mkproj("2026-09-06_rm-folder", "active");
  mkroadmap(d, "| R1 | a | i | s | — | in-progress | `specs/001-a/` |");
  mkdirSync(join(d, "specs/001-a"), { recursive: true });
  touch(join(d, "specs/001-a/spec.md"));
  assert.equal(field("spec", gen(d).out), "specs/001-a none");
});

// A ROADMAP project ignores a leftover README ## Next Steps list: the roadmap
// is its one list of outstanding work.
test("rm-ignores-stale-next-steps", () => {
  const d = mkproj("2026-09-07_rm-stale-list", "active");
  mkroadmap(d, "| R1 | a | i | s | — | done | — |");
  append(d, "", "## Next Steps", "", "- [ ] an old todo", "1. an old numbered item");
  const { out } = gen(d);
  assert.equal(field("verdict", out), "no-hard-signal", "rm-ignores-next-steps-verdict");
  assert.equal(field("next_steps_section", out), "no", "rm-reports-no-next-steps-section");
  assert.equal(field("next_steps_unchecked", out), "0", "rm-counts-no-todos");
});
