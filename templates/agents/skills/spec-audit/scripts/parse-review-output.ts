#!/usr/bin/env -S node --experimental-strip-types
// parse-review-output.ts
//
// Parse review round-2 output for line-anchored [concede] and [disagree]
// verdicts. Round 2 fires only when the authoring agent pushed back on round-1
// findings; the reviewer returns one verdict per pushed-back finding, naming it
// by the ID the pushback file gave it (`F<n>`, see
// .agents/skills/spec-audit/SKILL.md § step-5-review-round-2).
//
// Deterministic — line match + count + emit JSON-ish summary.
//
// Usage:
//   parse-review-output.ts --expected <id,id,...> < round-2-output.txt
//
// Flags:
//   --expected <ids>  REQUIRED. Comma-separated IDs of the findings the agent
//                     pushed back on (e.g. `F2,F4`). Each needs exactly one
//                     verdict. A verdict's ID is the first word after its
//                     marker, with trailing `:,.;` dropped.
//
// Output (multi-line to stdout):
//   concede-count: <N>
//   disagree-count: <N>
//   verdict: consensus | escalate | incomplete
//   <blank line>
//   [concede] <line 1>
//   [disagree] <line 1>
//   missing: <id>          (incomplete only — a submitted finding with no verdict)
//   duplicate: <id>        (incomplete only — more than one verdict for it)
//   unexpected: <id>       (incomplete only — a verdict for no submitted finding)
//
// Caller uses:
//   - verdict=consensus  → every pushed-back finding conceded; emit round-2 trailer
//   - verdict=escalate   → every finding has a verdict and some are [disagree]
//   - verdict=incomplete → NOT consensus: some finding was not adjudicated
//
// Why --expected is required: counting [disagree] lines alone made "two
// pushbacks, one [concede] back" read as consensus, so the SPEC recorded
// agreement on a finding nobody reviewed. Only the caller knows what it submitted.
//
// Exit code: 0 consensus or escalate; 1 empty input; 2 caller error (no or bad
// --expected); 3 incomplete (the summary is still printed).
//
// peers:
//   .agents/skills/spec-audit/scripts/parse-review-output.test.ts

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** The finding ID a verdict line names: its first word, trailing punctuation dropped. */
function verdictId(line: string, marker: string): string {
  const word = line.slice(marker.length).trimStart().split(/\s/, 1)[0] ?? "";
  return word.replace(/[:,.;]+$/, "");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let expectedArg: string | undefined;
  while (argv.length > 0) {
    const a = argv.shift() ?? "";
    if (a === "--expected") expectedArg = argv.shift();
    else {
      process.stderr.write(`error: unknown argument: ${a}\n`);
      exit(2);
    }
  }
  const EXPECTED = (expectedArg ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (EXPECTED.length === 0) {
    process.stderr.write("error: --expected <id,id,...> is required — the IDs of the findings pushed back on\n");
    exit(2);
  }

  // `$(cat)`: trailing newlines dropped, so input of only newlines is empty.
  const INPUT = readFileSync(0, "utf8").replace(/\n+$/, "");

  if (INPUT === "") {
    process.stderr.write("error: empty input\n");
    exit(1);
  }

  const lines = INPUT.split("\n");
  const CONCEDE_LINES = lines.filter((l) => l.startsWith("[concede]"));
  const DISAGREE_LINES = lines.filter((l) => l.startsWith("[disagree]"));

  const seen = new Map<string, number>();
  const ids = [
    ...CONCEDE_LINES.map((l) => verdictId(l, "[concede]")),
    ...DISAGREE_LINES.map((l) => verdictId(l, "[disagree]")),
  ];
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const expected = new Set(EXPECTED);
  const missing = EXPECTED.filter((id) => !seen.has(id));
  const duplicate = EXPECTED.filter((id) => (seen.get(id) ?? 0) > 1);
  const unexpected = [...seen.keys()].filter((id) => !expected.has(id));
  const incomplete = missing.length + duplicate.length + unexpected.length > 0;

  const VERDICT = incomplete ? "incomplete" : DISAGREE_LINES.length === 0 ? "consensus" : "escalate";

  let out = `concede-count: ${CONCEDE_LINES.length}\ndisagree-count: ${DISAGREE_LINES.length}\nverdict: ${VERDICT}\n\n`;
  for (const l of [...CONCEDE_LINES, ...DISAGREE_LINES]) out += `${l}\n`;
  for (const id of missing) out += `missing: ${id}\n`;
  for (const id of duplicate) out += `duplicate: ${id}\n`;
  for (const id of unexpected) out += `unexpected: ${id}\n`;
  process.stdout.write(out);
  if (incomplete) exit(3);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
