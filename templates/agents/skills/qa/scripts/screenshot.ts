#!/usr/bin/env -S node --experimental-strip-types
// screenshot.ts — capture each page at each viewport with determinism on, and
// emit an evidence manifest (page × viewport → path · bytes · http-status).
// Uses the Playwright Node API (NOT the bare CLI) so we can settle animations,
// capture MOTION, and mask dynamic regions — things the bare
// `npx playwright screenshot` CLI cannot express. CLI/Node Playwright only —
// never a Playwright MCP server.
//
// peers:
//   .agents/skills/qa/scripts/serve.ts
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/ensure-playwright.ts
//   .agents/skills/qa/scripts/tests/lib.test.ts
//
// Usage:
//   screenshot.ts --url <base> --repo-slug <slug> --run-id <id>
//                 --pages "<route ...>" --viewports "W,W,W" [--masks "sel,sel"]
//                 [--app <target-dir>]   the app's own Playwright is tried first
//                 [--auth-op-item <id> --auth-id-field F --auth-secret-field F]
//                 [--auth-act-as <email>]   # X-Portal-Act-As, beside the token
//                 [--auth-jwt-file <path>]  # local Access token (serve.ts QA_AUTH_JWT_FILE)
// Output: PNGs + manifest.json under /tmp/qa-shots/<slug>/<run-id>/, and a
//         manifest table on stdout (route · width · path · bytes · status).
//         Plus motion/ — an animation manifest and a frame burst per route.
//         A page taller than 3,000px is shot as <route>-<width>-part<n>.png,
//         one manifest row each, so a reviewer can read it (PART_MAX).
// Exit:   0 ok; 2 usage; 6 identical shots across routes; 7 Playwright
//         unavailable (stderr carries `qa: skipped — Playwright unavailable
//         (<reason>)` — a skip, never a pass), and separately an off-origin
//         redirect; 8 a capture came back blank (see the BLANK GATE at the
//         bottom); 9 a route answered 4xx/5xx or not at all (the STATUS GATE).
//
// ── Why this captures the MOTION site, not the reduced-motion one ─────────────
// `reducedMotion: "reduce"` looks like a determinism setting and is not one: it
// makes the browser report `prefers-reduced-motion: reduce`, so any app with an
// honest reduce-motion block serves its ACCESSIBILITY FALLBACK to the camera —
// a rendering most users never see, and no reviewer could tell, because a still
// of a suppressed animation looks exactly like a still of an absent one. Motion
// is design. Default is normal motion; `--reduced-motion` shoots the fallback ON
// PURPOSE, as its own axis, which is what that emulation is actually for.
//
// `animations: "disabled"` on the screenshot call STAYS, and is a different
// thing despite the name. Playwright fast-forwards finite animations to
// completion for the shot, so the still lands on the settled end state rather
// than a half-faded frame. Turning it off would not reveal motion; it would just
// make every still catch a random point mid-entrance and poison the geometry
// review with findings about washed-out text. Stills settle; motion is captured
// separately, below.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser, Page, Request, Response } from "playwright";
import {
  qaAccessHeaders,
  qaSignAccess,
  qaBrowsers,
  qaContextOptions,
  qaErr,
  qaReadJwtFile,
  qaPlaywrightNodeModules,
  qaEnvCfAccess,
  qaResolveCfAccess,
  qaResolvePages,
} from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { gotoSurvivingNetworkChange } from "./nav.ts";

/** Tallest single shot. The reviewer's image reader shrinks a picture to about
 *  2,000px on its long side, so a taller shot reaches it too small to read its
 *  text or its sight code. 3,000px reads
 *  at about 1.5x; it is also far under ImageMagick's 32,000px policy cap, the
 *  reason the split first existed. */
const PART_MAX = 3_000;
/** How long the shot waits for every image to load and decode (see REVEAL); QA_IMAGE_WAIT_MS overrides, for the test. */
const IMAGE_WAIT_MS = Number(process.env.QA_IMAGE_WAIT_MS) || 10_000;

// ── FONTS ─────────────────────────────────────────────────────────────────────
// Phone shots drawn in the machine's fallback font, with nothing in the run
// saying so, lead the reviewer to judge line breaks the page never has. Two
// things go wrong. A font
// first used by text the reveal brings in was still loading when the still's
// height was measured, so the page was cut into parts at the fallback's height;
// Playwright waits for fonts inside each screenshot call, which is after that
// measurement. And a font file or font stylesheet that failed left no trace.
//
// So each capture phase (the motion burst, the settled still) first waits for
// the fonts the page has started using, at most FONT_WAIT_MS, and every font
// that failed, timed out or could not be checked becomes a note on that
// phase's evidence: in the manifests (`fontNotes`) and as one `font:` line
// per route, width and phase in the run summary. The screenshot calls that
// follow skip Playwright's own font wait (DRIVER_FONT_WAIT_OFF), which has no
// deadline of its own: a stalled font request held each call for its full 30s
// timeout and then failed the run.

/** Longest wait for pending fonts, per capture phase; QA_FONT_WAIT_MS overrides, for the test. */
const FONT_WAIT_MS = Number(process.env.QA_FONT_WAIT_MS) || 5_000;
/** Read by playwright-core at each screenshot call (coreBundle.js `_preparePageForScreenshot`). */
const DRIVER_FONT_WAIT_OFF = "PW_TEST_SCREENSHOT_NO_FONTS_READY";

interface FontNote {
  phase: "motion" | "still";
  kind: "timeout" | "face-error" | "stylesheet-error" | "unverified";
  reason: string;
  /** The font family of a face that failed or timed out. */
  family?: string;
  /** The origin a failed stylesheet came from; never its path or query. */
  origin?: string;
}
interface FontState {
  timedOut: boolean;
  /** `began`: on the read after capture, a face that was idle at the phase's waited read and is in use now. */
  faces: { family: string; status: string; began?: boolean }[];
}
interface SheetFailure {
  origin: string;
  reason: string;
  /** The URL that failed, kept in memory only: a later direct load of it recovers the sheet. */
  url?: string;
}

/**
 * The page's font faces, after waiting up to `waitMs` for the ones it has
 * started using; `waitMs` 0 reads them without waiting. Null when the browser
 * could not answer, including a page that did not answer by the deadline.
 */
async function readFonts(page: Page, waitMs: number): Promise<FontState | null> {
  const inPage = page.evaluate(async (ms: number) => {
    const set = document.fonts;
    if (!set) return null;
    // Layout first: the browser starts loading a face when text laid out in it
    // needs it, and text the reveal just added has not been laid out yet.
    void document.documentElement.getBoundingClientRect();
    let timedOut = false;
    if (ms > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      timedOut = await Promise.race([
        set.ready.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), ms);
        }),
      ]);
      clearTimeout(timer);
    }
    // Once the wait is over, the waited read remembers each face's status and
    // starts listening for the browser's own load events; the read after
    // capture then knows which loads the capture started: a face idle at the
    // wait and in use now, or one the browser finished loading since (a face
    // added afterwards from a URL). A face registered already loaded from
    // bytes fires no load, so it is not mistaken for one.
    //
    // A face present at the wait keeps its own status, even if another face
    // had matching descriptors. For new objects only, a settled descriptor
    // accounts for Chromium rebuilding a stylesheet's faces during a shot.
    // Those copies announce loads even when the rendered text stays the same,
    // as measured on a live page.
    interface Since {
      settled: Set<string>;
      byFace: WeakMap<FontFace, string>;
      loaded: WeakSet<FontFace>;
      stop: () => void;
    }
    const describe = (f: FontFace): string =>
      [f.family, f.weight, f.style, f.stretch, f.unicodeRange, f.featureSettings].join("|");
    const store = window as unknown as { __qaFontsSinceWait?: Since };
    if (ms > 0) {
      store.__qaFontsSinceWait?.stop();
      const loaded = new WeakSet<FontFace>();
      const onLoad = (e: Event) => {
        for (const face of (e as FontFaceSetLoadEvent).fontfaces) loaded.add(face);
      };
      set.addEventListener("loadingdone", onLoad);
      set.addEventListener("loadingerror", onLoad);
      const faces = [...set];
      store.__qaFontsSinceWait = {
        settled: new Set(faces.filter((f) => f.status === "loaded" || f.status === "error").map(describe)),
        byFace: new WeakMap(faces.map((f) => [f, f.status])),
        loaded,
        stop: () => {
          set.removeEventListener("loadingdone", onLoad);
          set.removeEventListener("loadingerror", onLoad);
        },
      };
    }
    const since = store.__qaFontsSinceWait;
    return {
      timedOut,
      faces: [...set].map((f) => ({
        family: f.family.replace(/^["']|["']$/g, ""),
        status: f.status,
        began: (() => {
          if (ms !== 0 || since === undefined) return false;
          const previous = since.byFace.get(f);
          if (previous !== undefined) return previous === "unloaded" && f.status !== "unloaded";
          return since.loaded.has(f) && !since.settled.has(describe(f));
        })(),
      })),
    };
  }, waitMs);
  // A page that stops answering (a detached frame, a hung renderer) must not
  // hold the run: give up on it a little after its own deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), waitMs + 2_000);
  });
  try {
    const state = await Promise.race([inPage.catch(() => null), backstop]);
    return state && Array.isArray(state.faces) ? state : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stylesheet requests that failed in the navigation attempt that committed,
 * and are still failed: a later successful load of the same sheet clears its
 * failure. URLs stay in memory for matching; only origins leave. Also the
 * committed attempt's main-document response, which answers for the page when
 * a request held open (a stalled font) keeps the navigation from going idle.
 */
function trackStylesheets(page: Page): {
  goto: Page["goto"];
  failures: () => SheetFailure[];
  document: () => Response | undefined;
} {
  let attempt = 0;
  const startedIn = new WeakMap<Request, number>();
  const failed = new Map<string, SheetFailure>();
  let docRequest: Request | undefined;
  let doc: Response | undefined;
  let docFinished = false;
  const isDocument = (req: Request): boolean => {
    try {
      return req.isNavigationRequest() && req.frame() === page.mainFrame();
    } catch {
      return false;
    }
  };
  // A sheet is one request through its redirects: a later load that reaches a
  // different mirror still recovers the sheet the page asked for.
  const sheetKey = (req: Request): string => {
    let first = req;
    try {
      for (let r = req.redirectedFrom(); r; r = r.redirectedFrom()) first = r;
    } catch {
      // a request that cannot say where it came from is its own sheet
    }
    return first.url();
  };
  // Chromium refuses a stylesheet that answered 4xx/5xx and then reports the
  // request as aborted; the status is the better reason, so it stays.
  const answeredError = new WeakSet<Request>();
  const answeredOk = new WeakSet<Request>();
  const ours = (req: Request): boolean => {
    try {
      return req.resourceType() === "stylesheet" && req.frame() === page.mainFrame();
    } catch {
      return false; // a service-worker request has no frame, and no part in this document
    }
  };
  const origin = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return "unknown origin";
    }
  };
  page.on("request", (req) => {
    const mainDocument = isDocument(req);
    if (!mainDocument && !ours(req)) return;
    startedIn.set(req, attempt);
    // The browser issues a new document request when it follows a redirect.
    // Until that request answers, the earlier response cannot stand for it.
    if (mainDocument) {
      docRequest = req;
      doc = undefined;
      docFinished = false;
    }
  });
  page.on("response", (res) => {
    const req = res.request();
    if (startedIn.get(req) !== attempt) return;
    if (isDocument(req)) {
      if (req === docRequest) doc = res;
      return;
    }
    if (!ours(req)) return;
    const status = res.status();
    if (status >= 300 && status < 400) return; // a redirect's own answer is neither failure nor recovery
    if (status >= 400) {
      answeredError.add(req);
      failed.set(sheetKey(req), { origin: origin(req.url()), reason: `HTTP ${status}`, url: req.url() });
    } else answeredOk.add(req);
  });
  page.on("requestfinished", (req) => {
    if (startedIn.get(req) !== attempt) return;
    if (isDocument(req) && doc?.request() === req) docFinished = true;
    // A sheet recovers only once its whole body has arrived, not on its headers.
    if (ours(req) && answeredOk.has(req)) {
      failed.delete(sheetKey(req));
      for (const [k, v] of failed) if (v.url === req.url()) failed.delete(k);
    }
  });
  page.on("requestfailed", (req) => {
    if (!ours(req) || startedIn.get(req) !== attempt || answeredError.has(req)) return;
    failed.set(sheetKey(req), {
      origin: origin(req.url()),
      reason: req.failure()?.errorText || "request failed",
      url: req.url(),
    });
  });
  return {
    // Each call is a fresh attempt: gotoSurvivingNetworkChange retries once,
    // and an abandoned attempt's late events must not describe the page shot.
    goto: (url, options) => {
      attempt++;
      failed.clear();
      docRequest = undefined;
      doc = undefined;
      docFinished = false;
      return page.goto(url, options);
    },
    failures: () => [...failed.values()],
    // Only a document that arrived whole answers for the page.
    document: () => (docFinished ? doc : undefined),
  };
}

/** The notes for one phase: `before` is the bounded wait, `afterCapture` an unwaited read once its shots are taken. */
function fontNotes(
  phase: FontNote["phase"],
  before: FontState | null,
  afterCapture: FontState | null,
  sheets: SheetFailure[],
): FontNote[] {
  const notes: FontNote[] = [];
  if (before === null) {
    notes.push({ phase, kind: "unverified", reason: "font state could not be read before capture" });
  } else if (before.timedOut) {
    const pending = [...new Set(before.faces.filter((f) => f.status === "loading").map((f) => f.family))];
    if (pending.length === 0)
      notes.push({ phase, kind: "timeout", reason: `fonts still loading after ${FONT_WAIT_MS}ms` });
    for (const family of pending)
      notes.push({ phase, kind: "timeout", reason: `still loading after ${FONT_WAIT_MS}ms`, family });
  }
  const failedFaces = new Set(
    [...(before?.faces ?? []), ...(afterCapture?.faces ?? [])].filter((f) => f.status === "error").map((f) => f.family),
  );
  for (const family of failedFaces)
    notes.push({ phase, kind: "face-error", reason: "failed to load or parse", family });
  if (before !== null && afterCapture === null) {
    notes.push({ phase, kind: "unverified", reason: "font state could not be read after capture" });
  } else if (afterCapture !== null && !before?.timedOut) {
    // A load that began after the wait above (the rewind or a screenshot call
    // brought a face into use): still loading now, or idle at the wait and in
    // use now. Early shots of the phase may show the fallback.
    const started = new Set(
      afterCapture.faces
        .filter((f) => f.status === "loading" || f.began === true)
        .map((f) => f.family)
        .filter((family) => !failedFaces.has(family)),
    );
    for (const family of started)
      notes.push({ phase, kind: "unverified", reason: "began loading during capture", family });
  }
  for (const s of sheets) notes.push({ phase, kind: "stylesheet-error", reason: s.reason, origin: s.origin });
  const seen = new Set<string>();
  return notes.filter((n) => {
    const key = JSON.stringify(n);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One summary line's text for a phase's notes. */
function describeFontNotes(notes: FontNote[]): string {
  return notes
    .map((n) => `${n.kind}${n.family ? ` ${n.family}` : ""}${n.origin ? ` ${n.origin}` : ""}: ${n.reason}`)
    .join("; ");
}

/** Run `fn` with Playwright's own screenshot font wait off, restoring the previous setting after. */
async function withoutDriverFontWait<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[DRIVER_FONT_WAIT_OFF];
  process.env[DRIVER_FONT_WAIT_OFF] = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[DRIVER_FONT_WAIT_OFF];
    else process.env[DRIVER_FONT_WAIT_OFF] = previous;
  }
}

async function main(): Promise<void> {
  const SHOTS_ROOT = process.env.QA_SHOTS_ROOT || "/tmp/qa-shots";
  let URL_ = "";
  let SLUG = "";
  let RUN_ID = "";
  let PAGES = "";
  let VIEWPORTS = "1440,820,390";
  let MASKS = "";
  let APP = "";
  let AUTH_OP_ITEM = "";
  let AUTH_ID_FIELD = "client_id";
  let AUTH_SECRET_FIELD = "client_secret";
  let AUTH_ACT_AS = "";
  let AUTH_JWT_FILE = "";
  // Motion capture is ON by default and has to stay that way to be worth anything:
  // an opt-in motion check is a motion check nobody runs.
  let REDUCED_MOTION = "no-preference";
  let CAPTURE_MOTION = true;

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i] ?? "";
    const val = argv[i + 1] ?? "";
    let step = 2;
    switch (flag) {
      case "--url":
        URL_ = val;
        break;
      case "--repo-slug":
        SLUG = val;
        break;
      case "--run-id":
        RUN_ID = val;
        break;
      case "--pages":
        PAGES = val;
        break;
      case "--viewports":
        VIEWPORTS = val;
        break;
      case "--masks":
        MASKS = val;
        break;
      case "--app":
        APP = val;
        break;
      case "--reduced-motion":
        REDUCED_MOTION = "reduce";
        step = 1;
        break;
      case "--no-motion":
        CAPTURE_MOTION = false;
        step = 1;
        break;
      case "--auth-op-item":
        AUTH_OP_ITEM = val;
        break;
      case "--auth-id-field":
        AUTH_ID_FIELD = val || "client_id";
        break;
      case "--auth-secret-field":
        AUTH_SECRET_FIELD = val || "client_secret";
        break;
      case "--auth-act-as":
        AUTH_ACT_AS = val;
        break;
      case "--auth-jwt-file":
        AUTH_JWT_FILE = val;
        break;
      default:
        qaErr(`screenshot: unknown flag: ${flag}`);
        exit(2);
    }
    i += step;
  }

  // CF-Access service-token headers for a gated --live portal. The 1Password item
  // REF arrives on argv; the token VALUES are resolved here and kept in this
  // process (never the environment, argv or stdout) so they don't leak into
  // process listings or a child. With no item named, QA_CF_ACCESS_ID /
  // QA_CF_ACCESS_SECRET in the environment are the pair (no 1Password at all).
  const ACCESS =
    AUTH_OP_ITEM !== "" ? await qaResolveCfAccess(AUTH_OP_ITEM, AUTH_ID_FIELD, AUTH_SECRET_FIELD) : qaEnvCfAccess();
  if (AUTH_OP_ITEM !== "" && ACCESS === undefined) {
    qaErr(`screenshot: --auth-op-item set but service token unresolved from 1Password item ${AUTH_OP_ITEM}`);
    exit(2);
  }
  const JWT = qaReadJwtFile(AUTH_JWT_FILE);
  if (JWT === undefined) {
    qaErr(`screenshot: --auth-jwt-file ${AUTH_JWT_FILE} is missing or empty`);
    exit(2);
  }

  if (URL_ === "" || SLUG === "" || RUN_ID === "") {
    qaErr("usage: screenshot.ts --url U --repo-slug S --run-id R --pages '...'");
    exit(2);
  }
  PAGES = qaResolvePages(PAGES, "");

  const OUT_DIR = `${SHOTS_ROOT}/${SLUG}/${RUN_ID}`;
  mkdirSync(OUT_DIR, { recursive: true });

  // ── resolve a node_modules dir whose playwright has a CACHED chromium ─
  // Many playwright copies exist (npx cache, vendored repos) at different
  // versions, each pinned to a different chromium revision; only the revisions
  // under ~/.cache/ms-playwright are actually installed. Pick the first candidate
  // whose pinned revision has a real browser binary on disk (no guessing —
  // don't assume a version maps to an installed browser). None → install one on
  // first use (ensure-playwright.ts); impossible → a skip, said plainly.
  const NODE_PATH_DIR = qaPlaywrightNodeModules(APP);
  if (NODE_PATH_DIR === undefined) {
    qaErr("qa: skipped — Playwright unavailable (see the line above); no screenshots were taken");
    exit(7);
  }

  // Resolve `playwright` from the dir whose node_modules holds it, so the copy
  // with the installed browser is the one loaded.
  const require = createRequire(`${dirname(NODE_PATH_DIR)}/`);
  const { chromium }: typeof import("playwright") = require("playwright");

  // Deterministic multi-viewport capture → manifest.json + table.
  const base = URL_;
  const outDir = OUT_DIR;
  // A route given twice is shot once, for the same reason as a width (below).
  const pages = [...new Set(PAGES.split(/\s+/).filter(Boolean))];
  // A width given twice is shot once: a second capture would overwrite the
  // first one's PNG while both kept manifest rows and notes.
  const widths = [
    ...new Set(
      VIEWPORTS.split(",")
        .map((w) => Number.parseInt(w.trim(), 10))
        .filter(Boolean),
    ),
  ];
  const masks = (MASKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const slugRoute = (r: string): string => {
    let s = r
      .replace(/^\//, "")
      .replace(/[^A-Za-z0-9-]/g, "_")
      .replace(/_+/g, "_");
    s = s.replace(/^_+|_+$/g, "").slice(0, 60);
    return s || "index";
  };

  // CF-Access service-token headers (the pair resolved above) — sent on every
  // request to the site (qaSignAccess, never to a CDN it loads from) so a
  // gated portal returns 200 instead of a login redirect.
  // X-Portal-Act-As makes the probe the person the portal pairs it with
  // (PROBE_ACTS_AS); it means nothing without the token, so it only rides with it.
  const accessHeaders = qaAccessHeaders(ACCESS, AUTH_ACT_AS, JWT);

  // Chromium's shared-memory files go in a TMPDIR of the browser's own, removed
  // on exit: one is left behind whenever a process ends between making and
  // unlinking it (see interaction-check.browser.ts).
  const browserTmp = mkdtempSync(join(tmpdir(), "screenshot-browser-"));
  process.on("exit", () => rmSync(browserTmp, { recursive: true, force: true }));
  // Phone widths get a touchscreen browser of their own (QA_TOUCH_BROWSER_ARGS).
  const browsers = qaBrowsers(
    (args): Promise<Browser> => chromium.launch({ env: { ...process.env, TMPDIR: browserTmp }, args }),
  );

  // INK: the fraction of sampled pixels that are NOT the image's most common
  // colour. A page that captured as blank white scores ~0; a real page scores
  // well above the floor. Decoding happens in a throwaway blank context so a
  // site's own Content-Security-Policy cannot block the data URL.
  async function inkFraction(file: string): Promise<number | null> {
    // Decoding needs no pointer: the mouse browser.
    const ctx = await (await browsers.forWidth(Number.POSITIVE_INFINITY)).newContext();
    const p = await ctx.newPage();
    try {
      const b64 = readFileSync(file).toString("base64");
      return await p.evaluate(async (data: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        if (!g) return null;
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        // Every 4th pixel, colour quantised to 5 bits per channel: anti-aliasing
        // and gradients must not each read as their own distinct colour, or a
        // blank page with a faint wash would score as busy.
        const counts = new Map<number, number>();
        let total = 0;
        for (let i = 0; i < px.length; i += 16) {
          const k = (((px[i] ?? 0) >> 3) << 10) | (((px[i + 1] ?? 0) >> 3) << 5) | ((px[i + 2] ?? 0) >> 3);
          counts.set(k, (counts.get(k) || 0) + 1);
          total++;
        }
        let modal = 0;
        for (const v of counts.values()) if (v > modal) modal = v;
        return total ? 1 - modal / total : 0;
      }, b64);
    } catch {
      return null;
    } finally {
      await ctx.close();
    }
  }

  interface Shot {
    route: string;
    width: number;
    path: string;
    bytes: number;
    status: number;
    sha: string;
    ink: number | null;
    landedOrigin: string;
    /** Page rows this shot covers: the whole page, or one part of it. */
    rows: number;
    /** Present only when a font failed, timed out or could not be checked (FONTS). */
    fontNotes?: FontNote[];
  }
  interface Anim {
    name: string;
    target: string;
    durationMs: number | null;
    delayMs: number | null;
    playState: string;
  }
  type Motion =
    | {
        route: string;
        width: number;
        animations: Anim[];
        frames: string[];
        distinctFrames: number;
        error?: undefined;
        fontNotes?: FontNote[];
      }
    | {
        route: string;
        width: number;
        error: string;
        animations?: undefined;
        distinctFrames?: undefined;
        fontNotes?: FontNote[];
      };

  const manifest: Shot[] = [];
  const motion: Motion[] = [];
  /** FONTS: one summary line per capture phase with notes, in capture order. */
  const fontLines: string[] = [];
  const fontLine = (route: string, width: number, phase: string, notes: FontNote[]): void => {
    if (notes.length > 0)
      fontLines.push(`font: ${route} @${width} ${phase} — typography may differ: ${describeFontNotes(notes)}`);
  };
  for (const route of pages) {
    for (const width of widths) {
      const ctx = await (await browsers.forWidth(width)).newContext({
        ...qaContextOptions(width),
        deviceScaleFactor: 1,
        reducedMotion: REDUCED_MOTION === "reduce" ? "reduce" : "no-preference",
      });
      const page = await ctx.newPage();
      // Watching stylesheets starts before the first navigation (FONTS).
      const sheets = trackStylesheets(page);
      await qaSignAccess(page, base, accessHeaders);
      const url = base.replace(/\/$/, "") + (route.startsWith("/") ? route : `/${route}`);
      let status = 0;
      let landedOrigin = "";
      try {
        const resp = await gotoSurvivingNetworkChange(sheets, url, { waitUntil: "networkidle", timeout: 30000 });
        status = resp ? resp.status() : 0;
        // T5: an auth wall answers 200 from a DIFFERENT origin. Route-count
        // guards miss it on single-page sites; the landed origin never does.
        try {
          landedOrigin = new URL(page.url()).origin;
        } catch {
          // no origin to compare
        }
      } catch (e) {
        // A page that answered but never went network-idle — a font request
        // held open is the usual cause — is shot as it stands, so its fonts can
        // be checked and noted (FONTS). Any other failure has no page to shoot.
        const doc = sheets.document();
        if (e instanceof Error && e.name === "TimeoutError" && doc) {
          status = doc.status();
          try {
            landedOrigin = new URL(page.url()).origin;
          } catch {
            // no origin to compare
          }
          qaErr(`screenshot: ${route} @${width} — answered ${status} but never went network-idle; shot as it stands`);
        } else status = -1;
      }
      // MOTION, captured before the settled still — the entrance is already
      // running by the time `networkidle` resolves, so anything sampled later has
      // missed it. Two records, because they fail differently: the manifest says
      // what the app DECLARED (an animation that was never wired shows up as an
      // empty list), and the burst says what actually MOVED (an animation that is
      // declared but instantly complete shows up as identical frames).
      if (CAPTURE_MOTION) {
        const mdir = `${outDir}/motion`;
        mkdirSync(mdir, { recursive: true });
        let fontsBefore: FontState | null = null;
        let notes: FontNote[] = [];
        const withNotes = () => (notes.length > 0 ? { fontNotes: notes } : {});
        try {
          const anims = await page.evaluate(() =>
            document.getAnimations().map((a) => {
              const t: ComputedEffectTiming = a.effect?.getComputedTiming ? a.effect.getComputedTiming() : {};
              const el = a.effect && "target" in a.effect ? (a.effect as KeyframeEffect).target : null;
              // On an SVG element `className` is an SVGAnimatedString, not a
              // string, so String() on it yields "[object SVGAnimatedString]" and
              // the ensō mark reported its target as "[object". getAttribute is
              // the one accessor that answers the same for HTML and SVG.
              const cls = el ? el.getAttribute("class") || el.tagName.toLowerCase() : "?";
              return {
                name: String(("animationName" in a && a.animationName) || a.constructor?.name || "?"),
                target: String(cls).split(" ")[0] ?? "",
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
          // is also what makes it comparable between runs. Fonts settle first
          // (FONTS), so the replay is not drawn in a fallback that then swaps.
          fontsBefore = await readFonts(page, FONT_WAIT_MS);
          await page.evaluate(() => {
            for (const a of document.getAnimations()) {
              try {
                a.currentTime = 0;
                a.play();
              } catch {
                // an animation that refuses a seek is left where it is
              }
            }
          });
          // A frame burst across the entrance band. Named by elapsed ms so the
          // reviewer can say "at 120ms the run was half drawn" rather than "it
          // looks animated". Full-viewport shots with animations ALLOWED — this is
          // the one capture that must not be fast-forwarded.
          const burst: string[] = [];
          await withoutDriverFontWait(async () => {
            for (const at of [0, 120, 260, 520]) {
              const f = `${mdir}/${slugRoute(route)}-${width}-t${String(at).padStart(4, "0")}.png`;
              await page.screenshot({ path: f, animations: "allow", caret: "hide" });
              burst.push(f);
              await page.waitForTimeout(at === 0 ? 120 : 140);
            }
          });
          notes = fontNotes("motion", fontsBefore, await readFonts(page, 0), sheets.failures());
          const distinct = new Set(
            burst.map((f) => {
              try {
                return createHash("sha256").update(readFileSync(f)).digest("hex");
              } catch {
                return f;
              }
            }),
          ).size;
          motion.push({ route, width, animations: anims, frames: burst, distinctFrames: distinct, ...withNotes() });
        } catch (e) {
          // A burst that failed part way still says what its fonts were doing.
          if (notes.length === 0) notes = fontNotes("motion", fontsBefore, await readFonts(page, 0), sheets.failures());
          motion.push({ route, width, error: String(e instanceof Error && e.message ? e.message : e), ...withNotes() });
        }
        fontLine(route, width, "motion", notes);
      }

      // REVEAL before the settled still. A fullPage shot does NOT scroll, so a
      // site that fades sections in on scroll (an IntersectionObserver plus a
      // rule like [data-animate] { opacity: 0 }) captures as blank — the DOM is
      // complete, the pixels are white, and the capture exits 0, and a reviewer
      // then grades thousands of pixels of white.
      // Two passes, because either alone leaves a gap: scrolling fires the
      // observers a well-behaved site listens to, and forcing the end state
      // covers the ones whose trigger never fires under an automated scroll.
      //
      // Then IMAGES. A `loading="lazy"` image past the browser's own look-ahead
      // is fetched only when scrolled near, and the walk moves on in 60ms, so a
      // shot taken after it caught the empty box: a home page's row of photos
      // came out pure white in every shot while a live browser showed them
      // (screenshot-lazy.test.ts). Every lazy image is
      // switched to eager, which starts its fetch, and the shot waits for all
      // of them to load and decode, up to IMAGE_WAIT_MS; one still missing then
      // is named on stderr rather than shot silently as white.
      //
      // Then SKIPPED CONTENT. The browser does not draw a `content-visibility:
      // auto` element outside the viewport, and the shot is taken with the
      // window at the top of a 1,600px-tall viewport (qaContextOptions), so
      // such content lower down comes out blank — the walk's return to the top
      // un-draws what it passed, and a visual reviewer has to reject a blank
      // lower list as a capture artifact. Each element whose computed value is `auto` is set
      // `visible`; `hidden` content, which a visitor never sees, is left alone,
      // and no box's size or overflow changes, so a list that scrolls in its
      // own box shows only the rows in its window, as a visitor sees it.
      let pendingImages = 0;
      try {
        pendingImages = await page.evaluate(async (waitMs: number) => {
          const eager = () => {
            for (const i of document.images) if (i.loading === "lazy") i.loading = "eager";
          };
          eager();
          // "instant", because a site that sets `scroll-behavior: smooth` turns a
          // plain scrollTo into an animation: the shot then caught its sticky
          // header still on the way back up, drawn over the page title.
          const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo({ top: y, behavior: "instant" });
            await new Promise((r) => setTimeout(r, 60));
          }
          window.scrollTo({ top: 0, behavior: "instant" });
          const s = document.createElement("style");
          s.textContent =
            "[data-animate],[data-aos],[data-reveal],.reveal,.fade-in,.animate-on-scroll" +
            "{opacity:1 !important;transform:none !important;visibility:visible !important}";
          document.head.appendChild(s);
          for (const el of document.querySelectorAll<HTMLElement>("*")) {
            if (getComputedStyle(el).contentVisibility === "auto") {
              el.style.setProperty("content-visibility", "visible", "important");
            }
          }
          await new Promise((r) => setTimeout(r, 120));
          // Read the list again: the scroll can insert images (an observer
          // filling a slot), and those must be waited for too.
          eager();
          const imgs = [...document.images];
          const settled = (i: HTMLImageElement) =>
            i.complete
              ? Promise.resolve()
              : new Promise<void>((r) => {
                  i.addEventListener("load", () => r(), { once: true });
                  i.addEventListener("error", () => r(), { once: true });
                });
          await Promise.race([
            Promise.all(imgs.map(settled)).then(() =>
              Promise.all(imgs.filter((i) => i.naturalWidth > 0).map((i) => i.decode().catch(() => {}))),
            ),
            new Promise((r) => setTimeout(r, waitMs)),
          ]);
          return imgs.filter((i) => !i.complete).length;
        }, IMAGE_WAIT_MS);
      } catch {
        // a page that refuses the reveal is shot as it stands
      }
      if (pendingImages > 0) {
        qaErr(
          `screenshot: ${route} @${width} — ${pendingImages} image(s) still loading after ${IMAGE_WAIT_MS}ms; they may show empty`,
        );
      }

      // Fonts the reveal brought into use settle before the page is measured:
      // a height taken in the fallback cuts the parts in the wrong place (FONTS).
      const stillFontsBefore = await readFonts(page, FONT_WAIT_MS);

      // A page taller than PART_MAX is shot as clipped parts, top to bottom.
      // A part the reviewer can read at about 1.5x (PART_MAX). The blank and
      // identical-shot gates below judge a route's parts together, since one
      // part of a real page can be plain background.
      let height = 0;
      try {
        height = Number(await page.evaluate(() => document.documentElement.scrollHeight)) || 0;
      } catch {
        // an unmeasurable page is shot whole, as before
      }
      const parts = height > PART_MAX ? Math.ceil(height / PART_MAX) : 1;
      const stillShots: Shot[] = [];
      for (let part = 0; part < parts; part++) {
        const file =
          parts === 1
            ? `${outDir}/${slugRoute(route)}-${width}.png`
            : `${outDir}/${slugRoute(route)}-${width}-part${part + 1}.png`;
        const top = part * PART_MAX;
        await withoutDriverFontWait(() =>
          page.screenshot({
            path: file,
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            mask: masks.map((sel) => page.locator(sel)),
            ...(parts === 1 ? {} : { clip: { x: 0, y: top, width, height: Math.min(PART_MAX, height - top) } }),
          }),
        );
        let bytes = 0;
        try {
          bytes = statSync(file).size;
        } catch {
          // no file, no bytes
        }
        const ink = await inkFraction(file);
        // T5: hash the pixels, not just the size — identical shots across distinct
        // routes mean an auth wall or dead client routing, and the manifest would
        // otherwise report a clean 200 for every row.
        let sha = "";
        try {
          sha = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
        } catch {
          // unhashable reads as no hash
        }
        const rows = parts === 1 ? height : Math.min(PART_MAX, height - top);
        stillShots.push({ route, width, path: file, bytes, status, sha, ink, landedOrigin, rows });
      }
      // Every part carries the same notes: the wait ran once, for all of them.
      const stillNotes = fontNotes("still", stillFontsBefore, await readFonts(page, 0), sheets.failures());
      for (const shot of stillShots) manifest.push(stillNotes.length > 0 ? { ...shot, fontNotes: stillNotes } : shot);
      fontLine(route, width, "still", stillNotes);
      await ctx.close();
    }
  }
  await browsers.close();

  const baseOrigin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return "";
    }
  })();
  const offOrigin = manifest.filter((m) => m.landedOrigin && baseOrigin && m.landedOrigin !== baseOrigin);

  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  if (motion.length) {
    writeFileSync(`${outDir}/motion/manifest.json`, JSON.stringify(motion, null, 2));
    // A route whose frames are all identical either has no motion or has motion
    // that never runs. Both are reportable; neither is visible in a settled still.
    const still = motion.filter((m) => !m.error && (m.distinctFrames ?? 0) <= 1);
    const declared = motion.filter((m) => !m.error && (m.animations || []).length > 0).length;
    process.stdout.write(
      `\nmotion: ${declared}/${motion.length} route×viewport captures declared animations; ` +
        `${motion.length - still.length} showed frame-to-frame change\n`,
    );
    for (const m of still) {
      process.stdout.write(
        `  NO MOTION  ${m.route} @${m.width} — ${(m.animations || []).length} declared, frames identical\n`,
      );
    }
  }
  const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
  for (const m of manifest) {
    process.stdout.write(
      `${m.route.padEnd(16)} ${String(m.width).padStart(5)}  ${m.path}  ${kb(m.bytes).padStart(7)}  ${m.status}\n`,
    );
  }
  // FONTS: one line per capture phase with notes; a still's parts share one.
  for (const line of fontLines) process.stdout.write(`${line}\n`);

  // Collide-check per width: >1 distinct route sharing one image is not evidence.
  // A route shot in parts is compared as the whole sequence of its parts.
  const collisions: { width: number; routes: string[] }[] = [];
  for (const width of widths) {
    const seq = new Map<string, string[]>();
    for (const m of manifest.filter((x) => x.width === width)) seq.set(m.route, [...(seq.get(m.route) ?? []), m.sha]);
    const byHash = new Map<string, string[]>();
    for (const [route, shas] of seq) {
      if (shas.some((h) => !h)) continue;
      const key = shas.join("|");
      byHash.set(key, [...(byHash.get(key) ?? []), route]);
    }
    for (const [, routes] of byHash) {
      if (routes.length > 1) collisions.push({ width, routes });
    }
  }
  if (offOrigin.length > 0) {
    process.stderr.write("\nqa: REDIRECTED OFF-ORIGIN — these are not your pages\n");
    const seen = new Set<string>();
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
    exit(7);
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
    exit(6);
  }
  // STATUS GATE. A route that answered 4xx/5xx, or never answered, is not the
  // page: an answer like "Service tokens cannot access this page" is a 403 with a
  // full-ink body, so it clears the blank gate and, alone, the identical-shots
  // gate too. A route that IS an error page may answer its own code
  // (/404 with 404, /500 with 500) and nothing else: a 403 there is still a wall.
  const expectedError = (route: string): number | null => {
    const m = /^\/?(404|500)(\.html)?\/?$/.exec(route);
    return m ? Number(m[1]) : null;
  };
  const failedStatus = manifest.filter(
    (m) => (m.status < 200 || m.status >= 400) && m.status !== expectedError(m.route),
  );
  if (failedStatus.length > 0) {
    process.stderr.write("\nqa: UNSUCCESSFUL RESPONSES — these shots are not the pages\n");
    for (const m of failedStatus)
      process.stderr.write(`  ${m.route} @${m.width}: HTTP ${m.status === -1 ? "no response" : m.status}\n`);
    process.stderr.write(
      "  A 403 on a gated portal usually means the probe reached it as a MACHINE: pass\n" +
        "  --auth-act-as <the email its wrangler PROBE_ACTS_AS names> (serve.ts --live\n" +
        "  emits it as QA_AUTH_ACT_AS). Asking a person to sign in is not the fix.\n",
    );
    exit(9);
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
  // A route shot in parts is blank only as a whole page: its parts' ink,
  // weighted by the rows each covers. A part with unmeasured ink leaves the
  // route unjudged here; it is reported as unmeasured below.
  const byPage = new Map<string, Shot[]>();
  for (const m of manifest) byPage.set(`${m.route} ${m.width}`, [...(byPage.get(`${m.route} ${m.width}`) ?? []), m]);
  const blanks: { route: string; width: number; ink: number; path: string }[] = [];
  for (const shots of byPage.values()) {
    if (shots.some((m) => typeof m.ink !== "number")) continue;
    const rows = shots.reduce((n, m) => n + m.rows, 0);
    const ink =
      rows > 0
        ? shots.reduce((n, m) => n + (m.ink as number) * m.rows, 0) / rows
        : shots.reduce((n, m) => n + (m.ink as number), 0) / shots.length;
    if (ink < INK_FLOOR) blanks.push({ route: shots[0].route, width: shots[0].width, ink, path: shots[0].path });
  }
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
    exit(8);
  }

  process.stdout.write(`qa: shots + manifest → ${OUT_DIR}\n`);
}

await runToExit(main);
