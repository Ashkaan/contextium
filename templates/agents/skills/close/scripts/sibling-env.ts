// sibling-env.ts — the UPSTREAM_<REPO>_DIR variables verify.ts sets before it
// runs any suite, one per worktree this thread holds.
//
// A product repo's test that holds a copy to its sibling repo (a site's test
// reading the workbench's database schema, say) looks for `UPSTREAM_<REPO>_DIR`
// first and `~/code/<repo>` second. When one row changes both repos,
// `~/code/<repo>` is the shared checkout, which does not carry the change until
// the landing — so the copy and the original, both changed together, compare
// unequal and the close fails a correct change. Naming this thread's worktree
// of each sibling makes the comparison the one that will be true after the
// landing.
//
// The name is the shared checkout's folder, uppercased, every non-word
// character an underscore: `portal.example.com` → UPSTREAM_PORTAL_EXAMPLE_COM_DIR,
// which is how such a sibling test should spell it. A
// variable the caller already set wins. A worktree that is gone — a landing
// already removed it, and the ledger keeps its row — names nothing: a sibling
// test given a missing directory throws, and the shared checkout it falls back
// to already holds what that worktree landed.

import { statSync } from "node:fs";
import { basename } from "node:path";

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

export interface LedgerWorktree {
  wt: string;
  shared: string;
}

export function siblingDirEnv(
  rows: readonly LedgerWorktree[],
  current: Readonly<Record<string, string | undefined>>,
  exists: (dir: string) => boolean = isDir,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { wt, shared } of rows) {
    if (wt === "" || shared === "" || !exists(wt)) continue;
    const name = `UPSTREAM_${basename(shared).toUpperCase().replace(/\W/g, "_")}_DIR`;
    if (current[name] !== undefined && current[name] !== "") continue;
    out[name] = wt;
  }
  return out;
}
