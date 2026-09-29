#!/usr/bin/env bash
# Rows for check-secrets.sh: a staged private key, cloud key id or hard-coded
# token is refused; clean changes pass; --since reads what the branch changed,
# committed or not, and untracked files too. Fixtures are throwaway git repos,
# and the secrets are assembled at run time so this file holds none.
set -uo pipefail

SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-secrets.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0
fail=0
rc_is() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 — want rc $3, got $2: $(cat "$TMP/err")" >&2; fi; }

KEY="-----BEGIN RSA ""PRIVATE KEY-----"
AWS="AKIA""ABCDEFGHIJKLMNOP"
TOK="api_key = \"$(printf 'x%.0s' $(seq 1 30))\""

n=0
newrepo() {
  n=$((n + 1)); R="$TMP/r$n"; mkdir -p "$R"
  git -C "$R" init -q
  git -C "$R" symbolic-ref HEAD refs/heads/main
  git -C "$R" config user.email t@example.com; git -C "$R" config user.name t
  echo seed >"$R/seed"; git -C "$R" add -A; git -C "$R" commit -q -m seed
}
run() { (cd "$R" && bash "$SUT" "$@") 2>"$TMP/err"; RC=$?; }

newrepo; run
rc_is "nothing staged" "$RC" 0
echo "plain text" >"$R/a"; git -C "$R" add a; run
rc_is "a clean staged change" "$RC" 0
for s in "$KEY" "$AWS" "$TOK"; do
  newrepo; printf '%s\n' "$s" >"$R/a"; git -C "$R" add a; run
  rc_is "a staged secret (${s:0:12}…)" "$RC" 1
done
newrepo; printf '%s\n' "$KEY" >"$R/a"; run
rc_is "an unstaged secret is not the staged diff's" "$RC" 0
run --since HEAD
rc_is "--since reads untracked files too" "$RC" 1
newrepo; git -C "$R" checkout -q -b work; printf '%s\n' "$AWS" >"$R/b"; git -C "$R" add b; git -C "$R" commit -q -m b
run --since main
rc_is "--since reads a secret already committed on the branch" "$RC" 1
run --since
rc_is "--since with no ref is a caller error" "$RC" 2

# Only what the change ADDS is scanned: removing a leaked key must pass the gate
# that exists to get it out, and an untouched line beside an edit is context.
newrepo; printf '%s\n' "$KEY" >"$R/a"; git -C "$R" add a; git -C "$R" commit -q -m leak
: >"$R/a"; git -C "$R" add a; run
rc_is "removing a committed key passes" "$RC" 0
newrepo; printf '%s\n' "$AWS" >"$R/a"; git -C "$R" add a; git -C "$R" commit -q -m leak
echo "one more line" >>"$R/a"; git -C "$R" add a; run
rc_is "a key that is only context beside an edit is not the change's" "$RC" 0
newrepo; printf '%s\n' "$KEY" >"$R/seed"; git -C "$R" commit -q -am leak; git -C "$R" checkout -q -b work; : >"$R/seed"; git -C "$R" add seed; git -C "$R" commit -q -m clear; run --since main
rc_is "--since: a removal alone passes" "$RC" 0

# A diff that cannot be read is not a clean diff.
newrepo; echo "x" >"$R/a"; git -C "$R" add a; echo garbage >"$R/.git/index"; run
rc_is "an unreadable staged diff is an error, not a pass" "$RC" 2
newrepo; echo garbage >"$R/.git/index"; run --since HEAD
rc_is "…and so under --since" "$RC" 2

echo "check-secrets.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
