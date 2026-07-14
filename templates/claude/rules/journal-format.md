# Journal Format

How the daily session log is structured so it stays useful. Always loaded.

## journal-format
Memory lives in two layers. The **git log** records WHAT changed (commit subjects, ideally with a
verb-first actionable subject). The **journal** records WHY — one file per day at `journal/YYYY-MM-DD.md`,
written at the end of a working session by `/close`.

Each journal entry MUST use labeled markers, not narrative prose:

- **Action:** what the session set out to do.
- **Changes:** what actually changed (files, behavior).
- **Decisions:** choices made and the reasoning, especially the roads not taken.
- **Issues:** what went wrong or remains open.
- **Lessons:** what to do differently next time.
- **Next:** the concrete next step for a future session.

The bold markers are required here — this is the one place the no-bold half of @rule:voice is
explicitly overridden, because the structure is what makes the journal greppable and skimmable by a
future session. Convert relative dates to absolute ("yesterday" → the actual date) so the entry reads
correctly out of context. Keep it terse; the journal is a memory aid, not an essay.

Why two layers: the git log answers "when did X change and what was the commit," the journal answers
"why did we do it that way and what did we learn." Reconstructing a past decision needs both.
