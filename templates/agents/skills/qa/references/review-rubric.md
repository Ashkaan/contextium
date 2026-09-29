# QA Review Rubric

The measurable half of a visual review. Loaded by `step-4-fresh-review` and pasted into the reviewer subagent's brief.

Everything here is a NUMBER the reviewer can check against a PNG, or a STATE it can be asked to render. Vibes ("does it feel polished") are excluded on purpose — they produce unfalsifiable findings.

**Design specifics are not in this rubric and never will be.** Type ramp, palette, spacing scale, motion character, font pairing, dark-mode weighting — none of it lives here. Every app gets a fresh design, so a globally-prescribed look gets in the way rather than helping. Each app's own `DESIGN.md` is the sole design authority. Where a threshold below carries a number, it is there because it holds regardless of what the design looks like — legibility, reach, contrast, and whether the thing works.

**That paragraph was right about prescribing a look and wrong about the consequence.** Delegating the design left no check on whether the delegated authority existed. `gen-design-md.ts` auto-writes `DESIGN.md` on a repo's first run as a token inventory with creative direction "intentionally omitted", so the design-system checks ran against nothing and the run reported clean forever — a portal can pass `/qa` repeatedly while its owner finds it plainly bad. Two things close that, and neither adds a design opinion here:

1. **The app must declare a system.** A `DESIGN.md` that carries `design-authority: generated-stub`, or whose body declares none of the contract headings, is a stub, and `/qa` raises that as the run's FIRST finding at P1 — not as a clean result. `design-authority.sh` owns the rule.
2. **Divergence from what it declared is counted.** `system-drift.sh` measures the source against the app's OWN scales. A scale the app does not declare disarms its own measure; nothing here says what the scale should be.

This rubric still prescribes no type ramp, no palette and no spacing scale. It now requires that the app prescribe them, and it counts the gap.

## Severity

Every finding carries P0–P3. The tiebreaker when two levels seem plausible:

> **Would a user contact support about this? If yes, it is at least P1.**

| Level | Meaning |
|---|---|
| P0 | Blocks the task. Unreadable, unclickable, data loss, broken layout at a supported width. |
| P1 | Task completable but degraded. Support-ticket territory. |
| P2 | Craft defect. Noticeable to a careful user, no functional cost. |
| P3 | Polish. |

Ship gate: no P0, no P1. P2/P3 are reported, not blocking.

## Legibility and contrast

| Check | Threshold |
|---|---|
| Body size | Content-bearing text ≥14px at any width. This is a legibility floor, not a type-scale opinion — the detector's own floors sit lower (12px/11px), so this row is the binding one. Presentations ≥18px: a deck is read from across a room. |
| Body text contrast | 4.5:1 minimum (WCAG AA). A contrast failure on content-bearing text is **P1**, not polish. |
| Large text (≥18px, or ≥14px bold) | 3:1 minimum. |
| UI component / focus indicator | 3:1 against adjacent colors. |

## Layout and interaction

| Check | Threshold |
|---|---|
| Touch targets | 44×44px minimum (44pt iOS / 48dp Android). Applies to every tappable element, not just buttons. Expanding the hit area with a pseudo-element (`::before { inset: -10px }`) counts — the visual element does not have to grow. |
| Keyboard focus | Every interactive element shows a focus indicator on keyboard entry, driven by `:focus-visible` (not `:focus`, which also fires on mouse click). A bare `outline: 0` with no replacement in the same rule is **P1** — keyboard users never see hover. How the indicator LOOKS is the design's call. |
| Overflow clipping | A positioned child (dropdown, tooltip, popover, menu) inside an `overflow: hidden/auto/clip` ancestor gets cut off. The single most common generated-code layout bug. Check every menu and dropdown, and check them at the narrowest shot. |
| Overlay remedy | The fix is the Popover API (top layer, above everything regardless of `z-index`, no portal needed) or CSS Anchor Positioning with `@position-try` fallbacks. Anchor positioning is Chrome/Edge 125+ and absent in Firefox/Safari, so a fallback is required, not optional. |
| Flex/grid overflow | Long unbreakable strings blow out tracks unless children carry `min-width: 0` and tracks use `minmax(0, 1fr)`. Bare `1fr` is the bug — the classic mobile cutoff. |
| Responsive by input, not width | Where the concern is input, key off capability (`@media (pointer: coarse)`, `@media (hover: hover)`), not width — a hover-only affordance is unreachable on touch. Functionality MUST NOT disappear at small widths; it is reorganised. Prefer container queries (`container-type: inline-size`) for component-level adaptation — a component's available width is not the viewport's. |
| Destructive actions | Prefer undo over a confirmation dialog — users click through confirmations without reading. Where the action cannot be reversed (permanent delete, an outbound send, anything touching other people's data), undo is not available and a confirmation naming the consequence IS required. |
| Validation timing | On blur, not on every keystroke (password strength is the exception). Per-keystroke validation shows an error for a value the user has not finished typing. |

## Interface copy

| Check | Threshold |
|---|---|
| Control labels | Name the action and its scope ("Delete 5 items", "Keep editing"). "OK", "Submit", "Yes"/"No" do not tell the user what is about to happen. |
| Term consistency | One term per concept, and the term must match the consequence — "delete" reads as permanent, "remove" as recoverable. Mixing them misleads. |
| Error messages | Answer three things: what happened, why, and what to do next. An error naming only the failure leaves the user stuck. |

Tone, voice, and personality are the product's own and are governed by its own voice guide, not measured here.

## Motion

Whether a surface moves at all is the design's call, not this rubric's. What is checked is whether declared motion actually works and whether the accessibility fallback is honored.

Evidence is `motion/manifest.json` (what the page DECLARED, via `document.getAnimations()`) plus the frame burst `<route>-<width>-t{0,120,260,520}.png` (what actually MOVED).

| Check | Threshold |
|---|---|
| Declared but not running | An animation the page declares that produces identical frames across the burst is wired and broken — **P1**. An empty declaration list is NOT a defect. |
| Reduced-motion honored | With `--reduced-motion` the SAME route must go to ≤1 distinct frame. Still animating is a **P1** accessibility failure. |

`getComputedTiming().easing` reports `linear` for CSS animations regardless of the real curve — the easing lives on the keyframes, not the effect. Do NOT report "all easings are linear" from the manifest.

## State and edge coverage

Screenshots of the happy path prove almost nothing. Ask for these explicitly; each is a separate shot or a stated "not reachable in this run".

| Axis | What to render |
|---|---|
| Empty | Zero items, and WHICH empty: first-use (show the value, offer a template), user-cleared (light touch, easy to recreate), no-results (suggest a different query, offer to clear filters), no-permission (explain why and how to request access), error (what failed and the retry). They want different copy and different affordances. |
| Loading | Every async surface renders a loading state. A control that gives no feedback between click and result reads as broken, and the user clicks again. |
| One | Single item. Catches grids that need ≥2 to look right. |
| Max | 1000+ rows, 50+ options, very large numbers. |
| Long text | 100+ character names and titles. |
| Character class | Emoji, RTL (Arabic/Hebrew), CJK, accented Latin. Length in characters is not length on screen. |
| Translation swell | Budget 30–40% growth. German ~+30%, Finnish +30–40%, French +20%, Chinese −30%. A layout tight in English breaks in German. |
| Error | 400 validation, 401 relogin, 403 permission, 404 not-found, 429 rate limit, 500 generic + support path. |
| Concurrency | Submit clicked 10× fast. Button must disable while in flight. |
| Permission | No-view, no-edit, read-only variants. |
| Zoom | 200% browser zoom without loss of function. |

This extends boundary inputs (0/1/empty/max/error) with the four axes a numeric framing has no slot for: character class, rendered-vs-semantic length, concurrency, and permission state. The rule's discipline still governs — enumerate EXPECTED BEHAVIOR at each, don't merely visit them.

## Performance and stability

Not readable from a still. Report these only when the run had a live page, and say so when it did not.

| Check | Threshold |
|---|---|
| Core Web Vitals | LCP <2.5s, CLS <0.1, INP <200ms. |
| Layout thrash | Reads and writes to layout properties batched, not interleaved in a loop. |
| Offscreen work | Long lists use `content-visibility` / `contain` so offscreen content is not laid out every frame. |
| `will-change` scoping | Applied to the element that actually animates, and removed after. Left on broadly, it holds compositor layers and costs memory. |

## Drift classification

When the reviewer finds a deviation from the design system, it must classify the cause, because the fix differs:

| Class | Meaning | Fix |
|---|---|---|
| Missing token | The value should exist in the system and doesn't | **Propose it and ask.** A new color, gradient, radius, shadow, font, or effect is a design-system expansion, not an implementation detail — name the addition, the role it plays, and why the existing tokens cannot do the job. Do not invent it silently. |
| One-off implementation | A shared component exists but wasn't used | Swap to the shared component |
| Conceptual misalignment | The flow, IA, or hierarchy doesn't match neighboring features | Rework the flow |

Naming only the symptom is how drift compounds. A settings page exposing 40 fields where the rest of the app reveals 5 at a time is drift even if every field is perfectly styled.

## Design-system divergence

Measured by `system-drift.sh` against the app's own `DESIGN.md`, never against a
house style. **A key the app does not declare disarms its measure and cannot
fail.** One finding per distinct off-scale VALUE, carrying its occurrence count
and up to five `file:line` examples — not one per occurrence, because 467
findings is a dump rather than a review.

| Measure | Armed by | What counts as drift |
|---|---|---|
| Type size | `typography.scale` (or `typeScale`) | A `text-[Npx]` or a raw `font-size` whose pixel value is not on the declared ramp. Named utilities are not compared — `text-center` is not a size |
| Colour | `colors` | A raw Tailwind palette step (`bg-slate-100`), or a hex/rgb/hsl literal that is not a declared value. A `var(--token)` reference is never drift |
| Control height | `controlHeights` | A `h-*` / `min-h-*` on an interactive element whose pixel height is not one of the declared sizes |
| Recipe | `componentVariants` | An element rendering the raw platform tag for a role the system has a component for. **A claim to adjudicate, never a defect** |
| Native widget | always | `<select>`, or an input of type date / datetime-local / month / week / time / color / file / range / number, with no `appearance-none` |

| Severity | When |
|---|---|
| **P1** | A native platform widget. The user is looking at an unstyled OS control, and no design system survives that, so it blocks regardless of count |
| **P1** | No design authority, or a stub one. The design-system checks are running against nothing |
| **P2** | An off-scale value used ten or more times. Systemic drift |
| **P3** | Fewer than ten. A one-off |
| claim | A recipe that maps to no declared variant. For the reviewer to rule on |

No measure emits P0: a scanner cannot know what blocks a task.

## What this rubric cannot check

**A design can be internally consistent and still be ugly.** Everything in the
section above measures whether the app matches the system it declared for
itself; none of it measures whether that system is any good, or whether the
result is beautiful. Consistency is the floor, not the verdict, and a portal can
pass every measure here and still be the thing somebody opens and dislikes. That
judgement is the fresh-eyes pass and the person who asked for the work.

State plainly rather than guessing. Motion character (duration, easing, stagger) is invisible in a static PNG and is the design's call anyway. Perceived performance, focus ORDER, and screen-reader output need a live pass. Font-loading setup (`font-display`, `font-optical-sizing`, fallback metric overrides) and safe-area insets are source-only — a headless shot has no notch and no swap event. A clean rubric run is a floor, not a verdict.

## Known detector false positives

Carried from the detector steps (`step-2.6-impeccable`, `step-2.6b-system-drift`) so the reviewer can reject them confidently:

| Signature | Reality |
|---|---|
| `#ffffff on #ffffff`, 1.0:1 | Gradient background the engine can't resolve; it defaults to white (white text on a dark gradient reports this way and is fine). Confirm against the PNG before reporting. |
| `overused-font` / `single-font` | An opinion about font popularity, not a defect. Report as taste input only. |

## Judgment frameworks

The rubric above is measurement. These are the lenses for what measurement misses. Use them when the review is a real critique rather than a regression check.

### Cognitive load

Working memory holds ~4 items (Cowan 2001, correcting Miller's 7±2). Count what a single decision point asks the user to hold at once and report where that is exceeded. How many items a design chooses to show is its own call; report the load, not a prescribed count.

### Nielsen heuristics, scored 0–4

Visibility of status · match to the real world · user control and freedom · consistency and standards · error prevention · recognition over recall · flexibility · error recovery · help and documentation.

Anchor each: 0 = absent or actively harmful, 2 = present but shallow (names the problem, not the fix), 4 = genuinely excellent. Sum /36 — 32–36 excellent, 25–31 good, 18–24 acceptable, 11–17 poor, below 11 critical. Most real interfaces land 18–29; a 4 must be earned.

Treat the total as ordinal, not cardinal. It forces a justified position per dimension. It is not a measurement, and a 3-point move between runs is noise, not a regression.

"Aesthetic and minimalist design" is dropped from the original ten — it scores how a design looks, which this rubric does not.

### Persona pass

Run the page as five readers, and report what broke for each rather than describing the persona:

| Persona | Reads for |
|---|---|
| Power user | Speed, shortcuts, density, escape hatches |
| First-timer | Orientation, what this is, what to do first |
| Assistive-tech user | Focus order, labels, contrast, keyboard reachability |
| Stress-tester | Long strings, rapid clicks, back button, refresh mid-flow |
| Mobile user | Thumb reach, one-handed use, viewport truncation |

### Ordering constraint

Deterministic findings enter the judgment pass AFTER the human-style review, never before. Detector output anchors attention toward what a scan can see, even when every finding is correct. `/qa` implements this: `step-2.6-impeccable` and `step-2.6b-system-drift` run first, but their output reaches the reviewer as claims to adjudicate, not as a starting frame.

## Presentation decks

Applies when the target is a slide deck (and any per-audience editions of it). Everything above still applies; these are additional.

| Check | Threshold |
|---|---|
| Navigation completeness | Arrow keys (←→↑↓), Space, PageUp/Down for prev/next; Home/End for first/last; click (left third = back, rest = forward); touch swipe (horizontal or vertical); debounced scroll wheel. A missing input is **P1** — audience hardware varies and a dead key strands the presenter mid-talk. |
| Orientation chrome | The audience can tell where they are without input: progress through the deck and the current slide number are both visible. Missing either is **P1**. Placement and styling are the deck's call. |
| Re-theme blast radius | A per-audience re-theme should touch the deck's theme stylesheet only — its token values and brand block. A diff that edits the slide markup for colour, typeface, or logo is a finding: the deck is re-themed, never forked. |
| Theme actually applied | Screenshot the re-themed deck and compare backgrounds against the intended tokens. A script that hardcodes background hexes makes a re-theme silently keep the old ones; it must read the CSS custom properties. |

### Clipping on decks needs a control

MUST measure the unmodified source deck the same way before treating any
overflow as a regression. Absolutely-positioned decoration on
`overflow-hidden` sections makes `scrollHeight` exceed `clientHeight` on
several slides of a typical deck. That measurement is not evidence of
clipped content — the screenshots are.

### Honesty guards

A clean rubric run is a floor, not a verdict. Never cite a clean scan as proof the work is good. Zero findings is a permitted result; padding a report with speculative items to look thorough is worse than saying it looked fine and naming what went unchecked. If any part of the review degraded (no PNGs, no live page, no subagent), the report's first line must say so.
