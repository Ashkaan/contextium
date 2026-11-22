// sibling-env.test.ts — the UPSTREAM_<REPO>_DIR variables verify.ts sets so a
// product repo's cross-repo test reads this thread's worktree of its sibling.
// Run as a program: node --test.
import assert from "node:assert/strict";
import { test } from "node:test";

import { siblingDirEnv } from "./sibling-env.ts";

const rows = [
  { wt: "/wt/workbench", shared: "/home/a/code/workbench", branch: "t3/x" },
  { wt: "/wt/site", shared: "/home/a/code/example.com", branch: "t3/x" },
  { wt: "/wt/portal", shared: "/home/a/code/portal.example.com", branch: "t3/x" },
];

const all = () => true;

test("a worktree that is gone (a landing already removed it) names nothing, so a sibling's test falls back to the shared checkout", () => {
  assert.deepEqual(
    siblingDirEnv(rows, {}, (dir) => dir !== "/wt/portal"),
    {
      UPSTREAM_WORKBENCH_DIR: "/wt/workbench",
      UPSTREAM_EXAMPLE_COM_DIR: "/wt/site",
    },
  );
  assert.deepEqual(
    siblingDirEnv([{ wt: "/no/such/dir/gone", shared: "/home/a/code/x" }], {}),
    {},
    "the default asks the filesystem",
  );
});

test("each ledger worktree is named by its shared checkout's folder, the way a sibling test reads it", () => {
  assert.deepEqual(siblingDirEnv(rows, {}, all), {
    UPSTREAM_WORKBENCH_DIR: "/wt/workbench",
    UPSTREAM_EXAMPLE_COM_DIR: "/wt/site",
    UPSTREAM_PORTAL_EXAMPLE_COM_DIR: "/wt/portal",
  });
});

test("a variable already set wins, and a row with no worktree or no shared checkout names nothing", () => {
  assert.deepEqual(
    siblingDirEnv(
      [...rows, { wt: "", shared: "/home/a/code/x", branch: "" }, { wt: "/wt/y", shared: "", branch: "" }],
      { UPSTREAM_WORKBENCH_DIR: "/mine" },
      all,
    ),
    { UPSTREAM_EXAMPLE_COM_DIR: "/wt/site", UPSTREAM_PORTAL_EXAMPLE_COM_DIR: "/wt/portal" },
  );
  assert.deepEqual(siblingDirEnv([], {}, all), {});
});
