# Governance Rules

Repo lifecycle, session protocols, and operational guardrails.

## Credentials & Keys

Store credentials in a secure vault (1Password, Bitwarden, etc.) immediately — never leave them only on disk. See
`integrations/1password/` for the recommended setup.

## Repo Hygiene

- `node_modules/`, `dist/`, build outputs must never be committed
- Never run package managers from the repo root — run from the relevant project folder
- After editing automation scripts, deploy them to the automation platform

## Projects

**Create:** folder `/projects/{domain}/YYYY-MM-DD_name/` + README.md (goal, status checkboxes) + add to Active Projects
in `/projects/README.md`. Push immediately.

**Complete:** Only user can mark complete. Present summary + loose ends, ask for confirmation.

## People & Entities

All people live in `/knowledge/people/{name}/` — each person gets a directory with at least a `README.md`. Create a card
when a fact is worth remembering.

## Session End

"Close this out", "wrap this up", or similar phrases mean commit AND journal in one pass.

- [ ] Create/update `/journal/YYYY-MM-DD.md` (structured format, see templates)
- [ ] Update `/projects/README.md` if statuses changed
- [ ] `git add <specific files>` -> commit -> push (never `git add -A`)
