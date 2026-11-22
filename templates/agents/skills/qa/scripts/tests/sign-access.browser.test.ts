// sign-access.browser.test.ts — qaSignAccess (lib.ts) in a real Chromium: the
// Access headers reach every request to the site under test, each hop of a
// redirect judged on its own, and no request to any other origin. Two local
// servers stand in for the site (127.0.0.1) and a CDN (localhost, another
// origin). The site behaves as Cloudflare Access does: it answers 401 to a
// request with neither the headers nor its CF_Authorization cookie, and sets
// that cookie on every request the headers got through.
//
// Needs a Playwright with an installed chromium (the same one screenshot.ts
// uses); without it every case reports SKIP rather than a pass.
//
// Run: node --experimental-strip-types .agents/skills/run.ts qa/scripts/tests/sign-access.browser.test.ts
//
// peers:
//   .agents/skills/qa/scripts/lib.ts (qaSignAccess, qaSignedHeaders)
//   .agents/skills/qa/scripts/tests/interaction-check.browser.test.ts (the same, through a QA script)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, Route } from "playwright";
import { qaPlaywrightNodeModules, qaSignAccess } from "../lib.ts";

const NODE_MODULES = qaPlaywrightNodeModules();
const SKIP = NODE_MODULES === undefined ? "no Playwright with an installed chromium" : false;
if (SKIP) process.stdout.write("sign-access.browser.test.ts: SKIP — no Playwright with an installed chromium\n");

const ACCESS = { "CF-Access-Client-Id": "ID-9", "CF-Access-Client-Secret": "SECRET-9" };

// The least of a WebSocket server: accept the handshake, picking "live.v2"
// when it is offered and the first subprotocol otherwise (a server may prefer a
// later offer), answer each short text frame with `${tag}:${text}`, and a
// close with a close. `chose` records the subprotocol it picked.
function acceptSocket(q: IncomingMessage, sock: Duplex, tag: string, ended: string[], chose: string[] = []): void {
  const accept = createHash("sha1")
    .update(`${q.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const offered = String(q.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const proto = offered.includes("live.v2") ? "live.v2" : (offered[0] ?? "");
  chose.push(proto);
  sock.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
      (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : "") +
      "\r\n",
  );
  sock.on("data", (d: Buffer) => {
    // A close frame is answered with one and the connection ended, as a server does.
    if ((d[0] & 0x0f) === 8) {
      sock.end(Buffer.from([0x88, 0]));
      return;
    }
    if ((d[0] & 0x0f) !== 1) return; // a ping or anything else: nothing to echo
    const len = d[1] & 0x7f;
    const mask = d.subarray(2, 6);
    const text = Buffer.from(d.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
    const out = Buffer.from(`${tag}:${text}`);
    sock.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
  });
  sock.on("close", () => ended.push(`${tag} ${q.url}`));
  sock.on("error", () => {});
}

describe("qaSignAccess in Chromium", { skip: SKIP }, () => {
  let browser: Browser | undefined;
  let site: Server | undefined;
  let cdn: Server | undefined;
  let sitePort = 0;
  let cdnPort = 0;
  // Every request each server saw: "METHOD path", its headers.
  let siteSeen: [string, IncomingHttpHeaders][] = [];
  let cdnSeen: [string, IncomingHttpHeaders][] = [];
  const socketsEnded: string[] = [];
  let siteChose: string[] = [];
  const portOf = (s: Server): number => {
    const a = s.address();
    return typeof a === "object" && a !== null ? a.port : 0;
  };
  const listen = (s: Server) => new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));

  before(async () => {
    const { chromium } = createRequire(`${dirname(NODE_MODULES ?? "")}/`)("playwright") as typeof import("playwright");
    browser = await chromium.launch();
    cdn = createServer((q, r) => {
      cdnSeen.push([`${q.method} ${q.url}`, q.headers]);
      // Off the site and back on it: the hop that returns must be signed again.
      if (q.url === "/bounce.css") {
        r.writeHead(302, { location: `http://127.0.0.1:${sitePort}/landed.css` });
        return r.end();
      }
      r.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "*" });
      r.end("h1{color:#111}");
    });
    cdn.on("upgrade", (q, sock) => {
      cdnSeen.push([`UPGRADE ${q.url}`, q.headers]);
      acceptSocket(q, sock, "cdn", socketsEnded);
    });
    await listen(cdn);
    cdnPort = portOf(cdn);
    site = createServer((q, r) => {
      siteSeen.push([`${q.method} ${q.url}`, q.headers]);
      if (q.headers["cf-access-client-id"] !== "ID-9" || q.headers["cf-access-client-secret"] !== "SECRET-9") {
        r.writeHead(401);
        return r.end();
      }
      r.appendHeader("set-cookie", "CF_Authorization=jwt-9; Path=/; HttpOnly");
      const to = (location: string, status = 302) => {
        r.writeHead(status, { location });
        r.end();
      };
      if (q.url === "/start") return to("/");
      if (q.url === "/home.css") return to("/there.css");
      if (q.url === "/leaves.css") return to("/mid.css");
      if (q.url === "/mid.css") return to(`http://localhost:${cdnPort}/z.css`);
      if (q.url === "/round.css") return to(`http://localhost:${cdnPort}/bounce.css`);
      // A write answered with a redirect to a page that needs the headers too.
      if (q.method === "POST" && q.url === "/save") return to("/saved", 303);
      // A page that opens a socket to the site (asking for a subprotocol, as the
      // an app's live updates might) and one to the other origin.
      if (q.url === "/sockets") {
        // tok is scoped to the socket's path; the browser sends it on that socket only.
        r.appendHeader("set-cookie", ["sid=s1; Path=/", "tok=t1; Path=/live"]);
        r.writeHead(200, { "content-type": "text/html" });
        return r.end(
          `<!doctype html><script>
            const got = (window.got = []);
            const events = (window.events = []);
            const open = (url, protos) => { const w = new WebSocket(url, protos); w.onopen = () => { events.push("open " + new URL(url).pathname); w.send("hi"); }; w.onmessage = (e) => got.push(e.data + "/" + w.protocol); w.onclose = () => events.push("closed " + new URL(url).pathname); return w; };
            window.own = open("ws://127.0.0.1:${sitePort}/live", ["live.v1", "live.v2"]);
            open("ws://localhost:${cdnPort}/chat", []);
            open("ws://127.0.0.1:${sitePort}/refused", []);
          </script>`,
        );
      }
      if (q.url?.endsWith(".css")) {
        r.writeHead(200, { "content-type": "text/css" });
        return r.end("h1{margin:0}");
      }
      r.appendHeader("set-cookie", "sid=s1; Path=/");
      r.writeHead(200, { "content-type": "text/html" });
      r.end(
        `<!doctype html><h1>${q.url}</h1>` +
          `<link rel="stylesheet" href="http://localhost:${cdnPort}/font.css" crossorigin>` +
          ["/home.css", "/leaves.css", "/round.css"].map((h) => `<link rel="stylesheet" href="${h}">`).join("") +
          `<form method="post" action="/save"><button>Save</button></form>`,
      );
    });
    // A socket gets in on the cookie, as Access lets a signed-in visitor's in.
    site.on("upgrade", (q, sock) => {
      siteSeen.push([`UPGRADE ${q.url}`, q.headers]);
      if (
        !String(q.headers.cookie ?? "")
          .split("; ")
          .includes("CF_Authorization=jwt-9")
      ) {
        sock.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      // A socket the site refuses even signed in.
      if (q.url === "/refused") {
        sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      acceptSocket(q, sock, "site", socketsEnded, siteChose);
    });
    await listen(site);
    sitePort = portOf(site);
  });
  after(async () => {
    await browser?.close();
    site?.close();
    cdn?.close();
  });

  async function open(path: string, routeWrites?: "block") {
    siteSeen = [];
    cdnSeen = [];
    siteChose = [];
    const ctx = await (browser as Browser).newContext();
    const routeSaw: string[] = [];
    if (routeWrites)
      await ctx.route("**/*", (r: Route) => {
        const q = r.request();
        routeSaw.push(`${q.method()} ${new URL(q.url()).pathname} id=${q.headers()["cf-access-client-id"] ?? "-"}`);
        return q.method() === "GET" ? r.continue() : r.abort("blockedbyclient");
      });
    const page = await ctx.newPage();
    const socketsSeen: string[] = [];
    page.on("websocket", (w) => socketsSeen.push(new URL(w.url()).pathname));
    await qaSignAccess(page, `http://127.0.0.1:${sitePort}`, ACCESS);
    const res = await page.goto(`http://127.0.0.1:${sitePort}${path}`, { waitUntil: "networkidle" });
    return { ctx, page, res, routeSaw, socketsSeen };
  }
  const paths = (seen: [string, IncomingHttpHeaders][]) => seen.map(([p]) => p);
  const unsigned = (seen: [string, IncomingHttpHeaders][]) =>
    seen
      .filter(([p]) => !p.startsWith("UPGRADE "))
      .filter(([, h]) => h["cf-access-client-id"] !== "ID-9" || h["cf-access-client-secret"] !== "SECRET-9")
      .map(([p]) => p);
  const leaked = (seen: [string, IncomingHttpHeaders][]) =>
    seen
      .filter(([, h]) => h["cf-access-client-id"] !== undefined || h["cf-access-client-secret"] !== undefined)
      .map(([p]) => p);

  test("every hop on the site is signed and no hop off it is, a chain that leaves and comes back included", async () => {
    const { ctx, res } = await open("/start");
    try {
      assert.equal(res?.status(), 200);
      assert.deepEqual(unsigned(siteSeen), [], paths(siteSeen).join(", "));
      for (const p of ["GET /start", "GET /", "GET /there.css", "GET /mid.css", "GET /landed.css"])
        assert.ok(paths(siteSeen).includes(p), `${p} not among ${paths(siteSeen).join(", ")}`);
      for (const p of ["GET /font.css", "GET /z.css", "GET /bounce.css"])
        assert.ok(paths(cdnSeen).includes(p), `${p} not among ${paths(cdnSeen).join(", ")}`);
      assert.deepEqual(leaked(cdnSeen), []);
      // The headers are added, not swapped for the request's own: the cookie still goes.
      assert.deepEqual(
        String(siteSeen.find(([p]) => p === "GET /there.css")?.[1].cookie)
          .split("; ")
          .sort(),
        ["CF_Authorization=jwt-9", "sid=s1"],
      );
    } finally {
      await ctx.close();
    }
  });

  test("a socket to the site is the browser's own: it gets in on the Access cookie, with its path's cookies and the subprotocol the site picks, and carries no headers; one to another origin carries none either", async () => {
    const { ctx, page, socketsSeen } = await open("/sockets");
    try {
      await page.waitForFunction(() => (window as unknown as { got: string[] }).got.length >= 2, null, {
        timeout: 5000,
      });
      const got = await page.evaluate(() => (window as unknown as { got: string[] }).got);
      // The page asked for live.v1 then live.v2, the site picked live.v2, and the page knows it.
      assert.deepEqual(got.slice().sort(), ["cdn:hi/", "site:hi/live.v2"]);
      assert.deepEqual(siteChose, ["live.v2"]);
      const up = siteSeen.find(([p]) => p === "UPGRADE /live")?.[1];
      assert.equal(up?.["cf-access-client-id"], undefined);
      assert.equal(up?.["cf-access-client-secret"], undefined);
      assert.deepEqual(String(up?.cookie).split("; ").sort(), ["CF_Authorization=jwt-9", "sid=s1", "tok=t1"]);
      assert.equal(up?.origin, `http://127.0.0.1:${sitePort}`);
      // Playwright still sees the page's sockets, as a caller watching them expects.
      assert.ok(socketsSeen.includes("/live"), socketsSeen.join(", "));
      assert.ok(paths(cdnSeen).includes("UPGRADE /chat"), paths(cdnSeen).join(", "));
      assert.deepEqual(leaked(cdnSeen), []);
    } finally {
      await ctx.close();
    }
  });

  test("a socket the site refuses never opens on the page; it closes", async () => {
    const { ctx, page } = await open("/sockets");
    try {
      await page.waitForFunction(
        () => (window as unknown as { events: string[] }).events.includes("closed /refused"),
        null,
        { timeout: 5000 },
      );
      const events = await page.evaluate(() => (window as unknown as { events: string[] }).events);
      assert.equal(events.includes("open /refused"), false, events.join(", "));
      assert.ok(paths(siteSeen).includes("UPGRADE /refused"), paths(siteSeen).join(", "));
    } finally {
      await ctx.close();
    }
  });

  test("a site socket the page closes is closed at the site too", async () => {
    const { ctx, page } = await open("/sockets");
    try {
      await page.waitForFunction(() => (window as unknown as { got: string[] }).got.length >= 2, null, {
        timeout: 5000,
      });
      const before = socketsEnded.filter((e) => e === "site /live").length;
      await page.evaluate(() => (window as unknown as { own: WebSocket }).own.close(1000, "done"));
      for (let i = 0; i < 50 && socketsEnded.filter((e) => e === "site /live").length === before; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(socketsEnded.filter((e) => e === "site /live").length, before + 1);
    } finally {
      await ctx.close();
    }
  });

  test("a write's redirect back to the site is signed, so the page after it loads", async () => {
    const { ctx, page } = await open("/");
    try {
      await Promise.all([page.waitForURL("**/saved"), page.click("button")]);
      assert.deepEqual(unsigned(siteSeen), [], paths(siteSeen).join(", "));
      assert.ok(paths(siteSeen).includes("POST /save"), paths(siteSeen).join(", "));
      assert.ok(paths(siteSeen).includes("GET /saved"), paths(siteSeen).join(", "));
      assert.equal(await page.textContent("h1"), "/saved");
    } finally {
      await ctx.close();
    }
  });

  test("a route that stops writes still stops them, and runs after the headers are added", async () => {
    const { ctx, page, routeSaw } = await open("/", "block");
    try {
      await page.click("button");
      await page.waitForTimeout(300);
      assert.equal(paths(siteSeen).includes("POST /save"), false, paths(siteSeen).join(", "));
      assert.ok(routeSaw.includes("POST /save id=ID-9"), routeSaw.join(", "));
      assert.deepEqual(unsigned(siteSeen), []);
      assert.deepEqual(leaked(cdnSeen), []);
    } finally {
      await ctx.close();
    }
  });
});

// A local run: no Access in front, so the site (as an app under wrangler)
// reads the token /qa minted from the header on a request and from the
// CF_Authorization cookie on a socket, and nothing sets that cookie but
// qaSignAccess.
describe("qaSignAccess on a local run", { skip: SKIP }, () => {
  let browser: Browser | undefined;
  let site: Server | undefined;
  const seen: [string, IncomingHttpHeaders][] = [];
  const ended: string[] = [];
  before(async () => {
    const { chromium } = createRequire(`${dirname(NODE_MODULES ?? "")}/`)("playwright") as typeof import("playwright");
    browser = await chromium.launch();
    site = createServer((q, r) => {
      seen.push([`${q.method} ${q.url}`, q.headers]);
      if (q.headers["cf-access-jwt-assertion"] !== "J.9") {
        r.writeHead(401);
        return r.end();
      }
      r.writeHead(200, { "content-type": "text/html" });
      r.end(
        `<!doctype html><script>window.events = []; const port = location.port;
          const w = new WebSocket("ws://127.0.0.1:" + port + "/api/live/socket");
          w.onopen = () => events.push("open"); w.onclose = () => events.push("closed");</script>`,
      );
    });
    site.on("upgrade", (q, sock) => {
      seen.push([`UPGRADE ${q.url}`, q.headers]);
      if (
        !String(q.headers.cookie ?? "")
          .split("; ")
          .includes("CF_Authorization=J.9")
      ) {
        sock.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      acceptSocket(q, sock, "site", ended);
    });
    await new Promise<void>((res) => site?.listen(0, "127.0.0.1", () => res()));
  });
  after(async () => {
    await browser?.close();
    site?.closeAllConnections();
    site?.close();
  });
  test("the page loads on the header and its socket opens on the cookie set for it", async () => {
    const a = site?.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await ctx.newPage();
      await qaSignAccess(page, base, { "Cf-Access-Jwt-Assertion": "J.9" });
      const res = await page.goto(`${base}/`, { waitUntil: "networkidle" });
      assert.equal(res?.status(), 200);
      await page.waitForFunction(() => (window as unknown as { events: string[] }).events.length > 0, null, {
        timeout: 5000,
      });
      assert.deepEqual(await page.evaluate(() => (window as unknown as { events: string[] }).events), ["open"]);
      const up = seen.find(([p]) => p === "UPGRADE /api/live/socket")?.[1];
      assert.equal(up?.["cf-access-jwt-assertion"], undefined);
      assert.ok(String(up?.cookie).split("; ").includes("CF_Authorization=J.9"), String(up?.cookie));
    } finally {
      await ctx.close();
    }
  });
});
