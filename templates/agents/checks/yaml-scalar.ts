// yaml-scalar.ts — the one reading of a YAML flow scalar that the frontmatter
// checks share. Imported by check-skills.ts and check-decision-records.ts.
//
// yamlScalar(s) returns the value of scalar `s` and a state:
//   ok        a plain value (a ` #` comment dropped), or a quoted value that
//             closes, optionally followed by whitespace and a `#` comment
//   open      a quote that never closes. In "…" a quote after an odd run of
//             backslashes is escaped; in '…' a doubled '' is.
//   trailing  a closed quote followed by anything but a comment
// Escapes inside the value are left as written: the checks only measure and
// compare values, and never need them decoded.

export type YamlScalarState = "ok" | "open" | "trailing";

export interface YamlScalar {
  value: string;
  state: YamlScalarState;
}

export function yamlScalar(raw: string): YamlScalar {
  const s = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  const q = s.charAt(0);
  if (q !== '"' && q !== "'") {
    const m = /[ \t]#/.exec(s);
    const v = m ? s.slice(0, m.index) : s;
    return { value: v.replace(/[ \t]+$/, ""), state: "ok" };
  }
  const n = s.length;
  let i = 1;
  for (; i < n; i++) {
    const c = s.charAt(i);
    if (q === '"' && c === "\\") {
      i++;
      continue;
    }
    if (c === q) {
      if (q === "'" && s.charAt(i + 1) === "'") {
        i++;
        continue;
      }
      break;
    }
  }
  if (i >= n) return { value: s, state: "open" };
  const rest = s.slice(i + 1);
  const state: YamlScalarState = /^[ \t]*$/.test(rest) || /^[ \t]+#/.test(rest) ? "ok" : "trailing";
  return { value: s.slice(1, i), state };
}
