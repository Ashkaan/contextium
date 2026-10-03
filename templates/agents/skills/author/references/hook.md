# /author hook — branch flow

Scaffolds `.agents/hooks/<name>.ts` (or `.agents/checks/<name>.ts`
with `<name>.test.ts` beside it) from the matching template, then fills it. A
hook the harness fires on every tool call may stay bash (TypeScript costs a
Node start per call); the scaffold writes TypeScript, and a bash hook is
written by hand. A
PreToolUse/PostToolUse hook is the one shape with a register step: it fires from
nothing until it is wired into a harness's hook manifest. A check is not wired
here — one that must block is a close gate in
`.agents/skills/close/scripts/land.ts`.

## Step 1 — resolve shape (ask the user: a numbered list, recommendation first; in Claude Code, `AskUserQuestion`)

Two structure-determining questions:

| Question | Options |
|---|---|
| Which of the 9 allowed categories? | (1) syntactic check, (2) peer-file co-commit, (3) progress-doc co-commit, (4) checklist gate, (5) journal frontmatter, (6) memory-write redirect, (7) tool-sandbox block, (8) session-discipline gate, (9) context injection. A hook MUST fall into exactly one. Semantic code review, feature-completeness judgment, and markdown-content quality are NOT hook territory. Do NOT author a hook for a failure mode that hasn't occurred. |
| Which firing surface (placement)? | (a) PreToolUse/PostToolUse on a tool call → top-level `.agents/hooks/<name>.ts`. (b) a check over files → `.agents/checks/<name>.ts` (pass `checks` as the 3rd scaffold arg). |

## Step 2 — scaffold

```bash
# PreToolUse/PostToolUse hook (top-level):
node --experimental-strip-types .agents/skills/author/scripts/scaffold.ts hook <name>
# a check (the workbench's checks folder, with <name>.test.ts beside it):
node --experimental-strip-types .agents/skills/author/scripts/scaffold.ts hook <name> checks
```

Writes the skeleton (the `node --experimental-strip-types` shebang; for a hook the stdin read, for a check an actionable-error `fail()` helper and its test beside it; an exit status set through `process.exitCode`) and `chmod +x`. Refuses if the file exists.

## Step 3 — fill

- Pick ONE category in the header comment; delete the rest.
- Replace the TODO body with the actual check.
- Every blocking path MUST call `fail` (or otherwise emit) an error naming the exact file + line + remediation. MUST NOT say "fix the issue" without pointing at it.
- **Exit code is load-bearing and depends on placement** (per Anthropic hooks docs, [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)):
  - A **PreToolUse/PostToolUse hook** wired in a hook manifest MUST `exit 2` to BLOCK the action (stderr is fed back as the denial reason). **`exit 1` is non-blocking** — the single most common hook bug is using `exit 1` intending to block. Exit 0 = allow (optionally emit a JSON `permissionDecision` object on stdout for finer control).
  - A **check** follows the checks convention (exit 1 on violation), which is what its `<name>.test.ts` asserts. The `fail()` helper's status of 1 in the template is correct for THIS placement.
- Hooks run with **no controlling terminal** — never `read -p`, prompt, or touch `/dev/tty`; emit a JSON `terminalSequence`/`additionalContext` instead.
- Set `process.exitCode` and return; never call `process.exit`, which can end the process before the denial reason queued for stderr is written. A hand-written bash hook keeps `set -euo pipefail` (a fail-open Stop/decision hook MAY drop `-e`, with an inline rationale comment and per-command guards).
- MUST NOT subject `.md` files to syntactic checks.
- For a check, fill the TODO case in `<name>.test.ts` with the violation the check exists for, and see it fail before the check makes it pass.

## Step 4 — verify

```bash
# a PreToolUse/PostToolUse hook:
node --experimental-strip-types .agents/skills/author/scripts/verify.ts hook .agents/hooks/<name>.ts
# a check, at the path scaffold.ts printed, plus its own suite:
node --experimental-strip-types .agents/skills/author/scripts/verify.ts hook .agents/checks/<name>.ts
node --test --experimental-strip-types .agents/checks/<name>.test.ts
```

For a `.ts` hook or check it checks that the file parses once its types are stripped and never calls `process.exit`; for a bash hook it runs `shellcheck` and asserts `set -euo pipefail` (disable a shellcheck warning only with an inline `# shellcheck disable=SCXXXX` naming the issue). A top-level hook must not `exit 1`. MUST exit 0 before the branch completes. For a top-level hook it also WARNs (non-blocking) while no hook manifest names it (see Step 5); for a check it makes no claim about wiring.

## Step 5 — register (a PreToolUse/PostToolUse hook only — it fires from nothing until wired)

Do NOT hand-edit `~/.claude/settings.json`, `~/.codex/hooks.json`,
`.agents/hooks/claude-hooks.json` or `.agents/hooks.json`: the installer writes,
links or merges those, and a re-run replaces what it made. Where a hook of your
own goes depends on the harness, because each reads its own format with its own
tool names:

| Harness | Your hook goes in | Merged by `install.sh` into |
|---|---|---|
| Claude Code, Codex, Grok Build | `.agents/user-hooks.json` (below) | `.agents/hooks/claude-hooks.json`, which `~/.codex/hooks.json` and `~/.grok/hooks/contextium.json` link to and `~/.claude/settings.json` has merged in |
| Gemini CLI | `.agents/user-gemini-settings.json`, under `hooks.BeforeTool`, matching Gemini's tool names | `.agents/gemini-settings.json`, which `.gemini/settings.json` links to |
| Antigravity | no supported place: it reads `.agents/hooks.json` in place, and the installer lays that file down from the template on every run, so an entry added there is gone after the next run | — |

The installer never writes `.agents/user-hooks.json`; every run merges it:

```jsonc
// <workbench>/.agents/user-hooks.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "<ToolName or regex>",
        "hooks": [{ "type": "command", "command": "node --experimental-strip-types \"<workbench>/.agents/hooks/<name>.ts\"" }]
      }
    ]
  }
}
```

Name the hook by the workbench's ABSOLUTE path (`<workbench>` is where
`install.sh` put it, spelled out, e.g. `/Users/you/code/workbench`: a `~` does
not expand inside the quotes), and keep the escaped quotes around the whole
path so a workbench under a folder with a space in its name still launches. The
absolute path matters because a session can be working in a product repo, where
`$CLAUDE_PROJECT_DIR` is that repo and holds no `.agents/hooks/`. Then re-run
`install.sh` to merge it.

After wiring, re-run `verify.ts hook` — the "not wired" WARN should be gone. If you intentionally leave it unwired, the WARN is non-blocking but the hook will never fire.

A check has no register step here. A check that must block becomes a close gate: `.agents/skills/close/scripts/land.ts` runs it with `--since origin/<trunk>` when a predicate over the branch's changed paths says its inputs moved, and refuses the close on a red result. A check no gate calls runs only by hand from the workbench root; say so where it is documented, because an automation nobody can see cannot be trusted.
