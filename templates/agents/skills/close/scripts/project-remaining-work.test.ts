// project-remaining-work.test.ts — covers the veto signals (a spec still owed
// work, an open ROADMAP row, a missing or unreadable ROADMAP.md) and the clean
// no-hard-signal case that lets /close step-2.1 flip a finished project.
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
const RM_HDR = `| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|`;
const touch = (p: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "");
};
/** A project with a README and a header-only ROADMAP.md. */
function mkproj(folder: string, status: string): string {
  const dir = join(TMP, "projects/web", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `---\nstatus: ${status}\n---\n# project\n`);
  writeFileSync(join(dir, "ROADMAP.md"), `# Roadmap: t\n\n${RM_HDR}\n`);
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

// 1. A spec still owed work → work-remains (the deterministic veto).
test("pending spec", () => {
  const d = mkproj("2026-01-01_pending-spec", "active");
  touch(join(d, "specs/001-foo/spec.md"));
  const { out } = gen(d);
  assert.equal(field("verdict", out), "work-remains", "pending-spec-verdict");
  assert.equal(field("unreported_specs", out), "1", "pending-spec-count");
});

// 2. Every spec reported, no open row → no-hard-signal (flip candidate).
test("all reported", () => {
  const d = mkproj("2026-02-02_all-reported", "active");
  touch(join(d, "specs/001-foo/spec.md"));
  writeFileSync(join(d, "specs/001-foo/report.md"), "---\nspec: 001-foo\nspec-status: complete\n---\n");
  const { out } = gen(d);
  assert.equal(field("verdict", out), "no-hard-signal", "all-reported-verdict");
  assert.equal(field("unreported_specs", out), "0", "all-reported-specs");
});

// 3. The README sections the ROADMAP replaced are not read: an open shard row
//    or an unchecked Next Steps box beside a clean ROADMAP.md prints nothing,
//    and the verdict is the rows'.
test("old-layout README sections are not read", () => {
  const d = mkproj("2026-03-03_old-sections", "active");
  append(
    d,
    "## Shard Status",
    "",
    "| Shard | State |",
    "|---|---|",
    "| alpha | in-flight |",
    "",
    "## Next Steps",
    "",
    "- [ ] wire the dashboard",
    "1. a numbered item",
  );
  mkroadmap(d, "| R1 | a | i | s | — | done | — |");
  const { out } = gen(d);
  assert.equal(
    out
      .split("\n")
      .filter((l) => /^(shard|next_steps|todo:|unparsed:)/.test(l))
      .join("\n"),
    "",
    "no shard, next_steps, todo or unparsed line",
  );
  assert.equal(field("verdict", out), "no-hard-signal", "the verdict is the rows'");
});

// 4. Status is echoed verbatim for the caller's gate.
test("status-echo", () => {
  const d = mkproj("2026-07-07_monitoring", "monitor");
  assert.equal(field("status", gen(d).out), "monitor");
});

// 5. Missing README → exit 2, not a silent pass.
test("missing-readme-exit2", () => {
  const d = join(TMP, "projects/web/2026-08-08_no-readme");
  mkdirSync(d, { recursive: true });
  assert.equal(gen(d).rc, 2);
});

// ── ROADMAP.md projects ─────────────────────────────────────────────
const mkroadmap = (d: string, ...rows: string[]): void =>
  writeFileSync(join(d, "ROADMAP.md"), `# Roadmap: t\n\n${RM_HDR}\n${rows.map((r) => `${r}\n`).join("")}`);
const roadmapLines = (out: string, prefix: string): string =>
  out
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .join("\n");

// No ROADMAP.md is reported, and vetoes completion: the project's one list of
// outstanding work is missing, not empty.
test("no ROADMAP.md is work-remains", () => {
  const d = mkproj("2026-09-01_no-roadmap", "active");
  rmSync(join(d, "ROADMAP.md"));
  const { out } = gen(d);
  assert.equal(field("roadmap-error", out), "no ROADMAP.md", "names the missing file");
  assert.equal(field("verdict", out), "work-remains", "vetoes completion");
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

// Open rows — planned, blocked watch, unknown status — are named; done,
// absorbed and closed are not.
test("rm-open", () => {
  const d = mkproj("2026-09-03_rm-open", "active");
  mkroadmap(
    d,
    "| R1 | a | i | s | — | done | — |",
    "| R2 | b | i | s | — | absorbed by R1 | — |",
    "| R3 | c | i | s | — | planned | — |",
    "| R4 | d | i | s | — | blocked: 2026-10-02 | — |",
    "| R5 | e | i | s | — | waiting on the vendor | — |",
    "| R6 | f | i | s | — | closed: superseded | — |",
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
  touch(join(d, "specs/001-a/spec.md"));
  assert.equal(field("spec", gen(d).out), "specs/001-a none");
});
