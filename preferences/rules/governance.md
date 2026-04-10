# Governance Rules

Repo lifecycle, session protocols, and operational guardrails.

## Credentials & Keys

Store credentials in a secure vault (1Password, Bitwarden, etc.) immediately — never leave them only on disk. See
`templates/integrations/1password/` for the recommended setup.

## Repo Hygiene

- `node_modules/`, `dist/`, `.next/`, build outputs must never be committed
- **Never exclude to avoid fixing.** Adding entries to `.gitignore` to work around linting or formatting issues is sweeping the problem under the rug. Fix the actual content. Excludes are only for genuinely external artifacts (`node_modules/`, `dist/`, `.next/`)
- If you use an automation platform (Windmill, n8n, etc.), deploy updated scripts after editing. Skip if none configured.

## Projects

**Create:** folder `/projects/{domain}/YYYY-MM-DD_name/` + README.md with frontmatter: project, status, created, tags, description, next. Push immediately.

**Status change:** Update the `status` field in the project's frontmatter (source of truth). For `waiting` status, use `blocked-on` instead of `next`.

**Complete:** Only user can mark complete. Present summary + loose ends, ask for confirmation. Then: set `status: completed` in frontmatter, remove `next`/`blocked-on`.

## People & Entities

All people live in `/knowledge/people/{name}/` — each person gets a directory with at least a `README.md`. Create a card
when a fact is worth remembering.

## Automation Quality

**No silent failures.** If an automation produces incomplete output — a missing metric, a failed API call, a skipped data source — it must fail the job. A "successful" job with missing data is worse than a failed job, because nobody gets notified.

## Email Policy

The AI assistant should never send emails on behalf of the user. Draft content for the user to review and send themselves. Scheduled automations with pre-approved email outputs are exempt from this rule.

## Session End

"Close this out", "wrap this up", "let's close", or similar wrap-up phrases mean commit AND journal in one pass.

- [ ] Create/update `/journal/YYYY-MM-DD.md` (structured format, see `preferences/templates/journal_template.md`)
- [ ] Update project READMEs if statuses changed
- [ ] `git add <specific files>` -> commit -> push (never `git add -A`)
