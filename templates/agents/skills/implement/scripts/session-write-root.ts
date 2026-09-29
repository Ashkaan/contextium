// session-write-root.ts — the TypeScript face of session-write-root.sh.
//
// Deliberately a thin exec wrapper, not a reimplementation. Worktree discovery,
// the `session-<key>` slug rule, marker lookup and creation all live in the
// shell script; duplicating any of that here would put the design in two places,
// which is the drift "single source of truth" exists to prevent.
//
// It is .ts, not .mjs: every caller is .ts and spells this import with a .ts
// specifier, which is what Node's type stripping resolves against.
//
// Why every scaffold needs this: a script under .agents/skills/ is read from the
// MAIN checkout, so `import.meta.url` can only ever resolve to the main
// checkout — never to the session worktree. See the shell script's header for
// the failure this ends.
//
// There is no second function for the records. `knowledge/`, `journal/`,
// `projects/` are in this repo, so the root a script writes a record under is
// the root below.
//
// peers:
//   .agents/skills/implement/scripts/session-write-root.sh    (the implementation)
//   .agents/skills/implement/scripts/session-write-root.test.sh

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESOLVER = join(dirname(fileURLToPath(import.meta.url)), "session-write-root.sh");

/** Per-process memo. The answer cannot change within one run, and an unmemoized
 *  call would re-fork (and, on the first call, re-enter worktree creation) for
 *  every path a script builds. */
const memo = new Map<string, string>();

export interface SessionWriteRootOptions {
  /** Create the session worktree when it has none. Leave true for anything that
   *  WRITES — that is the whole point. Pass false only to observe the current
   *  root without side effects. */
  create?: boolean;
}

/** `execFileSync` throws an Error carrying the child's stderr. Neither field is
 *  on the base Error type, and both are absent when the throw came from
 *  somewhere else, so read them off an unknown rather than asserting a shape. */
function execDetail(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null;
  return String(err?.stderr ?? err?.message ?? "").trim();
}

/**
 * Absolute root this session must write repo files under — code AND records:
 * `knowledge/`, `journal/` and `projects/` live in the same root, so a
 * record is joined onto this exactly like a source file. In a T3 thread this is
 * the thread's worktree; outside one it is the checkout the script lives in.
 *
 * Throws when the root cannot be resolved (not a git repo, worktree creation
 * failed, ambiguous markers). Throwing is correct: the caller's alternative is
 * writing into the main checkout, which is the bug.
 */
export function sessionWriteRoot(opts: SessionWriteRootOptions = {}): string {
  const create = opts.create !== false;
  const key = create ? "create" : "no-create";
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const args = create ? [] : ["--no-create"];
  let out: string;
  try {
    out = execFileSync(RESOLVER, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`session-write-root: could not resolve this session's write root.\n${execDetail(e)}`);
  }

  const root = out.trim();
  if (!root) throw new Error("session-write-root: resolver returned an empty path");
  memo.set(key, root);
  return root;
}

/** Convenience: join path segments onto the session write root. */
export function inWriteRoot(...segments: string[]): string {
  return join(sessionWriteRoot(), ...segments);
}
