// interaction-check.browser.test.ts — interaction-check.browser.ts against the
// committed fixture site (fixtures/interaction-site/) served on a free local
// port: it must flag a click that changes nothing, a click that only disables
// its button, and a page that renders nothing while its data loads, and pass
// the ones that answer at once. It must hold every write: no POST and no
// WebSocket reaches the server. The module is spawned the way
// interaction-check.ts runs it (its own process, QA_PW_PARENT naming the
// Playwright to load), never imported.
//
// Needs a Playwright with an installed chromium (the same one screenshot.ts
// uses); without it every case reports SKIP rather than a pass. A test never
// downloads a browser: QA_NO_INSTALL=1 keeps the first-use install off.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/interaction-check.browser.test.ts
//
// peers:
//   .agents/skills/qa/scripts/interaction-check.browser.ts
//   .agents/skills/qa/scripts/interaction-check.ts
//   .agents/skills/qa/scripts/tests/interaction-check.test.ts

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaPlaywrightNodeModules } from "../lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, "..", "interaction-check.browser.ts");
const SITE = join(HERE, "fixtures", "interaction-site");

process.env.QA_NO_INSTALL = "1";
const NODE_MODULES = qaPlaywrightNodeModules();
const SKIP = NODE_MODULES === undefined ? "no Playwright with an installed chromium" : false;
if (SKIP) process.stdout.write("interaction-check.browser.test.ts: SKIP — no Playwright with an installed chromium\n");

let PORT = 0;
let server: ChildProcess | undefined;
const TMP = mkdtempSync(join(tmpdir(), "interaction-browser-test-"));
const SERVER_LOG = join(TMP, "server.log");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  if (SKIP) return;
  PORT = await freePort();
  // http.server logs every request it receives to stderr, a POST included (it
  // answers 501). The pages POST on every click, so an unheld write shows there.
  const log = openSync(SERVER_LOG, "w");
  server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: SITE,
    stdio: ["ignore", "ignore", log],
  });
  closeSync(log);
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/good/`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(() => {
  server?.kill();
  rmSync(TMP, { recursive: true, force: true });
});

/**
 * Run the module over <pages> against <base> → exit code and combined output.
 * `stdin` is the auth options object interaction-check.ts writes there; the
 * module reads stdin to its end, so it is always closed. `checks` is the
 * module's third argv (`cut-off` runs that check alone); absent, all run.
 */
function check(
  pages: string,
  base = `http://127.0.0.1:${PORT}`,
  stdin = "",
  checks?: string,
): Promise<{ rc: number | null; out: string }> {
  return new Promise((res) => {
    const argv = ["--experimental-strip-types", MODULE, base, pages, ...(checks === undefined ? [] : [checks])];
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, QA_PW_PARENT: dirname(NODE_MODULES ?? "") },
      // A run that never exits is a failure to report, not a suite that hangs:
      // a held form navigation used to wedge the run for good.
      timeout: 120_000,
    });
    // EPIPE from a child that exits without reading is reported by its exit code.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (rc) => res({ rc, out }));
  });
}
const serverLog = () => readFileSync(SERVER_LOG, "utf8");

describe("interaction-check.browser.ts", { skip: SKIP, concurrency: 4 }, () => {
  // Answers at the click: the label changes before any server reply.
  test("a click that answers at once passes: exit 0 and the summary line", async () => {
    const r = await check("/good/");
    assert.equal(r.rc, 0, r.out);
    assert.match(
      r.out,
      /^interaction: 1 route\(s\), pressed 1 of 1 button\(s\) \(cap 25 per route\), 0 finding\(s\), 0 skipped$/m,
    );
  });
  // Sends the request and changes nothing until the server answers.
  test("a click that changes nothing until the server answers is a finding naming the route", async () => {
    const r = await check("/silent/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/silent\/ no-feedback "Save" changed nothing on screen within 150 ms/);
  });
  // Greys the button out and nothing else — not feedback: a visitor reads it as broken.
  test("a click that only disables its button is a finding", async () =>
    assert.equal((await check("/disables/")).rc, 9));
  // Renders nothing at all until its data arrives.
  test("a page that renders nothing while its data loads is a finding naming the route", async () => {
    const r = await check("/blank/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/blank\/ blank-while-loading/);
  });
  // Shows a loading state while the same data is on its way.
  test("a page that shows a loading state passes", async () => assert.equal((await check("/loading/")).rc, 0));

  test("a press that the page remembers (localStorage) does not change the page the next press loads", async () => {
    const r = await check("/remembers/");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /pressed 3 of 3 button\(s\)/);
  });

  test("a button inside a closed <details> is not counted: a visitor cannot see it", async () => {
    const r = await check("/collapsed/");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /pressed 1 of 1 button\(s\)/);
  });
  // A delete behind a confirm: the dialog IS the feedback (reviewer false positive).
  test("a confirm dialog counts as feedback", async () => assert.equal((await check("/confirm/")).rc, 0));
  // A theme toggle changes <html>, not <body> (reviewer false positive).
  test("a theme toggle on <html> counts as feedback", async () => assert.equal((await check("/theme/")).rc, 0));
  // Sets an attribute on hover and saves silently: the hover is not feedback.
  test("an attribute the hover set is not feedback", async () => assert.equal((await check("/hoverattr/")).rc, 9));
  // Only fades the button: a class change alone is not feedback.
  test("a button that only fades is not feedback", async () => assert.equal((await check("/greys/")).rc, 9));
  // A fixed overlay covers the only button, so it can never be pressed.
  test("a button no click can reach is an unpressed finding, not a silent pass", async () => {
    const r = await check("/overlay/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/overlay\/ unpressed/);
  });
  // An open modal dialog marks the page behind it aria-hidden and covers it (the
  // fixture is Radix's shape: role="dialog" with no aria-modal): a
  // button there is out of every visitor's reach by design, not a defect — one
  // app's drawer opened from a link reported 17 such buttons as unpressed. Listed with the reason; the dialog's
  // own button is still pressed.
  test("a button behind an open modal dialog is listed, not failed; the dialog's are pressed", async (t) => {
    const r = await check("/modal/");
    await t.test("exit 0", () => assert.equal(r.rc, 0, r.out));
    await t.test("lists the hidden button", () =>
      assert.ok(
        r.out.includes(
          'SKIPPED /modal/ "Behind" hidden from every visitor (aria-hidden or inert), as behind an open dialog',
        ),
        r.out,
      ),
    );
    await t.test("presses the dialog's", () => assert.match(r.out, /pressed 1 of 1 button/));
  });
  // aria-hidden alone hides a button from a screen reader, not from a mouse:
  // with no modal open it is pressed and judged like any other.
  test("an aria-hidden button with no modal open is still pressed and judged", async () => {
    const r = await check("/ariahidden/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/ariahidden\/ no-feedback "Save"/);
  });
  // A non-modal <dialog> opened with show(), or a dialog styled invisible,
  // hides nothing: an aria-hidden button beside them is still judged.
  test("a non-modal or invisible dialog does not exempt an aria-hidden button", async () => {
    const r = await check("/notmodal/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/notmodal\/ no-feedback "Save"/);
  });
  // The embedded-widget shape: a heading, and a large iframe that has not loaded.
  // 192.0.2.1 is TEST-NET-1, reserved and unroutable, so the frame never arrives.
  test("a large iframe still loading is blank while loading", async () => {
    const r = await check("/iframe/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/iframe\/ blank-while-loading an iframe/);
  });
  // A control whose response is off screen, declared as such.
  test("an opted-out control is listed with its reason, not failed", async () => {
    const r = await check("/optout/");
    assert.equal(r.rc, 0, r.out);
    assert.ok(r.out.includes('SKIPPED /optout/ "Copy" copies to the clipboard'), r.out);
  });
  test("a route that does not load fails the run: exit 1", async () => {
    const r = await check("/", "http://127.0.0.1:1");
    assert.equal(r.rc, 1, r.out);
    assert.match(r.out, /INTERACTION \/ unloadable/);
  });
  // Writes over a WebSocket, which page.route cannot see.
  test("a WebSocket write never connects", async () => {
    await check("/socket/");
    assert.equal(serverLog().includes('"GET /ws'), false, "the socket reached the server");
  });
  // A dev server's hot-reload socket carries no app data, and Next's dev
  // client never starts the page without it: it passes, while the
  // app's own socket on the same page is still held.
  test("a dev server's hot-reload socket connects; the app's own socket does not", async () => {
    const r = await check("/devreload/");
    assert.equal(r.rc, 0, r.out);
    assert.equal(serverLog().includes('"GET /ws-app'), false, "the app socket reached the server");
  });
  // `next dev` draws its own tools button into the page; it is the dev
  // server's, not the app's, and a production build has none.
  test("the Next dev server's tools button is listed, not failed; the page's own is pressed", async (t) => {
    const r = await check("/devtools/");
    await t.test("exit 0", () => assert.equal(r.rc, 0, r.out));
    await t.test("lists the dev tools button", () =>
      assert.match(r.out, /SKIPPED \/devtools\/ "Open Next\.js Dev Tools" the dev server's own tools/),
    );
    await t.test("presses the page's", () => assert.match(r.out, /pressed 1 of 1 button/));
  });
  // A page that moves to another origin a moment after it loads (a script
  // redirect to a sign-in page) is unloadable too — checked after it settles.
  test("a late redirect off-origin is unloadable, and says where it went", async () => {
    const r = await check("/late/");
    assert.equal(r.rc, 1, r.out);
    assert.match(r.out, /off-origin/);
  });
  // A route that answers 404 is unloadable (exit 1), never a clean page: its
  // text would otherwise pass every check.
  // An app whose buttons render a second after load, once the network is quiet:
  // counted too early, none is pressed.
  test("buttons that render after the network is quiet are still counted and pressed", async () => {
    const r = await check("/lateui/");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /pressed 2 of 2 button/);
  });
  // A segmented filter whose selected option is already pressed: pressing it
  // again correctly changes nothing, and its aria state says so. The other
  // option works.
  test("the option already selected is listed, not failed; the others are pressed", async (t) => {
    const r = await check("/selected/");
    await t.test("exit 0", () => assert.equal(r.rc, 0, r.out));
    await t.test("lists the pressed option", () =>
      assert.ok(r.out.includes('SKIPPED /selected/ "All" already the selected option'), r.out),
    );
    await t.test("lists the selected tab", () =>
      assert.ok(r.out.includes('SKIPPED /selected/ "Only tab" already the selected option'), r.out),
    );
    // A radio already checked (a drawer's touch-kind picker, say).
    await t.test("lists the checked radio", () =>
      assert.ok(r.out.includes('SKIPPED /selected/ "Call" already the selected option'), r.out),
    );
  });
  // An editor that saves on its way out, whose unload-time saves would reach
  // production between the check's presses and rewrite a real record. A press
  // dirties it; leaving must send nothing.
  test("a page that saves on its way out sends nothing between presses", async () => {
    const r = await check("/unloadsave/");
    assert.equal(r.rc, 0, r.out);
    const sent = serverLog().match(/"POST \/api\/unload-[a-z]+/g) ?? [];
    assert.deepEqual(sent, [], `an unload-time save reached the server: ${sent.join(" ")}`);
  });
  // A form that POSTs as a page navigation, labelling itself at the click (an
  // unsubscribe button is the common case). The check holds that POST, and it
  // used to hang for good afterwards.
  test("a form that POSTs as a navigation finishes, and its button was pressed", async (t) => {
    const r = await check("/formpost/");
    await t.test("exits 0 (a held form navigation does not hang the run)", () => assert.equal(r.rc, 0, r.out));
    await t.test("the button was pressed", () => assert.match(r.out, /pressed 1 of 1/));
  });
  test("a 404 route is unloadable, not clean, and names the status", async () => {
    const r = await check("/no-such-page.html");
    assert.equal(r.rc, 1, r.out);
    assert.match(r.out, /HTTP 404/);
  });
  // ── cut-off: at 390×844 every item in a clipping box is scrolled into view the
  // way a visitor could, and what still cannot be seen is reported, one line per
  // box. A capped list can hide half its rows on a phone this way, and no
  // screenshot shows it. ──
  const cutOffLines = (out: string) => out.split("\n").filter((l) => / cut-off /.test(l));
  const ROW8 = (route: string) =>
    `INTERACTION ${route} cut-off div.box shows 7, hides 13 below its edge (first hidden "Row 8")`;
  // A 290-px overflow:hidden box of twenty 40-px rows: row 8's centre is at 300 px.
  test("a box that hides rows no scroll can reach is one cut-off line naming it", async () => {
    const r = await check("/cutoff/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutoff/")]);
  });
  test("two such boxes are two lines, one per box", async () => {
    const r = await check("/cutofftwo/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      ROW8("/cutofftwo/"),
      'INTERACTION /cutofftwo/ cut-off div.box2 shows 7, hides 13 below its edge (first hidden "Item 8")',
    ]);
  });
  // Behind an open dialog (Radix hides the page and locks its scroll) nothing is a
  // visitor's to scroll, so only the dialog's own boxes count — as the covered
  // check reads only the dialog (a modal drawer once reported the whole board
  // behind it as cut off).
  test("behind an open dialog only the dialog's boxes are scanned", async () => {
    const r = await check("/cutoffmodal/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutoffmodal/")]);
  });
  // Rows added after load: the scan waits for the page to settle.
  test("rows that arrive after load are still scanned", async () => {
    const r = await check("/cutofflate/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutofflate/")]);
  });
  // Visibility is geometric, not what a tap would hit.
  test("rows with pointer-events: none are judged by where they are", async () => {
    const r = await check("/cutoffpointer/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutoffpointer/")]);
  });
  // One 800-px row whose centre (400 px) lies past the 290-px edge.
  test("a single row taller than its box, centred past the edge, is hidden", async () => {
    const r = await check("/cutofftall/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutofftall/ cut-off div.box shows 0, hides 1 below its edge (first hidden "Tall row")',
    ]);
  });
  // A fixed element inside the box is not clipped by it, so it is not one of its items.
  test("a fixed element inside a box is not counted against it", async () => {
    const r = await check("/cutofffixed/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutofffixed/")]);
  });
  // body { overflow: hidden }: the page itself cannot be scrolled by a finger.
  test("a page whose body forbids scrolling hides everything below the screen", async () => {
    const r = await check("/cutoffpage/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffpage/ cut-off body shows 21, hides 29 below its edge (first hidden "Row 22")',
    ]);
  });
  // body { overflow-x: hidden; height: 100% } hands its overflow to the screen,
  // which scrolls: the body's own short box is not a clip, so the box 1000 px
  // down is judged exactly as at the top.
  test("a body that only hides sideways overflow does not clip what the page scrolls to", async () => {
    const r = await check("/cutoffbodyx/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutoffbodyx/")]);
  });
  // html { overflow: auto } keeps the screen's scroll on <html>; the body is
  // then an ordinary box, 100vh tall and hidden, and is scanned like one.
  test("a body that clips while <html> holds the scroll is scanned as a box", async () => {
    const r = await check("/cutoffbodybox/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffbodybox/ cut-off body shows 21, hides 29 below its edge (first hidden "Row 22")',
    ]);
  });
  // A transform makes the box the fixed element's containing block, so the box
  // clips it — and so does an individual translate, rotate or scale.
  // content-visibility: auto applies layout containment, which holds fixed children too.
  for (const route of ["/cutofffixedtransform/", "/cutofffixedtranslate/", "/cutofffixedcv/"]) {
    test(`a fixed element inside a transformed box is clipped by it and counted (${route})`, async () => {
      const r = await check(route);
      assert.equal(r.rc, 9, r.out);
      assert.deepEqual(cutOffLines(r.out), [
        `INTERACTION ${route} cut-off div.box shows 7, hides 14 below its edge (first hidden "Row 8")`,
      ]);
    });
  }
  // A slide waiting off to the left, as a carousel's do: only the vertical is
  // judged, so its five rows count as shown and the line is the rows' alone.
  test("a carousel slide off to the side is not counted as cut off", async () => {
    const r = await check("/cutoffcarousel/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffcarousel/ cut-off div.box shows 12, hides 13 below its edge (first hidden "Row 8")',
    ]);
  });
  // An 800-px scroller shifted 100 px up under a 290-px clip: rows 3–20 are seen
  // only by scrolling them into the visible band (no alignment to the scroller
  // shows them), and rows 1–2 sit above the clip with the scroller at its top.
  test("rows reachable only between a scroller's alignments are found; rows above the clip are not", async () => {
    const r = await check("/cutoffshifted/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffshifted/ cut-off div.box shows 18, hides 2 below its edge (first hidden "Row 1")',
    ]);
  });
  // A clipping box scaled to half size on screen: its edge is measured where it
  // is drawn, so rows 8–10 (their centres past 145 px) are hidden.
  test("a clipping box scaled by a transform is measured on screen", async () => {
    const r = await check("/cutoffscaled/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffscaled/ cut-off div.box shows 7, hides 3 below its edge (first hidden "Row 8")',
    ]);
  });
  // An accordion folded shut inside an overflowing box hides its answers on
  // purpose: they are not judged, and the box's line is its rows' alone.
  test("rows inside a closed panel within a box are not counted against it", async () => {
    const r = await check("/cutoffaccordion/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutoffaccordion/")]);
  });
  // The shifted scroller drawn at 20%: the correction scroll is converted into the
  // scroller's own pixels, so the same 18 rows are reached as at full size.
  test("a scaled, shifted scroller reaches the same rows as at full size", async () => {
    const r = await check("/cutoffscaledshift/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffscaledshift/ cut-off div.box shows 18, hides 2 below its edge (first hidden "Row 1")',
    ]);
  });
  // overflow: clip with overflow-clip-margin: 60px paints 60 px past the edge:
  // nine rows show (Chromium's own hit test agrees), not seven.
  test("overflow-clip-margin widens a clip box's edge", async () => {
    const r = await check("/cutoffclipmargin/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffclipmargin/ cut-off div.box shows 9, hides 11 below its edge (first hidden "Row 10")',
    ]);
  });
  // A transformed <html> holds its fixed children, so with the page unable to
  // scroll one placed below the screen is cut off.
  test("a fixed element held by a transformed <html> below an unscrollable screen is hidden", async () => {
    const r = await check("/cutoffhtmlfixed/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffhtmlfixed/ cut-off html shows 0, hides 1 below its edge (first hidden "Fixed below")',
    ]);
  });
  // overflow-clip-margin: content-box clips at the content edge, inside the
  // 40-px padding: five rows paint (Chromium's own hit test agrees), not six.
  test("overflow-clip-margin's content-box keyword moves the edge inside the padding", async () => {
    const r = await check("/cutoffclipcontent/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffclipcontent/ cut-off div.box shows 5, hides 15 below its edge (first hidden "Row 6")',
    ]);
  });
  // An embedded frame that saves on its way out sends nothing either: the hold
  // is armed in every frame, not only the top one.
  test("checks=cut-off sends no write from an embedded frame on the way out", async () => {
    const r = await check("/framesave/", undefined, "", "cut-off");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/framesave/")]);
    assert.match(serverLog(), /"GET \/framesave\/child\.html/, "the frame never loaded");
    const sent = serverLog().match(/"POST \/api\/frame-save-[a-z]+/g) ?? [];
    assert.deepEqual(sent, [], `a frame's write reached the server: ${sent.join(" ")}`);
  });
  // Overflow is cut at the padding edge: a row under the box's 40-px bottom
  // border is not seen, though it lies inside the box's outer edge.
  test("a row under a clipping box's border is hidden", async () => {
    const r = await check("/cutoffborder/");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [
      'INTERACTION /cutoffborder/ cut-off div.box shows 6, hides 14 below its edge (first hidden "Row 7")',
    ]);
  });
  // The read-only run may point at a deployed site: a page that saves on load
  // and on its way out sends nothing.
  test("checks=cut-off sends no write, on load or on the way out", async () => {
    const r = await check("/cutoffsave/", undefined, "", "cut-off");
    assert.equal(r.rc, 9, r.out);
    const sent = serverLog().match(/"POST \/api\/cutoff-save-[a-z]+/g) ?? [];
    assert.deepEqual(sent, [], `a write reached the server: ${sent.join(" ")}`);
  });
  for (const [route, why] of [
    // An 800-px scroller inside a 290-px clip: centred, a row lands past the
    // edge, but scrolled to the scroller's top it shows.
    ["/cutoffdeep/", "a row centred past the edge shows when scrolled to the top of its scroller"],
    ["/cutoffscrolls/", "the box scrolls, so every row can be reached"],
    // body { contain: layout } keeps its overflow from passing to the screen, which scrolls.
    ["/cutoffbodycontain/", "a contained body's overflow does not pass to the screen"],
    // html { overflow-x: clip } keeps the screen's overflow on <html>, which scrolls:
    // body { overflow: hidden } there is an ordinary element and forbids nothing.
    ["/cutoffhtmlclip/", "html clips sideways, so the body hides nothing and the page scrolls"],
    // A deck's waiting slide: nothing in it can be seen, so nothing in it is cut off.
    ["/cutoffinvisible/", "the box sits inside an element with opacity 0"],
    ["/cutoffnested/", "an inner scroller inside the clipping box reaches every row"],
    ["/cutoffcollapsed/", "a closed panel is under 40 px"],
    ["/cutoffsmall/", "a 39-px box is under 40 px"],
    ["/cutoffclamp/", "a clamped paragraph is the box and holds no item"],
    ["/cutoffone/", "one row whose centre is inside the box"],
    ["/cutoffsmooth/", "smooth scrolling is overridden, so nothing is judged mid-scroll"],
    ["/cutoffpointerscrolls/", "pointer-events: none rows in a box that scrolls"],
  ]) {
    test(`no cut-off when ${why} (${route})`, async () => {
      const r = await check(route);
      assert.deepEqual(cutOffLines(r.out), [], r.out);
      assert.equal(r.rc, 0, r.out);
    });
  }
  // The read-only mode: this check alone, nothing pressed.
  test("checks=cut-off presses nothing: a silent button is no finding, pressed 0 of 0", async () => {
    const r = await check("/silent/", undefined, "", "cut-off");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /pressed 0 of 0 button\(s\)/);
  });
  test("checks=cut-off still reports a cut-off box", async () => {
    const r = await check("/cutoff/", undefined, "", "cut-off");
    assert.equal(r.rc, 9, r.out);
    assert.deepEqual(cutOffLines(r.out), [ROW8("/cutoff/")]);
    assert.match(r.out, /pressed 0 of 0 button\(s\)/);
  });
  test("checks=cut-off on a route that does not load is unloadable: exit 1", async () => {
    const r = await check("/no-such-page.html", undefined, "", "cut-off");
    assert.equal(r.rc, 1, r.out);
    assert.match(r.out, /INTERACTION \/no-such-page\.html unloadable HTTP 404/);
  });
  test("an unknown checks value → 2, naming cut-off", async () => {
    const r = await check("/good/", undefined, "", "bogus");
    assert.equal(r.rc, 2, r.out);
    assert.match(r.out, /cut-off/);
  });
  // Two links stacked with no room between: under a touch pointer the lower one's
  // enlarged hit area lies over the upper one's text.
  test("a control under a neighbour's enlarged hit area on a touchscreen is a covered finding", async () => {
    const r = await check("/covered/");
    assert.equal(r.rc, 9, r.out);
    assert.match(
      r.out,
      /INTERACTION \/covered\/ covered "Project title" is under "EXAMPLE-001"'s hit area at 390 px with a touch pointer/,
    );
  });

  test("the same links with room between their hit areas pass", async () =>
    assert.equal((await check("/spaced/")).rc, 0));

  // A dialog laid out but hidden is not open: the page is still read whole.
  test("a hidden dialog does not narrow the covered check to itself", async () => {
    const r = await check("/coveredhidden/");
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/coveredhidden\/ covered "Project title" is under "EXAMPLE-001"'s hit area/);
  });

  // A field in a hidden panel keeps a laid-out box no visitor can see or tap: it is not
  // covered by the button over it (a settings panel's collapsed Edit details).
  test("a control nobody can see is not read as covered", async () =>
    assert.equal((await check("/coveredclosed/")).rc, 0));

  test("several routes in one run: findings sorted, one summary", async () => {
    const r = await check("/silent/ /good/ /blank/");
    assert.equal(r.rc, 9, r.out);
    const lines = r.out.split("\n").filter((l) => l.startsWith("INTERACTION "));
    assert.deepEqual(lines, [...lines].sort());
    assert.match(r.out, /^interaction: 3 route\(s\), /m);
  });
});

// ── the auth options on stdin become request headers ──
describe("CF-Access + act-as from stdin", { skip: SKIP }, () => {
  let http: Server | undefined;
  let seen: IncomingHttpHeaders[] = [];
  let port = 0;
  before(async () => {
    http = createHttpServer((q, r) => {
      seen.push(q.headers);
      r.writeHead(200, { "content-type": "text/html" });
      r.end("<!doctype html><h1>Hi</h1><button onclick=\"this.textContent='Saving…'\">Save</button>");
    });
    await new Promise<void>((res) => http?.listen(0, "127.0.0.1", () => res()));
    const a = http.address();
    port = typeof a === "object" && a !== null ? a.port : 0;
  });
  after(() => http?.close());
  test("the pair and the act-as person on stdin are sent on every request", async () => {
    seen = [];
    const r = await check(
      "/",
      `http://127.0.0.1:${port}`,
      JSON.stringify({ access: { id: "ID-9", secret: "SECRET-9" }, actAs: "someone@example.com" }),
    );
    assert.equal(r.rc, 0, r.out);
    assert.ok(seen.length > 0);
    for (const h of seen) {
      assert.equal(h["cf-access-client-id"], "ID-9");
      assert.equal(h["cf-access-client-secret"], "SECRET-9");
      assert.equal(h["x-portal-act-as"], "someone@example.com");
    }
  });
  test("a local Access token on stdin is sent as Cf-Access-Jwt-Assertion on every request", async () => {
    seen = [];
    const r = await check(
      "/",
      `http://127.0.0.1:${port}`,
      JSON.stringify({ access: null, actAs: "", jwt: "LOCAL.JWT.9" }),
    );
    assert.equal(r.rc, 0, r.out);
    assert.ok(seen.length > 0);
    for (const h of seen) {
      assert.equal(h["cf-access-jwt-assertion"], "LOCAL.JWT.9");
      assert.equal(h["cf-access-client-id"], undefined);
    }
  });
  test("no stdin options → no auth headers", async () => {
    seen = [];
    const r = await check("/", `http://127.0.0.1:${port}`);
    assert.equal(r.rc, 0, r.out);
    assert.ok(seen.length > 0 && seen.every((h) => h["cf-access-client-id"] === undefined));
  });
});

// Read after every case above ran: the pages POST on every click.
describe("no write the check holds ever reaches the server", { skip: SKIP }, () => {
  test("no POST reached the server", () =>
    assert.equal(serverLog().includes('"POST '), false, `a held POST reached the server:\n${serverLog()}`));
  test("the log is being read (the page GETs are in it)", () => assert.match(serverLog(), /"GET \/good\//));
});
