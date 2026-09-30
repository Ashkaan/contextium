// parse-arg-mode.test.ts — peer of parse-arg-mode.ts.
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/parse-arg-mode.test.ts
//
// Pins the two-line `mode:` / `payload:` output for every mode: blank, the
// three verbs (create / complete / update), the two existing-slug heuristics
// (kebab slug, <domain>/<slug>) and the freeform-to-create default. The script
// is run as a subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "parse-arg-mode.ts");

function run(args: string[]) {
  // --no-warnings: Node 22.6 prints an ExperimentalWarning for type stripping
  // on stderr, and one case asserts stderr is empty.
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout, err: r.stderr, rc: r.status };
}

/** t <label> <expected stdout, lines joined with |> <args...> — and exit 0. */
function t(label: string, expected: string, args: string[]): void {
  test(label, () => {
    const r = run(args);
    assert.equal(r.out.split("\n").join("|"), expected, label);
    assert.equal(r.rc, 0, `${label}: exit 0`);
  });
}

t("no argument is blank", "mode: blank|payload:|", []);
t("empty string is blank", "mode: blank|payload:|", [""]);
t("whitespace only is blank", "mode: blank|payload:|", ["   "]);
t("kebab slug is existing", "mode: existing-slug|payload: checkout-flow|", ["checkout-flow"]);
t("padded slug is trimmed", "mode: existing-slug|payload: checkout-flow|", ["  checkout-flow "]);
t("domain/slug is existing", "mode: existing-slug|payload: web/checkout|", ["web/checkout"]);
t("one-word slug reads as create", "mode: create|payload: billing|", ["billing"]);
t("freeform text is create", "mode: create|payload: add a checkout retry|", ["add a checkout retry"]);
t("create verb", "mode: create|payload: a sync engine|", ["create a sync engine"]);
t("complete verb", "mode: complete|payload: sync-engine|", ["complete sync-engine"]);
t("update verb", "mode: update|payload: sync-engine|", ["update sync-engine"]);
t("a verb alone is not a verb", "mode: create|payload: complete|", ["complete"]);
t("uppercase slug is not a slug", "mode: create|payload: Checkout-Flow|", ["Checkout-Flow"]);
t("a slash with spaces is create", "mode: create|payload: fix a/b split|", ["fix a/b split"]);

test("stderr is empty", () => {
  assert.equal(run(["x"]).err, "");
});
