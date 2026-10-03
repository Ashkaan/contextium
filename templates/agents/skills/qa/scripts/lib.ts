#!/usr/bin/env -S node --experimental-strip-types
// lib.ts — shared pure helpers for the /qa harness scripts.
//
// Imported by detect-app.ts, serve.ts, screenshot.ts, a11y.ts,
// interaction-check.ts and mark-qa-done.ts. Holds the two
// pure functions tests/lib.test.ts pins (route-slug + page-resolve)
// plus small path/JSON helpers reused across scripts, so the logic lives in
// exactly one place.
//
// peers:
//   .agents/skills/qa/scripts/detect-app.ts
//   .agents/skills/qa/scripts/serve.ts
//   .agents/skills/qa/scripts/screenshot.ts
//   .agents/skills/qa/scripts/interaction-check.ts
//   .agents/skills/qa/scripts/ensure-playwright.ts
//   .agents/skills/qa/scripts/tests/lib.test.ts
//
// This file declares functions only — it has NO executable body, so importing
// it is side-effect-free.
//
// Credentials come from wrangler's own environment (CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID), from QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET, or from a
// 1Password item the caller names (read with the `op` CLI), and are handed back
// to the caller as values: never written to the environment, never put on argv.

import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Print to stderr (errors never pollute stdout pipelines). */
export function qaErr(...msg: string[]): void {
  process.stderr.write(`${msg.join(" ")}\n`);
}

// POSIX `cksum`: CRC-32 (polynomial 0x04C11DB7, unreflected) over the bytes and
// then the length, complemented. The slugs and change-set keys below were
// written by `cksum` before this file existed, so the same input has to keep
// the same number.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** The number POSIX `cksum` prints for these bytes. */
export function cksum(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let crc = 0;
  const step = (b: number) => {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0;
  };
  for (const b of buf) step(b);
  for (let n = buf.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return String(~crc >>> 0);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A child's stdout, or "" when it could not be run. Stderr is discarded. */
function capture(cmd: string, args: string[], input?: string): { out: string; ok: boolean } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] });
  if (r.error) return { out: "", ok: false };
  return { out: r.stdout ?? "", ok: r.status === 0 };
}

/**
 * Directory basename, with a short hash of the absolute path appended so two
 * same-basename repos never collide. The hash is
 * unconditional-but-stable: same path always yields the same slug, and
 * different paths sharing a basename get distinct slugs.
 */
export function qaRepoSlug(repo: string): string {
  const abspath = isDir(repo) ? resolve(repo) : repo;
  return `${basename(abspath)}-${cksum(abspath)}`;
}

/**
 * Map a route to a filesystem-safe, collision-free token. Strips the leading
 * slash, replaces every non [A-Za-z0-9-] char (including the query `?`, `=`,
 * `&`, and path `/`) with `_`, collapses repeats, trims edge `_`, caps at 60
 * chars, and maps the empty/root route to `index`. Distinct routes (incl.
 * distinct query strings) produce distinct names.
 */
export function qaSlugRoute(route: string): string {
  // Byte-wise, as `tr -c` was: a multi-byte character becomes one `_` per byte
  // and then collapses with its neighbours.
  const bytes = Buffer.from(route.replace(/^\//, ""), "utf8");
  let slug = "";
  for (const b of bytes) slug += /[A-Za-z0-9-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "_";
  slug = slug.replace(/_+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  slug = slug.slice(0, 60);
  return slug === "" ? "index" : slug;
}

/**
 * Resolve the page list. Precedence: explicit CLI args > the discovered/default
 * set > the root `/`. Each argument is a single space-separated string; the
 * result is space-separated. Never resolves to empty ("0 pages → default,
 * never screenshot nothing").
 */
export function qaResolvePages(explicit: string, fromDefault: string): string {
  if (explicit.replaceAll(" ", "") !== "") return explicit;
  if (fromDefault.replaceAll(" ", "") !== "") return fromDefault;
  return "/";
}

/**
 * A stable digest of a repo's uncommitted change-set, or undefined when `git
 * status` fails there (not a checkout). It keyed the done-marker an autonomous
 * QA Stop hook used to read, so that hook fired once per distinct set of edits.
 * No hook reads it now; `/implement` phase 4.8 gates on the TREE marker
 * instead. Kept because mark-qa-done.ts still writes it and writing it costs
 * nothing.
 */
export function qaChangeHash(repo: string): string | undefined {
  const r = spawnSync("git", ["-C", repo, "status", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return undefined;
  return cksum(r.stdout);
}

interface PagesProject {
  name?: unknown;
  domains?: unknown;
  source?: { config?: { repo_name?: unknown } };
}

interface Registry {
  success?: unknown;
  result?: unknown;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A Pages project the registry answer may hold: a string name and, when present, a list of non-empty string domains. */
function isPagesEntry(e: unknown): boolean {
  if (!isRecord(e) || typeof e.name !== "string") return false;
  // jq's `.domains // []`: an absent, null or false list reads as empty.
  const domains = e.domains === undefined || e.domains === null || e.domains === false ? [] : e.domains;
  return Array.isArray(domains) && domains.every(nonEmptyString);
}

/** A Workers custom domain: a non-empty hostname and a non-empty service. */
function isWorkersDomainEntry(e: unknown): boolean {
  return isRecord(e) && nonEmptyString(e.hostname) && nonEmptyString(e.service);
}

/**
 * Resolve a repo to its deployed URL by looking it up in the Cloudflare Pages
 * project registry. Returns the URL on success, undefined otherwise.
 *
 * This is a REGISTRY LOOKUP, not inference: it matches on each project's
 * `source.config.repo_name` (what CF actually builds from) and returns the
 * project's own custom domain. Repo dir name and domain diverge in practice
 * (a repo named site-web deploying to example.com), so a string heuristic
 * would be wrong here and this is not. Satisfies no guessing by consulting the
 * authoritative source rather than assuming, and keeps `/qa --live` usable in a
 * repo that has never been configured.
 *
 * Cached for 6h at /tmp/qa-cf-pages-cache.<account>.json (QA_CF_PAGES_CACHE
 * overrides the name the account is put into; qaCfAccountCache) —
 * the project list changes on the order of months, and the whole point is to
 * stay fast enough to sit in the default path.
 *
 * Credentials are wrangler's own: CLOUDFLARE_API_TOKEN (Pages and Workers read)
 * and CLOUDFLARE_ACCOUNT_ID (qaCfRegistryRefresh). Without them there is no
 * registry to ask, and this returns undefined — the caller then needs
 * --live-url, never a guessed URL.
 */
export async function qaDeriveLiveUrlFromCf(repoName: string): Promise<string | undefined> {
  const cache = process.env.QA_CF_PAGES_CACHE || "/tmp/qa-cf-pages-cache.json";
  const file = await qaCfRegistryRefresh(cache, "pages/projects", isPagesEntry);
  if (file === undefined) return undefined;
  const d = readJson(file);
  if (!isRecord(d) || !Array.isArray(d.result)) return undefined;
  for (const p of d.result as PagesProject[]) {
    if (!isRecord(p)) continue;
    const repo = isRecord(p.source) && isRecord(p.source.config) ? p.source.config.repo_name : undefined;
    if (repo !== repoName) continue;
    const domains = Array.isArray(p.domains) ? p.domains.filter((x): x is string => typeof x === "string") : [];
    const dom = domains.find((x) => !x.endsWith(".pages.dev"));
    if (dom) return `https://${dom}`;
  }
  return undefined;
}

/**
 * Does this repo's wrangler config declare a Worker entry (`main`)?
 *
 * It is the one signal that separates the two shapes of Cloudflare Astro
 * project, which take different serve commands: `main` present -> a Worker
 * (`wrangler dev`); absent -> Pages (`wrangler pages dev dist`). detect-app.ts
 * cannot tell them apart, because both carry the same astro + wrangler
 * dependency signals.
 *
 * Anchored at line start so a `//`-commented or `#`-commented `main` in a
 * JSONC/TOML config does not count, and so a nested `main` inside some other
 * block cannot masquerade as the top-level key. Checks jsonc, json, then toml —
 * first config found wins, matching how wrangler itself resolves.
 */
export function qaWranglerDeclaresMain(repo: string): boolean {
  for (const cfg of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const f = join(repo, cfg);
    if (!isFile(f)) continue;
    return readFileSync(f, "utf8")
      .split("\n")
      .some((l) => /^\s*("main"\s*:|main\s*=)/.test(l));
  }
  return false;
}

/**
 * The node_modules dir holding a `playwright` whose chromium revision is
 * installed, or undefined. Shared by screenshot.ts, interaction-check.ts and
 * a11y.ts.
 *
 * With `app`, the app's own copy comes first: every node_modules from the app
 * up to its repo root (the first ancestor holding `.git`), so a hoisted
 * workspace install counts. An app that ships Playwright must never be skipped
 * because the machine has none of its own.
 *
 * When no copy on the machine has its browser, ensure-playwright.ts installs
 * one into its own cache on first use. When that is impossible (offline, no
 * npm, QA_NO_INSTALL=1) it prints `qa: skipped — Playwright unavailable
 * (<reason>)` on stderr and this returns undefined: the caller reports a skip,
 * never a pass.
 */
export function qaPlaywrightNodeModules(app = ""): string | undefined {
  const candidates: string[] = [];
  if (app !== "" && isDir(app)) {
    let d = resolve(app);
    for (;;) {
      if (isDir(join(d, "node_modules"))) candidates.push(join(d, "node_modules"));
      if (existsSync(join(d, ".git")) || d === "/") break;
      d = dirname(d);
    }
  }
  const g = capture("npm", ["root", "-g"]).out.replace(/\n+$/, "");
  if (g !== "") candidates.push(g);
  const home = process.env.HOME || homedir();
  const npx = join(home, ".npm", "_npx");
  let entries: string[] = [];
  try {
    entries = readdirSync(npx).sort();
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const c = join(npx, e, "node_modules");
    if (isDir(join(c, "playwright"))) candidates.push(c);
  }
  // The first candidate whose chromium revision is installed.
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, ".cache", "ms-playwright");
  for (const dir of candidates) {
    try {
      const bj = join(dir, "playwright-core", "browsers.json");
      if (!existsSync(bj)) continue;
      const j = readJson(bj);
      const browsers = isRecord(j) && Array.isArray(j.browsers) ? j.browsers : [];
      const ch = browsers.find((b): b is Record<string, unknown> => isRecord(b) && b.name === "chromium");
      if (!ch) continue;
      const rev = String(ch.revision);
      // The browser dir layout differs by version (chrome-linux vs chrome-linux64),
      // so test the layout-independent INSTALLATION_COMPLETE marker instead.
      const full = join(cache, `chromium-${rev}`, "INSTALLATION_COMPLETE");
      const shell = join(cache, `chromium_headless_shell-${rev}`, "INSTALLATION_COMPLETE");
      if (existsSync(full) || existsSync(shell)) return dir;
    } catch {
      // an unreadable candidate is not a candidate
    }
  }
  // None on the machine: ensure-playwright.ts finds or installs one (its skip
  // line reaches the user on stderr, inherited).
  const ensure = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(dirname(fileURLToPath(import.meta.url)), "ensure-playwright.ts"),
      ...(app !== "" && isDir(app) ? ["--app", app] : []),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (ensure.error || ensure.status !== 0) return undefined;
  const mod = /^PLAYWRIGHT_MODULE=(.+)$/m.exec(ensure.stdout ?? "")?.[1];
  return mod ? dirname(mod) : undefined;
}

/** A CF-Access service-token pair: the two request headers a gated app wants. */
export interface CfAccessPair {
  id: string;
  secret: string;
}

/**
 * The CF-Access service-token pair held by 1Password item `item` in fields
 * `idField` / `secretField`, or undefined when either is unresolved. The pair is
 * RETURNED: the caller sets its own request headers from it, so the values never
 * reach the environment, a child's argv or stdout. The item is the one
 * `--auth-op-item` names (serve.ts --live passes on QA_ACCESS_OP_ITEM); it is
 * read with the `op` CLI.
 */
export async function qaResolveCfAccess(
  item: string,
  idField: string,
  secretField: string,
): Promise<CfAccessPair | undefined> {
  // A 1Password service account must name the vault, so look up which vault
  // holds this item rather than naming one.
  let vault = "";
  const list = readJsonText(capture("op", ["item", "list", "--format", "json"]).out);
  if (Array.isArray(list)) {
    const hit = list.find((x): x is Record<string, unknown> => isRecord(x) && (x.id === item || x.title === item));
    if (hit && isRecord(hit.vault) && hit.vault.id !== undefined && hit.vault.id !== null) vault = String(hit.vault.id);
  }
  const field = (f: string) =>
    capture("op", ["item", "get", item, "--vault", vault, "--fields", f, "--reveal"]).out.replace(/\n+$/, "");
  const id = field(idField);
  const secret = field(secretField);
  return id !== "" && secret !== "" ? { id, secret } : undefined;
}

/**
 * The pair QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET hold, or undefined unless both
 * are set: a service token with no 1Password at all. The capture scripts use it
 * when no `--auth-op-item` was named.
 */
export function qaEnvCfAccess(): CfAccessPair | undefined {
  const id = process.env.QA_CF_ACCESS_ID ?? "";
  const secret = process.env.QA_CF_ACCESS_SECRET ?? "";
  return id !== "" && secret !== "" ? { id, secret } : undefined;
}

/**
 * The request headers a pair (and, with it, the person the probe acts as) and a
 * local Access token become; undefined with neither. `jwt` is the token
 * `serve.ts` mints for a local run (`qaLocalAccess`), sent the way Cloudflare
 * Access forwards a signed-in person's to the Worker behind it.
 */
export function qaAccessHeaders(
  pair: CfAccessPair | undefined,
  actAs: string,
  jwt = "",
): Record<string, string> | undefined {
  if (pair === undefined && jwt === "") return undefined;
  return {
    ...(pair !== undefined ? { "CF-Access-Client-Id": pair.id, "CF-Access-Client-Secret": pair.secret } : {}),
    ...(pair !== undefined && actAs ? { "X-Portal-Act-As": actAs } : {}),
    ...(jwt !== "" ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
  };
}

/**
 * The token in the file `--auth-jwt-file` names, or "" when no file was named.
 * A named file that is missing or empty is an error, not an anonymous run: the
 * caller stops, because every page would answer 401 and grade as a login wall.
 */
export function qaReadJwtFile(file: string): string | undefined {
  if (file === "") return "";
  try {
    const jwt = readFileSync(file, "utf8").trim();
    return jwt === "" ? undefined : jwt;
  } catch {
    return undefined;
  }
}

function readJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `.success == true`, and the `result` the endpoint answers: a list whose every
 * entry passes `entry`, or (shape "object") one object that does. Each caller
 * names its shape, so an object answer never passes for a list endpoint.
 */
export function qaIsGoodRegistry(
  v: unknown,
  entry: (e: unknown) => boolean,
  shape: "list" | "object" = "list",
): boolean {
  const r: Registry = isRecord(v) ? v : {};
  if (r.success !== true) return false;
  return shape === "list" ? Array.isArray(r.result) && r.result.every(entry) : isRecord(r.result) && entry(r.result);
}

/**
 * The file a registry cache named `cache` is kept in for Cloudflare account
 * `account`: the account id goes before the extension
 * (`/tmp/qa-cf-pages-cache.json` -> `/tmp/qa-cf-pages-cache.<account>.json`).
 * Every account's registry is its own — its Pages projects, its Workers
 * domains, its Access team domain — so one account's copy must never answer
 * for another's after CLOUDFLARE_ACCOUNT_ID changes.
 */
export function qaCfAccountCache(cache: string, account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ""): string {
  const ext = extname(cache);
  return `${cache.slice(0, cache.length - ext.length)}.${account.replace(/[^A-Za-z0-9_-]/g, "_")}${ext}`;
}

/**
 * Keep a good copy of the account's GET /client/v4/accounts/<id>/<path> in the
 * account's own file for `cache` (qaCfAccountCache), refreshed every 6h, and
 * return that file — or undefined when there is no usable copy. A refresh
 * writes a per-run sibling and renames it into place only when the answer says `"success": true` with a `result` list whose
 * every entry satisfies `entry` (or, with shape "object", for an endpoint
 * answering one object, a `result` object that does), so a concurrent reader never sees a
 * half-written file and an error body never replaces a good one. A failed
 * refresh keeps the last good copy: the registry changes on the order of
 * months, and a live run must not lose its URL to a network blip. Undefined when
 * no usable copy exists, and when wrangler's CLOUDFLARE_API_TOKEN /
 * CLOUDFLARE_ACCOUNT_ID are not set — without them this is not the user's
 * account to ask about. QA_CF_API overrides the API base (tests point it at a
 * port nothing listens on).
 */
export async function qaCfRegistryRefresh(
  cacheName: string,
  path: string,
  entry: (e: unknown) => boolean,
  shape: "list" | "object" = "list",
): Promise<string | undefined> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (account === "" || token === "") return undefined;
  const cache = qaCfAccountCache(cacheName, account);
  const api = process.env.QA_CF_API || "https://api.cloudflare.com/client/v4";
  const size = (() => {
    try {
      return statSync(cache).size;
    } catch {
      return 0;
    }
  })();
  const stale = (() => {
    try {
      return Date.now() - statSync(cache).mtimeMs > 360 * 60 * 1000;
    } catch {
      return false;
    }
  })();
  if (size === 0 || stale) {
    const tmp = makeSibling(cache);
    if (tmp !== undefined) {
      // fetch rather than curl: the bearer token stays in this process instead
      // of on a child's argv, where every process listing could read it.
      let body: string | undefined;
      try {
        const resp = await fetch(`${api}/accounts/${account}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        body = resp.ok ? await resp.text() : undefined;
      } catch {
        body = undefined;
      }
      if (body !== undefined && qaIsGoodRegistry(readJsonText(body), entry, shape)) {
        try {
          writeFileSync(tmp, body);
          renameSync(tmp, cache);
        } catch {
          rmSync(tmp, { force: true });
        }
      } else {
        rmSync(tmp, { force: true });
      }
    }
  }
  try {
    if (statSync(cache).size === 0) return undefined;
  } catch {
    return undefined;
  }
  return qaIsGoodRegistry(readJson(cache), entry, shape) ? cache : undefined;
}

/** `mktemp "<file>.XXXXXX"`: a new empty sibling, or undefined when none can be made. */
function makeSibling(file: string): string | undefined {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    const p = `${file}.${suffix}`;
    try {
      closeSync(openSync(p, "wx", 0o600));
      return p;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) return undefined;
    }
  }
  return undefined;
}

/** JSONC as wrangler accepts it: `//` and block comments outside strings dropped, then trailing commas. */
function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let str = false;
  while (i < src.length) {
    const c = src[i] ?? "";
    const n = src[i + 1];
    if (str) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') str = false;
      i++;
      continue;
    }
    if (c === '"') {
      str = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      // A trailing comma: the next thing past whitespace and comments closes the list or object.
      let j = i + 1;
      for (;;) {
        while (j < src.length && /\s/.test(src[j] ?? "")) j++;
        if (src[j] === "/" && src[j + 1] === "/") {
          while (j < src.length && src[j] !== "\n") j++;
          continue;
        }
        if (src[j] === "/" && src[j + 1] === "*") {
          j += 2;
          while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The repo's wrangler config as JSON text (wrangler.jsonc/json with comments
 * and trailing commas removed, as wrangler itself accepts them), or "". A
 * config that is not valid JSON(C) is reported on stderr and reads as "".
 * wrangler.toml is read by the callers below.
 */
export function qaWranglerConfig(repo: string): string {
  for (const f of ["wrangler.jsonc", "wrangler.json"]) {
    const file = join(repo, f);
    if (!isFile(file)) continue;
    try {
      return JSON.stringify(JSON.parse(stripJsonc(readFileSync(file, "utf8"))));
    } catch (e) {
      process.stderr.write(`qa: ${repo}/${f} is not valid JSON(C): ${e instanceof Error ? e.message : String(e)}\n`);
      return "";
    }
  }
  return "";
}

function wranglerConfigObject(repo: string): Record<string, unknown> {
  const text = qaWranglerConfig(repo);
  const v = text === "" ? undefined : readJsonText(text);
  return isRecord(v) ? v : {};
}

/**
 * The value of the first `key = <string>` line of `text`: a basic "string"
 * (\" and \\ unescaped) or a literal 'string' (taken as written), or "". TOML
 * allows both, and a reader that knows only one reads the other as missing.
 */
export function qaTomlValue(text: string): string {
  const line = text.split("\n")[0] ?? "";
  // The kind of string is the quote that OPENS the value, not any quote on the
  // line: "o'brien@…" is a basic string with an apostrophe in it.
  const eq = line.indexOf("=");
  const value = (eq === -1 ? line : line.slice(eq + 1)).replace(/^\s+/, "");
  if (value.startsWith("'")) {
    const m = /^'([^']*)'/.exec(value);
    return m ? (m[1] ?? "") : "";
  }
  if (value.startsWith('"')) {
    const m = /^"((?:\\.|[^"\\])*)"/.exec(value);
    return m ? (m[1] ?? "").replace(/\\(["\\])/g, "$1") : "";
  }
  return "";
}

/**
 * The Worker name the repo's wrangler config declares at top level
 * (wrangler.toml's `name =` before any [table], or the JSON config's top-level
 * "name"), or "".
 */
export function qaWranglerName(repo: string): string {
  const toml = join(repo, "wrangler.toml");
  if (isFile(toml)) {
    for (const l of readFileSync(toml, "utf8").split("\n")) {
      if (/^\s*\[/.test(l)) break;
      if (/^\s*name\s*=/.test(l)) return qaTomlValue(l);
    }
    return "";
  }
  const name = wranglerConfigObject(repo).name;
  return name === undefined || name === null || name === false ? "" : String(name);
}

/** The route patterns the config declares, in order (the canonical hostname first, when the repo lists several). */
export function qaWranglerRoutes(repo: string): string[] {
  const toml = join(repo, "wrangler.toml");
  if (isFile(toml)) {
    // `pattern = …` inside a route table, or a top-level `route = "…"` string.
    const out: string[] = [];
    for (const l of readFileSync(toml, "utf8").split("\n")) {
      if (/^\s*#/.test(l)) continue;
      for (const m of l.matchAll(/(pattern|^\s*route)\s*=\s*("[^"]+"|'[^']+')/g)) out.push(qaTomlValue(m[0]));
    }
    return out;
  }
  const cfg = wranglerConfigObject(repo);
  const list: unknown[] = [];
  if (cfg.route !== undefined && cfg.route !== null && cfg.route !== false) list.push(cfg.route);
  if (Array.isArray(cfg.routes)) list.push(...cfg.routes);
  const out: string[] = [];
  for (const r of list) {
    if (typeof r === "string") out.push(r);
    else if (isRecord(r) && typeof r.pattern === "string") out.push(r.pattern);
  }
  return out;
}

/**
 * The live URL of a Worker-deployed app: a production custom domain
 * Cloudflare's Workers registry (GET /accounts/<id>/workers/domains) maps to
 * the Worker name the repo declares. The Pages lookup above cannot see a Worker
 * at all, so without this `/qa --live` refuses every Worker-served site with
 * "no Cloudflare Pages project". Same registry-lookup rule: the repo says which
 * Worker it deploys, Cloudflare says which hostnames serve it. When several do,
 * the one the repo declares first wins (the others are usually redirects, which
 * the off-origin gate then rejects); several with none declared is ambiguous
 * and returns nothing rather than a guess. Cached per account
 * (qaCfAccountCache) under QA_CF_WORKERS_DOMAINS_CACHE.
 */
export async function qaDeriveLiveUrlFromWorkers(repo: string): Promise<string | undefined> {
  const name = qaWranglerName(repo);
  if (name === "") return undefined;
  const cache = process.env.QA_CF_WORKERS_DOMAINS_CACHE || "/tmp/qa-cf-workers-domains.json";
  const file = await qaCfRegistryRefresh(cache, "workers/domains", isWorkersDomainEntry);
  if (file === undefined) return undefined;
  const d = readJson(file);
  const result = isRecord(d) && Array.isArray(d.result) ? d.result : [];
  const hosts = result
    .filter(
      (e): e is Record<string, unknown> =>
        isRecord(e) &&
        e.service === name &&
        (e.environment === undefined || e.environment === null || e.environment === false
          ? "production"
          : e.environment) === "production",
    )
    .map((e) => String(e.hostname));
  if (hosts.length === 0) return undefined;
  let host: string | undefined;
  for (const route of qaWranglerRoutes(repo)) {
    const h = route.split("/")[0] ?? "";
    if (hosts.includes(h)) {
      host = h;
      break;
    }
  }
  if (host === undefined) {
    if (hosts.length === 1) {
      host = hosts[0];
    } else {
      qaErr(
        `qa: Worker ${name} has several custom domains and its wrangler config names none of them: ${hosts.join(" ")} `,
      );
      return undefined;
    }
  }
  return `https://${host}`;
}

/**
 * The person the target's wrangler config lets the Access service token act
 * as, lower-cased, or "". The config's `PROBE_ACTS_AS = "<client id> <email>"`
 * is the app's own declaration, for an app that treats a service token alone as
 * a MACHINE (every page answers "service tokens cannot access this page") but
 * treats the same token plus `X-Portal-Act-As: <that email>` as that person on
 * every page and write. Apps that declare nothing get no header: this is inert
 * unless the app opts in. The email is not a secret, so it travels on argv as
 * `--auth-act-as`. Only an active line counts: a commented-out value would name
 * the wrong person, and such an app answers a wrong act-as with 401.
 */
export function qaProbeActsAs(repo: string): string {
  const value = qaWranglerVar(repo, "PROBE_ACTS_AS");
  if (value === "") return "";
  const email = (value.trim().split(/\s+/)[1] ?? "").toLowerCase();
  return /@.*\./s.test(email) ? email : "";
}

/**
 * The string value of `[vars] <key>` in the repo's wrangler config, or "". In
 * wrangler.toml the first active `<key> = "…"` line inside the top-level `[vars]`
 * table counts, so a commented-out value, an environment's, or another table's never does.
 */
export function qaWranglerVar(repo: string, key: string): string {
  const toml = join(repo, "wrangler.toml");
  if (isFile(toml)) {
    // Only inside the top-level `[vars]` table: an `[env.<name>.vars]` value is not the one a
    // local server runs with, and a same-named key in another table is not a var at all.
    // A line inside a multi-line string is never a header or a key; a header is `[vars]`,
    // `["vars"]` or `['vars']`, with any spacing and a trailing comment, and only that.
    let inVars = false;
    let multi: string | undefined;
    for (const l of readFileSync(toml, "utf8").split("\n")) {
      if (multi !== undefined) {
        if (l.split(multi).length % 2 === 0) multi = undefined;
        continue;
      }
      if (/^\s*\[/.test(l)) {
        inVars = /^\s*\[\s*(vars|"vars"|'vars')\s*\]\s*(#.*)?$/.test(l);
        continue;
      }
      if (inVars && new RegExp(`^\\s*${key}\\s*=`).test(l)) return qaTomlValue(l);
      const opens = /"""|'''/.exec(l);
      if (opens !== null && l.split(opens[0]).length % 2 === 0) multi = opens[0];
    }
    return "";
  }
  const vars = wranglerConfigObject(repo).vars;
  const v = isRecord(vars) ? vars[key] : undefined;
  return v === undefined || v === null || v === false ? "" : String(v);
}

/** One D1 database the wrangler config binds, and where its migrations live. */
export interface QaD1Migrations {
  binding: string;
  /** The migrations directory, relative to the repo: `migrations_dir`, else wrangler's default `migrations`. */
  dir: string;
  /** A `remote` binding reaches production even from a local server. */
  remote: boolean;
}

/**
 * The top-level `d1_databases` the repo's wrangler config declares, in order,
 * with each one's migrations directory. A fresh local database has no tables
 * at all until those migrations are applied to it. An `[env.*]` block's
 * bindings are not the ones a local server uses, so they are not read; an
 * entry with no binding is left out.
 */
export function qaD1Migrations(repo: string): QaD1Migrations[] {
  const out: QaD1Migrations[] = [];
  const toml = join(repo, "wrangler.toml");
  if (isFile(toml)) {
    let cur: Record<string, string> | undefined;
    const close = () => {
      if (cur?.binding)
        out.push({ binding: cur.binding, dir: cur.migrations_dir || "migrations", remote: cur.remote === "true" });
      cur = undefined;
    };
    for (const l of readFileSync(toml, "utf8").split("\n")) {
      if (/^\s*#/.test(l)) continue;
      if (/^\s*\[/.test(l)) {
        close();
        if (/^\s*\[\[\s*d1_databases\s*\]\]/.test(l)) cur = {};
        continue;
      }
      const m = /^\s*(binding|migrations_dir|remote)\s*=\s*(.*)$/.exec(l);
      if (cur && m) cur[m[1] ?? ""] = m[1] === "remote" ? ((m[2] ?? "").trim().split(/\s/)[0] ?? "") : qaTomlValue(l);
    }
    close();
    return out;
  }
  const list = wranglerConfigObject(repo).d1_databases;
  for (const d of Array.isArray(list) ? list : []) {
    if (!isRecord(d) || !nonEmptyString(d.binding)) continue;
    out.push({
      binding: d.binding,
      dir: nonEmptyString(d.migrations_dir) ? d.migrations_dir : "migrations",
      remote: d.remote === true,
    });
  }
  return out;
}

/** A local stand-in for Cloudflare Access: the key set a Worker verifies with, and one token it signed. */
export interface QaLocalAccess {
  jwks: string;
  jwt: string;
}

/** How long a local token lives: longer than any one /qa run. */
export const QA_LOCAL_JWT_HOURS = 12;

/**
 * A fresh RS256 key pair, its public half as a JWKS, and a token for `email`
 * signed with it, shaped as Cloudflare Access signs a person's: `email`, `sub`,
 * `iss` (the account's Access team domain), `aud` (the application's AUD tag).
 * The key lives only in this process, so the token verifies against nothing
 * but the JWKS returned beside it, and an app that opts in (ACCESS_JWKS_URL)
 * should trust that JWKS only on a loopback request.
 */
export function qaLocalAccess(
  email: string,
  aud: string,
  issuer: string,
  nowSec = Math.floor(Date.now() / 1000),
): QaLocalAccess {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "qa-local";
  const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signed = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part({
    email,
    sub: `qa-local:${email}`,
    iss: issuer,
    aud: [aud],
    iat: nowSec,
    exp: nowSec + QA_LOCAL_JWT_HOURS * 3600,
  })}`;
  return { jwks, jwt: `${signed}.${sign("sha256", Buffer.from(signed), privateKey).toString("base64url")}` };
}

/**
 * The issuer Cloudflare Access puts on this account's tokens,
 * `https://<auth_domain>`, from the account's Access organization — the
 * registry, not a copy of the team name. Cached 6h per account
 * (qaCfAccountCache) under QA_CF_ACCESS_ORG_CACHE.
 */
export async function qaAccessIssuer(): Promise<string | undefined> {
  const cache = process.env.QA_CF_ACCESS_ORG_CACHE || "/tmp/qa-cf-access-org.json";
  const good = (e: unknown) => isRecord(e) && nonEmptyString(e.auth_domain);
  const file = await qaCfRegistryRefresh(cache, "access/organizations", good, "object");
  if (file === undefined) return undefined;
  const d = readJson(file);
  const org = isRecord(d) && isRecord(d.result) ? d.result : {};
  return nonEmptyString(org.auth_domain) ? `https://${org.auth_domain}` : undefined;
}

/**
 * Where interaction-check.ts records a clean run for a tree, and where
 * mark-qa-done.ts --tree looks for it. One formula, here, so the writer and the
 * reader cannot disagree about the key.
 */
export function qaInteractionStampPath(repo: string, tree: string): string {
  return `${process.env.QA_DONE_DIR || "/tmp/qa-done"}/interaction-${qaRepoSlug(repo)}-${tree}`;
}
