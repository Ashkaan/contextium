#!/usr/bin/env -S node --experimental-strip-types
// sight-fallback.test.ts — run the SKILL's step-4 review-chain fallback block
// VERBATIM, against stub vendors, and pin what it must do: a vendor that cannot
// open the images is not banked, the next one is asked, and the one asked
// can actually open them.
//
// Measured against the real CLIs: Grok on the chain's default path (a
// `list_dir` allowlist, told to read no local files) answers "cannot see" for a
// PNG named in the brief, and exits 0; with `read_file` allowed it transcribes
// the code. Codex's read-only sandbox reads it. So the stubs here see only
// when invoked the way the real ones can see: grok when its allowlist holds
// read_file, codex always unless told to be blind.
//
// The block runs from a scratch root whose `.agents` links to this template's
// `agents/`, as an install lays it out. The manifest, brief and review paths
// it names live under /tmp by design (the SKILL's own paths); this suite's
// run id is unique and they are removed afterwards.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/sight-fallback.test.ts
//
// peers: ../../SKILL.md (step-4-fresh-review), ../sight-validate.ts, ../sight-check.ts,
//        ../../../review/policy-review.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = resolve(SCRIPTS, "..", "..", "..");
const TMP = mkdtempSync(join(tmpdir(), "sight-fallback-test-"));
const RUN_ID = `sight-fallback-${process.pid}`;
const SLUG = `sight-fallback-${process.pid}`;
const SHOTS = `/tmp/qa-shots/${SLUG}/${RUN_ID}`;
after(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(`/tmp/qa-shots/${SLUG}`, { recursive: true, force: true });
  rmSync(`/tmp/qa-brief-${RUN_ID}.txt`, { force: true });
  rmSync(`/tmp/qa-review-${RUN_ID}.txt`, { force: true });
});

// The fallback block: the fenced bash right after "When it fails, route around it".
const skill = readFileSync(join(SCRIPTS, "..", "SKILL.md"), "utf8");
const from = skill.indexOf("**When it fails, route around it");
const block = /```bash\n([\s\S]*?)```/.exec(skill.slice(from))?.[1] ?? "";

// An install's layout: <root>/.agents -> templates/agents.
const ROOT = join(TMP, "root");
mkdirSync(ROOT);
symlinkSync(AGENTS, join(ROOT, ".agents"));
const HARNESS = join(TMP, "harness");

// Two shots, two codes; the brief names the PNGs and never the codes.
mkdirSync(SHOTS, { recursive: true });
writeFileSync(
  join(SHOTS, "manifest.json"),
  `[{"path":"${SHOTS}/index-1440.png"},{"path":"${SHOTS}/about-1440.png"}]\n`,
);
writeFileSync(`/tmp/qa-brief-${RUN_ID}.txt`, "Transcribe each QA SIGHT CODE, then review.\n");
const CODES = join(TMP, "codes");
writeFileSync(CODES, "index-1440.png\tK7M3PX\nabout-1440.png\tR4W9TN\n");
const SEEN = "index-1440.png = K7M3PX\\nabout-1440.png = R4W9TN\\nZero findings.";

// Stub vendors: each records its argv, then answers as the real one would.
const BIN = join(TMP, "bin");
mkdirSync(BIN);
const CALLS = join(TMP, "calls");
const stub = (name: string, body: string) => {
  writeFileSync(join(BIN, name), body);
  chmodSync(join(BIN, name), 0o755);
};
stub(
  "codex",
  `#!/bin/sh
echo "codex $*" >> "${CALLS}"
cat > /dev/null
if [ -n "\${STUB_CODEX_BLIND:-}" ]; then echo "I cannot open image files here."; else printf '${SEEN}\\n'; fi
`,
);
stub(
  "grok",
  `#!/bin/sh
echo "grok $*" >> "${CALLS}"
case " $* " in
  *" --tools read_file"*) printf '{"text":"${SEEN}","stopReason":"end_turn"}\\n' ;;
  *) printf '{"text":"CANNOT SEE","stopReason":"end_turn"}\\n' ;;
esac
`,
);

function fallback(author: string, env: Record<string, string> = {}) {
  writeFileSync(HARNESS, `agent=${author}\n`);
  writeFileSync(CALLS, "");
  rmSync(`/tmp/qa-review-${RUN_ID}.txt`, { force: true });
  const r = spawnSync("bash", ["-c", block], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      CODEX_BIN: join(BIN, "codex"),
      GROK_BIN: join(BIN, "grok"),
      CONTEXTIUM_HARNESS_FILE: HARNESS,
      S: ".agents/skills/qa/scripts",
      QA_SLUG: SLUG,
      RUN_ID,
      QA_SIGHT_CODES: CODES,
      ...env,
    },
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(CALLS, "utf8") };
}

test("the fallback block is in the SKILL", () => assert.match(block, /policy-review\.ts adversarial-review/));
test("a blind first vendor is not banked: the next one is asked, sees, and the gate passes", () => {
  const r = fallback("claude", { STUB_CODEX_BLIND: "1" });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /SIGHTED — 2\/2/);
  assert.match(r.calls, /^codex /m);
  assert.match(r.calls, /^grok .*--tools read_file/m);
});
test("codex wrote the code: grok is asked with an allowlist that can open an image", () => {
  const r = fallback("codex");
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /SIGHTED — 2\/2/);
  assert.doesNotMatch(r.calls, /^codex /m);
});
test("a seeing first vendor answers alone", () => {
  const r = fallback("claude");
  assert.equal(r.rc, 0, r.out);
  assert.doesNotMatch(r.calls, /^grok /m);
});
test("no vendor can see → the gate refuses: no visual pass", () => {
  const r = fallback("codex", { GROK_BIN: join(BIN, "codex"), STUB_CODEX_BLIND: "1" });
  assert.notEqual(r.rc, 0, r.out);
  assert.doesNotMatch(r.out, /SIGHTED/);
});
