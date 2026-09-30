#!/usr/bin/env -S node --experimental-strip-types
// impeccable-detect.ts — run the design detector against a rendered page.
//
// Called from step-2.6 and again from step-2.7 after fixes. It exists as a
// script rather than as a shell block quoted twice in SKILL.md because the
// install guard below is a fact, and a fact copied into two prose blocks drifts
// (one fact, one file).
//
// WHAT IT RUNS. The npm shim on PATH (`impeccable`), not `npx --yes
// impeccable@latest` and not the arch-specific engine binary. The shim resolves
// the platform engine itself; hardcoding an arch directory would make this file
// responsible for a path it would then have to keep correct.
//
// CURRENCY. Impeccable's rules move, and a stale copy stops learning what they
// learn. So before each run this compares the installed version
// (`impeccable --version`) with the latest published one (`npm view impeccable
// version`) and runs `npm install -g impeccable@latest` when the copy is
// missing OR older. Not `npx impeccable@latest`: that re-downloads the package
// on every invocation. Offline, the installed copy runs and the line says the
// check could not happen. A failed upgrade runs the installed copy and says so;
// a failed first install is `detector unavailable`. QA_NO_INSTALL=1 forbids
// installing (CI, offline machines).
//
// ONE ARTIFACT. The engine that scans the page is resolved by the shim out of
// the CLI package (`require.resolve("@impeccable/cli-<platform>")`). Never run
// the package's own `install` verb: it writes skill folders, hook manifests and
// subagents into every harness home. Impeccable is a tool here, not a skill;
// this script touches only the npm package.
//
// CHECKED vs COULD-NOT-CHECK. The detector has never been a gate and still is
// not — a crash must not fail a QA run. But "scanned, found nothing" and "never
// ran" used to print as the same silence, which is the actual defect: a broken
// install read exactly like a clean page. This prints `impeccable: clean` only
// when the engine ran and returned nothing, and `impeccable: detector
// unavailable — <reason>` on every path where it did not run.
//
// A GATED PAGE. The engine sends no headers, so an app that answers 401
// without its local Access token is scanned as its 401 page and reported
// clean. `--auth-jwt-file <path>` — the QA_AUTH_JWT_FILE serve.ts writes —
// points the engine at a loopback proxy that adds `Cf-Access-Jwt-Assertion` to
// every request it forwards to the page's origin. The proxy listens on loopback
// and forwards to loopback, which is the only place such an app should trust a
// locally signed token.
//
// Usage: impeccable-detect.ts <target-repo> <url> [--auth-jwt-file <path>]
// Exit: always 0 — the caller is a non-gating step (1 on a usage error).

import { spawn, spawnSync } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { accessSync, closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jwtAt = argv.indexOf("--auth-jwt-file");
  const JWT_FILE = jwtAt >= 0 ? (argv[jwtAt + 1] ?? "") : null;
  const positional = jwtAt >= 0 ? [...argv.slice(0, jwtAt), ...argv.slice(jwtAt + 2)] : argv;
  const [TARGET = "", URL = ""] = positional;
  if (!TARGET || !URL || JWT_FILE === "") {
    process.stderr.write("usage: impeccable-detect.ts <target-repo> <url> [--auth-jwt-file <path>]\n");
    exit(1);
  }

  function unavailable(reason: string): never {
    process.stdout.write(`impeccable: detector unavailable — ${reason}\n`);
    exit(0);
  }

  /** `command -v NAME`: an executable regular file of that name on PATH. */
  function onPath(name: string): boolean {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = join(dir || ".", name);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return true;
      } catch {
        // not here; keep looking
      }
    }
    return false;
  }

  /** The last `n` lines of `text`, as `tail -n` prints them. */
  const tail = (text: string, n: number): string => `${text.split("\n").slice(-n).join("\n")}\n`;

  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  /** The installed shim's version (`impeccable --version`, first number run), or "". */
  const installedVersion = (): string => {
    const r = spawnSync("impeccable", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = (r.stdout ?? "").split("\n")[0] ?? "";
    return /[0-9]+(?:\.[0-9]+)*/.exec(first)?.[0] ?? "";
  };

  /** `npm install -g impeccable@latest`, unless QA_NO_INSTALL=1 or there is no npm; true when it succeeded. */
  const installLatest = (): boolean => {
    if (process.env.QA_NO_INSTALL === "1" || !onPath("npm")) return false;
    const npm = spawnSync("npm", ["install", "-g", "impeccable@latest"], { stdio: ["inherit", 2, 2] });
    return npm.status === 0;
  };

  // ── The shim ──────────────────────────────────────────────────────────────
  // Missing shim is the fresh-machine bootstrap case: nothing is installed at all.
  const view = onPath("npm")
    ? spawnSync("npm", ["view", "impeccable", "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    : undefined;
  const latest =
    view && !view.error && view.status === 0 ? ((view.stdout ?? "").trim().split("\n").pop() ?? "").trim() : "";
  if (!onPath("impeccable")) {
    if (process.env.QA_NO_INSTALL === "1") unavailable("not installed and QA_NO_INSTALL=1");
    process.stderr.write("impeccable: shim not on PATH — installing\n");
    if (!installLatest()) unavailable("npm install -g impeccable@latest failed");
    if (!onPath("impeccable")) unavailable("npm install succeeded but no impeccable on PATH");
  } else {
    const have = installedVersion();
    if (latest === "") {
      process.stdout.write(
        `impeccable: could not read the latest version (npm view failed) — running ${have || "the installed copy"}\n`,
      );
    } else if (have !== "" && semverLt(have, latest)) {
      process.stdout.write(`impeccable: ${have} is older than the latest ${latest} — upgrading\n`);
      if (!installLatest() || semverLt(installedVersion(), latest)) {
        process.stdout.write(`impeccable: upgrade to ${latest} failed — running ${installedVersion()}\n`);
      }
    }
  }

  // ── Detect ────────────────────────────────────────────────────────────────
  // cwd = target repo so its .impeccable ignore config (read from cwd) applies.
  // CI=1 passes --no-sandbox — hosts that block Chrome's sandbox (containers, some
  // Linux servers) abort the browser engine on launch without it.
  //
  // stdout and stderr share one file because the engine writes human-readable
  // findings to STDERR, keeping stdout free for --json. Dropping stderr here
  // would throw away every finding and print a confident empty result.
  let out = "";
  let rc: number;
  let token: string | null = null;
  if (JWT_FILE !== null) {
    try {
      token = readFileSync(JWT_FILE, "utf8").trim();
    } catch {
      token = "";
    }
    if (!token) unavailable(`no sign-in token readable at ${JWT_FILE}`);
  }
  if (!isDir(TARGET)) {
    // The engine never runs when the target cannot be entered — the shell's
    // failed `cd` — and that is a could-not-check, not a clean page.
    process.stderr.write(`impeccable-detect: cd: ${TARGET}: No such file or directory\n`);
    rc = 1;
  } else {
    const scratch = mkdtempSync(join(tmpdir(), "impeccable-detect-"));
    const file = join(scratch, "out");
    const fd = openSync(file, "w");
    let scanUrl = URL;
    let proxy: SignedInProxy | null = null;
    if (token !== null) {
      const origin = new globalThis.URL(URL);
      try {
        proxy = await signedInProxy(origin, token);
      } catch (e) {
        closeSync(fd);
        rmSync(scratch, { recursive: true, force: true });
        unavailable(`the signed-in proxy could not start: ${e instanceof Error ? e.message : String(e)}`);
      }
      const port = (proxy.server.address() as { port: number }).port;
      scanUrl = `http://127.0.0.1:${port}${origin.pathname}${origin.search}`;
    }
    // Asynchronous, so the proxy on this event loop can answer the engine.
    const run = await new Promise<{ status: number | null; error?: NodeJS.ErrnoException }>((done) => {
      const child = spawn("impeccable", ["detect", scanUrl], {
        cwd: TARGET,
        env: { ...process.env, CI: "1" },
        stdio: ["inherit", fd, fd],
      });
      child.on("error", (error) => done({ status: null, error }));
      child.on("close", (status) => done({ status }));
    });
    proxy?.server.close();
    // Through the proxy, a scan that never reached the page read an error page
    // or nothing: that is a could-not-check whatever the engine exited with.
    const page = proxy ? proxy.page() : null;
    if (proxy && (typeof page !== "number" || page >= 400)) {
      closeSync(fd);
      rmSync(scratch, { recursive: true, force: true });
      unavailable(
        page === null
          ? "the engine never fetched the page through the signed-in proxy"
          : page === "unreachable"
            ? "the app did not answer through the signed-in proxy"
            : page === "bad-redirect"
              ? "the page redirected to an unreadable location"
              : `the page answered ${page} through the signed-in proxy`,
      );
    }
    closeSync(fd);
    out = readFileSync(file, "utf8").replace(/\n+$/, "");
    rmSync(scratch, { recursive: true, force: true });
    // A spawn that never started reads as the shell's 127 (not found) / 126.
    rc = run.status ?? (run.error?.code === "ENOENT" ? 127 : 126);
  }
  const said = out.replace(/\s/g, "") !== "";

  // The exit codes, measured against the engine rather than taken from --help,
  // which documents only 0 and 1:
  //
  //   0  scanned, no primary findings
  //   1  a requested target could not be scanned
  //   2  scanned, FOUND anti-patterns          ← not documented, and non-zero
  //
  // That third one is why this is a switch and not `if (rc !== 0)`. Treating
  // every non-zero as a failure reports real contrast and text-size findings as
  // "detector unavailable" — the exact inversion this script exists to prevent,
  // and worse than silence.
  switch (rc) {
    case 0:
      if (!said) {
        process.stdout.write("impeccable: clean\n");
      } else {
        // Advisory-only findings land here: listed, never counted, exit stays 0.
        process.stdout.write(tail(out, 80));
        process.stdout.write("impeccable: clean (advisories only)\n");
      }
      break;
    case 2:
      process.stdout.write(tail(out, 80));
      break;
    default:
      if (said) process.stdout.write(tail(out, 80));
      unavailable(`detect exited ${rc}`);
  }
  exit(0);
}

/**
 * True when version `a` is older than `b`. Numeric per field (4.10.0 is newer
 * than 4.9.0); a pre-release or build suffix is ignored.
 */
function semverLt(a: string, b: string): boolean {
  const parts = (v: string) =>
    (v.split(/[-+]/)[0] ?? "").split(".").map((x) => Number.parseInt(x.replace(/[^0-9]/g, "") || "0", 10));
  const av = parts(a);
  const bv = parts(b);
  for (let i = 0; i < 3; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

interface SignedInProxy {
  server: Server;
  /**
   * What the scanned page answered through the proxy: its HTTP status, following
   * a same-origin redirect to where it landed; "unreachable" when the app did
   * not answer; null when the engine never asked for it.
   */
  page(): number | "unreachable" | "bad-redirect" | null;
}

/**
 * A loopback server forwarding every request to `origin` with the local Access
 * token added. A same-origin absolute `Location` is rewritten to the proxy, so
 * a redirect does not leave it and lose the token.
 */
function signedInProxy(origin: URL, token: string): Promise<SignedInProxy> {
  let expected = `${origin.pathname}${origin.search}`;
  let page: number | "unreachable" | "bad-redirect" | null = null;
  let self = "";
  const server = createServer((req, res) => {
    const isPage = req.url === expected;
    const upstream = request(
      {
        host: origin.hostname,
        port: origin.port || 80,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: origin.host, "cf-access-jwt-assertion": token },
      },
      (answer) => {
        const status = answer.statusCode ?? 502;
        const headers = { ...answer.headers };
        const location = typeof headers.location === "string" ? headers.location : null;
        // Parsed once, against the request, so `landed`, `/landed`,
        // `//host/landed` and an absolute URL are one comparison; a Location
        // that cannot be parsed is passed through as it came.
        let next: URL | null = null;
        if (location) {
          try {
            next = new globalThis.URL(location, `${origin.origin}${req.url ?? "/"}`);
          } catch {
            next = null;
          }
        }
        if (next && next.origin === origin.origin)
          headers.location = `${self}${next.pathname}${next.search}${next.hash}`;
        if (isPage) {
          if (status >= 300 && status < 400 && location) {
            // The fragment never reaches a server, so it is not part of the next request.
            if (!next) page = "bad-redirect";
            else expected = next.origin === origin.origin ? `${next.pathname}${next.search}` : next.href;
          } else page = status;
        }
        res.writeHead(status, headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (isPage) page = "unreachable";
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((ready, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      self = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      ready({ server, page: () => page });
    });
  });
}

await runToExit(main);
