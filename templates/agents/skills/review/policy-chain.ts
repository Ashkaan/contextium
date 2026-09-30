#!/usr/bin/env -S node --experimental-strip-types
// policy-chain.ts — walk a policy row's chain until a vendor answers.
//
// THE script-side executor of the policy table, `policy.json` beside this file.
// Every script caller that wants an AI answer declares a TASK-KIND and imports
// this file; none of them names a vendor. It was extracted from
// policy-review.ts's inlined walk, which was the only copy — so the two review
// scripts each hardcoded one `codex exec` and a Codex outage took them both down
// with nothing to fall back to. The three callers — code-review.ts,
// policy-review.ts, spec-audit.ts — import it.
//
// THE AUTHOR LEAVES A REVIEW CHAIN. The installer records the model family that
// writes the code as `agent=<name>` in `.agents/harness` (two levels above this
// skill's folder). For every row read from `.chain` — the review rows — the slot
// whose vendor is that family is skipped: a reviewer of the same model as the
// author shares the blind spots that produced the mistake. antigravity is the
// gemini family; cursor and copilot name no single family, so nothing is
// skipped. A `.voices` row (a panel) keeps every seat. The claude slot is never
// skipped: it is not a CLI call but "dispatch your own agent" (return 3), which
// every caller already labels as reduced independence. No file, or no `agent=`
// key: the row as written.
//
// Usage (import, then call):
//   import { policyRunChain } from "./policy-chain.ts";
//   const rc = policyRunChain("adversarial-review", promptFile, { out: rawOut });
//
// The walk is synchronous (spawnSync throughout), so a caller never interleaves
// its own output with a walk in flight.
//
//   answer: the answering vendor's raw output, and NOTHING else — written to
//           `opts.out` (a file, truncated first, as a `> "$OUT"` redirect did),
//           or to stdout when no `out` is given.
//   stderr: every diagnostic — one line per slot tried, with vendor + reason.
//   return 0:   a slot answered
//   return 1:   chain exhausted (every slot absent or failed)
//   return 2:   caller error (unknown row, policy.json missing, empty prompt,
//               unrunnable validator)
//   return 3:   chain reached a claude slot in a script context — or, on a row
//               marked `"fallback": "fresh-context"` (Contextium), every vendor
//               in it was unavailable: the caller runs a fresh-context review
//               of its own and records it as NOT independent
//   return 124: chain exhausted and the LAST failure was a timeout
//   return 125: chain exhausted, and AT LEAST ONE slot was alive, answered, and
//               was rejected for its SHAPE. Not "the last failure was" — any
//               such slot earns this code, because a caller's re-ask re-walks
//               the WHOLE chain, so a primary that answered wrongly is still
//               recoverable when the backup behind it was dead. Distinct from 1
//               so a caller with its own re-ask can tell "ask again, differently"
//               from "there is nobody left to ask", and spend a second walk only
//               on the first. A timeout still outranks it: 124 is checked first,
//               because callers map that to their own fatal message.
//
// Sets process.env.POLICY_CHAIN_VENDOR / POLICY_CHAIN_MODEL — who answered.
//
// Those are visible to the importing process only. A caller in a SEPARATE
// process (`node code-review.ts`) cannot see them at all, so the same fact is
// written to stderr as one `answered: <vendor>/<model>` line; that line is the
// durable channel and is what the tests assert on.
//
// Environment:
//   POLICY_JSON                  path to policy.json (default: the one beside
//                                this script)
//   CODEX_BIN / GROK_BIN         per-vendor binary override; load-bearing for
//                                stub-driven failure tests, which must never
//                                depend on a live vendor's quota or auth
//   POLICY_CHAIN_RESOLVER        command that prints the model a slot's
//                                `tracks` resolves to, given `<vendor> <tracks>`
//                                (default: `tracks` itself, verbatim — there is
//                                no model catalog here, so a `{v}` family cannot
//                                resolve; an empty `tracks` runs the CLI's own
//                                default model); a test seam
//   CONTEXTIUM_HARNESS_FILE      the harness record read for `agent=` (default:
//                                `.agents/harness`, two levels above this skill)
//   POLICY_CHAIN_SLOT_TIMEOUT_S  per-slot wall clock (default 900)
//   POLICY_CHAIN_VALIDATOR       optional shape test, as a command — see below
//
// THE SHAPE TEST (opts.validator, or POLICY_CHAIN_VALIDATOR)
//
// A slot used to be banked on `rc == 0` alone, so a vendor that answered with
// prose instead of the review the caller asked for spent the WHOLE chain: both
// callers here parse afterwards, outside the walk, where a rejection can no
// longer reach the backup sitting untried.
//
// Pass `opts.validator` — a function of the slot's output file, the shape both
// real callers use, or a command name — or set POLICY_CHAIN_VALIDATOR to a
// command, and the walk runs it on the slot's output file before banking.
// Non-zero = this slot did not answer, and the walk keeps going exactly as it
// does for a timeout. Neither set → today's behavior.
//
//   const wantsFinding = (f: string) => ({ rc: /^FINDING/m.test(readFileSync(f, "utf8")) ? 0 : 1, stderr: "" });
//   const rc = policyRunChain("adversarial-review", promptFile, { out, validator: wantsFinding });
//
// Four properties of it are load-bearing, not stylistic:
//
//   1. A command validator's stdout goes to /dev/null, enforced HERE rather than
//      by convention at the call site. This helper's answer stream is what a
//      caller parses; one stray echo from a validator would land inside the
//      review and corrupt it. A function validator reports through its return
//      value and has no stream to leak.
//   2. Its stderr (last 500B) is the rejection reason, quoted into the
//      diagnostic — mirroring how a failed slot's vendor stderr is surfaced.
//   3. POLICY_CHAIN_VALIDATOR is removed from process.env for the walk, so it
//      never reaches the environment of a vendor CLI subprocess the walk spawns
//      or of any nested call.
//   4. An UNRUNNABLE validator (a command name that resolves to nothing on PATH
//      and no executable path) is a caller error — return 2, before any vendor
//      is invoked. Defaulting it to "accept" would silently reinstate the exact
//      hole it was set to close, and finding that out costs a whole chain's
//      spend.
//
// `policyRunChain` DELETES POLICY_CHAIN_VALIDATOR on return, so one gate's shape
// test cannot bleed into another's run in the same process. Callers therefore
// pass it per call, never once at the top of the script.
//
// There is deliberately no CLAUDE_BIN: a claude slot returns 3 WITHOUT invoking
// anything, because the Claude layer here is an agent with repo tools, not a
// one-shot CLI call — so there is no binary for an override to point at.
//
// Per-slot timeout, not a total one. A timed-out slot FALLS THROUGH to the next:
// a hang is the failure class this file exists to survive, and the old hard
// `exit 124` with no fallthrough left the most common outage uncovered.
// Worst-case wall clock is therefore slots x slot-timeout. A caller bounds that
// by LOWERING POLICY_CHAIN_SLOT_TIMEOUT_S — never by wrapping the whole call in
// its own `timeout`, which becomes a total-chain cap that kills the walk
// mid-fallthrough, the exact behavior this design removes. Each slot runs under
// spawnCapped (below), which KILLs a slot that ignores TERM and whatever it
// started; a slot it stops reports 124, the coreutils convention, so a slot's
// 124 means the same thing on every host.
//
// The prompt arrives as a FILE and is piped on stdin, never on argv. A large
// diff on argv dies `Argument list too long` (exit 126) on exactly the changes
// that most need reviewing.
//
// Diagnostics are stderr-ONLY. code-review.ts's stdout is a triage-line stream
// that /implement-audit's fix loop parses, so a banner there corrupts it.
//
// The policy is read with JSON.parse, where the bash walk shelled out to jq —
// so jq is no longer a requirement and "jq absent" is no longer a caller error.
//
// This file is the one place a review vendor's CLI is invoked from a script.

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_CHAIN_DEFAULT_SLOT_TIMEOUT_S = "900";

// Read-only is the tightest sandbox that still lets Codex read the repo. Every
// script caller of this helper reviews an artifact:
// it reads and reports, it never writes, so it should not be able to.
const POLICY_CHAIN_CODEX_SANDBOX = "--sandbox=read-only";

// There is no Grok DENYLIST here: both chain-driven shapes are allowlists, and
// both run under a mode that ignores `--disallowed-tools` outright, so the flag
// would assert a protection that does not apply.
// What it used to withhold must still be unreachable: Grok's default set includes
// `run_terminal_command`, `write`, `search_replace` and `spawn_subagent`, the
// prompts on this path carry untrusted text (diffs, SPEC bodies, fetched pages),
// and an unscoped call is a prompt-injection path to a shell on the reviewing
// machine. The two allowlists in the scope block below are the only thing
// keeping it unreachable, which is why neither may be empty.
// If a denylist ever returns on a `dontAsk` shape, do NOT put a `scheduler_*`
// tool in it: `scheduler_list` declares a requirement on them, so denying one
// fails session creation outright.

// The system prompt exists to stop the Grok CLI planning instead of answering.
// Override by exporting POLICY_CHAIN_GROK_SYSTEM_PROMPT before calling.
// TWO prompts, picked by the same condition that picks the tool scope below.
// The allowlist path (POLICY_CHAIN_GROK_TOOLS, used by code-review.ts and
// spec-audit.ts with read_file,list_dir,grep) exists precisely so the model CAN
// read repo artifacts — telling it not to would forbid the only tools that path
// grants, and the review would come back thin or empty. The other path is
// prompt-in/answer-out and needs no local reads at all.
function grokSystemPrompt(): string {
  const override = process.env.POLICY_CHAIN_GROK_SYSTEM_PROMPT ?? "";
  if (override !== "") return override;
  let sp = "You are a review service. Answer the message directly. ";
  sp += "Do NOT plan. Do NOT announce or describe what you are ";
  sp += "about to do. Your entire reply must BE the answer itself, ";
  sp += "with no preamble and nothing after it. ";
  if ((process.env.POLICY_CHAIN_GROK_TOOLS ?? "") !== "") {
    sp += "Read whatever repo files you need in order to answer.";
  } else {
    sp += "Answer from the message alone; do not read local files.";
  }
  return sp;
}

// The prompt-in/answer-out path's ALLOWLIST, and the mode welded to it. Measured:
// `dontAsk` cancels a share of runs that call no tool at all (2/8 against a real
// 30k-char prompt, 0/8 under bypassPermissions), and `bypassPermissions`
// ignores --disallowed-tools, so the scoping has to flip to an allowlist in the same change. It must be NON-EMPTY:
// `--tools ''` granted a file write and a shell command, 2/2. This path reads
// nothing, so list_dir is the least-capable non-empty value, not a capability.
const POLICY_CHAIN_GROK_PLAIN_TOOLS = "list_dir";

/** What a shape test reports: its exit status, and the stderr that is quoted as the reason. */
export interface ValidatorResult {
  rc: number;
  stderr: string;
}

/** A shape test: a function of the slot's output file, or the name of a command run on it. */
export type Validator = string | ((outFile: string) => ValidatorResult);

/** Where a walk writes: the answer stream and the diagnostic stream. */
export interface ChainSink {
  out: (chunk: string | Buffer) => void;
  err: (line: string) => void;
}

export interface ChainOptions {
  /** File the answer is written to (truncated first). Unset → stdout. */
  out?: string;
  /** The shape test. Unset → POLICY_CHAIN_VALIDATOR from the environment, if any. */
  validator?: Validator;
  /** Override where the streams go (tests). */
  sink?: Partial<ChainSink>;
}

const defaultSink: ChainSink = {
  out: (chunk) => {
    process.stdout.write(chunk);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

// Is `p` an executable file (`[[ -x ]]`)?
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// `command -v NAME` for an external command: a name with a slash is checked
// where it points; a bare name is looked up on PATH, as the shell would.
export function commandOnPath(name: string): boolean {
  if (name === "") return false;
  if (name.includes("/")) return isExecutable(name) && !statSync(name).isDirectory();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir === "" ? "." : dir, name);
    try {
      if (statSync(p).isFile() && isExecutable(p)) return true;
    } catch {
      // not in this PATH entry
    }
  }
  return false;
}

// Is the caller's validator something this process can actually call? A
// function always is (the shape both real callers use); a name must be a
// command on PATH or an executable path.
function validatorRunnable(v: Validator): boolean {
  if (typeof v === "function") return true;
  return commandOnPath(v) || isExecutable(v);
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where policy.json lives. An explicit POLICY_JSON wins; otherwise it is the
 * table shipped beside this script. The sink parameter is kept for callers
 * that pass one; this lookup has no failure to report.
 */
export function policyChainPolicyPath(_sink: Partial<ChainSink> = {}): string | null {
  const explicit = process.env.POLICY_JSON ?? "";
  if (explicit !== "") return explicit;
  return join(HERE, "policy.json");
}

// The vendor that wrote the code, from `agent=` in the harness record, or ""
// (see the header: THE AUTHOR LEAVES A REVIEW CHAIN).
export function policyChainAuthor(): string {
  const file = process.env.CONTEXTIUM_HARNESS_FILE || join(HERE, "..", "..", "harness");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  let agent = "";
  for (const line of text.split("\n")) {
    const m = /^\s*agent\s*=\s*(.*)$/.exec(line);
    if (m) {
      agent = (m[1] ?? "").replace(/["' \r]/g, "");
      break;
    }
  }
  if (agent === "claude" || agent === "codex" || agent === "gemini" || agent === "grok") return agent;
  if (agent === "antigravity") return "gemini";
  return "";
}

// The exact model a slot's `tracks` names. There is no model catalog here, so
// the default rule is the identity: an exact id is passed through, and a `{v}`
// family — which only a catalog could resolve — fails the slot rather than
// guessing. `bin` is kept in the signature for a resolver that asks the CLI.
// Returns the pin (trailing newlines stripped, as `$(...)` did) and the
// resolver's stderr.
function resolveModel(vendor: string, tracks: string, _bin: string): { ok: boolean; pin: string; stderr: string } {
  const override = process.env.POLICY_CHAIN_RESOLVER ?? "";
  if (override === "") {
    if (tracks.includes("{v}")) {
      return {
        ok: false,
        pin: "",
        stderr: `a model family (${tracks}) needs a resolver; name an exact model or leave tracks empty\n`,
      };
    }
    return { ok: true, pin: tracks, stderr: "" };
  }
  // A command line, split on whitespace on purpose.
  const words = override.split(/[ \t\n]+/).filter((w) => w !== "");
  const cmd = words[0] ?? "";
  const args = [...words.slice(1), vendor, tracks];
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], maxBuffer: 1 << 26 });
  if (res.error) {
    return { ok: false, pin: "", stderr: `${cmd}: ${res.error.message}\n` };
  }
  return { ok: res.status === 0, pin: (res.stdout ?? "").replace(/\n+$/, ""), stderr: res.stderr ?? "" };
}

// The last `n` bytes of a file, as `tail -c n` reads them; "" when absent.
function tailBytes(file: string, n: number): Buffer {
  try {
    const b = readFileSync(file);
    return b.subarray(Math.max(0, b.length - n));
  } catch {
    return Buffer.alloc(0);
  }
}

function nonEmpty(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

// Emit a slot's captured output, guaranteeing a trailing newline. A vendor that
// ends without one would otherwise have its LAST line silently dropped by every
// caller's line-by-line parse — losing the final finding of a review rather
// than failing loudly.
function emit(file: string, sink: ChainSink): void {
  const b = readFileSync(file);
  sink.out(b);
  if (b.length > 0 && b[b.length - 1] !== 0x0a) sink.out("\n");
}

// ── The per-command wall clock ─────────────────────────────────────────
//
// spawnCapped runs `<bin> <args…>` under a wall clock: at the cap, TERM to the
// command's process group; once the group is empty, or CAP_KILL_GRACE_MS later,
// KILL to whatever is left of it; status 124, the coreutils convention. It is a
// small watchdog in a Node child, where coreutils `timeout` and spawnSync's own
// `timeout` both fall short: macOS ships no `timeout`, the implementations
// disagree on the status after a KILL (124 or 137), `timeout` without -k and
// spawnSync both wait forever on a command that ignores TERM, and neither
// reaches what the command started. A command that cannot be started is 127
// (not found) or 126 (not runnable) with the reason on stderr, what a shell
// reports. The watchdog forwards TERM, INT and HUP to the group, so a caller
// that is itself stopped stops the command too. code-review.ts caps its packer
// with it as well.
//
// The cap holds until the captured streams close, not only until the command
// exits: spawnSync returns when its pipes reach EOF, and anything the command
// started holds them. So the leader's exit ends the run only once its group is
// empty; a descendant still running at the cap is stopped with the group and
// the run is 124, not the leader's status. A descendant that left the group is
// out of the watchdog's reach, so spawnSync's own timeout is set past the cap
// and the grace as a backstop: it closes the caller's end of the pipes, and
// that run is 124 too.
const CAP_KILL_GRACE_MS = 3000;
// The watchdog is a Node process of its own: its start-up precedes the cap's
// clock, so a call is measured as overrunning only past cap + this.
const CAP_STARTUP_MS = 500;
const CAP_BACKSTOP_MS = 2000;
const CAP_WATCHDOG = `
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const [capMs, graceMs, bin, ...args] = process.argv.slice(1);
const child = spawn(bin, args, { stdio: "inherit", detached: true });
const group = (sig) => {
  try {
    process.kill(-child.pid, sig);
    return true;
  } catch {
    return false;
  }
};
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => group(sig));
let timedOut = false;
child.on("error", (e) => {
  process.stderr.write(bin + ": " + e.message + "\\n");
  process.exit(e.code === "ENOENT" ? 127 : 126);
});
child.on("exit", (code, signal) => {
  if (timedOut) return;
  const status = code ?? 128 + (constants.signals[signal] ?? 0);
  const done = () => {
    if (group(0) || timedOut) return;
    clearInterval(drain);
    clearTimeout(cap);
    process.exit(status);
  };
  const drain = setInterval(done, 20);
  done();
});
const cap = setTimeout(() => {
  timedOut = true;
  group("SIGTERM");
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (group(0) && Date.now() - t0 < Number(graceMs)) return;
    clearInterval(poll);
    group("SIGKILL");
    process.exit(124);
  }, 50);
}, Number(capMs));
`;

export function spawnCapped(
  capMs: number,
  bin: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const start = Date.now();
  const r = spawnSync(
    process.execPath,
    ["-e", CAP_WATCHDOG, "--", String(capMs), String(CAP_KILL_GRACE_MS), bin, ...args],
    { timeout: capMs + CAP_KILL_GRACE_MS + CAP_BACKSTOP_MS, ...opts },
  );
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  // A descendant that left the process group is out of the watchdog's reach and
  // can hold a captured pipe after the group is empty, so the call returns only
  // when it lets go. A call that outlived its cap by more than the watchdog's own
  // start-up timed out, whatever status the leader left behind.
  const overran = Date.now() - start > capMs + CAP_STARTUP_MS;
  return code === "ETIMEDOUT" || overran ? { ...r, status: 124, signal: null, error: undefined } : r;
}

// `<bin> …` under a per-slot wall clock (spawnCapped), stdin/stdout/stderr
// wired to files. The exit status is the one coreutils would report: the
// child's, or 124 when the clock ran out.
function runTimed(
  secs: string,
  bin: string,
  args: string[],
  stdin: number | "inherit",
  stdoutFile: string,
  stderrFile: string,
): number {
  const outFd = openSync(stdoutFile, "w");
  const errFd = openSync(stderrFile, "w");
  try {
    const ms = Math.max(1, Math.round(Number(secs) * 1000)) || 900_000;
    const r = spawnCapped(ms, bin, args, { stdio: [stdin, outFd, errFd] });
    if (r.error) {
      writeSync(errFd, `${bin}: ${r.error.message}\n`);
      return 126;
    }
    if (r.status !== null) return r.status;
    return 128 + (r.signal === "SIGKILL" ? 9 : 15);
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

function runCodex(bin: string, promptFile: string, out: string, secs: string, pin: string, tmp: string): number {
  const inFd = openSync(promptFile, "r");
  try {
    // An empty pin runs the CLI's own default model: no -m at all.
    const model = pin !== "" ? ["-m", pin] : [];
    return runTimed(secs, bin, ["exec", ...model, POLICY_CHAIN_CODEX_SANDBOX, "-"], inFd, out, `${tmp}/slot.err`);
  } finally {
    closeSync(inFd);
  }
}

function runGrok(
  bin: string,
  promptFile: string,
  out: string,
  secs: string,
  pin: string,
  tmp: string,
  sink: ChainSink,
): number {
  const raw = `${out}.grok-raw`;
  // Two shapes, each a permission MODE plus an allowlist — never a mode alone.
  // Neither carries a denylist.
  //
  // POLICY_CHAIN_GROK_TOOLS set → an agentic read-only run (code review, SPEC
  // audit) that must actually reach repo files. `dontAsk` cancels repo-reading
  // agent runs, and runs that call no tool at all, so no Grok path keeps it:
  // this branch takes bypassPermissions + the caller's allowlist. The allowlist
  // is the only scoping that mode enforces, so the caller's list must be
  // non-empty and read-only — code-review.ts and spec-audit.ts both pass
  // read_file,list_dir,grep. No web hop either: a review reads the repo.
  //
  // Unset → prompt-in/answer-out, no local reads, and no `dontAsk` either: that
  // mode also cancels runs which call NO tool, so this branch takes
  // bypassPermissions + a non-empty allowlist. `--disable-web-search` joins it —
  // this branch answers from the message alone, and a mode that cannot cancel is
  // not a reason to leave a web hop reachable.
  const tools = process.env.POLICY_CHAIN_GROK_TOOLS ?? "";
  const scope =
    tools !== ""
      ? ["--permission-mode", "bypassPermissions", "--tools", tools, "--disable-web-search"]
      : ["--permission-mode", "bypassPermissions", "--tools", POLICY_CHAIN_GROK_PLAIN_TOOLS, "--disable-web-search"];
  // `--verbatim` because without it the CLI TRUNCATES a large --prompt-file and
  // offloads the rest to a file the model is told to read, forcing an agent loop
  // whose narration lands in `.text`. The prompts on this path are review diffs
  // and SPEC audits — routinely large enough to trip it — and a review that comes
  // back as first-turn narration with no findings is indistinguishable from a
  // clean pass. Tool denial (the cancelled branch below) is one cause of
  // narration-instead-of-answer; this is the other.
  //
  // The other two flags travel with it: verbatim ALONE still self-cancelled 8/8
  // on a real 27k-char prompt, because the CLI's default system prompt makes it a
  // planning agent and its default effort resolves to xhigh. Two measurements
  // disagreed, so the union ships.
  const sysprompt = grokSystemPrompt();
  // --no-plan is the CLI's own switch for the planning behaviour the flags
  // above fight indirectly.
  // An empty pin runs the CLI's own default model: no -m at all.
  const model = pin !== "" ? ["-m", pin] : [];
  const rc = runTimed(
    secs,
    bin,
    [
      "--prompt-file",
      promptFile,
      ...model,
      "--output-format",
      "json",
      "--verbatim",
      "--no-plan",
      "--reasoning-effort",
      "high",
      "--system-prompt-override",
      sysprompt,
      ...scope,
    ],
    "inherit",
    raw,
    `${tmp}/slot.err`,
  );
  if (rc !== 0) {
    rmSync(raw, { force: true });
    return rc;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(raw, "utf8"));
  } catch {
    parsed = undefined;
  }
  const obj =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  // A cancelled run exits 0 and still carries `.text`, but that text is the
  // narration the model emitted before it was cut off — NOT an answer. Returning
  // it would hand the caller a confident-looking partial as if it were the whole
  // review, so fail the slot and say why.
  if (obj?.stopReason === "cancelled") {
    sink.err(
      "policy-chain: grok run was CANCELLED mid-agent-loop (stopReason=cancelled); output is partial narration, not an answer",
    );
    sink.err("policy-chain: grok: a cancel most often means the permission mode regressed to dontAsk");
    rmSync(raw, { force: true });
    return 1;
  }
  // `--output-format json` emits one object carrying `.text`. When the payload
  // is not that shape, fall back to the raw stdout so a CLI format change
  // surfaces the model's output instead of an empty "success".
  const t = obj?.text;
  const text =
    t === undefined || t === null || t === false
      ? ""
      : (typeof t === "string" ? t : JSON.stringify(t)).replace(/\n+$/, "");
  if (text !== "") {
    writeFileSync(out, `${text}\n`);
  } else {
    renameSync(raw, out);
    return 0;
  }
  rmSync(raw, { force: true });
  return 0;
}

// jq's string interpolation of a field: a string as is, null/absent as "null",
// anything else as its JSON.
function jqField(v: unknown): string {
  if (v === undefined || v === null) return "null";
  return typeof v === "string" ? v : JSON.stringify(v);
}

interface Slot {
  vendor: string;
  model: string;
  tracks: string;
}

// The row's slots, `chain` or (a panel row) `voices`; null when the file does
// not parse or names no such row.
function readSlots(
  policy: string,
  taskKind: string,
): { slots: Slot[]; known: string; isReview?: boolean; fallback?: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(policy, "utf8"));
  } catch {
    return { slots: [], known: "" };
  }
  const rows =
    doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>).rows : undefined;
  if (rows === null || typeof rows !== "object" || Array.isArray(rows)) return { slots: [], known: "" };
  const rowMap = rows as Record<string, unknown>;
  const known = Object.keys(rowMap).sort().join(", ");
  const row = Object.hasOwn(rowMap, taskKind) ? rowMap[taskKind] : undefined;
  if (row === undefined || row === null || row === false || typeof row !== "object") return { slots: [], known };
  const r = row as Record<string, unknown>;
  const list = r.chain ?? r.voices ?? [];
  if (!Array.isArray(list)) return { slots: [], known };
  const slots: Slot[] = [];
  for (const s of list) {
    const o = s !== null && typeof s === "object" ? (s as Record<string, unknown>) : {};
    const tr = o.tracks;
    slots.push({
      vendor: jqField(o.vendor),
      model: jqField(o.model),
      tracks: tr === undefined || tr === null || tr === false ? "" : jqField(tr),
    });
  }
  // A review row is one read from `.chain`; a panel (`.voices`) keeps every
  // seat when the author is left out.
  const isReview = r.chain !== undefined && r.chain !== null && r.chain !== false;
  const fallback = typeof r.fallback === "string" ? r.fallback : "";
  return { slots, known, isReview, fallback };
}

function walk(
  taskKind: string,
  promptFile: string,
  validator: Validator | undefined,
  outPath: string,
  tmp: string,
  sink: ChainSink,
): number {
  const e = (msg: string) => sink.err(`policy-chain: ${msg}`);
  let lastWasTimeout = false;
  let anySchemaReject = false;

  if (taskKind === "" || promptFile === "") {
    e("usage: policyRunChain <task-kind> <prompt-file>");
    return 2;
  }

  const policy = policyChainPolicyPath(sink) ?? "";
  if (!existsSync(policy) || !statSync(policy).isFile()) {
    e(`policy.json not found at ${policy}`);
    e("it ships beside policy-chain.ts; reinstall, or point POLICY_JSON at a copy");
    return 2;
  }

  if (!existsSync(promptFile) || !statSync(promptFile).isFile()) {
    e(`prompt file not found: ${promptFile}`);
    return 2;
  }
  // Never burn an agent run on an empty prompt: the vendor would answer
  // something, and that answer would be indistinguishable from a real one.
  if (statSync(promptFile).size === 0) {
    e(`prompt file is empty: ${promptFile} — refusing to invoke any vendor`);
    return 2;
  }

  // Checked BEFORE the first vendor is invoked, not at the moment of use: an
  // unrunnable shape test discovered after a slot answered has already cost the
  // slot, and the walk would then have to choose between accepting an unchecked
  // answer and throwing away a good one. Neither is right, so it is a caller
  // error up here where nothing has been spent yet.
  if (validator !== undefined && !validatorRunnable(validator)) {
    const name = typeof validator === "string" ? validator : "(function)";
    e(`POLICY_CHAIN_VALIDATOR '${name}' is not a function, command, or executable`);
    e(
      "refusing to run the chain: an unrunnable shape test that defaulted to accept would silently reinstate the hole it was set to close",
    );
    return 2;
  }

  // The policy is the SSOT for which vendor does which work-type. An unknown
  // task-kind is an error, never a silent default — same contract as the router,
  // where an unknown TaskKind is a compile error.
  const { slots, known, isReview, fallback } = readSlots(policy, taskKind);
  if (slots.length === 0) {
    e(`no policy row for task-kind '${taskKind}'`);
    e(`known rows: ${known}`);
    return 2;
  }

  const secs = process.env.POLICY_CHAIN_SLOT_TIMEOUT_S || POLICY_CHAIN_DEFAULT_SLOT_TIMEOUT_S;
  const out = `${tmp}/slot.out`;

  // The author's vendor, for a review row (`.chain`); a panel (`.voices`) keeps
  // every seat.
  const author = isReview ? policyChainAuthor() : "";

  // The whole chain is read up front rather than streamed. The walk has to know
  // whether a NEXT slot exists before it names a failure: promising "trying next
  // slot" on a one-slot row is a diagnostic that lies about what happens next.
  for (let i = 0; i < slots.length; i++) {
    const { vendor, model, tracks } = slots[i] as Slot;
    if (vendor === "") continue;
    const next = i + 1 < slots.length ? " — trying next slot" : "";

    if (author !== "" && vendor === author && vendor !== "claude") {
      e(`${vendor} left out of '${taskKind}': it wrote the code (.agents/harness agent=)${next}`);
      lastWasTimeout = false;
      continue;
    }

    if (vendor === "claude") {
      // The Claude slot is the agent layer's job, not this script's — an agent
      // gets fresh context and repo tools, which a one-shot CLI call does not.
      // Terminal, not a fallthrough: the caller must dispatch its own agent (or,
      // for a gate that requires vendor independence from the author, report
      // unavailable) rather than have this walk answer for it.
      e(`chain for '${taskKind}' reached the claude slot (${model}) — dispatch the Claude agent instead`);
      return 3;
    }

    let bin: string;
    if (vendor === "codex") bin = process.env.CODEX_BIN || "codex";
    else if (vendor === "grok") bin = process.env.GROK_BIN || "grok";
    else {
      e(`unsupported vendor '${vendor}' in the '${taskKind}' chain${next}`);
      lastWasTimeout = false;
      continue;
    }

    // A slot's `tracks` names the exact model it runs. An EMPTY tracks runs the
    // CLI's own default model — the shipped table leaves it empty, so each
    // vendor runs whatever its user configured. A family that does not resolve
    // is refused rather than run as something else.

    if (!commandOnPath(bin) && !isExecutable(bin)) {
      e(`${vendor} CLI absent (${bin})${next}`);
      lastWasTimeout = false;
      continue;
    }

    const res = tracks === "" ? { ok: true, pin: "", stderr: "" } : resolveModel(vendor, tracks, bin);
    writeFileSync(`${tmp}/resolve.err`, res.stderr);
    if (tracks !== "" && (!res.ok || res.pin === "")) {
      const why = tailBytes(`${tmp}/resolve.err`, 300).toString("utf8").replace(/\n+$/, "");
      e(`${vendor} slot (${model}) could not resolve ${tracks}: ${why} — refusing to run the CLI default${next}`);
      lastWasTimeout = false;
      continue;
    }
    const pin = res.pin;

    writeFileSync(out, "");
    writeFileSync(`${tmp}/slot.err`, "");
    const rc =
      vendor === "codex"
        ? runCodex(bin, promptFile, out, secs, pin, tmp)
        : runGrok(bin, promptFile, out, secs, pin, tmp, sink);

    if (rc === 0) {
      // The shape test, between "the CLI exited 0" and "this slot answered" —
      // the only place a rejection still has a backup to fall through to.
      if (validator !== undefined) {
        let vrc: number;
        if (typeof validator === "function") {
          const v = validator(out);
          vrc = v.rc;
          writeFileSync(`${tmp}/validator.err`, v.stderr);
        } else {
          // stdout to /dev/null: this walk's answer stream is what the caller
          // parses, and a chatty validator would be read as findings.
          const errFd = openSync(`${tmp}/validator.err`, "w");
          try {
            const r = spawnSync(validator, [out], { stdio: ["inherit", "ignore", errFd] });
            vrc = r.status ?? 128 + (r.signal === "SIGKILL" ? 9 : 15);
            if (r.error) vrc = 127;
          } finally {
            closeSync(errFd);
          }
        }
        if (vrc !== 0) {
          let vreason = "";
          if (nonEmpty(`${tmp}/validator.err`)) {
            vreason = `: ${tailBytes(`${tmp}/validator.err`, 500).toString("utf8").replace(/\n/g, " ")}`;
          }
          e(`${vendor} answered in the wrong shape (validator exit ${vrc})${vreason}${next}`);
          lastWasTimeout = false;
          anySchemaReject = true;
          continue;
        }
      }
      process.env.POLICY_CHAIN_VENDOR = vendor;
      process.env.POLICY_CHAIN_MODEL = model;
      e(`answered: ${vendor}/${model} (row '${taskKind}')`);
      if (outPath === "") emit(out, sink);
      else {
        const b = readFileSync(out);
        appendFileSync(outPath, b);
        if (b.length > 0 && b[b.length - 1] !== 0x0a) appendFileSync(outPath, "\n");
      }
      return 0;
    }

    if (rc === 124) {
      e(`${vendor} timed out after ${secs}s${next}`);
      lastWasTimeout = true;
    } else {
      e(`${vendor} failed (exit ${rc})${next}`);
      lastWasTimeout = false;
    }
    // The vendor's own last words. Without this a quota lockout, an expired
    // auth, or a bad flag all read as a bare exit code, which takes a session
    // to diagnose.
    if (nonEmpty(`${tmp}/slot.err`)) {
      e(`${vendor} stderr (last 500B): ${tailBytes(`${tmp}/slot.err`, 500).toString("utf8").replace(/\n/g, " ")}`);
    }
  }

  // A one-slot row prints no "trying next slot" line above, so this sentence is
  // the whole story for it. Named `or was unavailable` because an absent CLI and
  // a crashed one are both exhaustion from the caller's side.
  e(`every vendor in the '${taskKind}' chain failed or was unavailable (${slots.length} slot(s) tried)`);
  // Contextium: a review row marked `"fallback": "fresh-context"` does not end
  // in "unavailable" when no vendor could answer — most installs have one model
  // CLI, and no review at all is worse than a weaker one said plainly. It returns
  // 3, the code callers already treat as "dispatch your own fresh-context agent".
  // Vendors that were ALIVE but answered in the wrong shape (125, below) are not
  // unavailable, so they keep the re-ask path instead.
  if (!anySchemaReject && fallback === "fresh-context") {
    e(
      `no independent vendor for '${taskKind}' — fall back to a fresh-context review, NOT independent (the row's fallback)`,
    );
    return 3;
  }
  if (lastWasTimeout) return 124;
  // At least one slot was ALIVE and answered, and what it said was the wrong
  // shape. ANY such slot earns this code, not merely the last one: a caller's
  // re-ask re-walks the WHOLE chain, so a primary that narrated is recoverable
  // even when the backup behind it was dead. Keying on the last slot would have
  // withheld the re-ask in exactly that case — primary narrates, backup down —
  // which is the compound outage the re-ask is most needed for.
  if (anySchemaReject) return 125;
  return 1;
}

/**
 * Public entry point. Walks `taskKind`'s chain on `promptFile` and returns the
 * status in the header's table. The per-call scratch dir is removed on every
 * return path, and POLICY_CHAIN_VALIDATOR is gone from the environment
 * afterwards whatever happened.
 */
export function policyRunChain(taskKind: string, promptFile: string, opts: ChainOptions = {}): number {
  const sink: ChainSink = { ...defaultSink, ...opts.sink };
  // Strip the environment's validator while keeping its value. Left in
  // process.env it would reach every vendor CLI this walk spawns, and any
  // nested chain call.
  const envValidator = process.env.POLICY_CHAIN_VALIDATOR ?? "";
  delete process.env.POLICY_CHAIN_VALIDATOR;
  const validator: Validator | undefined = opts.validator ?? (envValidator !== "" ? envValidator : undefined);
  const outPath = opts.out ?? "";
  if (outPath !== "") writeFileSync(outPath, "");
  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), "policy-chain-"));
  } catch {
    sink.err("policy-chain: cannot create a scratch dir");
    return 2;
  }
  try {
    return walk(taskKind, promptFile, validator, outPath, tmp, sink);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    // One gate's shape test must not survive into the next gate's run in the
    // same process — it would silently apply the wrong contract to the wrong
    // answer, which is harder to spot than no test at all.
    delete process.env.POLICY_CHAIN_VALIDATOR;
  }
}
