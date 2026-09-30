// a11y.test.ts — pin a11y.ts offline: its usage exits, the off-repo install
// under $HOME/.local/lib/qa-a11y through a stub `npm` (exit 8 when that fails),
// the per-page/per-viewport violation lines a fake `playwright` +
// `@axe-core/playwright` produce, HTTP >= 400 pages "not graded", exit 3 when
// nothing could be graded, the CF-Access + act-as headers a stub `op` resolves
// (or QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET hold), QA_NO_INSTALL=1 (no npm
// call, exit 8), and the install lock both with flock and, on a machine with no
// flock (macOS), as a mkdir lock. No browser and no network: the fake modules
// record what the real ones would have been asked. The script is spawned,
// never imported.
//
// The fake packages are JavaScript because Node will not strip types inside
// node_modules, and CommonJS as the real ones are (require() of an ES module
// needs Node 22.12); they are written at run time into the sandbox, never
// tracked.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/a11y.test.ts
//
// peers: ../a11y.ts

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "a11y.ts");
const TMP = mkdtempSync(join(tmpdir(), "a11y-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── sandbox HOME: the script's cache dir is derived from it ──
const HOME = join(TMP, "home");
mkdirSync(HOME);
const CACHE = join(HOME, ".local/lib/qa-a11y");
const FAKE_LOG = join(TMP, "fake.log");
const NPM_LOG = join(TMP, "npm.log");

/**
 * process.env without the host's 1Password settings, service-token pair and
 * install switch, so `op` is only ever the stub on PATH.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "OP_CONNECT_HOST",
    "OP_CONNECT_TOKEN",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "QA_CF_ACCESS_ID",
    "QA_CF_ACCESS_SECRET",
    "QA_NO_INSTALL",
  ])
    delete e[k];
  return e;
}

// ── the fake node modules the stub npm "installs" ──
const FAKE_SRC = join(TMP, "fake-modules");
mkdirSync(join(FAKE_SRC, "playwright"), { recursive: true });
mkdirSync(join(FAKE_SRC, "@axe-core/playwright"), { recursive: true });
writeFileSync(join(FAKE_SRC, "playwright/package.json"), '{"name":"playwright","main":"index.js"}');
writeFileSync(
  join(FAKE_SRC, "playwright/index.js"),
  `const { appendFileSync } = require("node:fs");
const statusMap = JSON.parse(process.env.FAKE_STATUS || "{}");
class Page {
  async goto(url) {
    const route = new URL(url).pathname;
    appendFileSync(process.env.FAKE_LOG, \`goto \${url}\\n\`);
    if (process.env.FAKE_THROW && route === process.env.FAKE_THROW) throw new Error("boom on " + route);
    const status = statusMap[route] ?? 200;
    return { status: () => status };
  }
}
class Ctx {
  constructor(opts) { appendFileSync(process.env.FAKE_LOG, \`context \${JSON.stringify(opts)}\\n\`); }
  async newPage() { return new Page(); }
  async close() {}
}
exports.chromium = {
  async launch() { return { async newContext(o) { return new Ctx(o); }, async close() {} }; },
};
`,
);
writeFileSync(
  join(FAKE_SRC, "@axe-core/playwright/package.json"),
  '{"name":"@axe-core/playwright","main":"index.js"}',
);
writeFileSync(
  join(FAKE_SRC, "@axe-core/playwright/index.js"),
  `exports.default = class AxeBuilder {
  constructor() {}
  async analyze() {
    const ids = JSON.parse(process.env.FAKE_VIOLATIONS || "[]");
    return { violations: ids.map((id) => ({ id })) };
  }
}
`,
);

// ── stubs on PATH: npm (installs the fakes or fails), op (1Password) ──
const BIN = join(TMP, "bin");
mkdirSync(BIN);
writeFileSync(
  join(BIN, "npm"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_NPM_LOG"
[ "\${STUB_NPM:-ok}" = "ok" ] || exit 1
/bin/mkdir -p node_modules && /bin/cp -R "$FAKE_SRC/." node_modules/
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

function run(args: string[], env: Record<string, string> = {}, path = `${BIN}:${process.env.PATH}`) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...hermeticEnv(),
      HOME,
      PATH: path,
      FAKE_LOG,
      STUB_NPM_LOG: NPM_LOG,
      FAKE_SRC,
      ...env,
    },
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const clear = (f: string) => writeFileSync(f, "");

// ── usage ──
test("no --url → 2", () => {
  const r = run([]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage: a11y\.ts/);
});
test("unknown flag → 2", () => {
  const r = run(["--url", "http://localhost:1", "--bogus"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /unknown flag: --bogus/);
});
test("--auth-op-item unresolved → 2, before any install", () => {
  const r = run(["--url", "http://localhost:1", "--auth-op-item", "item1"], { STUB_OP: "fail" });
  assert.equal(r.rc, 2);
  assert.match(r.out, /service token unresolved from 1Password item item1/);
});
test("usage exits never reach npm", () => assert.equal(existsSync(NPM_LOG), false, read(NPM_LOG)));

// ── install: fails → 8; succeeds → lands in $HOME/.local/lib/qa-a11y ──
test("npm install fails → 8", () => {
  const r = run(["--url", "http://localhost:1"], { STUB_NPM: "fail" });
  assert.equal(r.rc, 8);
  assert.ok(r.out.includes(`installing @axe-core/playwright into ${CACHE}`), r.out);
  assert.match(r.out, /could not install/);
});
test("npm called as: install --no-save --silent @axe-core/playwright playwright", () =>
  assert.equal(read(NPM_LOG), "install --no-save --silent @axe-core/playwright playwright\n"));

// ── QA_NO_INSTALL=1: no npm call at all, exit 8, said plainly ──
test("QA_NO_INSTALL=1 → 8, npm never called, the reason named", () => {
  clear(NPM_LOG);
  const r = run(["--url", "http://localhost:1"], { QA_NO_INSTALL: "1" });
  assert.equal(r.rc, 8);
  assert.equal(read(NPM_LOG), "");
  assert.match(r.out, /QA_NO_INSTALL=1/);
});

// ── no flock on PATH (macOS): the mkdir lock ──
// PATH holds only the stubs (npm, op); the npm stub names its tools absolutely.
test("no flock: a failed install is 8 and releases the mkdir lock", () => {
  const r = run(["--url", "http://localhost:1"], { STUB_NPM: "fail" }, BIN);
  assert.equal(r.rc, 8, r.out);
  assert.match(r.out, /could not install @axe-core\/playwright/);
  assert.equal(existsSync(`${CACHE}.lockdir`), false);
});
test("no flock: a run waits on a held mkdir lock, then installs and releases it", async () => {
  mkdirSync(`${CACHE}.lockdir`);
  clear(NPM_LOG);
  setTimeout(() => rmSync(`${CACHE}.lockdir`, { recursive: true, force: true }), 1500);
  const t0 = Date.now();
  const r = await new Promise<{ rc: number | null; out: string }>((done) => {
    const c = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, "--url", "http://localhost:8813"], {
      env: { ...hermeticEnv(), HOME, PATH: BIN, FAKE_LOG, STUB_NPM_LOG: NPM_LOG, FAKE_SRC },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (rc) => done({ rc, out }));
  });
  assert.equal(r.rc, 0, r.out);
  assert.ok(Date.now() - t0 >= 1000, "it did not wait on the lock");
  assert.equal(read(NPM_LOG), "install --no-save --silent @axe-core/playwright playwright\n");
  assert.equal(existsSync(`${CACHE}.lockdir`), false, "the lock was not released");
  // Back to the cold cache the next test expects.
  rmSync(CACHE, { recursive: true, force: true });
});

let first = { rc: 0 as number | null, out: "" };
test("first run installs and grades → 0", () => {
  clear(NPM_LOG);
  clear(FAKE_LOG);
  first = run(["--url", "http://localhost:8813/", "--pages", "/ /about", "--viewports", "1440,390"]);
  assert.equal(first.rc, 0, first.out);
});
test("deps installed under $HOME/.local/lib/qa-a11y", () =>
  assert.ok(statSync(join(CACHE, "node_modules/@axe-core/playwright")).isDirectory()));
test("one line per page × viewport", () => {
  for (const l of [
    "a11y / @1440: 0 violation(s)",
    "a11y / @390: 0 violation(s)",
    "a11y /about @1440: 0 violation(s)",
    "a11y /about @390: 0 violation(s)",
  ]) {
    assert.ok(first.out.includes(l), `${l} missing from:\n${first.out}`);
  }
});
test("advisory footer", () => assert.ok(first.out.includes("advisory (~57% WCAG coverage) — not a hard gate")));
test("four navigations", () => assert.equal(read(FAKE_LOG).match(/^goto /gm)?.length, 4));
test("trailing slash on base collapsed", () => assert.match(read(FAKE_LOG), /^goto http:\/\/localhost:8813\/about$/m));
test("viewport width from --viewports", () =>
  assert.ok(read(FAKE_LOG).includes('"viewport":{"width":390,"height":1600}'), read(FAKE_LOG)));
test("no auth → no extra headers", () => assert.equal(read(FAKE_LOG).includes("extraHTTPHeaders"), false));

// second run: already installed, npm not called again; violations listed by id
let second = { rc: 0 as number | null, out: "" };
test("violations counted and named, exit still 0 (advisory)", () => {
  clear(FAKE_LOG);
  clear(NPM_LOG);
  second = run(["--url", "http://localhost:8813", "--pages", "/"], { FAKE_VIOLATIONS: '["color-contrast","label"]' });
  assert.equal(second.rc, 0);
  assert.ok(second.out.includes("a11y / @1440: 2 violation(s) [color-contrast, label]"), second.out);
});
test("second run skips the install", () => assert.equal(read(NPM_LOG), ""));
test("no install banner on a warm cache", () => assert.equal(second.out.includes("installing"), false));

// default pages → "/", default viewport → 1440
test("no --pages → / at 1440", () => {
  clear(FAKE_LOG);
  const r = run(["--url", "http://localhost:8813"]);
  assert.equal(r.rc, 0);
  assert.equal(read(FAKE_LOG).match(/^goto /gm)?.length, 1);
  assert.ok(r.out.includes("a11y / @1440:"), r.out);
});

// ── HTTP >= 400 is "not graded"; an error is reported; all-bad → 3 ──
test("403 page not graded, run still 0 because / was", () => {
  const r = run(["--url", "http://localhost:8813", "--pages", "/ /admin"], { FAKE_STATUS: '{"/admin":403}' });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("a11y /admin @1440: error — HTTP 403, not the page; not graded"), r.out);
  assert.ok(r.out.includes("a11y / @1440: 0 violation(s)"), r.out);
});
test("every page 4xx/5xx → 3", () => {
  const r = run(["--url", "http://localhost:8813", "--pages", "/ /admin"], { FAKE_STATUS: '{"/admin":403,"/":500}' });
  assert.equal(r.rc, 3);
  assert.match(r.out, /a11y: no page could be graded/);
});
test("navigation error reported, nothing graded → 3", () => {
  const r = run(["--url", "http://localhost:8813", "--pages", "/"], { FAKE_THROW: "/" });
  assert.equal(r.rc, 3);
  assert.ok(r.out.includes("a11y / @1440: error — boom on /"), r.out);
});

// ── auth: CF-Access pair from op, act-as beside it, never on argv ──
test("auth run → 0", () => {
  clear(FAKE_LOG);
  const r = run(
    [
      "--url",
      "http://localhost:8813",
      "--pages",
      "/",
      "--auth-op-item",
      "item1",
      "--auth-act-as",
      "Someone@Example.com",
    ],
    { STUB_OP: "ok" },
  );
  assert.equal(r.rc, 0, r.out);
});
test("token pair + act-as sent as extraHTTPHeaders", () =>
  assert.ok(
    read(FAKE_LOG).includes(
      '"CF-Access-Client-Id":"ID-1","CF-Access-Client-Secret":"SECRET-1","X-Portal-Act-As":"Someone@Example.com"',
    ),
    read(FAKE_LOG),
  ));
// act-as without a token means nothing and is not sent
test("act-as without token → no header", () => {
  clear(FAKE_LOG);
  run(["--url", "http://localhost:8813", "--pages", "/", "--auth-act-as", "x@y.z"]);
  assert.equal(read(FAKE_LOG).includes("X-Portal-Act-As"), false);
});

// ── the install lock: a held lock is waited on, and an install that finished under it is not repeated ──
// flock(1) holds the lock here; a machine without it (macOS) has the mkdir-lock cases above instead.
const hasFlock = !spawnSync("flock", ["--version"], { stdio: "ignore" }).error;
test("a run waits on a held install lock, then finds the install done and skips npm", { skip: !hasFlock }, async () => {
  // Drop the axe dir so the first check misses, then hold the lock while
  // another "run" finishes the install.
  rmSync(join(CACHE, "node_modules/@axe-core"), { recursive: true, force: true });
  clear(NPM_LOG);
  const ready = join(TMP, "lock-held");
  const holder = spawn(
    "flock",
    [
      "-o",
      `${CACHE}.lock`,
      "sh",
      "-c",
      `touch "${ready}"; sleep 1; mkdir -p "${CACHE}/node_modules/@axe-core" && cp -r "${FAKE_SRC}/@axe-core/playwright" "${CACHE}/node_modules/@axe-core/"`,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => holder.on("exit", r));
  while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  const r = run(["--url", "http://localhost:8813", "--pages", "/"]);
  const waited = Date.now() - t0;
  await exited;
  assert.equal(r.rc, 0, r.out);
  assert.ok(waited >= 500, `returned after ${waited} ms — it did not wait on the lock`);
  assert.equal(read(NPM_LOG), "", "npm ran although the install had finished under the lock");
  assert.equal(r.out.includes("installing"), false, r.out);
});

// ── no item named: the pair from QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET ──
test("the environment's service-token pair becomes the headers", () => {
  clear(FAKE_LOG);
  const r = run(["--url", "http://localhost:8813", "--pages", "/"], {
    QA_CF_ACCESS_ID: "ENV-ID",
    QA_CF_ACCESS_SECRET: "ENV-SECRET",
  });
  assert.equal(r.rc, 0, r.out);
  assert.ok(
    read(FAKE_LOG).includes('"CF-Access-Client-Id":"ENV-ID","CF-Access-Client-Secret":"ENV-SECRET"'),
    read(FAKE_LOG),
  );
});
