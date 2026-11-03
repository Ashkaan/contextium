#!/usr/bin/env -S node --experimental-strip-types
// interaction-check.ts — press every visible button on each page with the
// server held still, and flag what does not answer at once. The checks and why
// they exist are in interaction-check.browser.ts; this wrapper resolves
// Playwright and the CF-Access token (or the local one) the same way screenshot.ts does.
//
// peers:
//   .agents/skills/qa/scripts/interaction-check.browser.ts
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/tests/interaction-check.test.ts
//
// Usage:
//   interaction-check.ts --url <base> --pages "<route ...>" [--repo <target-dir>]
//                        [--auth-op-item <id> --auth-id-field F --auth-secret-field F]
//                        [--auth-act-as <email>]   # X-Portal-Act-As, beside the token
//                        [--auth-jwt-file <path>]  # local Access token (serve.ts QA_AUTH_JWT_FILE)
//                        [--checks cut-off]        # that check alone: nothing pressed, no stamp
//
// --checks cut-off runs only the phone-size cut-off check: it loads each page
// and presses nothing, so it may point at a deployed site, and it writes no
// stamp, since it is not the whole step-3.7 check. Without it every check runs,
// on this machine only.
//
// With --repo, a clean run (exit 0) writes the stamp mark-qa-done.ts --tree
// refuses to mark a served app without: $QA_DONE_DIR/interaction-<slug>-<tree>,
// where <tree> is `.agents/skills/review/code-review.ts --snapshot` of the repo holding
// the target — the same snapshot /implement passes to mark-qa-done as
// $POST_QA. An edit after the check moves the tree, so the stamp stops matching
// and the check has to run again.
// Output: `INTERACTION <route> <kind> <detail>` per finding, `SKIPPED …` per
//         opt-out, and one `interaction: …` summary (see interaction-check.browser.ts).
// Exit:   0 clean; 9 findings; 1 a route did not load; 2 usage, a --checks
//         other than cut-off, or (without --checks) a --url or --pages route
//         whose host is not localhost / 127.0.0.1 / ::1; 7 Playwright
//         unavailable — `qa: skipped — Playwright unavailable (<reason>)` on
//         stderr, a skip and never a pass.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  qaEnvCfAccess,
  qaErr,
  qaInteractionStampPath,
  qaPlaywrightNodeModules,
  qaReadJwtFile,
  qaResolveCfAccess,
} from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

  let URL_ = "";
  let PAGES = "";
  let REPO = "";
  let AUTH_OP_ITEM = "";
  let AUTH_ID_FIELD = "client_id";
  let AUTH_SECRET_FIELD = "client_secret";
  let AUTH_ACT_AS = "";
  let AUTH_JWT_FILE = "";
  let CHECKS = "";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i] ?? "";
    const val = argv[i + 1] ?? "";
    switch (flag) {
      case "--url":
        URL_ = val;
        break;
      case "--pages":
        PAGES = val;
        break;
      case "--repo":
        REPO = val;
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
      case "--checks":
        if (val !== "cut-off") {
          qaErr(`interaction-check: --checks ${val} is not a check — the one is cut-off`);
          exit(2);
        }
        CHECKS = val;
        break;
      default:
        qaErr(`interaction-check: unknown flag: ${flag}`);
        exit(2);
    }
    i += 2;
  }

  if (URL_ === "" || PAGES.replaceAll(" ", "") === "") {
    qaErr("usage: interaction-check.ts --url U --pages '/ /about'");
    exit(2);
  }

  // Buttons are pressed only on this machine: serve.ts --before/--after serves
  // on localhost. A run pointed at production once rewrote a live record 18
  // times, and nothing in /qa needs a deployed target here. Every
  // page is checked as the browser module resolves it (`new URL(route, base)`),
  // because an absolute route there replaces the base entirely. The guard is
  // against presses, so --checks cut-off, which presses nothing and only loads
  // pages as /qa --live screenshots do, may read a deployed site; the URL must
  // still parse.
  const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];
  for (const target of [URL_, ...PAGES.split(/\s+/).filter(Boolean)]) {
    let host: string;
    try {
      host = new URL(target, URL_).hostname;
    } catch {
      qaErr(`interaction-check: --url ${URL_} is not a URL`);
      exit(2);
    }
    if (CHECKS === "" && !LOOPBACK.includes(host)) {
      qaErr(
        `interaction-check: ${host} is not this machine — press buttons only on serve.ts --before/--after, never on a deployed site`,
      );
      exit(2);
    }
  }

  // With no item named, QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET are the pair.
  const ACCESS =
    AUTH_OP_ITEM !== "" ? await qaResolveCfAccess(AUTH_OP_ITEM, AUTH_ID_FIELD, AUTH_SECRET_FIELD) : qaEnvCfAccess();
  if (AUTH_OP_ITEM !== "" && ACCESS === undefined) {
    qaErr(`interaction-check: --auth-op-item set but service token unresolved from 1Password item ${AUTH_OP_ITEM}`);
    exit(2);
  }
  const JWT = qaReadJwtFile(AUTH_JWT_FILE);
  if (JWT === undefined) {
    qaErr(`interaction-check: --auth-jwt-file ${AUTH_JWT_FILE} is missing or empty`);
    exit(2);
  }

  const NODE_MODULES = qaPlaywrightNodeModules(REPO);
  if (NODE_MODULES === undefined) {
    qaErr("qa: skipped — Playwright unavailable (see the line above); no interaction check ran");
    exit(7);
  }
  process.env.QA_PW_PARENT = dirname(NODE_MODULES);

  // Its own process: the browser module exits with its verdict, and a crash in
  // the browser must not take the stamp logic below with it. The token pair goes
  // on its stdin, never its environment or argv (see interaction-check.browser.ts).
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "interaction-check.browser.ts"), URL_, PAGES, CHECKS || "all"],
    {
      stdio: ["pipe", "inherit", "inherit"],
      input: JSON.stringify({ access: ACCESS ?? null, actAs: AUTH_ACT_AS, jwt: JWT }),
    },
  );
  const rc = r.status ?? 1;
  if (rc === 0 && REPO !== "" && CHECKS === "") {
    const snap = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(SCRIPT_DIR, "../../review/code-review.ts"), "--snapshot"],
      {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    if (snap.error || snap.status !== 0) exit(snap.status ?? 1);
    const tree = (snap.stdout ?? "").replace(/\n+$/, "");
    const stamp = qaInteractionStampPath(REPO, tree);
    mkdirSync(dirname(stamp), { recursive: true });
    closeSync(openSync(stamp, "a"));
    const now = new Date();
    utimesSync(stamp, now, now);
    process.stdout.write(`interaction: stamped ${basename(stamp)}\n`);
  }
  exit(rc);
}

await runToExit(main);
