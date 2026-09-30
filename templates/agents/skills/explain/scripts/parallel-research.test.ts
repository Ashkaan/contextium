// Tests for parallel-research.ts: seats are the `panel` row of the review
// skill's policy.json, run through /debate's dispatch-agents.ts (its flags, its
// timeout, its stand-ins), and the summary it prints at 3 / 2 / 0 voices, on a
// failure, on a timeout and on bad input. Stub CLIs on PATH stand in for the
// real ones; a fixture panel pins which vendor sits in which seat.
//
// The program is SPAWNED, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/explain/scripts/parallel-research.test.ts
//
// peers: parallel-research.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "parallel-research.ts");

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "parallel-research-test-"));
  made.push(d);
  return d;
}

function which(bin: string): string | undefined {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(d, bin);
    if (d !== "" && existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

// Only the system tools the stubs need, linked one by one: a real claude, codex
// or grok in /usr/bin would otherwise answer a seat the stubs own. `timeout` /
// `gtimeout` are linked when the host has them; the dispatcher's own watchdog
// covers a host without.
const SYS = scratch();
for (const t of ["sh", "bash", "env", "sleep", "printf", "echo", "cat", "timeout", "gtimeout"]) {
  const p = which(t);
  if (p) symlinkSync(p, join(SYS, t));
}

function writeExe(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A fresh, empty stub dir. */
const bin = scratch;

// A stub answers with the prompt it was given, prefixed with its name. The
// dispatcher passes the prompt as an argument: after `-p` for grok, last for
// claude and codex.
function stub(dir: string, name: string): void {
  writeExe(
    join(dir, name),
    name === "grok"
      ? '#!/bin/sh\necho "grok says: $2"\n'
      : `#!/bin/sh\nfor a; do :; done\necho "${name} says: $a"\n`,
  );
}
const failing = (dir: string, name: string): void => writeExe(join(dir, name), "#!/bin/sh\nexit 7\n");
const slow = (dir: string, name: string): void => writeExe(join(dir, name), "#!/bin/sh\nsleep 5\necho late\n");

// The fixture panel. Seat order is the table's, so a table that puts codex
// first puts codex on H1 — the case that proves the seats come from the table.
function panel(...vendors: string[]): string {
  const p = join(scratch(), "policy.json");
  writeFileSync(
    p,
    `${JSON.stringify({ rows: { panel: { voices: vendors.map((v) => ({ vendor: v, model: v, tracks: "" })) } } })}\n`,
  );
  return p;
}

interface Run {
  rc: number | null;
  out: string;
  err: string;
}

// The PATH is the stubs plus the linked system tools, nothing else.
function run(stubs: string, policy: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: `${stubs}${delimiter}${SYS}`, HOME: "/tmp", DEBATE_POLICY_JSON: policy },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

test("two of three panel CLIs installed: the missing one's seat is argued by another", () => {
  const b = bin();
  stub(b, "claude");
  stub(b, "codex");
  const r = run(b, panel("claude", "codex", "grok"), "--h1", "is it the cache", "--h2", "is it the clock", "--h3", "is it the config");
  assert.equal(r.rc, 0, r.out + r.err);
  assert.ok(r.out.includes("=== H1 (claude)"), `seat 1 is the panel's first voice: ${r.out}`);
  assert.ok(r.out.includes("claude says: is it the cache"), "…with the hypothesis it was given");
  assert.ok(r.out.includes("codex says: is it the clock"), "seat 2 is the panel's second voice");
  assert.ok(r.out.includes("claude says: is it the config"), "seat 3's missing voice is stood in for");
  assert.ok(r.out.includes("stood in for grok"), "…and the block says so");
  assert.ok(r.out.includes("SUMMARY: 3 OK, 0 FAIL, 0 TIMEOUT"), `summary: ${r.out}`);
  assert.ok(r.err.includes("[voices] explain"), `a thin panel is said once: ${r.err}`);
});

test("the seats are the table's, in the table's order", () => {
  const b = bin();
  for (const v of ["claude", "codex", "grok"]) stub(b, v);
  const r = run(b, panel("codex", "grok", "claude"), "--h1", "a", "--h2", "b", "--h3", "c");
  assert.equal(r.rc, 0, r.out + r.err);
  assert.ok(r.out.includes("=== H1 (codex)"), `H1 is the table's first voice: ${r.out}`);
  assert.ok(r.out.includes("claude says: c"), "H3 is the table's third voice");
  assert.ok(!r.err.includes("[voices]"), `a full panel is not called thin: ${r.err}`);
});

test("a stand-in that fails too leaves that seat a FAIL, with the others intact", () => {
  const b = bin();
  stub(b, "codex");
  failing(b, "grok");
  const ran = join(b, "claude.ran");
  writeExe(join(b, "claude"), `#!/bin/sh\nif [ -e '${ran}' ]; then exit 3; fi\n: > '${ran}'\necho "claude says: first"\n`);
  const r = run(b, panel("claude", "codex", "grok"), "--h1", "a", "--h2", "b", "--h3", "c");
  assert.equal(r.rc, 0, r.out + r.err);
  assert.ok(r.out.includes("=== H3 (grok) — FAIL"), `the failing seat is reported: ${r.out}`);
  assert.ok(r.out.includes("SUMMARY: 2 OK, 1 FAIL, 0 TIMEOUT"), `summary counts it: ${r.out}`);
});

test("a timed-out seat is a TIMEOUT; seats with no CLI and no stand-in are MISSING", () => {
  const b = bin();
  slow(b, "codex");
  const r = run(b, panel("claude", "codex", "grok"), "--h1", "a", "--h2", "b", "--h3", "c", "--timeout", "1");
  assert.equal(r.rc, 1, r.out + r.err);
  assert.ok(r.out.includes("=== H2 (codex) — TIMEOUT after 1s"), `the slow seat timed out: ${r.out}`);
  assert.ok(r.out.includes("=== H1 (claude) — MISSING"), "the uninstalled seat is missing");
  assert.ok(r.out.includes("SUMMARY: 0 OK, 2 FAIL, 1 TIMEOUT"), `summary counts both: ${r.out}`);
});

test("no panel CLI installed at all is an error that says what it looked for", () => {
  const r = run(bin(), panel("claude", "codex", "grok"), "--h1", "a", "--h2", "b", "--h3", "c");
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes("no model CLI found on PATH (looked for: claude codex grok)"), r.err);
});

test("no policy table where the review skill keeps it is an error naming the path", () => {
  const b = bin();
  stub(b, "claude");
  const absent = join(scratch(), "absent.json");
  const r = run(b, absent, "--h1", "a", "--h2", "b", "--h3", "c");
  assert.equal(r.rc, 1);
  assert.ok(r.err.includes(`policy.json not found at ${absent}`), r.err);
});

test("a missing hypothesis or a timeout outside 1-600 is a caller error", () => {
  const b = bin();
  stub(b, "claude");
  const pol = panel("claude", "codex", "grok");
  assert.equal(run(b, pol, "--h1", "a", "--h2", "b").rc, 2);
  assert.equal(run(b, pol, "--h1", "a", "--h2", "b", "--h3", "c", "--timeout", "0").rc, 2);
});

test("the per-vendor flags live in one place: /debate's dispatcher", () => {
  const src = readFileSync(SUT, "utf8");
  assert.doesNotMatch(src, /codex exec|--output-format|--approval-mode/, "parallel-research.ts keeps its own copy of a CLI's flags");
  assert.doesNotMatch(src, /voices\.sh|reviewer-chain\.sh/, "parallel-research.ts still names the retired voices.sh / reviewer-chain.sh");
});

test("research seats: the grok seat is dispatched with read + search tools", () => {
  const b = bin();
  stub(b, "claude");
  stub(b, "codex");
  const argvFile = join(b, "grok-argv");
  writeExe(join(b, "grok"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\necho "grok says: done"\n`);
  run(b, panel("claude", "codex", "grok"), "--h1", "a", "--h2", "b", "--h3", "c");
  const flat = existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").join(" ") : "";
  assert.ok(flat.includes("--tools read_file,list_dir,grep"), `the grok research seat can read the repo: ${flat}`);
  assert.ok(!flat.includes("--disable-web-search"), `…and can search the web: ${flat}`);
});
