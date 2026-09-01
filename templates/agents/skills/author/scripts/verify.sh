#!/usr/bin/env bash
# verify.sh — Step "verify" of /author, AND the deterministic enforcement
# surface for the four principles the artifact must satisfy (SPEC § 5a):
#   (1) Anthropic best practices  (2) low token usage
#   (3) high determinism          (4) low context usage
#
# Each principle is a GATE here, not advisory prose (@rule:mechanisms-not-prose):
# an artifact that violates one fails verify the same way malformed frontmatter
# does. Sourced from Anthropic docs (code.claude.com/docs/en/{skills,sub-agents,
# hooks}).
#
#   rule  → run-rule-linters.sh (format + refs)
#   skill → check-skill-format.sh
#         + description ≤1536 chars & not first-person   [P1 Anthropic, P2 token]
#         + SKILL.md body ≤500 lines                     [P2 token, P4 context]
#         + references one level deep (leaf refs)        [P4 context]
#   hook  → shellcheck + `set -euo pipefail`
#         + top-level (PreToolUse) hooks MUST NOT `exit 1` (use exit 2 to block) [P1]
#         + non-blocking WARN if unwired                 [determinism / visibility]
#   agent → 6-field frontmatter SSOT (references/agent.md)
#         + description not first-person                 [P1 Anthropic]
#         + `tools` is a non-empty scoped list           [P1 best practice, P2 token]
#           (field is `tools`, NOT `allowed-tools` — the latter is ignored)
#
# Usage: verify.sh <type> <path>
# Exit: 0 pass; 1 conformance/principle failure (actionable stderr); 2 usage.

set -euo pipefail

err() { echo "$@" >&2; }

# Anthropic limits (code.claude.com/docs/en/skills).
DESC_MAX_CHARS=1536
SKILL_BODY_MAX_LINES=500
# Agent SSOT field list (mirrors references/agent.md § Frontmatter contract).
# NB: the agent tool-allowlist field is `tools` (Anthropic), NOT `allowed-tools`
# — an unrecognized key is silently ignored and the agent inherits ALL tools.
AGENT_REQUIRED_FIELDS=(name description model tools peers enforces)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Ask git, the way scaffold.sh does. Counting directories up from this script is
# wrong in the repo that AUTHORS the layer — the skills sit one level deeper
# there, so a fixed count landed on templates/ and every linter lookup missed,
# reporting a clean verify over checks that never ran.
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO_ROOT" ]]; then
  err "not inside a git repository, and CLAUDE_PROJECT_DIR is unset"
  exit 2
fi

type="${1:-}"
path="${2:-}"

if [[ -z "$type" || -z "$path" ]]; then
  err "usage: $(basename "$0") <type> <path>"
  exit 2
fi
case "$type" in
  rule|skill|hook|agent|output-style) ;;
  *) err "unknown type: $type (rule|skill|hook|agent|output-style)"; exit 2 ;;
esac
if [[ ! -f "$path" ]]; then
  err "path not found: $path"
  exit 1
fi

# ── Shared frontmatter helpers ────────────────────────────────────────────
frontmatter_end_line() {
  awk '/^---$/{c++; if(c==2){print NR; exit}}' "$1"
}
# Echo the FULL logical YAML value for <field>, folding block scalars (`>` / `|`)
# and block sequences (`- item`) into one space-joined string. Reading only the
# key's own line let a `description: >` folded scalar bypass the length +
# first-person gates and made a block-style `tools:` list read as empty
# (probe findings 1/4/6). Surrounding quotes are stripped so the char count is
# exact.
frontmatter_value() {
  local file="$1" field="$2"
  awk -v field="$field" '
    NR==1 && $0=="---" { infm=1; next }
    infm && $0=="---" { exit }
    !infm { next }
    {
      if (capturing) {
        if ($0 ~ /^[[:space:]]/ || $0 ~ /^[[:space:]]*-/) {
          line=$0; sub(/^[[:space:]]+/, "", line); sub(/^-[[:space:]]*/, "", line)
          if (line != "") val = (val=="" ? line : val " " line)
          next
        } else { capturing=0 }
      }
      if ($0 ~ ("^" field ":")) {
        v=$0; sub(("^" field ":[[:space:]]*"), "", v)
        if (v ~ /^[>|][0-9+-]*$/) v=""        # block-scalar indicator, not content
        val=v; capturing=1; next
      }
    }
    END {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      if (val ~ /^".*"$/ || val ~ /^'"'"'.*'"'"'$/) val=substr(val,2,length(val)-2)
      print val
    }
  ' "$file"
}
# Fail if a description is written in first person (Anthropic: third person).
# `\bI\b` is case-sensitive so "AI"/"API" are spared; the possessive/plural
# markers are case-insensitive (probe finding 2 — `my`/`we`/`our`/`me` slipped
# the old `\bI\b`-only check).
description_is_first_person() {
  grep -qE '\bI\b' <<<"$1" && return 0
  grep -qiE "\b(my|me|we|our|us|i'm|i'll|i've)\b" <<<"$1"
}

fail=0
flag() { err "FAIL — $1"; fail=1; }

case "$type" in
  rule)
    CLAUDE_PROJECT_DIR="$REPO_ROOT" "$SCRIPT_DIR/run-rule-linters.sh" "$path"
    ;;

  skill)
    if [[ -x "$REPO_ROOT/.githooks/checks/check-skill-format.sh" ]]; then
      "$REPO_ROOT/.githooks/checks/check-skill-format.sh" "$path" || fail=1
    else
      echo "SKIP — check-skill-format (not installed); running the inline checks only"
    fi

    desc="$(frontmatter_value "$path" description)"
    if [[ -z "$desc" ]]; then
      flag "skill has no description: — it is the invocation trigger (Anthropic)"
    else
      local_len=${#desc}
      if [[ $local_len -gt $DESC_MAX_CHARS ]]; then
        flag "description is $local_len chars (>$DESC_MAX_CHARS) — overflow collapses the skill to name-only in listings [P1/P2]: $path"
      fi
      if description_is_first_person "$desc"; then
        flag "description is first-person — Anthropic requires third person (\"Scaffolds…\", not \"I scaffold…\") [P1]: $path"
      fi
    fi

    end="$(frontmatter_end_line "$path")"
    if [[ -n "$end" ]]; then
      total="$(wc -l < "$path")"
      body_lines=$((total - end))
      if [[ $body_lines -gt $SKILL_BODY_MAX_LINES ]]; then
        flag "SKILL.md body is $body_lines lines (>$SKILL_BODY_MAX_LINES) — split detail into references/ [P2/P4]: $path"
      fi
    fi

    # References must be one level deep: a file under references/ must not link
    # to another .md (that would be a second hop the model has to chase) [P4].
    refs_dir="$(dirname "$path")/references"
    if [[ -d "$refs_dir" ]]; then
      while IFS= read -r ref; do
        # A LOCAL `](...md)` link is a second hop; external https doc URLs
        # ending `.md` are allowed (the SPEC encourages citing Anthropic doc
        # URLs) — probe finding 5.
        if grep -oE '\]\([^)]+\.md\)' "$ref" | grep -qvE '\]\(https?://'; then
          flag "reference doc links to another local .md — keep references one level deep from SKILL.md [P4]: $ref"
        fi
      done < <(find "$refs_dir" -maxdepth 1 -type f -name '*.md')
    fi

    [[ $fail -ne 0 ]] && exit 1
    echo "PASS — skill ($(basename "$(dirname "$path")"))"
    ;;

  hook)
    if ! command -v shellcheck >/dev/null 2>&1; then
      err "shellcheck not installed — cannot verify hook"
      exit 1
    fi
    shellcheck "$path" || fail=1
    # Shell safe mode, plus its fail-open carve-out: a Stop /
    # decision hook that must NEVER block on its own internal error MAY drop
    # `-e`, PROVIDED the `set` line carries an inline rationale comment. Under
    # `-e` an unguarded failure aborts non-zero, which for a Stop hook BLOCKS
    # the stop — the exact trap fail-open exists to prevent. Without this
    # branch the check failed BOTH sanctioned instances
    # (check-deferral-language-stop.sh, check-no-access-claim-stop.sh), i.e.
    # it enforced the rule's first paragraph and not its carve-out.
    if ! grep -qE '^set -euo pipefail' "$path" \
      && ! grep -qE '^set -uo pipefail[[:space:]]+#.*fail-open' "$path"; then
      flag "hook missing \`set -euo pipefail\` — a
       fail-open Stop hook may use \`set -uo pipefail  # ... fail-open ...\`
       with an inline rationale on the set line: $path"
    fi
    # Placement gate: a top-level .claude/hooks/<name>.sh is a PreToolUse/
    # PostToolUse Claude hook — exit 1 is NON-blocking there, so a blocker that
    # uses it silently fails to block. Must exit 2 to block (Anthropic) [P1].
    case "$path" in
      *.githooks/checks/*) ;;  # pre-commit check: exit 1 is correct
      *.claude/hooks/*)
        if sed 's/#.*//' "$path" | grep -qE '(^|[;{(&|[:space:]])exit[[:space:]]+1([[:space:]]|[;)&|]|$)'; then
          flag "top-level hook uses \`exit 1\` (NON-blocking) — a PreToolUse blocker must \`exit 2\`; pre-commit checks belong in .githooks/checks/ [P1]: $path"
        fi
        ;;
    esac
    [[ $fail -ne 0 ]] && exit 1
    # Non-blocking wiring check (@rule:surface-visible-signal).
    #
    # Search the CALLER, never the whole directory. A freshly scaffolded check
    # under .githooks/checks/ carries its own name in the wiring instructions in
    # its header comment, so a recursive search over .githooks/ matched the file
    # itself and reported every unwired check as wired — the one thing this
    # warning exists to catch.
    base="$(basename "$path")"
    case "$path" in
      *.githooks/checks/*) wired_in="$REPO_ROOT/.githooks/pre-commit" ;;
      *)                   wired_in="$REPO_ROOT/.claude/settings.json" ;;
    esac
    if ! grep -qF "$base" "$wired_in" 2>/dev/null; then
      err "WARN — '$base' authored but not wired (nothing in $(basename "$wired_in")"
      err "       invokes it) — it will never fire until wired."
    fi
    echo "PASS — hook ($base)"
    ;;

  agent)
    first_line="$(head -n 1 "$path")"
    if [[ "$first_line" != "---" ]]; then
      err "FAIL — agent missing YAML frontmatter (must start with \`---\`): $path"
      exit 1
    fi
    fm_end="$(frontmatter_end_line "$path")"
    if [[ -z "$fm_end" ]]; then
      err "FAIL — agent has unterminated frontmatter (no closing \`---\`): $path"
      exit 1
    fi
    frontmatter="$(sed -n "2,$((fm_end - 1))p" "$path")"
    for field in "${AGENT_REQUIRED_FIELDS[@]}"; do
      grep -qE "^${field}:" <<<"$frontmatter" \
        || flag "agent frontmatter missing required field \`${field}:\` (per references/agent.md): $path"
    done

    desc="$(frontmatter_value "$path" description)"
    if [[ -n "$desc" ]] && description_is_first_person "$desc"; then
      flag "agent description is first-person — Anthropic requires third person [P1]: $path"
    fi

    # `tools` must be a non-empty scoped list — an agent with no tool scoping
    # inherits everything (higher permission + token surface) [P1/P2]. The field
    # is `tools`, not `allowed-tools` (the latter is silently ignored on agents).
    tools="$(frontmatter_value "$path" tools)"
    if [[ -z "$tools" || "$tools" == "[]" ]]; then
      flag "agent tools is empty/absent — scope \`tools:\` to what the job needs (NOT \`allowed-tools\`, which agents ignore) [P1/P2]: $path"
    fi

    [[ $fail -ne 0 ]] && exit 1
    echo "PASS — agent ($(basename "$path"))"
    ;;

  output-style)
    # Field list read first-hand from code.claude.com/docs/en/output-styles
    # (2026-08-19). All four are OPTIONAL to the parser — which is the problem
    # this branch exists to fix: every failure below is silent at runtime.
    OS_KNOWN_FIELDS="name description keep-coding-instructions force-for-plugin"

    first_line="$(head -n 1 "$path")"
    if [[ "$first_line" != "---" ]]; then
      err "FAIL — output-style missing YAML frontmatter (must start with \`---\`): $path"
      exit 1
    fi
    fm_end="$(frontmatter_end_line "$path")"
    if [[ -z "$fm_end" ]]; then
      err "FAIL — output-style has unterminated frontmatter (no closing \`---\`): $path"
      exit 1
    fi
    frontmatter="$(sed -n "2,$((fm_end - 1))p" "$path")"

    # (1) Unknown key. The parser IGNORES these, so a typo'd field is a silent
    # no-op — `keep_coding_instructions` with an underscore reads as absent and
    # strips the coding instructions the author meant to keep.
    while IFS= read -r fmline; do
      [[ "$fmline" =~ ^[[:space:]]*$ ]] && continue
      [[ "$fmline" =~ ^[[:space:]]*# ]] && continue
      [[ "$fmline" =~ ^[[:space:]] ]] && continue   # nested value, not a key
      key="${fmline%%:*}"
      [[ "$key" == "$fmline" ]] && continue          # no colon, not a key line
      # Exact token match, NOT `grep -w`: hyphen is a non-word character, so
      # `-w` matched `keep`, `coding`, `instructions`, `force` and `plugin`
      # INSIDE the two hyphenated field names and waved all five through as
      # known (verified 2026-08-19).
      case "$key" in
        name|description|keep-coding-instructions|force-for-plugin) ;;
        *)
          flag "output-style unknown frontmatter key \`${key}:\` — silently ignored at load; valid keys are: $OS_KNOWN_FIELDS: $path" ;;
      esac
    done <<<"$frontmatter"

    # (2) description drives the /config picker; without it there is no entry.
    desc="$(frontmatter_value "$path" description)"
    [[ -n "$desc" ]] \
      || flag "output-style missing \`description:\` — the /config picker shows this, so the style is unpickable without it: $path"

    # (3) keep-coding-instructions DEFAULTS TO FALSE. Absent means Claude Code's
    # software-engineering instructions are stripped — almost never intended in
    # a coding repo, and invisible. Require the choice to be explicit.
    kci="$(frontmatter_value "$path" keep-coding-instructions)"
    case "$kci" in
      true|false) ;;
      "") flag "output-style missing \`keep-coding-instructions:\` — it defaults to FALSE, which STRIPS Claude Code's software-engineering instructions. Set it explicitly: $path" ;;
      *)  flag "output-style \`keep-coding-instructions: $kci\` is not true|false: $path" ;;
    esac

    [[ $fail -ne 0 ]] && exit 1
    echo "PASS — output-style ($(basename "$path"))"
    ;;
esac
