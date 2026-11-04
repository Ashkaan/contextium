// await-push-checks.test.ts — the close's wait on a pushed commit's checks,
// run as a program against a fake GitHub behind a stub `gh` on PATH.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/await-push-checks.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "await-push-checks.ts");
const REPO = "o/r";
const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const TIP = "c".repeat(40);
const FAST = ["--interval", "0.03", "--quiet", "0.25", "--first-seen-timeout", "0.4", "--finish-timeout", "2"];

const homes: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

type Answer = { status?: number; body?: unknown; raw?: string; delayMs?: number };
/** Answers one API path; `n` counts the calls to that path without its query. */
type Handler = (path: string, n: number) => Answer | undefined;

const run = (id: number, name: string, status: string, conclusion: string | null = null, app = "github-actions") => ({
  id,
  name,
  status,
  conclusion,
  app: { slug: app },
  html_url: `https://example.test/${name}/${id}`,
});
const runs = (...list: unknown[]): Answer => ({ body: { total_count: list.length, check_runs: list } });
const statuses = (...list: unknown[]): Answer => ({
  body: { state: "pending", total_count: list.length, statuses: list },
});
const noStatuses = statuses();

/** A fake GitHub. Unhandled paths answer the empty lists (commits) or 404. */
function github(handler: Handler): Promise<string> {
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "";
    const base = path.split("?")[0] ?? "";
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    let a = handler(path, n);
    if (a === undefined && base.endsWith("/check-runs")) a = runs();
    if (a === undefined && base.endsWith("/status")) a = noStatuses;
    if (a === undefined && /\/commits\/[0-9a-f]{40}$/.test(base)) a = { body: { sha: base.slice(-40), parents: [] } };
    const answer = a ?? { status: 404 };
    setTimeout(() => {
      if (answer.status && answer.status !== 200) {
        res.writeHead(answer.status).end('{"message":"Not Found"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(answer.raw ?? JSON.stringify(answer.body));
    }, answer.delayMs ?? 0);
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`);
    }),
  );
}

/** `gh api <path>` → GET <url>?path=<path>; a non-2xx is a failed gh, as GitHub's own are. */
function env(url: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "await-push-checks-"));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `code=$(curl -sS -o "$HOME/body.$$" -w '%{http_code}' --get --data-urlencode "path=$2" "${url}")`,
      `[ "$code" = 200 ] || { echo "gh: stub said no (HTTP $code)" >&2; rm -f "$HOME/body.$$"; exit 1; }`,
      `# Real gh wraps JSON in ANSI when FORCE_COLOR or CLICOLOR_FORCE is set.`,
      `if [ -n "$FORCE_COLOR" ] || [ -n "$CLICOLOR_FORCE" ]; then printf '\\033[1;37m'; cat "$HOME/body.$$"; printf '\\033[m'; else cat "$HOME/body.$$"; fi`,
      `rm -f "$HOME/body.$$"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

async function waiter(handler: Handler, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWaiter(handler, {}, args);
}

/** Same as `waiter`, with the color variables this harness sets forced on. */
async function waiterForced(handler: Handler, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWaiter(handler, { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" }, args);
}

async function runWaiter(
  handler: Handler,
  extra: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const url = await github(handler);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", SCRIPT, "--repo", REPO, "--sha", SHA, ...FAST, ...args],
      { env: { ...env(url), ...extra } },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const checkRuns = (sha: string) => (p: string) => p.startsWith(`repos/${REPO}/commits/${sha}/check-runs`);

describe("await-push-checks: what finished", () => {
  it("one check running, then success: exit 0 and one line", async () => {
    const r = await waiter((p, n) =>
      checkRuns(SHA)(p)
        ? runs(run(1, "deploy", n < 3 ? "in_progress" : "completed", n < 3 ? null : "success"))
        : undefined,
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out, "deploy: success (https://example.test/deploy/1)\n");
  });

  it("two checks, one still running: waits for both", async () => {
    const r = await waiter((p, n) =>
      checkRuns(SHA)(p)
        ? runs(
            run(1, "sync", "completed", "success"),
            run(2, "deploy", n < 5 ? "queued" : "completed", n < 5 ? null : "success"),
          )
        : undefined,
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^sync: success/m);
    assert.match(r.out, /^deploy: success/m);
  });

  for (const bad of ["failure", "cancelled", "timed_out"]) {
    it(`a check that ends ${bad}: exit 1 naming it`, async () => {
      const r = await waiter((p) => (checkRuns(SHA)(p) ? runs(run(1, "publish", "completed", bad)) : undefined));
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.out, new RegExp(`^publish: ${bad} \\(`, "m"));
      assert.match(r.out, new RegExp(`publish ${bad}\\n$`));
    });
  }

  it("a status `error`: exit 1 naming it", async () => {
    const r = await waiter((p) =>
      p.startsWith(`repos/${REPO}/commits/${SHA}/status`)
        ? statuses({ id: 9, context: "deployer", state: "error", target_url: "https://example.test/mark" })
        : undefined,
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer error\n$/);
  });

  it("neutral and skipped pass", async () => {
    const r = await waiter((p) =>
      checkRuns(SHA)(p)
        ? runs(run(1, "lint", "completed", "neutral"), run(2, "docs", "completed", "skipped"))
        : undefined,
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^lint: neutral/m);
    assert.match(r.out, /^docs: skipped/m);
  });

  it("a check that appears after the first finished, inside the quiet interval, is waited for", async () => {
    const r = await waiter((p, n) => {
      if (!checkRuns(SHA)(p)) return undefined;
      const first = run(1, "build", "completed", "success");
      if (n < 4) return runs(first);
      return runs(first, run(2, "rebuild", n < 8 ? "in_progress" : "completed", n < 8 ? null : "failure"));
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^build: success/m);
    assert.match(r.out, /rebuild failure\n$/);
  });

  it("still running at the finish window: exit 1 `still running`, never 0", async () => {
    const r = await waiter(
      (p) => (checkRuns(SHA)(p) ? runs(run(1, "deploy", "in_progress")) : undefined),
      "--finish-timeout",
      "0.5",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deploy still running\n$/);
  });

  it("a status pending at the finish window: exit 1, never 0", async () => {
    const r = await waiter(
      (p) =>
        p.startsWith(`repos/${REPO}/commits/${SHA}/status`)
          ? statuses({ id: 3, context: "deployer", state: "pending", target_url: null })
          : undefined,
      "--finish-timeout",
      "0.5",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer still running\n$/);
  });

  it("a failed check re-run on the same commit and passing: the newest attempt decides", async () => {
    const r = await waiter((p) =>
      checkRuns(SHA)(p)
        ? runs(run(7, "deploy", "completed", "failure"), run(9, "deploy", "completed", "success"))
        : undefined,
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^deploy: success \(https:\/\/example.test\/deploy\/9\)$/m);
  });

  it("two checks with the same name from different apps are kept apart", async () => {
    const r = await waiter((p) =>
      checkRuns(SHA)(p)
        ? runs(run(1, "build", "completed", "success", "app-a"), run(2, "build", "completed", "failure", "app-b"))
        : undefined,
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^build \[app-a\]: success/m);
    assert.match(r.out, /build \[app-b\] failure\n$/);
  });

  it("31 checks over two pages: every one read", async () => {
    const all = Array.from({ length: 31 }, (_, i) => run(i + 1, `job-${i + 1}`, "completed", "success"));
    const r = await waiter((p) => {
      if (!checkRuns(SHA)(p)) return undefined;
      const page = p.includes("page=2") ? all.slice(30) : all.slice(0, 30);
      return { body: { total_count: 31, check_runs: page } };
    });
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out.trim().split("\n").length, 31);
    assert.match(r.out, /^job-31: success/m);
  });

  it("a second page that fails to read is a failed read, never a pass", async () => {
    const all = Array.from({ length: 31 }, (_, i) => run(i + 1, `job-${i + 1}`, "completed", "success"));
    const r = await waiter(
      (p) => {
        if (!checkRuns(SHA)(p)) return undefined;
        if (p.includes("page=2")) return { status: 502 };
        return { body: { total_count: 31, check_runs: all.slice(0, 30) } };
      },
      "--finish-timeout",
      "0.5",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^cannot read checks for a{40}: .*check-runs/m);
  });
});

describe("await-push-checks: what could not be read", () => {
  it("gh failing every call: exit 1 `cannot read checks`, never 0 or 3", async () => {
    const r = await waiter(() => ({ status: 500 }));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^cannot read checks for a{40}: /m);
  });

  it("FORCE_COLOR on the parent does not make gh's JSON unreadable", async () => {
    const r = await waiterForced((p) =>
      checkRuns(SHA)(p) ? runs(run(1, "deploy", "completed", "success")) : undefined,
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^deploy: success/m);
  });

  it("malformed JSON on the check runs: exit 1, never 3", async () => {
    const r = await waiter((p) => (checkRuns(SHA)(p) ? { raw: "{not json" } : undefined));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /cannot read checks.*not JSON/);
  });

  it("a check run missing its field: exit 1, never 3", async () => {
    const r = await waiter((p) =>
      checkRuns(SHA)(p)
        ? { body: { total_count: 1, check_runs: [{ id: 1, name: "x", status: "completed" }] } }
        : undefined,
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /cannot read checks.*malformed check_runs entry/);
  });

  it("the status endpoint malformed while check runs read empty: exit 1, never 3", async () => {
    const r = await waiter((p) =>
      p.startsWith(`repos/${REPO}/commits/${SHA}/status`) ? { body: { total_count: 0 } } : undefined,
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /cannot read checks.*status: malformed answer/);
  });

  it("the status endpoint failing while check runs read empty: exit 1, never 3", async () => {
    const r = await waiter((p) => (p.startsWith(`repos/${REPO}/commits/${SHA}/status`) ? { status: 500 } : undefined));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^cannot read checks for /m);
  });

  it("usage: no --repo is exit 2", async () => {
    const url = await github(() => undefined);
    const r = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, "--sha", SHA], { env: env(url) });
      child.on("close", (code) => resolve(code ?? -1));
    });
    assert.equal(r, 2);
  });
});

describe("await-push-checks: an empty commit", () => {
  const withParent =
    (h: Handler): Handler =>
    (p, n) =>
      p === `repos/${REPO}/commits/${SHA}` ? { body: { sha: SHA, parents: [{ sha: PARENT }] } } : h(p, n);

  it("nothing reported here or before: exit 3 `no deploy reported`", async () => {
    const r = await waiter(withParent(() => undefined));
    assert.equal(r.code, 3, r.out + r.err);
    assert.equal(r.out, `no deploy reported for ${REPO}\n`);
  });

  it("the previous commit had a Pages check: exit 1 `expected a deploy`", async () => {
    const r = await waiter(
      withParent((p) =>
        checkRuns(PARENT)(p)
          ? runs(run(5, "Cloudflare Pages", "completed", "success", "cloudflare-workers-and-pages"))
          : undefined,
      ),
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^expected a deploy for o\/r and none started \(bbbbbbb reported Cloudflare Pages\)$/m);
  });

  it("a lint-only parent does not hide the grandparent's Pages run from an empty commit", async () => {
    const GRAND = "e".repeat(40);
    const r = await waiter((p) => {
      if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
      if (p === `repos/${REPO}/commits/${PARENT}`) return { body: { sha: PARENT, parents: [{ sha: GRAND }] } };
      if (checkRuns(PARENT)(p)) return runs(run(2, "lint", "completed", "success"));
      if (checkRuns(GRAND)(p))
        return runs(run(5, "Cloudflare Pages", "completed", "success", "cloudflare-workers-and-pages"));
      return undefined;
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^expected a deploy for o\/r and none started \(an earlier push reported Cloudflare Pages\)$/m);
  });

  const actionsAncestor = (workflow: string, changed: string[] = []): Handler =>
    withParent((p) => {
      if (p === `repos/${REPO}/compare/${PARENT}...${SHA}`)
        return { body: { files: changed.map((filename) => ({ filename })) } };
      if (checkRuns(PARENT)(p)) return runs(run(5, "deploy", "completed", "success"));
      if (p.startsWith(`repos/${REPO}/actions/runs?head_sha=${PARENT}`)) {
        return { body: { total_count: 1, workflow_runs: [{ path: ".github/workflows/x.yml", event: "push" }] } };
      }
      if (p === `repos/${REPO}/contents/.github/workflows/x.yml?ref=${SHA}`) {
        return { body: { content: Buffer.from(workflow).toString("base64") } };
      }
      return undefined;
    });

  it("the previous commit ran a workflow that runs on every push: exit 1", async () => {
    const r = await waiter(actionsAncestor("on:\n  push:\n    branches: [main]\n"));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /expected a deploy for o\/r and none started \(bbbbbbb ran \.github\/workflows\/x\.yml/);
  });

  // A workflow whose push trigger was removed starts on no push, so the
  // previous push's run expects nothing of this one (Contextium v9.2.0 review:
  // a deploy changed to workflow_dispatch only was read as "every push").
  for (const [label, workflow] of [
    ["a block-map `on:` with no push key", "on:\n  workflow_dispatch:\njobs:\n  build: {}\n"],
    ["a scalar `on:` naming another event", "on: workflow_dispatch\n"],
    ["a flow-list `on:` without push", "on: [pull_request, workflow_dispatch]\n"],
    ["a block-list `on:` without push", "on:\n  - pull_request\n  - workflow_dispatch\n"],
    [
      "a push key below another event only",
      "on:\n  workflow_run:\n    workflows: [x]\njobs:\n  push:\n    runs-on: x\n",
    ],
  ] as const) {
    it(`the previous push's workflow no longer triggers on push (${label}): exit 3`, async () => {
      const r = await waiter(actionsAncestor(workflow, ["src/app.ts"]));
      assert.equal(r.code, 3, r.out + r.err);
      assert.equal(r.out, `no deploy reported for ${REPO}\n`);
    });
  }

  for (const [label, workflow] of [
    ["a scalar `on: push`", "on: push\n"],
    ["a flow list naming push", 'on: [pull_request, "push"]\n'],
    ["a block list naming push", "on:\n  - pull_request\n  - push # deploys\n"],
    ["an empty-map push", "on:\n  push: {}\n"],
    ["a quoted `on` key", '"on":\n  push:\n'],
  ] as const) {
    it(`an unfiltered push trigger (${label}) still expects a run: exit 1`, async () => {
      const r = await waiter(actionsAncestor(workflow, ["src/app.ts"]));
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.out, /ran \.github\/workflows\/x\.yml, which runs on every push/);
    });
  }

  it("a workflow with no readable `on:` expects a run: exit 1", async () => {
    const r = await waiter(actionsAncestor("jobs:\n  build: {}\n", ["src/app.ts"]));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /whose triggers this cannot read/);
  });

  // GitHub reads workflow YAML with anchors, aliases and tags; this reader
  // parses none of them, so an `on:` holding one is unknown, never "absent"
  // (Contextium v9.2.0 review: `on: &events [push]` was read as no push).
  for (const [label, workflow] of [
    ["an anchored flow list", "on: &events [push]\n"],
    ["an alias", "x: &events [push]\non: *events\n"],
    ["a tagged flow list", "on: !!seq [push]\n"],
    ["a merge key", "base: &base\n  push:\non:\n  <<: *base\n"],
    ["an anchored block-list item", "on:\n  - &p push\n"],
  ] as const) {
    it(`an \`on:\` holding ${label} expects a run: exit 1`, async () => {
      const r = await waiter(actionsAncestor(workflow, ["src/app.ts"]));
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.out, /whose triggers this cannot read/);
    });
  }

  const ignoreDocs = 'on:\n  push:\n    branches: [main]\n    paths-ignore: ["docs/**", README.md]\n';
  const onlySrc = "on:\n  push:\n    branches: [main]\n    paths:\n      - 'src/**' # the app\njobs:\n  build: {}\n";

  it("a path-ignoring workflow, and this push changed only ignored files: exit 3", async () => {
    const r = await waiter(actionsAncestor(ignoreDocs, ["docs/a/b.md", "README.md"]));
    assert.equal(r.code, 3, r.out + r.err);
    assert.equal(r.out, `no deploy reported for ${REPO}\n`);
  });

  it("a path-ignoring workflow, and this push changed a source file: exit 1 naming it", async () => {
    const r = await waiter(actionsAncestor(ignoreDocs, ["docs/a.md", "src/app.ts"]));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(
      r.out,
      /none started \(bbbbbbb ran \.github\/workflows\/x\.yml, which this push's src\/app\.ts starts\)/,
    );
  });

  it("a block-list `paths:` filter no changed file passes: exit 3", async () => {
    const r = await waiter(actionsAncestor(onlySrc, ["docs/src/a.md"]));
    assert.equal(r.code, 3, r.out + r.err);
  });

  it("a block-list `paths:` filter a changed file passes: exit 1", async () => {
    const r = await waiter(actionsAncestor(onlySrc, ["src/deep/x.ts"]));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /this push's src\/deep\/x\.ts starts/);
  });

  it("a filter this cannot read (a negation) expects a run: exit 1", async () => {
    const r = await waiter(
      actionsAncestor("on:\n  push:\n    paths:\n      - 'src/**'\n      - '!src/docs/**'\n", ["README.md"]),
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /whose path filter this cannot read/);
  });

  it("GitHub's `**/` also matches no folder: `docs/**/*.md` ignores docs/README.md", async () => {
    const r = await waiter(actionsAncestor('on:\n  push:\n    paths-ignore: ["docs/**/*.md"]\n', ["docs/README.md"]));
    assert.equal(r.code, 3, r.out + r.err);
  });

  it("GitHub's `?` is zero or one of the character before: `*.jsx?` matches page.js", async () => {
    const r = await waiter(actionsAncestor("on:\n  push:\n    paths: ['*.jsx?']\n", ["page.js"]));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /this push's page\.js starts/);
  });

  it("a quoted pattern keeps its comma: `'src/a,b/**'` matches src/a,b/app.ts", async () => {
    const r = await waiter(
      actionsAncestor("on:\n  push:\n    paths: ['src/a,b/**', \"lib/**\"]\n", ["src/a,b/app.ts"]),
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /this push's src\/a,b\/app\.ts starts/);
  });

  it("a push that changed no file starts no filtered workflow: exit 3", async () => {
    const r = await waiter(actionsAncestor(ignoreDocs, []));
    assert.equal(r.code, 3, r.out + r.err);
  });

  it("changed files GitHub could not list in full expect a run: exit 1", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `docs/${i}.md`);
    const r = await waiter(actionsAncestor(ignoreDocs, many));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /changed too many files to tell/);
  });
});

describe("await-push-checks: what the last push reported", () => {
  const deployer = (id: number, state: string) => ({
    id,
    context: "deployer",
    state,
    target_url: `https://example.test/mark/${id}`,
  });
  /** The parent carried a build and the deployer's mark; this commit's build
   *  passes, and its own mark comes from `mark(n)` on the n-th status read. */
  const marked =
    (mark: (n: number) => unknown[], extra: Handler = () => undefined): Handler =>
    (p, n) => {
      if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
      if (checkRuns(PARENT)(p)) return runs(run(1, "build", "completed", "success"));
      if (p.startsWith(`repos/${REPO}/commits/${PARENT}/status`)) return statuses(deployer(1, "success"));
      if (checkRuns(SHA)(p)) return runs(run(2, "build", "completed", "success"));
      if (p.startsWith(`repos/${REPO}/commits/${SHA}/status`)) return statuses(...mark(n));
      return extra(p, n);
    };

  it("a mark that comes after the quiet interval is waited for", async () => {
    const r = await waiter(marked((n) => (n < 12 ? [] : [deployer(2, "success")])));
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^deployer: success \(https:\/\/example.test\/mark\/2\)$/m);
  });

  it("a mark that never comes: exit 1 `never reported`, never 0", async () => {
    const r = await waiter(
      marked(() => []),
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer never reported\n$/);
  });

  it("a missing mark is settled by a later trunk commit that carries one", async () => {
    const r = await waiter(
      marked(
        () => [],
        (p) => {
          if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
          if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
          if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
          if (p === `repos/${REPO}/commits/${TIP}`) return { body: { sha: TIP, parents: [{ sha: SHA }] } };
          if (checkRuns(TIP)(p)) return runs(run(3, "build", "completed", "success"));
          if (p.startsWith(`repos/${REPO}/commits/${TIP}/status`)) return statuses(deployer(3, "success"));
          return undefined;
        },
      ),
      "--finish-timeout",
      "3",
    );
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc, whose checks decide \(deployer not reported\)$/m);
    assert.match(r.out, /^deployer: success \(https:\/\/example.test\/mark\/3\)$/m);
  });
});

describe("await-push-checks: a later commit owes what the abandoned one did", () => {
  it("a later commit with no mark of its own does not settle a missing mark", async () => {
    const deployer = { id: 1, context: "deployer", state: "success", target_url: null };
    const r = await waiter(
      (p) => {
        if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
        if (p === `repos/${REPO}/commits/${TIP}`) return { body: { sha: TIP, parents: [{ sha: SHA }] } };
        if (checkRuns(PARENT)(p) || checkRuns(SHA)(p) || checkRuns(TIP)(p))
          return runs(run(1, "build", "completed", "success"));
        if (p.startsWith(`repos/${REPO}/commits/${PARENT}/status`)) return statuses(deployer);
        if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
        if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
        if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
        return undefined;
      },
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc/m);
    assert.match(r.out, /deployer never reported\n$/);
  });
});

describe("await-push-checks: marks owed from further back", () => {
  const GRAND = "d".repeat(40);
  const mark = { id: 1, context: "deployer", state: "success", target_url: null };
  const build = (c: string | null = "success") => runs(run(1, "build", "completed", c));
  const lineage: Handler = (p) => {
    if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
    if (p === `repos/${REPO}/commits/${PARENT}`) return { body: { sha: PARENT, parents: [{ sha: GRAND }] } };
    if (p === `repos/${REPO}/commits/${TIP}`) return { body: { sha: TIP, parents: [{ sha: SHA }] } };
    if (checkRuns(PARENT)(p) || checkRuns(GRAND)(p) || checkRuns(TIP)(p)) return build();
    if (p.startsWith(`repos/${REPO}/commits/${GRAND}/status`)) return statuses(mark);
    return undefined;
  };

  it("a parent with a build but no mark does not hide the grandparent's mark", async () => {
    const r = await waiter((p, n) => (checkRuns(SHA)(p) ? build() : lineage(p, n)), "--finish-timeout", "1");
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer never reported\n$/);
  });

  it("a cancel settled by a later commit carries the mark it was owed", async () => {
    const r = await waiter(
      (p, n) => {
        if (checkRuns(SHA)(p)) return build("cancelled");
        if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
        if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
        if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
        return lineage(p, n);
      },
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc/m);
    assert.match(r.out, /deployer never reported\n$/);
  });
});

describe("await-push-checks: a deploy app's run is owed like a mark", () => {
  // A check run from an app other than Actions (a hosted deploy such as
  // Cloudflare Pages) runs on every push, so a commit whose other checks ran
  // still owes it: a broken deploy trigger must not pass on lint alone.
  const lineage: Handler = (p) => {
    if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
    if (checkRuns(PARENT)(p)) return runs(run(1, "Cloudflare Pages", "completed", "success", "cloudflare-pages"));
    return undefined;
  };
  it("a parent's deploy-app run missing here fails, named", async () => {
    const r = await waiter(
      (p, n) => (checkRuns(SHA)(p) ? runs(run(2, "lint", "completed", "success")) : lineage(p, n)),
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /Cloudflare Pages never reported\n$/);
  });
  it("a lint-only parent does not hide the grandparent's deploy-app run", async () => {
    const GRAND = "e".repeat(40);
    const r = await waiter(
      (p) => {
        if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
        if (p === `repos/${REPO}/commits/${PARENT}`) return { body: { sha: PARENT, parents: [{ sha: GRAND }] } };
        if (checkRuns(SHA)(p) || checkRuns(PARENT)(p)) return runs(run(2, "lint", "completed", "success"));
        if (checkRuns(GRAND)(p)) return runs(run(1, "Cloudflare Pages", "completed", "success", "cloudflare-pages"));
        return undefined;
      },
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /Cloudflare Pages never reported\n$/);
  });
  it("the deploy-app run present here passes", async () => {
    const r = await waiter((p, n) =>
      checkRuns(SHA)(p)
        ? runs(
            run(2, "lint", "completed", "success"),
            run(3, "Cloudflare Pages", "completed", "success", "cloudflare-pages"),
          )
        : lineage(p, n),
    );
    assert.equal(r.code, 0, r.out + r.err);
  });
});

describe("await-push-checks: lookups that take a while", () => {
  it("a later commit that reported nothing does not settle a missing mark", async () => {
    const mark = { id: 1, context: "deployer", state: "success", target_url: null };
    const r = await waiter(
      (p) => {
        if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
        if (checkRuns(PARENT)(p) || checkRuns(SHA)(p)) return runs(run(1, "build", "completed", "success"));
        if (p.startsWith(`repos/${REPO}/commits/${PARENT}/status`)) return statuses(mark);
        if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
        if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
        if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
        return undefined;
      },
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.doesNotMatch(r.out, /superseded/);
    assert.match(r.out, /deployer never reported\n$/);
  });

  it("a status that appears during the ancestor walk is read before any verdict", async () => {
    let walked = false;
    const r = await waiter((p) => {
      if (p === `repos/${REPO}/commits/${SHA}`) {
        walked = true;
        return { body: { sha: SHA, parents: [] }, delayMs: 400 };
      }
      if (checkRuns(SHA)(p)) return runs(run(1, "build", "completed", "success"));
      if (walked && p.startsWith(`repos/${REPO}/commits/${SHA}/status`)) {
        return statuses({ id: 5, context: "deployer", state: "failure", target_url: null });
      }
      return undefined;
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer failure\n$/);
  });

  it("a check that appears during the empty-commit lookup is read before any verdict", async () => {
    let looked = false;
    const r = await waiter((p) => {
      if (p === `repos/${REPO}/commits/${SHA}`) return { body: { sha: SHA, parents: [{ sha: PARENT }] } };
      if (checkRuns(PARENT)(p)) return runs(run(5, "deploy", "completed", "success"));
      if (p.startsWith(`repos/${REPO}/actions/runs?head_sha=${PARENT}`)) {
        looked = true;
        return { body: { total_count: 1, workflow_runs: [{ path: ".github/workflows/x.yml", event: "push" }] } };
      }
      if (p === `repos/${REPO}/contents/.github/workflows/x.yml?ref=${SHA}`) {
        return { body: { content: Buffer.from('on:\n  push:\n    paths-ignore: ["docs/**"]\n').toString("base64") } };
      }
      if (p === `repos/${REPO}/compare/${PARENT}...${SHA}`) return { body: { files: [{ filename: "docs/a.md" }] } };
      if (looked && checkRuns(SHA)(p)) return runs(run(6, "deploy", "completed", "failure"));
      return undefined;
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deploy failure\n$/);
  });
});

describe("await-push-checks: what an abandoned commit owed", () => {
  it("a later commit owes the abandoned commit's marks even past its own walk", async () => {
    // SHA → c1 → … → c10, and only c10 is marked: SHA's walk (ten parents)
    // reaches it, the later TIP's (TIP → SHA → c1 … c9) does not.
    const c = (i: number) => `e${"0".repeat(37)}${String(i).padStart(2, "0")}`;
    const parentOf = new Map<string, string>([
      [TIP, SHA],
      [SHA, c(1)],
    ]);
    for (let i = 1; i < 10; i++) parentOf.set(c(i), c(i + 1));
    const r = await waiter(
      (p) => {
        const m = p.match(/^repos\/o\/r\/commits\/([0-9a-f]{40})$/);
        const parent = m ? parentOf.get(m[1] ?? "") : undefined;
        if (m && parent) return { body: { sha: m[1], parents: [{ sha: parent }] } };
        if (/^repos\/o\/r\/commits\/[0-9a-f]{40}\/check-runs/.test(p))
          return runs(run(1, "build", "completed", "success"));
        if (p.startsWith(`repos/${REPO}/commits/${c(10)}/status`)) {
          return statuses({ id: 1, context: "deployer", state: "success", target_url: null });
        }
        if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
        if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
        if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
        return undefined;
      },
      "--finish-timeout",
      "3",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc/m);
    assert.match(r.out, /deployer never reported\n$/);
  });
});

describe("await-push-checks: when a verdict may be drawn", () => {
  it("the attempt counted must be in the newest read: a passing re-run that drops out is not passed", async () => {
    const r = await waiter(
      (p, n) =>
        checkRuns(SHA)(p)
          ? n < 3
            ? runs(run(7, "deploy", "completed", "failure"), run(9, "deploy", "completed", "success"))
            : runs(run(7, "deploy", "completed", "failure"))
          : undefined,
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deploy no longer reported\n$/);
  });

  it("the quiet interval restarts when a check finishes: a status after a long build is caught", async () => {
    const r = await waiter((p, n) => {
      if (checkRuns(SHA)(p))
        return runs(run(1, "build", n < 14 ? "in_progress" : "completed", n < 14 ? null : "success"));
      if (p.startsWith(`repos/${REPO}/commits/${SHA}/status`) && n >= 17) {
        return statuses({ id: 4, context: "deployer", state: "failure", target_url: null });
      }
      return undefined;
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer failure\n$/);
  });

  it("a passed check that drops out of the newest read is never passed on the old one", async () => {
    const r = await waiter(
      (p, n) => (checkRuns(SHA)(p) ? (n < 3 ? runs(run(1, "deploy", "completed", "success")) : runs()) : undefined),
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deploy no longer reported\n$/);
  });
});

describe("await-push-checks: a cancelled check", () => {
  const cancelled: Handler = (p) => (checkRuns(SHA)(p) ? runs(run(1, "build", "completed", "cancelled")) : undefined);

  it("is settled by a later trunk commit that contains it and passes", async () => {
    const r = await waiter((p, n) => {
      if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
      if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
      if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
      if (checkRuns(TIP)(p)) return runs(run(2, "build", "completed", "success"));
      return cancelled(p, n);
    });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc, whose checks decide \(build cancelled\)$/m);
    assert.match(r.out, /^build: success/m);
  });

  it("with no later trunk commit stays a failure", async () => {
    const r = await waiter((p, n) => {
      if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
      if (p === `repos/${REPO}/commits/main`) return { body: { sha: SHA } };
      return cancelled(p, n);
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /build cancelled\n$/);
  });
});

// A status in state `error` is a marker that could not judge — a deployer's
// "internal error", which it may never re-mark once a newer build is live —
// not a verdict on the commit. A later trunk commit that contains it and passes
// settles it; a `failure` never is. Otherwise a deployer that lost a repo read
// for an hour would leave every close it errored on unable to finish after the
// fix went live.
describe("await-push-checks: a status that errored", () => {
  const mark = (state: string) => statuses({ id: 1, context: "deployer", state, target_url: null });
  const tip: Handler = (p) => {
    if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
    if (p === `repos/${REPO}/commits/main`) return { body: { sha: TIP } };
    if (p === `repos/${REPO}/compare/${SHA}...${TIP}`) return { body: { status: "ahead" } };
    if (checkRuns(TIP)(p)) return runs(run(2, "build", "completed", "success"));
    if (p.startsWith(`repos/${REPO}/commits/${TIP}/status`))
      return statuses({ id: 2, context: "deployer", state: "success", target_url: null });
    return undefined;
  };
  const commit =
    (state: string): Handler =>
    (p) => {
      if (checkRuns(SHA)(p)) return runs(run(1, "build", "completed", "success"));
      if (p.startsWith(`repos/${REPO}/commits/${SHA}/status`)) return mark(state);
      return undefined;
    };

  it("is settled by a later trunk commit that contains it and passes", async () => {
    const r = await waiter((p, n) => commit("error")(p, n) ?? tip(p, n));
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc, whose checks decide \(deployer error\)$/m);
    assert.match(r.out, /^deployer: success/m);
  });

  it("the later commit owes the mark that errored: a tip with a build and no mark does not pass", async () => {
    const r = await waiter(
      (p, n) => {
        if (p.startsWith(`repos/${REPO}/commits/${TIP}/status`)) return noStatuses;
        return commit("error")(p, n) ?? tip(p, n);
      },
      "--finish-timeout",
      "1",
    );
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^aaaaaaa superseded by ccccccc/m);
    assert.match(r.out, /deployer never reported\n$/);
  });

  it("a failure is not settled by a later commit", async () => {
    const r = await waiter((p, n) => commit("failure")(p, n) ?? tip(p, n));
    assert.equal(r.code, 1, r.out + r.err);
    assert.doesNotMatch(r.out, /superseded/);
    assert.match(r.out, /deployer failure\n$/);
  });

  it("with no later trunk commit stays a failure", async () => {
    const r = await waiter((p, n) => {
      if (p === `repos/${REPO}`) return { body: { default_branch: "main" } };
      if (p === `repos/${REPO}/commits/main`) return { body: { sha: SHA } };
      return commit("error")(p, n);
    });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /deployer error\n$/);
  });
});
