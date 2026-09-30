#!/usr/bin/env -S node --experimental-strip-types
// mark-qa-done.ts — record that a webapp repo has been visually QA'd.
//
// TWO MARKERS, TWO READERS, AND THEY ANSWER DIFFERENT QUESTIONS.
//
//   1. The CHANGE-SET marker, keyed on `git status --porcelain | cksum`
//      (qaChangeHash). Its only reader was a QA Stop hook that no longer
//      exists — so this marker now has no reader at all. Still written,
//      unchanged: it costs nothing.
//
//   2. The TREE marker, keyed on a git tree SHA. Read by
//      `/implement`'s `validate.ts --require-qa`, which refuses to let the
//      session close while a web target in the diff has no completed /qa.
//
// WHY THE SECOND ONE EXISTS. Marker 1 cannot carry that gate. Its key is a
// digest of the UNCOMMITTED change-set, so once the work is committed the digest
// is of empty input — a marker written after a commit is keyed `-4294967295`,
// which is exactly `printf '' | cksum`. A marker that can never match a future state cannot prove
// anything about the tree that shipped. A tree SHA can: it names the exact bytes
// QA looked at, it survives the commit, and — this is the part the gate needs —
// a LATER /qa that edits source changes the tree, so an earlier target's marker
// stops matching and that target runs again.
//
// Usage:
//   mark-qa-done.ts <repo-dir>                       change-set marker only
//   mark-qa-done.ts --tree <sha> <repo-dir>          both markers
//   mark-qa-done.ts --marker-path --tree <sha> <repo-dir>
//                                                    print the tree marker's
//                                                    path; write nothing
//
// `--marker-path` is how validate.ts asks "is this target done?" without
// re-deriving the key. The slug formula lives here and nowhere else
// (single source of truth); a second copy of `basename-cksum` in the gate
// would be a marker writer and a marker reader that can silently disagree.
//
// peers:
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/implement/scripts/validate.ts
//   .agents/skills/qa/scripts/tests/qa-targets.test.ts
//
// Exit:  0 marked (or path printed); 2 usage; 3 --tree on a served app whose
//        interaction check has not passed on that tree.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qaChangeHash, qaErr, qaInteractionStampPath, qaRepoSlug } from "./lib.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

  let TREE = "";
  let PRINT_ONLY = false;
  let REPO = "";

  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const a = argv[0] ?? "";
    if (a === "--tree") {
      if (argv.length < 2) {
        qaErr("mark-qa-done: --tree needs a sha");
        exit(2);
      }
      TREE = argv[1] ?? "";
      argv.splice(0, 2);
    } else if (a === "--marker-path") {
      PRINT_ONLY = true;
      argv.shift();
    } else if (a === "-h" || a === "--help") {
      // The header comment above, lines 2-40, is the help text.
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 40);
      process.stderr.write(`${lines.join("\n")}\n`);
      exit(0);
    } else if (a.startsWith("--")) {
      qaErr(`mark-qa-done: unknown flag: ${a}`);
      exit(2);
    } else {
      REPO = a;
      argv.shift();
    }
  }

  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  if (REPO === "" || !isDir(REPO)) {
    qaErr("usage: mark-qa-done.ts [--marker-path] [--tree <sha>] <repo-dir>");
    exit(2);
  }
  REPO = resolve(REPO);

  // An override so the marker writer and its readers can be pointed at a sandbox
  // together.
  const DONE_DIR = process.env.QA_DONE_DIR || "/tmp/qa-done";

  // TWO SLUGS, and they are not interchangeable.
  //
  // The CHANGE-SET marker stays keyed on the bare basename, which is how the Stop
  // hook that used to read it spelled the key (`$(basename "$repo")-$hash`,
  // inline). That hook is gone, so the marker has no reader and the slug no
  // longer has to match anything; it is left alone because changing a key nobody
  // reads is churn.
  //
  // The TREE marker is new, and its only reader is validate.ts --require-qa in
  // this same tree, so it gets the collision-safe slug: two `dashboard/`
  // directories in different repos must not share one QA verdict.
  const legacySlug = basename(REPO);
  const treeSlug = qaRepoSlug(REPO);

  if (PRINT_ONLY) {
    if (TREE === "") {
      qaErr("mark-qa-done: --marker-path needs --tree <sha>");
      exit(2);
    }
    process.stdout.write(`${DONE_DIR}/${treeSlug}-${TREE}\n`);
    exit(0);
  }

  /** `touch`: create the file, or bump its times when it exists. */
  function touch(p: string): void {
    closeSync(openSync(p, "a"));
    const now = new Date();
    utimesSync(p, now, now);
  }

  mkdirSync(DONE_DIR, { recursive: true });

  // The change-set marker is best-effort by nature (it is the Stop hook's key,
  // not a gate): a target directory that is not itself a git checkout gets the
  // key `unknown` rather than killing the run before it wrote anything. The TREE
  // marker below is the one a gate reads, and it does not depend on this at all.
  const hash = qaChangeHash(REPO) ?? "unknown";
  touch(join(DONE_DIR, `${legacySlug}-${hash}`));
  process.stdout.write(`qa: marked ${legacySlug} QA'd for current change-set (${DONE_DIR}/${legacySlug}-${hash})\n`);

  if (TREE !== "") {
    // A served web app is not QA'd until its buttons were pressed on THIS tree
    // (step-3.7-interaction). CLI and render targets have
    // none, so they need no stamp.
    const det = spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPT_DIR, "detect-app.ts"), REPO], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const type = /^TYPE=(.*)$/m.exec(det.stdout ?? "")?.[1] ?? "";
    if (type !== "cli" && type !== "render") {
      const stamp = qaInteractionStampPath(REPO, TREE);
      if (!exists(stamp)) {
        qaErr(`mark-qa-done: refusing — no clean interaction check for tree ${TREE.slice(0, 12)} (${stamp}).`);
        qaErr(
          `  Run step-3.7: interaction-check.ts --url <url> --pages '<routes>' --repo ${REPO}, fix what it finds, and mark again.`,
        );
        exit(3);
      }
    }
    touch(`${DONE_DIR}/${treeSlug}-${TREE}`);
    process.stdout.write(
      `qa: marked ${treeSlug} QA'd for tree ${TREE.slice(0, 12)} (${DONE_DIR}/${treeSlug}-${TREE})\n`,
    );
  }

  function exists(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

await runToExit(main);
