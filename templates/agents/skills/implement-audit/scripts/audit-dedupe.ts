#!/usr/bin/env -S node --experimental-strip-types
// audit-dedupe.ts — once-per-session guard for /implement-audit.
//
// The implement-audit review can be invoked twice in one session: /implement
// fires it at phase-4.7, and it is also standalone-callable by hand afterwards.
// Without a guard the second invocation would fire a second full fresh-context
// review. This marker makes it a no-op that re-emits the first run's trailer
// instead of re-reviewing.
//
// Marker key: the harness's session id — CONTEXTIUM_SESSION, else Claude Code's
// CLAUDE_CODE_SESSION_ID, else a caller-fed CLAUDE_SESSION_ID (harness.sh reads
// them). When none is set the key is empty and the guard fails SAFE — status
// always `fresh`, mark skipped — instead of colliding on a shared constant: a
// `:-nosession` fallback makes every id-less session share ONE marker, so a
// completed audit's trailer bleeds into the next session and can falsely
// certify unreviewed code. The id is reduced to [A-Za-z0-9_-] so it names a file
// inside the state folder and nothing outside it. Worktree-independent so it
// works in both /implement worktree mode and standalone direct mode. The marker
// file stores the emitted `implement-audit:` trailer so the no-op path can
// reprint it for the close commit.
//
// Env: CONTEXTIUM_AUDIT_STATE_DIR — the marker folder (default
//      /tmp/implement-audit-done); the test suite points it at a temp dir.
//
// peers:
//   .agents/skills/implement-audit/SKILL.md
//   .agents/skills/implement/SKILL.md
//   .agents/skills/implement-audit/scripts/audit-dedupe.test.ts
//   .agents/skills/close/scripts/harness.sh  (the harness's session id)
//
// Usage:
//   audit-dedupe.ts status        → line 1 `fresh` (no prior run) OR `done`;
//                                    on `done`, line 2+ is the stored trailer.
//                                    Always exits 0 (informational).
//   audit-dedupe.ts mark "<trailer>" → record that the audit ran + its trailer.
// Exit: 0 ok; 2 usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const DONE_DIR = process.env.CONTEXTIUM_AUDIT_STATE_DIR || "/tmp/implement-audit-done";

/** Reduced to [A-Za-z0-9_-], at most 64 characters — harness.sh's own rule. */
const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);

// The harness's session id, asked of harness.sh — the one place a harness's
// variables are named. A copy with no harness.sh beside the close skill reads
// the same names itself.
function sessionId(): string {
  const lib = join(dirname(fileURLToPath(import.meta.url)), "../../close/scripts/harness.sh");
  let sid = "";
  if (existsSync(lib)) {
    const r = spawnSync("bash", ["-c", '. "$0"; harness_session_id', lib], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    sid = r.status === 0 ? (r.stdout ?? "").trim() : "";
  } else {
    sid = process.env.CONTEXTIUM_SESSION || process.env.CLAUDE_CODE_SESSION_ID || "";
  }
  // harness.sh sanitizes; the fallbacks are sanitized here the same way.
  return sanitize(sid || process.env.CLAUDE_SESSION_ID || "");
}

async function main(): Promise<void> {
  const SID = sessionId();
  const MARKER = SID ? `${DONE_DIR}/${SID}` : "";

  switch (process.argv[2] ?? "") {
    case "status": {
      let isMarker = false;
      try {
        isMarker = MARKER !== "" && statSync(MARKER).isFile();
      } catch {
        isMarker = false;
      }
      if (isMarker) {
        process.stdout.write("done\n");
        process.stdout.write(readFileSync(MARKER));
      } else {
        process.stdout.write("fresh\n");
      }
      break;
    }
    case "mark": {
      const trailer = process.argv[3] ?? "";
      if (trailer === "") {
        process.stderr.write('usage: audit-dedupe.ts mark "<trailer>"\n');
        exit(2);
      }
      if (MARKER === "") {
        process.stderr.write(
          "implement-audit: no session id (CONTEXTIUM_SESSION / CLAUDE_CODE_SESSION_ID unset) — dedupe skipped; carry the trailer inline\n",
        );
        exit(0);
      }
      mkdirSync(DONE_DIR, { recursive: true });
      writeFileSync(MARKER, `${trailer}\n`);
      process.stdout.write(`implement-audit: marked session ${SID} audited (${MARKER})\n`);
      break;
    }
    default:
      process.stderr.write("usage: audit-dedupe.ts status|mark\n");
      exit(2);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
