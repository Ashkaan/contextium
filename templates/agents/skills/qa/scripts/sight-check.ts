#!/usr/bin/env -S node --experimental-strip-types
// sight-check.ts — prove the visual reviewer actually LOOKED at the screenshots.
//
// Why this exists: when image `Read` breaks mid-session (a harness hook timing
// out is enough), the /qa step-4 reviewer subagent keeps returning confident,
// correctly-shaped findings computed from pixel arithmetic it ran in a shell
// instead of from looking, and the orchestrator reads them as a visual pass
// that never happened. The numbers are not wrong — they answer a narrower
// question: three cards measured "aligned" (equal heights, equal bottom gaps,
// bodies at the same y — all true) while visibly ragged, because their closing
// lines wrapped to different LINE COUNTS and nothing measured that. A brief that
// asks for measurements is exactly what a blind agent can satisfy.
//
// So the brief stops being the gate. `stamp` burns a random code into the pixels
// of every shot — a code that exists NOWHERE else: not in the DOM, not in the
// served HTML, not in the brief, not in the run dir. `verify` refuses the review
// unless the reviewer transcribed every code back. Reading rendered glyphs is
// sight; there is no arithmetic that recovers them (and an OCR pass would still
// be a reading of the picture).
//
// Both modes are pure string/pixel work in a local process, so this gate still
// fires when the ORCHESTRATOR's own image Read is dead — which is the exact
// condition it exists for.
//
// The stamper is ImageMagick (`magick`) when installed, and otherwise Playwright
// (sight-stamp.ts, the same strip drawn by a headless browser), so the gate
// runs on a stock Mac or Linux box. With neither, stamp halts.
//
// peers:
//   .agents/skills/qa/SKILL.md            (step-4-fresh-review, step-4.5-fix-reverify)
//   .agents/skills/qa/scripts/screenshot.ts
//   .agents/skills/qa/scripts/sight-stamp.ts
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/tests/sight-check.test.ts
//   .agents/skills/qa/scripts/tests/sight-check-playwright.test.ts
//   .agents/skills/review/policy-review.ts  (the documented blind fallback: a
//                                            reviewer on another vendor)
//
// Usage:
//   sight-check.ts stamp  --dir <run-dir> [--codes <path>]
//   sight-check.ts verify --codes <path> --response <file>
//
// Exit: 0 ok | 2 usage | 3 missing dependency | 4 nothing stamped
//       5 no codes file (stamp never ran — absence is NEVER a pass)
//       6 BLIND REVIEW — codes missing from the response

import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qaPlaywrightNodeModules } from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  // Unambiguous alphabet: no 0/O/1/I/L/5/S — a transcription slip must not read as
  // a blind reviewer.
  const ALPHABET = "23467894ABCDEFGHJKMNPQRTUVWXYZ";
  const CODE_LEN = 6;

  // The fallback reviewer is handed at most 8 images per call: past that, vision
  // models start skimming. Larger runs are batched.
  const ROUTER_IMAGE_MAX = 8;

  function newCode(): string {
    let out = "";
    for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    return out;
  }

  // POSIX `cksum`'s CRC: the default codes path is named by it, so a codes file
  // stamped before this was TypeScript is still the one `verify` finds.
  const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    return c >>> 0;
  });
  function cksum(text: string): string {
    const bytes = Buffer.from(text);
    let crc = 0;
    const step = (byte: number): void => {
      crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    };
    for (const b of bytes) step(b);
    for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
    return `${~crc >>> 0}${bytes.length}`;
  }

  // Codes live OUTSIDE the run dir on purpose: the reviewer is handed the run dir,
  // and a codes file sitting next to the PNGs is a text answer to a picture
  // question.
  function defaultCodesPath(dir: string): string {
    const cache = process.env.QA_SIGHT_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "qa-sight");
    mkdirSync(cache, { recursive: true });
    return `${cache}/${cksum(dir)}.codes`;
  }

  function fallbackBanner(): void {
    // Named here, not left for the operator to rediscover. The review chain puts
    // the review on a different vendor from the author — the independence the
    // review gate wants anyway. A vendor in the chain that cannot open images
    // cannot return the codes, so this same gate catches it.
    process.stderr.write(`
  ROUTE AROUND IT — run the review through the review chain instead of a
  subagent whose image Read is dead. The brief names the PNG paths to open:

    node --experimental-strip-types .agents/skills/review/policy-review.ts adversarial-review \\
      <run-dir>/manifest.json <brief.txt>   > <response>.txt

  Then verify THAT response with this same gate. Max ${ROUTER_IMAGE_MAX} images per
  call — batch larger runs. The brief must still carry the rubric and the
  "transcribe the QA SIGHT CODE" instruction, and it must NEVER carry the codes.
`);
  }

  /** `--flag value` pairs; an unknown flag is a usage error naming the mode. */
  function parseFlags(mode: string, args: string[], known: string[]): Map<string, string> {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!known.includes(args[i])) {
        err(`sight-check.ts ${mode}: unknown arg '${args[i]}'`);
        exit(2);
      }
      flags.set(args[i], args[i + 1] ?? "");
    }
    return flags;
  }

  /** An executable regular file of that name on PATH — `command -v`. */
  function onPath(name: string): boolean {
    return (process.env.PATH ?? "").split(":").some((dir) => {
      const candidate = join(dir || ".", name);
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  }

  /** Run magick; a failure stops the script with magick's own status, as `set -e` did. */
  function magick(args: string[]): string {
    const run = spawnSync("magick", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (run.status !== 0) exit(run.status ?? 1);
    return run.stdout.replace(/\n+$/, "");
  }

  // ── stamp ──────────────────────────────────────────────────────────────────
  function cmdStamp(args: string[]): void {
    const flags = parseFlags("stamp", args, ["--dir", "--codes"]);
    const given = flags.get("--dir") ?? "";
    if (!given || !existsSync(given) || !statSync(given).isDirectory()) {
      err("usage: sight-check.ts stamp --dir <run-dir> [--codes <path>]");
      exit(2);
    }
    const dir = resolve(given);
    let pwNodeModules: string | undefined;
    if (!onPath("magick")) {
      pwNodeModules = qaPlaywrightNodeModules();
      if (pwNodeModules === undefined) {
        err("sight-check.ts: neither ImageMagick nor Playwright is available — cannot stamp, so sight cannot be proven.");
        err("sight-check.ts: HALT rather than dispatch an unverifiable review.");
        exit(3);
      }
      err("sight-check.ts: no ImageMagick — stamping with Playwright");
    }
    const codes = flags.get("--codes") || defaultCodesPath(dir);

    const shots = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".png"))
      .map((e) => join(dir, e.name))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (shots.length === 0) {
      err(`sight-check.ts: no PNGs at ${dir} — nothing to review, nothing to stamp.`);
      exit(4);
    }

    writeFileSync(codes, "");
    for (const png of shots) {
      const code = newCode();
      if (pwNodeModules !== undefined) {
        const run = spawnSync(
          process.execPath,
          ["--experimental-strip-types", join(SCRIPT_DIR, "sight-stamp.ts"), dirname(pwNodeModules), png, code],
          { stdio: ["ignore", "ignore", "inherit"] },
        );
        const rc = run.status ?? 1;
        if (rc === 0) {
          renameSync(`${png}.stamped`, png);
          appendFileSync(codes, `${basename(png)}\t${code}\n`);
          continue;
        }
        rmSync(`${png}.stamped`, { force: true });
        rmSync(codes, { force: true });
        if (rc === 4) {
          err(
            `sight-check.ts: the stamp rendered blank on ${basename(png)} (no font?) — a code nobody can read is an unpassable gate.`,
          );
        } else {
          err(`sight-check.ts: the Playwright stamper failed on ${basename(png)} (exit ${rc}).`);
        }
        exit(4);
      }
      const w = magick(["identify", "-format", "%w", png]);
      const h = magick(["identify", "-format", "%h", png]);
      // Appended BELOW the shot, so every y-coordinate in the page is unchanged
      // and the reviewer's geometry stays valid.
      magick([
        png,
        "(",
        "-size",
        `${w}x56`,
        "xc:#101010",
        "-fill",
        "#f5f5f5",
        "-pointsize",
        "30",
        "-gravity",
        "center",
        "-annotate",
        "0",
        `QA SIGHT CODE  ${code}`,
        ")",
        "-append",
        `${png}.stamped`,
      ]);
      const ink = magick([
        `${png}.stamped`,
        "-crop",
        `${w}x56+0+${h}`,
        "+repage",
        "-format",
        "%[fx:standard_deviation]",
        "info:",
      ]);
      if (Number.parseFloat(ink) > 0.01) {
        renameSync(`${png}.stamped`, png);
        appendFileSync(codes, `${basename(png)}\t${code}\n`);
      } else {
        rmSync(`${png}.stamped`, { force: true });
        err(
          `sight-check.ts: the stamp rendered blank on ${basename(png)} (no font?) — a code nobody can read is an unpassable gate.`,
        );
        rmSync(codes, { force: true });
        exit(4);
      }
    }

    process.stdout.write(`QA_SIGHT_CODES=${codes}\n`);
    process.stdout.write(`QA_SIGHT_COUNT=${shots.length}\n`);
    if (shots.length > ROUTER_IMAGE_MAX) {
      err(`sight-check.ts: ${shots.length} shots > ${ROUTER_IMAGE_MAX} — the fallback reviewer needs batching.`);
    }
  }

  // ── verify ─────────────────────────────────────────────────────────────────
  function cmdVerify(args: string[]): void {
    const flags = parseFlags("verify", args, ["--codes", "--response"]);
    const codes = flags.get("--codes") ?? "";
    const response = flags.get("--response") ?? "";
    if (!codes || !response) {
      err("usage: sight-check.ts verify --codes <path> --response <file>");
      exit(2);
    }
    if (!existsSync(response) || !statSync(response).isFile()) {
      err(`sight-check.ts: no response file at ${response}`);
      exit(2);
    }
    if (!existsSync(codes) || statSync(codes).size === 0) {
      err(`sight-check.ts: no codes at ${codes} — stamp never ran, so nothing about this review is proven.`);
      err("sight-check.ts: HALT. An unstamped run can never PASS this gate; re-shoot and stamp.");
      fallbackBanner();
      exit(5);
    }

    // A codes file that is non-empty but says nothing usable (truncated write,
    // wrong --codes path, a stale file from another harness) would otherwise fall
    // straight through the loop and report `SIGHTED — 0/0` — a pass that proves
    // nothing, which is the exact shape this gate exists to refuse. Every row is
    // validated, and zero valid rows is a halt, not a success.
    // The LAST row counts when the file has no trailing newline (a truncated
    // write, a hand-made file): dropping it would shrink the denominator and let
    // a partial transcription verify as complete.
    const said = readFileSync(response, "utf8");
    let total = 0;
    let seen = 0;
    const missing: string[] = [];
    for (const line of readFileSync(codes, "utf8").split("\n")) {
      if (!line) continue;
      if (!/^[^\t]+\t[A-Z0-9]{6}$/.test(line)) {
        err(`sight-check.ts: malformed row in ${codes}: '${line}'`);
        err("sight-check.ts: HALT — a codes file that cannot be read cannot prove anything.");
        fallbackBanner();
        exit(5);
      }
      const [shot, code] = line.split("\t");
      total++;
      // A whole word, any case — what `grep -qiwF` matched.
      if (new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, "i").test(said)) seen++;
      else missing.push(shot);
    }

    if (total === 0) {
      err(`sight-check.ts: ${codes} holds no codes — nothing about this review is proven.`);
      err("sight-check.ts: HALT. 0/0 is never a pass.");
      fallbackBanner();
      exit(5);
    }

    if (missing.length === 0) {
      process.stdout.write(`sight-check: SIGHTED — ${seen}/${total} codes transcribed.\n`);
      return;
    }

    err("");
    err("  ================================================================");
    err("  BLIND REVIEW REJECTED — this is not a visual pass. Do not report it as one.");
    err("  ================================================================");
    err(`  ${seen}/${total} sight codes came back. Missing for: ${missing.join(" ")}`);
    err("");
    err("  A reviewer that cannot open the picture still returns well-formed");
    err("  findings with real pixel numbers — computed, not seen. Those numbers");
    err("  answer a narrower question than the one asked.");
    fallbackBanner();
    exit(6);
  }

  const [mode = "", ...rest] = process.argv.slice(2);
  if (mode === "stamp") cmdStamp(rest);
  else if (mode === "verify") cmdVerify(rest);
  else {
    err("usage: sight-check.ts {stamp|verify} ...");
    exit(2);
  }
}

await runToExit(main);
