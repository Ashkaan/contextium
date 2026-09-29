// One Markdown table cell from a frontmatter value.
//
// parse_frontmatter.ts decodes `\n` in a double-quoted value, and a value may
// hold a `|`; either one written straight into a row breaks the table — a line
// break ends the row, a pipe ends the cell. Every generator that renders a
// table cell from frontmatter goes through this one function.

/** The value on one line (every run of whitespace, line breaks included, is
 *  one space; the ends trimmed), backslashes escaped and then each `|`. The
 *  order keeps escape parity: a value's own `\|` becomes `\\\|` (a literal
 *  backslash, then an escaped pipe), never `\\|`, which would end the cell. */
export function oneLineCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
