#!/usr/bin/env -S node --experimental-strip-types
// interaction-check.test.ts — interaction-check.ts, the wrapper: its usage
// exits, the missing-Playwright exit, the CF-Access + act-as headers it hands
// the browser, the browser module's verdict passed through as its own exit, and
// the stamp a clean run with --repo writes — the one mark-qa-done.ts --tree
// refuses a served app without. What the browser module judges on each page is
// interaction-check.browser.test.ts's. The wrapper is spawned, never imported.
//
// The browser cases need a Playwright with an installed chromium (the same one
// screenshot.ts uses); without it they report SKIP rather than a pass. A test
// never downloads a browser: QA_NO_INSTALL=1 keeps the first-use install off.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/interaction-check.test.ts
//
// peers:
//   .agents/skills/qa/scripts/interaction-check.ts
//   .agents/skills/qa/scripts/interaction-check.browser.ts
//   .agents/skills/qa/scripts/mark-qa-done.ts

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaPlaywrightNodeModules } from "../lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(HERE, "..");
const SCRIPT = join(SCRIPT_DIR, "interaction-check.ts");
const MARK = join(SCRIPT_DIR, "mark-qa-done.ts");
const CODE_REVIEW = join(SCRIPT_DIR, "../../review/code-review.ts");
const SITE = join(HERE, "fixtures", "interaction-site");

process.env.QA_NO_INSTALL = "1";
const SKIP = qaPlaywrightNodeModules() === undefined ? "no Playwright with an installed chromium" : false;
if (SKIP) process.stdout.write("interaction-check.test.ts: SKIP — no Playwright with an installed chromium\n");

const TMP = mkdtempSync(join(tmpdir(), "interaction-check-test-"));
const BIN = join(TMP, "bin");
mkdirSync(BIN);
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
chmodSync(join(BIN, "op"), 0o755);

function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
): Promise<{ rc: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
      env: { ...hermeticEnv(), PATH: `${BIN}:${process.env.PATH}`, ...env },
      cwd,
    });
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

after(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * process.env without the host's 1Password settings and service-token pair,
 * installs forbidden. HOME stays real here because the browser cases need the
 * host's Playwright; the `--auth-op-item item1` cases go through the stub `op`.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, QA_NO_INSTALL: "1" };
  for (const k of ["OP_CONNECT_HOST", "OP_CONNECT_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN", "QA_CF_ACCESS_ID", "QA_CF_ACCESS_SECRET"])
    delete e[k];
  return e;
}

// ── usage and refusals: no browser needed ──
test("no --url → 2 with usage", async () => {
  const r = await run(SCRIPT, ["--pages", "/"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage: interaction-check\.ts/);
});
test("blank --pages → 2", async () => assert.equal((await run(SCRIPT, ["--url", "http://x", "--pages", "  "])).rc, 2));
test("unknown flag → 2", async () => {
  const r = await run(SCRIPT, ["--url", "http://x", "--pages", "/", "--bogus", "1"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /interaction-check: unknown flag: --bogus/);
});
test("--auth-op-item unresolved → 2", async () => {
  const r = await run(SCRIPT, ["--url", "http://x", "--pages", "/", "--auth-op-item", "item1"], { STUB_OP: "fail" });
  assert.equal(r.rc, 2);
  assert.match(r.out, /service token unresolved from 1Password item item1/);
});
test("no Playwright, and installing one forbidden → 7, said plainly", async () => {
  const empty = join(TMP, "empty");
  mkdirSync(join(empty, "home"), { recursive: true });
  const r = await run(SCRIPT, ["--url", "http://x", "--pages", "/"], {
    PATH: BIN,
    HOME: join(empty, "home"),
    PLAYWRIGHT_BROWSERS_PATH: empty,
  });
  assert.equal(r.rc, 7);
  assert.match(r.out, /qa: skipped — Playwright unavailable \(see the line above\); no interaction check ran/);
});

// ── through a real browser ──
describe("interaction-check.ts with a browser", { skip: SKIP }, () => {
  let PORT = 0;
  let server: ChildProcess | undefined;
  const base = () => `http://127.0.0.1:${PORT}`;
  before(async () => {
    PORT = await freePort();
    const log = openSync(join(TMP, "server.log"), "w");
    server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
      cwd: SITE,
      stdio: ["ignore", "ignore", log],
    });
    closeSync(log);
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base()}/good/`)).ok) break;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  after(() => server?.kill());

  test("a clean page → 0, the browser's verdict passed through", async () => {
    const r = await run(SCRIPT, ["--url", base(), "--pages", "/good/"]);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^interaction: 1 route\(s\)/m);
  });
  test("a finding → 9, with the browser's INTERACTION line", async () => {
    const r = await run(SCRIPT, ["--url", base(), "--pages", "/silent/"]);
    assert.equal(r.rc, 9, r.out);
    assert.match(r.out, /INTERACTION \/silent\/ no-feedback/);
  });
  test("a route that does not load → 1", async () =>
    assert.equal((await run(SCRIPT, ["--url", "http://127.0.0.1:1", "--pages", "/"])).rc, 1));
  test("without --repo nothing is stamped", async () => {
    const done = join(TMP, "done-none");
    const r = await run(SCRIPT, ["--url", base(), "--pages", "/good/"], { QA_DONE_DIR: done });
    assert.equal(r.rc, 0, r.out);
    assert.equal(existsSync(done), false);
  });

  // ── mark-qa-done --tree refuses a served app until the check passes on that tree ──
  describe("the stamp mark-qa-done.ts --tree reads", () => {
    const APP = join(TMP, "app");
    const DONE = join(TMP, "done");
    const git = (...a: string[]) => execFileSync("git", ["-C", APP, ...a], { encoding: "utf8" });
    const snapshot = () =>
      execFileSync(process.execPath, ["--experimental-strip-types", CODE_REVIEW, "--snapshot"], {
        cwd: APP,
        encoding: "utf8",
      }).trim();
    let TREE = "";
    before(() => {
      mkdirSync(APP);
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      copyFileSync(join(SITE, "good/index.html"), join(APP, "index.html"));
      git("add", "-A");
      git("commit", "-qm", "app");
      TREE = snapshot();
    });
    test("refused before the check", async () =>
      assert.equal((await run(MARK, ["--tree", TREE, APP], { QA_DONE_DIR: DONE })).rc, 3));
    test("the check passed and stamped", async () => {
      const r = await run(SCRIPT, ["--url", base(), "--pages", "/good/", "--repo", APP], { QA_DONE_DIR: DONE });
      assert.equal(r.rc, 0, r.out);
      assert.match(r.out, new RegExp(`^interaction: stamped interaction-app-[0-9]+-${TREE}$`, "m"));
    });
    test("marked after the check", async () =>
      assert.equal((await run(MARK, ["--tree", TREE, APP], { QA_DONE_DIR: DONE })).rc, 0));
    test("an edit after the check needs the check again", async () => {
      appendFileSync(join(APP, "index.html"), "change\n");
      const tree2 = snapshot();
      assert.notEqual(tree2, TREE);
      assert.equal((await run(MARK, ["--tree", tree2, APP], { QA_DONE_DIR: DONE })).rc, 3);
    });
  });

  // ── the probe token and the person it acts as reach the page ──
  describe("CF-Access + act-as headers", () => {
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
    test("the token pair from op and X-Portal-Act-As are sent on every request", async () => {
      seen = [];
      const r = await run(
        SCRIPT,
        [
          "--url",
          `http://127.0.0.1:${port}`,
          "--pages",
          "/",
          "--auth-op-item",
          "item1",
          "--auth-act-as",
          "someone@example.com",
        ],
        { STUB_OP: "ok" },
      );
      assert.equal(r.rc, 0, r.out);
      assert.ok(seen.length > 0);
      for (const h of seen) {
        assert.equal(h["cf-access-client-id"], "ID-1");
        assert.equal(h["cf-access-client-secret"], "SECRET-1");
        assert.equal(h["x-portal-act-as"], "someone@example.com");
      }
    });
    test("act-as without a token is not sent", async () => {
      seen = [];
      const r = await run(SCRIPT, [
        "--url",
        `http://127.0.0.1:${port}`,
        "--pages",
        "/",
        "--auth-act-as",
        "someone@example.com",
      ]);
      assert.equal(r.rc, 0, r.out);
      assert.ok(seen.length > 0);
      assert.ok(seen.every((h) => h["x-portal-act-as"] === undefined));
    });
  });
});
