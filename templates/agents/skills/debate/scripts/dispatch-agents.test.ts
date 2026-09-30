// Test harness for dispatch-agents.ts — three seats (Claude, Codex, Grok), one
// prompt each, and the stand-in rules that keep a debate at three positions. The
// panel-row CLIs (claude / codex / grok) are stubbed via a per-test PATH so we
// don't touch real binaries. No `timeout` is on that PATH: the ceiling is the
// script's own watchdog, which cases 17, 18 and 20 exercise.
//
// EVERY case pins a FIXTURE panel through DEBATE_POLICY_JSON: the stubs are
// named `claude`, `codex` and `grok` right here, so reading the shipped table
// would turn a legitimate policy change into red cases that test nothing.
// Cases 7 and 8 are the ones that find the policy file themselves, and they are
// about that lookup and nothing else.
//
// The program is SPAWNED, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/debate/scripts/dispatch-agents.test.ts
//
// peers: dispatch-agents.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "dispatch-agents.ts");
// The script imports packages/cli-exit by a three-level climb and answer-block.ts
// from beside it; a copy planted in a tree of its own needs both at the same
// places relative to it.
const IMPORTS = ["../../../packages/cli-exit/cli-exit.ts", "answer-block.ts"];
function plantImports(script: string): void {
  for (const rel of IMPORTS) {
    const dest = join(dirname(script), rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(HERE, rel), dest);
  }
}

// Every temp dir the suite or the script made, removed at the end.
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "dispatch-agents-test-"));
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

// The tools a stub needs (`#!/usr/bin/env bash`, sleep, printf) — and nothing
// else, so no real claude / codex / grok and no git can answer.
function makeTightPath(): string {
  const d = scratch();
  for (const bin of [
    "bash",
    "sleep",
    "grep",
    "echo",
    "head",
    "wc",
    "date",
    "mktemp",
    "printf",
    "cat",
    "dirname",
    "basename",
    "tail",
    "sed",
    "awk",
    "chmod",
    "rm",
    "ls",
    "env",
    "yes",
    "find",
    "sort",
  ]) {
    const p = which(bin);
    if (p) symlinkSync(p, join(d, bin));
  }
  return d;
}

function writeExe(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A stub CLI that sleeps, prints one line and exits with the given code. */
function mkstub(dir: string, name: string, code: number, sleepS: number, msg: string): void {
  writeExe(join(dir, name), `#!/usr/bin/env bash\nsleep ${sleepS}\nprintf '%s\\n' '${msg}'\nexit ${code}\n`);
}

// The fixture panel: three vendors whose names match the stubs above. Shape mirrors
// .agents/skills/review/policy.json; content is pinned so a change there cannot
// redden this file.
const POLICY_JSON_BODY = JSON.stringify({
  rows: {
    panel: {
      voices: [
        { vendor: "claude", model: "opus", tracks: "opus[1m]" },
        { vendor: "codex", model: "codex", tracks: "gpt-{v}-sol" },
        { vendor: "grok", model: "grok", tracks: "grok-{v}" },
      ],
    },
  },
});

function makePolicy(path: string, body = POLICY_JSON_BODY): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${body}\n`);
  return path;
}

function makePromptsDir(n: 2 | 3): string {
  const d = scratch();
  if (n === 2) {
    writeFileSync(join(d, "role1.prompt"), "role1 prompt body\n");
    writeFileSync(join(d, "role2.prompt"), "role2 prompt body\n");
  } else {
    for (const r of ["role1", "role2", "role3"]) writeFileSync(join(d, `${r}.prompt`), `${r}\n`);
  }
  return d;
}

// The model resolver, stubbed: a resolver a user keeps of their own would read
// each CLI's catalog, and these CLIs are stubs. It resolves the fixture
// families to fixed ids and fails `unresolvable-{v}`. A case that sets
// DEBATE_RESOLVER to "" gets the script's own identity rule instead.
const RESOLVER_STUB = join(scratch(), "resolve-model");
writeExe(
  RESOLVER_STUB,
  `#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
`,
);

const SHARED_POLICY = makePolicy(join(scratch(), "policy.json"));

// A copy of the script in a scratch skills tree, so the policy it finds beside
// the review skill is whatever the case puts there.
function isolatedScript(): string {
  const iso = scratch();
  mkdirSync(join(iso, ".agents/skills/debate/scripts"), { recursive: true });
  const copy = join(iso, ".agents/skills/debate/scripts/dispatch-agents.ts");
  copyFileSync(SCRIPT, copy);
  plantImports(copy);
  return copy;
}

interface RunOpts {
  script?: string;
  // Omitted → the shared fixture panel. "" is passed through deliberately: cases
  // 7 and 8 set the seam EMPTY to make the script find a policy path of its
  // own, and reading empty as unset would hand them the fixture, passing both
  // without exercising the lookup.
  policy?: string;
  // Omitted → the resolver stub. "" is passed through: the script's identity rule.
  resolver?: string;
  // DEBATE_MS_PER_S, the ceiling's clock seam; omitted → real seconds.
  msPerS?: string;
  cwd?: string;
}

interface Run {
  code: number | null;
  out: string;
  dir: string;
}

// The environment is wiped, so the seams the script reads — DEBATE_POLICY_JSON,
// DEBATE_RESOLVER and DEBATE_MS_PER_S — are forwarded explicitly.
function runScript(stubs: string, args: string[], o: RunOpts = {}): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", o.script ?? SCRIPT, ...args], {
    encoding: "utf8",
    cwd: o.cwd,
    timeout: 60_000,
    env: {
      PATH: stubs,
      HOME: "/tmp",
      DEBATE_RESOLVER: o.resolver ?? RESOLVER_STUB,
      DEBATE_POLICY_JSON: o.policy ?? SHARED_POLICY,
      ...(o.msPerS !== undefined ? { DEBATE_MS_PER_S: o.msPerS } : {}),
    },
  });
  const dir = /^output_dir=(.+)$/m.exec(r.stdout)?.[1] ?? "";
  if (dir !== "") made.push(dir);
  return { code: r.status, out: `${r.stdout}${r.stderr}`, dir };
}

function count(dir: string, ext: string): number {
  return readdirSync(dir).filter((f) => f.endsWith(ext)).length;
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}

/** The line after `flag` in an argv dump written one argument per line. */
function after1(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// Who argued each seat, from the stub each seat's output came from.
function arguedBy(d: string): string {
  return ["role1", "role2", "role3"]
    .map((r) => {
      const f = join(d, `${r}.output`);
      if (existsSync(f) && statSync(f).size > 0) return `${r}=${(lines(f)[0] ?? "").split(" ")[0]}`;
      return `${r}=GAP`;
    })
    .join(" ");
}

test("the script is executable", () => {
  assert.ok((statSync(SCRIPT).mode & 0o111) !== 0, `not executable: ${SCRIPT}`);
});

test("case1: no CLI on PATH makes every seat a gap naming it, and exits non-zero", () => {
  const r = runScript(makeTightPath(), ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /CLI not found/, "missing CLI-not-found msg");
});

test("case2: all agents succeed → one .output per role, exit 0", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says X");
  mkstub(stubs, "codex", 0, 0, "codex says Y");
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(count(r.dir, ".output"), 3);
});

test("case3: Codex times out → Claude stands in for its seat; three positions, no gap", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says X");
  mkstub(stubs, "codex", 0, 5, "slow"); // exceeds timeout=2
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "2"]);
  assert.equal(r.code, 0, `expected 0 (partial success): ${r.out}`);
  assert.equal(count(r.dir, ".gap"), 0, "expected 0 gaps");
  assert.equal(count(r.dir, ".output"), 3, "expected 3 outputs");
  assert.ok(lines(join(r.dir, "role2.output")).includes("claude says X"), "Codex's seat was not argued by Claude");
  assert.match(
    readFileSync(join(r.dir, "role2.voice"), "utf8"),
    /^claude opus\[1m\] — stood in for codex \(timeout/,
    "the stand-in is not recorded",
  );
  assert.ok(
    r.out.includes("codex failed (timeout after 2s (codex)); claude stands in"),
    `the stand-in is not announced: ${r.out}`,
  );
});

test("case4: all agents fail → exit non-zero, a .gap for each seat", () => {
  const stubs = makeTightPath();
  for (const v of ["claude", "codex", "grok"]) mkstub(stubs, v, 1, 0, "x");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.notEqual(r.code, 0, "expected non-zero on all-fail");
  assert.equal(count(r.dir, ".gap"), 3);
});

test("case5: a prompts dir with zero .prompt files is refused loudly", () => {
  const r = runScript(makeTightPath(), ["--prompts-dir", scratch(), "--timeout-s", "5"]);
  assert.notEqual(r.code, 0, "expected non-zero on empty prompts dir");
  assert.match(r.out, /holds no \.prompt files/);
});

// ── Case 6: the grok agent's flag shape ──
// Without --verbatim the CLI truncates a long prompt and offloads the remainder
// to a file it tells the model to read, so the reply comes back as agent
// narration rather than the argument this script dispatched for.
// Pinned to a FIXTURE panel row rather than the shipped table: this case is
// about the grok branch's flag shape, which stays correct (and testable)
// whether or not the policy happens to seat grok on the panel.
describe("case6: the grok seat's invocation", () => {
  let stubs = "";
  let pol = "";
  let pdir = "";
  let argv: string[] = [];
  let flat = "";

  before(() => {
    stubs = makeTightPath();
    const argvFile = join(stubs, "grok-argv.txt");
    // A three-vendor panel mirroring the shape the script expects, pinned rather
    // than read from the shipped table — so this case keeps testing the grok
    // branch through a reassignment.
    pol = makePolicy(join(stubs, "policy.json"));
    writeExe(
      join(stubs, "grok"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argvFile}'\nprintf 'grok says Z\\n'\n`,
    );
    mkstub(stubs, "claude", 0, 0, "claude says X");
    mkstub(stubs, "codex", 0, 0, "codex says Y");
    pdir = makePromptsDir(3);
    runScript(stubs, ["--prompts-dir", pdir, "--timeout-s", "5"], { policy: pol });
    assert.ok(existsSync(argvFile), "grok stub was never invoked under the fixture panel");
    argv = lines(argvFile);
    flat = argv.join(" ");
  });

  test("grok is invoked with --verbatim", () => {
    assert.ok(argv.includes("--verbatim"), `grok argv lacks --verbatim: ${flat}`);
  });

  // A debate voice is prompt-in/answer-out, and `dontAsk` was measured
  // cancelling that shape at turn 1, against never under bypassPermissions.
  // The mode and a NON-EMPTY allowlist are one change: bypassPermissions ignores
  // --disallowed-tools, and `--tools ''` granted a file write and a shell
  // command.
  test("grok is not invoked with dontAsk", () => {
    assert.ok(!argv.includes("dontAsk"), `dontAsk cancels answer-only runs: ${flat}`);
  });

  test("grok is invoked with bypassPermissions", () => {
    assert.ok(argv.includes("bypassPermissions"), `argv lacks bypassPermissions: ${flat}`);
  });

  test("grok's tool allowlist is non-empty", () => {
    assert.ok(argv.includes("list_dir"), `argv lacks a non-empty --tools: ${flat}`);
  });

  test("grok carries no denylist this mode would not enforce", () => {
    assert.ok(!argv.includes("--disallowed-tools"), `denylist is not enforced under this mode: ${flat}`);
  });

  test("grok takes no web hop", () => {
    assert.ok(argv.includes("--disable-web-search"), `argv lacks --disable-web-search: ${flat}`);
  });

  // Planning is off on every grok call.
  test("grok is invoked with --no-plan", () => {
    assert.ok(argv.includes("--no-plan"), `grok argv lacks --no-plan: ${flat}`);
  });

  test("the grok debate seat uses medium reasoning effort", () => {
    assert.equal(after1(argv, "--reasoning-effort"), "medium", `grok debate lacks medium effort: ${flat}`);
  });

  test("the grok debate seat answers without an agent loop", () => {
    assert.equal(
      after1(argv, "--system-prompt-override"),
      "Answer the user's message directly from its supplied context. Follow its requested output format exactly. Do not use tools or narrate.",
      `grok debate lacks completion instruction: ${flat}`,
    );
  });

  // All three seats share the default ceiling. An explicit --timeout-s still
  // applies to all three (as above). With the clock seam at 1ms a second, the
  // 300s default fires at 0.3s, before stubs that sleep 5s answer — and every
  // seat's gap names the ceiling it hit.
  test("every seat's default ceiling is 300s", () => {
    const slow = makeTightPath();
    for (const v of ["grok", "claude", "codex"]) mkstub(slow, v, 0, 5, `${v} says late`);
    const r = runScript(slow, ["--prompts-dir", makePromptsDir(3), "--no-stand-in"], { policy: pol, msPerS: "1" });
    const gaps = ["role1", "role2", "role3"].map((role) => readFileSync(join(r.dir, `${role}.gap`), "utf8").trim());
    for (const v of ["grok", "claude", "codex"]) {
      assert.ok(gaps.includes(`timeout after 300s (${v})`), `default ceilings: ${gaps.join(" | ")} ${r.out}`);
    }
  });
});

// ── Case 7: the policy is found beside the review skill ──
// The script reads `../../review/policy.json` from its own directory
// (`.agents/skills/debate/scripts/` → `.agents/skills/review/policy.json`).
// Cases 7 and 8 run a COPY from a scratch skills tree, so the file there is the
// one under test.
//
// DEBATE_POLICY_JSON is deliberately EMPTY here: this case is about the script
// finding the policy on its own, which the seam would otherwise short-circuit.
test("case7: the policy is found beside the review skill", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says X");
  mkstub(stubs, "codex", 0, 0, "codex says Y");
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const script = isolatedScript();
  makePolicy(join(dirname(script), "../../review/policy.json"));
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"], { script, policy: "" });
  assert.equal(r.code, 0, r.out);
});

// ── Case 8: no policy beside the review skill → fail loud, naming the path ──
// A missing table is reported with the path the script looked at, so the reader
// knows which install is incomplete.
test("case8: with no policy beside the review skill, the script fails loud naming the path", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says X");
  mkstub(stubs, "codex", 0, 0, "codex says Y");
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"], {
    script: isolatedScript(),
    policy: "",
    cwd: "/",
  });
  assert.notEqual(r.code, 0, "expected non-zero with no policy file");
  assert.match(
    r.out,
    /policy\.json not found at .*\/skills\/debate\/scripts\/\.\.\/\.\.\/review\/policy\.json/,
    "missing the not-found message naming the path",
  );
});

// ── Case 9: every CLI is told its voice's pinned model; an unpinned voice runs its CLI default ──
// A voice whose table names a model must run THAT model, not whatever its CLI
// ranks first; a voice whose table names none runs with no model flag at all.
test("case9: every voice runs its resolved model, an unpinned voice its CLI default, and an unresolvable voice never runs", () => {
  const stubs = makeTightPath();
  const argvDir = scratch();
  for (const v of ["claude", "codex", "grok"]) {
    writeExe(
      join(stubs, v),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argvDir}/${v}.argv'\necho "${v} says hi"\n`,
    );
  }
  let r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.equal(r.code, 0, r.out);
  for (const [v, model] of [
    ["claude", "opus[1m]"],
    ["codex", "gpt-6-sol"],
    ["grok", "grok-4.7"],
  ] as const) {
    const argv = existsSync(join(argvDir, `${v}.argv`)) ? lines(join(argvDir, `${v}.argv`)) : [];
    const i = argv.indexOf(model);
    assert.ok(i > 0 && ["-m", "--model"].includes(argv[i - 1] ?? ""), `${v} was not told ${model}: ${argv.join(" ")}`);
  }

  // A voice with no model runs on its CLI's default: no model flag, its own
  // seat, and a .voice line that says so. One that will not resolve (a
  // resolver was given and failed) never runs: its seat fails and a stand-in
  // argues it.
  const pdir2 = makePromptsDir(2);
  const unpinned = makePolicy(
    join(scratch(), "policy.json"),
    '{"rows":{"panel":{"voices":[{"vendor":"claude","model":"opus","tracks":"opus[1m]"},{"vendor":"codex","model":"codex"}]}}}',
  );
  for (const f of readdirSync(argvDir)) rmSync(join(argvDir, f));
  r = runScript(stubs, ["--prompts-dir", pdir2, "--timeout-s", "5"], { policy: unpinned });
  assert.equal(r.code, 0, `an unpinned voice should run: ${r.out}`);
  assert.ok(existsSync(join(argvDir, "codex.argv")), `the unpinned codex voice did not run: ${r.out}`);
  const codexArgv = lines(join(argvDir, "codex.argv"));
  assert.ok(
    !codexArgv.includes("-m") && !codexArgv.includes("--model"),
    `the unpinned codex voice was given a model flag: ${codexArgv.join(" ")}`,
  );
  assert.equal(readFileSync(join(r.dir, "role2.voice"), "utf8"), "codex (default model)\n");
  for (const f of readdirSync(argvDir)) rmSync(join(argvDir, f));

  const unresolvable = makePolicy(
    join(scratch(), "policy.json"),
    '{"rows":{"panel":{"voices":[{"vendor":"claude","model":"opus","tracks":"opus[1m]"},{"vendor":"codex","model":"codex","tracks":"unresolvable-{v}"}]}}}',
  );
  r = runScript(stubs, ["--prompts-dir", pdir2, "--timeout-s", "5"], { policy: unresolvable });
  assert.equal(r.code, 0, `an unresolvable voice's seat should be stood in for: ${r.out}`);
  assert.ok(r.out.includes("could not resolve unresolvable-{v}"), `missing the unresolved message: ${r.out}`);
  assert.ok(!existsSync(join(argvDir, "codex.argv")), "the unresolvable codex voice ran anyway");
});

// ── Case 10: the stand-in rules, and the fallback when the first choice failed too ──
//   Claude fails → Codex doubles.  Grok fails → Claude doubles.  Codex fails → Claude doubles.
//   A stand-in must have answered its own seat, so the leftover voice is next.
// Failing vendors → expected seat owners (seats: role1 Claude, role2 Codex, role3 Grok).
describe("case10: the stand-in rules", () => {
  const pdir = makePromptsDir(3);
  for (const [failing, expect] of [
    [["claude"], "role1=codex role2=codex role3=grok"],
    [["grok"], "role1=claude role2=codex role3=claude"],
    [["codex"], "role1=claude role2=claude role3=grok"],
    [["claude", "codex"], "role1=grok role2=grok role3=grok"],
    [["grok", "claude"], "role1=codex role2=codex role3=codex"],
    [["codex", "grok"], "role1=claude role2=claude role3=claude"],
  ] as const) {
    test(`failing [${failing.join(" ")}] → ${expect}`, () => {
      const stubs = makeTightPath();
      for (const v of ["claude", "codex", "grok"]) {
        if ((failing as readonly string[]).includes(v)) mkstub(stubs, v, 1, 0, `${v} failed`);
        else mkstub(stubs, v, 0, 0, `${v} says`);
      }
      const r = runScript(stubs, ["--prompts-dir", pdir, "--timeout-s", "5"]);
      assert.equal(arguedBy(r.dir), expect);
    });
  }
});

test("case11: --no-stand-in leaves a failed seat a gap (for a caller that needs each voice's own answer)", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says");
  mkstub(stubs, "codex", 1, 0, "codex failed");
  mkstub(stubs, "grok", 0, 0, "grok says");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5", "--no-stand-in"]);
  assert.equal(arguedBy(r.dir), "role1=claude role2=GAP role3=grok", "expected Codex's seat to stay a gap");
  assert.ok(statSync(join(r.dir, "role2.gap")).size > 0, "gap file empty");
  assert.ok(!existsSync(join(r.dir, "role2.voice")), "a gap seat kept its voice file");
});

test("case12: a prompt count that does not match the panel is refused with exit 2", () => {
  const stubs = makeTightPath();
  for (const v of ["claude", "codex", "grok"]) mkstub(stubs, v, 0, 0, "x");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(2), "--timeout-s", "5"]);
  assert.equal(r.code, 2);
  assert.ok(r.out.includes("holds 2 prompt(s) but the panel has 3 voice(s)"), `missing msg: ${r.out}`);
});

test("case13: a stand-in that fails too leaves a gap carrying BOTH reasons", () => {
  const stubs = makeTightPath();
  // claude answers its own seat, then fails when it stands in: it fails only on
  // the second call.
  const ran = join(stubs, "claude.ran");
  writeExe(
    join(stubs, "claude"),
    `#!/usr/bin/env bash\nif [[ -e '${ran}' ]]; then echo "second call broke" >&2; exit 3; fi\n: > '${ran}'\necho "claude says"\n`,
  );
  mkstub(stubs, "codex", 0, 0, "codex says");
  mkstub(stubs, "grok", 1, 0, "grok failed");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  const gap = join(r.dir, "role3.gap");
  assert.ok(existsSync(gap) && statSync(gap).size > 0, `Grok's seat should be a gap; got ${arguedBy(r.dir)}`);
  assert.ok(
    readFileSync(gap, "utf8").includes("stood in for grok (exit 1 (grok)); the stand-in failed too: exit 3 (claude)"),
    `gap lacks both reasons: ${readFileSync(gap, "utf8")}`,
  );
});

// ── Case 14: a CLI that exits 0 having printed nothing did not argue its seat ──
// Exit status alone called an empty (or whitespace-only) answer a success, so
// three silent voices yielded three "answered" seats, exit 0, and a synthesis
// over nothing. A blank answer is a gap like any other failure — and so it is
// stood in for.
function mksilent(dir: string, name: string): void {
  writeExe(join(dir, name), `#!/usr/bin/env bash\nprintf '  \\n\\n'\nexit 0\n`);
}

test("case14: a voice that exits 0 with blank output is a failure, and a stand-in argues its seat", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says");
  mksilent(stubs, "codex");
  mkstub(stubs, "grok", 0, 0, "grok says");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(arguedBy(r.dir), "role1=claude role2=claude role3=grok", "Codex's blank seat was not stood in for");
  assert.match(
    readFileSync(join(r.dir, "role2.voice"), "utf8"),
    /^claude opus\[1m\] — stood in for codex \(no answer in output \(codex\)\)/,
    "the stand-in does not name the blank answer",
  );
});

test("case14: when every voice exits 0 with blank output, every seat is a gap and the run exits non-zero", () => {
  const stubs = makeTightPath();
  for (const v of ["claude", "codex", "grok"]) mksilent(stubs, v);
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.notEqual(r.code, 0, `three blank answers were reported as success: ${r.out}`);
  assert.equal(count(r.dir, ".gap"), 3);
  assert.equal(count(r.dir, ".output"), 0, "a blank .output was left for the parser");
  assert.match(r.out, /role1: no answer in output \(claude\)/);
});

// ── Case 15: an output holding only CLI footer noise is no answer either ──
// `[done in 4.2s]` / `total tokens: 2255` passed a blank check, so the seat
// counted as argued while parse-agent-output.ts — which cuts at the first
// footer line — found nothing in it: no stand-in, no .gap, and a debate one
// position short that reported success. Both scripts now judge a seat by the
// same reading (answer-block.ts).
test("case15: a voice whose output is only footer noise is a failure, and a stand-in argues its seat", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says");
  writeExe(join(stubs, "codex"), `#!/usr/bin/env bash\nprintf '[done in 4.2s]\\ntotal tokens: 2255\\n'\n`);
  mkstub(stubs, "grok", 0, 0, "grok says");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    arguedBy(r.dir),
    "role1=claude role2=claude role3=grok",
    "Codex's footer-only seat was not stood in for",
  );
  assert.match(
    readFileSync(join(r.dir, "role2.voice"), "utf8"),
    /^claude opus\[1m\] — stood in for codex \(no answer in output \(codex\)\)/,
  );
});

// The converse: a legacy codex shape puts footer-like lines ABOVE the answer.
// The parser keeps everything from the heading on, so the seat was argued and
// must not be handed to a stand-in.
test("case15: footer-like lines above an anchored answer do not make the seat a gap", () => {
  const stubs = makeTightPath();
  mkstub(stubs, "claude", 0, 0, "claude says");
  writeExe(join(stubs, "codex"), `#!/usr/bin/env bash\nprintf 'tokens-in: 1843\\n\\n## Position\\ncodex argues\\n'\n`);
  mkstub(stubs, "grok", 0, 0, "grok says");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(r.dir, "role2.gap")), `an anchored answer was called a gap: ${r.out}`);
  assert.equal(readFileSync(join(r.dir, "role2.voice"), "utf8"), "codex gpt-6-sol\n");
});

// ── Case 16: with no resolver, `tracks` is the model, handed over verbatim ──
// There is no model catalog to consult; the table's string IS what the CLI is
// told.
test("case16: with no resolver, every CLI is told its voice's tracks verbatim", () => {
  const stubs = makeTightPath();
  const argvDir = scratch();
  for (const v of ["claude", "codex", "grok"]) {
    writeExe(
      join(stubs, v),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argvDir}/${v}.argv'\necho "${v} says hi"\n`,
    );
  }
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5"], { resolver: "" });
  assert.equal(r.code, 0, r.out);
  for (const [v, model] of [
    ["claude", "opus[1m]"],
    ["codex", "gpt-{v}-sol"],
    ["grok", "grok-{v}"],
  ] as const) {
    const argv = existsSync(join(argvDir, `${v}.argv`)) ? lines(join(argvDir, `${v}.argv`)) : [];
    const i = argv.indexOf(model);
    assert.ok(
      i > 0 && ["-m", "--model"].includes(argv[i - 1] ?? ""),
      `${v} was not told ${model} verbatim: ${argv.join(" ")}`,
    );
  }
});

// ── Cases 17-18, 20: the script's own watchdog is the ceiling ──
// No `timeout` binary is involved (macOS ships none); the seat must still end at
// the ceiling, as exit 124, so the stand-in and the gap text read exactly as
// `timeout`'s status would make them. A `timeout` planted on PATH is ignored.
function tightPathWithoutTimeout(): string {
  const stubs = makeTightPath();
  writeExe(join(stubs, "timeout"), "#!/usr/bin/env bash\nexit 99\n");
  return stubs;
}

test("case17: the watchdog times a seat out, whatever `timeout` is on PATH", () => {
  const stubs = tightPathWithoutTimeout();
  mkstub(stubs, "claude", 0, 0, "claude says X");
  mkstub(stubs, "codex", 0, 5, "slow"); // exceeds timeout=2
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "2"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(
    r.out.includes("codex failed (timeout after 2s (codex)); claude stands in"),
    `the watchdog did not report a timeout: ${r.out}`,
  );
  assert.ok(lines(join(r.dir, "role2.output")).includes("claude says X"), "the timed-out seat was not stood in for");
});

// TERM alone would leave the debate waiting on a CLI that ignores it forever.
test("case18: a CLI that ignores TERM is KILLed", () => {
  const stubs = tightPathWithoutTimeout();
  mkstub(stubs, "claude", 0, 0, "claude says X");
  writeExe(join(stubs, "codex"), "#!/usr/bin/env bash\ntrap '' TERM\nexec sleep 30\n");
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const start = Date.now();
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "2"]);
  const elapsed = (Date.now() - start) / 1000;
  assert.equal(r.code, 0, r.out);
  assert.ok(elapsed < 15, `a TERM-ignoring CLI held the debate ${elapsed}s past a 2s timeout`);
  assert.ok(
    r.out.includes("codex failed (timeout after 2s (codex)); claude stands in"),
    `the kill was not reported as a timeout: ${r.out}`,
  );
});

// A CLI that dies on TERM can leave a child that ignores it. The KILL that
// follows the grace period must still reach the CLI's process group after the
// CLI itself has exited; cancelling it on the CLI's exit left the child running
// after the debate had moved on.
test("case20: after a timeout, a TERM-ignoring child of the CLI is KILLed too", () => {
  const stubs = tightPathWithoutTimeout();
  const pidFile = join(stubs, "grandchild.pid");
  mkstub(stubs, "claude", 0, 0, "claude says X");
  writeExe(
    join(stubs, "codex"),
    `#!/usr/bin/env bash\nbash -c 'trap "" TERM; printf "%s" $$ > "${pidFile}"; exec sleep 30' &\nwait\n`,
  );
  mkstub(stubs, "grok", 0, 0, "grok says Z");
  const r = runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "2"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes("codex failed (timeout after 2s (codex))"), `no timeout reported: ${r.out}`);
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) process.kill(pid, "SIGKILL");
  assert.equal(alive, false, `the CLI's TERM-ignoring child (pid ${pid}) outlived the debate`);
});

// ── Case 19: --research gives the grok seat read + search tools (Contextium) ──
// /explain's seats investigate a hypothesis: they must read repo files and may
// search the web, which a debate voice arguing from its prompt does not.
test("case19: --research gives the grok seat read and search tools, still under bypassPermissions", () => {
  const stubs = makeTightPath();
  const argvFile = join(stubs, "grok-argv.txt");
  writeExe(join(stubs, "grok"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argvFile}'\nprintf 'grok says Z\\n'\n`);
  mkstub(stubs, "claude", 0, 0, "claude says X");
  mkstub(stubs, "codex", 0, 0, "codex says Y");
  runScript(stubs, ["--prompts-dir", makePromptsDir(3), "--timeout-s", "5", "--research"]);
  assert.ok(existsSync(argvFile), "grok never ran under --research");
  const argv = lines(argvFile);
  const flat = argv.join(" ");
  assert.equal(after1(argv, "--tools"), "read_file,list_dir,grep", `a research seat lacks read tools: ${flat}`);
  assert.ok(!argv.includes("--disable-web-search"), `a research seat cannot search the web: ${flat}`);
  assert.ok(argv.includes("bypassPermissions"), `a research seat lost its permission mode: ${flat}`);
});
