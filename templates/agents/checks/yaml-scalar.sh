# shellcheck shell=bash
# yaml-scalar.sh — the one reading of a YAML flow scalar that the frontmatter
# checks share. Sourced by check-skill-format.sh and check-decision-records.sh,
# which prepend $YAML_SCALAR_AWK to their own awk programs; both must pass
# `-v sq="'"`, since a single quote cannot sit inside this single-quoted string.
#
# yaml_scalar(s) returns the value of scalar `s` and sets YS_STATE:
#   ok        a plain value (a ` #` comment dropped), or a quoted value that
#             closes, optionally followed by whitespace and a `#` comment
#   open      a quote that never closes. In "…" a quote after an odd run of
#             backslashes is escaped; in '…' a doubled '' is.
#   trailing  a closed quote followed by anything but a comment
# Escapes inside the value are left as written: the checks only measure and
# compare values, and never need them decoded.

# shellcheck disable=SC2016,SC2034  # awk source, not shell; read by the sourcing scripts
YAML_SCALAR_AWK='
function yaml_scalar(s,   q, i, n, c, rest) {
  gsub(/^[ \t]+|[ \t]+$/, "", s)
  YS_STATE = "ok"
  q = substr(s, 1, 1)
  if (q != "\"" && q != sq) {
    if (match(s, /[ \t]#/)) s = substr(s, 1, RSTART - 1)
    gsub(/[ \t]+$/, "", s)
    return s
  }
  n = length(s)
  for (i = 2; i <= n; i++) {
    c = substr(s, i, 1)
    if (q == "\"" && c == "\\") { i++; continue }
    if (c == q) {
      if (q == sq && substr(s, i + 1, 1) == sq) { i++; continue }
      break
    }
  }
  if (i > n) { YS_STATE = "open"; return s }
  rest = substr(s, i + 1)
  if (rest !~ /^[ \t]*$/ && rest !~ /^[ \t]+#/) YS_STATE = "trailing"
  return substr(s, 2, i - 2)
}
'
