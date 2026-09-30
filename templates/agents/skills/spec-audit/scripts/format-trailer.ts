#!/usr/bin/env -S node --experimental-strip-types
// format-trailer.ts
//
// Emit the consolidated `spec-audit:` line, which /spec-audit writes into the
// spec's plan.md Constitution Check (a record, never a gate on a commit).
// One line carries three facts — who reviewed, the spirit-check verdict, and
// where the user's verbatim ask lives — because all three come from the same
// spec-edit event, and three separate lines would triple the reading without
// adding evidence.
//
// Usage:
//   format-trailer.ts round-1 <vendor> <spirit-verdict>
//   format-trailer.ts round-2 <vendor> <accepted-by-reviewer> <escalated-to-user> <spirit-verdict>
//   format-trailer.ts skipped-user "<verbatim user authorization>"
//   format-trailer.ts skipped-non-material <typo|formatting|link|wording-polish|section-reorder|clarification>
//
// <vendor>: whichever vendor ACTUALLY answered — read it from the
//   `answered: <vendor>/<model>` line spec-audit.ts writes to stderr. It is not
//   a fixed name: the review chain may fall through to its backup, and a line
//   that names the wrong reviewer is worse than one that names none, because
//   plan.md's line is the only durable record of who reviewed the SPEC.
//   Nothing parses this field; the value is for the human reading plan.md.
// <spirit-verdict>: MATCH | DRIFT | AMBIGUOUS
//
// Output (one line to stdout):
//   spec-audit: <vendor> <result>; spirit <verdict>; user-ask-verbatim in spec.md Input
//   spec-audit: skipped — <reason>
//
// Exit code: 0 on valid mode; 1 on invalid mode or vendor.
//
// peers:
//   .agents/skills/spec-audit/scripts/format-trailer.test.ts
//   .agents/skills/spec-audit/scripts/write-audit-line.ts  (writes the line into plan.md)

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const REASONS = ["typo", "formatting", "link", "wording-polish", "section-reorder", "clarification"];
const VENDOR_REQUIRED =
  "vendor required — the vendor that answered, per the answered: line spec-audit.ts writes to stderr";
const SPIRIT_REQUIRED = "spirit verdict required: MATCH | DRIFT | AMBIGUOUS";

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  exit(1);
}

/** bash's `${N:?msg}`: the positional argument, or a refusal naming it. */
function required(n: number, msg: string): string {
  const v = process.argv[n + 1] ?? "";
  if (v === "") fail(`${process.argv[1]}: ${n}: ${msg}`);
  return v;
}

function validateSpirit(verdict: string): void {
  if (verdict === "MATCH" || verdict === "DRIFT" || verdict === "AMBIGUOUS") return;
  fail(`error: invalid spirit verdict '${verdict}' — must be MATCH | DRIFT | AMBIGUOUS`);
}

function validateVendor(vendor: string): void {
  // Any lowercase vendor token the policy could name. Deliberately not a fixed
  // list: pinning one here would reintroduce exactly the coupling this argument
  // removes — a policy edit adding a vendor must not need an edit here too.
  // ANCHORED, whole-value: the bash original first tried a `case` glob, where
  // `[a-z][a-z0-9-]*)` let `co dex; rm -rf` through — and this value lands
  // verbatim in the plan.md line that is the only durable record of who
  // reviewed the SPEC.
  if (/^[a-z][a-z0-9-]*$/.test(vendor)) return;
  fail(`error: invalid vendor '${vendor}' — expected the answering vendor, e.g. codex | grok`);
}

// Contextium: the fresh-context fallback (the review chain's exit 3) is named
// `claude-fallback` and ALWAYS carries its caveat in the line, so a weaker
// review can never be read as an independent one.
function labelVendor(vendor: string): string {
  return vendor === "claude-fallback" ? "claude-fallback (fresh context, NOT independent)" : vendor;
}

async function main(): Promise<void> {
  const MODE = required(1, "mode required: round-1 | round-2 | skipped-user | skipped-non-material");

  switch (MODE) {
    case "round-1": {
      const VENDOR = required(2, VENDOR_REQUIRED);
      const SPIRIT = required(3, SPIRIT_REQUIRED);
      validateVendor(VENDOR);
      validateSpirit(SPIRIT);
      process.stdout.write(`spec-audit: ${labelVendor(VENDOR)} round-1; spirit ${SPIRIT}; user-ask-verbatim in spec.md Input\n`);
      break;
    }
    case "round-2": {
      const VENDOR = required(2, VENDOR_REQUIRED);
      const ACCEPTED = required(3, "accepted-by-reviewer count required for round-2");
      const ESCALATED = required(4, "escalated-to-user count required for round-2");
      const SPIRIT = required(5, SPIRIT_REQUIRED);
      validateVendor(VENDOR);
      validateSpirit(SPIRIT);
      process.stdout.write(
        `spec-audit: ${labelVendor(VENDOR)} round-2 (${ACCEPTED} accepted by ${VENDOR}, ${ESCALATED} escalated); spirit ${SPIRIT}; user-ask-verbatim in spec.md Input\n`,
      );
      break;
    }
    case "skipped-user": {
      const QUOTE = required(2, "verbatim user authorization quote required");
      process.stdout.write(`spec-audit: skipped — user authorized "${QUOTE}"\n`);
      break;
    }
    case "skipped-non-material": {
      const REASON = required(
        2,
        "non-material reason required: typo|formatting|link|wording-polish|section-reorder|clarification",
      );
      if (!REASONS.includes(REASON)) {
        fail(
          `error: invalid non-material reason '${REASON}' — must be typo|formatting|link|wording-polish|section-reorder|clarification`,
        );
      }
      process.stdout.write(`spec-audit: skipped — non-material (${REASON})\n`);
      break;
    }
    default:
      fail(`error: invalid mode '${MODE}' — must be round-1 | round-2 | skipped-user | skipped-non-material`);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
