#!/usr/bin/env -S node --experimental-strip-types
// Test harness for the act-as path: `qaProbeActsAs` in lib.ts reads the
// person a target's wrangler config lets the Access service token act as, and
// the capture scripts accept `--auth-act-as` to send it as `X-Portal-Act-As`.
// Also the Cloudflare registry lookups (Pages projects, Workers custom domains)
// that resolve a `--live` URL, and the STATUS GATE (exit 9).
//
// Why: an app that treats a service token alone as a machine answers every page
// with "service tokens cannot access this page", and a capture of that is read
// as "only a signed-in person can check this live". The app treats the token as
// the person PROBE_ACTS_AS names when the request carries the header.
//
// lib.ts is a library and is imported; the programs (screenshot.ts,
// interaction-check.ts, serve.ts, a11y.ts) are spawned. The registry lookups
// need wrangler's CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; fake values
// are set below, and QA_CF_API points at a port nothing listens on, so a
// refresh can never reach Cloudflare. A stub `op` is first on PATH, so nothing
// reaches 1Password. The capture checks need a Playwright already on the
// machine (a test never downloads one); without it they are skipped, said.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/probe-acts-as.test.ts
//
// peers: lib.ts, serve.ts, screenshot.ts, interaction-check.ts, interaction-check.browser.ts, a11y.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "qa-act-as-"));
mkdirSync(join(tmp, "bin"));
mkdirSync(join(tmp, "home"));
// The stub `op`: every read fails, except the item the capture scripts'
// --auth-op-item names here (item1), which answers when asked to.
writeFileSync(
  join(tmp, "bin/op"),
  `#!/bin/sh
[ "\${STUB_OP:-}" = "ok" ] || exit 1
case "$*" in
  *"item list"*) echo '[{"id":"item1","title":"probe","vault":{"id":"v1"}}]' ;;
  *"item get item1"*"--fields client_id"*) echo "probe-id" ;;
  *"item get item1"*"--fields client_secret"*) echo "probe-secret" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(tmp, "bin/op"), 0o755);
// Hermetic: a sandbox HOME, no host 1Password settings or service-token pair,
// installs forbidden, and fake Cloudflare credentials with an API base nothing
// answers on. The capture scripts that drive a real browser get the real HOME
// back (the host's Playwright lives under it).
const savedHome = process.env.HOME;
const HERMETIC: Record<string, string | undefined> = {
  OP_CONNECT_HOST: undefined,
  OP_CONNECT_TOKEN: undefined,
  OP_SERVICE_ACCOUNT_TOKEN: undefined,
  QA_CF_ACCESS_ID: undefined,
  QA_CF_ACCESS_SECRET: undefined,
  QA_NO_INSTALL: "1",
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  QA_CF_API: "http://127.0.0.1:9",
};
const savedOp = Object.fromEntries(Object.keys(HERMETIC).map((k) => [k, process.env[k]]));
process.env.HOME = join(tmp, "home");
for (const [k, v] of Object.entries(HERMETIC)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
const {
  qaCfAccountCache,
  qaDeriveLiveUrlFromCf,
  qaDeriveLiveUrlFromWorkers,
  qaPlaywrightNodeModules,
  qaProbeActsAs,
  qaRepoSlug,
  qaTomlValue,
  qaWranglerConfig,
  qaWranglerName,
  qaWranglerRoutes,
} = await import("./lib.ts");
const savedPath = process.env.PATH;
const savedWorkers = process.env.QA_CF_WORKERS_DOMAINS_CACHE;
const savedPages = process.env.QA_CF_PAGES_CACHE;
process.env.PATH = `${join(tmp, "bin")}:${process.env.PATH}`;
process.env.QA_CF_WORKERS_DOMAINS_CACHE = join(tmp, "domains.json");
process.env.QA_CF_PAGES_CACHE = join(tmp, "pages.json");
// The registry keeps each account's copy in its own file; these are test-account's.
const DOMAINS = qaCfAccountCache(process.env.QA_CF_WORKERS_DOMAINS_CACHE);
const PAGES = qaCfAccountCache(process.env.QA_CF_PAGES_CACHE);
after(() => {
  process.env.PATH = savedPath;
  process.env.HOME = savedHome;
  for (const [k, v] of Object.entries(savedOp)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedWorkers === undefined) delete process.env.QA_CF_WORKERS_DOMAINS_CACHE;
  else process.env.QA_CF_WORKERS_DOMAINS_CACHE = savedWorkers;
  if (savedPages === undefined) delete process.env.QA_CF_PAGES_CACHE;
  else process.env.QA_CF_PAGES_CACHE = savedPages;
  rmSync(tmp, { recursive: true, force: true });
  // serve.ts --live wrote its runfile under /tmp/qa-shots/<this fixture's slug>/.
  rmSync(`/tmp/qa-shots/${qaRepoSlug(PORTAL)}`, { recursive: true, force: true });
});

function fixture(dir: string, file: string, body: string): string {
  mkdirSync(join(tmp, dir), { recursive: true });
  writeFileSync(join(tmp, dir, file), body);
  return join(tmp, dir);
}

/** Spawn a program; async, because the header server below lives in this process. */
function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ rc: number | null; out: string; stdout: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SCRIPT_DIR, script), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let out = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (rc) => res({ rc, out, stdout }));
  });
}

// 1. The line shape an app declares.
const PORTAL = fixture(
  "portal",
  "wrangler.toml",
  `name = "portal-example-com"
routes = [{ pattern = "portal.example.com", custom_domain = true }]
[vars]
ACCESS_AUD = "aud1,aud2"
PROBE_ACTS_AS = "0123456789abcdef0123456789abcdef.access someone@example.com"
`,
);
test("toml: the email PROBE_ACTS_AS names", () => assert.equal(qaProbeActsAs(PORTAL), "someone@example.com"));

// 2. A wrangler.jsonc config.
test("jsonc: the email, lower-cased", () => {
  const d = fixture(
    "jsonc",
    "wrangler.jsonc",
    `{
  // comment
  "vars": { "PROBE_ACTS_AS": "probe.access Someone@Example.com" }
}
`,
  );
  assert.equal(qaProbeActsAs(d), "someone@example.com");
});

// 3. No PROBE_ACTS_AS: nothing, so no header is sent.
const PLAIN = fixture("plain", "wrangler.toml", 'name = "site"\n[vars]\nFOO = "bar"\n');
test("no key: empty", () => assert.equal(qaProbeActsAs(PLAIN), ""));

// 4. No wrangler config at all.
mkdirSync(join(tmp, "none"));
const NONE = join(tmp, "none");
test("no config: empty", () => assert.equal(qaProbeActsAs(NONE), ""));

// 5. A value with no email in its second field: empty, never a guess.
test("no email: empty", () =>
  assert.equal(qaProbeActsAs(fixture("bad", "wrangler.toml", 'PROBE_ACTS_AS = "only-a-client-id"\n')), ""));

// 6. Both capture scripts accept the flag: with the other required arguments
//    missing they must stop at usage (exit 2 with "usage:"), not at "unknown flag".
for (const s of ["screenshot.ts", "interaction-check.ts"]) {
  test(`${s}: exit on missing args, and --auth-act-as is a known flag`, async () => {
    const r = await run(s, ["--auth-act-as", "someone@example.com"]);
    assert.equal(r.rc, 2);
    assert.equal(r.out.includes("unknown flag"), false, r.out);
  });
}

// 7. The header is on the wire. A local server records the request headers the
//    capture's browser sends; the token pair is the one qaResolveCfAccess
//    returns for the --auth-op-item the capture was given.
const PW = (() => {
  // The real HOME: the host's Playwright (if any) lives under it.
  process.env.HOME = savedHome;
  try {
    return qaPlaywrightNodeModules() !== undefined;
  } finally {
    process.env.HOME = join(tmp, "home");
  }
})();
if (!PW) process.stdout.write("probe-acts-as: capture checks SKIPPED — no Playwright with an installed chromium\n");
const pwSkip = PW ? false : "no Playwright with an installed chromium";
test("screenshot.ts: the header on the wire, and the status gate on 403/404/500", { skip: pwSkip }, async (t) => {
  let rootHeaders: IncomingHttpHeaders = {};
  const s = createServer((q, r) => {
    if (q.url === "/") rootHeaders = q.headers;
    const code = q.url === "/forbidden" || q.url === "/500" ? 403 : q.url === "/404" ? 404 : 200;
    r.writeHead(code, { "content-type": "text/html" });
    r.end(
      `<!doctype html><title>t</title><main style="padding:40px;font:24px sans-serif;background:#123;color:#fed"><h1>Act-as probe page</h1><p>${"text ".repeat(200)}</p></main>`,
    );
  });
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
  const a = s.address();
  const port = typeof a === "object" && a !== null ? a.port : 0;
  const shots = join(tmp, "shots");
  const common = ["--url", `http://127.0.0.1:${port}`, "--repo-slug", "t", "--viewports", "800", "--no-motion"];
  try {
    const shot = await run(
      "screenshot.ts",
      [...common, "--run-id", "t", "--pages", "/", "--auth-op-item", "item1", "--auth-act-as", "someone@example.com"],
      { STUB_OP: "ok", HOME: savedHome, QA_SHOTS_ROOT: shots },
    );
    // A full-ink 403 is not a page: the status gate refuses it (exit 9). A
    // route that is the error page (/404) is exempt.
    const r403 = await run("screenshot.ts", [...common, "--run-id", "t403", "--pages", "/forbidden"], {
      HOME: savedHome,
      QA_SHOTS_ROOT: shots,
    });
    const r404 = await run("screenshot.ts", [...common, "--run-id", "t404", "--pages", "/404"], {
      HOME: savedHome,
      QA_SHOTS_ROOT: shots,
    });
    const r500 = await run("screenshot.ts", [...common, "--run-id", "t500", "--pages", "/500"], {
      HOME: savedHome,
      QA_SHOTS_ROOT: shots,
    });
    await t.test("screenshot.ts: a 403 route exits 9", () => assert.equal(r403.rc, 9, r403.out));
    await t.test("screenshot.ts: the 403 names act-as", () =>
      assert.equal(r403.out.split("\n").filter((l) => l.includes("auth-act-as")).length, 1),
    );
    await t.test("screenshot.ts: /404 is exempt", () => assert.equal(r404.rc, 0, r404.out));
    await t.test("screenshot.ts: /500 answering 403 is still refused", () => assert.equal(r500.rc, 9, r500.out));
    await t.test("screenshot.ts ran", () => assert.equal(shot.rc, 0, shot.out.split("\n").slice(-5).join("\n")));
    await t.test("the browser sent X-Portal-Act-As", () =>
      assert.equal(rootHeaders["x-portal-act-as"], "someone@example.com"),
    );
    await t.test("beside the token", () => assert.equal(rootHeaders["cf-access-client-id"], "probe-id"));
  } finally {
    s.close();
  }
});

// 8. A Worker-deployed portal's live URL: the Worker name the repo declares,
//    matched against a Workers custom-domain registry answer (the fixture stands
//    in for GET /accounts/<id>/workers/domains, cached where lib.ts caches it).
test("toml: the Worker name", () => assert.equal(qaWranglerName(PORTAL), "portal-example-com"));
test("no config: no Worker name", () => assert.equal(qaWranglerName(NONE), ""));
test("toml: the top-level name, not a table's", () => {
  writeFileSync(join(PLAIN, "wrangler.toml"), 'name = "dash"\n[[d1_databases]]\nname = "NOT_THIS"\n');
  assert.equal(qaWranglerName(PLAIN), "dash");
});
test("workers: the production custom domain", async () => {
  writeFileSync(
    DOMAINS,
    `{"success":true,"result":[
 {"hostname":"other.example.com","service":"other","environment":"production"},
 {"hostname":"staging.portal.example.com","service":"portal-example-com","environment":"staging"},
 {"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}
`,
  );
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), "https://portal.example.com");
});
test("workers: no domain for the service → nothing", async () =>
  assert.equal(await qaDeriveLiveUrlFromWorkers(PLAIN), undefined));

// 9. A commented-out value never wins over the active one.
test("toml: the active line, not the comment", () => {
  const d = fixture(
    "commented",
    "wrangler.toml",
    'name = "p"\n[vars]\n# PROBE_ACTS_AS = "old.access old@example.com"\nPROBE_ACTS_AS = "new.access someone@example.com"\n',
  );
  assert.equal(qaProbeActsAs(d), "someone@example.com");
});

// 10. JSONC as wrangler accepts it: block comments, trailing commas, a // inside a string.
const JSONC2 = fixture(
  "jsonc2",
  "wrangler.jsonc",
  `{
  /* block
     comment */
  "name": "portal-example-com",
  "routes": [{ "pattern": "portal.example.com", "custom_domain": true },],
  "vars": { "DOCS": "https://x.test//y", "PROBE_ACTS_AS": "probe.access SomeOne@example.com", },
}
`,
);
test("jsonc: name through block comments and trailing commas", () =>
  assert.equal(qaWranglerName(JSONC2), "portal-example-com"));
test("jsonc: act-as through the same", () => assert.equal(qaProbeActsAs(JSONC2), "someone@example.com"));
test("jsonc: routes through the same, and a // inside a string survives", () => {
  assert.deepEqual(qaWranglerRoutes(JSONC2), ["portal.example.com"]);
  assert.match(qaWranglerConfig(JSONC2), /"DOCS":"https:\/\/x\.test\/\/y"/);
});

// 11. Several production hostnames: the one the repo declares wins; none declared is ambiguous.
test("workers: the declared route among several", async () => {
  writeFileSync(
    DOMAINS,
    `{"success":true,"result":[
 {"hostname":"www.portal.example.com","service":"portal-example-com","environment":"production"},
 {"hostname":"portal.example.com","service":"portal-example-com","environment":"production"},
 {"hostname":"a.dash.test","service":"dash","environment":"production"},
 {"hostname":"b.dash.test","service":"dash","environment":"production"}]}
`,
  );
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), "https://portal.example.com");
});
test("workers: several and none declared → nothing", async () =>
  assert.equal(await qaDeriveLiveUrlFromWorkers(PLAIN), undefined));

// 12. A failed refresh keeps the last good copy; an error body never counts.
test("workers: stale cache, refresh fails → still resolves", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(DOMAINS, twoDaysAgo, twoDaysAgo);
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), "https://portal.example.com");
});
test("workers: an error body is not a registry", async () => {
  writeFileSync(DOMAINS, '{"success":false,"errors":[{"code":10000}],"result":null}');
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), undefined);
});

// 13. serve.ts --live emits the live URL and the act-as person for a Worker portal.
test("serve.ts --live: the Worker's URL and the act-as person", async (t) => {
  writeFileSync(
    DOMAINS,
    '{"success":true,"result":[{"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}\n',
  );
  writeFileSync(PAGES, '{"success":true,"result":[]}');
  mkdirSync(join(PORTAL, "src/pages"), { recursive: true });
  writeFileSync(join(PORTAL, "src/pages/index.html"), "<h1>x</h1>\n");
  writeFileSync(
    join(PORTAL, "package.json"),
    '{"name":"portal","scripts":{"build":"true"},"devDependencies":{"vite":"1"}}\n',
  );
  const live = await run("serve.ts", ["up", "--repo", PORTAL, "--mode", "live", "--run-id", "t"]);
  await t.test("serve.ts --live: the Worker's URL", () =>
    assert.equal(/^QA_URL=.*$/m.exec(live.stdout)?.[0], "QA_URL=https://portal.example.com", live.out),
  );
  await t.test("serve.ts --live: the act-as person", () =>
    assert.equal(/^QA_AUTH_ACT_AS=.*$/m.exec(live.stdout)?.[0], "QA_AUTH_ACT_AS=someone@example.com", live.out),
  );
});

// 14. ",}" inside a string is text, not a trailing comma.
test("jsonc: a string holding ,} survives", () => {
  const d = fixture(
    "jsonc3",
    "wrangler.jsonc",
    '{\n  "name": "n",\n  "vars": { "NOTE": "a,}b", "PROBE_ACTS_AS": "p.access x@example.com" },\n}\n',
  );
  const cfg: unknown = JSON.parse(qaWranglerConfig(d));
  const note =
    typeof cfg === "object" &&
    cfg !== null &&
    "vars" in cfg &&
    typeof cfg.vars === "object" &&
    cfg.vars !== null &&
    "NOTE" in cfg.vars
      ? cfg.vars.NOTE
      : undefined;
  assert.equal(note, "a,}b");
});
test("jsonc: an invalid config reads as nothing and says so", () => {
  const d = fixture("jsonc-bad", "wrangler.jsonc", '{ "name": ');
  const saved = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  };
  try {
    assert.equal(qaWranglerConfig(d), "");
  } finally {
    process.stderr.write = saved;
  }
  assert.match(err, /qa: .*wrangler\.jsonc is not valid JSON\(C\)/);
});

// 15. A success:true body without a result list is not a registry.
test("workers: success without a result list → nothing", async () => {
  writeFileSync(DOMAINS, '{"success":true,"result":null}');
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), undefined);
});

// 15b. Entries that are not registry entries do not replace a good copy.
test("workers: a good copy resolves", async () => {
  writeFileSync(
    DOMAINS,
    '{"success":true,"result":[{"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}\n',
  );
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), "https://portal.example.com");
});
test("workers: an empty hostname is not an entry", async () => {
  writeFileSync(DOMAINS, '{"success":true,"result":[{"hostname":"","service":"portal-example-com"}]}');
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), undefined);
});
test("workers: success with empty entries → nothing", async () => {
  writeFileSync(DOMAINS, '{"success":true,"result":[{}]}');
  assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), undefined);
});

// 15c. Pages: a project whose domains hold a null is not a registry entry.
test("pages: domains:[null] → nothing", async () => {
  writeFileSync(
    PAGES,
    '{"success":true,"result":[{"name":"x","domains":[null],"source":{"config":{"repo_name":"x"}}}]}',
  );
  assert.equal(await qaDeriveLiveUrlFromCf("x"), undefined);
});
test("pages: a good entry still resolves", async () => {
  writeFileSync(
    PAGES,
    '{"success":true,"result":[{"name":"x","domains":["x.pages.dev","x.test"],"source":{"config":{"repo_name":"x"}}}]}',
  );
  assert.equal(await qaDeriveLiveUrlFromCf("x"), "https://x.test");
});

// 16. a11y.ts takes the same auth flags (usage stop, not "unknown flag").
test("a11y.ts: exit on missing args, and the auth flags are known", async () => {
  const r = await run("a11y.ts", ["--auth-act-as", "someone@example.com", "--auth-op-item", "x"]);
  assert.equal(r.rc, 2);
  assert.equal(r.out.includes("unknown flag"), false, r.out);
});

// TOML literal strings ('…') are as valid as basic ones ("…"): every reader takes both.
const LIT = fixture(
  "lit",
  "wrangler.toml",
  `name = 'lit-worker'
route = { pattern = 'lit.example.com/*', custom_domain = true }
[vars]
PROBE_ACTS_AS = 'probe.access someone@example.com'
`,
);
test("toml literal: the Worker name", () => assert.equal(qaWranglerName(LIT), "lit-worker"));
test("toml literal: the route pattern", () => assert.deepEqual(qaWranglerRoutes(LIT), ["lit.example.com/*"]));
test("toml literal: the email PROBE_ACTS_AS names", () => assert.equal(qaProbeActsAs(LIT), "someone@example.com"));
test("toml: a bare route string", () => {
  writeFileSync(join(LIT, "wrangler.toml"), 'name = "q"\nroute = "plain.example.com/*"\n');
  assert.deepEqual(qaWranglerRoutes(LIT), ["plain.example.com/*"]);
});
test("toml literal: a backslash stays as written", () =>
  assert.equal(qaTomlValue("PROBE_ACTS_AS = 'lit\\\\x someone@example.com'\n"), "lit\\\\x someone@example.com"));
test("toml basic: an apostrophe inside a double-quoted value", () =>
  assert.equal(
    qaTomlValue(`PROBE_ACTS_AS = "probe.access o'brien@example.com"\n`),
    "probe.access o'brien@example.com",
  ));
test("toml: a last line with no final newline", () =>
  assert.equal(qaTomlValue("PROBE_ACTS_AS = 'x.access last@example.com'"), "x.access last@example.com"));
test('toml basic: \\" and \\\\ are unescaped', () =>
  assert.equal(qaTomlValue('K = "a\\"b\\\\c" # trailing'), 'a"b\\c'));

// 17. Without wrangler's credentials there is no registry to ask, even with a
//     good cached copy: the lookup is the user's account or nothing.
test("registry: no credentials → nothing, even from a good cache", async (t) => {
  writeFileSync(
    DOMAINS,
    '{"success":true,"result":[{"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}',
  );
  writeFileSync(
    PAGES,
    '{"success":true,"result":[{"name":"x","domains":["x.test"],"source":{"config":{"repo_name":"x"}}}]}',
  );
  await t.test("workers: with credentials, the cached copy resolves", async () =>
    assert.equal(await qaDeriveLiveUrlFromWorkers(PORTAL), "https://portal.example.com"),
  );
  const unset = async (k: string, f: () => Promise<string | undefined>) => {
    const saved = process.env[k];
    delete process.env[k];
    try {
      return await f();
    } finally {
      process.env[k] = saved;
    }
  };
  await t.test("workers: no CLOUDFLARE_ACCOUNT_ID → nothing", async () =>
    assert.equal(await unset("CLOUDFLARE_ACCOUNT_ID", () => qaDeriveLiveUrlFromWorkers(PORTAL)), undefined),
  );
  await t.test("pages: no CLOUDFLARE_API_TOKEN → nothing", async () =>
    assert.equal(await unset("CLOUDFLARE_API_TOKEN", () => qaDeriveLiveUrlFromCf("x")), undefined),
  );
});
