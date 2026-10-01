#!/usr/bin/env -S node --experimental-strip-types
// dispatch-agents.ts — Step 3 of /debate. Reads a prompts dir produced by
// build-agent-prompts.ts and puts each prompt in front of one panel voice, in
// parallel, with a per-agent timeout. Emits one .output per answered seat, one
// .gap per seat nobody answered, and one .voice per seat naming who argued it.
//
// SEATS. Prompt N (in sorted order) goes to panel voice N, and the prompt count
// must equal the voice count. For /debate that is Claude, Codex and Grok — the
// `panel` row of .agents/skills/review/policy.json. No config: always three
// seats, always the same three voices, so there is no choice to get wrong.
//
// STAND-INS. A seat whose voice fails is argued by another voice, so a debate
// still has three positions: Claude fails → Codex doubles; Grok fails → Claude
// doubles; Codex fails → Claude doubles. The stand-in must have
// answered its OWN seat — a voice that just failed is not asked twice — and the
// remaining voice is the second choice when the first cannot. A seat nobody
// could argue stays a .gap. `--no-stand-in` turns this off for a caller that
// needs each voice's own answer or nothing.
//
// FOLDERS. The prompts dir is the caller's and is left in place: a caller may
// still need it after this returns. The output dir is handed to the caller on
// stdout, and its last reader removes it (parse-agent-output.ts in /debate,
// parallel-research.ts for /explain).
//
// peers: build-agent-prompts.ts, parse-agent-output.ts, .agents/skills/debate/SKILL.md
//
// Usage:
//   dispatch-agents.ts --prompts-dir <path> [--timeout-s <int>] [--no-stand-in] [--research]
//   (--research, Contextium: the grok seat may read the repo and search the web)

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { hasAnswer } from "./answer-block.ts";

async function main(): Promise<void> {
  function err(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }

  function die(msg: string, code = 2): never {
    err(msg);
    exit(code);
  }

  // The help text is this file's own header comment — read as a block, not a
  // line range, so an edit above the usage cannot make --help print code.
  function headerComment(): string {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1);
    const end = lines.findIndex((l) => !l.startsWith("//"));
    return lines
      .slice(0, end === -1 ? lines.length : end)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n");
  }

  let promptsDir = "";
  let timeoutS = "300";
  let standIn = true;
  let research = false;

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--prompts-dir") promptsDir = argv[++i] ?? "";
    else if (flag === "--timeout-s") timeoutS = argv[++i] ?? "";
    else if (flag === "--no-stand-in") standIn = false;
    // Contextium: /explain's seats investigate rather than argue, so they may
    // read the repo and search the web; a debate seat answers from its prompt.
    else if (flag === "--research") research = true;
    else if (flag === "-h" || flag === "--help") {
      err(headerComment());
      exit(0);
    } else die(`unknown flag: ${flag}`);
  }

  if (promptsDir === "") die("--prompts-dir required");
  if (!(existsSync(promptsDir) && statSync(promptsDir).isDirectory())) die(`prompts dir not found: ${promptsDir}`);
  if (!/^[0-9]+$/.test(timeoutS) || Number(timeoutS) < 1) die("--timeout-s must be positive integer");

  // Collect prompt files. Sorted order is seat order. Regular files only, dotfiles
  // included — what `find -maxdepth 1 -type f -name '*.prompt'` matched.
  const promptFiles = readdirSync(promptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".prompt"))
    .map((e) => join(promptsDir, e.name))
    .sort();
  if (promptFiles.length < 1) die(`prompts dir holds no .prompt files: ${promptsDir}`);

  // ── Voices, read from the assignment policy ───────────────────────────

  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

  // WHERE IS THE POLICY? Beside the review skill this skill ships with:
  // `.agents/skills/debate/scripts/` → `.agents/skills/review/policy.json`, found
  // from this script's own directory, so it answers the same way from the
  // installed `.agents/skills/` and from the template repo.
  //
  // DEBATE_POLICY_JSON is a TEST SEAM, not a production knob: it lets the suite
  // pin a fixture panel row so a per-vendor flag case (e.g. the grok --verbatim
  // regression) tests the branch it names rather than whatever the shipped table
  // happens to assign. Unset in every real run.
  const POLICY_SEAM = process.env.DEBATE_POLICY_JSON ?? "";
  const POLICY_JSON = POLICY_SEAM !== "" ? POLICY_SEAM : `${SCRIPT_DIR}/../../review/policy.json`;

  if (!(existsSync(POLICY_JSON) && statSync(POLICY_JSON).isFile())) {
    err(`policy.json not found at ${POLICY_JSON}`);
    err("The panel row ships with the review skill (.agents/skills/review/policy.json); re-run the installer.");
    exit(1);
  }

  interface PanelVoice {
    vendor: string;
    tracks: string;
  }

  /** A JSON value as it reads inside a string: text as-is, null/absent as `null`, anything else as JSON. */
  function asText(v: unknown): string {
    if (typeof v === "string") return v;
    if (v === undefined || v === null) return "null";
    return JSON.stringify(v);
  }

  function field(o: unknown, key: string): unknown {
    return typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>)[key] : undefined;
  }

  /** `rows.panel.voices`, each as vendor + tracks (empty when the voice names none). An unreadable row is an empty panel. */
  function readPanel(path: string): PanelVoice[] {
    let voices: unknown;
    try {
      voices = field(field(field(JSON.parse(readFileSync(path, "utf8")), "rows"), "panel"), "voices");
    } catch (e) {
      err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    if (!Array.isArray(voices)) {
      err(`${path}: rows.panel.voices is not a list`);
      return [];
    }
    return voices.map((v: unknown) => {
      const tracks = field(v, "tracks");
      return {
        vendor: asText(field(v, "vendor")),
        tracks: tracks === undefined || tracks === null || tracks === false ? "" : asText(tracks),
      };
    });
  }

  // Each voice carries its slot's `tracks`. Empty means "the CLI's own default
  // model": no model flag is passed. Non-empty is handed to the CLI verbatim as
  // its model.
  const PANEL = readPanel(POLICY_JSON);
  if (promptFiles.length !== PANEL.length) {
    die(
      `prompts dir holds ${promptFiles.length} prompt(s) but the panel has ${PANEL.length} voice(s) — one prompt per seat.`,
    );
  }

  /** Whether a command name runs: an executable file on PATH, or at the path given when it names one. */
  function onPath(cmd: string): boolean {
    const runnable = (p: string): boolean => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    if (cmd.includes("/")) return runnable(cmd);
    return (process.env.PATH ?? "").split(delimiter).some((d) => runnable(join(d === "" ? "." : d, cmd)));
  }

  // Resolve every voice's `tracks` to the model its CLI is told, once, before any
  // agent runs. The rule is identity: `tracks` IS the model. DEBATE_RESOLVER is a
  // TEST SEAM like DEBATE_POLICY_JSON, and an override for a user who keeps a
  // resolver of their own (`<resolver> <vendor> <tracks>` prints the model id).
  // Returns "" when a resolver was given and nothing resolved; its stderr is
  // discarded.
  function resolveTracks(vendor: string, tracks: string): string {
    const resolver = process.env.DEBATE_RESOLVER ?? "";
    if (resolver === "") return tracks;
    const r = spawnSync(resolver, [vendor, tracks], { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"] });
    return r.status === 0 ? r.stdout.replace(/\n+$/, "") : "";
  }

  const VENDOR: string[] = []; // seat → vendor
  const MODEL: string[] = []; // seat → resolved model, empty for the CLI's default
  const UNUSABLE: string[] = []; // seat → why its voice cannot run at all, empty when it can
  PANEL.forEach(({ vendor, tracks }, i) => {
    VENDOR[i] = vendor;
    MODEL[i] = "";
    UNUSABLE[i] = "";
    if (!onPath(vendor)) {
      UNUSABLE[i] = `${vendor} CLI not found`;
    } else if (tracks === "") {
      // no tracks: the CLI's own default model, no flag
    } else {
      const m = resolveTracks(vendor, tracks);
      if (m === "") UNUSABLE[i] = `${vendor} could not resolve ${tracks} — refusing to run its CLI default`;
      else MODEL[i] = m;
    }
  });

  // Who a seat's voice is, for the .voice line: "<vendor> <model>", or
  // "<vendor> (default model)" when the table names none.
  const voiceLabel = (i: number): string =>
    MODEL[i] !== "" ? `${VENDOR[i]} ${MODEL[i]}` : `${VENDOR[i]} (default model)`;

  const OUTPUT_DIR = mkdtempSync(join(tmpdir(), "debate-outputs-"));

  const seatRole = (i: number): string => basename(promptFiles[i] ?? "", ".prompt");
  const seatFile = (i: number, ext: string): string => join(OUTPUT_DIR, `${seatRole(i)}.${ext}`);

  function nonEmpty(p: string): boolean {
    return existsSync(p) && statSync(p).size > 0;
  }

  function textOf(p: string): string {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }

  function firstLine(p: string): string {
    return textOf(p).split("\n")[0] ?? "";
  }

  /** The first `n` bytes of a file, or nothing when it cannot be read. */
  function headBytes(p: string, n: number): Buffer {
    try {
      const fd = openSync(p, "r");
      try {
        const buf = Buffer.alloc(n);
        return buf.subarray(0, readSync(fd, buf, 0, n, 0));
      } finally {
        closeSync(fd);
      }
    } catch {
      return Buffer.alloc(0);
    }
  }

  /** The argv each CLI takes, or null for a vendor this script does not drive. */
  function cliArgs(cli: string, model: string, promptBody: string): string[] | null {
    // Only the flag shape lives here — CLI trivia, not an assignment. The model
    // flag is added only when the table names a model.
    switch (cli) {
      case "claude":
        return ["-p", ...(model === "" ? [] : ["--model", model]), "--output-format", "text", promptBody];
      case "codex":
        // --full-auto was REMOVED from `codex exec` (rejected outright by
        // v0.147.0 — every codex agent died at exit 2 with "unexpected
        // argument"). A debate agent only reads and answers, so
        // read-only is also the right capability: it withholds writes rather
        // than asking the model not to. --skip-git-repo-check because the CLI
        // otherwise refuses outside a repo, and --color never keeps ANSI escapes
        // out of what parse-agent-output.ts has to strip.
        return [
          "exec",
          ...(model === "" ? [] : ["-m", model]),
          "--sandbox=read-only",
          "--skip-git-repo-check",
          "--color",
          "never",
          promptBody,
        ];
      case "grok": {
        // --verbatim: without it the CLI preprocesses the prompt and, past a size
        // threshold, truncates it and offloads the rest to a file the model is
        // told to read — turning one answer into an agent loop whose narration is
        // what comes back.
        //
        // This is a prompt-in/answer-out seat, not a repo investigation. On a
        // ~2 KB debate prompt, Grok's default agent instruction made tool calls
        // and took minutes, sometimes past the ceiling. A completion instruction
        // plus medium reasoning effort returned full answers in about 75s,
        // without tool calls. Low was faster but gave less consistent coverage of
        // the requested points; high timed out. Keep the instruction
        // task-neutral: another caller may use this same dispatcher with a
        // numbered verdict format instead of debate sections.
        //
        // The permission mode IS carried. `dontAsk` was measured cancelling a
        // quarter of prompt-in/answer-out runs at turn 1 — narration only, no
        // answer — against none under bypassPermissions. A debate voice is
        // exactly that shape, so it takes the mode plus a NON-EMPTY allowlist,
        // which are one change and not two.
        //
        // The allowlist also closes a path this call would otherwise have. Under
        // `dontAsk` with no scoping, every one of Grok's default tools is
        // auto-approved — a terminal command, a file write, a subagent — and a
        // debate prompt carries whatever the user pasted into the question. That
        // is a prompt-injection path to a shell on this machine. Web search is
        // off for the same reason: a debate voice argues from the question it
        // was given.
        //
        // --no-plan: the CLI's own switch for the planning behaviour --verbatim
        // only works around; every grok call here carries it.
        //
        // A research seat (--research) reads and searches: a read-only allowlist
        // and the web left on. Still never a shell or a write.
        const scope = research
          ? ["--tools", "read_file,list_dir,grep"]
          : ["--tools", "list_dir", "--disable-web-search"];
        const system = research
          ? "Investigate the user's message: read repo files and search the web as needed, then reply with the answer only, in its requested format. Do not narrate."
          : "Answer the user's message directly from its supplied context. Follow its requested output format exactly. Do not use tools or narrate.";
        return [
          "-p",
          promptBody,
          ...(model === "" ? [] : ["-m", model]),
          "--output-format",
          "plain",
          "--verbatim",
          "--no-plan",
          "--permission-mode",
          "bypassPermissions",
          ...scope,
          "--reasoning-effort",
          "medium",
          "--system-prompt-override",
          system,
        ];
      }
      default:
        return null;
    }
  }

  // The ceiling is a watchdog in this process rather than coreutils `timeout`:
  // macOS ships no `timeout`, the implementations disagree on the status after a
  // KILL (124 or 137), and none of them KILLs what the CLI started once the CLI
  // itself has exited. After TERM, the CLI and everything it started get
  // KILL_GRACE_MS before KILL — one that ignores TERM would otherwise hold the
  // debate open, or outlive it.
  const KILL_GRACE_MS = 3000;
  // TEST SEAM, like DEBATE_POLICY_JSON: milliseconds per second of the ceiling,
  // so a suite can run the 300s default in a fraction of a second. Unset in
  // every real run.
  const MS_PER_S = Number(process.env.DEBATE_MS_PER_S ?? "") || 1000;
  // One entry per timed-out seat, settled once its process group is empty or
  // KILLed. The program ends through runToExit, which exits at once, so main
  // awaits these before returning — a pending KILL timer would not hold it open.
  const reaping: Promise<void>[] = [];

  /** Whether any process is left in the group `pgid` leads (or led). */
  function groupAlive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run `<cli> <args…>` under the ceiling with stdin from /dev/null, stdout and
   * stderr to the given files, and resolve with its exit status: 124 when the
   * ceiling fires, as `timeout` reports it. A status from a signal is 128 + its
   * number, and a command that cannot be started is 127 with the reason in the
   * error file — what a shell reports.
   */
  function runTimed(cli: string, args: string[], outf: string, errf: string): Promise<number> {
    const outFd = openSync(outf, "w");
    const errFd = openSync(errf, "w");
    return new Promise((done) => {
      // A child that fails to start can report both `error` and `close`; the
      // first one settles the seat.
      let settled = false;
      let timedOut = false;
      let ceiling: NodeJS.Timeout | undefined;
      const finish = (rc: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(ceiling);
        closeSync(outFd);
        closeSync(errFd);
        done(timedOut ? 124 : rc);
      };
      // The CLI leads its own process group, so TERM and KILL reach whatever it
      // started too, not only the CLI itself.
      const child = spawn(cli, args, { stdio: ["ignore", outFd, errFd], detached: true });
      const signalGroup = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          // ESRCH: every process in the group has already exited.
        }
      };
      child.on("error", (e) => {
        writeFileSync(errFd, `${cli}: ${e.message}\n`);
        finish(127);
      });
      child.on("close", (code, signal) => {
        finish(code ?? 128 + (signal ? osConstants.signals[signal] : 0));
      });
      ceiling = setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        // Not cancelled when the CLI exits: a child that ignored TERM is still
        // in the group, and this KILL is what ends it. It stops early only once
        // the group is empty.
        reaping.push(
          new Promise((reaped) => {
            const started = Date.now();
            const poll = setInterval(() => {
              if (child.pid !== undefined && groupAlive(child.pid) && Date.now() - started < KILL_GRACE_MS) return;
              clearInterval(poll);
              signalGroup("SIGKILL");
              reaped();
            }, 100);
          }),
        );
      }, Number(timeoutS) * MS_PER_S);
    });
  }

  // Run one prompt on one voice. Writes <role>.output on success, <role>.gap on
  // failure; the caller owns <role>.voice. Never rejects: a seat that cannot even
  // be started is a gap like any other failure.
  //
  // Success is exit 0 AND an answer, read the way parse-agent-output.ts reads
  // it (answer-block.ts). Exit status alone counted a CLI that exited 0 having
  // printed nothing — or only footer noise the parser cuts — as an argued seat,
  // so silent voices made a "successful" debate with positions missing; no
  // answer is a gap, and a stand-in argues the seat.
  async function dispatchOne(promptFile: string, cli: string, model: string): Promise<void> {
    const role = basename(promptFile, ".prompt");
    const outf = join(OUTPUT_DIR, `${role}.output`);
    const errf = join(OUTPUT_DIR, `${role}.err`);
    const gapf = join(OUTPUT_DIR, `${role}.gap`);
    rmSync(gapf, { force: true });
    try {
      // Trailing newlines dropped, as the prompt reached the CLI before.
      const promptBody = readFileSync(promptFile, "utf8").replace(/\n+$/, "");
      const args = cliArgs(cli, model, promptBody);
      if (args === null) {
        writeFileSync(gapf, `no CLI mapping for vendor '${cli}' (policy added a vendor this script does not drive)\n`);
        return;
      }
      const rc = await runTimed(cli, args, outf, errf);
      if (rc === 124) {
        writeFileSync(gapf, `timeout after ${timeoutS}s (${cli})\n`);
        rmSync(outf, { force: true });
      } else if (rc !== 0) {
        writeFileSync(gapf, Buffer.concat([Buffer.from(`exit ${rc} (${cli})\n`), headBytes(errf, 1024)]));
        rmSync(outf, { force: true });
      } else if (!hasAnswer(textOf(outf))) {
        writeFileSync(gapf, Buffer.concat([Buffer.from(`no answer in output (${cli})\n`), headBytes(errf, 1024)]));
        rmSync(outf, { force: true });
      }
    } catch (e) {
      writeFileSync(gapf, `dispatch failed (${cli}): ${e instanceof Error ? e.message : String(e)}\n`);
      rmSync(outf, { force: true });
    }
  }

  // Round 1: every seat on its own voice, in parallel.
  const round1: Promise<void>[] = [];
  promptFiles.forEach((promptFile, i) => {
    if (UNUSABLE[i] !== "") {
      writeFileSync(seatFile(i, "gap"), `${UNUSABLE[i]}\n`);
      return;
    }
    writeFileSync(seatFile(i, "voice"), `${voiceLabel(i)}\n`);
    round1.push(dispatchOne(promptFile, VENDOR[i] ?? "", MODEL[i] ?? ""));
  });
  await Promise.all(round1);

  // Round 2: stand-ins for the seats that failed. First choice first; the
  // fallback is the voice left over. Keyed by vendor, so it follows the panel.
  const STAND_IN_ORDER: Record<string, string[]> = {
    claude: ["codex", "grok"],
    grok: ["claude", "codex"],
    codex: ["claude", "grok"],
  };

  const stoodIn = (i: number): boolean => textOf(seatFile(i, "voice")).includes("stood in");

  /** That voice's seat, if it answered its own seat; judged on the first seat the voice holds. */
  function answeredOwn(vendor: string): number | undefined {
    const j = VENDOR.indexOf(vendor);
    if (j === -1) return undefined;
    if (!nonEmpty(seatFile(j, "output")) || existsSync(seatFile(j, "gap"))) return undefined;
    if (stoodIn(j)) return undefined;
    return j;
  }

  if (standIn) {
    const round2: Promise<void>[] = [];
    promptFiles.forEach((promptFile, i) => {
      if (!existsSync(seatFile(i, "gap"))) return;
      const reason = firstLine(seatFile(i, "gap"));
      for (const sub of STAND_IN_ORDER[VENDOR[i] ?? ""] ?? []) {
        const j = answeredOwn(sub);
        if (j === undefined) continue;
        writeFileSync(seatFile(i, "voice"), `${voiceLabel(j)} — stood in for ${VENDOR[i]} (${reason})\n`);
        err(`  ${seatRole(i)}: ${VENDOR[i]} failed (${reason}); ${VENDOR[j]} stands in`);
        round2.push(dispatchOne(promptFile, VENDOR[j] ?? "", MODEL[j] ?? ""));
        break;
      }
    });
    await Promise.all(round2);
  }

  // Summarize per-seat failure on stderr.
  let okCount = 0;
  promptFiles.forEach((_, i) => {
    const gapf = seatFile(i, "gap");
    if (nonEmpty(gapf)) {
      // A failed stand-in keeps both reasons: the seat's own and the stand-in's.
      if (stoodIn(i)) {
        const strip = (s: string): string => s.replace(/\n+$/, "");
        writeFileSync(
          gapf,
          `${strip(textOf(seatFile(i, "voice")))}; the stand-in failed too: ${strip(textOf(gapf))}\n`,
        );
      }
      err(`  ${seatRole(i)}: ${firstLine(gapf)}`);
      rmSync(seatFile(i, "voice"), { force: true });
    } else {
      okCount++;
    }
  });

  // Every timed-out seat's process group, emptied before the debate moves on.
  await Promise.all(reaping);

  process.stdout.write(`output_dir=${OUTPUT_DIR}\n`);

  // Exit non-zero only when NO seat was argued (gap-tolerant per SKILL.md).
  process.exitCode = okCount > 0 ? 0 : 1;
}

await runToExit(main);
