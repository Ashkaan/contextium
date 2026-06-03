---
name: GitHub
description: Git hosting, PRs, issues, and repo management via gh CLI
cli: "`gh` CLI"
typed_client: integrations/github/github_api.ts
---

# GitHub Integration

## TypeScript Clients

Two helpers, each for a different write target:

| Helper | Use For | Write Path |
|---|---|---|
| [`git_local.ts`](git_local.ts) — `commitFiles()` | Writes to **this repo** from a runner that has a local clone | Local clone → `git push` |
| [`github_api.ts`](github_api.ts) — `ghPut()` / `ghBatchCommit()` | Writes to any **other** repo OR reads from any repo | GitHub Contents/Trees REST API |

### Why split

`ghBatchCommit`/`ghPut` write directly to `origin/main` via the REST API. When a worker on a host with a local clone uses REST writes, that local clone lags behind origin — and a concurrent session with uncommitted local edits can hit non-fast-forward errors and trigger destructive stash-and-rebase recovery. `commitFiles()` writes through the local clone with `flock` serialization, so origin only advances via the working tree and no session needs to pull-rebase.

### `commitFiles()` — local-clone writes (this repo only)

```ts
import { commitFiles } from "../../integrations/github/git_local.ts";

await commitFiles(
  [{ path: "knowledge/foo/bar.md", content: "..." }],
  "feat(foo): bar",
);
```

- Runs on the host holding the local clone. Reads `CONTEXT_REPO_PATH` env var (default: this repo's path).
- `flock`-serialized so concurrent workers can't race on `.git/index` or push fast-forward.
- `git pull --rebase --autostash origin main` before commit handles any remaining REST writers.
- Files with `content === null` are deletes.
- No-op (returns `commitSha: ""`) when nothing changed after add.

### `github_api.ts` — REST API client

- Code on a host with a local clone imports the reference directly:

  ```ts
  import { createGitHubSession, ghGetJson, ghGetTree, type GitHubSession } from "../../integrations/github/github_api.ts";
  ```

### Export surface

| Function / Type | Purpose |
|---|---|
| `createGitHubSession(token?)` | Auth via passed token or env; returns `GitHubSession` |
| `ghGet(session, path)` | Raw response body (string or null on 404) |
| `ghGetJson<T>(session, path)` | JSON GET with typed return |
| `ghGetTree(session, owner, repo, ref)` | Recursive tree fetch (all files in repo) |
| `ghGetRaw(session, path)` | Raw file content |
| `ghGetRawBatch(session, paths, opts?)` | Concurrent raw-file batch with rate limiting |
| `ghPut(session, path, body)` | PUT request — for repos OTHER than this one (use `commitFiles` for this repo) |
| `ghBatchCommit(session, owner, repo, branch, files, message)` | Multi-file atomic commit via tree API — for repos OTHER than this one |
| `GitHubSession`, `TreeEntry`, `BatchFile` | Shared types |

## Authentication

The `gh` CLI is authenticated and has write access to the repos you own.

### Token Scopes

A useful starting scope set: `repo`, `workflow`, `read:org`, `gist`, `notifications`.

`notifications` is required for the GraphQL `updateSubscription` mutation (subscribe/unsubscribe to issues and PRs programmatically). To add a missing scope:

```bash
gh auth refresh -h github.com -s <scope>
```

### Push Access

SSH deploy keys on some repos are **read-only**. If `git push` fails with a deploy key error, switch the remote to HTTPS:

```bash
git remote set-url origin https://github.com/<owner>/<repo>.git
git push
```

HTTPS pushes use `gh` auth (credential helper), which has full write access.

### API Access

```bash
gh api repos/<owner>/<repo>          # REST
gh repo view <owner>/<repo>          # high-level
gh pr create / gh issue create       # workflows
```

## Gotchas

- **Deploy key != write access.** Several repos may have SSH deploy keys that only allow fetch. Fall back to HTTPS via `gh` auth when push is denied.

## Common invocations

Replace `<owner>/<repo>` with your own. Token is read from a vault item below; swap in your own item path.

### Smoke / auth check
```bash
GH_TOKEN="$(op read 'op://<your-vault>/<github-item-id>/credential')" gh api user --jq '.login'
```

### Refresh / re-auth
```bash
op read 'op://<your-vault>/<github-item-id>/credential' | gh auth login --hostname github.com --with-token >/dev/null && gh auth status --hostname github.com --json hosts --jq '.hosts["github.com"][0] | {login,scopes}'
```

### Common queries / actions
- Verify repo access + default branch: `gh repo view <owner>/<repo> --json nameWithOwner,visibility,viewerPermission,defaultBranchRef --jq '{repo:.nameWithOwner,visibility,permission:.viewerPermission,defaultBranch:.defaultBranchRef.name}'`
- Fetch recursive file tree (CLI analog to `ghGetTree`): `gh api 'repos/<owner>/<repo>/git/trees/main?recursive=1' --jq '.tree[] | select(.type=="blob") | .path' | sed -n '1,200p'`
- Read a file as raw text (CLI analog to `ghGet`/`ghGetRaw`): `gh api repos/<owner>/<repo>/contents/README.md -H 'Accept: application/vnd.github.raw' | sed -n '1,40p'`
- Read file metadata + SHA (for update flows): `gh api repos/<owner>/<repo>/contents/README.md --jq '{path,sha,size}'`
- List recent merged PRs: `gh pr list --repo <owner>/<repo> --state merged --limit 10 --json number,title,mergedAt,url --jq '.[] | {number,title,mergedAt,url}'`

### Common failures
- `gh` auth errors (`HTTP 401`, `authentication required`) → re-run the **Refresh / re-auth** command above, then retry.
- Missing scope errors (for example GraphQL subscription operations) → `gh auth refresh -h github.com -s notifications`
- `git push` denied with deploy key / read-only key message → `git remote set-url origin https://github.com/<owner>/<repo>.git && git push`
- `zsh: no matches found` when the endpoint includes `?recursive=1` → quote the API path: `gh api 'repos/<owner>/<repo>/git/trees/main?recursive=1' ...`
