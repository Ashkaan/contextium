---
name: GitHub
description: Git hosting, PRs, issues, and repo management via gh CLI
hosts:
  - api.github.com
  - github.com
aliases:
  - gh
  - gh cli
  - pull request
  - github issue
typed_client:
  - none
access:
  - api
  - cli
  - ssh
uses: none
base_url: https://api.github.com
auth: bearer token (personal access token), or gh auth
onepassword_item: none
rate_limit: 5000 requests/hour authenticated
cli: "`gh` CLI"
---

# GitHub Integration

**Access order:** api, cli, ssh — the REST and GraphQL APIs reach everything `gh` does and run where `gh` is not installed, while SSH reaches only git itself.

## If you write a client

Nothing here ships one; `gh` covers every call below. If your automations write to git, split the write path by target:

| Target | Write path |
|---|---|
| **This repo**, from a host that has a local clone | Commit and push through that clone |
| Any **other** repo, or reads from any repo | GitHub REST API (Contents API for one file, Git Data API for several) |

**Why split:** a REST write advances `origin/main` behind the local clone's back. The clone then lags, and a session with uncommitted local edits hits non-fast-forward errors on its next push and falls into a stash-and-rebase recovery that can lose work. Writing through the clone means origin only moves via a working tree.

A local-clone commit helper, if you write one, should:

- Serialize with `flock` on a lock file, so concurrent jobs cannot race on `.git/index` or on the push.
- Run `git pull --rebase --autostash origin main` before committing, to absorb any remaining REST writers.
- Treat a file with null content as a delete.
- Return without committing when nothing changed after `git add`.

A REST helper is worth wrapping for: raw file reads (`Accept: application/vnd.github.raw`), the recursive tree (`git/trees/<ref>?recursive=1`), a concurrency-limited batch of raw reads, and a multi-file atomic commit (create blobs → create a tree on the base tree → create a commit → move the ref).

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
- Fetch recursive file tree: `gh api 'repos/<owner>/<repo>/git/trees/main?recursive=1' --jq '.tree[] | select(.type=="blob") | .path' | sed -n '1,200p'`
- Read a file as raw text: `gh api repos/<owner>/<repo>/contents/README.md -H 'Accept: application/vnd.github.raw' | sed -n '1,40p'`
- Read file metadata + SHA (for update flows): `gh api repos/<owner>/<repo>/contents/README.md --jq '{path,sha,size}'`
- List recent merged PRs: `gh pr list --repo <owner>/<repo> --state merged --limit 10 --json number,title,mergedAt,url --jq '.[] | {number,title,mergedAt,url}'`

### Common failures
- `gh` auth errors (`HTTP 401`, `authentication required`) → re-run the **Refresh / re-auth** command above, then retry.
- Missing scope errors (for example GraphQL subscription operations) → `gh auth refresh -h github.com -s notifications`
- `git push` denied with deploy key / read-only key message → `git remote set-url origin https://github.com/<owner>/<repo>.git && git push`
- `zsh: no matches found` when the endpoint includes `?recursive=1` → quote the API path: `gh api 'repos/<owner>/<repo>/git/trees/main?recursive=1' ...`
