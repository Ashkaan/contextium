---
paths: null
---

# Decision Records

Where a choice that would be expensive to reverse is written down. Always loaded.

## decision-records
A decision that would be expensive to reverse — a data format, a vendor, a layout other work builds
on, a rule of the loop itself — MUST get a record in a `decisions/` folder, in the narrowest home
containing everyone who could act contrary to it. The format, the placement rule and the check are
written ONCE, in `decisions/README.md` at the repo root; MUST follow it and MUST NOT restate it.

A record is `accepted` only when it quotes, with a date, the words of the person who accepted it. An
agent MUST write `proposed` over a discussion that did not decide, because a record that overstates
what was agreed is worse than none: the next session treats it as settled.
`.githooks/checks/check-decision-records.sh` runs at pre-commit and at `/close`. [2026-09-22]
