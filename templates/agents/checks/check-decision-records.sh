#!/usr/bin/env bash
# check-decision-records.sh — hold every decision record to the format stated
# in decisions/README.md, before it is committed.
#
# WHY. A decision written as free prose drifts: status words multiply, and a
# record gets written as decided over a discussion that decided nothing. The
# MADR format fixes the first by vocabulary; part (g) fixes the second, because
# an `accepted` record has to carry the dated words that accepted it.
#
# WHAT IT CHECKS — the seven parts, each with the letter its violations carry:
#   (a) frontmatter parses and carries `status`, `date` and `decision-makers`
#   (b) `status` is proposed | rejected | accepted | deprecated |
#       `superseded by <path>/decisions/NNNN-<slug>.md` — a repo-relative
#       PATH, never a bare number (numbers are per folder) and never an
#       absolute, home or `..` path
#   (c) `date` is a real YYYY-MM-DD
#   (d) `decision-makers` is non-empty
#   (e) the filename is NNNN-title-with-dashes.md, lowercase
#   (f) NNNN is unique among every record ON DISK in the same folder — not
#       among the arguments, or a new 0003 beside a committed 0003 passes
#   (g) an `accepted` record's BODY has a line holding a YYYY-MM-DD date
#       followed by a quoted run ("…" or “…”); frontmatter does not count
#
# WHAT IT SCANS. With no path arguments: the decision files changed in this
# work tree, staged or not, measured from HEAD — or with `--since <ref>` from
# where this branch left <ref>, so a record already committed on the branch is
# seen too. Untracked files come from `git ls-files --others`, one per file, so
# a brand-new `decisions/` folder is read record by record. Paths no longer on
# disk are skipped: a move arrives as a delete plus a new file.
# With arguments: exactly those files, whatever their names, and every
# directory argument walked for decision files at any depth. land.sh calls it
# with `--since origin/<trunk>`, BEFORE its `git add -A`, so a record the
# session already committed and one it has not yet staged are both seen.
#
# peers:
#   decisions/README.md                            (the format this enforces)
#   .agents/skills/close/scripts/land.sh           (the gate that calls it)
#
# A "decision file" is any `.md` directly inside a folder named `decisions`,
# except that folder's README.md. Broader than NNNN-*.md on purpose: a record
# misnamed `001-foo.md` must fail part (e), not slip past unscanned.
#
# Placement — which `decisions/` a record belongs in — is NOT checked: "the
# narrowest home containing everyone who could act contrary" names people, and
# no script can enumerate them. That rule lives in decisions/README.md.
#
# Usage:
#   check-decision-records.sh                     records changed since HEAD
#   check-decision-records.sh --since <ref>       …since this branch left <ref>
#   check-decision-records.sh <path>...           those files / directories
#
# Output (stdout): exactly one line — `OK — N decision record(s) checked`, or
#   `FAIL — N decision record(s) checked, M violation(s)`.
# Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
#
# Exit: 0 clean · 1 one or more violations · 2 caller error
#
# bash 3.2 compatible on purpose (macOS): no mapfile, no declare -A, and the
# date is validated arithmetically rather than with GNU-only `date -d`.

set -euo pipefail

# shellcheck source=SCRIPTDIR/yaml-scalar.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/yaml-scalar.sh"

err() { echo "$@" >&2; }

# A decision file: a .md directly inside a `decisions` folder, not its README.
is_decision_path() {
  local p="$1" re='(^|/)decisions/[^/]+\.md$'
  [[ "$p" =~ $re ]] && [[ "$(basename "$p")" != "README.md" ]]
}

# is_real_date YYYY-MM-DD — true when the calendar has that day.
is_real_date() {
  local d="$1" y m day max
  [[ "$d" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]] || return 1
  y=$((10#${BASH_REMATCH[1]}))
  m=$((10#${BASH_REMATCH[2]}))
  day=$((10#${BASH_REMATCH[3]}))
  case "$m" in
    1|3|5|7|8|10|12) max=31 ;;
    4|6|9|11) max=30 ;;
    2)
      if (( (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 )); then max=29; else max=28; fi
      ;;
    *) return 1 ;;
  esac
  (( day >= 1 && day <= max ))
}

targets=()
since=""
if [[ "${1:-}" == "--since" ]]; then
  [[ -n "${2:-}" ]] || { err "check-decision-records: --since needs a ref"; exit 2; }
  since="$2"
  shift 2
  [[ $# -eq 0 ]] || { err "check-decision-records: --since takes no paths"; exit 2; }
fi

if [[ $# -eq 0 ]]; then
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    err "check-decision-records: not inside a git work tree"
    exit 2
  }
  cd "$top"
  base="HEAD"
  if [[ -n "$since" ]]; then
    # git's own stderr stays visible: "not a valid object name" and "no merge
    # base" are different faults with different fixes.
    base="$(git merge-base HEAD "$since")" || {
      err "check-decision-records: cannot find where HEAD left $since"
      exit 2
    }
  fi
  # `--no-renames` lists a move as its two halves, and the half no longer on
  # disk is dropped below — so there is no rename field to parse.
  # Each list goes to a file and its exit is checked: inside a process
  # substitution a failing git read as "nothing changed", and the scan passed
  # without reading a record it was meant to check.
  lists="$(mktemp)"
  if ! git diff -z --name-only --no-renames "$base" >"$lists" 2>"$lists.err"; then
    err "check-decision-records: git diff against $base failed: $(cat "$lists.err")"
    rm -f "$lists" "$lists.err"
    exit 2
  fi
  if ! git ls-files -z --others --exclude-standard >>"$lists" 2>"$lists.err"; then
    err "check-decision-records: git ls-files failed: $(cat "$lists.err")"
    rm -f "$lists" "$lists.err"
    exit 2
  fi
  while IFS= read -r -d '' path; do
    is_decision_path "$path" || continue
    [[ -f "$path" ]] || continue
    targets+=("$path")
  done <"$lists"
  rm -f "$lists" "$lists.err"
else
  for arg in "$@"; do
    if [[ -f "$arg" ]]; then
      targets+=("$arg")
    elif [[ -d "$arg" ]]; then
      while IFS= read -r -d '' f; do
        is_decision_path "$f" && targets+=("$f")
      done < <(find "$arg" -type f -name '*.md' -print0 | sort -z)
    else
      err "check-decision-records: not a file or directory: $arg"
      exit 2
    fi
  done
fi

# Frontmatter and body in one pass. A small state machine, not a YAML library:
# the three keys are flat scalars, plus `decision-makers` as a block list
# (`  - name`), which MADR's full template also allows. Prints nine fixed
# lines: fm-state (ok | none | unclosed), then has/value for status, date and
# decision-makers, whether the body holds a dated quote (1/0), and the keys
# YAML would refuse, as `key=open` or `key=trailing` (space-separated, may be
# empty). Values are read by yaml_scalar, shared with check-skill-format.sh.
parse_record() {
  awk -v sq="'" "$YAML_SCALAR_AWK"'
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    # The value, and the key noted in badq[] when YAML would refuse it: a
    # quote that never closes, or text after a closed one (yaml-scalar.sh).
    function value_of(raw, k,   v) {
      v = yaml_scalar(raw)
      if (YS_STATE != "ok") badq[k] = YS_STATE
      return v
    }
    NR == 1 {
      if ($0 == "---") { infm = 1; next }
      nofm = 1; exit
    }
    infm && $0 == "---" { infm = 0; closed = 1; next }
    infm {
      if (match($0, /^[A-Za-z0-9_-]+:/)) {
        cur = substr($0, 1, RLENGTH - 1)
        has[cur] = 1
        val[cur] = value_of(substr($0, RLENGTH + 1), cur)
      } else if (cur == "decision-makers" && $0 ~ /^[ \t]+-[ \t]*[^ \t]/) {
        item = trim($0); sub(/^-[ \t]*/, "", item)
        val[cur] = (val[cur] == "" ? "" : val[cur] ", ") value_of(item, cur)
      }
      next
    }
    # The date must come BEFORE the opening quote — `Your Name 2026-01-10: "…"`.
    # Either order would let a line quoting a discussion and dating it after
    # stand in for an approval.
    closed && !quoted && match($0, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/) {
      rest = substr($0, RSTART + RLENGTH)
      if (rest ~ /"[^"]+"/) quoted = 1
      o = index(rest, "“")
      if (o && index(substr(rest, o + length("“")), "”") > 1) quoted = 1
    }
    END {
      print (nofm || NR == 0) ? "none" : (closed ? "ok" : "unclosed")
      print has["status"] + 0;          print val["status"]
      print has["date"] + 0;            print val["date"]
      print has["decision-makers"] + 0; print val["decision-makers"]
      print quoted + 0
      bad = ""
      if (badq["status"] != "") bad = bad " status=" badq["status"]
      if (badq["date"] != "") bad = bad " date=" badq["date"]
      if (badq["decision-makers"] != "") bad = bad " decision-makers=" badq["decision-makers"]
      print bad
    }
  ' "$1"
}

violations=0
printed=$'\n'

violation() {
  local line="$1: ($2) $3"
  case "$printed" in *$'\n'"$line"$'\n'*) return 0 ;; esac
  printed="$printed$line"$'\n'
  err "$line"
  violations=$((violations + 1))
}

# A supersession names a REPO-RELATIVE path: segments that do not start with a
# dot (so no `..`, no `./`), no leading `/` or `~`.
status_re='^(proposed|rejected|accepted|deprecated|superseded by ([A-Za-z0-9_][A-Za-z0-9_.-]*/)*decisions/[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md)$'
name_re='^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$'
num_re='^([0-9]{4})-'
empty_list_re='^\[[[:space:]]*\]$'

for f in ${targets[@]+"${targets[@]}"}; do
  name="$(basename "$f")"
  dir="$(dirname "$f")"

  # (e) and (f) read only the name, so they hold even when the content is bad.
  if [[ ! "$name" =~ $name_re ]]; then
    violation "$f" e "filename must be NNNN-title-with-dashes.md, lowercase (got $name)"
  fi
  if [[ "$name" =~ $num_re ]]; then
    num="${BASH_REMATCH[1]}"
    siblings=()
    while IFS= read -r -d '' s; do siblings+=("$s"); done \
      < <(find "$dir" -maxdepth 1 -type f -name "${num}-*.md" -print0 | sort -z)
    if [[ ${#siblings[@]} -gt 1 ]]; then
      for s in ${siblings[@]+"${siblings[@]}"}; do
        others=()
        for o in ${siblings[@]+"${siblings[@]}"}; do
          [[ "$o" != "$s" ]] && others+=("$(basename "$o")")
        done
        violation "${dir}/$(basename "$s")" f "number $num is also used by ${others[*]} in the same folder"
      done
    fi
  fi

  {
    IFS= read -r fm_state
    IFS= read -r has_status; IFS= read -r status
    IFS= read -r has_date;   IFS= read -r date
    IFS= read -r has_dm;     IFS= read -r dm
    IFS= read -r quoted
    IFS= read -r unclosed_keys
  } < <(parse_record "$f")

  case "$fm_state" in
    none)
      violation "$f" a "no frontmatter — the file must open with a '---' line"
      continue
      ;;
    unclosed)
      violation "$f" a "frontmatter is never closed by a second '---' line"
      continue
      ;;
  esac

  for k in $unclosed_keys; do
    case "${k#*=}" in
      open) violation "$f" a "${k%%=*} has an unclosed quote — the frontmatter will not parse" ;;
      *) violation "$f" a "${k%%=*} has text after its closing quote — the frontmatter will not parse" ;;
    esac
  done

  if [[ "$has_status" != 1 ]]; then
    violation "$f" a "missing required key: status"
  elif [[ ! "$status" =~ $status_re ]]; then
    violation "$f" b "status '$status' is not proposed/rejected/accepted/deprecated/'superseded by <path>/decisions/NNNN-<slug>.md'"
  fi

  if [[ "$has_date" != 1 ]]; then
    violation "$f" a "missing required key: date"
  elif ! is_real_date "$date"; then
    violation "$f" c "date '$date' is not a real YYYY-MM-DD"
  fi

  if [[ "$has_dm" != 1 ]]; then
    violation "$f" a "missing required key: decision-makers"
  elif [[ -z "$dm" || "$dm" =~ $empty_list_re ]]; then
    violation "$f" d "decision-makers is empty — name who decided"
  fi

  if [[ "$status" == "accepted" && "$quoted" != 1 ]]; then
    violation "$f" g "accepted, but no body line has a YYYY-MM-DD date followed by the quoted words that accepted it (a date after the quote does not count)"
  fi
done

if [[ $violations -gt 0 ]]; then
  echo "FAIL — ${#targets[@]} decision record(s) checked, ${violations} violation(s)"
  exit 1
fi
echo "OK — ${#targets[@]} decision record(s) checked"
