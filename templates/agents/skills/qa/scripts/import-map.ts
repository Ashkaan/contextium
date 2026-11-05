// import-map.ts — the repo's reverse-import map, read once per qa-targets run.
//
// Usage: import-map.ts <repo>
// Prints one `<target-without-code-ext>\t<importer>` line per import edge, both
// repo-relative. As a module, `importEdges(repo)` returns the same edges in the
// same order; qa-targets.ts imports it and walks them.
//
// WHY ONE PASS. qa-targets used to run a repo-wide `git grep` for every file
// its importer walk reached, plus a `realpath` per import it found: about 15
// minutes on a diff touching one widely imported library file, and a 322-file
// diff unfinished after about 50. Every file is read once
// here instead.
//
// THE RULES ARE THE ONES THE GREP WALK USED, so the targets do not change:
//   - the files are git's tracked and untracked-but-not-ignored ones (what
//     `git grep --untracked` searched), with a source extension;
//   - an import is `from|import|require`, an optional `(`, then a quoted spec,
//     all on one line;
//   - `./` and `../` resolve against the importer's directory, a bare spec
//     against the repo root, an absolute one is skipped, and anything that
//     resolves outside the repo is skipped;
//   - a resource query or hash (`?raw`, `?url`, `#top`) is dropped from the
//     spec (dropQuery, which qa-targets.ts also applies to its lookup);
//   - a code extension is dropped from both ends (`.css` and the rest are kept).
// One difference, deliberately: the path is normalized lexically, where the
// shell used `realpath -m`, which also followed a symlinked directory. Nothing
// under the repo's source trees is reached through one.
//
// Exits 2 (the module throws) when the file list cannot be read: an empty map
// would be read as "no importers", the silent "no UI changed" qa-targets
// exists to refuse.
//
// peers:
//   .agents/skills/qa/scripts/qa-targets.ts
//   .agents/skills/qa/scripts/tests/import-map.test.ts

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** The code extensions: a specifier may leave one out, and a target is keyed without it. */
export const CODE_EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;
/** The source files read for imports: code, and the component formats whose script blocks import. */
export const SOURCE_EXTS = [...CODE_EXTS, "astro", "svelte", "vue"] as const;
/** A source file's path; .agents/skills/close/scripts/importers.ts reads the same files. */
export const SOURCE = new RegExp(`\\.(?:${SOURCE_EXTS.join("|")})$`);
const CODE_EXT = new RegExp(`\\.(?:${CODE_EXTS.join("|")})$`);
// Matched LINE BY LINE, as `grep -o` did. Across the whole text, a prose
// "from the import" in a comment ran on to the next line's quote and swallowed
// the real import there — found by diffing both walks' importers.
const IMPORT = /(?:from|import|require)[ \t\f\v]*\(?[ \t\f\v]*(['"])([^'"]+)\1/g;

/** A path with its code extension (`.ts`, `.jsx`, …) dropped; `.css` and the rest kept. */
export const dropCodeExt = (p: string): string => p.replace(CODE_EXT, "");

/**
 * A spec with its resource query or hash (`?raw`, `#top`) dropped: the
 * bundler's instruction, not part of the file. qa-targets.ts drops it from
 * the key it looks up too, so the two sides cannot disagree.
 */
export const dropQuery = (p: string): string => p.replace(/[?#].*$/, "");

/**
 * Every `[target, importer]` edge in the repo, both repo-relative.
 * Throws when git cannot list the repo's files; the message starts
 * `could not list`.
 */
export function importEdges(repo: string): Array<[string, string]> {
  let files: string[];
  try {
    // `cwd`, not `git -C`: the subcommand is then git's first argument, which
    // is what qa-targets-git-errors.test.ts's shim keys its simulated failure on.
    files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\0")
      .filter((f) => f && SOURCE.test(f));
  } catch (e) {
    throw new Error(`could not list ${repo}'s files: ${e instanceof Error ? e.message : String(e)}`);
  }

  const out: Array<[string, string]> = [];
  for (const file of new Set(files)) {
    let text: string;
    try {
      text = readFileSync(posix.join(repo, file), "utf8");
    } catch {
      continue; // listed but gone (a deletion in the working tree): it imports nothing now
    }
    const seen = new Set<string>();
    for (const m of text.split(/\r?\n/).flatMap((line) => [...line.matchAll(IMPORT)])) {
      // A resource query (`./README.md?raw`, `./icon.svg?url`) is the bundler's
      // instruction, not part of the file: indexed with it, the README's own
      // lookup found no importer.
      const spec = dropQuery(m[2]);
      if (spec === "" || spec.startsWith("/")) continue;
      const joined = spec.startsWith("./") || spec.startsWith("../") ? posix.join(posix.dirname(file), spec) : spec;
      const resolved = posix.normalize(joined);
      if (resolved === ".." || resolved.startsWith("../")) continue;
      const target = dropCodeExt(resolved);
      if (target === dropCodeExt(file) || seen.has(target)) continue;
      seen.add(target);
      out.push([target, file]);
    }
  }
  return out;
}

function main(): void {
  const repo = process.argv[2];
  if (!repo) {
    process.stderr.write("usage: import-map.ts <repo>\n");
    exit(2);
  }
  let edges: Array<[string, string]>;
  try {
    edges = importEdges(repo);
  } catch (e) {
    process.stderr.write(`import-map: ${e instanceof Error ? e.message : String(e)}\n`);
    exit(2);
  }
  process.stdout.write(edges.length ? `${edges.map(([t, f]) => `${t}\t${f}`).join("\n")}\n` : "");
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
