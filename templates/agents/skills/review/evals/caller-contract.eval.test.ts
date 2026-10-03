// caller-contract.eval.test.ts — peer of caller-contract.eval.ts.
// Run: node --test --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.test.ts
//
// Pins the eval's own machinery without spending its vendor call: the two-commit
// fixture it assembles, the `--pack-only` half (the blast-radius pack names the
// untouched caller), and the three grades of the rerun — PASS when the review
// names the caller, FAIL when it does not, INCONCLUSIVE when the chain never
// answers. The reviewer is a stub: `CODEX_BIN`/`GROK_BIN` point at a script
// that dumps the prompt it was handed and prints whatever this suite told it to,
// a fixture policy and resolver keep policy-chain.ts off the live catalog, and
// `codex`/`grok` on PATH are stubs that exit 1 so nothing real can be reached
// even if an override were ignored. The eval is run as a subprocess, never
// imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "caller-contract.eval.ts");
const tmp = mkdtempSync(join(tmpdir(), "caller-contract-eval-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

mkdirSync(`${tmp}/bin`, { recursive: true });
for (const v of ["codex", "grok"]) {
  writeFileSync(`${tmp}/bin/${v}`, `#!/usr/bin/env bash\necho "${v} stub on PATH: refused $*" >&2\nexit 1\n`);
  chmodSync(`${tmp}/bin/${v}`, 0o755);
}

writeFileSync(
  `${tmp}/policy.json`,
  `{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    }
  }
}
`,
);
writeFileSync(`${tmp}/resolve-model.sh`, '#!/usr/bin/env bash\necho "$2"\n');
chmodSync(`${tmp}/resolve-model.sh`, 0o755);

// The reviewer under this suite's control: dumps its prompt to SEEN, counts its
// calls, then prints REPLY (or exits 1 when REPLY is absent).
const SEEN = `${tmp}/seen.txt`;
const CALLS = `${tmp}/calls`;
const REPLY = `${tmp}/reply.txt`;
writeFileSync(
  `${tmp}/reviewer.sh`,
  `#!/usr/bin/env bash
cat >"${SEEN}"
echo x >>"${CALLS}"
[[ -f "${REPLY}" ]] || exit 1
cat "${REPLY}"
`,
);
chmodSync(`${tmp}/reviewer.sh`, 0o755);

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${tmp}/bin:${process.env.PATH ?? ""}`,
  POLICY_JSON: `${tmp}/policy.json`,
  POLICY_CHAIN_RESOLVER: `${tmp}/resolve-model.sh`,
  CODEX_BIN: `${tmp}/reviewer.sh`,
  GROK_BIN: `${tmp}/reviewer.sh`,
};

let stdout = "";
let stderr = "";
function run(...args: string[]): number | null {
  rmSync(SEEN, { force: true });
  rmSync(CALLS, { force: true });
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    env: ENV,
    timeout: 300_000,
  });
  stdout = r.stdout;
  stderr = r.stderr;
  return r.status;
}
const calls = (): number => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").split("\n").length - 1 : 0);
const clip = (label: string, text: string): string =>
  text
    .split("\n")
    .slice(0, 8)
    .map((l) => `    ${label}: ${l}`)
    .join("\n");
const outHas = (needle: string): string =>
  stdout.includes(needle) ? "yes" : `missing: ${needle}\n${clip("stdout", stdout)}`;
const errHas = (needle: string): string =>
  stderr.includes(needle) ? "yes" : `missing: ${needle}\n${clip("stderr", stderr)}`;
const seenHas = (needle: string): string =>
  existsSync(SEEN) && readFileSync(SEEN, "utf8").includes(needle) ? "yes" : `missing from prompt: ${needle}`;
// `grep -F <needle> <stdout>`, as `$(...)` reads it.
const grepOut = (needle: string): string =>
  stdout
    .split("\n")
    .filter((l) => l.includes(needle))
    .join("\n");

function t(label: string, expected: string | number | null, actual: string | number | null): void {
  assert.equal(actual, expected, `${label}\n  expected: [${expected}]\n  actual  : [${actual}]`);
}

test("1. --pack-only: the deterministic half, no reviewer reached", () => {
  const rc = run("--pack-only");
  t("pack-only exits 0", 0, rc);
  t(
    "pack-only reports the pack naming the caller",
    "yes",
    outHas("PASS: the pack names src/consumer.ts as a caller of getUser"),
  );
  t(
    "pack-only says no vendor call was spent",
    "yes",
    outHas("caller-contract: PASS (pack-only; no vendor call spent)"),
  );
  t("pack-only never calls the reviewer", 0, calls());
  t("pack-only leaves the rerun banner unprinted", "", grepOut("spending one vendor call"));
});

test("2. the rerun, reviewer names the caller", () => {
  writeFileSync(
    REPLY,
    "[must-fix] src/consumer.ts:4 greet() still calls getUser(id) with one argument — pass a LookupOptions — throws on options.includeArchived\n",
  );
  let rc = run();
  t("a review naming the caller grades PASS (exit 0)", 0, rc);
  t(
    "the PASS line names the broken caller",
    "yes",
    outHas("caller-contract: PASS — the review named the broken caller."),
  );
  t("the review stdout is echoed for the reader", "yes", outHas("--- review stdout ---"));
  t("the reviewer was called once", 1, calls());
  t("the prompt the reviewer saw carried the untouched caller by name", "yes", seenHas("src/consumer.ts"));
  t("the prompt carried the changed signature", "yes", seenHas("options: LookupOptions"));
  t("the pack half still ran first", "yes", outHas("PASS: the pack names src/consumer.ts as a caller of getUser"));

  // A mention in passing is enough: the grade is about what reached the prompt.
  writeFileSync(REPLY, "[nit] consumer greeting text could be friendlier\nNO_FINDINGS\n");
  rc = run();
  t("a passing mention of the caller still grades PASS", 0, rc);
});

test("3. the rerun, reviewer misses the caller", () => {
  writeFileSync(REPLY, "NO_FINDINGS\n");
  let rc = run();
  t("a clean review grades FAIL (exit 1)", 1, rc);
  t(
    "the FAIL names the file the review missed",
    "yes",
    errHas("caller-contract: FAIL — the review did not name src/consumer.ts."),
  );
  t("the FAIL warns that one miss is one sample", "yes", errHas("a single miss is one sample, not a regression."));
  t("the reviewer was still called", 1, calls());
  writeFileSync(REPLY, "[should-fix] src/api.ts:10 the option should default to false\n");
  rc = run();
  t("a finding about the changed file alone is still FAIL", 1, rc);
});

test("4. the rerun, no reviewer answers", () => {
  rmSync(REPLY, { force: true });
  const rc = run();
  t("an exhausted chain grades INCONCLUSIVE (exit 2), not FAIL", 2, rc);
  t("INCONCLUSIVE says the review did not complete", "yes", errHas("INCONCLUSIVE: the review did not complete"));
  t("INCONCLUSIVE says it is not a failing grade", "yes", errHas("failing grade"));
  t("both chain slots were tried before giving up", 2, calls());
  t("no PASS line was printed for the rerun", "", grepOut("the review named"));
});

test("5. the fixture is rebuilt fresh each run and cleaned up", () => {
  // A temp folder of this test's own: counted in the shared one, another
  // suite's eval run making or removing its scratch repo moved the count.
  const dir = mkdtempSync(join(tmp, "own-tmpdir-"));
  const scratch = (): string[] => readdirSync(dir).filter((n) => /^caller-contract-eval-/.test(n));
  const saved = ENV.TMPDIR;
  ENV.TMPDIR = dir;
  try {
    run("--pack-only");
  } finally {
    if (saved === undefined) delete ENV.TMPDIR;
    else ENV.TMPDIR = saved;
  }
  t("the scratch repo is removed on exit", "", scratch().join(" "));
});
