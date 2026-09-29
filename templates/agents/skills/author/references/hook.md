# /author hook — branch flow

Scaffolds `.agents/hooks/<name>.sh` (or `.agents/checks/<name>.sh`
with `<name>.test.sh` beside it) from the matching template, then fills it. A
PreToolUse/PostToolUse hook is the one shape with a register step: it fires from
nothing until it is wired into a harness's hook manifest. A check is not wired
here — nothing dispatches a new check until something calls it.

## Step 1 — resolve shape (ask the user: a numbered list, recommendation first; in Claude Code, `AskUserQuestion`)

Two structure-determining questions:

| Question | Options |
|---|---|
| Which of the 9 allowed categories? | (1) syntactic check, (2) peer-file co-commit, (3) progress-doc co-commit, (4) checklist gate, (5) journal frontmatter, (6) memory-write redirect, (7) tool-sandbox block, (8) session-discipline gate, (9) context injection. A hook MUST fall into exactly one. Semantic code review, feature-completeness judgment, and markdown-content quality are NOT hook territory. Do NOT author a hook for a failure mode that hasn't occurred. |
| Which firing surface (placement)? | (a) PreToolUse/PostToolUse on a tool call → top-level `.agents/hooks/<name>.sh`. (b) a check over files → `.agents/checks/<name>.sh` (pass `checks` as the 3rd scaffold arg). |

## Step 2 — scaffold

```bash
# PreToolUse/PostToolUse hook (top-level):
bash .agents/skills/author/scripts/scaffold.sh hook <name>
# a check (the workbench's checks folder, with <name>.test.sh beside it):
bash .agents/skills/author/scripts/scaffold.sh hook <name> checks
```

Writes the skeleton (shebang + `set -euo pipefail` + actionable-error `fail()` helper, or the stdin read for a tool-call hook) and `chmod +x`. Refuses if the file exists.

## Step 3 — fill

- Pick ONE category in the header comment; delete the rest.
- Replace the TODO body with the actual check.
- Every blocking path MUST call `fail` (or otherwise emit) an error naming the exact file + line + remediation. MUST NOT say "fix the issue" without pointing at it.
- **Exit code is load-bearing and depends on placement** (per Anthropic hooks docs, [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)):
  - A **PreToolUse/PostToolUse hook** wired in a hook manifest MUST `exit 2` to BLOCK the action (stderr is fed back as the denial reason). **`exit 1` is non-blocking** — the single most common hook bug is using `exit 1` intending to block. Exit 0 = allow (optionally emit a JSON `permissionDecision` object on stdout for finer control).
  - A **check** follows the checks convention (`exit 1` on violation), which is what its `<name>.test.sh` asserts. The `fail()` helper's `exit 1` in the template is correct for THIS placement; change it to `exit 2` if you wired the hook as a PreToolUse blocker.
- Hooks run with **no controlling terminal** — never `read -p`, prompt, or touch `/dev/tty`; emit a JSON `terminalSequence`/`additionalContext` instead.
- Keep `set -euo pipefail`. Exception: a fail-open Stop/decision hook MAY drop `-e` per the carve-out — only with an inline rationale comment + per-command guards.
- MUST NOT subject `.md` files to syntactic checks.
- For a check, fill the TODO case in `<name>.test.sh` with the violation the check exists for, and see it fail before the check makes it pass.

## Step 4 — verify

```bash
# a PreToolUse/PostToolUse hook:
bash .agents/skills/author/scripts/verify.sh hook .agents/hooks/<name>.sh
# a check, at the path scaffold.sh printed, plus its own suite:
bash .agents/skills/author/scripts/verify.sh hook .agents/checks/<name>.sh
bash .agents/checks/<name>.test.sh
```

Runs `shellcheck` + asserts `set -euo pipefail` is present. MUST exit 0 (shellcheck-clean + safe-mode present) before the branch completes. Disable a shellcheck warning only with an inline `# shellcheck disable=SCXXXX` naming the issue. For a top-level hook it also WARNs (non-blocking) while no hook manifest names it (see Step 5); for a check it makes no claim about wiring.

## Step 5 — register (a PreToolUse/PostToolUse hook only — it fires from nothing until wired)

Do NOT hand-edit `~/.claude/settings.json`, `~/.codex/hooks.json` or
`.agents/hooks.json`: the installer writes or links those, and a re-run replaces
what it made. Your own hooks go in `.agents/user-hooks.json` at the workbench
root — the installer never writes that file, and every run merges it into each
harness's manifest:

```jsonc
// <workbench>/.agents/user-hooks.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "<ToolName or regex>",
        "hooks": [{ "type": "command", "command": "bash <workbench>/.agents/hooks/<name>.sh" }]
      }
    ]
  }
}
```

Name the hook by the workbench's ABSOLUTE path (`<workbench>` is where
`install.sh` put it, e.g. `~/code/workbench`): a session can be working in a
product repo, where `$CLAUDE_PROJECT_DIR` is that repo and holds no
`.agents/hooks/`. Then re-run `install.sh` to merge it.

After wiring, re-run `verify.sh hook` — the "not wired" WARN should be gone. If you intentionally leave it unwired, the WARN is non-blocking but the hook will never fire.

A check has no register step here. Nothing dispatches a new check on its own; until something calls it, it runs by hand from the workbench root (say so where the check is documented: an automation nobody can see cannot be trusted).
