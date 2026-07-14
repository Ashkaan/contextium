// Shared YAML frontmatter parser for index generators.
// Handles key-value pairs, >- multiline folded scalars, and YAML lists.

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

    // Handle >- or > multiline folded scalar
    if (value === ">-" || value === ">") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        i++;
        parts.push(lines[i].trim());
      }
      value = parts.join(" ");
    }

    // Skip YAML lists
    if (value === "" || value === "[]") {
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      continue;
    }

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}
