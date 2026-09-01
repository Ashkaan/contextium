# /author hook — branch flow

Scaffolds `.claude/hooks/<name>.sh` (or `.githooks/checks/<name>.sh`) from
`references/templates/hook.template.sh`, then fills + WIRES it. The hook is the
one type with a meaningful register step: a hook fires from nothing until it is
wired into a settings matcher or a pre-commit body.

Governing rules: the list of things a hook is allowed to do, `@rule:hook-blocking-exit-code`,
`@rule:hook-errors-actionable`, the shellcheck-clean requirement,
the no-markdown-linting rule, the question of where automation belongs,
`@rule:surface-visible-signal`, `@rule:no-speculative-enforcement`.

## Step 1 — resolve shape (ask the user)

Two structure-determining questions:

| Question | Options |
|---|---|
| Which of the 9 allowed categories? | (1) syntactic check, (2) peer-file co-commit, (3) progress-doc co-commit, (4) checklist gate, (5) journal frontmatter, (6) memory-write redirect, (7) tool-sandbox block, (8) session-discipline gate, (9) context injection. A hook MUST fall into exactly one (the list of things a hook is allowed to do). Semantic code review, feature-completeness judgment, and markdown-content quality are NOT hook territory. Do NOT author a hook for a failure mode that hasn't occurred (`@rule:no-speculative-enforcement`). |
| Which firing surface (placement)? | (a) PreToolUse/PostToolUse on a tool call → top-level `.claude/hooks/<name>.sh`. (b) pre-commit check → `.githooks/checks/<name>.sh` (pass `checks` as the 3rd scaffold arg). |

## Step 2 — scaffold

```bash
# PreToolUse/PostToolUse hook (top-level):
bash .agents/skills/author/scripts/scaffold.sh hook <name>
# pre-commit check (checks/ subdir):
bash .agents/skills/author/scripts/scaffold.sh hook <name> checks
```

Writes the skeleton (shebang + `set -euo pipefail` + self-locating telemetry source + actionable-error `fail()` helper) and `chmod +x`. Refuses if the file exists.

## Step 3 — fill

- Pick ONE category in the header comment; delete the rest.
- Replace the TODO body with the actual check.
- Every blocking path MUST call `fail` (or otherwise emit) an error naming the exact file + line + remediation (`@rule:hook-errors-actionable`). MUST NOT say "fix the issue" without pointing at it.
- **Exit code is load-bearing and depends on placement** (per Anthropic hooks docs, [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)):
  - A **PreToolUse/PostToolUse Claude hook** wired in `settings.json` MUST `exit 2` to BLOCK the action (stderr is fed back as the denial reason). **`exit 1` is non-blocking** — the single most common hook bug is using `exit 1` intending to block. Exit 0 = allow (optionally emit a JSON `permissionDecision` object on stdout for finer control).
  - A **pre-commit check** invoked by `.githooks/pre-commit` follows the body convention (`exit 1` on violation) — the aggregating body turns a non-zero check into the commit block. The `fail()` helper's `exit 1` in the template is correct for THIS placement; change it to `exit 2` if you wired the hook as a PreToolUse blocker.
- Hooks run with **no controlling terminal** — never `read -p`, prompt, or touch `/dev/tty`; emit a JSON `terminalSequence`/`additionalContext` instead.
- Keep `set -euo pipefail` (`@rule:hook-blocking-exit-code`). Exception: a fail-open Stop/decision hook MAY drop `-e` per the carve-out — only with an inline rationale comment + per-command guards.
- MUST NOT subject `.md` files to syntactic checks (the no-markdown-linting rule).

## Step 4 — verify

```bash
bash .agents/skills/author/scripts/verify.sh hook .claude/hooks/<name>.sh
```

Runs `shellcheck` + asserts `set -euo pipefail` is present. It also emits a non-blocking WARN if the hook is not yet wired (see Step 5). MUST exit 0 (shellcheck-clean + safe-mode present) before the branch completes. Disable a shellcheck warning only with an inline `# shellcheck disable=SCXXXX` naming the issue (the shellcheck-clean requirement).

## Step 5 — register (REQUIRED — the hook fires from nothing until wired)

Pick the wiring that matches the placement chosen in Step 1:

(a) PreToolUse / PostToolUse — add a matcher block to `.claude/settings.json` `hooks`:

```jsonc
// in .claude/settings.json → "hooks" → "PreToolUse" (or "PostToolUse")
{
  "matcher": "<ToolName or regex>",
  "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.sh" }]
}
```

(b) pre-commit check — add an invocation line to `.githooks/pre-commit`:

```bash
# in .githooks/pre-commit — plain invocation, exactly like check-secrets.sh
bash "$root/.githooks/checks/<name>.sh" <staged-files-or-args>
```

After wiring, re-run `verify.sh hook` — the "not wired" WARN should be gone. If you intentionally leave it unwired, the WARN is non-blocking but the hook will never fire (`@rule:surface-visible-signal`).
