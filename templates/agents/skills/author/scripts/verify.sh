#!/usr/bin/env bash
# verify.sh — Step "verify" of /author, AND the deterministic enforcement
# surface for the four principles the artifact must satisfy (SKILL.md § The four principles):
#   (1) Anthropic best practices  (2) low token usage
#   (3) high determinism          (4) low context usage
#
# Each principle is a GATE here, not advisory prose:
# an artifact that violates one fails verify the same way malformed frontmatter
# does. Sourced from Anthropic docs (code.claude.com/docs/en/{skills,sub-agents,
# hooks}).
#
#   skill → .agents/checks/check-skills.sh (the published Agent Skills
#           validator + AGENTS.md § Skill shape: the six keys, description
#           ≤1,024, metadata.peers, state/)               [P1 spec]
#         + description not first-person                 [P1 Anthropic]
#         + references one level deep (leaf refs)        [P4 context]
#         No sentence cap and no body cap for skills: the description folds
#         "when to use it" in, and the body standard is
#         deterministic-where-possible, concise and effective — not a line count.
#   hook  → shellcheck + `set -euo pipefail`
#         + top-level (PreToolUse) hooks MUST NOT `exit 1` (use exit 2 to block) [P1]
#         + non-blocking WARN when no harness hook manifest names a top-level
#           hook                                     [determinism / visibility]
#         (a check under .agents/checks/ gets no wiring claim: nothing
#         dispatches a new check on its own, and a WARN against a dispatcher
#         that does not exist would report every check unwired)
#   agent → 6-field frontmatter SSOT (references/agent.md)
#         + description not first-person, ONE sentence   [P1 Anthropic, P2 token]
#         + `tools` is a non-empty scoped list           [P1 best practice, P2 token]
#           (field is `tools`, NOT `allowed-tools` — the latter is ignored)
#
# Usage: verify.sh <type> <path>
# Exit: 0 pass; 1 conformance/principle failure (actionable stderr); 2 usage.

set -euo pipefail

err() { echo "$@" >&2; }

# A skill's description cap is the Agent Skills spec's 1,024, enforced by
# check-skills.sh; agents have no documented character cap.
# Every agent description is always-loaded text: agents are listed to the model
# on EVERY session, so the description is the one field whose length is paid
# per session rather than per invocation. One sentence — the job and who
# dispatches it — is the cap [P2 token, P4 context]. Everything else belongs in
# the body, which loads only when the artifact runs.
DESC_MAX_SENTENCES=1
# Agent SSOT field list (mirrors references/agent.md § Frontmatter contract).
# NB: the agent tool-allowlist field is `tools` (Anthropic), NOT `allowed-tools`
# — an unrecognized key is silently ignored and the agent inherits ALL tools.
AGENT_REQUIRED_FIELDS=(name description model tools peers)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# WHERE IS THE WORKBENCH? Three candidates, and the answer is PROVEN rather than
# assumed — the root must hold `.agents/skills/`, the folder the installer
# writes and every harness's skill link points into.
#
# The climb is first because it is the script's own workbench: this file lives
# at `<workbench>/.agents/skills/<skill>/scripts/`, so four levels up is the
# workbench — the session's worktree when invoked as
# `.agents/skills/<skill>/scripts/x.sh`, the checkout when invoked through the
# home link (`~/.agents/skills`, `~/.claude/skills`). `cd -P` walks the REAL
# directory, so the link is followed before `..` is applied and the climb never
# lands in `~/.agents`. It fails for a copy of this file that sits outside a
# workbench (the template repo's `templates/agents/skills/`, a test's scratch
# dir), where a proven CLAUDE_PROJECT_DIR (a Claude Code hook sets it; nothing
# else does) or `git rev-parse` answers instead.
#
# A script elsewhere that needs the workbench root the same way should carry
# this function verbatim; change them together.
resolve_repo_root() {
  local cand
  for cand in "$(cd -P "$1/../../../.." 2>/dev/null && pwd)" \
              "${CLAUDE_PROJECT_DIR:-}" \
              "$(git rev-parse --show-toplevel 2>/dev/null || true)"; do
    [[ -n "$cand" ]] || continue
    [[ -d "$cand/.agents/skills" ]] || continue
    printf '%s\n' "$cand"
    return 0
  done
  return 1
}

REPO_ROOT="$(resolve_repo_root "$SCRIPT_DIR" || true)"

type="${1:-}"
path="${2:-}"

if [[ -z "$type" || -z "$path" ]]; then
  err "usage: $(basename "$0") <type> <path>"
  exit 2
fi
case "$type" in
  skill|hook|agent|output-style) ;;
  *) err "unknown type: $type (skill|hook|agent|output-style)"; exit 2 ;;
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
# The standalone `I` is case-sensitive so "AI"/"API" are spared; the
# possessive/plural markers are case-insensitive (probe finding 2 —
# `my`/`we`/`our`/`me` slipped the old `I`-only check). Word edges are spelled
# as non-word classes rather than `\b`, which BSD grep -E does not honour
# everywhere.
description_is_first_person() {
  grep -qE '(^|[^[:alnum:]_])I([^[:alnum:]_]|$)' <<<"$1" && return 0
  grep -qiE "(^|[^[:alnum:]_])(my|me|we|our|us|i'm|i'll|i've)([^[:alnum:]_]|$)" <<<"$1"
}
# Count sentences in a description. A terminator only counts when a space or the
# end of the string follows it, and the dots that are NOT sentence ends are
# neutralized first: dotted names (`claude.ai`, `SKILL.md`, `package.json`),
# decimals, ellipses, and the stock abbreviations. Without that, one mention of
# a filename would read as two sentences and the gate would fire on a compliant
# description. The abbreviation's left edge is a non-word class, not `\b`,
# which BSD sed -E does not support.
description_sentence_count() {
  local d
  d="$(sed -E \
        -e 's/\.\.\./…/g' \
        -e "s/(^|[^[:alnum:]_])(e\\.g|i\\.e|etc|vs|approx)\\./\\1\\2/g" \
        -e 's/([A-Za-z0-9])\.([A-Za-z0-9])/\1\2/g' \
        <<<"$1")"
  # `grep | wc -l` cannot be used here: under `pipefail` a description with no
  # terminator at all (the common one-clause case) makes grep exit 1, which
  # aborts verify under `set -e` before any gate reports. Capture, then count.
  local terminators
  terminators="$(grep -oE "[.!?]+[\"')]*([[:space:]]|$)" <<<"$d" || true)"
  if [[ -z "$terminators" ]]; then
    echo 0
  else
    # Arithmetic strips the padding BSD `wc` puts before the count.
    echo $(( $(wc -l <<<"$terminators") ))
  fi
}

fail=0
flag() { err "FAIL — $1"; fail=1; }

# Documented agent frontmatter fields, read first-hand from
# code.claude.com/docs/en/sub-agents plus the repo-only key (`peers`). An
# unrecognized key is SILENTLY IGNORED at load — the same
# failure the output-style branch already guards — so `allowed-tools` for
# `tools` reads as absent and the agent runs with every tool. Skills have no
# such list here: the published validator in check-skills.sh owns their keys.
AGENT_KNOWN_FIELDS=(name description model tools color skills peers)

# flag_unknown_keys <path> <label> <known-field>...
flag_unknown_keys() {
  local path="$1" label="$2"; shift 2
  local known=(" $* ") fm_end frontmatter fmline key
  fm_end="$(frontmatter_end_line "$path")"
  [[ -z "$fm_end" ]] && return 0
  frontmatter="$(sed -n "2,$((fm_end - 1))p" "$path")"
  while IFS= read -r fmline; do
    [[ "$fmline" =~ ^[[:space:]]*$ ]] && continue
    [[ "$fmline" =~ ^[[:space:]]*# ]] && continue
    [[ "$fmline" =~ ^[[:space:]] ]] && continue   # nested value, not a key
    [[ "$fmline" =~ ^- ]] && continue             # list item at column 0
    key="${fmline%%:*}"
    [[ "$key" == "$fmline" ]] && continue          # no colon, not a key line
    # Exact token match — `grep -w` treats a hyphen as a boundary and would
    # wave `tools:` through as a substring of `allowed-tools`.
    [[ " ${known[*]} " == *" $key "* ]] \
      || flag "$label unknown frontmatter key \`${key}:\` — silently ignored at load; check the spelling against code.claude.com/docs/en/skills: $path"
  done <<<"$frontmatter"
}

case "$type" in
  skill)
    # The conformance check lives at `.agents/checks/`, three levels up from
    # this script and then down, and is the same one land.sh runs before every
    # commit: the published Agent Skills validator (the six keys, name =
    # folder, description ≤1,024) plus AGENTS.md § Skill shape's local rules.
    # It prints its own violation lines; a failure here is one of those.
    "$SCRIPT_DIR/../../../checks/check-skills.sh" "$(dirname "$path")" || fail=1

    desc="$(frontmatter_value "$path" description)"
    if [[ -z "$desc" ]]; then
      flag "skill has no description: — it is the invocation trigger (Anthropic)"
    elif description_is_first_person "$desc"; then
      flag "description is first-person — Anthropic requires third person (\"Scaffolds…\", not \"I scaffold…\") [P1]: $path"
    fi

    # References must be one level deep: a file under references/ must not link
    # to another .md (that would be a second hop Claude has to chase) [P4].
    refs_dir="$(dirname "$path")/references"
    if [[ -d "$refs_dir" ]]; then
      while IFS= read -r ref; do
        # A LOCAL `](...md)` link is a second hop; external https doc URLs
        # ending `.md` are allowed (SKILL.md encourages citing Anthropic doc
        # URLs) — probe finding 5. A link back UP to the owning SKILL.md is
        # also allowed: it is the breadcrumb home, not a further hop outward,
        # and flagging it would fail correctly-shaped reference docs for
        # carrying the one link this rule most wants them to have.
        if grep -oE '\]\([^)]+\.md\)' "$ref" \
          | grep -vE '\]\(https?://' \
          | grep -qvE '\]\((\.\./)?SKILL\.md\)'; then
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
    # Safe mode, plus its fail-open carve-out: a Stop /
    # decision hook that must NEVER block on its own internal error MAY drop
    # `-e`, PROVIDED the `set` line carries an inline rationale comment. Under
    # `-e` an unguarded failure aborts non-zero, which for a Stop hook BLOCKS
    # the stop — the exact trap fail-open exists to prevent. Without this
    # branch the check would fail every sanctioned fail-open Stop hook, i.e.
    # enforce the rule's first paragraph and not its carve-out.
    if ! grep -qE '^set -euo pipefail' "$path" \
      && ! grep -qE '^set -uo pipefail[[:space:]]+#.*fail-open' "$path"; then
      flag "hook missing \`set -euo pipefail\` — a
       fail-open Stop hook may use \`set -uo pipefail  # ... fail-open ...\`
       with an inline rationale on the set line: $path"
    fi
    # Placement gate: a top-level .agents/hooks/<name>.sh is a PreToolUse/
    # PostToolUse hook — exit 1 is NON-blocking there, so a blocker that
    # uses it silently fails to block. Must exit 2 to block (Anthropic) [P1].
    # `templates/agents/…` is the same folder in the template repo.
    case "$path" in
      *.agents/checks/*|*templates/agents/checks/*) ;;  # a check: exit 1 is correct
      *.agents/hooks/*|*templates/agents/hooks/*)
        if sed 's/#.*//' "$path" | grep -qE '(^|[;{(&|[:space:]])exit[[:space:]]+1([[:space:]]|[;)&|]|$)'; then
          flag "top-level hook uses \`exit 1\` (NON-blocking) — a PreToolUse blocker must \`exit 2\`; checks belong in .agents/checks/ [P1]: $path"
        fi
        ;;
    esac
    [[ $fail -ne 0 ]] && exit 1
    base="$(basename "$path")"
    # Non-blocking wiring check for a TOP-LEVEL hook only: it fires from nothing
    # until a hook manifest names it. The installer wires `.agents/hooks/` per
    # harness, each in the file that harness reads — Claude Code
    # `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Antigravity
    # `<workbench>/.agents/hooks.json` — so ANY of them naming the hook counts.
    # A check in `.agents/checks/` gets no claim. An unresolvable workbench root
    # is not evidence of an unwired hook either — saying "not wired" with the
    # workbench's own manifest unread would be a claim about a file this run
    # never opened.
    case "$path" in
      *.agents/checks/*|*templates/agents/checks/*) ;;
      *)
        if [[ -z "$REPO_ROOT" ]]; then
          err "WARN — could not find the workbench, so '$base' was not checked for"
          err "       wiring. Set CLAUDE_PROJECT_DIR to the workbench checkout."
        elif ! grep -qF "$base" "$HOME/.claude/settings.json" \
                  "$HOME/.codex/hooks.json" "$REPO_ROOT/.agents/hooks.json" 2>/dev/null; then
          err "WARN — '$base' authored but not wired (no hook manifest names it:"
          err "       ~/.claude/settings.json, ~/.codex/hooks.json, .agents/hooks.json)"
          err "       — it will never fire until wired."
        fi
        ;;
    esac
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
    # The block MUST parse as YAML — an unquoted `: ` anywhere in a value
    # ("Different job: the adversarial reviewer…") breaks it, and every field
    # goes with it at load: `tools:`, `model:`, the description. An agent has
    # shipped that way before. Skill side, the published validator in
    # check-skills.sh reports the same failure.
    # The parse uses PyYAML when python3 has it. Without it (macOS's stock
    # python3) a fallback checks the failure that matters: a top-level value
    # left unquoted while holding `: ` (or ending in `:`). An ImportError must
    # neither fail every agent nor let a malformed one through.
    yaml_bad=0
    if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
      printf '%s\n' "$frontmatter" \
        | python3 -c 'import sys, yaml; yaml.safe_load(sys.stdin.read())' >/dev/null 2>&1 || yaml_bad=1
    elif printf '%s\n' "$frontmatter" | awk '
        /^[A-Za-z_][A-Za-z0-9_-]*:[ \t]/ {
          v = $0; sub(/^[^:]*:[ \t]+/, "", v)
          if (v ~ /^["\047>|\[{&*!]/) next
          if (v ~ /: / || v ~ /:$/) bad = 1
        }
        END { exit bad ? 0 : 1 }'; then
      yaml_bad=1
    fi
    if [[ "$yaml_bad" -eq 1 ]]; then
      flag "agent frontmatter does not parse as YAML — every field is silently dropped at load (quote the value holding \`: \`, or fold it into a \`>-\` block): $path"
    fi
    flag_unknown_keys "$path" "agent" ${AGENT_KNOWN_FIELDS[@]+"${AGENT_KNOWN_FIELDS[@]}"}
    for field in ${AGENT_REQUIRED_FIELDS[@]+"${AGENT_REQUIRED_FIELDS[@]}"}; do
      grep -qE "^${field}:" <<<"$frontmatter" \
        || flag "agent frontmatter missing required field \`${field}:\` (per references/agent.md): $path"
    done

    desc="$(frontmatter_value "$path" description)"
    if [[ -n "$desc" ]] && description_is_first_person "$desc"; then
      flag "agent description is first-person — Anthropic requires third person [P1]: $path"
    fi
    if [[ -n "$desc" ]]; then
      sentences="$(description_sentence_count "$desc")"
      if [[ $sentences -gt $DESC_MAX_SENTENCES ]]; then
        flag "agent description is $sentences sentences — write ONE sentence naming the job and who dispatches it; the agent list is loaded every session, so the rest belongs in the body [P2/P4]: $path"
      fi
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
    # Field list read first-hand from code.claude.com/docs/en/output-styles.
    # All four are OPTIONAL to the parser — which is the problem
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
      # known.
      case "$key" in
        name|description|keep-coding-instructions|force-for-plugin) ;;
        *)
          flag "output-style unknown frontmatter key \`${key}:\` — silently ignored at load; valid keys are: $OS_KNOWN_FIELDS: $path" ;;
      esac
    done <<<"$frontmatter"

    # (2) description drives the /config picker; without it there is no entry.
    desc="$(frontmatter_value "$path" description)"
    if [[ -z "$desc" ]]; then
      flag "output-style missing \`description:\` — the /config picker shows this, so the style is unpickable without it: $path"
    else
      sentences="$(description_sentence_count "$desc")"
      if [[ $sentences -gt $DESC_MAX_SENTENCES ]]; then
        flag "output-style description is $sentences sentences — the /config picker shows one line, so write ONE sentence [P2]: $path"
      fi
    fi

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
