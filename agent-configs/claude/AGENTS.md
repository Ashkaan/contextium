# Codex Agent Guide

## When to Use Codex

Use Codex (via `codex exec "..."`) for tasks that benefit from a separate context window:

| Task                       | Why Codex                                         |
| -------------------------- | ------------------------------------------------- |
| Bulk file edits (>2 files) | Direct editing in separate context                |
| Code generation from spec  | Focused generation without polluting main context |
| Large refactors            | Handles multi-file changes atomically             |
| Documentation generation   | Can read many files without filling your context  |

## How to Invoke

```bash
# Basic execution
codex exec "refactor all API calls in src/ to use the new client"

# With file context
codex exec "update tests in tests/ to match new API signatures"
```

## Conventions

- Codex works in the same repo directory
- It can read and edit files directly
- Keep prompts specific and actionable
- Review changes after execution

## Delegation Logging

When delegating non-trivial work, log in the journal:

- `codex: bulk-edited 12 files for pattern library scaffolding`
- `codex: generated test suite for auth module`
