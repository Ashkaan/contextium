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
function scripted(
  name: string,
  body: string,
  pushback = "",
): { status: number | null; stdout: string; stderr: string } {
  const d = `${tmp}/${name}`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "SPEC BODY\n");
  writeFileSync(`${d}/plan.md`, "PLAN BODY\n");
  writeFileSync(`${tmp}/${name}-vendor`, `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' '${body}'\n`);
  chmodSync(`${tmp}/${name}-vendor`, 0o755);
  const args = ["--experimental-strip-types", SUT, d, "brief"];
  if (pushback !== "") {
    writeFileSync(`${d}/pushback.md`, pushback);
    args.push(`${d}/pushback.md`);
  }
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

test("a prefixed round-two verdict is salvaged; a prefixed sentinel still fails round two", () => {
  const ok = scripted("prefix-r2", "Weighing F1.[concede] F1\n", "F1: pushback text\n");
  t(`round two verdict (stderr: ${ok.stderr})`, 0, ok.status);
  assert.equal(ok.stdout, "[concede] F1\n");
  const bad = scripted("prefix-r2-sentinel", "Weighing F1.NO_FINDINGS\n", "F1: pushback text\n");
  t(`round two sentinel (stderr: ${bad.stderr})`, 1, bad.status);
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
