// corrections.test.ts — what survives the filter, and what each row looks like.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/corrections.test.ts
//
// The fixture database carries the message shapes T3 really writes, including
// a turn carrying two citations on one line. It is built in a temporary folder
// by the test itself; the script is spawned. Local time is the rows' clock, so
// every child runs with TZ pinned to the zone the fixtures' times are written for.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "corrections.ts");
const TMP = mkdtempSync(join(tmpdir(), "corrections-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const is = (name: string, got: string, want: string): void => assert.equal(got, want, name);
const has = (name: string, got: string, needle: string): void =>
  assert.ok(got.includes(needle), `${name}: '${got}' lacks '${needle}'`);
const hasnt = (name: string, got: string, needle: string): void =>
  assert.ok(!got.includes(needle), `${name}: '${got}' should not contain '${needle}'`);

type Run = { out: string; rc: number };

// The zone the fixtures' local times are written for, and no harness session
// variable from the shell running the suite: a session id there would send a
// thread-less run to that harness's transcript instead of this database.
const HARNESS_VARS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CONTEXTIUM_SESSION", "CODEX_THREAD_ID", "CODEX_SESSION_ID"];
function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, TZ: "America/Los_Angeles", ...env };
  for (const k of HARNESS_VARS) delete e[k];
  return e;
}

/** `$(… 2>&1)`: stdout and stderr together, trailing newlines stripped. */
function run(env: Record<string, string>, ...args: string[]): Run {
  const e = childEnv(env);
  if (!("WORKBENCH_THREAD_ID" in env)) delete e.WORKBENCH_THREAD_ID;
  // --no-warnings: Node 22.6–22.17 warn that type stripping is experimental.
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: e,
    timeout: 60_000,
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\n+$/, ""), rc: r.status ?? -1 };
}

const T3 = join(TMP, "t3");
mkdirSync(join(T3, "userdata"), { recursive: true });
const TID = "ffffffff-1111-2222-3333-777777777777";
const OTHER = "99999999-1111-2222-3333-888888888888";

const CITE1 =
  "[Assistant quote](t3-citation://v1/a/b/c?text=The+library+commit+swept&start=1&comment=How+can+we+prevent+that%3F)";
const CITE2 =
  "[Assistant quote](t3-citation://v1/a/b/c?text=app-health.sh+exited+2&comment=what+hooks+do+we+need%2C+and+why%3F)";
const NOCOMMENT = "[Assistant quote](t3-citation://v1/a/b/c?text=just+a+quote&start=5&end=9)";

const MESSAGES = `create table projection_thread_messages (
  message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
  role TEXT NOT NULL, text TEXT NOT NULL, is_streaming INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const ACTIVITIES = `create table projection_thread_activities (
  activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
  tone TEXT, kind TEXT NOT NULL, summary TEXT, payload_json TEXT,
  created_at TEXT NOT NULL, sequence INTEGER)`;

// The fixtures are written by a child Node: node:sqlite loads unflagged only
// from Node 22.13, and this suite runs on 22.6 too, where it needs
// --experimental-sqlite — a flag a running test cannot give itself. So a
// fixture records its statements and replays them in a child that has it.
const REPLAY = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
for (const op of JSON.parse(require("fs").readFileSync(0, "utf8"))) {
  if (op.params) db.prepare(op.sql).run(...op.params);
  else db.exec(op.sql);
}
db.close();
`;
class FixtureDb {
  private ops: { sql: string; params?: unknown[] }[] = [];
  private path: string;
  constructor(path: string) {
    this.path = path;
  }
  exec(sql: string): void {
    this.ops.push({ sql });
  }
  prepare(sql: string): { run: (...params: unknown[]) => void } {
    return { run: (...params) => void this.ops.push({ sql, params }) };
  }
  close(): void {
    const r = spawnSync(
      process.execPath,
      ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", "-e", REPLAY, this.path],
      { input: JSON.stringify(this.ops), encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`fixture ${this.path}: ${r.stderr}`);
  }
}

type Adders = {
  add: (thread: string, role: string, text: string, at: string) => void;
  addAct: (thread: string, kind: string, payload: object, at: string) => void;
};

function adders(db: FixtureDb): Adders {
  const ins = db.prepare(`insert into projection_thread_messages
  (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
  values (?,?,?,?,?,0,?,?)`);
  const act = db.prepare(`insert into projection_thread_activities
  (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
  values (?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  let a = 0;
  return {
    add: (thread, role, text, at) => {
      ins.run(`m${n++}`, thread, "t", role, text, at, at);
    },
    addAct: (thread, kind, payload, at) => {
      const id = `a${a++}`;
      act.run(id, thread, "t", "info", kind, "s", JSON.stringify(payload), at, a);
    },
  };
}

{
  const db = new FixtureDb(join(T3, "userdata/state.sqlite"));
  db.exec(MESSAGES);
  db.exec(ACTIVITIES);
  const { add, addAct } = adders(db);

  // 03:15 UTC on the 14th is 20:15 on the 13th in Los Angeles.
  add(TID, "user", "This is way too long.  What are my options simply?", "2026-09-14T03:15:00.000Z");
  add(TID, "assistant", "a long answer nobody asked to be quoted", "2026-09-14T03:16:00.000Z");
  add(TID, "user", "$close", "2026-09-14T03:17:00.000Z");
  add(TID, "user", "/implement checkout-flow r2", "2026-09-14T03:18:00.000Z");
  add(TID, "user", `${CITE1} ${CITE2}`, "2026-09-14T03:19:00.000Z");
  add(TID, "user", NOCOMMENT, "2026-09-14T03:20:00.000Z");
  add(TID, "user", `${NOCOMMENT}\nso what do we do about it?`, "2026-09-14T03:21:00.000Z");
  add(
    TID,
    "user",
    "Close should create the work tree.\n\nAre you sure this is the right shape?",
    "2026-09-14T03:22:00.000Z",
  );
  add(TID, "user", "/close but first tell me why the push failed", "2026-09-14T03:23:00.000Z");
  add(OTHER, "user", "a turn in somebody else thread", "2026-09-14T03:24:00.000Z");

  // The AskUserQuestion channel. T3 records the offered options on
  // `user-input.requested` and the answer given on `user-input.resolved`, keyed by
  // requestId. An answer equal to an offered label is a SELECTION (the agent wrote
  // those words); anything else is free text the user typed.
  const Q1 = "Keep the fold shard or drop it?";
  const Q2 = "Do you ever use a bare /loop?";
  addAct(
    TID,
    "user-input.requested",
    {
      requestId: "r1",
      questions: [
        {
          id: Q1,
          question: Q1,
          options: [
            { label: "Keep the fold shard (Recommended)", description: "d" },
            { label: "Run the two serially instead", description: "d" },
          ],
        },
        { id: Q2, question: Q2, options: [{ label: "Always a fixed interval", description: "d" }] },
      ],
    },
    "2026-09-14T03:25:00.000Z",
  );
  addAct(
    TID,
    "user-input.resolved",
    { requestId: "r1", answers: { [Q1]: "Run the two serially instead", [Q2]: "I never use loop at all." } },
    "2026-09-14T03:26:00.000Z",
  );
  addAct(
    OTHER,
    "user-input.resolved",
    { requestId: "r9", answers: { "someone else question": "someone else answer" } },
    "2026-09-14T03:27:00.000Z",
  );
  db.close();
}

const E = { T3CODE_HOME: T3, HOME: join(TMP, "home"), WORKBENCH_THREAD_ID: TID };

test("per-thread rows", () => {
  const { out: OUT, rc: RC } = run(E);
  const FULL = run(E, "--full").out;

  is("exits 0", String(RC), "0");

  // ── Ordinary turns ─────────────────────────────────────────────────────────

  has("a typed turn is one row, local time first", OUT, "20:15\tThis is way too long.  What are my options simply?");
  has("a multi-line turn prints its first line", OUT, "20:22\tClose should create the work tree.");
  hasnt("…and not its later lines", OUT, "Are you sure this is the right shape?");
  has(
    "--full keeps every line, newlines escaped",
    FULL,
    "Close should create the work tree.\\nAre you sure this is the right shape?",
  );

  // ── Skill invocations are envelopes, not turns ─────────────────────────────

  hasnt("a bare $close is dropped", OUT, "$close");
  hasnt("a slash invocation with arguments is dropped", OUT, "checkout-flow");
  has("an invocation that also says something keeps the something", OUT, "but first tell me why the push failed");

  // ── Citations ──────────────────────────────────────────────────────────────

  has("a citation's comment is the user's words and is kept", OUT, "20:19\tHow can we prevent that?");
  has(
    "two citations on one line both yield their comments",
    FULL,
    "How can we prevent that?\\nwhat hooks do we need, and why?",
  );
  hasnt("the quoted assistant text is never attributed to the user", OUT, "The library commit swept");
  hasnt("…nor the second quote", OUT, "app-health.sh exited 2");
  hasnt("a citation with no comment is dropped entirely", OUT, "just a quote");
  has("a citation with no comment still keeps the prose beside it", OUT, "20:21\tso what do we do about it?");

  // ── Scope ──────────────────────────────────────────────────────────────────

  hasnt("another thread's turns are not this thread's", OUT, "somebody else");
  hasnt("assistant rows are not corrections", OUT, "a long answer");

  // Seven rows survive: five of the nine typed turns (the two invocations and the
  // comment-less citation are the four that do not), plus the two AskUserQuestion
  // answers.
  is("every kept row and no more", String(OUT.split("\n").filter((l) => l !== "").length), "7");

  // ── Ordering ───────────────────────────────────────────────────────────────

  is(
    "rows come out in the order the user said them",
    OUT.split("\n")
      .map((l) => `${l.split("\t")[0]} `)
      .join(""),
    "20:15 20:19 20:21 20:22 20:23 20:26 20:26 ",
  );

  // ── AskUserQuestion answers ─────────────────────────────────────────────
  //
  // Replies given through a question prompt are activities, not messages, and a
  // script reading messages alone never sees them. The Corrections section is the
  // one part of a journal entry the agent does not author, so a blind spot here
  // loses exactly the signal it exists to carry.

  has("a free-text answer is kept as the user's words", OUT, "I never use loop at all.");
  has("a chosen option is kept, marked as a choice", OUT, "[chose] Run the two serially instead");
  hasnt("another thread's answers stay out", OUT, "someone else answer");
  hasnt("an offered option the user did not pick is not a row", OUT, "Always a fixed interval");
  hasnt("the question text is not a row", OUT, "Do you ever use a bare");

  // A selection is the agent's wording that the user picked; free text is their
  // own. Same distinction the script already makes between a citation's `text=`
  // (the agent's) and its `comment=` (the user's) — it decides whether the journal may quote the row
  // or must report it as a choice.
  hasnt("free text is not marked as a choice", OUT, "[chose] I never use loop");

  has("answers carry a time like every other row", OUT, "20:26");
});

// ── A thread nobody typed in ───────────────────────────────────────────────

test("a thread with no turns prints nothing", () => {
  const EMPTY = run(
    { T3CODE_HOME: T3, HOME: join(TMP, "home"), WORKBENCH_THREAD_ID: OTHER },
    "--thread",
    "no-such-thread",
  );
  is("a thread with no turns prints nothing", EMPTY.out, "");
});

// ── A Node that warns when node:sqlite loads ──────────────────────────────
//
// Node 22 and 24 print `ExperimentalWarning: SQLite is an experimental feature`
// on stderr when node:sqlite loads, and callers read this program as `2>&1` —
// a reader may parse window mode's stdout as JSON. The Node running this suite
// may not warn, so a preload makes it: a resolve hook emits the same warning at
// the same moment Node 22 does, when node:sqlite is resolved. A Node without
// module.registerHooks (before 22.15) gets no hook, and the run is still
// checked for a clean output.
const SQLITE_WARN = join(TMP, "sqlite-warns.mjs");
writeFileSync(
  SQLITE_WARN,
  `import * as mod from "node:module";
let warned = false;
mod.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (!warned && specifier === "node:sqlite") {
      warned = true;
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    }
    return nextResolve(specifier, context);
  },
});
`,
);
function runWarning(env: Record<string, string>, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--import", SQLITE_WARN, "--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: childEnv(env),
    timeout: 60_000,
  });
  // Node 22.6–22.17's own type-stripping and typeless-package warnings are not
  // the one under test.
  const err = (r.stderr ?? "")
    .split("\n")
    .filter((l) => !/ExperimentalWarning: Type Stripping|\[MODULE_TYPELESS_PACKAGE_JSON\]|^\(Use `node --trace-warnings/.test(l))
    .join("\n");
  return { out: `${r.stdout ?? ""}${err}`.replace(/\n+$/, ""), rc: r.status ?? -1 };
}

test("no SQLite warning reaches the output on a Node that warns", () => {
  const EMPTY = runWarning({ T3CODE_HOME: T3, HOME: join(TMP, "home") }, "--thread", "no-such-thread");
  is("a thread with no turns still prints nothing", EMPTY.out, "");
});

// Node 22.x prints a type-stripping ExperimentalWarning on stderr in every
// child, thread.ts included. Merged into the thread id, it named a thread that
// does not exist and every row vanished. The preload writes that warning in
// every Node this run starts, as such a Node does.
const STRIP_WARN = join(TMP, "strip-warns.mjs");
writeFileSync(
  STRIP_WARN,
  'process.stderr.write("(node:111) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\\n");\n',
);
test("a Node warning on thread.ts's stderr is not part of the thread id", () => {
  const plain = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    env: childEnv({ T3CODE_HOME: T3, HOME: join(TMP, "home"), WORKBENCH_THREAD_ID: TID }),
  });
  const warned = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    env: childEnv({
      T3CODE_HOME: T3,
      HOME: join(TMP, "home"),
      WORKBENCH_THREAD_ID: TID,
      NODE_OPTIONS: `--import ${STRIP_WARN}`,
    }),
  });
  assert.equal(warned.status, 0, warned.stderr);
  assert.notEqual(plain.stdout, "", "(the thread has rows)");
  is("the same rows with the warning on stderr", warned.stdout, plain.stdout);
});

// ── A missing database is named, not guessed around ────────────────────────

test("a missing database", () => {
  const MISS = run({ T3CODE_HOME: join(TMP, "nowhere"), HOME: join(TMP, "home"), WORKBENCH_THREAD_ID: TID });
  is("a missing database exits 2", String(MISS.rc), "2");
  has("naming the path it tried", MISS.out, join(TMP, "nowhere/userdata/state.sqlite"));
});

// ── Window mode: every thread, one JSON object ─────────────────────────────
//
// A reader of many threads must get the rows a close would have journaled,
// so this fixture reuses the shapes above — a chosen option, a citation
// comment, an invocation — across threads on three harnesses, and adds what
// only the window can get wrong: its two bounds, deleted and assistant-only
// threads, missing metadata, and the assistant message each row answered.

const W3 = join(TMP, "w3");
mkdirSync(join(W3, "userdata"), { recursive: true });
const WA = "aaaaaaaa-0000-0000-0000-000000000001"; // claudeAgent
const WB = "bbbbbbbb-0000-0000-0000-000000000002"; // codex, deleted
const WC = "cccccccc-0000-0000-0000-000000000003"; // grok
const WD = "dddddddd-0000-0000-0000-000000000004"; // assistant only
const WE = "eeeeeeee-0000-0000-0000-000000000005"; // typed only outside the window
const WF = "ffffffff-0000-0000-0000-000000000006"; // no thread row, no session row

{
  const db = new FixtureDb(join(W3, "userdata/state.sqlite"));
  db.exec(MESSAGES);
  db.exec(ACTIVITIES);
  db.exec(`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
  db.exec(`create table projection_thread_sessions (
  thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT,
  updated_at TEXT NOT NULL)`);
  const { add, addAct } = adders(db);
  const thr = db.prepare("insert into projection_threads values (?,?,?,?,?,?)");
  const ses = db.prepare("insert into projection_thread_sessions values (?,?,?,?)");
  const T0 = "2026-09-20T00:00:00.000Z";
  thr.run(WA, "p", "Alpha thread", T0, T0, null);
  thr.run(WB, "p", "Bravo thread", T0, T0, "2026-09-22T20:00:00.000Z");
  thr.run(WC, "p", "Charlie thread", T0, T0, null);
  thr.run(WD, "p", "Delta thread", T0, T0, null);
  thr.run(WE, "p", "Echo thread", T0, T0, null);
  ses.run(WA, "idle", "claudeAgent", T0);
  ses.run(WB, "idle", "codex", T0);
  ses.run(WC, "idle", "grok", T0);
  ses.run(WD, "idle", "claudeAgent", T0);

  // Alpha: a 700-character assistant turn answered on the lower bound itself,
  // then a short one answered with a citation comment. Rows either side of the
  // window, and one exactly on the upper bound, stay out.
  add(WA, "user", "typed before the window", "2026-09-21T23:59:59.999Z");
  add(WA, "assistant", `${"L".repeat(599)}M${"overflow".repeat(100)}`, "2026-09-21T23:59:59.000Z");
  add(WA, "user", "on the lower bound\nand a second line", "2026-09-22T00:00:00.000Z");
  add(WA, "assistant", "short answer", "2026-09-22T06:00:00.000Z");
  add(WA, "user", CITE1, "2026-09-22T07:00:00.000Z");
  add(WA, "assistant", "an answer after the last turn", "2026-09-22T07:30:00.000Z");
  add(WA, "user", "on the upper bound", "2026-09-23T00:00:00.000Z");

  // Charlie: an invocation (dropped) and a typed turn with no assistant before it.
  add(WC, "user", "$close", "2026-09-22T04:00:00.000Z");
  add(WC, "user", "grok turn with nothing before it", "2026-09-22T05:00:00.000Z");
  add(WC, "assistant", "grok answer", "2026-09-22T05:01:00.000Z");

  // Bravo: the question was asked BEFORE the window and answered inside it, so
  // the offered options must be read unwindowed or the choice reads as free text.
  add(WB, "assistant", "which way?", "2026-09-21T22:00:00.000Z");
  addAct(
    WB,
    "user-input.requested",
    {
      requestId: "r1",
      questions: [
        { id: "q", question: "q", options: [{ label: "Run them serially", description: "d" }] },
        { id: "q2", question: "q2", options: [{ label: "Unpicked option", description: "d" }] },
      ],
    },
    "2026-09-21T22:00:01.000Z",
  );
  addAct(
    WB,
    "user-input.resolved",
    { requestId: "r1", answers: { q: "Run them serially", q2: "my own words" } },
    "2026-09-22T12:00:00.000Z",
  );

  add(WD, "assistant", "delta talks to itself", "2026-09-22T09:00:00.000Z");
  add(WE, "user", "echo typed only tomorrow", "2026-09-23T09:00:00.000Z");
  add(WF, "user", "a thread T3 no longer has a row for", "2026-09-22T13:00:00.000Z");
  db.close();
}

// No WORKBENCH_THREAD_ID: window mode must never ask thread.ts for one.
const WE_ = { T3CODE_HOME: W3, HOME: join(TMP, "home") };

test("window mode", () => {
  const WIN = run(WE_, "--since", "2026-09-22T00:00:00Z", "--until", "2026-09-23T00:00:00Z", "--json");
  is("window mode exits 0 with no thread to resolve", String(WIN.rc), "0");
  const WARNED = runWarning(WE_, "--since", "2026-09-22T00:00:00Z", "--until", "2026-09-23T00:00:00Z", "--json");
  is("window mode on a Node that warns about node:sqlite is the same JSON alone", WARNED.out, WIN.out);

  // q(value) — one value out of the window object, rendered as the shell
  // suite's reader printed it: a string bare, anything else as JSON.
  const j: unknown = JSON.parse(WIN.out);
  const q = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
  type W = {
    since: string;
    until: string;
    threads: {
      thread_id: string;
      title: string;
      harness: string;
      deleted: boolean;
      items: { at: string; text: string; reply_to: string | null }[];
    }[];
  };
  const w = j as W;
  const t = w.threads;

  is("the bounds are echoed as given", q([w.since, w.until]), '["2026-09-22T00:00:00Z","2026-09-23T00:00:00Z"]');
  is("exactly the contract keys at the top", q(Object.keys(w)), '["since","until","threads"]');
  is(
    "exactly the contract keys on a thread",
    q(Object.keys(t[0] ?? {})),
    '["thread_id","title","harness","deleted","items"]',
  );
  is("exactly the contract keys on an item", q(Object.keys(t[0]?.items[0] ?? {})), '["at","text","reply_to"]');

  is(
    "threads with a kept row, oldest first item first; assistant-only and out-of-window threads omitted",
    q(t.map((x) => x.thread_id)),
    `["${WA}","${WC}","${WB}","${WF}"]`,
  );
  is(
    "each thread names its harness, unknown when T3 has no session",
    q(t.map((x) => x.harness)),
    '["claudeAgent","grok","codex","unknown"]',
  );
  is(
    "titles come from the thread row, empty when there is none",
    q(t.map((x) => x.title)),
    '["Alpha thread","Charlie thread","Bravo thread",""]',
  );
  is("a deleted thread is kept and marked", q(t.map((x) => x.deleted)), "[false,false,true,false]");

  is(
    "the window keeps its lower bound and drops its upper, and rows outside it",
    q(t[0]?.items.map((i) => i.at)),
    '["2026-09-22T00:00:00.000Z","2026-09-22T07:00:00.000Z"]',
  );
  is("text is the whole turn with real newlines", q(t[0]?.items[0]?.text), "on the lower bound\nand a second line");
  is("a citation is reduced to its comment", q(t[0]?.items[1]?.text), "How can we prevent that?");
  is("an invocation is dropped here too", q(t[1]?.items.map((i) => i.text)), '["grok turn with nothing before it"]');
  is(
    "an answer to an option offered before the window is still a choice",
    q(t[2]?.items.map((i) => i.text)),
    '["[chose] Run them serially","my own words"]',
  );

  is(
    "reply_to is the earlier assistant turn cut to 600 characters",
    q(t[0]?.items[0]?.reply_to),
    `${"L".repeat(599)}M`,
  );
  is("reply_to is the LATEST earlier assistant turn, not a later one", q(t[0]?.items[1]?.reply_to), "short answer");
  is("reply_to is null when nothing came before", q(t[1]?.items[0]?.reply_to), "null");
  is("an answer pairs with the assistant turn that asked", q(t[2]?.items[0]?.reply_to), "which way?");
});

// ── Window mode usage: all three flags or none ─────────────────────────────

test("window mode usage", () => {
  const usageRc = (...args: string[]): string => String(run(WE_, ...args).rc);
  is("--since without --until exits 2", usageRc("--since", "2026-09-22T00:00:00Z", "--json"), "2");
  is("--until without --since exits 2", usageRc("--until", "2026-09-22T00:00:00Z", "--json"), "2");
  is(
    "a window without --json exits 2",
    usageRc("--since", "2026-09-22T00:00:00Z", "--until", "2026-09-23T00:00:00Z"),
    "2",
  );
  is("--json without a window exits 2", usageRc("--json"), "2");
  is(
    "--full does not ride along with a window",
    usageRc("--since", "2026-09-22T00:00:00Z", "--until", "2026-09-23T00:00:00Z", "--json", "--full"),
    "2",
  );
  const USAGE_ERR = run(WE_, "--since", "x", "--json").out;
  has("a usage error prints the usage", USAGE_ERR, "--since <iso> --until <iso> --json");
  const BADDATE = run(WE_, "--since", "yesterday", "--until", "2026-09-23T00:00:00Z", "--json");
  is("a bound that is not a date exits 2", String(BADDATE.rc), "2");
  has("…naming the bound", BADDATE.out, "--since is not a date: yesterday");
  const REVERSED = run(WE_, "--since", "2026-09-23T00:00:00Z", "--until", "2026-09-22T00:00:00Z", "--json");
  is("a reversed window exits 2 rather than reading as silence", String(REVERSED.rc), "2");
  has("…saying which way round", REVERSED.out, "--since must be before --until");
  is(
    "an empty window (since = until) exits 2",
    usageRc("--since", "2026-09-22T00:00:00Z", "--until", "2026-09-22T00:00:00Z", "--json"),
    "2",
  );
  const FEB30 = run(WE_, "--since", "2026-02-30T00:00:00Z", "--until", "2026-03-05T00:00:00Z", "--json");
  is("a day that does not exist (Feb 30) exits 2 rather than becoming March 2", String(FEB30.rc), "2");
  has("…naming the bound", FEB30.out, "--since is not a date: 2026-02-30");

  const WMISS = run(
    { T3CODE_HOME: join(TMP, "nowhere"), HOME: join(TMP, "home") },
    "--since",
    "2026-09-22T00:00:00Z",
    "--until",
    "2026-09-23T00:00:00Z",
    "--json",
  );
  is("window mode on a missing database exits 2", String(WMISS.rc), "2");
  has("…naming the path it tried", WMISS.out, join(TMP, "nowhere/userdata/state.sqlite"));
});

// A harness may reach every skill script through a symlink (a skills folder
// linked to the repo's .agents/skills), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "corrections.ts");
  symlinkSync(SCRIPT, link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...["--no-such-flag"]], {
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /usage: corrections\.ts/);
});
