#!/usr/bin/env -S node --experimental-strip-types
// scaffold.ts — Step 2 (`scaffold`) of /author. Deterministic skeleton
// emitter: validates <type> + kebab <name>, computes the surface path,
// refuses on collision, copies the type's template with `{{name}}`
// substituted, and prints the written path.
//
// Names are rejected, never normalized — a silent rename would surprise
// the author (the name contract).
//
// A hook or a check is written as TypeScript (`<name>.ts`, and
// `<name>.test.ts` beside a check), from the `.template.ts` templates, because
// a scaffold of a bash check would be a file the bash-vs-TypeScript rule
// refuses. A bash hook, which that rule allows for a hook the harness fires on
// every tool call, is written by hand.
//
// peers: verify.ts, .agents/skills/author/SKILL.md,
//        .agents/skills/author/references/templates/
//
// Usage:
//   scaffold.ts <type> <name> [placement]
//     <type>      skill | hook | agent | output-style
//     <name>      kebab-case slug (^[a-z][a-z0-9-]*$)
//     [placement] hook only: `checks` → .agents/checks/<name>.ts
//                 plus <name>.test.ts beside it (default → .agents/hooks/<name>.ts)
//
// Output (stdout): the written path.
// Exit:
//   0  scaffold written
//   1  reject (non-kebab name, collision, missing template)
//   2  usage error (bad/missing type, empty name)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

const VALID_TYPES = "skill hook agent output-style";
const NAME_RE = /^[a-z][a-z0-9-]*$/;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // ── Where this session writes ─────────────────────────────────────────────
  // Self-location USED to set REPO_ROOT here, with a comment claiming it was
  // "robust against worktree vs CLAUDE_PROJECT_DIR mismatch, so files land in the
  // repo the script lives in." That reasoning is backwards: this script is always
  // READ FROM THE MAIN CHECKOUT, so "the repo the script lives in" is only ever
  // the main checkout — never the session's worktree. Scaffolded hooks and skills
  // landed in the main tree and the session's next Write was refused by the edit
  // guard. The resolver creates the worktree if needed, so the scaffold lands
  // where the rest of the session's edits go.
  //
  // TEMPLATE_DIR stays self-located: templates are READ, and reading them from the
  // checkout this script was invoked from is correct.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const resolver = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(scriptDir, "../../implement/scripts/session-write-root.ts")],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  // `$(…)` under `set -e`: a failed resolver ends the scaffold with its status.
  if (resolver.status !== 0) exit(resolver.status ?? 1);
  const repoRoot = (resolver.stdout ?? "").replace(/\n+$/, "");
  const templateDir = join(scriptDir, "../references/templates");

  // ── Arg parse ─────────────────────────────────────────────────────────────
  const type = process.argv[2] ?? "";
  const name = process.argv[3] ?? "";
  const placement = process.argv[4] ?? "";

  if (type === "") {
    err(`usage: ${basename(process.argv[1] ?? "scaffold.ts")} <type> <name> [placement]`);
    err(`valid types: ${VALID_TYPES}`);
    exit(2);
  }

  // Exact-match the type — a word match would accept a multi-token arg like
  // "skill hook". Aligns with verify.ts's dispatch (code-reviewer finding).
  if (!["skill", "hook", "agent", "output-style"].includes(type)) {
    err(`unknown type: ${type}`);
    err(`valid types: ${VALID_TYPES}`);
    exit(2);
  }

  // Empty name is the "no name" boundary → the skill prompts.
  if (name === "") {
    err(`name required (empty) — prompt the author for a ${type} name`);
    exit(2);
  }

  // Non-kebab name → reject, never normalize.
  if (!NAME_RE.test(name)) {
    err(`invalid name: '${name}' — must match ^[a-z][a-z0-9-]*$ (kebab-case)`);
    exit(1);
  }

  /** Copy <tmpl> to <dest> with {{name}} → name. name is kebab-validated. */
  const substitute = (tmpl: string, dest: string): void => {
    if (!isFile(tmpl)) {
      err(`template missing: ${tmpl}`);
      exit(1);
    }
    try {
      writeFileSync(dest, readFileSync(tmpl, "utf8").replaceAll("{{name}}", name));
    } catch {
      err(`scaffold.ts: ${dest}: No such file or directory`);
      exit(1);
    }
  };

  if (type === "skill") {
    // Skills live under `.agents/skills/` of the workbench, so the destination
    // is REPO_ROOT — the session's own worktree, the same root the hook and
    // agent branches write to — and the close lands it like any other file.
    //
    // SKILLS_ROOT stays, and stays FIRST, for the reason it was added: without
    // it this script's own suite would scaffold into the live tree and rely on
    // a cleanup step to take it back out again.
    const skillsRoot = process.env.SKILLS_ROOT || `${repoRoot}/.agents/skills`;
    const destDir = `${skillsRoot}/${name}`;
    const dest = `${destDir}/SKILL.md`;
    if (existsSync(destDir)) {
      err(`exists: ${destDir} — never overwrites; rename`);
      exit(1);
    }
    mkdirSync(destDir, { recursive: true });
    substitute(join(templateDir, "skill.template.md"), dest);
    process.stdout.write(`${dest}\n`);
  } else if (type === "hook") {
    // Placement decides BOTH the path AND which correct-by-construction template:
    //   default → .agents/hooks/<name>.ts : PreToolUse/PostToolUse, blocks with
    //             exit 2.
    //   checks  → .agents/checks/<name>.ts : a check, fails with exit 1, with
    //             <name>.test.ts beside it. What fires a check is a close gate
    //             in land.ts, not this script.
    const checks = placement === "checks";
    const rel = checks ? `.agents/checks/${name}.ts` : `.agents/hooks/${name}.ts`;
    const tmpl = join(templateDir, checks ? "hook-precommit.template.ts" : "hook-tooluse.template.ts");
    const dest = `${repoRoot}/${rel}`;
    const relTest = `${rel.slice(0, -".ts".length)}.test.ts`;
    const destTest = `${dest.slice(0, -".ts".length)}.test.ts`;
    if (existsSync(dest)) {
      err(`exists: ${rel} — never overwrites; rename`);
      exit(1);
    }
    if (checks && existsSync(destTest)) {
      err(`exists: ${relTest} — never overwrites; rename`);
      exit(1);
    }
    substitute(tmpl, dest);
    spawnSync("chmod", ["+x", dest], { stdio: "inherit" });
    if (checks) substitute(join(templateDir, "check-test.template.ts"), destTest);
    process.stdout.write(`${rel}\n`);
  } else if (type === "output-style") {
    // Body is APPENDED TO THE SYSTEM PROMPT, so it is in force every turn of
    // every session that selects it. Single file, no registration side effects:
    // existing does NOT select it (settings.json `outputStyle`) and does NOT
    // reach subagents (a SubagentStart hook's allowlist). Both are register-step
    // work per references/output-style.md. Output styles are Claude Code's
    // alone; the file goes in the shared layer, which the installer links from
    // ~/.claude/output-styles (there is no in-repo .claude/).
    const rel = `.agents/output-styles/${name}.md`;
    const dest = `${repoRoot}/${rel}`;
    if (existsSync(dest)) {
      err(`exists: ${rel} — never overwrites; rename`);
      exit(1);
    }
    mkdirSync(dirname(dest), { recursive: true });
    substitute(join(templateDir, "output-style.template.md"), dest);
    process.stdout.write(`${rel}\n`);
    err("note: keep-coding-instructions defaults to FALSE — omitting it strips");
    err("      Claude Code's software-engineering instructions. Template sets it");
    err("      true; change it deliberately, never by deletion.");
  } else {
    const rel = `.agents/agents/${name}.md`;
    const dest = `${repoRoot}/${rel}`;
    if (existsSync(dest)) {
      err(`exists: ${rel} — never overwrites; rename`);
      exit(1);
    }
    substitute(join(templateDir, "agent.template.md"), dest);
    process.stdout.write(`${rel}\n`);
    // verb-form reminder (non-blocking): agents are not slash-invocable.
    if (/^(run|make|build|create|fix|update|do|get|set|check)(-|$)/.test(name)) {
      err(`note: '${name}' reads like a verb — agents are NOT slash-invocable`);
      err("      If you want a /command, author a skill.");
    }
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await runToExit(main);
}
