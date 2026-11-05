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
// PIECES. A change too large for one
// review call is reviewed in pieces: full reviews over one base and head, each
// reading a disjoint list of the changed files (`begin --slice <file>`). Each
// completed piece is kept in `slices` with the files its reviewed diff actually
// held; when the pieces together have read every changed file at its current
// content, `finish` combines them into one ordinary full-review receipt, read by
// every reader below like any other. A file that moved after the piece that
// read it is unread again; a declared item counts only from a piece that
// checked it and whose digests for it still hold; a different base, head,
// branch base, scope, writer set or declaration starts a new set. Every piece
// spends a round from the same allowance (code-review.ts).
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
//                         [--since <tree>] [--report <path>] [--head <sha>]
//                         [--slice <file>]
//       register the obligation, validate the declaration, and either print
//       `RECEIPT=reuse` (a valid receipt matches; no review is needed) or write
//       the attempt `incomplete` and print `RECEIPT=review` + `ITEMS_FILE=<path>`.
//       With --slice (mode range only), the attempt is one piece: its file lists
//       NUL-separated repo-relative paths, each changed since the branch base,
//       none a record, none read at its current content by an earlier piece of
//       the same set — else exit 2 before any state change.
//   audit-dedupe.ts finish --repo <dir> --rc <n> [--result <file>] [--checks-failed]
//       record the attempt's outcome; prints `APPROVED=0|1` and the reasons.
//       For a piece whose set is not complete it also prints
//       `SLICE_PENDING=<n>`, one `unread: <path>` line per changed file no
//       piece has read, one `unchecked: <id>` per declared item no piece has
//       checked yet, and `SLICE_BLOCKED=1` when a reason other than those
//       (a finding, a writer as reviewer, a later commit) already stands.
//       --rc 3 leaves the attempt open and pending the fresh-context fallback;
//       --rc 3 --checks-failed again on a pending attempt keeps that layers
//       1+2 failed over it, so the fallback that finishes it cannot approve.
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
  /**
   * Each declared item's covered keys. The reverse of itemKeys, which
   * keeps one item per path: claims that share an evidence file each keep it.
   */
  itemPaths?: Record<string, string[]>;
  authors: string;
  reviewer?: string;
  items?: ItemResult[];
  blocking?: string[];
  nits?: string[];
  gaps?: string[];
  approved?: boolean;
  trailer?: string;
  /** A piece: the paths its piece file listed. */
  slice?: string[];
  /** A piece: the listed paths its reviewed diff actually held. */
  read?: string[];
  /** A combined receipt: every answering reviewer, each held to the writer exclusion. */
  reviewers?: string[];
  /** A combined receipt: how many pieces it was made of. */
  pieces?: number;
  /** The chain left no independent vendor (code-review.ts exit 3): a fresh-context fallback may finish it. */
  pendingFallback?: boolean;
  /** Layers 1+2 failed in the phase that left it pending: the fallback that finishes it is checks-failed. */
  checksFailed?: boolean;
  /** false: the fresh-context fallback reviewed it — recorded, and reported, as NOT independent. */
  independent?: boolean;
}
/** What makes pieces one set: both ends of the reviewed range and what the review was bound to. */
export interface SliceSet {
  base: string;
  head: string;
  branchBase: string;
  scope: string;
  authors: string;
  block: string | null;
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
  /** The completed pieces of the set being reviewed; absent reads as no set. */
  slices?: Receipt[];
  sliceSet?: SliceSet;
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

/** Each declared item's covered keys, every item keeping every path it names. */
export function declaredItemPaths(decl: Declaration | null): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  if (!decl) return paths;
  for (const e of decl.entryPoints) paths[e.id] = [e.path];
  for (const d of decl.dependencies) paths[d.id] = [d.repo ? `${canonicalRepo(d.repo)}::${d.path}` : d.path];
  for (const c of decl.claims) paths[c.id] = [...(c.negativeTest?.evidence ?? [])];
  return paths;
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
 * In a workbench the instructions count too: AGENTS.md (and .agents/AGENTS.md,
 * which the root one links to), and the skills and
 * agents under .agents/ that tell a model what to do.
 */
export function needsReview(p: string, workbench: boolean): boolean {
  if (!workbench) return !isRecord(p) && !p.endsWith(".md");
  // The installer links AGENTS.md to .agents/AGENTS.md, so a change edits
  // the installed file: both spellings are the working agreement.
  if (p === "AGENTS.md" || p === ".agents/AGENTS.md") return true;
  // A project's own scripts run in layer-2 like an app's code, so they are
  // reviewed like it; the project's records stay records.
  if (/^projects\//.test(p) && /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|py)$/.test(p)) return true;
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
  /** HEAD when the coverage was read; absent where a caller builds one by hand. */
  head?: string | null;
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
  return { covered, block, decl, problems, changed, head: gitLine(repo, ["rev-parse", "--verify", "HEAD^{commit}"]) };
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
  "#pieces": "the rest of the change: this round built on one piece of an incomplete piece set",
};

/** The path-like token leading <text>, or null: the one rule for where a
 *  finding points, used by the REPEAT SPOT detector below. It decides no
 *  finding's closure: a blocker closes when a round that was shown it leaves it
 *  out (finish), never by the file it names. The token is the text up to the first
 *  whitespace, backtick or quote, an opening backtick or quote skipped and,
 *  when it closes on the line, read through to it (`dir/my file.ts:12`): with a
 *  `:<line>` it is whatever precedes the line (`Makefile:12`, `localhost:3000`);
 *  without one it is a path when it holds a `/` or ends in an extension and
 *  holds no colon, so prose (`Note:`) and `node:sqlite` lead with none; a
 *  colon inside a lined path is the path's (`src/x:y.tsx:160`). A markdown link
 *  (`[a.ts:9](/abs/a.ts:9)`) is read by its text.
 *  `loc` is the path with its line; `end` is where the token, with any
 *  closing backtick, quote or link target, ends in <text>. */
export function leadingPath(text: string): { path: string; loc: string; end: number } | null {
  const link = /^\[([^\]\s][^\]]*)\]\([^)\s]*\)/.exec(text);
  if (link) {
    const inner = leadingPath(link[1] ?? "");
    return inner ? { ...inner, end: link[0].length } : null;
  }
  const open = /^[`'"(]?/.exec(text)?.[0].length ?? 0;
  const t = text.slice(open);
  const shut = open > 0 ? (text[0] === "(" ? ")" : text[0]) : "";
  const close = (n: number): number => open + n + (shut !== "" && t[n] === shut ? 1 : 0);
  // A backticked or quoted location runs to its closing delimiter, a space in
  // the name included; one that does not close on the line is read bare.
  const quoted = shut !== "" && shut !== ")" ? t.indexOf(shut) : -1;
  const raw =
    quoted > 0 && !t.slice(0, quoted).includes("\n") ? t.slice(0, quoted) : (/^[^\s`'",;]+/.exec(t)?.[0] ?? "");
  // Trailing punctuation is not the path's: a sentence's `.` or `:`, and a `)`
  // that closes nothing the token opened (`app/(group)/page.tsx` keeps its own).
  let tok = raw;
  const opens = (x: string): number => x.split("(").length - x.split(")").length;
  while (/[.:]$/.test(tok) || (tok.endsWith(")") && opens(tok) < 0)) tok = tok.slice(0, -1);
  const lined = /^(.+?)(:\d+(?:[-:]\d+)*)$/.exec(tok);
  if (lined && /[A-Za-z._/]/.test(lined[1] ?? ""))
    return { path: lined[1] as string, loc: tok, end: close(tok.length) };
  if (tok !== "" && !tok.includes(":") && /[A-Za-z0-9]/.test(tok) && (tok.includes("/") || /\.[A-Za-z0-9]+$/.test(tok)))
    return { path: tok, loc: tok, end: close(tok.length) };
  return null;
}

// ── REPEAT SPOT ──
// A must-fix or should-fix within REPEAT_SPOT_LINES of one the last review left
// open, in the same file, means the fix did not close the defect, or its patch
// opened the next hole beside it: a handler patched through seven reviews drew
// a new finding a few lines from the last each time, and only replacing the
// patches with one design came back clean. The warning is a line for the build
// to read on stderr; it changes no receipt. code-review.ts prints it for a
// vendor's answer, and finish --fallback for the fresh-context fallback's.
const REPEAT_SPOT_LINES = 25;
// The spot is the finding's file and line, read by leadingPath: bare,
// backticked or a markdown link (`[f.ts:9](/abs/f.ts:9)`), a path holding a
// colon included. A regex of its own cut such a path at the colon.
function spotOf(finding: string): { file: string; line: number } | null {
  const t = finding.trim();
  const tag = /^\[(?:must-fix|should-fix)\]\s+/.exec(t);
  const lead = tag ? leadingPath(t.slice(tag[0].length)) : null;
  const line = lead ? /^:(\d+)/.exec(lead.loc.slice(lead.path.length)) : null;
  return lead && line ? { file: lead.path, line: Number(line[1]) } : null;
}
/** One REPEAT SPOT warning per finding in <findings> beside one of <open>, the findings the last review left open. */
export function repeatSpots(findings: string[], open: string[]): string[] {
  const earlier = open.flatMap((f) => spotOf(f) ?? []);
  const out: string[] = [];
  for (const f of findings) {
    const spot = spotOf(f);
    if (!spot) continue;
    const { file, line } = spot;
    const prev = earlier.find((e) => e.file === file && Math.abs(e.line - line) <= REPEAT_SPOT_LINES);
    if (prev)
      out.push(
        `[code-review] REPEAT SPOT: ${file}:${line} — the last review flagged ${file}:${prev.line} too. Stop patching this piece: redesign it as a whole, then review the redesign.`,
      );
  }
  return out;
}

/** The form two finding lines are compared in: runs of whitespace collapsed, ends trimmed. */
export function findingKey(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Why a receipt does not describe this content, or [] when it does. */
export function receiptReasons(r: Receipt | undefined, cov: Coverage, scope: string | null): string[] {
  if (!r) return ["no completed independent review"];
  if (r.status !== "complete") return ["the last review attempt did not complete"];
  const why: string[] = [];
  if (r.slice) why.push("one piece of a larger review, not a review of the whole change");
  const reviewers = r.reviewers ?? (r.reviewer ? [r.reviewer] : []);
  if (reviewers.length === 0) why.push("the review recorded no answering reviewer, so it is not a coverage receipt");
  for (const v of reviewers)
    if (authorVendors(r.authors).includes(v.split("/")[0] ?? "")) why.push(`the reviewer ${v} is one of the writers`);
  if ((r.blocking ?? []).length > 0) why.push(`${(r.blocking ?? []).length} must-fix/should-fix finding(s) unresolved`);
  for (const g of r.gaps ?? []) why.push(`not reviewed: ${GAP_WORDS[g] ?? g}`);
  const status = new Map((r.items ?? []).map((i) => [i.id, i]));
  for (const id of r.requiredItems) {
    const it = status.get(id);
    if (!it && r.pieces) why.push(`no piece checked ${id} at its current content`);
    else if (!it) why.push(`the reviewer reported nothing for ${id}`);
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

export interface PieceSet {
  /** Changed non-record paths no piece has read at their current content. */
  unread: string[];
  /** Required declared items no piece has checked at their current content. */
  unchecked: string[];
  /** Every other reason the set does not approve. */
  why: string[];
  /** The set as one full-review receipt, bound to the current content. */
  combined: Receipt;
}

/**
 * Pieces combined against the content as it is now. A changed path is read
 * when a piece's reviewed diff held it and that piece's digest of it is the
 * current one; a declared item is checked when a piece reported it checked and
 * that piece's digests of every path naming it are the current ones. Any other
 * covered key (the behavior contract, a declared path no checked item vouches
 * for) must not have moved under any piece.
 */
export function pieceSet(pieces: Receipt[], cov: Coverage, scope: string | null): PieceSet {
  const last = pieces[pieces.length - 1] as Receipt;
  const now = cov.covered;
  const unread = cov.changed.filter(
    (p) => !isRecord(p) && !pieces.some((pc) => (pc.read ?? []).includes(p) && pc.covered[p] === now[p]),
  );
  const keysOf = (pc: Receipt, id: string): string[] =>
    pc.itemPaths?.[id] ??
    Object.entries(pc.itemKeys ?? {})
      .filter(([, v]) => v === id)
      .map(([k]) => k);
  const ids = [...new Set(pieces.flatMap((pc) => (pc.items ?? []).map((i) => i.id)))];
  const items: ItemResult[] = [];
  const vouched = new Set<string>();
  for (const id of ids) {
    const pc = pieces.find(
      (x) =>
        (x.items ?? []).some((i) => i.id === id && i.status === "checked") &&
        keysOf(x, id).every((k) => x.covered[k] === now[k]),
    );
    const it = pc?.items?.find((i) => i.id === id);
    if (pc && it) {
      items.push(it);
      for (const k of keysOf(pc, id)) vouched.add(k);
    }
  }
  const changed = new Set(cov.changed);
  const gaps = new Set<string>(pieces.flatMap((pc) => (pc.gaps ?? []).filter((g) => g.startsWith("#"))));
  if (last.head && cov.head && last.head !== cov.head) gaps.add("#head");
  for (const k of Object.keys(now).sort()) {
    if (changed.has(k) || vouched.has(k)) continue;
    if (pieces.some((pc) => pc.covered[k] !== now[k])) gaps.add(k);
  }
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  const combined: Receipt = {
    status: "complete",
    mode: "range",
    bucket: "build",
    tree: last.tree,
    ...(last.head ? { head: last.head } : {}),
    base: last.base,
    scope: last.scope,
    startedAt: (pieces[0] as Receipt).startedAt,
    finishedAt: new Date().toISOString(),
    block: last.block,
    covered: { ...now },
    requiredItems: last.requiredItems,
    itemKeys: last.itemKeys,
    ...(last.itemPaths ? { itemPaths: last.itemPaths } : {}),
    authors: last.authors,
    reviewer: pieces.find((pc) => pc.reviewer)?.reviewer,
    reviewers: uniq(pieces.flatMap((pc) => (pc.reviewer ? [pc.reviewer] : []))),
    items,
    blocking: uniq(pieces.flatMap((pc) => pc.blocking ?? [])),
    nits: uniq(pieces.flatMap((pc) => pc.nits ?? [])),
    gaps: [...gaps],
    pieces: pieces.length,
    // One piece the fresh-context fallback reviewed makes the whole set NOT independent.
    ...(pieces.some((pc) => pc.independent === false) ? { independent: false } : {}),
  };
  const checked = new Set(items.filter((i) => i.status === "checked").map((i) => i.id));
  const unchecked = last.requiredItems.filter((id) => !checked.has(id));
  const why = receiptReasons({ ...combined, requiredItems: [] }, cov, scope);
  // Every piece answered by a reviewer, or the set is not a review: a piece
  // with none is never kept (finish), and this holds if one ever is.
  pieces.forEach((pc, i) => {
    if (!pc.reviewer) why.push(`piece ${i + 1} recorded no answering reviewer`);
  });
  return { unread, unchecked, why: [...cov.problems, ...why], combined };
}

/** A valid receipt among the latest attempt and the latest complete one, or the reasons neither is. */
export function validity(rs: RepoState, cov: Coverage, scope: string | null): { ok: Receipt } | { why: string[] } {
  if (cov.problems.length > 0) return { why: cov.problems };
  // A piece set still being reviewed: what the whole set lacks, never only
  // the latest piece's own reasons.
  if ((rs.slices ?? []).length > 0 && rs.receipt?.slice) {
    const set = pieceSet(rs.slices as Receipt[], cov, scope);
    const why = [...set.why, ...set.unchecked.map((id) => `no piece checked ${id} at its current content`)];
    if (rs.receipt.status !== "complete") why.unshift("the last review attempt did not complete");
    why.push(
      set.unread.length > 0
        ? `pieces pending: ${set.unread.length} changed file(s) unread by any piece: ${set.unread.join(", ")}`
        : "every changed file was read by a piece, but the set was never combined — a full review replaces it",
    );
    return { why };
  }
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

/** A piece file: NUL-separated repo-relative paths, deduplicated and sorted. */
export function readPieceFile(file: string): string[] | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return { error: `the piece file ${file} could not be read: ${(e as Error).message}` };
  }
  const paths = [...new Set(raw.split("\0").filter((p) => p !== ""))].sort();
  if (paths.length === 0) return { error: `the piece file ${file} names no path (paths are NUL-separated)` };
  for (const p of paths) {
    const parts = p.split("/");
    if (isAbsolute(p) || parts.includes("..") || parts.includes(".") || parts.includes(""))
      return { error: `the piece names ${JSON.stringify(p)}, which is not a repo-relative path inside the repo` };
  }
  return paths;
}
const SET_FIELDS: [keyof SliceSet, string][] = [
  ["base", "base"],
  ["head", "head"],
  ["branchBase", "branch base"],
  ["scope", "scope"],
  ["authors", "writers"],
  ["block", "declaration"],
];

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
const byWhom = (r: Receipt): string => {
  const who = (r.reviewers ?? [r.reviewer]).join(", ");
  return r.independent === false ? `${who} (claude-fallback: fresh context, NOT independent)` : who;
};
function summary(r: Receipt): string {
  return (
    r.trailer ??
    `implement-audit: receipt ${r.mode} review${r.pieces ? ` in ${r.pieces} pieces` : ""} by ${byWhom(r)} at ${r.finishedAt}; ${(r.nits ?? []).length} nit(s) held; APPROVE`
  );
}

/**
 * A numbered finding of the fallback reviewer's format (`N. **title**: `a.ts:12` —
 * nature — …`) with its location moved to the front (`a.ts:12: **title** — …`),
 * the shape a vendor's triage line has, so the REPEAT SPOT detector reads where
 * it points. Where it points decides nothing else: a blocker closes when a
 * round shown it leaves it out (finish). The location is what leadingPath reads
 * right after the title (its closing `**`, else the first `: ` or ` — `): the
 * first path-like token, backticked or bare, with or without a line. A line
 * with nothing path-like after its title is returned as it came.
 */
function fileFirst(l: string): string {
  const close = l.startsWith("**") ? l.indexOf("**", 2) : -1;
  const sep = /: | — /.exec(l);
  const end = close >= 0 ? close + 2 : sep ? sep.index + sep[0].length : 0;
  const at = end + (/^[\s:—]*/.exec(l.slice(end))?.[0].length ?? 0);
  const loc = leadingPath(l.slice(at));
  if (!loc) return l;
  const head = l.slice(0, at).replace(/[\s:—]+$/, "");
  const tail = l.slice(at + loc.end).replace(/^[\s:]+/, "");
  // A location holding a space keeps its backticks, so it is read whole again.
  const lead = /\s/.test(loc.loc) ? `\`${loc.loc}\`` : loc.loc;
  return `${lead}: ${tail === "" ? head : `${head} ${tail}`}`;
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
    // One answer per item: with two, the receipt's lookup keeps the last, and an
    // item the reviewer said it did not check could read as checked.
    const ids = new Set<string>();
    for (const c of v.coverage as { id: string }[]) {
      if (ids.has(c.id)) return { error: `the frame names coverage item ${c.id} more than once` };
      ids.add(c.id);
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
      if (m) findings.push(`${m[1] === "fix-now" ? "[must-fix]" : m[1]?.startsWith("deferred") ? "[should-fix]" : "[nit]"} ${fileFirst(l.replace(/^[0-9]+\.\s*/, ""))}`);
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
        "--slice",
      ]);
      for (const k of ["--repo", "--tree", "--mode", "--bucket"]) if (!f[k]) usageExit(`begin needs ${k}`);
      const mode = f["--mode"] as Mode;
      const bucket = f["--bucket"] as Bucket;
      if (!["range", "since", "final"].includes(mode)) usageExit(`unknown mode ${mode}`);
      if (!["build", "qa"].includes(bucket)) usageExit(`unknown bucket ${bucket}`);
      // A piece is one part of the build bucket's full review; refused here,
      // before anything is read or written, when its list cannot be one.
      let slice: string[] | null = null;
      if (f["--slice"] !== undefined) {
        if (mode !== "range" || bucket !== "build")
          usageExit("--slice is a piece of the build bucket's full review (--mode range --bucket build)");
        const got = readPieceFile(f["--slice"] as string);
        if ("error" in got) usageExit(got.error);
        slice = got;
      }
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
      const authors = normaliseAuthors(
        process.env.POLICY_CHAIN_AUTHOR_VENDORS ?? "",
        process.env.POLICY_CHAIN_AUTHOR_THREAD_ID ?? "",
      );
      // The set this attempt belongs to. Earlier pieces count only toward the
      // same set; a different set, or a full review, which reads everything,
      // replaces them. Their spending stays spent.
      const headCommit =
        mode === "range" ? (gitLine(repo, ["rev-parse", "--verify", `${f["--head"] ?? "HEAD"}^{commit}`]) ?? "") : "";
      let sliceSet: SliceSet | null = null;
      if (slice) {
        sliceSet = {
          base: gitLine(repo, ["rev-parse", "--verify", `${rs.base || "HEAD"}^{commit}`]) ?? rs.base,
          head: headCommit || (f["--head"] ?? "HEAD"),
          branchBase: branchBase(repo, cov.decl?.base ?? rs.base),
          scope: rs.scope,
          authors,
          block: cov.block,
        };
        const kept = rs.slices ?? [];
        const was = rs.sliceSet;
        const differs = was ? SET_FIELDS.find(([k]) => was[k] !== (sliceSet as SliceSet)[k]) : undefined;
        if (kept.length > 0 && (was === undefined || differs)) {
          warn(
            `implement-audit: ${kept.length} earlier piece(s) no longer count: the ${differs?.[1] ?? "set"} differs — this piece starts a new set`,
          );
          rs.slices = [];
        }
        // Refused before any reviewer call, and before anything is written.
        const changed = new Set(cov.changed);
        const refuse = (why: string): never => {
          warn(`implement-audit: ${why} — no review call was made`);
          return exit(2);
        };
        for (const pth of slice) {
          if (isRecord(pth))
            refuse(`the piece names ${pth}, a record (journal, knowledge, decisions, project Markdown)`);
          if (!changed.has(pth)) refuse(`the piece names a path not changed since the branch base: ${pth}`);
          const n = (rs.slices ?? []).findIndex(
            (pc) => (pc.read ?? []).includes(pth) && pc.covered[pth] === cov.covered[pth],
          );
          if (n >= 0) refuse(`piece ${n + 1} already read ${pth} at its current content`);
        }
      } else if (mode === "range" && (rs.slices ?? []).length > 0) {
        warn(
          `implement-audit: ${(rs.slices ?? []).length} earlier piece(s) no longer count: a full review reads the whole change`,
        );
        rs.slices = [];
        rs.sliceSet = undefined;
      }
      const v = validity(rs, cov, rs.scope);
      if ("ok" in v && v.ok.authors === authors) {
        writeState(owner, state);
        say("RECEIPT=reuse");
        say(
          `NOTE: the ${v.ok.mode} review by ${byWhom(v.ok)} (${v.ok.finishedAt}) still covers this content — no review call`,
        );
        return;
      }
      if (rs.receipt?.status === "complete") rs.last = rs.receipt;
      if (sliceSet) rs.sliceSet = sliceSet;
      const items = declarationItems(cov.decl);
      rs.receipt = {
        status: "incomplete",
        mode,
        bucket,
        tree: f["--tree"] as string,
        ...(f["--since"] ? { since: f["--since"] } : {}),
        ...(mode === "range" && f["--head"] ? { head: headCommit || f["--head"] } : {}),
        ...(slice ? { slice } : {}),
        base: rs.base,
        scope: rs.scope,
        startedAt: now,
        block: cov.block,
        covered: cov.covered,
        requiredItems: items.filter((i) => i.required).map((i) => i.id),
        itemKeys: declaredKeys(cov.decl),
        itemPaths: declaredItemPaths(cov.decl),
        authors,
      };
      const itemsFile = join(ownerDir(owner), `review-items-${sha256(repo).slice(0, 12)}.json`);
      try {
        writeState(owner, state);
        // A follow-up is shown the findings still open, so a fix that does not
        // close one is re-reported rather than taken as settled, and one the
        // round leaves out is closed (finish).
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
        // The phase's layers failed after the chain left it pending: the
        // fallback, a later invocation that runs no layer, must not forget it.
        if (f["--checks-failed"]) r.checksFailed = true;
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
      let res: { vendor?: unknown; findings?: unknown; coverage?: unknown; shown?: unknown };
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
        // The fallback reviewer was handed the items file, whose openFindings
        // are what begin wrote for this round (none for a full review): those
        // are what it was shown, and what a repeat spot is measured against.
        const handed = r.mode === "range" ? [] : (rs.last?.blocking ?? []);
        for (const line of repeatSpots(parsed.findings, handed)) warn(line);
        res = { vendor: "fresh-context/claude-fallback", ...parsed, shown: handed };
        r.independent = false;
        delete r.pendingFallback;
        // The chain's exit 3 charged nothing, as code-review.ts charges a first
        // full review only when it completes: this completion is that review,
        // so it is spent here, and a repeated full review counts as a round.
        if (r.mode === "range") {
          const bucket: Bucket = process.env.CODE_REVIEW_BUCKET === "qa" ? "qa" : "build";
          const spent = readSpend(repo, bucket);
          if (spent !== null && !("unknown" in spent) && !spent.full) writeSpend(repo, bucket, { ...spent, full: true });
        }
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
      // The open findings the round was shown: what a vendor's prompt listed
      // (code-review.ts writes them), or what the fallback was handed; anything
      // else is a round shown nothing.
      const shownList =
        Array.isArray(res.shown) && res.shown.every((x) => typeof x === "string") ? (res.shown as string[]) : [];
      r.reviewer = typeof res.vendor === "string" && res.vendor.trim() !== "" ? res.vendor : undefined;
      if (r.slice && !r.reviewer) {
        // A piece is kept only as a completed review; with no answering
        // reviewer it read nothing, and the attempt stays incomplete.
        warn("implement-audit: the piece's result names no answering reviewer — not kept, nothing counted as read");
        say("APPROVED=0");
        return;
      }
      r.blocking = lines.filter((l) => /^\[(?:must-fix|should-fix)\]/.test(l));
      const prev = r.mode === "range" ? undefined : rs.last;
      r.nits = lines.filter((l) => l.startsWith("[nit]"));
      r.items = Array.isArray(res.coverage) ? (res.coverage as ItemResult[]) : [];
      const gaps: string[] = [];
      if (f["--checks-failed"] || r.checksFailed) gaps.push("#checks");
      delete r.checksFailed;
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
        if (r.slice) {
          // A piece read only the listed paths its reviewed diff held; what
          // the other pieces read is judged when the set is combined below.
          r.read = (r.slice ?? []).filter((p) => read.has(p));
        } else {
          const base = branchBase(repo, r.base);
          for (const p of changedSince(repo, base)) if (!isRecord(p) && !read.has(p)) gaps.push(p);
        }
      } else {
        if (!prev) gaps.push("#no-base");
        else if (prev.slice) gaps.push("#pieces");
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
          // An earlier blocker stands until a round that was shown it completes
          // without re-raising it. The follow-up prompt lists every open
          // blocker and says one it does not re-report is recorded as closed,
          // and the result names what that prompt listed, so a fix in any file
          // can close it. Re-raised is the same line by findingKey; a re-raised
          // blocker is kept once. A blocker the round was not shown — a result
          // that lists other findings or none — stands. Closing a blocker only
          // when the file it seemed to name changed kept a fix in a neighbouring
          // file from ever closing it, and guessing that file from free text
          // went wrong one new way per review (a later citation, a space or
          // colon in the name, an extensionless or unknown file).
          const shown = new Set(shownList.map(findingKey));
          const open = new Set(r.blocking.map(findingKey));
          for (const b of prev.blocking ?? []) {
            const k = findingKey(b);
            if (open.has(k) || shown.has(k)) continue;
            r.blocking.push(b);
            open.add(k);
          }
          // The base this round builds on was read by the fresh-context
          // fallback: what the round inherits is NOT independent, as one such
          // piece makes a whole piece set (pieceSet).
          if (prev.independent === false) r.independent = false;
        }
      }
      r.gaps = gaps;
      r.status = "complete";
      r.finishedAt = new Date().toISOString();
      let why = receiptReasons(
        r,
        { covered: r.covered, block: r.block, decl: null, problems: [], changed: [] },
        rs.scope,
      );
      let pending: PieceSet | null = null;
      if (r.slice) {
        // Combine the set against the content as it is now. Nothing is
        // written until the end, so a failure here leaves the set as it was.
        let cov: Coverage;
        try {
          cov = coverageNow(repo, rs.base, rs.report);
        } catch (e) {
          warn(`implement-audit: ${(e as Error).message} — the piece cannot be bound to its content`);
          say("APPROVED=0");
          exit(1);
        }
        const pieces = [...(rs.slices ?? []), r];
        const set = pieceSet(pieces, cov, rs.scope);
        if (set.unread.length === 0) {
          rs.receipt = set.combined;
          rs.slices = undefined;
          rs.sliceSet = undefined;
          why = receiptReasons(set.combined, cov, rs.scope);
        } else {
          rs.slices = pieces;
          pending = set;
          why = set.why;
        }
      }
      const done = rs.receipt as Receipt;
      done.approved = why.length === 0 && pending === null;
      try {
        writeState(owner, state);
      } catch (e) {
        warn(`implement-audit: could not record the review: ${(e as Error).message}`);
        say("APPROVED=0");
        exit(1);
      }
      for (const w of why) warn(`implement-audit: ${w}`);
      say(`APPROVED=${done.approved ? 1 : 0}`);
      if (pending) {
        // Not a failure: the next piece reads these. Anything else that already
        // stands is SLICE_BLOCKED, so a caller can tell a set still being read
        // from one that will not approve once it is.
        say(`SLICE_PENDING=${pending.unread.length}`);
        if (pending.why.length > 0) say("SLICE_BLOCKED=1");
        // One line per path: a name holding a control character or a quote is
        // printed as a JSON string, so a newline in it cannot split the line.
        for (const u of pending.unread) say(`unread: ${/[\u0000-\u001f"\\]/.test(u) ? JSON.stringify(u) : u}`);
        for (const id of pending.unchecked) say(`unchecked: ${id}`);
      }
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
