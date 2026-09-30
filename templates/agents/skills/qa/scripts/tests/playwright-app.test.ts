#!/usr/bin/env -S node --experimental-strip-types
// playwright-app.test.ts — screenshot.ts and interaction-check.ts hand the
// target app to the Playwright lookup, so an app that ships its own Playwright
// is used when the machine has none. The app's copy here is a stub with an
// "installed" browser revision: the capture then fails on the stub (any exit
// but 2 or 7), where a lookup that ignored the app reports `Playwright
// unavailable` (exit 7) and a caller without the flag refuses it (exit 2).
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/playwright-app.test.ts
//
// peers:
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/screenshot.ts
//   .agents/skills/qa/scripts/interaction-check.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "pw-app-test-"));
const RUN_ID = `r${process.pid}`;
after(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(`/tmp/qa-shots/s/${RUN_ID}`, { recursive: true, force: true });
});

// A PATH with nothing on it (no npm, so no global copy), an empty HOME, an
// empty first-use cache with installs forbidden, and a browser cache holding
// only the app's revision.
for (const d of ["bin", "home", "browsers/chromium-9999", "repo/.git", "repo/apps/site"]) {
  mkdirSync(join(TMP, d), { recursive: true });
}
const APP = join(TMP, "repo/apps/site");
mkdirSync(join(TMP, "repo/node_modules/playwright-core"), { recursive: true });
mkdirSync(join(TMP, "repo/node_modules/playwright"), { recursive: true });
writeFileSync(
  join(TMP, "repo/node_modules/playwright-core/browsers.json"),
  '{"browsers":[{"name":"chromium","revision":"9999"}]}\n',
);
writeFileSync(join(TMP, "browsers/chromium-9999/INSTALLATION_COMPLETE"), "");

function envRun(script: string, args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", join(DIR, script), ...args], {
    encoding: "utf8",
    env: {
      PATH: join(TMP, "bin"),
      HOME: join(TMP, "home"),
      QA_NO_INSTALL: "1",
      QA_PLAYWRIGHT_DIR: join(TMP, "empty"),
      PLAYWRIGHT_BROWSERS_PATH: join(TMP, "browsers"),
      QA_DONE_DIR: join(TMP, "done"),
    },
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}
const shot = (...a: string[]) =>
  envRun("screenshot.ts", [
    "--url",
    "http://127.0.0.1:9",
    "--repo-slug",
    "s",
    "--run-id",
    RUN_ID,
    "--pages",
    "/",
    "--no-motion",
    ...a,
  ]);
const inter = (...a: string[]) => envRun("interaction-check.ts", ["--url", "http://127.0.0.1:9", "--pages", "/", ...a]);
const used = (r: { rc: number | null; out: string }) =>
  r.rc !== 7 && r.rc !== 2 ? "yes" : `no (rc=${r.rc}: ${r.out.split("\n").slice(0, 3).join(" ")})`;

test("screenshot without --app: no Playwright is exit 7, said plainly", () => {
  const r = shot();
  assert.equal(r.rc, 7);
  assert.match(r.out, /qa: skipped — Playwright unavailable \(see the line above\); no screenshots were taken/);
});
test("screenshot with --app: the app's copy is used (not exit 2 or 7)", () =>
  assert.equal(used(shot("--app", APP)), "yes"));
test("interaction-check with --repo: the app's copy is used (not exit 2 or 7)", () =>
  assert.equal(used(inter("--repo", APP)), "yes"));
