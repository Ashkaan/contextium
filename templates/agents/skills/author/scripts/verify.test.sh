#!/usr/bin/env bash
# Test harness for verify.sh — round-trips each type through scaffold.sh then
# asserts verify passes the well-formed scaffold and fails a deliberately
# broken one.
#
# peers: verify.sh, scaffold.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$SCRIPT_DIR/verify.sh"
SCAFFOLD="$SCRIPT_DIR/scaffold.sh"
# Five levels, not four: scripts -> author -> skills -> agents -> templates -> the
# repo root. Stopping at templates/ made scaffold write into a directory that
# does not exist, so the round-trip cases had no file to verify.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"

[[ -x "$VERIFY" ]] || { echo "FAIL: not executable: $VERIFY" >&2; exit 1; }

pass=0
fail=0
assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

CLEANUP=()
cleanup() {
  for p in "${CLEANUP[@]:-}"; do
    [[ -n "$p" ]] && rm -rf "${REPO_ROOT:?}/${p:?}"
  done
}
trap cleanup EXIT

verify_rc() {
  local rc=0
  "$VERIFY" "$@" >/dev/null 2>&1 || rc=$?
  echo "$rc"
}

# ── Case 1: usage (missing args) → exit 2 ──
case_usage() {
  local rc
  rc=$(verify_rc skill)
  [[ "$rc" -eq 2 ]] || { assert_fail "usage" "expected exit 2; got $rc"; return; }
  assert_pass "usage missing-arg exit2"
}

# ── Case 2: skill round-trip → verify passes ──
case_skill_ok() {
  local name="zz-verify-test-skill" path rc
  CLEANUP+=(".agents/skills/$name")
  path=$("$SCAFFOLD" skill "$name" 2>/dev/null)
  rc=$(verify_rc skill "$REPO_ROOT/$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "skill-ok" "expected pass; got $rc"; return; }
  assert_pass "skill scaffold verifies"
}

# ── Case 3: agent round-trip → verify passes; broken agent → fails ──
case_agent() {
  local name="zz-verify-test-agent" path rc
  CLEANUP+=(".agents/reviewers/$name.md")
  path=$("$SCAFFOLD" agent "$name" 2>/dev/null)
  rc=$(verify_rc agent "$REPO_ROOT/$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "agent-ok" "expected pass; got $rc"; return; }
  # Break it: strip the `model:` line → missing required field.
  grep -v '^model:' "$REPO_ROOT/$path" > "$REPO_ROOT/$path.tmp" && mv "$REPO_ROOT/$path.tmp" "$REPO_ROOT/$path"
  rc=$(verify_rc agent "$REPO_ROOT/$path")
  [[ "$rc" -ne 0 ]] || { assert_fail "agent-broken" "expected fail on missing model:"; return; }
  assert_pass "agent ok-then-broken-field"
}

# ── Case 4: hook round-trip → verify passes; missing safe-mode → fails ──
case_hook() {
  local name="zz-verify-test-hook" path rc
  CLEANUP+=(".claude/hooks/$name.sh")
  path=$("$SCAFFOLD" hook "$name" 2>/dev/null)
  rc=$(verify_rc hook "$REPO_ROOT/$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-ok" "expected pass; got $rc"; return; }
  # Break it: remove `set -euo pipefail`.
  grep -v '^set -euo pipefail' "$REPO_ROOT/$path" > "$REPO_ROOT/$path.tmp" && mv "$REPO_ROOT/$path.tmp" "$REPO_ROOT/$path"
  rc=$(verify_rc hook "$REPO_ROOT/$path")
  [[ "$rc" -ne 0 ]] || { assert_fail "hook-broken" "expected fail on missing safe-mode"; return; }
  assert_pass "hook ok-then-missing-safemode"
}

# ── Case 5: rule → verify dispatches to run-rule-linters ──
# Asserts delegation (verify's actual unit), NOT repo-wide ref health: the
# linters run a whole-repo scan whose pass/fail depends on unrelated files.
# The linters themselves are tested hermetically by run-rule-linters.test.sh.
case_rule() {
  local out
  # Any shipped rule file works here; this asserts DELEGATION, not the rule.
  # .agents/rules/ in a project that INSTALLED the layer, templates/agents/rules/
  # in the repo that authors it. Only one of the two exists in any checkout.
  local rule_file="$REPO_ROOT/.agents/rules/no-deferral.md"
  [[ -f "$rule_file" ]] || rule_file="$REPO_ROOT/templates/agents/rules/no-deferral.md"
  out=$("$VERIFY" rule "$rule_file" 2>&1 || true)
  echo "$out" | grep -q "check-rule-format" || { assert_fail "rule-dispatch" "verify did not reach run-rule-linters: $out"; return; }
  # Missing path still routes through the type dispatch → non-zero.
  local rc
  rc=$(verify_rc rule "$REPO_ROOT/.agents/rules/does-not-exist.md")
  [[ "$rc" -ne 0 ]] || { assert_fail "rule-missing" "expected non-zero on missing rule file"; return; }
  assert_pass "rule dispatches to linters"
}

# ── Principle gates (SKILL.md § The four principles) — each must FAIL a violating artifact ──

write_skill() {
  # write_skill <name> <description> <body-line-count>
  local name="$1" desc="$2" lines="$3" dir
  dir="$REPO_ROOT/.agents/skills/$name"
  mkdir -p "$dir"
  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    echo "---"
    echo "# $name"
    for ((i = 0; i < lines; i++)); do echo "body line $i"; done
  } > "$dir/SKILL.md"
}

# Capture verify's combined output without tripping `set -e`/pipefail.
verify_out() { "$VERIFY" "$@" 2>&1 || true; }

# P1/P2: description over the 1,024-char cap (Agent Skills spec) → FAIL; at the cap → no cap error.
case_desc_cap() {
  local name="zz-verify-desccap" big out
  CLEANUP+=(".agents/skills/$name")
  big=$(printf 'x%.0s' $(seq 1 1025))
  write_skill "$name" "$big" 5
  local rc; rc=$(verify_rc skill "$REPO_ROOT/.agents/skills/$name/SKILL.md")
  [[ "$rc" -ne 0 ]] || { assert_fail "desc-cap" "1025-char description should fail"; return; }
  big=$(printf 'x%.0s' $(seq 1 1024))
  write_skill "$name" "$big" 5
  out=$(verify_out skill "$REPO_ROOT/.agents/skills/$name/SKILL.md")
  grep -q "description is" <<<"$out" && { assert_fail "desc-cap" "1024-char description should pass the cap gate"; return; }
  assert_pass "desc-cap 1025-fails 1024-ok"
}

# P1: first-person description → FAIL.
case_first_person() {
  local name="zz-verify-fp" out
  CLEANUP+=(".agents/skills/$name")
  write_skill "$name" "I scaffold artifacts when you ask me to." 5
  out=$(verify_out skill "$REPO_ROOT/.agents/skills/$name/SKILL.md")
  grep -q "first-person" <<<"$out" || { assert_fail "first-person" "first-person description should fail"; return; }
  assert_pass "first-person rejected"
}

# P2/P4: SKILL.md body over 500 lines → FAIL.
case_body_limit() {
  local name="zz-verify-body" out
  CLEANUP+=(".agents/skills/$name")
  write_skill "$name" "Scaffolds a thing for the repo." 501
  out=$(verify_out skill "$REPO_ROOT/.agents/skills/$name/SKILL.md")
  grep -q "body is" <<<"$out" || { assert_fail "body-limit" "501-line body should fail"; return; }
  assert_pass "body-limit 501-fails"
}

# P1: top-level hook using exit 1 → FAIL; checks/ hook using exit 1 → PASS.
case_hook_placement() {
  local top="zz-verify-hooktop" out
  CLEANUP+=(".claude/hooks/$top.sh")
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n' > "$REPO_ROOT/.claude/hooks/$top.sh"
  out=$(verify_out hook "$REPO_ROOT/.claude/hooks/$top.sh")
  grep -q "NON-blocking" <<<"$out" || { assert_fail "hook-placement" "top-level exit 1 should fail"; return; }
  local chk="zz-verify-hookchk" path rc
  CLEANUP+=(".githooks/checks/$chk.sh")
  path=$("$SCAFFOLD" hook "$chk" checks 2>/dev/null)
  rc=$(verify_rc hook "$REPO_ROOT/$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-placement" "checks/ exit 1 should pass; got $rc"; return; }
  assert_pass "hook-placement top-exit1-fails checks-ok"
}

# P1/P2: agent with empty allowed-tools → FAIL.
case_agent_tools() {
  local name="zz-verify-agenttools" out
  CLEANUP+=(".agents/reviewers/$name.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs.\nmodel: inherit\ntools: []\npeers: []\nenforces: []\n---\nbody\n' "$name" > "$REPO_ROOT/.agents/reviewers/$name.md"
  out=$(verify_out agent "$REPO_ROOT/.agents/reviewers/$name.md")
  grep -q "tools is empty" <<<"$out" || { assert_fail "agent-tools" "empty allowed-tools should fail"; return; }
  assert_pass "agent-tools empty-rejected"
}

# ── Adversarial-review hardening (probe/code-reviewer findings) ──

# Finding 1: a folded/block-scalar description must NOT bypass the cap or the
# first-person scan (frontmatter_value now folds continuation lines).
case_desc_folded() {
  local name="zz-verify-folded" dir out
  CLEANUP+=(".agents/skills/$name")
  dir="$REPO_ROOT/.agents/skills/$name"; mkdir -p "$dir"
  { echo "---"; echo "name: $name"; echo "description: >"; \
    printf '  %s\n' "$(printf 'x%.0s' $(seq 1 1600))"; \
    echo "---"; echo "# $name"; echo body; } > "$dir/SKILL.md"
  out=$(verify_out skill "$dir/SKILL.md")
  grep -q "description is" <<<"$out" || { assert_fail "desc-folded" "folded 1600-char description should fail the cap"; return; }
  assert_pass "desc-folded cap not bypassed"
}

# Finding 2: first-person markers beyond standalone "I" are caught.
case_first_person_words() {
  local name="zz-verify-fpw" out
  CLEANUP+=(".agents/skills/$name")
  write_skill "$name" "My job is to scaffold things for the repo." 5
  out=$(verify_out skill "$REPO_ROOT/.agents/skills/$name/SKILL.md")
  grep -q "first-person" <<<"$out" || { assert_fail "fp-words" "'My job' should be flagged first-person"; return; }
  assert_pass "first-person my/we caught"
}

# Finding 3: a top-level hook that blocks via exit 1 inside a helper fn is caught.
case_hook_exit1_indirect() {
  local name="zz-verify-hookind" out
  CLEANUP+=(".claude/hooks/$name.sh")
  printf '#!/usr/bin/env bash\nset -euo pipefail\nblock() { exit 1; }\nblock\n' > "$REPO_ROOT/.claude/hooks/$name.sh"
  out=$(verify_out hook "$REPO_ROOT/.claude/hooks/$name.sh")
  grep -q "NON-blocking" <<<"$out" || { assert_fail "hook-indirect" "exit 1 inside a fn should be flagged"; return; }
  assert_pass "hook exit1-via-fn caught"
}

# Finding 4: a block-style `tools:` list is non-empty (no false positive).
case_agent_tools_block() {
  local name="zz-verify-tblock" rc
  CLEANUP+=(".agents/reviewers/$name.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs.\nmodel: inherit\ntools:\n  - Read\n  - Grep\npeers: []\nenforces: []\n---\nbody\n' "$name" > "$REPO_ROOT/.agents/reviewers/$name.md"
  rc=$(verify_rc agent "$REPO_ROOT/.agents/reviewers/$name.md")
  [[ "$rc" -eq 0 ]] || { assert_fail "tools-block" "block-style tools: should pass; got $rc"; return; }
  assert_pass "block-style tools accepted"
}

# Finding 5: an external https .md URL in a reference is NOT a second-hop; a
# local .md link IS.
case_ref_url_vs_local() {
  local name="zz-verify-refs" dir out
  CLEANUP+=(".agents/skills/$name")
  dir="$REPO_ROOT/.agents/skills/$name"; mkdir -p "$dir/references"
  write_skill "$name" "Scaffolds a thing for the repo." 5
  echo "See [docs](https://code.claude.com/docs/en/skills.md)." > "$dir/references/ok.md"
  out=$(verify_out skill "$dir/SKILL.md")
  grep -q "another local .md" <<<"$out" && { assert_fail "ref-url" "https .md URL should NOT be flagged"; return; }
  echo "See [sibling](other.md)." > "$dir/references/bad.md"
  out=$(verify_out skill "$dir/SKILL.md")
  grep -q "another local .md" <<<"$out" || { assert_fail "ref-local" "local .md link should be flagged"; return; }
  assert_pass "ref https-ok local-flagged"
}

# ── output-style: every one of these is SILENT at load time, which is the
# whole reason the branch exists. The parser ignores unknown keys and defaults
# keep-coding-instructions to false. ──
case_output_style() {
  local dir out
  dir=$(mktemp -d)
  mk_os() { printf '%b' "$2" > "$dir/$1"; }

  mk_os ok.md '---\nname: x\ndescription: does a thing\nkeep-coding-instructions: true\n---\n\nbody\n'
  verify_out output-style "$dir/ok.md" >/dev/null 2>&1 \
    || { assert_fail "output-style-ok" "well-formed style should pass"; return; }

  mk_os nodesc.md '---\nname: x\nkeep-coding-instructions: true\n---\n\nbody\n'
  out=$(verify_out output-style "$dir/nodesc.md" 2>&1 || true)
  grep -q "description" <<<"$out" || { assert_fail "output-style-desc" "missing description should be flagged"; return; }

  mk_os nokci.md '---\nname: x\ndescription: d\n---\n\nbody\n'
  out=$(verify_out output-style "$dir/nokci.md" 2>&1 || true)
  grep -q "keep-coding-instructions" <<<"$out" || { assert_fail "output-style-kci" "absent keep-coding-instructions should be flagged"; return; }

  mk_os typo.md '---\nname: x\ndescription: d\nkeep_coding_instructions: true\n---\n\nbody\n'
  out=$(verify_out output-style "$dir/typo.md" 2>&1 || true)
  grep -q "unknown frontmatter key" <<<"$out" || { assert_fail "output-style-typo" "underscore variant should be flagged as unknown"; return; }

  mk_os badval.md '---\nname: x\ndescription: d\nkeep-coding-instructions: yes\n---\n\nbody\n'
  out=$(verify_out output-style "$dir/badval.md" 2>&1 || true)
  grep -q "not true|false" <<<"$out" || { assert_fail "output-style-badval" "non-boolean should be flagged"; return; }

  # grep -w treated hyphen as a non-word boundary, so each of these five
  # substrings of the two hyphenated field names passed as a KNOWN key.
  for bogus in keep coding instructions force plugin; do
    mk_os "sub-$bogus.md" "---\nname: x\ndescription: d\nkeep-coding-instructions: true\n$bogus: true\n---\n\nbody\n"
    out=$(verify_out output-style "$dir/sub-$bogus.md" 2>&1 || true)
    grep -q "unknown frontmatter key" <<<"$out" \
      || { assert_fail "output-style-substring-$bogus" "\`$bogus:\` should be flagged as unknown"; return; }
  done

  mk_os plugin.md '---\nname: x\ndescription: d\nkeep-coding-instructions: false\nforce-for-plugin: true\n---\n\nbody\n'
  verify_out output-style "$dir/plugin.md" >/dev/null 2>&1 \
    || { assert_fail "output-style-plugin" "all four documented keys should pass"; return; }

  rm -rf "$dir"
  assert_pass "output-style frontmatter (unknown-key, description, keep-coding-instructions)"
}

case_usage
case_output_style
case_skill_ok
case_agent
case_hook
case_rule
case_desc_cap
case_first_person
case_body_limit
case_hook_placement
case_agent_tools
case_desc_folded
case_first_person_words
case_hook_exit1_indirect
case_agent_tools_block
case_ref_url_vs_local

echo
echo "verify.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
