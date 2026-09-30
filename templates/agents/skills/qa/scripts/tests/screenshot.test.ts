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
class Page {
  constructor() { this.route = "/"; this.current = ""; }
  async goto(url) {
    this.route = new URL(url).pathname;
    this.current = landedMap[this.route] ? landedMap[this.route] + this.route : url;
    log(\`goto \${url}\`);
    if (process.env.FAKE_THROW && this.route === process.env.FAKE_THROW) throw new Error("boom");
    const status = statusMap[this.route] ?? 200;
    return { status: () => status };
  }
  url() { return this.current; }
  // getAnimations / rewind pass no argument; inkFraction passes the base64 image.
  async evaluate(fn, arg) {
    if (arg !== undefined) return Number(process.env.FAKE_INK ?? "0.3");
    return [];
  }
  async screenshot(opts) {
    mkdirSync(dirname(opts.path), { recursive: true });
    const body = process.env.FAKE_SAME ? "same-bytes" : \`shot \${this.route} \${opts.path}\`;
    writeFileSync(opts.path, body);
    log(\`shot \${opts.path} fullPage=\${!!opts.fullPage} animations=\${opts.animations} masks=\${(opts.mask || []).join(",")}\`);
  }
  async waitForTimeout() {}
  locator(sel) { return sel; }
}
class Ctx {
  constructor(o) { log(\`context \${JSON.stringify(o)}\`); }
  async newPage() { return new Page(); }
  async close() {}
}
exports.chromium = {
  async launch() { log("launch"); return { async newContext(o) { return new Ctx(o); }, async close() { log("close"); } }; },
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
}
const manifest = (): Row[] => JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));

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
test("context: width, scale 1, motion NOT reduced", () =>
  assert.ok(
    log().includes('"viewport":{"width":390,"height":1600},"deviceScaleFactor":1,"reducedMotion":"no-preference"'),
  ));
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
test("no auth → no headers", () => assert.equal(log().includes("extraHTTPHeaders"), false));

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
      "a@b.co",
    ],
    { STUB_OP: "ok" },
  );
  assert.equal(r.rc, 0, r.out);
});
test("CF-Access pair + act-as as extraHTTPHeaders", () =>
  assert.ok(
    log().includes(
      '"extraHTTPHeaders":{"CF-Access-Client-Id":"ID-1","CF-Access-Client-Secret":"SECRET-1","X-Portal-Act-As":"a@b.co"}',
    ),
    log(),
  ));
test("act-as without a token is not sent", () => {
  reset();
  run([...BASE, "--pages", "/", "--viewports", "1440", "--no-motion", "--auth-act-as", "a@b.co"]);
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
  assert.ok(
    log().includes('"extraHTTPHeaders":{"CF-Access-Client-Id":"ENV-ID","CF-Access-Client-Secret":"ENV-SECRET"}'),
    log(),
  );
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
