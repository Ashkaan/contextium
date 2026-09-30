#!/usr/bin/env -S node --experimental-strip-types
// build-agent-prompts.ts — Step 2 of /debate. Writes the three role prompts.
// Owns the role-template SSOT.
//
// Always three roles, no format and no config: a choice the user has to make
// before every debate is a choice they can get wrong. The council roles are the
// ones that proved useful across debates. File names sort into seat order, and
// dispatch-agents.ts hands seat N to panel voice N:
//   pragmatist → Claude, skeptic → Codex, visionary → Grok.
//
// Outputs a single line to stdout: `prompts_dir=<path>`.
//
// peers: dispatch-agents.ts, parse-agent-output.ts, .agents/skills/debate/SKILL.md
//
// Usage:
//   build-agent-prompts.ts --question "<q>" [--context-file <path>]

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

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

  let question = "";
  let contextFile = "";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--question") question = argv[++i] ?? "";
    else if (flag === "--context-file") contextFile = argv[++i] ?? "";
    else if (flag === "-h" || flag === "--help") {
      process.stderr.write(`${headerComment()}\n`);
      exit(0);
    } else die(`unknown flag: ${flag}`);
  }

  if (question === "") die("--question empty or missing");

  if (contextFile !== "" && !(existsSync(contextFile) && statSync(contextFile).isFile())) {
    die(`context file not found: ${contextFile}`);
  }

  const promptsDir = mkdtempSync(join(tmpdir(), "debate-prompts-"));

  // Trailing newlines are dropped, so an empty or blank-line-only file adds no
  // context block at all.
  const ctxBlock = contextFile === "" ? "" : readFileSync(contextFile, "utf8").replace(/\n+$/, "");

  type Role = "pragmatist" | "skeptic" | "visionary";
  const ROLES: Role[] = ["pragmatist", "skeptic", "visionary"];

  const STEEL_MAN = "Argue this position as if your career depends on it. Do not hedge.";

  // Pragmatist and visionary argue FOR a position; the skeptic attacks.
  const ADVOCATE_SCHEMA =
    "## Position\nOne sentence.\n\n## Key Arguments\n1. [Strongest]\n2. [Second strongest]\n3. [Third strongest]\n\n## Strongest Point\nThe single most compelling reason your position is correct.\n\n## Acknowledged Weaknesses\n1-2 weaknesses you concede, with why they don't change your conclusion.";

  const TEMPLATES: Record<Role, { roleBlock: string; stance: string; outputSchema: string }> = {
    pragmatist: {
      roleBlock: "Feasibility, cost, speed, what works today. Argue from implementation reality.",
      stance: "Pragmatist",
      outputSchema: ADVOCATE_SCHEMA,
    },
    skeptic: {
      roleBlock: "Hidden costs, perverse incentives, second-order effects. Trust no one's good intentions.",
      stance: "Skeptic",
      outputSchema:
        "## Position\nCritical assessment.\n\n## Key Arguments\n3 most dangerous failure modes.\n\n## Strongest Point\nWhat other council members are ignoring.\n\n## Acknowledged Weaknesses\nWeaknesses in the skeptical stance.",
    },
    visionary: {
      roleBlock: "Long-term impact, ideal outcomes. Work backward from the best possible future.",
      stance: "Visionary",
      outputSchema: ADVOCATE_SCHEMA,
    },
  };

  function emitPrompt(role: Role): void {
    const t = TEMPLATES[role];
    const lines = [t.roleBlock, STEEL_MAN, "", `Question: ${question}`, `Your assigned position: ${t.stance}`];
    if (ctxBlock !== "") lines.push("", "CONTEXT FOR DEBATE:", ctxBlock);
    lines.push("", "Structure your response as:", t.outputSchema, "", "Stay under 500 words. Specific, not generic.");
    writeFileSync(join(promptsDir, `${role}.prompt`), `${lines.join("\n")}\n`);
  }

  for (const role of ROLES) emitPrompt(role);

  process.stdout.write(`prompts_dir=${promptsDir}\n`);
}

await runToExit(main);
