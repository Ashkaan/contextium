#!/usr/bin/env -S node --experimental-strip-types
// screenshot-lazy.test.ts — a lazy-loaded image below the fold is in the shot.
//
// Why this exists: a home page's row of photos was `loading="lazy"`, and every
// full-page shot of it caught them as pure white, while a live browser showed
// all of them. A
// fullPage screenshot does not scroll, and the reveal pass's scroll moved on
// before a lazily requested image had arrived, so the capture photographed the
// placeholder. The reviewer had to spend a pass proving the site was fine.
//
// screenshot.ts is a program and is spawned. The page is served locally: a
// 3,000px spacer, then a lazy <img> whose bytes the server sends 3s late.
// Needs a Playwright with an installed chromium and ImageMagick; without it every case reports SKIP rather than a pass. A test
// never installs anything: QA_NO_INSTALL=1 keeps the first-use installs off.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/screenshot-lazy.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaPlaywrightNodeModules } from "./lib.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

process.env.QA_NO_INSTALL = "1";
const skip =
  qaPlaywrightNodeModules() === undefined
    ? "no Playwright with an installed chromium"
    : spawnSync("sh", ["-c", "command -v magick"]).status === 0
      ? false
      : "no ImageMagick";

/** The bottom shot of the page, whole or its last part: these pages are taller
 *  than one part, and the image sits 400px above the page's end. */
function lastPart(runDir: string): string {
  const rows = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as { route: string; path: string }[];
  const path = rows.filter((m) => m.route === "/").at(-1)?.path ?? "";
  assert.ok(path, `no shot of / in ${runDir}`);
  return path;
}
const tmp = mkdtempSync(join(tmpdir(), "qa-lazy-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A 200x200 solid red PNG, made once with ImageMagick.
const RED = skip ? Buffer.alloc(0) : execFileSync("magick", ["-size", "200x200", "xc:#ff0000", "png:-"]);

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ rc: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SCRIPT_DIR, "screenshot.ts"), ...args], {
      env: { ...process.env, ...env },
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

test("a lazy image 9,000px down, served 3s late, is in the full-page shot", { skip }, async () => {
  const s = createServer((q, r) => {
    if (q.url === "/red.png") {
      setTimeout(() => {
        r.writeHead(200, { "content-type": "image/png" });
        r.end(RED);
      }, 3000);
      return;
    }
    r.writeHead(200, { "content-type": "text/html" });
    r.end(
      `<!doctype html><title>t</title><body style="margin:0;background:#fff;font:20px sans-serif">` +
        `<p style="padding:20px">${"text ".repeat(100)}</p><div style="height:9000px"></div>` +
        `<img id="late" src="/red.png" loading="lazy" width="200" height="200" style="display:block;margin-left:100px">` +
        `<div style="height:400px"></div></body>`,
    );
  });
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
  const a = s.address();
  const port = typeof a === "object" && a !== null ? a.port : 0;
  const shots = join(tmp, "shots");
  try {
    const r = await run(
      [
        "--url",
        `http://127.0.0.1:${port}`,
        "--repo-slug",
        "t",
        "--run-id",
        "lazy",
        "--pages",
        "/",
        "--viewports",
        "800",
        "--no-motion",
      ],
      { QA_SHOTS_ROOT: shots },
    );
    assert.equal(r.rc, 0, r.out);
    // The image's centre: 100px in, below the paragraph and the spacer.
    const shot = lastPart(join(shots, "t", "lazy"));
    const height = Number(execFileSync("magick", ["identify", "-format", "%h", shot], { encoding: "utf8" }));
    const y = height - 400 - 100;
    const pixel = execFileSync("magick", [shot, "-format", `%[hex:p{200,${y}}]`, "info:"], { encoding: "utf8" });
    assert.match(pixel, /^FF0000/i, `the lazy image's centre is #${pixel}, not red`);
  } finally {
    s.close();
  }
});

test("an image that never arrives is named on stderr after the wait, and the page is still shot", { skip }, async () => {
  const s = createServer((q, r) => {
    if (q.url === "/never.png") return; // held open: no answer at all
    r.writeHead(200, { "content-type": "text/html" });
    r.end(
      `<!doctype html><title>t</title><body style="margin:0;font:20px sans-serif"><p>${"text ".repeat(100)}</p>` +
        `<div style="height:9000px"></div><img src="/never.png" loading="lazy" width="200" height="200"></body>`,
    );
  });
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
  const a = s.address();
  const port = typeof a === "object" && a !== null ? a.port : 0;
  try {
    const r = await run(
      [
        "--url",
        `http://127.0.0.1:${port}`,
        "--repo-slug",
        "t",
        "--run-id",
        "never",
        "--pages",
        "/",
        "--viewports",
        "800",
        "--no-motion",
      ],
      { QA_SHOTS_ROOT: join(tmp, "shots"), QA_IMAGE_WAIT_MS: "1500" },
    );
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /screenshot: \/ @800 — 1 image\(s\) still loading after 1500ms; they may show empty/);
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

test("an image the page inserts while it is scrolled, served 3s late, is in the shot too", { skip }, async () => {
  const s = createServer((q, r) => {
    if (q.url === "/late.png") {
      setTimeout(() => {
        r.writeHead(200, { "content-type": "image/png" });
        r.end(RED);
      }, 3000);
      return;
    }
    r.writeHead(200, { "content-type": "text/html" });
    r.end(
      `<!doctype html><title>t</title><body style="margin:0;background:#fff;font:20px sans-serif">` +
        `<p style="padding:20px">${"text ".repeat(100)}</p><div style="height:9000px"></div>` +
        `<div id="slot" style="height:200px"></div><div style="height:400px"></div>` +
        `<script>addEventListener("scroll", () => { const s = document.getElementById("slot");` +
        ` if (!s.firstChild && scrollY > 7000) { const i = new Image(200, 200); i.src = "/late.png";` +
        ` i.style.cssText = "display:block;margin-left:100px"; s.appendChild(i); } });</script></body>`,
    );
  });
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
  const a = s.address();
  const port = typeof a === "object" && a !== null ? a.port : 0;
  const shots = join(tmp, "shots");
  try {
    const r = await run(
      [
        "--url",
        `http://127.0.0.1:${port}`,
        "--repo-slug",
        "t",
        "--run-id",
        "inserted",
        "--pages",
        "/",
        "--viewports",
        "800",
        "--no-motion",
      ],
      { QA_SHOTS_ROOT: shots },
    );
    assert.equal(r.rc, 0, r.out);
    const shot = lastPart(join(shots, "t", "inserted"));
    const height = Number(execFileSync("magick", ["identify", "-format", "%h", shot], { encoding: "utf8" }));
    const pixel = execFileSync("magick", [shot, "-format", `%[hex:p{200,${height - 400 - 100}}]`, "info:"], {
      encoding: "utf8",
    });
    assert.match(pixel, /^FF0000/i, `the inserted image's centre is #${pixel}, not red`);
  } finally {
    s.close();
  }
});
