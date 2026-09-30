// Shared YAML frontmatter parser for index generators.
// Handles key-value pairs, quoted values (`next: "R3: checkout retries"` keeps
// its colon), trailing comments, >- multiline folded scalars, and YAML lists.

export function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(4, end);
  const result: Record<string, string> = {};
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const kvMatch = lines[i].match(/^(\S+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    // A > or >- folded scalar (its header may carry a ` #` comment): the
    // indented lines joined with spaces. Its text is literal, so it is never
    // unquoted or cut at a `#`; with no lines it is empty and skipped.
    if (/^>-?(\s+#.*)?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        i++;
        parts.push(lines[i].trim());
      }
      if (parts.length > 0) result[key] = parts.join(" ");
      continue;
    }

    // Skip YAML lists
    if (value === "" || value === "[]") {
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      continue;
    }

    // A quoted value ends at its closing quote, not at the end of the line:
    // `status: "active" # note` is `active`. An unquoted value ends at a ` #`
    // comment, as in YAML: `priority: high  # required on active` is `high`.
    if (value.startsWith('"') || value.startsWith("'")) {
      value = unquote(value);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }

    result[key] = value;
  }
  return result;
}

/** The value of a quoted scalar that closes and is followed by nothing but
 *  whitespace or a `#` comment, its escapes decoded; any other value comes back
 *  as it was. In '…' a doubled '' is one quote and a backslash is literal. In
 *  "…" a backslash escapes the next character: \" \\ \/ \t \n decode, and any
 *  other escape is kept as written. */
function unquote(value: string): string {
  const q = value[0];
  if (q !== '"' && q !== "'") return value;
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const c = value[i];
    if (q === '"' && c === "\\") {
      const e = value[i + 1] ?? "";
      out += DOUBLE_QUOTED_ESCAPES[e] ?? `\\${e}`;
      i++;
      continue;
    }
    if (c !== q) {
      out += c;
      continue;
    }
    if (q === "'" && value[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    const rest = value.slice(i + 1);
    return /^(\s+#.*|\s*)$/.test(rest) ? out : value;
  }
  return value;
}

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", t: "\t", n: "\n" };
