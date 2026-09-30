#!/usr/bin/env -S node --experimental-strip-types
// sight-check-playwright.test.ts — the stamp without ImageMagick. On a PATH that
// holds no `magick`, `sight-check.ts stamp` must draw the codes with Playwright
// (sight-stamp.ts), and a reply carrying them must verify. Skips when no
// Playwright with its browser is already on the machine; a test never
// downloads one (QA_NO_INSTALL=1).
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/sight-check-playwright.test.ts
//
// peers:
//   .agents/skills/qa/scripts/sight-check.ts
//   .agents/skills/qa/scripts/sight-stamp.ts
//   .agents/skills/qa/scripts/lib.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { qaPlaywrightNodeModules } from "../lib.ts";

const SC = join(dirname(fileURLToPath(import.meta.url)), "..", "sight-check.ts");
process.env.QA_NO_INSTALL = "1";
const NM = qaPlaywrightNodeModules();
const skip = NM === undefined ? "no Playwright with an installed chromium" : false;
if (skip) process.stdout.write("sight-check-playwright.test.ts: SKIP — no Playwright with an installed chromium\n");

const TMP = mkdtempSync(join(tmpdir(), "sight-pw-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// A PATH with no magick: only node and npm (the lookup asks `npm root -g`),
// when the machine has them.
const BIN = join(TMP, "bin");
mkdirSync(BIN);
for (const tool of ["node", "npm"]) {
  const p = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  if (p !== "") symlinkSync(p, join(BIN, tool));
}
const RUN = join(TMP, "run");
mkdirSync(RUN);
const CODES = join(TMP, "codes");

function sc(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SC, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: BIN, ...env },
  });
  return { rc: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const pngdim = (f: string): string => {
  const b = readFileSync(f);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

let stamp = { rc: 0 as number | null, out: "", err: "" };
before(async () => {
  if (NM === undefined) return;
  // Two real PNGs of different sizes, drawn by the same Playwright.
  const { chromium }: typeof import("playwright") = createRequire(`${dirname(NM)}/`)("playwright");
  const b = await chromium.launch();
  for (const [name, w, h] of [
    ["home-1440.png", 1440, 600],
    ["home-390.png", 390, 844],
  ] as const) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.setContent('<body style="margin:0;background:#fff"><h1>Home</h1></body>');
    await p.screenshot({ path: join(RUN, name) });
    await p.close();
  }
  await b.close();
  stamp = sc(["stamp", "--dir", RUN, "--codes", CODES]);
});

test("magick is not on the test PATH", { skip }, () => assert.equal(existsSync(join(BIN, "magick")), false));
test("stamp without magick exits 0", { skip }, () => assert.equal(stamp.rc, 0, stamp.err));
test("it says which stamper ran", { skip }, () =>
  assert.match(stamp.err, /no ImageMagick — stamping with Playwright/));
test("it reports the codes file", { skip }, () => assert.match(stamp.out, new RegExp(`^QA_SIGHT_CODES=${CODES}$`, "m")));
test("one code per shot", { skip }, () =>
  assert.equal(
    readFileSync(CODES, "utf8")
      .split("\n")
      .filter((l) => /^home-[0-9]+\.png\t[A-Z0-9]{6}$/.test(l)).length,
    2,
  ));
test("the strip is appended below: same width, 56px taller", { skip }, () => {
  assert.equal(pngdim(join(RUN, "home-1440.png")), "1440x656");
  assert.equal(pngdim(join(RUN, "home-390.png")), "390x900");
});
test("the codes are not in the run dir", { skip }, () => {
  const code = readFileSync(CODES, "utf8").split("\n")[0]?.split("\t")[1] ?? "";
  assert.notEqual(code, "");
  for (const f of readdirSync(RUN)) assert.equal(readFileSync(join(RUN, f)).includes(code), false, f);
});
test("a reply carrying the codes verifies; one without them is a blind review", { skip }, () => {
  const reply = join(TMP, "reply");
  writeFileSync(
    reply,
    readFileSync(CODES, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace("\t", " = "))
      .join("\n"),
  );
  assert.equal(sc(["verify", "--codes", CODES, "--response", reply]).rc, 0);
  const blind = join(TMP, "blind");
  writeFileSync(blind, "the page looks fine\n");
  assert.equal(sc(["verify", "--codes", CODES, "--response", blind]).rc, 6);
});

// Neither stamper: still a halt, and it names both. No npm on PATH, an empty
// HOME and first-use cache, installs forbidden — so no Playwright resolves.
test("no magick and no Playwright is exit 3, and the halt names both", () => {
  const empty = join(TMP, "empty-bin");
  mkdirSync(empty, { recursive: true });
  mkdirSync(join(TMP, "home"), { recursive: true });
  const r = sc(["stamp", "--dir", RUN, "--codes", join(TMP, "codes2")], {
    PATH: empty,
    HOME: join(TMP, "home"),
    QA_PLAYWRIGHT_DIR: join(TMP, "none"),
    PLAYWRIGHT_BROWSERS_PATH: join(TMP, "none"),
  });
  assert.equal(r.rc, 3, r.err);
  assert.match(r.err, /neither ImageMagick nor Playwright/);
});
