#!/usr/bin/env -S node --experimental-strip-types
// sight-check.test.ts — pin the one property the gate exists for: a review
// response that is well-formed but UNSEEN must not pass.
//
// The fixture is a real failure shape — correct severities, real
// pixel numbers, a confident "ALIGNED" verdict — computed by a reviewer whose
// image Read was dead. Everything the step-4 brief asks for is present; only
// the sight codes are missing. The script is spawned, never imported; every
// case skips when ImageMagick is not installed, as the bash suite did.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/sight-check.test.ts
//
// peers: ../sight-check.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SC = join(dirname(fileURLToPath(import.meta.url)), "..", "sight-check.ts");
const TMP = mkdtempSync(join(tmpdir(), "sight-check-test-")); // outside the repo, always
after(() => rmSync(TMP, { recursive: true, force: true }));

const skip = spawnSync("sh", ["-c", "command -v magick"]).status === 0 ? false : "no ImageMagick";

function run(args: string[], env: Record<string, string> = {}): { rc: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SC, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

const RUN = join(TMP, "run");
const CODES = join(TMP, "codes.tsv");
const BLIND = join(TMP, "blind.txt");
mkdirSync(RUN);
if (!skip) {
  execFileSync("magick", [
    "-size",
    "800x600",
    "xc:#ffffff",
    "-fill",
    "#111111",
    "-pointsize",
    "32",
    "-gravity",
    "north",
    "-annotate",
    "+0+80",
    "The Next Three Years",
    join(RUN, "roadmap-1440.png"),
  ]);
  execFileSync("magick", [
    "-size",
    "390x844",
    "xc:#ffffff",
    "-fill",
    "#111111",
    "-pointsize",
    "18",
    "-gravity",
    "north",
    "-annotate",
    "+0+40",
    "The Next Three Years",
    join(RUN, "roadmap-390.png"),
  ]);
}

// ── the blind reviewer's answer: every brief requirement met, nothing seen ──
const BLIND_TEXT = `roadmap-1440.png — three roadmap cards, widths 360/360/360, tops all y=300,
bottoms all y=700, bodies begin y=356, bottom gaps 200px each. ALIGNED.
Body #6b7280 on #ffffff = 4.83:1, passes AA. No collisions; nearest pair 100px clear.
P3 — gutters 80px vs 100px outer margin.
roadmap-390.png — single column, no overflow. No P0/P1. Ship gate: PASS.
`;
writeFileSync(BLIND, BLIND_TEXT);

/** The code stamped on a shot, read back out of the codes file. */
const codeFor = (codes: string, shot: string): string =>
  readFileSync(codes, "utf8")
    .split("\n")
    .map((l) => l.split("\t"))
    .find(([s]) => s === shot)?.[1] ?? "";

// The cases run in order: verify-before-stamp first, then the stamp the rest read.
test("usage: no mode → exit 2", () => assert.equal(run([]).rc, 2));

// ── boundary: verify BEFORE stamp. Absence is never a pass. ──
test("no-codes-file halts (5)", { skip }, () => {
  writeFileSync(CODES, "");
  assert.equal(run(["verify", "--codes", CODES, "--response", BLIND]).rc, 5);
});
test("no-codes names the review-chain fallback", { skip }, () =>
  assert.match(run(["verify", "--codes", CODES, "--response", BLIND]).out, /review\/policy-review\.ts/),
);
// A render-only pass writes no manifest, so the fallback reviews the list of
// PNGs the pass stamped, made first (Contextium v9.2.0 review).
test("the fallback makes and passes the PNG list, never a manifest", { skip }, () => {
  const out = run(["verify", "--codes", CODES, "--response", BLIND]).out;
  assert.doesNotMatch(out, /manifest\.json/);
  assert.match(out, /find <run-dir> -maxdepth 1 -name '\*\.png' \| sort > <shots\.txt>/);
  assert.match(out, /adversarial-review \\\n\s+<shots\.txt> <brief\.txt>/);
});

// ── boundary: 0 shots ──
test("zero-shot dir halts (4)", { skip }, () => {
  mkdirSync(join(TMP, "empty"));
  assert.equal(run(["stamp", "--dir", join(TMP, "empty"), "--codes", join(TMP, "empty.tsv")]).rc, 4);
});

// ── stamp ──
test("stamp succeeds (0)", { skip }, () => {
  const r = run(["stamp", "--dir", RUN, "--codes", CODES]);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.stdout, `QA_SIGHT_CODES=${CODES}\nQA_SIGHT_COUNT=2\n`);
});
test("one code per shot", { skip }, () =>
  assert.equal(readFileSync(CODES, "utf8").split("\n").filter(Boolean).length, 2),
);
test("codes differ per shot", { skip }, () =>
  assert.notEqual(codeFor(CODES, "roadmap-1440.png"), codeFor(CODES, "roadmap-390.png")),
);

// The code must live in the PIXELS and nowhere a grep can reach.
test("code absent from the PNG's bytes as text", { skip }, () =>
  assert.ok(!readFileSync(join(RUN, "roadmap-1440.png")).includes(codeFor(CODES, "roadmap-1440.png"))),
);
test("codes file is not inside the run dir", { skip }, () => {
  const code = codeFor(CODES, "roadmap-1440.png");
  for (const f of readdirSync(RUN)) assert.ok(!readFileSync(join(RUN, f)).includes(code), `${f} holds the code`);
});

// Geometry above the strip is untouched — the reviewer's y-coordinates stay valid.
test("stamp appends below, width unchanged", { skip }, () =>
  assert.equal(
    execFileSync("magick", ["identify", "-format", "%wx%h", join(RUN, "roadmap-390.png")], { encoding: "utf8" }),
    "390x900",
  ),
);

// A code cut off at the edge is unreadable, so the gate cannot pass: at a
// 320px phone width the 30pt strip ran off both sides (three
// 320 shots came back with the last character cut).
test("the strip's text fits inside a 320px shot", { skip }, () => {
  const narrow = join(TMP, "narrow");
  mkdirSync(narrow);
  execFileSync("magick", ["-size", "320x400", "xc:#ffffff", join(narrow, "page-320.png")]);
  const r = run(["stamp", "--dir", narrow, "--codes", join(TMP, "narrow.tsv")]);
  assert.equal(r.rc, 0, r.out);
  // The ink inside the strip, as WxH+X+Y around the dark background.
  const box = execFileSync(
    "magick",
    [join(narrow, "page-320.png"), "-crop", "320x56+0+400", "+repage", "-fuzz", "20%", "-format", "%@", "info:"],
    { encoding: "utf8" },
  );
  const [, w, , x] = box.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/)?.map(Number) ?? [];
  assert.ok(x >= 4 && x + w <= 316, `text spans x=${x}..${x + w} of 320 (${box})`);
});

// ── THE property: the same well-formed blind answer is now rejected ──
test("blind review rejected (6)", { skip }, () =>
  assert.equal(run(["verify", "--codes", CODES, "--response", BLIND]).rc, 6),
);
test("rejection is loud", { skip }, () =>
  assert.match(run(["verify", "--codes", CODES, "--response", BLIND]).out, /BLIND REVIEW REJECTED/),
);
test("rejection names the review-chain fallback", { skip }, () =>
  assert.match(run(["verify", "--codes", CODES, "--response", BLIND]).out, /review\/policy-review\.ts/),
);

// ── a sighted answer passes ──
const sighted = (): string => {
  const f = join(TMP, "sighted.txt");
  writeFileSync(
    f,
    `roadmap-1440.png = ${codeFor(CODES, "roadmap-1440.png")}\nroadmap-390.png = ${codeFor(CODES, "roadmap-390.png")}\n${BLIND_TEXT}`,
  );
  return f;
};
test("sighted review accepted (0)", { skip }, () => {
  const r = run(["verify", "--codes", CODES, "--response", sighted()]);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.stdout, "sight-check: SIGHTED — 2/2 codes transcribed.\n");
});
test("a code transcribed in lower case still counts (0)", { skip }, () => {
  const f = join(TMP, "lower.txt");
  writeFileSync(f, readFileSync(sighted(), "utf8").toLowerCase());
  assert.equal(run(["verify", "--codes", CODES, "--response", f]).rc, 0);
});

// ── partial sight: opened one shot, computed the other ──
test("partial sight rejected (6)", { skip }, () => {
  const f = join(TMP, "partial.txt");
  writeFileSync(f, `roadmap-1440.png = ${codeFor(CODES, "roadmap-1440.png")}\n${BLIND_TEXT}`);
  assert.equal(run(["verify", "--codes", CODES, "--response", f]).rc, 6);
});

// ── boundary: empty response ──
test("empty response rejected (6)", { skip }, () => {
  writeFileSync(join(TMP, "empty.txt"), "");
  assert.equal(run(["verify", "--codes", CODES, "--response", join(TMP, "empty.txt")]).rc, 6);
});

// ── boundary: response file missing ──
test("missing response file is usage (2)", { skip }, () =>
  assert.equal(run(["verify", "--codes", CODES, "--response", join(TMP, "nope.txt")]).rc, 2),
);

// A codes file that is non-empty but unreadable must HALT, never report 0/0.
test("malformed codes file halts (5)", { skip }, () => {
  writeFileSync(join(TMP, "bad.tsv"), "garbage-with-no-tab\n");
  assert.equal(run(["verify", "--codes", join(TMP, "bad.tsv"), "--response", sighted()]).rc, 5);
});
test("codes file of blank lines halts (5)", { skip }, () => {
  writeFileSync(join(TMP, "blank.tsv"), "\n\n");
  assert.equal(run(["verify", "--codes", join(TMP, "blank.tsv"), "--response", sighted()]).rc, 5);
});

// No trailing newline: the LAST row must still count, or the denominator shrinks
// and a partial transcription verifies as complete.
test("unterminated last row still counted (6)", { skip }, () => {
  const c1 = codeFor(CODES, "roadmap-1440.png");
  writeFileSync(
    join(TMP, "nonl.tsv"),
    `roadmap-1440.png\t${c1}\nroadmap-390.png\t${codeFor(CODES, "roadmap-390.png")}`,
  );
  writeFileSync(join(TMP, "onlyfirst.txt"), `roadmap-1440.png = ${c1}\n${BLIND_TEXT}`);
  assert.equal(run(["verify", "--codes", join(TMP, "nonl.tsv"), "--response", join(TMP, "onlyfirst.txt")]).rc, 6);
});
test("unterminated codes file accepts a full transcription (0)", { skip }, () =>
  assert.equal(run(["verify", "--codes", join(TMP, "nonl.tsv"), "--response", sighted()]).rc, 0),
);

// Without --codes the file lands in QA_SIGHT_DIR, named by POSIX `cksum` of the
// run dir — the name the shell version gave it, so either finds the other's.
test("the default codes path is the run dir's cksum, outside the run dir", { skip }, () => {
  const run2 = join(TMP, "run2");
  mkdirSync(run2);
  execFileSync("magick", ["-size", "200x100", "xc:#ffffff", join(run2, "a.png")]);
  const cache = join(TMP, "cache");
  const r = run(["stamp", "--dir", run2], { QA_SIGHT_DIR: cache });
  const sum = execFileSync("sh", ["-c", 'printf %s "$1" | cksum | tr -d " \\n"', "sh", run2], { encoding: "utf8" });
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.stdout.split("\n")[0], `QA_SIGHT_CODES=${cache}/${sum}.codes`);
});

// Everything stamp prints is safe to source, stderr included. A session once
// ran `stamp > sight.env 2>&1` and then `source sight.env`; the
// batching note read "21 shots > 8 — …", the shell took `> 8` as a redirect, and
// an empty file named `8` landed in the worktree and was committed to main.
test("stamp output merged with stderr and sourced writes no file", { skip }, () => {
  const many = join(TMP, "many");
  mkdirSync(many);
  for (let i = 0; i < 9; i++) execFileSync("magick", ["-size", "200x100", "xc:#ffffff", join(many, `s${i}.png`)]);
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SC, "stamp", "--dir", many, "--codes", join(TMP, "many.tsv")],
    {
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const env = join(TMP, "many.env");
  writeFileSync(env, r.stdout + r.stderr);
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const sourced = spawnSync("bash", ["-c", `source ${JSON.stringify(env)} 2>/dev/null; echo "$QA_SIGHT_COUNT"`], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(sourced.stdout.trim(), "9");
  assert.deepEqual(readdirSync(cwd), [], "sourcing the stamp output created a file");
});
