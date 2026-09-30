#!/usr/bin/env -S node --experimental-strip-types
// impeccable-detect.test.ts — pin impeccable-detect.ts's checked-vs-could-not-
// check contract against a stub `impeccable` on PATH: exit 0 with no output is
// `clean`, exit 0 with output is `clean (advisories only)`, exit 2 lists the
// findings, any other exit is `detector unavailable`; a missing shim goes
// through a stub `npm install -g` and never the network. And the currency
// guard: the installed version against `npm view impeccable version`, an
// upgrade when older (numerically: 4.10.0 is newer than 4.9.0), the
// could-not-check line when npm view fails, a failed upgrade named, and
// QA_NO_INSTALL=1 forbidding every install. The stub records its argv and cwd
// so the call the engine WOULD have received is asserted. The script is
// spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/impeccable-detect.test.ts
//
// peers: ../impeccable-detect.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "impeccable-detect.ts");
const TMP = mkdtempSync(join(tmpdir(), "impeccable-detect-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── stubs ──
// `impeccable`: `--version` answers the version in $STUB_VERSION_FILE (what
// the last stub install wrote) or $STUB_VERSION (default 4.1.0); `detect`
// exits with $STUB_RC, prints $STUB_OUT to stderr (the engine writes findings
// there), and records argv + cwd + CI.
const BIN = join(TMP, "bin");
mkdirSync(BIN);
const STUB = join(BIN, "impeccable");
writeFileSync(
  STUB,
  `#!/bin/sh
if [ "$1" = --version ]; then
  v="\${STUB_VERSION:-4.1.0}"
  [ -n "\${STUB_VERSION_FILE:-}" ] && [ -f "$STUB_VERSION_FILE" ] && read -r v < "$STUB_VERSION_FILE"
  printf 'impeccable v%s\\n' "$v"
  exit 0
fi
printf '%s\\n' "$*" > "$STUB_LOG"
printf 'cwd=%s\\nCI=%s\\n' "$(pwd)" "\${CI:-}" >> "$STUB_LOG"
[ -n "\${STUB_OUT:-}" ] && printf '%s\\n' "$STUB_OUT" >&2
exit "\${STUB_RC:-0}"
`,
);
chmodSync(STUB, 0o755);
// `npm`: `view impeccable version` answers $STUB_LATEST (default 4.1.0) unless
// STUB_VIEW=fail; any other call records its argv (appended to
// $STUB_NPM_CALLS, the last one in $STUB_NPM_LOG) and, on STUB_NPM=ok, drops a
// shim into $INSTALL_BIN and records $STUB_LATEST as the installed version.
const INSTALL_BIN = join(TMP, "installed");
mkdirSync(INSTALL_BIN);
writeFileSync(
  join(BIN, "npm"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_NPM_CALLS"
if [ "$1" = view ]; then
  [ "\${STUB_VIEW:-ok}" = "ok" ] || exit 1
  printf '%s\\n' "\${STUB_LATEST:-4.1.0}"
  exit 0
fi
printf '%s\\n' "$*" > "$STUB_NPM_LOG"
[ "\${STUB_NPM:-fail}" = "ok" ] || exit 1
[ -n "\${STUB_VERSION_FILE:-}" ] && printf '%s\\n' "\${STUB_LATEST:-4.1.0}" > "$STUB_VERSION_FILE"
[ -n "\${STUB_NO_COPY:-}" ] || cp "$STUB_SHIM_SRC" "$INSTALL_BIN/impeccable"
`,
);
chmodSync(join(BIN, "npm"), 0o755);
const STUB_LOG = join(TMP, "impeccable.log");
const STUB_NPM_LOG = join(TMP, "npm.log");
const STUB_NPM_CALLS = join(TMP, "npm-calls.log");
const STUB_VERSION_FILE = join(TMP, "installed-version");

const TARGET = join(TMP, "repo");
mkdirSync(TARGET);
const URL = "http://localhost:8813/";
// PATH with the stub shim first; and, for the "no shim" runs, a PATH that holds
// only what the stubs need — the machine's own impeccable must be unreachable,
// or the install branch never runs. Node itself is spawned by absolute path.
const WITH_SHIM = `${BIN}:/usr/bin:/bin`;
const CORE = join(TMP, "core");
mkdirSync(CORE);
symlinkSync("/bin/cp", join(CORE, "cp"));
symlinkSync(join(BIN, "npm"), join(CORE, "npm"));
const NO_SHIM = `${INSTALL_BIN}:${CORE}`;

function run(args: string[], env: Record<string, string> = {}): { rc: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? TMP,
      STUB_LOG,
      STUB_NPM_LOG,
      STUB_NPM_CALLS,
      INSTALL_BIN,
      STUB_SHIM_SRC: STUB,
      PATH: WITH_SHIM,
      ...env,
    },
  });
  return { rc: r.status, out: (r.stdout + r.stderr).replace(/\n+$/, ""), stdout: r.stdout };
}
const log = (): string => (existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8") : "");

// ── usage ──
test("no args → usage, non-zero", () => {
  const r = run([]);
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("usage: impeccable-detect.ts"), r.out);
});
test("no url → usage, non-zero", () => {
  const r = run([TARGET]);
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("usage:"), r.out);
});

// ── rc 0, silent → clean ──
test("engine 0 + silence → clean", () => {
  const r = run([TARGET, URL], { STUB_RC: "0" });
  assert.equal(r.rc, 0);
  assert.equal(r.out, "impeccable: clean");
});
test("engine called as: detect <url>", () => {
  run([TARGET, URL], { STUB_RC: "0" });
  assert.equal(log().split("\n")[0], `detect ${URL}`);
});
test("engine cwd is the target repo", () => {
  run([TARGET, URL], { STUB_RC: "0" });
  assert.ok(log().split("\n").includes(`cwd=${TARGET}`), log());
});
test("CI=1 in the engine's environment", () => {
  run([TARGET, URL], { STUB_RC: "0" });
  assert.ok(log().split("\n").includes("CI=1"), log());
});

// ── rc 0, output → advisories, listed ──
test("engine 0 + output → advisories listed", () => {
  const r = run([TARGET, URL], { STUB_RC: "0", STUB_OUT: "advisory: text-size 11px" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("advisory: text-size 11px"), r.out);
  assert.ok(r.out.includes("impeccable: clean (advisories only)"), r.out);
});

// ── rc 2 → findings printed, no 'clean', still exit 0 ──
test("engine 2 → findings, neither clean nor unavailable", () => {
  const r = run([TARGET, URL], { STUB_RC: "2", STUB_OUT: "contrast 2.1:1 on .hero" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("contrast 2.1:1"), r.out);
  assert.ok(!r.out.includes("clean") && !r.out.includes("unavailable"), r.out);
});

// ── rc 1 → unavailable, with whatever it said ──
test("engine 1 → unavailable, reason kept", () => {
  const r = run([TARGET, URL], { STUB_RC: "1", STUB_OUT: "could not reach target" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("could not reach target"), r.out);
  assert.ok(r.out.includes("detector unavailable — detect exited 1"), r.out);
});
test("engine 127, silent → unavailable only", () => {
  const r = run([TARGET, URL], { STUB_RC: "127" });
  assert.equal(r.rc, 0);
  assert.equal(r.out, "impeccable: detector unavailable — detect exited 127");
});

// a target that does not exist: the engine never runs
test("missing target → unavailable, engine not invoked", () => {
  writeFileSync(STUB_LOG, "");
  const r = run([join(TMP, "nope"), URL], { STUB_RC: "0" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("detector unavailable"), r.out);
  assert.equal(log(), "");
});

// ── no shim: install path ──
test("no shim + npm fails → unavailable", () => {
  rmSync(join(INSTALL_BIN, "impeccable"), { force: true });
  const r = run([TARGET, URL], { PATH: NO_SHIM, STUB_NPM: "fail" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("shim not on PATH — installing"), r.out);
  assert.ok(r.out.includes("unavailable — npm install -g impeccable@latest failed"), r.out);
});
test("npm called as: install -g impeccable@latest", () => {
  rmSync(join(INSTALL_BIN, "impeccable"), { force: true });
  run([TARGET, URL], { PATH: NO_SHIM, STUB_NPM: "fail" });
  assert.equal(readFileSync(STUB_NPM_LOG, "utf8"), "install -g impeccable@latest\n");
});
test("no shim + npm succeeds → detect runs on the installed shim", () => {
  rmSync(join(INSTALL_BIN, "impeccable"), { force: true });
  const r = run([TARGET, URL], { PATH: NO_SHIM, STUB_NPM: "ok", STUB_RC: "0" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("installing"), r.out);
  assert.equal(r.stdout, "impeccable: clean\n");
});

// ── currency: the installed version against the latest published one ──
const calls = (): string => (existsSync(STUB_NPM_CALLS) ? readFileSync(STUB_NPM_CALLS, "utf8") : "");
function fresh(): void {
  rmSync(STUB_NPM_CALLS, { force: true });
  rmSync(STUB_VERSION_FILE, { force: true });
}
test("current: npm is only asked for the latest version, and the detector runs", () => {
  fresh();
  const r = run([TARGET, URL], { STUB_VERSION: "4.1.0", STUB_LATEST: "4.1.0" });
  assert.equal(r.stdout, "impeccable: clean\n");
  assert.equal(calls(), "view impeccable version\n");
});
test("older: says so, installs the latest, then runs", () => {
  fresh();
  const r = run([TARGET, URL], {
    STUB_VERSION: "4.0.2",
    STUB_LATEST: "4.1.0",
    STUB_NPM: "ok",
    STUB_NO_COPY: "1",
    STUB_VERSION_FILE,
  });
  assert.ok(r.out.includes("impeccable: 4.0.2 is older than the latest 4.1.0 — upgrading"), r.out);
  assert.ok(calls().includes("install -g impeccable@latest"), calls());
  assert.ok(!r.out.includes("upgrade to"), r.out);
  assert.ok(r.out.includes("impeccable: clean"), r.out);
});
test("a numeric compare: 4.10.0 is not older than 4.9.0", () => {
  fresh();
  const r = run([TARGET, URL], { STUB_VERSION: "4.10.0", STUB_LATEST: "4.9.0" });
  assert.ok(!r.out.includes("upgrading"), r.out);
  assert.ok(!calls().includes("install"), calls());
});
test("offline: the latest cannot be read — the installed copy runs, and it says so", () => {
  fresh();
  const r = run([TARGET, URL], { STUB_VERSION: "4.0.2", STUB_VIEW: "fail" });
  assert.ok(
    r.out.includes("impeccable: could not read the latest version (npm view failed) — running 4.0.2"),
    r.out,
  );
  assert.ok(!calls().includes("install"), calls());
  assert.ok(r.out.includes("impeccable: clean"), r.out);
});
test("older and the upgrade fails: the old copy runs, named", () => {
  fresh();
  const r = run([TARGET, URL], { STUB_VERSION: "4.0.2", STUB_LATEST: "4.1.0", STUB_NPM: "fail" });
  assert.ok(r.out.includes("impeccable: upgrade to 4.1.0 failed — running 4.0.2"), r.out);
  assert.ok(r.out.includes("impeccable: clean"), r.out);
});
test("QA_NO_INSTALL=1 + no shim: unavailable, npm install never called", () => {
  fresh();
  rmSync(join(INSTALL_BIN, "impeccable"), { force: true });
  const r = run([TARGET, URL], { PATH: NO_SHIM, QA_NO_INSTALL: "1", STUB_NPM: "ok" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("impeccable: detector unavailable — not installed and QA_NO_INSTALL=1"), r.out);
  assert.ok(!calls().includes("install"), calls());
});
test("QA_NO_INSTALL=1 + older: no upgrade attempted", () => {
  fresh();
  const r = run([TARGET, URL], { STUB_VERSION: "4.0.2", STUB_LATEST: "4.1.0", QA_NO_INSTALL: "1", STUB_NPM: "ok" });
  assert.ok(!calls().includes("install"), calls());
  assert.ok(r.out.includes("impeccable: clean"), r.out);
});

// ── a gated page: the local sign-in rides a loopback proxy ──
// The engine takes no headers, so an app that answers 401 without its local
// Access token is scanned as its 401 page and reported clean. With --auth-jwt-file the engine is pointed at a loopback
// proxy that adds `Cf-Access-Jwt-Assertion` to every request it forwards.
test("--auth-jwt-file scans through a proxy that sends the token", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const seen: (string | undefined)[] = [];
  const app = createServer((req, res) => {
    seen.push(req.headers["cf-access-jwt-assertion"] as string | undefined);
    res.writeHead(req.headers["cf-access-jwt-assertion"] === "tok-123" ? 200 : 401, { "content-type": "text/html" });
    res.end("<html><body>page</body></html>");
  });
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  const port = (app.address() as { port: number }).port;
  const jwt = join(TMP, "access.jwt");
  writeFileSync(jwt, "tok-123\n");
  // A stub engine that fetches the URL it was given, as the real one does.
  const fetchBin = join(TMP, "fetchbin");
  mkdirSync(fetchBin, { recursive: true });
  writeFileSync(
    join(fetchBin, "impeccable"),
    `#!/bin/sh\ncurl -s -o /dev/null -w '%{http_code}' "$2" > "$STUB_LOG"\nprintf '\\nurl=%s\\n' "$2" >> "$STUB_LOG"\n`,
  );
  chmodSync(join(fetchBin, "impeccable"), 0o755);
  // A stub npm: the currency check must never reach the registry from a test.
  writeFileSync(join(fetchBin, "npm"), "#!/bin/sh\n[ \"$1\" = view ] && echo 0.0.0\nexit 0\n");
  chmodSync(join(fetchBin, "npm"), 0o755);
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      SCRIPT,
      TARGET,
      `http://127.0.0.1:${port}/operations/x?week=1`,
      "--auth-jwt-file",
      jwt,
    ],
    { env: { HOME: process.env.HOME ?? TMP, STUB_LOG, PATH: `${fetchBin}:/usr/bin:/bin` } },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  await new Promise((ok) => child.on("close", ok));
  app.close();
  const lines = log().split("\n");
  assert.equal(lines[0], "200", `the engine saw ${lines[0]}; the app saw ${JSON.stringify(seen)}`);
  assert.ok(
    seen.every((h) => h === "tok-123"),
    JSON.stringify(seen),
  );
  assert.match(lines[1] ?? "", /^url=http:\/\/127\.0\.0\.1:\d+\/operations\/x\?week=1$/);
  assert.notEqual(
    lines[1],
    `url=http://127.0.0.1:${port}/operations/x?week=1`,
    "scanned the app directly, not the proxy",
  );
  assert.equal(stdout, "impeccable: clean\n");
});

test("--auth-jwt-file naming no readable token → unavailable, engine not invoked", () => {
  writeFileSync(STUB_LOG, "");
  const r = run([TARGET, URL, "--auth-jwt-file", join(TMP, "missing.jwt")], { STUB_RC: "0" });
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("detector unavailable"), r.out);
  assert.equal(log(), "");
});

// Review of the proxy: a signed-in scan that did not reach the page is a
// could-not-check, never `clean`; and a same-origin redirect keeps the token.
async function viaProxy(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, port: number) => void,
  token = "tok-123",
  path = "/page",
): Promise<{ stdout: string; seen: (string | undefined)[]; rc: number | null }> {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const seen: (string | undefined)[] = [];
  let port = 0;
  const app = createServer((req, res) => {
    seen.push(req.headers["cf-access-jwt-assertion"] as string | undefined);
    handler(req, res, port);
  });
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  port = (app.address() as { port: number }).port;
  const jwt = join(TMP, "access2.jwt");
  writeFileSync(jwt, `${token}\n`);
  const fetchBin = join(TMP, "fetchbin2");
  mkdirSync(fetchBin, { recursive: true });
  writeFileSync(join(fetchBin, "impeccable"), `#!/bin/sh\ncurl -s -L -o /dev/null "$2"\nexit 0\n`);
  chmodSync(join(fetchBin, "impeccable"), 0o755);
  // A stub npm: the currency check must never reach the registry from a test.
  writeFileSync(join(fetchBin, "npm"), "#!/bin/sh\n[ \"$1\" = view ] && echo 0.0.0\nexit 0\n");
  chmodSync(join(fetchBin, "npm"), 0o755);
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", SCRIPT, TARGET, `http://127.0.0.1:${port}${path}`, "--auth-jwt-file", jwt],
    { env: { HOME: process.env.HOME ?? TMP, PATH: `${fetchBin}:/usr/bin:/bin` } },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const rc = await new Promise<number | null>((ok) => child.on("close", (code) => ok(code)));
  app.close();
  return { stdout, seen, rc };
}

test("a signed-in scan whose page answers 401 is unavailable, not clean", async () => {
  const { stdout } = await viaProxy((_req, res) => {
    res.writeHead(401);
    res.end("no");
  });
  assert.match(stdout, /detector unavailable — the page answered 401/);
});

test("a signed-in scan of an app that is not up is unavailable, not clean", async () => {
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const dead = (probe.address() as { port: number }).port;
  probe.close();
  const jwt = join(TMP, "access3.jwt");
  writeFileSync(jwt, "tok\n");
  const fetchBin = join(TMP, "fetchbin2");
  mkdirSync(fetchBin, { recursive: true });
  writeFileSync(join(fetchBin, "impeccable"), `#!/bin/sh\ncurl -s -o /dev/null "$2"\nexit 0\n`);
  chmodSync(join(fetchBin, "impeccable"), 0o755);
  // A stub npm: the currency check must never reach the registry from a test.
  writeFileSync(join(fetchBin, "npm"), "#!/bin/sh\n[ \"$1\" = view ] && echo 0.0.0\nexit 0\n");
  chmodSync(join(fetchBin, "npm"), 0o755);
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SCRIPT, TARGET, `http://127.0.0.1:${dead}/page`, "--auth-jwt-file", jwt],
    { encoding: "utf8", env: { HOME: process.env.HOME ?? TMP, PATH: `${fetchBin}:/usr/bin:/bin` } },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /detector unavailable/);
});

test("a same-origin absolute redirect goes back through the proxy and keeps the token", async () => {
  const { stdout, seen } = await viaProxy((req, res, port) => {
    if (req.url === "/page") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
      res.end();
      return;
    }
    res.writeHead(req.headers["cf-access-jwt-assertion"] === "tok-123" ? 200 : 401, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  assert.deepEqual(seen, ["tok-123", "tok-123"]);
  assert.equal(stdout, "impeccable: clean\n");
});

test("a relative redirect is followed to where the page landed, not called unavailable", async () => {
  const { stdout, seen } = await viaProxy(
    (req, res) => {
      if (req.url === "/a/page") {
        res.writeHead(302, { location: "landed?x=1#top" });
        res.end();
        return;
      }
      res.writeHead(req.url === "/a/landed?x=1" ? 200 : 404, { "content-type": "text/html" });
      res.end("<html></html>");
    },
    "tok-123",
    "/a/page",
  );
  assert.deepEqual(seen, ["tok-123", "tok-123"]);
  assert.equal(stdout, "impeccable: clean\n");
});

test("a malformed redirect is could-not-check, and the script still exits 0 with a status line", async () => {
  const { stdout, rc } = await viaProxy((req, res) => {
    res.writeHead(302, { location: "http://[" });
    res.end();
  });
  assert.equal(rc, 0);
  assert.match(stdout, /detector unavailable — the page redirected to an unreadable location/);
});

test("a protocol-relative same-origin redirect keeps the token", async () => {
  const { stdout, seen } = await viaProxy((req, res, port) => {
    if (req.url === "/page") {
      res.writeHead(302, { location: `//127.0.0.1:${port}/landed` });
      res.end();
      return;
    }
    res.writeHead(req.headers["cf-access-jwt-assertion"] === "tok-123" ? 200 : 401, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  assert.deepEqual(seen, ["tok-123", "tok-123"]);
  assert.equal(stdout, "impeccable: clean\n");
});
