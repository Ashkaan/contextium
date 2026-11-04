// interaction-check.browser.ts — use each page the way a visitor would, with
// the server held still, and report what does not answer at once.
//
// Four checks per route. The first two are judged on what the page shows
// BEFORE any reply; the last two read the settled page at a phone's size and
// press nothing:
//
//   blank-while-loading  Every fetch/XHR is held. One second after the HTML
//                        loads, the page's main region (`main`, else `body`)
//                        showing no text and no image, icon or progress
//                        indicator is blank while its data loads — and so is
//                        any visible iframe of 200 px or more that has not
//                        finished loading (an embedded booking widget under a
//                        heading is the common case).
//   no-feedback          The page loads normally, the pointer rests on the
//                        button, then every write and data request is held and
//                        the button is pressed. Feedback is any of: the visible
//                        text changed, an element appeared, vanished or moved,
//                        a native dialog opened, the page navigated, the <html>
//                        element's attributes changed (a theme toggle), or an
//                        aria-pressed / -expanded / -checked / -selected state
//                        changed — within 150 ms. A button that only greys out
//                        or fades is not feedback: a visitor reads it as broken.
//   covered              The settled page at 390 px with a touch pointer: every
//                        visible control tapped at its centre and corners must
//                        answer itself, never a neighbour whose enlarged hit
//                        area lies over it.
//   cut-off              At 390×844, every item inside a box that clips its content
//                        (overflow hidden or clip, 40 px or taller) is scrolled
//                        into view the way a visitor could — the page and every
//                        box that scrolls move, a hidden box is put back — and
//                        a box with items whose centre still lies off screen or
//                        outside a clipping box is one finding. A list capped at
//                        70% of the screen can hide half its rows on a phone,
//                        and /qa shoots phones 1600 px tall, where that cap
//                        holds every row, so no screenshot can show it.
//
// HELD MEANS NEVER SENT, and exactly this is held, in every check from before
// its page first navigates: every non-GET request (answered with a 204, or held
// open during a press) and, while a press is judged, every fetch/XHR (the
// route handler neither continues nor fulfils), every WebSocket (the constructor is replaced before any page script runs, so no
// socket connects), and service workers (blocked, since page.route cannot see
// what they fetch). A POST that is a page navigation (a plain HTML form) is
// answered locally with a 204 instead of held, which still sends nothing and
// keeps the page on screen. NOT held: GET navigations and GET page resources,
// which are reads by contract. Pressing Delete here deletes nothing.
//
// An element marked `data-qa-feedback="<reason>"` is skipped and listed, for
// the rare control whose correct response is off screen; the reason is the
// reviewer's to accept.
//
// Why: a form that sits blank for seconds while its data loads, and a button
// that gives no sign it was pressed, both pass a screenshot review — the
// screenshots show only the settled page.
//
// Run by interaction-check.ts as its own process. Argv: <base-url> <pages,
// space-separated> [<checks>: all (the default) | cut-off, which runs that
// check alone and presses nothing]. Env: QA_PW_PARENT (the dir whose node_modules holds the
// Playwright to use). Stdin, optional: one JSON object
// `{"access": {"id": …, "secret": …} | null, "actAs": "<email>", "jwt": "<token>"}`
// — the CF-Access pair, the person the probe acts as, and a local run's Access
// token. They travel on stdin because they are secrets: argv is in every
// process listing, and the environment is inherited by everything the browser
// starts.
// Output: `INTERACTION <route> <kind> <detail>` per finding (kinds:
// blank-while-loading, no-feedback, unpressed, covered, cut-off, unloadable), `SKIPPED <route>
// "<label>" <reason>` per opt-out, one `interaction: …` summary line.
// Exit 0 clean, 9 findings, 1 a route did not load, 2 an unknown <checks>.
//
// peers:
//   .agents/skills/qa/scripts/interaction-check.ts
//   .agents/skills/qa/scripts/tests/interaction-check.browser.test.ts

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { BrowserContext, Page, Request, Route } from "playwright";
import { type CfAccessPair, qaAccessHeaders } from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { gotoSurvivingNetworkChange } from "./nav.ts";

async function main(): Promise<void> {
  const require = createRequire(`${process.env.QA_PW_PARENT}/`);
  const { chromium }: typeof import("playwright") = require("playwright");

  const [base = "", pagesArg, checks = "all"] = process.argv.slice(2);
  const pages = (pagesArg ?? "").split(/\s+/).filter(Boolean);
  if (checks !== "all" && checks !== "cut-off") {
    process.stderr.write(`interaction-check.browser: checks ${checks} is not one of all, cut-off\n`);
    exit(2);
  }
  const BLANK_AFTER_MS = 1000;
  const FEEDBACK_MS = 150;
  const HOVER_SETTLE_MS = 60;
  const QUIET_CAP_MS = 2000;
  const STABLE_MS = 1200;
  const STABLE_POLL_MS = 200;
  const STABLE_CAP_MS = 8000;
  const MAX_BUTTONS = 25;
  const ROUTE_POOL = 4;
  const NAV_TIMEOUT_MS = 30_000;
  const BUTTONS = "button, [role=button], input[type=submit], input[type=button]";
  /** Everything a tap can land on, for the covered check: links and tabs as well as buttons. */
  const CONTROLS = "a[href], button, [role=button], [role=tab], summary, select, input:not([type=hidden])";
  /** A modal dialog, as both checks read one: a native dialog opened modal, an
   *  aria-modal one, or a role="dialog" (Radix sets no aria-modal). Each check
   *  also requires it visible and not itself aria-hidden. */
  const MODAL =
    'dialog:modal, [aria-modal="true"], :is([role="dialog"], [role="alertdialog"]):not(dialog):not([aria-modal="false"])';
  /** The phone width /qa shoots (screenshot.ts's default 390), where the touch floor applies. */
  const TOUCH_WIDTH = 390;

  /** The auth options on stdin; none when stdin is a terminal or empty. */
  function readAuth(): { access: CfAccessPair | undefined; actAs: string; jwt: string } {
    const text = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
    if (text === "") return { access: undefined, actAs: "", jwt: "" };
    const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
    const v: unknown = JSON.parse(text);
    const o = isObj(v) ? v : {};
    const a = isObj(o.access) ? o.access : {};
    const access =
      typeof a.id === "string" && typeof a.secret === "string" && a.id !== "" && a.secret !== ""
        ? { id: a.id, secret: a.secret }
        : undefined;
    return {
      access,
      actAs: typeof o.actAs === "string" ? o.actAs : "",
      jwt: typeof o.jwt === "string" ? o.jwt : "",
    };
  }
  // The person the token acts as on an app that declares PROBE_ACTS_AS; only with the token.
  const auth = readAuth();
  const extraHTTPHeaders = qaAccessHeaders(auth.access, auth.actAs, auth.jwt);

  const isData = (req: Request): boolean => ["fetch", "xhr"].includes(req.resourceType());

  /** Replaces WebSocket before any page script runs: a socket that never opens
   *  and never sends. A page that reads over a socket shows its waiting state.
   *  A dev server's hot-reload socket alone is real: it carries no app data and
   *  writes nothing, and Next's dev client never starts the page without it, so
   *  every button on a `next dev` target was dead (Next 16.2.9 and 16.4.3). Next's is `/_next/hmr` (`/_next/webpack-hmr` before 16.4);
   *  Vite's is named by its `vite-hmr` / `vite-ping` protocol. */
  const NO_SOCKETS = () => {
    const RealSocket = window.WebSocket;
    const isDevReload = (url: string | URL, protocols?: string | string[]): boolean => {
      const path = new URL(String(url), location.href).pathname;
      const named = ([] as string[]).concat(protocols ?? []);
      return (
        path.startsWith("/_next/hmr") ||
        path.startsWith("/_next/webpack-hmr") ||
        named.includes("vite-hmr") ||
        named.includes("vite-ping")
      );
    };
    class HeldSocket extends EventTarget {
      url: string;
      readyState: number;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        this.readyState = 0;
      }
      send() {}
      close() {}
    }
    // A constructor that returns an object hands `new` that object instead.
    function Socket(url: string | URL, protocols?: string | string[]): EventTarget {
      return isDevReload(url, protocols) ? new RealSocket(url, protocols) : new HeldSocket(url);
    }
    Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    Object.defineProperty(window, "WebSocket", { value: Socket, writable: true, configurable: true });
  };

  /**
   * The hold, inside the page. Routing holds a request the page makes while it
   * lives, but not one made while it CLOSES: a keepalive fetch or a beacon sent
   * from pagehide/beforeunload leaves through the browser past the route (seen on
   * the fixture, and on a live site as a record rewritten on every press). Once the
   * check arms it (`__qaHold`), fetch, XHR and sendBeacon here send nothing.
   */
  const HOLD_IN_PAGE = () => {
    const w = window as Window & { __qaHold?: boolean };
    const realFetch = w.fetch?.bind(w);
    if (realFetch) {
      w.fetch = (...args: Parameters<typeof fetch>) =>
        w.__qaHold ? new Promise<Response>(() => {}) : realFetch(...args);
    }
    const beacon = navigator.sendBeacon?.bind(navigator);
    if (beacon) {
      navigator.sendBeacon = (...args: Parameters<Navigator["sendBeacon"]>) => (w.__qaHold ? true : beacon(...args));
    }
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
      if (w.__qaHold) return;
      return send.apply(this, args);
    };
  };

  /** What a visitor can see: the text, the set of visible elements and where they
   *  are, the <html> element's attributes, and every ARIA state. Classes and
   *  inline styles are left out on purpose, so a button that only greys out or
   *  fades reads as unchanged. */
  const pageState = (): string => {
    const boxes: string[] = [];
    for (const el of document.body ? document.body.querySelectorAll("*") : []) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") continue;
      boxes.push(`${el.tagName}@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`);
    }
    const aria = [...document.querySelectorAll("[aria-pressed],[aria-expanded],[aria-checked],[aria-selected]")]
      .map((el) =>
        ["aria-pressed", "aria-expanded", "aria-checked", "aria-selected"].map((a) => el.getAttribute(a)).join("/"),
      )
      .join(";");
    const html = [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`).join(" ");
    return [location.href, html, aria, document.body ? document.body.innerText : "", boxes.join("|")].join("\n");
  };

  // Playwright starts Chromium with --disable-dev-shm-usage, so Chromium backs
  // its shared memory with `.org.chromium.Chromium.*` files in TMPDIR, each
  // unlinked right after it is made. A process ended between the two, which
  // browser.close() does, leaves its file behind for good, and test runs piled
  // them into /tmp. The browser gets a TMPDIR of its own, removed once it closes.
  const browserTmp = mkdtempSync(join(tmpdir(), "interaction-browser-"));
  const browser = await chromium.launch({ env: { ...process.env, TMPDIR: browserTmp } });
  const findings: string[] = [];
  const skipped: string[] = [];
  let pressed = 0;
  let candidates = 0;
  let unloadable = 0;

  type Screen = { viewport: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean };
  const DESKTOP: Screen = { viewport: { width: 1440, height: 900 } };
  const PHONE: Screen = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

  /**
   * Every check's page, with the write guard in place before its first
   * navigation: a write (any non-GET) is answered here with a 204 and never
   * sent. A check that routes more narrowly does it on the page, and passes
   * what it does not hold on with `fallback()`, so this guard still answers it.
   * Until the Contextium v9.2.0 review only the cut-off and covered checks had
   * it: the full run's button-finding page, and each press's page until the
   * press, loaded with no route at all, and a page that saves on load sent it.
   */
  async function newPage(screen: Screen = DESKTOP): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({
      ...screen,
      extraHTTPHeaders,
      serviceWorkers: "block",
    });
    await ctx.addInitScript(NO_SOCKETS);
    await ctx.addInitScript(HOLD_IN_PAGE);
    await ctx.route("**/*", (r) =>
      r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" }),
    );
    const page = await ctx.newPage();
    return { ctx, page };
  }

  // A page that answered 4xx/5xx, or landed on another origin (a sign-in wall),
  // is not the page: its text would pass every check below and stamp a clean
  // run. screenshot.ts's STATUS and OFF-ORIGIN gates refuse the same two cases.
  async function gotoChecked(page: Page, url: string) {
    const resp = await gotoSurvivingNetworkChange(page, url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    const status = resp ? resp.status() : 0;
    if (status === 0 || status >= 400) throw new Error(`HTTP ${status || "no response"} from ${url}`);
    const landed = new URL(page.url()).origin;
    if (landed !== new URL(url).origin) throw new Error(`redirected off-origin to ${landed}`);
    return resp;
  }

  // Where the page ended up once it had time to move: a script redirect to a
  // sign-in page on another origin runs after DOMContentLoaded, so the check in
  // gotoChecked alone would pass it. Called again after the page settles.
  function assertLanded(page: Page, url: string): void {
    const landed = new URL(page.url()).origin;
    if (landed !== new URL(url).origin) throw new Error(`redirected off-origin to ${landed}`);
  }

  /** Arms HOLD_IN_PAGE in every frame of the page, not only the top one: an
   *  embedded frame's pagehide beacon or keepalive fetch leaves past any route
   *  too. A frame already gone, or one that never finished loading (a frame
   *  whose host does not answer evaluates forever), is skipped after 300 ms. */
  async function armHold(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          frame
            .evaluate(() => {
              (window as Window & { __qaHold?: boolean }).__qaHold = true;
            })
            .catch(() => {}),
          new Promise<void>((r) => {
            timer = setTimeout(r, 300);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const firstLine = (err: unknown): string =>
    String(typeof err === "object" && err !== null && "message" in err ? (err.message ?? err) : err)
      .split("\n")[0]
      ?.slice(0, 160) ?? "";

  async function blankWhileLoading(route: string, url: string): Promise<boolean> {
    const { ctx, page } = await newPage();
    try {
      await page.route("**/*", (r: Route) => (isData(r.request()) ? undefined : r.fallback()));
      await gotoChecked(page, url);
      await page.waitForTimeout(BLANK_AFTER_MS);
      assertLanded(page, url);
      const shown = await page.evaluate(() => {
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        const region: HTMLElement | null = document.querySelector("main") ?? document.body;
        const text = (region?.innerText ?? "").trim().length;
        const marks = [
          ...(region?.querySelectorAll("img, svg, canvas, video, [role=progressbar], [aria-busy=true], progress") ??
            []),
        ].filter(visible).length;
        const frames = [...document.querySelectorAll("iframe")]
          .filter(visible)
          .filter((f) => {
            const r = f.getBoundingClientRect();
            return r.width >= 200 && r.height >= 200;
          })
          .map((f) => f.src || "(inline)");
        return { text, marks, frames };
      });
      if (shown.text === 0 && shown.marks === 0) {
        findings.push(
          `INTERACTION ${route} blank-while-loading the main region showed nothing ${BLANK_AFTER_MS} ms after the HTML loaded, with its data requests still pending`,
        );
      }
      // A large iframe still loading at the same moment is the same blank: the
      // page around it rendered, the part the visitor came for did not.
      const loaded: string[] = [];
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let state: string;
        try {
          state = await Promise.race([
            frame.evaluate(() => document.readyState).catch(() => "unknown"),
            new Promise<string>((r) => {
              timer = setTimeout(() => r("pending"), 300);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (state === "complete" && frame.url() !== "about:blank") loaded.push(frame.url());
      }
      for (const src of shown.frames) {
        if (!loaded.some((u) => u === src || u.startsWith(src))) {
          findings.push(
            `INTERACTION ${route} blank-while-loading an iframe (${src.slice(0, 80)}) was still loading ${BLANK_AFTER_MS} ms after the HTML, with no placeholder around it`,
          );
        }
      }
      return true;
    } catch (err) {
      unloadable++;
      findings.push(`INTERACTION ${route} unloadable ${firstLine(err)}`);
      return false;
    } finally {
      await armHold(page);
      await ctx.close();
    }
  }

  /**
   * A quiet network is not a rendered page: a client app can fetch, go quiet, and
   * only then draw its buttons (a review page that drew all of them ~1.5 s
   * after load). Counted at network-idle, that page had one button and
   * the run pressed nothing — or, on the next load, pressed by an index the page
   * had not reached yet. So settle also waits until the buttons and the text stop
   * changing for STABLE_MS, bounded by STABLE_CAP_MS for a page that never stops.
   */
  async function settle(page: Page): Promise<void> {
    await page.waitForLoadState("networkidle", { timeout: QUIET_CAP_MS }).catch(() => {});
    const signature = () =>
      page
        .evaluate(
          (sel: string) => `${document.querySelectorAll(sel).length}:${document.body?.innerText.length ?? 0}`,
          BUTTONS,
        )
        .catch(() => "");
    const deadline = Date.now() + STABLE_CAP_MS;
    let last = await signature();
    let since = Date.now();
    while (Date.now() < deadline && Date.now() - since < STABLE_MS) {
      await page.waitForTimeout(STABLE_POLL_MS);
      const now = await signature();
      if (now !== last) {
        last = now;
        since = Date.now();
      }
    }
  }

  async function noFeedback(route: string, url: string): Promise<void> {
    const { ctx, page } = await newPage();
    // A held request is never answered while the press is judged, and ABORTED
    // (still never sent) before the page reloads or closes. A form that POSTs as
    // a page NAVIGATION is the exception: held open, Chromium tore the page's
    // target down at once, so the feedback read failed and the run never exited
    // (an unsubscribe button did exactly this). It is answered
    // here with a local 204 — still never sent, and a 204 leaves the browser on
    // the page, so what the click put on screen stays readable.
    const held: Route[] = [];
    const release = async () => {
      for (const r of held.splice(0)) await r.abort().catch(() => {});
    };
    try {
      await gotoChecked(page, url);
      await settle(page);
      assertLanded(page, url);
      const all = await page.locator(BUTTONS).evaluateAll(
        (els, modal) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            // checkVisibility, not the box alone: a button inside a closed <details>
            // keeps a laid-out box a visitor cannot see (one settings page
            // reported 24 such buttons as unpressed).
            const shown = r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true });
            const h = el as HTMLElement & { value?: string; disabled?: boolean };
            const label = (h.innerText || h.value || el.getAttribute("aria-label") || h.title || "")
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 60);
            // The option a set already has selected — a pressed filter, the tab
            // shown, the checked radio, the current section — correctly does nothing when pressed
            // again, and its aria state says so; it is listed, not failed.
            const current = el.getAttribute("aria-current");
            // A radio already checked is the same fact; a checkbox's aria-checked is
            // not, since pressing it again toggles it.
            const radio = ["radio", "menuitemradio"].includes(el.getAttribute("role") ?? "");
            const selected =
              el.getAttribute("aria-selected") === "true" ||
              el.getAttribute("aria-pressed") === "true" ||
              (radio && el.getAttribute("aria-checked") === "true") ||
              (current !== null && current !== "false");
            // The page behind an open modal dialog — marked aria-hidden (as Radix's
            // Dialog marks everything outside it) while that dialog is shown — or
            // anything inert is out of every visitor's reach by design; listed, not
            // failed (one app's drawer reported 17 such buttons as
            // unpressed). aria-hidden alone hides a button from
            // a screen reader, not from a mouse, so it exempts nothing by itself:
            // only a modal shown elsewhere does — a native dialog opened modal, an
            // aria-modal one, or a role="dialog" (Radix sets no aria-modal) that is
            // visible, `visibility: hidden` included. A <dialog> opened with show(),
            // whatever its role, and anything marked aria-modal="false" are not
            // modal and exempt nothing.
            const behindModal =
              el.closest('[aria-hidden="true"]') !== null &&
              [...document.querySelectorAll(modal)].some(
                (d) =>
                  !d.contains(el) &&
                  d.closest('[aria-hidden="true"]') === null &&
                  d.checkVisibility({ visibilityProperty: true }),
              );
            const hidden = el.closest("[inert]") !== null || behindModal;
            // `next dev` draws its own tools button into the page, inside a
            // <nextjs-portal> shadow root; a production build has none, and it is
            // not the app's to answer for.
            const root = el.getRootNode();
            const devChrome = root instanceof ShadowRoot && root.host.localName === "nextjs-portal";
            return {
              shown: shown && !h.disabled && el.getAttribute("aria-disabled") !== "true",
              label: label || "(unlabelled)",
              optOut:
                el.getAttribute("data-qa-feedback") ??
                (devChrome
                  ? "the dev server's own tools, absent from a production build"
                  : hidden
                    ? "hidden from every visitor (aria-hidden or inert), as behind an open dialog"
                    : selected
                      ? "already the selected option"
                      : null),
            };
          }),
        MODAL,
      );
      const eligible: { label: string; index: number }[] = [];
      all.forEach((b, index) => {
        if (!b.shown) return;
        if (b.optOut) skipped.push(`SKIPPED ${route} "${b.label}" ${b.optOut}`);
        else eligible.push({ ...b, index });
      });
      candidates += eligible.length;
      if (eligible.length > MAX_BUTTONS) {
        skipped.push(`SKIPPED ${route} ${eligible.length - MAX_BUTTONS} button(s) past the cap of ${MAX_BUTTONS}`);
      }

      // A FRESH page per press, closed with its hold still in place. The hold is
      // never lifted: lifting it to reload is how an editor that saves on its way
      // out (pagehide, beforeunload, a beacon) wrote to production between
      // presses — one review record was rewritten on every press.
      // Whatever the page sends while it closes is held, and dies with it.
      const hold = (r: Route) => {
        const req = r.request();
        if (req.method() !== "GET" && req.isNavigationRequest()) return r.fulfill({ status: 204 }); // never sent
        if (req.method() !== "GET" || isData(req)) {
          held.push(r); // held: never sent
          return;
        }
        return r.continue();
      };
      await armHold(page);
      await page.close({ runBeforeUnload: false });

      // And a fresh CONTEXT per press: storage is per context, and a press the
      // page remembers (collapsible headers that save a collapsed category to
      // localStorage) otherwise hides the buttons every
      // later press was counted against.
      for (const { label, index } of eligible.slice(0, MAX_BUTTONS)) {
        const { ctx: pressCtx, page: press } = await newPage();
        let dialogOpened = false;
        let navigated = false;
        press.on("dialog", (d) => {
          dialogOpened = true;
          d.dismiss().catch(() => {});
        });
        try {
          await gotoChecked(press, url);
          await settle(press);
          assertLanded(press, url);
          // The page draws its buttons on its own schedule: wait until the one
          // counted at this index exists before reaching for it.
          await press
            .waitForFunction(
              ([sel, n]: [string, number]) => document.querySelectorAll(sel).length > n,
              [BUTTONS, index] as [string, number],
              { timeout: STABLE_CAP_MS },
            )
            .catch(() => {});
          const button = press.locator(BUTTONS).nth(index);
          await button.hover({ timeout: 2_000 });
          await press.waitForTimeout(HOVER_SETTLE_MS);
          await press.route("**/*", hold);
          await armHold(press);
          press.on("framenavigated", (f) => {
            if (f === press.mainFrame()) navigated = true;
          });
          const before = await press.evaluate(pageState);
          await button.click({ timeout: 2_000, noWaitAfter: true });
          pressed++;
          await press.waitForTimeout(FEEDBACK_MS);
          if (dialogOpened || navigated) continue;
          const after = await press.evaluate(pageState).catch(() => null);
          if (after !== null && after === before) {
            findings.push(
              `INTERACTION ${route} no-feedback "${label}" changed nothing on screen within ${FEEDBACK_MS} ms of the click`,
            );
          }
        } catch (err) {
          findings.push(`INTERACTION ${route} unpressed "${label}" ${firstLine(err)}`);
        } finally {
          await release();
          await armHold(press);
          await press.close({ runBeforeUnload: false }).catch(() => {});
          await pressCtx.close().catch(() => {});
        }
      }
    } catch (err) {
      unloadable++;
      findings.push(`INTERACTION ${route} unloadable ${firstLine(err)}`);
    } finally {
      await release();
      await ctx.close();
    }
  }

  /**
   * Inside the page: every item inside a box that clips its content vertically,
   * scrolled into view the way a visitor could — the page and every box that
   * scrolls move, a box with overflow hidden is put back, since no finger can
   * move it — then judged by where its centre lands. One record per box that
   * still hides something. Only the vertical is judged: a carousel's slides
   * wait off to the side by design, and the defect this finds is rows cut off
   * below an edge.
   *
   * A box is an element with overflow-y hidden or clip, at least 40 px tall,
   * whose content runs more than 4 px past its height (a closed panel is under
   * the floor). An item is a rendered element a visitor could see — not
   * display: none, visibility: hidden or opacity 0, so a deck's waiting slides
   * are not judged in their hidden state — with text of its own, or an
   * image, icon, video, canvas or form control; it belongs to the nearest box
   * that clips it. Clipping follows the containing-block chain, not the DOM
   * chain: an absolutely positioned element escapes every box below its nearest
   * positioned ancestor, and a fixed one every box below its nearest ancestor
   * with a transform (or translate, rotate, scale), filter, perspective or
   * paint containment. An item is
   * tried centred, then at the top and the bottom of its scrollers: a visitor
   * can stop a scroller anywhere, so centring alone could judge a row hidden
   * that scrolling it to the top shows. The element whose
   * overflow the screen takes — <html>, or <body> when <html> is visible — is
   * the screen itself: body { overflow: hidden } makes the whole page a box, and
   * body { overflow-x: hidden } clips nothing the page scrolls to.
   */
  const scanCutOff = (modalSel: string): { box: string; shown: number; hidden: number; firstHidden: string }[] => {
    const html = document.documentElement;
    const body = document.body;
    if (!body) return [];
    // An open modal dialog is all a visitor can reach: the page behind it is hidden
    // and its scroll locked by design, so only the dialog's items count — the
    // dialog the covered check reads (a modal drawer once reported the whole
    // board behind it as cut off).
    const modal = [...document.querySelectorAll(modalSel)]
      .filter((d) => d.closest('[aria-hidden="true"]') === null && d.checkVisibility({ visibilityProperty: true }))
      .pop();
    const clips = (v: string) => v === "hidden" || v === "clip";
    // <body>'s overflow passes to the screen only when <html>'s is visible on both
    // axes and neither element has layout or paint containment.
    const htmlStyle = getComputedStyle(html);
    const contained = (cs: CSSStyleDeclaration) =>
      /layout|paint|strict|content/.test(cs.contain) || cs.contentVisibility === "auto";
    const root =
      htmlStyle.overflowX === "visible" &&
      htmlStyle.overflowY === "visible" &&
      !contained(htmlStyle) &&
      !contained(getComputedStyle(body))
        ? body
        : html;
    const pageClipped = clips(getComputedStyle(root).overflowY);
    const pageScroller = document.scrollingElement ?? html;
    const OWN = new Set(["img", "svg", "video", "canvas", "input", "select", "textarea", "button"]);
    const isBox = (el: Element): boolean => {
      if (el === root) return pageClipped && pageScroller.scrollHeight - innerHeight > 4;
      if (!clips(getComputedStyle(el).overflowY)) return false;
      return el.getBoundingClientRect().height >= 40 && el.scrollHeight - el.clientHeight > 4;
    };
    const isItem = (el: Element): boolean => {
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (OWN.has(el.localName)) return true;
      return [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    };
    /** Whether `s` makes its element the containing block of a fixed descendant. */
    const holdsFixed = (s: CSSStyleDeclaration): boolean =>
      s.transform !== "none" ||
      s.translate !== "none" ||
      s.rotate !== "none" ||
      s.scale !== "none" ||
      s.perspective !== "none" ||
      s.filter !== "none" ||
      s.backdropFilter !== "none" ||
      /transform|translate|rotate|scale|perspective|filter/.test(s.willChange) ||
      /paint|layout|strict|content/.test(s.contain) ||
      s.contentVisibility === "auto";
    /** The ancestors that clip `el`, nearest first, and whether the screen's own scroll moves it. */
    const clippersOf = (el: Element): { clippers: Element[]; onPage: boolean } => {
      const clippers: Element[] = [];
      let position = getComputedStyle(el).position;
      for (let a = el.parentElement; a !== null && a !== html; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (position === "fixed" && !holdsFixed(s)) continue;
        if (position === "absolute" && s.position === "static" && !holdsFixed(s)) continue;
        if (a !== root && (s.overflowX !== "visible" || s.overflowY !== "visible")) clippers.push(a);
        position = s.position;
      }
      // A fixed element no ancestor below <html> holds is held by <html> itself when
      // <html> has a transform or the like, and then scrolls with the page.
      return { clippers, onPage: position !== "fixed" || holdsFixed(getComputedStyle(html)) };
    };
    const label = (el: Element): string => {
      const h = el as HTMLElement & { value?: string; placeholder?: string };
      return (
        h.innerText ||
        el.getAttribute("alt") ||
        el.getAttribute("aria-label") ||
        h.value ||
        h.placeholder ||
        `<${el.localName}>`
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
    };
    const named = (el: Element) => `${el.localName}${[...el.classList].map((c) => `.${c}`).join("")}`;

    // Boxes first, before anything is scrolled; then each item on its own.
    const boxes = new Set([body, ...body.querySelectorAll("*"), root].filter(isBox));
    if (boxes.size === 0) return [];
    const tally = new Map<Element, { shown: number; hidden: number; firstHidden: string }>();
    for (const item of body.querySelectorAll("*")) {
      if (boxes.has(item) || !isItem(item)) continue;
      if (modal !== undefined && !modal.contains(item)) continue;
      const { clippers, onPage } = clippersOf(item);
      const box = clippers.find((c) => boxes.has(c)) ?? (onPage && boxes.has(root) ? root : undefined);
      if (box === undefined) continue;
      // A closed panel nearer the item than its box hides it on purpose — an
      // accordion folded shut is under the 40-px floor — so it is not judged.
      const nearer = box === root ? clippers : clippers.slice(0, clippers.indexOf(box));
      if (nearer.some((c) => clips(getComputedStyle(c).overflowY) && c.getBoundingClientRect().height < 40)) continue;
      // Every box with overflow hidden on the DOM path, where it was: scrollIntoView moves them, no finger can.
      const putBack: [Element | null, number][] = [];
      for (let a = item.parentElement; a !== null; a = a.parentElement) {
        if (a === root || a === html) continue;
        if (getComputedStyle(a).overflowY === "hidden") putBack.push([a, a.scrollTop]);
      }
      if (pageClipped) putBack.push([null, pageScroller.scrollTop]);
      // The band the item is seen through: the screen, narrowed to each clipping
      // box's padding edge, where overflow is cut (a border is not see-through).
      const band = (from = 0): [number, number] => {
        let top = 0;
        let bottom = innerHeight;
        for (const c of clippers.slice(from)) {
          if (getComputedStyle(c).overflowY === "visible") continue;
          // clientTop and clientHeight are layout pixels; a transform can scale the
          // box on screen, so they are scaled by its on-screen to layout height.
          const r = c.getBoundingClientRect();
          const k = c instanceof HTMLElement && c.offsetHeight > 0 ? r.height / c.offsetHeight : 1;
          // overflow: clip cuts overflow-clip-margin beyond the padding edge (hidden does not).
          const cs = getComputedStyle(c);
          // Its keyword names the edge the margin is measured from: padding-box
          // (the default), content-box (inside the padding) or border-box.
          let edgeTop = c.clientTop;
          let edgeHeight = c.clientHeight;
          let m = 0;
          if (cs.overflowY === "clip") {
            const parts = cs.overflowClipMargin.split(" ");
            m = Number.parseFloat(parts.find((p) => /^-?[\d.]+px$/.test(p)) ?? "") || 0;
            if (parts.includes("content-box")) {
              const pt = Number.parseFloat(cs.paddingTop) || 0;
              edgeTop += pt;
              edgeHeight -= pt + (Number.parseFloat(cs.paddingBottom) || 0);
            } else if (parts.includes("border-box")) {
              edgeTop = 0;
              edgeHeight = c instanceof HTMLElement ? c.offsetHeight : edgeHeight + 2 * c.clientTop;
            }
          }
          const t = r.top + (edgeTop - m) * k;
          top = Math.max(top, t);
          bottom = Math.min(bottom, t + (edgeHeight + 2 * m) * k);
        }
        return [top, bottom];
      };
      const centre = () => {
        const r = item.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      const inBand = (): boolean => {
        const [t, b] = band();
        const y = centre();
        return y >= t && y < b;
      };
      const shownAt = (block: ScrollLogicalPosition): boolean => {
        item.scrollIntoView({ block, inline: "nearest", behavior: "instant" });
        for (const [a, top] of putBack) {
          if (a === null) window.scrollTo({ top, behavior: "instant" });
          else a.scrollTo({ top, behavior: "instant" });
        }
        return inBand();
      };
      // Failing those, every scroller a finger can move — the item's own first,
      // then outward, then the page — is scrolled to put the item's centre in the
      // middle of the band of the clips at and outside it: a clip nested inside a
      // scroller moves with the item when that scroller moves, so it is the inner
      // scrollers' to satisfy, and an outer one can bring a whole nested scrollport
      // into view. A scroller partly cut off by an outer box needs this.
      const scrollers = clippers.filter((c) => /auto|scroll/.test(getComputedStyle(c).overflowY));
      const shownInBand = (): boolean => {
        for (let pass = 0; pass < 3; pass++) {
          for (const sc of [...scrollers, null]) {
            if (sc === null && pageClipped) continue;
            const [t, b] = band(sc === null ? clippers.length : clippers.indexOf(sc));
            if (t >= b) continue;
            const by = centre() - (t + b) / 2;
            if (sc === null) window.scrollBy({ top: by, behavior: "instant" });
            else {
              // The distance is on screen; a scaled scroller moves in its own layout pixels.
              const k =
                sc instanceof HTMLElement && sc.offsetHeight > 0
                  ? sc.getBoundingClientRect().height / sc.offsetHeight
                  : 1;
              sc.scrollBy({ top: by / (k || 1), behavior: "instant" });
            }
            if (inBand()) return true;
          }
        }
        return inBand();
      };
      const seen = shownAt("center") || shownAt("start") || shownAt("end") || shownInBand();
      const t = tally.get(box) ?? { shown: 0, hidden: 0, firstHidden: "" };
      if (seen) t.shown++;
      else if (t.hidden++ === 0) t.firstHidden = label(item);
      tally.set(box, t);
    }
    return [...tally].filter(([, t]) => t.hidden > 0).map(([box, t]) => ({ box: named(box), ...t }));
  };

  // Read-only, and may run on a deployed site (--checks cut-off): every write is
  // answered by newPage's guard and never sent, and the in-page hold is armed
  // before the page closes, for what pagehide sends past any route.
  async function cutOff(route: string, url: string): Promise<boolean> {
    const { ctx, page } = await newPage(PHONE);
    try {
      await gotoChecked(page, url);
      await settle(page);
      assertLanded(page, url);
      for (const b of await page.evaluate(scanCutOff, MODAL)) {
        findings.push(
          `INTERACTION ${route} cut-off ${b.box} shows ${b.shown}, hides ${b.hidden} below its edge (first hidden "${b.firstHidden}")`,
        );
      }
      return true;
    } catch (err) {
      unloadable++;
      findings.push(`INTERACTION ${route} unloadable ${firstLine(err)}`);
      return false;
    } finally {
      await armHold(page);
      await ctx.close();
    }
  }

  /**
   * Every visible control on the settled page, tapped at its centre and four
   * points just inside its corners, at a phone's width with a touch pointer.
   * What answers each tap is the topmost element there; one inside another
   * control means that control's enlarged hit area lies over this one, and a
   * tap meant for it goes elsewhere. With a dialog open, only the dialog is read.
   */
  const coveredControls = ([sel, modalSel]: [string, string]): string[] => {
    const name = (e: Element) =>
      (e.textContent || e.getAttribute("aria-label") || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
    const modal = [...document.querySelectorAll(modalSel)]
      .filter((d) => d.closest('[aria-hidden="true"]') === null && d.checkVisibility({ visibilityProperty: true }))
      .pop();
    const out: string[] = [];
    for (const el of (modal ?? document).querySelectorAll(sel)) {
      const first = el.getBoundingClientRect();
      // checkVisibility, not the box alone: a field inside a closed <details> keeps a
      // laid-out box no visitor can see or tap (a settings panel's Edit details).
      if (
        first.width <= 2 ||
        first.height <= 2 ||
        !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      )
        continue;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
      ];
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || el.contains(hit) || hit.contains(el)) continue;
        const owner = hit.closest(sel);
        if (owner && owner !== el && !owner.contains(el) && !el.contains(owner)) {
          out.push(`"${name(el)}" is under "${name(owner)}"'s hit area`);
          break;
        }
      }
    }
    return out;
  };

  // Text links grown to 44px for a touchscreen can cover the link stacked under
  // them, so a tap on one title opens its neighbour. A mouse never meets the enlarged area, so this reads the page as a
  // phone does. Nothing is pressed; every write is answered here, never sent.
  async function covered(route: string, url: string): Promise<void> {
    const { ctx, page } = await newPage({
      viewport: { width: TOUCH_WIDTH, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await gotoChecked(page, url);
      await settle(page);
      assertLanded(page, url);
      for (const c of await page.evaluate(coveredControls, [CONTROLS, MODAL] as [string, string]))
        findings.push(`INTERACTION ${route} covered ${c} at ${TOUCH_WIDTH} px with a touch pointer`);
    } catch (err) {
      unloadable++;
      findings.push(`INTERACTION ${route} unloadable ${firstLine(err)}`);
    } finally {
      // Armed before the page closes: a keepalive fetch or beacon sent from
      // pagehide leaves past any route, so it is held in the page itself.
      await armHold(page);
      await ctx.close();
    }
  }

  // A route that will not load is reported once, by whichever check met it first.
  async function checkRoute(route: string): Promise<void> {
    const url = new URL(route, base).toString();
    if (checks === "cut-off") {
      await cutOff(route, url);
      return;
    }
    if (await blankWhileLoading(route, url)) {
      if (await cutOff(route, url)) {
        await noFeedback(route, url);
        await covered(route, url);
      }
    }
  }

  // Four routes at a time; each route's own presses stay in order, one fresh page each.
  const queue = [...pages];
  try {
    await Promise.all(
      Array.from({ length: Math.min(ROUTE_POOL, queue.length) }, async () => {
        for (let route = queue.shift(); route !== undefined; route = queue.shift()) await checkRoute(route);
      }),
    );
  } finally {
    await browser.close();
    rmSync(browserTmp, { recursive: true, force: true });
  }
  findings.sort();
  for (const f of findings) process.stdout.write(`${f}\n`);
  for (const s of skipped) process.stdout.write(`${s}\n`);
  process.stdout.write(
    `interaction: ${pages.length} route(s), pressed ${pressed} of ${candidates} button(s) (cap ${MAX_BUTTONS} per route), ${findings.length} finding(s), ${skipped.length} skipped\n`,
  );
  exit(unloadable > 0 ? 1 : findings.length > 0 ? 9 : 0);
}

await runToExit(main);
