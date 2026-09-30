// Boundary rows for the helpers the app and integration indexes share: the
// repo root they resolve in both layouts, and the frontmatter values a README
// carries. The project index has its own suite, project-index.generate.test.ts.
// Run: node --test --experimental-strip-types templates/agents/generators/generators.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "./parse_frontmatter.ts";
import { repoRoot } from "./repo_root.ts";
import { oneLineCell } from "./table_cell.ts";

test("repoRoot: installed layout is two levels up", () => {
  const url = pathToFileURL("/r/.agents/generators/x.generate.ts").href;
  assert.equal(repoRoot(url), "/r");
});

test("repoRoot: authoring layout is three levels up", () => {
  const url = pathToFileURL("/r/templates/agents/generators/x.generate.ts").href;
  assert.equal(repoRoot(url), "/r");
});

test("parseFrontmatter: a quoted next: keeps its colon", () => {
  const fm = parseFrontmatter('---\nnext: "R3: checkout retries"\n---\n');
  assert.equal(fm?.next, "R3: checkout retries");
});

test("parseFrontmatter: a trailing comment is not part of the value", () => {
  const fm = parseFrontmatter("---\npriority: high   # required on active\ndescription: the #1 tool\n---\n");
  assert.equal(fm?.priority, "high");
  assert.equal(fm?.description, "the");
});

test("parseFrontmatter: a quoted value followed by a comment loses the quotes and the comment", () => {
  const fm = (body: string) => parseFrontmatter(`---\n${body}\n---\n`);
  assert.equal(fm('status: "active" # note')?.status, "active");
  assert.equal(fm("status: 'active'   # note")?.status, "active");
  assert.equal(fm('project: "issue #42" # tracked')?.project, "issue #42");
  assert.equal(fm('project: "say \\"hi\\"" # x')?.project, 'say "hi"');
  assert.equal(fm("project: 'it''s here' # x")?.project, "it's here");
  assert.equal(fm('project: "unclosed')?.project, '"unclosed');
});

test("parseFrontmatter: a folded scalar is literal text, so a # in it is not a comment", () => {
  const fm = (body: string) => parseFrontmatter(`---\n${body}\n---\n`);
  assert.equal(fm("next: >-\n  Fix parsing of # headings\n  in READMEs")?.next, "Fix parsing of # headings in READMEs");
  assert.equal(fm('d: >-\n  "whole"')?.d, '"whole"');
  assert.equal(fm("d: >- # why\n  a\n  b")?.d, "a b");
  assert.equal(fm("d: > # why\n  a")?.d, "a");
});

test("parseFrontmatter: YAML escapes are decoded once the closing quote is found", () => {
  const fm = (body: string) => parseFrontmatter(`---\n${body}\n---\n`);
  assert.equal(fm('p: "a\\\\b"')?.p, "a\\b");
  assert.equal(fm('p: "tab\\there"')?.p, "tab\there");
  assert.equal(fm("p: 'a backslash \\ stays'")?.p, "a backslash \\ stays");
  assert.equal(fm("p: 'x'''")?.p, "x'");
});

test("parseFrontmatter: a missing next: is undefined, not empty", () => {
  const fm = parseFrontmatter("---\nstatus: blocked\nblocked-on: vendor reply\n---\n\n## Goal\n\nx\n");
  assert.equal(fm?.next, undefined);
  assert.equal(fm?.["blocked-on"], "vendor reply");
});

// integrations/README.md is hand-maintained: it holds the manifest schema the
// integration-manifest check enforces. The index prints; a run with no flags
// must never replace that README.
// A throwaway workbench holding these generators and one readable integration.
function integrationFixture(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "integration-index-"));
  cpSync(here, join(root, ".agents", "generators"), { recursive: true });
  mkdirSync(join(root, "integrations", "demo"), { recursive: true });
  writeFileSync(
    join(root, "integrations", "demo", "README.md"),
    "---\nname: Demo\ndescription: A demo\ncli: demo\n---\n# Demo\n",
  );
  return root;
}

function runIntegrationIndex(root: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      join(root, ".agents", "generators", "integration-index.generate.ts"),
      ...args,
    ],
    { encoding: "utf8" },
  );
}

test("integration-index: a run with no flags prints the index and leaves integrations/README.md alone", () => {
  const root = integrationFixture();
  const readme = "# Integrations\n\n## Manifest\n\nthe schema\n";
  writeFileSync(join(root, "integrations", "README.md"), readme);
  const r = runIntegrationIndex(root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[Demo\]\(demo\/\)/);
  assert.equal(readFileSync(join(root, "integrations", "README.md"), "utf8"), readme);
});

test("integration-index: --out <file> is refused after an integration could not be read", () => {
  const root = integrationFixture();
  mkdirSync(join(root, "integrations", "broken"), { recursive: true });
  const out = join(root, "index.md");
  writeFileSync(out, "the last good index\n");
  const r = runIntegrationIndex(root, ["--out", out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused/);
  assert.equal(readFileSync(out, "utf8"), "the last good index\n");
});

// The app index writes apps/README.md by default; the same rule holds for it.
test("app-index: apps/README.md is left as it was after an app could not be read", () => {
  const root = integrationFixture();
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(join(root, "apps", "demo", "README.md"), "---\nname: demo\ndescription: A demo app\n---\n# demo\n");
  mkdirSync(join(root, "apps", "broken"), { recursive: true });
  writeFileSync(join(root, "apps", "README.md"), "the last good index\n");
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", join(root, ".agents", "generators", "app-index.generate.ts")],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused/);
  assert.equal(readFileSync(join(root, "apps", "README.md"), "utf8"), "the last good index\n");
});

// A domain bundle whose folder cannot be listed has lost its member apps: that
// is a drop, not an empty bundle. (Root lists any folder, so it cannot run this.)
test("app-index: a domain bundle that cannot be listed is a drop, and apps/README.md is left as it was", {
  skip: process.getuid?.() === 0,
}, () => {
  const root = integrationFixture();
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(join(root, "apps", "demo", "README.md"), "---\nname: demo\ndescription: A demo app\n---\n# demo\n");
  const bundle = join(root, "apps", "media");
  mkdirSync(join(bundle, "player"), { recursive: true });
  writeFileSync(join(bundle, "trigger.config.ts"), "// trigger-domain-bundle: media\n");
  writeFileSync(join(bundle, "player", "README.md"), "---\nname: player\ndescription: Plays\n---\n");
  writeFileSync(join(root, "apps", "README.md"), "the last good index\n");
  chmodSync(bundle, 0o300);
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", join(root, ".agents", "generators", "app-index.generate.ts")],
      { encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /media/);
    assert.equal(readFileSync(join(root, "apps", "README.md"), "utf8"), "the last good index\n");
  } finally {
    chmodSync(bundle, 0o700);
  }
});

// A decoded `\n` or a `|` in a frontmatter value must not break the table.
const MULTILINE = '---\nname: "Two | names"\ndescription: "two\\nlines | piped"\ncli: "a\\nb"\n---\n# x\n';

test("integration-index: a value with a line break and a pipe stays one table cell", () => {
  const root = integrationFixture();
  writeFileSync(join(root, "integrations", "demo", "README.md"), MULTILINE);
  const r = runIntegrationIndex(root);
  assert.equal(r.status, 0, r.stderr);
  const row = r.stdout.split("\n").find((l) => l.includes("two lines"));
  assert.ok(row, `the row renders on one line:\n${r.stdout}`);
  assert.ok(row.includes("two lines \\| piped"), row);
  assert.ok(row.includes("[Two \\| names]"), row);
  assert.ok(row.includes("| a b |"), row);
});

test("app-index: a value with a line break and a pipe stays one table cell", () => {
  const root = integrationFixture();
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(
    join(root, "apps", "demo", "README.md"),
    MULTILINE.replace('cli: "a\\nb"', 'schedule: "daily\\nat 9 | UTC"'),
  );
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      join(root, ".agents", "generators", "app-index.generate.ts"),
      "--out",
      "-",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const row = r.stdout.split("\n").find((l) => l.includes("two lines"));
  assert.ok(row, `the row renders on one line:\n${r.stdout}`);
  assert.ok(row.includes("two lines \\| piped"), row);
  assert.ok(row.includes("daily at 9 \\| UTC"), row);
});

test("integration-index: --out <file> writes when every integration was read", () => {
  const root = integrationFixture();
  const out = join(root, "integrations", "index.md");
  const r = runIntegrationIndex(root, ["--out", out]);
  assert.equal(r.status, 0);
  assert.match(readFileSync(out, "utf8"), /\[Demo\]\(demo\/\)/);
});

// A link in the index is relative to the file it is written to, not to
// integrations/: an index at the repo root links integrations/demo/.
test("integration-index: --out outside integrations/ links each integration from where the file is", () => {
  const root = integrationFixture();
  const out = join(root, "index.md");
  const r = runIntegrationIndex(root, ["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(out, "utf8");
  assert.match(text, /\[Demo\]\(integrations\/demo\/\)/);
  assert.match(text, /\[AGENTS\.md\]\(AGENTS\.md\)/);
});

function runAppIndex(root: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", join(root, ".agents", "generators", "app-index.generate.ts"), ...args],
    { encoding: "utf8" },
  );
}

test("app-index: --out outside apps/ links each app from where the file is", () => {
  const root = integrationFixture();
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(join(root, "apps", "demo", "README.md"), "---\nname: demo\ndescription: A demo app\n---\n# demo\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  const out = join(root, "docs", "apps.md");
  const r = runAppIndex(root, ["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(out, "utf8"), /\[demo\]\(\.\.\/apps\/demo\/\)/);
});

// Installing a bundle's dependencies creates node_modules/ beside its member
// apps (and a flat workspace may put one at apps/node_modules/); neither, nor a
// dot-folder, is an app.
test("app-index: node_modules and dot-folders are not apps, at the top or inside a domain bundle", () => {
  const root = integrationFixture();
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(join(root, "apps", "demo", "README.md"), "---\nname: demo\ndescription: A demo app\n---\n# demo\n");
  const bundle = join(root, "apps", "media");
  mkdirSync(join(bundle, "player"), { recursive: true });
  writeFileSync(join(bundle, "trigger.config.ts"), "// trigger-domain-bundle: media\n");
  writeFileSync(join(bundle, "player", "README.md"), "---\nname: player\ndescription: Plays\n---\n");
  mkdirSync(join(bundle, "node_modules", "zod"), { recursive: true });
  mkdirSync(join(bundle, ".turbo"), { recursive: true });
  mkdirSync(join(root, "apps", "node_modules", "zod"), { recursive: true });
  mkdirSync(join(root, "apps", ".cache"), { recursive: true });
  const r = runAppIndex(root);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(root, "apps", "README.md"), "utf8");
  assert.match(text, /\*\*Total: 2 apps\*\*/);
  assert.doesNotMatch(r.stderr, /node_modules|\.turbo|\.cache/);
});

test("integration-index: node_modules and dot-folders are not integrations", () => {
  const root = integrationFixture();
  mkdirSync(join(root, "integrations", "node_modules", "zod"), { recursive: true });
  mkdirSync(join(root, "integrations", ".cache"), { recursive: true });
  const out = join(root, "integrations", "index.md");
  const r = runIntegrationIndex(root, ["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(out, "utf8"), /\*\*Total: 1 integrations\*\*/);
});

test("oneLineCell: whitespace collapses to one line and a pipe is escaped", () => {
  assert.equal(oneLineCell("  two\nlines\r\n\tand  more  "), "two lines and more");
  assert.equal(oneLineCell("a | b"), "a \\| b");
});

test("oneLineCell: backslashes are escaped before pipes, so every pipe stays escaped", () => {
  assert.equal(oneLineCell("a|b"), "a\\|b");
  assert.equal(oneLineCell("a\\|b"), "a\\\\\\|b");
  assert.equal(oneLineCell("a\\\\|b"), "a\\\\\\\\\\|b");
});
