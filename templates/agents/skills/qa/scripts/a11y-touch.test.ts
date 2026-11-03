#!/usr/bin/env -S node --experimental-strip-types
// a11y-touch.test.ts — the accessibility pass grades the phone width as a
// touchscreen, the same browser the phone-width screenshot uses.
//
// Why this exists: a page that changes under `@media (pointer: coarse)` was
// graded at 390 as a mouse browser saw it, so what a phone shows was never what
// axe read. The page hides an image with no
// alt text under a coarse pointer: at 1440 axe reports `image-alt`, at 390 the
// image is not displayed and it does not.
//
// a11y.ts is a program and is spawned. Needs a Playwright with an installed
// chromium and the axe install at ~/.local/lib/qa-a11y (a11y.ts installs it on
// first use); without them every case reports SKIP rather than a pass. A test
// never installs anything: QA_NO_INSTALL=1 keeps the first-use installs off.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/a11y-touch.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaPlaywrightNodeModules } from "./lib.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

process.env.QA_NO_INSTALL = "1";
const skip =
  qaPlaywrightNodeModules() === undefined
    ? "no Playwright with an installed chromium"
    : existsSync(join(process.env.HOME || homedir(), ".local/lib/qa-a11y/node_modules/@axe-core/playwright"))
      ? false
      : "no axe install at ~/.local/lib/qa-a11y";

function run(args: string[]): Promise<{ rc: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SCRIPT_DIR, "a11y.ts"), ...args]);
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

// A 1x1 transparent GIF, so the image loads and axe grades it.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

test("axe at 390 grades the touchscreen page, at 1440 the mouse page", { skip }, async () => {
  const s = createServer((q, r) => {
    if (q.url === "/x.gif") {
      r.writeHead(200, { "content-type": "image/gif" });
      r.end(GIF);
      return;
    }
    r.writeHead(200, { "content-type": "text/html" });
    r.end(
      `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>t</title>` +
        `<style>@media (pointer: coarse){.mouse-only{display:none}}</style>` +
        `<body><main><h1>Touch probe</h1><div class="mouse-only"><img src="/x.gif" width="40" height="40"></div></main></body></html>`,
    );
  });
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
  const a = s.address();
  const port = typeof a === "object" && a !== null ? a.port : 0;
  try {
    const r = await run(["--url", `http://127.0.0.1:${port}`, "--pages", "/", "--viewports", "1440,390"]);
    assert.equal(r.rc, 0, r.out);
    const line = (w: number) => r.out.split("\n").find((l) => l.startsWith(`a11y / @${w}:`)) ?? "";
    assert.match(line(1440), /image-alt/, `the 1440 run graded a mouse page and should see the image:\n${r.out}`);
    assert.doesNotMatch(
      line(390),
      /image-alt/,
      `the 390 run should grade the touchscreen page, where the image is hidden:\n${r.out}`,
    );
    assert.match(line(390), /violation/, `the 390 run produced no line:\n${r.out}`);
  } finally {
    s.close();
  }
});
