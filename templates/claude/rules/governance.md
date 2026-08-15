---
paths: null
---

# Governance

Always-loaded governance rules — lint/format reasoning, session-end phrasing, ship-claim wording, commit-message authoring, publish-boundary decisions. Failure stories live in each correction's session journal per `@rule:rule-minimal-context`.

## repo-hygiene-fix-at-source
When a lint or format error occurs, MUST fix it at the source; MUST NOT add the file to an exclude list to avoid the fix. [2026-03-22]

## session-end
When the user says "close", "wrap up", "let's close", MUST invoke `/close` (journal entry + commit + push). `/close` also auto-fires as the tail of `/spec` and `/implement` on clean completion. If the session touched a project, MUST update that project's README next-steps in the same commit. [2026-03-30] [2026-06-28]

## no-co-authored-by-claude
Git commit messages MUST NOT include `Co-Authored-By: Claude ... <noreply@anthropic.com>` trailer lines, or equivalent trailers for any other AI agent. MUST NOT use `git commit --author` to credit an AI agent. The `attribution: {"commit": "", "pr": ""}` setting in `.claude/settings.json` removes AI attribution from the tool description; the rule stays as the backstop for every committer. [2026-04-23] [2026-08-06]

## deploy-target-known-before-deploy-claim
Before writing "shipped", "deployed", "live", or any deploy-command instruction in session output, MUST consult the relevant documentation for the repo's actual deploy model and verify the claim against it. MUST NOT treat repo-local convenience scripts as authoritative when official documentation documents a different model. [2026-04-22]

## commit-subject-must-be-actionable
Every git commit subject MUST begin with an actionable verb (add / fix / update / refactor / remove / etc.), ≤100 chars. MUST NOT use vague subjects ("wip", "fix it", multi-line). [2026-05-12]

## auth-gated-is-not-publish-block
When your own tools cannot access a user-protected resource (auth gates, SSO, VPN, IP allowlist), MUST NOT assume the user also cannot access it. MUST NOT escalate to a more-public mechanism (remove the gate, publish to a no-auth URL) to solve your OWN tool-access problem. When verification is needed, ask the user to confirm what they see; MUST NOT re-publish data to make verification yours. [2026-05-17]
