// Run: node --experimental-strip-types .agents/skills/qa/scripts/tests/static-serve.test.ts
// The static server is exercised as a program, never imported.
// peers: ../static-serve.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "static-serve.ts");
const TMP = mkdtempSync(join(tmpdir(), "qa-static-"));
const ROOT = join(TMP, "built files");
mkdirSync(ROOT);
mkdirSync(join(ROOT, "about"));
writeFileSync(join(ROOT, "index.html"), "<h1>baseline</h1>");
writeFileSync(join(ROOT, "icon.svg"), "<svg/>");
writeFileSync(join(ROOT, "about", "index.html"), '<link rel="stylesheet" href="app.css">');
writeFileSync(join(ROOT, "about", "app.css"), "body{color:red}");
after(() => rmSync(TMP, { recursive: true, force: true }));

test("invalid arguments produce usage and exit 2", () => {
  for (const args of [[], [ROOT, ""], [ROOT, "0"], [ROOT, "65536"], [ROOT, "NaN"], [join(TMP, "missing"), "4242"]]) {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage: static-serve/);
  }
});

test("an occupied port fails without affecting its current owner", async () => {
  const held = createServer();
  await new Promise<void>((done) => held.listen(0, "127.0.0.1", done));
  try {
    const address = held.address();
    assert.ok(address && typeof address === "object");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ROOT, String(address.port)], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /EADDRINUSE/);
    assert.equal(held.listening, true);
  } finally {
    await new Promise<void>((done) => held.close(() => done()));
  }
});

test("the command serves HTML and assets from a directory containing spaces", async () => {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done) => reservation.close(() => done()));
  const server = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, ROOT, String(address.port)], { stdio: "ignore" });
  const done = once(server, "exit");
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100 && !response; attempt++) {
      response = await fetch(`http://127.0.0.1:${address.port}/`, { headers: { Connection: "close" } }).catch(
        () => undefined,
      );
      if (!response) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(response, "static server must become reachable");
    assert.equal(await response.text(), "<h1>baseline</h1>");
    const directory = await fetch(`http://127.0.0.1:${address.port}/about?x=1`, { redirect: "manual" });
    assert.equal(directory.status, 301, "directory pages need a trailing slash for relative assets");
    assert.equal(directory.headers.get("location"), "/about/?x=1");
    const svg = await fetch(`http://127.0.0.1:${address.port}/icon.svg`);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.equal(await svg.text(), "<svg/>");
    writeFileSync(join(ROOT, "module.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const module = await WebAssembly.compileStreaming(fetch(`http://127.0.0.1:${address.port}/module.wasm`));
    assert.ok(module instanceof WebAssembly.Module, "browser-style streaming WebAssembly must load assets");
  } finally {
    server.kill("SIGTERM");
    await done;
  }
});
