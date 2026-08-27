---
name: close
description: The "wrap" verb of the loop — end the session by writing the journal entry, updating touched project READMEs, committing, and pushing. Auto-invoked as the tail of /spec and /implement (the producer verbs) on clean completion, so "wrap" is not a verb the user types; also runnable directly. Dispatches /implement-audit as a backstop for substantial ad-hoc changes not already reviewed by /implement. Use when the user says "close", "wrap up", "let's close", or when a producer verb's auto-close gate fires.
disable-model-invocation: false
allowed-tools: "Bash(.claude/skills/close/scripts/*:*) Bash(.claude/skills/implement-audit/scripts/*:*) Bash(git *:*) Bash(node *:*) Read Edit Write Task Skill AskUserQuestion"
peers:
  - .claude/rules/journal-format.md
  - .claude/skills/implement-audit/SKILL.md
  - .claude/skills/close/references/auto-close-gate.md
handoffs_to:
  - .claude/skills/implement-audit/SKILL.md
handoffs_from:
  - .claude/skills/spec/SKILL.md
  - .claude/skills/implement/SKILL.md
enforces:
  - "@rule:journal-format"
  - "@rule:no-deferral"
steps:
  - id: code-review
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "Run .claude/skills/implement-audit/scripts/audit-dedupe.sh status. `done` → this session was already audited; capture the stored trailer (line 2+) for the commit message and do NOT dispatch a reviewer. `fresh` AND the session made substantial changes (a new directory under apps/, or roughly >50 changed lines of code) → dispatch /implement-audit and fix every ready finding before committing. `fresh` and trivial (README/config/journal-only) → skip."
  - id: journal
    kind: action
    action: "Write today's session block to journal/<today>.md with labeled markers per @rule:journal-format: Action / Changes / Decisions / Issues / Lessons / Next."
  - id: project-update
    kind: action
    action: "If the session touched a project, update its README status + next-steps in the same commit."
  - id: commit
    kind: action
    action: "Stage the files this session edited and commit. The commit-gate hook enforces subject discipline. Then push."
---

# /close — Session Wrap

The "wrap" verb of the loop. A session isn't closed by `git commit` alone — the journal entry is
load-bearing. `/close` writes the journal, updates any touched project README, commits, and pushes, in
one pass. For substantial changes that weren't already reviewed by `/implement`, it runs
`/implement-audit` first so blind spots get caught before the work is sealed.

**`/close` is also the auto-tail of the producer verbs.** `/spec` and `/implement` auto-invoke `/close`
on clean completion per [`references/auto-close-gate.md`](references/auto-close-gate.md) — so in the
normal loop nobody types `/close`; the producing verb fires it. When auto-invoked, the `close-fired`
session marker (`scripts/close-fired.sh`) guards against a double-fire if a held question resumes the
verb after `/close` had already started. Typing `/close` yourself still works for ad-hoc sessions that
didn't run a producer verb.

## Critical

- **The journal is required.** Do not stop after `git commit`. The journal entry (§2) is what makes a
  past decision reconstructable later per `@rule:journal-format`; the commit alone is not "closed."
- **Audit substantial ad-hoc changes — and only those.** §1 asks a marker file whether this session
  was already audited. If it was, the review does not run again and its trailer rides onto the commit
  instead. If it wasn't, and the session changed real code, `/implement-audit` runs here and every
  ready finding is fixed before the commit. Do not skip it to close faster.
- **Land the full scope.** Fix the audit findings this session per `@rule:no-deferral`; don't stage
  them in a README as "follow-ups."

## 1. Pre-Close Audit (substantial ad-hoc changes only)

`/implement-audit` is the loop's single code reviewer, normally fired by `/implement`. `/close` is the
backstop for substantial work done OUTSIDE `/implement` — a quick fix that grew, a refactor you did by
hand.

**Ask the marker, don't judge it:**

```bash
bash .claude/skills/implement-audit/scripts/audit-dedupe.sh status
```

`done` means this session already ran the review. Line 2 onward is the `implement-audit:` trailer that
run produced — capture it for §4's commit message and move on. **Do not dispatch a second review.**
This used to be a judgment call written in prose ("skip it if `/implement` already did it"), which asks
the closing session to decide a fact it cannot observe; it decided wrong often enough that people
watched the same diff get reviewed twice in one session.

`fresh` means nothing has reviewed this session's work. Now the size question matters: dispatch
`/implement-audit` if the session introduced a new directory under `apps/` (at any depth) or changed
roughly more than 50 lines of code. README/docs/config/journal-only sessions skip.

Detect the session's commit range and brief the audit with it:

```bash
# N = number of commits this session made (recall from your own git-commit calls)
BASE_SHA=$(git rev-parse HEAD~N)
HEAD_SHA=$(git rev-parse HEAD)
git diff "$BASE_SHA" "$HEAD_SHA"
```

Pass `/implement-audit`: the SHA range, the diff, the SPEC path if one exists for the touched code, and
a one-paragraph brief of what was built. Fix EVERY finding whose fix is ready this session — both
`must-fix` and `should-fix`. The triage label orders work within the round; it does not schedule across
sessions. A finding with a known fix ships now, per `@rule:no-deferral`. Defer to a future session ONLY
when the fix needs an unmade design decision (track it in a project folder) or is blocked on something
external. The fix loop and its round cap live inside `/implement-audit`; don't re-implement them here.

## 2. Journal Entry

Write today's session block to `journal/<today>.md` via Edit/Write. The format SSOT is
`@rule:journal-format` — labeled markers, not narrative prose, so a future session can grep and skim it.

If the file doesn't exist yet, create it:

```markdown
# 2026-06-03

### <one-line session heading>
**Action:** <what the session set out to do>
**Changes:** <files / behavior that changed>
**Decisions:** <choices made and why, especially roads not taken>
**Issues:** <what went wrong or stays open>
**Lessons:** <what to do differently next time>
**Next:** <the concrete next step for a future session>
```

If the file already exists (multi-session day), append a new `### <heading>` block at the end with the
same markers. Conventions:

- The bold markers are required here — this is the one place `@rule:voice`'s no-bold rule is overridden,
  because the structure is what makes the journal greppable.
- Convert relative dates to absolute ("yesterday" → the actual date) so the entry reads correctly out
  of context.
- Keep it terse; the journal is a memory aid, not an essay. A light session can be heading + Action +
  one-line summary.
- Not every marker is needed every time — include the ones that carry signal. `Decisions` matters most
  (recording a rejected path prevents re-exploring a dead end later).

## 3. Project Updates

If the session touched a project, update that project's README in the same commit: check off completed
next-steps, add new ones, and move the status frontmatter if the stage changed (active / blocked /
monitor / completed). This keeps the project index honest for the next `/project` invocation.

## 4. Commit and Push

Stage only the files THIS session edited (recall them from your own Edit/Write/Bash history — do not
blanket-add). Commit with a verb-led subject; the `commit-gate.sh` hook enforces the subject
discipline at commit time, so you don't restate those rules here. Then push.

```bash
git add <file1> <file2> ...        # the files you actually edited
git commit -m "<verb-led subject>"
git push origin "$(git rev-parse --abbrev-ref HEAD)"
```

**Carry the audit trailers.** A commit that changes real code needs the `implement-audit:` line, and a
commit that changes a SPEC needs the `spec-audit:` line — `.githooks/checks/check-audit-trailers.sh`
rejects the commit otherwise. Both lines already exist: §1 either captured the stored one from the
marker or the audit you just ran printed a fresh one. Put them at the end of the message, after a blank
line:

```bash
git commit -m "add the digest scheduler" \
           -m "implement-audit: codex, 2 rounds, 5 findings (5 fixed, 0 open) — APPROVE"
```

The gate only checks that the line is present, so it cannot tell a real trailer from an invented one.
Writing one for a review that did not happen is the one thing that turns this gate into theatre.

If the push is rejected (non-fast-forward, auth, network), `scripts/push-with-retry.sh` handles a
bounded retry — invoke it rather than hand-rolling a loop:

```bash
bash .claude/skills/close/scripts/push-with-retry.sh "$(git rev-parse --abbrev-ref HEAD)"
```

`scripts/detect-mode.sh` is available if you need to confirm the session's working-tree context before
committing; for a standard close it isn't required.

When the push lands, state it plainly in the closing summary: the branch and SHA now on the remote, so
the user knows nothing is lost by closing the tab.

## Examples

**Quick fix (no audit).** The user runs `/close` after a 5-minute edit to a single README. §1 skips
(no substantial code change). §2 appends the journal entry with labeled markers. §3 skips (no project
touched). §4 stages the README, commits with a verb-led subject, pushes. Summary names the pushed SHA.

**Auto-close after /implement.** The user runs `/implement my-feature` and does NOT type `/close` —
`/implement`'s terminal `auto-close` gate fires it (marks `close-fired.sh`, dispatches `/close`). §1
reads the marker, gets `done`, and takes the stored `implement-audit:` trailer for the commit — no
second review. §2 writes the journal entry. §3 updates the project README status to completed. §4
commits the implementation + report + journal + README with that trailer, and pushes.

**Auto-close after /spec.** `/spec` writes the SPEC, spirit-check passes, and its `auto-close` gate
dispatches `/close`. §1 skips (SPEC-only, no code). §2 journals the SPEC session. §4 commits the SPEC to
main. The user reviews it in the fresh `/implement` tab — there was no sign-off halt.

**Close after ad-hoc work.** The user fixed a bug by hand (no `/implement`), touching ~120 lines across
`apps/parser/`. §1 reads the marker, gets `fresh`, sees a large unaudited diff, and dispatches
`/implement-audit` — 2 must-fix + 1 should-fix findings, all ready, all fixed this session. §2–4 run as
normal, with the trailer the audit printed.

**Ops-only close.** The session was rule edits and journal cleanup, no code. §1 skips. §2–4 still run:
journal entry, commit the rule edits, push.

## Troubleshooting

| Failure | Symptom | Fix |
|---|---|---|
| Audit returns ready fixes | `/implement-audit` lists must-fix / should-fix items | Fix every ready finding this session per `@rule:no-deferral`. The re-review loop and its round cap live inside `/implement-audit`; let it run them. |
| The audit ran twice | two reviewer calls on one diff | The marker was not written — `audit-dedupe.sh mark` only records when a session id is set. Check `CLAUDE_CODE_SESSION_ID`; without one the guard fails safe (always `fresh`) and you carry the trailer inline. |
| Commit rejected: missing trailer | `check-audit-trailers.sh` fired | The commit changes code or a SPEC and carries no `implement-audit:` / `spec-audit:` line. Get the real one from §1's marker or by running the audit; do not invent one. |
| Commit rejected by hook | `commit-gate.sh` exits non-zero | Read the hook's message; fix the named issue (subject shape, staged content) and re-commit. |
| Push rejected | `git push` non-fast-forward / auth / network | Run `scripts/push-with-retry.sh`; if it exhausts retries, resolve out-of-band, then re-run. |
| Journal format off | A future `/project` or review can't parse the entry | Format SSOT is `@rule:journal-format`: labeled markers (Action / Changes / Decisions / Issues / Lessons / Next). Fix the field in-place via Edit. |
