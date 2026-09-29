#!/usr/bin/env bash
# Boundary rows for check-integration-manifest.sh: every part letter, the
# `uses` / `uses-why` rules, and the no-args / `--since` scan land.sh calls
# (changed, untracked, deleted, committed on the branch).
#
# Fixture READMEs live under a scratch dir; the scan-mode rows use real
# `git init`-ed repos, because those modes read `git diff` and
# `git ls-files --others`. The script is run as a subprocess, never sourced.
#
# Usage: bash check-integration-manifest.test.sh
# Exit 0 = every case behaves as specified.

# shellcheck disable=SC2016  # single-quoted needles carry literal backticks on purpose
set -uo pipefail

CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-integration-manifest.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/integration-manifest-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# A stand-in credentials.ts so `onepassword_item` is verifiable without the repo.
# The key prefix is assembled at run time, so no `CREDS.<key>` literal ships in
# this file (the release's leak gate refuses one).
CK="CREDS"
cat >"$TMP/credentials-fixture.ts" <<'TS'
export const CREDS = {
  demo: { id: "x", title: "t", fields: {}, consumers: [] },
  slack: { id: "y", title: "t", fields: {}, consumers: [] },
} as const;
TS
export INTEGRATION_MANIFEST_CREDS="$TMP/credentials-fixture.ts"

pass=0
fail=0

# make_readme <dir-name> <frontmatter-body> [extra-file]
make_readme() {
  local name="$1" fm="$2" extra="${3:-}"
  local d="$TMP/integrations/$name"
  mkdir -p "$d"
  { echo "---"; printf '%s\n' "$fm"; echo "---"; echo; echo "# $name"; } >"$d/README.md"
  [ -n "$extra" ] && : >"$d/$extra"
  echo "$d/README.md"
}

# expect <want:ok|violation> <case-name> <readme-path> [substring the message must contain]
expect() {
  local want="$1" case_name="$2" readme="$3" needle="${4:-}"
  local out rc=0
  out=$(cd "$TMP" && bash "$CHECK" "$readme" 2>&1) || rc=$?
  local got="ok"
  [ $rc -ne 0 ] && got="violation"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $case_name — expected $want, got $got"
    echo "  output: $out"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; then
    echo "FAIL: $case_name — message did not mention \"$needle\""
    echo "  output: $out"
    fail=$((fail + 1))
    return
  fi
  echo "ok: $case_name"
  pass=$((pass + 1))
}

VALID_FM='name: Dataforseo
description: A one-line description
hosts:
  - host.example.com
aliases:
  - example
typed_client:
  - client.ts
access:
  - api
uses: api
base_url: https://api.example.com
auth: basic
onepassword_item: ${CK}.demo
rate_limit: none
cli: REST API'
VALID_FM="${VALID_FM/'${CK}'/$CK}"

# The manifest-only shape: no client, no code reaches the product.
NONE_FM="${VALID_FM/  - client.ts/  - none}"
NONE_FM="${NONE_FM/uses: api/uses: none}"

# — the valid shapes —
expect ok "valid manifest" \
  "$(make_readme dataforseo "$VALID_FM" client.ts)"

expect ok "manifest-only folder (typed_client, uses and onepassword_item none)" \
  "$(make_readme metacritic "${NONE_FM/${CK}.demo/none}")"

CF_README="$(make_readme cloudflare "${VALID_FM/  - client.ts/  - client.ts$'\n'  - d1.ts}" client.ts)"
: >"$TMP/integrations/cloudflare/d1.ts"
expect ok "several typed_client entries" "$CF_README"

expect ok "all five shapes, canonical order" \
  "$(make_readme laddered "${VALID_FM/  - api/  - api$'\n'  - cli$'\n'  - ssh$'\n'  - mcp$'\n'  - browser}" client.ts)"

# Order carries the product's capability ranking, so a non-canonical one passes.
expect ok "access in a non-canonical order" \
  "$(make_readme reordered "${VALID_FM/  - api/  - api$'\n'  - ssh}" client.ts)"

# — (a) fences and nesting —
expect violation "content before the opening fence" \
  "$(mkdir -p "$TMP/integrations/preamble" && { echo "stray line"; echo "---"; printf '%s\n' "$VALID_FM"; echo "---"; } >"$TMP/integrations/preamble/README.md" && : >"$TMP/integrations/preamble/client.ts" && echo "$TMP/integrations/preamble/README.md")" \
  "(a) no frontmatter, or content before the opening"

expect violation "front matter never closed" \
  "$(mkdir -p "$TMP/integrations/unclosed" && { echo "---"; printf '%s\n' "$VALID_FM"; echo "# body, no closing fence"; } >"$TMP/integrations/unclosed/README.md" && : >"$TMP/integrations/unclosed/client.ts" && echo "$TMP/integrations/unclosed/README.md")" \
  "(a) frontmatter is never closed"

expect violation "no front matter at all" \
  "$(mkdir -p "$TMP/integrations/bare" && echo "# bare" >"$TMP/integrations/bare/README.md" && echo "$TMP/integrations/bare/README.md")" \
  "(a) no frontmatter"

# A reader that matches the opening fence as `---` then a newline drops a
# README whose fence carries a trailing space, without a word.
expect violation "opening fence with trailing whitespace" \
  "$(mkdir -p "$TMP/integrations/padfence" && { echo "--- "; printf '%s\n' "$VALID_FM"; echo "---"; } >"$TMP/integrations/padfence/README.md" && : >"$TMP/integrations/padfence/client.ts" && echo "$TMP/integrations/padfence/README.md")" \
  "(a) no frontmatter, or content before the opening"

expect violation "nested map under a key" \
  "$(make_readme nested "${VALID_FM/auth: basic/auth:$'\n'  method: basic}" client.ts)" \
  "(a) indented line"

expect violation "a named input file that does not exist" \
  "$TMP/integrations/ghost-folder/README.md" \
  "(a) no such file"

# — (b) keys —
expect violation "missing key" \
  "$(make_readme nokey "${VALID_FM/rate_limit: none$'\n'/}" client.ts)" \
  "(b) missing manifest key(s): rate_limit"

expect violation "keys out of order" \
  "$(make_readme disordered "${VALID_FM/base_url: https:\/\/api.example.com$'\n'auth: basic/auth: basic$'\n'base_url: https:\/\/api.example.com}" client.ts)" \
  "(b) manifest keys out of order"

expect violation "unknown key" \
  "$(make_readme extrakey "$VALID_FM
surprise: yes" client.ts)" \
  "(b) unknown manifest key(s): surprise"

# — (c) list shape —
expect violation "access empty" \
  "$(make_readme noaccess "${VALID_FM/access:$'\n'  - api/access:}" client.ts)" \
  '(c) `access` is empty'

expect violation "inline list instead of a block sequence" \
  "$(make_readme inline "${VALID_FM/hosts:$'\n'  - host.example.com/hosts: [host.example.com]}" client.ts)" \
  "(c) \`hosts\` must be a block sequence"

# — (d) access values —
expect violation "access value outside the five" \
  "$(make_readme badshape "${VALID_FM/  - api/  - graphql$'\n'  - api}" client.ts)" \
  '(d) `access` value "graphql" is not one of'

expect violation "access value repeated" \
  "$(make_readme dupshape "${VALID_FM/  - api/  - api$'\n'  - api}" client.ts)" \
  '(d) `access` lists "api" more than once'

# — (e) typed_client —
expect violation "typed_client names a missing file" \
  "$(make_readme ghostclient "${VALID_FM/  - client.ts/  - nope.ts}")" \
  "(e) \`typed_client\` names \"nope.ts\""

expect violation "typed_client mixes none with a real entry" \
  "$(make_readme mixedclient "${VALID_FM/  - client.ts/  - client.ts$'\n'  - none}" client.ts)" \
  "(e) \`typed_client\` mixes"

expect violation "typed_client: none while the folder ships a client" \
  "$(make_readme lyingnone "${NONE_FM}" client.ts)" \
  "(e) \`typed_client: none\` but"

UNDECL="$(make_readme undeclared "$VALID_FM" client.ts)"
: >"$TMP/integrations/undeclared/extra.ts"
expect violation "an entry point the manifest never declares" "$UNDECL" "(e) "

# — (f) onepassword_item —
expect violation "onepassword_item names an unknown CREDS key" \
  "$(make_readme badcred "${VALID_FM/${CK}.demo/${CK}.nope}" client.ts)" \
  "(f) \`onepassword_item: ${CK}.nope\` — no such key"

expect violation "onepassword_item carries a 1Password title" \
  "$(make_readme titlecred "${VALID_FM/${CK}.demo/DataForSEO API - Shared}" client.ts)" \
  "(f) \`onepassword_item: DataForSEO API - Shared\` — must be"

# — (g) and (g2) scalars —
expect violation "empty scalar" \
  "$(make_readme emptyauth "${VALID_FM/auth: basic/auth:}" client.ts)" \
  '(g) `auth` is empty'

expect violation "unquoted colon-space makes the YAML a nested mapping" \
  "$(make_readme colonval "${VALID_FM/auth: basic/auth: Authorization: Token <t>}" client.ts)" \
  "(g2) \`auth\` value contains an unquoted"

expect violation "value starting with a YAML indicator" \
  "$(make_readme tickval "${VALID_FM/cli: REST API/cli: \`yt-dlp\` (no auth)}" client.ts)" \
  "(g2) \`cli\` value starts with the YAML indicator"

expect violation "list item YAML reads as a map" \
  "$(make_readme mapitem "${VALID_FM/  - host.example.com/  - host.example.com: alias}" client.ts)" \
  "(g2) \`hosts\` item contains an unquoted"

expect violation "list item YAML reads as a nested list" \
  "$(make_readme nestitem "${VALID_FM/  - host.example.com/  - - host.example.com}" client.ts)" \
  "(g2) \`hosts\` item starts with \`- \`"

# CRLF fences are read as fences, so the check accepts them too.
expect ok "CRLF line endings" \
  "$(mkdir -p "$TMP/integrations/crlf" && { echo "---"; printf '%s\n' "$VALID_FM"; echo "---"; } | sed 's/$/\r/' >"$TMP/integrations/crlf/README.md" && : >"$TMP/integrations/crlf/client.ts" && echo "$TMP/integrations/crlf/README.md")"

expect ok "list item with a colon, quoted" \
  "$(make_readme quoteditem "${VALID_FM/  - host.example.com/  - \"host.example.com: alias\"}" client.ts)"

expect ok "the same values, quoted" \
  "$(make_readme quotedval "${VALID_FM/auth: basic/auth: \"Authorization: Token <t>\"}" client.ts)"

expect ok "quoted value with trailing whitespace" \
  "$(make_readme quotedpad "${VALID_FM/auth: basic/auth: \"Authorization: Token <t>\"   }" client.ts)"

# — (h) uses is one value from the set —
expect violation "uses missing" \
  "$(make_readme nouses "${VALID_FM/uses: api$'\n'/}" client.ts)" \
  "(b) missing manifest key(s): uses"

expect violation "uses empty" \
  "$(make_readme emptyuses "${VALID_FM/uses: api/uses:}" client.ts)" \
  '(h) `uses` is empty'

expect violation "uses as a block list" \
  "$(make_readme listuses "${VALID_FM/uses: api/uses:$'\n'  - api}" client.ts)" \
  '(h) `uses` must be one value'

expect violation "uses outside the set" \
  "$(make_readme vncuses "${VALID_FM/uses: api/uses: vnc}" client.ts)" \
  '(h) `uses: vnc` is not one of'

# — (i) uses is an access value —
expect violation "uses names a shape access does not list" \
  "$(make_readme sshuses "${VALID_FM/uses: api/uses: ssh}" client.ts)" \
  '(i) `uses: ssh` is not in `access`'

# — (j) none only without a client —
expect violation "uses none beside a real typed_client" \
  "$(make_readme noneclient "${VALID_FM/uses: api/uses: none}" client.ts)" \
  '(j) `uses: none` but `typed_client` lists'

# — (k) uses-why when the code does not take the first shape —
expect violation "uses is not access[0] and no uses-why" \
  "$(make_readme nowhy "${VALID_FM/  - api/  - cli$'\n'  - api}" client.ts)" \
  '(k) `uses: api` is not the first `access` value (cli)'

expect violation "uses-why present but empty when required" \
  "$(make_readme emptywhy "${VALID_FM/  - api$'\n'uses: api/  - cli$'\n'  - api$'\n'uses: api$'\n'uses-why:}" client.ts)" \
  '(k) `uses: api` is not the first `access` value (cli)'

expect ok "uses is not access[0], with uses-why" \
  "$(make_readme withwhy "${VALID_FM/  - api$'\n'uses: api/  - cli$'\n'  - api$'\n'uses: api$'\n'uses-why: the client runs where the CLI is not installed}" client.ts)"

expect ok "uses-why present when uses is access[0]" \
  "$(make_readme extrawhy "${VALID_FM/uses: api/uses: api$'\n'uses-why: the REST API is the whole product}" client.ts)"

expect ok "uses is access[0] of a non-canonical list, no uses-why" \
  "$(make_readme apifirst "${VALID_FM/  - api/  - api$'\n'  - cli}" client.ts)"

expect violation "uses-why placed before uses" \
  "$(make_readme whyfirst "${VALID_FM/uses: api/uses-why: text$'\n'uses: api}" client.ts)" \
  "(b) manifest keys out of order"

expect violation "uses-why placed after base_url" \
  "$(make_readme whylate "${VALID_FM/auth: basic/uses-why: text$'\n'auth: basic}" client.ts)" \
  "(b) manifest keys out of order"

# The hyphen in `uses-why` makes it a key, not an unread line.
expect violation "uses-why with an unquoted colon-space" \
  "$(make_readme whycolon "${VALID_FM/uses: api/uses: api$'\n'uses-why: reason: text}" client.ts)" \
  "(g2) \`uses-why\` value contains an unquoted"

expect violation "uses-why empty when not required" \
  "$(make_readme emptyoptional "${VALID_FM/uses: api/uses: api$'\n'uses-why:}" client.ts)" \
  '(g) `uses-why` is empty'

# — credentials.ts unreadable —
out=$(INTEGRATION_MANIFEST_CREDS="$TMP/nope.ts" bash "$CHECK" "$TMP/integrations/dataforseo/README.md" 2>&1)
rc=$?
if [ $rc -eq 1 ] && [[ "$out" == *"cannot read CREDS keys"* ]]; then
  echo "ok: credentials.ts unreadable exits 1"
  pass=$((pass + 1))
else
  echo "FAIL: credentials.ts unreadable — rc=$rc, output: $out"
  fail=$((fail + 1))
fi

# A workbench with no credentials.ts is fine while no manifest names a CREDS key.
out=$(INTEGRATION_MANIFEST_CREDS="$TMP/nope.ts" bash "$CHECK" "$TMP/integrations/metacritic/README.md" 2>&1)
rc=$?
if [ $rc -eq 0 ]; then
  echo "ok: no credentials.ts is not an error while every onepassword_item is none"
  pass=$((pass + 1))
else
  echo "FAIL: no credentials.ts with onepassword_item none — rc=$rc, output: $out"
  fail=$((fail + 1))
fi

# — caller errors —
out=$(bash "$CHECK" --since 2>&1)
rc=$?
if [ $rc -eq 2 ]; then
  echo "ok: --since with no ref exits 2"
  pass=$((pass + 1))
else
  echo "FAIL: --since with no ref — rc=$rc, output: $out"
  fail=$((fail + 1))
fi

# ── Scan modes, in real repos ─────────────────────────────────────────────

n=0
# newrepo — a repo whose first commit holds two valid manifests. Sets REPO.
newrepo() {
  n=$((n + 1))
  REPO="$TMP/repo$n"
  mkdir -p "$REPO/integrations/alpha" "$REPO/integrations/beta"
  git -C "$REPO" init -q
  git -C "$REPO" symbolic-ref HEAD refs/heads/main
  git -C "$REPO" config user.email t@example.com
  git -C "$REPO" config user.name tester
  for x in alpha beta; do
    { echo "---"; printf '%s\n' "$VALID_FM"; echo "---"; } >"$REPO/integrations/$x/README.md"
    : >"$REPO/integrations/$x/client.ts"
  done
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m seed
}

# scan <want-rc> <case-name> <stdout-needle> [args...] — runs from $REPO.
scan() {
  local want="$1" case_name="$2" needle="$3"
  shift 3
  local out rc=0
  out=$(cd "$REPO" && bash "$CHECK" "$@" 2>"$TMP/scan-err") || rc=$?
  if [ "$rc" -ne "$want" ] || [[ "$out" != *"$needle"* ]]; then
    echo "FAIL: $case_name — expected rc=$want and \"$needle\", got rc=$rc: $out"
    sed 's/^/    /' "$TMP/scan-err"
    fail=$((fail + 1))
    return
  fi
  echo "ok: $case_name"
  pass=$((pass + 1))
}

newrepo
scan 0 "no README changed" "OK — 0 manifest(s) checked"
scan 0 "--all reads every README" "OK — 2 manifest(s) checked" --all

echo "extra body line" >>"$REPO/integrations/alpha/README.md"
scan 0 "one modified README is checked" "OK — 1 manifest(s) checked"

mkdir -p "$REPO/integrations/gamma"
{ echo "---"; printf '%s\n' "${VALID_FM/uses: api/uses: vnc}"; echo "---"; } >"$REPO/integrations/gamma/README.md"
: >"$REPO/integrations/gamma/client.ts"
scan 1 "an untracked README is checked" "FAIL — 2 manifest(s) checked, 1 violation(s)"
if grep -q 'integrations/gamma/README.md: (h)' "$TMP/scan-err"; then
  echo "ok: the untracked README's violation names it"
  pass=$((pass + 1))
else
  echo "FAIL: the untracked README's violation does not name it"
  fail=$((fail + 1))
fi
rm -rf "$REPO/integrations/gamma"

git -C "$REPO" checkout -q -- integrations/alpha/README.md
git -C "$REPO" rm -q -r integrations/beta
scan 0 "a deleted README is skipped" "OK — 0 manifest(s) checked"

newrepo
git -C "$REPO" checkout -q -b branch
echo "extra body line" >>"$REPO/integrations/alpha/README.md"
git -C "$REPO" commit -q -am "edit on the branch"
scan 0 "a committed change is invisible from HEAD" "OK — 0 manifest(s) checked"
scan 0 "…and checked with --since" "OK — 1 manifest(s) checked" --since main

# A scan git cannot make is an error, never "OK — 0".
newrepo
echo "extra body line" >>"$REPO/integrations/alpha/README.md"
echo garbage >"$REPO/.git/index"
scan 2 "a git diff that fails is a caller error, not a clean scan" ""
newrepo
git -C "$REPO" checkout -q -b branch
scan 2 "--since a ref git cannot read is a caller error" "" --since no-such-ref

echo "not a manifest" >"$REPO/integrations/notes.md"
scan 0 "a non-README file under integrations/ is not a target" "OK — 0 manifest(s) checked"

# The starters this repo ships (templates/integrations/, beside this check in
# the Contextium repo; absent from an installed workbench's .agents/checks/).
STARTERS="$(cd "$(dirname "$CHECK")/../.." && pwd)/integrations"
if [ -d "$STARTERS" ]; then
  out=$(cd "$TMP" && INTEGRATION_MANIFEST_CREDS="$TMP/nope.ts" bash "$CHECK" "$STARTERS"/*/README.md 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "ok: every integration starter's manifest passes"
    pass=$((pass + 1))
  else
    echo "FAIL: the integration starters' manifests — rc=$rc:"
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=$((fail + 1))
  fi
fi

echo
echo "check-integration-manifest.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
