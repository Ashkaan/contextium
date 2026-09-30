#!/usr/bin/env -S node --experimental-strip-types
// verify.ts — Step "verify" of /author, AND the deterministic enforcement
// surface for the four principles the artifact must satisfy (SKILL.md § The four principles):
//   (1) Anthropic best practices  (2) low token usage
//   (3) high determinism          (4) low context usage
//
// Each principle is a GATE here, not advisory prose:
// an artifact that violates one fails verify the same way malformed frontmatter
// does. Sourced from Anthropic docs (code.claude.com/docs/en/{skills,sub-agents,
// hooks}).
//
//   skill → .agents/checks/check-skills.ts (the published Agent Skills
//           validator + AGENTS.md § Skill shape: the six keys, description
//           ≤1,024, metadata.peers, state/)               [P1 spec]
//         + description not first-person                 [P1 Anthropic]
//         + references one level deep (leaf refs)        [P4 context]
//         No sentence cap and no body cap for skills: the description folds
//         "when to use it" in, and the body standard is
//         deterministic-where-possible, concise and effective — not a line count.
//   hook  → a bash hook (`.sh`): shellcheck + `set -euo pipefail`
//           a TypeScript hook (`.ts`): parses as TypeScript + never calls
//           `process.exit`
//         + top-level (PreToolUse) hooks MUST NOT exit 1 (use exit 2 to block) [P1]
//         + non-blocking WARN when no harness hook manifest names a top-level
//           hook                                     [determinism / visibility]
//         (a check under .agents/checks/ gets no wiring claim: nothing
//         dispatches a new check on its own, and a WARN against a dispatcher
//         that does not exist would report every check unwired)
//   agent → 6-field frontmatter SSOT (references/agent.md)
//         + description not first-person, ONE sentence   [P1 Anthropic, P2 token]
//         + `tools` is a non-empty scoped list           [P1 best practice, P2 token]
//           (field is `tools`, NOT `allowed-tools` — the latter is ignored)
//
// The TypeScript hook gates: scaffold.ts writes a hook or a check as `.ts`,
// and a `.ts` file has no `set -euo pipefail` to
// hold it to and no shellcheck to pass. Its two gates are the nearest
// equivalents — it must parse (Node's own type stripper, which throws on a
// syntax error), and it must not end through `process.exit`, which can drop the
// denial reason still queued for stderr (.agents/packages/cli-exit/cli-exit.ts
// § WHY). A `.sh` hook is held to the bash gates.
//
// Node 22.6 through 22.12 have type stripping but not `stripTypeScriptTypes`;
// there the parse gate asks the stripper Node bundles (see stripTypes below).
//
// Usage: verify.ts <type> <path>
// Exit: 0 pass; 1 conformance/principle failure (actionable stderr); 2 usage.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// A skill's description cap is the Agent Skills spec's 1,024, enforced by
// check-skills.ts; agents have no documented character cap.
// Every agent description is always-loaded text: agents are listed to the model
// on EVERY session, so the description is the one field whose length is paid
// per session rather than per invocation. One sentence — the job and who
// dispatches it — is the cap [P2 token, P4 context]. Everything else belongs in
// the body, which loads only when the artifact runs.
const DESC_MAX_SENTENCES = 1;
// Agent SSOT field list (mirrors references/agent.md § Frontmatter contract).
// NB: the agent tool-allowlist field is `tools` (Anthropic), NOT `allowed-tools`
// — an unrecognized key is silently ignored and the agent inherits ALL tools.
const AGENT_REQUIRED_FIELDS = ["name", "description", "model", "tools", "peers"];

// Documented agent frontmatter fields, read first-hand from
// code.claude.com/docs/en/sub-agents plus the repo-only key (`peers`). An
// unrecognized key is SILENTLY IGNORED at load — the same
// failure the output-style branch already guards — so `allowed-tools` for
// `tools` reads as absent and the agent runs with every tool. Skills have no
// such list here: the published validator in check-skills.ts owns their keys.
const AGENT_KNOWN_FIELDS = ["name", "description", "model", "tools", "color", "skills", "peers"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// WHERE IS THE WORKBENCH? Three candidates, and the answer is PROVEN rather
// than assumed — the root must hold `.agents/skills/`, the folder the installer
// writes and every harness's skill link points into.
//
// The climb is first because it is the script's own workbench: this file lives
// at `<workbench>/.agents/skills/<skill>/scripts/`, so four levels up is the
// workbench — the session's worktree when invoked as
// `.agents/skills/<skill>/scripts/x.ts`, the checkout when invoked through the
// home link (`~/.agents/skills`, `~/.claude/skills`). The climb walks the REAL
// directory, so the link is followed before `..` is applied and the climb never
// lands in `~/.agents`. It fails for a copy of this file that sits outside a
// workbench (the template repo's `templates/agents/skills/`, a test's scratch
// dir), where a proven CLAUDE_PROJECT_DIR (a Claude Code hook sets it; nothing
// else does) or `git rev-parse` answers instead.
//
// A script elsewhere that needs the workbench root the same way should carry
// this function verbatim; change them together.
function resolveRepoRoot(scriptDir: string): string {
  let climb = "";
  try {
    climb = realpathSync(resolve(realpathSync(scriptDir), "../../../.."));
  } catch {
    climb = "";
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const gitTop = top.status === 0 ? (top.stdout ?? "").replace(/\n+$/, "") : "";
  for (const cand of [climb, process.env.CLAUDE_PROJECT_DIR ?? "", gitTop]) {
    if (cand === "") continue;
    if (!isDir(`${cand}/.agents/skills`)) continue;
    return cand;
  }
  return "";
}

// ── Shared frontmatter helpers ────────────────────────────────────────────

/** A file's lines, as awk and sed read them. */
function fileLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** The line number of the second `---` line, or 0 for none. */
function frontmatterEndLine(path: string): number {
  let c = 0;
  const lines = fileLines(path);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") {
      c += 1;
      if (c === 2) return i + 1;
    }
  }
  return 0;
}

/** `sed -n "2,$((end - 1))p"`: lines 2..end-1, or line 2 alone when end-1 < 2. */
function frontmatterBlock(path: string, end: number): string {
  const lines = fileLines(path);
  const last = Math.max(2, end - 1);
  return lines.slice(1, last).join("\n");
}

// Echo the FULL logical YAML value for <field>, folding block scalars (`>` / `|`)
// and block sequences (`- item`) into one space-joined string. Reading only the
// key's own line let a `description: >` folded scalar bypass the length +
// first-person gates and made a block-style `tools:` list read as empty
// (probe findings 1/4/6). Surrounding quotes are stripped so the char count is
// exact.
function frontmatterValue(path: string, field: string): string {
  const lines = fileLines(path);
  let infm = false;
  let capturing = false;
  let val = "";
  const keyRe = new RegExp(`^${field}:`);
  const keyStrip = new RegExp(`^${field}:[ \\t\\n\\v\\f\\r]*`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i === 0 && line === "---") {
      infm = true;
      continue;
    }
    if (infm && line === "---") break;
    if (!infm) continue;
    if (capturing) {
      if (/^[ \t\n\v\f\r]/.test(line) || /^[ \t\n\v\f\r]*-/.test(line)) {
        const item = line.replace(/^[ \t\n\v\f\r]+/, "").replace(/^-[ \t\n\v\f\r]*/, "");
        if (item !== "") val = val === "" ? item : `${val} ${item}`;
        continue;
      }
      capturing = false;
    }
    if (keyRe.test(line)) {
      let v = line.replace(keyStrip, "");
      if (/^[>|][0-9+-]*$/.test(v)) v = ""; // block-scalar indicator, not content
      val = v;
      capturing = true;
    }
  }
  val = val.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
  if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
  return val;
}

// A check's folder, in an installed workbench or the template repo. A check
// exits 1 by contract and gets no wiring claim.
const isCheckPath = (p: string): boolean => p.includes(".agents/checks/") || p.includes("templates/agents/checks/");
// A top-level hook's folder: `templates/agents/…` is the same folder in the
// template repo.
const isTopHookPath = (p: string): boolean => p.includes(".agents/hooks/") || p.includes("templates/agents/hooks/");

// Fail if a description is written in first person (Anthropic: third person).
// `\bI\b` is case-sensitive so "AI"/"API" are spared; the possessive/plural
// markers are case-insensitive (probe finding 2 — `my`/`we`/`our`/`me` slipped
// the old `\bI\b`-only check).
function descriptionIsFirstPerson(d: string): boolean {
  if (/\bI\b/.test(d)) return true;
  return /\b(my|me|we|our|us|i'm|i'll|i've)\b/i.test(d);
}

// Count sentences in a description. A terminator only counts when a space or the
// end of the string follows it, and the dots that are NOT sentence ends are
// neutralized first: dotted names (`claude.ai`, `SKILL.md`, `package.json`),
// decimals, ellipses, and the stock abbreviations. Without that, one mention of
// a filename would read as two sentences and the gate would fire on a compliant
// description.
function descriptionSentenceCount(desc: string): number {
  const d = desc
    .replace(/\.\.\./g, "…")
    .replace(/\b(e\.g|i\.e|etc|vs|approx)\./g, "$1")
    .replace(/([A-Za-z0-9])\.([A-Za-z0-9])/g, "$1$2");
  return (d.match(/[.!?]+["')]*([ \t\n\v\f\r]|$)/g) ?? []).length;
}

let fail = 0;
function flag(msg: string): void {
  err(`FAIL — ${msg}`);
  fail = 1;
}

/** Keys at column 0 of a frontmatter block that no known field names. */
function flagUnknownKeys(path: string, label: string, known: string[]): void {
  const fmEnd = frontmatterEndLine(path);
  if (fmEnd === 0) return;
  // Exact token match — a word match treats a hyphen as a boundary and would
  // wave `tools:` through as a substring of `allowed-tools`.
  const knownLine = `  ${known.join(" ")}  `;
  for (const fmline of frontmatterBlock(path, fmEnd).split("\n")) {
    if (/^[ \t\n\v\f\r]*$/.test(fmline)) continue;
    if (/^[ \t\n\v\f\r]*#/.test(fmline)) continue;
    if (/^[ \t\n\v\f\r]/.test(fmline)) continue; // nested value, not a key
    if (fmline.startsWith("-")) continue; // list item at column 0
    const colon = fmline.indexOf(":");
    if (colon === -1) continue; // no colon, not a key line
    const key = fmline.slice(0, colon);
    if (!knownLine.includes(` ${key} `)) {
      flag(
        `${label} unknown frontmatter key \`${key}:\` — silently ignored at load; check the spelling against code.claude.com/docs/en/skills: ${path}`,
      );
    }
  }
}

/** Does the `python3` on PATH import PyYAML? (`command -v python3` and the import, together.) */
function hasPyYaml(): boolean {
  const r = spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function verifySkill(path: string): void {
  // The conformance check lives at `.agents/checks/`, three levels up from
  // this script and then down, and is the same one land.ts runs before every
  // commit: the published Agent Skills validator (the six keys, name =
  // folder, description ≤1,024) plus AGENTS.md § Skill shape's local rules.
  // It prints its own violation lines; a failure here is one of those.
  const cs = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "../../../checks/check-skills.ts"), dirname(path)],
    { stdio: "inherit" },
  );
  if (cs.status !== 0) fail = 1;

  const desc = frontmatterValue(path, "description");
  if (desc === "") {
    flag("skill has no description: — it is the invocation trigger (Anthropic)");
  } else if (descriptionIsFirstPerson(desc)) {
    flag(
      `description is first-person — Anthropic requires third person ("Scaffolds…", not "I scaffold…") [P1]: ${path}`,
    );
  }

  // References must be one level deep: a file under references/ must not link
  // to another .md (that would be a second hop Claude has to chase) [P4].
  const refsDir = `${dirname(path)}/references`;
  if (isDir(refsDir)) {
    for (const entry of readdirSync(refsDir)) {
      const ref = `${refsDir}/${entry}`;
      if (!entry.endsWith(".md")) continue;
      try {
        if (!lstatSync(ref).isFile()) continue;
      } catch {
        continue;
      }
      // A LOCAL `](...md)` link is a second hop; external https doc URLs
      // ending `.md` are allowed (SKILL.md encourages citing Anthropic doc
      // URLs) — probe finding 5. A link back UP to the owning SKILL.md is
      // also allowed: it is the breadcrumb home, not a further hop outward,
      // and flagging it would fail correctly-shaped reference docs for
      // carrying the one link this rule most wants them to have.
      const links = readFileSync(ref, "utf8").match(/\]\([^)]+\.md\)/g) ?? [];
      const local = links.filter((l) => !/\]\(https?:\/\//.test(l)).filter((l) => !/\]\((\.\.\/)?SKILL\.md\)/.test(l));
      if (local.length > 0) {
        flag(`reference doc links to another local .md — keep references one level deep from SKILL.md [P4]: ${ref}`);
      }
    }
  }

  if (fail !== 0) exit(1);
  process.stdout.write(`PASS — skill (${basename(dirname(path))})\n`);
}

/** The bash hook's gates, as they always were. */
function verifyBashHook(path: string, source: string): void {
  if (spawnSync("sh", ["-c", "command -v shellcheck"], { stdio: "ignore" }).status !== 0) {
    err("shellcheck not installed — cannot verify hook");
    exit(1);
  }
  if (spawnSync("shellcheck", [path], { stdio: "inherit" }).status !== 0) fail = 1;
  // Safe mode, plus its fail-open carve-out: a Stop /
  // decision hook that must NEVER block on its own internal error MAY drop
  // `-e`, PROVIDED the `set` line carries an inline rationale comment. Under
  // `-e` an unguarded failure aborts non-zero, which for a Stop hook BLOCKS
  // the stop — the exact trap fail-open exists to prevent. Without this
  // branch the check would fail every sanctioned fail-open Stop hook, i.e.
  // enforce the rule's first paragraph and not its carve-out.
  if (!/^set -euo pipefail/m.test(source) && !/^set -uo pipefail[ \t\n\v\f\r]+#.*fail-open/m.test(source)) {
    flag(`hook missing \`set -euo pipefail\` — a
       fail-open Stop hook may use \`set -uo pipefail  # ... fail-open ...\`
       with an inline rationale on the set line: ${path}`);
  }
  // Placement gate: a top-level .agents/hooks/<name>.sh is a PreToolUse/
  // PostToolUse hook — exit 1 is NON-blocking there, so a blocker that
  // uses it silently fails to block. Must exit 2 to block (Anthropic) [P1].
  if (!isCheckPath(path) && isTopHookPath(path)) {
    const exit1 = /(^|[;{(&|\s])exit\s+1(\s|[;)&|]|$)/;
    if (source.split("\n").some((l) => exit1.test(l.replace(/#.*/, "")))) {
      flag(
        `top-level hook uses \`exit 1\` (NON-blocking) — a PreToolUse blocker must \`exit 2\`; checks belong in .agents/checks/ [P1]: ${path}`,
      );
    }
  }
}

/**
 * TypeScript source → the JavaScript Node runs; throws on a syntax error.
 * `stripTypeScriptTypes` arrived in Node 22.13. Before it (22.6–22.12, which
 * strip types but export no stripper) the same bundled stripper, amaro, is
 * asked in a child process — it is internal there, so only a child started
 * with `--expose-internals` can load it. A Node where neither answers throws a
 * plain "cannot strip" error, which the gate reports as a failure to parse.
 */
function stripTypes(source: string): string {
  const strip = (nodeModule as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;
  if (typeof strip === "function") return strip(source);
  const child = spawnSync(
    process.execPath,
    [
      "--expose-internals",
      "--no-warnings",
      "-e",
      `let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  try {
    const { transformSync } = require("internal/deps/amaro/dist/index");
    process.stdout.write(transformSync(s, { mode: "strip-only" }).code);
  } catch (e) {
    process.stderr.write(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
  }
});`,
    ],
    { input: source, encoding: "utf8" },
  );
  if (child.status === 0) return child.stdout;
  throw new Error(child.stderr || child.error?.message || `cannot strip types on Node ${process.version}`);
}

/** A TypeScript hook's gates: it parses, it never calls process.exit, and a top-level one never exits 1. */
function verifyTsHook(path: string, source: string): void {
  // Node's type stripper parses the whole file and throws on a syntax error.
  // It is marked experimental and says so on stderr; that line is not ours.
  // Stripping only parses, though: an early error the runtime raises before the
  // hook's first line runs (`const x = 1; const x = 2;`) strips cleanly. So the
  // stripped JavaScript is then syntax-checked as the ES module Node runs it as.
  process.removeAllListeners("warning");
  let stripped: string | null = null;
  try {
    stripped = stripTypes(source);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n").find((l) => l.trim() !== "") ?? "";
    flag(`hook does not parse as TypeScript (${msg.trim()}): ${path}`);
  }
  if (stripped !== null) {
    const check = spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: stripped,
      encoding: "utf8",
    });
    if (check.status !== 0) {
      const lines = `${check.stderr ?? ""}${check.error ? check.error.message : ""}`.split("\n");
      const msg =
        lines.find((l) => /^\w*Error:/.test(l)) ?? lines.find((l) => l.trim() !== "") ?? "node --check failed";
      flag(`hook does not parse as TypeScript (${msg}): ${path}`);
    }
  }
  const code = source.split("\n").map((l) => l.replace(/\/\/.*/, ""));
  if (code.some((l) => /\bprocess\.exit\s*\(/.test(l))) {
    flag(
      `hook calls \`process.exit\` — it can end the process before the reason queued for stderr is written; set process.exitCode and return, or end through runToExit (packages/cli-exit): ${path}`,
    );
  }
  if (!isCheckPath(path) && isTopHookPath(path)) {
    if (code.some((l) => /\bexit\s*\(\s*1\s*\)|\bexitCode\s*=\s*1\b/.test(l))) {
      flag(
        `top-level hook uses \`exit 1\` (NON-blocking) — a PreToolUse blocker must \`exit 2\`; checks belong in .agents/checks/ [P1]: ${path}`,
      );
    }
  }
}

function verifyHook(path: string, repoRoot: string): void {
  const source = readFileSync(path, "utf8");
  if (path.endsWith(".ts")) verifyTsHook(path, source);
  else verifyBashHook(path, source);
  if (fail !== 0) exit(1);
  const base = basename(path);
  // Non-blocking wiring check for a TOP-LEVEL hook only: it fires from nothing
  // until a hook manifest names it. The installer wires `.agents/hooks/` per
  // harness, each in the file that harness reads — Claude Code
  // `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Antigravity
  // `<workbench>/.agents/hooks.json` — so ANY of them naming the hook counts.
  // A check in `.agents/checks/` gets no claim. An unresolvable workbench root
  // is not evidence of an unwired hook either — saying "not wired" with the
  // workbench's own manifest unread would be a claim about a file this run
  // never opened.
  if (!isCheckPath(path)) {
    if (repoRoot === "") {
      err(`WARN — could not find the workbench, so '${base}' was not checked for`);
      err("       wiring. Set CLAUDE_PROJECT_DIR to the workbench checkout.");
    } else {
      const home = process.env.HOME || homedir();
      const manifests = [`${home}/.claude/settings.json`, `${home}/.codex/hooks.json`, `${repoRoot}/.agents/hooks.json`];
      const wired = manifests.some((m) => {
        try {
          return readFileSync(m, "utf8").includes(base);
        } catch {
          return false;
        }
      });
      if (!wired) {
        err(`WARN — '${base}' authored but not wired (no hook manifest names it:`);
        err("       ~/.claude/settings.json, ~/.codex/hooks.json, .agents/hooks.json)");
        err("       — it will never fire until wired.");
      }
    }
  }
  process.stdout.write(`PASS — hook (${base})\n`);
}

function verifyAgent(path: string): void {
  const lines = fileLines(path);
  if ((lines[0] ?? "") !== "---") {
    err(`FAIL — agent missing YAML frontmatter (must start with \`---\`): ${path}`);
    exit(1);
  }
  const fmEnd = frontmatterEndLine(path);
  if (fmEnd === 0) {
    err(`FAIL — agent has unterminated frontmatter (no closing \`---\`): ${path}`);
    exit(1);
  }
  const frontmatter = frontmatterBlock(path, fmEnd);
  // The block MUST parse as YAML — an unquoted `: ` anywhere in a value
  // ("Different job: the adversarial reviewer…") breaks it, and every field
  // goes with it at load: `tools:`, `model:`, the description. An agent has
  // shipped that way before. Skill side, the published validator in
  // check-skills.ts reports the same failure.
  // The parse uses PyYAML when python3 has it. Without it (macOS's stock
  // python3) a fallback checks the failure that matters: a top-level value
  // left unquoted while holding `: ` (or ending in `:`). An ImportError must
  // neither fail every agent nor let a malformed one through.
  let yamlBad = false;
  if (hasPyYaml()) {
    const r = spawnSync("python3", ["-c", "import sys, yaml; yaml.safe_load(sys.stdin.read())"], {
      input: `${frontmatter.replace(/\n+$/, "")}\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (r.status !== 0) yamlBad = true;
  } else {
    for (const line of frontmatter.split("\n")) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*:[ \t]/.test(line)) continue;
      const v = line.replace(/^[^:]*:[ \t]+/, "");
      if (/^["'>|[{&*!]/.test(v)) continue;
      if (v.includes(": ") || v.endsWith(":")) yamlBad = true;
    }
  }
  if (yamlBad) {
    flag(
      `agent frontmatter does not parse as YAML — every field is silently dropped at load (quote the value holding \`: \`, or fold it into a \`>-\` block): ${path}`,
    );
  }
  flagUnknownKeys(path, "agent", AGENT_KNOWN_FIELDS);
  const fmLines = frontmatter.split("\n");
  for (const field of AGENT_REQUIRED_FIELDS) {
    if (!fmLines.some((l) => l.startsWith(`${field}:`))) {
      flag(`agent frontmatter missing required field \`${field}:\` (per references/agent.md): ${path}`);
    }
  }

  const desc = frontmatterValue(path, "description");
  if (desc !== "" && descriptionIsFirstPerson(desc)) {
    flag(`agent description is first-person — Anthropic requires third person [P1]: ${path}`);
  }
  if (desc !== "") {
    const sentences = descriptionSentenceCount(desc);
    if (sentences > DESC_MAX_SENTENCES) {
      flag(
        `agent description is ${sentences} sentences — write ONE sentence naming the job and who dispatches it; the agent list is loaded every session, so the rest belongs in the body [P2/P4]: ${path}`,
      );
    }
  }

  // `tools` must be a non-empty scoped list — an agent with no tool scoping
  // inherits everything (higher permission + token surface) [P1/P2]. The field
  // is `tools`, not `allowed-tools` (the latter is silently ignored on agents).
  const tools = frontmatterValue(path, "tools");
  if (tools === "" || tools === "[]") {
    flag(
      `agent tools is empty/absent — scope \`tools:\` to what the job needs (NOT \`allowed-tools\`, which agents ignore) [P1/P2]: ${path}`,
    );
  }

  if (fail !== 0) exit(1);
  process.stdout.write(`PASS — agent (${basename(path)})\n`);
}

function verifyOutputStyle(path: string): void {
  // Field list read first-hand from code.claude.com/docs/en/output-styles.
  // All four are OPTIONAL to the parser — which is the problem
  // this branch exists to fix: every failure below is silent at runtime.
  const OS_KNOWN_FIELDS = "name description keep-coding-instructions force-for-plugin";

  const lines = fileLines(path);
  if ((lines[0] ?? "") !== "---") {
    err(`FAIL — output-style missing YAML frontmatter (must start with \`---\`): ${path}`);
    exit(1);
  }
  const fmEnd = frontmatterEndLine(path);
  if (fmEnd === 0) {
    err(`FAIL — output-style has unterminated frontmatter (no closing \`---\`): ${path}`);
    exit(1);
  }
  const frontmatter = frontmatterBlock(path, fmEnd);

  // (1) Unknown key. The parser IGNORES these, so a typo'd field is a silent
  // no-op — `keep_coding_instructions` with an underscore reads as absent and
  // strips the coding instructions the author meant to keep.
  for (const fmline of frontmatter.split("\n")) {
    if (/^[ \t\n\v\f\r]*$/.test(fmline)) continue;
    if (/^[ \t\n\v\f\r]*#/.test(fmline)) continue;
    if (/^[ \t\n\v\f\r]/.test(fmline)) continue; // nested value, not a key
    const colon = fmline.indexOf(":");
    if (colon === -1) continue; // no colon, not a key line
    const key = fmline.slice(0, colon);
    // Exact token match, NOT a word match: hyphen is a non-word character, so
    // a word match found `keep`, `coding`, `instructions`, `force` and `plugin`
    // INSIDE the two hyphenated field names and waved all five through as
    // known.
    if (!["name", "description", "keep-coding-instructions", "force-for-plugin"].includes(key)) {
      flag(
        `output-style unknown frontmatter key \`${key}:\` — silently ignored at load; valid keys are: ${OS_KNOWN_FIELDS}: ${path}`,
      );
    }
  }

  // (2) description drives the /config picker; without it there is no entry.
  const desc = frontmatterValue(path, "description");
  if (desc === "") {
    flag(
      `output-style missing \`description:\` — the /config picker shows this, so the style is unpickable without it: ${path}`,
    );
  } else {
    const sentences = descriptionSentenceCount(desc);
    if (sentences > DESC_MAX_SENTENCES) {
      flag(
        `output-style description is ${sentences} sentences — the /config picker shows one line, so write ONE sentence [P2]: ${path}`,
      );
    }
  }

  // (3) keep-coding-instructions DEFAULTS TO FALSE. Absent means Claude Code's
  // software-engineering instructions are stripped — almost never intended in
  // a coding repo, and invisible. Require the choice to be explicit.
  const kci = frontmatterValue(path, "keep-coding-instructions");
  if (kci === "") {
    flag(
      `output-style missing \`keep-coding-instructions:\` — it defaults to FALSE, which STRIPS Claude Code's software-engineering instructions. Set it explicitly: ${path}`,
    );
  } else if (kci !== "true" && kci !== "false") {
    flag(`output-style \`keep-coding-instructions: ${kci}\` is not true|false: ${path}`);
  }

  if (fail !== 0) exit(1);
  process.stdout.write(`PASS — output-style (${basename(path)})\n`);
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(SCRIPT_DIR);

  const type = process.argv[2] ?? "";
  const path = process.argv[3] ?? "";

  if (type === "" || path === "") {
    err(`usage: ${basename(process.argv[1] ?? "verify.ts")} <type> <path>`);
    exit(2);
  }
  if (!["skill", "hook", "agent", "output-style"].includes(type)) {
    err(`unknown type: ${type} (skill|hook|agent|output-style)`);
    exit(2);
  }
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    err(`path not found: ${path}`);
    exit(1);
  }

  if (type === "skill") verifySkill(path);
  else if (type === "hook") verifyHook(path, repoRoot);
  else if (type === "agent") verifyAgent(path);
  else verifyOutputStyle(path);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await runToExit(main);
}
