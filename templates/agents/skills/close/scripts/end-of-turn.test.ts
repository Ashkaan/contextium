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
  end: (p: unknown, opts?: { harness?: string | null; covered?: string; tid?: string | null; slot?: string }) => Run;
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
  const env = (o: { covered?: string; tid?: string | null; slot?: string } = {}) => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME };
    if (o.slot !== undefined) e.WORKBENCH_REVIEW_SLOT = o.slot;
    else delete e.WORKBENCH_REVIEW_SLOT;
    if (o.tid !== null) e.WORKBENCH_THREAD_ID = o.tid ?? tid;
    else delete e.WORKBENCH_THREAD_ID;
    if (o.covered !== undefined) e.END_OF_TURN_TEST_COVERED = o.covered;
    else delete e.END_OF_TURN_TEST_COVERED;
    return e;
  };
  const exec = (args: string[], input: string, o: { covered?: string; tid?: string | null; slot?: string } = {}): Run => {
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
  assert.equal(t.end(payload("grok", "Hi"), { harness: "grok" }).code, 0, "Grok is not covered");
  assert.equal(
    t.end(payload("grok", "Hi"), { harness: "claude" }).code,
    0,
    "a Grok payload through the Claude manifest",
  );
  assert.equal(
    t.end(payload("grok", "Hi", false, { last_assistant_message: "Hi" }), { harness: "codex" }).code,
    0,
    "a Grok payload through the manifest Codex reads, which Grok's hooks file links to, even with Codex's field",
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

// ── a question after a close pauses it ───────────────────────────────

const Q = "Which plan should I keep?";

test("--pause refuses an empty question and a thread with no close; records both markers otherwise", () => {
  const t = thread();
  assert.equal(t.pause("  ").code, 2);
  const early = t.pause(Q);
  assert.equal(early.code, 2);
  assert.match(early.stderr, /no close has finished in this thread/);
  closed(t);
  const r = t.pause(Q);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(t.file("paused"), "utf8").trim(), Q);
  assert.ok(existsSync(t.file("reopened")));
  t.pause("Second question?");
  assert.equal(readFileSync(t.file("paused"), "utf8").trim(), "Second question?", "a second pause replaces the first");
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

test("a reply that does not ask the recorded question is refused naming it, and the pause is consumed either way", () => {
  const t = thread();
  closed(t);
  t.pause(Q);
  const r = t.end(payload("claude", "Which one do you want?"));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Ask it in these words: "Which plan should I keep\?"/);
  assert.ok(!existsSync(t.file("paused")));
  assert.ok(existsSync(t.file("reopened")), "the close stays paused");
});

test("the second stop of an asking turn passes and consumes the pause; an interrupted asking turn's pause is consumed next", () => {
  const t = thread();
  closed(t);
  t.pause(Q);
  assert.equal(t.end(payload("claude", "no question", true)).code, 0);
  assert.ok(!existsSync(t.file("paused")));
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
