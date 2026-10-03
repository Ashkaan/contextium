#!/usr/bin/env -S node --experimental-strip-types
// lib.test.ts — pin the two pure helpers: route-slug + page resolution, and
// the Playwright lookup that honours an app's own copy and falls back to
// ensure-playwright.ts; and the local-run helpers: a wrangler config's vars,
// the stand-in Access token, and the headers it becomes.
// Fixture-free apart from throwaway files, no server needed.
//
// lib.ts is a LIBRARY (every qa program imports it), so it is imported here.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/lib.test.ts
//
// peers: ../lib.ts, ../ensure-playwright.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cksum,
  qaAccessHeaders,
  qaAccessIssuer,
  qaCfAccountCache,
  qaD1Migrations,
  qaEnvCfAccess,
  qaIsGoodRegistry,
  qaLocalAccess,
  qaPlaywrightNodeModules,
  qaReadJwtFile,
  qaResolvePages,
  qaSlugRoute,
  qaWranglerVar,
} from "../lib.ts";

// ── qaSlugRoute ──
test("slug root", () => assert.equal(qaSlugRoute("/"), "index"));
test("slug empty", () => assert.equal(qaSlugRoute(""), "index"));
test("slug plain", () => assert.equal(qaSlugRoute("projects"), "projects"));
test("slug leading-sl", () => assert.equal(qaSlugRoute("/apps"), "apps"));
test("slug nested", () => assert.equal(qaSlugRoute("/foo/bar"), "foo_bar"));
test("slug query", () => assert.equal(qaSlugRoute("/a?b=1"), "a_b_1"));
// distinct queries → distinct slugs (collision-free)
test("slug distinct-queries", () => assert.notEqual(qaSlugRoute("/a?b=1"), qaSlugRoute("/a?b=2")));
// length cap at 60
test("slug length-cap", () => assert.ok(qaSlugRoute(`/${"x".repeat(80)}`).length <= 60));

// ── qaResolvePages ──
test("pages explicit", () => assert.equal(qaResolvePages("a b", "x y"), "a b"));
test("pages config", () => assert.equal(qaResolvePages("", "x y"), "x y"));
test("pages default", () => assert.equal(qaResolvePages("", ""), "/"));
test("pages ws-only", () => assert.equal(qaResolvePages("   ", ""), "/"));

// ── cksum: the number POSIX cksum prints, which every slug and marker key was written with ──
test("cksum of empty input is 4294967295 (the change-set key of a clean tree)", () =>
  assert.equal(cksum(""), "4294967295"));
test("cksum matches POSIX cksum on a path", () => assert.equal(cksum("/tmp/foo/bar"), "3528597843"));

// ── qaPlaywrightNodeModules(app): the app's own Playwright counts ──
// A PATH with no npm, an empty HOME, an empty first-use cache with installs
// forbidden, and a browser cache holding only the app's revision — so no copy
// on the machine qualifies, and only the app's can.
const TMPL = realpathSync(mkdtempSync(join(tmpdir(), "qa-lib-test-")));
after(() => rmSync(TMPL, { recursive: true, force: true }));
for (const d of [
  "bin",
  "home",
  "browsers/chromium-9999",
  "repo/.git",
  "repo/apps/site",
  "repo/node_modules/playwright-core",
  "repo/node_modules/playwright",
]) {
  mkdirSync(join(TMPL, d), { recursive: true });
}
writeFileSync(
  join(TMPL, "repo/node_modules/playwright-core/browsers.json"),
  '{"browsers":[{"name":"chromium","revision":"9999"}]}\n',
);
writeFileSync(join(TMPL, "browsers/chromium-9999/INSTALLATION_COMPLETE"), "");

function pwLookup(app?: string): string {
  return lookup(app, {
    PATH: join(TMPL, "bin"),
    HOME: join(TMPL, "home"),
    PLAYWRIGHT_BROWSERS_PATH: join(TMPL, "browsers"),
    QA_PLAYWRIGHT_DIR: join(TMPL, "empty"),
    QA_NO_INSTALL: "1",
  }).out;
}

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib.ts");
/**
 * qaPlaywrightNodeModules(app) in a child under `env`, so the skip line
 * ensure-playwright.ts writes to the inherited stderr is captured too.
 */
function lookup(app: string | undefined, env: NodeJS.ProcessEnv): { out: string; err: string } {
  const code = `import { qaPlaywrightNodeModules } from ${JSON.stringify(LIB)};
process.stdout.write(qaPlaywrightNodeModules(${JSON.stringify(app ?? "")}) ?? "");`;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", code],
    { encoding: "utf8", env },
  );
  return { out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("an app's own (hoisted) Playwright is found", () =>
  assert.equal(pwLookup(join(TMPL, "repo/apps/site")), join(TMPL, "repo/node_modules")));
test("without the app, it is not looked at", () => assert.equal(pwLookup(), ""));

// ── no copy on the machine → ensure-playwright.ts ──
// A fake module whose "browser" exists, in the first-use cache and in an app
// that has no browsers.json (so only ensure-playwright.ts --app can see it).
function fakePw(nm: string): void {
  mkdirSync(join(nm, "playwright"), { recursive: true });
  writeFileSync(join(nm, "playwright/package.json"), '{"name":"playwright","version":"0.0.0","main":"index.js"}\n');
  writeFileSync(
    join(nm, "playwright/index.js"),
    'module.exports={chromium:{executablePath:()=>require("path").join(__dirname,"..",".browser")}};\n',
  );
  writeFileSync(join(nm, ".browser"), "");
}
fakePw(join(TMPL, "pwcache/node_modules"));
const bare = { PATH: join(TMPL, "bin"), HOME: join(TMPL, "home") };
test("playwright falls back to the first-use cache", () =>
  assert.equal(
    lookup(undefined, { ...bare, QA_PLAYWRIGHT_DIR: join(TMPL, "pwcache") }).out,
    join(TMPL, "pwcache/node_modules"),
  ));
test("no playwright and no install → undefined, and the skip line", () => {
  const r = lookup(undefined, { ...bare, QA_PLAYWRIGHT_DIR: join(TMPL, "empty"), QA_NO_INSTALL: "1" });
  assert.equal(r.out, "");
  assert.match(r.err, /qa: skipped — Playwright unavailable \(/);
});
mkdirSync(join(TMPL, "app2/.git"), { recursive: true });
fakePw(join(TMPL, "app2/node_modules"));
test("the app reaches ensure-playwright.ts as --app", () =>
  assert.equal(
    lookup(join(TMPL, "app2"), { ...bare, QA_PLAYWRIGHT_DIR: join(TMPL, "empty"), QA_NO_INSTALL: "1" }).out,
    join(TMPL, "app2/node_modules"),
  ));

// ── the service token from the environment ──
test("QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET: a pair only when both are set", () => {
  const saved = { id: process.env.QA_CF_ACCESS_ID, secret: process.env.QA_CF_ACCESS_SECRET };
  try {
    process.env.QA_CF_ACCESS_ID = "i";
    process.env.QA_CF_ACCESS_SECRET = "s";
    assert.deepEqual(qaEnvCfAccess(), { id: "i", secret: "s" });
    delete process.env.QA_CF_ACCESS_SECRET;
    assert.equal(qaEnvCfAccess(), undefined);
  } finally {
    for (const [k, v] of [
      ["QA_CF_ACCESS_ID", saved.id],
      ["QA_CF_ACCESS_SECRET", saved.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── local runs: vars, token ──
// The registry reads need wrangler's credentials; fake ones, and an API base
// nothing listens on, so a refresh can never reach Cloudflare.
process.env.CLOUDFLARE_API_TOKEN = "test-token";
process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
process.env.QA_CF_API = "http://127.0.0.1:9";
const LOCAL = mkdtempSync(join(tmpdir(), "qa-lib-local-"));
after(() => rmSync(LOCAL, { recursive: true, force: true }));
const repo = (name: string, file: string, text: string) => {
  const d = join(LOCAL, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), text);
  return d;
};

test("D1 migrations from wrangler.toml: default and named dirs, remote, env blocks left out", () => {
  const d = repo(
    "d1toml",
    "wrangler.toml",
    [
      'name = "w"',
      "[[d1_databases]]",
      'binding = "A_DB"',
      'database_id = "id-a"',
      "# [[d1_databases]] a comment is not a table",
      "[[d1_databases]]",
      "binding = 'B_DB'",
      'migrations_dir = "db/b"',
      "remote = true # reaches production",
      "[[d1_databases]]",
      'database_id = "no-binding"',
      "[vars]",
      'X = "1"',
      "[[env.staging.d1_databases]]",
      'binding = "STAGING_DB"',
    ].join("\n"),
  );
  assert.deepEqual(qaD1Migrations(d), [
    { binding: "A_DB", dir: "migrations", remote: false },
    { binding: "B_DB", dir: "db/b", remote: true },
  ]);
});
test("D1 migrations from wrangler.jsonc", () => {
  const d = repo(
    "d1jsonc",
    "wrangler.jsonc",
    '{ // a comment\n "d1_databases": [{ "binding": "A_DB", "migrations_dir": "sql", "remote": true }, { "database_id": "x" }, { "binding": "C" }], }',
  );
  assert.deepEqual(qaD1Migrations(d), [
    { binding: "A_DB", dir: "sql", remote: true },
    { binding: "C", dir: "migrations", remote: false },
  ]);
});
test("no wrangler config → no D1 databases", () => assert.deepEqual(qaD1Migrations(join(LOCAL, "none")), []));
test("a wrangler var: the first active line, not a commented one", () => {
  const d = repo("vars", "wrangler.toml", '[vars]\n# ACCESS_AUD = "old"\nACCESS_AUD = "a1,a2"\n');
  assert.equal(qaWranglerVar(d, "ACCESS_AUD"), "a1,a2");
  assert.equal(qaWranglerVar(d, "MISSING"), "");
});
test("a wrangler var: the top-level [vars] only, never an environment's or another table's", () => {
  const d = repo(
    "env-vars",
    "wrangler.toml",
    '[env.staging.vars]\nACCESS_ISSUER = "https://staging.example.com"\n[other]\nACCESS_AUD = "not-a-var"\n[vars]\nACCESS_ISSUER = "https://team.example.com"\n[env.prod.vars]\nACCESS_AUD = "prod-only"\n',
  );
  assert.equal(qaWranglerVar(d, "ACCESS_ISSUER"), "https://team.example.com");
  assert.equal(qaWranglerVar(d, "ACCESS_AUD"), "");
});

test("the local token verifies against its own key set and carries Access's claims", () => {
  const { jwks, jwt } = qaLocalAccess("a@example.com", "aud-1", "https://team.example.com", 1_000);
  const [h, p, sig] = jwt.split(".");
  const key = JSON.parse(jwks).keys[0];
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(sig ?? "", "base64url"),
    ),
    true,
  );
  assert.equal(JSON.parse(Buffer.from(h ?? "", "base64url").toString()).kid, key.kid);
  assert.deepEqual(JSON.parse(Buffer.from(p ?? "", "base64url").toString()), {
    email: "a@example.com",
    sub: "qa-local:a@example.com",
    iss: "https://team.example.com",
    aud: ["aud-1"],
    iat: 1_000,
    exp: 1_000 + 12 * 3600,
  });
  assert.equal(key.d, undefined, "the key set must hold the public half only");
});
test("headers: the token alone, the pair alone, and nothing", () => {
  assert.deepEqual(qaAccessHeaders(undefined, "", "J"), { "Cf-Access-Jwt-Assertion": "J" });
  assert.deepEqual(qaAccessHeaders(undefined, "p@x.com", "J"), { "Cf-Access-Jwt-Assertion": "J" });
  assert.deepEqual(qaAccessHeaders({ id: "i", secret: "s" }, "p@x.com"), {
    "CF-Access-Client-Id": "i",
    "CF-Access-Client-Secret": "s",
    "X-Portal-Act-As": "p@x.com",
  });
  assert.equal(qaAccessHeaders(undefined, "p@x.com"), undefined);
});
test("the token file: none named, named and read, named but missing or empty", () => {
  const f = join(LOCAL, "t.jwt");
  writeFileSync(f, "TOKEN\n");
  assert.equal(qaReadJwtFile(""), "");
  assert.equal(qaReadJwtFile(f), "TOKEN");
  assert.equal(qaReadJwtFile(join(LOCAL, "absent.jwt")), undefined);
  writeFileSync(f, "");
  assert.equal(qaReadJwtFile(f), undefined);
});
test("the Access issuer comes from the account's organization, cached", async () => {
  const cache = join(LOCAL, "org.json");
  process.env.QA_CF_ACCESS_ORG_CACHE = cache;
  writeFileSync(qaCfAccountCache(cache), '{"success":true,"result":{"auth_domain":"team.example.com"}}');
  assert.equal(await qaAccessIssuer(), "https://team.example.com");
  writeFileSync(qaCfAccountCache(cache), '{"success":true,"result":{"name":"no domain"}}');
  chmodSync(qaCfAccountCache(cache), 0o644);
  assert.equal(await qaAccessIssuer(), undefined);
  delete process.env.QA_CF_ACCESS_ORG_CACHE;
});
test("without wrangler's credentials there is no issuer, even from a good cache", async () => {
  const cache = join(LOCAL, "org-nocreds.json");
  process.env.QA_CF_ACCESS_ORG_CACHE = cache;
  writeFileSync(qaCfAccountCache(cache), '{"success":true,"result":{"auth_domain":"team.example.com"}}');
  const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    assert.equal(await qaAccessIssuer(), undefined);
  } finally {
    process.env.CLOUDFLARE_ACCOUNT_ID = saved;
    delete process.env.QA_CF_ACCESS_ORG_CACHE;
  }
});

test("qaCfAccountCache: the account goes before the extension, path-safe", () => {
  assert.equal(qaCfAccountCache("/tmp/qa-cf-pages-cache.json", "abc123"), "/tmp/qa-cf-pages-cache.abc123.json");
  assert.equal(qaCfAccountCache("/tmp/cache", "abc123"), "/tmp/cache.abc123");
  assert.equal(qaCfAccountCache("/tmp/c.json", "../x y"), "/tmp/c.___x_y.json");
});
// Each account answers for itself: a cache filled for one account is never read
// for another, and switching back reads the first account's copy again.
test("registry caches are kept per Cloudflare account", async () => {
  const asked: string[] = [];
  const api = createServer((q, s) => {
    const account = /\/accounts\/([^/]+)\//.exec(q.url ?? "")?.[1] ?? "";
    asked.push(account);
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify({ success: true, result: { auth_domain: `${account}.example.com` } }));
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", () => done()));
  const addr = api.address();
  const saved = { account: process.env.CLOUDFLARE_ACCOUNT_ID, api: process.env.QA_CF_API };
  process.env.QA_CF_API = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  process.env.QA_CF_ACCESS_ORG_CACHE = join(LOCAL, "org-per-account.json");
  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-a";
    assert.equal(await qaAccessIssuer(), "https://acct-a.example.com");
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-b";
    assert.equal(await qaAccessIssuer(), "https://acct-b.example.com", "account b was answered from account a's cache");
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-a";
    assert.equal(await qaAccessIssuer(), "https://acct-a.example.com");
    assert.deepEqual(asked, ["acct-a", "acct-b"], "a fresh per-account copy is not asked for again");
  } finally {
    process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
    process.env.QA_CF_API = saved.api;
    delete process.env.QA_CF_ACCESS_ORG_CACHE;
    await new Promise<void>((done) => api.close(() => done()));
  }
});
test("the object endpoint's cache never accepts a list answer", async () => {
  const cache = join(LOCAL, "org-list.json");
  process.env.QA_CF_ACCESS_ORG_CACHE = cache;
  writeFileSync(qaCfAccountCache(cache), '{"success":true,"result":[{"auth_domain":"team.example.com"}]}');
  assert.equal(await qaAccessIssuer(), undefined);
  delete process.env.QA_CF_ACCESS_ORG_CACHE;
});
test("a registry answer must have the shape its endpoint returns", () => {
  const named = (e: unknown) => typeof (e as { name?: unknown }).name === "string";
  assert.equal(qaIsGoodRegistry({ success: true, result: [{ name: "a" }] }, named), true);
  assert.equal(
    qaIsGoodRegistry({ success: true, result: { name: "a" } }, named),
    false,
    "an object never passes for a list endpoint",
  );
  assert.equal(qaIsGoodRegistry({ success: true, result: { name: "a" } }, named, "object"), true);
  assert.equal(qaIsGoodRegistry({ success: true, result: [{ name: "a" }] }, named, "object"), false);
  assert.equal(qaIsGoodRegistry({ success: false, result: [] }, named), false);
});
