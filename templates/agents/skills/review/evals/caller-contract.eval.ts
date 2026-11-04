#!/usr/bin/env -S node --experimental-strip-types
// caller-contract.eval.ts — does the reviewer catch a broken caller it cannot
// see in the diff?
//
// Required by an eval suite for every app that calls a model: `code-review.ts verdict` is a
// declared ai_judgment_feature (SPEC front matter), and changing that script's
// prompt is a prompt change. This is the rerun.
//
// THE FIXTURE IS THE WHOLE ARGUMENT. One file changes: an exported function
// grows a second, REQUIRED parameter that its body immediately dereferences. The
// only caller lives in a second file that the diff does not touch and does not
// mention. Before the blast-radius pack there was nothing in the prompt that
// could lead a reviewer to that file — it would have to guess that a caller
// exists, guess where, and go read it. The pack puts `consumer.ts` in front of
// it by name, and this eval scores exactly one thing: does the review name the
// broken caller?
//
// WHAT IS NOT BEING SCORED. Not the reviewer's disposition, not its finding
// count, not its severity choice, not its prose. A review that reports the
// caller as `[must-fix]`, as `[should-fix]`, or in passing inside another
// finding all PASS. The claim under test is about what reached the prompt.
//
// THE SLICED CASE. A change too large for one
// review call is reviewed in pieces, each reading only its own files' diff. The
// second case changes the caller too (a new, unrelated function beside the
// broken call), and reviews the piece that holds only the callee: the caller is
// a changed file the reviewer is told another piece reads. The claim is the
// same — the review must still name the broken caller — because a piece that
// waves a caller off as "another piece's" is a whole-change regression.
//
// This spends ONE real vendor call per case, on whichever vendor the
// `adversarial-review` row selects: two by default. It is not part of `npm test`
// for that reason — a suite that costs a vendor call per run stops being run.
//
// Usage:
//   node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts [--case whole|sliced]
//   node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts --pack-only
//
// `--pack-only` asserts the deterministic half — that the pack names the caller
// — and spends nothing. Useful for checking the fixture still bites after a
// packer change, and NOT a substitute for the rerun: a pack that reaches the
// prompt and a reviewer that acts on it are two different claims.
//
// Exit:
//   0  PASS — every case's review named the caller (or, with --pack-only, every
//      case's pack did)
//   1  FAIL — a case's review did not
//   2  the review did not happen (chain exhausted, timeout, caller error).
//      INCONCLUSIVE, not a failing grade: an outage must never read as a
//      model regression.
//
// peers:
//   .agents/skills/review/code-review.ts
//   .agents/skills/review/blast-radius.ts
//   .agents/skills/review/evals/README.md

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(): Promise<void> {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  // The scripts under eval sit one level up: this folder is .agents/skills/review/evals/.
  const CHECKS = resolve(SCRIPT_DIR, "..");
  const REVIEW = `${CHECKS}/code-review.ts`;
  const PACK = `${CHECKS}/blast-radius.ts`;

  const argv = process.argv.slice(2);
  const PACK_ONLY = argv[0] === "--pack-only";
  let CASES: ("whole" | "sliced")[] = ["whole", "sliced"];
  if (argv[0] === "--case" && (argv[1] === "whole" || argv[1] === "sliced") && argv.length === 2) CASES = [argv[1]];
  else if (argv.length > 0 && !(PACK_ONLY && argv.length === 1)) {
    err("usage: caller-contract.eval.ts [--case whole|sliced] | --pack-only");
    exit(2);
  }

  const TMP = mkdtempSync(join(tmpdir(), "caller-contract-eval-"));
  try {
    /** One fixture repo per case: the caller is broken by the change in both. */
    const build = (kind: "whole" | "sliced"): { REPO: string; BASE: string; HEAD_SHA: string } => {
      const REPO = `${TMP}/repo-${kind}`;
      mkdirSync(`${REPO}/src`, { recursive: true });
      const git = (...args: string[]): string =>
        (spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout ?? "").replace(/\n+$/, "");
      git("init", "-q", ".");
      git("config", "user.email", "eval@local");
      git("config", "user.name", "eval");

      writeFileSync(
        `${REPO}/src/api.ts`,
        `export interface User {
  id: string
  name: string
}

export function getUser(id: string): User {
  return { id, name: \`user-\${id}\` }
}
`,
      );

      // The caller. In the whole case it is committed BEFORE the change and never
      // touched again, so it appears in no hunk of the diff under review.
      writeFileSync(
        `${REPO}/src/consumer.ts`,
        `import { getUser } from './api'

export function greet(id: string): string {
  const user = getUser(id)
  return \`hello \${user.name}\`
}
`,
      );

      writeFileSync(
        `${REPO}/README.md`,
        `# fixture
A two-file module used by the review chain's caller-contract eval.
`,
      );

      git("add", "src", "README.md");
      git("commit", "-qm", "initial module");

      // The change: a second parameter, required, and dereferenced on the first line
      // of the body. Every existing caller now passes `undefined` and throws.
      writeFileSync(
        `${REPO}/src/api.ts`,
        `export interface User {
  id: string
  name: string
}

export interface LookupOptions {
  includeArchived: boolean
}

export function getUser(id: string, options: LookupOptions): User {
  const suffix = options.includeArchived ? '-archived' : ''
  return { id, name: \`user-\${id}\${suffix}\` }
}
`,
      );
      // The sliced case changes the caller as well — an unrelated addition that
      // leaves the broken call as it was — so it is a changed file outside the
      // piece under review, read by "another piece".
      if (kind === "sliced")
        writeFileSync(
          `${REPO}/src/consumer.ts`,
          `import { getUser } from './api'

export function greet(id: string): string {
  const user = getUser(id)
  return \`hello \${user.name}\`
}

export function farewell(name: string): string {
  return \`goodbye \${name}\`
}
`,
        );

      git("add", "src");
      git("commit", "-qm", "add a lookup options parameter to getUser");
      return { REPO, BASE: git("rev-parse", "HEAD~1"), HEAD_SHA: git("rev-parse", "HEAD") };
    };

    // The piece the sliced case reviews: the callee alone.
    const PIECE = `${TMP}/piece-callee`;
    writeFileSync(PIECE, "src/api.ts\0");

    for (const kind of CASES) {
      const { REPO, BASE, HEAD_SHA } = build(kind);

      // ── The deterministic half ──────────────────────────────────────────
      // The pack is built over the piece's own file in both cases (the whole
      // case's diff holds no other), so it must still reach the caller.
      writeFileSync(
        `${TMP}/fixture.diff`,
        spawnSync("git", ["-C", REPO, "diff", BASE, HEAD_SHA, "--", "src/api.ts"], { encoding: "utf8" }).stdout ?? "",
      );
      const pack = (
        spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            PACK,
            "--repo",
            REPO,
            "--diff-file",
            `${TMP}/fixture.diff`,
            "--old-ref",
            BASE,
            "src/api.ts",
          ],
          { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"], maxBuffer: 1 << 26 },
        ).stdout ?? ""
      ).replace(/\n+$/, "");

      if (!pack.includes("src/consumer.ts")) {
        err(`FAIL (${kind}): the pack itself does not name the caller — the fixture no longer bites.`);
        err(pack);
        exit(1);
      }
      out(`PASS: the pack names src/consumer.ts as a caller of getUser${kind === "sliced" ? " (sliced)" : ""}`);
      if (PACK_ONLY) continue;

      // ── The rerun ───────────────────────────────────────────────────────

      out(`caller-contract (${kind}): spending one vendor call on the adversarial-review row…`);
      const args = kind === "sliced" ? [BASE, HEAD_SHA, "--slice", PIECE] : [BASE, HEAD_SHA];
      // The review needs an owner and the authors to leave out. The fixture is a
      // scripted diff no model wrote, so its author is "human" and the eval owns
      // its own review loop; run in the scratch repo, no thread's T3 context is
      // taken for the writer's (Contextium v9.2.0 review).
      const r = spawnSync(process.execPath, ["--experimental-strip-types", REVIEW, ...args], {
        encoding: "utf8",
        cwd: REPO,
        env: {
          ...process.env,
          CODE_REVIEW_LOOP_ID: process.env.CODE_REVIEW_LOOP_ID || `caller-contract-eval-${process.pid}`,
          POLICY_CHAIN_AUTHOR_VENDORS: process.env.POLICY_CHAIN_AUTHOR_VENDORS || "human",
          // An executing thread's id or writing thread, inherited, would make the
          // scripted fixture look like T3 work owing a writing thread: cleared.
          WORKBENCH_THREAD_ID: "",
          POLICY_CHAIN_AUTHOR_THREAD_ID: "",
          CODEX_REVIEW_REPO: REPO,
          CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/rounds-${kind}`,
          CODE_REVIEW_SNAP_STATE_DIR: `${TMP}/snaps`,
        },
        stdio: ["inherit", "pipe", "pipe"],
        maxBuffer: 1 << 26,
      });
      writeFileSync(`${TMP}/review.out`, r.stdout ?? "");
      const rc = r.status ?? 1;

      if (rc !== 0) {
        err(`INCONCLUSIVE: the review did not complete (${kind}, exit ${rc}). This is not a`);
        err("failing grade — an exhausted chain or a timeout says nothing about the");
        err("prompt. Restore a vendor and re-run.");
        // `tail -20`
        const lines = (r.stderr ?? "").split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        for (const l of lines.slice(-20)) err(l);
        exit(2);
      }

      out(`--- review stdout --- (${kind})`);
      process.stdout.write(readFileSync(`${TMP}/review.out`));
      out("--- end ---");

      if (/consumer/i.test(r.stdout ?? "")) {
        out(`caller-contract: PASS — the review named the broken caller${kind === "sliced" ? " (sliced)" : ""}.`);
        continue;
      }

      err(`caller-contract: FAIL — the review did not name src/consumer.ts${kind === "sliced" ? " (sliced)" : ""}.`);
      err("The pack put that file in the prompt by name and the caller is now");
      err("passing `undefined` into a required parameter that is dereferenced on");
      err("the first line of the body. Read the review above before changing the");
      err("prompt: a single miss is one sample, not a regression.");
      exit(1);
    }
    if (PACK_ONLY) out("caller-contract: PASS (pack-only; no vendor call spent)");
    exit(0);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
