#!/usr/bin/env -S node --experimental-strip-types
// spec-audit.ts — Single-round adversarial review of a SPEC (or plan-mode draft
// containing SPEC content), on whichever vendor the policy's
// `adversarial-review` row selects. Returns triaged findings on stdout for
// Claude to read and orchestrate the consensus protocol.
//
// Renamed from an old vendor-named filename: that name pinned a vendor into a
// path, which the assignment table cannot honor. The vendor comes from the
// policy table (policy.json beside this script), walked by
// .agents/skills/review/policy-chain.ts, and a Codex outage falls through to the
// row's declared backup instead of taking the gate down.
//
// Usage:
//   spec-audit.ts <spec-folder | spec-or-plan-file> <brief> [<pushback-file>]
//
// Inputs:
//   $1  spec-folder        A spec-kit folder, `specs/NNN-name/`, which MUST hold
//                          spec.md and plan.md (exit 2 otherwise). Those two,
//                          then tasks.md, research.md, data-model.md,
//                          quickstart.md and every file under contracts/ that
//                          exists, are handed to the reviewer together, each
//                          under a `=== <file> ===` header, because the design is
//                          split across them. report.md is not design and is
//                          never sent. A file that cannot be read is exit 2.
//       spec-or-plan-file  Or the absolute path to one draft SPEC / plan file
//                          (app SPECs and legacy project SPECs).
//   $2  brief              Short description of what the SPEC is for.
//   $3  pushback-file      (optional, round 2) Path to file containing
//                          Claude's pushbacks against round-1 findings.
//                          When present, the reviewer is asked to concede or
//                          restate each prior finding.
//
// Output (stdout): triaged findings, one per line, and nothing else.
//   [must-fix]   <plan-or-spec-target> <issue> <suggested fix>
//   [should-fix] <issue>
//   [nit]        <issue>
//   [concede]    <id>  (round 2 only — Claude's pushback was valid; <id> is the
//                      pushback file's F<n>, which parse-review-output.ts matches)
//   [disagree]   <id> <restated rationale>  (round 2 only)
//
// Output (stderr): every diagnostic, including one line per chain slot tried
// and an `answered: <vendor>/<model>` line naming who did the review.
//
// Exit:
//   0    A vendor answered.
//   1    The whole `adversarial-review` chain was exhausted. NOT a review.
//   2    Caller error (bad arity, missing file, unknown row).
//   3    No independent reviewer: the chain reached a CLAUDE slot, or (on the
//        shipped table) every vendor was unavailable. Contextium: the caller
//        runs the same attack in a FRESH context with its own agent and records
//        `spec-audit: claude-fallback (fresh context, NOT independent) …` — a
//        completed but weaker audit, never an independent one.
//   124  Chain exhausted and the last slot's failure was a timeout.
//
// Note the exit codes: caller errors are 2, not 1, so
// "you called this wrong" and "the review did not happen" are distinguishable —
// the same split code-review.ts already used, now shared by both reviewers.
//
// CODEX_BIN / GROK_BIN / POLICY_CHAIN_SLOT_TIMEOUT_S are honored by
// policy-chain.ts, which holds the CLI invocation shapes; reviewers run
// read-only — an auditor reads and reports, it never writes.
//
// Enforces the spec-audit consensus gate (.agents/skills/spec-audit/SKILL.md).
// The named decision point in the plan-mode step graph between SPEC drafting and
// ExitPlanMode runs this script.
//
// Runs on: plan-mode (via Claude tool call), not pre-commit.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";
import { policyRunChain, type ValidatorResult } from "./policy-chain.ts";

const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// `$(...)` drops trailing newlines.
const chomp = (s: string): string => s.replace(/\n+$/, "");

function mktempFile(prefix: string): string {
  for (;;) {
    const p = join(tmpdir(), `${prefix}${randomBytes(4).toString("hex")}`);
    try {
      writeFileSync(p, "", { flag: "wx" });
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

// grep -c: the lines of `text` matching `re`, a final unterminated line included.
// The reviewer's answer as lines, the ONE reading every gate below shares: the
// chain's shape test, the finding and sentinel counts, and the stdout filter. A
// trailing `\r` is dropped from each line, so a CRLF answer is read as the same
// answer — the shape test cannot bank a reply the counter then rejects.
function answerLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.replace(/\r$/, ""));
}

function countLines(text: string, re: RegExp): number {
  return answerLines(text).filter((l) => re.test(l)).length;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    err(`Usage: ${process.argv[1]} <spec-folder | spec-or-plan-file> <brief> [<pushback-file>]`);
    exit(2);
  }

  const SPEC_FILE = argv[0] as string;
  const BRIEF = argv[1] as string;
  const PUSHBACK_FILE = argv[2] ?? "";

  if (!isFile(SPEC_FILE) && !isDir(SPEC_FILE)) {
    err(`Error: SPEC file not found: ${SPEC_FILE}`);
    exit(2);
  }

  if (PUSHBACK_FILE !== "" && !isFile(PUSHBACK_FILE)) {
    err(`Error: pushback file not found: ${PUSHBACK_FILE}`);
    exit(2);
  }

  let SPEC_CONTENTS = "";
  if (isDir(SPEC_FILE)) {
    // spec.md holds the behavior contract and plan.md the shape; a folder missing
    // either would be "audited" without the part the review exists to read.
    for (const f of ["spec.md", "plan.md"]) {
      if (!isFile(`${SPEC_FILE}/${f}`)) {
        err(`Error: spec folder has no ${f}: ${SPEC_FILE}`);
        exit(2);
      }
    }
    // Every design file spec-kit's plan can produce, in reading order. report.md
    // is not design and is left out.
    const design: string[] = [];
    for (const f of ["spec.md", "plan.md", "tasks.md", "research.md", "data-model.md", "quickstart.md"]) {
      if (isFile(`${SPEC_FILE}/${f}`)) design.push(f);
    }
    if (isDir(`${SPEC_FILE}/contracts`)) {
      // Captured and checked, so a find that fails stops the audit instead of
      // quietly sending the design without its contracts.
      const found = spawnSync("find", [`${SPEC_FILE}/contracts`, "-type", "f"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 1 << 30,
      });
      if (found.status !== 0) {
        err(`Error: cannot list ${SPEC_FILE}/contracts`);
        exit(2);
      }
      // Sorted here, in byte order (what `LC_ALL=C sort` prints): the bash piped
      // through a locale-dependent `sort` whose failure went unnoticed, and an
      // unchecked sorter that dies sends the design without its contracts.
      const prefix = `${SPEC_FILE}/`;
      const contracts = (found.stdout ?? "")
        .split("\n")
        .filter((c) => c !== "")
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const c of contracts) design.push(c.startsWith(prefix) ? c.slice(prefix.length) : c);
    }
    for (const f of design) {
      let body: string;
      try {
        body = chomp(readFileSync(`${SPEC_FILE}/${f}`, "utf8"));
      } catch {
        err(`Error: cannot read ${SPEC_FILE}/${f} — refusing to audit a partial design`);
        exit(2);
      }
      SPEC_CONTENTS += `=== ${f} ===\n${body}\n\n`;
    }
  } else {
    SPEC_CONTENTS = chomp(readFileSync(SPEC_FILE, "utf8"));
  }

  let ROUND_INSTRUCTIONS: string;
  if (PUSHBACK_FILE !== "") {
    const PUSHBACK_CONTENTS = chomp(readFileSync(PUSHBACK_FILE, "utf8"));
    ROUND_INSTRUCTIONS = `
ROUND 2 — Claude has responded to your prior findings. For each item below,
either CONCEDE (Claude's pushback is valid; the finding should be dropped) or
DISAGREE (the finding stands; restate the rationale once, briefly).

Output format for round 2 — STRICT. Each verdict MUST appear on its own line,
with the literal bracket prefix at the very start of the line. No markdown
bold (no \`**[concede]**\`). No alternate prefixes like \`concede:\` or
\`-- concede --\`. Claude parses by line-anchored grep \`^\\[concede\\]\` and
\`^\\[disagree\\]\`; deviations are silently dropped.

  [concede] <finding-id>
  [disagree] <finding-id> <one-sentence restated rationale>

<finding-id> is the ID the pushback below opens with (F1, F2, ...), copied
exactly as the first word after the bracket prefix — never a quote or a
paraphrase. Emit exactly one verdict per pushback: a pushback with no verdict,
two verdicts, or a verdict for an ID not below fails the round.

Every pushback above needs a verdict. Emit at least one [concede] or
[disagree] line — an empty response, or a bare NO_FINDINGS, is treated as a
FAILED audit rather than agreement, because a round with no verdicts is
indistinguishable from a crash and would otherwise read as consensus.

CLAUDE'S PUSHBACKS:
${PUSHBACK_CONTENTS}`;
  } else {
    ROUND_INSTRUCTIONS = `
ROUND 1 — Adversarial review of the SPEC below. Find design flaws BEFORE code
is written.

CRITICAL FRAMING — this SPEC exists where every caller is the owner's own code. Defense-in-depth
findings (per-caller credentials, allowlists, retry primitives, isolation
layers) MUST be weighed against the simplest mechanism that works, and nothing
is built for a failure mode that has not occurred. If a finding adds a
control surface against an unenumerated threat, downgrade it to [nit] or
omit. Defense-in-depth is over-engineering until a real threat is named.

Attack across these dimensions:

1. Behavior contract gaps — anything ambiguous, contradictory, or missing.
2. Input/output contract holes — params not typed, KV writes missing
   envelope/SLA, side effects not enumerated.
3. Boundary cases — 0 / 1 / empty / max / error rows missing or hand-waved.
4. Downstream consumers — does the SPEC name them or grep for them?
5. Peer/sibling-feature consistency — does the SPEC list parallel patterns
   in the same app and update them too?
6. Doc surface drift — which READMEs / SPECs / index files will go stale,
   and is the SPEC's "what changes" section accounting for them?
7. Failure modes — refuse-to-write conditions, partial-success behavior,
   retry-exhausted state.
8. Class-fix atomicity — if the SPEC describes a fix to a shared mechanism,
   does it sweep all peers in the same session, or quietly defer?
9. Shape proportionality — is the proposed shape (function / module / daemon /
   service / portal) proportionate to the user's verbatim ask? If the SPEC
   proposes a deployed service when a function would satisfy the ask,
   that's a [must-fix] finding: the shape exceeds the ask.
10. Control-surface budget — count auth layers, retry primitives, validation
    passes, isolation primitives in the SPEC. For each, is the surface paying
    its weight against a CONCRETE NAMED threat in the SPEC's threat model, or
    is it speculative? Speculative surfaces are [must-fix] cuts, not [must-fix]
    additions.

Required: every [must-fix] finding MUST name the concrete failure it causes
(the data it corrupts, the case it mishandles, the surface it adds for no
named threat). A finding that names no failure cannot be must-fix.

OUTPUT CAP: at most 8 findings total, ranked by severity. If you have more
than 8, the top 8 displace the rest. Forces you to prioritize instead of
flooding the channel.

If the SPEC is too vague to attack on any of the above, that's a [must-fix]
finding — say so explicitly. Don't invent praise.

Output format for round 1 — STRICT. Each finding MUST appear on its own line,
with the literal bracket prefix at the very start of the line. No markdown
bold (no \`**[must-fix]**\`). No alternate prefixes (no \`must-fix:\`,
\`-- must-fix --\`, etc.). Claude parses by line-anchored grep
\`^[must-fix]\`, \`^[should-fix]\`, \`^[nit]\`; deviations silently drop.

  [must-fix]   <target-file-or-section>: <issue> — <suggested fix> — <the failure it causes>
  [should-fix] <target-or-section>: <issue>
  [nit]        <issue>

IF YOU AUDITED THE SPEC AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean audit. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED audit
rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.`;
  }

  const PROMPT = `You are an adversarial reviewer of an app SPEC. You're reviewing a SPEC, not
code. The repo conventions you must hold the SPEC to are documented in
AGENTS.md, section Standards (data is fetched and judgment is prompted, read
before asserting, a class fix is atomic, no deferral, simplest mechanism that
works, plan the four before building, tests and evals).

BRIEF: ${BRIEF}
${ROUND_INSTRUCTIONS}

SPEC CONTENTS:
${SPEC_CONTENTS}`;

  // ── Invoke ────────────────────────────────────────────────────────────

  const PROMPT_FILE = mktempFile("spec-audit-prompt-");
  let RAW_OUT = "";
  try {
    // Prompt as a FILE, piped on stdin — never argv. A long SPEC plus a pushback
    // file is exactly the input that dies "Argument list too long" on argv, and the
    // CLI hanging on an unfed stdin until killed is the
    // other half the pipe closes: the vendor gets EOF when the file ends.
    writeFileSync(PROMPT_FILE, `${PROMPT}\n`);

    // policy-chain.ts keeps its own diagnostics on stderr, so the captured stream is
    // findings-only. It is captured rather than passed straight through because
    // "exit 0" is not the same claim as "an audit happened" — see the sentinel check
    // below.
    RAW_OUT = mktempFile("spec-audit-out-");

    // Same read-only allowlist as code-review.ts, for the same reason: under a
    // denylist, grok's run was CANCELLED the first time it reaches for a
    // denied tool, and the audit reports a healthy vendor as exhausted. Both
    // agentic callers of this chain must scope it the same way.
    process.env.POLICY_CHAIN_GROK_TOOLS = "read_file,list_dir,grep";

    // The chain's shape test: is this output an AUDIT at all?
    //
    // ANCHORED (`^\[`), deliberately, and NOT the same as code-review.ts's. That
    // script's parser SALVAGES a marker a vendor glued onto the end of a
    // narration line, so an unanchored gate there matches what its parser will
    // actually accept. This script has no salvage: it counts line-anchored prefixes
    // only. An unanchored gate here would bank a prose answer that merely MENTIONS
    // `[must-fix]`, skip the healthy backup, and then fail the audit as unparseable
    // — the exact hole the gate was added to close. A shape test must match the
    // parser it feeds, not the other gate's parser. Same cheap question
    // the full parse below asks, moved to where a "no" still has a backup to fall
    // through to — until now a vendor that answered with prose was banked, the walk
    // stopped, and the untried slot never ran.
    //
    // It is ROUND-AWARE, and that is the whole reason it is chosen per call
    // rather than once at the top of the file. Round 2 adjudicates pushback and
    // accepts ONLY [concede] / [disagree]; a round-2 reply carrying [must-fix] — or
    // the NO_FINDINGS sentinel — is not an answer to what was asked, and the parse
    // below would read "no disagreements" as CONSENSUS and approve the SPEC
    // unread. A wrapper-level validator sharing one prefix set across both rounds
    // would hand exactly that back as a pass.
    const shape = PUSHBACK_FILE !== "" ? /^\[(concede|disagree)\]/ : /^\[(must-fix|should-fix|nit)\]|^NO_FINDINGS$/;
    const looksLikeAnAudit = (file: string): ValidatorResult => ({
      rc: countLines(readFileSync(file, "utf8"), shape) > 0 ? 0 : 1,
      stderr: "",
    });

    const RC = policyRunChain("adversarial-review", PROMPT_FILE, { out: RAW_OUT, validator: looksLikeAnAudit });

    const rawHead = (): void => {
      const b = readFileSync(RAW_OUT);
      process.stderr.write(b.subarray(0, 2048));
    };

    switch (RC) {
      case 0:
        break;
      case 125:
        // Every vendor was alive and answered; none produced an audit. This script
        // has no re-ask of its own, so there is nothing further to spend — but it
        // is named separately from a dead chain because the two need different
        // fixes, and "the chain is exhausted" would send the reader to check quotas
        // for vendors that were answering fine.
        err("Error: no vendor in the chain produced a parseable audit. The SPEC was NOT audited.");
        err("Every slot answered; none in the shape this round accepts. Raw output (first 2KB):");
        rawHead();
        exit(1);
        break;
      case 3:
        err("[spec-audit] no independent reviewer answered the 'adversarial-review' row.");
        err("Run this same audit with a fresh-context agent of your own, and record it as");
        err("  spec-audit: claude-fallback (fresh context, NOT independent) …");
        err("(format-trailer.ts <mode> claude-fallback …). A completed but weaker audit,");
        err("never an independent one.");
        exit(3);
        break;
      case 124:
        err("Error: every vendor in the chain timed out. The SPEC was NOT audited.");
        exit(124);
        break;
      case 2:
        err("Error: the audit could not be dispatched (see above). It did NOT run.");
        exit(2);
        break;
      default:
        err("Error: the 'adversarial-review' chain is exhausted. The SPEC was NOT audited.");
        exit(1);
    }

    // A vendor answered — which is NOT the same as an audit having happened. Without
    // this, a slot that exits 0 having said nothing produced a silent pass, and the
    // caller would build an APPROVING `spec-audit:` trailer out of it: byte-identical
    // to a clean audit, on a SPEC nothing read. code-review.ts has guarded this since
    // it was written; spec-audit once did not, and the peer script's
    // own header calls it "the highest-severity failure the contract guards".
    //
    // The accepted prefix set is PER ROUND, which matters more than it looks. Round 2
    // asks for verdicts on prior findings, and `parse-review-output.ts` counts only
    // `[concede]` / `[disagree]`. A round-2 reply that came back as `[must-fix]`
    // would satisfy a shared prefix set, exit 0, and then parse as zero disagreements
    // — i.e. CONSENSUS — silently converting a held finding into an approving SPEC
    // sign-off. Round 2 therefore accepts verdicts only.
    const raw = readFileSync(RAW_OUT, "utf8");
    const vendor = process.env.POLICY_CHAIN_VENDOR || "";
    let FINDING_COUNT: number;
    const SENTINEL = countLines(raw, /^NO_FINDINGS$/);

    if (PUSHBACK_FILE !== "") {
      // ROUND 2 has no clean-pass shape. Every pushback needs a verdict, and
      // `parse-review-output.ts` reports `verdict: consensus` when it counts zero
      // `[disagree]` lines — so "the reviewer said nothing" and "the reviewer
      // conceded everything" are the SAME input to it, and the second is an
      // approving SPEC trailer. `NO_FINDINGS` is therefore REJECTED here even though
      // round 1 accepts it: an unadjudicated pushback must fail loud rather than
      // pass quietly.
      FINDING_COUNT = countLines(raw, /^\[(concede|disagree)\]/);
      if (FINDING_COUNT === 0) {
        err(`Error: ${vendor || "the reviewer"} returned no [concede] / [disagree] verdict for round 2.`);
        if (SENTINEL > 0) {
          err("It emitted NO_FINDINGS, which round 2 does NOT accept — a pushback round");
          err("with no verdicts would parse as consensus and approve the SPEC unread.");
        }
        err("Treating as a FAILED audit, not a clean pass. Raw output (first 2KB):");
        rawHead();
        exit(1);
      }
    } else {
      // ROUND 1 does have a clean-pass shape: a SPEC with nothing wrong is a real
      // outcome, and the sentinel is what distinguishes it from a crash.
      FINDING_COUNT = countLines(raw, /^\[(must-fix|should-fix|nit)\]/);
      if (FINDING_COUNT === 0 && SENTINEL === 0) {
        err(`Error: ${vendor || "the reviewer"} produced no findings and no NO_FINDINGS sentinel.`);
        err("Treating as a FAILED audit, not a clean pass. Raw output (first 2KB):");
        rawHead();
        exit(1);
      }
    }

    // STDOUT CARRIES TRIAGE LINES ONLY. Printing the reviewer's raw stdout let
    // commentary, a restated prompt, or a stray banner into the stream Claude parses
    // — the same contract code-review.ts has always enforced by filtering rather
    // than by asking nicely. Anything dropped is echoed to stderr, so an unparseable
    // audit stays diagnosable instead of silently thinning.
    for (const line of answerLines(raw)) {
      if (/^\[(must-fix|should-fix|nit|concede|disagree)\]/.test(line)) process.stdout.write(`${line}\n`);
      else if (line === "NO_FINDINGS" || line === "") continue;
      else err(`[spec-audit] dropped non-triage line: ${line}`);
    }

    if (FINDING_COUNT > 0) {
      err(`[spec-audit] complete — ${FINDING_COUNT} finding(s) from ${vendor || "unknown"}.`);
    } else {
      err(`[spec-audit] complete — audited clean (NO_FINDINGS) by ${vendor || "unknown"}.`);
    }
    exit(0);
  } finally {
    rmSync(PROMPT_FILE, { force: true });
    if (RAW_OUT !== "") rmSync(RAW_OUT, { force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
