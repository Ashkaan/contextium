# Code Conventions

Standards for all TypeScript and shell scripts in this repo. Sourced from the Deno style guide, Effective TypeScript (Vanderkam), and Google's shell guide. Enforced by `deno lint`, `deno fmt`, `shellcheck`, and your CI pipeline.

---

## TypeScript

### Type Safety

**Strict mode is non-negotiable.** All TypeScript code must compile under strict settings. This catches implicit `any`, null/undefined misuse, and uninitialized variables at compile time rather than runtime.

**Prefer `unknown` over `any`.** If a value's type is genuinely unknown, use `unknown` and narrow before use. `any` disables the type system — use it only as a last resort with an inline `// deno-lint-ignore` and a comment explaining why.

```typescript
// Bad — disables all type checking downstream
function parse(input: any): string { return input.name; }

// Good — forces the caller to narrow
function parse(input: unknown): string {
  if (typeof input === "object" && input !== null && "name" in input) {
    return (input as { name: string }).name;
  }
  throw new Error("Invalid input: missing 'name'");
}
```

**Design types that represent only valid states.** Use discriminated unions to make illegal states unrepresentable. This eliminates entire categories of bugs because the type system prevents them.

```typescript
// Bad — allows impossible combinations (loading + error)
interface RequestState {
  loading: boolean;
  error?: string;
  data?: Result;
}

// Good — each state is explicit and complete
type RequestState =
  | { status: "pending" }
  | { status: "error"; error: string }
  | { status: "ok"; data: Result };
```

**Be strict in outputs, flexible in inputs.** Accept broad types in parameters (union types, optional fields) but return narrow, fully-typed results. This makes functions easy to call and safe to consume.

```typescript
// Good — accepts string or Date, returns precise type
function formatDate(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return d.toISOString().slice(0, 10);
}
```

**Use utility types.** `Partial<T>`, `Pick<T, K>`, `Omit<T, K>`, `Record<K, V>`, and `Required<T>` reduce boilerplate and keep types in sync with their source.

### Naming

| Kind | Style | Example |
|------|-------|---------|
| Variables, functions, methods | camelCase | `dayStart`, `fetchJson()` |
| Constants (static, top-level) | UPPER_SNAKE_CASE | `REPO_OWNER`, `COOLDOWN_MS` |
| Types, interfaces, enums, classes | PascalCase | `CalendarEvent`, `BriefingData` |
| Enum members | UPPER_SNAKE_CASE | `Status.IN_PROGRESS` |
| Filenames (automation scripts) | snake_case | `build_briefing.ts` |
| Filenames (everything else) | kebab-case | `code-quality.yaml` |
| Acronyms | Follow casing rules | `httpServer`, `HtmlParser` (not `HTTPServer`) |

Source: [Deno style guide](https://docs.deno.com/runtime/contributing/style_guide/)

### File Structure

Every script follows this layout:

```
1. Header comment (path, runtime, purpose)
2. Imports (grouped: stdlib/npm → shared → relative)
3. Types
4. Constants
5. Helpers
6. Main
```

Use section dividers for logical groupings:

```typescript
// ── Types ────────────────────────────────────────────────────────────
// ── Constants ────────────────────────────────────────────────────────
// ── Helpers ──────────────────────────────────────────────────────────
// ── Main ─────────────────────────────────────────────────────────────
```

### Imports

Group in this order, separated by blank lines:

```typescript
import type { Config } from "./config.js";         // 1. type imports (any source)

import * as sdk from "npm:some-sdk@1";              // 2. npm / external packages

import { helper } from "../shared/module.ts";       // 3. shared utilities

import { local } from "./local.ts";                 // 4. relative imports
```

### Functions

**Top-level functions use the `function` keyword**, not arrow syntax. Arrow functions are for callbacks and inline expressions only. This follows the Deno style guide — `function` declarations are hoisted, named in stack traces, and visually distinct from data.

```typescript
// Good — top-level
export function buildHtml(data: BriefingData): string { ... }

// Good — callback
const sorted = items.sort((a, b) => a.date.localeCompare(b.date));

// Bad — top-level arrow
const buildHtml = (data: BriefingData): string => { ... };
```

**Max 2 required parameters + options object.** If a function needs more than 2 required args, consolidate into an options object. This prevents argument-ordering bugs and makes call sites readable.

```typescript
// Bad — which boolean is which?
async function assess(domain: string, true, false, "full") { ... }

// Good — clear at the call site
interface AssessOptions { includeWhois?: boolean; format?: "full" | "summary"; }
async function assess(domain: string, options?: AssessOptions) { ... }
```

**Always annotate return types on exported functions.** Type inference is fine for local helpers, but exports define a contract — make it explicit.

### Types

- Prefer `interface` for object shapes (extendable, better error messages)
- Prefer `type` for unions, intersections, and aliases
- Use `import type` when only importing types — it's erased at runtime
- Define result types as named interfaces, not inline — they document the contract
- For untyped API responses: `const data = (await res.json()) as ApiResponse`

### Error Handling

**Accumulate warnings, throw on critical failure.** Non-fatal issues go into `warnings[]`; fatal issues throw immediately.

```typescript
const warnings: string[] = [];

try {
  items = await fetchItems();
} catch (err) {
  warnings.push(`Items: ${err}`);
}

// All sources failed — throw, don't return empty
if (items.length === 0 && warnings.length > 0) {
  throw new Error(`All sources failed: ${warnings.join("; ")}`);
}
```

**Never swallow errors silently.** An empty `catch {}` is a bug. At minimum, log or push to warnings.

**Error messages:** sentence case, no period, active voice, include context:
```typescript
// Good
throw new Error(`Cannot refresh token for ${resourcePath}: ${r.status}`);

// Bad
throw new Error("Token refresh error.");
```

Source: [Deno error message guidelines](https://docs.deno.com/runtime/contributing/style_guide/)

### Comments

- **No JSDoc on internal code** — types are the documentation
- **JSDoc on shared utility exports only** — one-line `/** description */` plus `@param` tags
- **Inline comments explain WHY**: `// Warn instead of throw — partial data still useful here`
- **Section dividers** for logical groupings: `// ── Helpers ──────────`
- **No commented-out code** — delete it; git has history
- **TODO format**: `// TODO(author): description` with attribution, not anonymous

Source: [Deno style guide](https://docs.deno.com/runtime/contributing/style_guide/)

### Patterns to Avoid

| Anti-pattern | Why | Instead |
|-------------|-----|---------|
| `function main(args: any)` | Untyped boundary | Type every parameter explicitly |
| `try { ... } catch { }` | Silent failure | Push to warnings or throw |
| `const token = "sk-abc123"` | Hardcoded secret | Use vault or environment variables |
| `Proxy`, `eval`, metaprogramming | Implicit behavior, hard to trace | Be explicit, even if more code |

---

## Shell Scripts

### Safety

Every script starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

- `errexit` — exit on first error (no silent failures)
- `nounset` — error on undefined variables (catches typos)
- `pipefail` — propagate errors through pipes

Source: [Google shell style guide](https://google.github.io/styleguide/shellguide.html)

### Naming

| Kind | Style | Example |
|------|-------|---------|
| Constants, environment exports | UPPER_SNAKE_CASE | `API_URL`, `REPO_ROOT` |
| Local/loop variables | lower_snake_case | `script_file`, `parent_hash` |
| Functions | lower_snake_case | `check_prereqs()`, `build_payload()` |

### Formatting

| Rule | Value |
|------|-------|
| Indentation | 2 spaces (no tabs) |
| Line length | 80 characters (hard limit) |
| Control flow | `; then` / `; do` on same line as `if`/`for`/`while` |
| Conditionals | `[[ ]]` not `[ ]` |
| Substitution | `$(command)` not backticks |

### Quoting

**Always double-quote variable expansions.** Unquoted variables are the #1 source of shell bugs.

```bash
# Bad — breaks on paths with spaces
cp $SCRIPT_FILE /tmp/

# Good
cp "$SCRIPT_FILE" /tmp/
```

Use `"${var}"` form when adjacent to other text: `"${prefix}_suffix"`.

### Functions

- Declare all functions before executable code
- Use `local` for function-scoped variables
- Separate declaration from assignment with command substitution:

```bash
# Bad — local masks the exit code
local output=$(some_command)

# Good — exit code is preserved
local output
output=$(some_command)
```

### Error Messages

Print errors to stderr:

```bash
echo "Error: file not found: $SCRIPT_FILE" >&2
```

Use long flags where available for self-documenting code: `--recursive` over `-r`.

### When Not to Use Shell

If a script exceeds ~100 lines or needs complex data manipulation, rewrite in TypeScript. Shell is for glue, not business logic.

Sources: [Google shell style guide](https://google.github.io/styleguide/shellguide.html), [Shell script best practices](https://sharats.me/posts/shell-script-best-practices/)

---

## Formatting Reference

Recommended `deno fmt` configuration:

| Rule | Value |
|------|-------|
| Indentation | 2 spaces |
| Line width | 120 characters |
| Semicolons | Always |
| Quotes | Double (`"`) |
| Trailing commas | Always in multiline |

These match the conventions above. `deno fmt` handles them automatically — no manual enforcement needed.

---

## Further Reading

- [Effective TypeScript](https://effectivetypescript.com/) — 83 specific ways to improve TypeScript (Vanderkam)
- [Deno Style Guide](https://docs.deno.com/runtime/contributing/style_guide/) — Official Deno project conventions
- [Deno Linting & Formatting](https://docs.deno.com/runtime/fundamentals/linting_and_formatting/) — Built-in tooling docs
- [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html) — Bash conventions
