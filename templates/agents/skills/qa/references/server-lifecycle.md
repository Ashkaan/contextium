# QA server lifecycle

Run each command separately, replacing angle-bracket values with literal
paths or values. Read the printed fields; no shell variables, `eval`, PID
discovery, inline server source, or cleanup command is needed.

## Normal preview

```bash
node --experimental-strip-types .agents/skills/qa/scripts/serve.ts up --repo <absolute-app-path> --mode before --run-id <unique-id>
```

The output includes `QA_URL`, `QA_RUNFILE`, `QA_LABEL`, `QA_SRC` and
`QA_PAGES` and `QA_CAPTURE_DIR`. Preserve the runfile path. An occupied default port is skipped;
never stop another listener to reclaim it. `--mode after` and `--mode live`
retain the meanings in the QA workflow.

## Prebuilt comparison

```bash
node --experimental-strip-types .agents/skills/qa/scripts/serve.ts up --repo <baseline-source-path> --dist <absolute-built-directory> --mode before --run-id <unique-baseline-id>
```

This serves the existing files on loopback using the shared TypeScript static
server. It never rebuilds, seeds databases, or adds Worker bindings. Its
`QA_LABEL` says `prebuilt directory`; a static capture does not verify server
behavior. Use the source revision that produced those files as `--repo`, and
pass explicit routes when that source has no discoverable routes. `--dist`
requires `--mode before` so prebuilt bytes cannot be labeled as a fresh HEAD
build or production. Each baseline and candidate has its own run ID/runfile.
Use the emitted URL with the existing screenshot and impeccable scripts.

## Evidence without a server

```bash
node --experimental-strip-types .agents/skills/qa/scripts/serve.ts up --repo <absolute-app-path> --mode capture --run-id <unique-id>
```

CLI and render-only targets receive `QA_CAPTURE_DIR` and `QA_RUNFILE` without
building or starting a process. Write their evidence there, then use the same
`down --clean` command after review. Status reports `QA_STATUS=capture`;
restart refuses because there is no server.

## Status and restart

```bash
node --experimental-strip-types .agents/skills/qa/scripts/serve.ts status --runfile <absolute-server.run-path>
node --experimental-strip-types .agents/skills/qa/scripts/serve.ts restart --runfile <absolute-server.run-path>
```

Status reports local process liveness: exit 0 and `QA_ALIVE=yes` for the recorded
server, exit 1 and `QA_ALIVE=no` after it stops or its process identity no longer
matches. A reused PID reports `QA_STATUS=unverified`; teardown refuses to signal
it. Surviving children retain ownership when their launcher exits, so teardown
still stops the server's process group. This does not prove page health. A live-site record reports `QA_STATUS=live`
and owns no local process. Lifecycle commands for the same run are serialized.
Restart repeats the recorded target, mode, port and build-directory options;
it keeps captures. It does not switch HEAD, production or prebuilt inputs to
edited working-tree source; the main workflow's step 2.7 defines the candidate
sequence for that case. For older runfiles without start arguments, use `down`
and then a new `up` with the original target. Older running records must still
prove their process group and exact stdout log before teardown will signal
them. A second `up` on a running run ID
refuses rather than overwriting the ownership record.

## Teardown and re-shooting

```bash
node --experimental-strip-types .agents/skills/qa/scripts/serve.ts down --runfile <absolute-server.run-path> --clean
```

After the review, this stops only the recorded process group, removes its
ephemeral worktree if one exists, and removes its capture directory, including
replacement and reduced-motion captures nested beneath it. The
cleanup flag refuses a runfile outside the QA captures root. Omit `--clean`
to retain evidence, or skip teardown entirely for `--keep`. For another capture
pass, keep the server's run ID and set `QA_SHOTS_ROOT` to a fresh subdirectory
of `QA_CAPTURE_DIR`, such as `passes/review-2`, on the screenshot command. Its
manifest gives the new directory to stamp and review. Earlier evidence stays
intact and the one final cleanup removes every pass. Do not combine shell
`kill` or deletion with screenshot, build or
comparison commands. Keep route expansion, size loops and result summaries in
the check's TypeScript program.
