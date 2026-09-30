#!/usr/bin/env -S node --experimental-strip-types
// write-audit-line.ts — write format-trailer.ts's `spec-audit:` line into a spec
// folder's plan.md, replacing the Constitution Check's `- spec-audit:` item.
//
// The one rule this adds: a NON-MATERIAL skip never erases a real verdict. When
// the item already holds a review result and the new line is
// `spec-audit: skipped — non-material (…)`, the verdict and its reviewer name
// stay, with `; re-check <YYYY-MM-DD> non-material` appended (a previous
// re-check note is replaced, not stacked). Otherwise — the placeholder, an
// earlier skip, a new verdict, a user-authorized skip — the new line replaces
// the item whole.
//
// Usage:
//   write-audit-line.ts <spec-folder> "<line from format-trailer.ts>"
//
// Exit: 0 written · 1 plan.md has no `- spec-audit:` item · 2 usage (no
// plan.md, or a line that does not start with exactly one `spec-audit: `).
//
// peers:
//   .agents/skills/spec-audit/scripts/write-audit-line.test.ts
//   .agents/skills/spec-audit/scripts/format-trailer.ts
//   .agents/skills/spec/references/templates/plan.md  (the placeholder item)

import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`write-audit-line: ${msg}\n`);
}

/** Today in the local zone, as `date +%Y-%m-%d` prints it. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const ITEM = /^- spec-audit:/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    err('usage: write-audit-line.ts <spec-folder> "<spec-audit: line>"');
    exit(2);
  }
  const folder = (args[0] ?? "").replace(/\/$/, "");
  let line = args[1] ?? "";
  const plan = `${folder}/plan.md`;
  let isFile = false;
  try {
    isFile = statSync(plan).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    err(`no plan.md in ${folder}`);
    exit(2);
  }
  if (line.startsWith("spec-audit: spec-audit:")) {
    err("doubled prefix — pass format-trailer.ts's output as it is");
    exit(2);
  }
  if (!line.startsWith("spec-audit: ") || line.length === "spec-audit: ".length) {
    err(`not a spec-audit: line: ${line}`);
    exit(2);
  }

  const text = readFileSync(plan, "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => ITEM.test(l));
  if (at === -1) {
    err(`no '- spec-audit:' item in ${plan} — restore it from the plan template`);
    exit(1);
  }

  const old = (lines[at] ?? "").replace(/^- spec-audit: */, "");
  if (line.startsWith("spec-audit: skipped — non-material")) {
    // The placeholder (`[…]`) or an earlier skip holds nothing worth keeping.
    if (!old.startsWith("[") && !old.startsWith("skipped")) {
      const cut = old.indexOf("; re-check ");
      const verdict = cut === -1 ? old : old.slice(0, cut);
      line = `spec-audit: ${verdict}; re-check ${today()} non-material`;
    }
  }

  lines[at] = `- ${line}`;
  writeFileSync(plan, lines.join("\n"));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
