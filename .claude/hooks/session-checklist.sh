#!/bin/bash
# Session start checklist — fires on UserPromptSubmit (once per session).
# Injects a reminder to classify the session and load preferences.

cat <<'REMINDER'
SESSION START CHECKLIST:
1. Classify this session: New Project | Existing | One-Off (default: journal-only)
2. Load preferences/user/preferences.md and preferences/rules/behavior.md and preferences/rules/governance.md
3. Before ending: create/update today's journal, commit, and push
REMINDER