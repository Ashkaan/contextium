// interaction-check.browser.ts — use each page the way a visitor would, with
// the server held still, and report what does not answer at once.
//
// Two checks per route, both judged on what the page shows BEFORE any reply:
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
//
// HELD MEANS NEVER SENT, and exactly this is held: every non-GET request and
// every fetch/XHR (the route handler neither continues nor fulfils), every
// WebSocket (the constructor is replaced before any page script runs, so no
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
// space-separated>. Env: QA_PW_PARENT (the dir whose node_modules holds the
// Playwright to use). Stdin, optional: one JSON object
// `{"access": {"id": …, "secret": …} | null, "actAs": "<email>", "jwt": "<token>"}`
// — the CF-Access pair, the person the probe acts as, and a local run's Access
// token. They travel on stdin because they are secrets: argv is in every
// process listing, and the environment is inherited by everything the browser
// starts.
// Output: `INTERACTION <route> <kind> <detail>` per finding (kinds:
// blank-while-loading, no-feedback, unpressed, unloadable), `SKIPPED <route>
// "<label>" <reason>` per opt-out, one `interaction: …` summary line.
// Exit 0 clean, 9 findings, 1 a route did not load.
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

async function main(): Promise<void> {
  const require = createRequire(`${process.env.QA_PW_PARENT}/`);
  const { chromium }: typeof import("playwright") = require("playwright");

  const [base = "", pagesArg] = process.argv.slice(2);
  const pages = (pagesArg ?? "").split(/\s+/).filter(Boolean);
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
   *  and never sends. A page that reads over a socket shows its waiting state. */
  const NO_SOCKETS = () => {
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
    Object.assign(HeldSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    Object.defineProperty(window, "WebSocket", { value: HeldSocket, writable: true, configurable: true });
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

  async function newPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders,
      serviceWorkers: "block",
    });
    await ctx.addInitScript(NO_SOCKETS);
    await ctx.addInitScript(HOLD_IN_PAGE);
    const page = await ctx.newPage();
    return { ctx, page };
  }

  // A page that answered 4xx/5xx, or landed on another origin (a sign-in wall),
  // is not the page: its text would pass every check below and stamp a clean
  // run. screenshot.ts's STATUS and OFF-ORIGIN gates refuse the same two cases.
  async function gotoChecked(page: Page, url: string) {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
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

  const firstLine = (err: unknown): string =>
    String(typeof err === "object" && err !== null && "message" in err ? (err.message ?? err) : err)
      .split("\n")[0]
      ?.slice(0, 160) ?? "";

  async function blankWhileLoading(route: string, url: string): Promise<boolean> {
    const { ctx, page } = await newPage();
    try {
      await page.route("**/*", (r: Route) => (isData(r.request()) ? undefined : r.continue()));
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
        const state = await Promise.race([
          frame.evaluate(() => document.readyState).catch(() => "unknown"),
          new Promise<string>((r) => setTimeout(() => r("pending"), 300)),
        ]);
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
      const all = await page.locator(BUTTONS).evaluateAll((els) =>
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
          // shown, the current section — correctly does nothing when pressed
          // again, and its aria state says so; it is listed, not failed.
          const current = el.getAttribute("aria-current");
          const selected =
            el.getAttribute("aria-selected") === "true" ||
            el.getAttribute("aria-pressed") === "true" ||
            (current !== null && current !== "false");
          return {
            shown: shown && !h.disabled && el.getAttribute("aria-disabled") !== "true",
            label: label || "(unlabelled)",
            optOut: el.getAttribute("data-qa-feedback") ?? (selected ? "already the selected option" : null),
          };
        }),
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
          await press.evaluate(() => {
            (window as Window & { __qaHold?: boolean }).__qaHold = true;
          });
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

  async function checkRoute(route: string): Promise<void> {
    const url = new URL(route, base).toString();
    if (await blankWhileLoading(route, url)) await noFeedback(route, url);
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
