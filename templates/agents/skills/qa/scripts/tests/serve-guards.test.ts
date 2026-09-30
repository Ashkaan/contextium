#!/usr/bin/env -S node --experimental-strip-types
// serve-guards.test.ts — guard-path tests for serve.ts that do NOT spin a real
// server: the "--live without a live URL → refuse" row, --live-url and the
// environment it can come from, arg-validation usage exits, and the port
// ownership helpers on a machine with lsof and no ss (macOS). The happy-path
// serve is serve.test.ts's, against stubs.
//
// Nothing here reaches 1Password or Cloudflare: a stub `op` that always fails
// sits first on PATH, wrangler's CLOUDFLARE_* credentials are removed, and the
// registry caches point into the sandbox, so the live lookup has no token and
// no cache and resolves nothing.
//
// serve.ts is spawned for the guards; its port helpers are imported (serve.ts
// runs its main only when it is the program).
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/serve-guards.test.ts
//
// peers: ../serve.ts

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaRepoSlug } from "../lib.ts";
import { qaListenerPids, qaPortFree, qaPortOwnedBy } from "../serve.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "serve.ts");
const TMP = mkdtempSync(join(tmpdir(), "serve-guards-test-"));
const BIN = join(TMP, "bin");
mkdirSync(BIN);

/** process.env without the host's 1Password, Cloudflare and /qa settings. */
function hermeticEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "OP_CONNECT_HOST",
    "OP_CONNECT_TOKEN",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "QA_ACCESS_OP_ITEM",
    "QA_LIVE_URL",
  ])
    delete e[k];
  return e;
}
writeFileSync(join(BIN, "op"), "#!/bin/sh\nexit 1\n");
chmodSync(join(BIN, "op"), 0o755);
mkdirSync(join(TMP, "home"));

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...hermeticEnv(),
      ...extra,
      HOME: join(TMP, "home"),
      PATH: `${BIN}:${process.env.PATH}`,
      QA_CF_PAGES_CACHE: join(TMP, "pages.json"),
      QA_CF_WORKERS_DOMAINS_CACHE: join(TMP, "workers.json"),
    },
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout ?? "" };
}

// --live on a detectable repo whose basename matches no CF Pages project → exit
// 6. The astro dep makes detect-app pass so we reach the derive; with no
// registry copy and no token the derive returns nothing and serve refuses with
// "live URL".
const LIVE = join(TMP, "live");
mkdirSync(LIVE);
writeFileSync(join(LIVE, "package.json"), '{"dependencies":{"astro":"5"}}');
const EMPTY = join(TMP, "empty");
mkdirSync(EMPTY);

after(() => {
  // serve.ts made /tmp/qa-shots/<slug>/t1 before it refused; the slug is this fixture's.
  rmSync(join("/tmp/qa-shots", qaRepoSlug(LIVE)), { recursive: true, force: true });
  if (listener.pid !== undefined) {
    try {
      process.kill(-listener.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

test("live, no CF match → exit 6", () => {
  const r = run(["up", "--repo", LIVE, "--mode", "live", "--run-id", "t1"]);
  assert.equal(r.rc, 6);
  assert.match(r.out, /live URL/);
});
test("the refusal names --live-url", () =>
  assert.match(run(["up", "--repo", LIVE, "--mode", "live", "--run-id", "t6"]).out, /--live-url/));

// --live with an explicit --live-url needs no registry: the URL is emitted as given.
test("live with --live-url → that URL, and no Access item named → none sent", () => {
  const r = run(["up", "--repo", LIVE, "--mode", "live", "--run-id", "t4", "--live-url", "https://example.com"]);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.stdout, /^QA_URL=https:\/\/example\.com$/m);
  assert.match(r.stdout, /^QA_AUTH_OP_ITEM=$/m);
});
test("QA_LIVE_URL + QA_ACCESS_OP_ITEM from the environment", () => {
  const r = run(["up", "--repo", LIVE, "--mode", "live", "--run-id", "t5"], {
    QA_LIVE_URL: "https://example.org",
    QA_ACCESS_OP_ITEM: "item123",
  });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.stdout, /^QA_URL=https:\/\/example\.org$/m);
  assert.match(r.stdout, /^QA_AUTH_OP_ITEM=item123$/m);
});

// ── port ownership without ss (macOS): the lsof path ──
// The helpers run in this process under a PATH holding a stub lsof, ps, and no
// ss. The stub reports the pid of a detached `sleep` (its own group's leader)
// as the listener on port 4242.
const NOSS = join(TMP, "noss");
mkdirSync(NOSS);
const ps = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
if (ps !== "") writeFileSync(join(NOSS, "ps"), `#!/bin/sh\nexec ${ps} "$@"\n`);
chmodSync(join(NOSS, "ps"), 0o755);
const listener = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
listener.unref();
const LP = String(listener.pid ?? "");
function lsof(on: boolean) {
  if (on) {
    writeFileSync(join(NOSS, "lsof"), `#!/bin/sh\ncase "$*" in *"-iTCP:4242 "*) echo ${LP} ;; esac\nexit 0\n`);
    chmodSync(join(NOSS, "lsof"), 0o755);
  } else {
    rmSync(join(NOSS, "lsof"), { force: true });
  }
}
function underNoSs<T>(f: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = NOSS;
  try {
    return f();
  } finally {
    process.env.PATH = saved;
  }
}
test("lsof: a listened port is not free, a quiet one is", () => {
  lsof(true);
  assert.equal(
    underNoSs(() => qaPortFree(4242)),
    false,
  );
  assert.equal(
    underNoSs(() => qaPortFree(4243)),
    true,
  );
});
test("lsof: the listener's pid", () => {
  lsof(true);
  assert.deepEqual(
    underNoSs(() => qaListenerPids(4242)),
    [LP],
  );
});
test("lsof: our group owns the listener, another group does not", () => {
  lsof(true);
  assert.equal(
    underNoSs(() => qaPortOwnedBy(4242, LP)),
    true,
  );
  assert.equal(
    underNoSs(() => qaPortOwnedBy(4242, "1")),
    false,
  );
});
test("neither ss nor lsof: a port reads free and no pid resolves", () => {
  lsof(false);
  assert.equal(
    underNoSs(() => qaPortFree(4242)),
    true,
  );
  assert.equal(
    underNoSs(() => qaPortOwnedBy(4242, LP)),
    false,
  );
});
test("bad mode → exit 2", () =>
  assert.equal(run(["up", "--repo", EMPTY, "--mode", "sideways", "--run-id", "t3"]).rc, 2));
test("missing run-id → exit 2", () => assert.equal(run(["up", "--repo", EMPTY, "--mode", "before"]).rc, 2));
test("down missing runfile → exit 2", () => assert.equal(run(["down", "--runfile", "/nonexistent/server.run"]).rc, 2));
test("unknown subcommand → exit 2", () => assert.equal(run(["sideways"]).rc, 2));
