#!/usr/bin/env bash
# check-skills.sh — hold every <skill>/SKILL.md in this checkout to the Agent
# Skills specification plus the three local rules AGENTS.md § Skill shape
# states, before a close commits it.
#
# WHY. Skills that carried frontmatter keys the spec does not allow, checked
# by a linter nothing fired at a close, drifted unnoticed: frontmatters stopped
# parsing and cross-skill references went stale. This check runs the PUBLISHED
# validator when it is installed, so the key list lives in one place (the
# pinned `skills-ref` package), and adds only what the spec leaves to us. Where
# it is not installed, a built-in reading of the same rules answers instead,
# in the validator's own wording, so a machine without Python still has a check.
#
# WHAT IT CHECKS, per skill folder:
#   (a) the folder holds a SKILL.md
#   (b) `skills-ref validate` passes — the six allowed keys, name = folder,
#       description length, and so on; its lines are relayed verbatim. Without
#       the validator, builtin_validate checks the same list
#   (c) `metadata`, when present, holds only `peers`, a non-empty string
#   (d) a `state/` folder holds `_doc.md`, and SKILL.md never names a
#       `state/` path — state is what a skill has learned, never loaded at
#       activation (AGENTS.md § Skill shape)
#
# WHAT IT SCANS. With no arguments: every top-level folder with ANY path
# changed beneath it in this worktree, staged or not, plus untracked — a new
# `state/` file or a new folder without SKILL.md selects its folder; a
# root-level file selects nothing. "Changed" is measured from HEAD, or with
# `--since <ref>` from where this branch left <ref> (land.sh calls it that
# way, BEFORE its `git add -A`). Folders no longer on disk are skipped.
# Test and fixture files are part of what it reads: a changed `*.test.sh`
# selects its skill like any other file.
# `--all` reads every top-level folder except .git, node_modules and .trash;
# explicit paths read exactly those folders (a path to SKILL.md works too).
#
# Usage:
#   check-skills.sh                    folders changed since HEAD
#   check-skills.sh --since <ref>      …since this branch left <ref>
#   check-skills.sh --all              every skill folder
#   check-skills.sh <skill-dir>...     those folders
#
# Env:
#   SKILLS_ROOT     the skills folder (default: ../skills beside this script,
#                   i.e. .agents/skills)
#   SKILLS_REF_BIN  the validator: `agentskills` on PATH, else the venv below;
#                   `builtin` forces the built-in reading. Set to a path that
#                   does not exist, it is a caller error (exit 2).
#
# Output (stdout): exactly one line — `OK — N skill(s) checked`, or
#   `FAIL — N skill(s) checked, M violation(s)`.
# Output (stderr): one line per violation, `<skill>/SKILL.md: <what>`.
#
# peers:
#   AGENTS.md § Skill shape                          (the rules this enforces)
#   .agents/checks/check-skills.test.sh
#   .agents/skills/close/scripts/land.sh             (the gate that calls it)
#   .agents/skills/author/scripts/verify.sh          (/author's verify step)
#
# Exit: 0 clean · 1 one or more violations · 2 caller error
#
# bash 3.2 compatible (macOS): no mapfile, no declare -A, no GNU realpath.

set -euo pipefail

# PHYSICAL path: invoked through a symlink (`~/.agents/skills/...`) a logical
# path would name the link, not the checkout the skills live in.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILLS_ROOT="${SKILLS_ROOT:-${HERE}/../skills}"
INSTALL_LINE='python3 -m venv ~/.local/lib/quality/skills-ref && ~/.local/lib/quality/skills-ref/bin/pip install skills-ref==0.1.1'
if [ -z "${SKILLS_REF_BIN:-}" ]; then
  if command -v agentskills >/dev/null 2>&1; then
    SKILLS_REF_BIN="$(command -v agentskills)"
  elif [ -x "${HOME}/.local/lib/quality/skills-ref/bin/agentskills" ]; then
    SKILLS_REF_BIN="${HOME}/.local/lib/quality/skills-ref/bin/agentskills"
  else
    SKILLS_REF_BIN="builtin"
  fi
fi

err() { echo "$@" >&2; }

# Folders that are never skills.
is_ignored() { case "$1" in .git|node_modules|.trash) return 0 ;; esac; return 1; }

targets=()
mode="changed"
since=""
case "${1:-}" in
  --all)
    [ $# -eq 1 ] || { err "check-skills: --all takes no paths"; exit 2; }
    mode="all"
    ;;
  --since)
    [ -n "${2:-}" ] || { err "check-skills: --since needs a ref"; exit 2; }
    since="$2"
    shift 2
    [ $# -eq 0 ] || { err "check-skills: --since takes no paths"; exit 2; }
    ;;
  -*)
    err "check-skills: unknown option $1"
    exit 2
    ;;
  "") ;;
  *) mode="paths" ;;
esac

if [ "${SKILLS_REF_BIN}" != "builtin" ] && [ ! -x "${SKILLS_REF_BIN}" ]; then
  err "check-skills: no validator at ${SKILLS_REF_BIN} — install it, or unset SKILLS_REF_BIN for the built-in check:"
  err "  ${INSTALL_LINE}"
  exit 2
fi

if [ "${mode}" = "paths" ]; then
  for p in "$@"; do
    p="${p%/SKILL.md}"
    p="${p%/}"
    targets+=("${p}")
  done
elif [ "${mode}" = "all" ]; then
  for d in "${SKILLS_ROOT}"/*/ "${SKILLS_ROOT}"/.*/; do
    [ -d "${d}" ] || continue
    name="$(basename "${d}")"
    case "${name}" in .|..) continue ;; esac
    is_ignored "${name}" && continue
    targets+=("${SKILLS_ROOT}/${name}")
  done
else
  git -C "${SKILLS_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    err "check-skills: ${SKILLS_ROOT} is not inside a git work tree"
    exit 2
  }
  base="HEAD"
  if [ -n "${since}" ]; then
    base="$(git -C "${SKILLS_ROOT}" merge-base HEAD "${since}" 2>/dev/null)" || {
      err "check-skills: cannot find where HEAD left ${since}"
      exit 2
    }
  fi
  # Every changed or untracked path, relative to the root; the first path
  # component of any path that HAS a component is a candidate folder. Both
  # git listings are NUL-delimited (a bash variable cannot hold NUL, so they
  # go through a temp file) and each exit status is checked: a failed scan is
  # an exit 2, never an empty list reported as `OK — 0 skill(s) checked`.
  scan="$(mktemp)"
  trap 'rm -f "${scan}"' EXIT
  git -C "${SKILLS_ROOT}" diff -z --name-only --no-renames --relative "${base}" >"${scan}" || {
    err "check-skills: git diff against ${base} failed in ${SKILLS_ROOT}"
    exit 2
  }
  git -C "${SKILLS_ROOT}" ls-files -z --others --exclude-standard >>"${scan}" || {
    err "check-skills: git ls-files failed in ${SKILLS_ROOT}"
    exit 2
  }
  seen=$'\n'
  while IFS= read -r -d '' path; do
    [[ "${path}" == */* ]] || continue
    name="${path%%/*}"
    case "${seen}" in *$'\n'"${name}"$'\n'*) continue ;; esac
    seen="${seen}${name}"$'\n'
    is_ignored "${name}" && continue
    [ -d "${SKILLS_ROOT}/${name}" ] || continue
    targets+=("${SKILLS_ROOT}/${name}")
  done <"${scan}"
fi

if [ ${#targets[@]} -eq 0 ]; then
  echo "OK — 0 skill(s) checked"
  exit 0
fi

violations=0
violation() {
  err "$1/SKILL.md: $2"
  violations=$((violations + 1))
}

# The frontmatter block without its fences, for the metadata reader.
frontmatter() {
  awk 'NR==1 && $0 != "---" { exit 1 } NR==1 { next } $0 == "---" { exit } { print }' "$1"
}

# shellcheck source=SCRIPTDIR/yaml-scalar.sh
. "${HERE}/yaml-scalar.sh"

# parse_fm <SKILL.md> — the frontmatter read the way the checks need it, one
# line per fact, TAB-separated:
#   E<TAB><message>            a problem the validator would report
#   K<TAB><key>                a top-level key, once per occurrence
#   V<TAB><key><TAB><value>    a scalar top-level value (block scalars folded)
#   L<TAB><key>                a top-level key whose value is a block list
#   M<TAB><key><TAB><type><TAB><value>   a metadata entry: type str|list
#   MT<TAB><type>              metadata that is not a map
# Not a YAML library: the flat shape the spec allows — `key: value`, quoted
# values, `>`/`|` block scalars, one level of map under metadata, and a
# single-line `{k: v}` metadata map, which the validator refuses but whose
# keys the local rule still reads.
parse_fm() {
  awk -v sq="'" "${YAML_SCALAR_AWK}"'
    function trim(x) { gsub(/^[ \t]+|[ \t]+$/, "", x); return x }
    function is_block(v) { return v ~ /^[>|][+-]?[0-9]?$/ }
    function flush(   v) {
      if (key == "") return
      if (listy) print "L\t" key
      else if (key != "metadata") {
        v = block ? trim(val) : yaml_scalar(val)
        if (!block && YS_STATE == "open") print "E\tInvalid YAML in frontmatter: while scanning a quoted scalar in " key ": found unexpected end of stream"
        else if (!block && YS_STATE == "trailing") print "E\tInvalid YAML in frontmatter: text after the closing quote of " key
        print "V\t" key "\t" v
      }
      if (key == "metadata") flush_meta()
      key = ""; val = ""; listy = 0; block = 0
    }
    function flush_meta(   v) {
      if (mkey == "") return
      if (mlisty) print "M\t" mkey "\tlist\t"
      else {
        v = mblock ? trim(mval) : yaml_scalar(mval)
        if (!mblock && YS_STATE == "open") print "E\tInvalid YAML in frontmatter: while scanning a quoted scalar in metadata." mkey ": found unexpected end of stream"
        else if (!mblock && YS_STATE == "trailing") print "E\tInvalid YAML in frontmatter: text after the closing quote of metadata." mkey
        print "M\t" mkey "\tstr\t" v
      }
      mkey = ""; mval = ""; mlisty = 0; mblock = 0
    }
    NR == 1 { if ($0 != "---") { print "E\tSKILL.md must start with YAML frontmatter (---)"; bad = 1; exit } next }
    $0 == "---" { closed = 1; exit }
    /^[ \t]*$/ { if (block && key != "") val = val " "; next }
    /^#/ { next }
    /^[^ \t]/ {
      flush()
      if (!match($0, /^[A-Za-z0-9_-]+:/)) { print "E\tInvalid YAML in frontmatter: line " (NR) " is not a key: value line"; next }
      key = substr($0, 1, RLENGTH - 1)
      rest = trim(substr($0, RLENGTH + 1))
      print "K\t" key
      if (rest ~ /^[\[{]/) {
        print "E\tInvalid YAML in frontmatter: found a disallowed JSONesque flow " (rest ~ /^\{/ ? "mapping" : "sequence") " in " key " (" rest ")"
        if (key == "metadata" && rest ~ /^\{.*\}$/) {
          body = substr(rest, 2, length(rest) - 2)
          n = split(body, pairs, ",")
          for (i = 1; i <= n; i++) {
            if (!match(pairs[i], /^[ \t]*[A-Za-z0-9_-]+[ \t]*:/)) continue
            mk = trim(substr(pairs[i], 1, RLENGTH - 1))
            print "M\t" mk "\tstr\t" yaml_scalar(substr(pairs[i], RLENGTH + 1))
          }
        } else if (key == "metadata") print "MT\tstr"
        key = ""; next
      }
      if (is_block(rest)) { block = 1; val = "" } else { block = 0; val = rest }
      if (key == "metadata" && rest != "") { print "MT\tstr"; key = "" }
      next
    }
    {
      line = trim($0)
      if (key == "metadata") {
        ind = match($0, /[^ \t]/) - 1
        if (mind == 0 || ind <= mind) {
          if (match($0, /^[ \t]+[A-Za-z0-9_-]+:/)) {
            klen = RLENGTH
            flush_meta()
            mind = ind
            mkey = trim(substr($0, 1, klen - 1))
            mrest = trim(substr($0, klen + 1))
            mblock = is_block(mrest)
            mval = mblock ? "" : mrest
          }
        } else if (line ~ /^- / && trim(mval) == "") {
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
      if (NR == 0) { print "E\tSKILL.md must start with YAML frontmatter (---)"; exit }
      if (!closed) { print "E\tSKILL.md frontmatter not properly closed with ---"; exit }
      flush()
    }
  ' "$1"
}

# Characters, not bytes: drop UTF-8 continuation bytes before counting.
char_count() {
  printf '%s' "$1" | LC_ALL=C tr -d '\200-\277' | wc -c | tr -d ' '
}

# builtin_validate <dir> — the published validator's rules, in its wording,
# for a machine without it. Prints nothing when the skill is valid, else the
# validator's shape: a `Validation failed for` header and `  - <error>` lines.
builtin_validate() {
  local dir="$1" folder facts line tag rest value keys="" extra="" name="" desc="" has_name=0 has_desc=0 desc_list=0 n errs=""
  folder="$(basename "${dir}")"
  add() { errs="${errs}  - $1"$'\n'; }
  if [ ! -f "${dir}/SKILL.md" ]; then
    add "Missing required file: SKILL.md"
  else
    facts="$(parse_fm "${dir}/SKILL.md")"
    # A YAML error is the whole answer, as it is for the validator: nothing
    # else can be read from a frontmatter that does not parse.
    while IFS= read -r line; do
      case "${line}" in E$'\t'*) add "${line#E	}" ;; esac
    done <<<"${facts}"
    if [ -z "${errs}" ]; then
      while IFS=$'\t' read -r tag rest value; do
        case "${tag}" in
          K)
            case "${keys}" in *" ${rest} "*) add "Invalid YAML in frontmatter: duplicate key ${rest}" ;; esac
            keys="${keys} ${rest} "
            case "${rest}" in
              name|description|license|compatibility|allowed-tools|metadata) ;;
              *) extra="${extra}${rest}"$'\n' ;;
            esac
            ;;
          V)
            case "${rest}" in
              name) name="${value}"; has_name=1 ;;
              description) desc="${value}"; has_desc=1 ;;
              compatibility)
                n="$(char_count "${value}")"
                [ "${n}" -le 500 ] || add "Compatibility exceeds 500 character limit (${n} chars)"
                ;;
            esac
            ;;
          L)
            case "${rest}" in
              name) has_name=1; name="" ;;
              description) has_desc=1; desc_list=1 ;;
            esac
            ;;
        esac
      done <<<"${facts}"
      if [ -n "${extra}" ]; then
        add "Unexpected fields in frontmatter: $(printf '%s' "${extra}" | LC_ALL=C sort | paste -sd, - | sed 's/,/, /g'). Only ['allowed-tools', 'compatibility', 'description', 'license', 'metadata', 'name'] are allowed."
      fi
      if [ "${has_name}" != 1 ]; then
        add "Missing required field in frontmatter: name"
      elif [ -z "${name}" ]; then
        add "Field 'name' must be a non-empty string"
      else
        n="$(char_count "${name}")"
        if [ "${n}" -gt 64 ]; then
          add "Skill name '${name}' exceeds 64 character limit (${n} chars)"
        elif [ "${name}" != "$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]')" ]; then
          add "Skill name '${name}' must be lowercase"
        elif [[ ! "${name}" =~ ^[a-z0-9-]+$ ]]; then
          add "Skill name '${name}' contains invalid characters. Only letters, digits, and hyphens are allowed."
        elif [[ "${name}" == -* || "${name}" == *- ]]; then
          add "Skill name cannot start or end with a hyphen"
        elif [[ "${name}" == *--* ]]; then
          add "Skill name cannot contain consecutive hyphens"
        elif [ "${name}" != "${folder}" ]; then
          add "Directory name '${folder}' must match skill name '${name}'"
        fi
      fi
      if [ "${has_desc}" != 1 ]; then
        add "Missing required field in frontmatter: description"
      elif [ "${desc_list}" = 1 ] || [ -z "${desc//[[:space:]]/}" ]; then
        add "Field 'description' must be a non-empty string"
      else
        n="$(char_count "${desc}")"
        [ "${n}" -le 1024 ] || add "Description exceeds 1024 character limit (${n} chars)"
      fi
    fi
  fi
  [ -n "${errs}" ] || return 0
  printf 'Validation failed for %s:\n%s' "${dir}" "${errs}" >&2
  return 1
}

# read_metadata <SKILL.md> — one line per metadata entry,
# `key<TAB>type<TAB>value` (type str or list), or `!type<TAB><type>` when
# metadata is not a map. A block map and an inline `{…}` map read the same.
read_metadata() {
  parse_fm "$1" | awk -F'\t' '
    $1 == "M" { print $2 "\t" $3 "\t" $4 }
    $1 == "MT" { print "!type\t" $2 }
  '
}

# resolve_path <path> — the path with every existing directory resolved
# physically and a missing tail kept as written; `realpath -m` without GNU.
resolve_path() {
  local p="$1" head tail=""
  case "${p}" in /*) ;; *) p="${PWD}/${p}" ;; esac
  head="${p}"
  while [ ! -d "${head}" ]; do
    tail="/$(basename "${head}")${tail}"
    head="$(dirname "${head}")"
  done
  printf '%s%s\n' "$(cd "${head}" && pwd -P)" "${tail}"
}

check_skill() {
  local dir="$1" name line
  name="$(basename "${dir}")"

  # (a)
  if [ ! -f "${dir}/SKILL.md" ]; then
    err "${name}: no SKILL.md"
    violations=$((violations + 1))
    return
  fi

  # (b) The published validator. Its stdout is the `Valid skill:` line;
  #     its stderr is a header plus `  - <error>` lines, relayed.
  #     A multi-line error (a YAML parse failure quotes the offending line)
  #     is folded onto the `  - ` line that opened it, one violation each.
  local vout cur="" vrc=0
  if [ "${SKILLS_REF_BIN}" = "builtin" ]; then
    vout="$(builtin_validate "${dir}" 2>&1)" || vrc=$?
  else
    vout="$("${SKILLS_REF_BIN}" validate "${dir}" 2>&1 >/dev/null)" || vrc=$?
  fi
  if [ "${vrc}" -ne 0 ]; then
    while IFS= read -r line; do
      case "${line}" in
        "Validation failed for "*) ;;
        "  - "*)
          [ -n "${cur}" ] && violation "${name}" "${cur}"
          cur="${line#  - }"
          ;;
        *)
          line="$(printf '%s' "${line}" | tr -s '[:space:]' ' ')"
          line="${line# }"
          [ -n "${line}" ] && cur="${cur:+${cur} }${line}"
          ;;
      esac
    done <<<"${vout}"
    if [ -n "${cur}" ]; then
      violation "${name}" "${cur}"
    else
      violation "${name}" "the validator exited non-zero with no message"
    fi
  fi

  # (c) metadata: only peers, a non-empty string.
  if frontmatter "${dir}/SKILL.md" >/dev/null; then
    local key type value
    while IFS=$'\t' read -r key type value; do
      [ -n "${key}" ] || continue
      case "${key}" in
        "!type") violation "${name}" "metadata must be a map of string keys to string values, got ${type}" ;;
        peers)
          if [ "${type}" != "str" ]; then
            violation "${name}" "metadata.peers must be a string (space-separated paths), got ${type}"
          elif [ -z "${value//[[:space:]]/}" ]; then
            violation "${name}" "metadata.peers must be a non-empty string — name the peers or drop the key"
          fi
          ;;
        *) violation "${name}" "metadata.${key} is not a key a skill carries — the only custom key is metadata.peers (AGENTS.md § Skill shape)" ;;
      esac
    done < <(read_metadata "${dir}/SKILL.md")
  fi

  # (d) state/: described by _doc.md, never named from SKILL.md.
  if [ -d "${dir}/state" ] && [ ! -f "${dir}/state/_doc.md" ]; then
    violation "${name}" "state/ has no _doc.md — a state folder describes what it holds and which script writes and reads it"
  fi
  # A reference to THIS skill's state folder. Every path-like token holding
  # `state/` is classified: `state/…` or `./state/…` is this skill's; so is
  # `<name>/state/…` bare or behind `../`; a home-rooted or absolute path is
  # this skill's when it RESOLVES into this folder (checkout, worktree or
  # symlink alike) or names it under a `skills/` folder — the skills live at
  # `<workbench>/.agents/skills/<name>`, so `skills/<name>/state/` in any checkout,
  # worktree or link to one (`~/.agents/skills`, `~/.claude/skills`) is this
  # skill's. A path into another tree (knowledge/<name>/state/x,
  # ~/knowledge/<name>/state/x, /tmp/<name>/state/x) is not one.
  local real_dir tok resolved lineno
  real_dir="$(resolve_path "${dir}")"
  while IFS=: read -r lineno tok; do
    [ -n "${tok}" ] || continue
    # shellcheck disable=SC2088  # the literal two characters are the pattern
    case "${tok}" in
      state/*|./state/*|"${name}"/state/*|../"${name}"/state/*) ;;
      "~/"*|/*)
        resolved="$(resolve_path "${tok/#\~/${HOME}}")"
        case "${resolved}" in
          "${real_dir}/state"|"${real_dir}/state/"*) ;;
          */skills/"${name}"/state/*) ;;
          *) continue ;;
        esac
        ;;
      *) continue ;;
    esac
    violation "${name}" "line ${lineno} links ${tok} — state is never loaded at activation, so SKILL.md must not name it"
  done < <(grep -noE '[^[:space:]"'"'"'`()<>[]*state/[^[:space:]"'"'"'`()<>[]*' "${dir}/SKILL.md" || true)
}

for t in "${targets[@]}"; do
  if [ ! -d "${t}" ]; then
    err "$(basename "${t}"): no such folder ${t}"
    violations=$((violations + 1))
    continue
  fi
  check_skill "${t}"
done

if [ "${violations}" -gt 0 ]; then
  echo "FAIL — ${#targets[@]} skill(s) checked, ${violations} violation(s)"
  exit 1
fi
echo "OK — ${#targets[@]} skill(s) checked"
