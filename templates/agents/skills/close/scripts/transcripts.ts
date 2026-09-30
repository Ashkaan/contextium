#!/usr/bin/env -S node --experimental-strip-types
// transcripts.ts — corrections.ts's rows for a session T3 Code did not record:
// the user's own turns, read from the harness's own transcript file.
//
// corrections.ts reads T3 Code's database, which renders every harness T3 runs.
// A session outside T3 has no row there, so its record is the harness's own
// session file — whichever exists, first match wins:
//
//   claude  ~/.claude/projects/<dir>/<session>.jsonl — by CLAUDE_CODE_SESSION_ID
//           when the shell has one (an id with no record is no record), else
//           the newest one for this worktree or its main checkout. Claude
//           Code names the folder after the directory, every character that is
//           not a letter or digit turned into `-`.
//   codex   ~/.codex/sessions/**/rollout-*.jsonl — the one whose session id is
//           CODEX_THREAD_ID (or CODEX_SESSION_ID) when the shell has one, else
//           the newest from the last two days whose session ran in this
//           worktree or its main checkout. Two Codex sessions in one tree are
//           told apart only by the id, so an id with no record is no record.
//
// The same drops as corrections.ts, for the same reasons: tool results, the
// harness's injected instructions and reminders, and a turn that is nothing but
// a skill invocation. An answer given through a question prompt is prefixed
// `[answered] ` — Claude Code's record does not say whether it was one of the
// agent's options or the user's own words, so it is never quoted as theirs.
//
// Usage:
//   transcripts.ts [--full] [--source claude|codex]
//     one `HH:MM <TAB> <first line>` row per turn, local time;
//     --full prints the whole turn with newlines escaped as \n
//
// Env: CLAUDE_CONFIG_DIR (~/.claude), CODEX_HOME (~/.codex), CLAUDE_CODE_SESSION_ID,
//      CODEX_THREAD_ID / CODEX_SESSION_ID.
//
// Exit: 0 rows on stdout (none is a normal outcome) · 2 no transcript found for
//       this session, or bad usage. The file read goes to stderr.
//
// peers:
//   .agents/skills/close/scripts/transcripts.test.ts
//   .agents/skills/close/scripts/corrections.ts
//   .agents/skills/close/scripts/write-root.sh   (--main: the main checkout)

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(msg: string): never {
  process.stderr.write(`corrections: ${msg}\n`);
  return exit(2);
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};
const firstLine = (f: string): string => {
  try {
    return readFileSync(f, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return "";
  }
};

interface Where {
  TOP: string;
  MAIN: string;
  CLAUDE_DIR: string;
  CODEX_DIR: string;
}

function claudeFile(w: Where, sid: string): string | null {
  const projects = join(w.CLAUDE_DIR, "projects");
  if (sid !== "") {
    // The session's own transcript, or none: an id with no record is a lookup
    // that failed, never a reason to read the newest one in this tree.
    if (!isDir(projects)) return null;
    for (const d of readdirSync(projects).sort()) {
      const f = join(projects, d, `${sid}.jsonl`);
      if (isFile(f)) return f;
    }
    return null;
  }
  for (const d of [w.TOP, w.MAIN]) {
    const dir = join(projects, d.replace(/[^A-Za-z0-9]/g, "-"));
    if (!isDir(dir)) continue;
    // Newest by mtime; the names are uuids.
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(dir, n))
      .filter(isFile)
      .sort((a, b) => mtime(b) - mtime(a));
    if (files[0]) return files[0];
  }
  return null;
}

function rollouts(codexDir: string): string[] {
  const root = join(codexDir, "sessions");
  if (!isDir(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((rel) => /(^|\/)rollout-[^/]*\.jsonl$/.test(rel))
    .map((rel) => join(root, rel))
    .filter(isFile)
    .sort();
}

function codexFile(w: Where, cid: string): string | null {
  const files = rollouts(w.CODEX_DIR);
  if (cid !== "") {
    // The session's own record: its session_meta names the id (the file name
    // usually carries it too, but the record is what is read). An id with no
    // record is a lookup that failed — never a reason to read the newest
    // rollout in this tree, which may be another session's.
    for (const f of files) {
      try {
        if (JSON.parse(firstLine(f))?.payload?.id === cid) return f;
      } catch {
        // not a record
      }
    }
    return null;
  }
  // The last two days, newest first, whose session ran in this tree.
  const since = Date.now() - 2 * 86_400_000;
  const want = new Set([w.TOP, w.MAIN]);
  const recent = files
    .map((f) => ({ f, t: mtime(f) }))
    .filter(({ t }) => t > since)
    .sort((a, b) => b.t - a.t);
  for (const { f } of recent) {
    try {
      const cwd = JSON.parse(firstLine(f))?.payload?.cwd;
      if (cwd && want.has(realpathSync(cwd))) return f;
    } catch {
      // not a record, or a directory that is gone
    }
  }
  return null;
}

// A turn that is nothing but a skill invocation: at most four slug-shaped
// arguments after the command, the same rule corrections.ts applies.
const COMMAND = /^[/$][a-zA-Z][a-zA-Z0-9_:-]*$/;
const SLUG_ARG = /^[A-Za-z0-9._/@=+-]+$/;
const invocationOnly = (s: string): boolean => {
  const t = s.trim().split(/\s+/);
  return COMMAND.test(t[0] ?? "") && t.length <= 5 && t.slice(1).every((a) => SLUG_ARG.test(a));
};
// What a harness injects into a user turn, not what the user typed.
const INJECTED =
  /^(<(system-reminder|command-name|command-message|command-args|local-command-std(out|err)|environment_context|user_instructions|INSTRUCTIONS)\b|# AGENTS\.md instructions|Caveat: The messages below)/;
const clean = (text: unknown): string =>
  String(text ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

// biome-ignore lint/suspicious/noExplicitAny: a transcript row is whatever the harness wrote
type Row = any;
const texts = (parts: unknown): string =>
  Array.isArray(parts) ? parts.map((x: Row) => x?.text ?? "").join("\n") : "";

function turns(kind: "claude" | "codex", file: string): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  const add = (at: unknown, raw: unknown): void => {
    const text = clean(raw);
    if (!text || INJECTED.test(text) || invocationOnly(text)) return;
    out.push({ at: String(at ?? ""), text });
  };
  const rows: Row[] = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (kind === "claude") {
    for (const r of rows) {
      if (r.type !== "user" || r.isMeta || r.isSidechain) continue;
      const c = r.message?.content;
      if (typeof c === "string") {
        add(r.timestamp, c);
        continue;
      }
      if (!Array.isArray(c)) continue;
      for (const part of c) {
        if (part?.type === "text") add(r.timestamp, part.text);
        else if (part?.type === "tool_result") {
          const t = typeof part.content === "string" ? part.content : texts(part.content);
          const m = /^User has answered your questions?:\s*([\s\S]*)$/.exec(t.trim());
          if (m) add(r.timestamp, `[answered] ${m[1]}`);
        }
      }
    }
  } else {
    // Newer Codex logs each typed turn as an event; older ones only as a
    // response item, among the instructions it injects.
    const events = rows.filter(
      (r) =>
        r.type === "event_msg" &&
        (r.payload?.type === "user_message" ||
          (r.payload?.type === "item_completed" && r.payload?.item?.type === "UserMessage")),
    );
    if (events.length) {
      for (const r of events) {
        if (r.payload.type === "user_message") add(r.timestamp, r.payload.message);
        else add(r.timestamp, texts(r.payload.item.content));
      }
    } else {
      for (const r of rows) {
        const p = r.payload;
        if (r.type !== "response_item" || p?.type !== "message" || p?.role !== "user") continue;
        add(r.timestamp, texts(p.content));
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

async function main(): Promise<void> {
  let FULL = false;
  let SOURCE = "";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") FULL = true;
    else if (a === "--source") {
      SOURCE = argv[++i] ?? "";
      if (SOURCE !== "claude" && SOURCE !== "codex") fail("--source is claude or codex");
    } else fail("usage: transcripts.ts [--full] [--source claude|codex]");
  }

  const g = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const TOP = real(g.status === 0 && g.stdout.trim() !== "" ? g.stdout.trim() : process.cwd());
  const m = spawnSync("bash", [join(HERE, "write-root.sh"), "--main", "."], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const MAIN = m.status === 0 && m.stdout.trim() !== "" ? m.stdout.trim() : TOP;
  const HOME = process.env.HOME ?? "";
  const w: Where = {
    TOP,
    MAIN,
    CLAUDE_DIR: resolve(process.env.CLAUDE_CONFIG_DIR || `${HOME}/.claude`),
    CODEX_DIR: resolve(process.env.CODEX_HOME || `${HOME}/.codex`),
  };

  // AN EXPLICIT SESSION ID IS THE ANSWER OR NOTHING, for either harness. With an
  // id, the record is that session's file; if it is missing the lookup fails
  // rather than falling back to the newest transcript in this tree, or to the
  // other harness's — either could be another session's words, quoted in the
  // journal as this user's. Only with no id at all is the newest record for this
  // tree the answer, Codex first (it records the directory it ran in).
  const CL_ID = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  const CX_ID = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || "";
  let kind: "claude" | "codex" | "" = "";
  let file: string | null = null;
  if ((SOURCE === "" || SOURCE === "claude") && CL_ID !== "") {
    file = claudeFile(w, CL_ID);
    if (file === null) fail(`no Claude Code record of session ${CL_ID}`);
    kind = "claude";
  } else if ((SOURCE === "" || SOURCE === "codex") && CX_ID !== "") {
    file = codexFile(w, CX_ID);
    if (file === null) fail(`no Codex record of session ${CX_ID}`);
    kind = "codex";
  } else {
    if (SOURCE === "" || SOURCE === "codex") {
      file = codexFile(w, "");
      if (file !== null) kind = "codex";
    }
    if (kind === "" && (SOURCE === "" || SOURCE === "claude")) {
      file = claudeFile(w, "");
      if (file !== null) kind = "claude";
    }
  }
  if (kind === "" || file === null) {
    fail(`no record of this session found (${SOURCE || "T3 Code, Claude Code or Codex"}) for ${TOP}`);
  }
  process.stderr.write(`corrections: source ${kind} (${file})\n`);

  let rows: { at: string; text: string }[];
  try {
    rows = turns(kind, file);
  } catch {
    fail(`could not read ${file}`);
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  let out = "";
  for (const { at, text } of rows) {
    const t = new Date(at);
    const hhmm = Number.isNaN(t.getTime()) ? "--:--" : `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const body = FULL ? text.replace(/\n/g, "\\n") : (text.split("\n").find((l) => l.trim()) ?? "");
    out += `${hhmm}\t${body}\n`;
  }
  process.stdout.write(out);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
