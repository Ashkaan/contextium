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
//   .agents/skills/close/scripts/t3-db.test.ts

import { statSync } from "node:fs";

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

/**
 * The `orchestration_v2_projection_turn_items` types that are tool calls. T3 writes no
 * `projection_thread_activities` row after the cutover; from then on a tool call is a
 * turn item instead, and no turn item predates the cutover, so the two sources never
 * overlap. Its payload is the turn item's own shape — `input`, `output`,
 * `toolName`, `fileName`, `diffStr` — not the legacy `itemType`/`data` one, so a reader
 * tells them apart by `$.type`.
 */
const V2_TOOL_TYPES = "'command_execution', 'dynamic_tool', 'file_change', 'web_search', 'subagent'";

/**
 * On the v2 file, TEMP views that shadow the legacy table names with live data, so a
 * reader's queries stay as written. SQLite resolves an unqualified name in `temp`
 * before `main`, and a read-only connection may still create temp objects.
 * Empty on the legacy file.
 */
export function legacyViews(dbPath: string): string {
  if (!isV2(dbPath)) return "";
  return `
create temp view projection_threads as select * from ${threadsSource(dbPath)};
create temp view projection_thread_messages as
  select thread_id, role, text, created_at from main.projection_thread_messages
  union
  select thread_id, role, json_extract(payload_json, '$.text'), created_at
  from main.orchestration_v2_projection_messages;
create temp view projection_thread_sessions as
  select thread_id, provider_name from main.projection_thread_sessions
  union
  select thread_id, provider from main.orchestration_v2_projection_provider_sessions;
create temp view projection_thread_activities as
  select thread_id, kind, payload_json, created_at from main.projection_thread_activities
  union all
  select thread_id, 'tool.completed', payload_json,
    coalesce(json_extract(payload_json, '$.startedAt'), updated_at)
  from main.orchestration_v2_projection_turn_items
  where type in (${V2_TOOL_TYPES}) and status in ('completed', 'failed');
`;
}
