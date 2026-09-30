#!/usr/bin/env -S node --experimental-strip-types
// Contract: run an adversarial review on an artifact using the vendor the
// policy table (policy.json beside this script) assigns to the task-kind. No
// caller names a model.
//
// Usage: policy-review.ts <task-kind> <artifact-path> <brief-file>
//
// This script owns ONLY prompt construction. The chain walk it used to inline
// was extracted to .agents/skills/review/policy-chain.ts so the review scripts
// could share it instead of each hardcoding one vendor — which is why a Codex
// quota lockout once took them all down with nothing to fall back to. It
// imports the walk.
//
// Output (stdout): the answering vendor's findings, and nothing else.
// Output (stderr): every diagnostic, including the `### reviewer:` line. That
//   line USED to go to stdout; it moved here in the extraction, because stdout
//   has to carry vendor output only for a caller that parses it.
//
// Exit: 0 = a vendor answered; 1 = chain exhausted; 2 = caller error;
//       3 = chain reached the claude slot (caller should dispatch its Claude
//       agent instead); 124 = exhausted, last failure was a timeout.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";
import { policyRunChain } from "./policy-chain.ts";

const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

async function main(): Promise<void> {
  const TASK_KIND = process.argv[2] ?? "";
  const ARTIFACT = process.argv[3] ?? "";
  const BRIEF_FILE = process.argv[4] ?? "";

  if (TASK_KIND === "" || ARTIFACT === "" || BRIEF_FILE === "") {
    err(`Usage: ${process.argv[1]} <task-kind> <artifact-path> <brief-file>`);
    exit(2);
  }

  for (const f of [ARTIFACT, BRIEF_FILE]) {
    if (!isFile(f)) {
      err(`policy-review: file not found: ${f}`);
      exit(2);
    }
  }

  // `$(cat …)` read them: trailing newlines dropped.
  const ARTIFACT_CONTENTS = readFileSync(ARTIFACT, "utf8").replace(/\n+$/, "");
  const BRIEF_CONTENTS = readFileSync(BRIEF_FILE, "utf8").replace(/\n+$/, "");

  const PROMPT_FILE = join(tmpdir(), `policy-review-prompt-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(
      PROMPT_FILE,
      `${BRIEF_CONTENTS}

ARTIFACT UNDER REVIEW: ${ARTIFACT}

--- BEGIN ARTIFACT ---
${ARTIFACT_CONTENTS}
--- END ARTIFACT ---
`,
      { flag: "wx" },
    );

    const RC = policyRunChain(TASK_KIND, PROMPT_FILE);

    if (RC === 0) {
      err(
        `### reviewer: ${process.env.POLICY_CHAIN_VENDOR ?? ""}/${process.env.POLICY_CHAIN_MODEL ?? ""} (per policy row '${TASK_KIND}')`,
      );
    }

    exit(RC);
  } finally {
    rmSync(PROMPT_FILE, { force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
