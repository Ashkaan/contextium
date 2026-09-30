// check-integration-manifest.test.ts — boundary rows for
// check-integration-manifest.ts: every part letter, the `uses` / `uses-why`
// rules, and the no-args / `--since` scan land.ts calls (changed, untracked,
// deleted, committed on the branch).
//
// Run: node --test --experimental-strip-types .agents/checks/check-integration-manifest.test.ts
//
// Fixture READMEs are written by `makeReadme()` from VALID_FM below into a
// scratch dir; the scan-mode rows use real `git init`-ed repos, because those
// modes read `git diff` and `git ls-files --others`. The program is SPAWNED,
// never imported, with HOME pointed at a scratch folder so no git config of
// the real one leaks in.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "check-integration-manifest.ts");
const TMP = mkdtempSync(join(tmpdir(), "integration-manifest-test-"));
const HOME = join(TMP, "home");
mkdirSync(HOME);
after(() => rmSync(TMP, { recursive: true, force: true }));

// A stand-in credentials.ts so `onepassword_item` is verifiable without the repo.
// The key prefix is assembled at run time, so no `CREDS.<key>` literal ships in
// this file (the release's leak gate refuses one).
const CK = "CREDS";
const CREDS = join(TMP, "credentials-fixture.ts");
writeFileSync(
  CREDS,
  `export const CREDS = {
  demo: { id: "x", title: "t", fields: {}, consumers: [] },
  slack: { id: "y", title: "t", fields: {}, consumers: [] },
} as const;
`,
);

interface Run {
  out: string;
  err: string;
  rc: number | null;
}

function run(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CHECK, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME, INTEGRATION_MANIFEST_CREDS: CREDS, ...env },
  });
  if (r.error) throw r.error;
  return { out: r.stdout, err: r.stderr, rc: r.status };
}

const VALID_FM = `name: Dataforseo
description: A one-line description
hosts:
  - host.example.com
aliases:
  - example
typed_client:
  - client.ts
access:
  - api
uses: api
base_url: https://api.example.com
auth: basic
onepassword_item: ${CK}.demo
rate_limit: none
cli: REST API`;

/** VALID_FM with its first `from` replaced — the old suite's `${VALID_FM/a/b}`. */
const fm = (from: string, to: string, base = VALID_FM): string => {
  assert.ok(base.includes(from), `fixture pattern not in frontmatter: ${from}`);
  return base.replace(from, to);
};

// The manifest-only shape: no client, no code reaches the product.
const NONE_FM = fm("uses: api", "uses: none", fm("  - client.ts", "  - none"));

/** integrations/<name>/README.md from a frontmatter body; `extra` names an
 *  empty file to create beside it. Returns the README path. */
function makeReadme(name: string, body: string, extra?: string): string {
  const d = join(TMP, "integrations", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "README.md"), `---\n${body}\n---\n\n# ${name}\n`);
  if (extra) writeFileSync(join(d, extra), "");
  return join(d, "README.md");
}

/** A README written verbatim, with a `client.ts` beside it. */
function rawReadme(name: string, content: string, client = true): string {
  const d = join(TMP, "integrations", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "README.md"), content);
  if (client) writeFileSync(join(d, "client.ts"), "");
  return join(d, "README.md");
}

/** The old suite's `expect ok|violation <case> <readme> [needle]`. */
function expect(
  t: { test: (name: string, fn: () => void) => Promise<void> },
  want: "ok" | "violation",
  name: string,
  readme: string,
  needle = "",
) {
  return t.test(name, () => {
    const r = run([readme], TMP);
    const out = `${r.out}${r.err}`;
    assert.equal(r.rc === 0 ? "ok" : "violation", want, out);
    if (needle) assert.ok(out.includes(needle), `message did not mention "${needle}": ${out}`);
  });
}

test("the valid shapes", async (t) => {
  await expect(t, "ok", "valid manifest", makeReadme("dataforseo", VALID_FM, "client.ts"));
  await expect(
    t,
    "ok",
    "manifest-only folder (typed_client, uses and onepassword_item none)",
    makeReadme("metacritic", fm(`${CK}.demo`, "none", NONE_FM)),
  );
  const cf = makeReadme("cloudflare", fm("  - client.ts", "  - client.ts\n  - d1.ts"), "client.ts");
  writeFileSync(join(TMP, "integrations/cloudflare/d1.ts"), "");
  await expect(t, "ok", "several typed_client entries", cf);
  await expect(
    t,
    "ok",
    "all five shapes, canonical order",
    makeReadme("laddered", fm("  - api", "  - api\n  - cli\n  - ssh\n  - mcp\n  - browser"), "client.ts"),
  );
  // Order carries the product's capability ranking, so a non-canonical one passes.
  await expect(
    t,
    "ok",
    "access in a non-canonical order",
    makeReadme("reordered", fm("  - api", "  - api\n  - ssh"), "client.ts"),
  );
});

test("(a) fences and nesting", async (t) => {
  await expect(
    t,
    "violation",
    "content before the opening fence",
    rawReadme("preamble", `stray line\n---\n${VALID_FM}\n---\n`),
    "(a) no frontmatter, or content before the opening",
  );
  await expect(
    t,
    "violation",
    "front matter never closed",
    rawReadme("unclosed", `---\n${VALID_FM}\n# body, no closing fence\n`),
    "(a) frontmatter is never closed",
  );
  await expect(t, "violation", "no front matter at all", rawReadme("bare", "# bare\n", false), "(a) no frontmatter");
  // A reader that matches the opening fence as `---` then a newline drops a
  // README whose fence carries a trailing space, without a word.
  await expect(
    t,
    "violation",
    "opening fence with trailing whitespace",
    rawReadme("padfence", `--- \n${VALID_FM}\n---\n`),
    "(a) no frontmatter, or content before the opening",
  );
  await expect(
    t,
    "violation",
    "nested map under a key",
    makeReadme("nested", fm("auth: basic", "auth:\n  method: basic"), "client.ts"),
    "(a) indented line",
  );
  await expect(
    t,
    "violation",
    "a named input file that does not exist",
    join(TMP, "integrations/ghost-folder/README.md"),
    "(a) no such file",
  );
});

test("(b) keys", async (t) => {
  await expect(
    t,
    "violation",
    "missing key",
    makeReadme("nokey", fm("rate_limit: none\n", ""), "client.ts"),
    "(b) missing manifest key(s): rate_limit",
  );
  await expect(
    t,
    "violation",
    "keys out of order",
    makeReadme(
      "disordered",
      fm("base_url: https://api.example.com\nauth: basic", "auth: basic\nbase_url: https://api.example.com"),
      "client.ts",
    ),
    "(b) manifest keys out of order",
  );
  await expect(
    t,
    "violation",
    "unknown key",
    makeReadme("extrakey", `${VALID_FM}\nsurprise: yes`, "client.ts"),
    "(b) unknown manifest key(s): surprise",
  );
});

test("(c) list shape", async (t) => {
  await expect(
    t,
    "violation",
    "access empty",
    makeReadme("noaccess", fm("access:\n  - api", "access:"), "client.ts"),
    "(c) `access` is empty",
  );
  await expect(
    t,
    "violation",
    "inline list instead of a block sequence",
    makeReadme("inline", fm("hosts:\n  - host.example.com", "hosts: [host.example.com]"), "client.ts"),
    "(c) `hosts` must be a block sequence",
  );
});

test("(d) access values", async (t) => {
  await expect(
    t,
    "violation",
    "access value outside the five",
    makeReadme("badshape", fm("  - api", "  - graphql\n  - api"), "client.ts"),
    '(d) `access` value "graphql" is not one of',
  );
  await expect(
    t,
    "violation",
    "access value repeated",
    makeReadme("dupshape", fm("  - api", "  - api\n  - api"), "client.ts"),
    '(d) `access` lists "api" more than once',
  );
});

test("(e) typed_client", async (t) => {
  await expect(
    t,
    "violation",
    "typed_client names a missing file",
    makeReadme("ghostclient", fm("  - client.ts", "  - nope.ts")),
    '(e) `typed_client` names "nope.ts"',
  );
  await expect(
    t,
    "violation",
    "typed_client mixes none with a real entry",
    makeReadme("mixedclient", fm("  - client.ts", "  - client.ts\n  - none"), "client.ts"),
    "(e) `typed_client` mixes",
  );
  await expect(
    t,
    "violation",
    "typed_client: none while the folder ships a client",
    makeReadme("lyingnone", NONE_FM, "client.ts"),
    "(e) `typed_client: none` but",
  );
  const undecl = makeReadme("undeclared", VALID_FM, "client.ts");
  writeFileSync(join(TMP, "integrations/undeclared/extra.ts"), "");
  await expect(t, "violation", "an entry point the manifest never declares", undecl, "(e) ");
});

test("(f) onepassword_item", async (t) => {
  await expect(
    t,
    "violation",
    "onepassword_item names an unknown CREDS key",
    makeReadme("badcred", fm(`${CK}.demo`, `${CK}.nope`), "client.ts"),
    `(f) \`onepassword_item: ${CK}.nope\` — no such key`,
  );
  await expect(
    t,
    "violation",
    "onepassword_item carries a 1Password title",
    makeReadme("titlecred", fm(`${CK}.demo`, "DataForSEO API - Shared"), "client.ts"),
    "(f) `onepassword_item: DataForSEO API - Shared` — must be",
  );
});

test("(g) and (g2) scalars", async (t) => {
  await expect(
    t,
    "violation",
    "empty scalar",
    makeReadme("emptyauth", fm("auth: basic", "auth:"), "client.ts"),
    "(g) `auth` is empty",
  );
  await expect(
    t,
    "violation",
    "unquoted colon-space makes the YAML a nested mapping",
    makeReadme("colonval", fm("auth: basic", "auth: Authorization: Token <t>"), "client.ts"),
    "(g2) `auth` value contains an unquoted",
  );
  await expect(
    t,
    "violation",
    "value starting with a YAML indicator",
    makeReadme("tickval", fm("cli: REST API", "cli: `yt-dlp` (no auth)"), "client.ts"),
    "(g2) `cli` value starts with the YAML indicator",
  );
  await expect(
    t,
    "violation",
    "list item YAML reads as a map",
    makeReadme("mapitem", fm("  - host.example.com", "  - host.example.com: alias"), "client.ts"),
    "(g2) `hosts` item contains an unquoted",
  );
  await expect(
    t,
    "violation",
    "list item YAML reads as a nested list",
    makeReadme("nestitem", fm("  - host.example.com", "  - - host.example.com"), "client.ts"),
    "(g2) `hosts` item starts with `- `",
  );
  // CRLF fences are read as fences, so the check accepts them too.
  await expect(t, "ok", "CRLF line endings", rawReadme("crlf", `---\n${VALID_FM}\n---\n`.replace(/\n/g, "\r\n")));
  await expect(
    t,
    "ok",
    "list item with a colon, quoted",
    makeReadme("quoteditem", fm("  - host.example.com", '  - "host.example.com: alias"'), "client.ts"),
  );
  await expect(
    t,
    "ok",
    "the same values, quoted",
    makeReadme("quotedval", fm("auth: basic", 'auth: "Authorization: Token <t>"'), "client.ts"),
  );
  await expect(
    t,
    "ok",
    "quoted value with trailing whitespace",
    makeReadme("quotedpad", fm("auth: basic", 'auth: "Authorization: Token <t>"   '), "client.ts"),
  );
});

test("(h)–(k) uses and uses-why", async (t) => {
  // (h) uses is one value from the set
  await expect(
    t,
    "violation",
    "uses missing",
    makeReadme("nouses", fm("uses: api\n", ""), "client.ts"),
    "(b) missing manifest key(s): uses",
  );
  await expect(
    t,
    "violation",
    "uses empty",
    makeReadme("emptyuses", fm("uses: api", "uses:"), "client.ts"),
    "(h) `uses` is empty",
  );
  await expect(
    t,
    "violation",
    "uses as a block list",
    makeReadme("listuses", fm("uses: api", "uses:\n  - api"), "client.ts"),
    "(h) `uses` must be one value",
  );
  await expect(
    t,
    "violation",
    "uses outside the set",
    makeReadme("vncuses", fm("uses: api", "uses: vnc"), "client.ts"),
    "(h) `uses: vnc` is not one of",
  );
  // (i) uses is an access value
  await expect(
    t,
    "violation",
    "uses names a shape access does not list",
    makeReadme("sshuses", fm("uses: api", "uses: ssh"), "client.ts"),
    "(i) `uses: ssh` is not in `access`",
  );
  // (j) none only without a client
  await expect(
    t,
    "violation",
    "uses none beside a real typed_client",
    makeReadme("noneclient", fm("uses: api", "uses: none"), "client.ts"),
    "(j) `uses: none` but `typed_client` lists",
  );
  // (k) uses-why when the code does not take the first shape
  await expect(
    t,
    "violation",
    "uses is not access[0] and no uses-why",
    makeReadme("nowhy", fm("  - api", "  - cli\n  - api"), "client.ts"),
    "(k) `uses: api` is not the first `access` value (cli)",
  );
  await expect(
    t,
    "violation",
    "uses-why present but empty when required",
    makeReadme("emptywhy", fm("  - api\nuses: api", "  - cli\n  - api\nuses: api\nuses-why:"), "client.ts"),
    "(k) `uses: api` is not the first `access` value (cli)",
  );
  await expect(
    t,
    "ok",
    "uses is not access[0], with uses-why",
    makeReadme(
      "withwhy",
      fm("  - api\nuses: api", "  - cli\n  - api\nuses: api\nuses-why: the client runs where the CLI is not installed"),
      "client.ts",
    ),
  );
  await expect(
    t,
    "ok",
    "uses-why present when uses is access[0]",
    makeReadme("extrawhy", fm("uses: api", "uses: api\nuses-why: the REST API is the whole product"), "client.ts"),
  );
  await expect(
    t,
    "ok",
    "uses is access[0] of a non-canonical list, no uses-why",
    makeReadme("apifirst", fm("  - api", "  - api\n  - cli"), "client.ts"),
  );
  await expect(
    t,
    "violation",
    "uses-why placed before uses",
    makeReadme("whyfirst", fm("uses: api", "uses-why: text\nuses: api"), "client.ts"),
    "(b) manifest keys out of order",
  );
  await expect(
    t,
    "violation",
    "uses-why placed after base_url",
    makeReadme("whylate", fm("auth: basic", "uses-why: text\nauth: basic"), "client.ts"),
    "(b) manifest keys out of order",
  );
  // The hyphen in `uses-why` makes it a key, not an unread line.
  await expect(
    t,
    "violation",
    "uses-why with an unquoted colon-space",
    makeReadme("whycolon", fm("uses: api", "uses: api\nuses-why: reason: text"), "client.ts"),
    "(g2) `uses-why` value contains an unquoted",
  );
  await expect(
    t,
    "violation",
    "uses-why empty when not required",
    makeReadme("emptyoptional", fm("uses: api", "uses: api\nuses-why:"), "client.ts"),
    "(g) `uses-why` is empty",
  );
});

test("credentials.ts unreadable exits 1", () => {
  const r = run([join(TMP, "integrations/dataforseo/README.md")], TMP, {
    INTEGRATION_MANIFEST_CREDS: join(TMP, "nope.ts"),
  });
  assert.equal(r.rc, 1, r.err);
  assert.ok(r.err.includes("cannot read CREDS keys"), r.err);
});

test("no credentials.ts is not an error while every onepassword_item is none", () => {
  const r = run([join(TMP, "integrations/metacritic/README.md")], TMP, {
    INTEGRATION_MANIFEST_CREDS: join(TMP, "nope.ts"),
  });
  assert.equal(r.rc, 0, `${r.out}${r.err}`);
});

test("--since with no ref exits 2", () => {
  const r = run(["--since"], TMP);
  assert.equal(r.rc, 2, r.err);
});

// ── Scan modes, in real repos ─────────────────────────────────────────────

let REPO = "";
let n = 0;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME },
  });
}

/** A repo whose first commit holds two valid manifests. */
function newrepo(): void {
  n += 1;
  REPO = join(TMP, `repo${n}`);
  for (const x of ["alpha", "beta"]) {
    mkdirSync(join(REPO, "integrations", x), { recursive: true });
    writeFileSync(join(REPO, "integrations", x, "README.md"), `---\n${VALID_FM}\n---\n`);
    writeFileSync(join(REPO, "integrations", x, "client.ts"), "");
  }
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "tester");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
}

/** The old suite's `scan <want-rc> <case> <stdout-needle> [args...]`, from the repo. */
function scan(
  t: { test: (name: string, fn: () => void) => Promise<void> },
  want: number,
  name: string,
  needle: string,
  args: string[] = [],
) {
  const r = run(args, REPO);
  return {
    r,
    done: t.test(name, () => {
      assert.equal(r.rc, want, `${r.out}${r.err}`);
      assert.ok(r.out.includes(needle), `stdout lacks "${needle}": ${r.out}${r.err}`);
    }),
  };
}

test("scan modes", async (t) => {
  newrepo();
  await scan(t, 0, "no README changed", "OK — 0 manifest(s) checked").done;
  await scan(t, 0, "--all reads every README", "OK — 2 manifest(s) checked", ["--all"]).done;

  appendFileSync(join(REPO, "integrations/alpha/README.md"), "extra body line\n");
  await scan(t, 0, "one modified README is checked", "OK — 1 manifest(s) checked").done;

  mkdirSync(join(REPO, "integrations/gamma"));
  writeFileSync(join(REPO, "integrations/gamma/README.md"), `---\n${fm("uses: api", "uses: vnc")}\n---\n`);
  writeFileSync(join(REPO, "integrations/gamma/client.ts"), "");
  const g = scan(t, 1, "an untracked README is checked", "FAIL — 2 manifest(s) checked, 1 violation(s)");
  await g.done;
  await t.test("the untracked README's violation names it", () =>
    assert.ok(g.r.err.includes("integrations/gamma/README.md: (h)"), g.r.err),
  );
  rmSync(join(REPO, "integrations/gamma"), { recursive: true });

  git("checkout", "-q", "--", "integrations/alpha/README.md");
  git("rm", "-q", "-r", "integrations/beta");
  await scan(t, 0, "a deleted README is skipped", "OK — 0 manifest(s) checked").done;

  newrepo();
  git("checkout", "-q", "-b", "branch");
  appendFileSync(join(REPO, "integrations/alpha/README.md"), "extra body line\n");
  git("commit", "-q", "-am", "edit on the branch");
  await scan(t, 0, "a committed change is invisible from HEAD", "OK — 0 manifest(s) checked").done;
  await scan(t, 0, "…and checked with --since", "OK — 1 manifest(s) checked", ["--since", "main"]).done;

  // A scan git cannot make is an error, never "OK — 0".
  newrepo();
  appendFileSync(join(REPO, "integrations/alpha/README.md"), "extra body line\n");
  writeFileSync(join(REPO, ".git/index"), "garbage\n");
  await scan(t, 2, "a git diff that fails is a caller error, not a clean scan", "").done;
  newrepo();
  git("checkout", "-q", "-b", "branch");
  await scan(t, 2, "--since a ref git cannot read is a caller error", "", ["--since", "no-such-ref"]).done;

  writeFileSync(join(REPO, "integrations/notes.md"), "not a manifest\n");
  await scan(t, 0, "a non-README file under integrations/ is not a target", "OK — 0 manifest(s) checked").done;
});

// The starters this repo ships (templates/integrations/, beside this check in
// the Contextium repo; absent from an installed workbench's .agents/checks/).
const STARTERS = join(HERE, "..", "..", "integrations");
test("every integration starter's manifest passes", { skip: !existsSync(STARTERS) && "no starters beside this check" }, () => {
  const readmes = readdirSync(STARTERS)
    .map((d) => join(STARTERS, d, "README.md"))
    .filter((f) => existsSync(f))
    .sort();
  assert.ok(readmes.length > 0, `no starter README under ${STARTERS}`);
  const r = run(readmes, TMP, { INTEGRATION_MANIFEST_CREDS: join(TMP, "nope.ts") });
  assert.equal(r.rc, 0, `${r.out}${r.err}`);
});
