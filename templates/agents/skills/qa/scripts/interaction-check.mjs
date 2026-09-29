// interaction-check.mjs — use each page the way a visitor would, with the
// server held still, and report what does not answer at once.
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
// what they fetch). NOT held: GET navigations and GET page resources, which
// are reads by contract. Pressing Delete here deletes nothing.
//
// An element marked `data-qa-feedback="<reason>"` is skipped and listed, for
// the rare control whose correct response is off screen; the reason is the
// reviewer's to accept.
//
// Why: a form that sits blank for seconds while its data loads, and a button
// that gives no sign it was pressed, both pass a screenshot review — the
// screenshots show only the settled page.
//
// Run by interaction-check.sh. Argv: <base-url> <pages, space-separated>.
// Output: `INTERACTION <route> <kind> <detail>` per finding (kinds:
// blank-while-loading, no-feedback, unpressed, unloadable), `SKIPPED <route>
// "<label>" <reason>` per opt-out, one `interaction: …` summary line.
// Exit 0 clean, 9 findings, 1 a route did not load.
//
// peers:
//   .agents/skills/qa/scripts/interaction-check.sh
//   .agents/skills/qa/scripts/tests/interaction-check.test.sh

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(`${process.env.QA_PW_PARENT}/`);
const { chromium } = require("playwright");

const [base, pagesArg] = process.argv.slice(2);
const pages = (pagesArg ?? "").split(/\s+/).filter(Boolean);
const BLANK_AFTER_MS = 1000;
const FEEDBACK_MS = 150;
const HOVER_SETTLE_MS = 60;
const QUIET_CAP_MS = 2000;
const MAX_BUTTONS = 25;
const ROUTE_POOL = 4;
const NAV_TIMEOUT_MS = 30_000;
const BUTTONS = "button, [role=button], input[type=submit], input[type=button]";

const cfId = process.env.QA_CF_ACCESS_ID || "";
const cfSecret = process.env.QA_CF_ACCESS_SECRET || "";
const extraHTTPHeaders =
  cfId && cfSecret ? { "CF-Access-Client-Id": cfId, "CF-Access-Client-Secret": cfSecret } : undefined;

const isData = (req) => ["fetch", "xhr"].includes(req.resourceType());

/** Replaces WebSocket before any page script runs: a socket that never opens
 *  and never sends. A page that reads over a socket shows its waiting state. */
const NO_SOCKETS = () => {
  class HeldSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
    }
    send() {}
    close() {}
  }
  Object.assign(HeldSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = HeldSocket;
};

/** What a visitor can see: the text, the set of visible elements and where they
 *  are, the <html> element's attributes, and every ARIA state. Classes and
 *  inline styles are left out on purpose, so a button that only greys out or
 *  fades reads as unchanged. */
const pageState = () => {
  const boxes = [];
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

const browser = await chromium.launch();
const findings = [];
const skipped = [];
let pressed = 0;
let candidates = 0;
let unloadable = 0;

async function newPage() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders,
    serviceWorkers: "block",
  });
  await ctx.addInitScript(NO_SOCKETS);
  const page = await ctx.newPage();
  return { ctx, page };
}

const firstLine = (err) =>
  String(err?.message ?? err)
    .split("\n")[0]
    .slice(0, 160);

async function blankWhileLoading(route, url) {
  const { ctx, page } = await newPage();
  try {
    await page.route("**/*", (r) => (isData(r.request()) ? undefined : r.continue()));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(BLANK_AFTER_MS);
    const shown = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const region = document.querySelector("main") ?? document.body;
      const text = (region?.innerText ?? "").trim().length;
      const marks = [
        ...(region?.querySelectorAll("img, svg, canvas, video, [role=progressbar], [aria-busy=true], progress") ?? []),
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
    const loaded = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const state = await Promise.race([
        frame.evaluate(() => document.readyState).catch(() => "unknown"),
        new Promise((r) => setTimeout(() => r("pending"), 300)),
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

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: QUIET_CAP_MS }).catch(() => {});
}

async function noFeedback(route, url) {
  const { ctx, page } = await newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await settle(page);
    const all = await page.locator(BUTTONS).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const shown = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60);
        return {
          shown: shown && !el.disabled && el.getAttribute("aria-disabled") !== "true",
          label: label || "(unlabelled)",
          optOut: el.getAttribute("data-qa-feedback"),
        };
      }),
    );
    const eligible = [];
    all.forEach((b, index) => {
      if (!b.shown) return;
      if (b.optOut) skipped.push(`SKIPPED ${route} "${b.label}" ${b.optOut}`);
      else eligible.push({ ...b, index });
    });
    candidates += eligible.length;
    if (eligible.length > MAX_BUTTONS) {
      skipped.push(`SKIPPED ${route} ${eligible.length - MAX_BUTTONS} button(s) past the cap of ${MAX_BUTTONS}`);
    }

    // One page per route, reloaded between presses with its holds taken down.
    const hold = (r) => {
      const req = r.request();
      if (req.method() !== "GET" || isData(req)) return; // held: never sent
      return r.continue();
    };
    let dialogOpened = false;
    let navigated = false;
    page.on("dialog", (d) => {
      dialogOpened = true;
      d.dismiss().catch(() => {});
    });
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigated = true;
    });

    for (const { label, index } of eligible.slice(0, MAX_BUTTONS)) {
      try {
        await page.unroute("**/*", hold).catch(() => {});
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await settle(page);
        const button = page.locator(BUTTONS).nth(index);
        await button.hover({ timeout: 2_000 });
        await page.waitForTimeout(HOVER_SETTLE_MS);
        await page.route("**/*", hold);
        const before = await page.evaluate(pageState);
        dialogOpened = false;
        navigated = false;
        await button.click({ timeout: 2_000, noWaitAfter: true });
        pressed++;
        await page.waitForTimeout(FEEDBACK_MS);
        if (dialogOpened || navigated) continue;
        const after = await page.evaluate(pageState).catch(() => null);
        if (after !== null && after === before) {
          findings.push(
            `INTERACTION ${route} no-feedback "${label}" changed nothing on screen within ${FEEDBACK_MS} ms of the click`,
          );
        }
      } catch (err) {
        findings.push(`INTERACTION ${route} unpressed "${label}" ${firstLine(err)}`);
      }
    }
  } catch (err) {
    unloadable++;
    findings.push(`INTERACTION ${route} unloadable ${firstLine(err)}`);
  } finally {
    await ctx.close();
  }
}

async function checkRoute(route) {
  const url = new URL(route, base).toString();
  if (await blankWhileLoading(route, url)) await noFeedback(route, url);
}

// Four routes at a time; each route's own presses stay in order on one page.
const queue = [...pages];
await Promise.all(
  Array.from({ length: Math.min(ROUTE_POOL, queue.length) }, async () => {
    for (let route = queue.shift(); route !== undefined; route = queue.shift()) await checkRoute(route);
  }),
);

await browser.close();
findings.sort();
for (const f of findings) process.stdout.write(`${f}\n`);
for (const s of skipped) process.stdout.write(`${s}\n`);
process.stdout.write(
  `interaction: ${pages.length} route(s), pressed ${pressed} of ${candidates} button(s) (cap ${MAX_BUTTONS} per route), ${findings.length} finding(s), ${skipped.length} skipped\n`,
);
process.exit(unloadable > 0 ? 1 : findings.length > 0 ? 9 : 0);
