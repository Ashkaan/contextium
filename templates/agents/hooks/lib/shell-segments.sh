#!/usr/bin/env bash
# shell-segments.sh — take a Bash command apart with the quotes respected.
#
# Sourced, never executed. Written when two PreToolUse hooks needed the same
# walk; today one hook and its test source it:
#   .agents/hooks/check-shared-checkout-write.sh    (a write into a shared
#                                                    checkout)
#
# A SEPARATOR INSIDE QUOTES IS NOT A SEPARATOR, and neither is a word break.
# The first cut of the segment splitter kept two parallel lists — the original
# and a quote-stripped copy — and indexed one by the other's line number, on the
# stated premise that "stripping removes no separators". It does: a `;` inside a
# quoted string goes with the quotes, so `echo "one; two"; git add .` produced
# three raw segments and two stripped ones, every later index was off by one,
# and the `git add .` the staging hook is named after came back allowed.
#
# So both functions here walk the characters and track quote state, the same way
# the TypeScript comment stripper in the toolchain's app-shape check does.

# ── split_segments <command> ──────────────────────────────────────────────
#
# One segment per line, cut at an unquoted `;`, `&` or `|`.
#
# A NEWLINE INSIDE AN OPEN QUOTE IS NOT A SEGMENT BREAK either, which is why
# this buffers across input lines instead of printing one per line. Printing per
# line read the second line of a multiline quoted string as a command of its
# own, so `echo "line one⏎rm <guarded>/close"` came back as a `rm` and was
# refused — a false BLOCK on a command that writes nothing. The embedded newline
# becomes a space: inside a quoted word it is whitespace to every caller here.
split_segments() {
  printf '%s\n' "$1" | awk '
    BEGIN { q = ""; out = "" }
    {
      line = $0; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (q != "") {
          out = out c
          # A backslash escapes the next character inside DOUBLE quotes only.
          # Inside single quotes the shell treats it literally, so honoring it
          # there left the lexer believing a single-quoted string ending in a
          # backslash had not closed — it then swallowed the real `;` after it,
          # and the `git add -A` that followed came back allowed.
          if (c == "\\" && q == "\"") {
            out = out substr(line, i + 1, 1); i++; continue
          }
          if (c == q) { q = "" }
          continue
        }
        if (c == "\"" || c == "'"'"'") { q = c; out = out c; continue }
        if (c == ";" || c == "&" || c == "|") { out = out "\n"; continue }
        out = out c
      }
      if (q == "") { print out; out = "" } else { out = out " " }
    }
    END { if (out != "") print out }
  '
}

# ── split_words <segment> ─────────────────────────────────────────────────
#
# One TAGGED token per line, quotes consumed rather than deleted:
#   W <word>   a word, with its quote characters removed and its escapes applied
#   R >        an unquoted output redirection (`>` or `>>` — both tag as `R`)
#   L <        an unquoted input redirection (`<`, `<<`, `<<<`), which reads
#
# The tags are what a plain `tr -d "\"'"` could not give a caller, and both
# gaps it left were real. Deleting the quote CHARACTERS splits a quoted path at
# its spaces, so `cp /tmp/a "<guarded>/my file"` handed the caller `file` as the
# destination and the write went unrefused. And scanning for `>` in the stripped
# text cannot tell an operator from prose, so `printf '%s' '> <guarded>/f'` —
# a command that writes nothing at all — was refused.
split_words() {
  printf '%s\n' "$1" | awk '
    BEGIN { q = ""; tok = ""; have = 0; quoted = 0 }
    function flush() {
      if (have) { print "W " tok; tok = ""; have = 0; quoted = 0 }
    }
    # A file descriptor is an UNQUOTED run of digits touching its redirection
    # operator. Quoting makes it an ordinary word, so `touch "2">log` writes a
    # file named `2` — dropping it there lost the write entirely.
    function drop_fd() {
      if (have && !quoted && tok ~ /^[0-9]+$/) {
        tok = ""; have = 0; quoted = 0
      }
    }
    {
      line = $0; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (q != "") {
          if (c == "\\" && q == "\"") {
            tok = tok substr(line, i + 1, 1)
            i++; have = 1; quoted = 1; continue
          }
          if (c == q) { q = ""; have = 1; quoted = 1; continue }
          tok = tok c; have = 1; quoted = 1; continue
        }
        if (c == "\"" || c == "'"'"'") { q = c; have = 1; quoted = 1; continue }
        if (c == "\\") {
          tok = tok substr(line, i + 1, 1)
          i++; have = 1; quoted = 1; continue
        }
        if (c == " " || c == "\t") { flush(); continue }
        # Adjacency is knowable only here: the caller sees a flat token list,
        # so it had to drop any numeric word before a redirect, and
        # `touch 2 > log` silently lost the file literally named `2`.
        if (c == ">") {
          drop_fd()
          flush()
          if (substr(line, i + 1, 1) == ">") { i++ }
          print "R >"
          continue
        }
        if (c == "<") {
          # An input descriptor is attached too. Leaving `0` as a word in
          # `0</tmp/in touch <guarded>/f` made `0` read as the command, and the
          # real verb was never looked at.
          drop_fd()
          flush()
          while (substr(line, i + 1, 1) == "<") { i++ }
          print "L <"
          continue
        }
        # A `#` opens a comment only at a word boundary, so `issue#3.ts` is one
        # word and `touch f # note` stops at the note.
        if (c == "#" && !have) { break }
        tok = tok c; have = 1
      }
      flush()
    }
  '
}
