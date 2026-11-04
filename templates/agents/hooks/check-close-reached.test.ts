// Tests for check-close-reached.sh, the end-of-turn hook wrapper.
//
// Run: node --test --experimental-strip-types .agents/hooks/check-close-reached.test.ts
//
// The wrapper is SPAWNED with bash, a payload on stdin. One case runs the real
// check behind it end to end; the others copy the wrapper into a scratch tree
// of the same shape (.agents/hooks/ beside .agents/skills/close/scripts/) whose
// end-of-turn.ts is missing, crashes or hangs, since those are the wrapper's
// own paths.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "check-close-reached.sh");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "close-reached-test-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));

interface Run {
  rc: number | null;
  out: string;
  err: string;
}

function run(hook: string, stdin: string, home: string, env: NodeJS.ProcessEnv = {}, ...args: string[]): Run {
  const r = spawnSync("bash", [hook, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...env },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

/** A scratch tree holding a copy of the wrapper and its bounded runner
 *  (lib/paths.sh, unless `lib` is false) and, unless `check` is null, an
 *  end-of-turn.ts with that body. */
function tree(check: string | null, lib = true): { hook: string; home: string } {
  const d = mkdtempSync(join(ROOT, "tree-"));
  mkdirSync(join(d, ".agents", "hooks", "lib"), { recursive: true });
  mkdirSync(join(d, ".agents", "skills", "close", "scripts"), { recursive: true });
  copyFileSync(HOOK, join(d, ".agents", "hooks", "check-close-reached.sh"));
  if (lib) copyFileSync(join(dirname(HOOK), "lib", "paths.sh"), join(d, ".agents", "hooks", "lib", "paths.sh"));
  if (check !== null) writeFileSync(join(d, ".agents", "skills", "close", "scripts", "end-of-turn.ts"), check);
  return { hook: join(d, ".agents", "hooks", "check-close-reached.sh"), home: join(d, "home") };
}
const logOf = (home: string): string => {
  const f = join(home, ".cache", "workbench", "end-of-turn.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

test("the real check behind it: a refusal passes through as exit 2 with the reason; an allow as exit 0", () => {
  const home = join(ROOT, "real-home");
  const tid = "11111111-2222-3333-4444-555555555555";
  const state = join(home, ".cache", "workbench", "threads", tid);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "closed"), "");
  writeFileSync(join(state, "report"), "**Shipped:** x\n\norigin/main is at abc — closing this tab loses nothing.\n");
  const cwd = mkdtempSync(join(ROOT, "cwd-"));
  const payload = (reply: string) =>
    JSON.stringify({ cwd, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: reply });
  const env = { WORKBENCH_THREAD_ID: tid };
  const refused = run(HOOK, payload("Done."), home, env, "--harness", "claude");
  assert.equal(refused.rc, 2, refused.err);
  assert.match(refused.err, /Paste the close report \(saved at .*report\) verbatim/);
  const allowed = run(
    HOOK,
    payload("origin/main is at abc — closing this tab loses nothing."),
    home,
    env,
    "--harness",
    "claude",
  );
  assert.equal(allowed.rc, 0, allowed.err);
  assert.equal(run(HOOK, payload("Done."), home, env).rc, 0, "no --harness: allowed");
});

test("a missing check: allowed, said on stderr and logged", () => {
  const t = tree(null);
  const r = run(t.hook, "{}", t.home, {}, "--harness", "claude");
  assert.equal(r.rc, 0);
  assert.match(r.err, /end-of-turn check: missing: .*end-of-turn\.ts; reply allowed/);
  assert.match(logOf(t.home), /check-close-reached\.sh: missing: /);
});

test("a check that crashes: allowed and logged with its exit", () => {
  const t = tree("process.exit(7);\n");
  const r = run(t.hook, "{}", t.home, {}, "--harness", "claude");
  assert.equal(r.rc, 0);
  assert.match(logOf(t.home), /exited 7; allowed/);
});

test("a check past the bound is stopped: allowed and logged", () => {
  const t = tree("setTimeout(() => {}, 60_000);\n");
  const started = Date.now();
  const r = run(t.hook, "{}", t.home, { END_OF_TURN_TIMEOUT: "1" }, "--harness", "claude");
  assert.equal(r.rc, 0);
  assert.ok(Date.now() - started < 10_000, "stopped at the bound");
  assert.match(logOf(t.home), /stopped after 1s; allowed/);
});

// A PATH whose timeout and gtimeout are missing, as on a stock macOS: each
// stub exits 127, the shell's "command not found". The wrapper used to call
// `timeout` directly, and that 127 became an allowed reply with the check never run.
const NO_TIMEOUT = join(ROOT, "no-timeout-bin");
mkdirSync(NO_TIMEOUT, { recursive: true });
for (const t of ["timeout", "gtimeout"]) {
  writeFileSync(join(NO_TIMEOUT, t), "#!/bin/sh\nexit 127\n");
  chmodSync(join(NO_TIMEOUT, t), 0o755);
}
const NO_TIMEOUT_ENV = { PATH: NO_TIMEOUT + ":" + (process.env.PATH ?? "") };

test("with no timeout command, the check still runs: its refusal, reading the payload on stdin, passes through", () => {
  const t = tree(
    'import { readFileSync } from "node:fs";\nconst p = JSON.parse(readFileSync(0, "utf8"));\nprocess.stderr.write("refused: " + p.why + "\\n");\nprocess.exit(2);\n',
  );
  const r = run(t.hook, JSON.stringify({ why: "no close" }), t.home, NO_TIMEOUT_ENV, "--harness", "claude");
  assert.equal(r.rc, 2, r.err);
  assert.match(r.err, /refused: no close/);
});

test("with no timeout command, a check past the bound is still stopped", () => {
  const t = tree("setTimeout(() => {}, 60_000);\n");
  const started = Date.now();
  const r = run(t.hook, "{}", t.home, { ...NO_TIMEOUT_ENV, END_OF_TURN_TIMEOUT: "1" }, "--harness", "claude");
  assert.equal(r.rc, 0, r.err);
  assert.ok(Date.now() - started < 10_000, "stopped at the bound");
  assert.match(logOf(t.home), /stopped after 1s; allowed/);
});

test("a missing bounded runner: allowed, said and logged", () => {
  const t = tree("process.exit(2);\n", false);
  const r = run(t.hook, "{}", t.home, {}, "--harness", "claude");
  assert.equal(r.rc, 0);
  assert.match(logOf(t.home), /missing: .*paths\.sh; allowed/);
});

test("stdout passes through (Antigravity's refusal is JSON on stdout, exit 0)", () => {
  const t = tree('process.stdout.write(\'{"decision":"continue","reason":"r"}\\n\');\n');
  const r = run(t.hook, "{}", t.home, {}, "--harness", "antigravity");
  assert.equal(r.rc, 0);
  assert.deepEqual(JSON.parse(r.out), { decision: "continue", reason: "r" });
});

test("a log that cannot be written still allows (exit 0)", () => {
  const t = tree(null);
  // The log path is a directory, so the append fails.
  mkdirSync(join(t.home, ".cache", "workbench", "end-of-turn.log"), { recursive: true });
  const r = run(t.hook, "{}", t.home, {}, "--harness", "claude");
  assert.equal(r.rc, 0, r.err);
  assert.match(r.err, /reply allowed/);
});
