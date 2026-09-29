---
name: qa
description: See the real running product of any app in your workbench, find its design problems, fix them, and explain what changed. Use after a UI change, before/after committing, when asked to QA, screenshot, fix, or visually verify a web app, or to confirm a portal renders correctly at desktop/tablet/phone. CLI/library targets capture stdout instead of screenshots.
metadata:
  peers: ".agents/skills/qa/scripts/detect-app.sh .agents/skills/qa/scripts/discover-routes.sh .agents/skills/qa/scripts/serve.sh .agents/skills/qa/scripts/screenshot.sh .agents/skills/qa/scripts/sight-check.sh .agents/skills/qa/scripts/sight-stamp.mjs .agents/skills/qa/scripts/a11y.sh .agents/skills/qa/scripts/gen-design-md.ts .agents/skills/qa/scripts/design-authority.sh .agents/skills/qa/scripts/design-frontmatter.mjs .agents/skills/qa/scripts/element-scan.mjs .agents/skills/qa/scripts/interaction-check.sh .agents/skills/qa/scripts/interaction-check.mjs .agents/skills/qa/scripts/system-drift.sh .agents/skills/qa/scripts/impeccable-detect.sh .agents/skills/qa/scripts/lib.sh .agents/skills/qa/scripts/ensure-playwright.sh .agents/skills/qa/scripts/mark-qa-done.sh .agents/skills/qa/scripts/qa-targets.sh .agents/skills/qa/references/review-rubric.md .agents/skills/review/policy-review.sh"
---

# /qa — see the real running product

## Critical

- **`/implement` REQUIRES this, and will not close without it.** `/implement` phase-4.8 runs `scripts/qa-targets.sh` over its diff. Every web target it prints gets a full `/qa` — impeccable on `@latest` (step-2.6), its fixes (step-2.7), screenshots, sight-check, fresh-context visual review — and `validate.sh --require-qa` then refuses the close until each one has a marker for the tree that is about to ship. "Fully" is not a posture here, it is the gate's definition: a `/qa` that stopped after impeccable writes no marker, and the session does not close. `scripts/mark-qa-done.sh --tree <sha>` writes that marker, only at step-6-teardown, only after the review passed — never by hand, and never early.
- **The automatic trigger is `/implement`, not a hook.** Phase 4.8 runs `validate.sh --phase qa-list` and `--require-qa`, so a session that changed a web app cannot close without a finished `/qa`. Invoking `/qa` by hand is the manual override.
- **Tools install on first use; a missing tool is a skip, never a pass.** Playwright and Chromium (`ensure-playwright.sh`), impeccable (`impeccable-detect.sh`, which also upgrades it when a newer version is published) and the axe packages for `--a11y` install the first time they are needed — nothing at install time. When one cannot be installed (offline, no npm, `QA_NO_INSTALL=1`), the script prints `qa: skipped — Playwright unavailable (<reason>)` or `impeccable: detector unavailable — <reason>`; repeat that line to the user word for word and write no marker. The sight stamp uses ImageMagick (`magick`) when installed and Playwright otherwise, so it needs nothing extra. Node 22.18+ is assumed (it runs `gen-design-md.ts` directly).
- **A design authority that contains no design is a P1, not a pass.** `/qa` delegates the entire look question to the app's own `DESIGN.md` — correct — but a delegated file can hold no design. `gen-design-md.ts` writes a token inventory on a repo's first run, the `design-system-*` checks run against it, and the result is clean forever; that is how a portal passes `/qa` while its owner finds it plainly bad. `design-authority.sh` (step-2.5) now raises the missing system as the run's first finding, and `system-drift.sh` (step-2.6b) counts how far the source has drifted from whatever the app DID declare. Neither adds a design opinion to this skill: the rubric still prescribes no type ramp, palette or spacing scale.
- **Evidence, not assertion.** The deliverable is the manifest (page x viewport -> path, bytes, http-status) + the fresh-context findings, NOT "looks good." Give the agent a runnable check, and show the evidence.
- **The builder does not grade itself.** `step-4-fresh-review` dispatches a fresh-context subagent (in Claude Code, the `Task` tool; elsewhere, the harness's subagent or a new session) that Reads the PNGs and checks geometry — never inline-QA in this orchestrator. Hot-context self-review produces motivated reasoning.
- **Zero-config — no `.qa.json`.** Routes come from whichever file-based routing dirs the repo actually has — `src/pages/`, `pages/`, `app/`, `src/app/` (`discover-routes.sh`); the live URL from `--live-url`, or the Cloudflare Pages registry when wrangler's credentials are set. `DESIGN.md` is the only per-repo file the QA process involves, and `/qa` commits it itself (step-2.5-design-md).
- **Never guess a serve command.** Node-server / CLI / render targets REQUIRE a `qa:*` script in the repo's own `package.json` (`qa:serve` / `qa:cmd` / `qa:render`). Only Astro / Vite / static get a convention default.
- **Own your processes.** Teardown signals only the process group `serve.sh` started + removes only the worktree it created. Never global-`pkill workerd`/`wrangler` — that kills other repos' servers on the same machine. Ownership is proved at STARTUP too: the health check refuses a listener that is not in the process group this run spawned (unless the port was verified free the instant before spawning). Answering on a port is not evidence of owning it — a stale server from another repo answers 200 all day.
- **CLI/Node Playwright only** — `npx playwright` or an inline Node script importing the `playwright` package. No Playwright MCP server; the Node API is what `screenshot.sh` is built on.

## When to use vs. the neighbors

| Tool | Verifies | /qa relationship |
|---|---|---|
| `/qa` | the **running UI** at multiple sizes, reviewed by fresh eyes | this skill |
| `/implement` Phase 4 | code-level 5-layer ladder (lint, tsc, tests, checks, review) | complements — code vs. pixels |
| `/qa --keep` | leaves the app running so you can drive it | the screenshot-first way to launch it |

## step-0-resolve-target

Args: `target` (an app directory — a repo, or an app folder inside one; default = the repo of cwd). `page ...` = routes (default = auto-discovered from `src/pages/` by `discover-routes.sh`). Flags: `--before` (default) | `--after` | `--live [--live-url <url>]`, `--keep`, `--a11y`, `--viewports W,W,W`.

```bash
TARGET="${1:-$(git rev-parse --show-toplevel)}"   # resolve to an absolute directory
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
```

## step-1-detect-and-discover

```bash
S=.agents/skills/qa/scripts
TYPE="$(bash "$S/detect-app.sh" "$TARGET" | sed -n 's/^TYPE=//p')"   # exit 3 -> halt, print signals
```

An undetectable type stops here. Surface the exact message; do NOT invent a command. `/qa` is zero-config — there is no `.qa.json`; the non-convention types declare themselves with a `qa:*` script in their own `package.json`.

**Branch on `TYPE` BEFORE anything else** — `detect-app.sh` returns `astro-cf | astro | next | vite | static | node-server | render | cli | unknown`:
- `render` → skip serve + screenshot; go to `step-5b-render` (the repo's `qa:render` script produces the PNGs). The universal hatch — TRMNL Liquid, HTML-to-image, anything non-served. **Route discovery does NOT apply.**
- `cli` → skip to `step-5-cli` (stdout is the evidence). **Route discovery does NOT apply.**
- `astro-cf` on a CF-Access-gated portal → see **§ Cloudflare portal recipe** before choosing `--before` vs `--live`.
- everything else → `step-2-serve`.

**Routes are discovered, not tracked — and by `serve.sh`, against the SERVED source.** For a served type, `serve.sh` (step-2) walks every file-based routing dir (`src/pages/`, `pages/`, `app/`, `src/app/`) of the exact revision it serves (the HEAD worktree for `--after`, the working tree for `--before`/`--live`) and emits `QA_PAGES`. Discovering there — not here against the possibly-dirty working tree — is what keeps `--after` honest: an uncommitted added/removed page can't produce a 404 or a missed shot for the committed revision the label claims. `QA_PAGES` empty (source has no static routes) with NO explicit `page` arg → HALT and ask which route(s) to shoot; never fabricate `/` (no guessing). An explicit `page ...` arg always overrides (scoped run). Next repos ride the same walk: under App Router the DIRECTORY holding a `page.*` file is the route, `(group)` segments are organisational and never appear in the URL, `@slot` parallel routes are not standalone URLs, and `[param]` routes are skipped rather than shot as a literal bracket path.

## step-2-serve

```bash
eval "$(bash "$S/serve.sh" up --repo "$TARGET" --mode "$MODE" --run-id "$RUN_ID" | grep '^QA_')"
# MODE = before|after|live. Captures QA_URL, QA_PORT, QA_LABEL, QA_RUNFILE,
# QA_PID, and QA_PAGES (routes discovered from the served source).

# Resolve the page set: explicit `page` args win; else the discovered QA_PAGES.
PAGES="${PAGES:-$QA_PAGES}"
if [ -z "${PAGES// /}" ]; then
  echo "qa: no static routes in the served source and no explicit page arg — HALT." >&2
  echo "    Pass the route(s) to shoot, e.g. /qa $TARGET / /about --$MODE" >&2
  # stop here; do NOT screenshot a fabricated '/'
fi
```

`--before` serves the working tree; `--after` builds a clean `git worktree` of HEAD so uncommitted edits don't leak into the shot; `--live` hits the deployed URL and skips the build.

**`/qa` is zero-config — every repo runs with no per-repo config file.** Astro / Vite / static targets get convention defaults. For `--live`, `--live-url <url>` (or `QA_LIVE_URL`) names the deployed site; without it, `serve.sh` resolves the URL from a Cloudflare Pages registry lookup (`qa_derive_live_url_from_cf` in `lib.sh`, using wrangler's `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) that matches the repo against each project's `source.config.repo_name` and returns that project's custom domain — cached 6h at `/tmp/qa-cf-pages-cache.json`. That is a lookup in an authoritative registry, not inference from the directory name; the two genuinely differ (a repo named `site-web` deploying to `example.com`), which is why the heuristic would be wrong and the API is not. A site behind Cloudflare Access gets a service token when you name its 1Password item in `QA_ACCESS_OP_ITEM` (or set `QA_CF_ACCESS_ID` / `QA_CF_ACCESS_SECRET`). The only per-repo declaration `/qa` ever reads is a `qa:*` script in `package.json` for the non-convention types (`node-server`, `cli`, `render`); a CF-deployed Astro app needs nothing. Build/serve failures halt with the log tail. If detection returned `render`/`cli`, skip to `step-5b-render`/`step-5-cli`.

**No local data seed.** A `--before` build of a portal that reads a remote store renders empty/no-data states by design. For data-correctness QA of those portals, use `--live` (real data) or read the production store directly (§ Cloudflare portal recipe).

For an `astro-cf` target, serve.sh tries `wrangler pages dev` first (real CF bindings) and, if workerd won't boot, automatically falls back to `astro dev` (Vite, serves source, **no** CF bindings — `QA_LABEL` says so). The fallback server renders layout faithfully but has no production data; verify real DATA against the production store directly, not this server (§ Cloudflare portal recipe).

## step-2.5-design-md

`DESIGN.md` is impeccable's token allowlist — the file that arms the `design-system-*` checks impeccable 4.1.0 emits: `design-system-color`, `design-system-radius`, `design-system-font-size` and `design-system-font`, armed by `colors`, `rounded`, the `fontSize` and the `fontFamily` of the `typography` entries (measured against page fixtures and a real portal's built stylesheet). Each section independently gates its own check; an absent section makes that check pass everything. Without any `DESIGN.md` the design-system layer is structurally off, and a clean result means "not checked," not "conformant."

**And nothing else checks that the delegated authority contains a design.** That is the hole, and it is worth stating precisely because the delegation itself is correct. `/qa` hands the whole question of what an app should look like to the app's own `DESIGN.md` — right, because every app gets a fresh design and a globally prescribed look gets in the way. But `gen-design-md.ts` writes that file on a repo's first run as a token inventory whose creative direction is, in its own words, "intentionally omitted": no type ramp, no spacing scale, no control sizes, no field or focus anatomy, no empty state. So an auto-generated stub becomes the baseline, the design-system checks run against nothing, and the run reports clean forever: a clean `/qa`, on a portal its owner finds plainly bad.

The frontmatter follows the published DESIGN.md format (`google-labs-code/design.md`), which impeccable reads; `npx @google/design.md lint DESIGN.md` checks a file against it, and a token map outside its five keys (`colors`, `typography`, `rounded`, `spacing`, `components`) is ignored by that tooling. A `spacing` map or a `components` section changes nothing impeccable reports (probed against page fixtures); those sections serve the published schema and `system-drift.sh`, which reads `spacing` and `components.control-*` heights when the older `spacingScale`/`controlHeights` keys are absent.

If the repo has no `DESIGN.md`, generate one from the tokens already in the repo. Token extraction is data, not judgment, so it's a script, not an LLM pass — ONE file, no `.impeccable/` sidecar:

```bash
node "$S/gen-design-md.ts" "$TARGET"   # exit 3 = already exists (skip); exit 4 = no tokens found
```

The generator greps CSS custom properties, a Tailwind theme, and font-family declarations, and emits only the classes it finds (shadcn HSL-channel tokens are wrapped as `hsl(...)`; literal-hex palettes pass through). It never overwrites an existing `DESIGN.md` — that file may be hand-refined. **On a repo's first run the fresh file finds ~0 drift by construction** (the code matches the file just made from it) — which looks like a benign fact and is not one: it is the whole defect. Everything the generator writes now carries `design-authority: generated-stub`, and the gate below turns that zero-drift result into a P1 instead of a pass.

### The stub gate

```bash
bash "$S/design-authority.sh" status "$TARGET"   # 0 real · 3 stub or missing · 2 unparseable
```

**One rule, two limbs.** A `DESIGN.md` is a STUB iff it carries
`design-authority: generated-stub`, **or** its body declares none of the design
contract headings (type, weight, spacing, radius, control, field, focus, status,
empty/loading/error, elevation). Both, because a marker alone would exempt every
`DESIGN.md` generated before the marker existed — which is the entire population
that has the problem — and a heading scan alone would pass a hand-written file
that lists tokens under a "## Colors" heading and calls it a system.

On exit 3 the run's **first finding is P1**: *this app has no design system; the
design-system checks are running against an auto-extracted token list and cannot
fail.* A human DELETING the key is the act of claiming the file is now a real
design. A file generated before the marker existed is backfilled with
`gen-design-md.ts --mark-existing <repo>`, which only touches files matching the
generator's own output shape and leaves a hand-written one alone.

**Then commit it — `/qa` made the file, `/qa` lands it.** A generated file left untracked leaves the target repo dirty and the next agent guessing whose it is, and whether committing it is even in scope. It is: this is `/qa`'s own artifact, so it gets its own commit, that file only.

```bash
if [ -n "$(git -C "$TARGET" status --porcelain -- DESIGN.md)" ]; then
  git -C "$TARGET" add DESIGN.md
  git -C "$TARGET" commit -q -m "add DESIGN.md design-token allowlist generated by the QA harness" -- DESIGN.md
fi
```

The `-- DESIGN.md` pathspec is what keeps the commit to one file when the working tree has other edits in flight (it usually does — `/qa` runs mid-change). Commit only, do NOT push: these repos deploy on push, and a doc file must not trigger a site deploy; it rides the next real push.

## step-2.6-impeccable

Run impeccable against the **rendered page**, where its coverage is real. Measured: identical markup yields 12 findings as a live page vs ~4 as source files, and the styling idiom barely moves the source number (Tailwind 4, styled-components 3, inline `style={{}}` 2). So point it at `QA_URL`, not `src/`.

```bash
bash "$S/impeccable-detect.sh" "$TARGET" "$QA_URL"
```

The script always exits 0 — a detector CRASH must never fail a QA run. That is not permission to SKIP this step: surviving a blown-up detector and omitting the step are different things, and there is no path on which step 2.6 does not run. `/implement`'s gate takes the same line — a crash is survivable, an omission is not.

**It runs the INSTALLED shim, kept at the latest version.** Impeccable's rules move, and a pin is a promise to stop learning what they learn. So the script compares `impeccable --version` with `npm view impeccable version` and runs `npm install -g impeccable@latest` when the copy is missing or older — once, not on every call the way `npx impeccable@latest` would. Offline it runs the installed copy and says the check could not happen; a failed upgrade runs the installed copy and names its version; a failed first install is `detector unavailable`. The engine that scans the page is resolved by the shim out of the CLI package; impeccable is a tool here, not a skill. Do not pin a version anywhere, and never run the package's `install` verb: it writes into every harness home.

**"Clean" and "could not check" are different lines now.** The old call was wrapped `|| true`, so a broken install printed exactly what a clean page printed — silence — and a reader of the transcript could not tell which had happened. The script prints `impeccable: clean` only when the engine actually ran and returned nothing, and `impeccable: detector unavailable — <reason>` on every path where it did not. The step is still non-blocking either way.

And it stays HERE, inside `/qa`, rather than moving into `/implement`'s `validate.sh`: it needs a rendered page at a live URL, which only this skill has, and a second caller would split one fact across two files.

Nor does the step-4 visual reviewer stand in for it. Contrast ratios and design-token drift are exactly what a rule engine is better at than a model reading a PNG, and the fresh-eyes pass should spend its tokens on judgment a rule cannot make.

Read the output with two known false positives in mind:

| Limit | Handling |
|---|---|
| Gradient backgrounds report as `#ffffff on #ffffff`, 1.0:1 | False positive. The engine can't resolve a gradient behind text and defaults to white — white on a dark gradient reports this way and is fine. Discount unless the PNG confirms it. |
| `overused-font` / `single-font` fire on the app's chosen face | Opinion, not defect, when the face is declared in the target repo's own `DESIGN.md` (the theme's canonical surface). Report as taste input; the design system wins. |

The prose checks (`marketing-buzzword`, `em-dash-overuse`, `aphoristic-cadence`) scan *rendered pages* — copy as the visitor reads it.

## step-2.6b-system-drift

Impeccable checks the rendered page against the token allowlist. This checks the
SOURCE against the scales the app declared for itself — the half nobody was
measuring.

```bash
bash "$S/system-drift.sh" "${QA_WORKTREE:-$TARGET}"
```

**Against the source `serve.sh` BUILT**, not the working tree. `serve.sh --after`
emits `QA_WORKTREE`; that is the revision that produced the screenshots, and
scanning the working tree instead would report a fix made mid-run as if it had
shipped.

It reads `DESIGN.md` frontmatter only, and **a key it does not find disarms its
own measure** — a repo that declares nothing fails nothing. Five measures, each
a fact about the source rather than an opinion about design:

| Measure | Armed by |
|---|---|
| Type sizes not in the declared ramp | the `fontSize` of each named `typography` entry (the published DESIGN.md shape); `typography.scale` or `typeScale` still read in older files |
| Colours not in the declared palette | `colors` |
| Control heights not in the declared set | `controlHeights`, or `components.control-*` heights in the published shape |
| Class recipes matching no declared variant for their role | `componentVariants`, or `<role>-<variant>` component entries (`button-ghost`) in the published shape |
| Native controls rendering the platform widget | always |

**One finding per distinct off-scale VALUE**, carrying its occurrence count and
up to five `file:line` examples — not one finding per occurrence, because 467
findings is a dump rather than a review. A value used ten or more times is P2
(systemic drift); under ten is P3 (a one-off). A native platform widget is P1
regardless of count: the user is looking at an unstyled OS control, and no
design system survives that. **No measure emits P0** — a scanner cannot know
what blocks a task. The fourth measure is deliberately NOT "how many distinct
recipes exist": the system itself permits several variants and three sizes, so a
raw count would invent a threshold. It reports recipes it cannot map to a
declared variant as CLAIMS for the reviewer to adjudicate, never as defects.

| Exit | Meaning |
|---|---|
| 0 | clean, and SILENT. No congratulation — a scanner finding nothing is a floor, not a verdict |
| 1 | findings; read the `P1=/P2=/P3=/claims=` summary line |
| 2 | unparseable frontmatter. Never a silent partial scan |
| 3 | no design authority, or a stub one. **Distinct from clean on purpose** |

**Exit 3, or any P1, means the run MUST NOT report clean.** Its findings reach
the step-4 reviewer as claims to adjudicate AFTER the human-style pass, per the
rubric's ordering constraint — detector output anchors attention toward what a
scan can see, even when every finding is correct.

## step-2.7-impeccable-fix

Impeccable pinpoints each finding by rule + file + line. Fix them right there — no subagent, no hunting. Several are near-mechanical: swap a dated easing curve, bump sub-floor text to the size floor, drop a gradient-fill on text, remove a one-side accent border. Skip the two false positives above.

**Rebuild before re-checking.** The app was already built and served in step 2, so source edits made here are NOT live on a static serve (`wrangler pages dev dist`, `astro build` + serve) — only a raw HMR dev server would hot-reload them. So after applying fixes, tear the old server down FIRST (else the next `up` health-checks the still-running stale process and the runfile PID gets clobbered), re-serve to rebuild, then re-run `impeccable detect` against the fresh URL:

```bash
bash "$S/serve.sh" down --runfile "$QA_RUNFILE"    # kill the pre-fix server before re-serving
eval "$(bash "$S/serve.sh" up --repo "$TARGET" --mode "$MODE" --run-id "$RUN_ID" | grep '^QA_')"
bash "$S/impeccable-detect.sh" "$TARGET" "$QA_URL"
bash "$S/system-drift.sh" "${QA_WORKTREE:-$TARGET}"
```

**All deterministic fixing happens here, before any AI looks, and the step-3 screenshots are taken from this rebuilt server** — never the pre-fix build. The fresh-eyes review is expensive and should spend its tokens only on judgment a rule can't make, not on tells impeccable already located and you already fixed.

## step-3-screenshot

```bash
# $QA_SLUG came from serve.sh up — the collision-safe slug (basename-cksum) that
# screenshot.sh + teardown must BOTH use, so a plain basename never mismatches
# serve.sh's own shots dir.
# On --live with QA_ACCESS_OP_ITEM set, serve.sh emits that op-item (QA_AUTH_*),
# so screenshot.sh resolves + sends CF-Access headers — 200 on a gated site,
# harmless extra headers on an ungated one. On an app whose wrangler config
# sets PROBE_ACTS_AS it also emits QA_AUTH_ACT_AS: the token alone is a machine
# there, and the act-as header is what makes it the person the app names.
AUTH=(); [ -n "${QA_AUTH_OP_ITEM:-}" ] && AUTH=(--auth-op-item "$QA_AUTH_OP_ITEM" --auth-id-field "$QA_AUTH_ID_FIELD" --auth-secret-field "$QA_AUTH_SECRET_FIELD")
[ -n "${QA_AUTH_ACT_AS:-}" ] && AUTH+=(--auth-act-as "$QA_AUTH_ACT_AS")
bash "$S/screenshot.sh" --url "$QA_URL" --repo-slug "$QA_SLUG" --run-id "$RUN_ID" \
  --pages "$PAGES" --viewports "${VIEWPORTS:-1440,820,390}" --app "$TARGET" ${AUTH[@]+"${AUTH[@]}"}
```

Prints the manifest table (route · width · path · bytes · http-status). Label the block with `QA_LABEL` (`working tree` / `HEAD worktree` / `live URL <url>`) so the user knows which revision they're seeing.

Every run also writes `motion/` — see `step-3.6-motion`. The stills are the
settled end state; they are not evidence about motion and never were.

**Exit 6 = identical shots, HALT.** The script sha256s every PNG and refuses to hand back evidence where two distinct routes rendered byte-identical at the same width. A green `200` on every row proves nothing on its own: CF Access serves its login page with status 200, and a dead client router or a catch-all does the same. Do NOT proceed to review — diagnose first (`curl -sI <url>/<route> | head -3` shows the 302). On `--live`, attach a service token (§ Cloudflare portal recipe), or switch to `--before` to bypass the gate entirely. Without this gate a `--live` run against an auth-gated site produces six shots of the login wall and a clean manifest, and the reviewer grades a login page.

**Exit 7 = Playwright unavailable, or an off-origin redirect** — the stderr line says which. `qa: skipped — Playwright unavailable (<reason>)` means no screenshots exist: report the skip, never a pass.

## step-3.6-motion

`screenshot.sh` captures motion on every run, by default, and prints a summary
line. Nothing extra to invoke — but the RESULT is a gate, so read it:

```
motion: 7/7 route×viewport captures declared animations; 7 showed frame-to-frame change
```

Read it for BROKEN motion, not for absent motion. A route that DECLARES an
animation but shows identical frames across the burst is wired and not running —
that is a **P1 finding**. A route that declares nothing is not a defect: whether
a surface moves at all is the design's call, and this harness does not hold a
position on it (an "every site should move" gate would be a design opinion, and
design specifics live only in each app's own `DESIGN.md`).

Why the capture runs with normal motion: `reducedMotion: "reduce"` looks like a
determinism setting and is not one — it makes the browser report
`prefers-reduced-motion: reduce`, so any app with an honest reduce-motion block
serves its ACCESSIBILITY FALLBACK to the camera, a rendering most users never
see. No reviewer could catch it, because a still of a suppressed animation looks
exactly like a still of an absent one.

`animations: "disabled"` on the still STAYS and is a different thing despite the
name: Playwright fast-forwards finite animations to completion for that shot, so
the still lands on the settled state instead of a half-faded frame. Turning it
off would not reveal motion — it would make every still catch a random point
mid-entrance and fill the geometry review with findings about washed-out text.

To check the accessibility axis deliberately, re-run the capture with
`--reduced-motion`: the same routes must then collapse to ≤1 distinct frame.
Still animating under that flag is a P1 accessibility failure.

```bash
bash "$S/screenshot.sh" --url "$QA_URL" --repo-slug "$QA_SLUG" --run-id "$RUN_ID-rm" \
  --pages "$PAGES" --viewports 1440 --reduced-motion --app "$TARGET" ${AUTH[@]+"${AUTH[@]}"}
```

## step-3.7-interaction

Screenshots show the settled page. This step uses it, on `--before` and
`--after` (never `--live`: that is production, and a finding there cannot be
fixed in this run). Each page is loaded once with its data held, then every
visible button is pressed on a fresh load with everything that could write held.

```bash
bash "$S/interaction-check.sh" --url "$QA_URL" --pages "$PAGES" --repo "$TARGET" ${AUTH[@]+"${AUTH[@]}"}
```

Each `INTERACTION <route> <kind> <detail>` line is a **P1 finding**, fixed in
step-4.5 like any other:

- `no-feedback` — nothing a visitor can see changed within 150 ms of the click:
  no text, no element appearing, vanishing or moving, no dialog, no navigation,
  no theme or ARIA state. A button that only greys out or fades does not count;
  the control must say what it is doing ("Saving…"), or the item must leave its
  list, before the server answers.
- `blank-while-loading` — one second after the HTML arrived, with its data
  still on the way, the main region showed no text, image or progress
  indicator, or a large iframe had not loaded with nothing around it.
- `unpressed` — a button no click could reach (an overlay over it, say).
- `unloadable` — the route did not load; the run exits 1.

**Held means never sent**: every non-GET request, every fetch/XHR, every
WebSocket and every service worker. GET navigations are not held, so a GET
endpoint with a side effect is the one thing this can still trigger. Dialogs are
dismissed. It cannot see the RESULT a save shows once the server answers — that
half is still the reviewer's, from the running app.

A control whose correct response is off screen (a copy-to-clipboard button) can
carry `data-qa-feedback="<reason>"`; it is skipped and listed as `SKIPPED` with
the reason, which the reviewer accepts or rejects. It is never the way out of a
real `no-feedback`.

A clean run (exit 0) stamps the tree, and `mark-qa-done.sh --tree` refuses a
served app without that stamp (exit 3), so step-6 cannot mark a tree whose
buttons were never pressed. Why this exists: a form that sits blank for seconds
while its data loads, and a button that gives no sign it was pressed, both pass
a screenshot review — the shots show only the settled page.

Exit 7 is `qa: skipped — Playwright unavailable (<reason>)`: no stamp is written,
so `mark-qa-done.sh --tree` refuses, and the report says the check was skipped.

## step-3.5-a11y

Only with `--a11y`:

```bash
bash "$S/a11y.sh" --url "$QA_URL" --pages "$PAGES" --viewports "${VIEWPORTS:-1440}" ${AUTH[@]+"${AUTH[@]}"}
```

Per-page axe violation counts. Advisory (~57% WCAG coverage) — report it, never block on it.

## step-4-stamp-sight

**A brief that asks for measurements is exactly what a blind agent can satisfy.** When image `Read` breaks mid-session (a harness hook timing out is enough), the step-4 subagent keeps returning confident, correctly-formatted findings computed with its own pixel-arithmetic scripts in Bash, and the orchestrator reads them as a visual review that never happened. The numbers are not wrong — they answer a narrower question. Three cards come back "aligned" (equal heights, bodies at the same y, equal bottom gaps: all true) while visibly ragged, because the closing lines wrapped to different LINE COUNTS and nothing measured that. A sighted reviewer catches it on its first pass.

So the brief is not the gate. Burn a random code into the pixels of every shot and make the reviewer hand it back:

```bash
eval "$(bash "$S/sight-check.sh" stamp --dir "/tmp/qa-shots/$QA_SLUG/$RUN_ID")"
# -> QA_SIGHT_CODES=<path>  QA_SIGHT_COUNT=<n>
```

A 6-character code per shot, appended in a strip BELOW the image so every y-coordinate in the page is unchanged and the reviewer's geometry stays valid. The code exists in the pixels and nowhere else — not in the DOM, not in the served HTML, not in the PNG's bytes as text, and **not in the run dir**: `QA_SIGHT_CODES` deliberately points outside it, because a codes file sitting next to the PNGs is a text answer to a picture question. Never paste the codes into the brief.

The stamp is drawn by ImageMagick when `magick` is installed and by Playwright (`sight-stamp.mjs`) when it is not — the same strip either way. This step HALTS on exit 3 (neither ImageMagick nor Playwright available) or 4 (no PNGs, or the stamp rendered blank because no font resolved). A review that cannot be proven sighted must not be dispatched at all — an unstampable run is a broken harness, not a run to push through.

Both halves run outside the model (Bash, and a headless browser when there is no ImageMagick), so this gate still fires when the ORCHESTRATOR's own image `Read` is dead — which is the condition it exists for.

## step-4-fresh-review

Dispatch a fresh-context subagent. Its brief MUST demand geometry and measured numbers, not presence. Paste [references/review-rubric.md](references/review-rubric.md) into the brief verbatim — a reviewer catches only what it has thresholds for, and "looks fine" is the failure mode the rubric exists to prevent.

```
You are a visual-QA reviewer. Read each PNG under <run-dir> with the Read tool.

SIGHT CODE — do this first, per shot. Each PNG carries a dark strip along its
bottom edge reading "QA SIGHT CODE  XXXXXX". Transcribe that 6-character code
for EVERY shot, as `<filename> = <code>`, before any finding. It is harness
chrome: never a finding, never a contrast or collision defect, and it is not
part of the page under review. If you cannot open an image — Read failing, a
hook timing out, anything — SAY SO AND STOP. Do not substitute pixel arithmetic
run from Bash: it produces exactly the report shape asked for below and it is
not a visual review. Reporting one as the other is the failure this instruction
exists to stop.

For each shot: (1) describe what renders; (2) check element COLLISIONS / overlap
with explicit pixel measurements (e.g. "card at y=420 overlaps footer at y=410,
~10px"); (3) work the rubric below and report a MEASURED value against every
threshold you can check from the image — not "contrast looks fine" but "body
#6b7280 on #ffffff = 4.83:1, passes". A threshold you cannot measure from a PNG,
say so and skip it; do not guess.

Rubric (thresholds, severity ladder, edge-state axes, known false positives):
<paste references/review-rubric.md>

MOTION. `<run-dir>/motion/manifest.json` lists what each route DECLARED
(name, target, duration, delay) and `<run-dir>/motion/<route>-<width>-t*.png` is
a frame burst at 0/120/260/520ms with animations running. Work the rubric's
Motion section against both. A route with no declared animations, or with
declared animations whose frames are identical, is a P1 — this product should
move, and move in several places, not just fade the page in once.

Design intent: <paste the SPEC/design or describe the page's purpose>.

The deterministic layer (contrast, tells, token drift) was already scanned AND
fixed before these shots were taken (steps 2.6-2.7), so this page is the cleaned
version. Your job is the judgment a rule can't make — collisions, hierarchy,
balance, whether it actually reads right, and whether the motion is worth having.
Do not re-litigate impeccable's domain.

Return every finding with a P0-P3 severity per the rubric's ladder, the measured
value that justifies it, and a drift classification where it applies.
Zero findings is a permitted answer; do not pad.
```

**Then verify the reply before you read a word of it.** Write the reviewer's answer to a file and run the gate:

```bash
bash "$S/sight-check.sh" verify --codes "$QA_SIGHT_CODES" --response /tmp/qa-review-$RUN_ID.txt
```

Exit 0 prints `SIGHTED — n/n codes transcribed`. Exit 6 means the codes did not come back and the findings, however well-formed, were computed rather than seen. Exit 5 means no codes exist at all, so nothing about the reply is proven — absence is never a pass. **Either one HALTS the review. MUST NOT report a visual pass on an unverified reply**, and MUST NOT read past a "degraded"/"could not open the image" line in the reviewer's own text: that is exactly the line that gets read past.

**When it fails, route around it — the fallback is the review chain on another vendor, not a retry.** `adversarial-review` puts the review on a different vendor from the author — the independence the review gate wants anyway. The brief names the PNG paths the reviewer must open.

```bash
bash .agents/skills/review/policy-review.sh adversarial-review \
  "/tmp/qa-shots/$QA_SLUG/$RUN_ID/manifest.json" /tmp/qa-brief-$RUN_ID.txt \
  > /tmp/qa-review-$RUN_ID.txt
bash "$S/sight-check.sh" verify --codes "$QA_SIGHT_CODES" --response /tmp/qa-review-$RUN_ID.txt
```

The brief file carries the same text as the subagent brief above — rubric, sight-code instruction, design intent, and the absolute path of every PNG to open — and still never the codes. Max **8 images per call**; a bigger run is batched, and each batch's reply is verified against the same codes file. A vendor that cannot open an image cannot return the codes, so the same gate refuses its answer: when no reviewer in the chain can see, the review HALTS and the report says the visual review did not happen.

Apply taste to the findings (the subagent verifies structure, not whether a fix would look ridiculous). P2/P3 are reported, not blocking.

**A clean run is a floor, not a verdict.** A generic font at a flat type scale passes every numeric threshold in the rubric. Say what the rubric could not check (focus order, screen-reader output, perceived performance) rather than letting a green report imply it was covered. Motion is no longer on that list — it is captured and graded (step-3.6); if you find yourself writing "motion cannot be checked from a still", the motion evidence went unread.

## step-4.5-fix-reverify

Act on every P0 and P1 from step-4 and every `INTERACTION` line from step-3.7. Then re-serve, **re-run `interaction-check.sh` until it exits 0**, and re-shoot the affected pages, **re-run `step-4-stamp-sight` on the new shots**, and dispatch a **fresh** visual-QA subagent — not the one that reviewed the first pass (same-subagent-as-built is not acceptable) — to confirm the fixes landed and introduced no regression. Re-stamping is not optional: fresh PNGs carry no codes, and reusing the first pass's codes would let a reviewer pass this round by quoting what it read last round. Its reply goes through `sight-check.sh verify` on exactly the same terms, with the same halt and the same review-chain fallback. Skip this step entirely if step-4 returned zero P0/P1 and step-3.7 exited 0.

## step-4.7-explain

State plainly what was fixed, both the impeccable pass and the visual pass, in plain words: what was wrong, what changed — words that survive deleting every file path. This is what the user reads. No mechanism trail unless asked.

Example: "Two things: the hero headline used a dated bounce animation, now a clean ease-out. A card on the pricing page overlapped its footer by ~12px at phone width; the card now clears it. Nothing else surfaced."

## step-5-cli

For `cli`/library targets — the repo declares its command as a `qa:cmd` script in `package.json`. Preserve the command's exit status through the `tee` pipe (`PIPESTATUS[0]`) — the exit code IS half the evidence, and a failing CLI must not read as a clean capture:

```bash
(cd "$TARGET" && npm run --silent qa:cmd) | tee "/tmp/qa-shots/<slug>/$RUN_ID/cli-stdout.txt"
cli_rc=${PIPESTATUS[0]}   # NOT $? — that is tee's status, always 0
echo "qa: cli exit=$cli_rc"
```

No screenshot, no visual review. The captured stdout + `cli_rc` IS the evidence — report a non-zero `cli_rc` as a failed run. Say "no UI surface — captured command output instead."

## step-5b-render

For `render` targets — anything with a visual output that isn't a served web page (TRMNL Liquid, HTML-to-image). The repo declares its `qa:render` script in `package.json`; it produces the PNG(s) itself, reading `$QA_OUT`:

```bash
export QA_OUT="/tmp/qa-shots/<slug>/$RUN_ID"; mkdir -p "$QA_OUT"
(cd "$TARGET" && npm run --silent qa:render)
```

The PNG(s) under `$QA_OUT` ARE the screenshots — no serve, no `screenshot.sh`. Then continue to `step-4-fresh-review` over them exactly as for a served page. This is how `/qa` guarantees it can always render the thing it's working on: if a target can't be served, it declares how to render itself.

## Cloudflare portal recipe

A Cloudflare-hosted site behind Cloudflare Access is not a dead end. Three doors, pick by the question:

| Question | Door |
|---|---|
| Is the DATA / logic right? | Read the production store directly — e.g. `npx wrangler d1 execute <db> --remote --command "<sql>"`, or `npx wrangler kv key get <key> --namespace-id <id> --remote`. No server, no browser. Beats a screenshot for data-correctness. |
| Does the live page RENDER right? | `/qa <site> --live` with an Access service token: name its 1Password item in `QA_ACCESS_OP_ITEM` (or set `QA_CF_ACCESS_ID` / `QA_CF_ACCESS_SECRET`). The Access app needs a Service Auth policy for that token; then the gated URL returns 200 (headers resolved inside `screenshot.sh`, never on stdout). |
| Pre-commit layout of uncommitted edits? | `--before`; astro-cf auto-falls-back to `astro dev` if workerd won't boot. No CF bindings on the fallback, so pair it with the data read above. |

**Walking a page as a person.** Some apps treat a service token alone as a MACHINE and answer every page with "service tokens cannot access this page". If the app's wrangler config declares `PROBE_ACTS_AS = "<client id> <email>"`, the app treats the token plus an `X-Portal-Act-As: <that email>` header as that person. `serve.sh --live` reads the declaration (`qa_probe_acts_as` in `lib.sh`), finds a Worker's URL through the Workers custom-domain registry, and emits `QA_AUTH_ACT_AS`; pass it as `--auth-act-as` to `screenshot.sh`, `interaction-check.sh` and `a11y.sh`. An app that declares nothing gets no header.

Never conclude a portal fix is "unverifiable locally" — that conflates *your tool's* browser access with the open database and service-token doors. And never hand a live check to the user as "needs your sign-in" before sending the act-as header: with a service token and `--auth-act-as` the page is reachable without them.

## step-6-teardown

```bash
bash "$S/serve.sh" down --runfile "$QA_RUNFILE"   # unless --keep
[ -z "${KEEP:-}" ] && rm -rf "/tmp/qa-shots/$QA_SLUG/$RUN_ID"   # $QA_SLUG (from serve.sh) matches the real shots dir; nobody reviews the shots after the run
```

The screenshots exist only to be reviewed during the run (steps 4-4.5); once the review is done they're deleted. `--keep` leaves both the server AND the shots up, and prints `QA_URL`, the shots dir, and the teardown one-liner: `bash .agents/skills/qa/scripts/serve.sh down --runfile <QA_RUNFILE>`. The step-4.7 plain-English summary is the result the user sees, not the PNGs.

After the review completes and fix-now findings are handled, clear the autonomous gate for this change-set:

```bash
bash .agents/skills/qa/scripts/mark-qa-done.sh "$TARGET"

# Under /implement phase-4.8, pass the tree the gate will check against — the
# snapshot taken AFTER this /qa finished, so the marker names the bytes that ship:
bash .agents/skills/qa/scripts/mark-qa-done.sh --tree "$POST_QA" "$TARGET"
```

With `--tree` it writes `/tmp/qa-done/<slug>-<tree-sha>`, which is what `validate.sh --require-qa` reads. Both forms also write the legacy `/tmp/qa-done/<repo>-<change-hash>` key, which nothing reads any more. The next paragraph is why the gate needed a second key rather than a reuse of that one.

**Write the marker only here, and only after the review passed.** `mark-qa-done.sh --tree` itself refuses a served app whose interaction check has not passed on that exact tree. It is the single piece of evidence `/implement` accepts that a UI was actually looked at. A marker touched early — or by hand to get past a gate — is the gate lying, and the next thing that happens is a UI shipping on a green run that nobody saw.

**What the legacy key does NOT durably clear.** It is `git status --porcelain | cksum` — a digest of the repo's UNCOMMITTED change-set (`qa_change_hash` in `scripts/lib.sh`). Run after the work is committed, the digest is of empty input: the marker is keyed `-4294967295`, which is exactly `printf '' | cksum`. Such a marker can never match a future dirty state, so it proves nothing about the tree that shipped.

That measurement is exactly why the `/implement` gate could not reuse this key and got a second one. A tree SHA names the bytes QA looked at, survives the commit, and — the part the gate needs — MOVES when a later `/qa` edits source, so an earlier target's marker stops matching and that target runs again. `--require-qa` asks "has this exact tree been seen, target by target?" — a question the change-set key could never answer.

## Examples

### Example 1 — before-commit QA of a portal's projects page

`/qa apps/web/portal /projects --before`. step-0 resolves the portal's directory, run-id stamped. step-1 detects `astro-cf` (no config read); the explicit `/projects` arg overrides route discovery. step-2 builds the working tree and serves on :8813 (no seed — a portal that reads a remote store renders empty states in `--before`; use `--live` or a direct data read). step-3 shoots projects at 1440/820/390 -> manifest printed. step-4 dispatches the fresh-context reviewer. step-6 tears down the owned server.

### Example 2 — after-commit, multi-page, keep server up

`/qa apps/web/billing / /clients --after --keep`. step-2 builds a clean HEAD worktree (uncommitted edits excluded), serves it. step-3 shoots both routes. `--keep` leaves the server live; the URL + teardown one-liner are printed for interactive driving.

### Example 3 — CLI target

`/qa some-cli-repo`. detect-app returns `cli` (a `qa:cmd` script in its `package.json`). step-5 runs `npm run qa:cmd`, captures stdout to the run dir, reports "no UI surface."

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `detect-app: unknown app type` | Node-server / CLI / render target with no `qa:*` script | add a `qa:serve` / `qa:cmd` / `qa:render` script to the repo's `package.json` |
| `discover-routes: no-src-pages` / `no-static-routes` | the repo has no routing dir at all (`src/pages/`, `pages/`, `app/`, `src/app/`), or only dynamic/private/error routes | pass explicit `page ...` args for the routes to shoot; `/qa` never fabricates one |
| `build failed` | the repo's `npm run build` is red | fix the build in the target repo first |
| `server never came up` | slow boot / crash | check the printed `server.log` tail. A busy default port is no longer a cause — with no `--port`, `serve.sh` scans upward from 8813 for a free one |
| `the listener is NOT this run's process group` | a server from another repo or session already holds the port and answers 200 | stop that process or pass `--port <free-port>`. `/qa` refuses it deliberately: accepting it means an entire review pass grades a different application |
| `qa: BLANK CAPTURES` (exit 8) | the shot is (near-)uniform — almost always sections that fade in on scroll, since a `fullPage` shot does not scroll | the capture now scroll-walks the page and forces `[data-animate]`/`[data-aos]`/`.reveal`/`.fade-in`/`.animate-on-scroll` visible before shooting; if a site hides content under some OTHER selector, add it to that rule in `scripts/screenshot.sh`. A genuinely near-empty page (bare 404, one-line confirmation) is the false positive — re-run with `QA_INK_FLOOR=0`. Never review a shot the gate rejected: a reviewer handed a white image critiques the whitespace and returns confident findings about nothing. |
| blank screenshots that survive the gate | SPA needs a wait/selector | the Node capture uses `networkidle`; add a mask or raise the timeout |
| `qa: IDENTICAL SHOTS` (exit 6) | every route rendered the same image — auth wall, dead client routing, or a catch-all | `curl -sI <url>/<route> \| head -3` to see the redirect. On `--live`, attach an Access service token (§ Cloudflare portal recipe) — otherwise `--before` bypasses the gate. Never review the shots as-is. |
| `qa: UNSUCCESSFUL RESPONSES` (exit 9) | a route answered 4xx/5xx or not at all — a gated app's machine 403 carries a full page of ink, so the blank and identical-shot gates cannot see it | a 403 on a gated app: pass `--auth-act-as` (the "service tokens cannot access this page" row below); anything else: fix the route. Never review the shots |
| `qa: REDIRECTED OFF-ORIGIN` (exit 7) | navigation landed on a different origin (CF Access / Google sign-in) — catches the single-page case exit 6 structurally cannot | Attach an Access service token (§ Cloudflare portal recipe), or use `--before`. |
| `qa: skipped — Playwright unavailable (<reason>)` (exit 7) | no Playwright could be found or installed — offline, no npm, or `QA_NO_INSTALL=1` | report the skip, never a pass. Fix the reason (network, npm) and re-run; `bash .agents/skills/qa/scripts/ensure-playwright.sh` installs it on its own |
| `impeccable: detector unavailable — …` | impeccable is missing and could not be installed, or it crashed | report it as not checked; `npm install -g impeccable@latest` by hand, then re-run step-2.6 |
| `--live` refused | no `--live-url`, no CF Pages project matched the repo name, and no Workers custom domain serves the Worker its wrangler config names (or no Cloudflare credentials) | pass `--live-url <url>`, or use `--before` to build + serve the working tree (the URL is never inferred) |
| a gated app's page shows "service tokens cannot access this page" (or an API says a person is required) | the token reached the app as a MACHINE: no `X-Portal-Act-As` was sent | the target's wrangler config has no `PROBE_ACTS_AS`, or the run bypassed `serve.sh --live`. Pass `--auth-act-as <the email PROBE_ACTS_AS names>` to `screenshot.sh` / `interaction-check.sh`; a sign-in is never the fix |
| auth-gated `--live` shows a login redirect | no Access service token was sent, or the Access app has no Service Auth policy for it | § Cloudflare portal recipe. If you need the DATA not the pixels, read the store directly instead. |
| `wrangler pages dev` won't boot (workerd error) | sandbox can't start the Workers runtime | serve.sh auto-falls-back to `astro dev` (label says "no CF bindings"); verify data with a direct read, not the fallback server |
| `render` command wrote no PNGs | the `qa:render` script didn't write to `$QA_OUT` | it MUST write its PNG(s) to `$QA_OUT` (exported by step-5b); fix the script's output path |
