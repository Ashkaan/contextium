#!/usr/bin/env -S node --experimental-strip-types
// check-harness-config-links.ts — prove that every harness link is still a
// SYMLINK into this workbench, and that every hook manifest still names both
// pre-tool guards.
//
// WHY. The harness homes reach the workbench's skills and agents through links,
// so what every harness runs is versioned, diffable and restorable. The failure
// is silent: a harness that writes its own copy over a link leaves the
// workbench copy stale and nothing says so. This check reports it.
//
// WHY NOT JUST RELINK. Relinking a clobbered path by default erases the
// evidence — and the machine-written content — this check exists to report. So:
// report by default, `--fix` on request (the installer moves a real folder
// aside to <path>.pre-link itself; --fix never moves a directory).
//
// WHY THE MANIFEST HALF LIVES HERE TOO. A link that is right can point at a
// manifest that quietly lost a guard. The assertions are MAPPINGS, not
// set-equality: two manifests that both dropped the write guard are equal to
// each other, and a right set of scripts behind a wrong matcher never fires.
//
// Usage:
//   node --experimental-strip-types check-harness-config-links.ts          report drift, exit 1 if any
//   node --experimental-strip-types check-harness-config-links.ts --fix    relink, moving any occupying
//                                          file to <path>.pre-link first
//
// Environment (tests only; nothing in a real run sets these):
//   HARNESS_LINKS_HOME     stand in for $HOME
//   HARNESS_LINKS_REPO     stand in for the main checkout
//
// Exit: 0 clean · 1 drift (or a --fix that could not complete)
//
// Output is written with fs.writeSync, so the notes, the errors and the final
// OK line reach a shared pipe in the order they were produced — the installer
// reads the LAST line of `2>&1` as the verdict — and nothing is lost at exit.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const out = (s: string): void => {
  writeSync(1, s);
};
const errOut = (s: string): void => {
  writeSync(2, s);
};

/** `-L`: the path itself is a symlink, dangling or not. */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `-d`: a directory, following links. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `-f`: a regular file, following links. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Absolute and lexically normalized WITHOUT following symlinks. The chained
 *  rows are links to links on purpose, and resolving all the way through would
 *  compare a row against the folder instead of against the link it must name. */
function norm(p: string): string {
  return resolve(p);
}

/** `date +%Y%m%dT%H%M%S`, local time. */
function stamp(): string {
  const d = new Date();
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Replace <link> with a link to <target> in one rename(2), so a concurrent
 *  reader sees the old entry or the new link and never a missing path.
 *  Returns 0 relinked · 1 failed · 2 target missing · 3 a real directory
 *  stands there. */
function relink(link: string, target: string): number {
  const tmp = `${link}.tmp-link`;
  // BEFORE anything is renamed. A link to a target that does not exist leaves
  // the harness with nothing to read, and preserving the displaced file does
  // not help a harness about to start. Return 2 so the caller can say WHY.
  if (!existsSync(target)) return 2;
  // A real DIRECTORY is never relinked here: moving one aside is the
  // installer's step, said out loud, not a side effect of a check. Return 3.
  if (isDir(link) && !isLink(link)) return 3;
  try {
    rmSync(tmp, { force: true });
    if (existsSync(link) && !isLink(link)) {
      // NEVER clobber an existing .pre-link: it may be the only copy of content
      // a harness wrote and that never reached the workbench.
      let keep = `${link}.pre-link`;
      if (existsSync(keep)) {
        keep = `${link}.pre-link.${stamp()}`;
        let n = 0;
        while (existsSync(keep)) {
          n += 1;
          keep = `${link}.pre-link.${stamp()}.${n}`;
        }
      }
      cpSync(link, keep, { preserveTimestamps: true, verbatimSymlinks: true });
      out(`kept the displaced file at ${keep}\n`);
    }
    symlinkSync(target, tmp);
  } catch {
    return 1;
  }
  try {
    renameSync(tmp, link);
  } catch {
    rmSync(tmp, { force: true });
    return 1;
  }
  // The target could vanish between the guard and the swap, and a "repair"
  // that returns 0 over a dangling link is how the gate would pass a harness
  // that cannot read its skills.
  return existsSync(link) ? 0 : 1;
}

// ── The manifests ─────────────────────────────────────────────────────────

type Shape = "claude" | "gemini" | "agy";

const isObj = (v: unknown): v is { [key: string]: unknown } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A list the harness iterates — hook groups, a group's handlers: its items,
 *  nothing where it is absent (null), and an error (which makes that whole
 *  mapping a miss) for anything else. An OBJECT in a list's place is refused:
 *  no harness runs `{"0": group}`, however its values read. */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null) return [];
  throw new TypeError(`expected an array, got ${isObj(v) ? "an object" : typeof v}`);
}

/** `.k` on a group or handler: null for null, the value for an object, and an
 *  error (which makes that whole mapping a miss) for anything else. */
function field(o: unknown, k: string): unknown {
  if (o === null) return null;
  if (isObj(o)) return o[k] ?? null;
  throw new TypeError(`cannot index ${Array.isArray(o) ? "array" : typeof o} with "${k}"`);
}

/** `a // b`: b where a is null or false. */
const alt = (a: unknown, b: string): unknown => (a === null || a === false ? b : a);

/** The hook groups a harness reads from one manifest. Claude Code, Codex and
 *  Grok Build nest them under .hooks.PreToolUse; Gemini CLI under
 *  .hooks.BeforeTool; Antigravity makes each top-level key a hook NAME whose
 *  value holds the events. Throws where the manifest is not shaped for it. */
function hookGroups(shape: Shape, m: unknown): unknown[] {
  if (shape === "agy") {
    // The one map among them: hook name → its events.
    if (!isObj(m)) throw new TypeError("the manifest is not a map of hook names");
    const groups: unknown[] = [];
    for (const spec of Object.values(m)) if (isObj(spec)) groups.push(...list(spec.PreToolUse ?? null));
    return groups;
  }
  const hooks = field(m, "hooks");
  return list(field(hooks, shape === "gemini" ? "BeforeTool" : "PreToolUse"));
}

/** Does any group whose matcher matches the whole of <tool> run a command that
 *  names <script>? A matcher that is absent (or null) matches every tool. */
function routes(groups: unknown[], tool: string, script: string): boolean {
  return groups.some((g) => {
    const matcher = alt(field(g, "matcher"), ".*");
    if (typeof matcher !== "string") throw new TypeError("matcher is not a string");
    if (!new RegExp(`^(${matcher})$`).test(tool)) return false;
    return list(field(g, "hooks")).some((h) => {
      const c = alt(field(h, "command"), "");
      if (typeof c !== "string") throw new TypeError("command is not a string");
      return c.includes(script);
    });
  });
}

/** The (tool, script) pairs one manifest does not route. */
function manifestMisses(shape: Shape, m: unknown, want: string[]): Array<[string, string]> {
  const misses: Array<[string, string]> = [];
  let groups: unknown[] | null;
  try {
    groups = hookGroups(shape, m);
  } catch {
    groups = null;
  }
  for (const pair of want) {
    const i = pair.indexOf(":");
    const tool = pair.slice(0, i);
    const script = pair.slice(i + 1);
    let hit = false;
    try {
      hit = groups !== null && routes(groups, tool, script);
    } catch {
      hit = false;
    }
    if (!hit) misses.push([tool, script]);
  }
  return misses;
}

/** A manifest's parsed content, or undefined where it is not readable JSON.
 *  `null` and `false` count as unreadable: neither can hold a guard. */
function readJson(p: string): unknown {
  try {
    const v: unknown = JSON.parse(readFileSync(p, "utf8"));
    return v === null || v === false ? undefined : v;
  } catch {
    return undefined;
  }
}

type Kind = "required" | "optional" | "optional-file";

interface Row {
  link: string;
  target: string;
  kind: Kind;
  /** Asked about only while tools= (if recorded) names this tool. */
  tool?: string;
}

function gitLine(args: string[]): string | null {
  const r = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n+$/, "");
}

function main(): void {
  const args = process.argv.slice(2);

  let fix = false;
  const first = args[0] ?? "";
  if (first === "--fix") {
    fix = true;
  } else if (first !== "") {
    errOut("usage: check-harness-config-links.ts [--fix]\n");
    process.exitCode = 1;
    return;
  }

  const H = process.env.HARNESS_LINKS_HOME || process.env.HOME || homedir();

  // The MAIN checkout, never this worktree: a link into a worktree dies with it.
  // --git-common-dir answers with the main checkout's .git from inside a worktree
  // and with our own from inside the checkout, so one expression covers both.
  let MAIN: string;
  if (process.env.HARNESS_LINKS_REPO) {
    MAIN = process.env.HARNESS_LINKS_REPO;
  } else {
    const common = gitLine(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common === null) {
      process.exitCode = 1;
      return;
    }
    MAIN = realpathSync(dirname(common));
  }

  // The checkout this run is standing in — the manifests it asserts are this
  // tree's, so a worktree is checked against its own copies rather than main's.
  let HERE: string;
  if (process.env.HARNESS_LINKS_REPO) {
    HERE = process.env.HARNESS_LINKS_REPO;
  } else {
    const top = gitLine(["rev-parse", "--show-toplevel"]);
    if (top === null) {
      process.exitCode = 1;
      return;
    }
    HERE = top;
  }

  // ── The inventory ───────────────────────────────────────────────────────
  //
  // The skills rows are the whole folder, not a file: ~/.agents/skills is how
  // every harness reaches the workbench's skills, and ~/.claude/skills and
  // ~/.gemini/config/skills are Claude Code's and Antigravity's names for the
  // same place. ~/.claude/output-styles is Claude Code's only: no other harness
  // has output styles, and /author writes them to .agents/output-styles/.
  //
  // The hook rows exist only for a harness the installer was asked to wire, so
  // a MISSING one is not drift — but one that exists must be right. <kind> says
  // which: `required`; `optional` (missing is fine); `optional-file` (missing is
  // fine, and so is a file of the user's own, into which the installer merged
  // the guards instead of linking — the Codex case). <tool> (optional) keeps a
  // row from being asked about at all while the workbench's .agents/harness
  // `tools=` line leaves that tool out — a kept file or a foreign link of a
  // dropped tool is not ours; with no tools= line, every row is asked about.
  //
  // ORDER IS LOAD-BEARING for --fix: two rows point at another link rather than
  // at the workbench, and --fix refuses a target that does not exist yet.
  // Workbench-backed rows first, chained rows after.
  const LINKS: Row[] = [
    { link: `${H}/.agents/skills`, target: `${MAIN}/.agents/skills`, kind: "required" },
    { link: `${H}/.claude/agents`, target: `${MAIN}/.agents/agents`, kind: "required", tool: "claude" },
    { link: `${H}/.claude/output-styles`, target: `${MAIN}/.agents/output-styles`, kind: "required", tool: "claude" },
    {
      link: `${H}/.codex/hooks.json`,
      target: `${MAIN}/.agents/hooks/claude-hooks.json`,
      kind: "optional-file",
      tool: "codex",
    },
    {
      link: `${H}/.grok/hooks/contextium.json`,
      target: `${MAIN}/.agents/hooks/claude-hooks.json`,
      kind: "optional",
      tool: "grok",
    },
    {
      link: `${HERE}/.gemini/settings.json`,
      target: `${HERE}/.agents/gemini-settings.json`,
      kind: "optional",
      tool: "gemini",
    },
    { link: `${H}/.claude/skills`, target: `${H}/.agents/skills`, kind: "required", tool: "claude" },
    { link: `${H}/.gemini/config/skills`, target: `${H}/.agents/skills`, kind: "required", tool: "antigravity" },
  ];

  // The tools this workbench has wired, from the first `tools=` line of
  // .agents/harness (empty when the file or the line is absent: every tool row
  // is then asked for, as before).
  let toolsRec = "";
  try {
    const line = readFileSync(`${HERE}/.agents/harness`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("tools="));
    toolsRec = line === undefined ? "" : line.slice("tools=".length);
  } catch {
    toolsRec = "";
  }
  const toolWired = (t: string): boolean => toolsRec === "" || ` ${toolsRec} `.includes(` ${t} `);
  // A tool the record NAMES was wired by the installer, so its manifest must be
  // there; without a record, a manifest is asserted only where it exists.
  const toolRecorded = (t: string): boolean => toolsRec !== "" && toolWired(t);

  let rc = 0;
  let nOk = 0;
  let nSkip = 0;
  let errors = "";
  const err = (msg: string): void => {
    errors += `${msg}\n`;
    rc = 1;
  };

  for (const { link, target, kind, tool } of LINKS) {
    if (tool !== undefined && !toolWired(tool)) continue;
    if (kind !== "required" && !existsSync(link) && !isLink(link)) continue;
    if (kind === "optional-file" && isFile(link) && !isLink(link)) continue;

    // A box without ~/.gemini is not drift, it is a box without that harness.
    // Skip on the PARENT being absent, so a missing link inside a directory that
    // DOES exist still reports.
    if (!isDir(dirname(link))) {
      errOut(`note: ${dirname(link)} does not exist on this host, skipping ${link}\n`);
      nSkip += 1;
      continue;
    }

    const want = norm(target);
    let raw = "";
    let got = "";
    const linked = isLink(link);
    if (linked) {
      raw = readlinkSync(link);
      got = norm(isAbsolute(raw) ? raw : `${dirname(link)}/${raw}`);
    }

    let problem = "";
    if (!linked && isDir(link)) {
      problem = `is a real directory, not a symlink — a harness made the folder
    itself, or an earlier setup put a copy there`;
    } else if (!linked && existsSync(link)) {
      problem = `is a regular file, not a symlink — a harness wrote through and
    replaced the link, so the workbench copy is now stale`;
    } else if (!linked) {
      problem = "is missing";
    } else if (got !== want) {
      problem = `points at ${raw}, not at the workbench copy`;
    } else if (!existsSync(link)) {
      problem = `is a DANGLING link to ${raw}`;
    }

    if (!problem) {
      nOk += 1;
      continue;
    }

    if (fix) {
      switch (relink(link, target)) {
        case 0:
          out(`fixed: ${link} -> ${target}\n`);
          nOk += 1;
          break;
        case 2:
          err(`Error: refusing to relink ${link} — its target does not exist:
      ${target}
    ${link} is LEFT AS IT IS, because a link to a missing folder leaves that
    harness with nothing to read. Install the layer first, then re-run --fix.`);
          break;
        case 3:
          err(`Error: refusing to relink ${link} — it is a real directory.
    Move it aside (the installer does: <path>.pre-link) and re-run --fix;
    this script does not copy or rename a directory.`);
          break;
        default:
          err(`Error: could not relink ${link} -> ${target}`);
      }
      continue;
    }

    err(`Error: ${link} ${problem}
    want: ${target}`);
  }

  // ── The manifests ───────────────────────────────────────────────────────
  //
  // Required (manifest, TOOL NAME, script) mappings. Asserting the TOOL rather
  // than the matcher string is deliberate: a matcher is a regex, two spellings
  // of the same set are both correct, and what actually matters is whether the
  // tool a harness is about to run routes to the guard. Grok Build reads the
  // same Claude-shape file Codex links to, under its own tool names; Gemini
  // CLI's guards sit in its settings.json under BeforeTool.
  const INFRA = "check-host-infra-safety.sh";
  const WRITE = "check-shared-checkout-write.sh";
  let nManifests = 0;

  const checkManifest = (label: string, shape: Shape, mf: string, want: string[]): void => {
    nManifests += 1;
    if (!existsSync(mf)) {
      err(`Error: ${label} manifest missing at ${mf}`);
      return;
    }
    const m = readJson(mf);
    if (m === undefined) {
      err(`Error: ${label} manifest at ${mf} is not readable JSON`);
      return;
    }
    for (const [tool, script] of manifestMisses(shape, m, want)) {
      err(`Error: ${label} manifest does not route ${tool} to ${script}.
    Either the guard is absent or its matcher does not match that tool.`);
    }
  };

  const CLAUDE_WANT = [
    `Bash:${INFRA}`,
    `Bash:${WRITE}`,
    `Edit:${WRITE}`,
    `Write:${WRITE}`,
    `MultiEdit:${WRITE}`,
    `NotebookEdit:${WRITE}`,
  ];
  const GROK_WANT = [
    `run_terminal_command:${INFRA}`,
    `run_terminal_command:${WRITE}`,
    `write:${WRITE}`,
    `search_replace:${WRITE}`,
  ];
  const GEMINI_WANT = [
    `run_shell_command:${INFRA}`,
    `run_shell_command:${WRITE}`,
    `write_file:${WRITE}`,
    `replace:${WRITE}`,
  ];

  // Each manifest is asserted where its harness is wired. With a tools= record,
  // that is exactly the tools it names, and a missing manifest of one is an
  // error (its guards stopped running); a tool it leaves out is not asked about
  // — a file kept after --drop-tool is the user's. With no record, each is
  // asserted where it exists: Claude Code's where ~/.claude exists, Codex's and
  // Grok Build's where their hooks file exists, Gemini CLI's where this
  // checkout's .gemini/settings.json exists, Antigravity's where
  // .agents/hooks.json exists.
  const asserted = (tool: string, present: boolean): boolean =>
    toolRecorded(tool) || (toolsRec === "" && present);
  if (asserted("claude", isDir(`${H}/.claude`))) {
    checkManifest("Claude Code", "claude", `${H}/.claude/settings.json`, CLAUDE_WANT);
  }
  const codexHooks = `${H}/.codex/hooks.json`;
  if (asserted("codex", existsSync(codexHooks))) {
    checkManifest("Codex", "claude", codexHooks, [...CLAUDE_WANT, `apply_patch:${WRITE}`]);
    // Codex throws a manifest away whole when it carries any top-level key
    // besides `hooks` or `description` — both guards stop running there, with
    // no error anywhere.
    const m = readJson(codexHooks);
    const extra = isObj(m)
      ? Object.keys(m)
          .filter((k) => k !== "hooks" && k !== "description")
          .sort()
          .join(", ")
      : "";
    if (extra) {
      err(`Error: ${codexHooks} carries top-level key(s) besides hooks: ${extra}
    Codex throws the WHOLE manifest away when it carries anything but hooks or
    description, so both guards stop running there.`);
    }
  }
  const grokHooks = `${H}/.grok/hooks/contextium.json`;
  if (asserted("grok", existsSync(grokHooks))) {
    checkManifest("Grok Build", "claude", grokHooks, GROK_WANT);
  }
  const geminiSettings = `${HERE}/.gemini/settings.json`;
  if (asserted("gemini", existsSync(geminiSettings))) {
    checkManifest("Gemini CLI", "gemini", geminiSettings, GEMINI_WANT);
    // Gemini CLI reads .gemini/settings.json — AGENTS.md, the skills, the
    // guards — only in a trusted folder, so an untrusted workbench is not ready
    // however right the manifest is. A box with no ~/.gemini has no Gemini CLI
    // to trust anything; that is not drift.
    const trust = `${H}/.gemini/trustedFolders.json`;
    if (isDir(`${H}/.gemini`)) {
      const t = readJson(trust);
      if (!(isObj(t) && t[HERE] === "TRUST_FOLDER")) {
        err(`Error: Gemini CLI does not trust ${HERE}
    ${trust} needs "${HERE}": "TRUST_FOLDER" — without it Gemini CLI loads
    none of AGENTS.md, the skills or the guards. Re-run install.sh, or add it by hand.`);
      }
    }
  }
  const agyHooks = `${HERE}/.agents/hooks.json`;
  if (asserted("antigravity", existsSync(agyHooks))) {
    checkManifest("Antigravity", "agy", agyHooks, [
      `run_command:${INFRA}`,
      `run_command:${WRITE}`,
      `write_to_file:${WRITE}`,
      `replace_file_content:${WRITE}`,
    ]);
  }

  if (rc !== 0) {
    errOut(errors);
    errOut("\n");
    errOut(`Relink with: node --experimental-strip-types ${process.argv[1]} --fix\n`);
    errOut("It moves any occupying file to <path>.pre-link first, so content a harness\n");
    errOut("wrote that has not reached the workbench yet is preserved rather than lost.\n");
    process.exitCode = 1;
    return;
  }

  if (nSkip > 0) {
    out(`OK — ${nOk} links verified (${nSkip} skipped: no such home), ${nManifests} manifests carry the required hooks\n`);
  } else {
    out(`OK — ${nOk} links verified, ${nManifests} manifests carry the required hooks\n`);
  }
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
