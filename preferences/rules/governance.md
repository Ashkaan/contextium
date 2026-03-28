# Governance Rules

Repo lifecycle, session protocols, and operational guardrails.

## Credentials & Keys

Store credentials in a secure vault (1Password, Bitwarden, etc.) immediately — never leave them only on disk. See
`integrations/1password/` for the recommended setup.

## Repo Hygiene

- `node_modules/`, `dist/`, `.next/`, build outputs must never be committed
- **Never exclude to avoid fixing.** Adding entries to `.gitignore` or any other ignore list to work around linting, formatting, or tooling issues is sweeping the problem under the rug. Fix the actual content instead — format the files, fix the lint errors, resolve the warnings. Excludes are only for genuinely external artifacts (`node_modules/`, `dist/`, `.next/`) that aren't maintained code
- Never run package managers from the repo root — run from the relevant project folder
- After editing automation scripts, deploy them to the automation platform

## Projects

**Create:** folder `/projects/{domain}/YYYY-MM-DD_name/` + README.md (with frontmatter: project, status, created, tags, description, next) + run `npx tsx apps/project-index/generate.ts` to rebuild the index. Push immediately.

**Status change:** Update the `status` field in the project's frontmatter (source of truth). Then run `npx tsx apps/project-index/generate.ts` to rebuild `projects/README.md`. For `waiting` status, use `blocked-on` instead of `next`.

**Complete:** Only user can mark complete. Present summary + loose ends, ask for confirmation. Then: set `status: completed` in frontmatter, remove `next`/`blocked-on`, run the generation script.

## People & Entities

All people live in `/knowledge/people/{name}/` — each person gets a directory with at least a `README.md`. Create a card
when a fact is worth remembering.

## Automation Quality

**No silent failures.** If an automation produces incomplete output — a missing metric, a failed API call, a skipped data source — it must fail the job. A "successful" job with missing data is worse than a failed job, because nobody gets notified.

- Validation must check that **all expected outputs have values**, not just "at least one thing worked"
- Every warning or error that results in missing data should cause the job to fail, not silently continue

## Email Policy

The AI assistant should never send emails on behalf of the user. Draft content for the user to review and send themselves. Scheduled automations with pre-approved email outputs are exempt from this rule.

## Session End

"Close this out", "wrap this up", "let's close", or similar wrap-up phrases mean commit AND journal in one pass.

- [ ] Create/update `/journal/YYYY-MM-DD.md` (structured format, see templates)
- [ ] Update `/projects/README.md` if statuses changed
- [ ] `git add <specific files>` -> commit -> push (never `git add -A`)
