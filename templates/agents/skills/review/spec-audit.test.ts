// spec-audit.test.ts — peer of spec-audit.ts: what the reviewer is handed.
// The vendor is a stub that records its prompt, so no live chain is called.
//
// Run: node --test --experimental-strip-types .agents/skills/review/spec-audit.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "spec-audit.ts");
const tmp = mkdtempSync(join(tmpdir(), "spec-audit-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

writeFileSync(`${tmp}/vendor`, `#!/usr/bin/env bash\ncat >"${tmp}/prompt.txt"\necho NO_FINDINGS\n`);
writeFileSync(`${tmp}/resolver`, "#!/usr/bin/env bash\necho stub-model\n");
chmodSync(`${tmp}/vendor`, 0o755);
chmodSync(`${tmp}/resolver`, 0o755);

function audit(target: string): number | null {
  rmSync(`${tmp}/prompt.txt`, { force: true });
  return spawnSync(process.execPath, ["--experimental-strip-types", SUT, target, "brief"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      T3CODE_HOME: tmp,
      WORKBENCH_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_VENDORS: "claude",
      CODEX_BIN: `${tmp}/vendor`,
      GROK_BIN: `${tmp}/vendor`,
      POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
    },
    timeout: 60_000,
  }).status;
}
const prompt = (): string => readFileSync(`${tmp}/prompt.txt`, "utf8");

test("executable SPEC audit excludes Codex authors and refuses missing provenance", () => {
  const file = join(tmp, "author-spec.md");
  writeFileSync(file, "SPEC with an original Codex author\n");
  const policy = join(tmp, "author-policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      rows: {
        "adversarial-review": {
          chain: [
            { vendor: "codex", model: "codex", tracks: "gpt-{v}-sol" },
            { vendor: "grok", model: "grok", tracks: "grok-{v}" },
          ],
        },
      },
    }),
  );
  for (const authors of ["codex", ""]) {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, file, "brief"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmp,
        T3CODE_HOME: tmp,
        POLICY_CHAIN_AUTHOR_THREAD_ID: "",
        WORKBENCH_THREAD_ID: "",
        POLICY_CHAIN_AUTHOR_VENDORS: authors,
        POLICY_JSON: policy,
        CODEX_BIN: `${tmp}/vendor`,
        GROK_BIN: `${tmp}/vendor`,
        POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
      },
    });
    assert.equal(r.status, authors ? 0 : 2, r.stderr);
    if (authors) assert.match(r.stderr, /answered: grok\//);
    else assert.doesNotMatch(r.stderr, /answered:/);
  }
});
// `grep -E <re> prompt.txt`, joined as `$(...)` would read it.
const grepLines = (re: RegExp): string =>
  prompt()
    .split("\n")
    .filter((l) => re.test(l))
    .join("\n");

function t(label: string, expected: string | number | null, actual: string | number | null): void {
  assert.equal(actual, expected, `${label}\n  expected: [${expected}]\n  actual  : [${actual}]`);
}

test("a spec folder: every design file, each under its own header, in a fixed order", () => {
  const d = `${tmp}/specs/001-a`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  writeFileSync(`${d}/tasks.md`, "TASKS BODY\n");
  writeFileSync(`${d}/research.md`, "RESEARCH BODY\n");
  writeFileSync(`${d}/report.md`, "REPORT BODY\n");
  t("a folder audits cleanly", 0, audit(d));
  t(
    "the folder's four files, headed, in order",
    "=== spec.md ===\nSPEC BODY\n=== plan.md ===\nPLAN BODY\n=== tasks.md ===\nTASKS BODY\n=== research.md ===\nRESEARCH BODY",
    grepLines(/^(=== |[A-Z]+ BODY)/),
  );
  t("report.md is not design, and is not sent", "", grepLines(/REPORT BODY/));

  // data-model.md and contracts/ ride along when the plan produced them
  writeFileSync(`${d}/data-model.md`, "MODEL BODY\n");
  mkdirSync(`${d}/contracts`, { recursive: true });
  writeFileSync(`${d}/contracts/api.yaml`, "API BODY\n");
  audit(d);
  t(
    "data-model and contracts are sent after research",
    "=== research.md ===\n=== data-model.md ===\n=== contracts/api.yaml ===",
    grepLines(/^=== /).split("\n").slice(-3).join("\n"),
  );
  rmSync(`${d}/data-model.md`);
  rmSync(`${d}/contracts`, { recursive: true });

  // A folder missing tasks and research sends what it has
  rmSync(`${d}/tasks.md`);
  rmSync(`${d}/research.md`);
  audit(d);
  t("a partial folder sends what it has", "=== spec.md ===\n=== plan.md ===", grepLines(/^=== /));
});

test("no spec.md, no plan.md, or an empty folder is a caller error — nothing is sent", () => {
  mkdirSync(`${tmp}/norspec`, { recursive: true });
  writeFileSync(`${tmp}/norspec/research.md`, "R\n");
  writeFileSync(`${tmp}/norspec/plan.md`, "P\n");
  t("a folder without spec.md exits 2", 2, audit(`${tmp}/norspec`));
  t("a folder without spec.md is never sent", "no", existsSync(`${tmp}/prompt.txt`) ? "yes" : "no");
  mkdirSync(`${tmp}/noplan`, { recursive: true });
  writeFileSync(`${tmp}/noplan/spec.md`, "S\n");
  t("a folder without plan.md exits 2", 2, audit(`${tmp}/noplan`));

  mkdirSync(`${tmp}/empty`, { recursive: true });
  t("an empty folder exits 2", 2, audit(`${tmp}/empty`));
});

test("a single file still works, with no headers", () => {
  writeFileSync(`${tmp}/x.spec.md`, "LEGACY BODY\n");
  t("a file audits cleanly", 0, audit(`${tmp}/x.spec.md`));
  const headers = grepLines(/^=== /) === "" ? 0 : grepLines(/^=== /).split("\n").length;
  t(
    "a file is sent whole, unheaded",
    "LEGACY BODY|",
    `${headers === 0 ? "" : headers}${prompt().includes("LEGACY BODY") ? "LEGACY BODY" : ""}|`,
  );
});

// The reviewer is held to AGENTS.md § Standards, which names no validation
// library. A prompt that demanded one library at every boundary held a spec
// for a dependency-free service to that rule through two rounds, although the
// owner had chosen hand-written checks.
test("the standards the reviewer is held to name no library AGENTS.md does not", () => {
  const d = `${tmp}/specs/003-c`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  t("the folder audits cleanly", 0, audit(d));
  t("the prompt does not demand Zod", "", grepLines(/zod/i));
  t(
    "the prompt still holds the reviewer to AGENTS.md's Standards",
    "true",
    String(prompt().includes("AGENTS.md at the repo root")),
  );
});

// /spec-audit runs this program by path, without `node` (.agents/skills/spec-audit/SKILL.md
// step 4), so it must stay executable and its shebang must run it.
test("invoked directly by path, as the skill runs it, the program runs", () => {
  const r = spawnSync(SUT, [], { encoding: "utf8" });
  assert.equal(r.error, undefined, `direct invocation failed to start: ${r.error?.message}`);
  t("no arguments is a usage error", 2, r.status);
  assert.match(r.stderr, /^Usage: /);
});

// The chain's shape gate and the sentinel count must read lines the same way.
// A vendor answering `NO_FINDINGS\r\n` was accepted by the gate (a JS `m`-flag
// `$` matches before `\r`), which stopped the fallback, and then rejected by the
// line counter — a clean primary answer that failed the audit.
test("a CRLF NO_FINDINGS is one answer to every gate: a clean audit", () => {
  const d = `${tmp}/crlf`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  writeFileSync(`${tmp}/crlf-vendor`, "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'NO_FINDINGS\\r\\n'\n");
  chmodSync(`${tmp}/crlf-vendor`, 0o755);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, d, "brief"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      T3CODE_HOME: tmp,
      WORKBENCH_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_VENDORS: "claude",
      CODEX_BIN: `${tmp}/crlf-vendor`,
      GROK_BIN: `${tmp}/crlf-vendor`,
      POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
    },
    timeout: 60_000,
  });
  t(`a CRLF sentinel audits clean (stderr: ${r.stderr})`, 0, r.status);
  assert.match(r.stderr, /audited clean \(NO_FINDINGS\)/);
});

// The contracts list is sorted in-process, in byte order: an external `sort`
// whose status went unchecked (and whose output was capped) could fail and
// send the design without its contracts as a clean audit.
test("contracts are listed in byte order, with no external sorter to fail", () => {
  const d = `${tmp}/sorted`;
  mkdirSync(`${d}/contracts/sub`, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  writeFileSync(`${d}/contracts/b.yaml`, "B BODY\n");
  writeFileSync(`${d}/contracts/C.yaml`, "C BODY\n");
  writeFileSync(`${d}/contracts/sub/a.yaml`, "A BODY\n");
  const stubs = `${tmp}/failing-sort`;
  mkdirSync(stubs, { recursive: true });
  writeFileSync(`${stubs}/sort`, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(`${stubs}/sort`, 0o755);
  rmSync(`${tmp}/prompt.txt`, { force: true });
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, d, "brief"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      T3CODE_HOME: tmp,
      WORKBENCH_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_VENDORS: "claude",
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      LC_ALL: "en_US.UTF-8",
      CODEX_BIN: `${tmp}/vendor`,
      GROK_BIN: `${tmp}/vendor`,
      POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
    },
    timeout: 60_000,
  });
  t("the audit runs", 0, r.status);
  t(
    "every contract is sent, in byte order",
    "=== contracts/C.yaml ===\n=== contracts/b.yaml ===\n=== contracts/sub/a.yaml ===",
    grepLines(/^=== contracts\//),
  );
});

// A vendor that glues its first finding onto a narration line. When specification
// reviews did this, the anchored count saw only the later findings, exited 0,
// and the first finding went to stderr as a "dropped non-triage line". One
// normalized reading now drives the shape gate, the count and stdout.
function scripted(name: string, body: string): { status: number | null; stdout: string; stderr: string } {
  const d = `${tmp}/${name}`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  writeFileSync(`${tmp}/${name}-vendor`, `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' '${body}'\n`);
  chmodSync(`${tmp}/${name}-vendor`, 0o755);
  const args = ["--experimental-strip-types", SUT, d, "brief"];
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      T3CODE_HOME: tmp,
      WORKBENCH_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_VENDORS: "claude",
      CODEX_BIN: `${tmp}/${name}-vendor`,
      GROK_BIN: `${tmp}/${name}-vendor`,
      POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
    },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("a prefixed lone finding is salvaged, counted and emitted", () => {
  const r = scripted("prefix-one", "Reading the spec now.[must-fix] spec.md: first — fix — failure\n");
  t(`exit (stderr: ${r.stderr})`, 0, r.status);
  assert.equal(r.stdout, "[must-fix] spec.md: first — fix — failure\n");
  assert.match(r.stderr, /complete — 1 finding\(s\)/);
});

test("a prefixed first finding beside anchored ones is not dropped", () => {
  const r = scripted(
    "prefix-mixed",
    "Checking plan [step 2] next.[should-fix] plan.md: first — fix — f\r\n[must-fix] spec.md: second — fix — f\r\n[nit] tasks.md: third\r\n",
  );
  t(`exit (stderr: ${r.stderr})`, 0, r.status);
  assert.equal(
    r.stdout,
    "[should-fix] plan.md: first — fix — f\n[must-fix] spec.md: second — fix — f\n[nit] tasks.md: third\n",
  );
  assert.match(r.stderr, /complete — 3 finding\(s\)/);
  assert.doesNotMatch(r.stderr, /dropped non-triage line/);
});

test("a sentence that merely mentions the sentinel is not a clean audit", () => {
  const r = scripted("prose-sentinel", "I could not complete the audit and cannot return NO_FINDINGS\n");
  t(`exit (stderr: ${r.stderr})`, 1, r.status);
  assert.doesNotMatch(r.stderr, /audited clean/);
});

test("a prefixed clean sentinel audits clean", () => {
  const r = scripted("prefix-clean", "Done reading.NO_FINDINGS\n");
  t(`exit (stderr: ${r.stderr})`, 0, r.status);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /audited clean \(NO_FINDINGS\)/);
});

test("a prefixed follow-up verdict is salvaged; a prefixed sentinel still fails a follow-up", () => {
  const ok = followUp("prefix-fu", "Weighing F1.[resolved] F1\n", "F1 pushback: pushback text\n");
  t(`follow-up verdict (stderr: ${ok.stderr})`, 0, ok.status);
  assert.equal(ok.stdout, "[resolved] F1\n");
  const bad = followUp("prefix-fu-sentinel", "Weighing F1.NO_FINDINGS\n", "F1 pushback: pushback text\n");
  t(`follow-up sentinel (stderr: ${bad.stderr})`, 1, bad.status);
});

// ── Supported inputs and ideas ───────────────────────────────────────────
// A spec that never says which document layouts it has to support leaves
// every code review to invent a new one. Round one now
// attacks the spec's supported inputs, and names related improvements as
// [idea] lines that ride outside the eight-finding cap.

test("round one asks for supported inputs and for [idea] lines outside the finding cap", () => {
  const d = `${tmp}/specs/004-inputs`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  t("the folder audits cleanly", 0, audit(d));
  const p = prompt();
  assert.match(p, /Supported inputs/, "the prompt has no supported-inputs dimension");
  assert.match(p, /no fallback/i, "the prompt does not ask for a fallback for inputs outside the classes");
  assert.match(p, /\[idea\]\s+<section>: <improvement>/, "the prompt does not define the [idea] line");
  assert.match(p, /at most 5/, "the prompt does not cap ideas at five");
  assert.match(p, /not counted in the 8/i, "the prompt does not keep ideas out of the finding cap");
});

test("[idea] lines pass through stdout and are not counted as findings", () => {
  const r = scripted(
    "ideas",
    "[must-fix] spec.md: no layouts — name them — wrong parse\n[idea] Supported inputs: accept scanned PDFs\nNarration.[idea] Requirements: a dry-run flag\n",
  );
  t(`exit (stderr: ${r.stderr})`, 0, r.status);
  assert.equal(
    r.stdout,
    "[must-fix] spec.md: no layouts — name them — wrong parse\n[idea] Supported inputs: accept scanned PDFs\n[idea] Requirements: a dry-run flag\n",
  );
  assert.match(r.stderr, /complete — 1 finding\(s\)/);
  assert.match(r.stderr, /2 idea\(s\)/);
});

test("ideas beside NO_FINDINGS are a clean audit; ideas alone are not an audit", () => {
  const clean = scripted("ideas-clean", "NO_FINDINGS\n[idea] Requirements: a dry-run flag\n");
  t(`clean with ideas (stderr: ${clean.stderr})`, 0, clean.status);
  assert.equal(clean.stdout, "[idea] Requirements: a dry-run flag\n");
  assert.match(clean.stderr, /audited clean \(NO_FINDINGS\)/);
  const bare = scripted("ideas-bare", "[idea] Requirements: a dry-run flag\n");
  t(`ideas without the sentinel (stderr: ${bare.stderr})`, 1, bare.status);
});

// ── Follow-up rounds ─────────────────────────────────────────────────────
// The pushback-only round two never re-read an accepted edit. A follow-up
// round hands the reviewer the current spec and each open finding's
// disposition, and takes exactly one [resolved]/[open] verdict per ID, plus
// new findings only for defects the accepted edits introduced.

function followUp(
  name: string,
  body: string,
  dispositions: string,
  thread: { WORKBENCH_THREAD_ID?: string; T3CODE_THREAD_ID?: string } = {},
  specDir = `${tmp}/${name}`,
): { status: number | null; stdout: string; stderr: string; prompt: string } {
  mkdirSync(specDir, { recursive: true });
  if (!existsSync(`${specDir}/spec.md`)) writeFileSync(`${specDir}/spec.md`, "SPEC BODY\n");
  if (!existsSync(`${specDir}/plan.md`)) writeFileSync(`${specDir}/plan.md`, "PLAN BODY\n");
  const vendor = `${tmp}/${name}-fu-vendor`;
  writeFileSync(vendor, `#!/usr/bin/env bash\ncat >"${tmp}/${name}-fu-prompt.txt"\nprintf '%s' '${body}'\n`);
  chmodSync(vendor, 0o755);
  writeFileSync(`${tmp}/${name}-dispositions.md`, dispositions);
  rmSync(`${tmp}/${name}-fu-prompt.txt`, { force: true });
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SUT, specDir, "brief", "--follow-up", `${tmp}/${name}-dispositions.md`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmp,
        T3CODE_HOME: tmp,
        WORKBENCH_THREAD_ID: thread.WORKBENCH_THREAD_ID ?? "",
        T3CODE_THREAD_ID: thread.T3CODE_THREAD_ID ?? "",
        POLICY_CHAIN_AUTHOR_THREAD_ID: "",
        POLICY_CHAIN_AUTHOR_VENDORS: "claude",
        CODEX_BIN: vendor,
        GROK_BIN: vendor,
        POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
      },
      timeout: 60_000,
    },
  );
  const p = existsSync(`${tmp}/${name}-fu-prompt.txt`) ? readFileSync(`${tmp}/${name}-fu-prompt.txt`, "utf8") : "";
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, prompt: p };
}

const DISPOSITIONS = "F1 accepted: named the three layouts in Supported inputs\nF2 pushback: the cap is already in FR-003\n";

test("a follow-up sends the spec and the dispositions, and asks one verdict per ID and no ideas", () => {
  const r = followUp("fu-ok", "[resolved] F1\n[open] F2 FR-003 caps writes, not reads\n", DISPOSITIONS);
  t(`exit (stderr: ${r.stderr})`, 0, r.status);
  assert.equal(r.stdout, "[resolved] F1\n[open] F2 FR-003 caps writes, not reads\n");
  assert.match(r.prompt, /SPEC BODY/, "the follow-up does not send the current spec");
  assert.ok(r.prompt.includes(DISPOSITIONS.trimEnd()), "the follow-up does not send the dispositions verbatim");
  assert.match(r.prompt, /\[resolved\] F<n>/);
  assert.match(r.prompt, /\[open\] F<n>/);
  assert.match(r.prompt, /ONLY for defects the accepted edits introduced/);
  assert.doesNotMatch(r.prompt, /\[idea\]/, "a follow-up must not ask for ideas");
  assert.doesNotMatch(r.prompt, /ROUND 1/, "a follow-up is not a fresh review");
});

test("a follow-up may add must-fix and should-fix lines for defects the edits introduced", () => {
  const r = followUp(
    "fu-new",
    "[resolved] F1\n[resolved] F2\n[must-fix] spec.md: the new table drops CSV — add it — CSV rejected\n[should-fix] plan.md: shape note stale\n[nit] style\n[idea] Requirements: more\n",
    DISPOSITIONS,
  );
  t(`exit (stderr: ${r.stderr})`, 0, r.status);
  assert.equal(
    r.stdout,
    "[resolved] F1\n[resolved] F2\n[must-fix] spec.md: the new table drops CSV — add it — CSV rejected\n[should-fix] plan.md: shape note stale\n",
  );
  assert.match(r.stderr, /dropped non-triage line: \[nit\] style/);
  assert.match(r.stderr, /dropped non-triage line: \[idea\] Requirements: more/);
});

test("a follow-up with a missing, doubled or unknown verdict ID, or a bare sentinel, is a failed round", () => {
  const missing = followUp("fu-missing", "[resolved] F1\n", DISPOSITIONS);
  t(`missing (stderr: ${missing.stderr})`, 1, missing.status);
  assert.match(missing.stderr, /missing: F2/);
  const dup = followUp("fu-dup", "[resolved] F1\n[open] F1 no\n[resolved] F2\n", DISPOSITIONS);
  t(`duplicate (stderr: ${dup.stderr})`, 1, dup.status);
  assert.match(dup.stderr, /duplicate: F1/);
  const unknown = followUp("fu-unknown", "[resolved] F1\n[resolved] F2\n[resolved] F9\n", DISPOSITIONS);
  t(`unexpected (stderr: ${unknown.stderr})`, 1, unknown.status);
  assert.match(unknown.stderr, /unexpected: F9/);
  const sentinel = followUp("fu-sentinel", "NO_FINDINGS\n", DISPOSITIONS);
  t(`sentinel (stderr: ${sentinel.stderr})`, 1, sentinel.status);
  const old = followUp("fu-old", "[concede] F1\n[concede] F2\n", DISPOSITIONS);
  t(`old round-two verdicts (stderr: ${old.stderr})`, 1, old.status);
});

test("a dispositions file that is empty, malformed or repeats an ID is a caller error, and nothing is sent", () => {
  for (const [label, text] of [
    ["empty", "\n"],
    ["no disposition", "F1: named the layouts\n"],
    ["unknown disposition", "F1 deferred: later\n"],
    ["no ID", "accepted: named the layouts\n"],
    ["no text", "F1 accepted:\n"],
    ["repeated ID", "F1 accepted: a\nF1 pushback: b\n"],
  ] as const) {
    const r = followUp(`fu-bad-${label.replace(/ /g, "-")}`, "[resolved] F1\n", text);
    t(`${label} (stderr: ${r.stderr})`, 2, r.status);
    t(`${label} is never sent`, "", r.prompt);
    assert.match(r.stderr, /follow-up file/, `${label}: the error does not name the follow-up file`);
  }
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, `${tmp}/fu-ok`, "brief", "--follow-up", `${tmp}/nope.md`], {
    encoding: "utf8",
  });
  t("a missing dispositions file exits 2", 2, r.status);
});

test("the old pushback-file third argument is gone: a usage error", () => {
  writeFileSync(`${tmp}/old-pushback.md`, "F1: x — y\n");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, `${tmp}/fu-ok`, "brief", `${tmp}/old-pushback.md`], {
    encoding: "utf8",
  });
  t("a bare third argument exits 2", 2, r.status);
  assert.match(r.stderr, /--follow-up/);
});

test("at most three follow-ups per spec and thread: the fourth exits 5", () => {
  const spec = `${tmp}/capped`;
  const ok = "[resolved] F1\n[resolved] F2\n";
  const thread = { WORKBENCH_THREAD_ID: "thread-a" };
  for (let i = 1; i <= 3; i++) t(`follow-up ${i} runs`, 0, followUp("cap", ok, DISPOSITIONS, thread, spec).status);
  const fourth = followUp("cap", ok, DISPOSITIONS, thread, spec);
  t(`the fourth follow-up is refused (stderr: ${fourth.stderr})`, 5, fourth.status);
  t("the refused round is never sent", "", fourth.prompt);
  assert.match(fourth.stderr, /3 follow-up/);
  assert.ok(existsSync(`${tmp}/.cache/workbench/spec-audit-rounds`), "no counter under ~/.cache/workbench/spec-audit-rounds");
  // Another thread on the same spec has its own count; T3CODE_THREAD_ID keys it too.
  t("another thread starts fresh", 0, followUp("cap", ok, DISPOSITIONS, { T3CODE_THREAD_ID: "thread-b" }, spec).status);
  // Another spec in the same thread has its own count.
  t("another spec starts fresh", 0, followUp("cap2", ok, DISPOSITIONS, thread).status);
});

test("a failed follow-up does not spend a round", () => {
  const spec = `${tmp}/capped-failing`;
  const thread = { WORKBENCH_THREAD_ID: "thread-c" };
  for (let i = 1; i <= 3; i++) t(`failed follow-up ${i}`, 1, followUp("capf", "[resolved] F1\n", DISPOSITIONS, thread, spec).status);
  t("a good follow-up still runs", 0, followUp("capf", "[resolved] F1\n[resolved] F2\n", DISPOSITIONS, thread, spec).status);
});

test("with no thread id the cap fails open: no counter, and a fourth follow-up runs", () => {
  rmSync(`${tmp}/.cache`, { recursive: true, force: true });
  const spec = `${tmp}/uncapped`;
  for (let i = 1; i <= 4; i++)
    t(`follow-up ${i} without a thread id`, 0, followUp("open", "[resolved] F1\n[resolved] F2\n", DISPOSITIONS, {}, spec).status);
  t("no counter was written", "no", existsSync(`${tmp}/.cache/workbench/spec-audit-rounds`) ? "yes" : "no");
});

// Contextium: with no reviewer vendor installed, the shipped row falls back —
// exit 3, naming the fresh-context review and the NOT-independent line.
test("no vendor installed: the shipped row falls back to a fresh-context audit", () => {
  const d = `${tmp}/specs/009-fb`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "S\n");
  writeFileSync(`${d}/plan.md`, "P\n");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, d, "brief"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      T3CODE_HOME: `${tmp}/no-t3`,
      WORKBENCH_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_THREAD_ID: "",
      POLICY_CHAIN_AUTHOR_VENDORS: "claude",
      CODEX_BIN: `${tmp}/none`,
      GROK_BIN: `${tmp}/none`,
      POLICY_JSON: "",
    },
    timeout: 60_000,
  });
  t("no vendor installed: exit 3", 3, r.status);
  assert.ok(
    r.stderr.includes("claude-fallback (fresh context, NOT independent)"),
    `…names the line to record — got: ${r.stderr}`,
  );
});
