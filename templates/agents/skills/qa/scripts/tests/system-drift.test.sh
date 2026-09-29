#!/usr/bin/env bash
# system-drift.test.sh — the design-drift counter, against hermetic fixtures.
#
# Each case builds a throwaway repo with a real DESIGN.md and real source, and
# runs the REAL script. The point of the suite is the thing the check exists to
# prevent: a scan that reports clean because it was never armed. So the cases
# that matter most are the ones asserting a DISTINCT exit for "no authority" and
# "stub authority" — a missing design must never read as a passing one.
#
# Run: bash .agents/skills/qa/scripts/tests/system-drift.test.sh
#
# peers:
#   .agents/skills/qa/scripts/system-drift.sh
#   .agents/skills/qa/scripts/design-authority.sh
#   .agents/skills/qa/scripts/design-frontmatter.mjs
#   .agents/skills/qa/scripts/element-scan.mjs

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIFT="${SCRIPT_DIR}/../system-drift.sh"
AUTHORITY="${SCRIPT_DIR}/../design-authority.sh"

TMP="$(mktemp -d -t system-drift-test-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}
check_rc() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected rc=$expect, got rc=$got"; fi
}
check_has() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then ok; else bad "$name — missing '$needle' in:"$'\n'"$hay"; fi
}
check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then bad "$name — unexpected '$needle' in:"$'\n'"$hay"; else ok; fi
}
check_eq() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected '$expect', got '$got'"; fi
}

new_repo() {
  local dir="$TMP/$1"
  mkdir -p "$dir/src"
  printf '%s\n' "$dir"
}

# A real design authority: a four-step ramp, three control heights, a palette
# whose only member is the one token the fixture uses, and the contract headings
# that keep design-authority.sh from calling it a stub.
write_design() {
  local dir="$1" ramp="$2"
  cat >"$dir/DESIGN.md" <<YAML
---
name: Fixture
colors:
  ink: "#101010"
typography:
  scale:
$ramp
controlHeights:
  sm: "2rem"
  md: "2.25rem"
componentVariants:
  button: [default, ghost]
---

# Design System: Fixture

## Type
A four-step ramp.

## Controls
Two heights.

## Focus
One ring.
YAML
}

FOUR_STEP='    xs: "0.75rem"
    sm: "0.875rem"
    base: "1rem"
    lg: "1.5rem"'

# Seven distinct sizes in the source; four of them are on the ramp above, so
# exactly three are drift: 10px, 13px and 40px.
write_source_seven() {
  cat >"$1/src/app.tsx" <<'TSX'
export function App() {
  return (
    <div>
      <p className="text-[12px]">on the ramp</p>
      <p className="text-[14px]">on the ramp</p>
      <p className="text-[16px]">on the ramp</p>
      <p className="text-[24px]">on the ramp</p>
      <p className="text-[10px]">off</p>
      <p className="text-[13px]">off</p>
      <p className="text-[40px]">off</p>
    </div>
  );
}
TSX
}

# ── 1. The headline case: three off-ramp values, each named ───────────────
REPO="$(new_repo seven-sizes)"
write_design "$REPO" "$FOUR_STEP"
write_source_seven "$REPO"
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_rc "seven sizes against a four-step ramp exits 1" 1 "$rc"
check_eq "reports exactly three off-ramp values" 3 "$(grep -c 'type-size' <<<"$out")"
check_has "names 10px" "type-size  10px" "$out"
check_has "names 13px" "type-size  13px" "$out"
check_has "names 40px" "type-size  40px" "$out"
check_lacks "does not report a size that IS on the ramp" "type-size  14px" "$out"
check_has "points at the file and line" "src/app.tsx:9" "$out"
check_has "counts the severities" "system-drift: P1=" "$out"

# ── 2. RED-FIRST: declare a ramp the fixture already satisfies ────────────
# The same source, measured against a ramp that contains all seven sizes. If the
# check still reported drift here it would be asserting against its own regex
# rather than against the declaration, which is the way a scan like this is
# usually wrong.
REPO="$(new_repo ramp-satisfied)"
write_design "$REPO" '    a: "0.625rem"
    b: "0.75rem"
    c: "0.8125rem"
    d: "0.875rem"
    e: "1rem"
    f: "1.5rem"
    g: "2.5rem"'
write_source_seven "$REPO"
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_lacks "a satisfied ramp produces no type-size finding" "type-size" "$out"

# ── 3. Zero divergence is SILENT, and exits clean ─────────────────────────
REPO="$(new_repo clean)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export function App() {
  return <p className="text-[16px]">fine</p>;
}
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_rc "no divergence exits 0" 0 "$rc"
# No congratulation. A scanner finding nothing is a floor, not a verdict.
check_eq "no divergence prints nothing" "" "$out"

# ── 4. No DESIGN.md exits DISTINCTLY from clean ───────────────────────────
REPO="$(new_repo no-authority)"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p className="text-[13px]">x</p>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_rc "a missing authority exits 3, never 0" 3 "$rc"
check_has "says the app has no design system" "no DESIGN.md" "$out"
check_has "raises it as P1" "[P1] design-authority" "$out"

# ── 5. A generated stub is a stub under the FIRST limb ────────────────────
REPO="$(new_repo stub-marker)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
design-authority: generated-stub
name: Fixture
colors:
  ink: "#101010"
typography:
  scale:
    xs: "0.75rem"
---

# Design System: Fixture

## Type
Even a heading here does not rescue it: the marker is the human's own statement
that this file is an extraction rather than a design.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p className="text-[13px]">x</p>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_rc "a marked stub exits 3" 3 "$rc"
check_has "names the marker as the reason" "generated-stub" "$out"

# ── 6. An UNMARKED file with no contract is a stub under the SECOND limb ──
# This is the limb that matters most: every DESIGN.md generated before the
# marker existed is unmarked, and that is the whole population with the problem.
REPO="$(new_repo stub-no-contract)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
---

# Design System: Fixture

## Overview

Auto-generated from the tokens already in this repo.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p className="text-[13px]">x</p>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_rc "an unmarked file declaring no contract exits 3" 3 "$rc"
check_has "says it declares no contract" "declares no design contract" "$out"

# ── 7. Unparseable frontmatter is a parse error, never a partial scan ─────
REPO="$(new_repo malformed)"
printf -- '---\nname: Fixture\ncolors:\n  ink: "#101010"\n' >"$REPO/DESIGN.md"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p className="text-[13px]">x</p>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_rc "an unterminated frontmatter block exits 2" 2 "$rc"
check_has "names the parse failure" "never closed" "$out"

# ── 8. A one-entry scale is valid; drift is measured against what is declared ──
REPO="$(new_repo one-step)"
write_design "$REPO" '    only: "1rem"'
write_source_seven "$REPO"
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_eq "a one-entry ramp measures the other six" 6 "$(grep -c 'type-size' <<<"$out")"
check_lacks "and not the one it declares" "type-size  16px" "$out"

# ── 9. An absent key disarms its own measure and nothing else ─────────────
REPO="$(new_repo unarmed)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
---

# Design System: Fixture

## Focus
One ring, and no type ramp declared anywhere in this file.
YAML
write_source_seven "$REPO"
out="$(bash "$DRIFT" "$REPO" 2>&1)"
rc=$?
check_lacks "no declared ramp means no type findings" "type-size" "$out"
check_rc "and that is not a failure" 0 "$rc"

# ── 10. Severity follows the occurrence count, not the measure ────────────
REPO="$(new_repo severity)"
write_design "$REPO" "$FOUR_STEP"
{
  echo 'export function App() { return (<div>'
  for _ in $(seq 1 12); do echo '  <p className="text-[10px]">many</p>'; done
  echo '  <p className="text-[13px]">one</p>'
  echo '</div>); }'
} >"$REPO/src/app.tsx"
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "ten or more occurrences is systemic" "[P2] type-size  10px" "$out"
check_has "fewer than ten is a one-off" "[P3] type-size  13px" "$out"
check_has "caps the examples at five" "and 7 more" "$out"

# ── 11. A native widget is P1 whatever the count, and is always armed ─────
REPO="$(new_repo native)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export function App() {
  return (
    <form>
      <select name="role">
        <option value="a">A</option>
      </select>
      <input
        type="date"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        className="rounded border px-2"
      />
      <input type="text" className="appearance-none" />
    </form>
  );
}
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a raw select is P1" "[P1] native-widget  native <select>" "$out"
# The attributes are three lines below the tag. A line-based scan sees none of
# them, which is how 34 of 35 native inputs went unreported before this.
check_has "a multi-line native input is found" "[P1] native-widget  native <input type=date>" "$out"
check_lacks "a plain text input is not a platform widget" "type=text" "$out"

# ── 12. appearance-none is the opt-out, and it is honoured ────────────────
REPO="$(new_repo appearance)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <select className="appearance-none rounded border" name="role">
    <option value="a">A</option>
  </select>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_lacks "a styled select is not reported" "native <select>" "$out"

# ── 13. Off-palette colours, and the comment that is not one ──────────────
REPO="$(new_repo palette)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
// The old ink was #ffeedd and this sentence must not be a finding.
export const App = () => (
  <div className="bg-slate-100 text-emerald-700">
    <span style={{ color: "#101010" }}>declared</span>
    <span style={{ color: "#abcdef" }}>not declared</span>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a raw palette step is off-palette" "off-palette-colour  bg-slate-100" "$out"
check_has "so is an undeclared literal" "off-palette-colour  #abcdef" "$out"
check_lacks "a declared literal is not" "off-palette-colour  #101010" "$out"
check_lacks "and neither is one named in a comment" "#ffeedd" "$out"

# ── 14. A recipe claim is never counted as a defect ───────────────────────
REPO="$(new_repo claims)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <button className="border px-2">Go</button>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a raw button is reported as a claim" "[claim] unmapped-recipe  raw <button>" "$out"
check_has "and the summary counts it separately" "claims=1" "$out"
check_lacks "never as a P2" "[P2] unmapped-recipe" "$out"

# ── 15. design-authority.sh answers for a real system ─────────────────────
REPO="$(new_repo real-authority)"
write_design "$REPO" "$FOUR_STEP"
out="$(bash "$AUTHORITY" status "$REPO" 2>&1)"
rc=$?
check_rc "a real authority exits 0" 0 "$rc"
check_has "and says so" "AUTHORITY=real" "$out"

# ── 16. A block-list scale is READ, not discarded ─────────────────────────
# `- 4px` under a key used to be skipped, which disarmed that key's measure —
# a declared scale reading as an absent one, which is the failure the whole
# mechanism exists to close.
REPO="$(new_repo block-list)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
typography:
  scale:
    - "0.75rem"
    - "1rem"
controlHeights:
  - "2rem"
---

# Design System: Fixture

## Type
Two steps.

## Controls
One height.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <p className="text-[12px]">declared</p>
    <p className="text-[13px]">not declared</p>
    <button className="h-9">off the declared height</button>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a block-list ramp is measured" "type-size  13px" "$out"
check_lacks "and its declared step is not drift" "type-size  12px" "$out"
check_has "a block-list control set is measured too" "control-height  h-9" "$out"

# ── 17. An inline array keeps commas that are INSIDE a value ──────────────
REPO="$(new_repo inline-commas)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: ["rgb(0, 0, 0)", "#abcdef"]
typography:
  scale:
    xs: "0.75rem"
---

# Design System: Fixture

## Type
One step.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <span style={{ color: "rgb(0, 0, 0)" }}>declared</span>
    <span style={{ color: "#123456" }}>not declared</span>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_lacks "a declared rgb() is not split into three values" "rgb(0,0,0)" "$out"
check_has "an undeclared literal still reports" "#123456" "$out"

# ── 18. An arbitrary control height is caught ─────────────────────────────
# `h-[41px]` walked past the scan because the pattern ended in a word boundary,
# and a `]` cannot be followed by one.
REPO="$(new_repo arbitrary-height)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <button className="h-[41px] px-3">odd</button>
    <button className="h-8 px-3">declared</button>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "an arbitrary height is off-scale" "control-height  h-[41px] (41px)" "$out"
check_lacks "a declared height is not" "control-height  h-8" "$out"

# ── 19. A path with a space is scanned, not silently skipped ──────────────
REPO="$(new_repo "spaced")"
write_design "$REPO" "$FOUR_STEP"
mkdir -p "$REPO/src/my components"
cat >"$REPO/src/my components/app.tsx" <<'TSX'
export const App = () => <select name="role"><option value="a">A</option></select>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a file under a directory with a space is read" "native <select>" "$out"
check_has "and its path is reported whole" "src/my components/app.tsx" "$out"

# ── 20. Three spellings of one attribute, one answer ──────────────────────
REPO="$(new_repo type-spellings)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <input type="date" />
    <input type='time' />
    <input type={"file"} />
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "double quotes" "native <input type=date>" "$out"
check_has "single quotes" "native <input type=time>" "$out"
check_has "a JSX expression" "native <input type=file>" "$out"

# ── 21. The marker is the SCALAR, not the line it sits on ─────────────────
for spelling in 'design-authority: "generated-stub"' "design-authority: 'generated-stub'" 'design-authority: generated-stub  # written by /qa'; do
  REPO="$(new_repo "marker-$RANDOM")"
  {
    echo "---"
    echo "$spelling"
    printf 'name: Fixture
colors:
  ink: "#101010"
---

# Design System: Fixture

## Type
A real-looking heading, which must not rescue a file its own frontmatter calls a stub.
'
  } >"$REPO/DESIGN.md"
  cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p>x</p>;
TSX
  out="$(bash "$AUTHORITY" status "$REPO" 2>&1)"
  check_rc "marker spelled as [$spelling] is still a stub" 3 $?
  check_has "  and reported as one" "AUTHORITY=stub" "$out"
done

# ── 22. A token inventory headed "## Colors" is NOT a design system ───────
# The second limb has to reject exactly this shape, or it exempts the whole
# population of generated files it exists to catch.
REPO="$(new_repo colours-only)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
---

# Design System: Fixture

## Colors

Every colour this repo happens to use, and nothing about how to use them.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p>x</p>;
TSX
out="$(bash "$AUTHORITY" status "$REPO" 2>&1)"
check_rc "a colour list under a colour heading is a stub" 3 $?
check_has "and says it declares no contract" "declares no design contract" "$out"

# ── 23. A quoted marker with trailing spaces is still a marker ────────────
REPO="$(new_repo marker-trailing)"
printf -- '---\ndesign-authority: "generated-stub"   \nname: Fixture\n---\n\n# Design System: Fixture\n\n## Type\nA heading that must not rescue it.\n' >"$REPO/DESIGN.md"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p>x</p>;
TSX
out="$(bash "$AUTHORITY" status "$REPO" 2>&1)"
check_rc "a quoted marker padded with spaces is still a stub" 3 $?
check_has "and is reported as one" "AUTHORITY=stub" "$out"

# ── 24. A list of maps is a parse ERROR, not a corrupted scale ────────────
REPO="$(new_repo list-of-maps)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
typography:
  scale:
    - name: xs
      size: "0.75rem"
---

# Design System: Fixture

## Type
One step, written in a shape the reader does not cover.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p className="text-[13px]">x</p>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_rc "a list of maps exits 2, never 0" 2 $?
check_has "and names the shape it cannot read" "list of maps is not supported" "$out"

# ── 25. A quoted map key is the same unsupported shape ────────────────────
REPO="$(new_repo quoted-map-key)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
typography:
  scale:
    - "name": xs
      size: "0.75rem"
---

# Design System: Fixture

## Type
Still a list of maps, just quoted.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <p className="text-[13px]">x</p>;
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_rc "a quoted map key is rejected too" 2 $?
check_has "with the same reason" "list of maps is not supported" "$out"

# ── 26. A trailing comment is stripped; a hex colour is not ───────────────
REPO="$(new_repo trailing-comments)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010" # the brand ink
typography:
  scale:
    xs: "0.75rem"   # small
controlHeights:
  - "2rem" # standard
---

# Design System: Fixture

## Type
One step.

## Controls
One height.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <p className="text-[12px]">declared</p>
    <span style={{ color: "#101010" }}>declared</span>
    <button className="h-8">declared</button>
    <button className="h-9">not declared</button>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_lacks "a commented size is still recognised" "type-size  12px" "$out"
check_lacks "a commented hex colour survives the strip" "#101010" "$out"
check_lacks "a commented height is still recognised" "control-height  h-8" "$out"
check_has "and a genuinely undeclared height still reports" "control-height  h-9" "$out"

# ── 27. A comment on a container key does not disarm its measure ──────────
REPO="$(new_repo commented-container)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
typography:
  scale: # the ramp, four steps
    - "0.75rem"
    - "1rem"
---

# Design System: Fixture

## Type
Two steps.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <p className="text-[12px]">declared</p>
    <p className="text-[13px]">not declared</p>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "the ramp under a commented key is still read" "type-size  13px" "$out"
check_lacks "and its declared step is not drift" "type-size  12px" "$out"

# ── 28. A JSX variable is not a native type ───────────────────────────────
# `type={fileType}` is a variable whose value is unknown at scan time. Matching
# it on the prefix `file` reported a blocking P1 about a control that may be a
# plain text box.
REPO="$(new_repo jsx-variable-type)"
write_design "$REPO" "$FOUR_STEP"
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = ({ fileType, dateish }) => (
  <div>
    <input type={fileType} />
    <input type={dateish} />
    <input type={"date"} />
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a quoted JSX literal is still found" "native <input type=date>" "$out"
check_lacks "a variable named fileType is not a file input" "type=file" "$out"
check_eq "exactly one native finding" 1 "$(grep -c 'native-widget' <<<"$out")"

# ── 29. Control heights in the published shape arm the control measure ────
# The schema has no `controlHeights` key: a control's height lives on a
# `components` entry. Only entries named `control-*` count — an app may
# declare `person-row: 64px`, and a row height is not a control height.
REPO="$(new_repo components-controls)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
typography:
  body:
    fontSize: "1rem"
spacing:
  s4: "4px"
  s8: "8px"
rounded:
  sm: "6px"
components:
  control-sm:
    height: "2rem"
  control-md:
    height: "2.25rem"
  person-row:
    height: "64px"
---

# Design System: Fixture

## Controls
Two heights.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => (
  <div>
    <button className="h-9">declared control height</button>
    <button className="h-11">not declared</button>
    <button className="h-16">declared only by a row, which is not a control</button>
  </div>
);
TSX
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "a components control set arms the measure" "control-height  h-11" "$out"
check_lacks "and a declared control height is not drift" "control-height  h-9" "$out"
check_has "a non-control component height does not join the set" "control-height  h-16" "$out"

# ── 30. The reader reads the published keys when the older ones are absent ─
fm="$(node "$SCRIPT_DIR/../design-frontmatter.mjs" "$REPO")"
check_has "a spacing map arms the spacing scale" "SPACING_SCALE=4px|8px" "$fm"
check_has "and control-* heights arm the control set" "CONTROL_HEIGHTS=2rem|2.25rem" "$fm"

# ── 31. Variants derive from <role>-<variant> component names ─────────────
# `componentVariants` is not a schema key either; the schema's way to say a
# button has a ghost variant is an entry named `button-ghost`.
REPO="$(new_repo components-variants)"
cat >"$REPO/DESIGN.md" <<'YAML'
---
name: Fixture
colors:
  ink: "#101010"
typography:
  body:
    fontSize: "1rem"
components:
  button-default:
    backgroundColor: "{colors.ink}"
  button-ghost:
    textColor: "{colors.ink}"
---

# Design System: Fixture

## Controls
Two button variants.
YAML
cat >"$REPO/src/app.tsx" <<'TSX'
export const App = () => <button className="px-2">raw</button>;
TSX
fm="$(node "$SCRIPT_DIR/../design-frontmatter.mjs" "$REPO")"
check_has "variants derive from component names" "VARIANTS_BUTTON=default|ghost" "$fm"
out="$(bash "$DRIFT" "$REPO" 2>&1)"
check_has "and arm the recipe measure" "unmapped-recipe" "$out"

echo
echo "system-drift.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
