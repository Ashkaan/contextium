#!/usr/bin/env -S node --experimental-strip-types --test
// end-of-turn.test.ts — the end-of-turn check, run as a program.
//
// Each case gets its own thread id under a throwaway HOME, so its state folder
// (~/.cache/workbench/threads/<id>/) starts empty; WORKBENCH_THREAD_ID names
// the thread, as thread.ts allows a suite to. The payloads are the ones the
// harnesses sent in a measured run (tests/fixtures/end-of-turn/),
// with their cwd and reply replaced. A ledger worktree is a clone of a local
// bare repo, so "landed" means pushed to that origin.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/end-of-turn.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
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
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "end-of-turn.ts");
const FIX = join(HERE, "tests", "fixtures", "end-of-turn");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "end-of-turn-test-")));
const HOME = join(ROOT, "home");
const CWD = join(ROOT, "cwd");
mkdirSync(CWD, { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

const PROOF = "origin/main is at 0123456789abcdef0123456789abcdef01234567 — closing this tab loses nothing.";
const REPORT = `**Shipped:** a thing\n\n**Journal:** [x.md](<x.md>)\n\n${PROOF}\n`;

type H = "claude" | "codex" | "grok";
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8"));

/** A payload as harness `h` sends it, from the captured fixtures. */
function payload(
  h: H,
  reply: string | null,
  second = false,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (h === "grok") {
    const p = { ...fixture("grok-stop"), cwd: CWD, stopHookActive: second, stop_hook_active: second };
    return reply === null ? { ...p, ...extra } : { ...p, lastAssistantMessage: reply, ...extra };
  }
  return {
    ...fixture(`${h}-${second ? "second" : "first"}-stop`),
    cwd: CWD,
    stop_hook_active: second,
    last_assistant_message: reply,
    ...extra,
  };
}

interface Thread {
  tid: string;
  state: string;
  file: (name: string) => string;
  put: (name: string, body?: string) => void;
  /** End a turn: run the check on a payload. */
  end: (
    p: unknown,
    opts?: { harness?: string | null; covered?: string; tid?: string | null; slot?: string; t3?: string },
  ) => Run;
  pause: (q: string) => Run;
}
interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function thread(): Thread {
  const tid = randomUUID();
  const state = join(HOME, ".cache", "workbench", "threads", tid);
  mkdirSync(state, { recursive: true });
  const env = (o: { covered?: string; tid?: string | null; slot?: string; t3?: string } = {}) => {
    // T3CODE_HOME is a throwaway too, never the live ~/.t3: the fixtures carry
    // real session ids (the helper rule looks each one up).
    const e: NodeJS.ProcessEnv = { ...process.env, HOME, T3CODE_HOME: o.t3 ?? join(ROOT, "no-t3") };
    if (o.slot !== undefined) e.WORKBENCH_REVIEW_SLOT = o.slot;
    else delete e.WORKBENCH_REVIEW_SLOT;
    if (o.tid !== null) e.WORKBENCH_THREAD_ID = o.tid ?? tid;
    else delete e.WORKBENCH_THREAD_ID;
    if (o.covered !== undefined) e.END_OF_TURN_TEST_COVERED = o.covered;
    else delete e.END_OF_TURN_TEST_COVERED;
    return e;
  };
  const exec = (
    args: string[],
    input: string,
    o: { covered?: string; tid?: string | null; slot?: string; t3?: string } = {},
  ): Run => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
      input,
      encoding: "utf8",
      cwd: CWD,
      env: env(o),
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    tid,
    state,
    file: (n) => join(state, n),
    put: (n, body = "") => writeFileSync(join(state, n), body),
    end: (p, o = {}) =>
      exec(
        o.harness === null ? [] : ["--harness", o.harness ?? "claude"],
        typeof p === "string" ? p : JSON.stringify(p),
        o,
      ),
    pause: (q) => exec(["--pause", q], ""),
  };
}

const closed = (t: Thread, report = REPORT): void => {
  t.put("closed");
  t.put("report", report);
};
const stateLog = (t: Thread): string =>
  existsSync(t.file("end-of-turn.log")) ? readFileSync(t.file("end-of-turn.log"), "utf8") : "";
const globalLog = (): string => {
  const f = join(HOME, ".cache", "workbench", "end-of-turn.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

// ── A ledger worktree: a clone of a bare origin ───────────────────────────

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function worktree(): string {
  const d = mkdtempSync(join(ROOT, "repo-"));
  git(d, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(d, "clone", "-q", join(d, "origin.git"), "wt");
  const wt = join(d, "wt");
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-q", "-m", "a");
  git(wt, "push", "-q", "origin", "HEAD:main");
  git(wt, "remote", "set-head", "origin", "main");
  return wt;
}
const land = (wt: string): void => {
  git(wt, "add", "-A");
  if (git(wt, "status", "--porcelain").trim()) git(wt, "commit", "-q", "-m", "work");
  git(wt, "push", "-q", "origin", "HEAD:main");
};
const ledger = (t: Thread, ...wts: string[]): void =>
  t.put("worktrees", wts.map((w) => `${w}\t${w}\tbranch\n`).join(""));

const PASTE =
  /Paste the close report \(saved at .*\/report\) verbatim, ending with its last line:\n\n\*\*Shipped:\*\* a thing\n[\s\S]*\norigin\/main is at 0123[^\n]*\n\n/;
const UNLANDED = /This thread closed earlier and has work not landed: run \/close\./;
const PAUSE = /--pause "<question>"/;

// ── The proof line reaches the user ───────────────────────────────────────

test("no state folder for the thread: allowed, nothing written", () => {
  const t = thread();
  rmSync(t.state, { recursive: true });
  assert.equal(t.end(payload("claude", "Hi")).code, 0);
  assert.ok(!existsSync(t.state));
});

test("a report not delivered: refused every first stop until a reply carries its last line; the second stop passes", () => {
  const t = thread();
  closed(t);
  const first = t.end(payload("claude", "Done, all landed."));
  assert.equal(first.code, 2, first.stderr);
  assert.match(first.stderr, PASTE);
  assert.match(first.stderr, PAUSE, "the refusal says how to ask the user something");
  const second = t.end(payload("claude", "Done.", true));
  assert.equal(second.code, 0, "the second stop of the turn passes");
  assert.ok(!existsSync(t.file("report-delivered")), "…without marking the report delivered");
  assert.equal(t.end(payload("claude", "Anything else?")).code, 2, "the next turn's first stop is refused again");
  const carried = t.end(payload("claude", `**Shipped:** a thing\n\n${PROOF}`));
  assert.equal(carried.code, 0, carried.stderr);
  assert.ok(existsSync(t.file("report-delivered")), "a reply carrying the line marks it delivered");
  assert.equal(t.end(payload("claude", "Later chat.")).code, 0, "once delivered, later turns are not checked");
});

test("Codex's payload is read the same way, and a rewrapped line still counts", () => {
  const t = thread();
  closed(t);
  assert.equal(t.end(payload("codex", "Closed."), { harness: "codex" }).code, 2);
  const wrapped = PROOF.replace(" is at ", "\n is   at ");
  assert.equal(t.end(payload("codex", wrapped), { harness: "codex" }).code, 0);
  assert.ok(existsSync(t.file("report-delivered")));
});

test("a corrected reply on the second stop that carries the line marks it delivered; the next ordinary turn passes", () => {
  const t = thread();
  closed(t);
  assert.equal(t.end(payload("claude", "Done.")).code, 2);
  assert.equal(t.end(payload("claude", PROOF, true)).code, 0);
  assert.ok(existsSync(t.file("report-delivered")));
  assert.equal(t.end(payload("claude", "Hello again.")).code, 0);
});

test("an empty reply lacks the line; an empty report is allowed and logged", () => {
  const t = thread();
  closed(t);
  assert.equal(t.end(payload("claude", "")).code, 2, "an empty reply is refused");
  const e = thread();
  closed(e, "\n\n");
  assert.equal(e.end(payload("claude", "Hi")).code, 0);
  assert.match(stateLog(e), /report is empty/);
});

test("held: allowed, even with an older report undelivered", () => {
  const t = thread();
  closed(t);
  t.put("held", "subject\n");
  assert.equal(t.end(payload("claude", "Running the live checks.")).code, 0);
});

// ── a thread that closed closes again ────────────────────────────────

test("closed with a dirty worktree: refused every turn until a new close lands it; two cycles", () => {
  const t = thread();
  const wt = worktree();
  ledger(t, wt);
  closed(t);
  t.put("report-delivered");
  assert.equal(t.end(payload("claude", "Hi")).code, 0, "clean after the close");
  writeFileSync(join(wt, "later.txt"), "later\n");
  const r = t.end(payload("claude", "I changed a file."));
  assert.equal(r.code, 2);
  assert.match(r.stderr, UNLANDED);
  assert.match(r.stderr, PAUSE);
  assert.equal(t.end(payload("claude", "Ok.", true)).code, 0, "the second stop passes");
  assert.equal(t.end(payload("claude", "Next turn.")).code, 2, "the next turn is refused again");
  land(wt);
  assert.equal(t.end(payload("claude", "Landed.")).code, 0, "a new close landed it");
  writeFileSync(join(wt, "again.txt"), "again\n");
  assert.equal(t.end(payload("claude", "More work.")).code, 2, "the second cycle is refused too");
  land(wt);
  assert.equal(t.end(payload("claude", "Landed again.")).code, 0);
});

test("a review-chain vendor running in a closed thread's worktree is allowed and logged, never told to close", () => {
  const t = thread();
  const wt = worktree();
  ledger(t, wt);
  closed(t);
  t.put("report-delivered");
  writeFileSync(join(wt, "spec.md"), "a spec under review\n");
  assert.equal(t.end(payload("codex", "F1: the spec misses a case.")).code, 2, "a session turn is still refused");
  const r = t.end(payload("codex", "F1: the spec misses a case."), { harness: "codex", slot: "codex" });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, UNLANDED);
  assert.match(stateLog(t) + globalLog(), /review-chain codex subprocess/);
});

test("closed with a commit not pushed: refused", () => {
  const t = thread();
  const wt = worktree();
  ledger(t, wt);
  closed(t);
  t.put("report-delivered");
  writeFileSync(join(wt, "c.txt"), "c\n");
  git(wt, "add", "c.txt");
  git(wt, "commit", "-q", "-m", "c");
  assert.match(t.end(payload("claude", "Committed.")).stderr, UNLANDED);
});

test("one worktree unreadable and another unlanded, in either order: refused; unreadable alone: allowed and logged", () => {
  const broken = mkdtempSync(join(ROOT, "not-git-"));
  for (const order of ["broken first", "broken last"]) {
    const t = thread();
    const wt = worktree();
    writeFileSync(join(wt, "dirty.txt"), "d\n");
    if (order === "broken first") ledger(t, broken, wt);
    else ledger(t, wt, broken);
    closed(t);
    t.put("report-delivered");
    assert.equal(t.end(payload("claude", "Hi")).code, 2, order);
  }
  const t = thread();
  ledger(t, broken);
  closed(t);
  t.put("report-delivered");
  assert.equal(t.end(payload("claude", "Hi")).code, 0);
  assert.match(stateLog(t), /could not be read; not refused/);
});

// ── Errors allow ──────────────────────────────────────────────────────────

test("a field of the wrong type, no message this turn, or a payload that is not JSON: allowed and logged", () => {
  const t = thread();
  closed(t);
  assert.equal(t.end(payload("claude", "Hi", false, { stop_hook_active: "no" })).code, 0);
  assert.match(globalLog(), /payload field stop_hook_active is string/);
  assert.equal(t.end(payload("codex", null), { harness: "codex" }).code, 0, "Codex sends null when the turn has none");
  assert.match(globalLog(), /payload field last_assistant_message is null/);
  assert.equal(t.end("not json").code, 0);
  assert.match(globalLog(), /the payload is not JSON/);
});

test("a thread that cannot be resolved: allowed and logged", () => {
  const t = thread();
  const r = t.end(payload("claude", "Hi"), { tid: null });
  assert.equal(r.code, 0, r.stderr);
  assert.match(globalLog(), /no thread for /);
});

test("an error inside the check (an unreadable report): allowed and logged", () => {
  const t = thread();
  closed(t);
  chmodSync(t.file("report"), 0o000);
  try {
    assert.equal(t.end(payload("claude", "Hi")).code, 0);
    assert.match(stateLog(t), /EACCES/);
  } finally {
    chmodSync(t.file("report"), 0o644);
  }
});

// ── only a covered harness is checked ─────────────────────────────

test("an uncovered harness, no --harness, and Grok through the Claude settings file are all allowed", () => {
  const t = thread();
  closed(t);
  assert.equal(t.end(payload("claude", "Hi"), { harness: null }).code, 0, "no --harness");
  assert.equal(
    t.end(payload("grok", "Hi"), { harness: "grok", covered: "claude,codex" }).code,
    0,
    "Grok when it is not covered",
  );
  assert.equal(
    t.end(payload("grok", "Hi"), { harness: "claude", covered: "claude,codex" }).code,
    0,
    "a Grok payload through the Claude manifest when Grok is not covered",
  );
  assert.equal(
    t.end(payload("grok", "Hi", false, { last_assistant_message: "Hi" }), { harness: "codex", covered: "claude,codex" }).code,
    0,
    "a Grok payload through the manifest Codex reads, which Grok's hooks file links to, even with Codex's field, when Grok is not covered",
  );
  assert.equal(t.end(payload("codex", "Hi"), { harness: "codex" }).code, 2, "Codex itself is still checked");
  assert.equal(
    t.end(payload("claude", "Hi"), { covered: "codex", harness: "claude" }).code,
    0,
    "Claude when only Codex is",
  );
  assert.equal(t.end(payload("claude", "Hi")).code, 2, "Claude itself is still checked");
});

test("Grok, when covered: the reply is this turn's agent chunks from its transcript, never an earlier turn's", () => {
  const t = thread();
  closed(t);
  const transcript = join(ROOT, `updates-${t.tid}.jsonl`);
  const row = (kind: string, text: string) =>
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: kind, content: { type: "text", text } } },
    });
  writeFileSync(
    transcript,
    [
      row("user_message_chunk", "close it"),
      row("agent_message_chunk", PROOF),
      row("user_message_chunk", "thanks"),
      row("agent_message_chunk", "You're "),
      row("agent_message_chunk", "welcome."),
      "junk",
    ].join("\n"),
  );
  const p = payload("grok", null, false, { transcriptPath: transcript });
  const r = t.end(p, { harness: "grok", covered: "claude,codex,grok" });
  assert.equal(r.code, 2, "the earlier turn's line does not count for this turn");
  writeFileSync(
    transcript,
    [
      row("user_message_chunk", "close it"),
      row("agent_message_chunk", "Shipped. "),
      row("agent_message_chunk", PROOF),
    ].join("\n"),
  );
  assert.equal(t.end(p, { harness: "grok", covered: "claude,codex,grok" }).code, 0);
  assert.ok(existsSync(t.file("report-delivered")));
  const none = payload("grok", null, false, { transcriptPath: join(ROOT, "absent.jsonl") });
  assert.equal(
    t.end(none, { harness: "grok", covered: "claude,codex,grok" }).code,
    0,
    "an unreadable transcript allows",
  );
});

// ── Grok on the real covered list, from a captured run ───────────────────────
//
// The captures keep `<cwd>`, `<transcript>` and `<session>` in place of the
// run's paths and session id. No case here sets `covered`, so these read
// COVERED.

/** A captured Grok payload, its placeholders filled. */
function grokCapture(name: string, transcript: string): Record<string, unknown> {
  const raw = readFileSync(join(FIX, `${name}.json`), "utf8")
    .replaceAll("<cwd>", CWD)
    .replaceAll("<transcript>", transcript)
    .replaceAll("<session>", `grok-test-${randomUUID()}`);
  return JSON.parse(raw);
}

test("Grok, covered: its captured first stop is refused while the report is undelivered, and its second stop passes", () => {
  const t = thread();
  closed(t);
  const transcript = join(FIX, "grok-transcript.jsonl");
  const first = t.end(grokCapture("grok-first-stop", transcript), { harness: "claude" });
  assert.equal(first.code, 2, "the first stop of a Grok turn through the Claude manifest");
  assert.match(first.stderr, /Paste the close report/);
  assert.ok(!existsSync(t.file("report-delivered")));
  assert.equal(
    t.end(grokCapture("grok-first-stop", transcript), { harness: "grok" }).code,
    2,
    "through --harness grok",
  );
  assert.equal(
    t.end(grokCapture("grok-second-stop", transcript), { harness: "claude" }).code,
    0,
    "the second stop always passes",
  );
});

test("Grok, covered: delivery is found in its real transcript when the payload carries no reply", () => {
  const t = thread();
  closed(t);
  // Grok's shutdown stop carries no `lastAssistantMessage`, so the reply comes
  // from the transcript.
  const bare = (transcript: string) => {
    const p = grokCapture("grok-first-stop", transcript);
    delete p.lastAssistantMessage;
    delete p.last_assistant_message;
    return p;
  };
  const real = readFileSync(join(FIX, "grok-transcript.jsonl"), "utf8");
  const undelivered = join(ROOT, `grok-real-${t.tid}.jsonl`);
  writeFileSync(undelivered, real);
  assert.equal(t.end(bare(undelivered), { harness: "claude" }).code, 2, "the real transcript lacks the line");
  const chunk = JSON.stringify({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${PROOF}` } } },
  });
  const delivered = join(ROOT, `grok-delivered-${t.tid}.jsonl`);
  writeFileSync(delivered, `${real.trimEnd()}\n${chunk}\n`);
  assert.equal(t.end(bare(delivered), { harness: "claude" }).code, 0);
  assert.ok(existsSync(t.file("report-delivered")), "report-delivered written from the transcript");
});

// ── US5: a question after a close pauses it ───────────────────────────────

const Q = "Which plan should I keep?";

test("--pause refuses an empty question; records both markers otherwise, before any close too", () => {
  const t = thread();
  assert.equal(t.pause("  ").code, 2);
  const early = thread();
  // No close yet (a session asking mid-way): recorded, and the asking reply is checked.
  assert.equal(early.pause(Q).code, 0, "a question before any close is recorded");
  assert.ok(existsSync(early.file("reopened")));
  assert.equal(early.end(payload("claude", "Still working on it.")).code, 2, "a reply without it is refused");
  assert.ok(!existsSync(early.file("asked")), "a question never asked is not recorded as asked");
  closed(t);
  const r = t.pause(Q);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(t.file("paused"), "utf8").trim(), Q);
  assert.ok(existsSync(t.file("reopened")));
  t.pause("Second question?");
  assert.equal(readFileSync(t.file("paused"), "utf8").trim(), "Second question?", "a second pause replaces the first");
});

test("a held close's question is checked like any other: refused without it, recorded as asked with it", () => {
  const t = thread();
  t.put("held", "subject\n");
  const r = t.pause(Q);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(t.file("paused"), "utf8").trim(), Q);
  const omit = t.end(payload("claude", "Still checking."));
  assert.equal(omit.code, 2, "the hold no longer lets a reply skip the recorded question");
  assert.match(omit.stderr, /Ask it in these words/);
  assert.ok(!existsSync(t.file("asked")));
  assert.ok(existsSync(t.file("paused")), "the question is kept for the retry");
  // The retry, with no second --pause: the second stop that asks it marks it asked.
  assert.equal(t.end(payload("claude", `Live check failed:\n${Q}`, true)).code, 0);
  assert.ok(existsSync(t.file("asked")), "asked is written when the retry carries the question");
  assert.ok(!existsSync(t.file("paused")));
  assert.equal(t.end(payload("claude", "Waiting on the user.")).code, 0, "held still allows later turns");
});

test("a new --pause clears the earlier question's asked mark until its own reply asks it", () => {
  const t = thread();
  closed(t);
  t.pause(Q);
  assert.equal(t.end(payload("claude", Q)).code, 0);
  assert.ok(existsSync(t.file("asked")));
  t.pause("A second question?");
  assert.ok(!existsSync(t.file("asked")), "the second question has not reached the user yet");
  assert.equal(t.end(payload("claude", "A second question?")).code, 0);
  assert.ok(existsSync(t.file("asked")));
});

test("the asking turn passes when the reply carries the question; every later turn is refused until a new close", () => {
  const t = thread();
  closed(t);
  assert.equal(t.pause(Q).code, 0);
  const ask = t.end(payload("claude", `Before I go on:\n${Q}`));
  assert.equal(ask.code, 0, ask.stderr);
  assert.ok(!existsSync(t.file("paused")), "the pause is consumed");
  for (const reply of ["Keep plan A, done.", PROOF, "No files changed."]) {
    const r = t.end(payload("claude", reply));
    assert.equal(r.code, 2, reply);
    assert.match(r.stderr, /This close is paused for the user's answer: deal with it and close again/);
  }
  assert.equal(t.end(payload("claude", "ok", true)).code, 0, "its second stop passes");
  rmSync(t.file("reopened")); // what land.ts does when a new close completes (land-cases Case 8)
  assert.equal(t.end(payload("claude", "Closed again.")).code, 0);
});

test("a question recorded as a numbered list passes when the reply prints it as that list", () => {
  // Choices go one per line so the reply shows a real list (recorded
  // on one line, they came out as a paragraph); line breaks are collapsed.
  const t = thread();
  closed(t);
  t.pause("Row 9, finance snapshot alert:\n1. Close it as already fixed (recommended).\n2. Keep it open.");
  const reply =
    "Already handled.\n\nRow 9, finance snapshot alert:\n\n1. Close it as already fixed (recommended).\n2. Keep it open.\n";
  assert.equal(t.end(payload("claude", reply)).code, 0);
});

test("a reply that does not ask the recorded question is refused naming it; the question is kept for the retry", () => {
  const t = thread();
  closed(t);
  t.pause(Q);
  const r = t.end(payload("claude", "Which one do you want?"));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Ask it in these words: "Which plan should I keep\?"/);
  assert.ok(existsSync(t.file("paused")), "kept, so the retry is checked");
  assert.ok(existsSync(t.file("reopened")), "the close stays paused");
  // A first-stop retry that asks it passes and marks it asked.
  assert.equal(t.end(payload("claude", `Sorry: ${Q}`)).code, 0);
  assert.ok(!existsSync(t.file("paused")));
  assert.ok(existsSync(t.file("asked")));
});

test("the second stop of an asking turn passes and consumes the pause; an interrupted asking turn's pause is consumed next", () => {
  const t = thread();
  closed(t);
  t.pause(Q);
  assert.equal(t.end(payload("claude", "no question", true)).code, 0);
  assert.ok(!existsSync(t.file("paused")));
  assert.ok(!existsSync(t.file("asked")), "a second stop that never asked it leaves it unasked");
  assert.equal(t.end(payload("claude", "Next turn.")).code, 2, "reopened still holds the close paused");

  const u = thread();
  closed(u);
  u.pause(Q);
  // The asking turn was interrupted: no turn end ran. The next one consumes it.
  assert.equal(u.end(payload("claude", `Asking again: ${Q}`)).code, 0);
  assert.ok(!existsSync(u.file("paused")));
  assert.equal(u.end(payload("claude", "His answer handled.")).code, 2);
});

test("a refused second close (closed cleared, closed-once kept) still refuses work not landed", () => {
  const t = thread();
  const wt = worktree();
  ledger(t, wt);
  t.put("closed-once");
  writeFileSync(join(wt, "after.txt"), "after\n");
  const r = t.end(payload("claude", "Still working."));
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, UNLANDED);
  land(wt);
  assert.equal(t.end(payload("claude", "Landed.")).code, 0);
});

test("--pause after a refused second close (closed-once only) records the pause", () => {
  const t = thread();
  t.put("closed-once");
  const r = t.pause(Q);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(t.file("paused")) && existsSync(t.file("reopened")));
});

// Every case above names its thread with WORKBENCH_THREAD_ID. A session whose
// harness exports no id gets one thread.ts generates for its checkout, and a
// new one once that id's close has landed — so the hook that ran right after
// the close asked thread.ts, got the new id, read its empty state and let a
// reply without the saved proof through (Contextium v9.2.0 review). The hook
// and --pause ask for the id the checkout names now, without starting a new
// one; any other caller still starts a new session after a close.
test("an id-less session's close is checked by the hook that follows it, with no WORKBENCH_THREAD_ID", () => {
  const home = join(ROOT, "native-home");
  const repo = join(ROOT, "native-repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, T3CODE_HOME: join(home, "no-t3") };
  for (const k of ["WORKBENCH_THREAD_ID", "CONTEXTIUM_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "WORKBENCH_REVIEW_SLOT", "END_OF_TURN_TEST_COVERED"])
    delete env[k];
  const node = (script: string, args: string[], input = "") =>
    spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: repo, env, input, encoding: "utf8" });
  const first = node(join(HERE, "thread.ts"), ["--id"]);
  assert.equal(first.status, 0, first.stderr);
  const sid = first.stdout.trim();
  assert.match(sid, /^session-/);
  const state = join(home, ".cache", "workbench", "threads", sid);
  writeFileSync(join(state, "closed"), "");
  writeFileSync(join(state, "report"), REPORT);
  const p = JSON.stringify({ ...payload("claude", "Done."), cwd: repo });
  const r = node(SCRIPT, ["--harness", "claude"], p);
  assert.equal(r.status, 2, `the reply without the proof is refused: ${r.stderr}`);
  assert.match(r.stderr, /does not carry its close report/);
  const ok = node(SCRIPT, ["--harness", "claude"], JSON.stringify({ ...payload("claude", `Closed.\n\n${PROOF}`), cwd: repo }));
  assert.equal(ok.status, 0, ok.stderr);
  const asked = node(SCRIPT, ["--pause", "Ship the copy as is?"]);
  assert.equal(asked.status, 0, `--pause reaches the session that closed: ${asked.stderr}`);
  assert.ok(existsSync(join(state, "reopened")));
  const next = node(join(HERE, "thread.ts"), ["--id"]);
  assert.notEqual(next.stdout.trim(), sid, "any other caller still starts a new session after the close");
});

// ── a helper's turn in the session's folder is the helper's ─────────────
//
// T3 records each harness session id as `nativeThreadRef.nativeId` on the
// provider thread of the T3 thread it runs. A delegated helper shares the
// parent's worktree, so the folder names the parent; the session id names
// the helper.

const HELPER = "thread:delegated-task:command%3Amcp%3Ahelper";

/** A fake T3 home whose database maps each session id to a thread. */
function t3Home(map: Record<string, string>): string {
  const home = mkdtempSync(join(ROOT, "t3-"));
  mkdirSync(join(home, "userdata"));
  const r = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-sqlite",
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite';
       const [file, map] = process.argv.slice(1); const db = new DatabaseSync(file);
       db.exec('create table orchestration_v2_projection_provider_threads(thread_id text, payload_json text)');
       const ins = db.prepare('insert into orchestration_v2_projection_provider_threads values (?, ?)');
       for (const [sid, tid] of Object.entries(JSON.parse(map))) ins.run(tid, JSON.stringify({ nativeThreadRef: { nativeId: sid } }));`,
      join(home, "userdata", "statev2.sqlite"),
      JSON.stringify(map),
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return home;
}

/** A closed thread whose ledger worktree has work not landed. */
function closedUnlanded(): Thread {
  const t = thread();
  const wt = worktree();
  ledger(t, wt);
  closed(t);
  t.put("report-delivered");
  writeFileSync(join(wt, "later.txt"), "later\n");
  return t;
}

/** Every file in the state folder but the log, with its contents. */
const snapshot = (t: Thread): string =>
  spawnSync("sh", ["-c", 'for f in $(ls -A | grep -v \'^end-of-turn.log$\'); do echo "== $f"; cat "$f"; done'], {
    cwd: t.state,
    encoding: "utf8",
  }).stdout;

/** Each covered payload form, with the session id set as that harness sends it. */
const FORMS: { name: string; harness: H; covered?: string; withId: (sid: string | null) => Record<string, unknown> }[] =
  [
    {
      name: "Claude Code",
      harness: "claude",
      withId: (sid) => {
        const p = payload("claude", "Hi");
        if (sid === null) delete p.session_id;
        else p.session_id = sid;
        return p;
      },
    },
    {
      name: "Codex",
      harness: "codex",
      withId: (sid) => {
        const p = payload("codex", "Hi");
        if (sid === null) delete p.session_id;
        else p.session_id = sid;
        return p;
      },
    },
    {
      // Grok's own camelCase id, with the snake_case copy it also sends removed.
      name: "Grok",
      harness: "grok",
      covered: "claude,codex,grok",
      withId: (sid) => {
        const p = payload("grok", "Hi");
        delete p.session_id;
        if (sid === null) delete p.sessionId;
        else p.sessionId = sid;
        return p;
      },
    },
  ];

for (const form of FORMS) {
  test(`${form.name}: a helper's turn on a closed thread with work not landed is allowed and logged in the thread's own log`, () => {
    const t = closedUnlanded();
    const t3 = t3Home({ "sess-helper": HELPER, "sess-own": t.tid });
    const before = snapshot(t);
    const r = t.end(form.withId("sess-helper"), { harness: form.harness, covered: form.covered, t3 });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, UNLANDED);
    assert.match(
      stateLog(t),
      new RegExp(`a helper's turn \\(${HELPER.replace(/[%:]/g, ".")}\\), not thread ${t.tid}'s`),
    );
    assert.doesNotMatch(globalLog(), new RegExp(t.tid), "the line is in the thread's own log, not the global one");
    assert.equal(snapshot(t), before, "no marker is created, removed or changed");
  });

  test(`${form.name}: the session's own turn, an unknown session id and no session id are each refused as today`, () => {
    const t = closedUnlanded();
    const t3 = t3Home({ "sess-helper": HELPER, "sess-own": t.tid });
    for (const [what, sid] of [
      ["its own thread", "sess-own"],
      ["an id T3 has no record of", "sess-unknown"],
      ["no session id", null],
    ] as const) {
      const r = t.end(form.withId(sid), { harness: form.harness, covered: form.covered, t3 });
      assert.equal(r.code, 2, `${what}: ${r.stderr}`);
      assert.match(r.stderr, UNLANDED, what);
    }
    assert.doesNotMatch(stateLog(t), /helper's turn/);
  });
}

test("a session id T3's database cannot be read for is checked as today, and the error logged", () => {
  const t = closedUnlanded();
  const t3 = mkdtempSync(join(ROOT, "t3-bad-"));
  mkdirSync(join(t3, "userdata"));
  writeFileSync(join(t3, "userdata", "statev2.sqlite"), "not a database");
  const r = t.end(FORMS[0]?.withId("sess-helper"), { t3 });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, UNLANDED);
  assert.match(stateLog(t), /session id not looked up: cannot read/);
});

test("a thread with no state folder exits before T3's database is read", () => {
  const t = thread();
  rmSync(t.state, { recursive: true });
  const t3 = mkdtempSync(join(ROOT, "t3-junk-"));
  mkdirSync(join(t3, "userdata"));
  writeFileSync(join(t3, "userdata", "statev2.sqlite"), "not a database");
  const before = globalLog();
  assert.equal(t.end(FORMS[0]?.withId("sess-helper"), { t3 }).code, 0);
  assert.equal(globalLog(), before, "nothing logged: the database was never opened");
  assert.ok(!existsSync(t.state));
});

test("a session lookup that stalls gives up in time for today's check, through the hook wrapper", () => {
  const t = closedUnlanded();
  const t3 = t3Home({ "sess-helper": HELPER });
  const wrapper = join(HERE, "..", "..", "..", "hooks", "check-close-reached.sh");
  const started = Date.now();
  // Not a review-chain subprocess, even when the suite runs inside one (it
  // sets WORKBENCH_REVIEW_SLOT, and the hook allows that before any lookup).
  const { WORKBENCH_REVIEW_SLOT: _slot, ...outer } = process.env;
  const r = spawnSync("bash", [wrapper, "--harness", "claude"], {
    input: JSON.stringify(FORMS[0]?.withId("sess-helper")),
    encoding: "utf8",
    cwd: CWD,
    env: {
      ...outer,
      HOME,
      T3CODE_HOME: t3,
      WORKBENCH_THREAD_ID: t.tid,
      T3_DB_TEST_STALL_MS: "9000",
      END_OF_TURN_TEST_COVERED: "claude",
    },
  });
  assert.equal(r.status, 2, `the check still ran and refused: ${r.stderr}`);
  assert.match(r.stderr, UNLANDED);
  assert.doesNotMatch(r.stderr, /stopped after/, "the wrapper did not have to stop it");
  assert.match(stateLog(t), /session id not looked up: .*no answer within 2000 ms/);
  assert.ok(Date.now() - started < 9_000, "it did not wait for the stalled lookup");
});
