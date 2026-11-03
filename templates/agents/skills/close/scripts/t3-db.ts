// t3-db.ts — which file is T3's state database, and how the close reads a thread from it.
//
// T3 0.0.46 moved its state from `userdata/state.sqlite` to `userdata/statev2.sqlite`.
// The new file carries a copy of the old `projection_*` tables, but T3 stopped writing
// them at the cutover; every thread since exists only in the `orchestration_v2_*`
// tables. Read the old file, or the old tables, and a thread started after the cutover
// is "not in a T3 thread", so every close refuses.
//
// What the v2 file holds:
//   - `orchestration_v2_projection_threads` holds every legacy thread with the same
//     branch, worktree path, created_at and deleted state. Branch and worktree path are
//     in `payload_json` (`$.branch`, `$.worktreePath`).
//   - `orchestration_v2_projection_messages` holds every legacy user message (the union
//     of both is the v2 count) but only part of the assistant history, so messages are
//     read from both and de-duplicated.
//   - Question prompts (`user-input.*`) were recorded on `projection_thread_activities`;
//     their v2 home, `orchestration_v2_projection_runtime_requests`, had no rows when
//     this was written, so its payload shape is unknown and an answer given after the
//     cutover is not read.
//
// peers:
//   .agents/skills/close/scripts/thread.ts        (the thread row)
//   .agents/skills/close/scripts/corrections.ts   (what the user typed)
//   .agents/skills/close/scripts/session.ts       (the whole session, re-read at close)
//   .agents/skills/close/scripts/rows-taken.ts    (the open threads)
//   .agents/skills/close/scripts/t3-db.test.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THREAD = join(dirname(fileURLToPath(import.meta.url)), "thread.ts");

/**
 * This shell's thread id, from `thread.ts --id`, or thread.ts's own refusal without
 * its `thread: ` prefix. The id is stdout alone: a Node 22.x writes a type-stripping
 * warning to stderr on every run, and merged in it named a thread that does not
 * exist. stderr is read only for the refusal.
 */
export function currentThread(requireUnique = false): { id: string } | { error: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", THREAD, "--id", ...(requireUnique ? ["--require-unique"] : [])],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  if (r.status !== 0) {
    const err = (r.stderr ?? "").split("\n").filter((l) => l !== "");
    const why = err.filter((l) => l.startsWith("thread: ")).pop() ?? err.pop() ?? `thread.ts exited ${r.status}`;
    return { error: why.replace(/^thread: /, "") };
  }
  return { id: (r.stdout ?? "").replace(/\n+$/, "") };
}

/** Review guards need the executing task, not an arbitrary owner of its cwd.
 * Ambiguous worktrees provide no cache key until the caller supplies its
 * actual WORKBENCH_THREAD_ID. Code review separately requires a stable audit
 * owner rather than disabling its counter. Outside T3, thread.ts names the
 * harness's own session (its native id, or one generated per tree), so that
 * keys the review the same way; the native ids below are the fallback when
 * thread.ts itself cannot answer. */
export function reviewSessionId(): string {
  const thread = currentThread(true);
  if ("id" in thread) return `t3-${createHash("sha256").update(thread.id).digest("hex")}`;
  if (/ambiguous|cannot (?:read|query)/.test(thread.error)) return "";
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}

/** A cwd/explicit executor belonging to T3 requires explicit review roles.
 * An unreadable or shared T3 context is not permission to disable guards. */
export function inT3ReviewContext(): boolean {
  if (!isFile(t3Database(process.env.T3CODE_HOME || `${process.env.HOME}/.t3`))) return false;
  const thread = currentThread(true);
  return "id" in thread || !/not in a T3 thread|in no ledger/.test(thread.error);
}

/** Conservative provenance: providers recorded for the ORIGINAL writing
 * thread, including run history when transient session records are absent.
 * A reviewer child passes that thread explicitly; its own provider
 * is not the author. This records participants, not byte-level authorship. */
export function recordedReviewAuthors(authorThreadId?: string): { vendors: string[] } | { error: string } {
  const dbPath = t3Database(process.env.T3CODE_HOME || `${process.env.HOME}/.t3`);
  if (!isFile(dbPath)) return authorThreadId ? { error: "writing-thread database unavailable" } : { vendors: [] };
  const id = authorThreadId;
  if (!id)
    return inT3ReviewContext()
      ? { error: "POLICY_CHAIN_AUTHOR_THREAD_ID is required in T3; the executing task is not inferred as the writer" }
      : { vendors: [] };
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `
    import {DatabaseSync} from 'node:sqlite';
    const [file,id,v2]=process.argv.slice(1); const db=new DatabaseSync(file,{readOnly:true});
    const tables=v2==='true'
      ? ['orchestration_v2_projection_provider_sessions','orchestration_v2_projection_runs']
      : ['projection_thread_sessions'];
    const rows=[];
    for (const table of tables) {
      const cols=db.prepare('pragma table_info('+table+')').all().map(c=>c.name);
      if (cols.length===0) continue;
      const column=v2==='true'
        ? (cols.includes('driver')?"coalesce(nullif(driver,''),provider)":'provider')
        : 'provider_name';
      rows.push(...db.prepare('select distinct '+column+' as provider from '+table+' where thread_id=?').all(id));
    }
    console.log(JSON.stringify(rows));
    db.close();
  `,
      dbPath,
      id,
      String(isV2(dbPath)),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.status !== 0) return { error: "cannot read writing-thread provider records" };
  const rows = JSON.parse(child.stdout) as { provider: string | null }[];
  if (rows.length === 0) return { error: "no provider recorded for original writing thread" };
  const vendors = new Set<string>();
  for (const row of rows) {
    if (typeof row.provider !== "string" || row.provider.trim() === "")
      return { error: "empty writing provider record" };
    const name = row.provider.toLowerCase();
    const vendor = /^claude(?:agent|[-_].*)?$/.test(name)
      ? "claude"
      : /^codex(?:[-_].*)?$/.test(name)
        ? "codex"
        : /^grok(?:build|[-_].*)?$/.test(name)
          ? "grok"
          : /^(?:antigravity|gemini)(?:[-_].*)?$/.test(name)
            ? "gemini"
            : null;
    if (!vendor) return { error: `unrecognized writing provider ${row.provider}` };
    vendors.add(vendor);
  }
  return { vendors: [...vendors] };
}

/**
 * Node 22 and 24 print `ExperimentalWarning: SQLite is an experimental feature` on
 * stderr when node:sqlite loads, and callers read these programs as `2>&1` — a
 * reader may parse corrections.ts's window mode as JSON. A program
 * started as `node x.ts` cannot pass itself `--disable-warning=ExperimentalWarning`,
 * so node:sqlite is loaded only after this filter drops that one warning and hands
 * every other warning to the listeners Node installed.
 */
export function silenceSqliteWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /\bSQLite\b/.test(w.message)) return;
    for (const l of listeners) l.call(process, w);
  });
}

/**
 * node:sqlite, loaded in this process, warning silenced. Node 22.5–22.12 have it
 * only behind --experimental-sqlite, which a program started as `node x.ts`
 * cannot pass itself; there the program `script` (the caller's own file) runs
 * once more with the flag, same arguments, same environment, and this process
 * exits as that run does. Every later Node loads it unflagged, so this is the
 * only path on them.
 */
export async function loadSqlite(script: string): Promise<typeof import("node:sqlite")> {
  silenceSqliteWarning();
  try {
    return await import("node:sqlite");
  } catch (e) {
    if (process.execArgv.includes("--experimental-sqlite")) throw e;
    const r = spawnSync(
      process.execPath,
      ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", ...process.execArgv, script, ...process.argv.slice(2)],
      { stdio: "inherit" },
    );
    process.exit(r.status ?? 2);
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The database T3 is writing now: statev2.sqlite when it exists, else the legacy file. */
export function t3Database(t3Home: string): string {
  const v2 = `${t3Home}/userdata/statev2.sqlite`;
  return isFile(v2) ? v2 : `${t3Home}/userdata/state.sqlite`;
}

/** Whether `dbPath` is the v2 file, whose live thread tables are `orchestration_v2_*`. */
export function isV2(dbPath: string): boolean {
  return dbPath.endsWith("/statev2.sqlite");
}

/**
 * A FROM source with the legacy `projection_threads` columns the close reads —
 * thread_id, title, branch, worktree_path, created_at, deleted_at — for either file.
 */
export function threadsSource(dbPath: string): string {
  if (!isV2(dbPath)) return "projection_threads";
  return `(select thread_id, title,
    json_extract(payload_json, '$.branch') as branch,
    json_extract(payload_json, '$.worktreePath') as worktree_path,
    created_at, deleted_at
    from main.orchestration_v2_projection_threads)`;
}

export interface OpenThread {
  id: string;
  title: string;
  worktreePath: string;
}

/**
 * The threads the user has open with a worktree: not deleted, archived or settled
 * (all three in `payload_json`; `deleted_at` is also a column), and not a child
 * task. Read by rows-taken.ts, which asks each one's worktree what it is building.
 *
 * A child task shares its parent's worktree and is never settled, so children can
 * be nearly every unsettled thread with a worktree. T3 marks one with
 * `lineage.parentThreadId` (`lineage` is itself a JSON string); a child also
 * has a `thread:` id, which is the test for a row with no lineage.
 * Parsed here rather than with json_extract: one malformed payload would fail
 * the whole query, and it should cost only its own row, through `warn`.
 */
export function openThreads(
  db: { prepare(sql: string): { all(): unknown[] } },
  warn: (msg: string) => void = () => {},
): OpenThread[] {
  const rows = db
    .prepare(
      `select thread_id, title, payload_json from main.orchestration_v2_projection_threads
       where deleted_at is null order by created_at, thread_id`,
    )
    .all() as { thread_id: string; title: string | null; payload_json: string | null }[];
  const out: OpenThread[] = [];
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload_json ?? "");
      if (p === null || typeof p !== "object") throw new Error("not an object");
    } catch {
      warn(`thread ${r.thread_id}: payload_json is not a JSON object — skipped`);
      continue;
    }
    if (p.deletedAt != null || p.archivedAt != null || p.settledAt != null) continue;
    if (typeof p.worktreePath !== "string" || p.worktreePath === "") continue;
    let lineage: unknown = p.lineage;
    if (typeof lineage === "string") {
      try {
        lineage = JSON.parse(lineage);
      } catch {
        lineage = undefined;
      }
    }
    const isChild =
      lineage !== null && typeof lineage === "object"
        ? (lineage as { parentThreadId?: unknown }).parentThreadId != null
        : r.thread_id.startsWith("thread:");
    if (isChild) continue;
    out.push({ id: r.thread_id, title: r.title ?? "", worktreePath: p.worktreePath });
  }
  return out;
}

/**
 * The `orchestration_v2_projection_turn_items` types that are tool calls. T3 writes no
 * `projection_thread_activities` row after the cutover; from then on a tool call is a
 * turn item instead, and no turn item predates the cutover, so the two sources never
 * overlap. Its payload is the turn item's own shape — `input`, `output`,
 * `toolName`, `fileName`, `diffStr` — not the legacy `itemType`/`data` one, so a reader
 * tells them apart by `$.type`.
 */
const V2_TOOL_TYPES = "'command_execution', 'dynamic_tool', 'file_change', 'web_search', 'subagent'";

/** The table names in a database's `main` schema — what `legacyViews` may union. */
export function mainTables(db: { prepare(sql: string): { all(): unknown[] } }): Set<string> {
  const rows = db.prepare("select name from main.sqlite_master where type = 'table'").all();
  return new Set(rows.map((r) => String((r as { name: unknown }).name)));
}

/**
 * On the v2 file, TEMP views that shadow the legacy table names with live data, so a
 * reader's queries stay as written. SQLite resolves an unqualified name in `temp`
 * before `main`, and a read-only connection may still create temp objects.
 * Empty on the legacy file.
 *
 * A frozen legacy table is unioned only when `tables` (from `mainTables`) still holds
 * it. T3 0.1.1-nightly.20261018 dropped `projection_thread_activities`, and a view
 * naming a missing table fails when it is read: every close's corrections step died
 * with "no such table" that night. `tables` is required so no caller can skip the check.
 * A role-user v2 message an agent created (`createdBy: "agent"` — T3's restart notice,
 * a background-task notice, a subagent's prompt) is not something anyone typed, and is
 * left out. Assistant messages are `createdBy: "agent"` too, and stay: they are what a
 * turn answers (`reply_to`).
 * `source` is the message's `creationSource`: "web" or "mobile" for what the user typed in the
 * app, "server" for what our own scripts sent (T3 stamps those `createdBy: "user"` too),
 * null on the legacy file. Only the corrections reader filters on it; a thread
 * transcript keeps a script's opening prompt, because it is what the thread answered.
 * Every live select names its columns, because with the legacy branch gone it is the
 * first select of its union, and the view takes its column names from it.
 */
export function legacyViews(dbPath: string, tables: ReadonlySet<string>): string {
  if (!isV2(dbPath)) return "";
  const legacy = (name: string, select: string): string[] => (tables.has(name) ? [`${select} from main.${name}`] : []);
  const view = (name: string, parts: string[], joiner: string): string =>
    `create temp view ${name} as\n  ${parts.join(`\n  ${joiner}\n  `)};`;
  // The question answers before the cutover were on the legacy activities table. When
  // T3 has dropped the v2 file's copy, they are still in the frozen `state.sqlite`
  // beside it, attached read-only (the connection's own flags) and read from there.
  const frozen = `${dirname(dbPath)}/state.sqlite`;
  const attachFrozen = !tables.has("projection_thread_activities") && isFile(frozen);
  const activities = attachFrozen
    ? ["select thread_id, kind, payload_json, created_at from t3_legacy.projection_thread_activities"]
    : legacy("projection_thread_activities", "select thread_id, kind, payload_json, created_at");
  return `${attachFrozen ? `\nattach database '${frozen.replaceAll("'", "''")}' as t3_legacy;` : ""}
create temp view projection_threads as select * from ${threadsSource(dbPath)};
${view(
  "projection_thread_messages",
  [
    ...legacy("projection_thread_messages", "select thread_id, role, text, created_at, null as source"),
    "select thread_id, role, json_extract(payload_json, '$.text') as text, created_at, json_extract(payload_json, '$.creationSource') as source\n  from main.orchestration_v2_projection_messages\n  where not (role = 'user' and coalesce(json_extract(payload_json, '$.createdBy'), 'user') = 'agent')",
  ],
  "union",
)}
${view(
  "projection_thread_sessions",
  [
    ...legacy("projection_thread_sessions", "select thread_id, provider_name"),
    ...legacy("orchestration_v2_projection_provider_sessions", "select thread_id, provider as provider_name"),
    ...legacy("orchestration_v2_projection_runs", "select thread_id, provider as provider_name"),
  ],
  "union",
)}
${view(
  "projection_thread_activities",
  [
    ...activities,
    `select thread_id, 'tool.completed' as kind, payload_json,
    coalesce(json_extract(payload_json, '$.startedAt'), updated_at) as created_at
  from main.orchestration_v2_projection_turn_items
  where type in (${V2_TOOL_TYPES}) and status in ('completed', 'failed')`,
  ],
  "union all",
)}
`;
}
