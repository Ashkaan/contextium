# Governance Rules

Repo lifecycle, session protocols, and operational guardrails.

## Credentials & Keys

Store credentials in a secure vault (1Password, Bitwarden, etc.) immediately — never leave them only on disk. See `integrations/1password/` for the recommended setup.

## Repo Hygiene

- `node_modules/`, `dist/`, build outputs must never be committed
- Never run package managers from the repo root — run from the relevant project folder
- After editing automation scripts, deploy them to the automation platform

## Projects

**Create:** folder `/projects/{domain}/YYYY-MM-DD_name/` + README.md (goal, status checkboxes) + add to Active Projects in `/projects/README.md`. Push immediately.

**Complete:** Only user can mark complete. Present summary + loose ends, ask for confirmation.

## People & Entities

All people live in `/knowledge/people/{name}/` — each person gets a directory with at least a `README.md`. Create a card when a fact is worth remembering.

## Context Repo Parity

Every automation script must have a source file in the repo. The repo is the source of truth. Scripts that only exist in the automation platform are invisible to refactors and will silently break when paths or dependencies change.

## Session End

"Close this out", "wrap this up", or similar phrases mean commit AND journal in one pass.

- [ ] Create/update `/journal/YYYY-MM-DD.md` (structured format, see below)
- [ ] If session touched a project: update that project's README next-steps
- [ ] Update `/projects/README.md` if statuses changed
- [ ] `git add <specific files>` -> commit -> push (never `git add -A`)

### Recommended Journal Format

These are defaults — adapt to your style, but the structure helps your AI find context in future sessions.

- **Frontmatter**: `date` and `tags` only; all session content goes in the markdown body
- **Session headings**: each session is an `### ` heading (project path or `one-off (description)`)
- **Required sections**: `**Action:**` summary line under each heading
- **Optional sections**: Changes, Decisions, Lessons, Blocked, Next
- **Decisions**: include liberally — capture the WHY, what was rejected, and edge-case context. These are the highest-value entries for future sessions
- **Avoid**: narrative prose, granular code diffs, deployment play-by-play — git history covers that
- **Target size**: 10-350 lines per day (enough for context, short enough to scan)
