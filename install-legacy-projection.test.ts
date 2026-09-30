// Rows for install-legacy-projection.ts: for every path the v6/v7 projector
// wrote, the regenerated file is byte for byte what that projector wrote from
// the same layer (checked against v7.0.0's own projector when the tag is here);
// a path it never wrote, or a command for a skill the snapshot lacks, has
// nothing to compare against (exit 1).
//
// The layers are written into a temp dir from the literals below, so the
// fixtures live in this file.
//
// Run: node --experimental-strip-types --test install-legacy-projection.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const HERE = import.meta.dirname;
const SUT = join(HERE, "install-legacy-projection.ts");
const TMP = mkdtempSync(join(tmpdir(), "legacy-projection-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function write(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A layer with the shapes the projector handled: an H1 to drop, a nested rule,
 * a folded description, a description needing escapes, a body holding ''' (the
 * TOML fallback) and one that does not. */
function layer(root: string): string {
  const a = join(root, ".agents");
  write(join(a, "AGENTS.md"), "# Working agreement\n\nBe brief.\n");
  write(join(a, "rules/voice.md"), "# Voice\n\nPlain words.\n");
  write(join(a, "rules/meta/nested.md"), "# Nested\n\nA nested rule.\n");
  write(join(a, "rules/README.md"), "# Rules\n\nnot a rule\n");
  write(join(a, "skills/plain/SKILL.md"), "---\nname: plain\ndescription: >\n  Does one thing,\n  folded.\n---\n\n# plain\n\nRun it.\n");
  write(join(a, "skills/quoted/SKILL.md"), "---\nname: quoted\ndescription: Says \"close\" and a \\ path.\n---\n\n# quoted\n\nA body with ''' in it.\n");
  return a;
}

/** Shapes no row above names, compared only against v7's projector: a file
 * without its last newline, CRLF lines, a symlinked rule (find -type f skips
 * it), a first line that is not an H1, a `---` in a body, a |- description
 * ended by the closing fence, a quoted body, bytes that are not UTF-8, and
 * trailing blank lines (which $(...) strips). */
function edgeLayer(root: string): string {
  const a = join(root, ".agents");
  write(join(a, "AGENTS.md"), "Not an H1\r\n# Later H1\r\n\r\nno newline at the end");
  write(join(a, "rules/b.md"), "# B\n\nb rule\n\n\n");
  write(join(a, "rules/A.md"), Buffer.from([0x23, 0x20, 0x41, 0x0a, 0xe9, 0xa0, 0xff, 0x0a]));
  write(join(a, "rules/empty.md"), "");
  symlinkSync("b.md", join(a, "rules/linked.md"));
  write(join(a, "skills/edge/SKILL.md"), "---\nname: edge\ndescription: |-\n  first\n\n\tsecond \"q\"\n---\nbody\n---\nafter a rule\n\n\n");
  write(join(a, "skills/nofm/SKILL.md"), "# no front matter\ndescription: not read\n");
  write(join(a, "skills/both/SKILL.md"), "---\ndescription: a \\\\ b ''' c\n---\n''' and \"\" and \\\n");
  return a;
}

function gen(agentsDir: string, rel: string): { status: number | null; out: Buffer; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT, agentsDir, rel]);
  return { status: r.status, out: r.stdout, err: r.stderr.toString() };
}
const text = (agentsDir: string, rel: string): string => gen(agentsDir, rel).out.toString("latin1");

const A = layer(join(TMP, "wb"));

const WANT_BODY = `<!-- Generated from .agents/AGENTS.md + .agents/rules/*.md. Do not edit by hand; edit the source in .agents/ and re-run the installer. -->


Be brief.

# Principles

These are the always-on rules, identical in every tool.


A nested rule.


Plain words.

`;

test("GEMINI.md: the note, AGENTS.md without its H1, then every rule but README.md in byte order", () => {
  const r = gen(A, "GEMINI.md");
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.toString(), WANT_BODY);
});

test("copilot-instructions.md is GEMINI.md's body", () => {
  assert.equal(text(A, ".github/copilot-instructions.md"), text(A, "GEMINI.md"));
});

test("the Cursor rule opens with its .mdc frontmatter", () => {
  assert.equal(
    text(A, ".cursor/rules/contextium.mdc").split("\n").slice(0, 4).join("\n"),
    "---\ndescription: Contextium methodology and principles\nalwaysApply: true\n---",
  );
});

test("a TOML command: the folded description, a literal string, the fenced front matter", () => {
  assert.equal(
    text(A, ".gemini/commands/plain.toml").split("\n").slice(0, 3).join("\n"),
    "description = \"Does one thing, folded.\"\nprompt = '''\n```yaml",
  );
});

test("a body holding ''' falls back to a basic string", () => {
  assert.ok(text(A, ".gemini/commands/quoted.toml").includes('prompt = """'));
});

test("a prompt's description is YAML-escaped", () => {
  assert.equal(text(A, ".github/prompts/quoted.prompt.md").split("\n")[1], 'description: "Says \\"close\\" and a \\\\ path."');
});

test("a command for a skill the snapshot lacks exits 1", () => {
  assert.equal(gen(A, ".gemini/commands/nosuch.toml").status, 1);
});

test("a path the projector never wrote exits 1", () => {
  assert.equal(gen(A, "README.md").status, 1);
});

test("a missing argument is a usage error", () => {
  const r = gen(A, "");
  assert.equal(r.status, 1);
  assert.match(r.err, /usage:/);
});

// Against the projector itself, where the v7.0.0 tag is here.
const v7 = spawnSync("git", ["-C", HERE, "show", "v7.0.0:scripts/projector/project-rules.sh"]);
const V7_OK = v7.status === 0;
if (V7_OK) write(join(TMP, "project-rules.sh"), v7.stdout);
else process.stderr.write("note: no v7.0.0 tag here, so the rows against v7's own projector were skipped\n");

const RELS = [
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/contextium.mdc",
];

function againstV7(root: string, agentsDir: string, rels: string[]): void {
  for (const tool of ["gemini", "copilot", "cursor"]) {
    const r = spawnSync("bash", [join(TMP, "project-rules.sh"), tool, root]);
    assert.equal(r.status, 0, `v7's projector ran for ${tool}: ${r.stderr}`);
  }
  for (const rel of rels) {
    const want = readFileSync(join(root, rel));
    assert.ok(gen(agentsDir, rel).out.equals(want), `byte for byte what v7 wrote: ${rel}`);
  }
}

test("byte for byte what v7.0.0's projector wrote", { skip: !V7_OK && "no v7.0.0 tag" }, () => {
  againstV7(join(TMP, "wb"), A, [
    ...RELS,
    ".gemini/commands/plain.toml",
    ".gemini/commands/quoted.toml",
    ".github/prompts/plain.prompt.md",
    ".github/prompts/quoted.prompt.md",
  ]);
});

test("…and on the shapes the rows above do not name", { skip: !V7_OK && "no v7.0.0 tag" }, () => {
  const root = join(TMP, "edge");
  const a = edgeLayer(root);
  const rels = [...RELS];
  for (const s of ["edge", "nofm", "both"]) rels.push(`.gemini/commands/${s}.toml`, `.github/prompts/${s}.prompt.md`);
  againstV7(root, a, rels);
});
