# Rules Index

Behavioral and governance rules with enforcement status.

## Rule Files

| File | Scope |
|------|-------|
| [behavior.md](behavior.md) | Delegation, context efficiency, depth policy, proactive value |
| [governance.md](governance.md) | Credentials, repo hygiene, project lifecycle, session end, people |

## Enforcement

| Rule | Source | Enforced by |
|------|--------|-------------|
| Delegation-first | `behavior.md` | Manual |
| Context efficiency | `behavior.md` | Hook (optional) |
| Depth policy | `behavior.md` | Manual |
| Proactive value | `behavior.md` | Manual |
| Credential handling | `governance.md` | Manual |
| Repo hygiene | `governance.md` | Manual |
| Project lifecycle | `governance.md` | Manual |
| Session end / journal | `governance.md` | Manual |
| People & entities | `governance.md` | Manual |
| Context repo parity | `governance.md` | Manual |

## Hooks (Optional)

Hooks enforce rules automatically via your AI agent's hook system. They are not included in the default install — configure the ones that matter to you.

### Example Hooks (Claude Code)

These go in `~/.claude/hooks/` and are registered in `~/.claude/settings.json` under `hooks`.

| Hook | Event | What it does |
|------|-------|-------------|
| `block-memory-writes.sh` | PreToolUse (Write/Edit) | Blocks writes to `~/.claude/` memory directory — use the repo instead |
| `session-checklist.sh` | UserPromptSubmit | First-message reminder: classify session, load preferences, check context router |
| `api-docs-gate.sh` | PreToolUse (Bash) | Detects API calls to known hosts, reminds to load integration docs first |
| `context-efficiency.sh` | PreToolUse (Read) | Tracks file reads, nudges toward sub-agents when reading many files |

**How Claude Code hooks work:** Shell scripts that run on specific events (PreToolUse, PostToolUse, UserPromptSubmit). They can return JSON to block the action or inject context. See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) for the hook API.

**Other agents:** Cursor has `.cursorrules` directives, Windsurf has `.windsurfrules`, and Cline has `.clinerules` — each supports inline behavioral constraints. For agents without hook systems, the rules in `behavior.md` and `governance.md` serve as instruction-level enforcement.
