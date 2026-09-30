#!/usr/bin/env -S node --experimental-strip-types
// {{name}}.ts — TODO one-line: a PreToolUse/PostToolUse hook. <what it guards>.
//
// Category (pick ONE, delete the rest):
//   (6) memory-write redirect  (7) tool-sandbox block
//   (8) session-discipline gate (9) context injection on tool call
//
// Wiring (REQUIRED — fires from nothing until added): a matcher block in
// <workbench>/.agents/user-hooks.json, which install.sh merges into each
// harness's hook manifest (Claude Code ~/.claude/settings.json, Codex
// ~/.codex/hooks.json, Antigravity .agents/hooks.json) — the author skill's
// references/hook.md Step 5:
//   { "matcher": "<ToolName or regex>",
//     "hooks": [{ "type": "command",
//                 "command": "node --experimental-strip-types <workbench>/.agents/hooks/{{name}}.ts" }] }
//
// Cost: a hook on a busy matcher starts a Node process on every matching tool
// call. The bash-vs-TypeScript rule lets a hook the harness fires on every tool
// call stay bash for that reason; keep the matcher narrow.
//
// Exit-code contract (Anthropic hooks, code.claude.com/docs/en/hooks):
//   exit 0 = allow · exit 2 = BLOCK (stderr becomes the denial reason shown to
//   Claude) · exit 1 is NON-blocking — never use it to block (the canonical bug).
// Set process.exitCode and return; never call process.exit, which can end the
// process before the denial reason queued for stderr has been written.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function main(): void {
  // Anything this hook calls that is not the guard (a shared helper, a
  // telemetry logger) goes in a try/catch that swallows its failure: a non-zero
  // exit leaking out of a tool-call hook denies the tool call, with exit 2
  // blocking it outright and an empty reason.

  // The tool-call event arrives as JSON on stdin.
  const input = readFileSync(0, "utf8");
  if (input === "") return;
  // TODO the guard. Block with exit 2 + an actionable reason naming the file + fix.
  // Example:
  //
  //   const event = JSON.parse(input) as { tool_name?: string; tool_input?: { file_path?: string } };
  //   const file = event.tool_input?.file_path ?? "";
  //   if (event.tool_name === "Write" && file.endsWith(".forbidden")) {
  //     process.stderr.write(`  {{name}}: ${file}: writes to .forbidden are blocked — use .allowed\n`);
  //     process.exitCode = 2;
  //     return;
  //   }
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
