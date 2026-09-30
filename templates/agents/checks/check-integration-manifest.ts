#!/usr/bin/env -S node --experimental-strip-types
// check-integration-manifest.ts — hold every integrations/<name>/README.md
// manifest to the schema in integrations/README.md § Manifest, before a close
// commits it. integrations/README.md § Manifest owns what each key MEANS; this
// script owns whether a given README obeys it.
//
// WHAT IT CHECKS — each violation carries the letter of the part it breaks:
//   (a)  the frontmatter opens on line 1, is closed, and holds no nested map
//   (b)  exactly the required keys, in order; `uses-why` optional, and only
//        directly after `uses`
//   (c)  hosts, aliases, typed_client and access are non-empty block sequences
//   (d)  every `access` value is one of the five shapes, none repeated. The
//        ORDER is not checked: it ranks the shapes by capability for that
//        product, which no script can judge
//   (e)  every `typed_client` entry exists in the folder and every non-test
//        .ts there is listed — or the list is the single item `none` and the
//        folder ships no .ts
//   (f)  `onepassword_item` is `CREDS.<key>` exported by
//        integrations/1password/credentials.ts, or `none`
//   (g2) every scalar reads back from YAML as written (no unquoted `: `, no
//        leading indicator)
//   (g)  the remaining scalars are non-empty
//   (h)  `uses` is one value: a shape or `none`
//   (i)  `uses`, when not `none`, is one of this README's `access` values
//   (j)  `uses: none` only beside `typed_client: none`
//   (k)  `uses-why` is present and non-empty whenever `uses` is neither `none`
//        nor the first `access` value — the code does not take the most
//        capable shape, so the README says why
//
// WHAT IT SCANS. With no path arguments: the integration READMEs changed in this
// worktree, staged or not, plus untracked ones — land.ts calls it BEFORE its
// `git add -A`. "Changed" is measured from HEAD, or with `--since <ref>` from
// where this branch left <ref>: a README the session already COMMITTED differs
// from nothing at HEAD. Paths no longer on disk are skipped — deleting an
// integration arrives here as a deleted README. `--all` reads every
// integrations/*/README.md; explicit paths read exactly those files.
//
// Usage:
//   check-integration-manifest.ts                  READMEs changed since HEAD
//   check-integration-manifest.ts --since <ref>    …since this branch left <ref>
//   check-integration-manifest.ts --all            every integrations/*/README.md
//   check-integration-manifest.ts <readme>...      those files
//
// Env (tests only):
//   INTEGRATION_MANIFEST_CREDS  path to credentials.ts (default: the repo's)
//
// Output (stdout): exactly one line — `OK — N manifest(s) checked`, or
//   `FAIL — N manifest(s) checked, M violation(s)`.
// Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
//
// credentials.ts is read only when a manifest names a CREDS key: a workbench
// whose manifests all say `onepassword_item: none` needs none.
//
// peers:
//   integrations/README.md § Manifest             (the schema this enforces)
//   .agents/skills/close/scripts/land.ts          (the gate that calls it)
//
// Exit: 0 clean · 1 one or more violations, or credentials.ts unreadable when
//       a manifest needs it · 2 caller error

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Ends the run: `message` (when non-empty) to stderr, then exit `code`. */
class Exit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

// The keys, in the one order every manifest uses. `uses-why` is optional and,
// when present, sits directly after `uses`.
const REQUIRED_KEYS = [
  "name",
  "description",
  "hosts",
  "aliases",
  "typed_client",
  "access",
  "uses",
  "base_url",
  "auth",
  "onepassword_item",
  "rate_limit",
  "cli",
];
// The five shapes. Also the tiebreak between shapes of equal capability — which
// is prose in integrations/README.md, not something this script can test.
const SHAPES = ["cli", "api", "ssh", "mcp", "browser"];

// POSIX [[:space:]]; JavaScript's \s is wider.
const WS = "[ \\t\\n\\r\\f\\v]";
const KEY_LINE = new RegExp(`^([A-Za-z_][A-Za-z0-9_-]*):${WS}*(.*)$`, "s");
const KEY_LINE_NONEMPTY = new RegExp(`^([A-Za-z_][A-Za-z0-9_-]*):${WS}*(.+)$`, "s");
const LIST_ITEM = new RegExp(`^${WS}*-${WS}+(.*)$`, "s");
const INDENTED = new RegExp(`^${WS}+`);
const TRAILING_WS = new RegExp(`${WS}+$`);

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isManifestPath(p: string): boolean {
  return /(^|\/)integrations\/[^/]+\/README\.md$/.test(p);
}

function git(args: string[], inheritStderr = false) {
  return spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", inheritStderr ? "inherit" : "pipe"],
  });
}

function gitTop(): string | null {
  const r = git(["rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : null;
}

/** The repo this file sits in, for a run outside any git work tree. */
function scriptRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** A glob's `*.ext` over one folder: non-hidden names, sorted. */
function globNames(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((f) => !f.startsWith(".") && f.endsWith(suffix)).sort();
}

interface Scan {
  targets: string[];
  repoRoot: string;
}

function collect(args: string[], scan: Scan): void {
  let mode: "changed" | "all" | "paths" = "changed";
  let since = "";
  const first = args[0] ?? "";
  if (first === "--all") {
    if (args.length !== 1) throw new Exit(2, "check-integration-manifest: --all takes no paths");
    mode = "all";
  } else if (first === "--since") {
    if (!args[1]) throw new Exit(2, "check-integration-manifest: --since needs a ref");
    since = args[1];
    if (args.length !== 2) throw new Exit(2, "check-integration-manifest: --since takes no paths");
  } else if (first.startsWith("-")) {
    throw new Exit(2, `check-integration-manifest: unknown option ${first}`);
  } else if (first !== "") {
    mode = "paths";
  }

  if (mode === "paths") {
    scan.repoRoot = gitTop() ?? scriptRoot();
    scan.targets.push(...args);
    return;
  }
  if (mode === "all") {
    scan.repoRoot = gitTop() ?? scriptRoot();
    process.chdir(scan.repoRoot);
    for (const d of globNames("integrations", "")) {
      const f = `integrations/${d}/README.md`;
      if (isFile(f)) scan.targets.push(f);
    }
    return;
  }

  const top = gitTop();
  if (top === null) throw new Exit(2, "check-integration-manifest: not inside a git work tree");
  scan.repoRoot = top;
  process.chdir(top);
  let base = "HEAD";
  if (since) {
    const mb = git(["merge-base", "HEAD", since], true);
    if (mb.status !== 0) throw new Exit(2, `check-integration-manifest: cannot find where HEAD left ${since}`);
    base = mb.stdout.replace(/\n+$/, "");
  }
  // Tracked changes against the base plus untracked files, one per file.
  // `--no-renames` lists a move as its two halves; the half no longer on disk
  // is dropped here. Each list's exit is checked: a failing git read as
  // "nothing changed" once, and the scan reported OK — 0 over a README it
  // never saw.
  const diff = git(["diff", "-z", "--name-only", "--no-renames", base]);
  if (diff.status !== 0) {
    throw new Exit(
      2,
      `check-integration-manifest: git diff against ${base} failed: ${diff.stderr.replace(/\n+$/, "")}`,
    );
  }
  const others = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (others.status !== 0) {
    throw new Exit(2, `check-integration-manifest: git ls-files failed: ${others.stderr.replace(/\n+$/, "")}`);
  }
  const seen = new Set<string>();
  for (const p of `${diff.stdout}${others.stdout}`.split("\0")) {
    if (p === "" || !isManifestPath(p) || !isFile(p) || seen.has(p)) continue;
    seen.add(p);
    scan.targets.push(p);
  }
}

/** The CREDS keys credentials.ts exports, or "" when it cannot be read. */
async function credsKeys(file: string): Promise<string> {
  if (!isFile(file)) return "";
  try {
    const m: unknown = await import(pathToFileURL(resolve(file)).href);
    const creds = m && typeof m === "object" ? (m as { CREDS?: unknown }).CREDS : undefined;
    if (!creds || typeof creds !== "object") return "";
    return Object.keys(creds).join(" ");
  } catch {
    return "";
  }
}

/** The frontmatter block, no fences. It MUST open on line 1 and MUST be closed,
 *  and both fences are exactly `---`: a reader that matches `---` then a
 *  newline drops a README whose fence carries a trailing space without a word.
 *  A CRLF file's `\r` is dropped first. Returns 2 for no opening fence, 3 for
 *  never closed. */
function frontmatter(file: string): string | 2 | 3 {
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const body: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (i === 0) {
      if (line !== "---") return 2;
      continue;
    }
    if (line === "---") return body.join("\n").replace(/\n+$/, "");
    body.push(line);
  }
  return 3;
}

/** One pass over the frontmatter:
 *    keys     every top-level key, in order, repeats kept
 *    val      the text after `k:` on its own line (first occurrence)
 *    list     the `- item` values under a bare `k:`
 *    indent   indented lines that are not list items, as `N:line | …` */
interface Fm {
  keys: string[];
  val: Map<string, string>;
  list: Map<string, string[]>;
  indent: string;
}

function parseFm(fm: string): Fm {
  const out: Fm = { keys: [], val: new Map(), list: new Map(), indent: "" };
  let cur = "";
  let inList = false;
  let n = 0;
  for (const line of fm.split("\n")) {
    n += 1;
    const k = KEY_LINE.exec(line);
    if (k) {
      cur = k[1] ?? "";
      const v = k[2] ?? "";
      out.keys.push(cur);
      if (!out.val.has(cur)) out.val.set(cur, v);
      inList = v === "";
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (inList) out.list.set(cur, [...(out.list.get(cur) ?? []), item[1] ?? ""]);
      continue;
    }
    inList = false;
    if (INDENTED.test(line)) out.indent += `${out.indent ? " | " : ""}${n}:${line}`;
  }
  return out;
}

/** `list[key]` with empty items dropped. */
function listOf(fm: Fm, key: string): string[] {
  return (fm.list.get(key) ?? []).filter((i) => i !== "");
}

/** Why YAML would not read `value` back as the string written, or null. */
function yamlUnsafe(value: string): string | null {
  const v = value.replace(TRAILING_WS, "");
  if (/^".*"$/s.test(v) || /^'.*'$/s.test(v)) return null;
  if (v.includes(": ") || v.endsWith(":")) {
    return "contains an unquoted `: ` — YAML reads it as a nested mapping";
  }
  if (v === "-" || v.startsWith("- ")) return "starts with `- ` — YAML reads it as a nested list";
  if (/^[`@%&*!|>{[,?#]/.test(v)) return `starts with the YAML indicator "${v.slice(0, 1)}"`;
  return null;
}

/** ` ${words} ` contains ` ${w} ` — the shell's word-list membership test. */
function inWords(words: string, w: string): boolean {
  return ` ${words} `.includes(` ${w} `);
}

async function checkReadme(
  readme: string,
  validCreds: () => Promise<string>,
  violation: (p: string, part: string, what: string) => void,
): Promise<void> {
  const slash = readme.lastIndexOf("/");
  const dir = slash === -1 ? readme : readme.slice(0, slash);
  const fm = frontmatter(readme);

  if (fm === 2) {
    violation(readme, "a", "no frontmatter, or content before the opening `---` — the manifest must start on line 1");
    return;
  }
  if (fm === 3) {
    violation(readme, "a", "frontmatter is never closed by a second `---`");
    return;
  }
  if (fm === "") {
    violation(readme, "a", "empty frontmatter — every integration README carries the manifest");
    return;
  }

  const p = parseFm(fm);
  const hasKey = (k: string): boolean => p.val.has(k);

  // (a) No nested maps: the repo's parsers read scalars and block sequences
  //     only, and silently drop an indented sub-key.
  if (p.indent) {
    violation(readme, "a", `indented line that is not a \`- \` list item (nested maps are not read): ${p.indent}`);
  }

  // (b) Exactly the required keys, in order, `uses-why` only after `uses`.
  const presentList = p.keys.join(" ");
  const expected: string[] = [];
  for (const k of REQUIRED_KEYS) {
    expected.push(k);
    if (k === "uses" && inWords(presentList, "uses-why")) expected.push("uses-why");
  }
  const expectedList = expected.join(" ");
  if (presentList !== expectedList) {
    const missing = REQUIRED_KEYS.filter((k) => !inWords(presentList, k));
    const extra = p.keys.filter((k) => k !== "" && !inWords(`${REQUIRED_KEYS.join(" ")} uses-why`, k));
    if (missing.length > 0) violation(readme, "b", `missing manifest key(s): ${missing.join(" ")}`);
    if (extra.length > 0) {
      violation(
        readme,
        "b",
        `unknown manifest key(s): ${extra.join(" ")} — the manifest is exactly: ${REQUIRED_KEYS.join(" ")}, with optional uses-why directly after uses`,
      );
    }
    if (missing.length === 0 && extra.length === 0) {
      violation(
        readme,
        "b",
        `manifest keys out of order — got "${presentList}", want "${expectedList}" (uses-why is optional and sits directly after uses)`,
      );
    }
  }

  // (c) List keys are block sequences with at least one entry.
  for (const k of ["hosts", "aliases", "typed_client", "access"]) {
    if (!hasKey(k)) continue;
    const inline = p.val.get(k) ?? "";
    if (inline !== "") {
      violation(readme, "c", `\`${k}\` must be a block sequence (\`- item\` lines), got inline value "${inline}"`);
      continue;
    }
    if ((p.list.get(k) ?? []).length === 0) {
      violation(readme, "c", `\`${k}\` is empty — every integration declares at least one entry`);
    }
  }

  // (d) Every `access` value is a shape, none repeated. Order is the product's
  //     capability ranking and is not checked.
  const access = listOf(p, "access");
  const seenShape = new Set<string>();
  for (const a of access) {
    if (!inWords(SHAPES.join(" "), a)) {
      violation(readme, "d", `\`access\` value "${a}" is not one of: ${SHAPES.join(" ")}`);
    } else if (seenShape.has(a)) {
      violation(readme, "d", `\`access\` lists "${a}" more than once`);
    }
    seenShape.add(a);
  }

  // (e) Every `typed_client` entry names a file in this folder, or the list is
  //     the single item `none`.
  const clients = listOf(p, "typed_client");
  const actual = globNames(dir, ".ts").filter((f) => !f.endsWith(".test.ts") && isFile(`${dir}/${f}`));
  const clientsNone = clients.length === 1 && clients[0] === "none";

  if (clientsNone) {
    if (actual.length > 0) {
      violation(
        readme,
        "e",
        `\`typed_client: none\` but ${dir} ships ${actual.length} entry point(s): ${actual.join(" ")}`,
      );
    }
  } else if (clients.length > 0) {
    for (const c of clients) {
      if (c === "none") {
        violation(readme, "e", '`typed_client` mixes "none" with real entries — use "none" alone or list only files');
      } else if (!isFile(`${dir}/${c}`)) {
        violation(readme, "e", `\`typed_client\` names "${c}" but ${dir}/${c} does not exist`);
      }
    }
    for (const f of actual) {
      if (!inWords(clients.join(" "), f)) {
        violation(readme, "e", `${dir}/${f} is a non-test entry point but \`typed_client\` does not list it`);
      }
    }
  }

  // (f) `onepassword_item` is a CREDS key or `none`.
  let opi = p.val.get("onepassword_item") ?? "";
  if (opi.endsWith('"')) opi = opi.slice(0, -1);
  if (opi.startsWith('"')) opi = opi.slice(1);
  if (opi === "") {
    if (hasKey("onepassword_item")) {
      violation(readme, "f", "`onepassword_item` is empty — name a `CREDS.<key>` or `none`");
    }
  } else if (opi !== "none") {
    if (!opi.startsWith("CREDS.")) {
      violation(
        readme,
        "f",
        `\`onepassword_item: ${opi}\` — must be \`CREDS.<key>\` (the stable key, never the 1Password title) or \`none\``,
      );
    } else if (!inWords(await validCreds(), opi.slice("CREDS.".length))) {
      violation(readme, "f", `\`onepassword_item: ${opi}\` — no such key exported from credentials.ts`);
    }
  }

  // (g2) Every scalar must be one YAML reads back as written. An unquoted `: `,
  //      a trailing colon or a leading reserved indicator makes the whole
  //      frontmatter unparseable, silently so in the shell readers. A list
  //      item is held to the same test: `- host: alias` is a map to YAML.
  for (const line of fm.split("\n")) {
    const m = KEY_LINE_NONEMPTY.exec(line);
    if (!m) continue;
    const why = yamlUnsafe(m[2] ?? "");
    if (why !== null) violation(readme, "g2", `\`${m[1]}\` value ${why} — wrap the value in double quotes`);
  }
  for (const [kk, items] of p.list) {
    for (const item of items) {
      if (item === "") continue;
      const why = yamlUnsafe(item);
      if (why !== null) violation(readme, "g2", `\`${kk}\` item ${why} — wrap the item in double quotes`);
    }
  }

  // (g) Remaining scalars are non-empty.
  for (const k of ["name", "description", "base_url", "auth", "rate_limit", "cli"]) {
    if (!hasKey(k)) continue;
    if ((p.val.get(k) ?? "") === "") {
      violation(readme, "g", `\`${k}\` is empty — use \`none\` when the field does not apply`);
    }
  }

  // (h)–(k) `uses` and `uses-why`. Skipped when `uses` is absent: part (b)
  //         already named it missing.
  if (!hasKey("uses")) return;
  const uses = (p.val.get("uses") ?? "").replace(TRAILING_WS, "");
  const hasWhy = hasKey("uses-why");
  const why = p.val.get("uses-why") ?? "";

  if (uses === "") {
    if ((p.list.get("uses") ?? []).length > 0) {
      violation(readme, "h", `\`uses\` must be one value (${SHAPES.join(" ")} or none), not a list`);
    } else {
      violation(readme, "h", "`uses` is empty — name the shape the repo's code goes through, or `none`");
    }
    return;
  }
  if (!inWords(`${SHAPES.join(" ")} none`, uses)) {
    violation(readme, "h", `\`uses: ${uses}\` is not one of: ${SHAPES.join(" ")} none`);
    return;
  }

  if (uses === "none") {
    if (!clientsNone) {
      violation(
        readme,
        "j",
        `\`uses: none\` but \`typed_client\` lists ${clients.join(" ") || "nothing"} — a client is code that reaches the product`,
      );
    }
    if (hasWhy && why === "") violation(readme, "g", "`uses-why` is empty — drop the key or give the reason");
    return;
  }

  if (!inWords(access.join(" "), uses)) {
    violation(readme, "i", `\`uses: ${uses}\` is not in \`access\` (${access.join(" ") || "empty"})`);
    return;
  }

  if (uses !== access[0]) {
    if (why === "") {
      violation(
        readme,
        "k",
        `\`uses: ${uses}\` is not the first \`access\` value (${access[0]}), the most capable shape — add a non-empty \`uses-why\` saying why the code takes ${uses}`,
      );
    }
  } else if (hasWhy && why === "") {
    violation(readme, "g", "`uses-why` is empty — drop the key or give the reason");
  }
}

async function check(scan: Scan): Promise<number> {
  const { targets } = scan;
  if (targets.length === 0) {
    process.stdout.write("OK — 0 manifest(s) checked\n");
    return 0;
  }

  // Valid CREDS keys, read once and only when a manifest names one.
  // `onepassword_item` names a stable CREDS key, never a 1Password title — the
  // titles are mutable, so a README copy of one drifts.
  const credsFile =
    process.env.INTEGRATION_MANIFEST_CREDS || join(scan.repoRoot, "integrations", "1password", "credentials.ts");
  let credsRead: string | null = null;
  const validCreds = async (): Promise<string> => {
    if (credsRead === null) credsRead = await credsKeys(credsFile);
    if (credsRead === "") {
      throw new Exit(
        1,
        `check-integration-manifest: cannot read CREDS keys from ${credsFile} — onepassword_item unverifiable`,
      );
    }
    return credsRead;
  };

  let violations = 0;
  const violation = (path: string, part: string, what: string): void => {
    err(`${path}: (${part}) ${what}`);
    violations += 1;
  };
  for (const f of targets) {
    if (!isFile(f)) {
      violation(f, "a", "no such file");
      continue;
    }
    await checkReadme(f, validCreds, violation);
  }

  if (violations > 0) {
    process.stdout.write(`FAIL — ${targets.length} manifest(s) checked, ${violations} violation(s)\n`);
    return 1;
  }
  process.stdout.write(`OK — ${targets.length} manifest(s) checked\n`);
  return 0;
}

async function main(): Promise<void> {
  const scan: Scan = { targets: [], repoRoot: "" };
  let code = 0;
  try {
    collect(process.argv.slice(2), scan);
    code = await check(scan);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    err(e.message);
    code = e.code;
  }
  process.exitCode = code;
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
