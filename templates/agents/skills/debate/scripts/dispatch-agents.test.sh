#!/usr/bin/env bash
# Test harness for dispatch-agents.sh — three seats (Claude, Codex, Grok), one
# prompt each, and the stand-in rules that keep a debate at three positions. The
# panel-row CLIs (claude / codex / grok) are stubbed via a per-test PATH so we
# don't touch real binaries. `jq` is on the tight PATH because the script reads
# the policy through it.
#
# EVERY case pins a FIXTURE panel through DEBATE_POLICY_JSON: the stubs are
# named `claude`, `codex` and `grok` right here, so reading the shipped table
# would turn a legitimate policy change into red cases that test nothing.
# Cases 7 and 8 are the ones that find the policy file themselves, and they are
# about that lookup and nothing else.
#
# peers: dispatch-agents.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch-agents.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

make_tight_path() {
  local d="$1"
  # jq is required: the script reads the panel row out of policy.json with it.
  for bin in bash sleep grep echo head wc date mktemp printf cat dirname \
             basename tail sed awk timeout chmod rm ls env yes find sort jq; do
    if command -v "$bin" >/dev/null 2>&1; then
      ln -sf "$(command -v "$bin")" "$d/$bin"
    fi
  done
}

# Build stub CLI: $1=dir, $2=name, $3=exit, $4=sleep, $5=stdout
mkstub() {
  local dir="$1" name="$2" code="$3" sleep_s="$4" msg="$5"
  cat > "$dir/$name" <<EOF
#!/usr/bin/env bash
sleep $sleep_s
printf '%s\n' "$msg"
exit $code
EOF
  chmod +x "$dir/$name"
}

# The fixture panel: three vendors whose names match the stubs above. Shape mirrors
# .agents/skills/review/policy.json; content is pinned so a change there cannot
# redden this file.
POLICY_JSON_BODY='{"rows":{"panel":{"voices":[{"vendor":"claude","model":"opus","tracks":"opus[1m]"},
                            {"vendor":"codex","model":"codex","tracks":"gpt-{v}-sol"},
                            {"vendor":"grok","model":"grok","tracks":"grok-{v}"}]}}}'

make_policy() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$POLICY_JSON_BODY" > "$path"
}

make_prompts_dir() {
  local n="$1"
  local d
  d=$(mktemp -d)
  case "$n" in
    2) printf 'role1 prompt body\n' > "$d/role1.prompt"
       printf 'role2 prompt body\n' > "$d/role2.prompt" ;;
    3) printf 'role1\n' > "$d/role1.prompt"
       printf 'role2\n' > "$d/role2.prompt"
       printf 'role3\n' > "$d/role3.prompt" ;;
  esac
  printf '%s' "$d"
}

# `env -i` wipes the environment, so the two seams the script reads —
# DEBATE_POLICY_JSON and DEBATE_RESOLVER — have to be forwarded explicitly.
# DEBATE_POLICY_JSON defaults to the shared fixture panel, so no case depends on
# the shipped table. The default is `-` and not `:-` because cases 7 and 8 set
# the seam to the EMPTY string deliberately, to make the script find a policy
# path of its own; `:-` reads empty as unset and would hand them the fixture,
# passing both without exercising the lookup.
# The model resolver, stubbed: a resolver a user keeps of their own would read
# each CLI's catalog, and these CLIs are stubs. It resolves the fixture
# families to fixed ids and fails `unresolvable-{v}`. A case that sets
# DEBATE_RESOLVER="" gets the script's own identity rule instead.
RESOLVER_STUB="$(mktemp -d)/resolve-model.sh"
cat > "$RESOLVER_STUB" <<'RESOLVER'
#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
RESOLVER
chmod +x "$RESOLVER_STUB"

SHARED_POLICY=""
# A copy of the script in a scratch skills tree, so the policy it finds beside
# the review skill is whatever the case puts there.
isolated_script() {
  local iso
  iso=$(mktemp -d)
  mkdir -p "$iso/skills/debate/scripts"
  cp "$SCRIPT" "$iso/skills/debate/scripts/dispatch-agents.sh"
  echo "$iso/skills/debate/scripts/dispatch-agents.sh"
}

run_script() {
  local stubs="$1"; shift
  local rc=0 out
  if [[ -z "$SHARED_POLICY" ]]; then
    SHARED_POLICY="$(mktemp -d)/policy.json"
    make_policy "$SHARED_POLICY"
  fi
  out=$(env -i PATH="$stubs" HOME=/tmp \
    DEBATE_RESOLVER="${DEBATE_RESOLVER-$RESOLVER_STUB}" \
    DEBATE_POLICY_JSON="${DEBATE_POLICY_JSON-$SHARED_POLICY}" "$SCRIPT" "$@" 2>&1) || rc=$?
  printf '%s\n---RC=%s\n' "$out" "$rc"
}

# ── Case 1: no CLI on PATH → every seat is a gap naming it, exit non-zero ──
case1() {
  local stubs pdir out rc
  stubs=$(mktemp -d); make_tight_path "$stubs"
  pdir=$(make_prompts_dir 3)
  # No claude/codex/grok stubs
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case1" "expected non-zero; got $rc"; return; }
  echo "$out" | grep -q "CLI not found" || { assert_fail "case1" "missing CLI-not-found msg"; return; }
  assert_pass "case1 missing-cli-fails-loud"
}

# ── Case 2: all agents succeed → per-role .output files, exit 0 ──
case2() {
  local stubs pdir out rc dir
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 0 "codex says Y"
  mkstub "$stubs" grok   0 0 "grok says Z"
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case2" "expected 0; got $rc: $out"; return; }
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  local n
  n=$(find "$dir" -name '*.output' | wc -l)
  [[ "$n" -eq 3 ]] || { assert_fail "case2" "expected 3 .output files; got $n"; return; }
  assert_pass "case2 all-agents-succeed"
}

# ── Case 3: Codex times out → Claude stands in for its seat; three positions, no gap ──
case3() {
  local stubs pdir out rc dir
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 5 "slow"  # exceeds timeout=2
  mkstub "$stubs" grok   0 0 "grok says Z"
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 2)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case3" "expected 0 (partial success); got $rc: $out"; return; }
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  local gaps outs
  gaps=$(find "$dir" -name '*.gap' | wc -l)
  outs=$(find "$dir" -name '*.output' | wc -l)
  [[ "$gaps" -eq 0 && "$outs" -eq 3 ]] || { assert_fail "case3" "expected 0 gaps + 3 outs; got $gaps + $outs"; return; }
  grep -qx "claude says X" "$dir/role2.output" || { assert_fail "case3" "Codex's seat was not argued by Claude: $(cat "$dir/role2.output")"; return; }
  grep -q "^claude opus\[1m\] — stood in for codex (timeout" "$dir/role2.voice" \
    || { assert_fail "case3" "the stand-in is not recorded: $(cat "$dir/role2.voice")"; return; }
  echo "$out" | grep -q "codex failed (timeout after 2s (codex)); claude stands in" \
    || { assert_fail "case3" "the stand-in is not announced: $out"; return; }
  assert_pass "case3 codex-times-out-claude-doubles"
}

# ── Case 4: ALL agents fail → exit non-zero, .gap for each ──
case4() {
  local stubs pdir out rc dir
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 1 0 "x"
  mkstub "$stubs" codex  1 0 "x"
  mkstub "$stubs" grok   1 0 "x"
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case4" "expected non-zero on all-fail; got $rc"; return; }
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  local gaps
  gaps=$(find "$dir" -name '*.gap' | wc -l)
  [[ "$gaps" -eq 3 ]] || { assert_fail "case4" "expected 3 gaps; got $gaps"; return; }
  assert_pass "case4 all-fail-nonzero-exit"
}

# ── Case 5: --prompts-dir empty (zero .prompt files) → fail loud ──
case5() {
  local stubs pdir out rc
  stubs=$(mktemp -d); make_tight_path "$stubs"
  pdir=$(mktemp -d)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case5" "expected non-zero on empty prompts dir"; return; }
  echo "$out" | grep -q "holds no .prompt files" || { assert_fail "case5" "missing count msg: $out"; return; }
  assert_pass "case5 empty-prompts-dir-rejected"
}

# ── Case 6: the grok agent is invoked with --verbatim ──
# Without it the CLI truncates a long prompt and offloads the remainder to a
# file it tells the model to read, so the reply comes back as agent narration
# rather than the argument this script dispatched for.
# Pinned to a FIXTURE panel row rather than the shipped table: this case is
# about the grok branch's flag shape, which stays correct (and testable)
# whether or not the policy happens to seat grok on the panel.
case6() {
  local stubs pdir argv pol
  stubs=$(mktemp -d); make_tight_path "$stubs"
  argv="$stubs/grok-argv.txt"
  pol="$stubs/policy.json"
  # A three-vendor panel mirroring the shape the script expects, pinned rather
  # than read from the shipped table — so this case keeps testing the grok
  # branch through a reassignment.
  make_policy "$pol"
  cat > "$stubs/grok" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$argv"
printf 'grok says Z\n'
EOF
  chmod +x "$stubs/grok"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 0 "codex says Y"
  pdir=$(make_prompts_dir 3)
  DEBATE_POLICY_JSON="$pol" \
    run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5 >/dev/null
  if [[ ! -f "$argv" ]]; then
    assert_fail "case6" "grok stub was never invoked under the fixture panel"
    return
  fi
  if grep -qx -- "--verbatim" "$argv"; then
    assert_pass "case6 grok-invoked-with-verbatim"
  else
    assert_fail "case6" "grok argv lacks --verbatim: $(tr '\n' ' ' < "$argv")"
  fi
  # A debate voice is prompt-in/answer-out, and `dontAsk` was measured
  # cancelling that shape at turn 1, against never under bypassPermissions.
  # The mode and a NON-EMPTY allowlist are one change: bypassPermissions ignores
  # --disallowed-tools, and `--tools ''` granted a file write and a shell
  # command.
  local flat
  flat="$(tr '\n' ' ' < "$argv")"
  if grep -qx -- "dontAsk" "$argv"; then
    assert_fail "case6c" "dontAsk cancels answer-only runs: $flat"
  else
    assert_pass "case6c grok-not-invoked-with-dontAsk"
  fi
  if grep -qx -- "bypassPermissions" "$argv"; then
    assert_pass "case6d grok-invoked-with-bypassPermissions"
  else
    assert_fail "case6d" "argv lacks bypassPermissions: $flat"
  fi
  if grep -qx -- "list_dir" "$argv"; then
    assert_pass "case6e grok-allowlist-is-non-empty"
  else
    assert_fail "case6e" "argv lacks a non-empty --tools: $flat"
  fi
  if grep -qx -- "--disallowed-tools" "$argv"; then
    assert_fail "case6f" "denylist is not enforced under this mode: $flat"
  else
    assert_pass "case6f grok-carries-no-unenforced-denylist"
  fi
  if grep -qx -- "--disable-web-search" "$argv"; then
    assert_pass "case6g grok-takes-no-web-hop"
  else
    assert_fail "case6g" "argv lacks --disable-web-search: $flat"
  fi
  # Planning is off on every grok call.
  if grep -qx -- "--no-plan" "$argv"; then
    assert_pass "case6b grok-invoked-with-no-plan"
  else
    assert_fail "case6b" "grok argv lacks --no-plan: $(tr '\n' ' ' < "$argv")"
  fi
  if grep -A1 -x -- "--reasoning-effort" "$argv" | tail -1 | grep -qx medium; then
    assert_pass "case6h grok-debate-uses-medium-effort"
  else
    assert_fail "case6h" "grok debate lacks medium effort: $flat"
  fi
  if grep -A1 -x -- "--system-prompt-override" "$argv" | tail -1 | grep -qx "Answer the user's message directly from its supplied context. Follow its requested output format exactly. Do not use tools or narrate."; then
    assert_pass "case6i grok-debate-answers-without-agent-loop"
  else
    assert_fail "case6i" "grok debate lacks completion instruction: $flat"
  fi
  # All three seats share the default ceiling. An explicit --timeout-s still
  # applies to all three (as above). The stub records the ceiling and runs the
  # command without one, so the case needs no real `timeout` on the host.
  local timeouts="$stubs/timeouts.txt"
  rm -f "$stubs/timeout"
  cat > "$stubs/timeout" <<EOF
#!/usr/bin/env bash
printf '%s:%s\n' "\$1" "\$2" >> "$timeouts"
shift
exec "\$@"
EOF
  chmod +x "$stubs/timeout"
  local default_out default_dir
  default_out=$(DEBATE_POLICY_JSON="$pol" run_script "$stubs" --prompts-dir "$pdir")
  default_dir=$(printf '%s\n' "$default_out" | sed -n 's/^output_dir=//p' | tail -1)
  if grep -qx '300s:grok' "$timeouts" && grep -qx '300s:claude' "$timeouts" && grep -qx '300s:codex' "$timeouts" \
     && [[ -s "$default_dir/role1.output" && -s "$default_dir/role2.output" && -s "$default_dir/role3.output" ]] \
     && [[ ! -e "$default_dir/role1.gap" && ! -e "$default_dir/role2.gap" && ! -e "$default_dir/role3.gap" ]]; then
    assert_pass "case6j every-default-ceiling-is-300s"
  else
    assert_fail "case6j" "default ceilings or outputs: $(tr '\n' ' ' < "$timeouts") $default_out"
  fi
}

# ── Case 7: the policy is found beside the review skill ──
# The script reads `../../review/policy.json` from its own directory
# (`.agents/skills/debate/scripts/` → `.agents/skills/review/policy.json`).
# Cases 7 and 8 run a COPY from a scratch skills tree, so the file there is the
# one under test.
#
# DEBATE_POLICY_JSON is deliberately EMPTY here: this case is about the script
# finding the policy on its own, which the seam would otherwise short-circuit.
case7() {
  local stubs pdir out rc fake
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 0 "codex says Y"
  mkstub "$stubs" grok   0 0 "grok says Z"
  pdir=$(make_prompts_dir 3)
  fake="$(isolated_script)"
  make_policy "$(dirname "$fake")/../../review/policy.json"
  out=$(DEBATE_POLICY_JSON="" \
    SCRIPT="$fake" run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case7" "expected 0; got $rc: $out"; return; }
  assert_pass "case7 policy-found-beside-review-skill"
}

# ── Case 8: no policy beside the review skill → fail loud, naming the path ──
# A missing table is reported with the path the script looked at, so the reader
# knows which install is incomplete.
case8() {
  local stubs pdir out rc
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 0 "codex says Y"
  mkstub "$stubs" grok   0 0 "grok says Z"
  pdir=$(make_prompts_dir 3)
  out=$(cd / && DEBATE_POLICY_JSON="" \
    SCRIPT="$(isolated_script)" run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case8" "expected non-zero with no policy file"; return; }
  echo "$out" | grep -q "policy.json not found at .*/skills/debate/scripts/../../review/policy.json" \
    || { assert_fail "case8" "missing the not-found message naming the path: $out"; return; }
  assert_pass "case8 missing-policy-fails-loud"
}

# ── Case 9: every CLI is told its voice's pinned model; an unpinned voice runs its CLI default ──
# A voice whose table names a model must run THAT model, not whatever its CLI
# ranks first; a voice whose table names none runs with no model flag at all.
case9() {
  local stubs pdir out rc argvdir v
  stubs=$(mktemp -d); make_tight_path "$stubs"; argvdir=$(mktemp -d)
  for v in claude codex grok; do
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/%s.argv"\necho "%s says hi"\n' "$argvdir" "$v" "$v" > "$stubs/$v"
    chmod +x "$stubs/$v"
  done
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case9" "expected 0; got $rc: $out"; return; }
  for pair in "claude:opus[1m]" codex:gpt-6-sol grok:grok-4.7; do
    v="${pair%%:*}"
    grep -B1 -Fx -- "${pair#*:}" "$argvdir/$v.argv" 2>/dev/null | head -1 | grep -qxE -- '-m|--model' \
      || { assert_fail "case9" "$v was not told ${pair#*:}: $(tr '\n' ' ' < "$argvdir/$v.argv" 2>/dev/null)"; return; }
  done

  # A voice with no model runs on its CLI's default: no model flag, its own
  # seat, and a .voice line that says so. One that will not resolve (a
  # resolver was given and failed) never runs: its seat fails and a stand-in
  # argues it.
  local unpinned pdir2 dir
  pdir2=$(make_prompts_dir 2)
  unpinned="$(mktemp -d)/policy.json"
  printf '%s\n' '{"rows":{"panel":{"voices":[{"vendor":"claude","model":"opus","tracks":"opus[1m]"},{"vendor":"codex","model":"codex"}]}}}' > "$unpinned"
  rm -f "$argvdir"/*.argv
  out=$(DEBATE_POLICY_JSON="$unpinned" run_script "$stubs" --prompts-dir "$pdir2" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case9" "an unpinned voice should run: $out"; return; }
  [[ -e "$argvdir/codex.argv" ]] || { assert_fail "case9" "the unpinned codex voice did not run: $out"; return; }
  grep -qxE -- '-m|--model' "$argvdir/codex.argv" \
    && { assert_fail "case9" "the unpinned codex voice was given a model flag: $(tr '\n' ' ' < "$argvdir/codex.argv")"; return; }
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  grep -qx "codex (default model)" "$dir/role2.voice" \
    || { assert_fail "case9" "the unpinned seat's voice line is wrong: $(cat "$dir/role2.voice" 2>/dev/null)"; return; }
  rm -f "$argvdir"/*.argv

  local unresolvable
  unresolvable="$(mktemp -d)/policy.json"
  printf '%s\n' '{"rows":{"panel":{"voices":[{"vendor":"claude","model":"opus","tracks":"opus[1m]"},{"vendor":"codex","model":"codex","tracks":"unresolvable-{v}"}]}}}' > "$unresolvable"
  out=$(DEBATE_POLICY_JSON="$unresolvable" run_script "$stubs" --prompts-dir "$pdir2" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case9" "an unresolvable voice's seat should be stood in for: $out"; return; }
  echo "$out" | grep -q "could not resolve unresolvable-{v}" || { assert_fail "case9" "missing the unresolved message: $out"; return; }
  [[ ! -e "$argvdir/codex.argv" ]] || { assert_fail "case9" "the unresolvable codex voice ran anyway"; return; }
  assert_pass "case9 every-voice-runs-its-resolved-model"
}

# Who argued each seat, from the stub each seat's output came from.
argued_by() {  # argued_by <output_dir> → "role1=claude role2=codex role3=grok"
  local d="$1" r line=""
  for r in role1 role2 role3; do
    if [[ -s "$d/$r.output" ]]; then line+="$r=$(head -n 1 "$d/$r.output" | cut -d' ' -f1) "; else line+="$r=GAP "; fi
  done
  printf '%s' "${line% }"
}

# ── Case 10: the stand-in rules, and the fallback when the first choice failed too ──
#   Claude fails → Codex doubles.  Grok fails → Claude doubles.  Codex fails → Claude doubles.
#   A stand-in must have answered its own seat, so the leftover voice is next.
case10() {
  local pdir expect row stubs out dir got
  pdir=$(make_prompts_dir 3)
  # failing vendors → expected seat owners (seats: role1 Claude, role2 Codex, role3 Grok)
  for row in "claude:role1=codex role2=codex role3=grok" \
             "grok:role1=claude role2=codex role3=claude" \
             "codex:role1=claude role2=claude role3=grok" \
             "claude codex:role1=grok role2=grok role3=grok" \
             "grok claude:role1=codex role2=codex role3=codex" \
             "codex grok:role1=claude role2=claude role3=claude"; do
    stubs=$(mktemp -d); make_tight_path "$stubs"
    for v in claude codex grok; do
      if [[ " ${row%%:*} " == *" $v "* ]]; then mkstub "$stubs" "$v" 1 0 "$v failed"; else mkstub "$stubs" "$v" 0 0 "$v says"; fi
    done
    out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
    dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
    got=$(argued_by "$dir")
    expect="${row#*:}"
    [[ "$got" == "$expect" ]] || { assert_fail "case10" "failing [${row%%:*}]: expected $expect; got $got"; return; }
  done
  assert_pass "case10 stand-in-rules"
}

# ── Case 11: --no-stand-in leaves a failed seat a gap (for a caller that needs each voice's own answer) ──
case11() {
  local stubs pdir out dir
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 0 0 "claude says"
  mkstub "$stubs" codex  1 0 "codex failed"
  mkstub "$stubs" grok   0 0 "grok says"
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5 --no-stand-in)
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  [[ "$(argued_by "$dir")" == "role1=claude role2=GAP role3=grok" ]] \
    || { assert_fail "case11" "expected Codex's seat to stay a gap; got $(argued_by "$dir")"; return; }
  [[ -s "$dir/role2.gap" && ! -e "$dir/role2.voice" ]] || { assert_fail "case11" "gap/voice files wrong"; return; }
  assert_pass "case11 no-stand-in-keeps-the-gap"
}

# ── Case 12: one prompt per seat — a count that does not match the panel is refused ──
case12() {
  local stubs pdir out rc
  stubs=$(mktemp -d); make_tight_path "$stubs"
  mkstub "$stubs" claude 0 0 "x"; mkstub "$stubs" codex 0 0 "x"; mkstub "$stubs" grok 0 0 "x"
  pdir=$(make_prompts_dir 2)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 2 ]] || { assert_fail "case12" "expected exit 2; got $rc"; return; }
  echo "$out" | grep -q "holds 2 prompt(s) but the panel has 3 voice(s)" || { assert_fail "case12" "missing msg: $out"; return; }
  assert_pass "case12 prompt-count-must-match-panel"
}

# ── Case 13: a stand-in that fails too leaves a gap carrying BOTH reasons ──
case13() {
  local stubs pdir out dir
  stubs=$(mktemp -d); make_tight_path "$stubs"
  # claude answers its own seat, then fails when it stands in: it fails only on
  # the second call.
  cat > "$stubs/claude" <<EOF
#!/usr/bin/env bash
if [[ -e "$stubs/claude.ran" ]]; then echo "second call broke" >&2; exit 3; fi
: > "$stubs/claude.ran"
echo "claude says"
EOF
  chmod +x "$stubs/claude"
  mkstub "$stubs" codex 0 0 "codex says"
  mkstub "$stubs" grok  1 0 "grok failed"
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  [[ -s "$dir/role3.gap" ]] || { assert_fail "case13" "Grok's seat should be a gap; got $(argued_by "$dir")"; return; }
  grep -q "stood in for grok (exit 1 (grok)); the stand-in failed too: exit 3 (claude)" "$dir/role3.gap" \
    || { assert_fail "case13" "gap lacks both reasons: $(cat "$dir/role3.gap")"; return; }
  assert_pass "case13 failed-stand-in-keeps-both-reasons"
}

# ── Case 14: with no resolver, `tracks` is the model, handed over verbatim ──
# There is no model catalog to consult; the table's string IS what the CLI is
# told.
case14() {
  local stubs pdir out rc argvdir v
  stubs=$(mktemp -d); make_tight_path "$stubs"; argvdir=$(mktemp -d)
  for v in claude codex grok; do
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/%s.argv"\necho "%s says hi"\n' "$argvdir" "$v" "$v" > "$stubs/$v"
    chmod +x "$stubs/$v"
  done
  pdir=$(make_prompts_dir 3)
  out=$(DEBATE_RESOLVER="" run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case14" "expected 0; got $rc: $out"; return; }
  for pair in "claude:opus[1m]" "codex:gpt-{v}-sol" "grok:grok-{v}"; do
    v="${pair%%:*}"
    grep -B1 -Fx -- "${pair#*:}" "$argvdir/$v.argv" 2>/dev/null | head -1 | grep -qxE -- '-m|--model' \
      || { assert_fail "case14" "$v was not told ${pair#*:} verbatim: $(tr '\n' ' ' < "$argvdir/$v.argv" 2>/dev/null)"; return; }
  done
  assert_pass "case14 tracks-passed-verbatim-without-resolver"
}

# ── Case 15: no `timeout` or `gtimeout` on PATH → the bash watchdog still times a seat out ──
# macOS ships neither; the seat must still end at the ceiling, as exit 124, so
# the stand-in and the gap text read exactly as they do with `timeout`.
case15() {
  local stubs pdir out rc dir
  stubs=$(mktemp -d); make_tight_path "$stubs"
  rm -f "$stubs/timeout" "$stubs/gtimeout"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 5 "slow"  # exceeds timeout=2
  mkstub "$stubs" grok   0 0 "grok says Z"
  pdir=$(make_prompts_dir 3)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 2)
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case15" "expected 0; got $rc: $out"; return; }
  dir=$(echo "$out" | grep -oE "output_dir=[^ ]+" | sed 's/output_dir=//')
  echo "$out" | grep -q "codex failed (timeout after 2s (codex)); claude stands in" \
    || { assert_fail "case15" "the watchdog did not report a timeout: $out"; return; }
  grep -qx "claude says X" "$dir/role2.output" \
    || { assert_fail "case15" "the timed-out seat was not stood in for: $(cat "$dir/role2.output" 2>/dev/null)"; return; }
  assert_pass "case15 watchdog-times-out-without-timeout-binary"
}

# ── Case 16: a CLI that IGNORES TERM, no timeout binary → the watchdog KILLs ──
# TERM alone would leave the debate waiting on it forever.
case16() {
  local stubs pdir out rc dir start elapsed
  stubs=$(mktemp -d); make_tight_path "$stubs"
  rm -f "$stubs/timeout" "$stubs/gtimeout"
  mkstub "$stubs" claude 0 0 "claude says X"
  cat > "$stubs/codex" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
exec sleep 30
EOF
  chmod +x "$stubs/codex"
  mkstub "$stubs" grok 0 0 "grok says Z"
  pdir=$(make_prompts_dir 3)
  start=$(date +%s)
  out=$(run_script "$stubs" --prompts-dir "$pdir" --timeout-s 2)
  elapsed=$(( $(date +%s) - start ))
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case16" "expected 0; got $rc: $out"; return; }
  [[ "$elapsed" -lt 15 ]] || { assert_fail "case16" "a TERM-ignoring CLI held the debate ${elapsed}s past a 2s timeout"; return; }
  echo "$out" | grep -q "codex failed (timeout after 2s (codex)); claude stands in" \
    || { assert_fail "case16" "the kill was not reported as a timeout: $out"; return; }
  assert_pass "case16 watchdog-kills-a-cli-that-ignores-term"
}

# ── Case 17: --research gives the grok seat read + search tools (Contextium) ──
# /explain's seats investigate a hypothesis: they must read repo files and may
# search the web, which a debate voice arguing from its prompt does not.
case17() {
  local stubs pdir argv flat
  stubs=$(mktemp -d); make_tight_path "$stubs"
  argv="$stubs/grok-argv.txt"
  cat > "$stubs/grok" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$argv"
printf 'grok says Z\n'
EOF
  chmod +x "$stubs/grok"
  mkstub "$stubs" claude 0 0 "claude says X"
  mkstub "$stubs" codex  0 0 "codex says Y"
  pdir=$(make_prompts_dir 3)
  run_script "$stubs" --prompts-dir "$pdir" --timeout-s 5 --research >/dev/null
  [[ -f "$argv" ]] || { assert_fail "case17" "grok never ran under --research"; return; }
  flat="$(tr '\n' ' ' < "$argv")"
  grep -A1 -x -- "--tools" "$argv" 2>/dev/null | tail -1 | grep -qx "read_file,list_dir,grep" \
    || { assert_fail "case17" "a research seat lacks read tools: $flat"; return; }
  if grep -qx -- "--disable-web-search" "$argv"; then
    assert_fail "case17" "a research seat cannot search the web: $flat"; return
  fi
  grep -qx -- "bypassPermissions" "$argv" \
    || { assert_fail "case17" "a research seat lost its permission mode: $flat"; return; }
  assert_pass "case17 research-seat-reads-and-searches"
}

case1
case2
case3
case4
case5
case6
case7
case8
case9
case10
case11
case12
case13
case14
case15
case16
case17

echo
echo "dispatch-agents.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
