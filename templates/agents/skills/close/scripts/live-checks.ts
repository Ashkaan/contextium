#!/usr/bin/env -S node --experimental-strip-types
// live-checks.ts — what a finished spec says must be checked live, and what is
// live now to check it against.
//
// WHY. A hold entered when the model chose to, whose release re-proved only git
// ancestry, read no live check's result: an ordinary landing cleared the hold,
// and a parallel close could deploy a newer revision between the checks and the
// release. A close could also ask a question its live checks found under its
// own last line. So the protocol is in the script: a spec declares its checks
// here, land.ts owes them before it pushes, runs the command ones itself on
// --release, and accepts an eyes-only one only from a file recorded on the
// revision that is still live.
//
// THE FORM — this file is its one owner; the tasks template points here. A
// fenced block whose info string is `live-checks`, in a spec's tasks.md, one
// check per line (blank lines skipped):
//
//   ```live-checks
//   <id> | <target> | command | <shell command>
//   <id> | <target> | evidence | <what the evidence must show>
//   ```
//
// The line is split on its first three `|`, so a command keeps any pipe of its
// own. A command runs under `set -euo pipefail` (land.ts), so it may not pipe
// into a reader that stops early — `grep -q`, `grep -m`, `head`: the reader
// exits at its first match, the writer meets a closed pipe (curl exits 23,
// anything else 141), and the check fails though what it looked for is there —
// a large page fails that way every time. Capture first, then read:
// `P=$(curl -fsS …) && grep -q … <<<"$P"`. Such a line is refused at parse.
// <id> is [a-z0-9-]+, unique within the spec. <target> is one of:
//   workbench          — the repo that holds the declaring spec
//   repo:<owner>/<name> — another repo this close lands in, named as GitHub
//                        names it (land.ts finds its checkout in the ledger by
//                        its origin)
//
// WHAT IS LIVE on a target is its trunk as origin holds it now
// (`git ls-remote origin refs/heads/<trunk>`, the trunk from trunk.ts). The
// close knows no deployer of its own: the push deploys, and land.ts waits for
// every check GitHub reports on the pushed commit (await-push-checks.ts) before
// it holds, so a pushed trunk whose checks passed is what is served. A later
// push moves it, which voids an evidence capture taken before it.
//
// A reader answers what is live NOW, `{deploymentId, sourceCommit}`, never
// "did commit X deploy"; `sourceCommit` null is "cannot tell which commit",
// which the close refuses rather than guesses.
//
// Usage:
//   live-checks.ts parse <tasks.md>             → {"checks":[…],"warnings":[…]}; exit 1 on a malformed line
//   live-checks.ts revision <target> <repo-dir> → {"deploymentId":…,"sourceCommit":…}; exit 1 when unreadable
//   live-checks.ts source <repo:…>              → the owner/name it names; exit 1 for any other target
//   live-checks.ts contains <repo> <sha> <live> → exit 0 contained, 1 not, 2 unreadable
//
// LIVE_CHECKS_TEST_SOURCES=<json file> — the suites' seam: a target the file
// names (`workbench`, `repo:<owner>/<name>`) is answered from it, re-read on
// every call (so a check can change what is "live" mid-release; no file yet
// names nothing); the value is
// the live commit, null for "origin has no trunk", or `{"throw": "<msg>"}` to make
// that read fail. A target it does not name is read for real. Unset, as in
// every real run, nothing is stubbed.
//
// peers:
//   .agents/skills/close/scripts/land.ts                       (the one caller)
//   .agents/skills/close/scripts/trunk.ts                      (the trunk asked of origin)
//   .agents/skills/close/scripts/await-push-checks.ts          (the push checks waited for first)
//   .agents/skills/spec/references/templates/tasks.md          (points at the form)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LiveCheck = { id: string; target: string; kind: "command" | "evidence"; body: string; line: number };
export type Parsed = { checks: LiveCheck[]; warnings: string[]; errors: string[] };
export type Revision = { deploymentId: string; sourceCommit: string | null };

/** A pipe (not `||`) into `grep` with -q/-m/--quiet/--silent/--max-count, or into `head`. */
const EARLY_EXIT_READER =
  /(?<!\|)\|(?!\|)\s*(?:!\s*)?(?:grep\b[^|;&]*?\s(?:-[a-zA-Z]*[qm][a-zA-Z0-9]*|--quiet|--silent|--max-count(?:=\S*)?)(?=\s|$)|head\b)/;

const ID = /^[a-z0-9-]+$/;
const HEX = /^[0-9a-f]{7,40}$/;
const TRUNK_TS = `${dirname(fileURLToPath(import.meta.url))}/trunk.ts`;

/** Is <target> one of the two kinds, with a repo where the kind needs one? */
export function targetError(target: string): string | null {
  if (target === "workbench") return null;
  const m = /^repo:(.*)$/.exec(target);
  if (!m) return `unknown target "${target}" — workbench or repo:<owner>/<name>`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m[1] ?? "")) return `target "${target}" names no <owner>/<name>`;
  return null;
}

/** Every `live-checks` block of a tasks.md, parsed; `errors` carry `<line>: <why>`. */
export function parseLiveChecks(text: string): Parsed {
  const out: Parsed = { checks: [], warnings: [], errors: [] };
  const lines = text.split("\n");
  const seen = new Set<string>();
  let inBlock = false;
  let blockStart = 0;
  let blockCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const n = i + 1;
    if (!inBlock) {
      if (/^\s*```live-checks\s*$/.test(raw)) {
        inBlock = true;
        blockStart = n;
        blockCount = 0;
      }
      continue;
    }
    if (/^\s*```\s*$/.test(raw)) {
      inBlock = false;
      if (blockCount === 0) out.warnings.push(`${blockStart}: an empty live-checks block — it owes nothing`);
      continue;
    }
    if (raw.trim() === "") continue;
    blockCount += 1;
    const parts: string[] = [];
    let rest = raw;
    for (let k = 0; k < 3; k++) {
      const at = rest.indexOf("|");
      if (at === -1) break;
      parts.push(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
    parts.push(rest);
    if (parts.length < 4) {
      out.errors.push(`${n}: ${parts.length} field(s), not four — <id> | <target> | <kind> | <body>`);
      continue;
    }
    const [id = "", target = "", kind = "", body = ""] = parts.map((p) => p.trim());
    if (!id || !target || !kind || !body) {
      out.errors.push(`${n}: a blank field — <id> | <target> | <kind> | <body>`);
      continue;
    }
    if (!ID.test(id)) {
      out.errors.push(`${n}: id "${id}" is not [a-z0-9-]+`);
      continue;
    }
    const te = targetError(target);
    if (te) {
      out.errors.push(`${n}: ${te}`);
      continue;
    }
    if (kind !== "command" && kind !== "evidence") {
      out.errors.push(`${n}: unknown kind "${kind}" — command or evidence`);
      continue;
    }
    if (kind === "command" && EARLY_EXIT_READER.test(body)) {
      out.errors.push(
        `${n}: id "${id}" pipes into a reader that stops early (grep -q, grep -m, head), which fails under pipefail when the writer is still writing — capture first: P=$(…) && grep -q … <<<"$P"`,
      );
      continue;
    }
    if (seen.has(id)) {
      out.errors.push(`${n}: id "${id}" is declared twice`);
      continue;
    }
    seen.add(id);
    out.checks.push({ id, target, kind, body, line: n });
  }
  if (inBlock) out.errors.push(`${blockStart}: a live-checks block that never closes`);
  return out;
}

// ── What is live ───────────────────────────────────────────────────────────

export type Sources = {
  /** The commit origin's trunk is at, in the checkout <repo>; null when origin has no such branch. */
  trunkTip(repo: string): Promise<string | null>;
};

const realSources: Sources = {
  async trunkTip(repo) {
    const t = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", TRUNK_TS, repo], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trunk = (t.stdout ?? "").trim();
    if (t.status !== 0 || trunk === "") throw new Error(`no trunk branch in ${repo}: ${(t.stderr ?? "").trim().split("\n").pop() ?? ""}`);
    const r = spawnSync("git", ["-C", repo, "ls-remote", "origin", `refs/heads/${trunk}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) throw new Error(`git ls-remote origin failed in ${repo}: ${(r.stderr ?? "").trim().split("\n")[0] ?? ""}`);
    const sha = (r.stdout ?? "").split("\t")[0]?.trim() ?? "";
    return sha === "" ? null : sha;
  },
};

/** The seam: answers from a JSON file, re-read on every call; a target it
 *  does not name falls through to the real read. */
function fileSources(path: string, target: string): Sources {
  return {
    trunkTip: async (repo) => {
      // No file yet is a stub that names nothing: every target is read for real.
      const all = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<string, unknown>;
      if (!(target in all)) return realSources.trunkTip(repo);
      const v = all[target];
      if (v !== null && typeof v === "object" && "throw" in v) throw new Error(String((v as { throw: unknown }).throw));
      return v as string | null;
    },
  };
}

export function sources(target: string): Sources {
  const stub = process.env.LIVE_CHECKS_TEST_SOURCES;
  return stub ? fileSources(stub, target) : realSources;
}

/** What is live on <target>, served from the checkout <repo>, now. Throws,
 *  naming why, when it cannot be read. */
export async function liveRevision(target: string, repo: string, src: Sources = sources(target)): Promise<Revision> {
  const te = targetError(target);
  if (te) throw new Error(te);
  const tip = await src.trunkTip(repo);
  if (tip === null || tip === "") throw new Error(`origin of ${repo} has no trunk branch to read`);
  if (!HEX.test(tip)) throw new Error(`${target}'s live trunk is not a commit: ${String(tip).slice(0, 60)}`);
  return { deploymentId: tip, sourceCommit: tip };
}

/**
 * The GitHub repo a `repo:<owner>/<name>` target names. Throws for any other
 * target: `workbench` is the declaring spec's own repo, which the caller
 * already knows.
 */
export function sourceRepo(target: string): string {
  const te = targetError(target);
  if (te) throw new Error(te);
  if (!target.startsWith("repo:")) throw new Error(`${target} is served by a repo the close knows already`);
  return target.slice("repo:".length);
}

/**
 * Does the live commit contain <recorded>, in <repo>? `contained`, `not`
 * (unrelated or older), or `unreadable` (git failed, or <live> is a commit
 * <repo> does not have even after a fetch).
 */
export function contains(repo: string, recorded: string, live: string): "contained" | "not" | "unreadable" {
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" });
  const has = (sha: string) => git("rev-parse", "--verify", "-q", `${sha}^{commit}`).status === 0;
  if (!has(live) || !has(recorded)) git("fetch", "-q", "origin");
  if (!has(live) || !has(recorded)) return "unreadable";
  return git("merge-base", "--is-ancestor", recorded, live).status === 0 ? "contained" : "not";
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function cli(argv: string[]): Promise<number> {
  const [cmd, a = "", b = "", c = ""] = argv;
  const fail = (msg: string, code = 1): number => {
    process.stderr.write(`live-checks: ${msg}\n`);
    return code;
  };
  try {
    if (cmd === "parse" && a) {
      const p = parseLiveChecks(readFileSync(a, "utf8"));
      for (const w of p.warnings) process.stderr.write(`live-checks: warning ${a}:${w}\n`);
      if (p.errors.length > 0) {
        for (const e of p.errors) process.stderr.write(`live-checks: ${a}:${e}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ checks: p.checks, warnings: p.warnings })}\n`);
      return 0;
    }
    if (cmd === "revision" && a && b) {
      process.stdout.write(`${JSON.stringify(await liveRevision(a, b))}\n`);
      return 0;
    }
    if (cmd === "source" && a) {
      process.stdout.write(`${sourceRepo(a)}\n`);
      return 0;
    }
    if (cmd === "contains" && a && b && c) {
      const r = contains(a, b, c);
      process.stdout.write(`${r}\n`);
      return r === "contained" ? 0 : r === "not" ? 1 : 2;
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return fail(
    "usage: live-checks.ts parse <tasks.md> | revision <target> <repo-dir> | source <repo:…> | contains <repo> <sha> <live>",
    2,
  );
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await cli(process.argv.slice(2));
}
