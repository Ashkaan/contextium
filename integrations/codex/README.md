# Codex

AI code generation agent for bulk file edits, large refactors, and code generation tasks. Used as a delegated sub-agent when changes span many files or require repetitive pattern application.

## Requirements

- Node.js 18+
- OpenAI API key (Codex uses OpenAI models)
- Git repository for the target codebase

## Setup

1. Install the Codex CLI:
   ```bash
   npm install -g @openai/codex
   ```
2. Get an API key from [platform.openai.com](https://platform.openai.com/api-keys)
3. Store the key in your credential vault:
   ```bash
   op item create --category=login --title="OpenAI - Codex API Key" \
     --vault="AI" api_key="your-key-here"
   ```
4. Export for CLI use:
   ```bash
   export OPENAI_API_KEY=$(op read "op://AI/OpenAI - Codex API Key/api_key")
   ```
5. Verify: `codex "list the files in the current directory"`
6. See `agent-configs/codex/README.md` for the Codex agent configuration
7. See `agent-configs/claude/AGENTS.md` for delegation rules

## When to Delegate to Codex

| Scenario | Why Codex |
|----------|-----------|
| Bulk file edits (10+ files) | Faster than editing one at a time |
| Large refactors | Rename variables, restructure imports across a project |
| Boilerplate generation | Scaffold tests, components, or modules from patterns |
| Pattern application | Apply the same change to many similar files |

**Do NOT delegate** for single-file edits, logic-heavy changes requiring deep reasoning, or anything touching security-sensitive code.

## Key Commands

```bash
# Bulk rename across a project
codex "Rename all instances of 'oldFunction' to 'newFunction' across src/"

# Generate test files
codex "Generate unit tests for every file in src/utils/ using vitest"

# Scaffold from patterns
codex "Create a new integration README in integrations/slack/ following the format of integrations/todoist/README.md"

# Update imports after restructuring
codex "Update all imports to use the new @lib/ path alias instead of relative paths"

# Framework migration
codex "Convert all class components in src/components/ to functional components with hooks"
```

## Safety Notes

- Codex operates in a sandboxed environment by default
- Always review generated changes with `git diff` before committing
- For destructive operations (deleting files, rewriting core logic), review the plan before execution
- Use `--dry-run` when available to preview changes

## Use Cases

- Generating boilerplate code from templates or specifications
- Applying consistent formatting or structural changes across a codebase
- Creating test files for existing modules
- Migrating code between frameworks, patterns, or API versions
- Scaffolding new modules that follow existing conventions
