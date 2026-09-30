#!/usr/bin/env -S node --experimental-strip-types
// session-key.ts — turn a raw harness session id into the single key used for
// BOTH the worktree directory name (`session-<key>`) and the session marker
// filename (`.claude-session-<key>`).
//
// Why this is one shared script and not a per-caller inline expression
// (single source of truth):
//   - The raw id reaches `find -name` in the marker lookup. An id containing a
//     glob metacharacter (`*`, `?`, `[`) would make that lookup match the WRONG
//     worktree, which silently routes a session's edits into another session's
//     tree — the exact corruption this whole mechanism exists to prevent.
//   - Ids like `cse_01HFo2Jk` carry uppercase and `_`, both of which fail
//     SLUG_REGEX, so setup-worktree.sh's slug gate would reject them.
// Create, detect, merge, and sweep all key off this one function, so they cannot
// disagree about which worktree belongs to which session.
//
// peers:
//   .agents/skills/implement/scripts/session-key.test.ts
//   .agents/skills/implement/scripts/setup-worktree.sh
//   .agents/skills/implement/scripts/session-write-root.ts
//
// Usage:
//   session-key.ts <raw-session-id>     — print the key on stdout
//   session-key.ts --max-key-len        — print MAX_KEY_LEN (SSOT for tests)
//
// Exit:
//   0 — key printed
//   2 — empty input, or input with no usable characters at all

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// SLUG_REGEX (setup-worktree.sh) allows 64 chars total: 1 leading [a-z] + 63.
// The worktree name is "session-" + key, so the key ceiling is 64 - 8 = 56.
const SESSION_PREFIX = "session-";
const MAX_KEY_LEN = 56;

/** First 8 hex of sha256 over the RAW id's bytes — `sha256sum | cut -c1-8`. */
function digest8(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "";

  if (arg === "--max-key-len") {
    process.stdout.write(`${MAX_KEY_LEN}\n`);
    exit(0);
  }

  const raw = arg;

  if (raw === "") {
    err("session-key: raw session id required");
    exit(2);
  }

  // Lowercase, then collapse every run of characters outside [a-z0-9-] into a
  // single `-`. Doing it as one squeeze (rather than replace-then-collapse) keeps
  // `a__b` and `a_b` mapping to the same `a-b`. ASCII-only lowercasing: every
  // non-ASCII character is outside the kept set either way, so it squeezes to
  // `-` exactly as `tr -cs` did with it.
  let key = raw.replace(/[A-Z]/g, (c) => c.toLowerCase());
  key = key.replace(/[^a-z0-9-]+/g, "-");

  // Collapse runs of `-` introduced by the squeeze meeting literal hyphens
  // (`a_-_b` → `a---b` → `a-b`), then strip the ends.
  while (key.includes("--")) {
    key = key.replaceAll("--", "-");
  }
  if (key.startsWith("-")) key = key.slice(1);
  if (key.endsWith("-")) key = key.slice(0, -1);

  if (key === "") {
    err(`session-key: "${raw}" has no characters usable in a slug`);
    exit(2);
  }

  // ── Disambiguate whenever the mapping was lossy ────────────────────────────
  // Sanitizing is many-to-one: `a_b`, `a__b`, and `a*b` all reduce to `a-b`, so
  // three distinct sessions would share one marker name and one worktree — the
  // exact index-sharing this mechanism exists to end, reintroduced by its own
  // key function.
  //
  // So when the key is not byte-identical to the raw id, a short digest of the RAW
  // id is appended, which makes the result injective again. When it IS identical —
  // every normal UUID session id, which is already lowercase hex and hyphens —
  // nothing is appended, so existing worktrees on disk keep resolving and the
  // identity property the other callers rely on is preserved.
  if (key !== raw) {
    const digest = digest8(raw);
    // Reserve room for "-<8 hex>" inside the key ceiling before truncating.
    const readableMax = MAX_KEY_LEN - 9;
    if (key.length > readableMax) {
      key = key.slice(0, readableMax);
      if (key.endsWith("-")) key = key.slice(0, -1);
    }
    key = `${key}-${digest}`;
  } else if (key.length > MAX_KEY_LEN) {
    // Identical to the raw id but over the ceiling: truncation would ALSO be
    // lossy, so the same digest rule applies.
    const digest = digest8(raw);
    const readableMax = MAX_KEY_LEN - 9;
    key = key.slice(0, readableMax);
    if (key.endsWith("-")) key = key.slice(0, -1);
    key = `${key}-${digest}`;
  }

  // Defensive: the composed name is what every caller actually uses, so validate
  // THAT, not the key alone. A failure here is a bug in this script, not bad input.
  const composed = `${SESSION_PREFIX}${key}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(composed)) {
    err(`session-key: BUG — composed name "${composed}" fails the slug regex`);
    exit(2);
  }

  process.stdout.write(`${key}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
