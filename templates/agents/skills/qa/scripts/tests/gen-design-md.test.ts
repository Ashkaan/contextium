#!/usr/bin/env -S node --experimental-strip-types
// gen-design-md.test.ts — the generator, and the stub marker it now writes.
//
// The marker is the whole point of this suite. Before it existed, `/qa` wrote a
// token inventory on a repo's first run, treated that file as the app's sole
// design authority, ran four design-system checks against it, and reported clean
// forever — on an app nobody had designed. The cases below pin the two halves of
// the fix: every generated file says it is a stub, and a hand-written file is
// never touched. The scripts are spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/gen-design-md.test.ts
//
// peers:
//   .agents/skills/qa/scripts/gen-design-md.ts
//   .agents/skills/qa/scripts/design-authority.ts
//   .agents/skills/qa/scripts/design-frontmatter.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const GEN = join(SCRIPTS, "gen-design-md.ts");
const AUTHORITY = join(SCRIPTS, "design-authority.ts");
const FRONTMATTER = join(SCRIPTS, "design-frontmatter.ts");

const TMP = mkdtempSync(join(tmpdir(), "gen-design-md-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

interface Run {
  rc: number | null;
  out: string;
}
function run(script: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout + r.stderr };
}
const gen = (...args: string[]): Run => run(GEN, ...args);
const authority = (repo: string): Run => run(AUTHORITY, "status", repo);
const design = (repo: string): string => readFileSync(join(repo, "DESIGN.md"), "utf8");
const line = (repo: string, n: number): string => design(repo).split("\n")[n - 1];
const fontFamily = (repo: string): string =>
  design(repo)
    .split("\n")
    .find((l) => l.includes("fontFamily:")) ?? "";
const has = (hay: string, needle: string): void => assert.ok(hay.includes(needle), `missing '${needle}' in:\n${hay}`);
const lacks = (hay: string, needle: string): void =>
  assert.ok(!hay.includes(needle), `unexpected '${needle}' in:\n${hay}`);
/** Drop the marker line, as a human promoting the file would. */
const unmark = (repo: string): void =>
  writeFileSync(
    join(repo, "DESIGN.md"),
    design(repo)
      .split("\n")
      .filter((l) => !l.includes("design-authority: generated-stub"))
      .join("\n"),
  );

function repoWith(name: string, files: Record<string, string>): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return dir;
}
const THEME = `:root {
  --color-ink: #1b232c;
  --radius: 0.5rem;
}
body { font-family: 'Lexend Deca', system-ui, sans-serif; }
`;
const newRepo = (name: string): string => repoWith(name, { "theme.css": THEME });

// ── 1. A generated file declares itself a stub ────────────────────────────
{
  const repo = newRepo("generated");
  const r = gen(repo);
  test("the generator writes a file", () => assert.equal(r.rc, 0, r.out));
  test("carries the marker", () => has(design(repo), "design-authority: generated-stub"));
  test("on the first line of the frontmatter", () => assert.equal(line(repo, 2), "design-authority: generated-stub"));
  test("and says so in prose, where a human reads it", () => has(design(repo), "This is a stub"));
  test("it still extracts the tokens it always did", () => has(design(repo), "ink:"));

  // ── 2. And the authority check agrees ───────────────────────────────────
  const a = authority(repo);
  test("a generated file is not a design authority", () => assert.equal(a.rc, 3, a.out));
  test("for the stated reason", () => has(a.out, "AUTHORITY=stub"));
}

// ── 2b. A worktree is named after its repo, not its folder ──────────────
// /qa runs on thread worktrees whose folder is a thread id. The name comes from
// the shared checkout the worktree belongs to.
{
  const shared = newRepo("site-web.example.com");
  const git = (...a: string[]) => spawnSync("git", ["-C", shared, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const wt = join(TMP, "wt", "29188b12-511e-47da-a93f-94292c9fefad");
  git("worktree", "add", "-q", wt);
  const r = gen(wt);
  test("a worktree's file is written", () => assert.equal(r.rc, 0, r.out));
  test("and named after the repo the worktree belongs to", () => has(design(wt), "name: Site-Web"));
  test("not after the worktree's folder", () => lacks(design(wt), "29188b12"));

  // An app in a subdirectory keeps its own name.
  const nested = join(wt, "apps", "finance-portal");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "theme.css"), THEME);
  const n = gen(nested);
  test("a nested app's file is written", () => assert.equal(n.rc, 0, n.out));
  test("and named after its own folder, not the repo", () => has(design(nested), "name: Finance-Portal"));

  // `.` from inside the app is the same app.
  const dot = spawnSync(process.execPath, ["--experimental-strip-types", GEN, "--print", "."], {
    cwd: nested,
    encoding: "utf8",
  });
  test("`.` inside an app names that app", () => has(dot.stdout, "name: Finance-Portal"));
}

// ── 3. Removing the key is the claim that it is now real ──────────────────
// Only if the body also says something. The marker is limb one of the rule; a
// body with no contract headings is limb two, and deleting the key alone does
// not get past it.
{
  const repo = newRepo("promoted");
  gen(repo);
  unmark(repo);
  const unmarked = authority(repo);
  writeFileSync(join(repo, "DESIGN.md"), `${design(repo)}\n## Type\nA four-step ramp.\n\n## Focus\nOne ring.\n`);
  const promoted = authority(repo);
  test("deleting the key alone is not enough", () => assert.equal(unmarked.rc, 3, unmarked.out));
  test("because the body still declares no contract", () => has(unmarked.out, "declares no design contract"));
  test("a real contract plus no marker is a real authority", () => assert.equal(promoted.rc, 0, promoted.out));
  test("and it says so", () => has(promoted.out, "AUTHORITY=real"));
}

// ── 4. A hand-written file is never overwritten ───────────────────────────
const HANDWRITTEN = `---
name: Mine
colors:
  ink: "#000000"
---

# Design System: Mine

## Type
11 / 12 / 14 / 16 / 20 / 24.
`;
const REPO3 = newRepo("handwritten");
writeFileSync(join(REPO3, "DESIGN.md"), HANDWRITTEN);
{
  const r = gen(REPO3);
  test("the generator refuses an existing file", () => assert.equal(r.rc, 3, r.out));
  test("and leaves it byte-identical", () => assert.equal(design(REPO3), HANDWRITTEN));
}

// ── 5. --mark-existing backfills OUR files, and only ours ─────────────────
// The marker did not exist when most DESIGN.md files were written, so the whole
// affected population is unmarked. This is how they get marked — identified by
// the generator's own output shape, never by a guess about thinness.
{
  const repo = newRepo("backfill");
  gen(repo);
  unmark(repo);
  const first = gen("--mark-existing", repo);
  const markedLine = line(repo, 2);
  const second = gen("--mark-existing", repo);
  test("marks a file this generator wrote", () => assert.equal(first.rc, 0, first.out));
  test("says what it did", () => has(first.out, "marked"));
  test("and the key is back on line 2", () => assert.equal(markedLine, "design-authority: generated-stub"));
  test("marking twice is a no-op, not a second key", () => assert.equal(second.rc, 3, second.out));
  test("still exactly one marker", () =>
    assert.equal(
      design(repo)
        .split("\n")
        .filter((l) => l.includes("design-authority: generated-stub")).length,
      1,
    ));

  const refused = gen("--mark-existing", REPO3);
  test("refuses a hand-written file", () => assert.equal(refused.rc, 3, refused.out));
  test("and says why", () => has(refused.out, "not written by this generator"));
  test("leaving it byte-identical", () => assert.equal(design(REPO3), HANDWRITTEN));
}

// ── 5b. Sizes are emitted in the published DESIGN.md typography shape ─────
// google-labs-code/design.md allows only named entries carrying fontSize etc.
// under `typography`; a `scale:` map is flagged and ignored by its linter.
{
  const repo = repoWith("sized", {
    "theme.css": ":root {\n  --color-ink: #1b232c;\n  --text-sm: 14px;\n  --text-lg: 20px;\n}\n",
  });
  gen(repo);
  const fm = run(FRONTMATTER, repo).out;
  test("no scale map under typography", () => lacks(design(repo), "  scale:"));
  test("each size is a named typography entry", () => has(design(repo), "  text-sm:"));
  test("carrying its fontSize", () => has(design(repo), '    fontSize: "14px"'));
  test("and the drift reader still arms the type ramp from it", () => has(fm, "TYPE_SCALE=14px|20px"));
}

// ── 5c. A font-family inside an HTML template string is the stack, no more ─
// A real site's stub carried 200 characters of email markup as its body font:
// the scan stopped at the next `;`, which was lines later, and kept the
// attribute quote before the tag's `>`.
{
  const repo = repoWith("template-string", {
    "theme.css": ":root { --color-navy: #10274A; }\n",
    "notify.ts": [
      "const html = `<div style=\"background:#F7F8FA;padding:28px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif\">` +",
      '    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +',
      "    `</td></tr></table></div>`;",
      "export { html };",
      "",
    ].join("\n"),
  });
  gen(repo);
  test("a template-string font stack is the stack and nothing else", () =>
    assert.equal(
      fontFamily(repo),
      "    fontFamily: \"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif\"",
    ));
}

// ── 5d. A stack wrapped across lines is still the whole stack ──────────────
// A formatter breaks a long stack after a comma; a newline is not the end of
// the value.
{
  const repo = repoWith("wrapped-stack", {
    "theme.css":
      ':root { --color-navy: #10274A; }\nbody {\n  font-family:\n    "Inter",\n    system-ui,\n    sans-serif;\n}\n',
  });
  gen(repo);
  test("a wrapped stack keeps every family", () => has(fontFamily(repo), 'system-ui, sans-serif"'));
  test("and does not end at the first line break", () => lacks(fontFamily(repo), '"Inter","'));
}

// ── 5e. The value ends at an attribute's closing quote, not inside a family ─
// `style="font-family:Inter" data-x="foo"` has no `;` and no `>` before the
// next attribute; the quote after `Inter` closes the attribute, while the quote
// that opens 'Segoe UI' (after a comma) does not. Whitespace inside a quoted
// family is the family's own.
{
  const repo = repoWith("attribute-tail", {
    "theme.css": ':root { --color-navy: #10274A; }\nh1 { font-family: "Two  Spaces", serif; }\n',
    "notify.ts": 'const html = `<div style="font-family:Inter" data-x="foo">hi</div>`;\nexport { html };\n',
  });
  gen(repo);
  test("an attribute after the stack is not part of it", () => has(design(repo), '    fontFamily: "Inter"'));
  test("and no other attribute leaks in", () => lacks(design(repo), "data-x"));
  test("whitespace inside a quoted family is kept", () => has(design(repo), 'fontFamily: "\\"Two  Spaces\\", serif"'));
}

// ── 5f. An escaped quote is part of the family; a quote after trailing space closes ─
{
  const escaped = repoWith("escaped-quote", {
    "theme.css": ':root { --color-navy: #10274A; }\nh1 { font-family: "Franklin \\"Gothic\\"", serif; }\n',
  });
  gen(escaped);
  test("an escaped quote inside a family does not end the value", () => has(fontFamily(escaped), 'serif"'));
  const trailing = repoWith("trailing-space-attribute", {
    "theme.css": ":root { --color-navy: #10274A; }\n",
    "notify.ts": 'const html = `<div style="font-family:Arial " data-x="foo">hi</div>`;\nexport { html };\n',
  });
  gen(trailing);
  test("a closing quote after trailing space ends the value", () =>
    assert.equal(fontFamily(trailing), '    fontFamily: "Arial"'));
}

// ── 5g. An escaped attribute quote in a plain JS string ends the value too ─
{
  const repo = repoWith("escaped-attribute-quote", {
    "theme.css": ":root { --color-navy: #10274A; }\n",
    "notify.ts": 'const html = "<div style=\\"font-family:Arial\\">hi</div>";\nexport { html };\n',
  });
  gen(repo);
  test("a backslash-escaped closing quote ends the value without the backslash", () =>
    assert.equal(fontFamily(repo), '    fontFamily: "Arial"'));
}

// ── 6. No tokens at all is still a distinct outcome ───────────────────────
{
  const repo = join(TMP, "empty");
  mkdirSync(repo);
  const r = gen(repo);
  test("a repo with no tokens writes nothing", () => assert.equal(r.rc, 4, r.out));
  test("and leaves no file behind", () => {
    assert.deepEqual(readdirSync(repo), []);
    assert.ok(!existsSync(join(repo, "DESIGN.md")));
  });
}
