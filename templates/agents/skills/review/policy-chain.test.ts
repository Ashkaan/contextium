// policy-chain.test.ts — one case per boundary row of the chain walker.
//
// Every case is driven by STUBS, never a live vendor, so the result never
// depends on anyone's quota or auth state — which is the whole point of testing
// a fallback path.
//
// Rows 13 (max diff), 15 (--fixture) and 16 (CODEX_REVIEW_REPO) are properties
// of the CALLER, not the walker — the helper never resolves a repo or budgets a
// diff. They are exercised through code-review.ts at the bottom of this file.
//
// policy-chain.ts is a LIBRARY, so this suite imports it (the library
// carve-out in check-scripts), exactly as its three callers do. The walk takes
// a sink for its two streams; the suite collects them instead of monkeypatching
// process.stdout. code-review.ts, a program, is spawned.
//
// The vendor stubs are small bash files: they stand in for the codex and grok
// CLIs, which are external binaries, not scripts of this repo.
//
// Run: node --test --experimental-strip-types .agents/skills/review/policy-chain.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { policyRunChain, type Validator } from "./policy-chain.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = spawnSync("git", ["-C", SCRIPT_DIR, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).stdout.replace(/\n+$/, "");

// The vendor stubs and the planted-bug fixture live beside this suite, under
// tests/. A missing folder does not resolve, and the fixture-backed cases FAIL
// loudly — which is correct. A silent skip would report a green suite for
// assertions that never ran.
const STUBS = `${SCRIPT_DIR}/tests/stubs`;

const TMP = mkdtempSync(join(tmpdir(), "policy-chain-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── Fixtures ──────────────────────────────────────────────────────────
//
// A stand-in policy, so no case depends on the live table drifting.

const POLICY = `${TMP}/policy.json`;
writeFileSync(
  POLICY,
  `{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "one-slot": {
      "mode": "no-backup",
      "chain": [{ "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "claude-tail": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }]
    },
    "bogus-vendor": {
      "mode": "single",
      "chain": [{ "vendor": "nosuchvendor", "model": "x", "tracks": "x" }]
    },
    "unpinned": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "unresolvable": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "unresolvable-{v}" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "panel": {
      "mode": "panel",
      "voices": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    }
  }
}
`,
);

const PROMPT = `${TMP}/prompt.txt`;

function exe(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Model resolution reads a vendor's live catalog; these cases stub the vendor,
// so they stub the resolver too (POLICY_CHAIN_RESOLVER, policy-chain.ts). It
// resolves the fixture families the way a real catalog would and fails a
// family named `unresolvable-{v}`.
exe(
  `${TMP}/resolve-model.sh`,
  `#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2 in the $1 catalog" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
`,
);
process.env.POLICY_CHAIN_RESOLVER = `${TMP}/resolve-model.sh`;
writeFileSync(PROMPT, "review this artifact\n");

const EMPTY_PROMPT = `${TMP}/empty.txt`;
writeFileSync(EMPTY_PROMPT, "");

// Stubs the shared set does not cover: one that names itself so a stream can be
// attributed to a slot, one that records its argv, one that emits an
// unterminated final line.
function mkstub(path: string, body: string): void {
  exe(path, `#!/usr/bin/env bash\nset -uo pipefail\n${body}\n`);
}
mkstub(`${TMP}/say-codex.sh`, 'echo "[must-fix] from codex"');
mkstub(`${TMP}/say-grok.sh`, 'printf "{\\"text\\":\\"[must-fix] from grok\\"}\\n"');
mkstub(`${TMP}/record-args.sh`, `printf '%s\\n' "$@" > '${TMP}/argv.txt'; echo '{"text":"ok"}'`);
mkstub(`${TMP}/no-trailing-newline.sh`, 'printf "[nit] last line with no newline"');
mkstub(`${TMP}/echo-prompt-bytes.sh`, "wc -c < /dev/stdin");

process.env.POLICY_JSON = POLICY;
process.env.POLICY_CHAIN_SLOT_TIMEOUT_S = "5";
// No author recorded unless a case names one: the harness record of whatever
// checkout runs this suite must not decide which slots the cases see.
process.env.CONTEXTIUM_HARNESS_FILE = `${TMP}/no-such-harness`;

// run — calls the walk with `env` overlaid on process.env for the call only,
// and collects stdout and stderr separately so the "stdout carries vendor output
// ONLY" contract is assertable. Both are read the way `$(...)` read them in the
// bash suite: trailing newlines dropped.
interface Run {
  rc: number;
  out: string;
  err: string;
}
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
function run(kind: string, prompt: string, env: Record<string, string | undefined> = {}, validator?: Validator): Run {
  const out: Buffer[] = [];
  const err: string[] = [];
  const rc = withEnv(env, () =>
    policyRunChain(kind, prompt, {
      validator,
      sink: {
        out: (c) => {
          out.push(Buffer.from(c));
        },
        err: (l) => {
          err.push(`${l}\n`);
        },
      },
    }),
  );
  return {
    rc,
    out: Buffer.concat(out).toString("utf8").replace(/\n+$/, ""),
    err: err.join("").replace(/\n+$/, ""),
  };
}

const count = (hay: string, needle: string): number => hay.split("\n").filter((l) => l.includes(needle)).length;
const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8").replace(/\n+$/, "") : "");
// The line just before / after an exact line — `grep -B1 -x` / `grep -A1 -x`.
function lineBefore(hay: string, exact: string): string {
  const lines = hay.split("\n");
  const i = lines.indexOf(exact);
  return i < 0 ? "" : i === 0 ? exact : (lines[i - 1] ?? "");
}
function lineAfter(hay: string, exact: string): string {
  const lines = hay.split("\n");
  const i = lines.indexOf(exact);
  return i < 0 ? "" : (lines[i + 1] ?? exact);
}
function has(name: string, needle: string, hay: string): void {
  assert.ok(hay.includes(needle), `${name} — missing '${needle}' in: ${hay}`);
}
function lacks(name: string, needle: string, hay: string): void {
  assert.ok(!hay.includes(needle), `${name} — unexpected '${needle}' in: ${hay}`);
}
function rcIs(name: string, expect: number, got: number | null): void {
  assert.equal(got, expect, `${name} — expected rc=${expect}, got rc=${got}`);
}
function eq(name: string, expect: string | number, got: string | number): void {
  assert.equal(got, expect, `${name} — expected '${expect}', got '${got}'`);
}

// Is `dir` outside every git checkout? The no-repo cases only mean something there.
function outsideAnyRepo(dir: string): boolean {
  return spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: "ignore" }).status !== 0;
}

test("1a — unknown task-kind", () => {
  const r = run("no-such-kind", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh` });
  rcIs("1a unknown task-kind", 2, r.rc);
  has("1a names the row", "no-such-kind", r.err);
  has("1a lists known rows", "known rows:", r.err);
});

test("2 — a one-slot row exhausts with no 'trying next slot'", () => {
  const r = run("one-slot", PROMPT, { GROK_BIN: `${STUBS}/stub-fail.ts` });
  rcIs("2 one-slot exhaustion", 1, r.rc);
  lacks("2 no next-slot line on a one-slot row", "trying next slot", r.err);
  has("2 exhaustion is named", "every vendor in the 'one-slot' chain failed", r.err);
});

test("3 — empty prompt file, before any vendor is invoked", () => {
  rmSync(`${TMP}/argv.txt`, { force: true });
  const r = run("adversarial-review", EMPTY_PROMPT, { CODEX_BIN: `${TMP}/record-args.sh` });
  rcIs("3 empty prompt", 2, r.rc);
  assert.ok(!existsSync(`${TMP}/argv.txt`), "3 a vendor was invoked on an empty prompt");
  // A prompt file that does not exist at all is the same class of caller error.
  const r2 = run("adversarial-review", `${TMP}/does-not-exist.txt`);
  rcIs("3b missing prompt file", 2, r2.rc);
});

test("4 — every slot fails; one stderr line per slot", () => {
  const r = run("adversarial-review", PROMPT, {
    CODEX_BIN: `${STUBS}/stub-fail.ts`,
    GROK_BIN: `${STUBS}/stub-fail.ts`,
  });
  rcIs("4 total exhaustion", 1, r.rc);
  eq("4 nothing on stdout", "", r.out);
  eq("4 one failure line per slot", 2, count(r.err, "failed (exit"));
  has("4 names codex", "codex failed", r.err);
  has("4 names grok", "grok failed", r.err);
  // Only the non-final slot promises a next one. A "trying next slot" on the LAST
  // slot is a diagnostic that lies about what happens next.
  eq("4 only the non-final slot promises a next", 1, count(r.err, "trying next slot"));
});

test("5 — first slot's CLI absent; the walk continues", () => {
  const r = run("adversarial-review", PROMPT, {
    CODEX_BIN: `${TMP}/nonexistent-binary`,
    GROK_BIN: `${TMP}/say-grok.sh`,
  });
  rcIs("5 absent primary falls through", 0, r.rc);
  has("5 absence is named", "codex CLI absent", r.err);
  has("5 grok answered", "answered: grok/grok", r.err);
  eq("5 grok's text reaches stdout", "[must-fix] from grok", r.out);
});

test("6 — first slot exits non-zero; the walk continues", () => {
  const r = run("adversarial-review", PROMPT, { CODEX_BIN: `${STUBS}/stub-fail.ts`, GROK_BIN: `${TMP}/say-grok.sh` });
  rcIs("6 failed primary falls through", 0, r.rc);
  has("6 failure reason carries the exit code", "codex failed (exit 3)", r.err);
});

test("7 — a timed-out slot falls through; all-timeout returns 124", () => {
  const a = run("adversarial-review", PROMPT, { CODEX_BIN: `${STUBS}/stub-hang.ts`, GROK_BIN: `${TMP}/say-grok.sh` });
  rcIs("7a hung primary falls through", 0, a.rc);
  has("7a timeout is named as a timeout", "codex timed out after 5s", a.err);

  const b = run("adversarial-review", PROMPT, {
    CODEX_BIN: `${STUBS}/stub-hang.ts`,
    GROK_BIN: `${STUBS}/stub-hang.ts`,
  });
  rcIs("7b every slot timed out", 124, b.rc);

  // A timeout followed by a plain failure is NOT 124 — the code reports the LAST
  // failure, so a caller cannot mistake a dead vendor for a slow one.
  const c = run("adversarial-review", PROMPT, {
    CODEX_BIN: `${STUBS}/stub-hang.ts`,
    GROK_BIN: `${STUBS}/stub-fail.ts`,
  });
  rcIs("7c timeout then failure is 1, not 124", 1, c.rc);
});

test("8 — the walk stops on first success; streams never concatenate", () => {
  const r = run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh`, GROK_BIN: `${TMP}/say-grok.sh` });
  rcIs("8 first slot answers", 0, r.rc);
  eq("8 only the first slot's output", "[must-fix] from codex", r.out);
  lacks("8 the second slot never ran", "from grok", r.out);
  has("8 answered line names codex", "answered: codex/codex", r.err);
});

test("9 — a slot exits 0 with an empty body: success here; the CALLER decides", () => {
  const r = run("adversarial-review", PROMPT, { CODEX_BIN: `${STUBS}/stub-empty.ts` });
  rcIs("9 empty-but-zero is not chain fallthrough", 0, r.rc);
  eq("9 stdout is empty", "", r.out);
});

test("10 — policy.json missing", () => {
  const r = run("adversarial-review", PROMPT, { POLICY_JSON: `${TMP}/absent.json` });
  rcIs("10 missing policy", 2, r.rc);
  has("10 says where the table ships", "it ships beside policy-chain.ts", r.err);
});

test("11 — the policy is read at CALL time, never cached", () => {
  // A stale policy.json is a real hazard (pre-commit only regenerates when the
  // policy files are STAGED), so the helper must never memoize the table: the
  // same process, asked twice, must see an edit made in between.
  const STALE = `${TMP}/stale.json`;
  writeFileSync(
    STALE,
    '{ "rows": { "adversarial-review": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }] } } }\n',
  );
  const a = run("adversarial-review", PROMPT, { POLICY_JSON: STALE, CODEX_BIN: `${TMP}/say-codex.sh` });
  has("11 reads the row before the edit", "answered: codex/codex", a.err);
  writeFileSync(
    STALE,
    '{ "rows": { "adversarial-review": { "mode": "single", "chain": [{ "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }] } } }\n',
  );
  const b = run("adversarial-review", PROMPT, { POLICY_JSON: STALE, GROK_BIN: `${TMP}/say-grok.sh` });
  has("11 sees the edited row in the same process", "answered: grok/grok", b.err);
});

test("12 — the chain reaches a claude slot", () => {
  const r = run("claude-tail", PROMPT, { CODEX_BIN: `${STUBS}/stub-fail.ts` });
  rcIs("12 claude slot returns 3", 3, r.rc);
  has("12 tells the caller to dispatch its agent", "dispatch the Claude agent instead", r.err);
});

test("14 — a large prompt is piped, never placed on argv", () => {
  // ~256 KB, well past the point where argv dies "Argument list too long"
  // (exit 126).
  const BIG = `${TMP}/big-prompt.txt`;
  writeFileSync(BIG, randomBytes(262144).toString("base64").slice(0, 262144));
  const r = run("adversarial-review", BIG, { CODEX_BIN: `${TMP}/echo-prompt-bytes.sh` });
  rcIs("14 a 256KB prompt runs", 0, r.rc);
  assert.ok(Number(r.out.replace(/\s/g, "")) >= 262144, `14 the whole prompt did not reach the vendor: ${r.out}`);
});

test("16 — the helper resolves no repo of its own", (t) => {
  // Run with cwd outside any git checkout. A helper that shelled out to
  // `git rev-parse` for its policy path would die here; repo resolution stays
  // caller-owned.
  if (!outsideAnyRepo(TMP)) {
    t.skip(`${TMP} is inside a git checkout; skipping the no-repo case`);
    return;
  }
  const cwd = process.cwd();
  process.chdir(TMP);
  let r: Run;
  try {
    r = run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh` });
  } finally {
    process.chdir(cwd);
  }
  rcIs("16 works outside a git repo", 0, r.rc);
});

test("16b/16c — the table is the one shipped beside the script", () => {
  // No POLICY_JSON: the helper reads policy.json from its own folder, whatever
  // the caller's cwd, inside a repo or not. Run in a fresh node so nothing the
  // copy does can reach this suite.
  mkdirSync(`${TMP}/copy/a/b`, { recursive: true });
  copyFileSync(join(SCRIPT_DIR, "policy-chain.ts"), `${TMP}/copy/a/b/policy-chain.ts`);
  const code = `const m = await import(${JSON.stringify(`${TMP}/copy/a/b/policy-chain.ts`)}); const p = m.policyChainPolicyPath(); if (p === null) process.exit(2); process.stdout.write(p + "\\n");`;
  const env = { ...process.env };
  delete env.POLICY_JSON;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], {
    cwd: "/",
    env,
    encoding: "utf8",
  });
  rcIs("16b resolves with no repo and no POLICY_JSON", 0, r.status);
  eq("16b the policy.json beside the script", `${TMP}/copy/a/b/policy.json`, r.stdout.replace(/\n+$/, ""));

  // The shipped table carries the rows every caller names, pins no model, and
  // keeps the panel as voices.
  const shipped = JSON.parse(readFileSync(join(SCRIPT_DIR, "policy.json"), "utf8")) as {
    rows: Record<string, { chain?: { tracks: string }[]; voices?: { tracks: string }[] }>;
  };
  eq("16c shipped rows", "adversarial-review judgment panel repo-investigation", Object.keys(shipped.rows).sort().join(" "));
  eq(
    "16c the shipped table pins no model",
    "",
    Object.values(shipped.rows)
      .flatMap((row) => row.chain ?? row.voices ?? [])
      .map((slot) => slot.tracks)
      .filter((t) => t !== "")
      .join(","),
  );
  eq(
    "16c the panel is voices, the reviews are chains",
    "voices chain chain chain",
    ["panel", "adversarial-review", "judgment", "repo-investigation"]
      .map((k) => (shipped.rows[k]?.voices ? "voices" : "chain"))
      .join(" "),
  );
});

test("17 — every vendor down at once: no false green anywhere", () => {
  const r = run("adversarial-review", PROMPT, {
    CODEX_BIN: `${TMP}/nonexistent-binary`,
    GROK_BIN: `${TMP}/nonexistent-binary`,
  });
  rcIs("17 all vendors absent", 1, r.rc);
  eq("17 nothing on stdout", "", r.out);
});

test("an unsupported vendor exhausts cleanly; a panel row reads through voices", () => {
  const r = run("bogus-vendor", PROMPT);
  rcIs("unsupported vendor exhausts", 1, r.rc);
  has("unsupported vendor is named", "unsupported vendor", r.err);
  const p = run("panel", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh` });
  rcIs("panel row resolves through voices", 0, p.rc);
});

// ── § 9 failure mode: the answer-only Grok invocation is allowlist-scoped ──
//
// It used to be denylist-scoped, and these rows used to assert the four denied
// names were present. They now assert the opposite, because the protection
// changed shape: this path runs under `bypassPermissions`, which
// ignores `--disallowed-tools` entirely, so a denied name appearing on the
// command line would be a claim of safety that is not enforced. What holds now
// is the allowlist, and it holds only while it is NON-EMPTY — `--tools ''` was
// measured granting a file write and a shell command, 2/2.
test("§ 9 — the answer-only grok invocation", () => {
  rmSync(`${TMP}/argv.txt`, { force: true });
  const r = run("one-slot", PROMPT, { GROK_BIN: `${TMP}/record-args.sh` });
  rcIs("answer-only case ran", 0, r.rc);
  const ARGV = read(`${TMP}/argv.txt`);
  has("grok answer-only run is allowlist-scoped", "--tools", ARGV);
  has("grok answer-only allowlist is non-empty", "list_dir", ARGV);
  lacks("grok answer-only run carries no unenforced denylist", "--disallowed-tools", ARGV);
  lacks("grok answer-only run does not allowlist a shell", "run_terminal_command", ARGV);
  lacks("grok answer-only run does not allowlist search_replace", "search_replace", ARGV);
  lacks("grok answer-only run does not allowlist spawn_subagent", "spawn_subagent", ARGV);
  // The mode is half the protection and half the fix; asserting the allowlist
  // without it would pass against a `dontAsk` run that cancels a quarter of the
  // time and enforces the allowlist not at all.
  has("grok answer-only run uses bypassPermissions", "bypassPermissions", ARGV);
  lacks("grok answer-only run never uses dontAsk", "dontAsk", ARGV);
  has("grok answer-only run takes no web hop", "--disable-web-search", ARGV);
  has("grok prompt arrives as a file, not argv", "--prompt-file", ARGV);
  // Grok CLI 1.0.0 truncates a large prompt and offloads it to a session file
  // unless told not to. Review and SPEC-audit prompts are exactly the large ones,
  // and a half-delivered prompt comes back as narration this script then reports
  // as a dead slot — so the flag is a correctness requirement, not a nicety.
  has("grok prompt is sent verbatim (1.0.0 truncates large prompts)", "--verbatim", ARGV);
  // When the table names a model, the CLI is told it.
  has("grok is told the slot's pinned model", "grok-4.7", ARGV);
  eq("and told it as -m", "-m", lineBefore(ARGV, "grok-4.7"));

  // --verbatim alone is not enough: 1.0.0's default system prompt makes it a
  // planning agent and its default effort resolves to xhigh, both of which
  // self-cancel on a large prompt (8/8). All three or none.
  has("grok run pins reasoning effort (default xhigh self-cancels)", "--reasoning-effort", ARGV);
  has("grok run overrides the agent system prompt", "--system-prompt-override", ARGV);
  lacks("grok prompt text is not on argv", "review this artifact", ARGV);
  // Without --verbatim the CLI truncates a large --prompt-file and offloads the
  // remainder to a file, forcing an agent loop whose narration lands in `.text`.
  // On this path that means a review returning first-turn narration and no
  // findings, which reads exactly like a clean pass.
  has("grok run sends the prompt verbatim", "--verbatim", ARGV);
  // Planning off on every grok call: the CLI's own --no-plan.
  has("grok run disables plan mode", "--no-plan", ARGV);
});

// ── The repo-reading Grok invocation (code review, SPEC audit) ─────────
//
// Off `dontAsk` too: that mode cancels repo-reading agent runs, and runs that
// call no tool at all, so no Grok path keeps it. The allowlist is the caller's and must
// arrive intact — under bypassPermissions it is the only scoping enforced.
test("the repo-reading grok invocation, and the pinned models", () => {
  rmSync(`${TMP}/argv.txt`, { force: true });
  const r = run("one-slot", PROMPT, {
    POLICY_CHAIN_GROK_TOOLS: "read_file,list_dir,grep",
    GROK_BIN: `${TMP}/record-args.sh`,
  });
  rcIs("repo-reading case ran", 0, r.rc);
  let ARGV = read(`${TMP}/argv.txt`);
  has("grok repo-reading run uses bypassPermissions", "bypassPermissions", ARGV);
  lacks("grok repo-reading run never uses dontAsk", "dontAsk", ARGV);
  eq("grok repo-reading run carries the caller's allowlist", "read_file,list_dir,grep", lineAfter(ARGV, "--tools"));
  lacks("grok repo-reading run carries no unenforced denylist", "--disallowed-tools", ARGV);
  has("grok repo-reading run takes no web hop", "--disable-web-search", ARGV);

  rmSync(`${TMP}/argv.txt`, { force: true });
  run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/record-args.sh` });
  ARGV = read(`${TMP}/argv.txt`);
  eq("codex is told the slot's pinned model as -m", "-m", lineBefore(ARGV, "gpt-6-sol"));
});

test("an unpinned slot runs the CLI default; an unresolvable one is refused", () => {
  // A slot with no pin runs the CLI's own default model: no -m at all.
  rmSync(`${TMP}/argv.txt`, { force: true });
  const a = run("unpinned", PROMPT, { CODEX_BIN: `${TMP}/record-args.sh`, GROK_BIN: `${TMP}/say-grok.sh` });
  rcIs("an unpinned slot runs", 0, a.rc);
  const ARGV = read(`${TMP}/argv.txt`);
  has("the unpinned codex slot ran", "exec", ARGV);
  lacks("and was given no model flag", "-m", ARGV);

  // A family that does not resolve is refused: named, not run, and the chain
  // walks on.
  rmSync(`${TMP}/argv.txt`, { force: true });
  const b = run("unresolvable", PROMPT, { CODEX_BIN: `${TMP}/record-args.sh`, GROK_BIN: `${TMP}/say-grok.sh` });
  rcIs("an unresolvable family does not end the chain", 0, b.rc);
  has("the unresolvable family is named", "could not resolve unresolvable-{v}", b.err);
  eq("its backup answered", "[must-fix] from grok", b.out);
  assert.ok(!existsSync(`${TMP}/argv.txt`), "the unresolvable codex slot was run anyway");
});

test("the DEFAULT resolver has no catalog: an exact id passes, a family is refused", () => {
  const EXACT = `${TMP}/exact.json`;
  writeFileSync(
    EXACT,
    `{ "rows": {
  "exact": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-6-sol" }] },
  "family": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "" }] }
} }
`,
  );
  rmSync(`${TMP}/argv.txt`, { force: true });
  run("exact", PROMPT, { POLICY_JSON: EXACT, POLICY_CHAIN_RESOLVER: "", CODEX_BIN: `${TMP}/record-args.sh` });
  eq("the default resolver passes an exact id as -m", "-m", lineBefore(read(`${TMP}/argv.txt`), "gpt-6-sol"));
  rmSync(`${TMP}/argv.txt`, { force: true });
  const r = run("family", PROMPT, {
    POLICY_JSON: EXACT,
    POLICY_CHAIN_RESOLVER: "",
    CODEX_BIN: `${TMP}/record-args.sh`,
    GROK_BIN: `${TMP}/say-grok.sh`,
  });
  has("the default resolver refuses a family", "needs a resolver", r.err);
  eq("and the chain walks on", "[must-fix] from grok", r.out);
  assert.ok(!existsSync(`${TMP}/argv.txt`), "the family codex slot was run anyway");
});

test("the author leaves a review row", () => {
  // `.agents/harness` records `agent=` — the family that writes the code. A
  // review row (`.chain`) skips that vendor; a panel (`.voices`) keeps it; the
  // claude slot is never skipped, because it means "dispatch your own agent".
  const HARNESS = `${TMP}/harness`;
  writeFileSync(HARNESS, "harness=t3\nagent=codex\n");
  let r = run("adversarial-review", PROMPT, {
    CONTEXTIUM_HARNESS_FILE: HARNESS,
    CODEX_BIN: `${TMP}/say-codex.sh`,
    GROK_BIN: `${TMP}/say-grok.sh`,
  });
  rcIs("author skip: the row still answers", 0, r.rc);
  eq("author skip: codex wrote the code, so grok reviews", "[must-fix] from grok", r.out);
  has("author skip: it says why", "codex left out of 'adversarial-review': it wrote the code", r.err);
  r = run("panel", PROMPT, { CONTEXTIUM_HARNESS_FILE: HARNESS, CODEX_BIN: `${TMP}/say-codex.sh` });
  eq("author skip: a panel keeps the author's seat", "[must-fix] from codex", r.out);

  writeFileSync(HARNESS, "agent=grok\n");
  r = run("one-slot", PROMPT, { CONTEXTIUM_HARNESS_FILE: HARNESS, GROK_BIN: `${TMP}/say-grok.sh` });
  rcIs("author skip: a row holding only the author exhausts", 1, r.rc);

  writeFileSync(HARNESS, "agent=claude\n");
  r = run("claude-tail", PROMPT, { CONTEXTIUM_HARNESS_FILE: HARNESS, CODEX_BIN: `${STUBS}/stub-fail.ts` });
  rcIs("author skip: the claude slot still returns 3", 3, r.rc);

  writeFileSync(HARNESS, "agent=antigravity\n");
  const G = `${TMP}/gemini.json`;
  writeFileSync(
    G,
    '{ "rows": { "r": { "mode": "single", "chain": [{ "vendor": "gemini", "model": "gemini", "tracks": "" }, { "vendor": "codex", "model": "codex", "tracks": "" }] } } }\n',
  );
  r = run("r", PROMPT, { POLICY_JSON: G, CONTEXTIUM_HARNESS_FILE: HARNESS, CODEX_BIN: `${TMP}/say-codex.sh` });
  has("author skip: antigravity is the gemini family", "gemini left out of 'r'", r.err);

  for (const a of ["cursor", "copilot"]) {
    writeFileSync(HARNESS, `agent=${a}\n`);
    r = run("adversarial-review", PROMPT, { CONTEXTIUM_HARNESS_FILE: HARNESS, CODEX_BIN: `${TMP}/say-codex.sh` });
    eq(`author skip: agent=${a} names no family, nothing skipped`, "[must-fix] from codex", r.out);
  }
  r = run("adversarial-review", PROMPT, {
    CONTEXTIUM_HARNESS_FILE: `${TMP}/no-such-harness`,
    CODEX_BIN: `${TMP}/say-codex.sh`,
  });
  eq("author skip: no harness file, the row as written", "[must-fix] from codex", r.out);
});

test("Contextium: a review row with every vendor unavailable falls back", () => {
  // A row marked `"fallback": "fresh-context"` returns 3 — the caller dispatches
  // a fresh-context agent of its own and records it as NOT independent — instead
  // of the plain exhaustion a row without the mark keeps.
  const FB = `${TMP}/fallback.json`;
  writeFileSync(
    FB,
    `{ "rows": {
  "fb": { "mode": "single", "fallback": "fresh-context", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "" }, { "vendor": "grok", "model": "grok", "tracks": "" }] },
  "nofb": { "mode": "single", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "" }] }
} }
`,
  );
  let r = run("fb", PROMPT, {
    POLICY_JSON: FB,
    CODEX_BIN: `${TMP}/nonexistent-binary`,
    GROK_BIN: `${TMP}/nonexistent-binary`,
  });
  rcIs("fallback row, every vendor absent: 3", 3, r.rc);
  has("…and it says the review is NOT independent", "fresh-context review, NOT independent", r.err);
  r = run("fb", PROMPT, { POLICY_JSON: FB, CODEX_BIN: `${STUBS}/stub-fail.ts`, GROK_BIN: `${STUBS}/stub-fail.ts` });
  rcIs("fallback row, every vendor failing: 3", 3, r.rc);
  r = run("fb", PROMPT, { POLICY_JSON: FB, CODEX_BIN: `${STUBS}/stub-hang.ts`, GROK_BIN: `${STUBS}/stub-hang.ts` });
  rcIs("fallback row, every vendor timing out: 3", 3, r.rc);
  r = run(
    "fb",
    PROMPT,
    { POLICY_JSON: FB, CODEX_BIN: `${TMP}/say-prose.sh`, GROK_BIN: `${TMP}/say-prose.sh` },
    wantsFinding,
  );
  rcIs("fallback row, vendors alive but wrong-shaped: still 125", 125, r.rc);
  r = run("fb", PROMPT, { POLICY_JSON: FB, CODEX_BIN: `${TMP}/say-codex.sh` });
  rcIs("fallback row, a vendor answers: 0", 0, r.rc);
  r = run("nofb", PROMPT, { POLICY_JSON: FB, CODEX_BIN: `${TMP}/nonexistent-binary` });
  rcIs("a row without the mark keeps plain exhaustion", 1, r.rc);
  const shipped = JSON.parse(readFileSync(join(SCRIPT_DIR, "policy.json"), "utf8")) as {
    rows: Record<string, { fallback?: string }>;
  };
  eq(
    "the shipped review rows carry the mark; panel and investigation do not",
    "adversarial-review judgment",
    Object.entries(shipped.rows)
      .filter(([, row]) => row.fallback === "fresh-context")
      .map(([k]) => k)
      .join(" "),
  );
});

test("a slot is capped even with no `timeout` on PATH (stock macOS)", () => {
  // The walk's clock is its own, so a PATH holding no coreutils `timeout` still
  // ends a hang in 124. PATH keeps only what the stubs need to start.
  const NOTIMEOUT = `${TMP}/notimeout`;
  mkdirSync(NOTIMEOUT, { recursive: true });
  for (const b of ["bash", "env", "cat", "sleep"]) {
    const w = spawnSync("bash", ["-c", `command -v ${b}`], { encoding: "utf8" }).stdout.trim();
    if (w.startsWith("/") && !existsSync(`${NOTIMEOUT}/${b}`)) symlinkSync(w, `${NOTIMEOUT}/${b}`);
  }
  symlinkSync(process.execPath, `${NOTIMEOUT}/node`);
  const r = run("adversarial-review", PROMPT, {
    PATH: NOTIMEOUT,
    POLICY_CHAIN_SLOT_TIMEOUT_S: "2",
    CODEX_BIN: `${STUBS}/stub-hang.ts`,
    GROK_BIN: `${STUBS}/stub-hang.ts`,
  });
  rcIs("no timeout binary: a hang still ends in 124", 124, r.rc);
  has("no timeout binary: the hang is named as a timeout", "codex timed out after 2s", r.err);
});

test("a vendor's unterminated final line still reaches the caller", () => {
  // Every caller parses stdout line by line, and a `while read` parse drops a
  // final line that has no newline — silently losing the last finding of a
  // review. Read the raw stream here, not the trimmed one, and take the last
  // COMPLETE line.
  const chunks: Buffer[] = [];
  withEnv({ CODEX_BIN: `${TMP}/no-trailing-newline.sh` }, () =>
    policyRunChain("adversarial-review", PROMPT, {
      sink: { out: (c) => chunks.push(Buffer.from(c)), err: () => {} },
    }),
  );
  const complete = Buffer.concat(chunks).toString("utf8").split("\n");
  complete.pop();
  eq(
    "an unterminated last line survives a read loop",
    "[nit] last line with no newline",
    complete[complete.length - 1] ?? "",
  );
});

// ── The shape test: a wrong-shaped answer is a FAILED slot ────────────
//
// A slot used to be banked on `rc == 0` alone, so a vendor that answered with
// prose instead of the findings the caller asked for spent the whole chain —
// both callers parse afterwards, outside the walk, where a rejection can no
// longer reach the untried backup.

// Accepts only output carrying a finding line, which is the shape both reviewer
// gates actually need. Written as a FUNCTION because that is the shape the real
// callers use.
const wantsFinding: Validator = (f) => ({ rc: /^\[/m.test(readFileSync(f, "utf8")) ? 0 : 1, stderr: "" });
const rejectAll: Validator = () => ({ rc: 1, stderr: "nothing here looks like a review\n" });
// A command validator that prints to stdout, both verdicts: the walk must
// throw that stream away.
exe(`${TMP}/chatty-reject.sh`, "#!/usr/bin/env bash\necho STDOUT-FROM-VALIDATOR\nexit 1\n");
exe(`${TMP}/chatty-accept.sh`, "#!/usr/bin/env bash\necho STDOUT-FROM-VALIDATOR\nexit 0\n");
mkstub(`${TMP}/say-prose.sh`, 'echo "Sure, I can help you review that."');

test("the shape test", () => {
  // Unset → today's behavior, byte for byte.
  let r = run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh` });
  rcIs("validator unset changes nothing", 0, r.rc);
  eq("validator unset returns the answer", "[must-fix] from codex", r.out);

  // Slot 1 answers in the wrong shape → the chain walks to slot 2.
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${TMP}/say-prose.sh`, GROK_BIN: `${TMP}/say-grok.sh` },
    wantsFinding,
  );
  rcIs("a wrong-shaped primary falls through", 0, r.rc);
  has("the rejection is named", "codex answered in the wrong shape", r.err);
  has("the backup answered", "answered: grok/grok", r.err);
  eq("the backup's answer reaches stdout", "[must-fix] from grok", r.out);

  // Every slot wrong-shaped → exhaustion, and 125 rather than a bare 1: every
  // vendor was alive and answered, so a caller with its own re-ask should spend
  // it here. A dead chain (rc 1) has nobody left to ask and must not be re-walked.
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${TMP}/say-prose.sh`, GROK_BIN: `${TMP}/say-prose.sh` },
    wantsFinding,
  );
  rcIs("every slot wrong-shaped exhausts as 125, not 1", 125, r.rc);
  eq("an exhausted-on-shape chain emits nothing", "", r.out);
  eq("one rejection line per slot", 2, count(r.err, "answered in the wrong shape"));
  has("exhaustion is still named", "every vendor in the 'adversarial-review' chain failed", r.err);

  // ...and a chain that exhausted for a NON-shape reason still returns 1, so the
  // two are actually distinguishable rather than both collapsing to "exhausted".
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${STUBS}/stub-fail.ts`, GROK_BIN: `${STUBS}/stub-fail.ts` },
    wantsFinding,
  );
  rcIs("a dead chain is still a plain exhaustion", 1, r.rc);

  // A primary rejected on shape with a DEAD backup behind it still earns 125.
  // The re-ask re-walks the whole chain, so the narrating primary is recoverable
  // — and this compound case (primary narrates, backup down) is the one where the
  // re-ask matters most. Keying on the LAST slot would have withheld it here.
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${TMP}/say-prose.sh`, GROK_BIN: `${STUBS}/stub-fail.ts` },
    wantsFinding,
  );
  rcIs("shape-then-dead still earns the re-ask", 125, r.rc);

  // A timeout still wins the classification: callers map 124 to its own fatal
  // message, and that must not change because a shape test is now in play.
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${TMP}/say-prose.sh`, GROK_BIN: `${STUBS}/stub-hang.ts` },
    wantsFinding,
  );
  rcIs("a timeout still classifies as 124", 124, r.rc);

  // The validator's stderr is the reason, quoted into the diagnostic.
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${TMP}/say-codex.sh`, GROK_BIN: `${TMP}/say-grok.sh` },
    rejectAll,
  );
  has("the validator's stderr becomes the reason", "nothing here looks like a review", r.err);

  // THE contract that protects the answer stream: a validator's stdout must never
  // reach the caller's, which is parsed as findings. Asserted on both verdicts —
  // an accepting validator is the sneakier of the two, because its noise would be
  // prepended to a REAL review rather than to nothing.
  r = run(
    "adversarial-review",
    PROMPT,
    { CODEX_BIN: `${TMP}/say-codex.sh`, GROK_BIN: `${TMP}/say-grok.sh` },
    `${TMP}/chatty-reject.sh`,
  );
  lacks("a rejecting validator's stdout stays out of the answer", "STDOUT-FROM-VALIDATOR", r.out);
  r = run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh` }, `${TMP}/chatty-accept.sh`);
  eq("an accepting validator's stdout stays out of the answer", "[must-fix] from codex", r.out);

  // An UNRUNNABLE validator is a caller error, and it is caught before any vendor
  // is invoked. Defaulting it to "accept" would silently reinstate the hole.
  rmSync(`${TMP}/argv.txt`, { force: true });
  r = run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/record-args.sh` }, "_no_such_validator_anywhere");
  rcIs("an unrunnable validator is a caller error", 2, r.rc);
  has("it names the validator", "_no_such_validator_anywhere", r.err);
  assert.ok(!existsSync(`${TMP}/argv.txt`), "a vendor was invoked before the unrunnable validator was caught");
});

test("the environment's validator never survives the call, and never reaches a vendor", () => {
  // It must not bleed into the NEXT call in the same process — one gate's
  // contract applied to another gate's answer is worse than no contract at all.
  exe(`${TMP}/reject-all.sh`, '#!/usr/bin/env bash\necho "nothing here looks like a review" >&2\nexit 1\n');
  process.env.POLICY_CHAIN_VALIDATOR = `${TMP}/reject-all.sh`;
  withEnv({ CODEX_BIN: `${TMP}/say-codex.sh`, GROK_BIN: `${TMP}/say-grok.sh` }, () =>
    policyRunChain("adversarial-review", PROMPT, { out: `${TMP}/bleed.out`, sink: { err: () => {} } }),
  );
  eq("the validator does not survive the call", "", process.env.POLICY_CHAIN_VALIDATOR ?? "");

  // ...so the next call is unvalidated, which is what "opt-in" means.
  const r = run("adversarial-review", PROMPT, { CODEX_BIN: `${TMP}/say-codex.sh` });
  rcIs("the next call runs unvalidated", 0, r.rc);
  eq("and returns its answer", "[must-fix] from codex", r.out);

  // Never passed on: a name left in the environment lands in the environment of
  // every vendor CLI the walk spawns, and in any nested call. Stripped even when
  // the CALLER exported it, because documenting "do not export this" does not
  // stop anyone.
  mkstub(`${TMP}/record-env.sh`, `env > '${TMP}/env.txt'; printf '{"text":"[must-fix] ok"}\\n'`);
  exe(`${TMP}/wants-finding.sh`, "#!/usr/bin/env bash\ngrep -q '^\\[' \"$1\"\n");
  rmSync(`${TMP}/env.txt`, { force: true });
  process.env.POLICY_CHAIN_VALIDATOR = `${TMP}/wants-finding.sh`;
  const errs: string[] = [];
  withEnv({ GROK_BIN: `${TMP}/record-env.sh` }, () =>
    policyRunChain("one-slot", PROMPT, { out: `${TMP}/env-case.out`, sink: { err: (l) => errs.push(l) } }),
  );
  has("an exported validator still runs", "answered: grok/grok", errs.join("\n"));
  lacks("it is stripped from the vendor's environment", "POLICY_CHAIN_VALIDATOR", read(`${TMP}/env.txt`));
  eq("and it is gone afterwards", "", process.env.POLICY_CHAIN_VALIDATOR ?? "");

  // Belt and braces: nothing below this line may inherit a shape test. The
  // code-review.ts cases run it as a SUBPROCESS, which would see one.
  delete process.env.POLICY_CHAIN_VALIDATOR;
});

// ── Caller-scoped rows, through code-review.ts ────────────────────────
//
// 13 (max diff refused, never truncated), 15 (--fixture), plus the § 5
// acceptance behaviors: fall-through on a dead primary, on a hung primary, and
// a hard failure on exhaustion. BOTH bins are stubbed in every case — overriding
// only CODEX_BIN would send the backup hop to a live grok, which is the opposite
// of deterministic.

const REVIEW = join(SCRIPT_DIR, "code-review.ts");
const FIXTURE = `${SCRIPT_DIR}/tests/fixtures/planted-bugs`;

function review(args: string[], env: Record<string, string> = {}): { rc: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", REVIEW, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 300_000,
    maxBuffer: 1 << 26,
  });
  return { rc: r.status, out: r.stdout.replace(/\n+$/, ""), err: r.stderr };
}

test("code-review.ts: caller-scoped rows", () => {
  // 15 + acceptance 2 — dead primary, backup answers, fixture mode intact.
  let r = review(["--fixture", FIXTURE], { CODEX_BIN: `${STUBS}/stub-fail.ts`, GROK_BIN: `${STUBS}/stub-clean.ts` });
  rcIs("cr: dead primary falls through to the backup", 0, r.rc);
  has("cr: the fall-through is named on stderr", "trying next slot", r.err);
  has("cr: the answering vendor is named on stderr", "answered: grok", r.err);
  eq("cr: a clean review prints no findings", "", r.out);

  // acceptance 3 — hung primary falls through (this used to be a hard 124).
  r = review(["--fixture", FIXTURE], {
    CODEX_BIN: `${STUBS}/stub-hang.ts`,
    GROK_BIN: `${STUBS}/stub-clean.ts`,
    POLICY_CHAIN_SLOT_TIMEOUT_S: "5",
  });
  rcIs("cr: hung primary falls through", 0, r.rc);

  // acceptance 4 — exhaustion is a failure, never a pass.
  r = review(["--fixture", FIXTURE], { CODEX_BIN: `${STUBS}/stub-fail.ts`, GROK_BIN: `${STUBS}/stub-fail.ts` });
  rcIs("cr: exhaustion fails", 1, r.rc);
  has("cr: exhaustion names the row", "every vendor in the 'adversarial-review' chain failed", r.err);

  // 9 — a slot that exits 0 with an empty body is NOT a clean review.
  r = review(["--fixture", FIXTURE], { CODEX_BIN: `${STUBS}/stub-empty.ts`, GROK_BIN: `${STUBS}/stub-empty.ts` });
  rcIs("cr: empty output with no sentinel is a FAILED review", 1, r.rc);

  // 9b — narration-only is RE-ASKED, not failed. A slot that exits 0 saying
  // only "I'll review the diff..." looks like success to the chain, so the walk
  // stops and the backup never runs; without the re-ask the caller gets a FAILED
  // review for work the vendor was willing to do.
  r = review(["--fixture", FIXTURE], {
    STUB_NARRATE_STATE: `${TMP}/narrate-state`,
    CODEX_BIN: `${STUBS}/stub-narrate-then-answer.ts`,
    GROK_BIN: `${STUBS}/stub-fail.ts`,
  });
  rcIs("cr: narration-only is re-asked, not failed", 0, r.rc);
  has("cr: the re-ask's findings reach stdout", "a real finding on the re-ask", r.out);
  has("cr: the re-ask is announced on stderr", "re-asking once", r.err);

  // 9c — the re-ask is ONE re-ask. A vendor that narrates twice is a failed
  // review, not an infinite retry loop on a vendor that will never answer.
  r = review(["--fixture", FIXTURE], { CODEX_BIN: `${STUBS}/stub-prose.ts`, GROK_BIN: `${STUBS}/stub-prose.ts` });
  rcIs("cr: narration on both attempts is a FAILED review", 1, r.rc);
  has("cr: the failure says both attempts were spent", "on two attempts", r.err);

  // 13 — a diff over the byte budget is REFUSED, not truncated.
  //
  // The range is SEARCHED, not spelled `HEAD~1 HEAD`. That spelling asserted
  // something about the repo's history rather than about the code: a session
  // whose last commit was empty — a trailer-only commit, say — got "the diff is
  // empty, nothing was reviewed" and this case failed for a reason with nothing
  // to do with the byte budget.
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", REPO_ROOT, ...a], { encoding: "utf8" }).stdout.replace(/\n+$/, "");
  const head = git("rev-parse", "HEAD");
  let base = head;
  for (const c of git("rev-list", "--max-count=20", "HEAD").split("\n")) {
    if (git("diff", "--name-only", c, head) !== "") {
      base = c;
      break;
    }
  }
  r = review([base, head], {
    CODEX_BIN: `${STUBS}/stub-clean.ts`,
    GROK_BIN: `${STUBS}/stub-clean.ts`,
    CODEX_REVIEW_MAX_DIFF_BYTES: "10",
  });
  rcIs("cr: an over-budget diff is refused", 1, r.rc);
  has("cr: refusal says why", "Refusing rather than reviewing a truncated slice", r.err);

  // Contextium: every vendor unavailable on a fallback-marked row is exit 3,
  // and the message names the fresh-context reviewer and the line to record.
  const FBR = `${TMP}/fallback-review.json`;
  writeFileSync(
    FBR,
    '{ "rows": { "adversarial-review": { "mode": "single", "fallback": "fresh-context", "chain": [{ "vendor": "codex", "model": "codex", "tracks": "" }, { "vendor": "grok", "model": "grok", "tracks": "" }] } } }\n',
  );
  r = review(["--fixture", FIXTURE], {
    POLICY_JSON: FBR,
    CODEX_BIN: `${TMP}/nonexistent-binary`,
    GROK_BIN: `${TMP}/nonexistent-binary`,
  });
  rcIs("cr: no vendor available on a fallback row is exit 3", 3, r.rc);
  has("cr: it names the fresh-context reviewer", "implement-audit-reviewer", r.err);
  has("cr: it names the line to record", "claude-fallback (fresh context, NOT independent)", r.err);

  // 2 (caller-error half) — bad arity stays a caller error.
  r = review([]);
  rcIs("cr: bad arity is a caller error", 2, r.rc);
});
