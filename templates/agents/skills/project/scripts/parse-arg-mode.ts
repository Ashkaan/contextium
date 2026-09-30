#!/usr/bin/env -S node --experimental-strip-types
// parse-arg-mode.ts
//
// Parse the /project argument into a mode tag. Deterministic — pure regex.
//
// Modes:
//   blank          → no args; /project renders the project index inline (step-0.5-render-index)
//   create         → "create <freeform>" or bare freeform (new project)
//   existing-slug  → "<slug>" or "<domain>/<slug>" matching an existing project
//   complete       → "complete <slug>" (status change only)
//   update         → "update <slug>" (frontmatter edit only)
//
// Usage:
//   parse-arg-mode.ts "$ARGUMENTS"
//
// Output (two lines to stdout):
//   mode: <blank|create|existing-slug|complete|update>
//   payload: <the remainder after the mode verb, or empty for blank>
//
// Exit code: 0 always.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** POSIX [[:space:]] — not JS `\s`, which also takes Unicode spaces. */
const SPACE = "[ \\t\\n\\v\\f\\r]";

/**
 * Strip leading/trailing whitespace the way the bash original did:
 * `echo "$INPUT" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'` inside `$(…)`.
 * sed works line by line, so every line of a multi-line argument is trimmed,
 * and the command substitution drops the trailing newlines. `echo` itself read
 * an argument made only of its own flags (`-n`, `-e`, `-E`, combined) as
 * options and printed nothing — kept, so such an argument is `blank` as before.
 */
function strip(input: string): string {
  if (/^-[neE]+$/.test(input)) return "";
  const lead = new RegExp(`^${SPACE}+`);
  const trail = new RegExp(`${SPACE}+$`);
  return input
    .split("\n")
    .map((l) => l.replace(lead, "").replace(trail, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function emit(mode: string, payload: string): void {
  process.stdout.write(`mode: ${mode}\npayload:${payload === "" && mode === "blank" ? "" : ` ${payload}`}\n`);
}

async function main(): Promise<void> {
  const INPUT = strip(process.argv[2] ?? "");

  if (INPUT === "") {
    emit("blank", "");
    return;
  }

  // Mode verbs at the start of the input
  for (const verb of ["create", "complete", "update"]) {
    if (INPUT.startsWith(`${verb} `)) {
      emit(verb, INPUT.slice(verb.length + 1));
      return;
    }
  }

  // Heuristic: bare kebab-slug (one or more hyphens, no spaces) → existing-slug
  // Heuristic: <domain>/<slug> form → existing-slug
  // Heuristic: anything with spaces → create (freeform new project)
  if (INPUT.includes("/") && !INPUT.includes(" ")) {
    emit("existing-slug", INPUT);
    return;
  }

  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(INPUT)) {
    emit("existing-slug", INPUT);
    return;
  }

  // Default: freeform description → create
  emit("create", INPUT);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
