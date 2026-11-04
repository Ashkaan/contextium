#!/usr/bin/env -S node --experimental-strip-types
// await-push-checks.ts — has everything GitHub reports on a pushed commit
// finished, and did all of it pass?
//
// WHY. A close that waits for a push's deploy only where it knows the kind of
// deploy — one workflow here, one hosting provider's build there — calls
// everything else "nothing to wait for", and a site whose build failed closes
// green. But nearly every deploy reports to GitHub on the pushed commit:
// GitHub Actions and hosted builds (Cloudflare Pages and Workers Builds,
// Vercel, Netlify) as check runs, a deployer of your own as a commit status.
// So this waits on all of it, through one reader, and a check that is not a
// deploy (CI) is judged the same: the close is done only when nothing the push
// started is still running or has failed.
//
// READS, through `gh api` (the host's login; no token is read here):
//   repos/<repo>/commits/<sha>/check-runs and /status, every page of each
//   repos/<repo>/commits/<sha>            a first parent, for the empty case
//   repos/<repo>/actions/runs, contents   which workflows an ancestor ran, and
//                                         whether each filters pushes by path
//   repos/<repo>, commits/<branch>, compare   the trunk tip, for a cancel
//
// EXIT
//   0  every check finished `success`, `neutral` or `skipped` (a status
//      `success`), and nothing new appeared for --quiet seconds
//   1  a failure, anything still running at --finish-timeout, an answer that
//      could not be read, or an empty commit where a deploy was expected
//   2  usage
//   3  nothing reported within --first-seen-timeout, where nothing was expected
// Each finished check prints `<name>: <conclusion> (<url>)` on stdout as it
// finishes; on exit 1 or 3 the last line says why.
//
// RULES THAT ARE NOT OBVIOUS
//   - A verdict needs a fresh, complete, schema-checked read of BOTH endpoints.
//     A failed read keeps what was seen and is never "nothing there".
//   - A check run is its app and name, a status its context; the highest id
//     of each decides, so a re-run replaces the attempt that failed.
//   - The quiet interval restarts whenever a check appears, finishes or is
//     re-run: a second workflow queued after the first finished is waited for.
//   - Every check a verdict counts must be in the newest read; one that drops
//     out is never passed on an older reading.
//   - A STATUS THE LAST MARKED PUSH CARRIED IS OWED, and so is a check run
//     the nearest reporting ancestor got from an app other than Actions. Walking first parents
//     (up to ANCESTORS back — a fast-forward pushes commits that were never a
//     trunk tip), each commit status context on the nearest ancestor that
//     carried any must appear here too, since a status comes after the thing
//     it marks (a deployer can mark a build minutes after it finishes). A
//     deployer may mark only the newest build, so a later trunk commit
//     containing this one, with checks of its own, settles it — and owes the
//     marks this one was owed.
//   - AN EMPTY COMMIT. A repo that reports nothing must stay closable, but a
//     deploy trigger that broke must not pass. So the nearest ancestor that
//     reported anything decides:
//     a check run from an app other than Actions, or an Actions workflow this
//     push would start — no path filter, or one a changed file passes (a
//     build that skips docs) — means one was expected here. A filter this
//     cannot read expects one. A status alone expects nothing: it marks a
//     build, it does not start one.
//   - A CANCEL OR AN ERRORED MARK. A newer push cancels an older run still
//     building (a workflow's concurrency group), and a status in state
//     `error` is a marker that could not judge (a deployer's "internal
//     error"), which it may never re-mark once a newer build is live. When those are the only problems and the trunk tip contains this
//     commit, the tip's checks decide, since its deploy carries this commit
//     too; re-polling would refuse forever. A `failure` is a verdict and is
//     never settled this way.
//
// Caller: .agents/skills/close/scripts/land.ts (`pollDeploy`), the only one.
// Test: await-push-checks.test.ts, the program against a fake GitHub.

import { execFile } from "node:child_process";
import process from "node:process";

const PASS = new Set(["success", "neutral", "skipped"]);
const PER_PAGE = 100;
const MAX_PAGES = 20;
const ANCESTORS = 10;
const SETTLE_TRIES = 3;
const ACTIONS = "github-actions";

interface Opts {
  repo: string;
  sha: string;
  firstSeenSec: number;
  finishSec: number;
  quietSec: number;
  intervalSec: number;
}

/** One check run or status, as the newest read of it. `app` is "" for a status. */
interface Check {
  key: string;
  name: string;
  app: string;
  id: number;
  done: boolean;
  outcome: string;
  url: string;
}

type Read<T> = { ok: true; value: T } | { ok: false; why: string; missing?: boolean };

function usage(msg: string): never {
  process.stderr.write(
    `await-push-checks: ${msg}\nusage: await-push-checks.ts --repo <owner/name> --sha <sha> [--first-seen-timeout s] [--finish-timeout s] [--quiet s] [--interval s]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    repo: "",
    sha: "",
    firstSeenSec: 120,
    finishSec: 1800,
    quietSec: 60,
    intervalSec: 10,
  };
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || v === "" || !Number.isFinite(n) || n < 0) usage(`${flag} needs a number of seconds`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repo = argv[++i] ?? "";
    else if (a === "--sha") o.sha = argv[++i] ?? "";
    else if (a === "--first-seen-timeout") o.firstSeenSec = num(a, argv[++i]);
    else if (a === "--finish-timeout") o.finishSec = num(a, argv[++i]);
    else if (a === "--quiet") o.quietSec = num(a, argv[++i]);
    else if (a === "--interval") o.intervalSec = num(a, argv[++i]);
    else usage(`unknown argument: ${a}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) usage("--repo <owner/name> required");
  if (!/^[0-9a-f]{7,40}$/.test(o.sha)) usage("--sha <commit sha> required");
  return o;
}

function gh(path: string): Promise<Read<unknown>> {
  return new Promise((resolve) => {
    // This harness sets FORCE_COLOR and CLICOLOR_FORCE. gh then wraps the JSON
    // in ANSI, and JSON.parse reports "not JSON" for a commit whose checks passed.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CLICOLOR: "0", GH_FORCE_TTY: "0" };
    delete env.FORCE_COLOR;
    delete env.CLICOLOR_FORCE;
    execFile("gh", ["api", path], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        const detail = (String(stderr).trim() || err.message).split("\n")[0] ?? "";
        return resolve({ ok: false, why: `${path}: ${detail.slice(0, 200)}`, missing: /HTTP 404/.test(detail) });
      }
      try {
        resolve({ ok: true, value: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, why: `${path}: not JSON` });
      }
    });
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const short = (sha: string): string => sha.slice(0, 7);

function checkRun(v: unknown): Check | null {
  if (!isObj(v) || typeof v.id !== "number" || !str(v.name) || !str(v.status)) return null;
  if (!isObj(v.app) || !str(v.app.slug)) return null;
  const done = v.status === "completed";
  if (done && !str(v.conclusion)) return null;
  const url = str(v.html_url) ? v.html_url : str(v.details_url) ? v.details_url : "";
  return {
    key: `run ${v.app.slug} ${v.name}`,
    name: v.name,
    app: v.app.slug,
    id: v.id,
    done,
    outcome: done ? String(v.conclusion) : v.status,
    url,
  };
}

function commitStatus(v: unknown): Check | null {
  if (!isObj(v) || typeof v.id !== "number" || !str(v.context)) return null;
  if (!["success", "failure", "error", "pending"].includes(String(v.state))) return null;
  if (v.target_url !== null && v.target_url !== undefined && typeof v.target_url !== "string") return null;
  return {
    key: `status ${v.context}`,
    name: v.context,
    app: "",
    id: v.id,
    done: v.state !== "pending",
    outcome: String(v.state),
    url: typeof v.target_url === "string" ? v.target_url : "",
  };
}

/** Every page of one list endpoint. A page that is missing, malformed or short
 *  of `total_count` fails the whole read: a partial list is never the list. */
async function readList(path: string, listKey: string, parse: (v: unknown) => Check | null): Promise<Read<Check[]>> {
  const out: Check[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh(`${path}?per_page=${PER_PAGE}&page=${page}`);
    if (!r.ok) return r;
    const body = r.value;
    if (!isObj(body) || typeof body.total_count !== "number" || !Array.isArray(body[listKey])) {
      return { ok: false, why: `${path}: malformed answer on page ${page}` };
    }
    const items = body[listKey] as unknown[];
    for (const item of items) {
      const c = parse(item);
      if (c === null) return { ok: false, why: `${path}: malformed ${listKey} entry on page ${page}` };
      out.push(c);
    }
    if (out.length >= body.total_count) return { ok: true, value: out };
    if (items.length === 0) {
      return { ok: false, why: `${path}: page ${page} empty with ${out.length} of ${body.total_count} read` };
    }
  }
  return { ok: false, why: `${path}: more than ${MAX_PAGES} pages` };
}

/** Both endpoints for one commit, or a failed read if either failed. */
async function readCommit(repo: string, sha: string): Promise<Read<Check[]>> {
  const [runs, statuses] = await Promise.all([
    readList(`repos/${repo}/commits/${sha}/check-runs`, "check_runs", checkRun),
    readList(`repos/${repo}/commits/${sha}/status`, "statuses", commitStatus),
  ]);
  if (!runs.ok) return runs;
  if (!statuses.ok) return statuses;
  return { ok: true, value: [...runs.value, ...statuses.value] };
}

/** A check's name as printed: its app or "status" added only when two share it. */
function label(c: Check, all: Iterable<Check>): string {
  for (const o of all) if (o.key !== c.key && o.name === c.name) return `${c.name} [${c.app || "status"}]`;
  return c.name;
}

const passed = (c: Check): boolean => c.done && (c.app === "" ? c.outcome === "success" : PASS.has(c.outcome));

/** `sha`/`checks`: the nearest ancestor that reported anything, or null.
 *  `marks`: the statuses of the nearest that carried any, which can be
 *  further back — a superseded build's commit has checks but no mark.
 *  `deployRuns`: likewise the check runs from apps other than Actions of the
 *  nearest that carried any — a lint-only parent must not hide them. */
type Near = { sha: string; checks: Check[]; marks: Check[]; deployRuns: Check[] } | null;

/** Walk first parents of <sha>, up to ANCESTORS back, for the Near. */
async function nearestReporting(repo: string, sha: string): Promise<Read<Near>> {
  let cur = sha;
  let found: { sha: string; checks: Check[] } | null = null;
  let marks: Check[] | null = null;
  let deployRuns: Check[] | null = null;
  for (let i = 0; i < ANCESTORS; i++) {
    const c = await gh(`repos/${repo}/commits/${cur}`);
    if (!c.ok) return c;
    const parents = isObj(c.value) ? c.value.parents : undefined;
    if (!Array.isArray(parents)) return { ok: false, why: `repos/${repo}/commits/${cur}: malformed answer` };
    if (parents.length === 0) break;
    const parent = isObj(parents[0]) ? parents[0].sha : undefined;
    if (!str(parent)) return { ok: false, why: `repos/${repo}/commits/${cur}: malformed parent` };
    const checks = await readCommit(repo, parent);
    if (!checks.ok) return checks;
    if (found === null && checks.value.length > 0) found = { sha: parent, checks: checks.value };
    const m = checks.value.filter((x) => x.app === "");
    if (marks === null && m.length > 0) marks = m;
    const d = checks.value.filter((x) => x.app !== "" && x.app !== ACTIONS);
    if (deployRuns === null && d.length > 0) deployRuns = d;
    if (found !== null && marks !== null && deployRuns !== null)
      return { ok: true, value: { ...found, marks, deployRuns } };
    cur = parent;
  }
  return {
    ok: true,
    value: found === null ? null : { ...found, marks: marks ?? [], deployRuns: deployRuns ?? [] },
  };
}

/** Why a deploy was expected of an empty <sha>, or null when nothing was. */
async function expectation(repo: string, sha: string, near: Near): Promise<Read<string | null>> {
  if (near === null) return { ok: true, value: null };
  const app = near.checks.find((x) => x.app !== "" && x.app !== ACTIONS);
  if (app) return { ok: true, value: `${short(near.sha)} reported ${app.name}` };
  // A deploy app's run further back, past a lint-only parent, is expected too
  // (Contextium v9.2.0 review).
  const earlier = near.deployRuns[0];
  if (earlier) return { ok: true, value: `an earlier push reported ${earlier.name}` };
  if (!near.checks.some((x) => x.app === ACTIONS)) return { ok: true, value: null };
  return pushWorkflowExpected(repo, near.sha, sha);
}

type Filter = { kind: "none" } | { kind: "paths" | "ignore"; patterns: RegExp[] } | { kind: "unknown" };

/** A workflow's `push:` path filter, read from its text. Anything this cannot
 *  read for certain — a negation, a bracket or brace glob, a list it cannot
 *  parse — is "unknown", which expects a run rather than excusing one. */
/** A YAML flow list's items, a quoted one's commas kept; null when a quote
 *  is left open. */
function flowItems(body: string): string[] | null {
  const items: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of body) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (quote !== "") return null;
  items.push(cur.trim());
  return items;
}

function pushFilter(yml: string): Filter {
  const lines = yml.split("\n");
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const at = lines.findIndex((l) => /^\s*push:\s*(#.*)?$/.test(l));
  if (at < 0) return { kind: "none" };
  const block: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    if (indentOf(l) <= indentOf(lines[at] ?? "")) break;
    block.push(l);
  }
  const k = block.findIndex((l) => /^\s*paths(-ignore)?\s*:/.test(l));
  if (k < 0) return { kind: "none" };
  const m = (block[k] ?? "").match(/^(\s*)(paths(?:-ignore)?)\s*:\s*(.*?)\s*(#.*)?$/);
  if (!m) return { kind: "unknown" };
  const rest = m[3] ?? "";
  let items: string[];
  if (rest.startsWith("[") && rest.endsWith("]")) {
    const flow = flowItems(rest.slice(1, -1));
    if (flow === null) return { kind: "unknown" };
    items = flow;
  } else if (rest === "") {
    items = [];
    for (const l of block.slice(k + 1)) {
      if (indentOf(l) <= (m[1] ?? "").length) break;
      const item = l.match(/^\s*-\s*(.*?)\s*(#.*)?$/);
      if (!item) return { kind: "unknown" };
      items.push(item[1] ?? "");
    }
  } else {
    return { kind: "unknown" };
  }
  const patterns = items.map((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2"));
  if (patterns.length === 0 || patterns.some((p) => p === "" || /[!\[\]{}\\]/.test(p))) return { kind: "unknown" };
  const res = patterns.map(globRegex);
  if (res.some((r) => r === null)) return { kind: "unknown" };
  return { kind: m[2] === "paths" ? "paths" : "ignore", patterns: res as RegExp[] };
}

// GitHub's filter glob (docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax,
// "Filter pattern cheat sheet"): a double star crosses `/`,
// and a double star then `/` also matches no folder at all; `*` stops at `/`;
// `?` and `+` are zero-or-one and one-or-more of the character before. Null
// for a `?` or `+` that does not follow a plain character, which the sheet
// leaves undefined.
function globRegex(pattern: string): RegExp | null {
  let re = "";
  let afterLiteral = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "?" || ch === "+") {
      if (!afterLiteral) return null;
      re += ch;
      afterLiteral = false;
      continue;
    }
    afterLiteral = false;
    if (pattern.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i++;
    } else if (ch === "*") {
      re += "[^/]*";
    } else {
      re += ch.replace(/[.^$|()]/g, "\\$&");
      afterLiteral = ch !== "/";
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether <filter> starts its workflow for a push changing <files>. */
function starts(filter: { kind: "paths" | "ignore"; patterns: RegExp[] }, files: string[]): string | null {
  const hit = (f: string) => filter.patterns.some((p) => p.test(f));
  const f = filter.kind === "paths" ? files.find(hit) : files.find((x) => !hit(x));
  return f ?? null;
}

/** The workflows <ancestor>'s push ran, read at <sha>: the first that this
 *  push would start too — no path filter, or a filter a changed file passes —
 *  is why a run was expected. */
async function pushWorkflowExpected(repo: string, ancestor: string, sha: string): Promise<Read<string | null>> {
  const r = await gh(`repos/${repo}/actions/runs?head_sha=${ancestor}&per_page=100`);
  if (!r.ok) return r;
  const runs = isObj(r.value) ? r.value.workflow_runs : undefined;
  if (!Array.isArray(runs)) return { ok: false, why: `repos/${repo}/actions/runs: malformed answer` };
  const paths = new Set<string>();
  for (const run of runs) {
    if (!isObj(run) || !str(run.path)) return { ok: false, why: `repos/${repo}/actions/runs: malformed run` };
    if (run.event === "push") paths.add(run.path.replace(/@.*$/, ""));
  }
  let files: string[] | null = null;
  for (const path of paths) {
    const f = await gh(`repos/${repo}/contents/${path}?ref=${sha}`);
    if (!f.ok && f.missing) continue;
    if (!f.ok) return f;
    if (!isObj(f.value) || typeof f.value.content !== "string") {
      return { ok: false, why: `repos/${repo}/contents/${path}: malformed answer` };
    }
    const filter = pushFilter(Buffer.from(f.value.content, "base64").toString("utf8"));
    const ran = `${short(ancestor)} ran ${path}`;
    if (filter.kind === "none") return { ok: true, value: `${ran}, which runs on every push` };
    if (filter.kind === "unknown") return { ok: true, value: `${ran}, whose path filter this cannot read` };
    if (files === null) {
      const c = await changedFiles(repo, ancestor, sha);
      if (!c.ok) return c;
      if (c.value === null) return { ok: true, value: `${ran}, and this push changed too many files to tell` };
      files = c.value;
    }
    const by = starts(filter, files);
    if (by !== null) return { ok: true, value: `${ran}, which this push's ${by} starts` };
  }
  return { ok: true, value: null };
}

/** The files changed from <base> to <head> (a rename's old name too), or null
 *  when GitHub's list may be cut short, which cannot excuse a run. A push that
 *  changes no file starts no filtered workflow (the same page). */
async function changedFiles(repo: string, base: string, head: string): Promise<Read<string[] | null>> {
  const r = await gh(`repos/${repo}/compare/${base}...${head}`);
  if (!r.ok) return r;
  const list = isObj(r.value) ? r.value.files : undefined;
  if (!Array.isArray(list)) return { ok: false, why: `repos/${repo}/compare: malformed answer` };
  const files: string[] = [];
  for (const f of list) {
    if (!isObj(f) || !str(f.filename)) return { ok: false, why: `repos/${repo}/compare: malformed file` };
    files.push(f.filename);
    if (str(f.previous_filename)) files.push(f.previous_filename);
  }
  return { ok: true, value: list.length >= 300 ? null : files };
}

/** The trunk tip when it contains <sha>, is not it, and reported checks of
 *  its own; else null. */
async function laterTip(repo: string, sha: string): Promise<string | null> {
  const meta = await gh(`repos/${repo}`);
  const branch = meta.ok && isObj(meta.value) ? meta.value.default_branch : undefined;
  if (!str(branch)) return null;
  const tip = await gh(`repos/${repo}/commits/${branch}`);
  const tipSha = tip.ok && isObj(tip.value) ? tip.value.sha : undefined;
  if (!str(tipSha) || tipSha.startsWith(sha) || sha.startsWith(tipSha)) return null;
  const cmp = await gh(`repos/${repo}/compare/${sha}...${tipSha}`);
  const status = cmp.ok && isObj(cmp.value) ? cmp.value.status : undefined;
  if (status !== "ahead") return null;
  // A tip that reported nothing (a docs-only push) carries no deploy of its
  // own to settle anything by.
  const own = await readCommit(repo, tipSha);
  return own.ok && own.value.length > 0 ? tipSha : null;
}

type Watch =
  | { kind: "pass" }
  | { kind: "fail"; line: string; supersedable: boolean; owed?: Check[] }
  | { kind: "later"; tip: string; line: string; owed: Check[] }
  | { kind: "empty"; line: string; code: 1 | 3 };

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

/** <owed> is what an abandoned commit was still owed. The later commit that
 *  carries its deploy owes those marks too: its own walk starts a commit
 *  further back, and can end before the ancestor that carried them. */
async function watch(o: Opts, sha: string, say: (line: string) => void, owed: Check[]): Promise<Watch> {
  const start = Date.now();
  const elapsed = (): number => (Date.now() - start) / 1000;
  const seen = new Map<string, Check>();
  const printed = new Set<string>();
  let lastChange = start;
  let everRead = false;
  let near: Near | undefined;
  let tipAskedAt = 0;
  let fresh = new Set<string>();
  for (;;) {
    const r = await readCommit(o.repo, sha);
    let why = "";
    let missing: Check[] = [];
    if (r.ok) {
      everRead = true;
      fresh = new Set(r.value.map((c) => `${c.key}\t${c.id}`));
      for (const c of r.value) {
        const prev = seen.get(c.key);
        if (prev !== undefined && c.id < prev.id) continue;
        if (prev === undefined || prev.id !== c.id || prev.done !== c.done) lastChange = Date.now();
        seen.set(c.key, c);
      }
      for (const c of seen.values()) {
        const id = `${c.key}\t${c.id}`;
        if (!c.done || printed.has(id)) continue;
        printed.add(id);
        say(`${label(c, seen.values())}: ${c.outcome}${c.url ? ` (${c.url})` : ""}`);
      }
      const all = [...seen.values()];
      if (near === undefined && (all.length > 0 || elapsed() >= o.firstSeenSec)) {
        // The walk takes a while: read the commit again before any verdict,
        // so nothing that appeared meanwhile is missed.
        const n = await nearestReporting(o.repo, sha);
        if (n.ok) {
          near = n.value;
          continue;
        }
        why = n.why;
      }
      // A status the nearest marked ancestor carried is owed here too: a
      // deployer can mark a build minutes after it finishes. So is a check run
      // the nearest reporting ancestor got from an app other than Actions: a
      // hosted deploy (Cloudflare Pages) runs on every push, as the empty-commit
      // rule below already assumes, so lint passing alone must not hide a deploy
      // trigger that broke.
      if (near !== undefined && all.length > 0) {
        const want = new Map([...(near?.marks ?? []), ...(near?.deployRuns ?? []), ...owed].map((c) => [c.key, c]));
        missing = [...want.values()].filter((c) => !seen.has(c.key));
      }
      const settled =
        !why &&
        all.length > 0 &&
        all.every((c) => c.done && fresh.has(`${c.key}\t${c.id}`)) &&
        (Date.now() - lastChange) / 1000 >= o.quietSec;
      if (settled) {
        const bad = all.filter((c) => !passed(c));
        if (bad.length > 0) {
          return {
            kind: "fail",
            line: bad.map((c) => `${label(c, all)} ${c.outcome}`).join("; "),
            // A cancelled run, or a mark that errored rather than judged.
            supersedable: bad.every(
              (c) => (c.app !== "" && c.outcome === "cancelled") || (c.app === "" && c.outcome === "error"),
            ),
            // A mark that errored is still owed by the commit that settles it.
            owed: [...missing, ...bad.filter((c) => c.app === "" && c.outcome === "error")],
          };
        }
        if (missing.length === 0) return { kind: "pass" };
        // The deployer marks only the newest build: a later trunk commit
        // that contains this one carries its deploy, and decides.
        if ((Date.now() - tipAskedAt) / 1000 >= o.quietSec) {
          tipAskedAt = Date.now();
          const tip = await laterTip(o.repo, sha);
          if (tip !== null) {
            return { kind: "later", tip, owed: missing, line: `${missing.map((c) => c.name).join(", ")} not reported` };
          }
        }
      }
      if (!why && all.length === 0 && near !== undefined && elapsed() >= o.firstSeenSec) {
        const e = await expectation(o.repo, sha, near);
        const still = e.ok ? await readCommit(o.repo, sha) : e;
        if (e.ok && still.ok && still.value.length === 0) {
          if (e.value === null) return { kind: "empty", code: 3, line: `no deploy reported for ${o.repo}` };
          return { kind: "empty", code: 1, line: `expected a deploy for ${o.repo} and none started (${e.value})` };
        }
        if (!still.ok) why = still.why;
      }
    } else {
      why = r.why;
    }
    if (why) process.stderr.write(`await-push-checks: ${why}\n`);
    if (!everRead && why && elapsed() >= o.firstSeenSec) {
      return { kind: "fail", line: `cannot read checks for ${sha}: ${why}`, supersedable: false };
    }
    if (elapsed() >= o.finishSec) {
      if (why) return { kind: "fail", line: `cannot read checks for ${sha}: ${why}`, supersedable: false };
      const all = [...seen.values()];
      const left = [
        ...all.filter((c) => !passed(c)).map((c) => `${label(c, all)} ${c.done ? c.outcome : "still running"}`),
        ...all
          .filter((c) => passed(c) && !fresh.has(`${c.key}\t${c.id}`))
          .map((c) => `${label(c, all)} no longer reported`),
        ...missing.map((c) => `${c.name} never reported`),
      ];
      return {
        kind: "fail",
        line: left.length ? left.join("; ") : `checks of ${sha} still appearing at ${o.finishSec}s`,
        supersedable: false,
      };
    }
    await sleep(o.intervalSec);
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  let sha = o.sha;
  let owed: Check[] = [];
  for (let tries = 0; ; tries++) {
    const w = await watch(o, sha, say, owed);
    if (w.kind === "pass") process.exit(0);
    if (w.kind === "empty") {
      say(w.line);
      process.exit(w.code);
    }
    const later =
      w.kind === "later" ? w.tip : w.supersedable && tries < SETTLE_TRIES ? await laterTip(o.repo, sha) : null;
    if (later === null || tries >= SETTLE_TRIES) {
      say(w.line);
      process.exit(1);
    }
    say(`${short(sha)} superseded by ${short(later)}, whose checks decide (${w.line})`);
    sha = later;
    owed = w.kind === "later" ? w.owed : (w.owed ?? []);
  }
}

await main();
