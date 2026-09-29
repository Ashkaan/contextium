#!/usr/bin/env bash
# resolve-scope.sh — scope resolution for /implement Phase 4. Parse the scope argument and
# emit one repo-relative file path per line to stdout.
#
# Owns the scope-resolution table, formerly in the retired /validate skill.
#
# peers: .agents/skills/implement/scripts/resolve-scope.test.sh,
#        .agents/skills/implement/scripts/layer-1.sh,
#        .agents/skills/implement/scripts/layer-2.sh
#
# Usage:
#   resolve-scope.sh --scope <arg>
#
# Flags:
#   --scope <arg>   blank | apps/<app> | apps/<domain>/<app> | apps/<domain> |
#                   <name> matching apps/* | integrations/<name> |
#                   projects/<path> | glob
#
#                   An apps/ scope must name a DIRECTORY and is never widened to
#                   its parent — see the branch below for what that widening cost.
#
# Output:
#   stdout: one repo-relative path per line (may be empty)
#   stderr: scope-arg errors
#
# Exit:
#   0  scope resolved (zero or more files)
#   1  scope refers to a non-existent app/integration

set -euo pipefail

err() { echo "$@" >&2; }

SCOPE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SCOPE="${2:-}"
      shift
      [[ $# -gt 0 ]] && shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0" >&2
      exit 0
      ;;
    *)
      err "unknown flag: $1"
      exit 1
      ;;
  esac
done

# Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
# back to git when unset (some callers leave it unset). Keep `|| true`
# inside the substitution so a failing rev-parse outside a repo doesn't trip
# `set -e` (exit 128) before the guard surfaces the documented exit code.
REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_DIR" ]] || { err "CLAUDE_PROJECT_DIR unset and not inside a git repo"; exit 1; }
# `.git` is a DIRECTORY in a normal clone and a FILE (a gitdir pointer) in a
# linked worktree. `-d` rejected every worktree — and /implement runs Phase 4
# (all five Phase 4 layers) inside one, so this guard failed the whole build
# path. `-e` accepts both; a stray .git in a non-repo still fails downstream.
[[ -e "$REPO_DIR/.git" ]] || { err "not a git repo: $REPO_DIR"; exit 1; }

cd "$REPO_DIR"

# ── Blank scope → staged files ───────────────────────────────────────
if [[ -z "$SCOPE" ]]; then
  git diff --cached --name-only | grep -v '^$' || true
  exit 0
fi

# Every file a package owns, whatever its language: the layers find each
# file's package and run that package's own lint and tests, so filtering to
# *.ts here made a JavaScript-only package an empty scope that passed without
# running anything. Installed dependencies, build output and git internals are
# not the package's source.
src_files() {
  find "$1" \( -name node_modules -o -name .git -o -name dist -o -name build \) -prune \
    -o -type f -print 2>/dev/null | sort
}

# ── apps/<name>, apps/<domain>/<app>, or a bare <name> matching apps/* ──
#
# THE SCOPE IS USED AS GIVEN WHEN IT NAMES A DIRECTORY. Taking only the FIRST
# path segment would resolve `--scope apps/<domain>/<app>` to `apps/<domain>` —
# the whole domain and every sibling app — and layer 1 would then FAIL the
# caller's phase on a type error in an app the caller never named. Apps may be
# grouped by domain (`apps/<domain>/<app>/`), and every peer that finds an app's
# directory (layer-1.sh, layer-2.sh, this) must respect that grouping.
#
# There is NO first-segment fallback, and that is deliberate. A flat
# `apps/<name>` and a domain somebody means literally both already name a
# directory, so they need no special case — and the only input the fallback
# could still catch is a path that is NOT a directory, i.e. a typo. Widening a
# typo to its parent domain silently selects a superset the caller never asked
# for; failing loud on it is strictly better.
if [[ "$SCOPE" == apps/* ]]; then
  if [[ ! -d "$SCOPE" ]]; then
    err "app not found: ${SCOPE#apps/}"
    err "  an apps/ scope must name a directory — apps/<app>, apps/<domain>/<app>,"
    err "  or apps/<domain> for a whole domain. It is never widened to the parent."
    exit 1
  fi
  src_files "$SCOPE"
  exit 0
fi

# Bare name — try apps/<name> first
if [[ -d "apps/$SCOPE" ]]; then
  src_files "apps/$SCOPE"
  exit 0
fi

# ── integrations/<name> ──────────────────────────────────────────────
if [[ "$SCOPE" == integrations/* ]]; then
  name="${SCOPE#integrations/}"
  name="${name%%/*}"
  if [[ ! -d "integrations/$name" ]]; then
    err "integration not found: $name"
    exit 1
  fi
  src_files "integrations/$name"
  exit 0
fi

# ── projects/<path> — find code referenced by recent commits in that scope ─
#
# The project folder is a record in this repo, read from the session's write
# root (the thread's worktree, else this checkout). The join is still by SUBJECT
# rather than by path: a session closes once and `land.sh` commits everything
# the thread owns under the SAME subject, so the project's recent subjects name
# the code commits, whichever worktree each was made in. That is a real link,
# not a guess: it is written by one script from one variable.
if [[ "$SCOPE" == projects/* ]]; then
  PROJECTS_ROOT="$(bash "$(dirname "${BASH_SOURCE[0]}")/session-write-root.sh" 2>/dev/null || true)"
  if [[ -z "$PROJECTS_ROOT" ]]; then
    err "cannot resolve this session's write root — a projects/ scope needs it"
    exit 1
  fi
  if [[ ! -d "$PROJECTS_ROOT/$SCOPE" ]]; then
    err "project not found: $PROJECTS_ROOT/$SCOPE"
    exit 1
  fi
  # The subjects of the last few commits that touched this project…
  subjects=$(git -C "$PROJECTS_ROOT" log -n 10 --pretty=format:%s -- "$SCOPE" 2>/dev/null | sort -u)
  [[ -n "$subjects" ]] || exit 0
  # …then the code files THIS repo committed under those same subjects.
  while IFS= read -r subj; do
    [[ -z "$subj" ]] && continue
    sha=$(git log -n 1 --fixed-strings --grep="$subj" --pretty=format:%H 2>/dev/null | head -n 1)
    [[ -z "$sha" ]] && continue
    git show --name-only --pretty=format: "$sha" 2>/dev/null | grep -vE '(^|/)(node_modules|\.git)/|\.md$|^$' || true
  done <<< "$subjects" | sort -u
  exit 0
fi

# ── Glob / fallback — pass to find ───────────────────────────────────
# Resolve by expanding the glob via `compgen -G`.
matches=()
while IFS= read -r m; do
  [[ -n "$m" ]] && matches+=("$m")
done < <(compgen -G "$SCOPE" 2>/dev/null || true)

if [[ ${#matches[@]} -eq 0 ]]; then
  err "no files match scope: $SCOPE"
  exit 1
fi

printf '%s\n' ${matches[@]+"${matches[@]}"} | sort
