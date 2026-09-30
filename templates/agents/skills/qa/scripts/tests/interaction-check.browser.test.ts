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
 * module reads stdin to its end, so it is always closed.
 */
function check(
  pages: string,
  base = `http://127.0.0.1:${PORT}`,
  stdin = "",
): Promise<{ rc: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", MODULE, base, pages], {
      env: { ...process.env, QA_PW_PARENT: dirname(NODE_MODULES ?? "") },
      // A run that never exits is a failure to report, not a suite that hangs:
      // a held form navigation used to wedge the run for good.
      timeout: 120_000,
    });
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
