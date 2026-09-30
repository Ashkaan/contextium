// Rows for yaml-scalar.ts, the YAML flow-scalar reader check-skills.ts and
// check-decision-records.ts share. A library, not a program, so it is imported.
//
// Run: node --test --experimental-strip-types .agents/checks/yaml-scalar.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { yamlScalar } from "./yaml-scalar.ts";

const rows: [string, string, string, string][] = [
  ["a plain value", "  accepted  ", "accepted", "ok"],
  ["a plain value drops a ` #` comment", "accepted # why", "accepted", "ok"],
  ["a # inside a plain value is kept", "a#b", "a#b", "ok"],
  ["a double-quoted value", '"Pat Doe"', "Pat Doe", "ok"],
  ["a quoted value then a comment", '"active" # note', "active", "ok"],
  ["an escaped double quote does not close", '"say \\"hi\\""', 'say \\"hi\\"', "ok"],
  ["a doubled single quote does not close", "'it''s'", "it''s", "ok"],
  ["an unclosed double quote", '"open', '"open', "open"],
  ["a double quote closed only by an escape", '"open\\"', '"open\\"', "open"],
  ["an unclosed single quote", "'it''s", "'it''s", "open"],
  ["text after the closing quote", '"a" b', "a", "trailing"],
  ["a # glued to the closing quote is not a comment", "'a'#b", "a", "trailing"],
  ["an empty quoted value", '""', "", "ok"],
];

for (const [name, input, value, state] of rows) {
  test(name, () => {
    assert.deepEqual(yamlScalar(input), { value, state });
  });
}
