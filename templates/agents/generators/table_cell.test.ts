// Rows for table_cell.ts: a frontmatter value rendered into a Markdown table
// cell stays one cell — a line break (parse_frontmatter decodes `\n` in a
// double-quoted value) would end the row, and a `|` would end the cell.
//
// Run: cd .agents/generators && node --test --experimental-strip-types table_cell.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFrontmatter } from "./parse_frontmatter.ts";
import { oneLineCell } from "./table_cell.ts";

test("line breaks and runs of whitespace collapse to one space", () => {
  assert.equal(oneLineCell("  two\nlines\r\n\tand  more  "), "two lines and more");
});

test("a pipe is escaped so it cannot end the cell", () => {
  assert.equal(oneLineCell("a | b"), "a \\| b");
});

test("a decoded \\n from a quoted frontmatter value stays inside the row", () => {
  const v = parseFrontmatter('---\ndescription: "first\\nsecond | third"\n---\n')?.description ?? "";
  assert.equal(v, "first\nsecond | third");
  assert.equal(oneLineCell(v), "first second \\| third");
});

// Escape parity: a backslash already in the value is escaped before the pipes
// are, so `\|` cannot turn into `\\|` — an escaped backslash and a bare pipe.
test("backslashes are escaped before pipes, so every pipe stays escaped", () => {
  assert.equal(oneLineCell("a|b"), "a\\|b");
  assert.equal(oneLineCell("a\\|b"), "a\\\\\\|b");
  assert.equal(oneLineCell("a\\\\|b"), "a\\\\\\\\\\|b");
});
