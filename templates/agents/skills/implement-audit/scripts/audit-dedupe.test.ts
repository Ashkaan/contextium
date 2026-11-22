// audit-dedupe.test.ts — peer of audit-dedupe.ts: the review receipt.
// Run: node --test --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.test.ts
//
// Pins the receipt's lifecycle as validate.ts drives it — begin (register the
// obligation, check the declaration, reuse or open an incomplete attempt),
// finish (bind the parsed result to the content captured before dispatch) —
// and the readers that consume it: status (the skill's step 0), mark (a
// trailer is a record, never proof) and check (the close). Every case runs the
// script as a program in its own HOME, so no real thread's state is read or
// written; snapshots are real git trees written through a temporary index.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "audit-dedupe.ts");
const TMP = mkdtempSync(join(tmpdir(), "audit-dedupe-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const HOME = join(TMP, "home");

const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME, T3CODE_HOME: join(TMP, "absent-t3") };
delete baseEnv.CLAUDE_CODE_SESSION_ID;
delete baseEnv.CLAUDE_SESSION_ID;
delete baseEnv.WORKBENCH_THREAD_ID;
delete baseEnv.CODE_REVIEW_LOOP_ID;
delete baseEnv.CODE_REVIEW_ROUND_STATE_DIR;
delete baseEnv.POLICY_CHAIN_AUTHOR_VENDORS;
delete baseEnv.POLICY_CHAIN_AUTHOR_THREAD_ID;

interface R {
  out: string;
  err: string;
  rc: number | null;
}
function run(env: NodeJS.ProcessEnv, ...args: string[]): R {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.replace(/\n+$/, ""), err: r.stderr.replace(/\n+$/, ""), rc: r.status };
}
const git = (dir: string, ...a: string[]): string =>
  spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }).stdout.replace(/\n+$/, "");
function repo(name: string): string {
  const d = join(TMP, name);
  mkdirSync(join(d, ".agents/skills/demo"), { recursive: true });
  mkdirSync(join(d, "projects"), { recursive: true });
  git(d, "init", "-q", "-b", "main", ".");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 1;\n");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 1;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  return d;
}
/** A snapshot as code-review.ts takes one: the working tree as a git tree, HEAD and index untouched. */
function snap(dir: string): string {
  const idx = join(TMP, `idx-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  spawnSync("git", ["-C", dir, "read-tree", "HEAD"], { env });
  spawnSync("git", ["-C", dir, "add", "-A"], { env });
  const t = spawnSync("git", ["-C", dir, "write-tree"], { env, encoding: "utf8" }).stdout.trim();
  rmSync(idx, { force: true });
  return t;
}
function result(name: string, findings: string[], coverage: unknown[] = [], vendor = "grok/grok-4"): string {
  const f = join(TMP, `${name}.json`);
  writeFileSync(f, JSON.stringify({ vendor, findings, coverage }));
  return f;
}
/** A finding's id as audit-dedupe.ts findingId gives it: F and six hex digits of the normalised line. */
const fid = (line: string): string =>
  `F${createHash("sha256").update(line.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 6)}`;
/**
 * A follow-up round's result as code-review.ts writes it: <shown> is the open
 * findings its prompt listed, each with a verdict — open when the round
 * re-reports it, else <left> (fixed unless a case says otherwise).
 */
function shownResult(
  name: string,
  findings: string[],
  shown: string[],
  left: "fixed" | "disproved" | "open" | null = "fixed",
  extra: Record<string, unknown> = {},
): string {
  const f = join(TMP, `${name}.json`);
  const again = new Set(findings.map((l) => l.replace(/\s+/g, " ").trim()));
  const verdicts = shown.flatMap((b) => {
    const v = again.has(b.replace(/\s+/g, " ").trim()) ? "open" : left;
    return v === null ? [] : [{ id: fid(b), verdict: v, evidence: "read the repair" }];
  });
  writeFileSync(f, JSON.stringify({ vendor: "grok/grok-4", findings, coverage: [], shown, verdicts, ...extra }));
  return f;
}
const owner = (id: string): NodeJS.ProcessEnv => ({
  CODE_REVIEW_LOOP_ID: id,
  CODE_REVIEW_ROUND_STATE_DIR: join(TMP, `rounds-${id}`),
});
function begin(env: NodeJS.ProcessEnv, dir: string, mode = "range", extra: string[] = []): R {
  return run(
    env,
    "begin",
    "--repo",
    dir,
    "--tree",
    snap(dir),
    "--mode",
    mode,
    "--bucket",
    "build",
    "--base",
    "HEAD",
    "--scope",
    ".agents/skills/demo",
    ...extra,
  );
}
function approve(env: NodeJS.ProcessEnv, dir: string, findings: string[] = []): R {
  const b = begin(env, dir);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /RECEIPT=review/);
  return run(env, "finish", "--repo", dir, "--rc", "0", "--result", result(`r-${Math.random()}`, findings));
}

test("usage", () => {
  assert.equal(run({}).rc, 2);
  assert.equal(run({}, "bogus").rc, 2);
  const m = run(owner("u"), "mark");
  assert.equal(m.rc, 2);
  assert.match(m.err, /usage: audit-dedupe\.ts mark/);
  assert.equal(run(owner("u"), "begin", "--repo").rc, 2, "a flag with no value");
  assert.equal(run(owner("u"), "begin", "--repo", TMP).rc, 2, "begin without --tree, --mode, --bucket");
  assert.equal(run(owner("u"), "check").rc, 2, "check without --owner");
});

test("a real upstream merge after approval gets a focused, separate review allowance", () => {
  const d = repo("merge-allowance");
  const env: Record<string, string | undefined> = {
    ...owner("merge-allowance"),
    POLICY_CHAIN_AUTHOR_VENDORS: "claude",
  };
  const initialSource = "export const a = 1;\n" + "// shared context\n".repeat(10) + "export const tail = 1;\n";
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), initialSource);
  git(d, "commit", "-qam", "shared registry fixture");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", base);
  git(d, "checkout", "-qb", "work");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), initialSource.replace("a = 1", "a = 2"));
  git(d, "commit", "-qam", "own change");
  const approvedTree = snap(d);
  begin(env, d, "range", ["--base", base]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("merge-approved", [])).out,
    "APPROVED=1",
  );
  // The stalled sessions were created before follow-ups recorded HEAD.
  const legacyFile = join(HOME, ".cache/workbench/threads/merge-allowance/review.json");
  const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
  delete legacy.repos[d].receipt.head;
  delete legacy.repos[d].approvedReceipt.head;
  writeFileSync(legacyFile, JSON.stringify(legacy));
  git(d, "checkout", "-q", "main");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), initialSource.replace("tail = 1", "tail = 2"));
  git(d, "commit", "-qam", "upstream change");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-q", "work");
  git(d, "merge", "--no-edit", "main");
  const started = begin(env, d);
  assert.equal(started.rc, 0, started.err);
  assert.match(
    started.out,
    /^REVIEW_BUCKET=merge$/m,
    "imported code must not exhaust the implementation's fix allowance",
  );
  assert.match(
    started.out,
    new RegExp(`^REVIEW_SINCE=${approvedTree}$`, "m"),
    "only the change since approval is reviewed",
  );
  assert.equal(run(env, "check", "--owner", "merge-allowance", d).rc, 1, "a merge still needs its own actual review");
  const blocked = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result("merge-defect", ["[must-fix] b.ts:1: defect — fix — risk"]),
  );
  assert.equal(blocked.out, "APPROVED=0");
  const stateFile = join(HOME, ".cache/workbench/threads/merge-allowance/review.json");
  const first = JSON.parse(readFileSync(stateFile, "utf8")).repos[d].integration;
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), initialSource.replace("a = 1", "a = 2").replace("tail = 1", "tail = 3"));
  const fixing = begin(env, d, "since", ["--since", approvedTree]);
  assert.match(fixing.out, /^REVIEW_BUCKET=merge$/m);
  assert.deepEqual(
    JSON.parse(readFileSync(stateFile, "utf8")).repos[d].integration,
    first,
    "fixes and retries keep the same bounded integration budget",
  );
  // Drive the actual reviewer program against a stub vendor, with the ordinary
  // implementation allowance exhausted. No receipt/counter is hand-reset.
  const roundDir = env.CODE_REVIEW_ROUND_STATE_DIR as string;
  const buildCounter = join(roundDir, readdirSync(roundDir).find((p) => !p.includes("."))!);
  writeFileSync(buildCounter, "99\n");
  const policy = join(TMP, "integration-policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      rows: {
        "adversarial-review": { mode: "single", chain: [{ vendor: "codex", model: "codex", tracks: "gpt-{v}-sol" }] },
      },
    }),
  );
  const vendor = join(TMP, "integration-vendor.ts");
  writeFileSync(
    vendor,
    '#!/usr/bin/env -S node --experimental-strip-types\nimport{readFileSync}from"node:fs";readFileSync(0);process.stdout.write("NO_FINDINGS\\n");\n',
  );
  chmodSync(vendor, 0o755);
  const resolver = join(TMP, "integration-resolver.ts");
  writeFileSync(resolver, '#!/usr/bin/env -S node --experimental-strip-types\nprocess.stdout.write("gpt-6-sol\\n");\n');
  chmodSync(resolver, 0o755);
  const review = (extra: string[] = []) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(dirname(SUT), "../../review/code-review.ts"), "--since", approvedTree, ...extra],
      {
        encoding: "utf8",
        env: {
          ...baseEnv,
          ...env,
          CODE_REVIEW_BUCKET: "merge",
          CODE_REVIEW_MAX_ROUNDS: "3",
          CODEX_REVIEW_REPO: d,
          POLICY_JSON: policy,
          POLICY_CHAIN_RESOLVER: resolver,
          CODEX_BIN: vendor,
        },
        timeout: 60_000,
      },
    );
  assert.equal(review().status, 0, "a spent build allowance must not block the merge review");
  assert.equal(review().status, 0);
  assert.equal(review().status, 0, "integration starts at round one and has all three regular slots");
  assert.equal(review().status, 5, "integration fix loops remain bounded");
  assert.equal(review(["--final"]).status, 0);
  assert.equal(review(["--final"]).status, 5, "there is only one final integration pass");
  assert.equal(readFileSync(buildCounter, "utf8"), "99\n", "integration never resets or spends the build counter");
  const clean = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    shownResult("merge-fixed", [], ["[must-fix] b.ts:1: defect — fix — risk"]),
  );
  assert.equal(clean.out, "APPROVED=1", clean.err);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 9;\n");
  assert.doesNotMatch(
    begin(env, d).out,
    /^REVIEW_BUCKET=merge$/m,
    "author edits alone cannot obtain a fresh integration allowance",
  );
});

test("an upstream-merge review lists only this branch's files and the covered ones that moved, never the trunk's other work", () => {
  const d = repo("merge-paths");
  const env = { ...owner("merge-paths"), POLICY_CHAIN_AUTHOR_VENDORS: "claude" };
  const source = "export const a = 1;\n" + "// shared context\n".repeat(10) + "export const tail = 1;\n";
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), source);
  git(d, "commit", "-qam", "shared fixture");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", base);
  git(d, "checkout", "-qb", "work");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), source.replace("a = 1", "a = 2"));
  git(d, "commit", "-qam", "own change");
  const approvedTree = snap(d);
  begin(env, d, "range", ["--base", base]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("paths-approved", [])).out,
    "APPROVED=1",
  );
  // The trunk moves this branch's own file and, separately, a file nobody here touched.
  git(d, "checkout", "-q", "main");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), source.replace("tail = 1", "tail = 2"));
  mkdirSync(join(d, "apps/other"), { recursive: true });
  writeFileSync(join(d, "apps/other/big.ts"), "export const other = 1;\n".repeat(50));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "upstream work");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-q", "work");
  git(d, "merge", "--no-edit", "main");
  const started = begin(env, d);
  assert.equal(started.rc, 0, started.err);
  assert.match(started.out, /^REVIEW_BUCKET=merge$/m);
  assert.match(started.out, new RegExp(`^REVIEW_SINCE=${approvedTree}$`, "m"));
  const file = started.out.match(/^REVIEW_PATHS_FILE=(.*)$/m)?.[1];
  assert.ok(file, `no REVIEW_PATHS_FILE in ${started.out}`);
  assert.deepEqual(
    readFileSync(file, "utf8").split("\0").filter(Boolean),
    [".agents/skills/demo/a.ts"],
    "the merged-in apps/other/big.ts is the trunk's own work and is not re-reviewed here",
  );
  // The reviewer program itself, with a stand-in vendor that records its prompt:
  // the branch's file reaches it, the trunk's other file does not, and an empty
  // list sends nothing at all (git reads an empty pathspec file as "everything").
  const policy = join(TMP, "paths-policy.json");
  writeFileSync(
    policy,
    JSON.stringify({
      rows: {
        "adversarial-review": { mode: "single", chain: [{ vendor: "codex", model: "codex", tracks: "gpt-{v}-sol" }] },
      },
    }),
  );
  const seenFile = join(TMP, "paths-seen.txt");
  const vendor = join(TMP, "paths-vendor.ts");
  writeFileSync(
    vendor,
    `#!/usr/bin/env -S node --experimental-strip-types\nimport{readFileSync,writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(seenFile)},readFileSync(0));process.stdout.write("NO_FINDINGS\\n");\n`,
  );
  chmodSync(vendor, 0o755);
  const resolver = join(TMP, "paths-resolver.ts");
  writeFileSync(resolver, '#!/usr/bin/env -S node --experimental-strip-types\nprocess.stdout.write("gpt-6-sol\\n");\n');
  chmodSync(resolver, 0o755);
  const review = (pathsFile: string) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(dirname(SUT), "../../review/code-review.ts"), "--since", approvedTree],
      {
        encoding: "utf8",
        env: {
          ...baseEnv,
          ...env,
          CODE_REVIEW_BUCKET: "merge",
          CODE_REVIEW_PATHS_FILE: pathsFile,
          CODEX_REVIEW_REPO: d,
          POLICY_JSON: policy,
          POLICY_CHAIN_RESOLVER: resolver,
          CODEX_BIN: vendor,
        },
        timeout: 60_000,
      },
    );
  const narrowed = review(file);
  assert.equal(narrowed.status, 0, narrowed.stderr);
  const prompt = readFileSync(seenFile, "utf8");
  assert.match(prompt, /a = 2/, "the branch's own file reaches the reviewer");
  assert.match(prompt, /tail = 2/, "including what the trunk changed inside it");
  assert.doesNotMatch(prompt, /big\.ts|export const other/, "the trunk's other file does not");
  rmSync(seenFile);
  const emptyList = join(TMP, "paths-empty.txt");
  writeFileSync(emptyList, "");
  const nothing = review(emptyList);
  assert.equal(nothing.status, 4, `an empty list is converged, not a review of everything: ${nothing.stderr}`);
  assert.equal(existsSync(seenFile), false, "and no vendor call is made");
});

test("an ordinary follow-up names no path list: it reviews everything since its snapshot", () => {
  const d = repo("no-merge-paths");
  const env = { ...owner("no-merge-paths"), POLICY_CHAIN_AUTHOR_VENDORS: "claude" };
  const base = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", base);
  begin(env, d, "range", ["--base", base]);
  run(env, "finish", "--repo", d, "--rc", "0", "--result", result("no-merge-paths", ["[must-fix] a.ts:1: x — y — z"]));
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const followUp = begin(env, d, "since", ["--since", snap(d)]);
  assert.equal(followUp.rc, 0, followUp.err);
  assert.doesNotMatch(followUp.out, /^REVIEW_PATHS_FILE=/m);
});

test("local merges and an unapproved implementation cannot obtain an integration allowance", () => {
  for (const approved of [true, false]) {
    const d = repo(`local-merge-${approved}`);
    const env = owner(`local-merge-${approved}`);
    const base = git(d, "rev-parse", "HEAD");
    git(d, "update-ref", "refs/remotes/origin/main", base);
    git(d, "checkout", "-qb", "work");
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
    git(d, "commit", "-qam", "own change");
    begin(env, d, "range", ["--base", base]);
    const initial = run(
      env,
      "finish",
      "--repo",
      d,
      "--rc",
      "0",
      "--result",
      result(`local-merge-${approved}`, approved ? [] : ["[must-fix] a.ts:1: defect — fix — risk"]),
    );
    assert.equal(initial.out, `APPROVED=${approved ? 1 : 0}`);
    git(d, "checkout", "-q", "main");
    writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
    git(d, "commit", "-qam", "other branch");
    if (!approved) git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(d, "checkout", "-q", "work");
    git(d, "merge", "--no-edit", "main");
    assert.doesNotMatch(
      begin(env, d).out,
      /^REVIEW_BUCKET=merge$/m,
      "a real upstream merge AND earlier approval are required",
    );
  }
});

test("an already-approved incoming ancestor cannot renew the allowance for later local edits", () => {
  const d = repo("old-incoming"),
    env = owner("old-incoming");
  const src = "export const a = 1;\n" + "// context\n".repeat(10) + "export const tail = 1;\n";
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src);
  git(d, "commit", "-qam", "fixture");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", base);
  git(d, "checkout", "-qb", "work");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src.replace("a = 1", "a = 2"));
  git(d, "commit", "-qam", "feature");
  git(d, "checkout", "-q", "main");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src.replace("tail = 1", "tail = 2"));
  git(d, "commit", "-qam", "upstream");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-q", "work");
  git(d, "merge", "--no-edit", "main");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src.replace("a = 1", "a = 2"));
  git(d, "commit", "-qam", "restore source");
  begin(env, d, "range", ["--base", base]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("old-incoming-approved", [])).out,
    "APPROVED=1",
  );
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src.replace("a = 1", "a = 9"));
  assert.doesNotMatch(
    begin(env, d, "range", ["--base", base]).out,
    /^REVIEW_BUCKET=merge$/m,
    "the incoming commit was already present when this source was approved",
  );
});

test("a real upstream merge after a committed local fix reviews both changes in the integration allowance", () => {
  const d = repo("local-fix-then-upstream"),
    env = owner("local-fix-then-upstream");
  const src = "export const a = 1;\n" + "// context\n".repeat(10) + "export const tail = 1;\n";
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src);
  git(d, "commit", "-qam", "fixture");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", base);
  git(d, "checkout", "-qb", "work");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src.replace("a = 1", "a = 2"));
  git(d, "commit", "-qam", "feature");
  const approved = snap(d);
  begin(env, d, "range", ["--base", base]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("before-local-fix", [])).out,
    "APPROVED=1",
  );
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  git(d, "commit", "-qam", "local fix after approval");
  git(d, "checkout", "-q", "main");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), src.replace("tail = 1", "tail = 4"));
  git(d, "commit", "-qam", "new upstream source");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-q", "work");
  git(d, "merge", "--no-edit", "main");
  const b = begin(env, d, "range", ["--base", base]);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /^REVIEW_BUCKET=merge$/m);
  assert.match(b.out, new RegExp(`^REVIEW_SINCE=${approved}$`, "m"));
  const diff = git(d, "diff", approved);
  assert.match(diff, /\+export const b = 3;/);
  assert.match(diff, /\+export const tail = 4;/);
  assert.equal(
    run(env, "check", "--owner", "local-fix-then-upstream", d).rc,
    1,
    "neither change is approved before review",
  );
});

test("a malformed historical report cannot abort begin after the current declaration is repaired", () => {
  const d = repo("malformed-parent"),
    env = owner("malformed-parent");
  const report = join(d, "projects/report.md");
  const valid = `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`;
  writeFileSync(report, valid);
  git(d, "add", "-A");
  git(d, "commit", "-qm", "report fixture");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", base);
  git(d, "checkout", "-qb", "work");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  git(d, "commit", "-qam", "feature");
  begin(env, d, "range", ["--base", base, "--report", report]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("before-malformed", [])).out,
    "APPROVED=1",
  );
  git(d, "checkout", "-q", "main");
  writeFileSync(report, valid.replace('"claims":[]', '"claims":BROKEN'));
  git(d, "commit", "-qam", "bad historical report");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-q", "work");
  git(d, "merge", "--no-edit", "main");
  writeFileSync(report, valid.replace('"base":"HEAD"', `"base":"${base}"`));
  const b = begin(env, d, "range", ["--base", base, "--report", report]);
  assert.equal(b.rc, 0, b.err);
  assert.doesNotMatch(b.out, /^REVIEW_BUCKET=merge$/m, "malformed historical metadata grants no new allowance");
});

test("a user-named contract item cannot stand in for the implicit contract's own check", () => {
  const d = repo("contract-id-product"),
    wb = repo("contract-id-source"),
    env = owner("contract-id-product");
  const report = join(wb, "projects/p/specs/001-x/report.md"),
    spec = join(dirname(report), "spec.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [], claims: [{ id: "REVIEW_CONTRACT", claim: "a constant", inapplicable: "a constant" }] })}\n<!-- /review-coverage -->\n`,
  );
  writeFileSync(spec, "contract one\n");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  begin(env, d, "range", ["--report", report]);
  const userCheck = { id: "REVIEW_CONTRACT", status: "checked", evidence: ["the declared constant only"] };
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("contract-id-original", [], [userCheck])).out,
    "APPROVED=1",
  );
  const tree = snap(d);
  writeFileSync(spec, "contract two\n");
  begin(env, d, "since", ["--since", tree, "--report", report]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("contract-id-unread", [], [userCheck]));
  assert.equal(f.out, "APPROVED=0", "checking a user item must not clear an unread implicit contract");
});

test("a failed companion snapshot keeps prior evidence but cannot approve changed source", () => {
  const d = repo("snapshot-failure-product"),
    wb = repo("snapshot-failure-source"),
    env = owner("snapshot-failure-product");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [{ id: "D1", repo: wb, path: ".agents/skills/demo/a.ts", why: "shared source" }], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  begin(env, d, "range", ["--report", report]);
  assert.equal(
    run(
      env,
      "finish",
      "--repo",
      d,
      "--rc",
      "0",
      "--result",
      result("snapshot-failure-approved", [], [{ id: "D1", status: "checked", evidence: ["shared source"] }]),
    ).out,
    "APPROVED=1",
  );
  const before = JSON.parse(stateBytes("snapshot-failure-product")).repos[d].receipt.companionTrees;
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  renameSync(join(wb, ".git"), join(wb, "unavailable-git"));
  const b = begin(env, d, "range", ["--report", report]);
  assert.equal(b.rc, 1);
  assert.match(b.err, /could not snapshot declared companion/);
  assert.deepEqual(JSON.parse(stateBytes("snapshot-failure-product")).repos[d].receipt.companionTrees, before);
  assert.equal(
    run(env, "check", "--owner", "snapshot-failure-product", d).rc,
    1,
    "stale prior evidence never approves the changed product",
  );
});

test("upstream changes to a covered behavior contract or declaration get integration allowance", () => {
  for (const changed of ["spec.md", "report.md"]) {
    const d = repo(`merge-${changed}`),
      env = owner(`merge-${changed}`);
    const report = join(d, "projects/p/specs/001-x/report.md");
    const contract = join(dirname(report), "spec.md");
    mkdirSync(dirname(report), { recursive: true });
    const declaration = { base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [], claims: [] };
    writeFileSync(report, `<!-- review-coverage:v1 -->\n${JSON.stringify(declaration)}\n<!-- /review-coverage -->\n`);
    writeFileSync(contract, "contract one\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "contract");
    const base = git(d, "rev-parse", "HEAD");
    git(d, "update-ref", "refs/remotes/origin/main", base);
    git(d, "checkout", "-qb", "work");
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
    git(d, "commit", "-qam", "own code");
    begin(env, d, "range", ["--base", base, "--report", report]);
    assert.equal(
      run(env, "finish", "--repo", d, "--rc", "0", "--result", result(`contract-${changed}`, [])).out,
      "APPROVED=1",
    );
    git(d, "checkout", "-q", "main");
    if (changed === "spec.md") writeFileSync(contract, "contract two\n");
    else {
      declaration.base = base;
      writeFileSync(report, `<!-- review-coverage:v1 -->\n${JSON.stringify(declaration)}\n<!-- /review-coverage -->\n`);
    }
    git(d, "commit", "-qam", "upstream behavior");
    git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(d, "checkout", "-q", "work");
    git(d, "merge", "--no-edit", "main");
    assert.match(
      begin(env, d, "range", ["--base", base, "--report", report]).out,
      /^REVIEW_BUCKET=merge$/m,
      changed + " is covered even though it is stored as a record",
    );
  }
});

test("an interrupted review retries from the last completed review, not its unfinished snapshot", () => {
  const d = repo("retry-scope");
  const env = owner("retry-scope");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  const original = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  begin(env, d, "since", ["--since", original]);
  const unfinished = snap(d);
  const retry = begin(env, d, "since", ["--since", unfinished]);
  assert.match(retry.out, new RegExp(`^REVIEW_SINCE=${original}$`, "m"));
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("retry-clean", [])).out, "APPROVED=1");
});

test("a coverage declaration beside another repo is reviewed explicitly in a focused follow-up", () => {
  const d = repo("declaration-product");
  const wb = repo("declaration-workbench");
  const env = owner("declaration-product");
  const report = join(wb, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const declaration = { base: "HEAD", scope: "s", entryPoints: [], dependencies: [], claims: [] };
  const put = () =>
    writeFileSync(report, `<!-- review-coverage:v1 -->\n${JSON.stringify(declaration)}\n<!-- /review-coverage -->\n`);
  put();
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  begin(env, d, "range", ["--report", report]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("declaration-initial", [])).out,
    "APPROVED=1",
  );
  const previous = snap(d);
  declaration.base = git(d, "rev-parse", "HEAD");
  put();
  const b = begin(env, d, "since", ["--since", previous, "--report", report]);
  const items = JSON.parse(readFileSync(b.out.match(/^ITEMS_FILE=(.*)$/m)![1], "utf8"));
  assert.ok(items.items.some((i: { id: string }) => i.id === "@review-declaration"));
  assert.ok(items.changedCoverage.some((p: string) => p.includes("coverage declaration")));
  const f = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result(
      "declaration-followup",
      [],
      [{ id: "@review-declaration", status: "checked", evidence: ["read the new base and scope"] }],
    ),
  );
  assert.equal(f.out, "APPROVED=1", f.err);
});

test("an upstream merge in a declared companion gets an integration review without rereading the product", () => {
  const product = repo("companion-product");
  const wb = repo("companion-source");
  const env = owner("companion-product");
  const initial = "export const a = 1;\n" + "// context\n".repeat(10) + "export const tail = 1;\n";
  writeFileSync(join(wb, ".agents/skills/demo/a.ts"), initial);
  git(wb, "commit", "-qam", "fixture");
  const base = git(wb, "rev-parse", "HEAD");
  git(wb, "update-ref", "refs/remotes/origin/main", base);
  git(wb, "checkout", "-qb", "work");
  const report = join(product, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [{ id: "D1", repo: wb, path: ".agents/skills/demo/a.ts", why: "shared contract" }], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  writeFileSync(join(product, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const tree = snap(product);
  const checked = [{ id: "D1", status: "checked", evidence: ["shared contract read"] }];
  writeFileSync(join(wb, ".agents/skills/demo/b.ts"), "export const b = 9;\n");
  assert.equal(piece(env, product, [".agents/skills/demo/a.ts"], [], { report, coverage: checked }).out, "APPROVED=1");
  const saved = JSON.parse(stateBytes("companion-product")).repos[product];
  assert.ok(saved.receipt.companionTrees?.[wb], "combined pieces must retain companion source provenance");
  git(wb, "checkout", "-q", "main");
  writeFileSync(join(wb, ".agents/skills/demo/a.ts"), initial.replace("tail = 1", "tail = 2"));
  git(wb, "commit", "-qam", "upstream contract");
  git(wb, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(wb, "checkout", "-q", "work");
  git(wb, "merge", "--no-edit", "--no-ff", "main");
  const b = begin(env, product, "range", ["--report", report]);
  assert.match(b.out, /^REVIEW_BUCKET=merge$/m);
  assert.match(b.out, new RegExp(`^REVIEW_SINCE=${tree}$`, "m"));
  assert.equal(
    run(env, "check", "--owner", "companion-product", product).rc,
    1,
    "an empty product delta never approves changed dependencies by itself",
  );
  assert.equal(
    run(env, "finish", "--repo", product, "--rc", "0", "--result", result("companion-integrated", [], checked)).out,
    "APPROVED=1",
  );
});

test("a trailer is a record, never proof of review", () => {
  const d = repo("trailer");
  const env = owner("trailer");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run(env, "status", "--repo", d).out, "fresh");
  const m = run(env, "mark", "implement-audit: round-1; zero findings; APPROVE", "--repo", d);
  assert.equal(m.rc, 1, "mark with no receipt is refused");
  assert.match(m.err, /a trailer is a record, not proof of review/);
  // The old per-session marker is ignored, whatever it says.
  const legacy = join("/tmp/implement-audit-done", `loop-${createHash("sha256").update("trailer").digest("hex")}`);
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, "implement-audit: round-1; zero findings; APPROVE\n");
  try {
    assert.equal(run(env, "status", "--repo", d).out, "fresh", "a legacy trailer marker grants nothing");
  } finally {
    rmSync(legacy, { force: true });
  }
  // Outside T3 Code with no CODE_REVIEW_LOOP_ID the owner is the close's
  // thread id, so a trailer there is refused just the same.
  const noLoop = run({ WORKBENCH_THREAD_ID: "trailer-thread" }, "mark", "implement-audit: x", "--repo", d);
  assert.equal(noLoop.rc, 1, noLoop.err);
  assert.match(noLoop.err, /a trailer is a record, not proof of review/);
});

test("a contract-only upstream merge beside a product is checked without a full product reread", () => {
  const d = repo("implicit-contract-product"),
    wb = repo("implicit-contract-source"),
    env = owner("implicit-contract-product");
  const report = join(wb, "projects/p/specs/001-x/report.md"),
    spec = join(dirname(report), "spec.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  writeFileSync(spec, "contract one\n");
  git(wb, "add", "-A");
  git(wb, "commit", "-qm", "contract");
  git(wb, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(wb, "checkout", "-qb", "work");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  begin(env, d, "range", ["--report", report]);
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("implicit-contract-initial", [])).out,
    "APPROVED=1",
  );
  git(wb, "checkout", "-q", "main");
  writeFileSync(spec, "contract two\n");
  git(wb, "commit", "-qam", "upstream contract");
  git(wb, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(wb, "checkout", "-q", "work");
  git(wb, "merge", "--no-edit", "--no-ff", "main");
  const b = begin(env, d, "range", ["--report", report]);
  assert.match(b.out, /^REVIEW_BUCKET=merge$/m);
  const items = JSON.parse(readFileSync(b.out.match(/^ITEMS_FILE=(.*)$/m)![1], "utf8"));
  assert.ok(
    items.items.some((i: { id: string }) => i.id === "@review-contract"),
    "the implicit behavior contract needs an explicit checked item",
  );
  const f = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result(
      "implicit-contract-final",
      [],
      [{ id: "@review-contract", status: "checked", evidence: ["read contract two"] }],
    ),
  );
  assert.equal(f.out, "APPROVED=1", f.err);
});

test("begin, finish, status and mark: one approved receipt for the reviewed content", () => {
  const d = repo("life");
  const env = owner("life");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const f = approve(env, d, ["[nit] tidy"]);
  assert.equal(f.out, "APPROVED=1", f.err);
  let s = run(env, "status", "--repo", d);
  assert.equal(s.out.split("\n")[0], "done");
  assert.match(s.out, /receipt range review by grok\/grok-4/);
  assert.match(s.out, /1 nit\(s\) held/);
  assert.equal(run(env, "mark", "implement-audit: round-1; 1 nit; APPROVE", "--repo", d).rc, 0);
  s = run(env, "status", "--repo", d);
  assert.equal(s.out, "done\nimplement-audit: round-1; 1 nit; APPROVE");
  // The same content again: reuse, no new attempt.
  const again = begin(env, d);
  assert.match(again.out, /RECEIPT=reuse/);
  // A realpath alias of the same worktree is the same receipt.
  const alias = join(TMP, "life-alias");
  symlinkSync(d, alias);
  assert.equal(run(env, "status", "--repo", alias).out.split("\n")[0], "done");
  // Another owner, and a same-named worktree elsewhere, borrow nothing.
  assert.equal(run(owner("someone-else"), "status", "--repo", d).out, "fresh");
  mkdirSync(join(TMP, "elsewhere"), { recursive: true });
  const twin = repo("elsewhere/life");
  writeFileSync(join(twin, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run(env, "status", "--repo", twin).out, "fresh");
  // The receipt lives in the owner's durable thread cache.
  assert.ok(existsSync(join(HOME, ".cache/workbench/threads/life/review.json")));
});

test("an edit after the review makes it stale; a different scope or writer is not reused", () => {
  const d = repo("stale");
  const env = owner("stale");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out, "fresh");
  assert.match(s.err, /changed since the review: \.agents\/skills\/demo\/a\.ts/);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run(env, "status", "--repo", d).out.split("\n")[0], "done", "restoring the bytes recovers");
  const otherScope = run(
    env,
    "begin",
    "--repo",
    d,
    "--tree",
    snap(d),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--scope",
    ".agents/skills/other",
  );
  assert.match(otherScope.out, /RECEIPT=review/, "another scope is reviewed, not borrowed");
  run(env, "finish", "--repo", d, "--rc", "1");
  const writer = begin({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex" }, d);
  assert.match(writer.out, /RECEIPT=review/, "another writer set is reviewed again");
});

test("a failed or interrupted attempt never inherits success, and blockers are never cleared by convergence", () => {
  const d = repo("fail");
  const env = owner("fail");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  assert.match(begin(env, d, "since", ["--since", snap(d)]).out, /RECEIPT=review/);
  const fail = run(env, "finish", "--repo", d, "--rc", "1");
  assert.equal(fail.out, "APPROVED=0");
  assert.match(run(env, "status", "--repo", d).err, /the last review attempt did not complete/);
  assert.match(run({ ...env, CODE_REVIEW_LOOP_ID: "fail" }, "check", "--owner", "fail", d).err, /did not complete/);

  // A round with a blocker, then a converged round: the blocker stands.
  const t = snap(d);
  begin(env, d, "since", ["--since", t]);
  const blocked = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result("blk", ["[must-fix] a.ts:1: x — y — z"]),
  );
  assert.equal(blocked.out, "APPROVED=0");
  begin(env, d, "since", ["--since", snap(d)]);
  const conv = run(env, "finish", "--repo", d, "--rc", "4");
  assert.equal(conv.out, "APPROVED=0", "an empty delta manufactures no approval");
  assert.match(conv.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0").rc, 1, "finish with no open attempt is refused");
});

// A reviewer that writes its findings as links,
// "[run.ts:266](/abs/…/run.ts:266): …", and the file it named was read as
// "[run.ts", which no delta ever holds — the blocker could never close.
test("a blocker written as a link stays open until a round shown it does not re-raise it", () => {
  const d = repo("link");
  const env = owner("link");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  begin(env, d, "since", ["--since", snap(d)]);
  const abs = join(d, ".agents/skills/demo/a.ts");
  const blocked = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result("lnk", [`[must-fix] [a.ts:1](${abs}:1): x — y — z`]),
  );
  assert.equal(blocked.out, "APPROVED=0");
  // A round not shown it leaves it open, whatever its delta.
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 1;\n");
  begin(env, d, "since", ["--since", t1]);
  const other = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("lnk2", []));
  assert.equal(other.out, "APPROVED=0");
  assert.match(other.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  // A round shown it that does not re-report it closes it.
  const t2 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 4;\n");
  begin(env, d, "since", ["--since", t2]);
  assert.equal(
    run(
      env,
      "finish",
      "--repo",
      d,
      "--rc",
      "0",
      "--result",
      shownResult("lnk3", [], [`[must-fix] [a.ts:1](${abs}:1): x — y — z`]),
    ).out,
    "APPROVED=1",
  );
});

test("a follow-up round approves only what its delta covered", () => {
  const d = repo("delta");
  const env = owner("delta");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  // The round reviews s1..now: b.ts. a.ts moved since the approved receipt but
  // before s1, so this round never read it.
  begin(env, d, "since", ["--since", s1]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("gap", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/);
  // From the snapshot of the approved content, both are in the delta.
  const d2 = repo("delta2");
  const env2 = owner("delta2");
  writeFileSync(join(d2, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const t0 = snap(d2);
  approve(env2, d2);
  writeFileSync(join(d2, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  writeFileSync(join(d2, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env2, d2, "since", ["--since", t0]);
  assert.equal(run(env2, "finish", "--repo", d2, "--rc", "0", "--result", result("nogap", [])).out, "APPROVED=1");
  // A follow-up with no earlier complete review approves nothing.
  const d3 = repo("delta3");
  const env3 = owner("delta3");
  writeFileSync(join(d3, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  begin(env3, d3, "since", ["--since", snap(d3)]);
  const lone = run(env3, "finish", "--repo", d3, "--rc", "0", "--result", result("lone", []));
  assert.equal(lone.out, "APPROVED=0");
  assert.match(lone.err, /no earlier complete review/);
});

test("the coverage declaration: exactly one strict block, frozen; later prose is free", () => {
  const d = repo("decl");
  const env = owner("decl");
  writeFileSync(join(d, "AGENTS.md"), "rules\n");
  git(d, "add", "AGENTS.md");
  git(d, "commit", "-qm", "rules");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const decl = {
    base: "HEAD",
    scope: ".agents/skills/demo",
    entryPoints: [{ id: "E1", path: ".agents/skills/demo/a.ts" }],
    dependencies: [{ id: "D1", path: "AGENTS.md", why: "instruction" }],
    claims: [
      {
        id: "C1",
        claim: "a is 2",
        negativeTest: { trigger: "a=1", expected: "fails", evidence: [".agents/skills/demo/b.ts"] },
      },
    ],
  };
  const put = (body: string, prose = ""): void =>
    writeFileSync(report, `# r\n${prose}\n<!-- review-coverage:v1 -->\n${body}\n<!-- /review-coverage -->\n`);
  const tryBegin = (): R => begin(env, d, "range", ["--report", report]);
  for (const [why, body] of [
    ["duplicate key", '{"base":"HEAD","base":"x"}'],
    ["not strict JSON", "{base: HEAD}"],
    ['unknown key "extra"', JSON.stringify({ ...decl, extra: 1 })],
    ["exactly one of negativeTest or inapplicable", JSON.stringify({ ...decl, claims: [{ id: "C1", claim: "x" }] })],
    ["used twice", JSON.stringify({ ...decl, dependencies: [{ id: "E1", path: "AGENTS.md", why: "x" }] })],
    ["repo-relative", JSON.stringify({ ...decl, entryPoints: [{ id: "E1", path: "/etc/passwd" }] })],
    ["does not exist", JSON.stringify({ ...decl, entryPoints: [{ id: "E1", path: ".agents/skills/demo/gone.ts" }] })],
    ["omits the applicable instruction AGENTS.md", JSON.stringify({ ...decl, dependencies: [] })],
  ] as const) {
    put(body);
    const b = tryBegin();
    assert.equal(b.rc, 1, `${why}: ${b.out}`);
    assert.ok(b.err.includes(why), `${why}: ${b.err}`);
  }
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify(decl)}\n<!-- /review-coverage -->\n<!-- review-coverage:v1 -->\n`,
  );
  assert.match(tryBegin().err, /exactly one/);

  put(JSON.stringify(decl));
  const b = tryBegin();
  assert.match(b.out, /RECEIPT=review/, b.err);
  const items = JSON.parse(readFileSync(b.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8")).items;
  assert.deepEqual(
    items.map((i: { id: string }) => i.id),
    ["E1", "D1", "C1"],
    "one item per entry point, dependency and claim",
  );
  const cov = ["E1", "D1", "C1"].map((id) => ({ id, status: "checked", evidence: ["read"] }));
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("decl", [], cov)).out, "APPROVED=1");
  put(JSON.stringify(decl), "a paragraph written after the review");
  assert.equal(run(env, "status", "--repo", d).out.split("\n")[0], "done", "prose outside the block is free");
  put(JSON.stringify({ ...decl, scope: ".agents/skills/demo " }));
  assert.match(run(env, "status", "--repo", d).err, /coverage declaration changed/);
  put(JSON.stringify(decl));
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 9;\n");
  assert.match(
    run(env, "status", "--repo", d).err,
    /changed since the review: \.agents\/skills\/demo\/b\.ts/,
    "the evidence is hashed",
  );
});

test("begin carries a /tmp counter's spend into the durable cache, once", () => {
  const d = repo("migrate");
  const id = `migrate-${process.pid}`;
  const env = { CODE_REVIEW_LOOP_ID: id };
  const key = `loop-${createHash("sha256").update(id).digest("hex")}-${createHash("sha256").update(d).digest("hex").slice(0, 12)}`;
  const legacy = `/tmp/code-review-rounds/${key}`;
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, "3\n");
  writeFileSync(`${legacy}.final`, "x\n");
  try {
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
    assert.match(begin(env, d).out, /RECEIPT=review/);
    const durable = join(HOME, ".cache/workbench/threads", id, "review-rounds", key);
    assert.equal(readFileSync(durable, "utf8"), "3\n", "the greatest observed spend");
    assert.ok(existsSync(`${durable}.final`), "and the spent final pass");
    assert.ok(
      existsSync(join(HOME, ".cache/workbench/threads", id, "review-rounds-qa", key)),
      "the qa bucket is initialised",
    );
  } finally {
    rmSync(legacy, { force: true });
    rmSync(`${legacy}.final`, { force: true });
  }
});

test("unreadable state is refused, never read as no review", () => {
  const d = repo("corrupt");
  const env = owner("corrupt");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  mkdirSync(join(HOME, ".cache/workbench/threads/corrupt"), { recursive: true });
  writeFileSync(join(HOME, ".cache/workbench/threads/corrupt/review.json"), "{nope");
  const b = begin(env, d);
  assert.equal(b.rc, 1);
  assert.match(b.err, /could not be read/);
  const c = run({}, "check", "--owner", "corrupt", d);
  assert.equal(c.rc, 1);
  assert.match(c.err, /could not be read/);
});

test("check: an ad-hoc change, a record-only change and a landed branch need no receipt", () => {
  const d = repo("adhoc");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(run({}, "check", "--owner", "nobody", d).rc, 0, "no implementation work: judged as before");
  const r = repo("records");
  const env = owner("records");
  writeFileSync(join(r, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, r);
  git(r, "checkout", "-q", "--", "skills");
  mkdirSync(join(r, "journal"), { recursive: true });
  writeFileSync(join(r, "journal/x.md"), "notes\n");
  assert.equal(run({}, "check", "--owner", "records", r).rc, 0, "only records differ from the base");
  // A spec folder's evidence and mockups are records, whatever their extension.
  mkdirSync(join(r, "projects/ops/p/specs/005-x/evidence"), { recursive: true });
  writeFileSync(join(r, "projects/ops/p/specs/005-x/mockup.html"), "<p>mock</p>\n");
  writeFileSync(join(r, "projects/ops/p/specs/005-x/evidence/page-1.png"), "png\n");
  writeFileSync(join(r, "projects/ops/p/specs/005-x/evidence/live.json"), "{}\n");
  assert.equal(run({}, "check", "--owner", "records", r).rc, 0, "spec evidence and mockups are records");
  // A project's source is not, whatever its extension: scripts, their fixtures, prompts.
  for (const src of [
    "projects/ops/p/scripts/x.ts",
    "projects/ops/p/scripts/fixtures/good/intune.md",
    "projects/ops/p/scripts/fixtures/inventory.json",
    "projects/ops/p/harness/prompts/judge.txt",
    "projects/ops/p/specs/005-x/tests/fixtures/in.json",
    "projects/ops/p/ninja/health.ps1",
    "projects/ops/p/rig/config.yaml",
  ]) {
    mkdirSync(dirname(join(r, src)), { recursive: true });
    writeFileSync(join(r, src), "x\n");
    assert.equal(run({}, "check", "--owner", "records", r).rc, 1, `${src} needs the review`);
    rmSync(join(r, src));
  }
  const req = repo("required");
  writeFileSync(join(req, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(req, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "<!-- review-coverage:v1 -->\n{}\n<!-- /review-coverage -->\n");
  const c = run({}, "check", "--owner", "required", req);
  assert.equal(c.rc, 1, "a report carrying a coverage block marks implementation work");
  assert.match(c.err, /no review receipt for implementation source \(\.agents\/skills\/demo\/a\.ts\)/);
  // A project fixture alone is implementation source too: no bypass.
  git(req, "checkout", "-q", "--", ".agents/skills");
  mkdirSync(join(req, "projects/ops/p/scripts/fixtures"), { recursive: true });
  writeFileSync(join(req, "projects/ops/p/scripts/fixtures/inventory.json"), "{}\n");
  const fx = run({}, "check", "--owner", "required", req);
  assert.equal(fx.rc, 1, "a fixture-only change in implementation work needs a receipt");
  assert.match(
    fx.err,
    /no review receipt for implementation source \(projects\/ops\/p\/scripts\/fixtures\/inventory\.json\)/,
  );
  rmSync(join(req, "projects/ops/p/scripts"), { recursive: true, force: true });
  mkdirSync(join(req, "projects/ops/p/ninja"), { recursive: true });
  writeFileSync(join(req, "projects/ops/p/ninja/health.ps1"), "Write-Output 1\n");
  const ps = run({}, "check", "--owner", "required", req);
  assert.equal(ps.rc, 1, "a project's PowerShell script in implementation work needs a receipt");
  assert.match(ps.err, /no review receipt for implementation source \(projects\/ops\/p\/ninja\/health\.ps1\)/);
});

// ── Round-1 audit findings ───────────────────────────────────────────────

test("a gap the last receipt left stays until a round's delta carries it", () => {
  const d = repo("gapcarry");
  const env = owner("gapcarry");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", s1]);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("gc1", [])).out, "APPROVED=0");
  const s2 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  begin(env, d, "since", ["--since", s2]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("gc2", []));
  assert.equal(f.out, "APPROVED=0", "a clean round that never read a.ts does not approve it");
  assert.match(f.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/);
});

// After a release the public trunk takes the released commits and the branch
// base moves past them, so every file they touched leaves the change. Such a
// file is not a gap on a later --since round, nor is a gap an earlier round
// left on it: otherwise every file a release touched reads "not reviewed" on
// every round after it. A file the change deletes is still part of it and is
// judged as before.
function trunkRepo(tag: string): { d: string; env: NodeJS.ProcessEnv; base0: string } {
  const d = repo(tag);
  const bare = join(TMP, `${tag}-origin.git`);
  git(TMP, "init", "-q", "--bare", "-b", "main", bare);
  git(d, "remote", "add", "origin", bare);
  git(d, "push", "-q", "origin", "main");
  git(d, "fetch", "-q", "origin");
  const base0 = git(d, "rev-parse", "HEAD");
  git(d, "checkout", "-q", "-b", "feat");
  return { d, env: owner(tag), base0 };
}
function commitAll(d: string, msg: string): void {
  git(d, "add", "-A");
  git(d, "commit", "-qm", msg);
}
/** The trunk takes the branch's commits, as origin/main does when a release is published. */
function release(d: string): void {
  git(d, "push", "-q", "origin", "HEAD:main");
  git(d, "fetch", "-q", "origin");
}
function approveRange(env: NodeJS.ProcessEnv, d: string, base0: string, name: string): void {
  const b = begin(env, d, "range", ["--base", base0]);
  assert.match(b.out, /RECEIPT=review/, b.err);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result(name, []));
  assert.equal(f.out, "APPROVED=1", f.err);
}

test("a file the trunk absorbed after a release is no longer part of the change, and no gap", () => {
  const { d, env, base0 } = trunkRepo("absorbed");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  commitAll(d, "released change");
  approveRange(env, d, base0, "abs0");
  release(d);
  const t = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", t]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("abs1", []));
  assert.doesNotMatch(f.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/, "the released a.ts is not a gap");
  assert.equal(f.out, "APPROVED=1", f.err);
});

test("a gap an earlier round left on a file the trunk then absorbed is not carried", () => {
  const { d, env, base0 } = trunkRepo("absorbedgap");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  commitAll(d, "first");
  approveRange(env, d, base0, "ag0");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  commitAll(d, "second");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", s1]);
  const g = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ag1", []));
  assert.match(g.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/, "before the release a.ts is a gap");
  commitAll(d, "b");
  release(d);
  const s2 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  begin(env, d, "since", ["--since", s2]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ag2", []));
  assert.doesNotMatch(f.err, /not reviewed: \.agents\/skills\/demo\/a\.ts/, "the carried gap left with the release");
  assert.equal(f.out, "APPROVED=1", f.err);
});

test("a file the change deletes is still judged: a gap unless the round's diff carries it", () => {
  const { d, env, base0 } = trunkRepo("deleted");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  commitAll(d, "change");
  approveRange(env, d, base0, "del0");
  rmSync(join(d, ".agents/skills/demo/b.ts"));
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  begin(env, d, "since", ["--since", s1]);
  const gap = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("del1", []));
  assert.equal(gap.out, "APPROVED=0", "a deletion the round never read is not approved");
  assert.match(gap.err, /not reviewed: \.agents\/skills\/demo\/b\.ts/);

  const { d: d2, env: env2, base0: b2 } = trunkRepo("deleted2");
  writeFileSync(join(d2, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  commitAll(d2, "change");
  approveRange(env2, d2, b2, "del2");
  const t = snap(d2);
  rmSync(join(d2, ".agents/skills/demo/b.ts"));
  begin(env2, d2, "since", ["--since", t]);
  const ok = run(env2, "finish", "--repo", d2, "--rc", "0", "--result", result("del3", []));
  assert.equal(ok.out, "APPROVED=1", `a deletion the round's diff carries is reviewed: ${ok.err}`);
});

// An open blocker closes when a follow-up round that was shown it completes
// without re-raising it, whatever file the fix touched: the prompt lists
// every open blocker and says one not re-reported is recorded as closed.
// "Re-raised" is the round returning the same finding line, runs of whitespace
// collapsed. Guessing the file a blocker named, and closing it only when that
// file changed, went wrong one new way per review: a later citation, a space or
// colon in the name, an extensionless file, a file neither changed nor covered.
const OPEN_MAKEFILE = "[must-fix] Makefile: incorrect call to .agents/skills/demo/b.ts:5 — fix — breaks";
const MAKEFILE_12 = "[must-fix] Makefile:12: wrong target — fix — breaks";
function openBlocker(tag: string, ...blockers: string[]): { d: string; env: NodeJS.ProcessEnv; t0: string } {
  const d = repo(tag);
  const env = owner(tag);
  const t0 = snap(d);
  assert.match(begin(env, d).out, /RECEIPT=review/);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result(`${tag}0`, blockers)).out, "APPROVED=0");
  return { d, env, t0 };
}
test("a blocker closes on a round that was shown it and did not re-raise it, whatever file changed", () => {
  const { d, env, t0 } = openBlocker("blkshown", OPEN_MAKEFILE, MAKEFILE_12);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b1 = begin(env, d, "since", ["--since", t0]);
  const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
  assert.deepEqual(items.openFindings, [OPEN_MAKEFILE, MAKEFILE_12], "the follow-up is shown the open findings");
  const f1 = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    shownResult("bs1", [], [OPEN_MAKEFILE, MAKEFILE_12]),
  );
  assert.equal(f1.out, "APPROVED=1", `a fix in b.ts closes a blocker naming Makefile: ${f1.err}`);
});
test("a blocker the shown round re-raises stays open, once, until a shown round leaves it out", () => {
  const { d, env, t0 } = openBlocker("blkraised", MAKEFILE_12);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", t0]);
  const again = MAKEFILE_12.replace(" — ", "  —  ");
  const f1 = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("br1", [again], [MAKEFILE_12]));
  assert.equal(f1.out, "APPROVED=0", "a re-raised blocker stays open");
  assert.match(
    f1.err,
    /\b1 must-fix\/should-fix finding\(s\) unresolved/,
    "re-raised with other spacing, it is one finding",
  );
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  begin(env, d, "since", ["--since", t1]);
  const f2 = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("br2", [], [again]));
  assert.equal(f2.out, "APPROVED=1", `the next shown round that leaves it out closes it: ${f2.err}`);
});
// More open blockers than the reviewer's eight-finding cap: the cap limits new
// findings, so a round re-reports every open one. One it leaves out closes,
// and only that one.
const NINE = Array.from(
  { length: 9 },
  (_, i) => `[must-fix] .agents/skills/demo/b.ts:${(i + 1) * 100}: open ${i + 1} — fix — breaks`,
);
const NEW_ONE = "[must-fix] .agents/skills/demo/a.ts:3: a new one — fix — breaks";
function nineOpen(tag: string): { d: string; env: NodeJS.ProcessEnv } {
  const { d, env, t0 } = openBlocker(tag, ...NINE);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b1 = begin(env, d, "since", ["--since", t0]);
  const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
  assert.deepEqual(items.openFindings, NINE, "the follow-up is shown all nine");
  return { d, env };
}
function openAfter(env: NodeJS.ProcessEnv, d: string): string[] {
  const t = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), `export const b = ${Math.random()};\n`);
  const b = begin(env, d, "since", ["--since", t]);
  return JSON.parse(readFileSync(b.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8")).openFindings;
}
test("nine open blockers all re-reported beside a new one are ten open, none closed", () => {
  const { d, env } = nineOpen("nine-all");
  const f = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    shownResult("nine-all1", [...NINE, NEW_ONE], NINE),
  );
  assert.equal(f.out, "APPROVED=0", f.err);
  assert.match(f.err, /\b10 must-fix\/should-fix finding\(s\) unresolved/, "all ten are recorded");
  assert.deepEqual(openAfter(env, d), [...NINE, NEW_ONE], "the next round is shown all ten");
});
test("nine open blockers with eight re-reported close exactly the ninth", () => {
  const { d, env } = nineOpen("nine-eight");
  const f = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    shownResult("nine-eight1", NINE.slice(0, 8), NINE),
  );
  assert.equal(f.out, "APPROVED=0", f.err);
  assert.match(f.err, /\b8 must-fix\/should-fix finding\(s\) unresolved/, "only the one left out closed");
  assert.deepEqual(openAfter(env, d), NINE.slice(0, 8), "the ninth, and only the ninth, is closed");
});
test("a blocker stays open through a round that was not shown it", () => {
  const { d, env, t0 } = openBlocker("blkunshown", OPEN_MAKEFILE);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", t0]);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "1").out, "APPROVED=0", "a failed call closes nothing");
  begin(env, d, "since", ["--since", t0]);
  const blind = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("bu1", []));
  assert.equal(blind.out, "APPROVED=0", "a result that lists nothing as shown closes nothing");
  assert.match(blind.err, /\b1 must-fix\/should-fix finding\(s\) unresolved/);
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  begin(env, d, "since", ["--since", t1]);
  const other = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    shownResult("bu2", [], ["[must-fix] x.ts:1: another"]),
  );
  assert.equal(other.out, "APPROVED=0", "a round shown other findings does not close this one");
  const bad = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("bu3", [], [OPEN_MAKEFILE]));
  assert.equal(bad.rc, 1, "finish with no open attempt is refused");
  begin(env, d, "since", ["--since", t1]);
  const malformed = join(TMP, "bu4.json");
  writeFileSync(malformed, JSON.stringify({ vendor: "grok/grok-4", findings: [], coverage: [], shown: OPEN_MAKEFILE }));
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", malformed).out,
    "APPROVED=0",
    "a shown list that is not a list of strings shows nothing",
  );
});
test("a full review replaces the open set", () => {
  const { d, env } = openBlocker("blkfull", OPEN_MAKEFILE);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  assert.equal(approve(env, d).out, "APPROVED=1", "a clean full review carries no earlier blocker");
});
// How a blocker names its file no longer decides whether it closes: each of
// these was once misread, and each now stays open until a round shown it
// leaves it out, and closes then, on a round that changed only b.ts.
for (const [tag, blocker] of [
  ["blkspace", "[must-fix] .agents/skills/demo/my file.ts:12: wrong — fix — breaks"],
  ["blkcolon", "[must-fix] .agents/skills/demo/x:y é.ts:12: wrong — fix — breaks"],
  ["blkcolonsp", "[must-fix] .agents/skills/demo/x: y é.ts:12: wrong — fix — breaks"],
  ["blkquoted", "[must-fix] `.agents/skills/demo/my file.ts:12`: quoted — fix — breaks"],
  ["blkunknown", "[must-fix] apps/site/Makefile:12: caller not updated — fix — breaks"],
  ["blkcites", "[must-fix] apps/site/Makefile:12: calls .agents/skills/demo/b.ts:5 — fix — breaks"],
  ["blkleadnoline", "[should-fix] .agents/skills/demo/a.ts: incorrect call to .agents/skills/demo/b.ts:5 — fix — breaks"],
  ["blkprose", "[must-fix] Note: the summary is wrong — fix — breaks"],
] as const) {
  test(`'${blocker.slice(0, 48)}…' stays open unshown and closes shown, on a round over b.ts`, () => {
    const { d, env, t0 } = openBlocker(tag, blocker);
    writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
    begin(env, d, "since", ["--since", t0]);
    const f1 = run(env, "finish", "--repo", d, "--rc", "0", "--result", result(`${tag}1`, []));
    assert.equal(f1.out, "APPROVED=0", "not shown, it stays open");
    const t1 = snap(d);
    writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
    begin(env, d, "since", ["--since", t1]);
    const f2 = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult(`${tag}2`, [], [blocker]));
    assert.equal(f2.out, "APPROVED=1", `shown and left out, it closes: ${f2.err}`);
  });
}

test("a completed review of the same bytes supersedes an older approval; writer order is not a new writer", () => {
  const d = repo("supersede");
  const env = { ...owner("supersede"), POLICY_CHAIN_AUTHOR_VENDORS: "claude,codex" };
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  approve(env, d);
  assert.match(begin({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex, claude" }, d).out, /RECEIPT=reuse/);
  assert.match(begin({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "grok" }, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "0", "--result", result("sup", ["[should-fix] .agents/skills/demo/a.ts:1: x"]));
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out, "fresh", "the latest judgment of these bytes is the blocking one");
  assert.match(s.err, /1 must-fix\/should-fix/);
});

test("a full review's coverage is the range it actually read, base..head plus uncommitted", () => {
  const d = repo("headrange");
  const env = owner("headrange");
  const base = git(d, "rev-parse", "HEAD");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  git(d, "commit", "-qam", "a");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  git(d, "commit", "-qam", "b");
  const b = run(
    env,
    "begin",
    "--repo",
    d,
    "--tree",
    snap(d),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    base,
    "--head",
    "HEAD~1",
    "--scope",
    ".agents/skills/demo",
  );
  assert.match(b.out, /RECEIPT=review/);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("hr", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /not reviewed: \.agents\/skills\/demo\/b\.ts/);
});

test("every AGENTS.md above a changed path applies, the root included", () => {
  const d = repo("ancestors");
  const env = owner("ancestors");
  writeFileSync(join(d, "AGENTS.md"), "root rules\n");
  writeFileSync(join(d, ".agents/skills/AGENTS.md"), "skill rules\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "rules");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const decl = (deps: { id: string; path: string; why: string }[]) =>
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: deps, claims: [] })}\n<!-- /review-coverage -->\n`;
  writeFileSync(report, decl([{ id: "D1", path: ".agents/skills/AGENTS.md", why: "nearest" }]));
  const b = begin(env, d, "range", ["--report", report]);
  assert.equal(b.rc, 1);
  assert.match(b.err, /omits the applicable instruction AGENTS\.md/);
  writeFileSync(
    report,
    decl([
      { id: "D1", path: ".agents/skills/AGENTS.md", why: "nearest" },
      { id: "D2", path: "AGENTS.md", why: "root" },
    ]),
  );
  assert.match(begin(env, d, "range", ["--report", report]).out, /RECEIPT=review/);
});

// ── Round-2 audit findings ───────────────────────────────────────────────

test("a full review that ended before HEAD does not cover a file a later commit changed again", () => {
  const d = repo("headsame");
  const env = owner("headsame");
  const base = git(d, "rev-parse", "HEAD");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  git(d, "commit", "-qam", "a once");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  git(d, "commit", "-qam", "a twice");
  run(
    env,
    "begin",
    "--repo",
    d,
    "--tree",
    snap(d),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    base,
    "--head",
    "HEAD~1",
    "--scope",
    ".agents/skills/demo",
  );
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("hs", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /not reviewed: commits after the --head/);
});

test("a newly declared unchanged dependency is covered by the reviewer's check, not by the diff", () => {
  const d = repo("newdep");
  const env = owner("newdep");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  const decl = (deps: unknown[]) =>
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: deps, claims: [] })}\n<!-- /review-coverage -->\n`;
  writeFileSync(report, decl([]));
  const t0 = snap(d);
  begin(env, d, "range", ["--report", report]);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("nd0", [])).out, "APPROVED=1");
  writeFileSync(report, decl([{ id: "D1", path: ".agents/skills/demo/b.ts", why: "a reads it" }]));
  begin(env, d, "since", ["--since", t0, "--report", report]);
  const checked = run(
    env,
    "finish",
    "--repo",
    d,
    "--rc",
    "0",
    "--result",
    result("nd1", [], [{ id: "D1", status: "checked", evidence: ["b.ts:1"] }]),
  );
  assert.equal(checked.out, "APPROVED=1", checked.err);
  // The same, reported unchecked: not reviewed.
  const d2 = repo("newdep2");
  const env2 = owner("newdep2");
  writeFileSync(join(d2, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report2 = join(d2, "projects/p/specs/001-x/report.md");
  mkdirSync(dirname(report2), { recursive: true });
  writeFileSync(report2, decl([]));
  const u0 = snap(d2);
  begin(env2, d2, "range", ["--report", report2]);
  run(env2, "finish", "--repo", d2, "--rc", "0", "--result", result("nd2", []));
  writeFileSync(report2, decl([{ id: "D1", path: ".agents/skills/demo/b.ts", why: "a reads it", required: false }]));
  begin(env2, d2, "since", ["--since", u0, "--report", report2]);
  const un = run(
    env2,
    "finish",
    "--repo",
    d2,
    "--rc",
    "0",
    "--result",
    result("nd3", [], [{ id: "D1", status: "unchecked", evidence: ["no time"] }]),
  );
  assert.equal(un.out, "APPROVED=0");
  assert.match(un.err, /not reviewed: \.agents\/skills\/demo\/b\.ts/);
});

test("an inherited gap on the behavior contract clears when a round's diff carries the spec", () => {
  const d = repo("contract");
  const env = owner("contract");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(d, "projects/p/specs/001-x/report.md");
  const spec = join(d, "projects/p/specs/001-x/spec.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(spec, "contract one\n");
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  begin(env, d, "range", ["--report", report]);
  run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ct0", []));
  writeFileSync(spec, "contract two\n");
  const s1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", s1, "--report", report]);
  const gap = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ct1", []));
  assert.equal(gap.out, "APPROVED=0");
  assert.match(gap.err, /not reviewed: contract:/);
  const s2 = snap(d);
  writeFileSync(spec, "contract three\n");
  begin(env, d, "since", ["--since", s2, "--report", report]);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("ct2", []));
  assert.equal(f.out, "APPROVED=1", f.err);
});

// ── Round-3 audit finding ────────────────────────────────────────────────

test("a spec beside a product is reviewed through the declared item that names it", () => {
  const prod = repo("product");
  const wb = repo("product-wb");
  const env = owner("product");
  writeFileSync(join(prod, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(wb, "projects/p/specs/001-x/report.md");
  const spec = join(wb, "projects/p/specs/001-x/spec.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(spec, "contract one\n");
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: [{ id: "D1", path: "projects/p/specs/001-x/spec.md", repo: wb, why: "the contract" }], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  const cov = [{ id: "D1", status: "checked", evidence: ["spec.md"] }];
  begin(env, prod, "range", ["--report", report]);
  assert.equal(run(env, "finish", "--repo", prod, "--rc", "0", "--result", result("pr0", [], cov)).out, "APPROVED=1");
  writeFileSync(spec, "contract two\n");
  const t = snap(prod);
  writeFileSync(join(prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, prod, "since", ["--since", t, "--report", report]);
  const f = run(env, "finish", "--repo", prod, "--rc", "0", "--result", result("pr1", [], cov));
  assert.equal(f.out, "APPROVED=1", f.err);
});

// A recorded run is a record: rerunning it rewrites its bytes, and that alone
// no longer sends the claim back to the reviewer. It must still exist.
test("a claim beside a product names its recorded run in the other repo, bound by presence", () => {
  const prod = repo("claim-evidence-product");
  const wb = repo("claim-evidence-wb");
  const env = owner("claim-evidence-product");
  writeFileSync(join(prod, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(wb, "projects/p/specs/001-x/report-product.md");
  const log = "projects/p/specs/001-x/evidence/c1.log";
  mkdirSync(join(wb, dirname(log)), { recursive: true });
  writeFileSync(join(wb, log), "red, then green\n");
  const block = (repoField: string): string =>
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: [], claims: [{ id: "C1", claim: "a is 2", negativeTest: { trigger: "a set to 1", expected: "the test fails", evidence: [log], repo: repoField } }] })}\n<!-- /review-coverage -->\n`;
  writeFileSync(report, block("claim-evidence-wb"));
  const bad = begin(env, prod, "range", ["--report", report]);
  assert.match(bad.err, /claim C1: repo must be an absolute path/, "a relative repo is refused by name");
  writeFileSync(report, block(wb));
  const cov = [{ id: "C1", status: "checked", evidence: ["c1.log shows the red run, then green"] }];
  const b = begin(env, prod, "range", ["--report", report]);
  assert.equal(b.rc, 0, b.err);
  assert.doesNotMatch(b.err, /does not exist|unknown key/, "the log is read in the repo the claim names");
  assert.equal(run(env, "finish", "--repo", prod, "--rc", "0", "--result", result("ce0", [], cov)).out, "APPROVED=1");
  writeFileSync(join(wb, log), "rewritten after the review\n");
  const t = snap(prod);
  writeFileSync(join(prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, prod, "since", ["--since", t, "--report", report]);
  const f = run(env, "finish", "--repo", prod, "--rc", "0", "--result", result("ce1", [], []));
  assert.equal(f.out, "APPROVED=1", `a rerun recorded run keeps the claim checked: ${f.err}`);
  assert.doesNotMatch(f.err, /c1\.log/, "the rerun log is not named as unreviewed");
});

// ── A replaced companion evidence file leaves the change ──────────
//
// A two-repo build that replaces its red-run logs in the companion repo, and each deleted log stayed a "not
// reviewed" gap on every later receipt. A companion path the declaration no
// longer names and that no longer exists has left the change; one still on
// disk, or still declared, is judged as before.

interface Companion {
  prod: string;
  wb: string;
  env: NodeJS.ProcessEnv;
  report: string;
  c1: string;
  c2: string;
  declare: (evidence: string) => void;
  checkC1: { id: string; status: string; evidence: string[] }[];
}
/** A product build approved with claim C1's red-run log c1.log kept in the companion repo. */
function companion(name: string): Companion {
  const prod = repo(`${name}-product`);
  const wb = repo(`${name}-wb`);
  const env = owner(name);
  writeFileSync(join(prod, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const report = join(wb, "projects/p/specs/001-x/report-product.md");
  const c1 = "projects/p/specs/001-x/evidence/c1.log";
  const c2 = "projects/p/specs/001-x/evidence/c2.log";
  mkdirSync(join(wb, dirname(c1)), { recursive: true });
  writeFileSync(join(wb, c1), "red, then green\n");
  const declare = (evidence: string): void =>
    writeFileSync(
      report,
      `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: "s", entryPoints: [], dependencies: [], claims: [{ id: "C1", claim: "a is 2", negativeTest: { trigger: "a set to 1", expected: "the test fails", evidence: [evidence], repo: wb } }] })}\n<!-- /review-coverage -->\n`,
    );
  declare(c1);
  const checkC1 = [{ id: "C1", status: "checked", evidence: ["the log shows the red run, then green"] }];
  const b = begin(env, prod, "range", ["--report", report]);
  assert.equal(b.rc, 0, b.err);
  assert.equal(
    run(env, "finish", "--repo", prod, "--rc", "0", "--result", result(`${name}-0`, [], checkC1)).out,
    "APPROVED=1",
  );
  return { prod, wb, env, report, c1, c2, declare, checkC1 };
}
/** Delete c1.log, record c2.log and point the claim at it, as a redesign does. */
function replaceEvidence(c: Companion): void {
  rmSync(join(c.wb, c.c1));
  writeFileSync(join(c.wb, c.c2), "red, then green, after the redesign\n");
  c.declare(c.c2);
}
const withDeclaration = (c: Companion) => [
  ...c.checkC1,
  { id: "@review-declaration", status: "checked", evidence: ["C1 now names c2.log"] },
];

test("a replaced companion evidence file leaves the change", () => {
  const c = companion("replaced-evidence");
  const t = snap(c.prod);
  replaceEvidence(c);
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b = begin(c.env, c.prod, "since", ["--since", t, "--report", c.report]);
  assert.equal(b.rc, 0, b.err);
  const f = run(c.env, "finish", "--repo", c.prod, "--rc", "0", "--result", result("re1", [], withDeclaration(c)));
  assert.equal(f.out, "APPROVED=1", f.err);
  assert.doesNotMatch(f.out + f.err, /c1\.log/, "the deleted log is not named as unreviewed");
});

test("a rerun companion log leaves no gap, and a replaced one leaves the change", () => {
  const c = companion("carried-evidence");
  writeFileSync(join(c.wb, c.c1), "rewritten after the review\n");
  const t1 = snap(c.prod);
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(c.env, c.prod, "since", ["--since", t1, "--report", c.report]);
  const rerun = run(c.env, "finish", "--repo", c.prod, "--rc", "0", "--result", result("ca1", [], []));
  assert.equal(rerun.out, "APPROVED=1", rerun.err);
  assert.doesNotMatch(rerun.err, /not reviewed/, "a rerun log is no gap");
  const t2 = snap(c.prod);
  replaceEvidence(c);
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  begin(c.env, c.prod, "since", ["--since", t2, "--report", c.report]);
  const f = run(c.env, "finish", "--repo", c.prod, "--rc", "0", "--result", result("ca2", [], withDeclaration(c)));
  assert.equal(f.out, "APPROVED=1", f.err);
  assert.doesNotMatch(f.out + f.err, /c1\.log/, "the carried gap on the deleted log is dropped");
});

test("a receipt saved with a log's bytes before 2026-11-20 reads as bound by presence", () => {
  const c = companion("legacy-evidence");
  const f = join(HOME, ".cache/workbench/threads/legacy-evidence/review.json");
  const st = JSON.parse(readFileSync(f, "utf8")) as {
    repos: Record<string, Record<string, { covered?: Record<string, string> } | undefined>>;
  };
  let saved = 0;
  for (const rs of Object.values(st.repos))
    for (const r of [rs.receipt, rs.last, rs.approvedReceipt])
      for (const k of Object.keys(r?.covered ?? {}))
        if (k.endsWith("c1.log") && r?.covered) {
          r.covered[k] = "legacy-bytes";
          saved++;
        }
  assert.ok(saved > 0, "the saved receipt names the log");
  writeFileSync(f, JSON.stringify(st));
  writeFileSync(join(c.wb, c.c1), "rewritten after the review\n");
  const ck = run(c.env, "check", "--owner", "legacy-evidence", c.prod);
  assert.equal(ck.rc, 0, `a rerun log does not stale an older receipt: ${ck.err}`);
});

test("a companion file dropped from the declaration but still on disk stays a gap", () => {
  const c = companion("dropped-evidence");
  const t = snap(c.prod);
  writeFileSync(join(c.wb, c.c2), "red, then green, after the redesign\n");
  c.declare(c.c2);
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b = begin(c.env, c.prod, "since", ["--since", t, "--report", c.report]);
  assert.equal(b.rc, 0, b.err);
  const f = run(c.env, "finish", "--repo", c.prod, "--rc", "0", "--result", result("de1", [], withDeclaration(c)));
  assert.equal(f.out, "APPROVED=0", "evidence undeclared while still on disk is not let go unreviewed");
  assert.match(f.err, /not reviewed: .*dropped-evidence-wb::projects\/p\/specs\/001-x\/evidence\/c1\.log/);
});

test("a companion path left as a dangling symlink once undeclared is still there, and stays a gap", () => {
  const c = companion("dangling-evidence");
  const t = snap(c.prod);
  replaceEvidence(c);
  symlinkSync("no-such-run.log", join(c.wb, c.c1));
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b = begin(c.env, c.prod, "since", ["--since", t, "--report", c.report]);
  assert.equal(b.rc, 0, b.err);
  const f = run(c.env, "finish", "--repo", c.prod, "--rc", "0", "--result", result("dl1", [], withDeclaration(c)));
  assert.equal(f.out, "APPROVED=0", "a path that still holds a symlink has not left the change");
  assert.match(f.err, /not reviewed: .*dangling-evidence-wb::projects\/p\/specs\/001-x\/evidence\/c1\.log/);
});

test("a declared companion file that is deleted is reported missing", () => {
  const c = companion("deleted-declared-evidence");
  rmSync(join(c.wb, c.c1));
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b = begin(c.env, c.prod, "since", ["--since", snap(c.prod), "--report", c.report]);
  assert.equal(b.rc, 1, "begin refuses before any review call");
  assert.match(b.err, /declared path .*c1\.log does not exist/);
  assert.doesNotMatch(b.out, /RECEIPT=review/, "no review is opened over the missing log");
});

test("check: a project's own code is implementation source a receipt must cover", () => {
  const p = repo("project-code");
  const code = join(p, "projects/web/demo/scripts/main.ts");
  mkdirSync(dirname(code), { recursive: true });
  writeFileSync(code, "export const main = 1;\n");
  const report = join(p, "projects/web/demo/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "<!-- review-coverage:v1 -->\n{}\n<!-- /review-coverage -->\n");
  const c = run({}, "check", "--owner", "project-code", p);
  assert.equal(c.rc, 1, "project code with a coverage report and no receipt is refused");
  assert.match(c.err, /no review receipt for implementation source \(projects\/web\/demo\/scripts\/main\.ts\)/);
});

// ── Contextium: the owner on any harness, and the fresh-context fallback ──

test("outside T3 with no CODE_REVIEW_LOOP_ID the owner is the close's thread id", () => {
  const d = repo("thread-owner");
  const env = { WORKBENCH_THREAD_ID: "close-thread-1" };
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const b = begin(env, d);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /RECEIPT=review/);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("thread-owner", []));
  assert.equal(f.out, "APPROVED=1", f.err);
  assert.ok(existsSync(join(HOME, ".cache/workbench/threads/close-thread-1/review.json")));
  const c = run({}, "check", "--owner", "close-thread-1", d);
  assert.equal(c.rc, 0, c.err);
  assert.match(c.out, /receipt from grok\/grok-4 covers this content/);
});

test("no independent vendor: pending, then the fresh-context fallback is recorded NOT independent", () => {
  const d = repo("fallback");
  const env = owner("fallback");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const reply = (name: string, text: string): string => {
    const f = join(TMP, `${name}.txt`);
    writeFileSync(f, text);
    return f;
  };
  // Without a pending attempt a fallback is refused: it never stands in for a
  // vendor that answered.
  approve(env, d, ["[must-fix] .agents/skills/demo/a.ts:1: wrong — fix — breaks"]);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  let b = begin(env, d);
  assert.match(b.out, /RECEIPT=review/);
  let f = run(env, "finish", "--repo", d, "--fallback", reply("early", "NO_FINDINGS\n"));
  assert.equal(f.rc, 1, "a fallback for an attempt the chain did not leave pending");
  assert.match(f.err, /not pending a fallback/);
  // Exit 3 leaves the attempt open and pending.
  f = run(env, "finish", "--repo", d, "--rc", "3");
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /pending the fresh-context fallback/);
  assert.equal(run(env, "status", "--repo", d).out, "fresh", "a pending attempt is not a receipt");
  // A reply that says nothing is a review that did not happen.
  f = run(env, "finish", "--repo", d, "--fallback", reply("prose", "looked fine to me\n"));
  assert.equal(f.rc, 1);
  assert.match(f.err, /did NOT happen/);
  // The reviewer's own format: fix-now blocks.
  f = run(
    env,
    "finish",
    "--repo",
    d,
    "--fallback",
    reply("verdict", "1. **bad**: `a.ts:1` — wrong — verdict: **fix-now** — violated rule: none — fix it\n"),
  );
  assert.equal(f.out, "APPROVED=0", f.err);
  assert.match(f.err, /must-fix\/should-fix finding\(s\) unresolved/);
  // A clean fallback of the next attempt approves, and every report says NOT independent.
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 4;\n");
  b = begin(env, d);
  assert.match(b.out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  f = run(env, "finish", "--repo", d, "--fallback", reply("clean", "Zero findings. Work is consistent.\n"));
  assert.equal(f.out, "APPROVED=1", f.err);
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out.split("\n")[0], "done");
  assert.match(s.out, /claude-fallback: fresh context, NOT independent/);
  const c = run({}, "check", "--owner", "fallback", d);
  assert.equal(c.rc, 0, c.err);
  assert.match(c.out, /NOT independent/);
  assert.match(begin(env, d).out, /NOTE: .*NOT independent/, "reuse says so too");
});

// A fallback's blocker closes like any other: when a round shown it leaves it
// out, never because some file changed. And a round built on a
// fallback-reviewed base is not independent either: the base it inherits was
// read by the fresh-context reviewer.
test("a fallback's blocker stays open until a round shown it leaves it out, and a follow-up keeps NOT independent", () => {
  const d = repo("fallback-file");
  const env = owner("fallback-file");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const t0 = snap(d);
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const reply = join(TMP, "fallback-file.txt");
  writeFileSync(
    reply,
    "1. **bad**: `.agents/skills/demo/a.ts:1` — wrong — verdict: **fix-now** — failure: breaks — fix it\n",
  );
  let f = run(env, "finish", "--repo", d, "--fallback", reply);
  assert.equal(f.out, "APPROVED=0", f.err);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  begin(env, d, "since", ["--since", t0]);
  f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("fallback-file-1", []));
  assert.equal(f.out, "APPROVED=0", "a round not shown the fallback's blocker does not clear it");
  assert.match(f.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const b2 = begin(env, d, "since", ["--since", t1]);
  const open = JSON.parse(readFileSync(b2.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8")).openFindings;
  f = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("fallback-file-2", [], open));
  assert.equal(f.out, "APPROVED=1", f.err);
  const st = run(env, "status", "--repo", d);
  assert.match(st.out, /NOT independent/, "a follow-up on a fallback-reviewed base is still NOT independent");
  assert.match(run({}, "check", "--owner", "fallback-file", d).out, /NOT independent/);
});

// The fresh-context fallback of a follow-up round is handed the open
// findings (the items file) like a vendor: a clean reply closes them, and one
// it re-reports stays open, as a vendor's "open" verdict keeps it.
function pendingFollowUp(tag: string, blocker: string): { d: string; env: NodeJS.ProcessEnv } {
  const d = repo(tag);
  const env = owner(tag);
  const t0 = snap(d);
  assert.match(begin(env, d).out, /RECEIPT=review/);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result(`${tag}0`, [blocker])).out, "APPROVED=0");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  assert.match(begin(env, d, "since", ["--since", t0]).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  return { d, env };
}
test("a follow-up's fallback closes an open blocker it leaves out", () => {
  const { d, env } = pendingFollowUp("fb-shown", "[must-fix] Makefile:12: wrong target — fix — breaks");
  const reply = join(TMP, "fb-shown.txt");
  writeFileSync(reply, "NO_FINDINGS\n");
  const f = run(env, "finish", "--repo", d, "--fallback", reply);
  assert.equal(f.out, "APPROVED=1", `a clean fallback shown the blocker closes it: ${f.err}`);
});
// A fallback that re-reports a blocker it was shown keeps it open, and one
// judged open twice in a row prints STILL OPEN: the approach, not the patch,
// is wrong. A fallback that leaves it out closes it (above).
test("a follow-up's fallback that re-reports an open blocker keeps it open, and twice prints STILL OPEN", () => {
  const open = "[must-fix] .agents/skills/demo/b.ts:10: the save races — fix — breaks";
  const { d, env } = pendingFollowUp("fb-still", open);
  const reply = join(TMP, "fb-still.txt");
  writeFileSync(reply, `${open}\n`);
  const f = run(env, "finish", "--repo", d, "--fallback", reply);
  assert.equal(f.out, "APPROVED=0", f.err);
  assert.doesNotMatch(`${f.out}\n${f.err}`, /STILL OPEN/, "once open is not yet a pattern");
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 3;\n");
  assert.match(begin(env, d, "since", ["--since", t1]).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const g = run(env, "finish", "--repo", d, "--fallback", reply);
  assert.equal(g.out.split("\n").at(-1), "APPROVED=0", g.err);
  assert.match(g.out, /^STILL OPEN: F[0-9a-f]{6} .*the save races/m);
});

// A fallback finding is rewritten location first, the shape a vendor's
// triage line has, so the REPEAT SPOT detector reads where it points. The
// location is the one after the title, even when the title names another file
// (backticked, or with a line); where it points decides no closure.
for (const [tag, title] of [
  ["fallback-title", "**`.agents/skills/demo/b.ts` callers break**"],
  ["fallback-title-loc", "**`.agents/skills/demo/b.ts:5` callers break**"],
] as const) {
  test(`a fallback finding whose title is ${title} is bound to its location`, () => {
    const d = repo(tag);
    const env = owner(tag);
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
    const t0 = snap(d);
    assert.match(begin(env, d).out, /RECEIPT=review/);
    run(env, "finish", "--repo", d, "--rc", "3");
    const reply = join(TMP, `${tag}.txt`);
    writeFileSync(
      reply,
      `1. ${title}: \`.agents/skills/demo/a.ts:12\` — wrong — verdict: **fix-now** — failure: breaks — fix it\n`,
    );
    assert.equal(run(env, "finish", "--repo", d, "--fallback", reply).out, "APPROVED=0");
    writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
    const b1 = begin(env, d, "since", ["--since", t0]);
    const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
    assert.match(
      items.openFindings[0] ?? "",
      /^\[must-fix\] \.agents\/skills\/demo\/a\.ts:12: /,
      "the location leads the line",
    );
    const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult(`${tag}-1`, [], items.openFindings));
    assert.equal(f.out, "APPROVED=1", `a round over b.ts that was shown it and left it out closes it: ${f.err}`);
  });
}

// The location after the title leads the rewritten line, backticked or bare,
// even in an undeclared, unchanged file whose title cites a changed one.
for (const [tag, loc] of [
  ["fallback-lead", "`.agents/skills/demo/a.ts:12`"],
  ["fallback-lead-bare", ".agents/skills/demo/a.ts:12"],
] as const) {
  test(`a fallback finding located at ${loc} in an undeclared file leads with it, not its title's b.ts:5`, () => {
    const d = repo(tag);
    const env = owner(tag);
    const t0 = snap(d);
    assert.match(begin(env, d).out, /RECEIPT=review/);
    run(env, "finish", "--repo", d, "--rc", "3");
    const reply = join(TMP, `${tag}.txt`);
    writeFileSync(
      reply,
      `1. **\`.agents/skills/demo/b.ts:5\` callers break**: ${loc} — wrong — verdict: **fix-now** — failure: breaks — fix it\n`,
    );
    assert.equal(run(env, "finish", "--repo", d, "--fallback", reply).out, "APPROVED=0");
    writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
    const b1 = begin(env, d, "since", ["--since", t0]);
    const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
    assert.match(
      items.openFindings[0] ?? "",
      /^\[must-fix\] \.agents\/skills\/demo\/a\.ts:12: /,
      "the location after the title leads the line",
    );
    const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult(`${tag}-1`, [], items.openFindings));
    assert.equal(f.out, "APPROVED=1", `a round over b.ts that was shown it and left it out closes it: ${f.err}`);
  });
}

// After the title, any bare `<name>:<line>` is the location, extensionless
// included.
test("a fallback finding located at a bare extensionless Makefile:12 leads with it, not its title's b.ts:5", () => {
  const d = repo("fallback-lead-noext");
  const env = owner("fallback-lead-noext");
  const t0 = snap(d);
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const reply = join(TMP, "fallback-lead-noext.txt");
  writeFileSync(reply, "1. **`.agents/skills/demo/b.ts:5` callers break**: Makefile:12 — wrong — verdict: **fix-now**\n");
  assert.equal(run(env, "finish", "--repo", d, "--fallback", reply).out, "APPROVED=0");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b1 = begin(env, d, "since", ["--since", t0]);
  const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
  assert.match(items.openFindings[0] ?? "", /^\[must-fix\] Makefile:12: /, "the extensionless location leads the line");
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("fallback-lead-noext-1", [], items.openFindings));
  assert.equal(f.out, "APPROVED=1", `a round over b.ts that was shown it and left it out closes it: ${f.err}`);
});

// The location is the first path-like token after the title, with or without
// a line, not a later citation in the description: one rule, leadingPath.
test("a fallback finding located at a.ts with no line leads with it, not a later `b.ts:5`", () => {
  const d = repo("fallback-lead-noline");
  const env = owner("fallback-lead-noline");
  const t0 = snap(d);
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const reply = join(TMP, "fallback-lead-noline.txt");
  writeFileSync(
    reply,
    "1. **Bad call**: .agents/skills/demo/a.ts — calls `.agents/skills/demo/b.ts:5` with the old shape — verdict: **fix-now**\n",
  );
  assert.equal(run(env, "finish", "--repo", d, "--fallback", reply).out, "APPROVED=0");
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const b1 = begin(env, d, "since", ["--since", t0]);
  const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
  assert.match(items.openFindings[0] ?? "", /^\[must-fix\] \.agents\/skills\/demo\/a\.ts: \*\*Bad call\*\* — calls /);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("fallback-lead-noline-1", [], items.openFindings));
  assert.equal(f.out, "APPROVED=1", `a round over b.ts that was shown it and left it out closes it: ${f.err}`);
});

// A bare `<name>:<line>` counts only in the location, right after the title
// up to the first ` — `, never in the description (an endpoint such as
// localhost:3000).
test("a fallback finding whose description names localhost:3000 leads with its backticked a.ts", () => {
  const d = repo("fallback-desc-endpoint");
  const env = owner("fallback-desc-endpoint");
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const reply = join(TMP, "fallback-desc-endpoint.txt");
  writeFileSync(
    reply,
    "1. **Wrong endpoint**: `a.ts` — fetches localhost:3000 instead of the configured port — verdict: **fix-now**\n",
  );
  assert.equal(run(env, "finish", "--repo", d, "--fallback", reply).out, "APPROVED=0");
  const b1 = begin(env, d, "since", ["--since", snap(d)]);
  const items = JSON.parse(readFileSync(b1.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8"));
  assert.match(items.openFindings[0] ?? "", /^\[must-fix\] a\.ts: \*\*Wrong endpoint\*\* — fetches localhost:3000 /);
});

// The installer links AGENTS.md to .agents/AGENTS.md, so the file a change
// actually edits is .agents/AGENTS.md: it is an instruction file, reviewed like
// the root one (Contextium v9.2.0 review).
test("check: the installed .agents/AGENTS.md is implementation source, like the root AGENTS.md", () => {
  for (const file of [".agents/AGENTS.md", "AGENTS.md"]) {
    const name = `agents-md-${file.startsWith(".") ? "installed" : "root"}`;
    const d = repo(name);
    writeFileSync(join(d, file), "rules\n");
    const report = join(d, "projects/p/specs/001-x/report.md");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, "<!-- review-coverage:v1 -->\n{}\n<!-- /review-coverage -->\n");
    const c = run({}, "check", "--owner", name, d);
    assert.equal(c.rc, 1, `${file} needs a receipt: ${c.out}${c.err}`);
    assert.match(c.err, new RegExp(`no review receipt for implementation source \\(${file.replaceAll(".", "\\.")}\\)`));
  }
});

test("a fallback frame naming one item twice is refused, never the last entry wins", () => {
  const d = repo("fallback-dup");
  const env = owner("fallback-dup");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const f = join(TMP, "dup-frame.txt");
  writeFileSync(
    f,
    `BEGIN_REVIEW_V1\n${JSON.stringify({
      findings: "NO_FINDINGS",
      coverage: [
        { id: "E1", status: "unchecked", evidence: ["not read"] },
        { id: "E1", status: "checked", evidence: ["read"] },
      ],
    })}\nEND_REVIEW_V1\n`,
  );
  const r = run(env, "finish", "--repo", d, "--fallback", f);
  assert.equal(r.rc, 1, r.out + r.err);
  assert.match(r.err, /E1.*more than once|twice/);
});

test("a full review the fallback completed is spent, so a repeated full review is round 2", () => {
  const d = repo("fallback-spend");
  const env = owner("fallback-spend");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.match(begin(env, d).out, /RECEIPT=review/);
  run(env, "finish", "--repo", d, "--rc", "3");
  const f = join(TMP, "spend-clean.txt");
  writeFileSync(f, "NO_FINDINGS\n");
  assert.equal(run(env, "finish", "--repo", d, "--fallback", f).out, "APPROVED=1");
  const dir = join(TMP, "rounds-fallback-spend");
  assert.ok(
    readdirSync(dir).some((n) => n.endsWith(".full")),
    `the completed full review is marked spent in ${dir}: ${readdirSync(dir).join(" ")}`,
  );
});

// ── Pieces: piece-by-piece reviews approve together ──────────────────────
//
// A change too large for one review call is reviewed as pieces: full reviews
// over one base and head, each reading a disjoint list of the changed files.
// The receipt keeps the completed pieces and combines a set that read every
// changed file, at its current content, into one ordinary full-review receipt.

function pieceFile(paths: string[]): string {
  const f = join(TMP, `piece-${Math.random()}`);
  writeFileSync(f, paths.map((p) => `${p}\0`).join(""));
  return f;
}
interface PieceOpts {
  base?: string;
  head?: string;
  scope?: string;
  report?: string;
}
function beginPiece(env: NodeJS.ProcessEnv, dir: string, paths: string[], o: PieceOpts = {}): R {
  return run(
    env,
    "begin",
    "--repo",
    dir,
    "--tree",
    snap(dir),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    o.base ?? "HEAD",
    "--head",
    o.head ?? "HEAD",
    "--scope",
    o.scope ?? ".agents/skills/demo",
    "--slice",
    pieceFile(paths),
    ...(o.report ? ["--report", o.report] : []),
  );
}
function piece(
  env: NodeJS.ProcessEnv,
  dir: string,
  paths: string[],
  findings: string[] = [],
  o: PieceOpts & { coverage?: unknown[]; vendor?: string; expectedItems?: string[] } = {},
): R {
  const b = beginPiece(env, dir, paths, o);
  assert.equal(b.rc, 0, b.err);
  assert.match(b.out, /RECEIPT=review/, b.err);
  if (o.expectedItems) {
    const file = b.out.match(/^ITEMS_FILE=(.*)$/m)![1];
    const { items } = JSON.parse(readFileSync(file, "utf8")) as { items: { id: string }[] };
    assert.deepEqual(
      items.map((item) => item.id),
      o.expectedItems,
      "send only relevant, outstanding checks to this piece",
    );
  }
  return run(
    env,
    "finish",
    "--repo",
    dir,
    "--rc",
    "0",
    "--result",
    result(`p-${Math.random()}`, findings, o.coverage ?? [], o.vendor),
  );
}
const stateBytes = (id: string): string => {
  const f = join(HOME, ".cache/workbench/threads", id, "review.json");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
function edit(d: string, files: string[], v = 2): void {
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), `export const x = ${v};\n`);
  }
}
const A = ".agents/skills/demo/a.ts";
const B = ".agents/skills/demo/b.ts";
const C = ".agents/skills/demo/c.ts";
const D = ".agents/skills/demo/d.ts";
const REPORT = "projects/p/specs/001-x/report.md";
const declared = (scope: string): string =>
  `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope, entryPoints: [], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`;

test("pieces: two over one base and head approve together; the first alone names what is unread", () => {
  const d = repo("pc-two");
  const env = owner("pc-two");
  edit(d, [A, B]);
  const first = piece(env, d, [A]);
  assert.match(first.out, /^APPROVED=0$/m, first.err);
  assert.match(first.out, /^SLICE_PENDING=1$/m);
  assert.match(first.out, /^unread: \.agents\/skills\/demo\/b\.ts$/m);
  assert.doesNotMatch(first.err, /must-fix|not reviewed/, "pending files are not a failure");
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out, "fresh");
  assert.match(s.err, /pieces pending: 1 changed file\(s\) unread by any piece: \.agents\/skills\/demo\/b\.ts/);
  const c1 = run({}, "check", "--owner", "pc-two", d);
  assert.equal(c1.rc, 1);
  assert.match(c1.err, /unread by any piece: \.agents\/skills\/demo\/b\.ts/);
  const second = piece(env, d, [B]);
  assert.match(second.out, /^APPROVED=1$/m, second.err);
  assert.doesNotMatch(second.out, /SLICE_PENDING/);
  assert.equal(run({}, "check", "--owner", "pc-two", d).rc, 0, "the close accepts the combined receipt");
  const done = run(env, "status", "--repo", d);
  assert.equal(done.out.split("\n")[0], "done");
  assert.match(done.out, /in 2 pieces/);
  assert.match(begin(env, d).out, /RECEIPT=reuse/, "the combined receipt is reused like any other");
});

test("pieces: one piece listing every changed file approves on its own; four pieces approve", () => {
  const d = repo("pc-one");
  const env = owner("pc-one");
  edit(d, [A, B]);
  assert.match(piece(env, d, [A, B]).out, /^APPROVED=1$/m);
  const d4 = repo("pc-four");
  const env4 = owner("pc-four");
  edit(d4, [A, B, C, D]);
  for (const [i, f] of [A, B, C].entries()) {
    const r = piece(env4, d4, [f]);
    assert.match(r.out, /^APPROVED=0$/m);
    assert.match(r.out, new RegExp(`^SLICE_PENDING=${3 - i}$`, "m"));
  }
  assert.match(piece(env4, d4, [D]).out, /^APPROVED=1$/m);
  assert.equal(run({}, "check", "--owner", "pc-four", d4).rc, 0);
});

test("pieces: a bad piece is refused before any state change", () => {
  const d = repo("pc-bad");
  const env = owner("pc-bad");
  edit(d, [A, B, "journal/x.md"]);
  writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
  git(d, "add", ".agents/skills/demo/c.ts");
  git(d, "commit", "-qm", "c unchanged since");
  edit(d, [A, B]);
  assert.match(piece(env, d, [A]).out, /SLICE_PENDING=1/);
  const before = stateBytes("pc-bad");
  for (const [why, paths] of [
    ["overlap", [A]],
    ["not changed", [C]],
    ["record", ["journal/x.md"]],
    ["outside", ["../x.ts"]],
    ["absolute", ["/etc/passwd"]],
    ["empty", []],
  ] as const) {
    const r = beginPiece(env, d, [...paths]);
    assert.equal(r.rc, 2, `${why}: ${r.out} ${r.err}`);
    assert.doesNotMatch(r.out, /RECEIPT=/, why);
    assert.equal(stateBytes("pc-bad"), before, `${why}: the state is untouched`);
  }
  assert.match(beginPiece(env, d, [A]).err, /piece 1 already read \.agents\/skills\/demo\/a\.ts/);
  assert.match(beginPiece(env, d, [C]).err, /not changed since the branch base: \.agents\/skills\/demo\/c\.ts/);
  assert.match(beginPiece(env, d, ["journal/x.md"]).err, /a record/);
  assert.equal(
    run(env, "begin", "--repo", d, "--tree", snap(d), "--mode", "since", "--bucket", "build", "--slice", pieceFile([B]))
      .rc,
    2,
    "a piece is a full review",
  );
  assert.match(piece(env, d, [B]).out, /^APPROVED=1$/m, "the set still completes");
});

test("pieces: a different scope, writer set, declaration, base or head starts a new set", () => {
  for (const [what, second] of [
    ["scope", (env: NodeJS.ProcessEnv, d: string) => beginPiece(env, d, [B], { scope: ".agents/skills/other" })],
    [
      "writers",
      (env: NodeJS.ProcessEnv, d: string) => beginPiece({ ...env, POLICY_CHAIN_AUTHOR_VENDORS: "codex" }, d, [B]),
    ],
    ["base", (env: NodeJS.ProcessEnv, d: string) => beginPiece(env, d, [B], { base: "HEAD~1" })],
    ["head", (env: NodeJS.ProcessEnv, d: string) => beginPiece(env, d, [B], { head: "HEAD~1" })],
    [
      "declaration",
      (env: NodeJS.ProcessEnv, d: string) => {
        writeFileSync(join(d, REPORT), declared(".agents/skills/demo"));
        return beginPiece(env, d, [B], { report: join(d, REPORT) });
      },
    ],
  ] as const) {
    const d = repo(`pc-key-${what}`);
    const env = owner(`pc-key-${what}`);
    writeFileSync(join(d, ".agents/skills/demo/z.ts"), "export const z = 1;\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "z");
    edit(d, [A, B]);
    mkdirSync(dirname(join(d, REPORT)), { recursive: true });
    writeFileSync(join(d, REPORT), declared("s"));
    assert.match(piece(env, d, [A], [], { report: join(d, REPORT) }).out, /SLICE_PENDING=1/);
    const b = second(env, d);
    assert.equal(b.rc, 0, `${what}: ${b.err}`);
    assert.match(b.err, new RegExp(`1 earlier piece\\(s\\) no longer count: the ${what} differs`), `${what}: ${b.err}`);
    const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result(`k-${what}`, []));
    assert.match(f.out, /^APPROVED=0$/m, what);
    assert.match(f.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m, `${what}: the earlier piece no longer counts`);
  }
});

test("pieces: two explicit bases sharing one branch base are different sets", () => {
  const d = repo("pc-bases");
  const env = owner("pc-bases");
  const c0 = git(d, "rev-parse", "HEAD");
  git(d, "update-ref", "refs/remotes/origin/main", c0);
  writeFileSync(join(d, ".agents/skills/demo/z.ts"), "export const z = 1;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "z");
  const c1 = git(d, "rev-parse", "HEAD");
  edit(d, [A, B]);
  assert.match(piece(env, d, [A, ".agents/skills/demo/z.ts"], [], { base: c0 }).out, /SLICE_PENDING=1/);
  const b = beginPiece(env, d, [B], { base: c1 });
  assert.match(b.err, /no longer count: the base differs/);
});

test("pieces: a file edited after its piece is unread until a piece reads it again", () => {
  const d = repo("pc-moved");
  const env = owner("pc-moved");
  edit(d, [A, B]);
  piece(env, d, [A]);
  edit(d, [A], 3);
  const second = piece(env, d, [B]);
  assert.match(second.out, /^APPROVED=0$/m);
  assert.match(second.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m);
  const again = piece(env, d, [A]);
  assert.match(again.out, /^APPROVED=1$/m, again.err);
});

test("pieces: a commit between pieces leaves the set unapproved with the head reason", () => {
  const d = repo("pc-commit");
  const env = owner("pc-commit");
  const base = git(d, "rev-parse", "HEAD");
  edit(d, [A, B]);
  git(d, "commit", "-qam", "work");
  const head = git(d, "rev-parse", "HEAD");
  piece(env, d, [A], [], { base, head });
  writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "later");
  const f = piece(env, d, [B, C], [], { base, head });
  assert.match(f.out, /^APPROVED=0$/m);
  assert.match(f.err, /not reviewed: commits after the --head/);
  assert.equal(run({}, "check", "--owner", "pc-commit", d).rc, 1);
});

test("pieces: a blocker in one piece rides into the combined receipt and a --since round closes it", () => {
  const d = repo("pc-blocker");
  const env = owner("pc-blocker");
  edit(d, [A, B]);
  const blocker = "[must-fix] .agents/skills/demo/a.ts:1: wrong — fix — breaks";
  const p1 = piece(env, d, [A], [blocker]);
  assert.match(p1.out, /SLICE_PENDING=1/);
  assert.match(p1.out, /^SLICE_BLOCKED=1$/m, "a finding is not merely pending");
  const p2 = piece(env, d, [B], ["[nit] tidy"]);
  assert.match(p2.out, /^APPROVED=0$/m);
  assert.doesNotMatch(p2.out, /SLICE_PENDING/, "the set is complete");
  assert.match(p2.err, /1 must-fix\/should-fix finding\(s\) unresolved/);
  const t = snap(d);
  edit(d, [A], 4);
  const b = begin(env, d, "since", ["--since", t]);
  const open = JSON.parse(readFileSync(b.out.match(/ITEMS_FILE=(.*)/)?.[1] ?? "", "utf8")).openFindings;
  assert.deepEqual(open, [blocker], "the follow-up is shown the combined receipt's open finding");
  assert.match(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult("pcb", [], [blocker])).out,
    /^APPROVED=1$/m,
  );
  const s = run(env, "status", "--repo", d);
  assert.equal(s.out.split("\n")[0], "done", s.err);
});

test("pieces: a declared item counts from the piece that checked it, and not after its file moved", () => {
  const mk = (name: string): { d: string; env: NodeJS.ProcessEnv; report: string } => {
    const d = repo(name);
    writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "c");
    edit(d, [A, B]);
    const report = join(d, "projects/p/specs/001-x/report.md");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(
      report,
      `<!-- review-coverage:v1 -->\n${JSON.stringify({
        base: "HEAD",
        scope: ".agents/skills/demo",
        entryPoints: [
          { id: "E1", path: A },
          { id: "E2", path: B },
        ],
        dependencies: [{ id: "D1", path: C, why: "a reads it" }],
        claims: [],
      })}\n<!-- /review-coverage -->\n`,
    );
    return { d, env: owner(name), report };
  };
  const cov = (checked: string[], unchecked: string[] = []) => [
    ...checked.map((id) => ({ id, status: "checked", evidence: ["x"] })),
    ...unchecked.map((id) => ({ id, status: "unchecked", evidence: ["x"] })),
  ];
  const ok = mk("pc-items");
  piece(ok.env, ok.d, [A], [], { report: ok.report, coverage: cov(["E1", "D1"]), expectedItems: ["E1", "D1"] });
  const f = piece(ok.env, ok.d, [B], [], { report: ok.report, coverage: cov(["E2"]), expectedItems: ["E2"] });
  assert.match(f.out, /^APPROVED=1$/m, f.err);
  const moved = mk("pc-items-moved");
  piece(moved.env, moved.d, [A], [], { report: moved.report, coverage: cov(["E1", "D1"]) });
  edit(moved.d, [C], 5);
  const g = piece(moved.env, moved.d, [B, C], [], {
    report: moved.report,
    coverage: cov(["E2"], ["D1"]),
    expectedItems: ["E2", "D1"],
  });
  assert.match(g.out, /^APPROVED=0$/m);
  assert.match(g.err, /no piece checked D1 at its current content/);
  const none = mk("pc-items-none");
  piece(none.env, none.d, [A], [], { report: none.report, coverage: cov(["E1"], ["D1"]) });
  const h = piece(none.env, none.d, [B], [], {
    report: none.report,
    coverage: cov(["E2"], ["D1"]),
    expectedItems: ["E2", "D1"],
  });
  assert.match(h.out, /^APPROVED=0$/m);
  assert.match(h.err, /no piece checked D1/);
});

test("pieces: a listed file the reviewed diff did not hold stays unread", () => {
  const d = repo("pc-absent");
  const env = owner("pc-absent");
  git(d, "update-ref", "refs/remotes/origin/main", git(d, "rev-parse", "HEAD"));
  edit(d, [A]);
  git(d, "commit", "-qam", "a");
  const c1 = git(d, "rev-parse", "HEAD");
  edit(d, [B]);
  const f = piece(env, d, [A, B], [], { base: c1 });
  assert.match(f.out, /^APPROVED=0$/m);
  assert.match(f.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m, "a.ts was listed but base..head did not hold it");
});

test("pieces: two of three done — status and check name only the third piece's files", () => {
  const d = repo("pc-three");
  const env = owner("pc-three");
  edit(d, [A, B, C]);
  piece(env, d, [A]);
  piece(env, d, [B]);
  const s = run(env, "status", "--repo", d);
  assert.match(s.err, /unread by any piece: \.agents\/skills\/demo\/c\.ts$/m);
  assert.doesNotMatch(s.err, /a\.ts|b\.ts/);
  const c = run({}, "check", "--owner", "pc-three", d);
  assert.equal(c.rc, 1);
  assert.match(c.err, /\.agents\/skills\/demo\/c\.ts/);
  assert.doesNotMatch(c.err, /\.agents\/skills\/demo\/[ab]\.ts/);
});

test("pieces: a failed, interrupted or unrecorded piece keeps the earlier pieces and records no read", () => {
  const d = repo("pc-fail");
  const env = owner("pc-fail");
  edit(d, [A, B]);
  piece(env, d, [A]);
  // A chain failure.
  assert.equal(beginPiece(env, d, [B]).rc, 0);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "1").out, "APPROVED=0");
  // An interrupted piece: begun, never finished — the next begin replaces it.
  assert.equal(beginPiece(env, d, [B]).rc, 0);
  let c = run({}, "check", "--owner", "pc-fail", d);
  assert.match(c.err, /unread by any piece: \.agents\/skills\/demo\/b\.ts/);
  assert.doesNotMatch(c.err, /a\.ts/, "piece 1 still counts");
  // An unreadable result.
  const bad = join(TMP, "unreadable.json");
  writeFileSync(bad, "{nope");
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", bad).out, "APPROVED=0");
  // A state write that fails while combining.
  assert.equal(beginPiece(env, d, [B]).rc, 0);
  const dir = join(HOME, ".cache/workbench/threads/pc-fail");
  const before = stateBytes("pc-fail");
  chmodSync(dir, 0o555);
  let w: R;
  try {
    w = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("pcw", []));
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.equal(w.rc, 1);
  assert.equal(w.out, "APPROVED=0");
  assert.equal(stateBytes("pc-fail"), before, "nothing was recorded");
  c = run({}, "check", "--owner", "pc-fail", d);
  assert.doesNotMatch(c.err, /a\.ts/, "piece 1 still counts");
  assert.match(piece(env, d, [B]).out, /^APPROVED=1$/m, "the retry completes the set");
});

test("pieces: a writer answering one piece blocks the combined receipt", () => {
  const d = repo("pc-writer");
  const env = { ...owner("pc-writer"), POLICY_CHAIN_AUTHOR_VENDORS: "codex" };
  edit(d, [A, B]);
  piece(env, d, [A], [], { vendor: "codex/gpt" });
  const f = piece(env, d, [B]);
  assert.match(f.out, /^APPROVED=0$/m);
  assert.match(f.err, /the reviewer codex\/gpt is one of the writers/);
});

test("pieces: an unsliced full review after a partial set replaces it", () => {
  const d = repo("pc-replace");
  const env = owner("pc-replace");
  edit(d, [A, B]);
  piece(env, d, [A]);
  const b = begin(env, d);
  assert.match(b.err, /1 earlier piece\(s\) no longer count: a full review reads the whole change/);
  assert.match(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("rep", [])).out, /^APPROVED=1$/m);
  assert.equal(run({}, "check", "--owner", "pc-replace", d).rc, 0);
});

test("pieces: names with spaces, tabs and newlines stay one path each", () => {
  const d = repo("pc-names");
  const env = owner("pc-names");
  const odd = [".agents/skills/demo/sp ace.ts", ".agents/skills/demo/t\tab.ts", ".agents/skills/demo/new\nline.ts"];
  edit(d, odd);
  const p1 = piece(env, d, [odd[0] as string]);
  assert.match(p1.out, /SLICE_PENDING=2/);
  assert.match(p1.out, /^unread: "\.agents\/skills\/demo\/new\\nline\.ts"$/m, "a newline in a name cannot split its line");
  assert.match(p1.out, /^unread: "\.agents\/skills\/demo\/t\\tab\.ts"$/m);
  piece(env, d, [odd[1] as string]);
  assert.match(piece(env, d, [odd[2] as string]).out, /^APPROVED=1$/m);
});

test("pieces: state written before pieces existed reads as no set", () => {
  const d = repo("pc-legacy");
  const env = owner("pc-legacy");
  edit(d, [A]);
  approve(env, d);
  const f = join(HOME, ".cache/workbench/threads/pc-legacy/review.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  for (const rs of Object.values(st.repos) as Record<string, unknown>[]) delete rs.slices;
  writeFileSync(f, JSON.stringify(st));
  assert.equal(run(env, "status", "--repo", d).out.split("\n")[0], "done");
});

test("pieces: a follow-up round built on one piece of an incomplete set approves nothing", () => {
  const d = repo("pc-since");
  const env = owner("pc-since");
  edit(d, [A, B]);
  piece(env, d, [A]);
  const t = snap(d);
  edit(d, [A], 3);
  assert.match(begin(env, d, "since", ["--since", t]).out, /RECEIPT=review/);
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("pcs", []));
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /built on one piece of an incomplete piece set/);
});

// ── Findings from the pieces change's own review ─────────────────────────

test("pieces: claims sharing one evidence file each stay bound to it", () => {
  const d = repo("pc-shared-ev");
  const env = owner("pc-shared-ev");
  edit(d, [A, B]);
  const ev = "projects/p/specs/001-x/evidence/runs.md";
  mkdirSync(dirname(join(d, ev)), { recursive: true });
  writeFileSync(join(d, ev), "red then green\n");
  const report = join(d, REPORT);
  const claim = (id: string) => ({
    id,
    claim: `claim ${id}`,
    negativeTest: { trigger: "t", expected: "e", evidence: [ev] },
  });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [], dependencies: [], claims: [claim("C1"), claim("C2")] })}\n<!-- /review-coverage -->\n`,
  );
  const cov = (c1: string, c2: string) => [
    { id: "C1", status: c1, evidence: ["x"] },
    { id: "C2", status: c2, evidence: ["x"] },
  ];
  // Piece 1 checks C1; the shared evidence is then rerun, and piece 2 checks
  // only C2. A rerun is a record rewritten, so C1's check still stands.
  piece(env, d, [A], [], { report, coverage: cov("checked", "unchecked") });
  writeFileSync(join(d, ev), "red then green, rewritten\n");
  const f = piece(env, d, [B], [], { report, coverage: cov("unchecked", "checked") });
  assert.match(f.out, /^APPROVED=1$/m, `C1's check survives a rerun of its evidence: ${f.err}`);
  assert.doesNotMatch(f.err, /no piece checked C1/);
});

test("pieces: a piece whose result names no reviewer is not kept and reads nothing", () => {
  const d = repo("pc-novendor");
  const env = owner("pc-novendor");
  edit(d, [A, B]);
  assert.equal(beginPiece(env, d, [A]).rc, 0);
  const anon = join(TMP, "anon.json");
  writeFileSync(anon, JSON.stringify({ findings: [], coverage: [] }));
  const f = run(env, "finish", "--repo", d, "--rc", "0", "--result", anon);
  assert.equal(f.out, "APPROVED=0");
  assert.match(f.err, /no answering reviewer/);
  const second = piece(env, d, [B]);
  assert.match(second.out, /^APPROVED=0$/m, "the anonymous piece's file is still unread");
  assert.match(second.out, /^unread: \.agents\/skills\/demo\/a\.ts$/m);
});

// land.ts merges the trunk and, on a conflict, leaves the merge uncommitted;
// the close's re-run asks `check` before committing it. Measured from HEAD's
// merge-base, the trunk's own landed spec report and source read as this
// thread's implementation work, and the close would demand a review of them.
test("check: an uncommitted trunk merge does not make the trunk's work this thread's", () => {
  const d = repo("uncommitted-trunk-merge"),
    env = owner("uncommitted-trunk-merge");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-qb", "work");
  mkdirSync(join(d, "journal"), { recursive: true });
  writeFileSync(join(d, "journal/entry.md"), "# a records-only session\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "records only");
  git(d, "checkout", "-q", "main");
  mkdirSync(join(d, "projects/x/specs/001-y"), { recursive: true });
  writeFileSync(join(d, "projects/x/specs/001-y/report.md"), "# report\n<!-- review-coverage:v1 -->\n");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "another thread's reviewed build lands");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(d, "checkout", "-q", "work");
  git(d, "merge", "-q", "--no-commit", "--no-ff", "main");
  const r = run(env, "check", "--owner", "uncommitted-trunk-merge", d);
  assert.equal(r.rc, 0, r.err);
  assert.doesNotMatch(r.err, /no review receipt/);
});

test("a full review after the bound build has landed starts the repo's record afresh", () => {
  const d = repo("landed-report"),
    env = owner("landed-report");
  const stateFile = join(HOME, ".cache/workbench/threads/landed-report/review.json");
  const bound = (): unknown => {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as { repos: Record<string, { report: string | null }> };
    return Object.values(s.repos)[0]?.report ?? null;
  };
  git(d, "update-ref", "refs/remotes/origin/main", git(d, "rev-parse", "HEAD"));
  git(d, "checkout", "-qb", "work");
  const report = join(d, "projects/ops/p/specs/001-x/report.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(
    report,
    `<!-- review-coverage:v1 -->\n${JSON.stringify({ base: "HEAD", scope: ".agents/skills/demo", entryPoints: [{ id: "E1", path: ".agents/skills/demo/a.ts" }], dependencies: [], claims: [] })}\n<!-- /review-coverage -->\n`,
  );
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  // The build, unlanded: its report binds, and the review leaves a finding open.
  const b1 = begin(env, d, "range", ["--report", report]);
  assert.equal(b1.rc, 0, b1.err);
  assert.equal(bound(), report, "an unlanded report binds");
  assert.equal(
    run(
      env,
      "finish",
      "--repo",
      d,
      "--rc",
      "0",
      "--result",
      result("landed-1", ["[should-fix] .agents/skills/demo/a.ts:1: a finding about the build"]),
    ).out,
    "APPROVED=0",
  );
  // The build lands: the trunk holds the report as the worktree does.
  git(d, "add", "-A");
  git(d, "commit", "-qm", "land the build");
  git(d, "update-ref", "refs/remotes/origin/main", git(d, "rev-parse", "HEAD"));
  // A follow-up round still compares with the receipt it follows: kept.
  const before = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  assert.equal(begin(env, d, "since", ["--since", before]).rc, 0);
  assert.equal(bound(), report, "a follow-up round keeps the binding");
  run(env, "finish", "--repo", d, "--rc", "0", "--result", result("landed-since", []));
  // A full review of the later work, no --report: a fresh record.
  const b2 = begin(env, d);
  assert.equal(b2.rc, 0, b2.err);
  assert.equal(bound(), null, "the landed report no longer binds");
  const items = b2.out.match(/^ITEMS_FILE=(.*)$/m)?.[1] ?? "";
  assert.ok(items !== "" && existsSync(items), b2.out);
  assert.doesNotMatch(readFileSync(items, "utf8"), /coverage declaration|"E1"/, "no landed item is asked for again");
  assert.equal(
    run(env, "finish", "--repo", d, "--rc", "0", "--result", result("landed-2", [])).out,
    "APPROVED=1",
    "the landed build's open finding does not hold the later work",
  );
  // An explicit --report binds whatever its state.
  const b3 = begin(env, d, "range", ["--report", report]);
  assert.equal(b3.rc, 0, b3.err);
  assert.equal(bound(), report, "an explicit report binds");
});

// ── Two writers under one owner ────────────────
// A workbench review and a product review can run at once under one audit
// owner; a command that read the record at its start and wrote the whole of it
// back would erase the other repo's entry.

/** Run the program in the background; resolves when it exits. */
function runAsync(env: NodeJS.ProcessEnv, ...args: string[]): { child: ChildProcess; done: Promise<R> } {
  const child = spawn(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const done = new Promise<R>((ok) =>
    child.on("close", (rc) => ok({ out: out.replace(/\n+$/, ""), err: err.replace(/\n+$/, ""), rc })),
  );
  return { child, done };
}
const pause = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}
const record = (id: string): State => JSON.parse(stateBytes(id)) as State;
interface State {
  repos: Record<string, Record<string, unknown> & { receipt?: Record<string, unknown> }>;
}
const real = (d: string): string => git(d, "rev-parse", "--show-toplevel");
/**
 * Writer A runs `aArgs` held at its first record write; once it is waiting,
 * writer B runs `bArgs` to completion; then A is let go. Returns both results
 * and the record as B left it.
 */
async function interleave(
  env: NodeJS.ProcessEnv,
  id: string,
  aArgs: string[],
  bArgs: string[],
): Promise<{ a: R; b: R; afterB: State | null }> {
  const barrier = join(TMP, `barrier-${id}-${Math.random()}`);
  const a = runAsync({ ...env, AUDIT_DEDUPE_TEST_WRITE_BARRIER: barrier }, ...aArgs);
  let aExited = false;
  void a.done.then(() => {
    aExited = true;
  });
  await until("writer A to reach its write", () => existsSync(`${barrier}.waiting`) || aExited);
  if (aExited) assert.fail(`writer A ended before its write: ${JSON.stringify(await a.done)}`);
  const b = run(env, ...bArgs);
  const afterB = stateBytes(id) === "" ? null : record(id);
  writeFileSync(barrier, "");
  return { a: await a.done, b, afterB };
}
function beginArgs(dir: string): string[] {
  return [
    "begin",
    "--repo",
    dir,
    "--tree",
    snap(dir),
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    "HEAD",
    "--scope",
    ".agents/skills/demo",
  ];
}
function bothKept(after: State, x: string, y: string, afterB: State | null): void {
  assert.ok(after.repos[real(y)], `repo Y (${real(y)}) is missing from the record`);
  assert.ok(after.repos[real(x)], `repo X (${real(x)}) is missing from the record`);
  assert.deepEqual(after.repos[real(y)], afterB?.repos[real(y)], "Y's entry is as its own writer left it");
}

test("two writers for two repos under one owner keep both entries: begin against begin", async () => {
  const id = "pair-begin";
  const env = owner(id);
  const x = repo("pair-begin-x");
  const y = repo("pair-begin-y");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  writeFileSync(join(y, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const { a, b, afterB } = await interleave(env, id, beginArgs(x), beginArgs(y));
  assert.equal(b.rc, 0, b.err);
  assert.equal(a.rc, 0, a.err);
  const after = record(id);
  bothKept(after, x, y, afterB);
  const rx = after.repos[real(x)];
  assert.equal(rx.receipt?.status, "incomplete");
  assert.equal(rx.receipt?.mode, "range");
  assert.deepEqual(rx.spendInit, { build: true, qa: true });
  assert.equal(rx.base, "HEAD");
  assert.equal(rx.scope, ".agents/skills/demo");
});

test("two writers for two repos under one owner keep both entries: finish against begin", async () => {
  const id = "pair-finish";
  const env = owner(id);
  const x = repo("pair-finish-x");
  const y = repo("pair-finish-y");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  writeFileSync(join(y, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  const bx = begin(env, x);
  assert.match(bx.out, /RECEIPT=review/, bx.err);
  const finish = ["finish", "--repo", x, "--rc", "0", "--result", result("pair-finish", [])];
  const { a, b, afterB } = await interleave(env, id, finish, beginArgs(y));
  assert.equal(b.rc, 0, b.err);
  assert.equal(a.out, "APPROVED=1", a.err);
  const after = record(id);
  bothKept(after, x, y, afterB);
  const rx = after.repos[real(x)];
  assert.equal(rx.receipt?.approved, true);
  assert.ok(rx.approvedReceipt, "X keeps its approval");
});

test("two writers for two repos under one owner keep both entries: mark against begin", async () => {
  const id = "pair-mark";
  const env = owner(id);
  const x = repo("pair-mark-x");
  const y = repo("pair-mark-y");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  writeFileSync(join(y, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  assert.equal(approve(env, x).out, "APPROVED=1");
  const trailer = "implement-audit: round-1; zero findings; APPROVE";
  const { a, b, afterB } = await interleave(env, id, ["mark", trailer, "--repo", x], beginArgs(y));
  assert.equal(b.rc, 0, b.err);
  assert.equal(a.rc, 0, a.err);
  const after = record(id);
  bothKept(after, x, y, afterB);
  assert.equal(after.repos[real(x)].receipt?.trailer, trailer);
});

test("a third repo's entry is untouched by two writers for the other two", async () => {
  const id = "pair-third";
  const env = owner(id);
  const x = repo("pair-third-x");
  const y = repo("pair-third-y");
  const z = repo("pair-third-z");
  for (const [d, v] of [
    [x, 2],
    [y, 3],
    [z, 4],
  ] as const)
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), `export const a = ${v};\n`);
  assert.equal(approve(env, z).out, "APPROVED=1");
  const zBefore = JSON.stringify(record(id).repos[real(z)], null, 1);
  const { a, b, afterB } = await interleave(env, id, beginArgs(x), beginArgs(y));
  assert.equal(a.rc, 0, a.err);
  assert.equal(b.rc, 0, b.err);
  const after = record(id);
  bothKept(after, x, y, afterB);
  assert.equal(JSON.stringify(after.repos[real(z)], null, 1), zBefore, "Z is byte-for-byte as it was");
});

const ownerFolder = (id: string): string => join(HOME, ".cache/workbench/threads", id);
const lockOf = (id: string): string => join(ownerFolder(id), "review.json.lock");
/** Hold the owner's record lock from another process until the returned release is called. */
async function holdLock(id: string): Promise<() => Promise<void>> {
  mkdirSync(ownerFolder(id), { recursive: true });
  // -o: the sleep does not inherit the lock, so killing flock alone releases it.
  const c = spawn("flock", ["-o", "-x", lockOf(id), "sleep", "60"], { stdio: "ignore", detached: true });
  await until("the suite to hold the lock", () => spawnSync("flock", ["-n", lockOf(id), "true"]).status === 1);
  return async () => {
    if (c.pid !== undefined) process.kill(-c.pid, "SIGKILL");
    await new Promise<void>((ok) => (c.exitCode !== null || c.signalCode !== null ? ok() : c.on("exit", () => ok())));
  };
}
const shortWait = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, AUDIT_DEDUPE_LOCK_WAIT_SECONDS: "1" });

test("a write that cannot take the record's lock refuses, naming it, and leaves the record as it was", async () => {
  const id = "lock-held";
  const env = owner(id);
  const z = repo("lock-held-z");
  const x = repo("lock-held-x");
  writeFileSync(join(z, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  assert.equal(approve(env, z).out, "APPROVED=1");
  const before = stateBytes(id);
  const release = await holdLock(id);
  try {
    const b = begin(shortWait(env), x);
    assert.equal(b.rc, 1, b.out);
    assert.ok(b.err.includes(lockOf(id)), `names the lock: ${b.err}`);
    assert.match(b.err, /could not record the attempt: cannot lock .* past the 1s wait/);
    assert.equal(stateBytes(id), before, "the record is byte-identical");
  } finally {
    await release();
  }
});

test("a record made unreadable while a writer waits is refused on the locked re-read, and left as it is", async () => {
  const id = "lock-corrupt";
  const env = owner(id);
  const x = repo("lock-corrupt-x");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  const barrier = join(TMP, "barrier-lock-corrupt");
  const a = runAsync({ ...env, AUDIT_DEDUPE_TEST_WRITE_BARRIER: barrier }, ...beginArgs(x));
  await until("writer A to reach its write", () => existsSync(`${barrier}.waiting`));
  mkdirSync(ownerFolder(id), { recursive: true });
  writeFileSync(join(ownerFolder(id), "review.json"), "{nope");
  writeFileSync(barrier, "");
  const r = await a.done;
  assert.equal(r.rc, 1, r.out);
  assert.match(r.err, /refusing rather than reading it as no review/);
  assert.equal(stateBytes(id), "{nope", "nothing was written over it");
});

test("finish under a held lock reports APPROVED=0 and names the lock, on its result and convergence writes", async () => {
  const id = "lock-finish";
  const env = owner(id);
  const x = repo("lock-finish-x");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  // The result write.
  assert.match(begin(env, x).out, /RECEIPT=review/);
  let before = stateBytes(id);
  let release = await holdLock(id);
  try {
    const f = run(shortWait(env), "finish", "--repo", x, "--rc", "0", "--result", result("lock-finish", []));
    assert.equal(f.rc, 1);
    assert.equal(f.out, "APPROVED=0");
    assert.ok(f.err.includes(lockOf(id)), f.err);
    assert.match(f.err, /could not record the review: cannot lock/);
    assert.equal(stateBytes(id), before);
  } finally {
    await release();
  }
  // The convergence write: an earlier complete receipt, then a round with nothing to review.
  assert.equal(run(env, "finish", "--repo", x, "--rc", "0", "--result", result("lock-finish-2", [])).out, "APPROVED=1");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  assert.match(begin(env, x, "since", ["--since", snap(x)]).out, /RECEIPT=review/);
  before = stateBytes(id);
  release = await holdLock(id);
  try {
    const c = run(shortWait(env), "finish", "--repo", x, "--rc", "4");
    assert.equal(c.rc, 1);
    assert.equal(c.out, "APPROVED=0");
    assert.ok(c.err.includes(lockOf(id)), c.err);
    assert.equal(stateBytes(id), before);
  } finally {
    await release();
  }
});

test("the first write for an owner with no folder creates the folder, the lock file and the record", () => {
  const id = "lock-first";
  const x = repo("lock-first-x");
  writeFileSync(join(x, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(existsSync(ownerFolder(id)), false);
  const b = begin(owner(id), x);
  assert.equal(b.rc, 0, b.err);
  assert.ok(existsSync(lockOf(id)), "the lock file");
  assert.ok(record(id).repos[real(x)], "the record holds the repo");
});

test("a follow-up keeps an earlier check of a declared item nothing it names has moved under", () => {
  const mk = (
    name: string,
  ): { d: string; env: NodeJS.ProcessEnv; report: string; declare: (extra?: string) => void } => {
    const d = repo(name);
    writeFileSync(join(d, ".agents/skills/demo/c.ts"), "export const c = 1;\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "c");
    const report = join(d, "projects/p/specs/001-x/report.md");
    const evidence = "projects/p/specs/001-x/red-green.log";
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(join(d, evidence), "red, then green\n");
    const declare = (extra = "") =>
      writeFileSync(
        report,
        `<!-- review-coverage:v1 -->\n${JSON.stringify({
          base: "HEAD",
          scope: ".agents/skills/demo",
          entryPoints: [{ id: "E1", path: A }],
          dependencies: [{ id: "D1", path: C, why: `a reads it${extra}` }],
          claims: [
            { id: "P1", claim: "copy reads true", inapplicable: "copy, not code" },
            {
              id: "P2",
              claim: "rejects bad input",
              negativeTest: { trigger: "bad input", expected: "rejected", evidence: [evidence] },
            },
          ],
        })}\n<!-- /review-coverage -->\n`,
      );
    declare();
    edit(d, [A]);
    return { d, env: owner(name), report, declare };
  };
  const all = (status: string) => ["E1", "D1", "P1", "P2"].map((id) => ({ id, status, evidence: ["x"] }));
  const first = (o: ReturnType<typeof mk>, unchecked?: string): string => {
    const b = begin(o.env, o.d, "range", ["--report", o.report]);
    assert.equal(b.rc, 0, b.err);
    const f = run(
      o.env,
      "finish",
      "--repo",
      o.d,
      "--rc",
      "0",
      "--result",
      result(
        `fu-${Math.random()}`,
        [],
        all("checked").map((item) => (item.id === unchecked ? { ...item, status: "unchecked" } : item)),
      ),
    );
    assert.equal(f.out, unchecked ? "APPROVED=0" : "APPROVED=1", f.err);
    return snap(o.d);
  };
  const followUp = (o: ReturnType<typeof mk>, since: string, expected: string[], status = "unchecked"): R => {
    const b = begin(o.env, o.d, "since", ["--since", since, "--report", o.report]);
    assert.equal(b.rc, 0, b.err);
    const file = b.out.match(/^ITEMS_FILE=(.*)$/m)![1];
    const { items } = JSON.parse(readFileSync(file, "utf8")) as { items: { id: string }[] };
    assert.deepEqual(
      items.map((item) => item.id),
      expected,
      "send only outstanding checks to the reviewer",
    );
    return run(
      o.env,
      "finish",
      "--repo",
      o.d,
      "--rc",
      "0",
      "--result",
      result(
        `fu-${Math.random()}`,
        [],
        all(status).filter((item) => expected.includes(item.id)),
      ),
    );
  };
  // A source edit still needs entry-point, dependency and pathless claim checks.
  const kept = mk("fu-kept");
  const t1 = first(kept);
  edit(kept.d, [B]);
  const k = followUp(kept, t1, ["E1", "D1", "P1"], "checked");
  assert.equal(k.out, "APPROVED=1", k.err);
  // An unchanged item still needs review if the first reviewer left it open.
  const pending = mk("fu-pending");
  const tPending = first(pending, "P2");
  edit(pending.d, [B]);
  const p = followUp(pending, tPending, ["E1", "D1", "P1", "P2"]);
  assert.equal(p.out, "APPROVED=0");
  assert.match(p.err, /did not check P2/);
  // A moved dependency must be checked again; the recorded run can still be reused.
  const moved = mk("fu-moved");
  const t2 = first(moved);
  edit(moved.d, [C], 5);
  const m = followUp(moved, t2, ["E1", "D1", "P1"]);
  assert.equal(m.out, "APPROVED=0");
  assert.match(m.err, /did not check D1/);
  assert.doesNotMatch(m.err, /did not check P2/);
  // A changed declaration carries nothing over.
  const redeclared = mk("fu-redeclared");
  const t3 = first(redeclared);
  redeclared.declare(", and its default");
  edit(redeclared.d, [B]);
  const r = followUp(redeclared, t3, ["E1", "D1", "P1", "P2"]);
  assert.equal(r.out, "APPROVED=0");
  assert.match(r.err, /did not check P1/);
});

test("an undeclared companion file whose folder cannot be read is not taken as deleted: it stays a gap", () => {
  const c = companion("unreadable-evidence");
  const t0 = snap(c.prod);
  writeFileSync(join(c.wb, c.c2), "red, then green, after the redesign\n");
  c.declare(c.c2);
  writeFileSync(join(c.prod, ".agents/skills/demo/b.ts"), "export const b = 2;\n");
  const folder = join(c.wb, dirname(c.c1));
  const b = begin(c.env, c.prod, "since", ["--since", t0, "--report", c.report]);
  assert.equal(b.rc, 0, b.err);
  chmodSync(folder, 0o000);
  let f: R;
  try {
    f = run(c.env, "finish", "--repo", c.prod, "--rc", "0", "--result", result("ue1", [], withDeclaration(c)));
  } finally {
    chmodSync(folder, 0o755);
  }
  assert.equal(f.out, "APPROVED=0", "a file that may still be there is not let go unreviewed");
  assert.match(f.err, /not reviewed: .*unreadable-evidence-wb::projects\/p\/specs\/001-x\/evidence\/c1\.log/);
});

test("a writer may answer only under the user's recorded reviewer override, naming them and the date", () => {
  const ok = repo("ov-ok");
  const env = { ...owner("ov-ok"), POLICY_CHAIN_AUTHOR_VENDORS: "claude" };
  edit(ok, [A, B]);
  const words = 'claude/opus (reviewer override: "override: use claude" — Robin, 2026-11-19)';
  const f = piece(env, ok, [A, B], [], { vendor: words });
  assert.match(f.out, /^APPROVED=1$/m, f.err);
  for (const [name, vendor] of [
    ["ov-plain", "claude/opus"],
    ["ov-nodate", "claude/opus (reviewer override: use claude — Robin)"],
    ["ov-noname", 'claude/opus (reviewer override: "use claude" — 2026-11-19)'],
  ]) {
    const d = repo(name);
    const e = { ...owner(name), POLICY_CHAIN_AUTHOR_VENDORS: "claude" };
    edit(d, [A, B]);
    const r = piece(e, d, [A, B], [], { vendor });
    assert.match(r.out, /^APPROVED=0$/m, `${vendor}: ${r.out}`);
    assert.match(r.err, /is one of the writers/, vendor);
  }
});

// ── Ideas, notes, verdicts ──
// code-review.ts writes a round's ideas (improvements nobody asked for) and its
// notes (findings outside this build's change) beside the findings; neither
// holds the build, each is printed for the report's § Not built, and a later
// round keeps them. A receipt saved before 2026-11-22 called them deferred.
test("ideas and notes never hold the build, are printed, and survive a clean round; a saved deferral is an idea", () => {
  const d = repo("ideas-notes");
  const env = owner("ideas-notes");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(begin(env, d, "range").rc, 0);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("in0", [])).out, "APPROVED=1");
  const t1 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 3;\n");
  begin(env, d, "since", ["--since", t1]);
  const f1 = join(TMP, "in1.json");
  writeFileSync(
    f1,
    JSON.stringify({
      vendor: "grok/grok-4",
      findings: [],
      coverage: [],
      shown: [],
      ideas: ["[idea] .agents/skills/demo/a.ts: show the count too"],
      noted: ["[must-fix] other/b.ts:4: another project's bug"],
      deferred: ["[deferred] .agents/skills/demo/a.ts:1: an older round's leftover"],
    }),
  );
  const r1 = run(env, "finish", "--repo", d, "--rc", "0", "--result", f1);
  assert.match(r1.out, /^APPROVED=1$/m, r1.err);
  assert.match(r1.out, /^IDEA: \[idea\] \.agents\/skills\/demo\/a\.ts: show the count too$/m);
  assert.match(r1.out, /^IDEA: \[deferred\] \.agents\/skills\/demo\/a\.ts:1: an older round's leftover$/m);
  assert.match(r1.out, /^NOTED: \[must-fix\] other\/b\.ts:4: another project's bug$/m);
  const t2 = snap(d);
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 4;\n");
  begin(env, d, "since", ["--since", t2]);
  const r2 = run(env, "finish", "--repo", d, "--rc", "0", "--result", result("in2", []));
  assert.match(r2.out, /^APPROVED=1$/m, r2.err);
  assert.match(r2.out, /^IDEA: \[idea\] \.agents\/skills\/demo\/a\.ts: show the count too$/m, "a later clean round keeps the idea");
  assert.match(r2.out, /^NOTED: \[must-fix\] other\/b\.ts:4: another project's bug$/m, "and the note");
});

test("a follow-up's verdicts decide: none keeps a blocker open, disproved closes it with its evidence, open twice is STILL OPEN", () => {
  const BUG = "[must-fix] .agents/skills/demo/a.ts:1: reads the bathroom digit as bedrooms — witness: 2 bd 1 ba → 1 bedroom";
  const d = repo("verdicts");
  const env = owner("verdicts");
  writeFileSync(join(d, ".agents/skills/demo/a.ts"), "export const a = 2;\n");
  assert.equal(begin(env, d, "range").rc, 0);
  assert.equal(run(env, "finish", "--repo", d, "--rc", "0", "--result", result("vd0", [BUG])).out, "APPROVED=0");
  const step = (name: string, left: "fixed" | "disproved" | "open" | null, v: number): R => {
    const t = snap(d);
    writeFileSync(join(d, ".agents/skills/demo/a.ts"), `export const a = ${v};\n`);
    begin(env, d, "since", ["--since", t]);
    return run(env, "finish", "--repo", d, "--rc", "0", "--result", shownResult(name, [], [BUG], left));
  };
  const none = step("vd1", null, 3);
  assert.equal(none.out, "APPROVED=0", "shown with no verdict, it stays open: an omission is not a judgment");
  const open1 = step("vd2", "open", 4);
  assert.equal(open1.out, "APPROVED=0", "judged open, it stays open");
  assert.doesNotMatch(open1.out, /STILL OPEN/, "once is a repair that missed");
  const open2 = step("vd3", "open", 5);
  assert.match(open2.out, new RegExp(`^STILL OPEN: ${fid(BUG)} `, "m"), "twice in a row: change the approach");
  assert.match(open2.out, /change the approach/);
  const gone = step("vd4", "disproved", 6);
  assert.match(gone.out, /^APPROVED=1$/m, gone.err);
  assert.match(gone.out, new RegExp(`^DISPROVED: ${fid(BUG)} .*reads the bathroom digit.* — read the repair$`, "m"));
});
