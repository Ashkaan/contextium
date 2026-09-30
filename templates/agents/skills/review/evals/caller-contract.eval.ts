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
// This spends ONE real vendor call, on whichever vendor the `adversarial-review`
// row selects. It is not part of `npm test` for that reason — a suite that costs
// a vendor call per run stops being run.
//
// Usage:
//   node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts
//   node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts --pack-only
//
// `--pack-only` asserts the deterministic half — that the pack names the caller
// — and spends nothing. Useful for checking the fixture still bites after a
// packer change, and NOT a substitute for the rerun: a pack that reaches the
// prompt and a reviewer that acts on it are two different claims.
//
// Exit:
//   0  PASS — the review named the caller (or, with --pack-only, the pack did)
//   1  FAIL — it did not
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

  const PACK_ONLY = process.argv[2] === "--pack-only";

  const TMP = mkdtempSync(join(tmpdir(), "caller-contract-eval-"));
  try {
    const REPO = `${TMP}/repo`;
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

    // The caller. It is committed BEFORE the change and never touched again, so it
    // appears in no hunk of the diff under review.
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

    git("add", "src/api.ts");
    git("commit", "-qm", "add a lookup options parameter to getUser");

    const BASE = git("rev-parse", "HEAD~1");
    const HEAD_SHA = git("rev-parse", "HEAD");

    // ── The deterministic half ────────────────────────────────────────────

    writeFileSync(
      `${TMP}/fixture.diff`,
      spawnSync("git", ["-C", REPO, "diff", BASE, HEAD_SHA], { encoding: "utf8" }).stdout ?? "",
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
      err("FAIL: the pack itself does not name the caller — the fixture no longer bites.");
      err(pack);
      exit(1);
    }
    out("PASS: the pack names src/consumer.ts as a caller of getUser");

    if (PACK_ONLY) {
      out("caller-contract: PASS (pack-only; no vendor call spent)");
      exit(0);
    }

    // ── The rerun ─────────────────────────────────────────────────────────

    out("caller-contract: spending one vendor call on the adversarial-review row…");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", REVIEW, BASE, HEAD_SHA], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_REVIEW_REPO: REPO,
        CODE_REVIEW_ROUND_STATE_DIR: `${TMP}/rounds`,
        CODE_REVIEW_SNAP_STATE_DIR: `${TMP}/snaps`,
      },
      stdio: ["inherit", "pipe", "pipe"],
      maxBuffer: 1 << 26,
    });
    writeFileSync(`${TMP}/review.out`, r.stdout ?? "");
    writeFileSync(`${TMP}/review.err`, r.stderr ?? "");
    const rc = r.status ?? 1;

    if (rc !== 0) {
      err(`INCONCLUSIVE: the review did not complete (exit ${rc}). This is not a`);
      err("failing grade — an exhausted chain or a timeout says nothing about the");
      err("prompt. Restore a vendor and re-run.");
      // `tail -20`
      const lines = (r.stderr ?? "").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (const l of lines.slice(-20)) err(l);
      exit(2);
    }

    out("--- review stdout ---");
    process.stdout.write(readFileSync(`${TMP}/review.out`));
    out("--- end ---");

    if (/consumer/i.test(r.stdout ?? "")) {
      out("caller-contract: PASS — the review named the broken caller.");
      exit(0);
    }

    err("caller-contract: FAIL — the review did not name src/consumer.ts.");
    err("The pack put that file in the prompt by name and the caller is now");
    err("passing `undefined` into a required parameter that is dereferenced on");
    err("the first line of the body. Read the review above before changing the");
    err("prompt: a single miss is one sample, not a regression.");
    exit(1);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
