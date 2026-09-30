#!/usr/bin/env -S node --experimental-strip-types
// sight-validate.ts — the review chain's shape test for a visual review: a
// vendor's answer counts only when it transcribed every sight code.
//
// Why: the review chain banks the first vendor that exits 0. A vendor that
// cannot open the images still exits 0 — with "cannot see", or with findings
// computed rather than seen — and the vendor behind it, which could have
// looked, is never asked. policy-chain.ts runs a POLICY_CHAIN_VALIDATOR as
// `<command> <slot output file>` before banking a slot and treats non-zero as
// "this slot did not answer", so the walk moves on. This is that command:
// `sight-check.ts verify` of the slot's output against QA_SIGHT_CODES.
//
// peers:
//   .agents/skills/qa/scripts/sight-check.ts
//   .agents/skills/qa/SKILL.md            (step-4-fresh-review, the fallback block)
//   .agents/skills/review/policy-chain.ts (THE SHAPE TEST)
//   .agents/skills/qa/scripts/tests/sight-validate.test.ts
//
// Usage: POLICY_CHAIN_VALIDATOR=<this file> QA_SIGHT_CODES=<codes file> policy-review.ts …
//        (the chain then runs `sight-validate.ts <slot output>`)
// Exit:  0 every code transcribed; 2 usage; otherwise sight-check.ts verify's
//        (5 no codes, 6 codes missing — a blind answer). The one line on
//        stderr is the reason the chain quotes.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const response = process.argv[2] ?? "";
  const codes = process.env.QA_SIGHT_CODES ?? "";
  if (response === "" || process.argv.length > 3 || codes === "") {
    process.stderr.write("usage: QA_SIGHT_CODES=<codes file> sight-validate.ts <response file>\n");
    exit(2);
  }
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      join(dirname(fileURLToPath(import.meta.url)), "sight-check.ts"),
      "verify",
      "--codes",
      codes,
      "--response",
      response,
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
  const rc = r.error ? 2 : (r.status ?? 1);
  if (rc !== 0) {
    const why = /\d+\/\d+ sight codes came back[^\n]*/.exec(r.stderr ?? "")?.[0] ?? `sight-check.ts verify exit ${rc}`;
    process.stderr.write(`sight-validate: not a visual review — ${why.trim()}\n`);
  }
  exit(rc);
}

await runToExit(main);
