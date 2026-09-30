// Rows for install.sh: the harness question and what each answer wires (home
// links, hook merges, per-tool settings), the offer to install a missing tool,
// the Claude Code version floor, the upgrades from v6 and v7 (what they left
// behind is removed only when it is still ours), the AGENTS.md block merge,
// decisions/README.md seeding, tests left out of the install, and a machine
// without Node. Each row installs into a fresh temp target, with a HOME of its
// own, laid out the way the row needs.
//
// install.sh stays bash (it is the `curl … | bash` installer), so every row
// spawns `bash install.sh`. Tools are stubbed on PATH ($STUB first, then this
// test's own node, then only the running bash's folder and /usr/bin:/bin), and
// HOME is a temp dir, so nothing real is detected or installed: `curl` is a
// stub that logs the URL it was asked for. Variables that point a tool at a
// home of its own (T3CODE_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, …) are removed
// from the environment for the same reason. jq must be installed (the hook
// merge needs it). The v6 SPEC template and the v7 installer come from this
// repo's v6.0.0 and v7.0.0 tags, so run it from a clone that has its tags.
//
// A row that fails does not stop the others: each test collects its rows and
// fails once, naming every row that did not hold.
//
// Run: node --experimental-strip-types --test install.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const HERE = import.meta.dirname;
const INSTALL = join(HERE, "install.sh");
const TMP = mkdtempSync(join(tmpdir(), "install-test-"));
let V7_WORKTREE = "";
after(() => {
  if (V7_WORKTREE) spawnSync("git", ["-C", HERE, "worktree", "remove", "--force", V7_WORKTREE]);
  rmSync(TMP, { recursive: true, force: true });
});

// ── the harness ──────────────────────────────────────────────────────────

/** What `$(...)` keeps: all but the trailing newlines. */
const chomp = (s: string): string => s.replace(/\n+$/, "");

const BASH = chomp(spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout) || "/bin/bash";
// The running bash's own folder too: scripts that call `bash` by name must find
// it where it is (/usr/local/bin in a container), not only in /bin.
const BASH_DIR = dirname(BASH);

const STUB = join(TMP, "stub");
// The node running this test, and only it, so the installer's TypeScript steps
// run on the Node version under test.
const NODEBIN = join(TMP, "nodebin");
mkdirSync(STUB, { recursive: true });
mkdirSync(NODEBIN, { recursive: true });
symlinkSync(process.execPath, join(NODEBIN, "node"));
const PATH = `${STUB}:${NODEBIN}:${BASH_DIR}:/usr/bin:/bin`;

const CURL_LOG = join(TMP, "curl.log");
writeFileSync(CURL_LOG, "");
// A curl that installs nothing: it logs the URL and hands the shell a no-op.
writeFileSync(
  join(STUB, "curl"),
  `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "$a" >>"${CURL_LOG}" ;; esac; done\necho "echo stub-installed"\n`,
);
chmodSync(join(STUB, "curl"), 0o755);
// gh: logs every `repo create` it is asked for, and is logged in only while
// $TMP/gh-authed exists.
const GH_LOG = join(TMP, "gh.log");
const GH_AUTHED = join(TMP, "gh-authed");
writeFileSync(GH_LOG, "");
writeFileSync(
  join(STUB, "gh"),
  `#!/bin/sh
case "$1 $2" in
  "auth status") [ -e "${GH_AUTHED}" ] ;;
  "repo create") echo "$*" >>"${GH_LOG}" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(STUB, "gh"), 0o755);
/** A claude that reports that version. */
function stubClaude(version: string): void {
  writeFileSync(join(STUB, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(join(STUB, "claude"), 0o755);
}

/** A PATH folder mirroring /usr/bin and /bin without the named tools, with the
 * running bash (BASH_DIR may be /usr/bin, which has them) and, unless node is
 * one of those left out, this test's node. */
function pathWithout(name: string, ...tools: string[]): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  for (const bin of ["/usr/bin", "/bin"]) {
    let names: string[] = [];
    try {
      names = readdirSync(bin);
    } catch {
      continue;
    }
    for (const f of names) {
      if (tools.includes(f) || lexists(join(dir, f))) continue;
      symlinkSync(join(bin, f), join(dir, f));
    }
  }
  rmSync(join(dir, "bash"), { force: true });
  symlinkSync(BASH, join(dir, "bash"));
  if (!tools.includes("node")) {
    rmSync(join(dir, "node"), { force: true });
    symlinkSync(process.execPath, join(dir, "node"));
  }
  return dir;
}
const NOJQ = pathWithout("nojq", "jq");
const NONODE = pathWithout("nonode", "node", "nodejs");

// The environment every child gets: this one, less the variables that point a
// tool at a home of its own, with HOME and PATH ours and a git identity for the
// first commit the installer makes in a new workbench.
const HOME_VARS = /^(T3CODE_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_.*|GROK_.*|XDG_CONFIG_HOME|GIT_CONFIG_.*|CONTEXTIUM_.*)$/;
let HOME = join(TMP, "home");
mkdirSync(HOME, { recursive: true });
function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!HOME_VARS.test(k)) e[k] = v;
  Object.assign(e, {
    HOME,
    PATH,
    GIT_AUTHOR_NAME: "Pat Doe",
    GIT_AUTHOR_EMAIL: "pat@example.com",
    GIT_COMMITTER_NAME: "Pat Doe",
    GIT_COMMITTER_EMAIL: "pat@example.com",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
}

const OUT = join(TMP, "out");
/** The last install's stdout and stderr, as `>"$TMP/out" 2>&1` wrote them. */
let out = "";
type Run = { input?: string; env?: Record<string, string | undefined>; script?: string };
/** `bash install.sh <args>` (or another installer), both streams into $TMP/out. Returns its status. */
function install(args: string[], o: Run = {}): number {
  const fd = openSync(OUT, "w");
  try {
    const r = spawnSync(BASH, [o.script ?? INSTALL, ...args], {
      env: env(o.env),
      input: o.input ?? "",
      stdio: ["pipe", fd, fd],
      timeout: 600_000,
    });
    return r.status ?? 1;
  } finally {
    closeSync(fd);
    out = readFileSync(OUT, "utf8");
  }
}

/** Run a command with the rows' environment; its stdout as `$(...)` gives it. */
function run(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { env: env(o.env), cwd: o.cwd, encoding: "utf8", timeout: 600_000 });
  return { status: r.status ?? 1, stdout: chomp(r.stdout ?? ""), stderr: r.stderr ?? "" };
}
const git = (...args: string[]) => run("git", args);
/** `$(jq … 2>/dev/null)`. */
const jq = (...args: string[]): string => run("jq", args).stdout;
/** `jq <filter> <file> >tmp && cp tmp <file>`. */
function jqEdit(filter: string, file: string): void {
  const r = run("jq", [filter, file]);
  if (r.status === 0) writeFileSync(file, `${r.stdout}\n`);
}
const guardsIn = (file: string): string =>
  jq("-r", '[.hooks.PreToolUse[]?.hooks[]?.command | select(startswith(": contextium;"))] | length', file);

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function readlink(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "";
  }
}
/** `$(cat <file> 2>/dev/null)`. */
function cat(p: string): string {
  try {
    return chomp(readFileSync(p, "utf8"));
  } catch {
    return "";
  }
}
function lines(p: string): string[] {
  try {
    return readFileSync(p, "utf8").split("\n");
  } catch {
    return [];
  }
}
/** grep -qF */
const fileHas = (p: string, s: string): boolean => lines(p).some((l) => l.includes(s));
/** grep -qxF */
const fileHasLine = (p: string, s: string): boolean => lines(p).includes(s);
/** grep -c <regex> */
const countLines = (p: string, re: RegExp): string => String(lines(p).filter((l) => re.test(l)).length);
/** sed -n 's/^<key>=//p' */
const field = (p: string, key: string): string =>
  lines(p)
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1))
    .join("\n");
/** sed -i '/^<key>=/d' */
function dropField(p: string, key: string): void {
  writeFileSync(p, lines(p).filter((l) => !l.startsWith(`${key}=`)).join("\n"));
}
/** cmp -s */
function same(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}
/** `cksum <file | awk '{print $1, $2}'` */
function cksum(p: string): string {
  const r = spawnSync("cksum", { input: readFileSync(p), encoding: "utf8" });
  return r.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
}
function write(p: string, body: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
const tail = (s: string, k: number): string => chomp(s).split("\n").slice(-k).join("\n");

/** The rows of one test: each failed row is kept, and the test fails once, naming them all. */
class Rows {
  failed: string[] = [];
  bad(msg: string): void {
    this.failed.push(msg);
  }
  check(cond: boolean, msg: string): void {
    if (!cond) this.bad(msg);
  }
  is(name: string, got: string, want: string): void {
    if (got !== want) this.bad(`${name} — want [${want}] got [${got}]`);
  }
  hasOut(name: string, s: string): void {
    if (!out.split("\n").some((l) => l.includes(s))) this.bad(`${name} — output lacks: ${s}`);
  }
  lacksOut(name: string, s: string): void {
    if (out.split("\n").some((l) => l.includes(s))) this.bad(`${name} — output should not contain: ${s}`);
  }
  gone(name: string, rel: string): void {
    if (lexists(join(T, rel))) this.bad(`${name} — ${rel} is still there`);
  }
  there(name: string, rel: string): void {
    if (!lexists(join(T, rel))) this.bad(`${name} — ${rel} is missing`);
  }
  done(): void {
    assert.deepEqual(this.failed, [], `${this.failed.length} row(s) failed:\n${this.failed.join("\n")}`);
  }
}
function rows(fn: (r: Rows) => void): () => void {
  return () => {
    const r = new Rows();
    fn(r);
    r.done();
  };
}

let n = 0;
let T = "";
let H = "";
/** A new empty target and HOME, with the named folders made in the HOME. Sets T and H. */
function scratch(...homeDirs: string[]): void {
  n++;
  T = join(TMP, `t${n}`);
  H = join(TMP, `h${n}`);
  HOME = H;
  mkdirSync(T, { recursive: true });
  mkdirSync(H, { recursive: true });
  for (const d of homeDirs) mkdirSync(join(H, d), { recursive: true });
}
/** Install into a new empty git repo with a HOME of its own. Sets T and H; output in `out`. */
function fresh(...args: string[]): number {
  scratch();
  git("init", "-q", T);
  return install([T, "--yes", "--no-integrations", ...args]);
}
const rerun = (...args: string[]): number => install([T, "--yes", "--no-integrations", ...args]);

// The v6 SPEC template and a v7 checkout come from the tags. A run with no
// repository around it (a container) can hand them in instead:
//   CONTEXTIUM_V6_SPEC_LEAN=<file>  CONTEXTIUM_V7_SRC=<extracted v7.0.0 tree>
const V6_LEAN = join(TMP, "v6-spec-lean.md");
if (process.env.CONTEXTIUM_V6_SPEC_LEAN) {
  copyFileSync(process.env.CONTEXTIUM_V6_SPEC_LEAN, V6_LEAN);
} else {
  const r = spawnSync("git", ["-C", HERE, "show", "v6.0.0:templates/agents/templates/spec-lean.md"]);
  if (r.status !== 0) throw new Error("cannot read v6.0.0:templates/agents/templates/spec-lean.md — run from a clone with its tags");
  writeFileSync(V6_LEAN, r.stdout);
}

// ── the v6 SPEC template ─────────────────────────────────────────────────

/** A target with a v6 layer's leftovers. Sets T. */
function v6target(): void {
  n++;
  T = join(TMP, `t${n}`);
  HOME = join(TMP, `h${n}`);
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(T, ".agents/templates"), { recursive: true });
  mkdirSync(join(T, ".claude"), { recursive: true });
  copyFileSync(V6_LEAN, join(T, ".agents/templates/spec-lean.md"));
  symlinkSync("../.agents/templates", join(T, ".claude/templates"));
}
const installV6 = (): number => install([T, "--yes", "--no-integrations"]);

test(
  "the v6 SPEC template",
  rows((r) => {
    v6target();
    if (installV6() !== 0) r.bad(`install into a v6 target exited non-zero: ${tail(out, 5)}`);
    r.check(!existsSync(join(T, ".agents/templates")), "an untouched v6 spec-lean.md is removed with its folder");
    r.check(!lexists(join(T, ".claude/templates")), "our .claude/templates link is removed");

    v6target();
    appendFileSync(join(T, ".agents/templates/spec-lean.md"), "My own section.\n");
    if (installV6() !== 0) r.bad("install over an edited spec-lean.md exited non-zero");
    r.check(!existsSync(join(T, ".agents/templates/spec-lean.md")), "an edited spec-lean.md is moved out of the way");
    r.check(fileHas(join(T, ".agents/templates/spec-lean.md.pre-v7"), "My own section."), "the edited copy is kept as spec-lean.md.pre-v7");
    r.check(out.includes("spec-lean.md.pre-v7"), "the install says where the edited copy went");

    v6target();
    writeFileSync(join(T, ".agents/templates/spec-lean.md.pre-v7"), "An earlier rescue.\n");
    appendFileSync(join(T, ".agents/templates/spec-lean.md"), "A later edit.\n");
    if (installV6() !== 0) r.bad("install over a second edited spec-lean.md exited non-zero");
    r.check(cat(join(T, ".agents/templates/spec-lean.md.pre-v7")) === "An earlier rescue.", "an existing spec-lean.md.pre-v7 is never overwritten");
    r.check(fileHas(join(T, ".agents/templates/spec-lean.md.pre-v7.2"), "A later edit."), "the second rescue takes the next free name, spec-lean.md.pre-v7.2");
    r.check(out.includes("spec-lean.md.pre-v7.2"), "the install names the file it actually wrote");

    v6target();
    rmSync(join(T, ".claude/templates"));
    symlinkSync("../my-templates", join(T, ".claude/templates"));
    if (installV6() !== 0) r.bad("install with a user's own .claude/templates link exited non-zero");
    r.check(readlink(join(T, ".claude/templates")) === "../my-templates", "a .claude/templates link that is not ours is left alone");
  }),
);

test(
  "decisions/README.md",
  rows((r) => {
    v6target();
    write(join(T, "decisions/0001-x.md"), "---\nstatus: proposed\ndate: 2026-01-10\ndecision-makers: Pat Doe\n---\n# x\n");
    if (installV6() !== 0) r.bad("install with a decisions/ lacking its README exited non-zero");
    r.check(lines(join(T, "decisions/README.md")).some((l) => l.startsWith("# Decision records")), "a missing decisions/README.md is seeded into an existing folder");
    r.check(existsSync(join(T, "decisions/0001-x.md")), "the user's record is untouched");

    writeFileSync(join(T, "decisions/README.md"), "# Our own decision rules\n");
    if (installV6() !== 0) r.bad("re-install exited non-zero");
    r.check(cat(join(T, "decisions/README.md")) === "# Our own decision rules", "an existing decisions/README.md is never overwritten");
  }),
);

// ── v8: the harness question and what each answer wires ──────────────────

test(
  "the default install: T3 Code running Claude Code",
  rows((r) => {
    if (fresh() !== 0) r.bad(`default install exited non-zero: ${tail(out, 5)}`);
    r.is("no answer means T3 Code running Claude Code", cat(join(T, ".agents/harness")), "harness=t3\nagent=claude\ntools=t3 claude");
    r.is("the home .agents/skills links to the workbench", readlink(join(H, ".agents/skills")), join(T, ".agents/skills"));
    r.is("the home .claude/skills links to the home .agents/skills", readlink(join(H, ".claude/skills")), join(H, ".agents/skills"));
    r.is("the home .claude/agents links to the workbench's agents", readlink(join(H, ".claude/agents")), join(T, ".agents/agents"));
    r.is(
      "the home .claude/output-styles links to the workbench's, where /author writes them",
      readlink(join(H, ".claude/output-styles")),
      join(T, ".agents/output-styles"),
    );
    r.check(existsSync(join(T, ".agents/output-styles")), "…which exists");
    r.check(git("-C", T, "rev-parse", "-q", "--verify", "HEAD").status !== 0, "an existing git repo gets no commit from the installer");
    r.hasOut("with no origin, it says land.ts will refuse", "land.ts will refuse");
    r.is("the guards are merged into ~/.claude/settings.json", guardsIn(join(H, ".claude/settings.json")), "3");
    r.check(fileHas(join(H, ".claude/settings.json"), join(T, ".agents/hooks/check-shared-checkout-write.sh")), "…naming this workbench's hook path");
    r.gone("no in-repo .claude/", ".claude");
    r.gone("no .githooks/", ".githooks");
    r.gone("Antigravity's manifest ships only when Antigravity is picked", ".agents/hooks.json");
    r.gone("…and Gemini CLI's settings only when Gemini CLI is", ".agents/gemini-settings.json");
    r.check(!existsSync(join(H, ".claude/settings.json.pre-contextium")), "no backup of a Claude settings file that did not exist before the install");
    const hooks = join(T, ".agents/hooks/claude-hooks.json");
    r.check(!(fileHas(hooks, "__WORKBENCH__") || !fileHas(hooks, join(T, ".agents/hooks/"))), "the hook manifest is rendered in place, naming the workbench");
    r.gone("…and there is no second rendered copy", ".agents/codex-hooks.json");
    r.check(!existsSync(join(H, ".grok")), "Grok Build, not picked, gets no ~/.grok");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    for (const f of [
      ".agents/checks/check-skills.ts",
      ".agents/checks/check-decision-records.ts",
      ".agents/checks/check-standards-refs.ts",
      ".agents/checks/check-secrets.ts",
      ".agents/checks/check-harness-config-links.ts",
      ".agents/hooks/check-host-infra-safety.sh",
      ".agents/hooks/check-shared-checkout-write.sh",
      ".agents/packages/cli-exit/cli-exit.ts",
    ]) {
      r.there(`the layer carries ${f}`, f);
    }
    // Every installed script is an ES module; without a package.json saying so,
    // Node 22 warns MODULE_TYPELESS_PACKAGE_JSON on every run of every one.
    r.check(fileHas(join(T, ".agents/package.json"), '"type": "module"'), ".agents/package.json declares ES modules");
    const typeless = spawnSync(process.execPath, ["--experimental-strip-types", ".agents/checks/check-skills.ts", "--all"], {
      cwd: T,
      encoding: "utf8",
    });
    r.check(!typeless.stderr.includes("MODULE_TYPELESS_PACKAGE_JSON"), "…so an installed script runs without the typeless-module warning");
    const tests = run("find", [join(T, ".agents"), "(", "-name", "*.test.*", "-o", "-name", "tests", "-o", "-name", "fixtures", "-o", "-name", "evals", ")"]);
    r.is("no test or fixture is installed", tests.stdout.split("\n").slice(0, 3).join("\n"), "");
    r.gone("no rules folder", ".agents/rules");
    for (const f of ["GEMINI.md", ".gemini", ".codex", ".cursor", ".github"]) r.gone("no generated copy for another tool", f);
    r.is("AGENTS.md is the link", readlink(join(T, "AGENTS.md")), ".agents/AGENTS.md");
    r.is("five Contextium blocks", countLines(join(T, ".agents/AGENTS.md"), /^<!-- contextium:[a-z-]* -->$/), "5");
    r.check(
      fileHasLine(join(T, ".gitignore"), ".claude/worktrees/") && fileHasLine(join(T, ".gitignore"), ".gemini/worktrees/"),
      ".gitignore keeps both worktree roots out",
    );
    r.hasOut("the links and manifests are checked at the end", "links verified");
    r.check(lines(join(T, "integrations/README.md")).some((l) => l.startsWith("## Manifest")), "integrations/README.md carries the manifest schema the check enforces");
    r.there("the integration-manifest check land.ts runs is installed", ".agents/checks/check-integration-manifest.ts");
    r.hasOut("a missing T3 Code gets its install command", "curl -fsSL https://t3.codes/install.sh | sh");
    r.is("…but --yes installs nothing", cat(CURL_LOG), "");

    rerun();
    r.is("a re-run adds no second copy of the .gitignore lines", String(lines(join(T, ".gitignore")).filter((l) => l === ".claude/worktrees/").length), "1");
    r.is("…and no second copy of the guards", guardsIn(join(H, ".claude/settings.json")), "3");
  }),
);

test(
  "Claude Code settings and user hooks of the user's own",
  rows((r) => {
    // Kept, merged into, backed up once.
    scratch(".claude");
    const settings = join(H, ".claude/settings.json");
    writeFileSync(
      settings,
      `${JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash ~/mine.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }, null, 2)}\n`,
    );
    copyFileSync(settings, join(TMP, "mine.json"));
    rerun("--harness", "claude");
    r.is("the user's settings keys stay", jq("-r", ".theme", settings), "dark");
    r.is("…and their own PreToolUse hook", jq("-r", '[.hooks.PreToolUse[].hooks[].command | select(. == "bash ~/mine.sh")] | length', settings), "1");
    r.is("…and their Stop hook", jq("-r", ".hooks.Stop[0].hooks[0].command", settings), "echo done");
    r.is("…with the guards added", guardsIn(settings), "3");
    r.check(same(`${settings}.pre-contextium`, join(TMP, "mine.json")), "the first merge keeps the original beside it");

    // A user hook of their own, in the file the installer merges and never writes.
    const userHooks = join(T, ".agents/user-hooks.json");
    const manifest = join(T, ".agents/hooks/claude-hooks.json");
    writeFileSync(
      userHooks,
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash ~/audit.sh" }] }], PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "bash ~/after.sh" }] }] } }, null, 2)}\n`,
    );
    copyFileSync(userHooks, join(TMP, "user-hooks.json"));
    rerun("--harness", "claude");
    const audit = '[.hooks.PreToolUse[].hooks[].command | select(. == ": contextium; bash ~/audit.sh")] | length';
    r.is("a user hook reaches Claude Code's settings", jq("-r", audit, settings), "1");
    r.is("…and the workbench manifest Codex and Grok Build link to", jq("-r", audit, manifest), "1");
    r.check(same(userHooks, join(TMP, "user-hooks.json")), "the user's hook file is never rewritten");
    const afterIn = (f: string) => jq("-r", '[.hooks.PostToolUse[]?.hooks[]?.command | select(. == ": contextium; bash ~/after.sh")] | length', f);
    r.is("a user hook on another event (PostToolUse) reaches the workbench manifest", afterIn(manifest), "1");
    r.is("…and Claude Code's settings", afterIn(settings), "1");
    rerun("--harness", "claude");
    r.is("…once, after a re-run", afterIn(settings), "1");
    writeFileSync(userHooks, '{"hooks": ');
    rerun("--harness", "claude");
    r.hasOut("a user-hooks.json that is not JSON is said", "user-hooks.json is not valid JSON");
    r.is("…and the last good manifest keeps their hook", jq("-r", audit, manifest), "1");
    r.is("…and so do Claude Code's settings", jq("-r", audit, settings), "1");
    r.check(!fileHas(manifest, "__WORKBENCH__"), "…rendered, not the raw template");
  }),
);

test(
  "a re-run refreshes only what Contextium ships",
  rows((r) => {
    fresh("--harness", "claude");
    write(join(T, ".agents/skills/mine/SKILL.md"), "# mine\n");
    const dirs = ["agents", "hooks", "checks", "generators", "packages", "output-styles"];
    for (const d of dirs) write(join(T, `.agents/${d}/mine.md`), "mine\n");
    writeFileSync(join(T, ".agents/skills/close/stray.md"), "stray\n");
    appendFileSync(join(T, ".agents/skills/close/SKILL.md"), "edited\n");
    // Two skills an earlier release shipped and this one does not, recorded as shipped.
    for (const x of ["retired", "retired-edited"]) {
      const f = join(T, `.agents/skills/${x}/SKILL.md`);
      write(f, "old\n");
      appendFileSync(join(T, ".agents/skills/.contextium-manifest"), `.agents/skills/${x}/SKILL.md\t${cksum(f)}\n`);
    }
    appendFileSync(join(T, ".agents/skills/retired-edited/SKILL.md"), "mine\n");
    rerun("--harness", "claude");
    r.there("a skill the user added survives a re-run", ".agents/skills/mine/SKILL.md");
    for (const d of dirs) r.there(`…and a file of theirs in .agents/${d}/`, `.agents/${d}/mine.md`);
    r.gone("a shipped skill is replaced whole", ".agents/skills/close/stray.md");
    r.check(same(join(T, ".agents/skills/close/SKILL.md"), join(HERE, "templates/agents/skills/close/SKILL.md")), "…its edited file put back");
    r.gone("a skill an earlier release shipped, unchanged, is removed", ".agents/skills/retired");
    r.there("…one the user changed stays", ".agents/skills/retired-edited/SKILL.md");
    r.hasOut("…and is named", "kept .agents/skills/retired-edited");
    const manifest = join(T, ".agents/skills/.contextium-manifest");
    r.check(fileHas(manifest, ".agents/skills/close/SKILL.md\t"), "the manifest records what this release shipped");
    r.check(!fileHas(manifest, "retired"), "…and no longer what it does not");
    r.check(
      fileHasLine(join(T, ".agents/hooks/.contextium-manifest"), `.agents/hooks/claude-hooks.json\t${cksum(join(T, ".agents/hooks/claude-hooks.json"))}`),
      "…the hook manifest as rendered",
    );
    r.check(fileHas(join(T, ".agents/packages/.contextium-manifest"), ".agents/packages/cli-exit/cli-exit.ts\t"), "…and the packages it shipped");
  }),
);

test(
  "git and an origin",
  rows((r) => {
    writeFileSync(GH_AUTHED, "");
    scratch();
    rerun();
    r.is("a target that is not a git repo is made one, on main", git("-C", T, "symbolic-ref", "--short", "HEAD").stdout, "main");
    r.is("…with the installed tree as its first commit", git("-C", T, "rev-list", "--count", "HEAD").stdout, "1");
    r.is("…leaving nothing out", git("-C", T, "status", "--porcelain").stdout, "");
    r.hasOut("…and, with no origin, it says land.ts will refuse", "land.ts will refuse");
    r.is("--yes never creates a remote, even with gh logged in", cat(GH_LOG), "");

    scratch();
    const status = install([T, "--yes", "--no-integrations"], {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "true",
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      },
    });
    r.is("with no git identity the install still finishes", String(status), "0");
    r.check(git("-C", T, "rev-parse", "-q", "--verify", "HEAD").status !== 0, "…without a commit");
    r.hasOut("…and says how to make the first commit", "git config --global user.email");

    // A real folder where a home link goes: moved aside, never deleted.
    scratch(".claude/skills/mine");
    writeFileSync(join(H, ".claude/skills/mine/SKILL.md"), "keep\n");
    rerun("--harness", "claude");
    r.is("a real ~/.claude/skills is moved aside", cat(join(H, ".claude/skills.pre-link/mine/SKILL.md")), "keep");
    r.is("…the link takes its place", readlink(join(H, ".claude/skills")), join(H, ".agents/skills"));
    r.hasOut("…and it is said", `moved your ${H}/.claude/skills aside`);
  }),
);

test(
  "Codex",
  rows((r) => {
    fresh("--harness", "codex");
    r.is("Codex", cat(join(T, ".agents/harness")), "harness=codex\nagent=codex\ntools=codex");
    const manifest = join(T, ".agents/hooks/claude-hooks.json");
    r.is("the home .codex/hooks.json links to the workbench's manifest", readlink(join(H, ".codex/hooks.json")), manifest);
    r.is("…which carries only hooks and a description (Codex drops anything more)", jq("-r", 'keys | join(",")', manifest), "description,hooks");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    r.hasOut("…and the one-time hook trust is said", "hook-trust prompt");
    r.gone("no .codex in the workbench", ".codex");

    // Upgrading from the layout that rendered a separate .agents/codex-hooks.json:
    // the stale copy goes and a Codex link to it follows the manifest, even on a
    // run that did not pick Codex (a link left dangling runs no guard at all).
    copyFileSync(manifest, join(T, ".agents/codex-hooks.json"));
    rmSync(join(H, ".codex/hooks.json"));
    symlinkSync(join(T, ".agents/codex-hooks.json"), join(H, ".codex/hooks.json"));
    rerun("--harness", "claude");
    r.gone("the old rendered Codex manifest is removed", ".agents/codex-hooks.json");
    r.is("…and Codex's link follows the manifest", readlink(join(H, ".codex/hooks.json")), manifest);

    // Claude Code installed but not among the tools: it is not wired (a tool is
    // wired only while tools= names it, so a --drop-tool sticks), and the check at
    // the end does not ask for its links or guards.
    scratch(".claude");
    rerun("--harness", "codex");
    r.check(!existsSync(join(H, ".claude/settings.json")) && !lexists(join(H, ".claude/skills")), "an installed Claude Code not among the tools is left alone");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    r.hasOut("…and the install says it is ready", "ready in");

    // A check that fails at the end is not a ready install.
    scratch(".claude");
    writeFileSync(join(H, ".claude/settings.json"), "{not json");
    rerun("--harness", "claude");
    r.hasOut("settings that are not JSON fail the check at the end", "not right yet");
    r.lacksOut("…and the install does not call itself ready", "ready in");
    r.hasOut("…but says it installed, and what to fix", "installed in");

    // Without jq: linking needs none, so Codex still gets its hooks file.
    scratch();
    install([T, "--yes", "--no-integrations", "--harness", "codex"], { env: { PATH: `${STUB}:${NOJQ}` } });
    r.is("without jq, Codex's hooks file is still linked", readlink(join(H, ".codex/hooks.json")), join(T, ".agents/hooks/claude-hooks.json"));
    r.hasOut("…and the missing jq is said", "jq is not installed");

    scratch(".codex");
    const codex = join(H, ".codex/hooks.json");
    writeFileSync(codex, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "bash ~/codex-mine.sh" }] }] } }, null, 2)}\n`);
    write(join(T, ".agents/user-hooks.json"), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/stop.sh" }] }] } }, null, 2)}\n`);
    rerun("--harness", "codex");
    r.check(!lstatSync(codex).isSymbolicLink(), "a Codex hooks file of the user's is not replaced by a link");
    r.is("…their hook stays", jq("-r", '[.hooks.PreToolUse[].hooks[].command | select(. == "bash ~/codex-mine.sh")] | length', codex), "1");
    r.is("…and the guards are merged in", guardsIn(codex), "3");
    r.is(
      "…with a user hook on another event (Stop)",
      jq("-r", '[.hooks.Stop[]?.hooks[]?.command | select(. == ": contextium; bash ~/stop.sh")] | length', codex),
      "1",
    );
  }),
);

test(
  "Gemini CLI",
  rows((r) => {
    fresh("--harness", "gemini");
    const gs = join(T, ".gemini/settings.json");
    r.is("Gemini CLI's settings are a link to the workbench's", readlink(gs), "../.agents/gemini-settings.json");
    r.is("…which point it at AGENTS.md", jq("-c", ".context.fileName", gs), '["AGENTS.md"]');
    r.is("…and carry the guards under BeforeTool", jq("-r", '[.hooks.BeforeTool[]?.hooks[]?.command | select(startswith(": contextium;"))] | length', gs), "3");
    const rendered = join(T, ".agents/gemini-settings.json");
    r.check(!(fileHas(rendered, "__WORKBENCH__") || !fileHas(rendered, join(T, ".agents/hooks/"))), "…rendered with the workbench's path");
    r.is("…and its agent is gemini", field(join(T, ".agents/harness"), "agent"), "gemini");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");

    rmSync(gs);
    writeFileSync(
      gs,
      `${JSON.stringify({ ui: { theme: "mine" }, context: { fileName: ["GEMINI.md"] }, hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "bash ~/gem-mine.sh" }] }] } }, null, 2)}\n`,
    );
    rerun("--harness", "gemini");
    const user = join(T, ".agents/user-gemini-settings.json");
    r.is("a .gemini/settings.json of the user's becomes .agents/user-gemini-settings.json", jq("-r", ".ui.theme", user), "mine");
    r.is("…the link takes its place", readlink(gs), "../.agents/gemini-settings.json");
    r.is("…and their settings stay active, merged into what it links to", jq("-r", ".ui.theme", gs), "mine");
    r.is("…their context file beside AGENTS.md", jq("-c", ".context.fileName", gs), '["AGENTS.md","GEMINI.md"]');
    r.is(
      "…their hook beside the guards",
      jq("-r", '[.hooks.BeforeTool[].hooks[].command] | map(select(. == "bash ~/gem-mine.sh" or startswith(": contextium;"))) | length', gs),
      "4",
    );
    r.hasOut("…and where they live now is said", "user-gemini-settings.json");
    copyFileSync(user, join(TMP, "gem-user.json"));
    rerun("--harness", "gemini");
    r.check(same(user, join(TMP, "gem-user.json")), "a re-run never rewrites user-gemini-settings.json");
    r.is("…and merges it again, once", jq("-r", '[.hooks.BeforeTool[].hooks[].command | select(. == "bash ~/gem-mine.sh")] | length', gs), "1");
    writeFileSync(user, '{"ui": ');
    rerun("--harness", "gemini");
    r.hasOut("a user-gemini-settings.json that is not JSON is said", "user-gemini-settings.json is not valid JSON");
    r.is("…and the last good settings stay in force", jq("-r", ".ui.theme", gs), "mine");
    rmSync(user);

    rmSync(gs, { force: true });
    writeFileSync(gs, '{"context":{"fileName":["AGENTS.md"]}}\n');
    rerun("--harness", "gemini");
    r.is("the one-line settings an earlier v8 wrote are replaced by the link", readlink(gs), "../.agents/gemini-settings.json");
    r.gone("…with nothing kept of them", ".agents/user-gemini-settings.json");
  }),
);

test(
  "Grok Build, Antigravity, and the recorded set of tools",
  rows((r) => {
    fresh("--harness", "grok");
    const grok = join(H, ".grok/hooks/contextium.json");
    r.is("Grok Build's hooks link to the workbench manifest", readlink(grok), join(T, ".agents/hooks/claude-hooks.json"));
    r.is("…which routes Grok's own tool names", jq("-r", '[.hooks.PreToolUse[] | select(.matcher | test("run_terminal_command")) | .hooks[]] | length', grok), "2");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");

    fresh("--harness", "antigravity");
    r.is("Antigravity reads the skills through ~/.gemini/config/skills", readlink(join(H, ".gemini/config/skills")), join(H, ".agents/skills"));
    r.there("…and its manifest is in the workbench", ".agents/hooks.json");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    // Every tool the workbench has wired stays wired: a re-run adds to the set in
    // .agents/harness (tools=), and a tool leaves only with --drop-tool.
    rerun("--harness", "claude");
    r.there("a re-run for another tool keeps Antigravity's manifest", ".agents/hooks.json");
    r.is("…and records both tools", field(join(T, ".agents/harness"), "tools"), "antigravity claude");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    rerun("--harness", "claude", "--drop-tool", "antigravity");
    r.gone("--drop-tool antigravity removes its untouched manifest", ".agents/hooks.json");
    r.is("…and it leaves the record", field(join(T, ".agents/harness"), "tools"), "claude");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    rerun("--harness", "antigravity");
    writeFileSync(join(T, ".agents/hooks.json"), '{"mine": true}\n');
    rerun("--harness", "claude", "--drop-tool", "antigravity");
    r.there("…but keeps one the user changed", ".agents/hooks.json");
    r.hasOut("…and says so", "kept .agents/hooks.json");

    fresh("--harness", "gemini");
    rerun("--harness", "claude");
    r.there("a re-run for another tool keeps Gemini CLI's settings", ".agents/gemini-settings.json");
    r.is("…and the .gemini/settings.json link to them", readlink(join(T, ".gemini/settings.json")), "../.agents/gemini-settings.json");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    rerun("--harness", "claude", "--drop-tool", "gemini");
    r.gone("--drop-tool gemini removes its untouched settings", ".agents/gemini-settings.json");
    r.gone("…and the .gemini/settings.json link to them", ".gemini/settings.json");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
  }),
);

test(
  "--drop-tool undoes that tool's home wiring, and only what is ours",
  rows((r) => {
    fresh("--harness", "claude");
    jqEdit('. + {theme: "dark"}', join(H, ".claude/settings.json"));
    rerun("--harness", "codex", "--drop-tool", "claude");
    r.is("--drop-tool claude strips the guards merged into ~/.claude/settings.json", guardsIn(join(H, ".claude/settings.json")), "0");
    r.is("…keeping the rest of the file", jq("-r", ".theme", join(H, ".claude/settings.json")), "dark");
    for (const l of ["skills", "agents", "output-styles"]) {
      r.check(!lexists(join(H, ".claude", l)), `…and removes the ~/.claude/${l} link into this workbench`);
    }
    r.is("…and leaves the record", field(join(T, ".agents/harness"), "tools"), "codex");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
    rerun("--harness", "codex");
    r.is("a dropped tool stays dropped on the next run", guardsIn(join(H, ".claude/settings.json")), "0");

    fresh("--harness", "grok");
    rerun("--harness", "claude", "--drop-tool", "grok");
    r.check(!(lexists(join(H, ".grok/hooks/contextium.json")) && lstatSync(join(H, ".grok/hooks/contextium.json")).isSymbolicLink()), "--drop-tool grok removes our ~/.grok/hooks/contextium.json");
    fresh("--harness", "grok");
    rmSync(join(H, ".grok/hooks/contextium.json"));
    symlinkSync(join(TMP, "elsewhere.json"), join(H, ".grok/hooks/contextium.json"));
    rerun("--harness", "claude", "--drop-tool", "grok");
    r.is("…but not a link that points somewhere else", readlink(join(H, ".grok/hooks/contextium.json")), join(TMP, "elsewhere.json"));

    fresh("--harness", "codex");
    rerun("--harness", "claude", "--drop-tool", "codex");
    r.check(!lexists(join(H, ".codex/hooks.json")), "--drop-tool codex removes our ~/.codex/hooks.json link");
    scratch(".codex");
    const codex = join(H, ".codex/hooks.json");
    writeFileSync(codex, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "bash ~/codex-mine.sh" }] }] } }, null, 2)}\n`);
    rerun("--harness", "codex");
    rerun("--harness", "claude", "--drop-tool", "codex");
    r.is("…and strips the guards merged into a Codex hooks file of the user's", guardsIn(codex), "0");
    r.is("…keeping their own hook", jq("-r", '[.hooks.PreToolUse[].hooks[].command | select(. == "bash ~/codex-mine.sh")] | length', codex), "1");

    fresh("--harness", "antigravity");
    rerun("--harness", "claude", "--drop-tool", "antigravity");
    r.check(!(lexists(join(H, ".gemini/config/skills")) && lstatSync(join(H, ".gemini/config/skills")).isSymbolicLink()), "--drop-tool antigravity removes the ~/.gemini/config/skills link");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");
  }),
);

test(
  "a workbench from before tools=, kept customized files, and refused drops",
  rows((r) => {
    // A v8 workbench from before tools= was recorded: the set is read off disk.
    fresh("--harness", "gemini");
    dropField(join(T, ".agents/harness"), "tools");
    rerun("--harness", "claude");
    r.there("with no tools= line, the Gemini CLI files on disk count as wired", ".agents/gemini-settings.json");
    r.is("…and the set is recorded from then on", field(join(T, ".agents/harness"), "tools"), "gemini claude");

    // A v8.0.0 workbench shipped both per-harness files for every tool, so their
    // presence proves nothing: only a link, or harness=, says a tool was wired.
    fresh("--harness", "claude");
    copyFileSync(join(HERE, "templates/agents/hooks.json"), join(T, ".agents/hooks.json"));
    writeFileSync(join(T, ".agents/gemini-settings.json"), readFileSync(join(HERE, "templates/agents/gemini-settings.json"), "utf8").replaceAll("__WORKBENCH__", T));
    dropField(join(T, ".agents/harness"), "tools");
    rerun("--harness", "claude");
    r.is("with no tools= line, shipped-for-everyone files do not count as wired", field(join(T, ".agents/harness"), "tools"), "claude");
    r.gone("…so the untouched Antigravity manifest goes", ".agents/hooks.json");
    r.gone("…and the untouched Gemini CLI settings (as rendered for this workbench) go", ".agents/gemini-settings.json");

    // A customized file kept after --drop-tool is the user's from then on.
    fresh("--harness", "antigravity");
    writeFileSync(join(T, ".agents/hooks.json"), '{"mine": true}\n');
    rerun("--harness", "claude", "--drop-tool", "antigravity");
    rerun("--harness", "claude");
    r.is("a kept customized manifest survives the runs after the drop", cat(join(T, ".agents/hooks.json")), '{"mine": true}');

    fresh("--harness", "gemini");
    jqEdit('. + {ui: {theme: "mine"}}', join(T, ".agents/gemini-settings.json"));
    rerun("--harness", "claude", "--drop-tool", "gemini");
    r.there("dropping Gemini CLI keeps customized settings", ".agents/gemini-settings.json");
    r.check(
      !(lexists(join(T, ".gemini/settings.json")) && lstatSync(join(T, ".gemini/settings.json")).isSymbolicLink()),
      "…but takes away the .gemini/settings.json link, so Gemini CLI no longer loads them",
    );

    // Codex linked by the layout before .agents/hooks/claude-hooks.json.
    fresh("--harness", "codex");
    copyFileSync(join(T, ".agents/hooks/claude-hooks.json"), join(T, ".agents/codex-hooks.json"));
    rmSync(join(H, ".codex/hooks.json"));
    symlinkSync(join(T, ".agents/codex-hooks.json"), join(H, ".codex/hooks.json"));
    rerun("--harness", "claude", "--drop-tool", "codex");
    r.check(!lexists(join(H, ".codex/hooks.json")), "--drop-tool codex removes a link to the older .agents/codex-hooks.json too");

    // The harness you drive the workbench with cannot be dropped in the same run.
    fresh("--harness", "gemini");
    r.is("dropping the harness itself is refused", String(rerun("--drop-tool", "gemini")), "1");
    r.hasOut("…with how to pick another", "--harness");
    r.there("…and nothing is removed", ".agents/gemini-settings.json");
    r.is("an unknown --drop-tool name is refused", String(rerun("--harness", "claude", "--drop-tool", "bogus")), "1");
  }),
);

test(
  "Gemini CLI's trusted folders",
  rows((r) => {
    // Gemini CLI reads .gemini/settings.json (AGENTS.md, the guards) only in a
    // trusted folder, so wiring it trusts the workbench — and dropping it takes back
    // only the entry the installer added.
    scratch(".gemini");
    git("init", "-q", T);
    const trusted = join(H, ".gemini/trustedFolders.json");
    writeFileSync(trusted, '{"/somewhere/else": "TRUST_FOLDER"}\n');
    rerun("--harness", "gemini");
    r.is("wiring Gemini CLI trusts the workbench folder", jq("-r", "--arg", "k", T, ".[$k]", trusted), "TRUST_FOLDER");
    r.is("…keeping the folders already trusted", jq("-r", '.["/somewhere/else"]', trusted), "TRUST_FOLDER");
    r.hasOut("the closing message says trust gates AGENTS.md and the guards", "AGENTS.md and the guards");
    r.hasOut("…and names the variable headless runs need", "GEMINI_CLI_TRUST_WORKSPACE=true");
    rerun("--harness", "claude", "--drop-tool", "gemini");
    r.is("--drop-tool gemini takes back the entry the installer added", jq("-r", "--arg", "k", T, '.[$k] // "none"', trusted), "none");
    r.is("…and only that one", jq("-r", '.["/somewhere/else"]', trusted), "TRUST_FOLDER");

    scratch(".gemini");
    git("init", "-q", T);
    writeFileSync(join(H, ".gemini/trustedFolders.json"), `${JSON.stringify({ [T]: "TRUST_FOLDER" }, null, 2)}\n`);
    rerun("--harness", "gemini");
    rerun("--harness", "claude", "--drop-tool", "gemini");
    r.is(
      "a folder the user had trusted before the install stays trusted after the drop",
      jq("-r", "--arg", "k", T, ".[$k]", join(H, ".gemini/trustedFolders.json")),
      "TRUST_FOLDER",
    );

    // An entry the user set to something else is left alone — and the install is
    // not called ready, because Gemini CLI then loads none of the workbench.
    scratch(".gemini");
    git("init", "-q", T);
    writeFileSync(join(H, ".gemini/trustedFolders.json"), `${JSON.stringify({ [T]: "DO_NOT_TRUST" }, null, 2)}\n`);
    rerun("--harness", "gemini");
    r.is("a user's DO_NOT_TRUST entry is left as it is", jq("-r", "--arg", "k", T, ".[$k]", join(H, ".gemini/trustedFolders.json")), "DO_NOT_TRUST");
    r.hasOut("…the conflict is named", 'not "TRUST_FOLDER"');
    r.hasOut("…and the install is not called ready", "not ready");

    scratch();
    git("init", "-q", T);
    install([T, "--yes", "--no-integrations", "--harness", "gemini"], { env: { PATH: `${STUB}:${NOJQ}` } });
    r.hasOut("without jq, the exact trustedFolders.json line is printed", `"${T}": "TRUST_FOLDER"`);
  }),
);

test(
  "the other answers: VS Code, T3 Code's agents, --tools, --all-tools, the default target",
  rows((r) => {
    fresh("--harness", "vscode");
    r.is("VS Code's agent is copilot", field(join(T, ".agents/harness"), "agent"), "copilot");
    r.hasOut("VS Code has no one-line install, so it says where to get it", "code.visualstudio.com/download");

    fresh("--harness", "t3", "--agents", "codex");
    r.is("T3 Code running Codex", cat(join(T, ".agents/harness")), "harness=t3\nagent=codex\ntools=t3 codex");
    r.check(!existsSync(join(H, ".claude")), "…touches no ~/.claude");
    r.is("…and links Codex's hooks", readlink(join(H, ".codex/hooks.json")), join(T, ".agents/hooks/claude-hooks.json"));

    fresh("--tools", "claude gemini");
    r.is("--tools: the first is the harness", field(join(T, ".agents/harness"), "harness"), "claude");
    r.there("…and each named tool is wired", ".gemini/settings.json");
    r.is("…Claude Code too", readlink(join(H, ".claude/skills")), join(H, ".agents/skills"));

    fresh("--all-tools");
    r.is("--all-tools wires Claude Code", guardsIn(join(H, ".claude/settings.json")), "3");
    r.is("--all-tools links Antigravity's skills folder", readlink(join(H, ".gemini/config/skills")), join(H, ".agents/skills"));
    r.is("…and Gemini CLI", readlink(join(T, ".gemini/settings.json")), "../.agents/gemini-settings.json");
    r.is("…and Grok Build", readlink(join(H, ".grok/hooks/contextium.json")), join(T, ".agents/hooks/claude-hooks.json"));
    r.is("…and Codex", readlink(join(H, ".codex/hooks.json")), join(T, ".agents/hooks/claude-hooks.json"));
    r.there("…and Antigravity", ".agents/hooks.json");
    r.lacksOut("…and the check at the end finds nothing wrong", "not right yet");

    fresh("--tools", "copilot");
    r.is("--tools copilot is VS Code", field(join(T, ".agents/harness"), "harness"), "vscode");

    r.is("an unknown harness is refused", String(fresh("--harness", "bogus")), "1");

    n++;
    H = join(TMP, `h${n}`);
    HOME = H;
    mkdirSync(H, { recursive: true });
    install(["--yes", "--no-integrations", "--harness", "codex"]);
    r.check(existsSync(join(H, "code/workbench/.agents/AGENTS.md")), "with no target, the workbench is ~/code/workbench");
  }),
);

test(
  "installing what is missing",
  rows((r) => {
    writeFileSync(CURL_LOG, "");
    fresh("--harness", "grok");
    r.is("--yes alone never installs", cat(CURL_LOG), "");
    r.hasOut("…and prints the command", "curl -fsSL https://x.ai/cli/install.sh | bash");
    fresh("--harness", "grok", "--install-missing");
    r.is("--install-missing runs the vendor's installer", cat(CURL_LOG), "https://x.ai/cli/install.sh");
    r.hasOut("…and says the tool is still not on PATH", "not on your PATH yet");
  }),
);

test(
  "the interview, answered on stdin",
  rows((r) => {
    writeFileSync(CURL_LOG, "");
    scratch();
    install([T], { input: "8\ny\nPat Doe\n2\n\nn\n", env: { CONTEXTIUM_PROMPT_STDIN: "1" } });
    r.hasOut("the harness is the first question", "Which tool will you drive this repo with?");
    r.is("the eighth tool is Grok Build", field(join(T, ".agents/harness"), "harness"), "grok");
    r.is("a yes to the offer installs it", cat(CURL_LOG), "https://x.ai/cli/install.sh");
    r.check(fileHas(join(T, ".agents/AGENTS.md"), "working agreement for Pat Doe's workbench"), "the name answer lands in AGENTS.md");
    r.check(fileHas(join(T, ".agents/AGENTS.md"), "Act and report on routine work"), "the autonomy answer lands in AGENTS.md");
    r.hasOut("Grok is told to trust the folder", "grok --trust");

    stubClaude("2.1.283");
    scratch();
    install([T], { input: "1\n1 2\nn\nPat\n1\n\nn\n", env: { CONTEXTIUM_PROMPT_STDIN: "1" } });
    r.hasOut("T3 Code asks which agent it runs", "Which agent will T3 Code run?");
    r.is("the first agent picked writes the code", cat(join(T, ".agents/harness")), "harness=t3\nagent=claude\ntools=t3 claude codex");
    r.is("Claude Code among them is wired", readlink(join(HOME, ".claude/skills")), join(HOME, ".agents/skills"));
  }),
);

test(
  "an origin: asked for on a terminal, a gh repo offered",
  rows((r) => {
    // --no-integrations means no integrations question.
    const asked = ["--harness", "claude", "--name", "Pat", "--autonomy", "ask", "--no-integrations"];
    scratch();
    install([T, ...asked], { input: "git@example.com:pat/wb.git\n", env: { CONTEXTIUM_PROMPT_STDIN: "1" } });
    r.lacksOut("--no-integrations asks no integrations question", "Which integration starters");
    r.is("the origin asked for is added", git("-C", T, "remote", "get-url", "origin").stdout, "git@example.com:pat/wb.git");
    r.hasOut("…and the first push is said", "git push -u origin main");
    r.lacksOut("…and land.ts is not said to refuse", "land.ts will refuse");
    writeFileSync(GH_LOG, "");
    scratch();
    install([T, ...asked], { input: "\ny\n", env: { CONTEXTIUM_PROMPT_STDIN: "1" } });
    r.is("a blank origin with gh logged in offers a private repo, and a yes creates it", cat(GH_LOG), `repo create t${n} --private --source . --push`);
    writeFileSync(GH_LOG, "");
    scratch();
    install([T, ...asked], { input: "\n\n", env: { CONTEXTIUM_PROMPT_STDIN: "1" } });
    r.is("…and the default is no", cat(GH_LOG), "");
    r.hasOut("…so land.ts is said to refuse", "land.ts will refuse");
    rmSync(GH_AUTHED, { force: true });
  }),
);

test(
  "a starter picked passes the manifest check land.ts runs on it",
  rows((r) => {
    fresh("--integrations", "github todoist");
    const check = run(process.execPath, ["--experimental-strip-types", "--no-warnings", ".agents/checks/check-integration-manifest.ts", "--all"], { cwd: T });
    r.check(check.status === 0, `the installed starters pass the manifest check: ${tail(`${check.stdout}\n${check.stderr}`, 3)}`);
    r.check(lines(join(T, "integrations/README.md")).some((l) => l.startsWith("## Manifest")), "…and integrations/README.md is there beside them");
  }),
);

test(
  "the Claude Code floor",
  rows((r) => {
    stubClaude("2.1.270");
    fresh("--harness", "claude");
    r.hasOut("an older Claude Code is named, with the floor", "Claude Code 2.1.270 does not read AGENTS.md; 2.1.277 or later does");
    stubClaude("2.1.283");
    fresh("--harness", "claude");
    r.lacksOut("a current one is not warned about", "does not read AGENTS.md");
    rmSync(join(STUB, "claude"), { force: true });
  }),
);

test(
  "the AGENTS.md blocks: replaced, the rest kept",
  rows((r) => {
    fresh("--harness", "codex", "--name", "Pat Doe");
    const A = join(T, ".agents/AGENTS.md");
    const block = (name: string): string =>
      run(BASH, ["-c", `awk '/^<!-- contextium:${name} -->$/,/^<!-- \\/contextium -->$/' "$0"`, A]).stdout;
    const TEMPLATE_LOOP = block("loop");
    run(BASH, [
      "-c",
      `A="$0"
awk '{ print } /^## Stack$/ { print ""; print "Postgres 16, deployed with Kamal." }' "$A" >"$A.x" && mv "$A.x" "$A"
sed -e 's/^Three moves, with a deliberate/OLD LOOP TEXT/' "$A" >"$A.x" && mv "$A.x" "$A"
awk '/^<!-- contextium:records -->$/ { skip = 1 } !skip { print } /^<!-- \\/contextium -->$/ && skip { skip = 0 }' "$A" >"$A.x" && mv "$A.x" "$A"`,
      A,
    ]);
    appendFileSync(A, "\n## Mine\n\n- **Deploy on Fridays.** Ours.\n\n<!-- contextium:retired -->\nold block\n<!-- /contextium -->\n");
    rerun();
    r.is("a block's content is replaced by the template's", block("loop"), TEMPLATE_LOOP);
    r.check(fileHasLine(A, "Postgres 16, deployed with Kamal.") && fileHasLine(A, "- **Deploy on Fridays.** Ours."), "text outside the blocks is kept");
    r.check(!fileHasLine(A, "<!-- contextium:retired -->"), "a block the template no longer has is dropped");
    r.is("a block the file lost is appended", countLines(A, /^<!-- contextium:records -->$/), "1");
    r.hasOut("…and it says the user's text was untouched", "your text untouched");
    r.gone("no backup for a block refresh", ".agents/AGENTS.md.bak");

    appendFileSync(A, "\n<!-- contextium:loop -->\nnever closed\n");
    copyFileSync(A, join(TMP, "before"));
    rerun();
    r.check(same(A, join(TMP, "before")), "an unclosed block leaves the file untouched");
    r.hasOut("…and says why", "is never closed");

    rerun("--force");
    r.check(same(`${A}.bak`, join(TMP, "before")) && !fileHas(A, "never closed"), "--force replaces the file and keeps the old one as .bak");
  }),
);

test(
  "without Node: the layer installs, nothing it would run is run, and it says why",
  rows((r) => {
    scratch();
    git("init", "-q", T);
    const status = install([T, "--yes", "--no-integrations", "--harness", "claude"], { env: { PATH: `${STUB}:${NONODE}` } });
    r.is("a machine without Node still installs", String(status), "0");
    r.there("…the layer", ".agents/checks/check-harness-config-links.ts");
    r.hasOut("…says the check at the end could not run, and why", "Node 22.6 or later is not installed");
    r.hasOut("…and does not call the install ready", "not ready");
    r.lacksOut("…nor claims the links verified", "links verified");
  }),
);

// ── v7 -> v8 ─────────────────────────────────────────────────────────────

let V7 = "";
if (process.env.CONTEXTIUM_V7_SRC) {
  V7 = process.env.CONTEXTIUM_V7_SRC;
} else if (spawnSync("git", ["-C", HERE, "worktree", "add", "-q", "--detach", join(TMP, "v7src"), "v7.0.0"]).status === 0) {
  V7 = join(TMP, "v7src");
  V7_WORKTREE = V7;
}

/** A fresh v7 install for every tool, its git hooks wired, in a git repo with a HOME of its own. Sets T and HOME. */
function v7target(): void {
  scratch();
  git("init", "-q", T);
  const saved = out;
  install([T, "--yes", "--no-integrations", "--hooks", "--all-tools", "--name", "Pat Doe"], { script: join(V7, "install.sh") });
  out = saved;
}

test(
  "v7 -> v8",
  rows((r) => {
    if (!V7) {
      r.bad("cannot check out v7.0.0 for the upgrade rows — run from a clone with its tags");
      return;
    }
    v7target();
    r.there("the v7 install made its generated copies", "GEMINI.md");
    r.is("…and wired its git hooks", git("-C", T, "config", "--get", "core.hooksPath").stdout, ".githooks");
    rerun("--harness", "claude");
    for (const f of [".claude", ".agents/rules", ".agents/reviewers", ".agents/scripts", ".githooks", ".codex", ".cursor", "GEMINI.md", ".gemini/commands", ".github"]) {
      r.gone(`v7's own ${f} is removed`, f);
    }
    r.is("…and so is its core.hooksPath", git("-C", T, "config", "--get", "core.hooksPath").stdout, "");
    r.is("the skills now reach Claude Code through the home link", readlink(join(HOME, ".claude/skills")), join(HOME, ".agents/skills"));
    r.check(fileHas(join(T, ".agents/AGENTS.md"), "working agreement for Pat Doe's workbench"), "an unchanged v7 AGENTS.md is replaced, keeping its name");
    r.gone("…with nothing to back up", ".agents/AGENTS.md.bak");
    r.gone("a test v7 installed beside the generators is removed", ".agents/generators/generators.test.ts");

    v7target();
    appendFileSync(join(T, ".agents/AGENTS.md"), "\n## Our stack\n\nPostgres.\n");
    writeFileSync(join(T, ".agents/rules/ours.md"), "---\npaths: null\n---\n\n# Ours\n\n## ours\nA rule of ours. [2026-01-01]\n");
    appendFileSync(join(T, ".claude/CLAUDE.md"), "One more line of ours.\n");
    writeFileSync(join(T, ".github/copilot-instructions.md"), "Our own instructions.\n");
    jqEdit('.permissions.allow += ["Bash(make *)"]', join(T, ".claude/settings.json"));
    writeFileSync(join(T, ".githooks/checks/check-ours.sh"), "echo ours\n");
    rerun("--harness", "claude");
    r.check(
      fileHasLine(join(T, ".agents/AGENTS.md"), "Postgres.") && countLines(join(T, ".agents/AGENTS.md"), /^<!-- contextium:[a-z-]* -->$/) === "5",
      "an edited v7 AGENTS.md keeps its text and gains the blocks",
    );
    r.there("…with the original kept", ".agents/AGENTS.md.bak");
    r.hasOut("…and says what to delete", "Delete the old sections they");
    r.there("a rule file of the user's stays", ".agents/rules/ours.md");
    r.gone("…while v7's own rule files go", ".agents/rules/voice.md");
    r.hasOut("…and says so", "kept your own rule files: .agents/rules/ours.md");
    r.there("an edited CLAUDE.md stays", ".claude/CLAUDE.md");
    r.hasOut("…with the reason it matters", "Claude Code reads it instead of AGENTS.md");
    r.there("an edited .claude/settings.json stays", ".claude/settings.json");
    r.hasOut("…with what changed", "the guards now live in ~/.claude/settings.json");
    r.there("a check of the user's in .githooks/ stays", ".githooks/checks/check-ours.sh");
    r.gone("…while v7's own checks go", ".githooks/checks/check-secrets.sh");
    r.is("…and core.hooksPath stays while it has a hook to point at", git("-C", T, "config", "--get", "core.hooksPath").stdout, ".githooks");
    r.there("a copilot-instructions.md we did not write stays", ".github/copilot-instructions.md");
    r.hasOut("…and is named", "kept .github/copilot-instructions.md — Contextium did not write it");

    // The generated-file marker is not proof a file is untouched: an edited
    // GEMINI.md or command file still carries it, and the edit is the user's.
    v7target();
    appendFileSync(join(T, "GEMINI.md"), "A line of ours.\n");
    appendFileSync(join(T, ".gemini/commands/project.toml"), "A line of ours.\n");
    appendFileSync(join(T, ".cursor/rules/contextium.mdc"), "A line of ours.\n");
    rerun("--harness", "claude");
    r.there("an edited generated GEMINI.md stays", "GEMINI.md");
    r.hasOut("…and is named", "kept GEMINI.md — you edited it");
    r.there("an edited generated command stays", ".gemini/commands/project.toml");
    r.there("an edited generated Cursor rule stays", ".cursor/rules/contextium.mdc");
    r.gone("…while an unedited generated command goes", ".gemini/commands/close.toml");
    r.gone("…and the unedited copilot-instructions.md", ".github/copilot-instructions.md");

    // Without Node the generated copies cannot be regenerated to compare
    // against, so none is removed as unedited, and each kept one says why.
    v7target();
    install([T, "--yes", "--no-integrations", "--harness", "claude"], { env: { PATH: `${STUB}:${NONODE}` } });
    r.there("without Node, an unedited generated GEMINI.md stays", "GEMINI.md");
    r.there("…and an unedited generated command", ".gemini/commands/close.toml");
    r.hasOut("…and is named with the reason", "kept GEMINI.md — Node 22.6 or later is not installed");
  }),
);

// ── v8.0.1 -> the TypeScript layer ───────────────────────────────────────
// v8.0.1 shipped its checks as bash. They go with the upgrade while they are
// as it installed them; one the user edited stays, and is named.

test(
  "v8.0.1 -> the TypeScript layer",
  rows((r) => {
    const src = join(TMP, "v801src");
    if (spawnSync("git", ["-C", HERE, "worktree", "add", "-q", "--detach", src, "v8.0.1"]).status !== 0) {
      r.bad("cannot check out v8.0.1 for the upgrade rows — run from a clone with its tags");
      return;
    }
    try {
      scratch();
      git("init", "-q", T);
      install([T, "--yes", "--no-integrations", "--harness", "claude"], { script: join(src, "install.sh") });
      r.there("the v8.0.1 install shipped its bash checks", ".agents/checks/check-skills.sh");
      appendFileSync(join(T, ".agents/checks/check-secrets.sh"), "# ours\n");
      rerun("--harness", "claude");
      r.gone("an unedited v8.0.1 check is removed", ".agents/checks/check-skills.sh");
      r.there("…its TypeScript successor installed", ".agents/checks/check-skills.ts");
      r.there("an edited one stays", ".agents/checks/check-secrets.sh");
      r.hasOut("…and is named", "kept .agents/checks/check-secrets.sh");
      r.there("the packages the scripts import are installed", ".agents/packages/cli-exit/cli-exit.ts");
      r.hasOut("the check at the end runs on the upgraded layer", "links verified");
    } finally {
      spawnSync("git", ["-C", HERE, "worktree", "remove", "--force", src]);
    }
  }),
);
