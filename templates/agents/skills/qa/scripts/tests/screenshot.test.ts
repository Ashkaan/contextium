// screenshot.test.ts — pin screenshot.ts's gates offline against a fake
// `playwright` package: usage exits (2), no usable Playwright (7), the happy
// path's PNGs + manifest.json + motion burst (0), identical shots across routes
// (6), an off-origin landing (7), a 4xx/5xx route (9) with /404 allowed its own
// code, a blank capture (8) and QA_INK_FLOOR=0 lifting it, --no-motion, and the
// CF-Access + act-as headers a stub `op` resolves, or QA_CF_ACCESS_ID /
// QA_CF_ACCESS_SECRET hold. The fake records every
// context and navigation, so what the real browser WOULD have been asked is
// asserted. The script is spawned, never imported.
//
// The fake package is JavaScript because Node will not strip types inside
// node_modules, and CommonJS as the real one is (require() of an ES module
// needs Node 22.12); it is written at run time into the sandbox, never tracked.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/screenshot.test.ts
//
// peers: ../screenshot.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "screenshot.ts");
const TMP = mkdtempSync(join(tmpdir(), "screenshot-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── a Playwright the resolver accepts: browsers.json + INSTALLATION_COMPLETE ──
// lib.ts's resolver also tries the machine's global and npx copies; pointing
// PLAYWRIGHT_BROWSERS_PATH at an empty cache that holds only revision 9999
// makes every real install fail the marker test and only this fake pass it.
const NM = join(TMP, "node_modules");
mkdirSync(join(NM, "playwright-core"), { recursive: true });
mkdirSync(join(NM, "playwright"), { recursive: true });
mkdirSync(join(TMP, "browsers/chromium-9999"), { recursive: true });
writeFileSync(join(NM, "playwright-core/browsers.json"), '{"browsers":[{"name":"chromium","revision":"9999"}]}');
writeFileSync(join(TMP, "browsers/chromium-9999/INSTALLATION_COMPLETE"), "");
writeFileSync(join(NM, "playwright/package.json"), '{"name":"playwright","main":"index.js"}');
writeFileSync(
  join(NM, "playwright/index.js"),
  `const { appendFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const log = (s) => appendFileSync(process.env.FAKE_LOG, s + "\\n");
const statusMap = JSON.parse(process.env.FAKE_STATUS || "{}");
const landedMap = JSON.parse(process.env.FAKE_LANDED || "{}");
// A DevTools session as qaSignAccess uses it: a request is paused only when an
// enabled pattern matches it, as Chromium does; each continue is logged with
// the headers it set, "plain" when the request was never paused.
class Cdp {
  constructor() { this.patterns = []; this.paused = null; this.urls = {}; this.n = 0; }
  on(event, f) { if (event === "Fetch.requestPaused") this.paused = f; }
  async send(method, params) {
    if (method === "Fetch.enable") this.patterns = params.patterns;
    if (method === "Fetch.continueRequest") {
      const url = this.urls[params.requestId];
      log(params.headers ? "sent " + url + " " + JSON.stringify(Object.fromEntries(params.headers.map((h) => [h.name, h.value]))) : "as is " + url);
    }
  }
}
async function request(page, url) {
  const cdp = page.cdp;
  if (!cdp || !cdp.paused || !cdp.patterns.some((p) => url.startsWith(p.urlPattern.slice(0, -1)))) return log("plain " + url);
  const requestId = "r" + cdp.n++;
  cdp.urls[requestId] = url;
  cdp.paused({ requestId, request: { url, headers: {} } });
  await new Promise((r) => setImmediate(r));
}
// Stylesheet traffic as Playwright reports it, by FAKE_SHEETS scenario. One
// Request object per request, as Playwright keeps it across that request's events.
const FRAME = { name: "main" };
class Req {
  constructor(url, error, from, nav) { this.u = url; this.error = error; this.from = from || null; this.nav = !!nav; }
  url() { return this.u; }
  redirectedFrom() { return this.from; }
  isNavigationRequest() { return this.nav; }
  resourceType() { return "stylesheet"; }
  frame() { return FRAME; }
  failure() { return this.error ? { errorText: this.error } : null; }
}
const res = (req, status) => ({ request: () => req, status: () => status, url: () => req.url() });
const SHEET = "https://fonts.example/css2?family=Q&token=do-not-print";
let gotoCount = 0;
class Page {
  constructor(ctx) { this.route = "/"; this.current = ""; this.ctx = ctx; this.listeners = {}; this.attempts = 0; }
  context() { return this.ctx; }
  mainFrame() { return FRAME; }
  on(event, f) { (this.listeners[event] ||= []).push(f); }
  emit(event, x) { for (const f of this.listeners[event] || []) f(x); }
  sheets() {
    const scenario = process.env.FAKE_SHEETS || "";
    this.attempts++;
    if (scenario === "retry" && this.attempts === 1) {
      // The first attempt's sheet is abandoned with the navigation; its failure arrives during the second.
      this.abandoned = new Req(SHEET, "net::ERR_ABORTED");
      this.emit("request", this.abandoned);
      // A sheet that failed outright before the network changed, which the committed attempt never asks for.
      const early = new Req("https://fonts.example/early.css");
      this.emit("request", early);
      this.emit("response", res(early, 404));
      throw new Error("page.goto: net::ERR_NETWORK_CHANGED at " + this.route);
    }
    if (scenario === "retry") {
      this.emit("requestfailed", this.abandoned);
      const ok = new Req("https://fonts.example/other.css");
      this.emit("request", ok);
      this.emit("response", res(ok, 200));
        this.emit("requestfinished", ok);
    }
    if (scenario === "recover") {
      const first = new Req(SHEET, "net::ERR_ABORTED");
      this.emit("request", first);
      this.emit("response", res(first, 503));
      this.emit("requestfailed", first);
      const again = new Req(SHEET);
      this.emit("request", again);
      this.emit("response", res(again, 200));
      this.emit("requestfinished", again);
    }
    if (scenario === "redirect") {
      // The sheet redirects to a mirror that answers 503, then the same sheet redirects to one that answers 200.
      const a = new Req("https://fonts.example/fonts.css");
      this.emit("request", a);
      this.emit("response", res(a, 302));
      const m1 = new Req("https://mirror-1.example/fonts.css", null, a);
      this.emit("request", m1);
      this.emit("response", res(m1, 503));
      const b = new Req("https://fonts.example/fonts.css");
      this.emit("request", b);
      this.emit("response", res(b, 302));
      const m2 = new Req("https://mirror-2.example/fonts.css", null, b);
      this.emit("request", m2);
      this.emit("response", res(m2, 200));
      this.emit("requestfinished", m2);
    }
    if (scenario === "redirect-direct") {
      // The sheet redirects to a mirror that answers 503; the page then loads that mirror URL directly, and it answers 200.
      const a = new Req("https://fonts.example/fonts.css");
      this.emit("request", a);
      this.emit("response", res(a, 302));
      const m1 = new Req("https://mirror-1.example/fonts.css", null, a);
      this.emit("request", m1);
      this.emit("response", res(m1, 503));
      const direct = new Req("https://mirror-1.example/fonts.css");
      this.emit("request", direct);
      this.emit("response", res(direct, 200));
      this.emit("requestfinished", direct);
    }
    if (scenario === "direct-stall") {
      // The mirror answers 503; a direct retry of it sends 200 headers and then stalls before its CSS.
      const m1 = new Req("https://mirror-1.example/fonts.css");
      this.emit("request", m1);
      this.emit("response", res(m1, 503));
      const direct = new Req("https://mirror-1.example/fonts.css");
      this.emit("request", direct);
      this.emit("response", res(direct, 200));
    }
    if (scenario === "doc-redirect") {
      // The route redirects, and the redirect's target never answers; goto times out.
      const start = new Req(this.target, null, null, true);
      this.emit("request", start);
      this.emit("response", res(start, 302));
      this.emit("requestfinished", start);
      const target = new Req(this.target + "target", null, start, true);
      this.emit("request", target);
      const e = new Error("page.goto: Timeout 30000ms exceeded.");
      e.name = "TimeoutError";
      throw e;
    }
    if (scenario === "doc-whole" || scenario === "doc-half") {
      // The document answers 200; a request held open keeps the page from going idle, so goto times out.
      // doc-whole: the document's body arrived in full; doc-half: it stalled part way.
      const doc = new Req(this.target, null, null, true);
      this.emit("request", doc);
      this.emit("response", res(doc, 200));
      if (scenario === "doc-whole") this.emit("requestfinished", doc);
      const e = new Error("page.goto: Timeout 30000ms exceeded.");
      e.name = "TimeoutError";
      throw e;
    }
    if (scenario === "fail" || scenario === "recover-late") {
      const req = new Req(SHEET, "net::ERR_CONNECTION_REFUSED");
      this.emit("request", req);
      this.emit("requestfailed", req);
    }
  }
  async goto(url) {
    this.gotoIndex = ++gotoCount;
    this.route = new URL(url).pathname;
    this.current = landedMap[this.route] ? landedMap[this.route] + this.route : url;
    log(\`goto \${url}\`);
    this.target = url;
    this.sheets();
    await request(this, url);
    await request(this, "https://cdn.example/f.woff2");
    if (process.env.FAKE_THROW && this.route === process.env.FAKE_THROW) throw new Error("boom");
    const status = statusMap[this.route] ?? 200;
    return { status: () => status };
  }
  url() { return this.current; }
  // getAnimations / rewind pass no argument; inkFraction passes the base64 image.
  async evaluate(fn, arg) {
    // The font check passes its wait (0 for the read after capture) and answers the
    // page's faces; FAKE_FONTS is that answer as JSON, or "throw" for a browser that cannot.
    if (String(fn).includes("document.fonts")) {
      log(\`fonts wait=\${arg}\`);
      if (process.env.FAKE_FONTS === "throw") throw new Error("Execution context was destroyed");
      // FAKE_FONTS_AFTER answers the unwaited read after capture; FAKE_FONTS_FROM_GOTO
      // applies FAKE_FONTS only to the page loaded by that navigation and later ones.
      if (arg === 0 && process.env.FAKE_FONTS_AFTER) return JSON.parse(process.env.FAKE_FONTS_AFTER);
      const from = Number(process.env.FAKE_FONTS_FROM_GOTO || "0");
      if (this.gotoIndex < from) return { timedOut: false, faces: [] };
      return JSON.parse(process.env.FAKE_FONTS || '{"timedOut":false,"faces":[]}');
    }
    // The reveal pass's image wait passes its timeout and answers how many images are still loading;
    // the selectors it forces visible are logged, read out of the function's own text.
    if (String(fn).includes('"lazy"')) {
      log(\`reveal \${(String(fn).match(/"(\\[data-animate\\][^"]*)"/) || [])[1] || ""}\`);
      log("driver font wait at reveal: " + (process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ? "off" : "on"));
      if (process.env.FAKE_SHEETS === "recover-late") {
        const again = new Req(SHEET);
        this.emit("request", again);
        this.emit("response", res(again, 200));
        this.emit("requestfinished", again);
      }
      return Number(process.env.FAKE_PENDING ?? "0");
    }
    if (arg !== undefined) {
      // FAKE_INK_MATCH: a shot whose bytes hold this text has ink 0.3; the rest FAKE_INK.
      const match = process.env.FAKE_INK_MATCH;
      if (match && Buffer.from(String(arg), "base64").toString().includes(match)) return 0.3;
      return Number(process.env.FAKE_INK ?? "0.3");
    }
    if (String(fn).includes("documentElement.scrollHeight")) {
      log("measure height");
      return Number(process.env.FAKE_HEIGHT ?? "1600");
    }
    if (String(fn).includes("a.currentTime = 0")) log("rewind");
    return [];
  }
  async screenshot(opts) {
    mkdirSync(dirname(opts.path), { recursive: true });
    // FAKE_SAME_EXCEPT: every shot is the same bytes except those whose path holds this text.
    const except = process.env.FAKE_SAME_EXCEPT;
    const same = process.env.FAKE_SAME || (except && !opts.path.includes(except));
    const body = same ? "same-bytes" : \`shot \${this.route} \${opts.path}\`;
    writeFileSync(opts.path, body);
    log(\`shot \${opts.path} fullPage=\${!!opts.fullPage} animations=\${opts.animations} masks=\${(opts.mask || []).join(",")}\${opts.clip ? " clip=" + JSON.stringify(opts.clip) : ""} driverFontWait=\` + (process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ? "off" : "on"));
  }
  async waitForTimeout() {}
  locator(sel) { return sel; }
}
class Ctx {
  constructor(o) { log(\`context \${JSON.stringify(o)}\`); }
  async addCookies(c) { log("cookies " + JSON.stringify(c)); }
  async newCDPSession(page) { page.cdp = new Cdp(); return page.cdp; }
  async newPage() { return new Page(this); }
  async close() {}
}
exports.chromium = {
  async launch(o) { log("launch " + JSON.stringify((o && o.args) || [])); return { async newContext(o) { return new Ctx(o); }, async close() { log("close"); } }; },
};
`,
);

// ── stubs: npm (root -g → the fake node_modules), op (1Password) ──
const BIN = join(TMP, "bin");
mkdirSync(BIN);
writeFileSync(
  join(BIN, "npm"),
  `#!/bin/sh
[ "$*" = "root -g" ] || exit 1
[ -n "\${STUB_NO_PW:-}" ] || printf '%s\\n' "$FAKE_NM"
`,
);
writeFileSync(
  join(BIN, "op"),
  `#!/bin/sh
[ "\${STUB_OP:-}" = "ok" ] || exit 1
case "$*" in
  *"item list"*) echo '[{"id":"item1","title":"probe","vault":{"id":"v1"}}]' ;;
  *"--fields client_id"*) echo "ID-1" ;;
  *"--fields client_secret"*) echo "SECRET-1" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(BIN, "npm"), 0o755);
chmodSync(join(BIN, "op"), 0o755);
const HOME = join(TMP, "home");
mkdirSync(HOME);
const FAKE_LOG = join(TMP, "fake.log");

/**
 * process.env without the host's 1Password settings and service-token pair,
 * so `op` is only ever the stub on PATH and no QA_CF_ACCESS_* leaks in.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "OP_CONNECT_HOST",
    "OP_CONNECT_TOKEN",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "QA_CF_ACCESS_ID",
    "QA_CF_ACCESS_SECRET",
    "QA_PLAYWRIGHT_DIR",
  ])
    delete e[k];
  return e;
}
const SHOTS = join(TMP, "shots");
const BASE = ["--url", "http://localhost:8813", "--repo-slug", "app-1", "--run-id", "r1"];
const OUT = join(SHOTS, "app-1/r1");

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...hermeticEnv(),
      PATH: `${BIN}:${process.env.PATH}`,
      HOME,
      FAKE_NM: NM,
      FAKE_LOG,
      PLAYWRIGHT_BROWSERS_PATH: join(TMP, "browsers"),
      QA_SHOTS_ROOT: SHOTS,
      ...env,
    },
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}
const log = () => (existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, "utf8") : "");
function reset(): void {
  writeFileSync(FAKE_LOG, "");
  rmSync(SHOTS, { recursive: true, force: true });
}
interface Row {
  route: string;
  width: number;
  status: number;
  ink: number;
  sha: string;
  bytes: number;
  landedOrigin: string;
  fontNotes?: Note[];
}
interface Note {
  phase: string;
  kind: string;
  reason: string;
  family?: string;
  origin?: string;
}
const manifest = (): Row[] => JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
const motionManifest = (): { route: string; fontNotes?: Note[] }[] =>
  JSON.parse(readFileSync(join(OUT, "motion/manifest.json"), "utf8"));

// ── usage ──
test("no args → 2", () => {
  const r = run([]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage: screenshot\.ts/);
});
test("missing --run-id → 2", () => {
  const r = run(["--url", "http://x", "--repo-slug", "s"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage:/);
});
test("unknown flag → 2", () => {
  const r = run([...BASE, "--bogus"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /unknown flag: --bogus/);
});
test("auth unresolved → 2", () => {
  const r = run([...BASE, "--auth-op-item", "item1"], { STUB_OP: "fail" });
  assert.equal(r.rc, 2);
  assert.match(r.out, /service token unresolved from 1Password item item1/);
});
test("usage exits create no run dir", () => assert.equal(existsSync(SHOTS), false));

// ── no Playwright, and installing one forbidden → 7, said plainly ──
// (Playwright installs on first use; QA_NO_INSTALL=1 keeps this test offline.)
test("no playwright → 7", () => {
  reset();
  const r = run(BASE, { STUB_NO_PW: "1", QA_NO_INSTALL: "1" });
  assert.equal(r.rc, 7);
  assert.match(r.out, /qa: skipped — Playwright unavailable \(see the line above\); no screenshots were taken/);
});
test("no browser launched", () => assert.equal(log(), ""));

// ── happy path ──
let happy = { rc: 0 as number | null, out: "" };
test("happy path → 0, names the run dir", () => {
  reset();
  happy = run([...BASE, "--pages", "/ /about", "--viewports", "1440,390", "--masks", ".clock,.ad"]);
  assert.equal(happy.rc, 0, happy.out);
  assert.ok(happy.out.includes(`qa: shots + manifest → ${OUT}`), happy.out);
});
for (const f of ["index-1440.png", "index-390.png", "about-1440.png", "about-390.png"]) {
  test(`wrote ${f}`, () => assert.ok(existsSync(join(OUT, f))));
}
test("manifest.json written", () => assert.ok(existsSync(join(OUT, "manifest.json"))));
test("manifest has 4 rows (2 routes × 2 widths)", () => assert.equal(manifest().length, 4));
test("manifest row: route · width · status · sha · ink · bytes · origin", () =>
  assert.ok(
    manifest().some(
      (m) =>
        m.route === "/about" &&
        m.width === 390 &&
        m.status === 200 &&
        m.ink === 0.3 &&
        m.sha.length === 16 &&
        m.bytes > 0 &&
        m.landedOrigin === "http://localhost:8813",
    ),
  ));
test("stdout table row for /about @390", () =>
  assert.match(happy.out, new RegExp(`/about.*390.*${join(OUT, "about-390.png").replace(/[.]/g, "\\.")}.*200`)));
test("route joined onto base", () => assert.match(log(), /^goto http:\/\/localhost:8813\/about$/m));
test("context: width, scale 1, motion NOT reduced, touch only at the phone width", () => {
  assert.ok(
    log().includes(
      '"viewport":{"width":390,"height":1600},"hasTouch":true,"deviceScaleFactor":1,"reducedMotion":"no-preference"',
    ),
    log(),
  );
  assert.ok(log().includes('"viewport":{"width":1440,"height":1600},"hasTouch":false,"deviceScaleFactor":1'), log());
});
test("one mouse browser and one touchscreen browser, each closed", () => {
  const launches = log()
    .split("\n")
    .filter((l) => l.startsWith("launch "));
  assert.deepEqual(launches.sort(), [
    'launch ["--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1"]',
    "launch []",
  ]);
  assert.equal(
    log()
      .split("\n")
      .filter((l) => l === "close").length,
    2,
  );
});
test("settled still: fullPage, animations disabled, masks applied", () =>
  assert.ok(log().includes(`shot ${OUT}/index-1440.png fullPage=true animations=disabled masks=.clock,.ad`), log()));
test("motion: manifest + 4-frame burst per route × width", () => {
  assert.ok(existsSync(join(OUT, "motion/manifest.json")));
  assert.equal(readdirSync(join(OUT, "motion")).filter((f) => f.endsWith(".png")).length, 16);
});
test("burst frames allow animations", () =>
  assert.ok(log().includes(`shot ${OUT}/motion/index-1440-t0000.png fullPage=false animations=allow`), log()));
test("motion summary line", () =>
  assert.ok(
    happy.out.includes("motion: 0/4 route×viewport captures declared animations; 4 showed frame-to-frame change"),
    happy.out,
  ));
test("no auth → no headers", () => {
  assert.equal(log().includes("extraHTTPHeaders"), false);
  assert.doesNotMatch(log(), /^sent /m);
});
test("reveal pass forces [data-reveal] visible, as a common scroll-reveal library uses", () => {
  const line = log()
    .split("\n")
    .find((l) => l.startsWith("reveal "));
  assert.ok(line?.split(" ")[1]?.split(",").includes("[data-reveal]"), line ?? log());
});

// --no-motion, --reduced-motion, default pages + viewports
test("--no-motion → no motion dir", () => {
  reset();
  const r = run([...BASE, "--no-motion", "--reduced-motion"]);
  assert.equal(r.rc, 0, r.out);
  assert.equal(existsSync(join(OUT, "motion")), false);
});
test("defaults: / at 1440,820,390", () => {
  const m = manifest();
  assert.equal(m.map((x) => x.width).join(","), "1440,820,390");
  assert.equal(m[0]?.route, "/");
});
test("--reduced-motion → reduce", () => assert.ok(log().includes('"reducedMotion":"reduce"')));

// ── a page taller than a reviewer can read at once is shot in parts ──
// The reviewer's image reader shrinks a picture to about 2,000px on its long
// side, so a 20,775px phone page reached it at a tenth of its size, its text
// and its sight code unreadable (six of
// fifteen codes lost). Before that the cap was ImageMagick's 32,000px
// policy, which a 3,000px part is far under. Each part keeps its own row.
test("a 7,000px page is three clipped parts, each with its own row", () => {
  reset();
  const r = run([...BASE, "--pages", "/long", "--viewports", "390", "--no-motion"], { FAKE_HEIGHT: "7000" });
  assert.equal(r.rc, 0, r.out);
  const rows = manifest().filter((m) => m.route === "/long");
  assert.deepEqual(
    rows.map((m) => (m as Row & { path: string }).path.split("/").at(-1)),
    ["long-390-part1.png", "long-390-part2.png", "long-390-part3.png"],
  );
  assert.ok(log().includes('clip={"x":0,"y":0,"width":390,"height":3000}'), log());
  assert.ok(log().includes('clip={"x":0,"y":6000,"width":390,"height":1000}'), log());
});
test("a page under the cap is one shot with no clip", () => {
  reset();
  const r = run([...BASE, "--pages", "/short", "--viewports", "390", "--no-motion"], { FAKE_HEIGHT: "3000" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest().length, 1);
  assert.equal(log().includes("clip="), false);
});

// ── a page in parts is judged whole by the blank and identical-shot gates ──
// One 3,000px part of a real page can be plain background, and two pages of a
// site can share a footer part byte for byte; neither is a blank or a wall.
test("two routes sharing every part but one are not identical shots", () => {
  reset();
  const r = run([...BASE, "--pages", "/ /about", "--viewports", "390", "--no-motion"], {
    FAKE_HEIGHT: "7000",
    FAKE_SAME_EXCEPT: "-part1",
  });
  assert.equal(r.rc, 0, r.out);
});
test("a page with ink in one part of three is not blank", () => {
  reset();
  const r = run([...BASE, "--pages", "/long", "--viewports", "390", "--no-motion"], {
    FAKE_HEIGHT: "7000",
    FAKE_INK: "0",
    FAKE_INK_MATCH: "-part1",
  });
  assert.equal(r.rc, 0, r.out);
});
test("a page blank in every part is one blank capture", () => {
  reset();
  const r = run([...BASE, "--pages", "/long", "--viewports", "390", "--no-motion"], {
    FAKE_HEIGHT: "7000",
    FAKE_INK: "0",
  });
  assert.equal(r.rc, 8, r.out);
  assert.equal(r.out.split("\n").filter((l) => l.includes("non-background")).length, 1, r.out);
});

// ── gate: identical shots across routes → 6 ──
test("identical shots → 6", () => {
  reset();
  const r = run([...BASE, "--pages", "/ /about", "--viewports", "1440", "--no-motion"], { FAKE_SAME: "1" });
  assert.equal(r.rc, 6);
  assert.ok(r.out.includes("IDENTICAL SHOTS"));
  assert.ok(r.out.includes("1440px: /, /about rendered byte-identical"), r.out);
});
test("one route, identical across widths is not a collision", () =>
  assert.equal(run([...BASE, "--pages", "/", "--viewports", "1440,390", "--no-motion"], { FAKE_SAME: "1" }).rc, 0));

// ── gate: off-origin landing → 7 (wins over collisions) ──
test("off-origin → 7, reported before the collision", () => {
  reset();
  const r = run([...BASE, "--pages", "/ /login", "--viewports", "1440", "--no-motion"], {
    FAKE_LANDED: '{"/login":"https://auth.example.com"}',
    FAKE_SAME: "1",
  });
  assert.equal(r.rc, 7);
  assert.ok(r.out.includes("REDIRECTED OFF-ORIGIN"));
  assert.ok(r.out.includes("/login landed on https://auth.example.com"));
  assert.ok(r.out.includes("Expected origin: http://localhost:8813"));
});

// ── gate: unsuccessful response → 9; /404 may answer 404; no response is -1 ──
test("403 → 9 with the act-as hint; /404 answering 404 is allowed", () => {
  reset();
  const r = run([...BASE, "--pages", "/ /admin /404", "--viewports", "1440", "--no-motion"], {
    FAKE_STATUS: '{"/admin":403,"/404":404}',
  });
  assert.equal(r.rc, 9);
  assert.ok(r.out.includes("UNSUCCESSFUL RESPONSES"));
  assert.ok(r.out.includes("/admin @1440: HTTP 403"));
  assert.equal(r.out.includes("/404 @1440"), false);
  assert.ok(r.out.includes("--auth-act-as"));
});
test("an image still loading after the wait is named on stderr, and the run still exits 0", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_PENDING: "2" });
  assert.equal(r.rc, 0, r.out);
  assert.ok(r.out.includes("screenshot: / @1440 — 2 image(s) still loading after 10000ms"), r.out);
  const quiet = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"]);
  assert.equal(quiet.out.includes("still loading"), false, quiet.out);
});
test("navigation error → status -1 → 9", () => {
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_THROW: "/" });
  assert.equal(r.rc, 9);
  assert.ok(r.out.includes("/ @1440: HTTP no response"), r.out);
});

// ── gate: blank capture → 8; QA_INK_FLOOR=0 lifts it ──
test("ink 0 → 8 at the 0.02% floor", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_INK: "0" });
  assert.equal(r.rc, 8);
  assert.ok(r.out.includes("BLANK CAPTURES"));
  assert.ok(r.out.includes("/ @1440  0.0% non-background"));
  assert.ok(r.out.includes("Floor is 0.020%"));
});
test("QA_INK_FLOOR=0 accepts the blank", () =>
  assert.equal(
    run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_INK: "0", QA_INK_FLOOR: "0" }).rc,
    0,
  ));

// ── auth: token pair from op + act-as, sent as headers, absent from argv ──
test("auth run → 0", () => {
  reset();
  const r = run(
    [
      ...BASE,
      "--pages",
      "/",
      "--viewports",
      "1440",
      "--no-motion",
      "--auth-op-item",
      "item1",
      "--auth-act-as",
      "probe@example.com",
    ],
    { STUB_OP: "ok" },
  );
  assert.equal(r.rc, 0, r.out);
});
test("CF-Access pair + act-as sent to the site's own origin", () =>
  assert.ok(
    log().includes(
      'sent http://localhost:8813/ {"CF-Access-Client-Id":"ID-1","CF-Access-Client-Secret":"SECRET-1","X-Portal-Act-As":"probe@example.com"}',
    ),
    log(),
  ));
test("and never to another origin the page loads from, nor as a context-wide header", () => {
  assert.match(log(), /^plain https:\/\/cdn\.example\/f\.woff2$/m);
  assert.doesNotMatch(log(), /^sent https:\/\/cdn\.example/m);
  assert.equal(log().includes("extraHTTPHeaders"), false);
});
test("act-as without a token is not sent", () => {
  reset();
  run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion", "--auth-act-as", "probe@example.com"]);
  assert.equal(log().includes("X-Portal-Act-As"), false);
});

// ── no item named: the pair from QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET ──
test("the environment's service-token pair becomes the headers", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], {
    QA_CF_ACCESS_ID: "ENV-ID",
    QA_CF_ACCESS_SECRET: "ENV-SECRET",
  });
  assert.equal(r.rc, 0, r.out);
  assert.ok(log().includes('"CF-Access-Client-Id":"ENV-ID","CF-Access-Client-Secret":"ENV-SECRET"}'), log());
});
test("half a pair in the environment sends nothing", () => {
  reset();
  run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { QA_CF_ACCESS_ID: "ENV-ID" });
  assert.equal(log().includes("CF-Access-Client-Id"), false, log());
});
test("the token pair never reaches stdout or stderr", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion", "--auth-op-item", "item1"], {
    STUB_OP: "ok",
  });
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.out.includes("SECRET-1"), false, r.out);
});

// ── fonts: each phase waits, then the shots skip Playwright's own wait ──
test("fonts are checked before the rewind and before the still is measured, and shots skip the driver's wait", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440"]);
  assert.equal(r.rc, 0, r.out);
  const lines = log().split("\n");
  const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
  assert.ok(at("fonts wait=5000") >= 0 && at("fonts wait=5000") < at("rewind"), log());
  const stillCheck = lines.findIndex((l, i) => i > at("reveal ") && l === "fonts wait=5000");
  assert.ok(stillCheck > at("reveal ") && stillCheck < at("measure height"), log());
  for (const l of lines.filter((x) => x.startsWith("shot "))) assert.match(l, /driverFontWait=off$/, l);
  assert.ok(
    log().includes("driver font wait at reveal: on"),
    "the driver's wait was not restored after the motion burst",
  );
  assert.equal(manifest()[0]?.fontNotes, undefined);
  assert.equal(r.out.includes("font: "), false, r.out);
});
test("a browser that cannot report its fonts leaves the shots, noted as unverified in both phases", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "390"], { FAKE_FONTS: "throw" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.fontNotes?.[0]?.kind, "unverified");
  assert.equal(motionManifest()[0]?.fontNotes?.[0]?.kind, "unverified");
  assert.match(r.out, /^font: \/ @390 still — typography may differ: unverified: font state could not be read/m);
});
test("a font note cannot rescue an invalid route: the status gate still exits 9", () => {
  reset();
  const r = run([...BASE, "--pages", "/admin", "--viewports", "1440", "--no-motion"], {
    FAKE_STATUS: '{"/admin":403}',
    FAKE_FONTS: '{"timedOut":true,"faces":[{"family":"Switzer","status":"loading"}]}',
  });
  assert.equal(r.rc, 9, r.out);
  assert.deepEqual(manifest()[0]?.fontNotes, [
    { phase: "still", kind: "timeout", reason: "still loading after 5000ms", family: "Switzer" },
  ]);
});

// ── stylesheets: only the committed navigation, and only while still failed ──
test("an abandoned attempt's stylesheet, failing late during the retry, leaves no note", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440"], { FAKE_SHEETS: "retry" });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /retrying once/);
  assert.equal(manifest()[0]?.fontNotes, undefined, JSON.stringify(manifest()[0]));
  assert.equal(motionManifest()[0]?.fontNotes, undefined);
});
test("a stylesheet that answers 503 and then loads leaves no note", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440"], { FAKE_SHEETS: "recover" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.fontNotes, undefined, JSON.stringify(manifest()[0]));
  assert.equal(motionManifest()[0]?.fontNotes, undefined);
});
test("a stylesheet that fails with no face registered is noted in both phases by origin, never by URL", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "390"], { FAKE_SHEETS: "fail" });
  assert.equal(r.rc, 0, r.out);
  const expected = { kind: "stylesheet-error", reason: "net::ERR_CONNECTION_REFUSED", origin: "https://fonts.example" };
  assert.deepEqual(manifest()[0]?.fontNotes, [{ phase: "still", ...expected }]);
  assert.deepEqual(motionManifest()[0]?.fontNotes, [{ phase: "motion", ...expected }]);
  assert.match(r.out, /^font: \/ @390 motion — typography may differ: stylesheet-error https:\/\/fonts\.example/m);
  const written = r.out + readFileSync(join(OUT, "manifest.json"), "utf8");
  assert.equal(/do-not-print|css2/.test(written), false, written);
});
test("a stylesheet that recovers after the motion burst is noted on the motion only", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "390"], { FAKE_SHEETS: "recover-late" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(motionManifest()[0]?.fontNotes?.[0]?.kind, "stylesheet-error");
  assert.equal(manifest()[0]?.fontNotes, undefined, JSON.stringify(manifest()[0]));
});

test("a face idle before the burst and loaded by its end is noted as unverified in that phase", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "390"], {
    FAKE_FONTS: '{"timedOut":false,"faces":[{"family":"Switzer","status":"unloaded"}]}',
    FAKE_FONTS_AFTER: '{"timedOut":false,"faces":[{"family":"Switzer","status":"loaded","began":true}]}',
  });
  assert.equal(r.rc, 0, r.out);
  const expected = { kind: "unverified", reason: "began loading during capture", family: "Switzer" };
  assert.deepEqual(motionManifest()[0]?.fontNotes, [{ phase: "motion", ...expected }]);
  assert.deepEqual(manifest()[0]?.fontNotes, [{ phase: "still", ...expected }]);
});
test("a sheet that redirects to a failing mirror, then to a working one, leaves no note", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440"], { FAKE_SHEETS: "redirect" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.fontNotes, undefined, JSON.stringify(manifest()[0]));
  assert.equal(motionManifest()[0]?.fontNotes, undefined);
});
test("a width given twice is captured once, so no note can describe an overwritten PNG", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "390,390", "--no-motion"], {
    FAKE_FONTS: '{"timedOut":false,"faces":[{"family":"Switzer","status":"error"}]}',
    FAKE_FONTS_FROM_GOTO: "2",
  });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest().length, 1);
  assert.equal(
    log()
      .split("\n")
      .filter((l) => l.startsWith("goto ")).length,
    1,
    log(),
  );
  assert.equal(r.out.includes("font: "), false, r.out);
});
test("a face already in use at the wait, or registered loaded during capture, is not a load the capture began", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "390"], {
    FAKE_FONTS_AFTER: '{"timedOut":false,"faces":[{"family":"Switzer","status":"loaded","began":false}]}',
  });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.fontNotes, undefined, JSON.stringify(manifest()[0]));
  assert.equal(motionManifest()[0]?.fontNotes, undefined);
});
test("a failed mirror URL loaded directly and successfully later leaves no note", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440"], { FAKE_SHEETS: "redirect-direct" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.fontNotes, undefined, JSON.stringify(manifest()[0]));
});
test("a page whose document arrived whole but never went idle is shot with its own status", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_SHEETS: "doc-whole" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.status, 200);
  assert.match(r.out, /answered 200 but never went network-idle; shot as it stands/);
});
test("a page whose document stalled part way is still no response, exit 9", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_SHEETS: "doc-half" });
  assert.equal(r.rc, 9, r.out);
  assert.ok(r.out.includes("/ @1440: HTTP no response"), r.out);
});

test("a failed sheet whose direct retry sends headers and stalls is still noted", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_SHEETS: "direct-stall" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest()[0]?.fontNotes?.[0]?.kind, "stylesheet-error", JSON.stringify(manifest()[0]));
});
test("a route whose redirect target never answers is no response, exit 9", () => {
  reset();
  const r = run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion"], { FAKE_SHEETS: "doc-redirect" });
  assert.equal(r.rc, 9, r.out);
  assert.ok(r.out.includes("/ @1440: HTTP no response"), r.out);
});
test("a route given twice is captured once", () => {
  reset();
  const r = run([...BASE, "--pages", "/ /", "--viewports", "390", "--no-motion"]);
  assert.equal(r.rc, 0, r.out);
  assert.equal(manifest().length, 1);
  assert.equal(
    log()
      .split("\n")
      .filter((l) => l.startsWith("goto ")).length,
    1,
    log(),
  );
});
