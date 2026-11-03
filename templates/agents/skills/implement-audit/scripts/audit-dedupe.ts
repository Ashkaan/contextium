#!/usr/bin/env -S node --experimental-strip-types
// audit-dedupe.ts — the review receipt: what an independent review checked, of
// which bytes, with what result, and how many review calls the audit has spent.
//
// WHY A RECEIPT AND NOT A SESSION FLAG. This file used to store one trailer
// per session: `mark "<trailer>"` wrote
// it, and `status` re-printed it as `done` for the rest of the session. That
// answered "did an audit run in this session?", which is not the question a
// close needs answered. Fixes after the audit, /qa's edits, held nits fixed at
// the end and a trunk merge all changed the source a trailer still vouched for,
// and the post-QA review needed a separate bypass because the flag would have
// no-op'd it. A receipt binds the review to the content it read instead:
//
//   - the audit owner (CODE_REVIEW_LOOP_ID, else the session — see reviewOwner) and the
//     canonical repo/worktree, so another owner, repo or same-named worktree
//     never borrows it, and a realpath alias of the same worktree is the same;
//   - the content: a digest (verify.ts's `digest`: absent, link target, or exec
//     bit + bytes) of every changed non-record path, every path the report's
//     coverage declaration names, and the spec's behavior contract; plus the
//     declaration's own bytes. An unchanged caller or instruction that changes
//     makes the receipt stale even when the implementation did not move;
//   - the result: the answering reviewer, the writers it excluded, the
//     unresolved must-fix/should-fix lines, the held nits, and the reviewer's
//     checked/unchecked status for each declared item.
//
// A review attempt is written `incomplete` BEFORE dispatch, so an interrupted or
// failed attempt never inherits the earlier success; only the earlier complete
// receipt still matches the content it covered (undoing the unreviewed edit is
// a recovery). Approval comes from validate.ts's reading of the parsed result,
// never from code-review.ts's exit 0 alone, and never from a trailer.
//
// THE FRESH-CONTEXT FALLBACK (Contextium). Most installs have one model CLI, so
// the review chain can end with no independent vendor (code-review.ts exit 3,
// from a row whose declared fallback is "fresh-context"). `finish --rc 3` marks
// the open attempt pending; `finish --fallback <file>` then records the
// fresh-context reviewer's reply (validate.ts --fallback-review) against the
// same content, as reviewer `fresh-context` and `independent: false`. It
// satisfies a close like any receipt — no review at all is worse than a weaker
// one — and every line that reports it says NOT independent. Only an attempt the
// chain itself left pending can take one: a fallback never stands in for a
// vendor that answered, failed or timed out.
//
// SPENDING. The review rounds an owner has spent on a repo (build and QA
// buckets, the one final pass) live here too, in the owner's durable thread
// cache rather than /tmp, so a reboot loses no budget. A content, scope, base
// or executor change never renews them, and a missing or unreadable counter for
// an owner that registered an audit reads as spent, never as zero.
//
// THE OBLIGATION. The first review-driver entry registers `required` for the
// repo, so /close refuses the repo's implementation source without a valid
// receipt even if the report or receipt is later deleted. A close also applies
// the plan's backstop classification when the thread shows implementation work
// (a registered audit, unreadable state, or a report carrying a coverage block).
//
// State: ~/.cache/workbench/threads/<owner>/review.json, written atomically.
// Counters: <owner dir>/review-rounds[-qa]/<loop key>[.final|.full], or under
// CODE_REVIEW_ROUND_STATE_DIR[-qa] when that is set (the suites set it).
//
// peers:
//   .agents/skills/implement-audit/SKILL.md
//   .agents/skills/implement/SKILL.md
//   .agents/skills/implement/scripts/validate.ts   (begin / finish: the one review path)
//   .agents/skills/review/code-review.ts           (spend; framed result)
//   .agents/skills/close/scripts/verify.ts         (check, at verification)
//   .agents/skills/close/scripts/land.ts           (check, before the push)
//
// Usage:
//   audit-dedupe.ts status [--repo <dir>]
//       line 1 `done` when this owner's receipt for the repo still matches the
//       content it covered (line 2: its trailer or summary), else `fresh`, with
//       the reasons on stderr. Exit 0.
//   audit-dedupe.ts mark "<trailer>" [--repo <dir>]
//       attach the trailer to the valid receipt. Exit 1 when none is valid: a
//       trailer is a record, never proof of review.
//   audit-dedupe.ts begin --repo <dir> --base <sha> --scope <s> --tree <tree>
//                         --mode range|since|final --bucket build|qa
//                         [--since <tree>] [--report <path>]
//       register the obligation, validate the declaration, and either print
//       `RECEIPT=reuse` (a valid receipt matches; no review is needed) or write
//       the attempt `incomplete` and print `RECEIPT=review` + `ITEMS_FILE=<path>`.
//   audit-dedupe.ts finish --repo <dir> --rc <n> [--result <file>] [--checks-failed]
//       record the attempt's outcome; prints `APPROVED=0|1` and the reasons.
//       --rc 3 leaves the attempt open and pending the fresh-context fallback.
//   audit-dedupe.ts finish --repo <dir> --fallback <file> [--checks-failed]
//       record the fresh-context reviewer's reply (triage lines, its own
//       verdict format, or the BEGIN_REVIEW_V1 frame) for a pending attempt.
//   audit-dedupe.ts check --owner <id> <worktree>...
//       the close's reader: exit 0 when every worktree that needs a review has
//       a valid receipt, else 1 with one `review: <worktree>: <why>` line each.
// Exit: 0 ok · 1 refused (reasons on stderr) · 2 usage or caller error.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { inT3ReviewContext, reviewSessionId } from "../../close/scripts/t3-db.ts";
import { digest } from "../../close/scripts/verify.ts";

export type Bucket = "build" | "qa";
export type Mode = "range" | "since" | "final";

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Outside T3 Code: the close's own thread id (close/scripts/thread.ts --id —
 * the harness's session id, else one generated once and remembered for the
 * tree), so a receipt is filed under the id the close checks, on every harness,
 * including one that exports no session id. "" when it cannot answer.
 */
function closeThreadId(): string {
  const thread = fileURLToPath(new URL("../../close/scripts/thread.ts", import.meta.url));
  if (!existsSync(thread)) return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", thread, "--id"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

let ownerCache: string | undefined;
/**
 * The audit owner: CODE_REVIEW_LOOP_ID across fresh T3 review children; else,
 * in T3 Code, the executing task (reviewSessionId); elsewhere the close's thread id.
 */
export function reviewOwner(): string {
  if (ownerCache !== undefined) return ownerCache;
  ownerCache =
    process.env.CODE_REVIEW_LOOP_ID?.trim() || (inT3ReviewContext() ? reviewSessionId() : closeThreadId());
  return ownerCache;
}

let sidCache: string | undefined;
/** The counter key's session half, unchanged from code-review.ts so legacy counters migrate. */
export function reviewSid(): string {
  if (sidCache !== undefined) return sidCache;
  const owner = process.env.CODE_REVIEW_LOOP_ID;
  const sid = owner ? `loop-${sha256(owner)}` : reviewOwner();
  sidCache = sid.replace(/[^A-Za-z0-9_-]/g, "_");
  return sidCache;
}

export function canonicalRepo(repo: string): string {
  try {
    return realpathSync(repo);
  } catch {
    return resolve(repo);
  }
}

/** One fix loop's counter key: the owner AND the repo. Empty without an owner. */
export function loopKey(repo: string): string {
  const sid = reviewSid();
  if (sid === "") return "";
  return `${sid}-${sha256(canonicalRepo(repo)).slice(0, 12)}`;
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_");
export function ownerDir(owner: string): string {
  return join(process.env.HOME || homedir(), ".cache/workbench/threads", safeName(owner));
}
export const statePath = (owner: string): string => join(ownerDir(owner), "review.json");

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ── State ───────────────────────────────────────────────────────────────────

export interface ItemResult {
  id: string;
  status: "checked" | "unchecked";
  evidence: string[];
}
export interface Receipt {
  status: "incomplete" | "complete";
  mode: Mode;
  bucket: Bucket;
  tree: string;
  since?: string;
  /** The commit a full review's committed range ended at. */
  head?: string;
  base: string;
  scope: string;
  startedAt: string;
  finishedAt?: string;
  block: string | null;
  covered: Record<string, string>;
  requiredItems: string[];
  /** Each declared path's covered key and the item the reviewer reports it under. */
  itemKeys?: Record<string, string>;
  authors: string;
  reviewer?: string;
  items?: ItemResult[];
  blocking?: string[];
  nits?: string[];
  gaps?: string[];
  approved?: boolean;
  trailer?: string;
  /** The chain left no independent vendor (code-review.ts exit 3): a fresh-context fallback may finish it. */
  pendingFallback?: boolean;
  /** false: the fresh-context fallback reviewed it — recorded, and reported, as NOT independent. */
  independent?: boolean;
}
export interface RepoState {
  required: boolean;
  base: string;
  scope: string;
  report: string | null;
  registeredAt: string;
  spendInit: Partial<Record<Bucket, boolean>>;
  receipt?: Receipt;
  last?: Receipt;
}
export interface State {
  version: 1;
  owner: string;
  repos: Record<string, RepoState>;
}
type Read = { state: State } | { corrupt: string };

export function readState(owner: string): Read {
  const f = statePath(owner);
  if (!existsSync(f)) return { state: { version: 1, owner, repos: {} } };
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as State;
    if (s?.version !== 1 || typeof s.repos !== "object" || s.repos === null)
      return { corrupt: `${f} is not version 1` };
    return { state: s };
  } catch (e) {
    return { corrupt: `${f} could not be read: ${(e as Error).message}` };
  }
}
function writeState(owner: string, s: State): void {
  writeAtomic(statePath(owner), `${JSON.stringify(s, null, 1)}\n`);
}

// ── Spending ────────────────────────────────────────────────────────────────

export interface Spend {
  rounds: number;
  final: boolean;
  full: boolean;
}
export function roundDirs(bucket: Bucket): { dir: string; legacy: string | null } {
  const sfx = bucket === "qa" ? "-qa" : "";
  const o = process.env.CODE_REVIEW_ROUND_STATE_DIR;
  if (o) return { dir: `${o}${sfx}`, legacy: null };
  return { dir: join(ownerDir(reviewOwner()), `review-rounds${sfx}`), legacy: `/tmp/code-review-rounds${sfx}` };
}
function readCount(p: string): number | "absent" | "corrupt" {
  if (!existsSync(p)) return "absent";
  try {
    const raw = readFileSync(p, "utf8").replace(/\n+$/, "");
    return /^[0-9]+$/.test(raw) ? Number(raw) : "corrupt";
  } catch {
    return "corrupt";
  }
}
function spendRegistered(repo: string, bucket: Bucket): boolean | "corrupt" {
  const owner = reviewOwner();
  if (owner === "") return false;
  const r = readState(owner);
  if ("corrupt" in r) return "corrupt";
  return r.state.repos[canonicalRepo(repo)]?.spendInit?.[bucket] === true;
}

/**
 * What this owner has spent on this repo's bucket. null: no owner, so no counter
 * (a missing env var never blocks a review). `unknown`: a counter that cannot be
 * read, or is missing after the audit registered one — spent, never zero.
 */
export function readSpend(repo: string, bucket: Bucket): Spend | { unknown: string } | null {
  const key = loopKey(repo);
  if (key === "") return null;
  const { dir, legacy } = roundDirs(bucket);
  const d = readCount(`${dir}/${key}`);
  const l = legacy ? readCount(`${legacy}/${key}`) : "absent";
  if (d === "corrupt" || l === "corrupt")
    return { unknown: `the ${bucket} round counter for this audit is unreadable` };
  const final = existsSync(`${dir}/${key}.final`) || (legacy !== null && existsSync(`${legacy}/${key}.final`));
  const full = existsSync(`${dir}/${key}.full`);
  if (d === "absent") {
    // Once the audit registered its durable counter, a missing one is spent:
    // the /tmp counter it was migrated from can be older than what was spent
    // since, so it never stands in for the durable value.
    const reg = spendRegistered(repo, bucket);
    if (reg === "corrupt") return { unknown: "the review state for this audit is unreadable" };
    if (reg) return { unknown: `the ${bucket} round counter is missing although this audit registered one` };
    if (l === "absent") return { rounds: 0, final, full };
  }
  return { rounds: Math.max(d === "absent" ? 0 : d, l === "absent" ? 0 : l), final, full };
}

export function writeSpend(repo: string, bucket: Bucket, s: Spend): void {
  const key = loopKey(repo);
  if (key === "") return;
  const { dir } = roundDirs(bucket);
  writeAtomic(`${dir}/${key}`, `${s.rounds}\n`);
  if (s.final && !existsSync(`${dir}/${key}.final`))
    writeAtomic(`${dir}/${key}.final`, `${new Date().toISOString()}\n`);
  if (s.full && !existsSync(`${dir}/${key}.full`)) writeAtomic(`${dir}/${key}.full`, `${new Date().toISOString()}\n`);
}

// ── The coverage declaration ────────────────────────────────────────────────

export const OPEN = "<!-- review-coverage:v1 -->";
export const CLOSE = "<!-- /review-coverage -->";

export interface Declaration {
  base: string;
  scope: string;
  entryPoints: { id: string; path: string; note?: string }[];
  dependencies: { id: string; path: string; repo?: string; why: string; required?: boolean }[];
  claims: {
    id: string;
    claim: string;
    negativeTest?: { trigger: string; expected: string; evidence: string[] };
    inapplicable?: string;
  }[];
}

/**
 * Strict JSON: JSON.parse, after a scan that refuses a duplicate key in any
 * object (JSON.parse keeps the last one silently).
 */
export function parseStrictJson(text: string): unknown {
  const value = JSON.parse(text);
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) throw new Error(`duplicate key "${key}"`);
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    }
    i++;
  }
  return value;
}

const ID = /^[A-Za-z0-9_.-]{1,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const relPath = (p: string): boolean => !isAbsolute(p) && !p.split("/").includes("..") && p !== "";
function exactKeys(o: Record<string, unknown>, required: string[], optional: string[], where: string): void {
  for (const k of required) if (!(k in o)) throw new Error(`${where} lacks "${k}"`);
  for (const k of Object.keys(o))
    if (!required.includes(k) && !optional.includes(k)) throw new Error(`${where} has an unknown key "${k}"`);
}

/**
 * The report's one coverage block: null when the report has none, else the
 * declaration and the sha256 of the exact bytes between the two delimiter
 * lines. Throws on two blocks, an unpaired delimiter or an invalid object.
 */
export function parseDeclaration(report: string): { decl: Declaration; hash: string } | null {
  const lines = report.split("\n");
  const opens = lines.flatMap((l, n) => (l.trim() === OPEN ? [n] : []));
  const closes = lines.flatMap((l, n) => (l.trim() === CLOSE ? [n] : []));
  if (opens.length === 0 && closes.length === 0) return null;
  if (opens.length !== 1 || closes.length !== 1 || (opens[0] as number) > (closes[0] as number))
    throw new Error(`the report needs exactly one ${OPEN} … ${CLOSE} pair`);
  const inner = lines.slice((opens[0] as number) + 1, closes[0]).join("\n");
  const body = inner
    .trim()
    .replace(/^```(?:json)?\n/, "")
    .replace(/\n```$/, "");
  let v: unknown;
  try {
    v = parseStrictJson(body);
  } catch (e) {
    throw new Error(`the coverage block is not strict JSON: ${(e as Error).message}`);
  }
  if (!isObj(v)) throw new Error("the coverage block is not a JSON object");
  exactKeys(v, ["base", "scope", "entryPoints", "dependencies", "claims"], [], "the coverage block");
  if (!str(v.base) || typeof v.scope !== "string") throw new Error("base and scope must be strings");
  const ids = new Set<string>();
  const id = (o: Record<string, unknown>, where: string): void => {
    if (typeof o.id !== "string" || !ID.test(o.id)) throw new Error(`${where} has no valid id`);
    if (ids.has(o.id)) throw new Error(`id ${o.id} is used twice`);
    ids.add(o.id);
  };
  const arr = (x: unknown, where: string): Record<string, unknown>[] => {
    if (!Array.isArray(x) || !x.every(isObj)) throw new Error(`${where} must be an array of objects`);
    return x as Record<string, unknown>[];
  };
  for (const e of arr(v.entryPoints, "entryPoints")) {
    exactKeys(e, ["id", "path"], ["note"], "an entry point");
    id(e, "an entry point");
    if (typeof e.path !== "string" || !relPath(e.path))
      throw new Error(`entry point ${e.id}: path must be repo-relative`);
  }
  for (const d of arr(v.dependencies, "dependencies")) {
    exactKeys(d, ["id", "path", "why"], ["repo", "required"], "a dependency");
    id(d, "a dependency");
    if (typeof d.path !== "string" || !relPath(d.path))
      throw new Error(`dependency ${d.id}: path must be repo-relative`);
    if (d.repo !== undefined && (typeof d.repo !== "string" || !isAbsolute(d.repo)))
      throw new Error(`dependency ${d.id}: repo must be an absolute path`);
    if (!str(d.why)) throw new Error(`dependency ${d.id}: why is empty`);
    if (d.required !== undefined && typeof d.required !== "boolean")
      throw new Error(`dependency ${d.id}: required is not a boolean`);
  }
  for (const c of arr(v.claims, "claims")) {
    exactKeys(c, ["id", "claim"], ["negativeTest", "inapplicable"], "a claim");
    id(c, "a claim");
    if (!str(c.claim)) throw new Error(`claim ${c.id}: claim is empty`);
    if ((c.negativeTest === undefined) === (c.inapplicable === undefined))
      throw new Error(`claim ${c.id}: name exactly one of negativeTest or inapplicable`);
    if (c.inapplicable !== undefined && !str(c.inapplicable)) throw new Error(`claim ${c.id}: inapplicable is empty`);
    if (c.negativeTest !== undefined) {
      const t = c.negativeTest;
      if (!isObj(t)) throw new Error(`claim ${c.id}: negativeTest is not an object`);
      exactKeys(t, ["trigger", "expected", "evidence"], [], `claim ${c.id}'s negativeTest`);
      if (!str(t.trigger) || !str(t.expected)) throw new Error(`claim ${c.id}: trigger and expected must be named`);
      if (
        !Array.isArray(t.evidence) ||
        t.evidence.length === 0 ||
        !t.evidence.every((p) => typeof p === "string" && relPath(p))
      )
        throw new Error(`claim ${c.id}: evidence must list repo-relative paths`);
    }
  }
  return { decl: v as unknown as Declaration, hash: sha256(Buffer.from(inner, "utf8")) };
}

/** Each declared path's covered key, mapped to the item that names it. */
export function declaredKeys(decl: Declaration | null): Record<string, string> {
  const keys: Record<string, string> = {};
  if (!decl) return keys;
  for (const e of decl.entryPoints) keys[e.path] = e.id;
  for (const d of decl.dependencies) keys[d.repo ? `${canonicalRepo(d.repo)}::${d.path}` : d.path] = d.id;
  for (const c of decl.claims) for (const p of c.negativeTest?.evidence ?? []) keys[p] = c.id;
  return keys;
}

/** The items the reviewer reports on, one per declared entry point, dependency and claim. */
export function declarationItems(decl: Declaration | null): { id: string; required: boolean; text: string }[] {
  if (!decl) return [];
  return [
    ...decl.entryPoints.map((e) => ({
      id: e.id,
      required: true,
      text: `entry point ${e.path}${e.note ? ` — ${e.note}` : ""}: read it and confirm it still reaches the changed code correctly`,
    })),
    ...decl.dependencies.map((d) => ({
      id: d.id,
      required: d.required !== false,
      text: `unchanged dependency ${d.repo ? `${d.repo}::` : ""}${d.path} — ${d.why}: confirm the change still honors it`,
    })),
    ...decl.claims.map((c) => ({
      id: c.id,
      required: true,
      text: c.negativeTest
        ? `claim: ${c.claim}; negative test: ${c.negativeTest.trigger} must produce ${c.negativeTest.expected}; observed in ${c.negativeTest.evidence.join(", ")} — read the evidence and say whether it shows that failure and the restored pass`
        : `claim: ${c.claim}; no negative test, because ${c.inapplicable} — judge whether that is true`,
    })),
  ];
}

// ── What a receipt covers ───────────────────────────────────────────────────

/** Records /close and planning write: never a reason to review again unless declared. */
export function isRecord(p: string): boolean {
  return /^(?:journal|knowledge|decisions)\//.test(p) || /^projects\/.*\.md$/.test(p);
}

/**
 * The plan's backstop: a changed path that needs an independent review to land.
 * In a workbench the instructions count too: AGENTS.md, and the skills and
 * agents under .agents/ that tell a model what to do.
 */
export function needsReview(p: string, workbench: boolean): boolean {
  if (!workbench) return !isRecord(p) && !p.endsWith(".md");
  if (p === "AGENTS.md") return true;
  if (/^(?:apps|integrations|packages|\.agents)\//.test(p) && !p.endsWith(".md")) return true;
  return /^\.agents\/(?:skills|agents)\//.test(p) && p.endsWith(".md");
}

export const isWorkbench = (repo: string): boolean =>
  existsSync(join(repo, ".agents/skills")) && existsSync(join(repo, "projects"));

function gitZ(repo: string, args: string[]): string[] {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${(r.stderr ?? "").trim() || r.status}`);
  return (r.stdout ?? "").split("\0").filter((p) => p !== "");
}
function gitLine(repo: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

/** Where this branch left its trunk: the merge-base with origin's trunk, else the declared base, else HEAD. */
export function branchBase(repo: string, declared: string): string {
  for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if (gitLine(repo, ["rev-parse", "--verify", "-q", ref]) === null) continue;
    const mb = gitLine(repo, ["merge-base", "HEAD", ref]);
    if (mb) return mb;
  }
  if (declared && gitLine(repo, ["rev-parse", "--verify", "-q", `${declared}^{commit}`])) return declared;
  return "HEAD";
}

/** Every path changed since the branch base: committed, uncommitted and untracked, renames as two paths. */
export function changedSince(repo: string, base: string): string[] {
  const paths = [
    ...gitZ(repo, ["diff", "-z", "--no-renames", "--name-only", base]),
    ...gitZ(repo, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ];
  return [...new Set(paths)].sort();
}

/**
 * Every AGENTS.md at or above a path, repo-relative: the nearest one and each
 * one above it up to the root, all of which apply (root AGENTS.md: "follow it
 * alongside this file").
 */
function applicableInstructions(repo: string, p: string): string[] {
  const found: string[] = [];
  let dir = dirname(p);
  for (;;) {
    const cand = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`;
    if (existsSync(join(repo, cand))) found.push(cand);
    if (dir === "." || dir === "") return found;
    dir = dirname(dir);
  }
}

export interface Coverage {
  covered: Record<string, string>;
  block: string | null;
  decl: Declaration | null;
  problems: string[];
  changed: string[];
}

/**
 * The content a review of this repo covers now. Throws when git cannot list
 * what changed — a failed read is never an empty change.
 */
export function coverageNow(repo: string, base: string, report: string | null): Coverage {
  const problems: string[] = [];
  let decl: Declaration | null = null;
  let block: string | null = null;
  if (report !== null) {
    if (!existsSync(report)) problems.push(`the report ${report} is missing`);
    else {
      try {
        const parsed = parseDeclaration(readFileSync(report, "utf8"));
        if (parsed === null) problems.push(`the report has no ${OPEN} block`);
        else ({ decl, hash: block } = parsed);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
  }
  const changed = changedSince(repo, branchBase(repo, decl?.base ?? base));
  const members = changed.filter((p) => !isRecord(p));
  const covered: Record<string, string> = {};
  for (const p of members) covered[p] = digest(join(repo, p));
  if (decl) {
    const declared = new Set<string>();
    const add = (p: string, root = repo, key = p): void => {
      const d = digest(join(root, p));
      if (d === "absent") problems.push(`declared path ${key} does not exist`);
      covered[key] = d;
      if (root === repo) declared.add(p);
    };
    for (const e of decl.entryPoints) add(e.path);
    for (const d of decl.dependencies) {
      if (d.repo) add(d.path, d.repo, `${canonicalRepo(d.repo)}::${d.path}`);
      else add(d.path);
    }
    for (const c of decl.claims) for (const p of c.negativeTest?.evidence ?? []) add(p);
    // The applicable instructions: every AGENTS.md at or above each changed path.
    const need = new Set(members.flatMap((p) => applicableInstructions(repo, p)));
    for (const ins of need)
      if (!declared.has(ins) && !members.includes(ins))
        problems.push(`the declaration omits the applicable instruction ${ins}`);
  }
  if (report !== null) {
    const contract = join(dirname(report), "spec.md");
    if (existsSync(contract)) covered[`contract:${contract}`] = digest(contract);
  }
  return { covered, block, decl, problems, changed };
}

/** The writer vendors of an `<vendors>|<thread>` authors string, normalised. */
export function authorVendors(authors: string): string[] {
  return (authors.split("|")[0] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
}
const normaliseAuthors = (vendors: string, thread: string): string =>
  `${authorVendors(vendors).join(",")}|${thread.trim()}`;

function sameContent(r: Receipt, cov: Coverage): boolean {
  if (r.block !== cov.block) return false;
  const keys = new Set([...Object.keys(cov.covered), ...Object.keys(r.covered)]);
  return [...keys].every((k) => cov.covered[k] === r.covered[k]);
}

/** Gap tokens that are not covered keys. */
const GAP_WORDS: Record<string, string> = {
  "#declaration": "the coverage declaration",
  "#no-base": "no earlier complete review for this follow-up to build on",
  "#checks": "the deterministic checks failed before this review",
  "#head": "commits after the --head the full review ended at",
};

/** The file a triage line names first (`[must-fix] a.ts:12: …`), or null. */
export function findingFile(line: string): string | null {
  const m = line.replace(/^\[[a-z-]+\]\s*/, "").match(/^([^\s:]+\.[A-Za-z0-9]+)(?::\d+)?:/);
  return m?.[1] ?? null;
}

/** Why a receipt does not describe this content, or [] when it does. */
export function receiptReasons(r: Receipt | undefined, cov: Coverage, scope: string | null): string[] {
  if (!r) return ["no completed independent review"];
  if (r.status !== "complete") return ["the last review attempt did not complete"];
  const why: string[] = [];
  if (!r.reviewer) why.push("the review recorded no answering reviewer, so it is not a coverage receipt");
  if (r.reviewer && authorVendors(r.authors).includes(r.reviewer.split("/")[0] ?? ""))
    why.push(`the reviewer ${r.reviewer} is one of the writers`);
  if ((r.blocking ?? []).length > 0) why.push(`${(r.blocking ?? []).length} must-fix/should-fix finding(s) unresolved`);
  for (const g of r.gaps ?? []) why.push(`not reviewed: ${GAP_WORDS[g] ?? g}`);
  const status = new Map((r.items ?? []).map((i) => [i.id, i]));
  for (const id of r.requiredItems) {
    const it = status.get(id);
    if (!it) why.push(`the reviewer reported nothing for ${id}`);
    else if (it.status !== "checked")
      why.push(`the reviewer did not check ${id}: ${it.evidence.join("; ") || "no reason"}`);
  }
  if (scope !== null && r.scope !== scope) why.push(`reviewed scope '${r.scope}', not '${scope}'`);
  if (r.block !== cov.block) why.push("the report's coverage declaration changed since the review");
  const moved = [...new Set([...Object.keys(cov.covered), ...Object.keys(r.covered)])]
    .filter((k) => cov.covered[k] !== r.covered[k])
    .sort();
  if (moved.length > 0) why.push(`changed since the review: ${moved.join(", ")}`);
  return why;
}

/** A valid receipt among the latest attempt and the latest complete one, or the reasons neither is. */
export function validity(rs: RepoState, cov: Coverage, scope: string | null): { ok: Receipt } | { why: string[] } {
  if (cov.problems.length > 0) return { why: cov.problems };
  const a = receiptReasons(rs.receipt, cov, scope);
  if (a.length === 0 && rs.receipt) return { ok: rs.receipt };
  // The earlier complete receipt stands only when the latest one is an attempt
  // that never finished, or judged other content (the bytes were restored).
  // A completed review of these same bytes supersedes it, blockers and all.
  const judgedThis = rs.receipt?.status === "complete" && sameContent(rs.receipt, cov);
  if (rs.last && !judgedThis) {
    const b = receiptReasons(rs.last, cov, scope);
    if (b.length === 0) return { ok: rs.last };
  }
  return { why: a };
}

// ── The CLI ─────────────────────────────────────────────────────────────────

function flags(argv: string[], known: string[], bools: string[] = []): { f: Record<string, string>; rest: string[] } {
  const f: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (bools.includes(a)) f[a] = "1";
    else if (known.includes(a)) {
      if (i + 1 >= argv.length) usageExit(`${a} needs a value`);
      f[a] = argv[++i] as string;
    } else if (a.startsWith("--")) usageExit(`unknown flag ${a}`);
    else rest.push(a);
  }
  return { f, rest };
}
function usageExit(why: string): never {
  process.stderr.write(
    `audit-dedupe: ${why}\nusage: audit-dedupe.ts status|mark|begin|finish|check (see the header)\n`,
  );
  return exit(2);
}
const say = (l: string): void => {
  process.stdout.write(`${l}\n`);
};
const warn = (l: string): void => {
  process.stderr.write(`${l}\n`);
};
function toplevel(): string {
  return gitLine(process.cwd(), ["rev-parse", "--show-toplevel"]) ?? "";
}
function needOwner(): string {
  const owner = reviewOwner();
  if (owner === "") {
    warn(
      "implement-audit: no audit owner (CODE_REVIEW_LOOP_ID), native session or T3 thread id — no receipt can be kept",
    );
  }
  return owner;
}
function loadOrFail(owner: string): State {
  const r = readState(owner);
  if ("corrupt" in r) {
    warn(`implement-audit: ${r.corrupt} — refusing rather than reading it as no review`);
    exit(1);
  }
  return (r as { state: State }).state;
}
/** How a receipt's reviewer is reported: a fresh-context fallback always says it is not independent. */
const byWhom = (r: Receipt): string =>
  r.independent === false ? `${r.reviewer} (claude-fallback: fresh context, NOT independent)` : `${r.reviewer}`;
function summary(r: Receipt): string {
  return (
    r.trailer ??
    `implement-audit: receipt ${r.mode} review by ${byWhom(r)} at ${r.finishedAt}; ${(r.nits ?? []).length} nit(s) held; APPROVE`
  );
}

/**
 * The fresh-context fallback reviewer's reply, read into the shape a framed
 * vendor result has. Three spellings, so its output can be saved as it is: the
 * BEGIN_REVIEW_V1 frame (findings + coverage), triage lines with NO_FINDINGS,
 * and the implement-audit-reviewer agent's own format (`verdict: **fix-now**`
 * and `deferred-batch-N` block, the others are held; "Zero findings." is clean).
 * A reply holding none of them is a review that did not happen: an error.
 */
export function parseFallbackReply(text: string): { findings: string[]; coverage: ItemResult[] } | { error: string } {
  const lines = text.split("\n");
  const at = (w: string): number[] => lines.flatMap((l, i) => (l.trim() === w ? [i] : []));
  const b = at("BEGIN_REVIEW_V1");
  const e = at("END_REVIEW_V1");
  let coverage: ItemResult[] = [];
  let body = lines;
  if (b.length > 0 || e.length > 0) {
    if (b.length !== 1 || e.length !== 1 || (b[0] as number) > (e[0] as number))
      return { error: "the reply needs exactly one BEGIN_REVIEW_V1 … END_REVIEW_V1 frame" };
    let v: unknown;
    try {
      v = parseStrictJson(lines.slice((b[0] as number) + 1, e[0]).join("\n"));
    } catch (x) {
      return { error: `the frame is not strict JSON: ${(x as Error).message}` };
    }
    if (!isObj(v) || typeof v.findings !== "string" || !Array.isArray(v.coverage))
      return { error: "the frame is not {findings, coverage}" };
    for (const c of v.coverage) {
      if (
        !isObj(c) ||
        typeof c.id !== "string" ||
        (c.status !== "checked" && c.status !== "unchecked") ||
        !Array.isArray(c.evidence) ||
        !c.evidence.every((x) => typeof x === "string")
      )
        return { error: "a coverage entry is not {id, status: checked|unchecked, evidence: [strings]}" };
    }
    coverage = v.coverage as ItemResult[];
    body = v.findings.split("\n");
  }
  const findings: string[] = [];
  let clean = false;
  for (const raw of body) {
    const l = raw.trim();
    if (/^\[(?:must-fix|should-fix|nit)\]/.test(l)) findings.push(l);
    else if (l === "NO_FINDINGS" || l.startsWith("Zero findings.")) clean = true;
    else {
      const m = /verdict: \*\*(fix-now|deferred-batch-[0-9]+|speculative|out-of-scope)\*\*/.exec(l);
      if (m) findings.push(`${m[1] === "fix-now" ? "[must-fix]" : m[1]?.startsWith("deferred") ? "[should-fix]" : "[nit]"} ${l.replace(/^[0-9]+\.\s*/, "")}`);
    }
  }
  if (findings.length === 0 && !clean) return { error: "it holds no finding line and no NO_FINDINGS — the fallback review did NOT happen" };
  return { findings, coverage };
}

async function main(): Promise<void> {
  const [verb, ...argv] = process.argv.slice(2);
  switch (verb ?? "") {
    case "status": {
      const { f } = flags(argv, ["--repo"]);
      const owner = reviewOwner();
      const repo = canonicalRepo(f["--repo"] ?? toplevel());
      const r = owner === "" ? null : readState(owner);
      const rs = r && "state" in r ? r.state.repos[repo] : undefined;
      if (!rs) {
        say("fresh");
        return;
      }
      let v: ReturnType<typeof validity>;
      try {
        v = validity(rs, coverageNow(repo, rs.base, rs.report), rs.scope);
      } catch (e) {
        v = { why: [(e as Error).message] };
      }
      if ("ok" in v) {
        say("done");
        say(summary(v.ok));
      } else {
        say("fresh");
        for (const w of v.why) warn(`implement-audit: ${w}`);
      }
      return;
    }
    case "mark": {
      const { f, rest } = flags(argv, ["--repo"]);
      const trailer = rest[0] ?? "";
      if (trailer === "" || rest.length > 1) {
        process.stderr.write('usage: audit-dedupe.ts mark "<trailer>"\n');
        exit(2);
      }
      const owner = reviewOwner();
      if (owner === "") {
        warn("implement-audit: no native session or T3 thread id — dedupe skipped; carry the trailer inline");
        exit(0);
      }
      const repo = canonicalRepo(f["--repo"] ?? toplevel());
      const state = loadOrFail(owner);
      const rs = state.repos[repo];
      if (!rs) {
        warn(`implement-audit: no review receipt for ${repo} — a trailer is a record, not proof of review`);
        exit(1);
      }
      const v = validity(rs, coverageNow(repo, rs.base, rs.report), rs.scope);
      if (!("ok" in v)) {
        for (const w of v.why) warn(`implement-audit: ${w}`);
        warn("implement-audit: not marked — a trailer cannot stand in for a review of this content");
        exit(1);
      }
      v.ok.trailer = trailer;
      writeState(owner, state);
      say(`implement-audit: receipt for ${repo} carries the trailer (${statePath(owner)})`);
      return;
    }
    case "begin": {
      const { f } = flags(argv, [
        "--repo",
        "--base",
        "--head",
        "--scope",
        "--tree",
        "--mode",
        "--bucket",
        "--since",
        "--report",
      ]);
      for (const k of ["--repo", "--tree", "--mode", "--bucket"]) if (!f[k]) usageExit(`begin needs ${k}`);
      const mode = f["--mode"] as Mode;
      const bucket = f["--bucket"] as Bucket;
      if (!["range", "since", "final"].includes(mode)) usageExit(`unknown mode ${mode}`);
      if (!["build", "qa"].includes(bucket)) usageExit(`unknown bucket ${bucket}`);
      const owner = needOwner();
      if (owner === "") exit(1);
      const repo = canonicalRepo(f["--repo"] as string);
      const report = f["--report"] ? resolve(f["--report"]) : null;
      const state = loadOrFail(owner);
      const now = new Date().toISOString();
      const rs: RepoState = state.repos[repo] ?? {
        required: true,
        base: f["--base"] ?? "",
        scope: f["--scope"] ?? "",
        report,
        registeredAt: now,
        spendInit: {},
      };
      rs.required = true;
      if (f["--base"]) rs.base = f["--base"];
      rs.scope = f["--scope"] ?? rs.scope;
      if (report !== null) rs.report = report;
      // Initialise each bucket's durable counter once, carrying any spend a
      // /tmp counter from before the receipt holds, so a later missing file reads as spent.
      for (const b of ["build", "qa"] as Bucket[]) {
        if (rs.spendInit[b]) continue;
        const s = readSpend(repo, b);
        if (s !== null && !("unknown" in s)) writeSpend(repo, b, s);
        rs.spendInit[b] = true;
      }
      state.repos[repo] = rs;
      let cov: Coverage;
      try {
        cov = coverageNow(repo, rs.base, rs.report);
      } catch (e) {
        writeState(owner, state);
        warn(`implement-audit: ${(e as Error).message} — the review cannot be bound to its content`);
        exit(1);
      }
      if (cov.problems.length > 0) {
        writeState(owner, state);
        for (const p of cov.problems) warn(`implement-audit: coverage: ${p}`);
        warn("implement-audit: fix the report's coverage declaration before spending a review call");
        exit(1);
      }
      const v = validity(rs, cov, rs.scope);
      const authors = normaliseAuthors(
        process.env.POLICY_CHAIN_AUTHOR_VENDORS ?? "",
        process.env.POLICY_CHAIN_AUTHOR_THREAD_ID ?? "",
      );
      if ("ok" in v && v.ok.authors === authors) {
        writeState(owner, state);
        say("RECEIPT=reuse");
        say(
          `NOTE: the ${v.ok.mode} review by ${byWhom(v.ok)} (${v.ok.finishedAt}) still covers this content — no review call`,
        );
        return;
      }
      if (rs.receipt?.status === "complete") rs.last = rs.receipt;
      const items = declarationItems(cov.decl);
      rs.receipt = {
        status: "incomplete",
        mode,
        bucket,
        tree: f["--tree"] as string,
        ...(f["--since"] ? { since: f["--since"] } : {}),
        ...(mode === "range" && f["--head"]
          ? { head: gitLine(repo, ["rev-parse", "--verify", `${f["--head"]}^{commit}`]) ?? f["--head"] }
          : {}),
        base: rs.base,
        scope: rs.scope,
        startedAt: now,
        block: cov.block,
        covered: cov.covered,
        requiredItems: items.filter((i) => i.required).map((i) => i.id),
        itemKeys: declaredKeys(cov.decl),
        authors,
      };
      const itemsFile = join(ownerDir(owner), `review-items-${sha256(repo).slice(0, 12)}.json`);
      try {
        writeState(owner, state);
        // A follow-up is shown the findings still open, so a fix that does not
        // close one is re-reported rather than taken as settled.
        const openFindings = mode === "range" ? [] : (rs.last?.blocking ?? []);
        writeAtomic(
          itemsFile,
          `${JSON.stringify({ items: items.map(({ id, text }) => ({ id, text })), openFindings })}\n`,
        );
      } catch (e) {
        warn(`implement-audit: could not record the attempt: ${(e as Error).message}`);
        exit(1);
      }
      say("RECEIPT=review");
      say(`ITEMS_FILE=${itemsFile}`);
      return;
    }
    case "finish": {
      const { f } = flags(argv, ["--repo", "--rc", "--result", "--fallback"], ["--checks-failed"]);
      const fallback = f["--fallback"];
      if (!f["--repo"] || (f["--rc"] === undefined) === (fallback === undefined))
        usageExit("finish needs --repo and exactly one of --rc or --fallback");
      const owner = needOwner();
      if (owner === "") exit(1);
      const repo = canonicalRepo(f["--repo"] as string);
      const state = loadOrFail(owner);
      const rs = state.repos[repo];
      const r = rs?.receipt;
      if (!rs || !r || r.status !== "incomplete") {
        warn("implement-audit: no review attempt is open for this repo — nothing to finish");
        say("APPROVED=0");
        exit(1);
      }
      const rc = fallback !== undefined ? 0 : Number(f["--rc"]);
      if (fallback === undefined && rc === 3) {
        // No independent vendor: the attempt stays open, pending the declared
        // fresh-context fallback (see the header).
        r.pendingFallback = true;
        try {
          writeState(owner, state);
        } catch (e) {
          warn(`implement-audit: could not record the attempt: ${(e as Error).message}`);
          say("APPROVED=0");
          exit(1);
        }
        warn("implement-audit: no independent reviewer answered — pending the fresh-context fallback review");
        say("APPROVED=0");
        return;
      }
      if (fallback !== undefined && !r.pendingFallback) {
        warn(
          "implement-audit: this attempt is not pending a fallback — only a chain that found no independent vendor (exit 3) can take one",
        );
        say("APPROVED=0");
        exit(1);
      }
      if (rc === 4 && rs.last) {
        // Converged: nothing was reviewed, so the earlier complete receipt stands as it was.
        rs.receipt = rs.last;
        writeState(owner, state);
        const why = receiptReasons(
          rs.receipt,
          { covered: r.covered, block: r.block, decl: null, problems: [], changed: [] },
          rs.scope,
        );
        for (const w of why) warn(`implement-audit: ${w}`);
        say(`APPROVED=${why.length === 0 ? 1 : 0}`);
        return;
      }
      if (fallback === undefined && (rc !== 0 || !f["--result"])) {
        if (rc === 0)
          warn("implement-audit: the reviewer returned findings without a framed result — no coverage receipt");
        say("APPROVED=0");
        return;
      }
      let res: { vendor?: unknown; findings?: unknown; coverage?: unknown };
      if (fallback !== undefined) {
        let parsed: ReturnType<typeof parseFallbackReply>;
        try {
          parsed = parseFallbackReply(readFileSync(fallback, "utf8"));
        } catch (e) {
          parsed = { error: (e as Error).message };
        }
        if ("error" in parsed) {
          warn(`implement-audit: the fallback review ${fallback}: ${parsed.error}`);
          say("APPROVED=0");
          exit(1);
        }
        res = { vendor: "fresh-context/claude-fallback", ...parsed };
        r.independent = false;
        delete r.pendingFallback;
      } else {
        try {
          res = JSON.parse(readFileSync(f["--result"] as string, "utf8"));
        } catch (e) {
          warn(`implement-audit: the review result could not be read: ${(e as Error).message}`);
          say("APPROVED=0");
          return;
        }
      }
      const lines = Array.isArray(res.findings) ? (res.findings as string[]) : [];
      r.reviewer = typeof res.vendor === "string" ? res.vendor : undefined;
      r.blocking = lines.filter((l) => /^\[(?:must-fix|should-fix)\]/.test(l));
      const prev = r.mode === "range" ? undefined : rs.last;
      r.nits = lines.filter((l) => l.startsWith("[nit]"));
      r.items = Array.isArray(res.coverage) ? (res.coverage as ItemResult[]) : [];
      const gaps: string[] = [];
      if (f["--checks-failed"]) gaps.push("#checks");
      if (r.mode === "range") {
        // What the full review read, as code-review.ts builds it: the committed
        // range base..head, the uncommitted changes against HEAD, and the
        // untracked files. A changed path outside all three was never read.
        // A full review that ended before HEAD read none of the later commits'
        // versions, even of a file it read at an earlier version: refused whole.
        const head = r.head ?? "HEAD";
        const headNow = gitLine(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
        if (r.head && headNow !== null && r.head !== headNow) gaps.push("#head");
        const read = new Set([
          ...gitZ(repo, ["diff", "-z", "--no-renames", "--name-only", r.base || "HEAD", head]),
          ...gitZ(repo, ["diff", "-z", "--no-renames", "--name-only", "HEAD"]),
          ...gitZ(repo, ["ls-files", "-z", "--others", "--exclude-standard"]),
        ]);
        const base = branchBase(repo, r.base);
        for (const p of changedSince(repo, base)) if (!isRecord(p) && !read.has(p)) gaps.push(p);
      } else {
        if (!prev) gaps.push("#no-base");
        else {
          const delta = new Set(gitZ(repo, ["diff", "-z", "--no-renames", "--name-only", r.since ?? "", r.tree]));
          // A path in another repo (a companion, or the report beside a product) is
          // never in this repo's delta, so its change is always a gap.
          const rel = (abs: string): string => (abs.startsWith(`${repo}/`) ? abs.slice(repo.length + 1) : "\0");
          // A covered key is reviewed by this round when its file is in the
          // round's diff, or when it is a declared path whose item the reviewer
          // reported checked this round: an unchanged dependency newly declared,
          // or one that moved outside this repo, never enters the diff.
          const checked = new Set((r.items ?? []).filter((i) => i.status === "checked").map((i) => i.id));
          // The behavior contract is keyed by its absolute path; a declared
          // item naming the same file (in this repo, or another by "repo") is
          // its item too — the only way a spec beside a product can be reviewed.
          const byFile = new Map<string, string>();
          for (const [key, id] of Object.entries(r.itemKeys ?? {})) {
            const at = key.indexOf("::");
            byFile.set(at >= 0 ? join(key.slice(0, at), key.slice(at + 2)) : join(repo, key), id);
          }
          const reviewed = (k: string): boolean => {
            if (delta.has(k.startsWith("contract:") ? rel(k.slice("contract:".length)) : k)) return true;
            const id = k.startsWith("contract:")
              ? byFile.get(canonicalRepo(k.slice("contract:".length)))
              : r.itemKeys?.[k];
            return id !== undefined && checked.has(id);
          };
          for (const k of [...new Set([...Object.keys(r.covered), ...Object.keys(prev.covered)])].sort()) {
            if (r.covered[k] === prev.covered[k]) continue;
            if (!reviewed(k)) gaps.push(k);
          }
          if (r.block !== prev.block && !delta.has(rel(rs.report ?? ""))) gaps.push("#declaration");
          // What the earlier receipt left unreviewed stays unreviewed until a
          // round's delta actually carries it.
          for (const g of prev.gaps ?? []) {
            if (g === "#checks" || gaps.includes(g)) continue;
            if (g === "#declaration" ? delta.has(rel(rs.report ?? "")) : !g.startsWith("#") && reviewed(g)) continue;
            gaps.push(g);
          }
          // An earlier blocker stands until a round reviews a change to the file
          // it names (the round is shown it, and re-reports it if unfixed). A
          // blocker naming no file closes only on a round that changed something.
          for (const b of prev.blocking ?? []) {
            if (r.blocking.includes(b)) continue;
            const file = findingFile(b);
            if (file ? !delta.has(file) : delta.size === 0) r.blocking.push(b);
          }
        }
      }
      r.gaps = gaps;
      r.status = "complete";
      r.finishedAt = new Date().toISOString();
      const why = receiptReasons(
        r,
        { covered: r.covered, block: r.block, decl: null, problems: [], changed: [] },
        rs.scope,
      );
      r.approved = why.length === 0;
      try {
        writeState(owner, state);
      } catch (e) {
        warn(`implement-audit: could not record the review: ${(e as Error).message}`);
        say("APPROVED=0");
        exit(1);
      }
      for (const w of why) warn(`implement-audit: ${w}`);
      say(`APPROVED=${r.approved ? 1 : 0}`);
      return;
    }
    case "check": {
      const { f, rest } = flags(argv, ["--owner"]);
      const owner = f["--owner"] ?? "";
      if (owner === "" || rest.length === 0) usageExit("check needs --owner <id> and at least one worktree");
      const read = readState(owner);
      const corrupt = "corrupt" in read ? read.corrupt : null;
      const state = "state" in read ? read.state : null;
      const rows: { wt: string; changed: string[] | null; err?: string }[] = rest.map((wt) => {
        const repo = canonicalRepo(wt);
        try {
          const rs = state?.repos[repo];
          return { wt, changed: changedSince(wt, branchBase(wt, rs?.base ?? "")) };
        } catch (e) {
          return { wt, changed: null, err: (e as Error).message };
        }
      });
      // Implementation work in this thread: a registered audit, unreadable state,
      // or a report carrying a coverage block.
      const implementation =
        corrupt !== null ||
        rest.some((wt) => state?.repos[canonicalRepo(wt)]?.required) ||
        rows.some(
          (row) =>
            row.changed?.some((p) => {
              if (!/^projects\/.+\/specs\/[^/]+\/report\.md$/.test(p)) return false;
              try {
                return readFileSync(join(row.wt, p), "utf8")
                  .split("\n")
                  .some((l) => l.trim() === OPEN);
              } catch {
                return false;
              }
            }) ?? false,
        );
      const why: string[] = [];
      for (const row of rows) {
        const repo = canonicalRepo(row.wt);
        const rs = state?.repos[repo];
        if (row.changed === null) {
          why.push(`review: ${row.wt}: ${row.err}`);
          continue;
        }
        // Nothing but records differs from the trunk: there is no source left
        // to land unreviewed, whatever was registered (a landed branch, a retry).
        if (row.changed.every(isRecord)) continue;
        const wb = isWorkbench(row.wt);
        const src = row.changed.filter((p) => needsReview(p, wb));
        if (!rs?.required && !(implementation && src.length > 0)) continue;
        if (corrupt !== null) {
          why.push(`review: ${row.wt}: ${corrupt}`);
          continue;
        }
        if (!rs) {
          why.push(`review: ${row.wt}: no review receipt for implementation source (${src.slice(0, 5).join(", ")})`);
          continue;
        }
        let v: ReturnType<typeof validity>;
        try {
          v = validity(rs, coverageNow(row.wt, rs.base, rs.report), rs.scope);
        } catch (e) {
          v = { why: [(e as Error).message] };
        }
        if ("ok" in v) say(`review: ${row.wt}: receipt from ${byWhom(v.ok)} covers this content`);
        else for (const w of v.why) why.push(`review: ${row.wt}: ${w}`);
      }
      if (why.length > 0) {
        for (const w of why) warn(w);
        exit(1);
      }
      return;
    }
    default:
      usageExit(verb ? `unknown verb ${verb}` : "a verb is required");
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
