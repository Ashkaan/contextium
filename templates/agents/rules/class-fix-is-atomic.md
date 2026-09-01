---
paths: null
---

# Class Fix Is Atomic

When the same flaw exists in several places, fix all of them in the same session. Always loaded.

## class-fix-is-atomic
When the flaw you are fixing is a **shared pattern** — a helper several files call, a convention
repeated across siblings, the same mistake made in five places — MUST fix every instance in the same
session. MUST NOT fix one and leave the rest as a follow-up, a "Phase 2", or a note in a README.

**"Atomic" means same-session completion across every peer, not one edit or one file.** Five edits in
five files complies. A shared helper is one convenient way to get there, never a requirement.

**The sweep is part of the obligation, not its boundary.** A search too narrow to reach the peers
fails this rule exactly as leaving a found peer unfixed does, and so does reading only the first
screen of the results. If the reviewer finds a peer you missed, the sweep was too narrow — widen it
and fix what it turns up.

Peers are not only code. A colour or size changed at one call site while identical siblings keep the
old value is a class fix. So is a contract asserted in two places and checked in neither.

**Deferring is not one of the options.** The one exception is a peer that genuinely cannot be
migrated because something it needs does not exist yet AND building it requires a decision the user
has not made — in which case ask them, at that moment, naming the specific peer. "Too much work",
"more risk", "would need the tests restructured" are effort preferences, not impossibilities.

Run the sweep BEFORE the fix, not after: `/implement`'s peer-sweep step turns "did I get them all?"
into a list you work through, and the code review is the backstop, not the mechanism. [2026-04-23]
