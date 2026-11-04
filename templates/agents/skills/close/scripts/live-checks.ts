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
// WHAT IS LIVE — each target has one reader of what serves now, and when it
// cannot tell, the close refuses rather than guesses.
//
// The reader is GitHub's production deployments for the target's origin: what
// is live is the production deployment whose latest status is `success` and
// came LAST (`deployment <id>`, its commit). Not the newest deployment: GitHub
// marks earlier successes inactive only outside production (`auto_inactive`,
// "Create a deployment status", read 2026-11-04), so after a rollback the
// older deployment holds the newest success and the newer one still reads
// success. One still building, or whose latest status failed, does not count,
// so a capture taken while a deploy builds names the deployment that served
// it, and a release after the new one lands refuses that capture. The whole
// history is read or none of it counts: a deployment older than the read limit
// may be what serves, so a longer history is a failure, never an answer from
// part of it.
//
// When nothing records what serves — an origin not on GitHub, no production
// deployment, none whose latest status is success — the answer is
// `sourceCommit: null` ("cannot tell"), never the trunk, which a deploy may
// still be building or may have failed to ship. So an eyes-only evidence check
// needs a repo whose deploys GitHub records as production deployments; a
// command check, which land.ts runs itself on --release, works anywhere.
// Deployments that exist but cannot be read are a failure, never "cannot tell".
//
// A reader answers what is live NOW, `{deploymentId, sourceCommit}`, never
// "did commit X deploy".
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
// names nothing): `{"id": …, "sha": …}` is the live production deployment,
// null is none recorded, and `{"throw": "<msg>"}` makes that read fail. A
// target it does not name is read for real. Unset, as in every real run,
// nothing is stubbed.
//
// peers:
//   .agents/skills/close/scripts/land.ts                       (the one caller)
//   .agents/skills/close/scripts/await-push-checks.ts          (the push checks waited for first)
//   .agents/skills/spec/references/templates/tasks.md          (points at the form)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LiveCheck = { id: string; target: string; kind: "command" | "evidence"; body: string; line: number };
export type Parsed = { checks: LiveCheck[]; warnings: string[]; errors: string[] };
export type Revision = { deploymentId: string; sourceCommit: string | null };

/** A pipe (not `||`) into `grep` with -q/-m/--quiet/--silent/--max-count, or into `head`. */
const EARLY_EXIT_READER =
  /(?<!\|)\|(?!\|)\s*(?:!\s*)?(?:grep\b[^|;&]*?\s(?:-[a-zA-Z]*[qm][a-zA-Z0-9]*|--quiet|--silent|--max-count(?:=\S*)?)(?=\s|$)|head\b)/;

const ID = /^[a-z0-9-]+$/;
/** How far back the deployment history is read: 10 pages of 100. */
const DEPLOY_PAGES = 10;
const HEX = /^[0-9a-f]{7,40}$/;

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

export type Deployment = { id: string; sha: string };

export type Sources = {
  /** The production deployment live on <repo>'s origin (the header's rule),
   *  or why none can be named: the origin is not on GitHub, or records no
   *  production deployment whose latest status is success. Throws when it
   *  cannot be read (no gh, an unreadable or malformed answer, a history
   *  longer than the read limit). */
  deployment(repo: string): Promise<Deployment | { none: string }>;
};

/**
 * THE REPO GITHUB IS ASKED ABOUT: owner/name off <dir>'s configured origin URL,
 * or null when that is not on GitHub — the one reader land.ts and this file
 * share. Read from the config, not `git remote get-url`, which expands
 * `insteadOf`: a rewrite changes how the repo is reached, never which repo it
 * is. Unset is null (`git config` exit 1); any other failure throws, a read
 * that did not happen, never "no repo". An SSH origin may name a host alias
 * from ~/.ssh/config rather than github.com (`git@github-work:owner/repo` for a
 * second account), so its host is what `ssh -G` says it connects to — read from
 * the local config, no connection made.
 */
export function githubRepoOf(dir: string): string | null {
  const r = spawnSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status === 1) return null;
  if (r.status !== 0 || r.error) throw new Error(`could not read the origin of ${dir} — git config failed; re-run`);
  const url = (r.stdout ?? "").trim();
  const m =
    url.match(/^([a-z+]+):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^()(?:[^@/:]+@)?([^/:]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, scheme, host = "", repo = null] = m;
  if (host === "github.com") return repo;
  if (scheme !== "" && scheme !== "ssh") return null;
  const ssh = spawnSync("ssh", ["-G", host], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (ssh.status !== 0 || ssh.error) throw new Error(`could not resolve ${host}, the origin host of ${dir} — ssh -G failed; re-run`);
  return /^hostname github\.com$/m.test(ssh.stdout ?? "") ? repo : null;
}

/** `gh api <path>` as JSON; throws when gh is missing or its answer cannot be read. */
function ghJson(path: string): unknown {
  // A harness may force colour (FORCE_COLOR, CLICOLOR_FORCE); gh then wraps its
  // JSON in ANSI, as await-push-checks.ts says, so colour is turned off here too.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CLICOLOR: "0", GH_FORCE_TTY: "0" };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  const r = spawnSync("gh", ["api", path], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT")
    throw new Error("the origin is on GitHub, and reading its deployments needs the gh CLI, which is not installed");
  if (r.status !== 0) throw new Error(`gh api ${path} failed: ${(r.stderr ?? "").trim().split("\n")[0] ?? ""}`);
  try {
    return JSON.parse(r.stdout ?? "");
  } catch {
    throw new Error(`gh api ${path}: not JSON`);
  }
}

const realSources: Sources = {
  async deployment(repo) {
    const gh = githubRepoOf(repo);
    if (gh === null) return { none: "its origin is not on GitHub, so no deployment records what serves" };
    // Only production deployments serve the site: a newer preview is not what
    // is live. One still building, failed, inactive or never marked is skipped.
    // Every production one is read, because the one serving is the success
    // that came last, not the newest deployment (a rollback puts an older one
    // back by giving it a new success; see the header).
    let best: { id: string; sha: string; at: number } | null = null;
    for (let page = 1; ; page++) {
      const list = ghJson(`repos/${gh}/deployments?per_page=100&page=${page}`);
      if (!Array.isArray(list)) throw new Error(`repos/${gh}/deployments: not a list`);
      if (page > DEPLOY_PAGES) {
        // Past the limit only to learn whether the history ends there.
        if (list.length > 0)
          throw new Error(
            `${gh} has more than ${DEPLOY_PAGES * 100} deployments, and the older history is unread — one of them may be what serves`,
          );
        break;
      }
      for (const d of list) {
        if (d === null || typeof d !== "object" || Array.isArray(d)) throw new Error(`repos/${gh}/deployments: a malformed deployment`);
        const { id, sha, environment, production_environment } = d as Record<string, unknown>;
        const prod = production_environment === true || (typeof environment === "string" && /^(production|github-pages)$/i.test(environment));
        if (!prod) continue;
        if ((typeof id !== "number" && typeof id !== "string") || typeof sha !== "string" || !HEX.test(sha))
          throw new Error(`repos/${gh}/deployments: a production deployment without an id or commit`);
        const st = ghJson(`repos/${gh}/deployments/${id}/statuses?per_page=1`);
        if (!Array.isArray(st)) throw new Error(`repos/${gh}/deployments/${id}/statuses: not a list`);
        if (st.length === 0) continue;
        const latest = st[0];
        if (latest === null || typeof latest !== "object" || typeof (latest as { state?: unknown }).state !== "string")
          throw new Error(`repos/${gh}/deployments/${id}/statuses: a malformed status`);
        if ((latest as { state: string }).state !== "success") continue;
        const at = Date.parse(String((latest as { created_at?: unknown }).created_at ?? ""));
        if (Number.isNaN(at)) throw new Error(`repos/${gh}/deployments/${id}/statuses: a malformed status (no created_at)`);
        if (best === null || at > best.at) best = { id: String(id), sha, at };
      }
      if (list.length < 100) break;
    }
    if (best === null) return { none: `${gh} records no production deployment whose latest status is success` };
    return { id: best.id, sha: best.sha };
  },
};

/** The seam: answers from a JSON file, re-read on every call; a target it
 *  does not name falls through to the real read. */
function fileSources(path: string, target: string): Sources {
  return {
    deployment: async (repo) => {
      // No file yet is a stub that names nothing: every target is read for real.
      const all = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<string, unknown>;
      if (!(target in all)) return realSources.deployment(repo);
      const v = all[target];
      if (v === null) return { none: "no production deployment is recorded" };
      if (typeof v === "object" && "throw" in v) throw new Error(String((v as { throw: unknown }).throw));
      const { id, sha } = (typeof v === "object" ? v : {}) as { id?: unknown; sha?: unknown };
      if ((typeof id !== "string" && typeof id !== "number") || typeof sha !== "string")
        throw new Error(`${target}: a stubbed deployment without an id or commit`);
      return { id: String(id), sha };
    },
  };
}

export function sources(target: string): Sources {
  const stub = process.env.LIVE_CHECKS_TEST_SOURCES;
  return stub ? fileSources(stub, target) : realSources;
}

/** What is live on <target>, served from the checkout <repo>, now;
 *  `sourceCommit` null when nothing records it. Throws, naming why, when it
 *  cannot be read. */
export async function liveRevision(target: string, repo: string, src: Sources = sources(target)): Promise<Revision> {
  const te = targetError(target);
  if (te) throw new Error(te);
  const dep = await src.deployment(repo);
  if ("none" in dep) return { deploymentId: `none — ${dep.none}`, sourceCommit: null };
  if (!HEX.test(dep.sha)) throw new Error(`${target}'s live deployment names no commit: ${String(dep.sha).slice(0, 60)}`);
  return { deploymentId: `deployment ${dep.id}`, sourceCommit: dep.sha };
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
