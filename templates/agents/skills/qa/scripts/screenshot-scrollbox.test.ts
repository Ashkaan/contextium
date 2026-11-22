#!/usr/bin/env -S node --experimental-strip-types
// screenshot-scrollbox.test.ts — rows the browser skips until scrolled to are
// in the shot, and nothing a visitor cannot see is added to it.
//
// Why this exists: a list card low on a page came out blank under its filter
// row in a /qa shot while a live browser showed every row, and the visual
// reviewer had to reject each such shot as a capture artifact. The rows use
// `content-visibility: auto`, and a fullPage shot is taken with the window at
// the top of a 1,600px-tall viewport (`qaContextOptions` in lib.ts), so the
// browser skips drawing anything below it.
//
// screenshot.ts is a program and is spawned. The page is served locally: a dark
// header bar, a spacer one viewport tall plus 100px, a 600px card whose list
// scrolls inside it and holds 40 skipped rows, a `content-visibility: hidden`
// block, then a footer.
//
// Run: node --experimental-strip-types .agents/skills/run.ts qa/scripts/screenshot-scrollbox.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaContextOptions } from "./lib.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const HEADER = 100;
const SPACER = qaContextOptions(390).viewport.height + 100;
const CARD = 600;
const ROW = 64;
const ROWS = 40;
const HIDDEN = 100;
const FOOTER = 200;
const CARD_TOP = HEADER + SPACER;
/** Each row's green block: 40x40, 20px in from the left, 12px down the row. */
const BLOCK_X = 20 + 20;
const BLOCK_Y_IN_ROW = 12 + 20;
const PAGE_HEIGHT = HEADER + SPACER + CARD + HIDDEN + FOOTER;

const PAGE =
  `<!doctype html><title>t</title><meta name="viewport" content="width=device-width">` +
  `<style>body{margin:0;background:#fff}` +
  `.card{display:flex;flex-direction:column;overflow:hidden;height:${CARD}px}` +
  `.list{flex:1 1 auto;min-height:0;overflow-y:auto}` +
  `.row{content-visibility:auto;contain-intrinsic-size:auto 72px;height:${ROW}px;background:#fff;position:relative}` +
  `.row i{position:absolute;left:20px;top:12px;width:40px;height:40px;background:#00a000}` +
  `.secret{content-visibility:hidden;width:200px;height:${HIDDEN}px;position:relative}` +
  `.secret i{position:absolute;left:20px;top:20px;width:40px;height:40px;background:#a000a0}</style>` +
  `<body><div style="height:${HEADER}px;background:#202020"></div>` +
  `<div style="height:${SPACER}px"></div>` +
  `<div class="card"><div class="list">${`<div class="row"><i></i></div>`.repeat(ROWS)}</div></div>` +
  `<div class="secret"><i></i></div>` +
  `<div style="height:${FOOTER}px"></div></body>`;

const tmp = mkdtempSync(join(tmpdir(), "qa-scrollbox-"));
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

type Row = { route: string; path: string; rows: number };
let shot = "";
let manifest: Row[] = [];

/** One run, shared by every case: the page is shot once at 390. */
before(async () => {
  const s = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(PAGE);
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
        "scrollbox",
        "--pages",
        "/",
        "--viewports",
        "390",
        "--no-motion",
      ],
      { QA_SHOTS_ROOT: shots },
    );
    assert.equal(r.rc, 0, r.out);
    const runDir = join(shots, "t", "scrollbox");
    manifest = (JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as Row[]).filter(
      (m) => m.route === "/",
    );
    shot = manifest[0]?.path ?? "";
    assert.ok(shot, `no shot of / in ${runDir}`);
  } finally {
    s.close();
  }
});

function pixel(x: number, y: number): string {
  return execFileSync("magick", [shot, "-format", `%[hex:p{${x},${y}}]`, "info:"], { encoding: "utf8" });
}

function shotHeight(): number {
  return Number(execFileSync("magick", ["identify", "-format", "%h", shot], { encoding: "utf8" }));
}

test("scroll-box rows: the first skipped row of a list low on the page is drawn", () => {
  const p = pixel(BLOCK_X, CARD_TOP + BLOCK_Y_IN_ROW);
  assert.match(p, /^00A000/i, `the first row's block reads #${p}, not green: the skipped row was not drawn`);
});

test("hidden stays hidden: content-visibility:hidden content is not drawn", () => {
  const p = pixel(BLOCK_X, CARD_TOP + CARD + 20 + 20);
  assert.doesNotMatch(p, /^A000A0/i, `the hidden block's child reads #${p}: content-visibility:hidden was drawn`);
});

test("box keeps its height: the page is the layout with the box at its cap, and the last row is not drawn", () => {
  const total = manifest.reduce((n, m) => n + m.rows, 0);
  assert.equal(total, PAGE_HEIGHT, `the manifest's rows sum to ${total}, not the ${PAGE_HEIGHT}px layout`);
  const lastY = CARD_TOP + (ROWS - 1) * ROW + BLOCK_Y_IN_ROW;
  if (lastY < shotHeight()) {
    const p = pixel(BLOCK_X, lastY);
    assert.doesNotMatch(p, /^00A000/i, `the 40th row's block reads #${p}: a row outside the box's window was drawn`);
  }
});
