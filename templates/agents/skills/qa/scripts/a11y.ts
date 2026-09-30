#!/usr/bin/env -S node --experimental-strip-types
// a11y.ts — OPTIONAL accessibility layer for /qa (`--a11y`). Runs axe-core
// (Deque) per page/viewport via @axe-core/playwright and prints a violation
// count per page. axe catches ~57% of WCAG issues automatically — treated as an
// ADVISORY signal, NOT a hard gate (a rule engine covering half the standard
// cannot certify it);
// it does NOT do overlap/collision detection (that is the visual-review
// subagent's job).
//
// The axe deps are NOT vendored in this repo.
// they install on first use into an off-repo cache at ~/.local/lib/qa-a11y/.
//
// peers:
//   .agents/skills/qa/scripts/screenshot.ts
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/tests/a11y.test.ts
//
// Usage:  a11y.ts --url <base> --pages "<route ...>" [--viewports W,W,W]
//                 [--auth-op-item <id> --auth-id-field F --auth-secret-field F]
//                 [--auth-act-as <email>]   # the same auth screenshot.ts sends
//                 [--auth-jwt-file <path>]  # local Access token (serve.ts QA_AUTH_JWT_FILE)
// Exit:   0 ran (advisory — never fails on violations); 2 usage;
//         3 no page could be graded (every route errored or answered 4xx/5xx);
//         8 axe deps unavailable / install failed / QA_NO_INSTALL=1 with none installed.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { Page } from "playwright";
import { qaAccessHeaders, qaEnvCfAccess, qaErr, qaReadJwtFile, qaResolveCfAccess, qaResolvePages } from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const CACHE_DIR = `${process.env.HOME || homedir()}/.local/lib/qa-a11y`;
  let URL_ = "";
  let PAGES = "";
  let VIEWPORTS = "1440";
  let AUTH_OP_ITEM = "";
  let AUTH_ID_FIELD = "client_id";
  let AUTH_SECRET_FIELD = "client_secret";
  let AUTH_ACT_AS = "";
  let AUTH_JWT_FILE = "";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const val = argv[i + 1] ?? "";
    switch (flag) {
      case "--url":
        URL_ = val;
        break;
      case "--pages":
        PAGES = val;
        break;
      case "--viewports":
        VIEWPORTS = val;
        break;
      case "--auth-op-item":
        AUTH_OP_ITEM = val;
        break;
      case "--auth-id-field":
        AUTH_ID_FIELD = val || "client_id";
        break;
      case "--auth-secret-field":
        AUTH_SECRET_FIELD = val || "client_secret";
        break;
      case "--auth-act-as":
        AUTH_ACT_AS = val;
        break;
      case "--auth-jwt-file":
        AUTH_JWT_FILE = val;
        break;
      default:
        qaErr(`a11y: unknown flag: ${flag}`);
        exit(2);
    }
  }

  if (URL_ === "") {
    qaErr("usage: a11y.ts --url U --pages '...'");
    exit(2);
  }
  // Without the probe token a gated portal answers its login wall, and axe would
  // grade that page as the portal's (see screenshot.ts for the same headers).
  // The pair stays in this process: the capture below runs here, not in a child.
  // With no item named, QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET are the pair.
  const ACCESS =
    AUTH_OP_ITEM !== "" ? await qaResolveCfAccess(AUTH_OP_ITEM, AUTH_ID_FIELD, AUTH_SECRET_FIELD) : qaEnvCfAccess();
  if (AUTH_OP_ITEM !== "" && ACCESS === undefined) {
    qaErr(`a11y: --auth-op-item set but service token unresolved from 1Password item ${AUTH_OP_ITEM}`);
    exit(2);
  }
  const JWT = qaReadJwtFile(AUTH_JWT_FILE);
  if (JWT === undefined) {
    qaErr(`a11y: --auth-jwt-file ${AUTH_JWT_FILE} is missing or empty`);
    exit(2);
  }
  PAGES = qaResolvePages(PAGES, "");

  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const AXE_DIR = `${CACHE_DIR}/node_modules/@axe-core/playwright`;

  // ── install axe deps off-repo on first use ───────────────────────────
  // Serialized on a lock: CACHE_DIR is one shared directory, and two sessions
  // hitting their first --a11y run at once had both npm installs writing the same
  // node_modules tree, interleaving into a broken half-install that then failed for
  // both. The lock makes the second one wait and find the work already done, which
  // is why the directory test is re-checked inside it.
  //
  // The lock is flock(1) on a descriptor this process holds open, exactly the
  // `exec 202>lock; flock -w 300 202` shape: flock(1) locks the open file
  // description it inherits, so the lock is this process's until the descriptor
  // closes — and the kernel drops it if the process dies. Where there is no
  // flock (macOS), a `mkdir` lock: mkdir is atomic on every filesystem, so it
  // serializes the same way (a run that dies holding it leaves the directory,
  // and the next run waits its 5 minutes and skips).
  if (!isDir(AXE_DIR)) {
    // QA_NO_INSTALL=1 (offline machines, CI) forbids every first-use install.
    if (process.env.QA_NO_INSTALL === "1") {
      qaErr("a11y: @axe-core/playwright is not installed and QA_NO_INSTALL=1 — skipping a11y layer");
      exit(8);
    }
    mkdirSync(CACHE_DIR, { recursive: true });
    const lock = await a11yLock(CACHE_DIR);
    if (lock === undefined) {
      qaErr("a11y: another run has held the install lock for 5m — skipping a11y layer");
      exit(8);
    }
    try {
      if (!isDir(AXE_DIR)) {
        process.stderr.write(`qa: installing @axe-core/playwright into ${CACHE_DIR} (first --a11y run)…\n`);
        const npm = spawnSync("npm", ["install", "--no-save", "--silent", "@axe-core/playwright", "playwright"], {
          cwd: CACHE_DIR,
          stdio: "ignore",
        });
        if (npm.error || npm.status !== 0) {
          qaErr("a11y: could not install @axe-core/playwright — skipping a11y layer");
          exit(8);
        }
      }
    } finally {
      lock();
    }
  }

  // Resolve the bare specifiers from CACHE_DIR, whose node_modules holds
  // playwright + @axe-core/playwright.
  interface AxeResults {
    violations: { id: string }[];
  }
  type AxeBuilderClass = new (opts: { page: Page }) => { analyze(): Promise<AxeResults> };
  const require = createRequire(`${CACHE_DIR}/`);
  const { chromium }: typeof import("playwright") = require("playwright");
  const axe: { default: AxeBuilderClass } = require("@axe-core/playwright");
  const AxeBuilder = axe.default;

  const base = URL_;
  const pages = PAGES.split(/\s+/).filter(Boolean);
  const widths = VIEWPORTS.split(",")
    .map((w) => Number.parseInt(w.trim(), 10))
    .filter(Boolean);

  const extraHTTPHeaders = qaAccessHeaders(ACCESS, AUTH_ACT_AS, JWT);

  const browser = await chromium.launch();
  let graded = 0;
  for (const route of pages) {
    for (const width of widths) {
      const ctx = await browser.newContext({ viewport: { width, height: 1600 }, extraHTTPHeaders });
      const page = await ctx.newPage();
      const url = base.replace(/\/$/, "") + (route.startsWith("/") ? route : `/${route}`);
      try {
        const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        const status = resp ? resp.status() : 0;
        if (status >= 400) {
          process.stdout.write(`a11y ${route} @${width}: error — HTTP ${status}, not the page; not graded\n`);
          await ctx.close();
          continue;
        }
        const results = await new AxeBuilder({ page }).analyze();
        graded++;
        const n = results.violations.length;
        const ids = results.violations.map((v) => v.id).join(", ");
        process.stdout.write(`a11y ${route} @${width}: ${n} violation(s)${ids ? ` [${ids}]` : ""}\n`);
      } catch (e) {
        process.stdout.write(`a11y ${route} @${width}: error — ${e instanceof Error ? e.message : String(e)}\n`);
      }
      await ctx.close();
    }
  }
  await browser.close();
  // Advisory about violations, never about coverage: a run that graded nothing
  // measured nothing, and must not read as a clean one.
  if (graded === 0) {
    process.stderr.write("a11y: no page could be graded\n");
    exit(3);
  }

  process.stderr.write("qa: a11y is advisory (~57% WCAG coverage) — not a hard gate\n");
}

/**
 * Take the install lock beside `cacheDir`, waiting up to 5 minutes: the
 * release function, or undefined when the wait ran out.
 */
async function a11yLock(cacheDir: string): Promise<(() => void) | undefined> {
  if (!spawnSync("flock", ["--version"], { stdio: "ignore" }).error) {
    const fd = openSync(`${cacheDir}.lock`, "w");
    const got = spawnSync("flock", ["-w", "300", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    if (got.error || got.status !== 0) {
      closeSync(fd);
      return undefined;
    }
    return () => closeSync(fd);
  }
  const dir = `${cacheDir}.lockdir`;
  for (let i = 0; i < 300; i++) {
    try {
      mkdirSync(dir);
      return () => {
        try {
          rmdirSync(dir);
        } catch {
          // already gone
        }
      };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return undefined;
}

await runToExit(main);
