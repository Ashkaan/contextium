#!/usr/bin/env -S node --experimental-strip-types
// parse-agent-output.ts — Step 4 input preparation for /debate. Reads
// the .output files in the output dir produced by dispatch-agents.ts,
// strips Codex header/footer noise, extracts the structured `## Position`
// block, and emits cleaned blocks delimited by `=== <role> ===`.
//
// Handles two schemas: round-1 (`## Position`, `## Key Arguments`,
// `## Strongest Point`, `## Acknowledged Weaknesses`) and round-2
// (`## Rebuttal`, `## Underweighted Argument`, `## Revised Position`).
//
// NO ANSWER IS DROPPED. Skipping an output whose anchor heading was not at the
// start of a line silently takes an agent out of the debate — a model's
// preamble can run straight into `## Position` with no newline. The anchor
// is found anywhere in a line, and an answer with no anchor at all is
// passed through whole, marked unstructured, for the synthesis to read. A
// BLANK output (empty, whitespace, or only footer noise) is no answer: it is
// named on stderr and left out, and a dir with no usable answer exits 1.
//
// Each block names who argued it (`argued by:`), from the `.voice` file
// dispatch-agents.ts writes — including a stand-in for a failed voice.
//
// The output dir is removed once read: nothing in /debate reads it after this.
//
// peers: build-agent-prompts.ts, dispatch-agents.ts, .agents/skills/debate/SKILL.md
//
// Usage:
//   parse-agent-output.ts --output-dir <path> [--round 1|2]

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { linesOf, ROUND_ANCHORS, roundAnswer } from "./answer-block.ts";

async function main(): Promise<void> {
  function die(msg: string): never {
    process.stderr.write(`${msg}\n`);
    exit(2);
  }

  // The help text is this file's own header comment — read as a block, not a
  // line range, so an edit above the usage cannot make --help print code.
  function headerComment(): string {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    return lines
      .slice(0, end === -1 ? lines.length : end)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n");
  }

  let outputDir = "";
  let round = "1";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--output-dir") outputDir = argv[++i] ?? "";
    else if (flag === "--round") round = argv[++i] ?? "";
    else if (flag === "-h" || flag === "--help") {
      process.stderr.write(`${headerComment()}\n`);
      exit(0);
    } else die(`unknown flag: ${flag}`);
  }

  if (outputDir === "") die("--output-dir required");
  if (!(existsSync(outputDir) && statSync(outputDir).isDirectory())) die(`output dir not found: ${outputDir}`);
  if (round !== "1" && round !== "2") die(`--round must be 1 or 2 (got: ${round})`);

  // Anchor heading that marks the start of the structured block per round.
  const anchor = ROUND_ANCHORS[round];

  /** The `*.output` files in the dir, in sorted (seat) order; dotfiles excluded, as a shell glob would. */
  function outputFiles(dir: string): string[] {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".output") && !f.startsWith(".") && statSync(join(dir, f)).isFile())
      .sort();
  }

  /** Every `*.gap` under the dir, subdirectories included. */
  function gapCount(dir: string): number {
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".gap")).length;
  }

  // This is the dir's last reader: /debate's synthesis works from what is
  // printed here, and dispatch-agents.ts already named every stand-in and gap
  // on its stderr. So the dir goes once it has been read, whatever the verdict —
  // one run left one behind, and /tmp held about a thousand of them.
  try {
    let filesFound = 0;
    let usable = 0;
    for (const name of outputFiles(outputDir)) {
      filesFound++;
      const role = name.slice(0, -".output".length);
      // The reading dispatch-agents.ts judged the seat by: from the anchor on,
      // cut at the first footer, trailing blank lines dropped — falling back to
      // the other round's heading when this round's reading keeps nothing, so a
      // seat dispatch called answered is always printed here.
      const { lines: answer, anchored } = roundAnswer(readFileSync(join(outputDir, name), "utf8"), round);
      // A blank answer — empty, whitespace only, or nothing left once the footer
      // noise is cut — carries no position. Emitting it as a block made silent
      // voices read as arguments; it is named on stderr and left out, which is
      // not dropping an answer, because there is none.
      if (answer.length === 0) {
        process.stderr.write(`  ${role}: no usable content in ${name} — skipped\n`);
        continue;
      }
      usable++;
      let text = `=== ${role} ===\n`;
      const voiceFile = join(outputDir, `${role}.voice`);
      if (existsSync(voiceFile) && statSync(voiceFile).size > 0) {
        text += `argued by: ${linesOf(readFileSync(voiceFile, "utf8"))[0] ?? ""}\n`;
      }
      if (!anchored) {
        process.stderr.write(`  ${role}: unstructured output — no '${anchor}' heading; passing it through whole\n`);
        text += `(unstructured — no '${anchor}' heading)\n`;
      }
      text += answer.map((l) => `${l}\n`).join("");
      process.stdout.write(`${text}\n`);
    }

    // When no .output files exist at all, count .gap files for diagnostics.
    if (filesFound === 0) {
      process.stderr.write(`no .output files in ${outputDir} (gap count: ${gapCount(outputDir)})\n`);
      exit(1);
    }
    // Files, but not one answer in them: the synthesis has nothing to weigh.
    if (usable === 0) {
      process.stderr.write(
        `no usable answer in ${outputDir}: ${filesFound} .output file(s), all blank (gap count: ${gapCount(outputDir)})\n`,
      );
      exit(1);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

await runToExit(main);
