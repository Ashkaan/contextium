#!/usr/bin/env -S node --experimental-strip-types
// parallel-research.ts — Step 3 Deep of /explain. Puts three hypothesis prompts
// in front of the research CLIs in parallel; captures each result with per-seat
// isolation (one failure doesn't tank the others) + a configurable timeout.
//
// WHICH MODELS ANSWER is the `panel` row of .agents/skills/review/policy.json,
// the same three voices /debate seats, and each seat runs through /debate's
// dispatch-agents.ts — the one place a CLI's flags live. Three different models
// chasing three hypotheses is the point — one model asked three times tends to
// agree with itself — but a thin lineup degrades instead of failing: a seat
// whose CLI is missing or fails is argued by another voice (the dispatcher's
// stand-in rule), and the run says the panel was thin.
//
// peers: ../SKILL.md, ../../debate/scripts/dispatch-agents.ts, ../../review/policy.json
//
// Usage:
//   parallel-research.ts --h1 "<prompt>" --h2 "<prompt>" --h3 "<prompt>"
//                        [--timeout <sec>] [--skip-missing]
//
// Output (stdout): block-separated per-seat result, then SUMMARY line.
// exit: 0 if at least 1 seat returned a result; non-zero on all-fail / bad input.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

// Each seat's answer is shown up to this many bytes.
const SHOW_BYTES = 10240;

async function main(): Promise<void> {
  const err = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };
  const out = (text: string | Buffer): void => {
    process.stdout.write(text);
  };

  // The help text is this file's own header comment, read as a block.
  function headerComment(): string {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    return lines
      .slice(0, end === -1 ? lines.length : end)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n");
  }

  const H = ["", "", ""];
  let timeout = "120";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--h1") H[0] = argv[++i] ?? "";
    else if (flag === "--h2") H[1] = argv[++i] ?? "";
    else if (flag === "--h3") H[2] = argv[++i] ?? "";
    else if (flag === "--timeout") timeout = argv[++i] ?? "";
    // Accepted for compatibility and now the only behavior: a CLI that is not
    // installed is skipped, never fatal.
    else if (flag === "--skip-missing") continue;
    else if (flag === "-h" || flag === "--help") {
      err(headerComment());
      exit(0);
    } else {
      err(`unknown flag: ${flag}`);
      exit(2);
    }
  }

  H.forEach((h, i) => {
    if (h === "") {
      err(`--h${i + 1} empty or missing`);
      exit(2);
    }
  });

  if (!/^[0-9]+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 600) {
    err(`--timeout must be integer in [1, 600]; got: ${timeout}`);
    exit(2);
  }

  // ── Voices: the panel row, filtered to what is installed ──────────────
  // Which models, in what order, is the `panel` row of the review skill's
  // policy.json (DEBATE_POLICY_JSON overrides it, for the dispatcher too); how
  // each one is called is /debate's dispatch-agents.ts. Nothing about a CLI's
  // flags is written here.

  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  const DISPATCH = join(SCRIPT_DIR, "../../debate/scripts/dispatch-agents.ts");
  const seam = process.env.DEBATE_POLICY_JSON ?? "";
  const POLICY_JSON = seam !== "" ? seam : `${SCRIPT_DIR}/../../review/policy.json`;

  const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
  if (!isFile(POLICY_JSON)) {
    err(`policy.json not found at ${POLICY_JSON}`);
    exit(1);
  }
  if (!isFile(DISPATCH)) {
    err(`the /debate dispatcher is not installed at ${DISPATCH}`);
    exit(1);
  }

  let panel: string[];
  try {
    const voices: unknown = JSON.parse(readFileSync(POLICY_JSON, "utf8"))?.rows?.panel?.voices;
    if (!Array.isArray(voices)) throw new Error("rows.panel.voices is not a list");
    panel = voices
      .map((v: unknown) => (typeof v === "object" && v !== null ? (v as { vendor?: unknown }).vendor : undefined))
      .filter((v): v is string => typeof v === "string" && v !== "");
  } catch (e) {
    err(`cannot read the panel row of ${POLICY_JSON}: ${e instanceof Error ? e.message : String(e)}`);
    exit(1);
  }

  const onPath = (cmd: string): boolean =>
    (process.env.PATH ?? "").split(delimiter).some((d) => {
      const p = join(d === "" ? "." : d, cmd);
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const installed = panel.filter(onPath).length;
  const PANEL = panel.join(" ");
  if (installed === 0) {
    err(`no model CLI found on PATH (looked for: ${PANEL}).`);
    err("Install at least one, or investigate the hypotheses yourself.");
    exit(1);
  }
  if (installed < 3) {
    err(`[voices] explain: ${installed} model CLI(s) available, 3 would be better.`);
    err("         Running anyway with what is here — the same model filling several");
    err("         seats agrees with itself more than two different ones would, so treat");
    err("         the result as weaker rather than wrong.");
    err(`         To widen the panel, install another of: ${PANEL}.`);
  }

  const WORK = mkdtempSync(join(tmpdir(), "parallel-research-"));
  let OUT_DIR = "";
  try {
    mkdirSync(join(WORK, "prompts"));
    // File names sort into seat order: h1 → the panel's first voice, and so on.
    H.forEach((h, i) => writeFileSync(join(WORK, "prompts", `h${i + 1}.prompt`), `${h}\n`));

    // The dispatcher exits non-zero when no seat answered; its per-seat files are
    // still there to report, so its exit code is not ours to stop on.
    // --research: these seats investigate, so the dispatcher gives them read and
    // web-search tools a debate seat does not get.
    const d = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        DISPATCH,
        "--prompts-dir",
        join(WORK, "prompts"),
        "--timeout-s",
        timeout,
        "--research",
      ],
      { encoding: "utf8", env: { ...process.env, DEBATE_POLICY_JSON: POLICY_JSON }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const dirs = [...(d.stdout ?? "").matchAll(/^output_dir=(.*)$/gm)].map((m) => m[1] ?? "");
    OUT_DIR = dirs[dirs.length - 1] ?? "";
    if (OUT_DIR === "" || !(existsSync(OUT_DIR) && statSync(OUT_DIR).isDirectory())) {
      OUT_DIR = "";
      err("the /debate dispatcher did not run:");
      process.stderr.write(d.stderr ?? (d.error ? `${d.error.message}\n` : ""));
      exit(1);
    }

    let ok = 0;
    let failed = 0;
    let timedOut = 0;

    const read = (p: string): string | undefined => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };

    const emitBlock = (n: number): void => {
      // The seat's own vendor, in panel order.
      const own = panel[n - 1] ?? "";
      const output = join(OUT_DIR, `h${n}.output`);
      if (existsSync(output) && statSync(output).size > 0) {
        const voice = (read(join(OUT_DIR, `h${n}.voice`)) ?? "").split("\n")[0] ?? "";
        const who = voice.split(" ")[0] ?? "";
        out(`=== H${n} (${who !== "" ? who : own}) ===\n`);
        const at = voice.indexOf(" — ");
        if (voice.includes("stood in for") && at !== -1) out(`(${voice.slice(at + 3)})\n`);
        const body = readFileSync(output);
        out(body.subarray(0, SHOW_BYTES));
        if (body.length > SHOW_BYTES) out(`\n(truncated at 10KB of ${body.length} bytes)\n`);
        out("\n");
        ok++;
        return;
      }
      const gap = (read(join(OUT_DIR, `h${n}.gap`)) ?? "the seat recorded no result").replace(/\n+$/, "");
      if (gap.startsWith("timeout after")) {
        out(`=== H${n} (${own}) — TIMEOUT after ${timeout}s ===\n\n`);
        timedOut++;
      } else if (gap.includes("CLI not found")) {
        out(`=== H${n} (${own}) — MISSING ===\n(CLI not installed; no other voice could stand in)\n\n`);
        failed++;
      } else {
        out(`=== H${n} (${own}) — FAIL ===\n(no answer: the CLI failed or printed nothing)\n`);
        out(Buffer.from(`${gap}\n`).subarray(0, 1024));
        out("\n");
        failed++;
      }
    };

    emitBlock(1);
    emitBlock(2);
    emitBlock(3);

    out(`SUMMARY: ${ok} OK, ${failed} FAIL, ${timedOut} TIMEOUT\n`);
    process.exitCode = ok > 0 ? 0 : 1;
  } finally {
    rmSync(WORK, { recursive: true, force: true });
    if (OUT_DIR !== "") rmSync(OUT_DIR, { recursive: true, force: true });
  }
}

await runToExit(main);
