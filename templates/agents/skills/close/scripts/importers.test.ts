// importers.test.ts — importerClosure: who reads a changed shared module,
// followed through shared modules in turn.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/importers.test.ts
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { importerClosure, sharedUnit } from "./importers.ts";

const TMP = mkdtempSync(join(tmpdir(), "importers-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const root = join(TMP, name);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

test("an app importing a package's barrel is an importer of the file the barrel re-exports", () => {
  const root = tree("barrel", {
    "packages/p/p.ts": "export const p = (a: number) => a;\n",
    "packages/p/index.ts": 'export * from "./p.ts";\n',
    "apps/web/site/src/a.ts": 'import { p } from "../../../../packages/p/index.ts";\n',
    "apps/web/other/src/a.ts": "export const nothing = 1;\n",
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), ["apps/web/site/src/a.ts", "packages/p/index.ts"]);
});

test("an integration importing a changed package is an importer, and its importers follow", () => {
  const root = tree("integ", {
    "packages/p/p.ts": "export const p = (a: number) => a;\n",
    "integrations/q/q.ts": 'import { p } from "../../packages/p/p.ts";\np(1);\n',
    "apps/ops/x/src/a.ts": 'import "../../../../integrations/q/q.ts";\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), ["apps/ops/x/src/a.ts", "integrations/q/q.ts"]);
});

test("extensionless, .js and dynamic specifiers resolve; a query is not part of the path", () => {
  const root = tree("forms", {
    "packages/p/p.ts": "export const p = 1;\n",
    "packages/p/lib/index.ts": "export const l = 1;\n",
    "integrations/a/a.ts": 'import { p } from "../../packages/p/p";\n',
    "integrations/b/b.ts": 'const m = await import("../../packages/p/p.js");\n',
    "integrations/c/c.ts": 'const m = require("../../packages/p/lib");\n',
    "integrations/d/d.ts": 'import raw from "../../packages/p/p.ts?raw";\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts", "packages/p/lib/index.ts"]), [
    "integrations/a/a.ts",
    "integrations/b/b.ts",
    "integrations/c/c.ts",
    "integrations/d/d.ts",
  ]);
});

test("a cycle through shared code ends, and each file is named once", () => {
  const root = tree("cycle", {
    "packages/p/p.ts": 'import "../q/q.ts";\n',
    "packages/q/q.ts": 'import "../p/p.ts";\n',
    "apps/a/b/src/a.ts": 'import "../../../../packages/q/q.ts";\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), ["apps/a/b/src/a.ts", "packages/q/q.ts"]);
});

test("an app's file is a leaf: what imports an app is not followed", () => {
  const root = tree("leaf", {
    "packages/p/p.ts": "export const p = 1;\n",
    "apps/a/b/src/a.ts": 'import "../../../../packages/p/p.ts";\n',
    "apps/a/c/src/c.ts": 'import "../../b/src/a.ts";\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), ["apps/a/b/src/a.ts"]);
});

test("nothing shared changed, or no tree at all: no importers", () => {
  const root = tree("none", { "apps/a/b/src/a.ts": "export const a = 1;\n" });
  assert.deepEqual(importerClosure(root, []), []);
  assert.deepEqual(importerClosure(root, ["apps/a/b/src/a.ts", "README.md"]), []);
  assert.deepEqual(importerClosure(join(TMP, "absent"), ["packages/p/p.ts"]), []);
});

test("git's folder and installed-package folders are not read", () => {
  const root = tree("skip", {
    "packages/p/p.ts": "export const p = 1;\n",
    "packages/p/node_modules/x/i.ts": 'import "../../p.ts";\n',
    "apps/a/b/.git/hooks/i.ts": 'import "../../../../../packages/p/p.ts";\n',
    "apps/a/b/.yarn/releases/y.cjs": 'require("../../../../../packages/p/p.ts");\n',
    "apps/a/b/.pnpm-store/v3/i.ts": 'import "../../../../../packages/p/p.ts";\n',
    "apps/a/b/bower_components/x/i.js": 'import "../../../../../packages/p/p.ts";\n',
    "apps/a/b/jspm_packages/x/i.js": 'import "../../../../../packages/p/p.ts";\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), []);
});

// The Contextium v9.2.1 review: every dot folder was skipped, so a Storybook
// config in an app's .storybook/ importing a changed package was no importer.
test("source in any other dot folder is read: an app's .storybook config is an importer", () => {
  const root = tree("dot", {
    "packages/p/p.ts": "export const p = 1;\n",
    "apps/web/site/.storybook/main.ts": 'import { p } from "../../../../packages/p/p.ts";\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), ["apps/web/site/.storybook/main.ts"]);
});

test("an .astro, .vue or .svelte file importing a changed package is an importer", () => {
  const root = tree("sfc", {
    "packages/p/p.ts": "export const p = 1;\n",
    "apps/web/a/src/pages/index.astro": '---\nimport { p } from "../../../../../packages/p/p.ts";\n---\n<p>{p}</p>\n',
    "apps/web/v/src/App.vue": '<script setup lang="ts">\nimport { p } from "../../../../packages/p/p";\n</script>\n',
    "apps/web/s/src/App.svelte": '<script>\n  import { p } from "../../../../packages/p/p.js";\n</script>\n',
  });
  assert.deepEqual(importerClosure(root, ["packages/p/p.ts"]), [
    "apps/web/a/src/pages/index.astro",
    "apps/web/s/src/App.svelte",
    "apps/web/v/src/App.vue",
  ]);
});

// The Contextium v9.2.1 review: an extensionless specifier resolved only to
// TypeScript, so index.cjs requiring './p' was no importer when p.js changed.
test("an extensionless specifier resolves to the JavaScript file and index forms too", () => {
  const root = tree("jsforms", {
    "packages/p/p.js": "module.exports = 1;\n",
    "packages/p/index.cjs": 'module.exports = require("./p");\n',
    "packages/q/lib/index.mjs": "export const l = 1;\n",
    "packages/q/q.cjs": 'const l = require("./lib");\n',
    "packages/r/r.mjs": "export const r = 1;\n",
    "packages/r/use.js": 'import { r } from "./r";\n',
    "packages/s/lib/index.js": "export const s = 1;\n",
    "packages/s/use.ts": 'import { s } from "./lib";\n',
  });
  assert.deepEqual(
    importerClosure(root, [
      "packages/p/p.js",
      "packages/q/lib/index.mjs",
      "packages/r/r.mjs",
      "packages/s/lib/index.js",
    ]),
    ["packages/p/index.cjs", "packages/q/q.cjs", "packages/r/use.js", "packages/s/use.ts"],
  );
});

test("past the bound it throws rather than answer in part", () => {
  const root = tree("bound", {
    "packages/p/p.ts": "export const p = 1;\n",
    "apps/a/b/a.ts": "1;\n",
    "apps/a/b/b.ts": "1;\n",
  });
  assert.throws(() => importerClosure(root, ["packages/p/p.ts"], 2), /more than 2 code files/);
});

test("an unreadable file is an error, not an empty answer", () => {
  const root = tree("unreadable", {
    "packages/p/p.ts": "export const p = 1;\n",
    "apps/a/b/a.ts": 'import "../../../packages/p/p.ts";\n',
  });
  chmodSync(join(root, "apps/a/b/a.ts"), 0o000);
  try {
    assert.throws(() => importerClosure(root, ["packages/p/p.ts"]), /EACCES/);
  } finally {
    chmodSync(join(root, "apps/a/b/a.ts"), 0o644);
  }
});

test("sharedUnit names integrations/<name> and packages/<name> only", () => {
  assert.equal(sharedUnit("packages/p/p.ts"), "packages/p");
  assert.equal(sharedUnit("integrations/q/src/q.ts"), "integrations/q");
  assert.equal(sharedUnit("packages/README.md"), null);
  assert.equal(sharedUnit("apps/a/b/c.ts"), null);
  assert.equal(sharedUnit(""), null);
});
