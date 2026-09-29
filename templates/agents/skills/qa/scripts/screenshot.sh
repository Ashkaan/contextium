#!/usr/bin/env bash
# screenshot.sh — capture each page at each viewport with determinism on, and
# emit an evidence manifest (page × viewport → path · bytes · http-status).
# Uses the Playwright Node API (NOT the bare CLI) so we can settle animations,
# capture MOTION, and mask dynamic regions — things the bare
# `npx playwright screenshot` CLI cannot express. CLI/Node Playwright only —
# never a Playwright MCP server.
#
# peers:
#   .agents/skills/qa/scripts/serve.sh
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/qa/scripts/ensure-playwright.sh
#   .agents/skills/qa/scripts/tests/lib.test.sh
#
# Usage:
#   screenshot.sh --url <base> --repo-slug <slug> --run-id <id>
#                 --pages "<route ...>" --viewports "W,W,W" [--masks "sel,sel"]
#                 [--app <target-dir>]   the app's own Playwright is tried first
#                 [--auth-op-item <id> --auth-id-field F --auth-secret-field F]
#                 [--auth-act-as <email>]   # X-Portal-Act-As, beside the token
# Output: PNGs + manifest.json under /tmp/qa-shots/<slug>/<run-id>/, and a
#         manifest table on stdout (route · width · path · bytes · status).
#         Plus motion/ — an animation manifest and a frame burst per route.
# Exit:   0 ok; 2 usage; 6 identical shots across routes; 7 Playwright
#         unavailable (stderr carries `qa: skipped — Playwright unavailable
#         (<reason>)` — a skip, never a pass), and separately an off-origin
#         redirect; 8 a capture came back blank (see the BLANK GATE at the
#         bottom); 9 a route answered 4xx/5xx or not at all (the STATUS GATE).
#
# ── Why this captures the MOTION site, not the reduced-motion one ─────────────
# `reducedMotion: "reduce"` looks like a determinism setting and is not one: it
# makes the browser report `prefers-reduced-motion: reduce`, so any app with an
# honest reduce-motion block serves its ACCESSIBILITY FALLBACK to the camera —
# a rendering most users never see, and no reviewer could tell, because a still
# of a suppressed animation looks exactly like a still of an absent one. Motion
# is design. Default is normal motion; `--reduced-motion` shoots the fallback ON
# PURPOSE, as its own axis, which is what that emulation is actually for.
#
# `animations: "disabled"` on the screenshot call STAYS, and is a different
# thing despite the name. Playwright fast-forwards finite animations to
# completion for the shot, so the still lands on the settled end state rather
# than a half-faded frame. Turning it off would not reveal motion; it would just
# make every still catch a random point mid-entrance and poison the geometry
# review with findings about washed-out text. Stills settle; motion is captured
# separately, below.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

SHOTS_ROOT="${QA_SHOTS_ROOT:-/tmp/qa-shots}"
URL="" SLUG="" RUN_ID="" PAGES="" VIEWPORTS="1440,820,390" MASKS="" APP=""
AUTH_OP_ITEM="" AUTH_ID_FIELD="client_id" AUTH_SECRET_FIELD="client_secret" AUTH_ACT_AS=""
# Motion capture is ON by default and has to stay that way to be worth anything:
# an opt-in motion check is a motion check nobody runs.
REDUCED_MOTION="no-preference" CAPTURE_MOTION="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --repo-slug) SLUG="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --pages) PAGES="${2:-}"; shift 2 ;;
    --viewports) VIEWPORTS="${2:-}"; shift 2 ;;
    --masks) MASKS="${2:-}"; shift 2 ;;
    --app) APP="${2:-}"; shift 2 ;;
    --reduced-motion) REDUCED_MOTION="reduce"; shift ;;
    --no-motion) CAPTURE_MOTION=""; shift ;;
    --auth-op-item) AUTH_OP_ITEM="${2:-}"; shift 2 ;;
    --auth-id-field) AUTH_ID_FIELD="${2:-client_id}"; shift 2 ;;
    --auth-secret-field) AUTH_SECRET_FIELD="${2:-client_secret}"; shift 2 ;;
    --auth-act-as) AUTH_ACT_AS="${2:-}"; shift 2 ;;
    *) qa_err "screenshot: unknown flag: $1"; exit 2 ;;
  esac
done

# CF-Access service-token headers for a gated --live portal. The 1Password item
# REF arrives on argv; the token VALUES are resolved here and handed to the node
# capture via env (never argv/stdout) so they don't leak into process listings.
export QA_REDUCED_MOTION="$REDUCED_MOTION" QA_CAPTURE_MOTION="$CAPTURE_MOTION"
if [[ -n "$AUTH_OP_ITEM" ]] && ! qa_resolve_cf_access "$AUTH_OP_ITEM" "$AUTH_ID_FIELD" "$AUTH_SECRET_FIELD"; then
  qa_err "screenshot: --auth-op-item set but service token unresolved from 1Password item $AUTH_OP_ITEM"
  exit 2
fi
export QA_CF_ACCESS_ID="${QA_CF_ACCESS_ID:-}" QA_CF_ACCESS_SECRET="${QA_CF_ACCESS_SECRET:-}"
# The person the probe acts as on a portal that declares PROBE_ACTS_AS
# (lib.sh `qa_probe_acts_as`); without it every page there is a machine's 403.
export QA_ACT_AS="$AUTH_ACT_AS"

[[ -n "$URL" && -n "$SLUG" && -n "$RUN_ID" ]] \
  || { qa_err "usage: screenshot.sh --url U --repo-slug S --run-id R --pages '...'"; exit 2; }
PAGES="$(qa_resolve_pages "$PAGES" "")"

OUT_DIR="$SHOTS_ROOT/$SLUG/$RUN_ID"
mkdir -p "$OUT_DIR"

# ── resolve a node_modules dir whose playwright has a CACHED chromium ─
# Many playwright copies exist (npx cache, vendored repos) at different
# versions, each pinned to a different chromium revision; only the revisions
# under ~/.cache/ms-playwright are actually installed. Pick the first candidate
# whose pinned revision has a real browser binary on disk (no guessing —
# don't assume a version maps to an installed browser). None → install one on
# first use (ensure-playwright.sh); impossible → a skip, said plainly.
NODE_PATH_DIR="$(qa_playwright_node_modules "$APP" || true)"
if [[ -z "$NODE_PATH_DIR" ]]; then
  qa_err "qa: skipped — Playwright unavailable (see the line above); no screenshots were taken"
  exit 7
fi

# The Node program: deterministic multi-viewport capture → manifest.json + table.
# ESM `import` ignores NODE_PATH, so run node from the dir whose node_modules
# holds the playwright package — its bare specifier then resolves up-tree.
PW_PARENT="$(dirname "$NODE_PATH_DIR")"
# shellcheck disable=SC2016  # node program is intentionally unexpanded by bash
( cd "$PW_PARENT" && node --input-type=module -e '
import { chromium } from "playwright";
import { writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const [base, pagesCsv, viewportsCsv, masksCsv, outDir] = process.argv.slice(1);
const pages = pagesCsv.split(/\s+/).filter(Boolean);
const widths = viewportsCsv.split(",").map((w) => parseInt(w.trim(), 10)).filter(Boolean);
const masks = (masksCsv || "").split(",").map((s) => s.trim()).filter(Boolean);

const slugRoute = (r) => {
  let s = r.replace(/^\//, "").replace(/[^A-Za-z0-9-]/g, "_").replace(/_+/g, "_");
  s = s.replace(/^_+|_+$/g, "").slice(0, 60);
  return s || "index";
};

// CF-Access service-token headers (resolved by the shell above into env, so the
// token values never appear on argv) — sent on every request so a gated portal
// returns 200 instead of a login redirect.
const cfId = process.env.QA_CF_ACCESS_ID || "";
const cfSecret = process.env.QA_CF_ACCESS_SECRET || "";
// X-Portal-Act-As makes the probe the person the portal pairs it with
// (PROBE_ACTS_AS); it means nothing without the token, so it only rides with it.
const actAs = process.env.QA_ACT_AS || "";
const extraHTTPHeaders = cfId && cfSecret
  ? { "CF-Access-Client-Id": cfId, "CF-Access-Client-Secret": cfSecret, ...(actAs ? { "X-Portal-Act-As": actAs } : {}) }
  : undefined;

const browser = await chromium.launch();

// INK: the fraction of sampled pixels that are NOT the images most common
// colour. A page that captured as blank white scores ~0; a real page scores
// well above the floor. Decoding happens in a throwaway blank context so a
// sites own Content-Security-Policy cannot block the data URL.
// NOTE: single-quoted bash string (see the node --input-type=module -e above)
// — no apostrophes anywhere in this block.
async function inkFraction(file) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    const b64 = readFileSync(file).toString("base64");
    return await p.evaluate(async (data) => {
      const img = new Image();
      img.src = "data:image/png;base64," + data;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      // Every 4th pixel, colour quantised to 5 bits per channel: anti-aliasing
      // and gradients must not each read as their own distinct colour, or a
      // blank page with a faint wash would score as busy.
      const counts = new Map();
      let total = 0;
      for (let i = 0; i < px.length; i += 16) {
        const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
        counts.set(k, (counts.get(k) || 0) + 1);
        total++;
      }
      let modal = 0;
      for (const v of counts.values()) if (v > modal) modal = v;
      return total ? 1 - modal / total : 0;
    }, b64);
  } catch (e) {
    return null;
  } finally {
    await ctx.close();
  }
}

const manifest = [];
const motion = [];
for (const route of pages) {
  for (const width of widths) {
    const ctx = await browser.newContext({
      viewport: { width, height: 1600 },
      deviceScaleFactor: 1,
      reducedMotion: process.env.QA_REDUCED_MOTION === "reduce" ? "reduce" : "no-preference",
      extraHTTPHeaders,
    });
    const page = await ctx.newPage();
    const url = base.replace(/\/$/, "") + (route.startsWith("/") ? route : "/" + route);
    let status = 0;
    let landedOrigin = "";
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      status = resp ? resp.status() : 0;
      // T5: an auth wall answers 200 from a DIFFERENT origin. Route-count
      // guards miss it on single-page sites; the landed origin never does.
      try { landedOrigin = new URL(page.url()).origin; } catch {}
    } catch (e) {
      status = -1;
    }
    // MOTION, captured before the settled still — the entrance is already
    // running by the time `networkidle` resolves, so anything sampled later has
    // missed it. Two records, because they fail differently: the manifest says
    // what the app DECLARED (an animation that was never wired shows up as an
    // empty list), and the burst says what actually MOVED (an animation that is
    // declared but instantly complete shows up as identical frames).
    if (process.env.QA_CAPTURE_MOTION) {
      const mdir = `${outDir}/motion`;
      mkdirSync(mdir, { recursive: true });
      try {
        const anims = await page.evaluate(() =>
          document.getAnimations().map((a) => {
            const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
            const el = a.effect && a.effect.target;
            // On an SVG element `className` is an SVGAnimatedString, not a
            // string, so String() on it yields "[object SVGAnimatedString]" and
            // the ensō mark reported its target as "[object". getAttribute is
            // the one accessor that answers the same for HTML and SVG.
            // NOTE: this whole JS block lives in a single-quoted bash string
            // (see the `node --input-type=module -e` above), so no apostrophes.
            const cls = el ? el.getAttribute("class") || el.tagName.toLowerCase() : "?";
            return {
              name: a.animationName || (a.constructor && a.constructor.name) || "?",
              target: String(cls).split(" ")[0],
              durationMs: typeof t.duration === "number" ? t.duration : null,
              delayMs: typeof t.delay === "number" ? t.delay : null,
              playState: a.playState,
            };
          }),
        );
        // REWIND before bursting. `page.goto` resolves on networkidle, which is
        // long after a 520ms entrance has finished — the first attempt at this
        // sampled four identical settled frames and reported "no motion" for a
        // page that animates fine. Seeking every animation back to 0 and
        // replaying makes the burst independent of how slow the load was, which
        // is also what makes it comparable between runs.
        await page.evaluate(() => {
          for (const a of document.getAnimations()) {
            try { a.currentTime = 0; a.play(); } catch {}
          }
        });
        // A frame burst across the entrance band. Named by elapsed ms so the
        // reviewer can say "at 120ms the run was half drawn" rather than "it
        // looks animated". Full-viewport shots with animations ALLOWED — this is
        // the one capture that must not be fast-forwarded.
        const burst = [];
        for (const at of [0, 120, 260, 520]) {
          const f = `${mdir}/${slugRoute(route)}-${width}-t${String(at).padStart(4, "0")}.png`;
          await page.screenshot({ path: f, animations: "allow", caret: "hide" });
          burst.push(f);
          await page.waitForTimeout(at === 0 ? 120 : 140);
        }
        const distinct = new Set(
          burst.map((f) => { try { return createHash("sha256").update(readFileSync(f)).digest("hex"); } catch { return f; } }),
        ).size;
        motion.push({ route, width, animations: anims, frames: burst, distinctFrames: distinct });
      } catch (e) {
        motion.push({ route, width, error: String(e && e.message ? e.message : e) });
      }
    }

    // REVEAL before the settled still. A fullPage shot does NOT scroll, so a
    // site that fades sections in on scroll (an IntersectionObserver plus a
    // rule like [data-animate] { opacity: 0 }) captures as blank — the DOM is
    // complete, the pixels are white, and the capture exits 0, and a reviewer
    // then grades thousands of pixels of white. Two passes, because either alone leaves a gap: scrolling fires the
    // observers a well-behaved site listens to, and forcing the end state
    // covers the ones whose trigger never fires under an automated scroll.
    try {
      await page.evaluate(async () => {
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
        const s = document.createElement("style");
        s.textContent =
          "[data-animate],[data-aos],.reveal,.fade-in,.animate-on-scroll" +
          "{opacity:1 !important;transform:none !important;visibility:visible !important}";
        document.head.appendChild(s);
        await new Promise((r) => setTimeout(r, 120));
      });
    } catch (e) {}

    const file = `${outDir}/${slugRoute(route)}-${width}.png`;
    await page.screenshot({
      path: file,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      mask: masks.map((sel) => page.locator(sel)),
    });
    let bytes = 0;
    try { bytes = statSync(file).size; } catch {}
    const ink = await inkFraction(file);
    // T5: hash the pixels, not just the size — identical shots across distinct
    // routes mean an auth wall or dead client routing, and the manifest would
    // otherwise report a clean 200 for every row.
    let sha = "";
    try { sha = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16); } catch {}
    manifest.push({ route, width, path: file, bytes, status, sha, ink, landedOrigin });
    await ctx.close();
  }
}
await browser.close();

const baseOrigin = (() => { try { return new URL(base).origin; } catch { return ""; } })();
const offOrigin = manifest.filter(
  (m) => m.landedOrigin && baseOrigin && m.landedOrigin !== baseOrigin,
);

writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
if (motion.length) {
  writeFileSync(`${outDir}/motion/manifest.json`, JSON.stringify(motion, null, 2));
  // A route whose frames are all identical either has no motion or has motion
  // that never runs. Both are reportable; neither is visible in a settled still.
  const still = motion.filter((m) => !m.error && m.distinctFrames <= 1);
  const declared = motion.filter((m) => !m.error && (m.animations || []).length > 0).length;
  process.stdout.write(
    `\nmotion: ${declared}/${motion.length} route×viewport captures declared animations; ` +
      `${motion.length - still.length} showed frame-to-frame change\n`,
  );
  for (const m of still) {
    process.stdout.write(`  NO MOTION  ${m.route} @${m.width} — ${(m.animations || []).length} declared, frames identical\n`);
  }
}
const kb = (n) => (n / 1024).toFixed(0) + "KB";
for (const m of manifest) {
  process.stdout.write(
    `${m.route.padEnd(16)} ${String(m.width).padStart(5)}  ${m.path}  ${kb(m.bytes).padStart(7)}  ${m.status}\n`,
  );
}

// Collide-check per width: >1 distinct route sharing one image is not evidence.
const collisions = [];
for (const width of widths) {
  const byHash = new Map();
  for (const m of manifest.filter((x) => x.width === width && x.sha)) {
    if (!byHash.has(m.sha)) byHash.set(m.sha, []);
    byHash.get(m.sha).push(m.route);
  }
  for (const [, routes] of byHash) {
    if (routes.length > 1) collisions.push({ width, routes });
  }
}
if (offOrigin.length > 0) {
  process.stderr.write("\nqa: REDIRECTED OFF-ORIGIN — these are not your pages\n");
  const seen = new Set();
  for (const m of offOrigin) {
    const key = `${m.route} -> ${m.landedOrigin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    process.stderr.write(`  ${m.route} landed on ${m.landedOrigin}\n`);
  }
  process.stderr.write(
    `  Expected origin: ${baseOrigin}\n` +
    "  An auth wall answers 200 from its own origin, so status is not evidence.\n" +
    "  Gated site? Name a Cloudflare Access service token in QA_ACCESS_OP_ITEM (or\n" +
    "  set QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET) and /qa sends it on --live. A\n" +
    "  login page that still lands means the Access app has no service-token\n" +
    "  policy for it. Or use --before, which serves locally with no gate.\n",
  );
  process.exit(7);
}
if (collisions.length > 0) {
  process.stderr.write("\nqa: IDENTICAL SHOTS — evidence is not trustworthy\n");
  for (const c of collisions) {
    process.stderr.write(`  ${c.width}px: ${c.routes.join(", ")} rendered byte-identical\n`);
  }
  process.stderr.write(
    "  Likely: an auth wall (CF Access returns 200 on its login page), a\n" +
    "  client-routing failure, or a catch-all serving one page for every route.\n" +
    "  Check the redirect: curl -sI <url>/<route> | head -3\n" +
    "  Gated site? See the service-token note in SKILL.md, or use --before.\n",
  );
  process.exit(6);
}
// STATUS GATE. A route that answered 4xx/5xx, or never answered, is not the
// page: an answer like "Service tokens cannot access this page" is a 403 with a
// full-ink body, so it clears the blank gate and, alone, the identical-shots
// gate too. A route that IS an error page may answer its own code
// (/404 with 404, /500 with 500) and nothing else: a 403 there is still a wall.
const expectedError = (route) => { const m = /^\/?(404|500)(\.html)?\/?$/.exec(route); return m ? Number(m[1]) : null; };
const failedStatus = manifest.filter((m) => (m.status < 200 || m.status >= 400) && m.status !== expectedError(m.route));
if (failedStatus.length > 0) {
  process.stderr.write("\nqa: UNSUCCESSFUL RESPONSES — these shots are not the pages\n");
  for (const m of failedStatus) process.stderr.write(`  ${m.route} @${m.width}: HTTP ${m.status === -1 ? "no response" : m.status}\n`);
  process.stderr.write(
    "  A 403 on a gated portal usually means the probe reached it as a MACHINE: pass\n" +
    "  --auth-act-as <the email its wrangler PROBE_ACTS_AS names> (serve.sh --live\n" +
    "  emits it as QA_AUTH_ACT_AS). Asking a person to sign in is not the fix.\n",
  );
  process.exit(9);
}
// BLANK GATE. Placed last so a run that is also off-origin or colliding reports
// the more specific cause first. `ink === null` means the measurement itself
// failed and is NOT counted — an unmeasured shot must not read as a blank one.
// Floor is MEASURED, not chosen. Against local fixtures at 1440 and 390:
// a pure-white page scores 0.000%; a real one-sentence confirmation page on a
// 2400px body — the legitimate sparsest case — scores 0.045% and 0.164%; an
// ordinary text page scores 1.5% and 4.9%. 0.02% sits below every real page
// and above blank. Erring low is the safe direction: a floor set too low misses
// a marginal blank, where one set too high blocks a correct run.
const INK_FLOOR = Number(process.env.QA_INK_FLOOR || "0.0002");
const blanks = manifest.filter((m) => typeof m.ink === "number" && m.ink < INK_FLOOR);
const unmeasured = manifest.filter((m) => m.ink === null);
if (unmeasured.length > 0) {
  process.stderr.write(
    `\nqa: ${unmeasured.length} shot(s) could not be measured for blankness — judge those by eye\n`,
  );
}
if (blanks.length > 0) {
  process.stderr.write("\nqa: BLANK CAPTURES — these will not be handed to a reviewer\n");
  for (const b of blanks) {
    process.stderr.write(`  ${b.route} @${b.width}  ${(b.ink * 100).toFixed(1)}% non-background  ${b.path}\n`);
  }
  process.stderr.write(
    `  Floor is ${(INK_FLOOR * 100).toFixed(3)}% (QA_INK_FLOOR overrides).\n` +
    "  A reviewer handed a white image critiques the whitespace and reports\n" +
    "  confident findings about nothing — the failure this gate exists to stop.\n" +
    "  Likeliest cause: sections that reveal on scroll under a selector the\n" +
    "  reveal pass does not know. Add it to the forced-visible rule above, or\n" +
    "  raise the settle wait. A genuinely near-empty page (a bare 404, a\n" +
    "  one-line confirmation) is the false positive: re-run with QA_INK_FLOOR=0.\n",
  );
  process.exit(8);
}
' "$URL" "$PAGES" "$VIEWPORTS" "$MASKS" "$OUT_DIR" ) || exit $?  # explicit: bash 3.2 (macOS) does not stop on a failed ( … ) under set -e here

echo "qa: shots + manifest → $OUT_DIR"
