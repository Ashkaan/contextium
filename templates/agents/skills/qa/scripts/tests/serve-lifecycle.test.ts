// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/serve-lifecycle.test.ts
// Exercise the actual CLI and real loopback servers, including the prebuilt
// comparison-server path. No server is discovered or killed by port.
// peers: ../serve.ts ../static-serve.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "serve.ts");
const TMP = mkdtempSync(join(tmpdir(), "qa-lifecycle-"));
const REPO = join(TMP, "old build");
const DIST = join(REPO, "dist");
mkdirSync(join(DIST, "about"), { recursive: true });
writeFileSync(join(DIST, "index.html"), "<h1>old build</h1>");
writeFileSync(join(DIST, "about", "index.html"), "<h1>about</h1>");
writeFileSync(join(DIST, "app.css"), "body{color:red}");
writeFileSync(join(REPO, "secret.txt"), "outside the served directory");
// A baseline must bypass the Astro build and the live-data/sign-in paths.
writeFileSync(
  join(REPO, "package.json"),
  '{"dependencies":{"astro":"7","wrangler":"4"},"scripts":{"build":"exit 99"}}',
);
writeFileSync(join(REPO, "wrangler.toml"), 'name="must-not-use-live-bindings"\n');
let runfile = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8", timeout: 25_000 });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout ?? "" };
}

function field(text: string, key: string): string {
  return (new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "").replace(/\\(.)/g, "$1");
}

async function request(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...options, headers: { ...options.headers, Connection: "close" } });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

after(() => {
  if (runfile && existsSync(runfile)) run(["down", "--runfile", runfile, "--clean"]);
  rmSync(TMP, { recursive: true, force: true });
});

test("prebuilt comparison servers have an owned, restartable lifecycle", async () => {
  const port = await freePort();
  const args = [
    "up",
    "--repo",
    REPO,
    "--dist",
    DIST,
    "--mode",
    "before",
    "--run-id",
    `lifecycle-${process.pid}`,
    "--port",
    String(port),
  ];
  const up = run(args);
  assert.equal(up.rc, 0, `prebuilt server must start without building Astro: ${up.out}`);
  runfile = field(up.stdout, "QA_RUNFILE");
  assert.ok(existsSync(runfile), `up must emit its runfile: ${up.out}`);
  assert.equal(field(up.stdout, "QA_CAPTURE_DIR"), dirname(runfile));
  assert.match(up.out, /starting static server/);
  assert.match(field(up.stdout, "QA_LABEL"), /prebuilt/);
  const url = field(up.stdout, "QA_URL");
  assert.equal(await (await request(url)).text(), "<h1>old build</h1>");
  assert.equal(await (await request(`${url}/about/?x=1`)).text(), "<h1>about</h1>");
  const css = await request(`${url}/app.css`);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.equal((await request(`${url}/app.css`, { method: "HEAD" })).status, 200);
  assert.equal((await request(`${url}/missing`)).status, 404);
  assert.equal((await request(`${url}/%ZZ`)).status, 400);
  assert.equal((await request(`${url}/%2e%2e%2fsecret.txt`)).status, 403);
  assert.equal((await request(url, { method: "POST" })).status, 405);

  const status = run(["status", "--runfile", runfile]);
  assert.equal(status.rc, 0, status.out);
  assert.equal(field(status.stdout, "QA_ALIVE"), "yes");
  const firstPid = field(up.stdout, "QA_PID");
  const original = readFileSync(runfile, "utf8");
  const duplicate = run(args);
  assert.equal(duplicate.rc, 2, "up must not overwrite a running server's ownership record");
  assert.match(duplicate.out, /already running/);
  assert.equal(readFileSync(runfile, "utf8"), original);

  const capture = join(dirname(runfile), "index-390.png");
  writeFileSync(capture, "capture must survive restart");
  const replacement = join(dirname(runfile), "passes", "review-2", "site", "run");
  mkdirSync(replacement, { recursive: true });
  writeFileSync(join(replacement, "index-390.png"), "replacement evidence");
  const restart = run(["restart", "--runfile", runfile]);
  assert.equal(restart.rc, 0, restart.out);
  assert.notEqual(field(restart.stdout, "QA_PID"), firstPid);
  assert.equal(field(restart.stdout, "QA_URL"), url);
  assert.ok(existsSync(capture), "restart must preserve captures until the reviewer finishes");
  assert.ok(existsSync(replacement), "restart must preserve replacement evidence too");
  assert.equal(await (await request(url)).text(), "<h1>old build</h1>");

  const foreignScript = join(TMP, "unrelated.ts");
  writeFileSync(foreignScript, "setInterval(() => {}, 1000);\n");
  const foreign = spawn(process.execPath, ["--experimental-strip-types", foreignScript], { detached: true, stdio: "ignore" });
  const foreignDone = once(foreign, "exit");
  try {
    assert.ok(foreign.pid);
    const reused = join(TMP, "reused.run");
    writeFileSync(reused, readFileSync(runfile, "utf8").replace(/^QA_PID=.*$/m, `QA_PID=${foreign.pid}`));
    const probe = run(["status", "--runfile", reused]);
    assert.equal(probe.rc, 1, "status must not mistake a reused PID for the recorded server");
    const reject = run(["down", "--runfile", reused]);
    assert.equal(reject.rc, 2, "teardown must refuse a process whose identity differs from the record");
    assert.match(reject.out, /identity/);
    assert.doesNotThrow(() => process.kill(foreign.pid ?? 0, 0), "the unrelated process must survive");
  } finally {
    foreign.kill("SIGTERM");
    await foreignDone;
  }

  const outside = join(TMP, "server.run");
  writeFileSync(outside, readFileSync(runfile, "utf8").replaceAll(runfile, outside));
  const unsafe = run(["down", "--runfile", outside, "--clean"]);
  assert.equal(unsafe.rc, 2, "clean must refuse a directory outside the QA captures root before stopping anything");
  assert.ok(existsSync(join(REPO, "secret.txt")));
  assert.equal((await request(url)).status, 200);

  const stale = join(TMP, "stale.run");
  writeFileSync(stale, readFileSync(runfile, "utf8"));
  writeFileSync(
    runfile,
    readFileSync(runfile, "utf8")
      .replace(/^QA_PID_IDENTITY=.*\n/m, "")
      .replace(/^QA_RUNFILE=.*\n/m, ""),
  );
  const legacyStatus = run(["status", "--runfile", runfile]);
  assert.equal(legacyStatus.rc, 0, "legacy ownership must be proved by its process group and recorded stdout log");
  const down = run(["down", "--runfile", runfile, "--clean"]);
  assert.equal(down.rc, 0, down.out);
  assert.equal(existsSync(dirname(runfile)), false, "down --clean must remove its captures, log and runfile");
  assert.ok(existsSync(join(REPO, "secret.txt")), "cleanup must not remove the baseline source");
  await assert.rejects(request(url), "down must stop the owned listener");
  runfile = "";
  const stopped = run(["status", "--runfile", stale]);
  assert.equal(stopped.rc, 1, stopped.out);
  assert.equal(field(stopped.stdout, "QA_ALIVE"), "no");
});

test("simultaneous starts cannot overwrite one run's ownership", async () => {
  const ports = [await freePort(), await freePort()];
  const results: { rc: number | null; out: string }[] = [];
  try {
    await Promise.all(
      ports.map(
        (port) =>
          new Promise<void>((done) => {
            const child = spawn(process.execPath, [
              "--experimental-strip-types",
              SCRIPT,
              "up",
              "--repo",
              REPO,
              "--dist",
              DIST,
              "--mode",
              "before",
              "--run-id",
              `race-${process.pid}`,
              "--port",
              String(port),
            ]);
            let out = "";
            child.stdout.on("data", (data) => {
              out += data;
            });
            child.stderr.on("data", (data) => {
              out += data;
            });
            child.on("close", (rc) => {
              results.push({ rc, out });
              done();
            });
          }),
      ),
    );
    assert.deepEqual(results.map((r) => r.rc).sort(), [0, 2], "exactly one simultaneous start must succeed");
    assert.match(results.find((r) => r.rc === 2)?.out ?? "", /lifecycle.*busy|already running/);
  } finally {
    for (const r of results.filter((r) => r.rc === 0)) {
      const file = field(r.out, "QA_RUNFILE");
      if (existsSync(file)) run(["down", "--runfile", file, "--clean"]);
      // Before the serialization fix both servers started; each PID in these
      // child outputs belongs to this test, including the overwritten one.
      const pid = Number(field(r.out, "QA_PID"));
      if (pid > 1) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          /* already stopped */
        }
      }
    }
  }
});

test("teardown owns surviving children after the launcher exits", async () => {
  const repo = join(TMP, "orphan-server");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "qa:serve": "node --experimental-strip-types app.ts" } }));
  writeFileSync(
    join(repo, "app.ts"),
    'import { createServer } from "node:http"; createServer((q,s)=>s.end("child survives")).listen(Number(process.env.PORT));',
  );
  const up = run([
    "up",
    "--repo",
    repo,
    "--mode",
    "before",
    "--run-id",
    `orphan-${process.pid}`,
    "--port",
    String(await freePort()),
  ]);
  assert.equal(up.rc, 0, up.out);
  const file = field(up.stdout, "QA_RUNFILE");
  const pid = Number(field(up.stdout, "QA_PID"));
  const url = field(up.stdout, "QA_URL");
  try {
    process.kill(pid, "SIGKILL");
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(await (await request(url)).text(), "child survives", "fixture must retain a listening child");
    const status = run(["status", "--runfile", file]);
    assert.equal(status.rc, 0, "status must recognize the owned surviving process group");
    const restart = run(["restart", "--runfile", file]);
    assert.equal(restart.rc, 0, `restart must replace the surviving group: ${restart.out}`);
    assert.notEqual(field(restart.stdout, "QA_PID"), String(pid));
    assert.equal(await (await request(url)).text(), "child survives");
    const down = run(["down", "--runfile", file, "--clean"]);
    assert.equal(down.rc, 0, down.out);
    await assert.rejects(request(url), "teardown must stop children even with no live launcher");
    assert.equal(existsSync(dirname(file)), false);
  } finally {
    if (existsSync(file)) run(["down", "--runfile", file, "--clean"]);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already stopped */
    }
  }
});

test("capture-only runs share managed cleanup without a server", () => {
  const args = ["up", "--repo", REPO, "--mode", "capture", "--run-id", `capture-${process.pid}`];
  const up = run(args);
  assert.equal(up.rc, 0, up.out);
  const file = field(up.stdout, "QA_RUNFILE");
  try {
    const status = run(["status", "--runfile", file]);
    assert.equal(status.rc, 0, status.out);
    assert.equal(field(status.stdout, "QA_STATUS"), "capture");
    writeFileSync(join(dirname(file), "cli-stdout.txt"), "captured output");
    assert.equal(run(args).rc, 2, "an active capture record must not be overwritten");
    assert.equal(run(["restart", "--runfile", file]).rc, 2, "capture-only runs have no server to restart");
    assert.equal(run(["down", "--runfile", file, "--clean"]).rc, 0);
    assert.equal(existsSync(dirname(file)), false);
  } finally {
    if (existsSync(file)) run(["down", "--runfile", file, "--clean"]);
  }
});

test("lifecycle commands reject missing, invalid and legacy inputs", () => {
  for (const command of ["status", "restart"]) {
    const missing = run([command, "--runfile", join(TMP, "absent.run")]);
    assert.equal(missing.rc, 2, `${command}: ${missing.out}`);
    assert.match(missing.out, /runfile/);
  }
  const unsafe = join(TMP, "unsafe.run");
  for (const pid of ["0", "1", "-1", "NaN"]) {
    writeFileSync(unsafe, `QA_PID=${pid}\n`);
    const r = run(["down", "--runfile", unsafe]);
    assert.equal(r.rc, 2, `invalid pid ${pid} must be rejected before signaling`);
    assert.match(r.out, /pid/i);
  }
  writeFileSync(unsafe, "QA_PID=\n");
  const legacy = run(["restart", "--runfile", unsafe]);
  assert.equal(legacy.rc, 2);
  assert.match(legacy.out, /start arguments/);
  const dist = run(["up", "--repo", REPO, "--dist", join(TMP, "missing"), "--mode", "before", "--run-id", "missing"]);
  assert.equal(dist.rc, 2);
  assert.match(dist.out, /dist/);
  for (const mode of ["after", "live"]) {
    const r = run(["up", "--repo", REPO, "--dist", DIST, "--mode", mode, "--run-id", "bad-mode"]);
    assert.equal(r.rc, 2, `prebuilt bytes must not masquerade as ${mode}`);
    assert.match(r.out, /dist.*before/);
  }
  for (const port of ["0", "65536", "NaN"]) {
    const r = run(["up", "--repo", REPO, "--dist", DIST, "--mode", "before", "--run-id", "bad-port", "--port", port]);
    assert.equal(r.rc, 2, `invalid port ${port} must be rejected`);
    assert.match(r.out, /port/);
  }
  for (const args of [
    ["up", "--repo", REPO, "--dist"],
    ["up", "--repo", REPO, "--dist", "", "--mode", "before", "--run-id", "empty"],
    ["up", "--repo", REPO, "--mode", "before", "--run-id", "../outside"],
  ]) {
    const r = run(args);
    assert.equal(r.rc, 2, `invalid lifecycle argument list: ${JSON.stringify(args)}`);
    assert.match(r.out, /missing value|one directory name/);
  }
  for (const args of [
    ["up", "--repo", REPO, "--mode", "before", "--run-id", "first", "--run-id", "second"],
    ["down", "--runfile", unsafe, "--runfile", unsafe],
  ]) {
    const r = run(args);
    assert.equal(r.rc, 2, "duplicate flags must be rejected before choosing a lock or mutating files");
    assert.match(r.out, /duplicate/);
  }
  for (const args of [[], [DIST, "0"], [DIST, "65536"], [join(TMP, "missing"), "4242"]]) {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", join(dirname(SCRIPT), "static-serve.ts"), ...args], {
      encoding: "utf8",
    });
    assert.equal(r.status, 2, `static server must reject ${JSON.stringify(args)}`);
    assert.match(r.stderr, /usage: static-serve/);
  }
});
