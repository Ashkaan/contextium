---
paths: null
---

# Journal Format

Where the session log goes and where its shape is defined. Always loaded.

## journal-format
Memory lives in two layers. The **git log** records WHAT changed (verb-first commit subjects). The
**journal** records WHY — one file per session, written by `/close`.

A journal day is a FOLDER, `journal/YYYY-MM-DD/`, and each session is one file in it,
`HHMM-<slug>.md`. MUST NOT assemble that path by hand or append to another session's file:
`.agents/skills/close/scripts/journal-file.sh` allocates it, and one file per session is what keeps
two sessions from writing into the same place.

The entry's front matter, heading and closed set of bold section labels are defined ONLY in
`.agents/skills/close/references/journal-entry.md`, and `check-journal-entry.sh` validates an entry
before the close commits it. MUST follow that file; MUST NOT restate its schema elsewhere. The bold
labels are required there — the one place the no-bold half of @rule:voice is overridden, because the
labels are what make the journal greppable.

Convert relative dates to absolute ("yesterday" → the actual date) so the entry reads correctly out
of context. Keep it terse; the journal is a memory aid, not an essay. [2026-03-30] [2026-09-28]
