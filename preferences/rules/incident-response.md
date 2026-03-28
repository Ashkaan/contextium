# Incident Response Rules

When responding to monitoring alerts, failing schedules, or any production outage.

## Priority: Restore Service First

1. **Diagnose** — identify the root cause (read logs, check recent changes)
2. **Apply minimum fix** — the smallest change that restores service
3. **Commit + push** — immediately, before anything else touches the branch
4. **Deploy** — push the fix to the automation platform or hosting provider
5. **Verify** — trigger a test run, confirm success
6. **Only then** explore improvements, refactors, or alternative approaches

Do not combine outage fixes with feature work. Ship the fix in its own commit.

## Why

An outage that persists while exploring "better" solutions is worse than a quick fix followed by a planned improvement. Every minute spent on alternatives is a minute the system is down.
