// importers.ts — the code that reads a changed shared module, followed through
// shared modules in turn. The one rule both readers of "who imports what this
// branch changed" apply: land.ts's merged-tree check and verify.ts's importer
// pass. Each kept its own copy until the Contextium v9.2.0 review found both
// short in different ways: land.ts followed a barrel but checked only apps, so
// a trunk integration calling a package whose signature this branch changed ran
// no check; verify.ts checked only an app naming the changed file's own path,
// so an app importing a package's index.ts, which re-exports the changed p.ts,
// was never verified.
//
// The files read are qa's source files (import-map.ts's SOURCE: code, and the
// .astro, .vue and .svelte formats whose script blocks import), in every folder
// but git's own and those holding installed packages (SKIP_DIRS): an app's
// .storybook/ config is its code too (Contextium v9.2.1 review).
//
// A file imports a target when one of its relative specifiers (`from`,
// `import`, `import(`, `require(`) resolves to it — a `.js`, `.mjs` or
// `.cjs` specifier also to its TypeScript forms, and an extensionless one to
// the file or `index` with any code extension — or when the file
// names the target's repo-relative path outright (`../../../integrations/x/x.ts`
// from an app holds it, and so does a script that runs it by path). An
// importer under `integrations/` or `packages/` is itself shared code, so it
// joins the targets and its own importers are found in turn; an app's file is
// a leaf. The target set only grows and is bounded by the shared files, so a
// cycle ends the walk; MAX_FILES bounds the tree it reads.

import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { CODE_EXTS, SOURCE } from "../../qa/scripts/import-map.ts";

/** The folders whose code can be shared: an importer here is followed in turn. */
export const SHARED_TOPS = ["integrations", "packages"] as const;
/** The folders searched for importers. */
export const IMPORTER_TOPS = ["apps", ...SHARED_TOPS] as const;
/** How many code files the walk reads before it refuses: a tree past this is
 *  not this repo, and a partial answer would read as "no importers". */
export const MAX_FILES = 50_000;

/** Folders never read: git's own, and those holding installed packages. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  "bower_components",
  "jspm_packages",
]);
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"'?#]+)/g;

/** `integrations/<name>` or `packages/<name>` for a path inside one, else null. */
export function sharedUnit(p: string): string | null {
  const f = p.split("/");
  return (SHARED_TOPS as readonly string[]).includes(f[0] ?? "") && f.length >= 3 ? `${f[0]}/${f[1]}` : null;
}

/** The repo-relative files a relative specifier in <from> can name. */
function targetsOf(from: string, spec: string): string[] {
  const r = posix.normalize(posix.join(posix.dirname(from), spec));
  const out = [r];
  const js = /\.(m|c)?js$/.exec(r);
  if (js) {
    const stem = r.slice(0, -js[0].length);
    out.push(`${stem}.${js[1] ?? ""}ts`, `${stem}.tsx`);
  }
  if (!SOURCE.test(r)) for (const e of CODE_EXTS) out.push(`${r}.${e}`, `${r}/index.${e}`);
  return out;
}

/**
 * Every code file under apps/, integrations/ and packages/ of <root> that
 * imports one of the <changed> shared files (repo-relative, under
 * integrations/ or packages/), directly or through other shared files.
 * The changed files themselves are never in the answer: their units are
 * the branch's own. Sorted. Throws when the tree cannot be read or holds more than
 * <maxFiles> code files — never a partial answer.
 */
export function importerClosure(root: string, changed: string[], maxFiles = MAX_FILES): string[] {
  const seeds = changed.filter((p) => sharedUnit(p) !== null);
  if (seeds.length === 0) return [];
  const files = new Map<string, { text: string; to: string[] }>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && SOURCE.test(e.name)) {
        if (files.size >= maxFiles)
          throw new Error(
            `more than ${maxFiles} code files under ${IMPORTER_TOPS.join(", ")} — refusing a partial answer`,
          );
        const text = readFileSync(`${root}/${p}`, "utf8");
        const to = [...text.matchAll(SPEC)].flatMap((m) => targetsOf(p, m[1] ?? ""));
        files.set(p, { text, to });
      }
    }
  };
  for (const top of IMPORTER_TOPS) {
    let isDir = false;
    try {
      isDir = readdirSync(`${root}/${top}`) !== undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
    }
    if (isDir) walk(top);
  }
  const targets = new Set(seeds);
  let fresh = [...seeds];
  const found = new Set<string>();
  while (fresh.length > 0) {
    const next: string[] = [];
    for (const [p, f] of files) {
      if (found.has(p) || seeds.includes(p)) continue;
      if (!f.to.some((t) => targets.has(t)) && !fresh.some((t) => f.text.includes(t))) continue;
      found.add(p);
      if (sharedUnit(p) !== null && !targets.has(p)) {
        targets.add(p);
        next.push(p);
      }
    }
    fresh = next;
  }
  return [...found].sort();
}
