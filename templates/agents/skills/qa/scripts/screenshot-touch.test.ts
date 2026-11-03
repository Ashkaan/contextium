#!/usr/bin/env -S node --experimental-strip-types
// screenshot-touch.test.ts — the phone-width shot is taken as a touchscreen.
//
// Why this exists: a site that floors every control at 44px under
// `@media (pointer: coarse)` keeps the compact sizes for a mouse. /qa's 390
// shot opened a mouse browser, so it measured the mouse sizes, and page
// reviews reported correct buttons as too small to tap. The page here is blue for a mouse and red for a touchscreen, in
// CSS alone; each shot's centre pixel says which pointer the browser reported.
// Widths 480 and 481 sit either side of the threshold, so a wrong one fails.
// The page is 3,000px tall, past the 1,600px window, and the pixel is read
// below the window: Chromium drops `hasTouch`'s pointer when a full-page
// capture resizes the frame, and a page that fits the window never shows it.
//
// screenshot.ts is a program and is spawned.
// Needs a Playwright with an installed chromium and ImageMagick; without it every case reports SKIP rather than a pass. A test
// never installs anything: QA_NO_INSTALL=1 keeps the first-use installs off.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/screenshot-touch.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const tmp = mkdtempSync(join(tmpdir(), "qa-touch-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

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

test("the shots at 480 and below report a coarse pointer, the wider ones a fine one", { skip }, async () => {
  const s = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>t</title>` +
        `<style>html,body{margin:0}body{min-height:2800px}` +
        `@media (pointer: fine){body{background:#0000ff}}@media (pointer: coarse){body{background:#ff0000}}</style>` +
        `<body><p style="font:20px sans-serif;padding:20px">touch probe</p></body>`,
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
        "touch",
        "--pages",
        "/",
        "--viewports",
        "1440,481,480,390",
        "--no-motion",
      ],
      // A page of one colour is what the blank-capture gate exists to stop.
      { QA_SHOTS_ROOT: shots, QA_INK_FLOOR: "0" },
    );
    assert.equal(r.rc, 0, r.out);
    const expected: Record<number, string> = { 1440: "0000FF", 481: "0000FF", 480: "FF0000", 390: "FF0000" };
    for (const [width, colour] of Object.entries(expected)) {
      const shot = join(shots, "t", "touch", `index-${width}.png`);
      const w = Number(execFileSync("magick", ["identify", "-format", "%w", shot], { encoding: "utf8" }));
      const pixel = execFileSync("magick", [shot, "-format", `%[hex:p{${Math.floor(w / 2)},2500}]`, "info:"], {
        encoding: "utf8",
      });
      const pointer = colour === "FF0000" ? "coarse (touchscreen)" : "fine (mouse)";
      assert.match(
        pixel,
        new RegExp(`^${colour}`, "i"),
        `the ${width} shot is #${pixel}; expected a ${pointer} pointer`,
      );
    }
  } finally {
    s.close();
  }
});
