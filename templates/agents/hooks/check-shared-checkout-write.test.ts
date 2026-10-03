// Tests for check-shared-checkout-write.sh.
//
// Run: node --test --experimental-strip-types templates/agents/hooks/check-shared-checkout-write.test.ts
//
// Hermetic. HOME, the guarded checkout, write-root.sh and thread.ts are all
// fixtures, so nothing here reads a live repo or creates a real worktree. The
// hook stays bash (the harness fires it as a hook command); this suite SPAWNS
// it with `bash`, one payload per assertion.
//
// Both directions matter and they are NOT symmetric. A missed refusal leaves a
// file in a shared checkout that no close will commit, and one the close-time
// backstop catches only sometimes. A wrongly-refused
// write stops the session dead, and a guard that refuses
// `node --experimental-strip-types <skills>/close/scripts/verify.ts` — a command that only NAMES a guarded
// path — gets turned off, after which it guards nothing. So the allow cases
// below are as load-bearing as the refuse cases.
//
// The cases run in file order (node:test runs top-level tests sequentially),
// and the order is load-bearing: the git fixture for the untracked-delete
// cases is built partway down, in a `before` of its own section, exactly where
// the old bash suite built it.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "check-shared-checkout-write.sh");
assert.ok(existsSync(HOOK), `hook not found at ${HOOK}`);

const FIX = mkdtempSync(join(tmpdir(), "shared-write-test-"));
after(() => rmSync(FIX, { recursive: true, force: true }));

// HOME is the fixture root so `$HOME/.agents/skills` really is the home link
// into the checkout's .agents/skills/ — the unexpanded-tilde case below is about a path
// the hook must expand itself, and it can only be written honestly if that
// spelling reaches a guarded root through the link the harnesses read.
const WORKBENCH = join(FIX, "checkouts/workbench");
const RECORDS = WORKBENCH;
const SKILLS = join(WORKBENCH, ".agents/skills");
const WORKTREE = join(FIX, "worktrees/workbench/thread-1");
for (const d of [join(SKILLS, "close/scripts"), WORKBENCH, WORKTREE, join(FIX, ".agents")]) {
  mkdirSync(d, { recursive: true });
}
symlinkSync(SKILLS, join(FIX, ".agents/skills"));

// ── The two scripts the hook shells out to, stubbed ───────────────────────
// Every `--main` question is logged: the one repo is asked about once, and a
// hook still asking about the retired skills and library checkouts would spend
// a bounded wait on each answer that cannot come.
const WR = join(FIX, "write-root.sh");
const WR_LOG = join(FIX, "write-root-calls.log");
writeFileSync(
  WR,
  `#!/usr/bin/env bash
if [ "\${1:-}" = "--main" ]; then
  printf '%s\\n' "\${2:-}" >> '${WR_LOG}'
  printf '%s\\n' '${WORKBENCH}'
  exit 0
fi
printf '%s\\n' '${WORKTREE}'
`,
);

// thread.ts is TypeScript and the hook runs it with node, so its stand-ins are
// TypeScript too: a bash stub here would be a parse error.
const TH = join(FIX, "thread.ts");
writeFileSync(TH, 'process.stdout.write("thread-1");\n');

const NO_THREAD = join(FIX, "no-thread.ts");
writeFileSync(NO_THREAD, "process.exitCode = 1;\n");

// write-root.sh that never answers, for the degrade case.
const HUNG = join(FIX, "hung-write-root.sh");
writeFileSync(
  HUNG,
  `#!/usr/bin/env bash
if [ "\${1:-}" = "--main" ]; then
  printf '%s\\n' '${WORKBENCH}'
  exit 0
fi
sleep 30
`,
);

for (const f of [WR, TH, NO_THREAD, HUNG]) chmodSync(f, 0o755);

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: FIX,
  CHECK_SHARED_WRITE_ROOT_SCRIPT: WR,
  CHECK_SHARED_WRITE_THREAD_SCRIPT: TH,
  // 1s, not 20s: the degrade case asserts the bound exists, and asserting it at
  // its production value would cost 20s of wall clock on every run of this suite.
  CHECK_SHARED_WRITE_TIMEOUT: "1",
};

// ── Harness ───────────────────────────────────────────────────────────────
type Env = Record<string, string>;

function hook(payload: unknown, env: Env = {}): { status: number | null; stdout: string } {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout };
}

function runTool(tool: string, input: unknown, env: Env = {}): number | null {
  return hook({ tool_name: tool, tool_input: input, cwd: FIX }, env).status;
}

function runBash(command: string, cwd = FIX): number | null {
  return hook({ tool_name: "Bash", tool_input: { command }, cwd }).status;
}

const fp = (p: string) => ({ file_path: p });

function pathRefuses(label: string, tool: string, input: unknown) {
  test(label, () => assert.equal(runTool(tool, input), 2, `${label} — wanted exit 2`));
}
function pathAllows(label: string, tool: string, input: unknown) {
  test(label, () => assert.equal(runTool(tool, input), 0, `${label} — wanted exit 0`));
}
function bashRefuses(label: string, command: string, cwd = FIX) {
  test(label, () => assert.equal(runBash(command, cwd), 2, `${label} — wanted exit 2`));
}
function bashAllows(label: string, command: string, cwd = FIX) {
  test(label, () => assert.equal(runBash(command, cwd), 0, `${label} — wanted exit 0`));
}

// ── The guarded checkout: a skill, a record, a code file ──────────────────
pathRefuses("Edit under .agents/skills/", "Edit", fp(join(SKILLS, "close/SKILL.md")));

// ── One repo, asked about once ────────────────────────────────────────────
// The guarded root is the hook's own repo, resolved through `--main` on the
// hook's directory — one resolver call per write, each with a bounded wait,
// not one per folder the checkout holds.
test("one --main question, about the hook's own repo", () => {
  const asked = existsSync(WR_LOG) ? readFileSync(WR_LOG, "utf8").split("\n").filter(Boolean) : [];
  assert.deepEqual(asked, [dirname(HOOK)], `one --main question — got ${asked.length}: ${asked.join(" ")}`);
});
pathRefuses("Edit of a record in the checkout", "Edit", fp(join(RECORDS, "journal/2026-09-16/0000-x.md")));
pathRefuses("Edit in the code checkout", "Edit", fp(join(WORKBENCH, "apps/web/x/README.md")));

// ── The same relative path under a worktree is the whole point ────────────
pathAllows("Edit in this thread's worktree", "Edit", fp(join(WORKTREE, "close/SKILL.md")));
pathAllows("Edit somewhere else entirely", "Edit", fp(join(FIX, "scratch/note.md")));

// ── The other write tools ─────────────────────────────────────────────────
pathRefuses("Write in a guarded checkout", "Write", fp(join(SKILLS, "new.sh")));
pathRefuses("MultiEdit in a guarded checkout", "MultiEdit", fp(join(SKILLS, "close/scripts/verify.ts")));
// NotebookEdit names its target `notebook_path`. A guard reading only
// `file_path` lets every notebook write through.
pathRefuses("NotebookEdit via notebook_path", "NotebookEdit", { notebook_path: join(SKILLS, "nb.ipynb") });
pathAllows("Read is not a write", "Read", fp(join(SKILLS, "close/SKILL.md")));

// ── An unexpanded tilde is how a quoted path reaches a hook ───────────────
// Without the expansion the path is under no guarded root and the guard fails
// open silently — the identical literal-tilde defect that broke
// a test in the author skill.
pathRefuses("unexpanded ~/ path", "Edit", fp("~/.agents/skills/close/SKILL.md"));

// ── One case per promised Bash write form ─────────────────────────────────
bashRefuses("> redirection", `echo hi > ${SKILLS}/f`);
bashRefuses(">> redirection", `echo hi >> ${SKILLS}/f`);
bashRefuses("tee", `echo hi | tee ${SKILLS}/f`);
bashRefuses("tee -a", `echo hi | tee -a ${SKILLS}/f`);
bashRefuses("sed -i", `sed -i 's/a/b/' ${SKILLS}/f`);
bashRefuses("sed -i -e", `sed -i -e 's/a/b/' ${SKILLS}/f`);
bashRefuses("cp destination", `cp /tmp/a ${SKILLS}/f`);
bashRefuses("mv destination", `mv /tmp/a ${SKILLS}/f`);
bashRefuses("ln -s destination", `ln -s /tmp/a ${SKILLS}/f`);
bashRefuses("install destination", `install -m 644 /tmp/a ${SKILLS}/f`);
bashRefuses("rm", `rm -rf ${SKILLS}/close`);
bashRefuses("mkdir", `mkdir -p ${SKILLS}/newdir`);
bashRefuses("touch", `touch ${SKILLS}/f`);

// The SOURCE of a copy is a read, not a write.
bashAllows("cp out of a checkout", `cp ${SKILLS}/f /tmp/a`);

// ── Two targets, only the second guarded ──────────────────────────────────
bashRefuses("second target guarded", `touch /tmp/ok ${SKILLS}/f`);
bashRefuses("guarded write after an innocent one", `echo a > /tmp/ok; echo b > ${RECORDS}/f`);

// ── A relative target after a directory change ───────────────────────────
bashRefuses("cd then touch", `cd ${SKILLS} && touch f`);
bashRefuses("cd with a tilde", "cd ~/.agents/skills && touch f");
bashRefuses("cd then redirect", `cd ${RECORDS} && echo x > notes.md`);
bashAllows("cd elsewhere then touch", "cd /tmp && touch f");
// An unresolvable `cd` makes every later relative target unknowable, and
// unknowable fails OPEN — see the hook's KNOWN-and-DECLINED list. The
// unexpanded `$SOMEWHERE` is the INPUT under test.
bashAllows("cd to a variable, then a relative write", 'cd "$SOMEWHERE" && touch f');

// ── The false positive that would make the hook unusable ─────────────────
// Naming a guarded path is not writing to it. A guard that refused this would
// be turned off within the hour.
bashAllows(
  "running a script from a guarded checkout",
  `node --experimental-strip-types ${SKILLS}/close/scripts/verify.ts`,
);
bashAllows("reading a file in a guarded checkout", `cat ${SKILLS}/close/SKILL.md`);
bashAllows("grepping a guarded checkout", `grep -rn foo ${SKILLS}`);
bashAllows("git in a guarded checkout", `git -C ${SKILLS} status --porcelain`);
bashAllows("cd into a guarded checkout and read", `cd ${SKILLS} && ls -la`);
bashAllows("a sed WITHOUT -i is a read", `sed -n '1,5p' ${SKILLS}/f`);
bashAllows("not a write at all", "npm test");
bashAllows("an empty command", "");

// ── Found by the machine reviewer, round 1 ───────────────────────────────
//
// Six bypasses and one false block, every one of them reproduced against the
// hook before it was fixed. Four shared a single cause — the parser deleted
// quote CHARACTERS instead of consuming quoted SPANS — and the fix was to give
// lib/shell-segments.sh a tagged tokenizer both hooks now use.

// A quoted path is ONE word. Deleting the quotes split it at its space and
// handed the caller `file` as the destination, which is under no guarded root.
bashRefuses("a quoted destination with a space", `cp /tmp/a "${SKILLS}/my file"`);
bashRefuses("a single-quoted target with a space", `touch '${SKILLS}/my file'`);
bashRefuses("an escaped space in the target", `touch ${SKILLS}/my\\ file`);

// The mirror, and the reason the tokenizer had to be quote-AWARE rather than
// quote-blind in the other direction: a `>` inside quotes is prose. Refusing
// these would make every doc edit and every commit message about redirection
// unwritable.
bashAllows("a redirection inside single quotes", `printf '%s' '> ${SKILLS}/f'`);
bashAllows("a redirection inside double quotes", `echo "write it with > ${SKILLS}/f"`);
bashAllows("a redirection named in a message", `git commit -m 'use > ${SKILLS}/f'`);

// A newline inside an open quote is not a segment break. Printing one segment
// per input line read the second line of a multiline string as a command.
bashAllows("a newline inside a quoted string", `echo "line one\nrm ${SKILLS}/close"`);

// The verb is the first word that is not a wrapper or an assignment.
bashRefuses("env wrapper", `env X=1 touch ${SKILLS}/f`);
bashRefuses("env with its own flag", `env -i PATH=/bin touch ${SKILLS}/f`);
bashRefuses("a leading assignment", `X=1 cp /tmp/a ${SKILLS}/f`);
bashRefuses("sudo wrapper", `sudo touch ${SKILLS}/f`);

// `-t` carries the destination and makes every operand a source; `install -d`
// makes every operand a directory to create. Reading only the last operand
// checked a SOURCE path and let both through.
bashRefuses("cp -t", `cp -t ${SKILLS} /tmp/a`);
bashRefuses("cp --target-directory", `cp --target-directory ${SKILLS} /tmp/a`);
bashRefuses("cp --target-directory=", `cp --target-directory=${SKILLS} /tmp/a`);
bashRefuses("mv -t", `mv -t ${SKILLS} /tmp/a`);
bashRefuses("install -d, first operand", `install -d ${SKILLS}/a /tmp/b`);

// The mirror: a flag argument that is NOT a destination must not be tested as
// one, or `install -m 644` checks `644` and never looks at the real target.
bashRefuses("install -m still finds the destination", `install -m 644 /tmp/a ${SKILLS}/f`);
bashRefuses("sed -i -e still finds the file", `sed -i -e 's/a/b/' ${SKILLS}/f`);
bashRefuses("touch -r still finds the file", `touch -r /tmp/ref ${SKILLS}/f`);
bashAllows("touch -r reference is not a target", `touch -r ${SKILLS}/ref /tmp/f`);

// A file descriptor is not an operand.
bashRefuses("fd-qualified redirection", `cmd 2> ${SKILLS}/f`);
bashAllows("a here-string is a read", `cat <<< "${SKILLS}/f"`);

// Everything after `--` is an operand whatever it looks like.
bashRefuses("a target after --", `rm -- ${SKILLS}/f`);

// ── Found by the machine reviewer, round 2 ───────────────────────────────
//
// Four more, all reproduced before they were fixed. Three were bypasses in the
// operand walk; the fourth was a false refusal on a command that only READS.

// An input redirection names a file being read. Leaving it among the operands
// refused `tee /tmp/out < <guarded>/input`, which writes nothing here.
bashAllows("an input redirection is a read", `tee /tmp/out < ${SKILLS}/input`);
bashAllows("an input redirection into a guarded-path read", `sort < ${SKILLS}/f > /tmp/out`);

// A file descriptor is ATTACHED to its `>`. Dropping any numeric word before a
// redirect lost the file literally named `2`.
bashRefuses("a file literally named 2", `cd ${SKILLS} && touch 2 > /tmp/log`);
bashAllows("an attached fd is still not an operand", "echo x 2> /tmp/log");

// A wrapper option that takes an argument must take it, or the argument
// becomes the verb and the real command is never looked at.
bashRefuses("sudo -u with a separate argument", `sudo -u root touch ${SKILLS}/f`);
bashRefuses("sudo -u with an attached argument", `sudo -uroot touch ${SKILLS}/f`);
bashRefuses("env -u before the verb", `env -u FOO touch ${SKILLS}/f`);

// An attached short-option argument, and a cluster whose argument-taking letter
// is not the last one.
bashRefuses("cp -t attached", `cp -t${SKILLS} /tmp/a`);
bashRefuses("cp -St cluster", `cp -St src ${SKILLS}/f`);
bashRefuses("install -m attached", `install -m644 /tmp/a ${SKILLS}/f`);

// The mirror: an attached argument that is NOT a destination must not be
// tested as one.
bashAllows("install -m attached mode is not a destination", `install -m${SKILLS} 644 /tmp/a /tmp/b`);

// ── Found by the machine reviewer, round 3 ───────────────────────────────

// A file descriptor is UNQUOTED digits touching the operator. Quoting makes it
// an ordinary filename, and dropping it there lost the write entirely.
bashRefuses("a quoted 2 is a filename, not an fd", `cd ${SKILLS} && touch "2">/tmp/log`);
bashRefuses("an escaped 2 is a filename too", `cd ${SKILLS} && touch 2\\>/tmp/log`);
bashAllows("an unquoted attached fd is still an fd", "echo x 2>/tmp/log");

// An INPUT descriptor is attached too. Leaving `0` as a word made it read as
// the command, so the real verb was never looked at.
bashRefuses("an attached input descriptor", `0</tmp/in touch ${SKILLS}/f`);

// Every wrapper option that consumes the next word, short and long.
bashRefuses("env -u", `env -u FOO touch ${SKILLS}/f`);
bashRefuses("env --unset", `env --unset FOO touch ${SKILLS}/f`);
bashRefuses("env --unset=", `env --unset=FOO touch ${SKILLS}/f`);
bashRefuses("env -S", `env -S x touch ${SKILLS}/f`);
bashRefuses("exec -a", `exec -a name touch ${SKILLS}/f`);
bashRefuses("sudo --user", `sudo --user root touch ${SKILLS}/f`);
bashRefuses("sudo --user=", `sudo --user=root touch ${SKILLS}/f`);
bashRefuses("stdbuf -o", `stdbuf -o L touch ${SKILLS}/f`);
bashRefuses("stdbuf --output", `stdbuf --output L touch ${SKILLS}/f`);

// The mirror: a wrapper option that takes NO argument must not eat the verb.
bashRefuses("env -i takes no argument", `env -i touch ${SKILLS}/f`);
bashRefuses("sudo -n takes no argument", `sudo -n touch ${SKILLS}/f`);

// ── A delete that removes only untracked content is not a write ──────────
// The hook exists to stop content landing in a shared checkout outside any
// ledger. Deleting a file git does not track lands nothing and leaves nothing
// for a close to miss — it makes the checkout CLEANER. A harness's skill sync
// can write `~/.claude/skills/synced/` (= the skills checkout through the
// symlink), and refusing its cleanup is the wrong outcome. Tracked content
// still refuses, and so does a root that is not a git repository at all — the distinction needs git's
// answer, and without one the old refusal stands.
const git = (...args: string[]) =>
  execFileSync("git", ["-C", RECORDS, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    stdio: "ignore",
  });

describe("a delete that removes only untracked content", () => {
  before(() => {
    git("init", "-q");
    git("config", "commit.gpgsign", "false");
    for (const d of ["journal/2026-09-18", "synced/bucket-1/docx", "gen"]) {
      mkdirSync(join(RECORDS, d), { recursive: true });
    }
    writeFileSync(join(RECORDS, "journal/2026-09-18/0000-x.md"), "tracked\n");
    writeFileSync(join(RECORDS, "gen/keep.md"), "tracked\n");
    writeFileSync(join(RECORDS, ".gitignore"), "*.log\n");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    writeFileSync(join(RECORDS, "synced/bucket-1/docx/SKILL.md"), "copied\n");
    writeFileSync(join(RECORDS, "stray.txt"), "stray\n");
    writeFileSync(join(RECORDS, "gen/out.log"), "noise\n");
  });

  bashAllows("rm of an untracked directory", `rm -rf ${RECORDS}/synced`);
  bashAllows("rm of an untracked file", `rm ${RECORDS}/stray.txt`);
  bashAllows("rm of a gitignored file", `rm ${RECORDS}/gen/out.log`);
  bashAllows("rm of a path that does not exist", `rm -f ${RECORDS}/nothing-here`);
  bashRefuses("rm of a tracked file", `rm ${RECORDS}/journal/2026-09-18/0000-x.md`);
  bashRefuses("rm of a directory holding tracked content", `rm -rf ${RECORDS}/gen`);
  bashRefuses("rm of the checkout itself", `rm -rf ${RECORDS}`);
  bashRefuses("rm mixing tracked and untracked", `rm ${RECORDS}/stray.txt ${RECORDS}/gen/keep.md`);
  // Only rm gets the carve-out: creating an untracked file is exactly the failure.
  bashRefuses("touch of an untracked path is still a write", `touch ${RECORDS}/new-stray.txt`);
});

// ── Removing a SYMLINK is not a write to what it points at ───────────────
// A link in a harness home that points into this checkout is removed without
// touching the checkout: removing it unlinks an entry in that home. Resolving
// the leaf would charge the delete to the target, and every harness home holds
// links like it, so a refusal there would be a whole class, not one path.
//
// The PARENT is still resolved, because a link entry lives in a directory and
// that directory is what the delete writes to.
describe("removing a symlink", () => {
  before(() => {
    mkdirSync(join(FIX, "linkfarm"), { recursive: true });
    symlinkSync(join(RECORDS, "journal/2026-09-18/0000-x.md"), join(FIX, "linkfarm/tracked-link"));
    symlinkSync(join(RECORDS, "journal"), join(FIX, "linkfarm/journal-link"));
  });
  bashAllows("rm of a symlink that points at tracked content", `rm ${FIX}/linkfarm/tracked-link`);
  bashRefuses("rm THROUGH a symlinked parent still refuses", `rm ${FIX}/linkfarm/journal-link/2026-09-18/0000-x.md`);
});

describe("removing a tracked symlink", () => {
  before(() => {
    symlinkSync("journal/2026-09-18/0000-x.md", join(RECORDS, "tracked-self-link"));
    git("add", "-A");
    git("commit", "-q", "-m", "link-fixture");
  });
  bashRefuses("rm of a TRACKED symlink inside a guarded checkout still refuses", `rm ${RECORDS}/tracked-self-link`);
});

// ── A session's worktree INSIDE the checkout is not the checkout ─────────
// Claude Code's and Gemini CLI's session worktrees live under the checkout
// (.claude/worktrees/<id>, .gemini/worktrees/<id> — harness.sh), so a prefix
// test alone refuses every write a session makes in its own worktree. A
// repository nested in the checkout that is NOT one of its worktrees still is
// the checkout's folder, and still refuses.
describe("a worktree inside the checkout", () => {
  const INNER = join(RECORDS, ".claude/worktrees/s1");
  const NESTED = join(RECORDS, "vendor-clone");
  before(() => {
    git("worktree", "add", "-q", "-b", "session/s1", INNER);
    mkdirSync(NESTED, { recursive: true });
    execFileSync("git", ["-C", NESTED, "init", "-q"], { stdio: "ignore" });
  });
  pathAllows("Write into a linked worktree under .claude/worktrees/", "Write", fp(join(INNER, "projects/x/README.md")));
  bashAllows("a redirect into a linked worktree under the checkout", `echo x > ${INNER}/notes.md`);
  pathRefuses("Write beside it, in the checkout itself, still refuses", "Write", fp(join(RECORDS, "projects/x/README.md")));
  pathRefuses("Write into a nested repo that is not a worktree still refuses", "Write", fp(join(NESTED, "f.md")));
});

// ── A write that reaches no guarded checkout creates nothing ──────────────
//
// thread.ts --id records a session (a cache entry per thread) as a side effect.
// The guard used to ask it before looking at where the write lands, so every
// `2>/dev/null` made a session entry. It is asked only once a target is inside
// a guarded checkout.
const TH_LOG = join(FIX, "thread-calls.log");
const LOGGING_TH = join(FIX, "logging-thread.ts");
writeFileSync(
  LOGGING_TH,
  `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(TH_LOG)}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("thread-1");
`,
);
chmodSync(LOGGING_TH, 0o755);

function threadCalls(command: string): number {
  writeFileSync(TH_LOG, "");
  hook({ tool_name: "Bash", tool_input: { command }, cwd: FIX }, { CHECK_SHARED_WRITE_THREAD_SCRIPT: LOGGING_TH });
  return readFileSync(TH_LOG, "utf8").split("\n").filter(Boolean).length;
}
function expectCalls(want: number, label: string, command: string) {
  test(label, () => assert.equal(threadCalls(command), want, `${label} — wanted ${want} thread.ts call(s)`));
}
expectCalls(0, "2>/dev/null asks nothing of the session", "grep x /etc/hosts 2>/dev/null");
expectCalls(0, "> /dev/null asks nothing of the session", "echo x > /dev/null");
expectCalls(0, ">/dev/stderr asks nothing of the session", "echo x >/dev/stderr");
expectCalls(0, ">/dev/stdout asks nothing of the session", "echo x >/dev/stdout");
expectCalls(0, "a write outside every checkout asks nothing", `echo x > ${FIX}/scratch/out.txt`);
expectCalls(1, "a write into the shared checkout still asks", `echo x > ${SKILLS}/f`);

// ── Degrading, and failing open ──────────────────────────────────────────
// write-root.sh that never answers: the hook still REFUSES, and does it inside
// the bound rather than hanging the session for the duration of the flock.
describe("a hung write-root", () => {
  let rc: number | null = null;
  let elapsed = 0;
  before(() => {
    const started = Date.now();
    rc = runTool("Edit", fp(join(SKILLS, "f")), { CHECK_SHARED_WRITE_ROOT_SCRIPT: HUNG });
    elapsed = (Date.now() - started) / 1000;
  });
  test("a hung write-root still refuses", () => assert.equal(rc, 2));
  test("the refusal is bounded", () => assert.ok(elapsed <= 10, `the refusal is bounded — took ${elapsed}s`));
});

// No thread means no worktree to offer, and write-root.sh exits 2 in that case
// by design. A plain terminal must stay able to write.
test("no thread fails open", () =>
  assert.equal(runTool("Edit", fp(join(SKILLS, "f")), { CHECK_SHARED_WRITE_THREAD_SCRIPT: NO_THREAD }), 0));

// A checkout whose resolution fails is simply unguarded for this invocation —
// a resolver failure never becomes a blanket refusal.
const BROKEN = join(FIX, "broken-write-root.sh");
writeFileSync(BROKEN, "#!/usr/bin/env bash\nexit 2\n");
chmodSync(BROKEN, 0o755);
test("every resolution failing is not a blanket refusal", () =>
  assert.equal(runTool("Edit", fp(join(SKILLS, "f")), { CHECK_SHARED_WRITE_ROOT_SCRIPT: BROKEN }), 0));

// ── The other two harnesses ───────────────────────────────────────────────
//
// Every case here is RED against a hook that reads `.tool_name` alone: a Codex
// `apply_patch` matches no branch and an Antigravity payload leaves at the
// empty-TOOL check having examined no path, so all eight refusals below come
// back exit 0 — guarded-looking and guarding nothing.

// Codex: the tool is named `apply_patch` and the paths live in the patch body.
function runCodexPatch(patch: string, cwd = FIX): number | null {
  return hook({ tool_name: "apply_patch", tool_input: { command: patch }, cwd }).status;
}
function codexRefuses(label: string, patch: string, cwd = FIX) {
  test(label, () => assert.equal(runCodexPatch(patch, cwd), 2, `${label} — wanted exit 2`));
}
function codexAllows(label: string, patch: string, cwd = FIX) {
  test(label, () => assert.equal(runCodexPatch(patch, cwd), 0, `${label} — wanted exit 0`));
}

codexRefuses(
  "codex apply_patch — Add File",
  `*** Begin Patch
*** Add File: ${RECORDS}/journal/2026-09-18/new.md
+hello
*** End Patch`,
);

codexRefuses(
  "codex apply_patch — Update File",
  `*** Begin Patch
*** Update File: ${SKILLS}/qa/SKILL.md
@@
-old
+new
*** End Patch`,
);

codexRefuses(
  "codex apply_patch — Delete File",
  `*** Begin Patch
*** Delete File: ${WORKBENCH}/apps/x.ts
*** End Patch`,
);

codexRefuses(
  "codex apply_patch — Move to (the DESTINATION is the write)",
  `*** Begin Patch
*** Update File: ${FIX}/scratch/a.md
*** Move to: ${RECORDS}/knowledge/a.md
*** End Patch`,
);

// One patch, many files. Reading only the first is the whole reason this walks
// every verb line: here the first file is outside every guarded root.
codexRefuses(
  "codex apply_patch — only the SECOND file is in a shared checkout",
  `*** Begin Patch
*** Add File: ${FIX}/scratch/safe.md
+fine
*** Update File: ${SKILLS}/close/scripts/land.ts
@@
-x
+y
*** End Patch`,
);

// Envelope paths may be relative; they resolve against the normalized cwd.
codexRefuses(
  "codex apply_patch — relative path under a guarded cwd",
  `*** Begin Patch
*** Add File: journal/2026-09-18/rel.md
+hello
*** End Patch`,
  RECORDS,
);

codexAllows(
  "codex apply_patch outside every guarded checkout",
  `*** Begin Patch
*** Add File: ${FIX}/scratch/ok.md
+fine
*** End Patch`,
);

// A known write tool that yields no path is a broken parser, not a safe call.
codexRefuses(
  "codex apply_patch naming no file refuses rather than fails open",
  `*** Begin Patch
@@
+orphan hunk
*** End Patch`,
);

// Antigravity: `toolCall`, camelCase, and a JSON verdict on stdout. The exit
// code is ignored there, so asserting on it would pass while the model was told
// nothing — these helpers read stdout, which is the channel that decides.
function runAgy(call: unknown, cwd = FIX): string {
  return hook({ toolCall: call, workspacePaths: [cwd], conversationId: "c", stepIdx: 1 }).stdout;
}
const agyWrite = (name: string, p: string) => ({ name, args: { TargetFile: p } });
const agyCmd = (c: string) => ({ name: "run_command", args: { CommandLine: c } });

function agyDenies(label: string, call: unknown, cwd = FIX) {
  test(label, () => {
    const out = runAgy(call, cwd);
    let decision: unknown;
    try {
      decision = JSON.parse(out)?.decision;
    } catch {
      decision = undefined;
    }
    assert.equal(decision, "deny", `${label} — wanted a deny decision on stdout, got '${out.slice(0, 60)}'`);
  });
}
function agyAllows(label: string, call: unknown, cwd = FIX) {
  // Silence, not `{}`: `{}` is a DENY there (decision is required), so a guard
  // that printed it on the pass path would block every call it approved.
  test(label, () => {
    const out = runAgy(call, cwd);
    assert.equal(out, "", `${label} — wanted silence, got '${out.slice(0, 60)}'`);
  });
}

agyDenies(
  "antigravity write_to_file into a shared checkout",
  agyWrite("write_to_file", `${RECORDS}/journal/2026-09-18/agy.md`),
);
agyDenies(
  "antigravity replace_file_content into a shared checkout",
  agyWrite("replace_file_content", `${SKILLS}/qa/SKILL.md`),
);
agyDenies("antigravity run_command writing by shell redirection", agyCmd(`printf x > ${WORKBENCH}/stray.txt`));
agyDenies("antigravity write_to_file with no TargetFile refuses", {
  name: "write_to_file",
  args: { CodeContent: "x" },
});
agyAllows("antigravity write outside every guarded checkout", agyWrite("write_to_file", `${FIX}/scratch/agy-ok.md`));
agyAllows("antigravity view_file is not a write", {
  name: "view_file",
  args: { AbsolutePath: `${RECORDS}/journal/x.md` },
});

// Cwd comes from args.Cwd when present, and only then from workspacePaths[0].
agyDenies(
  "antigravity relative redirection resolves against args.Cwd",
  { name: "run_command", args: { CommandLine: "printf x > stray.txt", Cwd: RECORDS } },
  join(FIX, "scratch"),
);

// ── Grok Build ────────────────────────────────────────────────────────────
//
// Grok's payload is camelCase: `toolName` and `toolInput`, its shell tool is
// `run_terminal_command` and its file writes are `write` / `search_replace`
// with `toolInput.file_path` (read from a live grok 1.0.41 PreToolUse payload).
// A deny is exit 2 with the reason on stderr, as for Claude Code.
function runGrok(toolName: string, toolInput: unknown, cwd = FIX): number | null {
  return hook({ hook_event_name: "PreToolUse", toolName, toolInput, cwd }).status;
}
function grokExpects(want: number, label: string, toolName: string, toolInput: unknown) {
  test(label, () => assert.equal(runGrok(toolName, toolInput), want, `${label} — wanted exit ${want}`));
}
grokExpects(2, "grok write into a shared checkout", "write", fp(`${SKILLS}/grok.md`));
grokExpects(2, "grok search_replace into a shared checkout", "search_replace", fp(`${SKILLS}/close/SKILL.md`));
grokExpects(2, "grok run_terminal_command writing by redirection", "run_terminal_command", {
  command: `printf x > ${WORKBENCH}/stray.txt`,
});
grokExpects(2, "grok write with no file_path refuses", "write", { content: "x" });
grokExpects(0, "grok write outside every guarded checkout", "write", fp(`${FIX}/scratch/grok-ok.md`));
grokExpects(0, "grok read_file is not a write", "read_file", fp(`${SKILLS}/close/SKILL.md`));

// `..` after a symlink is taken from the link's TARGET, as the kernel does:
// ~/.agents/skills/.. is the checkout's .agents/, not ~/.agents.
pathRefuses(
  "a write through a home link and then .. into the checkout",
  "Write",
  fp(`${FIX}/.agents/skills/../AGENTS.md`),
);

// ── Gemini CLI ────────────────────────────────────────────────────────────
//
// Gemini CLI's BeforeTool payload is Claude's snake_case shape with its own tool
// names: `run_shell_command`, `write_file` and `replace`, each file tool with
// `tool_input.file_path` (read from @google/gemini-cli-core 0.61.0; not run).
pathRefuses("gemini write_file into a shared checkout", "write_file", fp(`${SKILLS}/gemini.md`));
pathRefuses("gemini replace into a shared checkout", "replace", fp(`${SKILLS}/close/SKILL.md`));
pathRefuses("gemini run_shell_command writing by redirection", "run_shell_command", {
  command: `printf x > ${WORKBENCH}/stray.txt`,
});
pathAllows("gemini write_file outside every guarded checkout", "write_file", fp(`${FIX}/scratch/gemini-ok.md`));

// ── Dispatch: the manifests must actually ROUTE these tools here ──────────
//
// A correct parser behind a matcher that never fires guards nothing, and that
// failure is invisible from every case above — they all call the hook directly.
// These read the real manifests and check the regex, which is the only thing
// standing between the payload and this script.
// In this repo the manifests sit beside the hooks: claude-hooks.json (Claude
// Code and Codex read this shape) and ../hooks.json (Antigravity's), which
// install.sh renders into the workbench and the harness homes.
const MANIFEST_DIR = HERE;
const SELF = "check-shared-checkout-write.sh";

type Group = { matcher?: string; hooks?: { command: string }[] };
const routes = (g: Group) => (g.hooks ?? []).some((h) => h.command.includes(SELF));

// The Claude/Codex shape: { hooks: { PreToolUse: [group…] } }; Gemini CLI's is
// the same with BeforeTool for its event.
function matchersFor(manifest: string, event = "PreToolUse"): string[] {
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  return ((m.hooks?.[event] ?? []) as Group[]).filter(routes).map((g) => g.matcher ?? "");
}
// The Antigravity shape: { <spec>: { PreToolUse: [group…] } }.
function agyMatchersFor(manifest: string): string[] {
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  const out: string[] = [];
  for (const spec of Object.values(m) as { PreToolUse?: Group[] }[]) {
    for (const g of spec?.PreToolUse ?? []) if (routes(g)) out.push(g.matcher ?? "");
  }
  return out;
}

function dispatches(label: string, tool: string, matchers: () => string[]) {
  test(label, () => {
    const hit = matchers().some((mx) => mx !== "" && new RegExp(`^(${mx})$`).test(tool));
    assert.ok(hit, `${label} — no matcher in the manifest matches '${tool}'`);
  });
}

const CLAUDE_MANIFEST = join(MANIFEST_DIR, "claude-hooks.json");
const AGY_MANIFEST = join(MANIFEST_DIR, "..", "hooks.json");
const GEMINI_MANIFEST = join(MANIFEST_DIR, "..", "gemini-settings.json");

if (existsSync(CLAUDE_MANIFEST)) {
  const mx = () => matchersFor(CLAUDE_MANIFEST);
  dispatches("manifest routes Codex apply_patch to this guard", "apply_patch", mx);
  dispatches("manifest still routes Claude Write to this guard", "Write", mx);
  dispatches("manifest still routes Claude Bash to this guard", "Bash", mx);
  dispatches("manifest routes Grok's write to this guard", "write", mx);
  dispatches("manifest routes Grok's search_replace to this guard", "search_replace", mx);
  dispatches("manifest routes Grok's run_terminal_command to this guard", "run_terminal_command", mx);
} else {
  console.error(`note: ${CLAUDE_MANIFEST} not found, skipping dispatch check`);
}

// The Gemini manifest ships beside hooks.json, so its absence is a failure, not
// a skip.
test("the gemini manifest exists", () => assert.ok(existsSync(GEMINI_MANIFEST), `${GEMINI_MANIFEST} not found`));
if (existsSync(GEMINI_MANIFEST)) {
  const mx = () => matchersFor(GEMINI_MANIFEST, "BeforeTool");
  dispatches("gemini manifest routes write_file here", "write_file", mx);
  dispatches("gemini manifest routes replace here", "replace", mx);
  dispatches("gemini manifest routes run_shell_command here", "run_shell_command", mx);
}

if (existsSync(AGY_MANIFEST)) {
  const mx = () => agyMatchersFor(AGY_MANIFEST);
  dispatches("agy manifest routes write_to_file here", "write_to_file", mx);
  dispatches("agy manifest routes replace_file_content here", "replace_file_content", mx);
  dispatches("agy manifest routes run_command here", "run_command", mx);
} else {
  console.error(`note: ${AGY_MANIFEST} not found, skipping agy dispatch check`);
}
