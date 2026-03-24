---
name: Error Remediation
description: >-
  Auto-remediation for failed automation workflows. Escalates through
  retry, AI diagnosis, and verification.
category: system
schedule: On error
runtime: Your automation platform
trigger: Event
outputs:
  - Retry attempt
  - Diagnosis email
integrations:
  - Your automation platform
  - AI code agent (Codex or similar)
  - Gmail or SMTP
---

# Error Remediation

Auto-remediation layer for automation failures. Never fails silently.

## Pattern: System/Event

Reacts to automation failures and attempts recovery before notifying the user.

## How It Works

1. **Tier 1 — Retry:** Wait, then re-trigger the failed workflow. Catches transient failures.
2. **Tier 2 — AI Diagnosis:** If retry fails, an AI code agent reads the script, diagnoses root cause, and attempts a
   fix.
3. **Verify:** If AI reports a fix, re-trigger once more. Only escalate to user if all attempts fail.

## Design Rules

- **Max 3 attempts:** original + retry + post-fix verify. No infinite loops.
- **Never silent:** Every auto-fix sends an info notification so you know it happened.
- **Retryability flags:** Only workflows marked retryable get automatic retry. Side-effect workflows skip to AI
  diagnosis.
- **Constrained AI:** The code agent cannot restart infrastructure, delete files, or modify git history.

## Implementation

1. Configure your automation platform's error handler to call this workflow
2. Create a script registry mapping workflow IDs to script paths
3. Set up the AI diagnosis prompt template
4. Configure notification delivery
