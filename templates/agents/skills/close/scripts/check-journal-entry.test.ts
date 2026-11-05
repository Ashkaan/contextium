// check-journal-entry.test.ts — the test harness for
// .agents/skills/close/scripts/check-journal-entry.ts
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/check-journal-entry.test.ts
//
// Front-matter fixtures are built from the two corruptions a shared day file
// suffers: a second frontmatter block appended mid-file, and a foreign `- slug:` inserted
// into another session's entry. Clean fixtures cover the shapes that must NOT
// trip the check — most importantly the nested `runtime_identity:` list, whose
// entries legitimately repeat `target:` / `branch:` / `head_sha:` and would be
// false duplicates under a naive key scan. The body fixtures (F6–F8) are the
// shapes close/references/journal-entry.md allows and the ones it retired; every
// refusing case also has a passing neighbour, because a false positive here
// refuses a close.
//
// Every fixture is a literal in this file, written into a temporary folder by
// the test itself; the check is spawned, never imported, with --no-warnings so
// Node 22's type-stripping warning stays out of the output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CHECK = join(SCRIPT_DIR, "check-journal-entry.ts");

const TMP = mkdtempSync(join(tmpdir(), "cje-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// A scratch HOME, so nothing the check or git reads or writes under HOME is
// the real one.
const HOME = join(TMP, "home");
mkdirSync(join(HOME, ".local/share"), { recursive: true });
const ENV: NodeJS.ProcessEnv = { ...process.env, HOME };

type Run = { rc: number; out: string };

function check(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CHECK, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ?? ENV,
    timeout: 60_000,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Write `fixture` plus a newline, as `printf '%s\n'` did, and return its path. */
function place(name: string, file: string, fixture: string): string {
  mkdirSync(join(TMP, name), { recursive: true });
  const path = join(TMP, name, file);
  writeFileSync(path, `${fixture}\n`);
  return path;
}

// ─── Assertions ──────────────────────────────────────────────────────────

// The front-matter fixtures are day-shaped (a `sessions:` list), which is
// `0000-day.md` — the one file that may still carry a list, and the one the
// slug/heading check (F5) skips.
function assertBlocks(name: string, fixture: string): void {
  test(`${name} blocked`, () => {
    const r = check([place(name, "0000-day.md", fixture)]);
    assert.notEqual(r.rc, 0, `${name} — expected BLOCK, got PASS`);
  });
}

function assertPasses(name: string, fixture: string): void {
  test(`${name} passed`, () => {
    const r = check([place(name, "0000-day.md", fixture)]);
    assert.equal(r.rc, 0, `${name} — expected PASS, got BLOCK:\n${r.out}`);
  });
}

// ─── F5: a session file's slug is the session its body is about ─────────

function assertSession(name: string, expect: "pass" | "block", fixture: string): void {
  test(`${name} ${expect === "pass" ? "passed" : "blocked"}`, () => {
    const r = check([place(name, "0900-a-session.md", fixture)]);
    if (expect === "pass") assert.equal(r.rc, 0, `${name} — expected PASS, got BLOCK`);
    else assert.notEqual(r.rc, 0, `${name} — expected BLOCK, got PASS`);
  });
}

// ─── F6 / F7 / F8: the body follows journal-entry.md ────────────────────
//
// Session-named files, so every session check runs. `assertBody` also reads
// the check's stderr for the check id and the words the message must carry —
// a refusal that names the wrong rule sends the writer to the wrong fix.

const FM = `---
date: 2026-09-23
time: "12:00"
slug: one-off (a session)
project: null
---

### one-off (a session)
**Action:** shipped

One line.
`;

function assertBody(name: string, expect: "pass" | "block", body: string, ...needles: string[]): void {
  test(`${name} ${expect === "pass" ? "passed" : "blocked"}`, () => {
    mkdirSync(join(TMP, name), { recursive: true });
    const path = join(TMP, name, "1200-a-session.md");
    // F9 binds sessions started from 2026-10-18 07:30; its cases start then.
    const fm = name.startsWith("f9-")
      ? FM.replace("date: 2026-09-23", "date: 2026-10-18").replace('time: "12:00"', 'time: "07:30"')
      : FM;
    writeFileSync(path, `${fm}\n${body}\n`);
    const r = check([path]);
    if (expect === "pass") {
      assert.equal(r.rc, 0, `${name} — expected PASS, got BLOCK:\n${r.out}`);
      return;
    }
    assert.notEqual(r.rc, 0, `${name} — expected BLOCK, got PASS`);
    for (const needle of needles) {
      assert.ok(r.out.includes(needle), `${name} — blocked, but the message lacks '${needle}':\n${r.out}`);
    }
  });
}

function f8Block(name: string, value: string, ...needles: string[]): void {
  test(`${name} blocked`, () => {
    mkdirSync(join(TMP, name), { recursive: true });
    const path = join(TMP, name, "1200-a-session.md");
    writeFileSync(
      path,
      `---\ndate: 2026-09-23\ntime: "12:00"\nslug: one-off (a session)\nroot_cause_status: ${value}\n---\n\n### one-off (a session)\n**Action:** fixed\n\nOne line.\n`,
    );
    const r = check([path]);
    assert.notEqual(r.rc, 0, `${name} — expected BLOCK, got PASS`);
    for (const needle of ["F8", value, ...needles]) {
      assert.ok(r.out.includes(needle), `${name} — blocked, but the message lacks '${needle}':\n${r.out}`);
    }
  });
}

// ─── Clean fixtures ──────────────────────────────────────────────────────

assertPasses(
  "single-session",
  `---
date: 2026-08-03
tags: [ai, telemetry]
sessions:
  - slug: one-off (weekly report triage)
    project: null
    root_cause_status: fixed
---

### one-off (weekly report triage)
**Action:** fixed

Body prose.`,
);

assertPasses(
  "multi-session",
  `---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (first)
    project: null
    root_cause_status: fixed
  - slug: ai/2026-08-03_second
    project: projects/ai/2026-08-03_second
    implement_audit_rounds: 2
    rules_should_have_fired: [no-guessing]
---

### one-off (first)
**Action:** fixed`,
);

// The nested list repeats target/branch/head_sha per entry by design. A key
// scan that ignored indent would call every one of these a duplicate.
assertPasses(
  "nested-runtime-identity",
  `---
date: 2026-08-03
tags: [portals]
sessions:
  - slug: one-off (portal ship)
    project: null
    root_cause_status: fixed
    runtime_identity:
      - target: "finance.example.com"
        branch: main
        head_sha: abc1234
        runtime: "CF Pages finance-example"
        rebuilt: yes
        duplicates_checked: n/a
        evidence: "deployment polled to success"
      - target: "sales.example.com"
        branch: main
        head_sha: def5678
        runtime: "CF Pages sales-example"
        rebuilt: yes
        duplicates_checked: n/a
        evidence: "deployment polled to success"
  - slug: one-off (after the nested block)
    project: null
---

### one-off (portal ship)
**Action:** shipped`,
);

// A slug with no fields at all is legal — plenty of sessions carry only a slug.
assertPasses(
  "slug-only-entries",
  `---
date: 2026-08-03
tags: [misc]
sessions:
  - slug: one-off (a)
  - slug: one-off (b)
---

### one-off (a)
**Action:** investigated`,
);

// `---` as a markdown horizontal rule in the body must not read as frontmatter.
assertPasses(
  "body-horizontal-rules",
  `---
date: 2026-08-03
tags: [misc]
sessions:
  - slug: one-off (a)
    project: null
---

### one-off (a)
**Action:** investigated

---

Some prose after a rule.

---`,
);

// Corruption 1: a concurrent session appended its whole frontmatter block
// mid-file. A reader reads only the first and drops this session.
assertBlocks(
  "second-frontmatter-block",
  `---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (first)
    project: null
---

### one-off (first)
**Action:** fixed

Body prose.

---
date: 2026-08-03
tags: [finance]
sessions:
  - slug: finance/2026-08-03_second
    project: projects/finance/2026-08-03_second
    root_cause_status: n/a
---

### finance/2026-08-03_second
**Action:** shipped`,
);

// Corruption 2: a foreign `- slug:` landed between a slug and its fields, so the
// fields re-parented onto the intruder, which then carried two `project:` keys.
assertBlocks(
  "split-entry-duplicate-key",
  `---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (mine)
  - slug: ai/2026-08-03_theirs
    project: ai/2026-08-03_theirs
    project: null
    implement_audit_rounds: 11
    root_cause_status: fixed
---

### one-off (mine)
**Action:** fixed`,
);

// The same split seen from the orphaned end: fields with no slug above them.
assertBlocks(
  "orphaned-fields-before-slug",
  `---
date: 2026-08-03
tags: [ai]
sessions:
    project: null
    root_cause_status: fixed
  - slug: one-off (first)
---

### one-off (first)
**Action:** fixed`,
);

assertBlocks(
  "duplicate-nested-block-key",
  `---
date: 2026-08-03
tags: [portals]
sessions:
  - slug: one-off (portal ship)
    runtime_identity:
      - target: "finance.example.com"
        branch: main
    runtime_identity:
      - target: "sales.example.com"
        branch: main
---

### one-off (portal ship)
**Action:** shipped`,
);

// F4. Two `tags:` keys in ONE block: YAML keeps the second, so `billing` here is
// discarded with no error anywhere, and F1 does not see it — its counters are
// `date:` and `sessions:` only.
assertBlocks(
  "duplicate-top-level-tags",
  `---
date: 2026-08-03
tags: [ai, billing]
tags: [ai, sales]
sessions:
  - slug: one-off (first)
---

### one-off (first)
**Action:** fixed`,
);

// The same key at column 0 in the BODY is not a duplicate — the frontmatter
// closed at the second `---`, and F4 must not reach past it.
assertPasses(
  "body-line-looks-like-a-key",
  `---
date: 2026-08-03
tags: [ai]
sessions:
  - slug: one-off (first)
---

### one-off (first)
**Action:** fixed

tags: this is prose, not frontmatter`,
);

assertBlocks(
  "no-frontmatter",
  `### one-off (no frontmatter)
**Action:** fixed

Body prose only.`,
);

assertSession(
  "f5-slug-matches-heading",
  "pass",
  `---
date: 2026-09-13
time: 09:00
slug: one-off (a session)
project: null
---

### one-off (a session)

**Action:** land the thing`,
);

assertSession(
  "f5-slug-disagrees-with-heading",
  "block",
  `---
date: 2026-09-13
time: 09:00
slug: one-off (a session)
---

### one-off (a different session)

**Action:** land the thing`,
);

assertSession(
  "f5-no-slug-key",
  "block",
  `---
date: 2026-09-13
time: 09:00
---

### one-off (a session)`,
);

assertSession(
  "f5-recorded-slug-does-not-count",
  "block",
  `---
date: 2026-09-13
time: 09:00
recorded_slug: one-off (the old name)
---

### one-off (a session)`,
);

assertSession(
  "f5-quoted-slug-matches-heading",
  "pass",
  `---
date: 2026-09-13
time: 09:00
slug: "one-off (scorecard: support satisfaction)"
---

### one-off (scorecard: support satisfaction)`,
);

assertSession(
  "f5-quoted-slug-disagrees",
  "block",
  `---
date: 2026-09-13
time: 09:00
slug: "one-off (scorecard: something else)"
---

### one-off (scorecard: support satisfaction)`,
);

assertBody(
  "f7-prose-bullet",
  "block",
  `**Decisions:**
- Chose X because Y.`,
  "F7",
  "1200-a-session.md:14",
  "neither a link nor a `rejected:` line",
);

assertBody(
  "f7-link-only",
  "pass",
  `**Decisions:**
- [0001-example-decision](../../projects/web/2026-01-10_checkout-flow/decisions/0001-example-decision.md)`,
);

assertBody(
  "f7-link-only-trailing-space",
  "pass",
  `**Decisions:**
- [spec 009 § Clarifications](../../projects/ai/x/specs/009-journal-schema/spec.md)   `,
);

assertBody(
  "f7-link-with-reasoning",
  "block",
  `**Decisions:**
- [x](decisions/0001-x.md) because y`,
  "F7",
  ":14",
);

assertBody(
  "f7-rejected",
  "pass",
  `**Decisions:**
- rejected: firing a live run now — the kernel update reboots the host`,
);

assertBody(
  "f7-rejected-500-chars",
  "pass",
  `**Decisions:**
- rejected: ${"x".repeat(490)}`,
);

// Characters, not bytes: 500 characters with an em-dash are 502 bytes, and a
// byte count would refuse this line on every platform.
assertBody(
  "f7-rejected-500-chars-with-em-dash",
  "pass",
  `**Decisions:**
- rejected: a — ${"x".repeat(486)}`,
);

// "rejected: " is 10 characters; 490 x's make exactly 500 after the "- ".
assertBody(
  "f7-rejected-501-chars",
  "block",
  `**Decisions:**
- rejected: ${"x".repeat(491)}`,
  "F7",
  "500",
);

assertBody(
  "f7-wrapped-bullet",
  "block",
  `**Decisions:**
- rejected: a long option — with a reason that
  wraps onto a second line`,
  "F7",
  ":15",
  "one line",
);

assertBody(
  "f7-two-good-one-bad",
  "block",
  `**Decisions:**
- [a](decisions/0001-a.md)
- Chose X because Y.
- rejected: b — c`,
  "F7",
  ":15",
);

assertBody(
  "f7-empty-decisions",
  "pass",
  `**Decisions:**

**Lessons:**
- nothing under Decisions is fine`,
);

// ─── F9: a Blocked bullet is an act or a wait, never an open decision ───
//
// A close can land with "waiting on the user's go-ahead for an infrastructure
// change" under Blocked; the auto-close gate says a question is asked and the
// run halts (auto-close-gate.md precondition (iii)), so that bullet refuses.

assertBody(
  "f9-act",
  "pass",
  `**Blocked:**
- act: send the drafted reply to the vendor on EXAMPLE-001`,
);

assertBody(
  "f9-wait",
  "pass",
  `**Blocked:**
- wait: the supplier's quotes, requested 2026-10-05`,
);

assertBody(
  "f9-untyped",
  "block",
  `**Blocked:**
- The reply to the vendor waits on the user to send it.`,
  "F9",
  "1200-a-session.md:14",
  "act:",
);

assertBody(
  "f9-decide",
  "block",
  `**Blocked:**
- decide: one dashboard dispatch per push, or a GitHub spending limit`,
  "F9",
  "open decision",
  "halt",
);

assertBody(
  "f9-go-ahead-in-an-act",
  "block",
  `**Blocked:**
- act: switching the build cache to a new host touches the deploy path; waiting on the user's go-ahead for an infrastructure change.`,
  "F9",
  "go-ahead",
);

assertBody(
  "f9-whether-in-a-wait",
  "block",
  `**Blocked:**
- wait: whether to send another reminder to the old mailing list`,
  "F9",
  "whether",
);

assertBody(
  "f9-question-mark",
  "block",
  `**Blocked:**
- act: keep the threshold and label more samples, or move it?`,
  "F9",
);

assertBody(
  "f9-one-bad-of-three",
  "block",
  `**Blocked:**
- act: press Send on the R2 newsletter
- R3: the user decides whether every subscriber gets the newsletter.
- wait: the client signing the proposal`,
  "F9",
  ":15",
);

assertBody(
  "f9-wait-on-someone-elses-answer",
  "pass",
  `**Blocked:**
- wait: the vendor's answer on the failing webhook, asked on EXAMPLE-001`,
);

assertBody(
  "f9-user-approval-in-an-act",
  "block",
  `**Blocked:**
- act: the user approves turning on the stricter spam filter for the support inbox`,
  "F9",
  "approves",
);

// Review round 1 of the F9 change: three more shapes.
assertBody(
  "f9-user-ok",
  "block",
  `**Blocked:**
- wait: infrastructure work needs the user’s OK`,
  "F9",
  "OK",
);

assertBody(
  "f9-pick-between",
  "block",
  `**Blocked:**
- act: the user picks between a larger email plan and a shorter mailing list`,
  "F9",
  "picks",
);

assertBody(
  "f9-vendor-sign-off-and-a-url",
  "pass",
  `**Blocked:**
- wait: the vendor's sign-off on the design, sent 2026-10-17
- act: open https://dash.cloudflare.com/?to=/:account/workers and press Retry build`,
);

assertBody(
  "f9-vendor-approval",
  "pass",
  `**Blocked:**
- wait: the vendor's approval of the API quota increase, due 2026-10-24`,
);

assertBody(
  "f9-inline-on-the-label-line",
  "block",
  `**Blocked:** - wait: whether to send another reminder`,
  "F9",
  "whether",
);

// An act is the user's own, so its decision words need no name; and a
// code span holding a URL does not swallow the prose after it.
assertBody(
  "f9-imperative-decide-in-an-act",
  "block",
  `**Blocked:**
- act: decide between a larger email plan and a shorter mailing list`,
  "F9",
  "decide",
);

assertBody(
  "f9-url-in-a-code-span",
  "block",
  "**Blocked:**\n- wait: open `https://example.com/` after the user decides between `Pro` and `Free`",
  "F9",
  "decides",
);

// A session started before F9 landed keeps its old shape: FM is 2026-09-23, and
// an entry started at 06:00 the morning F9 began was written under the old rule.
test("a session started at 06:00 on the day F9 landed passes untyped", () => {
  mkdirSync(join(TMP, "f9-before-0730"), { recursive: true });
  const path = join(TMP, "f9-before-0730", "0600-a-session.md");
  const fm = FM.replace("date: 2026-09-23", "date: 2026-10-18").replace('time: "12:00"', 'time: "06:00"');
  writeFileSync(path, `${fm}\n**Blocked:**\n- the test device's reset button needs a physical press — the user's hands.\n`);
  const r = check([path]);
  assert.equal(r.rc, 0, r.out);
});

// An entry written before F9 keeps its old shape (FM is dated 2026-09-23).
assertBody(
  "before-f9-untyped-blocked",
  "pass",
  `**Blocked:**
- R3: the user decides whether every subscriber gets the newsletter.`,
);

assertBody(
  "f9-empty-blocked",
  "pass",
  `**Blocked:**
`,
);

assertBody(
  "f7-no-decisions",
  "pass",
  `**Changes:**
- a change, with the small choice that explains it`,
);

assertBody(
  "f7-only-first-section-is-checked",
  "pass",
  `**Decisions:**
- rejected: a — b

**Lessons:**
- Chose X because Y is a fine Lessons bullet`,
);

// Fenced code is quoted text, not the entry's own sections.
assertBody(
  "f7-f6-inside-fence",
  "pass",
  `**Changes:**
- quoted an old entry:

\`\`\`markdown
**Next:**
- follow up

**Decisions:**
- Chose X because Y.
\`\`\`

- and a tilde fence too:

~~~
**Issues:**
~~~`,
);

assertBody(
  "f7-unclosed-fence-runs-to-eof",
  "pass",
  `**Changes:**
- an unclosed fence

\`\`\`
**Next:**
**Decisions:**
- Chose X because Y.`,
);

assertBody(
  "f6-next",
  "block",
  `**Next:**
- follow up later`,
  "F6",
  ":13",
  "Next",
  "ROADMAP.md",
  "Blocked",
);

assertBody(
  "f6-issues",
  "block",
  `**Issues:**
- the thing was broken`,
  "F6",
  "Issues",
  "Findings",
);

assertBody(
  "f6-one-off-label",
  "block",
  `**Verification:**
- ran it`,
  "F6",
  "Verification",
);

assertBody(
  "f6-all-eight",
  "pass",
  `**Changes:**
- a

**Findings:**
- b — \`grep -n b file\`

**Decisions:**
- rejected: c — d

**Corrections:**
- "e"

**Lessons:**
- f

**Blocked:**
- g

**Root-Cause Status:** fixed — h`,
);

assertBody(
  "f6-bold-lead-in-bullet",
  "pass",
  `**Changes:**
- **The nightly run was dead.** Restarted.
- **Bold lead.** text`,
);

// The same labels in a day file are the day's business, not a session's.
assertPasses(
  "f6-f8-day-file-skipped",
  `---
date: 2026-09-23
tags: [ai]
root_cause_status: partial
sessions:
  - slug: one-off (first)
---

**Next:**
- whatever the day file says

**Decisions:**
- Chose X because Y.`,
);

for (const v of ["fixed", "unknown-pending-verification", "deferred-by-user-directive", "n/a"]) {
  assertSession(
    `f8-${v}`,
    "pass",
    `---
date: 2026-09-23
time: "12:00"
slug: one-off (a session)
root_cause_status: ${v}
---

### one-off (a session)
**Action:** fixed

One line.`,
  );
}

assertSession(
  "f8-quoted-value",
  "pass",
  `---
date: 2026-09-23
time: "12:00"
slug: one-off (a session)
root_cause_status: "n/a"
---

### one-off (a session)
**Action:** fixed

One line.`,
);

f8Block("f8-addressed", "addressed", "unknown-pending-verification");

f8Block("f8-retired-deferred-with-project", "deferred-with-project");

f8Block("f8-value-with-a-tail", "fixed — projects/x/report.md");

f8Block("f8-partial", "partial");

assertBody(
  "f8-absent-key-passes",
  "pass",
  `**Changes:**
- no root_cause_status key at all`,
);

// ─── The lists the check compares against are journal-entry.md's ────────
//
// The check carries copies of the section set and the root_cause_status
// values rather than parsing a markdown table at every close. This case is what
// keeps the copies honest: the schema file is the definition, and a change to
// either list without the other fails here.

const SCHEMA = join(SCRIPT_DIR, "../references/journal-entry.md");

test("section set matches journal-entry.md", () => {
  const schema = readFileSync(SCHEMA, "utf8").split("\n");
  const start = schema.findIndex((l) => /^### Section set/.test(l));
  const labels: string[] = [];
  if (start >= 0) {
    for (let i = start; i < schema.length; i++) {
      const l = schema[i] ?? "";
      const m = /^\| `\*\*([A-Za-z -]+):\*\*` \|.*$/.exec(l);
      if (m?.[1]) labels.push(m[1]);
      if (i > start && /^\*\*Retired/.test(l)) break;
    }
  }
  const schemaLabels = labels.join("|");
  const scriptLabels = /^const SECTION_LABELS = "(.*)";$/m.exec(readFileSync(CHECK, "utf8"))?.[1] ?? "";
  assert.ok(
    schemaLabels !== "" && schemaLabels === scriptLabels,
    `section set — journal-entry.md says '${schemaLabels}', the check says '${scriptLabels}'`,
  );
});

test("root_cause_status values match journal-entry.md", () => {
  const schema = readFileSync(SCHEMA, "utf8").split("\n");
  const at = schema.findIndex((l) => l.includes("- **`root_cause_status:`** — optional; when present, one of"));
  const next = at >= 0 ? (schema[at + 1] ?? "") : "";
  const schemaValues = (next.match(/`[^`]*`/g) ?? []).map((v) => v.replace(/`/g, "")).join("|");
  const scriptValues = /^const ROOT_CAUSE_VALUES = "(.*)";$/m.exec(readFileSync(CHECK, "utf8"))?.[1] ?? "";
  assert.ok(
    schemaValues !== "" && schemaValues === scriptValues,
    `root_cause_status values — journal-entry.md says '${schemaValues}', the check says '${scriptValues}'`,
  );
});

// ─── Default (staged) path ───────────────────────────────────────────────

function git(...args: string[]): void {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function setupRepo(dir: string): void {
  mkdirSync(join(dir, "journal"), { recursive: true });
  git("-C", dir, "init", "-q");
  git("-C", dir, "config", "user.email", "test@example.com");
  git("-C", dir, "config", "user.name", "Test");
}

test("default-path blocked staged corrupt journal", () => {
  const dir = join(TMP, "repo-bad");
  setupRepo(dir);
  mkdirSync(join(dir, "journal/2026-08-03"), { recursive: true });
  copyFileSync(join(TMP, "second-frontmatter-block/0000-day.md"), join(dir, "journal/2026-08-03/0000-day.md"));
  git("-C", dir, "add", "journal/2026-08-03/0000-day.md");
  assert.notEqual(check([], { cwd: dir }).rc, 0, "default-path — expected BLOCK on staged corrupt journal");
});

// A git that cannot read the index is not "nothing staged". Read through a
// process substitution the failure listed nothing and the check exited 0, so a
// close's journal gate passed over an entry it never read.
test("default-path fails when git cannot read the index", () => {
  const dir = join(TMP, "repo-failgit");
  const bin = join(TMP, "failgit-bin");
  setupRepo(dir);
  mkdirSync(join(dir, "journal/2026-08-03"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(TMP, "second-frontmatter-block/0000-day.md"), join(dir, "journal/2026-08-03/0000-day.md"));
  git("-C", dir, "add", "journal/2026-08-03/0000-day.md");
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash\ncase " $* " in *" --cached "*) exit 128 ;; esac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const r = check([], { cwd: dir, env: { ...ENV, PATH: `${bin}:${process.env.PATH ?? ""}` } });
  assert.notEqual(r.rc, 0, "default-path passed with an unreadable index");
});

// The index copy is what commits, at any size. Read into a buffer with Node's
// default 1 MiB cap, a larger staged journal failed to read and the check fell
// back to the working copy — so corruption staged before an unstaged repair
// passed.
test("default-path reads a staged journal past 1 MiB from the index", () => {
  const dir = join(TMP, "repo-big");
  setupRepo(dir);
  mkdirSync(join(dir, "journal/2026-08-03"), { recursive: true });
  const file = join(dir, "journal/2026-08-03/0000-day.md");
  const filler = "Filler prose that pads the day record past the buffer cap.\n".repeat(24_000);
  writeFileSync(file, `${readFileSync(join(TMP, "second-frontmatter-block/0000-day.md"), "utf8")}\n${filler}`);
  git("-C", dir, "add", "journal/2026-08-03/0000-day.md");
  writeFileSync(file, `${readFileSync(join(TMP, "nested-runtime-identity/0000-day.md"), "utf8")}\n${filler}`);
  assert.equal(check([file], { cwd: dir }).rc, 0, "(the repaired working copy passes on its own)");
  assert.notEqual(check([], { cwd: dir }).rc, 0, "a staged corrupt journal past 1 MiB passed");
});

// A staged file the index cannot hand back is a failure, never a quiet fall
// back to the working copy.
test("default-path fails when a staged journal cannot be read from the index", () => {
  const dir = join(TMP, "repo-failshow");
  const bin = join(TMP, "failshow-bin");
  setupRepo(dir);
  mkdirSync(join(dir, "journal/2026-08-03"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(TMP, "nested-runtime-identity/0000-day.md"), join(dir, "journal/2026-08-03/0000-day.md"));
  git("-C", dir, "add", "journal/2026-08-03/0000-day.md");
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash\n[ "$1" = show ] && { echo "fatal: index unreadable" >&2; exit 128; }\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const r = check([], { cwd: dir, env: { ...ENV, PATH: `${bin}:${process.env.PATH ?? ""}` } });
  assert.notEqual(r.rc, 0, "a staged journal the index could not hand back passed");
  assert.match(r.out, /journal\/2026-08-03\/0000-day\.md/, "…and the failure names the file");
});

// A name git C-quotes without -z ("caf\303\251") failed the journal-path
// pattern, so a staged corrupt journal with an accent in its slug was never
// scanned and the gate passed.
test("default-path blocks a staged corrupt journal whose name git would quote", () => {
  const dir = join(TMP, "repo-quoted");
  setupRepo(dir);
  mkdirSync(join(dir, "journal/2026-08-03"), { recursive: true });
  copyFileSync(join(TMP, "second-frontmatter-block/0000-day.md"), join(dir, "journal/2026-08-03/0900-café.md"));
  git("-C", dir, "add", "journal/2026-08-03/0900-café.md");
  const r = check([], { cwd: dir });
  assert.notEqual(r.rc, 0, "a staged corrupt journal/2026-08-03/0900-café.md passed unscanned");
  assert.match(r.out, /0900-café\.md/, "…and the block names the file as it is on disk");
});

test("default-path passed clean staged journal", () => {
  const dir = join(TMP, "repo-clean");
  setupRepo(dir);
  mkdirSync(join(dir, "journal/2026-08-03"), { recursive: true });
  copyFileSync(join(TMP, "nested-runtime-identity/0000-day.md"), join(dir, "journal/2026-08-03/0000-day.md"));
  git("-C", dir, "add", "journal/2026-08-03/0000-day.md");
  assert.equal(check([], { cwd: dir }).rc, 0, "default-path — expected PASS on clean staged journal");
});

test("default-path correctly ignored non-journal file", () => {
  const dir = join(TMP, "repo-other");
  setupRepo(dir);
  copyFileSync(join(TMP, "second-frontmatter-block/0000-day.md"), join(dir, "notes.md"));
  git("-C", dir, "add", "notes.md");
  assert.equal(check([], { cwd: dir }).rc, 0, "default-path scanned a non-journal file");
});

// A leftover `journal/<date>.md` is not this check's business either: the split
// removed every one of them, and a new one is a reader's failure to catch, not
// a frontmatter shape.
test("default-path ignored a legacy day file", () => {
  const dir = join(TMP, "repo-legacy");
  setupRepo(dir);
  copyFileSync(join(TMP, "second-frontmatter-block/0000-day.md"), join(dir, "journal/2026-08-03.md"));
  git("-C", dir, "add", "journal/2026-08-03.md");
  assert.equal(check([], { cwd: dir }).rc, 0, "default-path scanned a legacy day file");
});

// ─── Real-repo regression: the 30 most recent session entries must be clean ─
//
// The records are in the same repo as these scripts, so this case runs on every
// test run from a workbench that has a journal (and is skipped where there is
// none, as in the template repo). Session files are `HHMM-<slug>.md` under a day folder; a `0000-` file is the
// day's own record and outside the section checks.

const top = spawnSync("git", ["-C", SCRIPT_DIR, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
const REPO_ROOT = top.status === 0 ? top.stdout.trim() : "";
const JOURNAL = join(REPO_ROOT, "journal");
if (REPO_ROOT !== "" && existsSync(JOURNAL)) {
  const real: string[] = [];
  for (const day of readdirSync(JOURNAL, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    for (const f of readdirSync(join(JOURNAL, day.name), { recursive: true, encoding: "utf8" })) {
      const base = f.slice(f.lastIndexOf("/") + 1);
      if (base.endsWith(".md") && !base.startsWith("0000-")) real.push(join(JOURNAL, day.name, f));
    }
  }
  real.sort();
  const last = real.slice(-30);
  if (last.length > 0) {
    test(`last ${last.length} real journals pass`, () => {
      const r = check(last);
      assert.equal(r.rc, 0, `real journals tripped the check:\n${r.out}`);
    });
  }
}

// A harness may reach every skill script through a symlink (a skills folder
// linked into the harness home), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "check-journal-entry.ts");
  symlinkSync(CHECK, link);
  writeFileSync(join(dir, "bad.md"), "no front matter\n");
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", link, join(dir, "bad.md")], {
    encoding: "utf8",
    env: ENV,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 1, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /no 'date:' key/);
});

// ─── F10: an entry states that nothing is left to ask ──────────────────
//
// A close can hold four items for the user, write them into its report as
// "waiting on the user" and into the journal as a `rejected:` line, then ask
// them below the close's last line. F9 and check-roadmap-decisions read only the two places a
// question had been parked before; prose anywhere else escaped. F10 makes the
// sweep an assertion every entry carries.

function f10(name: string, fmExtra: string | null, date = "2026-10-19", time = "15:11") {
  mkdirSync(join(TMP, name), { recursive: true });
  const path = join(TMP, name, "1200-a-session.md");
  const fm = FM.replace("date: 2026-09-23", `date: ${date}`)
    .replace('time: "12:00"', `time: "${time}"`)
    .replace("project: null\n", `project: null\n${fmExtra === null ? "" : `${fmExtra}\n`}`);
  writeFileSync(path, fm);
  return check([path]);
}

test("f10: open_items: none passes", () => {
  const r = f10("f10-none", "open_items: none");
  assert.equal(r.rc, 0, r.out);
});

test("f10: a missing open_items blocks, naming the rule and the halt", () => {
  const r = f10("f10-missing", null);
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F10"), r.out);
  assert.ok(r.out.includes("open_items"), r.out);
  assert.ok(r.out.includes("halt"), r.out);
});

test("f10: an open_items listing anything blocks", () => {
  const r = f10("f10-listed", 'open_items: "4 asked in the reply"');
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F10"), r.out);
  assert.ok(r.out.includes("4 asked in the reply"), r.out);
});

test("f10: an entry started before F10 landed keeps its shape", () => {
  const r = f10("f10-before", null, "2026-10-19", "15:10");
  assert.equal(r.rc, 0, r.out);
});

// ─── F11: no line leaves something waiting on the user's answer ─────────
// F10 is an assertion; F11 reads the entry for the parked question itself,
// wherever it was written (the round-1 review of F10, 2026-10-19).

function f11(name: string, body: string) {
  mkdirSync(join(TMP, name), { recursive: true });
  const path = join(TMP, name, "1200-a-session.md");
  const fm = FM.replace("date: 2026-09-23", "date: 2026-10-19")
    .replace('time: "12:00"', 'time: "15:11"')
    .replace("project: null\n", "project: null\nopen_items: none\n");
  writeFileSync(path, `${fm}\n${body}\n`);
  return check([path]);
}

// ─── F12: nothing under Blocked waits on the user ───────────────────────
// A close means the work is done: a step for the user's hands keeps the
// session open, so no `- act:` rides a close, and a
// `- wait:` is a check set for a future date or it is not a wait.

function f12(name: string, body: string, date = "2026-12-01", time = "12:00") {
  mkdirSync(join(TMP, name), { recursive: true });
  const path = join(TMP, name, "1200-a-session.md");
  const fm = FM.replace("date: 2026-09-23", `date: ${date}`)
    .replace('time: "12:00"', `time: "${time}"`)
    .replace("project: null\n", "project: null\nopen_items: none\n");
  writeFileSync(path, `${fm}\n${body}\n`);
  return check([path]);
}

test("f12: an act for the user blocks, and says the session stays open", () => {
  const r = f12("f12-act", "**Blocked:**\n- act: send the drafted reply to the client");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F12") && r.out.includes("stays open until they have done it"), r.out);
});

test("f12: a wait needs a date on or after the entry's", () => {
  for (const [name, line, needle] of [
    ["f12-undated", "- wait: the vendor's reply", "no date"],
    ["f12-past", "- wait: 2026-10-01 the vendor's reply", "already past"],
    ["f12-code-span", "- wait: see `2099-01-01`", "no date"],
    ["f12-not-a-day", "- wait: 2099-99-99 x", "no date"],
    ["f12-long-digits", "- wait: 2099-01-010 x", "no date"],
    ["f12-names-user", "- wait: 2099-01-01 the user sends the drafted reply", "waits on them"],
  ] as const) {
    const r = f12(name, `**Blocked:**\n${line}`);
    assert.notEqual(r.rc, 0, name);
    assert.ok(r.out.includes("F12") && r.out.includes(needle), `${name}: ${r.out}`);
  }
});

test("f12: a wait dated the entry's own day, or later, passes", () => {
  for (const [name, line] of [
    ["f12-same-day", "- wait: 2026-12-01 the vendor's quote"],
    ["f12-later", "- wait: the vendor's quote, due 2027-01-15"],
  ] as const) {
    const r = f12(name, `**Blocked:**\n${line}`);
    assert.equal(r.rc, 0, `${name}: ${r.out}`);
  }
});

test("f12: an untyped bullet is offered only the wait shape", () => {
  const r = f12("f12-untyped", "**Blocked:**\n- the vendor");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("- wait: <YYYY-MM-DD>"), r.out);
  assert.ok(!r.out.includes("- act:"), r.out);
});

test("f12: no Blocked section passes", () => {
  const r = f12("f12-none", "**Changes:**\n- a change");
  assert.equal(r.rc, 0, r.out);
});

test("f12: an entry started before F12 keeps F9's act line", () => {
  const r = f12("f12-before", "**Blocked:**\n- act: send the drafted reply to the client", "2026-10-20", "12:00");
  assert.equal(r.rc, 0, r.out);
});

test("f12: the Next and F11 messages no longer offer an act line", () => {
  const next = f12("f12-next", "**Next:**\n- something");
  assert.ok(next.out.includes("F6") && !next.out.includes("- act:") && !next.out.includes("**Blocked:**"), next.out);
  const parked = f12("f12-parked", "**Findings:**\n- waiting on the user for the colour palette");
  assert.ok(parked.out.includes("F11") && !parked.out.includes("- act:"), parked.out);
});

test("f11: a rejected: line parked on the user blocks", () => {
  const r = f11(
    "f11-rejected",
    "**Decisions:**\n- rejected: the footer fix — waiting for the user to decide whether to widen it",
  );
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F11") && r.out.includes("waiting for the user"), r.out);
});

test("f11: a Findings line parked on the user blocks", () => {
  const r = f11("f11-findings", "**Findings:**\n- the changelog runs long; the user to decide — `wc -c`");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F11"), r.out);
});

test("f11: the user's own words under Corrections, and an act under Blocked, pass", () => {
  const r = f11(
    "f11-ok",
    '**Corrections:**\n- "stop waiting on the user for that"\n\n**Blocked:**\n- act: send the drafted reply to the client',
  );
  assert.equal(r.rc, 0, r.out);
});

test("f11: a wait on your approval, written as a possessive, blocks", () => {
  const r = f11("f11-possessive", "**Findings:**\n- the footer change is pending your approval");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F11") && r.out.includes("pending your"), r.out);
});

test("f11: wording on the label line itself blocks", () => {
  const r = f11("f11-inline", "**Changes:** waiting on the user to decide the footer");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F11"), r.out);
});

test("f9: a Blocked wait worded as waiting on the user blocks", () => {
  const r = f11("f9-parked-wait", "**Blocked:**\n- wait: the user to confirm the vendor");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F9") && r.out.includes("confirm"), r.out);
});

test("f9: an act worded as waiting on the user to do it passes", () => {
  const r = f11("f9-act-waiting", "**Blocked:**\n- act: waiting on the user to send the drafted message");
  assert.equal(r.rc, 0, r.out);
});

test("f9: an act that is really the user's decision blocks", () => {
  const r = f11("f9-act-confirm", "**Blocked:**\n- act: the user to confirm the vendor");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F9") && r.out.includes("confirm"), r.out);
});

test("f9: an act that waits for the user's ruling blocks", () => {
  const r = f11("f9-act-rules", "**Blocked:**\n- act: wait until the user rules on the vendor");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F9"), r.out);
});

test("f9: an act that is a Confirm click passes", () => {
  const r = f11("f9-act-click-confirm", "**Blocked:**\n- act: click Confirm in the email verification screen");
  assert.equal(r.rc, 0, r.out);
});

test("f9: an act to confirm which option is a decision", () => {
  const r = f11("f9-act-confirm-which", "**Blocked:**\n- act: confirm which vendor to use");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F9"), r.out);
});

test("f9: an act to confirm a choice blocks, without naming the user", () => {
  const r = f11("f9-act-confirm-bare", "**Blocked:**\n- act: confirm the vendor");
  assert.notEqual(r.rc, 0);
  assert.ok(r.out.includes("F9"), r.out);
});

// "confirm" and the parked-wait wording reached Blocked with F10, so an entry
// started before F10 landed is read with F9's words alone.
test("f9: before F10 landed, an act to confirm and a wait on the user keep F9's words", () => {
  mkdirSync(join(TMP, "f9-pre-f10"), { recursive: true });
  const path = join(TMP, "f9-pre-f10", "1200-a-session.md");
  const fm = FM.replace("date: 2026-09-23", "date: 2026-10-19").replace('time: "12:00"', 'time: "15:10"');
  writeFileSync(
    path,
    `${fm}\n**Blocked:**\n- act: the user confirms the old staging site is switched off\n- wait: the user to confirm the vendor\n`,
  );
  const r = check([path]);
  assert.equal(r.rc, 0, r.out);
});
