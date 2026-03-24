# Journal Template

## Format

Journals are structured YAML-like markdown — not prose.

```markdown
# YYYY-MM-DD

**Tags:** tag1, tag2

## Session: project-path or one-off (description)

**Action:** completed | progressed | scaffolded | fixed | investigated | planned

Summary line — enough to decide whether to read deeper.

**Changes:** What changed, where, why (when files/systems changed)

**Decisions:**

- **Chose:** X | **Why:** reason | **Rejected:** Y

**Lessons:** Surprising learnings, gotchas, corrections

**Blocked:** What's waiting and on what

**Next:** Specific actionable next steps
```

## Rules

- Multi-session days: each session gets its own heading
- Include decisions liberally — capture the WHY
- Light sessions need only project, action, summary
- Target: 10-350 lines per day
- Do NOT include: narrative prose, granular code diffs, deployment play-by-play
