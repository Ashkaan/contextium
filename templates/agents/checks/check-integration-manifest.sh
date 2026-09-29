#!/usr/bin/env bash
# check-integration-manifest.sh — hold every integrations/<name>/README.md
# manifest to the schema in integrations/README.md § Manifest, before a close
# commits it. integrations/README.md § Manifest owns what each key MEANS; this
# script owns whether a given README obeys it.
#
# WHAT IT CHECKS — each violation carries the letter of the part it breaks:
#   (a)  the frontmatter opens on line 1, is closed, and holds no nested map
#   (b)  exactly the required keys, in order; `uses-why` optional, and only
#        directly after `uses`
#   (c)  hosts, aliases, typed_client and access are non-empty block sequences
#   (d)  every `access` value is one of the five shapes, none repeated. The
#        ORDER is not checked: it ranks the shapes by capability for that
#        product, which no script can judge
#   (e)  every `typed_client` entry exists in the folder and every non-test
#        .ts there is listed — or the list is the single item `none` and the
#        folder ships no .ts
#   (f)  `onepassword_item` is `CREDS.<key>` exported by
#        integrations/1password/credentials.ts, or `none`
#   (g2) every scalar reads back from YAML as written (no unquoted `: `, no
#        leading indicator)
#   (g)  the remaining scalars are non-empty
#   (h)  `uses` is one value: a shape or `none`
#   (i)  `uses`, when not `none`, is one of this README's `access` values
#   (j)  `uses: none` only beside `typed_client: none`
#   (k)  `uses-why` is present and non-empty whenever `uses` is neither `none`
#        nor the first `access` value — the code does not take the most
#        capable shape, so the README says why
#
# WHAT IT SCANS. With no path arguments: the integration READMEs changed in this
# worktree, staged or not, plus untracked ones — land.sh calls it BEFORE its
# `git add -A`. "Changed" is measured from HEAD, or with `--since <ref>` from
# where this branch left <ref>: a README the session already COMMITTED differs
# from nothing at HEAD. Paths no longer on disk are skipped — deleting an
# integration arrives here as a deleted README. `--all` reads every
# integrations/*/README.md; explicit paths read exactly those files.
#
# Usage:
#   check-integration-manifest.sh                  READMEs changed since HEAD
#   check-integration-manifest.sh --since <ref>    …since this branch left <ref>
#   check-integration-manifest.sh --all            every integrations/*/README.md
#   check-integration-manifest.sh <readme>...      those files
#
# Env (tests only):
#   INTEGRATION_MANIFEST_CREDS  path to credentials.ts (default: the workbench's)
#
# Output (stdout): exactly one line — `OK — N manifest(s) checked`, or
#   `FAIL — N manifest(s) checked, M violation(s)`.
# Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
#
# credentials.ts is read (with node) only when a manifest names a CREDS key: a
# workbench whose manifests all say `onepassword_item: none` needs neither.
#
# peers:
#   integrations/README.md § Manifest             (the schema this enforces)
#   .agents/skills/close/scripts/land.sh          (the gate that calls it)
#
# Exit: 0 clean · 1 one or more violations, or credentials.ts unreadable when
#       a manifest needs it · 2 caller error
#
# bash 3.2 compatible: no associative arrays, no namerefs.

set -uo pipefail

err() { echo "$@" >&2; }

# The keys, in the one order every manifest uses. `uses-why` is optional and,
# when present, sits directly after `uses`.
REQUIRED_KEYS="name description hosts aliases typed_client access uses base_url auth onepassword_item rate_limit cli"
# The five shapes. Also the tiebreak between shapes of equal capability — which
# is prose in integrations/README.md, not something this script can test.
SHAPES="cli api ssh mcp browser"

is_manifest_path() { [[ "$1" =~ (^|/)integrations/[^/]+/README\.md$ ]]; }

script_root() { (cd "$(dirname "$0")/../.." && pwd); }

mode="changed"
since=""
case "${1:-}" in
  --all)
    [[ $# -eq 1 ]] || { err "check-integration-manifest: --all takes no paths"; exit 2; }
    mode="all"
    ;;
  --since)
    [[ -n "${2:-}" ]] || { err "check-integration-manifest: --since needs a ref"; exit 2; }
    since="$2"
    shift 2
    [[ $# -eq 0 ]] || { err "check-integration-manifest: --since takes no paths"; exit 2; }
    ;;
  -*)
    err "check-integration-manifest: unknown option $1"
    exit 2
    ;;
  "") ;;
  *) mode="paths" ;;
esac

TARGETS=""   # newline-separated
n_targets=0
add_target() { TARGETS="${TARGETS}$1"$'\n'; n_targets=$((n_targets + 1)); }

if [[ "$mode" == "paths" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || script_root)"
  for f in "$@"; do add_target "$f"; done
elif [[ "$mode" == "all" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || script_root)"
  cd "$REPO_ROOT" || exit 2
  for f in integrations/*/README.md; do
    [[ -f "$f" ]] && add_target "$f"
  done
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    err "check-integration-manifest: not inside a git work tree"
    exit 2
  }
  cd "$REPO_ROOT" || exit 2
  base="HEAD"
  if [[ -n "$since" ]]; then
    base="$(git merge-base HEAD "$since")" || {
      err "check-integration-manifest: cannot find where HEAD left $since"
      exit 2
    }
  fi
  # Tracked changes against the base plus untracked files, one per file.
  # `--no-renames` lists a move as its two halves; the half no longer on disk
  # is dropped here. Each list is captured and its exit checked: a git that
  # cannot answer must not read as "nothing changed".
  changed="$(git diff --name-only --no-renames "$base" 2>&1)" || {
    err "check-integration-manifest: git diff against $base failed: $changed"
    exit 2
  }
  untracked="$(git ls-files --others --exclude-standard 2>&1)" || {
    err "check-integration-manifest: git ls-files failed: $untracked"
    exit 2
  }
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    is_manifest_path "$path" || continue
    [[ -f "$path" ]] || continue
    add_target "$path"
  done < <(printf '%s\n%s\n' "$changed" "$untracked" | LC_ALL=C sort -u)
fi

if [[ $n_targets -eq 0 ]]; then
  echo "OK — 0 manifest(s) checked"
  exit 0
fi

# ─── Valid CREDS keys (read once, and only when a manifest names one) ────────
# `onepassword_item` names a stable CREDS key, never a 1Password title — the
# titles are mutable, so a README copy of one drifts.
CREDS_FILE="${INTEGRATION_MANIFEST_CREDS:-$REPO_ROOT/integrations/1password/credentials.ts}"
VALID_CREDS=""
creds_read=0
creds_keys() {
  [[ "$creds_read" == 1 ]] && return 0
  creds_read=1
  if [[ -f "$CREDS_FILE" ]]; then
    VALID_CREDS=$(node --experimental-strip-types --no-warnings --preserve-symlinks --preserve-symlinks-main \
      -e 'const m = await import(process.argv[1]); console.log(Object.keys(m.CREDS).join(" "));' \
      "$CREDS_FILE" 2>/dev/null) || VALID_CREDS=""
  fi
  if [[ -z "$VALID_CREDS" ]]; then
    err "check-integration-manifest: cannot read CREDS keys from $CREDS_FILE — onepassword_item unverifiable"
    exit 1
  fi
}

# ─── Readers ─────────────────────────────────────────────────────────────────
# The frontmatter block, no fences. It MUST open on line 1 and MUST be closed,
# and both fences are exactly `---`. A CRLF file's `\r` is dropped first. Exit
# 2 = no opening fence, 3 = never closed.
frontmatter() {
  awk '
    { sub(/\r$/, "") }
    NR==1 && $0 != "---" { bad=2; exit }
    NR==1 { next }
    $0 == "---" { closed=1; exit }
    { print }
    END { if (bad) exit bad; if (!closed) exit 3 }
  ' "$1"
}

# parse_fm <frontmatter> — one awk pass, one fact per line, TAB-separated:
#   K <key>            every top-level key, in order, repeats kept
#   V <key> <value>    the text after `key:` on its own line (first occurrence)
#   L <key> <item>     a `- item` value under a bare `key:`
#   I <n>:<line>       an indented line that is not a list item
FACTS=""
parse_fm() {
  FACTS="$(printf '%s\n' "$1" | awk '
    match($0, /^[A-Za-z_][A-Za-z0-9_-]*:/) {
      cur = substr($0, 1, RLENGTH - 1)
      v = substr($0, RLENGTH + 1); sub(/^[ \t]+/, "", v)
      print "K\t" cur
      if (!(cur in seen)) { seen[cur] = 1; print "V\t" cur "\t" v }
      in_list = (v == "")
      next
    }
    match($0, /^[ \t]*-[ \t]+/) {
      if (in_list) print "L\t" cur "\t" substr($0, RLENGTH + 1)
      next
    }
    { in_list = 0 }
    /^[ \t]+/ { print "I\t" NR ":" $0 }
  ')"
}

keys_in_order() { printf '%s\n' "$FACTS" | awk -F'\t' '$1 == "K" { printf "%s%s", (n++ ? " " : ""), $2 }'; }
has_key() { printf '%s\n' "$FACTS" | awk -F'\t' -v k="$1" '$1 == "V" && $2 == k { f = 1 } END { exit !f }'; }
val_of() { printf '%s\n' "$FACTS" | awk -F'\t' -v k="$1" '$1 == "V" && $2 == k { sub(/^V\t[^\t]*\t/, ""); print; exit }'; }
# list_of <key> — the key's list items, one per line, empties dropped.
list_of() { printf '%s\n' "$FACTS" | awk -F'\t' -v k="$1" '$1 == "L" && $2 == k { sub(/^L\t[^\t]*\t/, ""); if ($0 != "") print }'; }
list_keys() { printf '%s\n' "$FACTS" | awk -F'\t' '$1 == "L" && !s[$2]++ { print $2 }'; }
indented() { printf '%s\n' "$FACTS" | awk -F'\t' '$1 == "I" { sub(/^I\t/, ""); printf "%s%s", (n++ ? " | " : ""), $0 }'; }
count_lines() { if [[ -z "$1" ]]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
in_words() { [[ " $2 " == *" $1 "* ]]; }

# yaml_unsafe <scalar> — true when YAML would not read <scalar> back as the
# string written, with the reason in YAML_WHY.
YAML_WHY=""
yaml_unsafe() {
  local v="$1"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ "$v" =~ ^\".*\"$ || "$v" =~ ^\'.*\'$ ]]; then return 1; fi
  if [[ "$v" == *": "* || "$v" == *: ]]; then
    YAML_WHY="contains an unquoted \`: \` — YAML reads it as a nested mapping"
    return 0
  fi
  if [[ "$v" == "-" || "$v" == "- "* ]]; then
    YAML_WHY="starts with \`- \` — YAML reads it as a nested list"
    return 0
  fi
  case "${v:0:1}" in
    '`' | '@' | '%' | '&' | '*' | '!' | '|' | '>' | '{' | '[' | ',' | '?' | '#')
      YAML_WHY="starts with the YAML indicator \"${v:0:1}\""
      return 0
      ;;
  esac
  return 1
}

violations=0

violation() {
  err "$1: ($2) $3"
  violations=$((violations + 1))
}

check_readme() {
  local readme="$1"
  local dir="${readme%/*}"
  local fm fm_rc=0
  fm="$(frontmatter "$readme")" || fm_rc=$?

  case "$fm_rc" in
    0) ;;
    2) violation "$readme" a "no frontmatter, or content before the opening \`---\` — the manifest must start on line 1"; return ;;
    3) violation "$readme" a "frontmatter is never closed by a second \`---\`"; return ;;
    *) violation "$readme" a "frontmatter could not be read"; return ;;
  esac
  if [[ -z "$fm" ]]; then
    violation "$readme" a "empty frontmatter — every integration README carries the manifest"
    return
  fi

  parse_fm "$fm"

  # (a) No nested maps: the readers take scalars and block sequences only,
  #     and silently drop an indented sub-key.
  local ind
  ind="$(indented)"
  if [[ -n "$ind" ]]; then
    violation "$readme" a "indented line that is not a \`- \` list item (nested maps are not read): $ind"
  fi

  # (b) Exactly the required keys, in order, `uses-why` only after `uses`.
  local present_list expected_list="" k
  present_list="$(keys_in_order)"
  for k in $REQUIRED_KEYS; do
    expected_list="${expected_list:+$expected_list }$k"
    if [[ "$k" == "uses" ]] && in_words uses-why "$present_list"; then
      expected_list="$expected_list uses-why"
    fi
  done
  if [[ "$present_list" != "$expected_list" ]]; then
    local missing="" extra=""
    for k in $REQUIRED_KEYS; do
      in_words "$k" "$present_list" || missing+="$k "
    done
    for k in $present_list; do
      in_words "$k" "$REQUIRED_KEYS uses-why" || extra+="$k "
    done
    if [[ -n "$missing" ]]; then
      violation "$readme" b "missing manifest key(s): ${missing% }"
    fi
    if [[ -n "$extra" ]]; then
      violation "$readme" b "unknown manifest key(s): ${extra% } — the manifest is exactly: ${REQUIRED_KEYS}, with optional uses-why directly after uses"
    fi
    if [[ -z "$missing" && -z "$extra" ]]; then
      violation "$readme" b "manifest keys out of order — got \"$present_list\", want \"$expected_list\" (uses-why is optional and sits directly after uses)"
    fi
  fi

  # (c) List keys are block sequences with at least one entry.
  local inline
  for k in hosts aliases typed_client access; do
    has_key "$k" || continue
    inline="$(val_of "$k")"
    if [[ -n "$inline" ]]; then
      violation "$readme" c "\`${k}\` must be a block sequence (\`- item\` lines), got inline value \"$inline\""
      continue
    fi
    if [[ -z "$(list_of "$k")" ]]; then
      violation "$readme" c "\`${k}\` is empty — every integration declares at least one entry"
    fi
  done

  # (d) Every `access` value is a shape, none repeated. Order is the product's
  #     capability ranking and is not checked.
  local access a seen_shapes=""
  access="$(list_of access)"
  while IFS= read -r a; do
    [[ -n "$a" ]] || continue
    if ! in_words "$a" "$SHAPES"; then
      violation "$readme" d "\`access\` value \"$a\" is not one of: ${SHAPES}"
    elif in_words "$a" "$seen_shapes"; then
      violation "$readme" d "\`access\` lists \"$a\" more than once"
    fi
    seen_shapes="$seen_shapes $a"
  done <<<"$access"

  # (e) Every `typed_client` entry names a file in this folder, or the list is
  #     the single item `none`.
  local clients c actual="" f
  clients="$(list_of typed_client)"
  for f in "$dir"/*.ts; do
    [[ -f "$f" ]] || continue
    [[ "$f" == *.test.ts ]] && continue
    actual="${actual:+$actual }$(basename "$f")"
  done
  local n_clients
  n_clients="$(count_lines "$clients")"
  local clients_words
  clients_words="$(printf '%s' "$clients" | tr '\n' ' ')"
  clients_words="${clients_words% }"

  if [[ "$n_clients" -eq 1 && "$clients" == "none" ]]; then
    if [[ -n "$actual" ]]; then
      violation "$readme" e "\`typed_client: none\` but $dir ships $(printf '%s' "$actual" | wc -w | tr -d ' ') entry point(s): ${actual}"
    fi
  elif [[ "$n_clients" -gt 0 ]]; then
    while IFS= read -r c; do
      [[ -n "$c" ]] || continue
      if [[ "$c" == "none" ]]; then
        violation "$readme" e "\`typed_client\` mixes \"none\" with real entries — use \"none\" alone or list only files"
      elif [[ ! -f "$dir/$c" ]]; then
        violation "$readme" e "\`typed_client\` names \"$c\" but $dir/$c does not exist"
      fi
    done <<<"$clients"
    for f in $actual; do
      in_words "$f" "$clients_words" ||
        violation "$readme" e "$dir/$f is a non-test entry point but \`typed_client\` does not list it"
    done
  fi

  # (f) `onepassword_item` is a CREDS key or `none`.
  local opi
  opi="$(val_of onepassword_item)"
  opi="${opi%\"}"
  opi="${opi#\"}"
  if [[ -z "$opi" ]]; then
    if has_key onepassword_item; then
      violation "$readme" f "\`onepassword_item\` is empty — name a \`CREDS.<key>\` or \`none\`"
    fi
  elif [[ "$opi" != "none" ]]; then
    if [[ "$opi" != CREDS.* ]]; then
      violation "$readme" f "\`onepassword_item: $opi\` — must be \`CREDS.<key>\` (the stable key, never the 1Password title) or \`none\`"
    else
      creds_keys
      in_words "${opi#CREDS.}" "$VALID_CREDS" ||
        violation "$readme" f "\`onepassword_item: $opi\` — no such key exported from credentials.ts"
    fi
  fi

  # (g2) Every scalar must be one YAML reads back as written. A list item is
  #      held to the same test: `- host: alias` is a map to YAML.
  local line kk vv item
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_-]*):[[:space:]]*(.+)$ ]] || continue
    kk="${BASH_REMATCH[1]}"
    vv="${BASH_REMATCH[2]}"
    yaml_unsafe "$vv" || continue
    violation "$readme" g2 "\`${kk}\` value $YAML_WHY — wrap the value in double quotes"
  done <<<"$fm"
  while IFS= read -r kk; do
    [[ -n "$kk" ]] || continue
    while IFS= read -r item; do
      [[ -n "$item" ]] || continue
      yaml_unsafe "$item" || continue
      violation "$readme" g2 "\`${kk}\` item $YAML_WHY — wrap the item in double quotes"
    done <<<"$(list_of "$kk")"
  done <<<"$(list_keys)"

  # (g) Remaining scalars are non-empty.
  for k in name description base_url auth rate_limit cli; do
    has_key "$k" || continue
    [[ -n "$(val_of "$k")" ]] || violation "$readme" g "\`${k}\` is empty — use \`none\` when the field does not apply"
  done

  # (h)–(k) `uses` and `uses-why`. Skipped when `uses` is absent: part (b)
  #         already named it missing.
  has_key uses || return 0
  local uses why has_why=0 first_access access_words
  uses="$(val_of uses)"
  uses="${uses%"${uses##*[![:space:]]}"}"
  has_key uses-why && has_why=1
  why="$(val_of uses-why)"
  first_access="$(printf '%s\n' "$access" | sed -n 1p)"
  access_words="$(printf '%s' "$access" | tr '\n' ' ')"
  access_words="${access_words% }"

  if [[ -z "$uses" ]]; then
    if [[ -n "$(list_of uses)" ]]; then
      violation "$readme" h "\`uses\` must be one value (${SHAPES} or none), not a list"
    else
      violation "$readme" h "\`uses\` is empty — name the shape the repo's code goes through, or \`none\`"
    fi
    return 0
  fi
  if ! in_words "$uses" "$SHAPES none"; then
    violation "$readme" h "\`uses: $uses\` is not one of: ${SHAPES} none"
    return 0
  fi

  if [[ "$uses" == "none" ]]; then
    if [[ ! ("$n_clients" -eq 1 && "$clients" == "none") ]]; then
      violation "$readme" j "\`uses: none\` but \`typed_client\` lists ${clients_words:-nothing} — a client is code that reaches the product"
    fi
    if [[ $has_why -eq 1 && -z "$why" ]]; then
      violation "$readme" g "\`uses-why\` is empty — drop the key or give the reason"
    fi
    return 0
  fi

  if ! in_words "$uses" "$access_words"; then
    violation "$readme" i "\`uses: $uses\` is not in \`access\` (${access_words:-empty})"
    return 0
  fi

  if [[ "$uses" != "$first_access" ]]; then
    if [[ -z "$why" ]]; then
      violation "$readme" k "\`uses: $uses\` is not the first \`access\` value (${first_access}), the most capable shape — add a non-empty \`uses-why\` saying why the code takes $uses"
    fi
  elif [[ $has_why -eq 1 && -z "$why" ]]; then
    violation "$readme" g "\`uses-why\` is empty — drop the key or give the reason"
  fi
}

while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  if [[ ! -f "$f" ]]; then
    violation "$f" a "no such file"
    continue
  fi
  check_readme "$f"
done <<<"$TARGETS"

if [[ $violations -gt 0 ]]; then
  echo "FAIL — ${n_targets} manifest(s) checked, ${violations} violation(s)"
  exit 1
fi
echo "OK — ${n_targets} manifest(s) checked"
