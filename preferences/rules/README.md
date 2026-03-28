# Rules Index

Behavioral and governance rules with enforcement status.

## Rule Files

| File                                          | Scope                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [behavior.md](behavior.md)                    | Delegation, context efficiency, depth policy, tracking completions, proactive value           |
| [governance.md](governance.md)                | Credentials, repo hygiene, project lifecycle, automation quality, email policy, session end, people |
| [incident-response.md](incident-response.md)  | Outage triage, restore-first protocol                                                        |

## Enforcement

| Rule                                       | Source              | Enforced by     |
| ------------------------------------------ | ------------------- | --------------- |
| Delegation-first                           | `behavior.md`       | Manual          |
| Context efficiency                         | `behavior.md`       | Hook (optional) |
| Fresh context for complex builds           | `behavior.md`       | Manual          |
| Depth policy                               | `behavior.md`       | Manual          |
| Tracking completions                       | `behavior.md`       | Manual          |
| Proactive value                            | `behavior.md`       | Manual          |
| Credential handling                        | `governance.md`     | Manual          |
| Repo hygiene (no excludes to avoid fixing) | `governance.md`     | Manual          |
| Project lifecycle                          | `governance.md`     | Manual          |
| Automation quality (no silent failures)    | `governance.md`     | Manual          |
| Email policy (never send on behalf)        | `governance.md`     | Manual          |
| Session end / journal                      | `governance.md`     | Manual          |
| People & entities                          | `governance.md`     | Manual          |
| Context repo parity                        | `governance.md`     | Manual          |
| Incident response (restore first)          | `incident-response.md` | Manual       |

## Hooks (Optional)

Hooks can be configured in your AI agent's settings to enforce rules automatically. Examples:

- Block writes to sensitive directories
- Remind to load integration docs before API calls
- Track file reads and suggest delegation
- Session start checklist

## Hooks (Advanced)

The enforcement hooks listed above are optional and not included in the default install. They demonstrate how behavioral
rules can be machine-enforced using your AI agent's hook system (e.g., Claude Code hooks at `~/.claude/hooks/`).

To set up hooks for your agent, see your agent's documentation on custom hooks or pre-tool-use triggers.
