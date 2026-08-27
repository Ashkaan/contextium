#!/usr/bin/env bash
# verify.sh — the conformance check /author runs before calling an artifact done.
#
# Each artifact type has a small number of ways to be structurally wrong, and all
# of them are checkable without judgment: a missing frontmatter field, an agent
# using the field name that agents silently ignore, a blocking hook that exits 1
# (which does not block), a hook nothing references.
#
# USAGE
#   verify.sh skill <name>
#   verify.sh agent <name>
#   verify.sh hook  <name>
#   verify.sh rule  <slug>
#
# OUTPUT: one line per check — `ok:` or `FAIL:`.
# EXIT: 0 all checks passed; 1 any check failed; 2 usage error.

set -uo pipefail

TYPE="${1:-}"
NAME="${2:-}"
[[ -n "$TYPE" && -n "$NAME" ]] || { echo "usage: verify.sh skill|agent|hook|rule <name>" >&2; exit 2; }

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$ROOT" ]] || { echo "not inside a git repo, and CLAUDE_PROJECT_DIR is unset" >&2; exit 2; }
cd "$ROOT" || exit 2

FAILED=0
ok()   { echo "ok: $*"; }
bad()  { echo "FAIL: $*"; FAILED=1; }

frontmatter() { awk 'NR==1 && $0=="---"{f=1; next} f && $0=="---"{exit} f' "$1"; }

case "$TYPE" in
  skill)
    f=".claude/skills/${NAME}/SKILL.md"
    [[ -f "$f" ]] || { bad "$f does not exist"; exit 1; }
    fm="$(frontmatter "$f")"
    for field in name description; do
      grep -qE "^${field}:" <<<"$fm" && ok "frontmatter has ${field}" || bad "frontmatter is missing ${field}:"
    done
    # The description is what the model routes on. One that never says when the
    # skill applies is a skill that never fires.
    desc="$(grep -E '^description:' <<<"$fm" | head -1)"
    [[ "${#desc}" -gt 60 ]] && ok "description is substantive" \
      || bad "description is too short to route on — say WHAT it does and WHEN to use it"
    if grep -qE '^steps:' <<<"$fm"; then
      grep -qE '^\s+- id:' <<<"$fm" && ok "step graph has ids" || bad "steps: present but no step has an id"
      # Every step id needs a body section; a graph nobody implemented is a
      # promise the skill does not keep.
      while read -r id; do
        grep -qE "^#{2,3} .*${id}" "$f" && ok "step ${id} has a body section" \
          || bad "step ${id} is declared but has no body section"
      done < <(grep -E '^\s+- id:' <<<"$fm" | sed -E 's/.*- id:[[:space:]]*//')
    else
      ok "no step graph (single-body skill)"
    fi
    ;;

  agent)
    f=".claude/agents/${NAME}.md"
    [[ -f "$f" ]] || { bad "$f does not exist"; exit 1; }
    fm="$(frontmatter "$f")"
    for field in name description; do
      grep -qE "^${field}:" <<<"$fm" && ok "frontmatter has ${field}" || bad "frontmatter is missing ${field}:"
    done
    # An agent's tool allowlist field is `tools`. `allowed-tools` is the SKILL
    # field name; on an agent it is silently ignored, so the agent quietly runs
    # with the default toolset instead of the one you wrote down.
    if grep -qE '^allowed-tools:' <<<"$fm"; then
      bad "agent uses allowed-tools: — agents read 'tools:'; this is silently ignored"
    else
      grep -qE '^tools:' <<<"$fm" && ok "tools: present" || ok "tools: omitted (agent inherits the default set)"
    fi
    ;;

  hook)
    f=".claude/hooks/${NAME}.sh"
    [[ -f "$f" ]] || { bad "$f does not exist"; exit 1; }
    head -1 "$f" | grep -q '^#!' && ok "has a shebang" || bad "missing a shebang line"
    grep -qE '^set -[eu]' "$f" && ok "sets shell safe mode" || bad "missing 'set -uo pipefail' (or equivalent)"
    if command -v shellcheck >/dev/null 2>&1; then
      out="$(shellcheck -S warning "$f" 2>&1)" && ok "shellcheck clean" || { bad "shellcheck: $out"; }
    else
      ok "shellcheck not installed — skipped"
    fi
    # A hook nothing references never runs, and nothing anywhere reports that.
    if grep -q "$(basename "$f")" .claude/settings.json 2>/dev/null; then
      ok "wired into settings.json"
    else
      bad "not referenced in .claude/settings.json — an unwired hook never fires"
    fi
    # Exit 1 from a PreToolUse hook prints and lets the call through.
    if grep -q 'PreToolUse' "$f" || grep -q "$(basename "$f")" .claude/settings.json 2>/dev/null; then
      grep -qE 'exit 2' "$f" && ok "has a blocking exit (2)" \
        || bad "no 'exit 2' — a PreToolUse hook that exits 1 does NOT block the call"
    fi
    ;;

  rule)
    hits="$(grep -rn "^## ${NAME}\$" .claude/rules/ 2>/dev/null || true)"
    if [[ -z "$hits" ]]; then
      bad "no rule with id '${NAME}' found under .claude/rules/"
    else
      count="$(grep -c . <<<"$hits")"
      [[ "$count" -eq 1 ]] && ok "rule id is unique" || { bad "rule id '${NAME}' is defined ${count} times:"; echo "$hits"; }
      body_line="$(grep -rA2 "^## ${NAME}\$" .claude/rules/ | grep -E 'MUST' || true)"
      [[ -n "$body_line" ]] && ok "rule body is imperative (MUST / MUST NOT)" \
        || bad "rule body has no MUST/MUST NOT — a rule that only describes is advice, not a rule"
      # Informational, not a failure: dating a rule makes it auditable later, but
      # rules written before the convention are not defective for lacking one.
      grep -rA3 "^## ${NAME}\$" .claude/rules/ | grep -qE '\[[0-9]{4}-[0-9]{2}-[0-9]{2}\]' \
        && ok "rule cites a date" \
        || ok "rule has no [YYYY-MM-DD] — worth adding so it can be audited later"
    fi
    ;;

  *)
    echo "usage: verify.sh skill|agent|hook|rule <name>" >&2
    exit 2
    ;;
esac

exit "$FAILED"
