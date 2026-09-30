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
      CODEX_BIN: `${tmp}/vendor`,
      GROK_BIN: `${tmp}/vendor`,
      POLICY_CHAIN_RESOLVER: `${tmp}/resolver`,
    },
    timeout: 60_000,
  }).status;
}
const prompt = (): string => readFileSync(`${tmp}/prompt.txt`, "utf8");
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

// Contextium: with no reviewer vendor installed, the shipped row falls back —
// exit 3, naming the fresh-context review and the NOT-independent line.
test("no vendor installed: the shipped row falls back to a fresh-context audit", () => {
  const d = `${tmp}/specs/009-fb`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/spec.md`, "S\n");
  writeFileSync(`${d}/plan.md`, "P\n");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, d, "brief"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_BIN: `${tmp}/none`, GROK_BIN: `${tmp}/none`, POLICY_JSON: "" },
    timeout: 60_000,
  });
  t("no vendor installed: exit 3", 3, r.status);
  assert.ok(
    r.stderr.includes("claude-fallback (fresh context, NOT independent)"),
    `…names the line to record — got: ${r.stderr}`,
  );
});
