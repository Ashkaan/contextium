#!/usr/bin/env bash
# Test harness for verify.sh — round-trips each type through scaffold.sh then
# asserts verify passes the well-formed scaffold and fails a deliberately
# broken one.
#
# peers: verify.sh, scaffold.sh

set -euo pipefail

# Home isolation. Anything the linters this exercises write under $HOME (a
# telemetry log, say) would count a test fixture as a real firing, and the
# hook-wiring cases read harness manifests under $HOME — so HOME moves to a
# throwaway path. check-skills.sh (which the skill branch delegates to) finds
# the published validator on PATH or under the REAL home, else uses its
# built-in reading; resolve it the same way and pin it before HOME moves.
if [[ -z "${SKILLS_REF_BIN:-}" ]]; then
  if command -v agentskills >/dev/null 2>&1; then
    SKILLS_REF_BIN="$(command -v agentskills)"
  elif [[ -x "$HOME/.local/lib/quality/skills-ref/bin/agentskills" ]]; then
    SKILLS_REF_BIN="$HOME/.local/lib/quality/skills-ref/bin/agentskills"
  else
    SKILLS_REF_BIN="builtin"
  fi
fi
export SKILLS_REF_BIN
export HOME="${TMPDIR:-/tmp}/claude-hook-test-home"
mkdir -p "$HOME/.local/share"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$SCRIPT_DIR/verify.sh"
SCAFFOLD="$SCRIPT_DIR/scaffold.sh"
# A scaffolded skill lands under `<workbench>/.agents/skills/`. Skill cases run
# against a throwaway SKILLS_ROOT — without it they would scaffold into the live
# tree and lean on the cleanup trap to take it back out. REPO_ROOT is asked of
# git, and governs the hook/agent cases, which write into a repo.
SKILLS_ROOT="$(mktemp -d -t author-skills-XXXXXX)"
export SKILLS_ROOT
# REPO_ROOT is a THROWAWAY workbench, not a live checkout. Pointing it at the
# real one would make every hook/agent case write a file into the working tree
# and lean on the cleanup trap to take it out again, so the cases run somewhere
# disposable.
REPO_ROOT="$(mktemp -d -t author-repo-XXXXXX)"
mkdir -p "$REPO_ROOT/.agents/hooks" "$REPO_ROOT/.agents/checks" "$REPO_ROOT/.agents/agents"
# scaffold.sh resolves its write root through session-write-root.sh, which in a
# live session answers with that session's worktree. Pin it, or the hook/agent
# cases below scaffold into the real checkout and this suite dies on the first
# one under `set -e`.
export CONTEXT_WRITE_ROOT="$REPO_ROOT"

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
  [[ -n "${SKILLS_ROOT:-}" ]] && rm -rf "${SKILLS_ROOT:?}"
  [[ -n "${REPO_ROOT:-}" && "$REPO_ROOT" == */author-repo-* ]] && rm -rf "${REPO_ROOT:?}"
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
  # Absolute path: the skill branch of scaffold.sh prints one (SKILLS_ROOT need
  # not sit under the write root), unlike the hook/agent branches below.
  path=$("$SCAFFOLD" skill "$name" 2>/dev/null)
  rc=$(verify_rc skill "$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "skill-ok" "expected pass; got $rc"; return; }
  assert_pass "skill scaffold verifies"
}

# ── Case 3: agent round-trip → verify passes; broken agent → fails ──
case_agent() {
  local name="zz-verify-test-agent" path rc
  CLEANUP+=(".agents/agents/$name.md")
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
  CLEANUP+=(".agents/hooks/$name.sh")
  path=$("$SCAFFOLD" hook "$name" 2>/dev/null)
  rc=$(verify_rc hook "$REPO_ROOT/$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-ok" "expected pass; got $rc"; return; }
  # Break it: remove `set -euo pipefail`.
  grep -v '^set -euo pipefail' "$REPO_ROOT/$path" > "$REPO_ROOT/$path.tmp" && mv "$REPO_ROOT/$path.tmp" "$REPO_ROOT/$path"
  rc=$(verify_rc hook "$REPO_ROOT/$path")
  [[ "$rc" -ne 0 ]] || { assert_fail "hook-broken" "expected fail on missing safe-mode"; return; }
  assert_pass "hook ok-then-missing-safemode"
}

# ── Principle gates (SKILL.md § The four principles) — each must FAIL a violating artifact ──

write_skill() {
  # write_skill <name> <description> <body-line-count>
  local name="$1" desc="$2" lines="$3" dir
  dir="$SKILLS_ROOT/$name"
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

# P1/P2: description over the 1,024-char cap (the Agent Skills spec's) → FAIL;
# at the cap → no cap error.
case_desc_cap() {
  local name="zz-verify-desccap" big out
  big=$(printf 'x%.0s' $(seq 1 1025))
  write_skill "$name" "$big" 5
  local rc; rc=$(verify_rc skill "$SKILLS_ROOT/$name/SKILL.md")
  [[ "$rc" -ne 0 ]] || { assert_fail "desc-cap" "1025-char description should fail"; return; }
  big=$(printf 'x%.0s' $(seq 1 1024))
  write_skill "$name" "$big" 5
  out=$(verify_out skill "$SKILLS_ROOT/$name/SKILL.md")
  grep -qi "exceeds\|description is" <<<"$out" && { assert_fail "desc-cap" "1024-char description should pass the cap gate: $out"; return; }
  assert_pass "desc-cap 1025-fails 1024-ok"
}

# P1: first-person description → FAIL.
case_first_person() {
  local name="zz-verify-fp" out
  write_skill "$name" "I scaffold artifacts when you ask me to." 5
  out=$(verify_out skill "$SKILLS_ROOT/$name/SKILL.md")
  grep -q "first-person" <<<"$out" || { assert_fail "first-person" "first-person description should fail"; return; }
  assert_pass "first-person rejected"
}

# P2/P4: an agent description longer than one sentence → FAIL; a one-sentence
# description carrying dotted names, an abbreviation and a decimal must NOT
# read as several (those dots are not sentence ends). Skills are exempt: the
# spec folds "when to use it" into the description, so a skill's is at least
# two sentences, and its length is the only cap.
case_desc_one_sentence() {
  local name="zz-verify-onesentence" out rc
  write_skill "$name" "Scaffolds a thing for the repo. Use it when authoring one." 600
  rc=$(verify_rc skill "$SKILLS_ROOT/$name/SKILL.md")
  [[ "$rc" -eq 0 ]] || { assert_fail "one-sentence" "a 600-line two-sentence skill should pass; got $rc: $(verify_out skill "$SKILLS_ROOT/$name/SKILL.md")"; return; }

  local agent="zz-verify-onesentence-agent"
  CLEANUP+=(".agents/agents/$agent.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs. Dispatched by /implement-audit.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n' "$agent" > "$REPO_ROOT/.agents/agents/$agent.md"
  out=$(verify_out agent "$REPO_ROOT/.agents/agents/$agent.md")
  grep -q "sentences" <<<"$out" || { assert_fail "one-sentence" "two-sentence agent description should fail"; return; }

  printf -- '---\nname: %s\ndescription: Reviews diffs when /implement-audit dispatches it.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n' "$agent" > "$REPO_ROOT/.agents/agents/$agent.md"
  rc=$(verify_rc agent "$REPO_ROOT/.agents/agents/$agent.md")
  [[ "$rc" -eq 0 ]] || { assert_fail "one-sentence" "one-sentence agent description should pass; got $rc"; return; }
  assert_pass "one-sentence enforced for agents only; a long two-sentence skill passes"
}

# A skill frontmatter key outside the Agent Skills spec's six is refused by
# check-skills.sh (the published validator), which verify delegates to; the
# retired repo keys are the case that matters. An agent's misspelled key is
# silently ignored at load, so the guard stays for agents.
case_unknown_keys() {
  local name="zz-verify-unknownkey" dir out
  dir="$SKILLS_ROOT/$name"; mkdir -p "$dir"
  write_skill_fm() {
    { echo "---"; echo "name: $name"; echo "description: Scaffolds a thing."; \
      printf '%s\n' "$@"; echo "---"; echo "# $name"; echo body; } > "$dir/SKILL.md"
  }

  write_skill_fm "steps:" "  - id: one"
  out=$(verify_out skill "$dir/SKILL.md")
  grep -q "Unexpected fields in frontmatter: steps" <<<"$out" || { assert_fail "unknown-keys" "\`steps:\` should fail through check-skills.sh: $out"; return; }

  write_skill_fm "allowed-tools: Bash Read" "metadata:" "  peers: \"scripts/x.sh\""
  out=$(verify_out skill "$dir/SKILL.md")
  grep -q "Unexpected fields\|FAIL" <<<"$out" && { assert_fail "unknown-keys" "the spec's fields must pass: $out"; return; }

  local agent="zz-verify-unknownkey-agent"
  CLEANUP+=(".agents/agents/$agent.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs.\nmodel: inherit\ntools:\n  - Read\npeers: []\nallowed-tools: Read\n---\nbody\n' "$agent" > "$REPO_ROOT/.agents/agents/$agent.md"
  out=$(verify_out agent "$REPO_ROOT/.agents/agents/$agent.md")
  grep -q "unknown frontmatter key" <<<"$out" || { assert_fail "unknown-keys" "\`allowed-tools:\` on an agent should be flagged"; return; }
  assert_pass "retired skill keys refused via check-skills.sh; agent unknown keys flagged"
}

# P1: top-level hook using exit 1 → FAIL; checks/ hook using exit 1 → PASS.
case_hook_placement() {
  local top="zz-verify-hooktop" out
  CLEANUP+=(".agents/hooks/$top.sh")
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n' > "$REPO_ROOT/.agents/hooks/$top.sh"
  out=$(verify_out hook "$REPO_ROOT/.agents/hooks/$top.sh")
  grep -q "NON-blocking" <<<"$out" || { assert_fail "hook-placement" "top-level exit 1 should fail"; return; }
  grep -q ".agents/checks" <<<"$out" || { assert_fail "hook-placement" "the flag must name where a check belongs: $out"; return; }
  local chk="zz-verify-hookchk" path rc
  CLEANUP+=(".agents/checks/$chk.sh" ".agents/checks/$chk.test.sh")
  path=$("$SCAFFOLD" hook "$chk" checks 2>/dev/null)
  [[ "$path" == .agents/checks/* ]] || { assert_fail "hook-placement" "scaffold put the check at $path"; return; }
  rc=$(verify_rc hook "$REPO_ROOT/$path")
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-placement" "a toolchain check's exit 1 should pass; got $rc"; return; }
  assert_pass "hook-placement top-exit1-fails checks-ok"
}

# P1/P2: agent with empty allowed-tools → FAIL.
case_agent_tools() {
  local name="zz-verify-agenttools" out
  CLEANUP+=(".agents/agents/$name.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs.\nmodel: inherit\ntools: []\npeers: []\n---\nbody\n' "$name" > "$REPO_ROOT/.agents/agents/$name.md"
  out=$(verify_out agent "$REPO_ROOT/.agents/agents/$name.md")
  grep -q "tools is empty" <<<"$out" || { assert_fail "agent-tools" "empty allowed-tools should fail"; return; }
  assert_pass "agent-tools empty-rejected"
}

# ── Adversarial-review hardening (probe/code-reviewer findings) ──

# Finding 1: a folded/block-scalar description must NOT bypass the cap or the
# first-person scan (frontmatter_value now folds continuation lines).
case_desc_folded() {
  local name="zz-verify-folded" dir out
  dir="$SKILLS_ROOT/$name"; mkdir -p "$dir"
  { echo "---"; echo "name: $name"; echo "description: >"; \
    printf '  %s\n' "$(printf 'x%.0s' $(seq 1 1600))"; \
    echo "---"; echo "# $name"; echo body; } > "$dir/SKILL.md"
  out=$(verify_out skill "$dir/SKILL.md")
  grep -qi "description is\|exceeds" <<<"$out" || { assert_fail "desc-folded" "folded 1600-char description should fail the cap: $out"; return; }
  assert_pass "desc-folded cap not bypassed"
}

# Finding 2: first-person markers beyond standalone "I" are caught.
case_first_person_words() {
  local name="zz-verify-fpw" out
  write_skill "$name" "My job is to scaffold things for the repo." 5
  out=$(verify_out skill "$SKILLS_ROOT/$name/SKILL.md")
  grep -q "first-person" <<<"$out" || { assert_fail "fp-words" "'My job' should be flagged first-person"; return; }
  assert_pass "first-person my/we caught"
}

# Finding 3: a top-level hook that blocks via exit 1 inside a helper fn is caught.
case_hook_exit1_indirect() {
  local name="zz-verify-hookind" out
  CLEANUP+=(".agents/hooks/$name.sh")
  printf '#!/usr/bin/env bash\nset -euo pipefail\nblock() { exit 1; }\nblock\n' > "$REPO_ROOT/.agents/hooks/$name.sh"
  out=$(verify_out hook "$REPO_ROOT/.agents/hooks/$name.sh")
  grep -q "NON-blocking" <<<"$out" || { assert_fail "hook-indirect" "exit 1 inside a fn should be flagged"; return; }
  assert_pass "hook exit1-via-fn caught"
}

# Finding 4: a block-style `tools:` list is non-empty (no false positive).
case_agent_tools_block() {
  local name="zz-verify-tblock" rc
  CLEANUP+=(".agents/agents/$name.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs.\nmodel: inherit\ntools:\n  - Read\n  - Grep\npeers: []\n---\nbody\n' "$name" > "$REPO_ROOT/.agents/agents/$name.md"
  rc=$(verify_rc agent "$REPO_ROOT/.agents/agents/$name.md")
  [[ "$rc" -eq 0 ]] || { assert_fail "tools-block" "block-style tools: should pass; got $rc"; return; }
  assert_pass "block-style tools accepted"
}

# Finding 5: an external https .md URL in a reference is NOT a second-hop; a
# local .md link IS.
case_ref_url_vs_local() {
  local name="zz-verify-refs" dir out
  dir="$SKILLS_ROOT/$name"; mkdir -p "$dir/references"
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

# ── The wiring check depends on finding the WORKBENCH ──
# `verify.sh` climbs `../../../..` from its own real directory
# (`<workbench>/.agents/skills/author/scripts/`) to find it, and that climb
# answers first whenever the script sits in an installed workbench. The
# fallback rungs are CLAUDE_PROJECT_DIR and `git rev-parse`, each PROVEN by
# `.agents/skills/` before it is accepted. To exercise the fallbacks this case
# runs a COPY of the scripts folder from a scratch dir laid out like the
# template repo (`templates/agents/skills/author/scripts/`), where the climb
# lands on a directory that is no workbench at all.
#
# Both directions are asserted. With a resolvable root the wiring answer is a
# real reading: a TOP-LEVEL hook fires from nothing until a hook manifest names
# it — Claude Code's ~/.claude/settings.json, Codex's ~/.codex/hooks.json, or
# the workbench's .agents/hooks.json (Antigravity) — so verify.sh WARNs
# (non-blocking) when none does; with no workbench root it says it could not
# look rather than claiming "not wired" about a file it never opened. A check
# under .agents/checks/ gets no wiring claim at all: nothing dispatches a new
# check on its own, and a WARN against a dispatcher that does not exist would
# report every check unwired.
case_hook_wiring() {
  local name="zz-verify-wiring" path out rc=0 fake fakehome iso VERIFY
  iso=$(mktemp -d)
  mkdir -p "$iso/templates/agents/skills/author"
  cp -r "$SCRIPT_DIR" "$iso/templates/agents/skills/author/scripts"
  VERIFY="$iso/templates/agents/skills/author/scripts/verify.sh"
  CLEANUP+=(".agents/hooks/$name.sh")
  path=$("$SCAFFOLD" hook "$name" 2>/dev/null)

  # Workbench-shaped, or resolve_repo_root will not take it as the workbench.
  # An empty home, so the only manifest that can answer is the one named.
  fake=$(mktemp -d)
  fakehome=$(mktemp -d)
  mkdir -p "$fake/.agents/skills"
  printf '{"hooks":{"PreToolUse":[{"command":"%s.sh"}]}}\n' "$name" > "$fake/.agents/hooks.json"
  out=$(HOME="$fakehome" CLAUDE_PROJECT_DIR="$fake" "$VERIFY" hook "$REPO_ROOT/$path" 2>&1) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-wiring" "wired hook should verify clean; got $rc: $out"; rm -rf "$fake" "$fakehome"; return; }
  grep -q "not wired" <<<"$out" && { assert_fail "hook-wiring" "hook wired in .agents/hooks.json reported unwired: $out"; rm -rf "$fake" "$fakehome"; return; }

  # Wired for Claude Code only: ~/.claude/settings.json names it.
  printf '{"hooks":{}}\n' > "$fake/.agents/hooks.json"
  mkdir -p "$fakehome/.claude"
  printf '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"/wb/.agents/hooks/%s.sh"}]}]}}\n' "$name" > "$fakehome/.claude/settings.json"
  rc=0
  out=$(HOME="$fakehome" CLAUDE_PROJECT_DIR="$fake" "$VERIFY" hook "$REPO_ROOT/$path" 2>&1) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-wiring" "wired hook should verify clean; got $rc: $out"; rm -rf "$fake" "$fakehome"; return; }
  grep -q "not wired" <<<"$out" && { assert_fail "hook-wiring" "hook wired in ~/.claude/settings.json reported unwired: $out"; rm -rf "$fake" "$fakehome"; return; }
  rm -f "$fakehome/.claude/settings.json"

  rc=0
  out=$(HOME="$fakehome" CLAUDE_PROJECT_DIR="$fake" "$VERIFY" hook "$REPO_ROOT/$path" 2>&1) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-wiring" "the wiring WARN must not block; got $rc: $out"; rm -rf "$fake" "$fakehome"; return; }
  grep -q "not wired" <<<"$out" || { assert_fail "hook-wiring" "unwired top-level hook should WARN: $out"; rm -rf "$fake" "$fakehome"; return; }

  # A check gets no wiring claim, wired or not.
  local chk="zz-verify-wiring-chk" cpath
  CLEANUP+=(".agents/checks/$chk.sh" ".agents/checks/$chk.test.sh")
  cpath=$("$SCAFFOLD" hook "$chk" checks 2>/dev/null)
  rc=0
  out=$(HOME="$fakehome" CLAUDE_PROJECT_DIR="$fake" "$VERIFY" hook "$REPO_ROOT/$cpath" 2>&1) || rc=$?
  rm -rf "$fake"
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-wiring" "a check should verify clean; got $rc: $out"; rm -rf "$fakehome"; return; }
  grep -qi "wired" <<<"$out" && { assert_fail "hook-wiring" "a check must get no wiring claim: $out"; rm -rf "$fakehome"; return; }

  # No rung can answer: not a workbench, CLAUDE_PROJECT_DIR empty, cwd `/`.
  rc=0
  out=$(cd / && HOME="$fakehome" CLAUDE_PROJECT_DIR="" "$VERIFY" hook "$REPO_ROOT/$path" 2>&1) || rc=$?
  rm -rf "$iso" "$fakehome"
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-wiring" "expected exit 0 with no workbench root; got $rc: $out"; return; }
  grep -q "could not find the workbench" <<<"$out" \
    || { assert_fail "hook-wiring" "unresolved root should say so, not 'not wired': $out"; return; }
  assert_pass "hook-wiring top-level-warns check-silent root-unresolved-says-so"
}

# The climb rung on its own: a copy installed at
# <workbench>/.agents/skills/author/scripts, invoked through a home link the
# way a harness invokes it (~/.agents/skills → <workbench>/.agents/skills),
# finds its workbench four levels up the REAL path with no other help —
# CLAUDE_PROJECT_DIR empty, cwd outside every repo — and reads that
# workbench's manifest.
case_hook_wiring_climb() {
  local name="zz-verify-wiring-climb" path out rc=0 wb fakehome VERIFY
  wb=$(mktemp -d)
  fakehome=$(mktemp -d)
  mkdir -p "$wb/.agents/skills/author" "$fakehome/.agents"
  cp -r "$SCRIPT_DIR" "$wb/.agents/skills/author/scripts"
  ln -s "$wb/.agents/skills" "$fakehome/.agents/skills"
  VERIFY="$fakehome/.agents/skills/author/scripts/verify.sh"
  CLEANUP+=(".agents/hooks/$name.sh")
  path=$("$SCAFFOLD" hook "$name" 2>/dev/null)
  printf '{"hooks":{"PreToolUse":[{"command":"%s.sh"}]}}\n' "$name" > "$wb/.agents/hooks.json"
  out=$(cd / && HOME="$fakehome" CLAUDE_PROJECT_DIR="" "$VERIFY" hook "$REPO_ROOT/$path" 2>&1) || rc=$?
  rm -rf "$wb" "$fakehome"
  [[ "$rc" -eq 0 ]] || { assert_fail "hook-wiring-climb" "expected exit 0; got $rc: $out"; return; }
  grep -q "WARN" <<<"$out" && { assert_fail "hook-wiring-climb" "the climb should find the workbench and its manifest: $out"; return; }
  assert_pass "hook-wiring climb finds the installed workbench through a home link"
}

# The dots that are not sentence ends — an abbreviation, a dotted filename, a
# decimal — must not split a one-sentence agent description.
case_desc_dots_not_sentences() {
  local agent="zz-verify-dots-agent" rc
  CLEANUP+=(".agents/agents/$agent.md")
  printf -- '---\nname: %s\ndescription: Reviews diffs (e.g. a SKILL.md edit or a 1.5 MB fixture) when /implement-audit dispatches it.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n' "$agent" > "$REPO_ROOT/.agents/agents/$agent.md"
  rc=$(verify_rc agent "$REPO_ROOT/.agents/agents/$agent.md")
  [[ "$rc" -eq 0 ]] || { assert_fail "dots-not-sentences" "one sentence with e.g./SKILL.md/1.5 should pass; got $rc: $(verify_out agent "$REPO_ROOT/.agents/agents/$agent.md")"; return; }
  assert_pass "abbreviation, dotted name and decimal are one sentence"
}

# The YAML gate needs PyYAML. A python3 without it (the stock macOS one) must
# not fail a well-formed agent on the ImportError; where PyYAML is present the
# gate still catches a value holding an unquoted `: `.
case_agent_yaml_gate() {
  local agent="zz-verify-yaml-agent" stub rc out
  CLEANUP+=(".agents/agents/$agent.md")
  stub=$(mktemp -d)
  printf '#!/bin/sh\necho "ModuleNotFoundError: No module named yaml" >&2\nexit 1\n' > "$stub/python3"
  chmod +x "$stub/python3"
  printf -- '---\nname: %s\ndescription: Reviews diffs.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n' "$agent" > "$REPO_ROOT/.agents/agents/$agent.md"
  rc=0
  out=$(PATH="$stub:$PATH" "$VERIFY" agent "$REPO_ROOT/.agents/agents/$agent.md" 2>&1) || rc=$?
  rm -rf "$stub"
  [[ "$rc" -eq 0 ]] || { assert_fail "yaml-gate" "a python3 without PyYAML failed a well-formed agent; got $rc: $out"; return; }
  if python3 -c 'import yaml' >/dev/null 2>&1; then
    printf -- '---\nname: %s\ndescription: Different job: reviews diffs.\nmodel: inherit\ntools:\n  - Read\npeers: []\n---\nbody\n' "$agent" > "$REPO_ROOT/.agents/agents/$agent.md"
    out=$(verify_out agent "$REPO_ROOT/.agents/agents/$agent.md")
    grep -q "does not parse as YAML" <<<"$out" || { assert_fail "yaml-gate" "an unquoted ': ' should fail the YAML gate: $out"; return; }
    assert_pass "yaml-gate skips without PyYAML, catches ': ' with it"
  else
    assert_pass "yaml-gate skips without PyYAML (no PyYAML here to prove the catch)"
  fi
}

# ── An agent's YAML is checked even where PyYAML is not installed ──
# A python3 without PyYAML (macOS's stock one) must neither pass malformed
# frontmatter nor fail a well-formed one: the fallback check catches the
# failure that matters — an unquoted value holding `: `.
case_agent_yaml_without_pyyaml() {
  local name="zz-verify-nopyyaml-agent" path out nopy
  nopy="$(mktemp -d)"
  printf '#!/bin/sh\necho "ModuleNotFoundError: No module named yaml" >&2\nexit 1\n' >"$nopy/python3"
  chmod +x "$nopy/python3"
  CLEANUP+=(".agents/agents/$name.md")
  path=$("$SCAFFOLD" agent "$name" 2>/dev/null)
  out=$(PATH="$nopy:$PATH" verify_out agent "$REPO_ROOT/$path")
  if grep -q "does not parse as YAML" <<<"$out"; then
    assert_fail "agent-yaml-nopyyaml" "a well-formed agent was flagged without PyYAML: $out"; rm -rf "$nopy"; return
  fi
  sed 's/^description: .*/description: Different job: the reviewer reads code./' "$REPO_ROOT/$path" >"$REPO_ROOT/$path.tmp" && mv "$REPO_ROOT/$path.tmp" "$REPO_ROOT/$path"
  out=$(PATH="$nopy:$PATH" verify_out agent "$REPO_ROOT/$path")
  rm -rf "$nopy"
  grep -q "does not parse as YAML" <<<"$out" \
    || { assert_fail "agent-yaml-nopyyaml" "an unquoted ': ' passed without PyYAML: $out"; return; }
  assert_pass "agent-yaml checked without PyYAML"
}

case_usage
case_output_style
case_skill_ok
case_agent
case_hook
case_desc_cap
case_first_person
case_desc_one_sentence
case_unknown_keys
case_hook_placement
case_agent_tools
case_desc_folded
case_first_person_words
case_hook_exit1_indirect
case_agent_tools_block
case_ref_url_vs_local
case_hook_wiring
case_hook_wiring_climb
case_desc_dots_not_sentences
case_agent_yaml_gate
case_agent_yaml_without_pyyaml

echo
echo "verify.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
