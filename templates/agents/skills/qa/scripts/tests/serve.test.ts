// serve.test.ts — pin serve.ts up/down offline on a `static` fixture with stub
// `ss`, `curl` and `python3` on PATH: the runfile's contents and the server
// command that WOULD have run (argv + cwd recorded by the stub), the default
// port and the hop off a busy one, --port, --mode after's detached worktree and
// its removal on down, the cli/render refusal (2), an undetectable repo (3), a
// failed build (4), a server that never answers (5), a foreign listener (5),
// and --mode live's runfile derived from a pre-seeded Cloudflare registry cache
// with no `op` and no network. serve-guards.test.ts keeps the pure arg-error
// rows. The script is spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/serve.test.ts
//
// peers: ../serve.ts, ./serve-guards.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaCfAccountCache, qaRepoSlug } from "../lib.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "serve.ts");
const TMP = mkdtempSync(join(tmpdir(), "serve-test-"));
let RUNFILE = "";

/**
 * process.env without the host's 1Password and Access settings, and with
 * wrangler's Cloudflare credentials replaced by fake ones: the registry is
 * asked with those, the caches below are seeded fresh so nothing is refreshed,
 * and QA_CF_API points at a port nothing listens on in case something is.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "OP_CONNECT_HOST",
    "OP_CONNECT_TOKEN",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "QA_ACCESS_OP_ITEM",
    "QA_LIVE_URL",
    "QA_CF_ACCESS_ID",
    "QA_CF_ACCESS_SECRET",
  ])
    delete e[k];
  e.CLOUDFLARE_API_TOKEN = "test-token";
  e.CLOUDFLARE_ACCOUNT_ID = "test-account";
  e.QA_CF_API = "http://127.0.0.1:9";
  return e;
}

// ── stubs ──
const BIN = join(TMP, "bin");
mkdirSync(BIN);
const stub = (name: string, body: string) => {
  writeFileSync(join(BIN, name), body);
  chmodSync(join(BIN, name), 0o755);
};
// ss: nothing listens, unless STUB_BUSY names ports (":8813 :8814") or "all";
// a busy port is held by pid 1 — never this run's process group. STUB_SQUAT
// names a file the server stub creates as it starts: from then on pid 1 holds
// every port, as another session's server that took the port in that gap does.
stub(
  "ss",
  `#!/bin/sh
all="$*"; port="\${all##*sport = :}"
busy="\${STUB_BUSY:-}"
[ -n "\${STUB_SQUAT:-}" ] && [ -f "\${STUB_SQUAT}" ] && busy="all"
case " $busy " in
  *" all "*|*" :$port "*) echo "LISTEN 0 4096 *:$port *:* users:((\\"other\\",pid=1,fd=3))" ;;
esac
`,
);
// curl: the health probe answers unless STUB_DOWN is set, and under STUB_SQUAT
// only once the squatter is in place, so the ownership check always sees it
stub("curl", '#!/bin/sh\n[ -z "${STUB_DOWN:-}" ] || exit 1\n[ -z "${STUB_SQUAT:-}" ] || [ -f "${STUB_SQUAT}" ]\n');
// The stubs' long sleep carries this run's pid, so the kill check below finds
// only this run's server — a bare `sleep 120` also matches every other suite's.
const STUB_SLEEP = `120.${process.pid}`;
// python3: the static server — record argv + cwd, then stay up (or die at once)
stub(
  "python3",
  `#!/bin/sh
printf '%s\\ncwd=%s\\n' "$*" "$PWD" > "$STUB_SERVER_LOG"
[ -n "\${STUB_SQUAT:-}" ] && touch "\${STUB_SQUAT}"
[ -n "\${STUB_DIE:-}" ] && exit 1
exec sleep ${STUB_SLEEP}
`,
);
// npm: the astro build fails loudly; a fixture holding .build-ok builds; the
// app's qa:seed script records what it was handed
stub(
  "npm",
  `#!/bin/sh
if [ "$1 $2" = "run qa:seed" ]; then
  printf 'seed persist=%s act_as=%s cwd=%s\\n' "$QA_D1_PERSIST" "$QA_ACT_AS" "$PWD" >> "$STUB_D1_LOG"
  exit \${STUB_SEED_RC:-0}
fi
[ -f .build-ok ] && exit 0
echo "build: boom"; exit 1
`,
);
// npx: the vite/wrangler server — record argv and the two variables a local
// sign-in hands the Worker, then stay up
stub(
  "npx",
  `#!/bin/sh
if [ "$1 $2 $3" = "wrangler d1 migrations" ]; then
  printf '%s cwd=%s\\n' "$*" "$PWD" >> "$STUB_D1_LOG"
  exit \${STUB_D1_RC:-0}
fi
printf '%s\\nACCESS_JWKS_URL=%s\\nINCLUDE=%s\\n' "$*" "$ACCESS_JWKS_URL" "$CLOUDFLARE_INCLUDE_PROCESS_ENV" > "$STUB_SERVER_LOG"
exec sleep ${STUB_SLEEP}
`,
);
// op: never reachable offline
stub("op", "#!/bin/sh\nexit 1\n");
const SERVER_LOG = join(TMP, "server.log");
const D1_LOG = join(TMP, "d1.log");

// ── fixtures ──
// a static site: dist/ to serve, src/pages/ for discover-routes, committed
const SITE = join(TMP, "site");
mkdirSync(join(SITE, "dist"), { recursive: true });
mkdirSync(join(SITE, "src/pages"), { recursive: true });
writeFileSync(join(SITE, "dist/index.html"), "<h1>hi</h1>\n");
writeFileSync(join(SITE, "src/pages/index.astro"), "");
writeFileSync(join(SITE, "src/pages/about.astro"), "");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
git(SITE, "init", "-q");
git(SITE, "add", "-A");
git(SITE, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
// a cli target, an undetectable one, an astro one whose build fails
const CLI = join(TMP, "cli");
mkdirSync(CLI);
writeFileSync(join(CLI, "package.json"), '{"scripts":{"qa:cmd":"node ."}}');
const NONE = join(TMP, "none");
mkdirSync(NONE);
const ASTRO = join(TMP, "astro");
mkdirSync(ASTRO);
writeFileSync(join(ASTRO, "package.json"), '{"dependencies":{"astro":"5"}}');
// a Vite Worker behind Cloudflare Access: no network
const GATED = join(TMP, "gated");
mkdirSync(GATED);
writeFileSync(join(GATED, "package.json"), '{"dependencies":{"vite":"7","wrangler":"4"}}');
writeFileSync(join(GATED, ".build-ok"), "");
writeFileSync(
  join(GATED, "wrangler.toml"),
  'name = "gated"\n[vars]\nACCESS_AUD = "aud-one,aud-two"\nPROBE_ACTS_AS = "cli_abc Probe@Example.com"\n',
);

// a Vite Worker with D1: one database with migrations, one whose migrations
// dir is missing, one bound remote; and a qa:seed script of its own
const D1APP = join(TMP, "d1app");
mkdirSync(join(D1APP, "migrations"), { recursive: true });
writeFileSync(join(D1APP, "migrations/0001_init.sql"), "CREATE TABLE notes (id INTEGER PRIMARY KEY);\n");
writeFileSync(
  join(D1APP, "package.json"),
  '{"dependencies":{"vite":"7","wrangler":"4"},"scripts":{"qa:seed":"node seed.js"}}',
);
writeFileSync(join(D1APP, ".build-ok"), "");
writeFileSync(
  join(D1APP, "wrangler.toml"),
  [
    'name = "d1app"',
    "[[d1_databases]]",
    'binding = "DB"',
    'database_id = "id-db"',
    "[[d1_databases]]",
    'binding = "CACHE_DB"',
    'database_id = "id-cache"',
    'migrations_dir = "db/cache"',
    "[[d1_databases]]",
    'binding = "PROD_DB"',
    'database_id = "id-prod"',
    "remote = true",
    "[vars]",
    'PROBE_ACTS_AS = "cli_abc Probe@Example.com"',
  ].join("\n"),
);

mkdirSync(join(TMP, "home"));
const ENV: NodeJS.ProcessEnv = {
  ...hermeticEnv(),
  HOME: join(TMP, "home"),
  PATH: `${BIN}:${process.env.PATH}`,
  STUB_SERVER_LOG: SERVER_LOG,
  STUB_D1_LOG: D1_LOG,
  QA_CF_PAGES_CACHE: join(TMP, "pages.json"),
  QA_CF_WORKERS_DOMAINS_CACHE: join(TMP, "workers.json"),
  QA_CF_ACCESS_ORG_CACHE: join(TMP, "access-org.json"),
};

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...ENV, ...env },
    timeout: 120_000,
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}
/** What `KEY` holds after bash evaluates `block` — the SKILL `eval`s serve.ts's stdout. */
const bashValue = (block: string, key: string): string =>
  spawnSync("bash", ["-c", `eval "$1" && printf '%s' "\${${key}-}"`, "x", block], { encoding: "utf8" }).stdout;
/** A runfile value as bash reads it back. */
const rf = (key: string): string => bashValue(readFileSync(RUNFILE, "utf8"), key);
const runfileOf = (out: string) => bashValue(/^QA_RUNFILE=.*$/m.exec(out)?.[0] ?? "", "QA_RUNFILE");
const serverLog = () => (existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, "utf8") : "");
const serverLine = (n: number) => serverLog().split("\n")[n - 1] ?? "";
function down() {
  const r = run(["down", "--runfile", RUNFILE]);
  RUNFILE = "";
  return r;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// serve.ts hardcodes /tmp/qa-shots and /tmp/qa-worktrees; the slug carries a
// cksum of this fixture's absolute path, so its run dirs are ours to remove.
after(() => {
  if (RUNFILE !== "" && existsSync(RUNFILE)) run(["down", "--runfile", RUNFILE]);
  for (const [root, prefix] of [
    ["/tmp/qa-shots", qaRepoSlug(SITE)],
    ["/tmp/qa-shots", qaRepoSlug(ASTRO)],
    ["/tmp/qa-shots", qaRepoSlug(GATED)],
    ["/tmp/qa-shots", qaRepoSlug(D1APP)],
    ["/tmp/qa-shots", qaRepoSlug(CLI)],
    ["/tmp/qa-shots", qaRepoSlug(NONE)],
    ["/tmp/qa-shots", qaRepoSlug(ODD_APP)],
    ["/tmp/qa-shots", qaRepoSlug(join(ODD, "apps", "new"))],
    ["/tmp/qa-worktrees", `${qaRepoSlug(SITE)}-`],
    ["/tmp/qa-worktrees", `${qaRepoSlug(ODD_APP)}-`],
  ] as const) {
    for (const d of existsSync(root) ? readdirSync(root) : []) {
      if (d.startsWith(prefix)) rmSync(join(root, d), { recursive: true, force: true });
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

// ── refusals before any server ──
test("cli target → 2", () => {
  const r = run(["up", "--repo", CLI, "--mode", "before", "--run-id", "t"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /cli target has no server/);
});
test("undetectable repo → 3 with detect-app's reason", () => {
  const r = run(["up", "--repo", NONE, "--mode", "before", "--run-id", "t"]);
  assert.equal(r.rc, 3);
  assert.match(r.out, /unknown app type/);
});
test("failed build → 4 with the log tail", () => {
  const r = run(["up", "--repo", ASTRO, "--mode", "before", "--run-id", "t"]);
  assert.equal(r.rc, 4);
  assert.match(r.out, /build failed/);
  assert.match(r.out, /build: boom/);
});
test("no server started on those paths", () => assert.equal(serverLog(), ""));

// ── up --mode before on the static site ──
let pid = 0;
let upOut = "";
test("static before → 0, runfile written", () => {
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "r1"]);
  upOut = r.out;
  RUNFILE = runfileOf(r.out);
  assert.equal(r.rc, 0, r.out);
  assert.ok(existsSync(RUNFILE));
});
test("runfile under /tmp/qa-shots/<slug>/<run-id>/", () =>
  assert.match(RUNFILE, /^\/tmp\/qa-shots\/site-[^/]*\/r1\/server\.run$/));
test("default port 8813", () => {
  assert.equal(rf("QA_URL"), "http://localhost:8813");
  assert.equal(rf("QA_PORT"), "8813");
});
test("before: working tree, no worktree", () => {
  assert.equal(rf("QA_LABEL"), "working tree");
  assert.equal(rf("QA_WORKTREE"), "");
  assert.equal(rf("QA_SOURCE_REPO"), SITE);
});
test("QA_PAGES from discover-routes, %q-quoted", () => {
  assert.equal(rf("QA_PAGES"), "/ /about ");
  assert.match(readFileSync(RUNFILE, "utf8"), /^QA_PAGES=\/\\ \/about\\ $/m);
});
test("server command: python3 -m http.server 8813", () => assert.equal(serverLine(1), "-m http.server 8813"));
test("served from dist/", () => assert.equal(serverLine(2), `cwd=${SITE}/dist`));
test("progress line names type and port", () => assert.ok(upOut.includes("starting static server on :8813"), upOut));
test("QA_PID is the live server", () => {
  pid = Number(rf("QA_PID"));
  assert.ok(pid > 0 && alive(pid), `pid ${pid}`);
});
test("server.log beside the runfile", () => {
  assert.equal(rf("QA_LOGFILE"), join(dirname(RUNFILE), "server.log"));
  assert.ok(existsSync(rf("QA_LOGFILE")));
});
test("the stdout block is what bash evaluates back to the same values", () => {
  const r = spawnSync(
    "bash",
    ["-c", `set -e; source "$1"; printf '%s|' "$QA_PAGES" "$QA_LABEL" "$QA_PID"`, "x", RUNFILE],
    {
      encoding: "utf8",
    },
  );
  assert.equal(r.stdout, `/ /about |working tree|${pid}|`);
});

// ── down ──
test("down → 0, reports pid", () => {
  const r = down();
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes(`torn down (pid=${pid}, worktree=none)`), r.out);
});
test("server killed", () => assert.equal(alive(pid), false, `pid ${pid} alive`));

// ── --port and the hop off a busy default ──
test("--port 9123 used", () => {
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "r2", "--port", "9123"]);
  RUNFILE = runfileOf(r.out);
  assert.equal(r.rc, 0, r.out);
  assert.equal(rf("QA_PORT"), "9123");
  assert.equal(serverLine(1), "-m http.server 9123");
  down();
});
test("busy 8813/8814 → 8815", () => {
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "r3"], { STUB_BUSY: ":8813 :8814" });
  RUNFILE = runfileOf(r.out);
  assert.equal(r.rc, 0, r.out);
  assert.equal(rf("QA_PORT"), "8815");
  assert.ok(r.out.includes(":8813 is busy — serving on :8815 instead"), r.out);
  down();
});

// ── a server that never answers → 5 ──
test("dead server → 5", () => {
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "r4"], { STUB_DOWN: "1", STUB_DIE: "1" });
  assert.equal(r.rc, 5);
  assert.ok(r.out.includes("did not come up on :8813"), r.out);
  assert.ok(r.out.includes("server never came up"), r.out);
});

// ── a foreign listener answers the probe → refused, 5 ──
test("foreign listener → refused, 5", () => {
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "r5"], { STUB_BUSY: "all" });
  assert.equal(r.rc, 5);
  assert.ok(r.out.includes("no free port in 8813-8853"), r.out);
  assert.ok(r.out.includes("NOT this run's process group"), r.out);
  assert.ok(r.out.includes("pass --port <free-port>"), r.out);
});
// A port free when the scan read it can be taken by another session's
// server before ours binds; ours would move elsewhere, and the run would accept
// the other app on the strength of "it was free at the start".
test("a port taken between the free check and our bind → refused, 5", () => {
  const squat = join(TMP, "squat");
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "r5b"], { STUB_SQUAT: squat });
  assert.equal(r.rc, 5, r.out);
  assert.ok(r.out.includes("NOT this run's process group"), r.out);
  assert.ok(!r.out.includes("accepted (port was free at start)"), r.out);
});
test("foreign attempt's server killed", () => {
  const r = spawnSync("pgrep", ["-f", `sleep ${STUB_SLEEP.replace(".", "\\.")}$`], { encoding: "utf8" });
  assert.equal(r.stdout, "", "stub server still running");
});

// ── every emitted value survives the SKILL's eval: a path with a space, `$`, `&`
// and parentheses comes back as itself. The app sits two levels below its git
// root, as an app in a monorepo does. ──
const ODD = join(TMP, "odd $HOME & (x)");
const ODD_APP = join(ODD, "apps", "web");
mkdirSync(join(ODD_APP, "dist"), { recursive: true });
writeFileSync(join(ODD_APP, "dist/index.html"), "<h1>odd</h1>\n");
writeFileSync(join(ODD, "README.md"), "the repository root, not an app\n");
git(ODD, "init", "-q");
git(ODD, "add", "-A");
git(ODD, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
test("a path that is shell syntax comes back through eval as itself", () => {
  const r = run(["up", "--repo", ODD_APP, "--mode", "before", "--run-id", "q1"]);
  RUNFILE = runfileOf(r.stdout);
  assert.equal(r.rc, 0, r.out);
  assert.equal(rf("QA_SOURCE_REPO"), ODD_APP);
  assert.equal(rf("QA_SRC"), ODD_APP);
  assert.equal(rf("QA_RUNFILE"), RUNFILE);
  assert.ok(existsSync(RUNFILE), RUNFILE);
  assert.equal(serverLine(2), `cwd=${ODD_APP}/dist`);
  const d = down();
  assert.equal(d.rc, 0, d.out);
});
test("after, app below its git root: served from the same app in the HEAD worktree", () => {
  const r = run(["up", "--repo", ODD_APP, "--mode", "after", "--run-id", "q2"]);
  RUNFILE = runfileOf(r.stdout);
  assert.equal(r.rc, 0, r.out);
  const tree = rf("QA_WORKTREE");
  assert.equal(serverLine(2), `cwd=${tree}/apps/web/dist`);
  assert.equal(rf("QA_SRC"), `${tree}/apps/web`);
  assert.ok(git(ODD, "worktree", "list").includes(tree));
  const d = down();
  assert.equal(d.rc, 0, d.out);
  assert.equal(existsSync(tree), false);
  assert.equal(git(ODD, "worktree", "list").includes(tree), false, "down removed the files but not the registration");
});
test("after, an app directory HEAD does not have → 2, named, no worktree left", () => {
  const fresh = join(ODD, "apps", "new");
  mkdirSync(join(fresh, "dist"), { recursive: true });
  writeFileSync(join(fresh, "dist/index.html"), "<h1>uncommitted</h1>\n");
  const r = run(["up", "--repo", fresh, "--mode", "after", "--run-id", "q3"]);
  assert.equal(r.rc, 2, r.out);
  assert.match(r.out, /apps\/new\/ is not in HEAD/);
  assert.equal(git(ODD, "worktree", "list").trim().split("\n").length, 1);
});

// ── --mode after: a detached worktree of HEAD, removed on down ──
let wt = "";
test("after → worktree at /tmp/qa-worktrees/<slug>-<run-id>", () => {
  const r = run(["up", "--repo", SITE, "--mode", "after", "--run-id", "r6"]);
  RUNFILE = runfileOf(r.out);
  wt = rf("QA_WORKTREE");
  assert.equal(r.rc, 0, r.out);
  assert.match(wt, /^\/tmp\/qa-worktrees\/site-.*-r6$/);
  assert.ok(existsSync(join(wt, "dist")));
});
test("served from the worktree's dist/", () => {
  assert.equal(rf("QA_LABEL"), "HEAD worktree");
  assert.equal(serverLine(2), `cwd=${wt}/dist`);
});
test("worktree registered on the source repo", () => assert.ok(git(SITE, "worktree", "list").includes(wt)));
test("down removes the worktree", () => {
  const r = down();
  assert.equal(r.rc, 0);
  assert.equal(existsSync(wt), false);
  assert.ok(r.out.includes(`worktree=${wt}`), r.out);
});
// A runfile an earlier serve wrote double-quoted its paths (`QA_WORKTREE="…"`)
// and left QA_PID="" for --live; a down after an upgrade must still read it, or
// it reports a teardown while the worktree and its registration stay behind.
test("down reads a runfile in the earlier double-quoted format", () => {
  const old = join(TMP, "old run tree");
  git(SITE, "worktree", "add", "--detach", "-q", old, "HEAD");
  const file = join(TMP, "old.run");
  writeFileSync(file, `QA_LABEL="HEAD worktree"\nQA_PID=""\nQA_WORKTREE="${old}"\nQA_SOURCE_REPO="${SITE}"\n`);
  const r = run(["down", "--runfile", file]);
  assert.equal(r.rc, 0, r.out);
  assert.ok(r.out.includes(`torn down (pid=none, worktree=${old})`), r.out);
  assert.equal(existsSync(old), false, "down left the old run's worktree");
  assert.equal(git(SITE, "worktree", "list").includes(old), false, "down left the old run's registration");
});

// ── --mode live from a seeded registry cache: no server, no op, no network ──
test("live: URL from the Pages registry, no pid", () => {
  writeFileSync(
    qaCfAccountCache(ENV.QA_CF_PAGES_CACHE ?? "", "test-account"),
    '{"success":true,"result":[{"name":"site","domains":["site.pages.dev","www.example.com"],"source":{"config":{"repo_name":"site"}}}]}\n',
  );
  writeFileSync(SERVER_LOG, "");
  // The Access service-token item is opt-in: QA_ACCESS_OP_ITEM names it.
  const r = run(["up", "--repo", SITE, "--mode", "live", "--run-id", "r7"], { QA_ACCESS_OP_ITEM: "<access-item>" });
  RUNFILE = runfileOf(r.out);
  assert.equal(r.rc, 0, r.out);
  assert.equal(rf("QA_URL"), "https://www.example.com");
  assert.equal(rf("QA_PID"), "");
});
test("live: the named Access item in the runfile", () => {
  assert.equal(rf("QA_AUTH_OP_ITEM"), "<access-item>");
  assert.equal(rf("QA_AUTH_ID_FIELD"), "client_id");
});
test("live starts no server", () => assert.equal(serverLog().includes("r7"), false));
test("no PROBE_ACTS_AS → no act-as line", () => {
  assert.equal(readFileSync(RUNFILE, "utf8").includes("QA_AUTH_ACT_AS"), false);
  RUNFILE = "";
});
test("live: a URL with & and an item title with spaces come back through eval as themselves", () => {
  const url = "https://www.example.com/app?a=1&b=$HOME";
  const item = "Cloudflare Access (QA probe) 'main'";
  const r = run(["up", "--repo", SITE, "--mode", "live", "--run-id", "r9", "--live-url", url], {
    QA_ACCESS_OP_ITEM: item,
    QA_ACCESS_ID_FIELD: "client id",
  });
  assert.equal(r.rc, 0, r.out);
  assert.equal(bashValue(r.stdout, "QA_URL"), url);
  assert.equal(bashValue(r.stdout, "QA_LABEL"), `live URL ${url}`);
  assert.equal(bashValue(r.stdout, "QA_AUTH_OP_ITEM"), item);
  assert.equal(bashValue(r.stdout, "QA_AUTH_ID_FIELD"), "client id");
});
// the Workers registry, via the repo's wrangler.toml, with PROBE_ACTS_AS
test("live: URL from the Workers registry via wrangler name", () => {
  writeFileSync(qaCfAccountCache(ENV.QA_CF_PAGES_CACHE ?? "", "test-account"), '{"success":true,"result":[]}');
  writeFileSync(
    qaCfAccountCache(ENV.QA_CF_WORKERS_DOMAINS_CACHE ?? "", "test-account"),
    '{"success":true,"result":[{"hostname":"portal.example.com","service":"site-worker","environment":"production"}]}\n',
  );
  writeFileSync(
    join(SITE, "wrangler.toml"),
    'name = "site-worker"\n[vars]\nPROBE_ACTS_AS = "cli_abc Probe@Example.com"\n',
  );
  const r = run(["up", "--repo", SITE, "--mode", "live", "--run-id", "r8"]);
  RUNFILE = runfileOf(r.out);
  assert.equal(r.rc, 0, r.out);
  assert.equal(rf("QA_URL"), "https://portal.example.com");
});
test("live: no QA_ACCESS_OP_ITEM → no Access item", () => assert.equal(rf("QA_AUTH_OP_ITEM"), ""));
test("live: PROBE_ACTS_AS email, lower-cased", () => {
  assert.equal(rf("QA_AUTH_ACT_AS"), "probe@example.com");
  RUNFILE = "";
});

// ── a gated Worker served locally: /qa stands in for Cloudflare Access ──
const jwtPart = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i] ?? "", "base64url").toString());
test("gated: no Access team domain → 8, no server", () => {
  rmSync(qaCfAccountCache(ENV.QA_CF_ACCESS_ORG_CACHE ?? "", "test-account"), { force: true });
  writeFileSync(SERVER_LOG, "");
  const r = run(["up", "--repo", GATED, "--mode", "before", "--run-id", "g0"]);
  assert.equal(r.rc, 8, r.out);
  assert.match(r.out, /Cloudflare Access team domain/);
  assert.equal(serverLog(), "");
});
test("gated: signs a token for the PROBE_ACTS_AS person and names its file", () => {
  writeFileSync(
    qaCfAccountCache(ENV.QA_CF_ACCESS_ORG_CACHE ?? "", "test-account"),
    '{"success":true,"result":{"auth_domain":"team.example.com"}}',
  );
  const r = run(["up", "--repo", GATED, "--mode", "before", "--run-id", "g1"]);
  RUNFILE = runfileOf(r.out);
  assert.equal(r.rc, 0, r.out);
  const jwt = readFileSync(rf("QA_AUTH_JWT_FILE"), "utf8");
  assert.equal(statSync(rf("QA_AUTH_JWT_FILE")).mode & 0o777, 0o600);
  const claims = jwtPart(jwt, 1);
  assert.equal(claims.email, "probe@example.com");
  assert.equal(claims.iss, "https://team.example.com");
  assert.deepEqual(claims.aud, ["aud-one"]);
  assert.match(rf("QA_LABEL"), /signed in locally as probe@example.com/);
  assert.equal(r.stdout.includes(jwt), false, "the token must never reach stdout");
});
test("gated: the Worker is told where the key set is, and the key set verifies the token", async () => {
  assert.match(serverLine(1), /^vite preview --port \d+$/);
  assert.equal(serverLine(3), "INCLUDE=true");
  const url = serverLine(2).replace("ACCESS_JWKS_URL=", "");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/jwks\.json$/);
  let keys: { keys: JsonWebKey[] } | undefined;
  for (let i = 0; i < 50 && keys === undefined; i++) {
    keys = await fetch(url)
      .then((x) => x.json() as Promise<{ keys: JsonWebKey[] }>)
      .catch(() => undefined);
    if (keys === undefined) await new Promise((res) => setTimeout(res, 100));
  }
  const jwt = readFileSync(rf("QA_AUTH_JWT_FILE"), "utf8");
  const [h, p, sig] = jwt.split(".");
  const key = createPublicKey({ key: keys?.keys[0] as JsonWebKey, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig ?? "", "base64url")), true);
  assert.equal(jwtPart(jwt, 0).kid, (keys?.keys[0] as { kid?: string }).kid);
});
test("gated: down stops the key-set server with the rest of the group", async () => {
  const url = serverLine(2).replace("ACCESS_JWKS_URL=", "");
  down();
  await new Promise((res) => setTimeout(res, 300));
  await assert.rejects(fetch(url));
});
test("gated: ACCESS_ISSUER in the wrangler config is the issuer, with no Cloudflare account to ask", () => {
  rmSync(ENV.QA_CF_ACCESS_ORG_CACHE ?? "", { force: true });
  rmSync(qaCfAccountCache(ENV.QA_CF_ACCESS_ORG_CACHE ?? "", "test-account"), { force: true });
  const toml = readFileSync(join(GATED, "wrangler.toml"), "utf8");
  writeFileSync(
    join(GATED, "wrangler.toml"),
    toml.replace("[vars]\n", '[vars]\nACCESS_ISSUER = "https://own.example.com"\n'),
  );
  try {
    const r = run(["up", "--repo", GATED, "--mode", "before", "--run-id", "g2"], {
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    });
    RUNFILE = runfileOf(r.out);
    assert.equal(r.rc, 0, r.out);
    assert.equal(jwtPart(readFileSync(rf("QA_AUTH_JWT_FILE"), "utf8"), 1).iss, "https://own.example.com");
    down();
  } finally {
    writeFileSync(join(GATED, "wrangler.toml"), toml);
  }
});

// ── a fresh local D1 database gets the app's schema before the server starts ──
// Empty local databases have no tables, so every query is a 500 ("no such
// table") instead of the empty state the page shows with no rows.
test("d1: each local database with migrations gets them, into the state dir the server reads", () => {
  writeFileSync(D1_LOG, "");
  writeFileSync(SERVER_LOG, "");
  const r = run(["up", "--repo", D1APP, "--mode", "before", "--run-id", "d1"]);
  RUNFILE = runfileOf(r.stdout);
  assert.equal(r.rc, 0, r.out);
  const log = readFileSync(D1_LOG, "utf8").split("\n");
  assert.equal(log[0], `wrangler d1 migrations apply DB --local --persist-to ${D1APP}/.wrangler/state cwd=${D1APP}`);
  assert.equal(log.filter((l) => l.startsWith("wrangler")).length, 1, log.join("\n"));
  assert.match(r.out, /CACHE_DB has no db\/cache\/ — its tables are left to the app's qa:seed/);
  assert.match(r.out, /PROD_DB is remote — left alone/);
  assert.match(rf("QA_LABEL"), /local D1: schema from migrations, then the app's qa:seed, no production rows/);
  assert.match(serverLine(1), /^vite preview --port \d+$/, "the server starts after the schema");
});
test("d1: the app's qa:seed runs after the schema, told the state dir and the signed-in person", () => {
  const log = readFileSync(D1_LOG, "utf8").split("\n");
  assert.equal(log[1], `seed persist=${D1APP}/.wrangler/state act_as=probe@example.com cwd=${D1APP}`);
  down();
});
test("d1: without a qa:seed, a database with no migrations is named as starting empty", () => {
  const pkg = readFileSync(join(D1APP, "package.json"), "utf8");
  writeFileSync(join(D1APP, "package.json"), '{"dependencies":{"vite":"7","wrangler":"4"}}');
  try {
    const r = run(["up", "--repo", D1APP, "--mode", "before", "--run-id", "d1b"]);
    RUNFILE = runfileOf(r.stdout);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /CACHE_DB has no db\/cache\/ — its local database starts with no tables/);
    assert.match(rf("QA_LABEL"), /local D1: schema from migrations, no production rows/);
    down();
  } finally {
    writeFileSync(join(D1APP, "package.json"), pkg);
  }
});
test("d1: a failed migration → 8, no server", () => {
  writeFileSync(SERVER_LOG, "");
  const r = run(["up", "--repo", D1APP, "--mode", "before", "--run-id", "d2"], { STUB_D1_RC: "1" });
  assert.equal(r.rc, 8, r.out);
  assert.match(r.out, /DB's migrations failed/);
  assert.equal(serverLog(), "");
});
test("d1: a failed qa:seed → 8, no server", () => {
  writeFileSync(SERVER_LOG, "");
  const r = run(["up", "--repo", D1APP, "--mode", "before", "--run-id", "d3"], { STUB_SEED_RC: "1" });
  assert.equal(r.rc, 8, r.out);
  assert.match(r.out, /qa:seed failed/);
  assert.equal(serverLog(), "");
});
test("d1: no D1 binding → no wrangler d1 call", () => {
  writeFileSync(D1_LOG, "");
  const r = run(["up", "--repo", SITE, "--mode", "before", "--run-id", "d4"]);
  RUNFILE = runfileOf(r.stdout);
  assert.equal(r.rc, 0, r.out);
  assert.equal(readFileSync(D1_LOG, "utf8"), "");
  down();
});
