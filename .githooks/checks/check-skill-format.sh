#!/usr/bin/env bash
# check-skill-format.sh — hold every skill to the Agent Skills specification
# (https://agentskills.io/specification) plus two local rules.
#
# Usage:
#   check-skill-format.sh                 # every skill under .agents/skills/ and templates/agents/skills/
#   check-skill-format.sh <path>...       # those skills — a SKILL.md or its folder
#
# Exit: 0 clean · 1 one or more violations (stderr lists each, file first) ·
#       2 a path that is neither a skill folder nor a SKILL.md in one.
#
# WHAT IT CHECKS, per skill:
#   - SKILL.md exists and opens with a closed `---` frontmatter block
#   - top-level keys are only: name, description, license, compatibility,
#     allowed-tools, metadata — each at most once
#   - name: present, equals the folder name, 1-64 chars of a-z 0-9 and
#     hyphens, no leading, trailing or doubled hyphen
#   - description: present, non-empty, at most 1024 characters
#   - compatibility: at most 500 characters when present
#   - allowed-tools: one space-separated string, never a YAML list
#   - metadata: a block map whose only key is `peers`, a non-empty string of
#     space-separated paths (the local rule: peers is the one custom key)
#   - a `state/` folder holds `_doc.md` saying what it holds and which script
#     writes and reads it (the local rule: state is described, never implicit)
#
# WHY. A key the harness does not know is ignored without a word, so a skill
# carrying one looks configured and is not. And a frontmatter that stops
# parsing makes the whole skill disappear from the listing, which nothing
# reports either.
#
# NOT A YAML PARSER. It reads the flat shape the spec allows — `key: value`,
# quoted values, `>`/`|` block scalars, and metadata's one level of nesting —
# and flags what falls outside it. That keeps it pure bash + awk, with no
# validator to install. Flow syntax (`[a, b]`, `{k: v}`) is refused.
#
# Runs on: pre-commit (the skills a commit touches), /author's verify step.
#
# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`,
# `readarray` and `declare -A` do not exist.
set -euo pipefail

# shellcheck source=SCRIPTDIR/yaml-scalar.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/yaml-scalar.sh"

issues=0
report() {
  echo "  SKILL-FORMAT: $1" >&2
  issues=$((issues + 1))
}

# Characters, not bytes: drop UTF-8 continuation bytes before counting, so an
# em dash counts once whatever the locale.
char_count() {
  printf '%s' "$1" | LC_ALL=C tr -d '\200-\277' | wc -c | tr -d ' '
}

# Collect the SKILL.md files to check.
files=()
if [[ $# -gt 0 ]]; then
  # A path that names no skill is the caller's mistake (exit 2), not a clean
  # result: a typo'd folder would otherwise be "checked" and pass.
  for p in "$@"; do
    if [[ -d "$p" ]]; then
      files+=("${p%/}/SKILL.md")
    elif [[ "$(basename "$p")" == "SKILL.md" && -d "$(dirname "$p")" ]]; then
      files+=("$p")
    else
      echo "check-skill-format: not a skill folder or SKILL.md: $p" >&2
      exit 2
    fi
  done
else
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  cd "$root"
  for d in .agents/skills templates/agents/skills; do
    [[ -d "$d" ]] || continue
    for s in "$d"/*/; do
      [[ -d "$s" ]] || continue
      files+=("${s%/}/SKILL.md")
    done
  done
fi

[[ ${#files[@]} -gt 0 ]] || exit 0

# Reads one frontmatter and prints one line per finding:
#   V<TAB>message        a violation
#   NAME<TAB>value       the name, unquoted
#   DESC<TAB>value       the description, block scalars folded onto one line
#   COMPAT<TAB>value     the compatibility string
parse_frontmatter() {
  awk -v sq="'" "$YAML_SCALAR_AWK"'
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    function is_block(v) { return v ~ /^[>|][+-]?[0-9]?$/ }
    # The value of a scalar as written (raw, continuation lines joined), with
    # a quote that never closes, or text after one, reported against label.
    function scalar_of(raw, label,   v) {
      v = yaml_scalar(raw)
      if (YS_STATE == "open") print "V\t" label " has an unclosed quote — the frontmatter will not parse"
      else if (YS_STATE == "trailing") print "V\t" label " has text after its closing quote — the frontmatter will not parse"
      return v
    }
    function flush(   v) {
      if (key == "") return
      v = block ? trim(val) : scalar_of(val, key)
      if (key == "name") print "NAME\t" v
      else if (key == "description") print "DESC\t" v
      else if (key == "compatibility") print "COMPAT\t" v
      if (key == "allowed-tools" && listy) print "V\tallowed-tools must be one space-separated string (\"Bash Read Edit\"), not a YAML list"
      if ((key == "name" || key == "description" || key == "license" || key == "compatibility") && listy)
        print "V\t" key " must be a string, not a list"
      if (key == "metadata") flush_meta()
      key = ""; val = ""; listy = 0; block = 0
    }
    function flush_meta() {
      if (mkey == "") return
      if (mkey != "peers") {
        print "V\tmetadata." mkey " is not allowed — the only metadata key is peers"
      } else if (mlisty) {
        print "V\tmetadata.peers must be a string of space-separated paths, not a list"
      } else {
        if (!mblock) mval = scalar_of(mval, "metadata.peers")
        if (trim(mval) == "") print "V\tmetadata.peers is empty — name the peers or drop the key"
      }
      mkey = ""; mval = ""; mlisty = 0; mblock = 0
    }
    NR == 1 { if ($0 != "---") { print "V\tmissing frontmatter — the file must open with a --- line"; bad = 1; exit } next }
    $0 == "---" { closed = 1; exit }
    /^[ \t]*$/ { if (block && key != "") val = val " "; next }
    /^#/ { next }
    /^[^ \t]/ {
      flush()
      if (!match($0, /^[A-Za-z0-9_-]+:/)) { print "V\tline " NR " is not a key: value line: " $0; next }
      key = substr($0, 1, RLENGTH - 1)
      rest = trim(substr($0, RLENGTH + 1))
      if (seen[key]++) print "V\tduplicate key " key
      known = (key ~ /^(name|description|license|compatibility|allowed-tools|metadata)$/)
      if (!known)
        print "V\tunknown key " key " — allowed: name, description, license, compatibility, allowed-tools, metadata"
      if (known && rest ~ /^[\[{]/) {
        print "V\t" key " uses flow syntax (" rest ") — write it in block form"
        rest = ""
      }
      if (is_block(rest)) { block = 1; val = "" }
      else { block = 0; val = rest }
      if (key == "metadata" && rest != "") print "V\tmetadata must be a block map (metadata:, then an indented peers: line)"
      next
    }
    {
      # An indented line: a continuation of the current key.
      line = trim($0)
      if (key == "metadata") {
        # A child key sits at the indent of the first child; anything deeper, or
        # any line while a block scalar is open, continues that child.
        ind = match($0, /[^ \t]/) - 1
        if (mind == 0 || ind <= mind) {
          if (match($0, /^[ \t]+[A-Za-z0-9_-]+:/)) {
            # Keep the match before flush_meta: it reads a scalar, and match()
            # in there resets RLENGTH.
            klen = RLENGTH
            flush_meta()
            mind = ind
            mkey = trim(substr($0, 1, klen - 1))
            mrest = trim(substr($0, klen + 1))
            if (mrest ~ /^[\[{]/) { print "V\tmetadata." mkey " uses flow syntax — write it in block form"; mrest = "x" }
            mblock = is_block(mrest)
            mval = mblock ? "" : mrest
          } else {
            print "V\tline " NR " under metadata is not a key: value line: " line
          }
        } else if (line ~ /^- / && mval == "") {
          mlisty = 1
        } else {
          mval = mval " " line
        }
        next
      }
      if (line ~ /^- / && !block) { listy = 1; next }
      val = (val == "" ? line : val " " line)
    }
    END {
      if (bad) exit
      if (NR == 0) { print "V\tmissing frontmatter — the file is empty"; exit }
      if (!closed) { print "V\tfrontmatter is never closed by a second --- line"; exit }
      flush()
    }
  ' "$1"
}

name_re='^[a-z0-9]+(-[a-z0-9]+)*$'

for file in "${files[@]}"; do
  dir="$(dirname "$file")"
  folder="$(basename "$dir")"

  if [[ ! -f "$file" ]]; then
    if [[ -d "$dir" ]]; then
      report "$dir: no SKILL.md — every skill folder holds one"
    fi
    continue
  fi

  name="" desc="" has_name=0 has_desc=0
  while IFS= read -r line; do
    tag="${line%%$'\t'*}"
    value="${line#*$'\t'}"
    case "$tag" in
      V) report "$file: $value" ;;
      NAME) name="$value"; has_name=1 ;;
      DESC) desc="$value"; has_desc=1 ;;
      COMPAT)
        n="$(char_count "$value")"
        [[ "$n" -le 500 ]] || report "$file: compatibility is $n characters — at most 500"
        ;;
    esac
  done < <(parse_frontmatter "$file")

  if [[ "$has_name" != 1 ]]; then
    report "$file: frontmatter missing required key name"
  elif [[ "$name" != "$folder" ]]; then
    report "$file: name '$name' must equal the folder name '$folder'"
  elif [[ ${#name} -gt 64 ]] || [[ ! "$name" =~ $name_re ]]; then
    report "$file: name '$name' must be 1-64 characters of a-z, 0-9 and single hyphens, not starting or ending with one"
  fi

  if [[ "$has_desc" != 1 ]]; then
    report "$file: frontmatter missing required key description — it is what the model routes on"
  elif [[ -z "$desc" ]]; then
    report "$file: description is empty — say what the skill does and when to use it"
  else
    n="$(char_count "$desc")"
    [[ "$n" -le 1024 ]] || report "$file: description is $n characters — at most 1024"
  fi

  if [[ -d "$dir/state" && ! -f "$dir/state/_doc.md" ]]; then
    report "$dir/state: no _doc.md — say what the folder holds and which script writes and reads it"
  fi
done

if [[ $issues -gt 0 ]]; then
  echo "" >&2
  echo "⚠ $issues skill-format violation(s) — the shape is the Agent Skills spec, https://agentskills.io/specification" >&2
  exit 1
fi

exit 0
