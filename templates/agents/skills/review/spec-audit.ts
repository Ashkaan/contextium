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
//   spec-audit.ts <spec-folder | spec-or-plan-file> <brief>                        round 1
//   spec-audit.ts <spec-folder | spec-or-plan-file> <brief> --follow-up <file>     follow-up round
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
//                          (app SPECs and feature SPECs).
//   $2  brief              Short description of what the SPEC is for.
//   --follow-up <file>     A follow-up round. One line per finding
//                          still open from the previous round, opening with its
//                          ID and a disposition:
//                            F2 accepted: <what changed in the spec>
//                            F3 pushback: <rationale>
//                          Text after the disposition is free (the caller quotes
//                          the finding there too). A blank line is skipped; any
//                          other line, an empty file or a repeated ID is exit 2.
//                          The reviewer gets the CURRENT spec plus these lines,
//                          and must return exactly one verdict per ID. The old
//                          pushback-only round 2 (a bare third argument) is gone:
//                          it never re-read an accepted edit, so a gap an edit
//                          opened surfaced only as code findings later.
//
// Output (stdout): triage lines, one per line, and nothing else.
//   Round 1:
//   [must-fix]   <plan-or-spec-target> <issue> <suggested fix>
//   [should-fix] <issue>
//   [nit]        <issue>
//   [idea]       <section>: <improvement>  (a related improvement the spec
//                misses; not a finding, outside the 8-finding cap)
//   Follow-up:
//   [resolved]   F<n>              (the edit fixed it, or the pushback is right)
//   [open]       F<n> <why>        (the finding stands)
//   [must-fix] / [should-fix]      (only defects the accepted edits introduced)
//
// Output (stderr): every diagnostic, including one line per chain slot tried
// and an `answered: <vendor>/<model>` line naming who did the review.
//
// Round cap: at most MAX_FOLLOW_UPS follow-ups (four reviews in all) per spec
// and thread, counted in ~/.cache/workbench/spec-audit-rounds/<sha256 of the
// spec's real path and the thread id>. The thread id is WORKBENCH_THREAD_ID,
// else T3CODE_THREAD_ID; with neither the cap fails open and nothing is
// counted. Only a follow-up that passed validation spends a round.
//
// Exit:
//   0    A vendor answered.
//   1    The whole `adversarial-review` chain was exhausted. NOT a review.
//   2    Caller error (bad arity, missing file, unknown row).
//   3    No independent reviewer: a row whose declared fresh-context fallback
//        found no eligible vendor. NOT an independent review. Original authors
//        are excluded by policy-chain.ts using POLICY_CHAIN_AUTHOR_VENDORS
//        (.agents/skills/review/SKILL.md). The caller runs the same attack in a
//        FRESH context with its own agent and records
//        `spec-audit: claude-fallback (fresh context, NOT independent) …` — a
//        completed but weaker audit, never an independent one.
//   5    A fourth follow-up on this spec in this thread. NOT sent.
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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";
import { policyRunChain, salvageTriageLine, type ValidatorResult } from "./policy-chain.ts";

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

const ROUND_ONE_MARKERS = ["[must-fix]", "[should-fix]", "[nit]", "[idea]"] as const;
const FOLLOW_UP_MARKERS = ["[resolved]", "[open]", "[must-fix]", "[should-fix]"] as const;
const ROUND_ONE_LINE = /^\[(must-fix|should-fix|nit|idea)\]/;
const FOLLOW_UP_LINE = /^\[(resolved|open|must-fix|should-fix)\]/;
const VERDICT_LINE = /^\[(resolved|open)\]/;

/** Follow-ups allowed per spec and thread after round 1: four reviews in all. */
const MAX_FOLLOW_UPS = 3;

/**
 * The answer as every later reader sees it: one line per answer line, with a
 * marker glued onto narration cut free (salvageTriageLine owns that rule). The
 * shape gate, the count and stdout all read THIS, so they cannot disagree. A
 * follow-up salvages its own markers and has no sentinel: a follow-up
 * NO_FINDINGS stays unparsed and fails below. Specification reviews that glued
 * their first finding to narration had the anchored count see the rest, exit 0,
 * and drop that finding from stdout.
 */
function normalizedLines(text: string, followUp: boolean): string[] {
  const markers = followUp ? FOLLOW_UP_MARKERS : ROUND_ONE_MARKERS;
  return answerLines(text).map((l) => {
    const { line, salvaged } = salvageTriageLine(l, markers, followUp ? null : "NO_FINDINGS");
    if (salvaged !== null) err(`[spec-audit] salvaged a ${salvaged} from a prefixed line`);
    return line;
  });
}

/** The finding ID a verdict line names: its first word, trailing punctuation dropped. */
function verdictId(line: string): string {
  const word = line.replace(/^\[[a-z-]+\]/, "").trimStart().split(/\s/, 1)[0] ?? "";
  return word.replace(/[:,.;]+$/, "");
}

/** What a follow-up answer got wrong against the IDs sent: one line each, empty when sound. */
function verdictProblems(lines: string[], expected: string[]): string[] {
  const seen = new Map<string, number>();
  for (const l of lines) if (VERDICT_LINE.test(l)) seen.set(verdictId(l), (seen.get(verdictId(l)) ?? 0) + 1);
  return [
    ...expected.filter((id) => !seen.has(id)).map((id) => `missing: ${id}`),
    ...expected.filter((id) => (seen.get(id) ?? 0) > 1).map((id) => `duplicate: ${id}`),
    ...[...seen.keys()].filter((id) => !expected.includes(id)).map((id) => `unexpected: ${id}`),
  ];
}

/**
 * The follow-up file's IDs, in order. Every non-blank line must open
 * `F<n> accepted: <text>` or `F<n> pushback: <text>`; anything else is the
 * caller's error, refused before a vendor is spent.
 */
function readDispositions(path: string): { ids: string[]; text: string } {
  const text = chomp(readFileSync(path, "utf8"));
  const ids: string[] = [];
  answerLines(text).forEach((l, i) => {
    if (l.trim() === "") return;
    const m = /^(F\d+) (accepted|pushback): *\S/.exec(l);
    if (!m) {
      err(`Error: follow-up file ${path} line ${i + 1} is not "F<n> accepted: <what changed>" or "F<n> pushback: <rationale>": ${l}`);
      exit(2);
    }
    const id = m[1] as string;
    if (ids.includes(id)) {
      err(`Error: follow-up file ${path} gives ${id} twice`);
      exit(2);
    }
    ids.push(id);
  });
  if (ids.length === 0) {
    err(`Error: follow-up file ${path} holds no dispositions`);
    exit(2);
  }
  return { ids, text };
}

/** This spec's follow-up counter for this thread, or null when no thread id is set (the cap fails open). */
function roundCounter(spec: string): string | null {
  const thread = process.env.WORKBENCH_THREAD_ID || process.env.T3CODE_THREAD_ID || "";
  if (thread === "") return null;
  const key = createHash("sha256").update(`${realpathSync(spec)}\0${thread}`).digest("hex");
  return join(homedir(), ".cache", "workbench", "spec-audit-rounds", key);
}

function followUpsSpent(counter: string): number {
  if (!existsSync(counter)) return 0;
  const n = Number(readFileSync(counter, "utf8").trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function countLines(lines: string[], re: RegExp): number {
  return lines.filter((l) => re.test(l)).length;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const usage = (): never => {
    err(`Usage: ${process.argv[1]} <spec-folder | spec-or-plan-file> <brief> [--follow-up <dispositions-file>]`);
    exit(2);
  };
  if (argv.length !== 2 && !(argv.length === 4 && argv[2] === "--follow-up")) usage();

  const SPEC_FILE = argv[0] as string;
  const BRIEF = argv[1] as string;
  const FOLLOW_UP_FILE = argv[3] ?? "";
  const FOLLOW_UP = FOLLOW_UP_FILE !== "";

  if (!isFile(SPEC_FILE) && !isDir(SPEC_FILE)) {
    err(`Error: SPEC file not found: ${SPEC_FILE}`);
    exit(2);
  }

  if (FOLLOW_UP && !isFile(FOLLOW_UP_FILE)) {
    err(`Error: follow-up file not found: ${FOLLOW_UP_FILE}`);
    exit(2);
  }
  const DISPOSITIONS = FOLLOW_UP ? readDispositions(FOLLOW_UP_FILE) : { ids: [], text: "" };

  // The cap is checked before anything is sent, and spent only once a follow-up
  // passes validation below, so a vendor failure never costs a round.
  const COUNTER = FOLLOW_UP ? roundCounter(SPEC_FILE) : null;
  const SPENT = COUNTER === null ? 0 : followUpsSpent(COUNTER);
  if (FOLLOW_UP && COUNTER === null) {
    err("[spec-audit] no WORKBENCH_THREAD_ID or T3CODE_THREAD_ID — the follow-up cap is not enforced");
  }
  if (SPENT >= MAX_FOLLOW_UPS) {
    err(`Error: this spec has had its ${MAX_FOLLOW_UPS} follow-up rounds in this thread (four reviews). Not sent.`);
    err("Settle each finding still open yourself (.agents/skills/spec-audit/SKILL.md), asking the user only what they alone can answer.");
    exit(5);
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
  if (FOLLOW_UP) {
    ROUND_INSTRUCTIONS = `
FOLLOW-UP ROUND — you reviewed this SPEC before. Each line under DISPOSITIONS
names one of your earlier findings by ID and says what Claude did with it:
"accepted" (the SPEC was edited; the line says how) or "pushback" (the SPEC was
not changed; the line gives the rationale). The SPEC below is the CURRENT text,
edits included.

For each ID, decide whether the finding is settled:

  [resolved] F<n>
      the edit fixes it, or the pushback is right
  [open] F<n> <why, in one brief sentence>
      the edit does not fix it, or the pushback is wrong

Emit exactly one verdict per ID below, the ID copied exactly as the first word
after the bracket prefix. A missing verdict, two verdicts for one ID, or a
verdict for an ID not below fails the round.

You may add new findings ONLY for defects the accepted edits introduced — a
gap, contradiction or broken reference an edit created. This is not a fresh
review: do not raise anything an edit did not cause, and do not list
improvements.

  [must-fix]   <target-file-or-section>: <issue> — <suggested fix> — <the failure it causes>
  [should-fix] <target-or-section>: <issue>

Output format — STRICT. Each line MUST start with its literal bracket prefix.
No markdown bold, no alternate prefixes, no prose. An empty response or a bare
NO_FINDINGS is a FAILED round: every ID needs a verdict.

DISPOSITIONS:
${DISPOSITIONS.text}`;
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
11. Supported inputs — the SPEC's Supported inputs (in a spec folder,
    spec.md § Requirements › Supported inputs) must name each class of input
    the work must handle, with an example and an expected result, and a
    fallback for anything outside those classes. A class the user's ask
    implies but the SPEC omits, a class with no expected result, or
    no fallback for inputs outside the classes is a finding: without it
    every code review invents a new input and calls its handling a bug.
12. Related improvements — what would the user reasonably expect this work to
    do that the SPEC does not mention? These are NOT findings: emit each as an
    [idea] line, at most 5, not counted in the 8-finding cap below.

Required: every [must-fix] finding MUST name the concrete failure it causes
(the data it corrupts, the case it mishandles, the surface it adds for no
named threat). A finding that names no failure cannot be must-fix.

OUTPUT CAP: at most 8 findings total, ranked by severity ([idea] lines are
not findings and are not counted in the 8). If you have more
than 8, the top 8 displace the rest. Forces you to prioritize instead of
flooding the channel.

If the SPEC is too vague to attack on any of the above, that's a [must-fix]
finding — say so explicitly. Don't invent praise.

Output format for round 1 — STRICT. Each finding MUST appear on its own line,
with the literal bracket prefix at the very start of the line. No markdown
bold (no \`**[must-fix]**\`). No alternate prefixes (no \`must-fix:\`,
\`-- must-fix --\`, etc.). Claude parses by line-anchored grep
\`^[must-fix]\`, \`^[should-fix]\`, \`^[nit]\`, \`^[idea]\`; deviations silently drop.

  [must-fix]   <target-file-or-section>: <issue> — <suggested fix> — <the failure it causes>
  [should-fix] <target-or-section>: <issue>
  [nit]        <issue>
  [idea]       <section>: <improvement>

IF YOU AUDITED THE SPEC AND FOUND NOTHING, emit exactly this one line, plus
any [idea] lines, and nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean audit. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED audit
rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.`;
  }

  const PROMPT = `You are an adversarial reviewer of an app SPEC. You're reviewing a SPEC, not
code. The repo conventions you must hold the SPEC to are the Standards in
AGENTS.md at the repo root, and in particular: data is fetched and judgment is
prompted; read before asserting; a class fix is atomic; no deferral; every new
function gets a test, and any work that calls a model carries an eval; the
quality gates are planned before building, with behaviour enumerated at
0 / 1 / empty / max / error inputs; no enforcement for a failure that has not
happened; and the simplest mechanism that works wins.

BRIEF: ${BRIEF}
${ROUND_INSTRUCTIONS}

SPEC CONTENTS:
${SPEC_CONTENTS}`;

  // ── Invoke ────────────────────────────────────────────────────────────

  const PROMPT_FILE = mktempFile("spec-audit-prompt-");
  let RAW_OUT = "";
  try {
    // Prompt as a FILE, piped on stdin — never argv. A long SPEC plus a follow-up
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
    // It reads the same normalized lines the count and stdout read below. A
    // shape test must match the parser it feeds: a gate looser than the parser
    // banks prose, skips the healthy backup and then fails the audit; a gate
    // stricter than it rejects an answer the parser would keep. Same cheap question
    // the full parse below asks, moved to where a "no" still has a backup to fall
    // through to — until now a vendor that answered with prose was banked, the walk
    // stopped, and the untried slot never ran.
    //
    // It is ROUND-AWARE, and that is the whole reason it is chosen per call
    // rather than once at the top of the file. A follow-up adjudicates earlier
    // findings and passes ONLY when every ID sent has exactly one [resolved] /
    // [open] verdict and none other appears; a follow-up reply that is all
    // [must-fix] lines, or the NO_FINDINGS sentinel, is not an answer to what was
    // asked, and reading it as "nothing open" would approve the SPEC unread.
    // Checking the IDs here, not only after the chain, lets a backup vendor
    // answer when the first one skipped an ID.
    const looksLikeAnAudit = (file: string): ValidatorResult => {
      const lines = normalizedLines(readFileSync(file, "utf8"), FOLLOW_UP);
      if (FOLLOW_UP) {
        const problems = verdictProblems(lines, DISPOSITIONS.ids);
        return { rc: problems.length === 0 ? 0 : 1, stderr: problems.join("\n") };
      }
      return { rc: countLines(lines, /^\[(must-fix|should-fix|nit)\]|^NO_FINDINGS$/) > 0 ? 0 : 1, stderr: "" };
    };

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
    // The accepted prefix set is PER ROUND, which matters more than it looks. A
    // follow-up asks for verdicts on prior findings; a reply that came back as
    // `[must-fix]` lines alone would satisfy a shared prefix set, exit 0, and
    // then parse as nothing open — i.e. CONSENSUS — silently converting a held
    // finding into an approving SPEC sign-off.
    const raw = normalizedLines(readFileSync(RAW_OUT, "utf8"), FOLLOW_UP);
    const vendor = process.env.POLICY_CHAIN_VENDOR || "";
    const SENTINEL = countLines(raw, /^NO_FINDINGS$/);
    const who = vendor || "unknown";
    let summary: string;

    if (FOLLOW_UP) {
      // A FOLLOW-UP has no clean-pass shape. Every ID sent needs one verdict:
      // "the reviewer said nothing" and "the reviewer resolved everything" must
      // never read alike, so NO_FINDINGS is REJECTED here even though round 1
      // accepts it, and a missing, doubled or unknown ID fails the round.
      const problems = verdictProblems(raw, DISPOSITIONS.ids);
      if (problems.length > 0) {
        err(`Error: ${vendor || "the reviewer"} did not give exactly one [resolved] / [open] verdict per finding.`);
        for (const p of problems) err(p);
        if (SENTINEL > 0) err("It emitted NO_FINDINGS, which a follow-up does NOT accept.");
        err("Treating as a FAILED round, not a clean pass. Raw output (first 2KB):");
        rawHead();
        exit(1);
      }
      // Spent only now: a follow-up that failed above never costs a round.
      if (COUNTER !== null) {
        try {
          mkdirSync(join(COUNTER, ".."), { recursive: true });
          writeFileSync(COUNTER, `${SPENT + 1}\n`);
        } catch (e) {
          err(`[spec-audit] could not record the follow-up round (${(e as Error).message}); the cap is not enforced`);
        }
      }
      const resolvedN = countLines(raw, /^\[resolved\]/);
      const openN = countLines(raw, /^\[open\]/);
      const newN = countLines(raw, /^\[(must-fix|should-fix)\]/);
      const of = COUNTER === null ? "" : ` ${SPENT + 1} of ${MAX_FOLLOW_UPS}`;
      summary = `follow-up${of} complete — ${resolvedN} resolved, ${openN} open, ${newN} new finding(s) from ${who}.`;
    } else {
      // ROUND 1 does have a clean-pass shape: a SPEC with nothing wrong is a real
      // outcome, and the sentinel is what distinguishes it from a crash. [idea]
      // lines are not findings: they neither make an audit nor count toward one.
      const FINDING_COUNT = countLines(raw, /^\[(must-fix|should-fix|nit)\]/);
      if (FINDING_COUNT === 0 && SENTINEL === 0) {
        err(`Error: ${vendor || "the reviewer"} produced no findings and no NO_FINDINGS sentinel.`);
        err("Treating as a FAILED audit, not a clean pass. Raw output (first 2KB):");
        rawHead();
        exit(1);
      }
      const ideas = countLines(raw, /^\[idea\]/);
      const ideaNote = ideas > 0 ? `, ${ideas} idea(s)` : "";
      summary =
        FINDING_COUNT > 0
          ? `complete — ${FINDING_COUNT} finding(s)${ideaNote} from ${who}.`
          : `complete — audited clean (NO_FINDINGS) by ${who}${ideaNote}.`;
    }

    // STDOUT CARRIES TRIAGE LINES ONLY. Printing the reviewer's raw stdout let
    // commentary, a restated prompt, or a stray banner into the stream Claude parses
    // — the same contract code-review.ts has always enforced by filtering rather
    // than by asking nicely. Anything dropped is echoed to stderr, so an unparseable
    // audit stays diagnosable instead of silently thinning.
    const keep = FOLLOW_UP ? FOLLOW_UP_LINE : ROUND_ONE_LINE;
    for (const line of raw) {
      if (keep.test(line)) process.stdout.write(`${line}\n`);
      else if (line === "NO_FINDINGS" || line === "") continue;
      else err(`[spec-audit] dropped non-triage line: ${line}`);
    }

    err(`[spec-audit] ${summary}`);
    exit(0);
  } finally {
    rmSync(PROMPT_FILE, { force: true });
    if (RAW_OUT !== "") rmSync(RAW_OUT, { force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
