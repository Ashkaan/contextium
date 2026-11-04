#!/usr/bin/env bash
# Block shell commands that modify shared host infrastructure or restart
# session-hosting services: shared host infrastructure changes only with the
# user's authorization, and a service whose process tree holds this session is
# never restarted, stopped or killed by name.
#
# Triggers (any one fires):
#   (a) sudo on a remote host (wrapped in ssh) — sudo on the local workstation
#       is OK; sudo over ssh to a NAS, a router or a client's server is not. A
#       sudo-over-ssh command whose every sudo-invoked segment is on the
#       READ-ONLY ALLOWLIST below passes: the rule says "Diagnose freely
#       (read-only)" in its own words, and a gate blocking the diagnosis it
#       permits teaches people to route around it. See § "Read-only allowlist".
#   (b) writes to /etc/, /root/, /usr/local/, /var/lib/
#   (c) ip link/addr/route mutate ops (add/del/set/change/flush)
#   (d) systemctl enable on a persistent unit — EXCEPT `systemctl --user enable`
#       on a unit that already exists under ~/.config/systemd/user/ and resolves
#       into that directory or a checkout of this repo, which the rule's own
#       carve-out puts in scope for autonomous work.
#   (e) edits to daemon.json / sshd_config / systemd-networkd
#   (f) systemctl restart/stop/disable against session-hosting services
#       (t3code, the T3 Code server)
#   (g) pkill -f / --full at a command position — the pattern always appears in
#       the invoking shell's own /proc cmdline, so pkill matches and SIGTERMs
#       the shell running it (and this tool's outer shell too). Exit 144, no
#       output, and every later command in the chain silently never runs.
#   (h) pgrep -f / --full at a command position in a command that ALSO contains
#       a `kill` — the identical trap by a second route. pgrep alone is
#       harmless, but its match list includes the invoking shell's own pid, so
#       feeding it to kill kills that shell:
#       `for p in $(pgrep -f runTR.sh); do kill "$p"; done` dies exit 144, as
#       does a `while pgrep -f 'runTR' ...` loop whose body kills.
#       A bare `pgrep -f` with no kill PASSES — reading is not the hazard.
#   (i) pkill / killall naming `claude` by ANY matcher (-x, -f, or bare) — the
#       Claude Code session itself runs as a process named `claude`, so this
#       kills the session issuing the command — and with it any background run
#       the session was waiting on, whose in-flight results are lost.
#       Same hazard class as (f), which reaches only systemctl.
#   (j) a kill by PORT at a command position — `fuser -k`, `lsof … | xargs
#       kill`, `kill $(lsof …)`, `kill-port`. Whatever holds the port dies,
#       and on a shared host that is not always the dev server the session
#       started: `fuser -k 8791/tcp` kills whatever other service listens on
#       8791. Most port kills took this route once, because this hook's own
#       (g)/(h) remedy text used to teach `fuser -k 3000/tcp`.
#
# Read-only inspection commands (ip route show, ls /etc/, cat /etc/foo) pass.
#
# ── PRECISION ────────────────────────────────────────────────────────────────
# A gate that fires mostly on commands the rule already permits never gets its
# remedy followed; it teaches the route-around habit instead (a verb assembled
# as `V=enab; systemctl --user "${V}le"` is the shape that habit takes, now
# blocked at (d2)). Two false-positive classes dominate a gate like this, and
# both are handled below:
#   - read-only diagnosis over `ssh … sudo …` (trigger (a) had no read/write
#     distinction), and
#   - a protected path or daemon-config keyword appearing only as PROSE — in a
#     heredoc body being written to a journal file, or in a quoted grep pattern.
#
# A second layer MAY sit in front of this one, ADDITIVE — it deletes nothing
# here: `permissions.ask` rules in Claude Code's settings such as
# Edit(//etc/**), Edit(//root/**), Edit(//usr/local/**), Edit(//var/lib/**).
# Those prompt even in bypassPermissions mode, which this hook does not. Their
# reach is the built-in file-editing tools — an Edit(path) rule covers Write
# and NotebookEdit too — but NOT Bash subprocess writes, which is the limit that
# matters here. Every trigger (a)-(j) above stays hook-owned, and NO branch below is
# removable on the belief that permissions now cover it:
#   (a) `Bash(sudo *)` cannot tell `sudo x` from `ssh host sudo x`, and would
#       prompt on every local sudo — a widening this rule never asked for.
#   (b)/(b') `echo x > /etc/hosts`, `sed -i`, `vim /etc/...` are Bash calls;
#       Edit(...) rules never see them. Per the permissions doc, Read/Edit deny
#       rules "don't apply to arbitrary subprocesses that read or write files
#       indirectly."
#   (c)/(d) `Bash(ip *)` / `Bash(systemctl enable *)` would also fire on the
#       read-only forms (`ip addr show`).
#   (e) path-specific Bash editing — no glob expresses it.
#   (f) the regex below matches the flag-before-verb form
#       `systemctl --user restart t3code`; `Bash(systemctl restart *)`
#       misses it.
#   (g)/(h)/(i) `pkill -f`, `pgrep -f` + kill, and `pkill <matcher> claude` all
#       need command-position anchoring or two-part matching the glob syntax
#       lacks; `Bash(pkill *)` would also fire on every harmless kill.

# ── Examples — what blocks and what passes ──────────────────────────────────
#
# Every line below is executable documentation. `bash check-host-infra-safety.sh
# --self-test` feeds each command through this script and fails if a `block:`
# does not exit 2 or a `pass:` does not exit 0. They are the test file, kept in
# the script so that the explanation and its proof are one artifact that cannot
# drift from the code beside it. A trailing `*` marks a multi-line command
# written with `\n` escapes and decoded with printf %b. `raw:` lines are whole
# stdin payloads that must pass because they carry no command at all. The
# blocks are genuine host changes this kind of gate exists to catch; the passes
# are the false positives that kind of gate produces.
#
# (g) pkill self-kill
#   block: kill 2122077 2>/dev/null; pkill -f 'session-id beadc084' 2>/dev/null
#   block: pkill -f astro
#   block: pkill -9 -f "next dev"
#   block: pkill --full wrangler
#   block: npm run build && pkill -f 'pages dev'
#   block: echo cleanup; pkill -f "until op|until KOMODO"
#   block: (pkill -f komodo)
#   pass: grep -rn 'pkill -f' journal/*.md
#   pass: rg --fixed-strings 'pkill -f' .claude/hooks/
#   pass: echo "do not use pkill -f here"
#   pass: pkill -x node_exporter
#   block: fuser -k 3000/tcp
#   block: lsof -ti tcp:3000 | xargs -r kill
#   pass: kill "$PID"
#   pass: systemctl --user stop nightly-report
# (h) pgrep -f whose output reaches a kill
#   block: for p in $(pgrep -f runTR.sh); do kill "$p" 2>/dev/null; done
#   block: pgrep -f 'myjob' | xargs -r kill
#   block: kill $(pgrep -f myjob)
#   block: pgrep -af runTR.sh | awk '{print $1}' | xargs kill -9
#   block: PIDS=`pgrep -f runTR.sh`; kill $PIDS
#   block: /usr/bin/pgrep -f runTR.sh | xargs -r kill
#   pass: pgrep -f runTR.sh
#   pass: while pgrep -f runjudge_grok >/dev/null; do sleep 30; done
#   pass: pgrep -f node > /tmp/pid-list.txt
#   pass: pgrep -f astro || echo "nothing to kill"
#   pass: kill "$PID"; pgrep -af astro
#   pass: grep -rn 'pgrep -f' journal/*.md
# (j) killing whatever holds a port
#   block: fuser -k 8791/tcp
#   block: fuser -k -n tcp 3000
#   block: sudo fuser -km 3000/tcp
#   block: lsof -t -i :3000 | xargs kill -9
#   block: lsof -i :3000 | awk 'NR>1 {print $2}' | xargs -r kill
#   block: kill $(lsof -ti:3000)
#   block: for p in $(lsof -ti:3000); do kill "$p"; done
#   block: npx kill-port 3000
#   block: npm run build && npx -y kill-port 4321
#   block: fuser --kill 8791/tcp
#   block: echo "$(fuser -k 8791/tcp)"
#   block: echo "stopped: `fuser -k 3000/tcp`"
#   block: echo "$(lsof -ti:3000 | xargs kill)"
#   pass: grep -rn 'fuser -k' journal/
#   pass: grep -rn '$(fuser -k 8791/tcp)' journal/
#   block: echo "'$(fuser -k 8791/tcp)'"
#   block*: cat > /tmp/stop.sh <<EOF\n$(fuser -k 8791/tcp)\nEOF
#   pass*: cat >> journal/x.md <<'EOF'\nran $(fuser -k 8791/tcp) by mistake\nEOF
#   pass*: cat >> journal/x.md <<"EOF"\nran `fuser -k 3000/tcp` once\nEOF
#   pass: echo "it's fine"; grep -rn '$(fuser -k 1/tcp)' x
#   block: cat <<<'EOF'; echo "$(fuser -k 8791/tcp)"
#   block*: cat >> journal/x.md <<'END '\nprose\nEND \necho "$(fuser -k 8791/tcp)"
#   block*: cat <<<'EOF'\necho "$(fuser -k 8791/tcp)"
#   block*: cat >> journal/x.md <<'END-TEXT'\nprose\nEND-TEXT\necho "$(fuser -k 8791/tcp)"
#   pass*: cat >> journal/x.md <<'END-TEXT'\nran $(fuser -k 8791/tcp)\nEND\nstill prose $(fuser -k 1/tcp)\nEND-TEXT
#   pass: echo "never fuser -k"
#   pass: kill -- -"$PGID"
#   pass: fuser 3000/tcp
#   pass: lsof -ti:3000
#   pass*: cat >> journal/x.md <<'EOF'\nfuser -k 8791/tcp killed the wrong service\nEOF
# (i) killing the session's own process name
#   block: pkill -x claude
#   block: pkill -f claude
#   block: pkill claude
#   block: killall claude
#   block: killall -9 claude
#   block: sudo pkill -x claude
#   block: nohup pkill -x claude
#   block: pkill -f my-bridge
#   block: pkill -f code-server
#   block: kill $(pgrep -x claude)
#   block: pgrep -x claude | xargs kill
#   block: kill -9 $(pidof claude)
#   block: ps aux | grep claude | awk '{print $2}' | xargs kill
#   pass: pgrep -a -x claude
#   pass: pgrep -c -x claude
#   pass: ps aux | grep claude
#   pass: pkill -x claude-helper
#   pass: grep -rn 'pkill -x claude' journal/*.md
#   pass: echo "never run pkill -x claude"
# regression: pre-existing triggers still fire
#   block: ssh nas sudo systemctl restart docker
#   block: echo x > /etc/hosts
#   block: ip route add 192.168.1.0/24 via 192.168.1.1
#   block: systemctl --user enable my-bridge
#   block: systemctl --user restart t3code
#   block: vim /etc/docker/daemon.json
# regression: benign commands still pass
#   pass: ip route show
#   pass: ls /etc/systemd/user/
#   pass: systemctl --user status my-bridge
#   pass: git status --short
# (a) read-only diagnosis over ssh+sudo now PASSES (the rule's own words)
#   pass: ssh nas "sudo sqlite3 -readonly /mnt/pool/docker/uptime-kuma/kuma.db \"SELECT id, name FROM monitor;\"" 2>&1
#   pass*: ssh nas "sudo sqlite3 -readonly /db/kuma.db \\"\nSELECT m.name, h.status\nFROM monitor m\nJOIN heartbeat h ON h.monitor_id = m.id;\\"" 2>&1
#   pass: timeout 60 ssh -o BatchMode=yes nas "sudo docker ps --format '{{.Names}}' | grep -i trigger" 2>&1
#   pass: timeout 25 ssh nas 'sudo docker logs komodo-periphery --tail 40 2>&1 | grep -i error' 2>&1
#   pass: ssh nas 'sudo docker inspect uptime-kuma --format "{{.Config.Image}}"' 2>&1
#   pass: ssh nas "sudo docker exec uptime-kuma cat /app/package.json" 2>&1
#   pass: ssh nas "sudo docker exec uptime-kuma grep -n 'heartbeat' /app/server/model/monitor.js" 2>&1
#   pass: timeout 30 ssh nas2 "sudo zpool status -x" 2>&1
#   pass: ssh nas2 'sudo smartctl -a /dev/sdc' 2>&1
#   pass: timeout 60 ssh nas "sudo smartctl -H -l selftest /dev/sdg" 2>&1
#   pass: ssh nas2 "sudo midclt call alert.list" 2>&1 | head -c 4000
#   pass: ssh nas "sudo grep -ri 'bond' /var/log/middlewared.log 2>/dev/null | tail -40" 2>&1
#   pass: ssh nas "sudo journalctl -u docker --since '-1h' --no-pager" 2>&1
#   pass: ssh nas "sudo systemctl status docker --no-pager" 2>&1
#   pass: ssh nas2 'sudo ipmitool mc info' 2>&1
# (a) treatment over ssh+sudo still BLOCKS
#   block: ssh nas "sudo docker exec uptime-kuma sqlite3 /app/data/kuma.db \"SELECT id FROM monitor;\"" 2>&1
#   block: ssh nas "sudo sqlite3 -readonly /db/kuma.db \"DELETE FROM heartbeat;\"" 2>&1
#   block: ssh nas "sudo sqlite3 -readonly /db/kuma.db \"UPDATE monitor SET active=0;\"" 2>&1
#   block: ssh nas "sudo docker exec uptime-kuma sh -c 'grep -n x /app/y.js'" 2>&1
#   block: ssh nas "sudo docker restart uptime-kuma" 2>&1
#   block: ssh nas "sudo docker run --rm -v /:/host alpine sh" 2>&1
#   block: ssh nas "sudo zpool scrub tank" 2>&1
#   block: ssh nas "sudo zpool destroy tank" 2>&1
#   block: ssh nas "sudo journalctl --vacuum-size=1M" 2>&1
#   block: ssh nas "sudo smartctl -t short /dev/sda" 2>&1
#   block: ssh nas "sudo midclt call pool.dataset.delete tank/x" 2>&1
#   block: ssh nas "sudo systemctl daemon-reload" 2>&1
#   block: ssh nas "sudo sh -c 'echo x > /etc/hosts'"
#   block: bash -c "ssh nas 'sudo tee /etc/hosts'"
#   block: ssh nas "sudo tee -a /root/.ssh/authorized_keys"
#   block: ssh nas "sudo zpool status -x; sudo systemctl restart docker" 2>&1
#   block: ssh nas "sudo docker exec garage /garage bucket info backups" 2>&1
#   block: ssh nas "sudo awk 'BEGIN{f=\"system\"; @f(\"touch /tmp/rule-proof\")}'"
# (d) systemctl --user enable on a ~/.config/systemd/user/ unit
#   block: systemctl --user enable definitely-not-installed.timer
#   block: sudo systemctl enable nightly-report.timer
#   block: systemctl --user enable "$UNIT"
#   block: V=enab; systemctl --user "${V}le" nightly-report.timer
# (b)/(b')/(e) a path or keyword merely NAMED is not a write
#   pass*: cat >> journal/2026-01-12/0930-notes.md <<'ENTRY'\n- settings carry Edit(//etc/**), Edit(//root/**), Edit(//usr/local/**)\n- daemon.json and sshd_config are named here as prose\nENTRY
#   pass: journalctl --since '2026-08-12 03:00' --utc 2>&1 | grep -iE 'systemd-networkd.*(enp|eno)' | head -20
#   pass: grep -rn 'daemon.json' knowledge/infra/
#   pass: git commit -m 'read-only diagnosis over ssh with sudo is what the rule permits'
#   pass: git commit -F /tmp/msg.txt
#   pass*: git commit -F - <<'MSG'\nfix the over-blocking hook\n\nThe dominant false positive is read-only diagnosis run over ssh with sudo,\nwhich the rule permits in its own words.\nMSG
# (b) a real write is still a write, quoted or not
#   block: printf 'x\n' >> /etc/hosts
#   block: cat /tmp/new-hosts > /etc/hosts
#   block: sed -i 's/a/b/' /etc/docker/daemon.json
#   block: tee -a /root/.ssh/authorized_keys < /tmp/key
#   block*: cat > /tmp/ha-key-fix.sh <<'SCRIPT'\nssh -o BatchMode=yes root@192.168.1.11 "printf %s \\"$PUBKEY\\" >> /root/.ssh/authorized_keys"\nSCRIPT\nbash /tmp/ha-key-fix.sh
# regressions: payload shapes an earlier version passed (fail-OPEN) or judged inconsistently
#   block: ssh nas "cd /tmp; sudo systemctl restart docker"
#   block: ssh nas "true && sudo rm -rf /etc/docker"
#   block: ssh nas "sudo apt update; sudo apt install -y nginx"
#   block: ssh nas "true | sudo systemctl restart docker"
#   block: ssh -o BatchMode=yes nas "cd /tmp; sudo zpool destroy tank"
#   block: ssh nas "echo 'a;b'; sudo systemctl restart docker"
#   block: ssh nas 'echo "a;b"; sudo systemctl restart docker'
#   block: ssh nas "cd '/a'; cd '/b'; sudo systemctl restart docker"
#   block: ssh nas "x='1;2' && sudo docker restart kuma"
#   block: ssh nas "echo \"a;b\"; sudo systemctl restart docker"
#   block: ssh nas "cd \"/a\"; sudo zpool destroy tank"
#   block: ssh nas 'echo a\; sudo systemctl restart docker'
#   block: ssh nas $'echo \'a;b\'; sudo systemctl restart docker'
#   block: ssh nas $'cd \'/a\'; sudo zpool destroy tank'
#   pass: ssh nas uptime; sudo -n true
#   pass: sudo -n true; ssh nas uptime
#   pass: ssh nas uptime && sudo -n systemctl --user status my-bridge
#   block: systemctl --user enable 'my-*.timer'
#   block: ssh nas "sudo docker exec kuma sqlite3 -readonly /db \"DELETE FROM heartbeat;\""
#   block: ssh nas "sudo docker exec kuma sqlite3 -readonly /db \"UPDATE monitor SET active=0;\""
#   pass: ssh nas "sudo timeout 20 zpool status -x"
#   pass: ssh nas "sudo timeout 20 midclt call alert.list"
# a host network change made without asking — every step blocks
#   block: ssh nas 'sudo ip link add ipvshim type ipvlan link bond0 mode l2'
#   block: ssh nas 'sudo ip route add 192.168.1.58/32 dev ipvshim'
#   block: ssh nas 'sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak'
#   block: echo '{"insecure-registries":["192.168.1.58:5000"]}' > /etc/docker/daemon.json
#   block: ssh nas 'sudo systemctl enable example-registry.service'
#   block: ssh nas 'sudo docker login -u user -p token 192.168.1.58:5000'
#
#   block: sudo systemctl restart t3code.service
#   pass: ls -la /tmp
#
# non-ASCII outside quotes — awk's substr slices BYTES, so pass 2 of
# scrub_prose meets half an em dash, and macOS awk dies ("towc: multibyte
# conversion failure") the moment that half byte reaches a regex. gawk and mawk
# never fail here, so these only bite on a Mac in a UTF-8 locale; the
# character test is index(), never ~, for that reason
#   pass: echo "x" # a — b
#   pass*: cat <<EOF\na — b\nEOF
#   pass: ls → x
#   block: ssh nas 'sudo systemctl restart docker' # restart — again
#   raw: {"tool_name":"Bash","tool_input":{"command":""}}
#   raw: {"tool_name":"Read"}
#   raw: {}

set -euo pipefail

# --self-test: run every `block:` / `pass:` / `raw:` example in the header
# above through this same script and report. Exit 1 on any mismatch.
if [[ "${1:-}" == "--self-test" ]]; then
  self="${BASH_SOURCE[0]}"; pass=0; fail=0
  while IFS= read -r line; do
    kind=${line%%:*}; kind=${kind#\#   }; cmd=${line#*: }
    if [[ "$kind" == *'*' ]]; then kind=${kind%'*'}; cmd=$(printf '%b' "$cmd"); fi
    if [[ "$kind" == raw ]]; then
      payload="$cmd"; want=0
    else
      payload=$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')
      want=0; [[ "$kind" == block ]] && want=2
    fi
    rc=0; printf '%s' "$payload" | bash "$self" >/dev/null 2>&1 || rc=$?
    if [[ "$rc" == "$want" ]]; then pass=$((pass+1))
    else fail=$((fail+1)); echo "FAIL (expected $kind, exit $rc): $cmd" >&2; fi
    # Every case runs a second time in Antigravity's shape, where a block is a
    # JSON decision on stdout rather than exit 2. A harness wired in with its
    # command read from the wrong key permits everything silently, so the shape
    # is asserted, not assumed.
    [[ "$kind" == raw ]] && continue
    # And a third time in Grok Build's shape: camelCase keys and its own tool
    # name, a block read from exit 2 like Claude's.
    grok_payload=$(jq -nc --arg c "$cmd" '{hook_event_name:"PreToolUse",toolName:"run_terminal_command",toolInput:{command:$c}}')
    rc=0; printf '%s' "$grok_payload" | bash "$self" >/dev/null 2>&1 || rc=$?
    if [[ "$rc" == "$want" ]]; then pass=$((pass+1))
    else fail=$((fail+1)); echo "FAIL (grok shape: expected $kind, exit $rc): $cmd" >&2; fi
    agy_payload=$(jq -nc --arg c "$cmd" '{toolCall:{name:"run_command",args:{CommandLine:$c}},stepIdx:0}')
    agy_out=$(printf '%s' "$agy_payload" | bash "$self" 2>/dev/null || true)
    if [[ "$kind" == block ]]; then
      if [[ "$(jq -r '.decision // empty' <<<"$agy_out" 2>/dev/null)" == deny ]]; then pass=$((pass+1))
      else fail=$((fail+1)); echo "FAIL (agy shape: expected a deny decision, got '${agy_out:0:40}'): $cmd" >&2; fi
    else
      if [[ -z "$agy_out" ]]; then pass=$((pass+1))
      else fail=$((fail+1)); echo "FAIL (agy shape: expected silence, got '${agy_out:0:40}'): $cmd" >&2; fi
    fi
  done < <(grep -E '^#   (block|pass|raw)\*?: ' "$self")
  # (d)'s carve-out needs a unit on disk, which a one-line example cannot
  # place: a scratch HOME whose ~/.config/systemd/user links a unit into the
  # main checkout, a linked worktree, another repo and a `<repo>-evil`
  # sibling, each enabled from inside the scratch repo. Nothing real is read.
  fx=$(mktemp -d "${TMPDIR:-/tmp}/infra-selftest.XXXXXX"); fx=$(cd "$fx" && pwd -P)
  self_abs="$(cd "$(dirname "$self")" && pwd -P)/$(basename "$self")"
  if {
    git init -q "$fx/repo" &&
      git -C "$fx/repo" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m seed &&
      git -C "$fx/repo" worktree add -q "$fx/wt" 2>/dev/null &&
      git init -q "$fx/other" && mkdir -p "$fx/repo-evil" "$fx/home/.config/systemd/user"
  } >/dev/null 2>&1; then
    for d in repo wt other repo-evil; do
      printf '[Unit]\n' >"$fx/$d/u.timer"
      ln -s "$fx/$d/u.timer" "$fx/home/.config/systemd/user/$d.timer"
    done
    for row in "repo 0 repo.timer" "repo 0 wt.timer" "wt 0 repo.timer" "repo 2 other.timer" "repo 2 repo-evil.timer"; do
      read -r from want unit <<<"$row"
      payload=$(jq -nc --arg c "systemctl --user enable $unit" '{tool_name:"Bash",tool_input:{command:$c}}')
      rc=0; (cd "$fx/$from" && printf '%s' "$payload" | HOME="$fx/home" bash "$self_abs") >/dev/null 2>&1 || rc=$?
      if [[ "$rc" == "$want" ]]; then pass=$((pass+1))
      else fail=$((fail+1)); echo "FAIL (unit fixture: from $from, enable $unit, expected exit $want, got $rc)" >&2; fi
    done
  else
    fail=$((fail+1)); echo "FAIL (unit fixture: could not build the scratch repos)" >&2
  fi
  rm -rf "$fx"
  echo "self-test: pass=$pass fail=$fail"
  [[ "$fail" == 0 ]] && exit 0 || exit 1
fi

INPUT=$(cat)
# Claude Code and Codex both nest the command under `tool_input` on their
# PreToolUse event (the Codex hooks schema). Antigravity (`agy`) puts it under
# `toolCall.args.CommandLine` and names the tool `run_command` (the hook
# reference embedded in the `agy` binary), and both shapes are in the self-test
# below. An empty COMMAND exits 0
# below, so a harness that puts the command elsewhere would be wired in and
# silently permitted everything — add its shape here, tested.
# Grok Build sends camelCase — `toolInput.command` under `toolName`
# `run_terminal_command` — read from a live grok 1.0.41 payload, and blocks on
# exit 2 the way Claude Code does.
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // .toolInput.command // .toolCall.args.CommandLine // empty')

# How this harness is told "no". Claude Code and Codex read exit 2 with the
# message on stderr; Antigravity reads a JSON decision on stdout and ignores the
# exit code. A pass stays silent on every harness: `{"decision":"allow"}` would
# auto-approve the call and bypass the permission prompt, which is not what a
# gate that found nothing should do.
ANTIGRAVITY=$(echo "$INPUT" | jq -r 'if .toolCall then "1" else "" end')

deny() {
  if [ -n "$ANTIGRAVITY" ]; then
    jq -nc --arg r "$1" '{decision:"deny",reason:$r}'
    exit 0
  fi
  printf '%s\n' "$1" >&2
  exit 2
}

[ -z "$COMMAND" ] && exit 0

block_self_kill() {
  local headline="$1"
  local mechanism="$2"
  local verb="$3"
  local _msg=""
  # The heredoc is read into a variable, not run inside "$(…)": bash 3.2 (the
  # macOS default) mis-parses a $(…) whose heredoc body holds an unmatched
  # quote or parenthesis, and the whole script then fails to parse.
  IFS= read -r -d '' _msg <<MSG || true
BLOCKED: $headline

$mechanism

A mistake made on many separate days is mechanized, so this one is.

Kill by something that is not a substring of your own command instead:
  own group   kill -- -"\$PGID"         # of a process you launched with setsid
  exact name  pkill -x node_exporter   # -x, not -f: matches comm, not cmdline
                                       # NEVER with the name \`claude\` — see (i)
  by pid      kill "\$PID"              # pid captured when you spawned it
  a unit      systemctl --user stop <unit>
  bracket     pgrep -f "[r]unTR" | xargs -r kill
              # the ERE [r]unTR does not match the literal "[r]unTR" in your
              # own cmdline, so the shell excludes itself. This guard still
              # blocks the shape — it cannot verify the trick — but it is the
              # one-line fix if you script it.

If you genuinely need pattern-matching, put the $verb inside a script file and
run the script — the shell's cmdline is then the script path, not the pattern.
WRITE THAT SCRIPT WITH THE Write TOOL, not a Bash heredoc: this guard is
line-oriented, so a heredoc line CONTAINING the pattern re-trips it. Then run
  bash /tmp/cleanup.sh

Command:
  $COMMAND
MSG
  deny "${_msg%$'\n'}"
}

block_port_kill() {
  deny "$(cat <<MSG
BLOCKED: a kill by port kills whatever holds the port, not the server you started.

On a shared host the port is not always yours: \`fuser -k 8791/tcp\` kills
whatever other service listens on 8791. A port number says nothing about
which process answers on it, so this guard refuses \`fuser -k\`,
\`lsof … | xargs kill\`, \`kill \$(lsof …)\` and \`kill-port\` at a command
position.

Stop the server by the process group you launched it in instead:
  setsid npm run dev > /tmp/dev.log 2>&1 &
  PGID=\$!                               # setsid makes the child its group leader
  …
  kill -- -"\$PGID"                       # ends the server and everything it spawned
Or by its pid (\`kill "\$PID"\`), or its unit (\`systemctl --user stop <unit>\`).
To see who holds a port without killing it: \`fuser 3000/tcp\`, \`ss -ltnp\`.

Command:
  $COMMAND
MSG
)"
}

block_kill_claude() {
  local _msg=""
  IFS= read -r -d '' _msg <<MSG || true
BLOCKED: killing a session-hosting process ends THIS session.

Two names are guarded: \`claude\`, and \`t3code\` — the T3 Code server, whose child processes
are every live T3 thread's agent, so one kill ends all of them including the
one that typed the command.

The Claude Code session running this command is itself a process named
\`claude\`. Every matcher reaches it — \`-x claude\` matches its comm, \`-f claude\`
matches its cmdline, and a bare \`pkill claude\` matches its comm too. Listing
first does not help either: \`kill \$(pgrep -x claude)\` and
\`ps aux | grep claude | awk '{print \$2}' | xargs kill\` are the same kill in
two steps, and this guard blocks those too. No form of a name-matched kill on
\`claude\` spares the session.

A name-matched kill of \`claude\` ends the session mid-task, and any background
run it was waiting on hangs on dead children and loses its in-flight results.

Same hazard as the systemctl guard, which covers t3code but not the kill
family.

Several sessions run as \`claude\` on this host at once, and "pick the right one
from the list" is the judgment call that goes wrong. Identify
the one you mean deterministically instead:
  a unit      systemctl --user stop <specific-unit>.service
              a remote session is its own scope, my-session-<n>.service —
              stop THAT unit, never the whole set. \`systemctl --user
              list-units 'my-session-*'\` names them.
  by pid      kill "\$PID"          # a pid you captured when YOU spawned it
  never this  ps -o ppid= -p \$\$     # your own session's claude pid.
                                   # Every other pid in the list belongs to a
                                   # DIFFERENT live session, not to junk.

If this session does not already authorize ending every session,
ask the user in prose and wait for the answer first. State that this ends
THIS session too. Reuse authorization already given; do not ask again.
The hook cannot see conversational approval and still blocks the literal
command. Use its recorded-script route: use the Write tool to write the
authorized command into a script file, record the authorization as a comment at the top with its date
and how it was given, then run the script. This route needs that actual
authorization; the comment does not grant it.

Command:
  $COMMAND
MSG
  deny "${_msg%$'\n'}"
}

block() {
  local trigger="$1"
  local reason="$2"
  local _msg=""
  IFS= read -r -d '' _msg <<MSG || true
BLOCKED: command matches "$trigger" — host-infra change requires user authorization.

$reason
  Diagnose freely (read-only). Propose freely (text-only).
  Treatment requires authorization.

If this session does not already authorize this change,
ask the user in prose and wait BEFORE executing. Describe:
  - verbatim commands you intend to run
  - host name + affected containers/services
  - rollback procedure

Reuse authorization already given; do not ask again.
This hook cannot see that approval and will
re-block the literal command. The sanctioned route — handing the command back
to the user is not an option — is:
  1. write the command into a script file with the Write tool,
  2. record the authorization as a comment at the top of that script, naming
     the date and how it was given ("Authorized by <name> <date> in
     chat"),
  3. run the script.
The comment is what makes the approval auditable later; the script file is what
makes it executable now.

Command:
  $COMMAND
MSG
  deny "${_msg%$'\n'}"
}

# ── Prose-vs-command scrubbing (shared by (a) (b) (b') (d) (e)) ──────────────
#
# The single largest false-positive class this gate produced was text that
# merely NAMES a protected path or a privileged command: a journal entry
# appended by heredoc whose prose contains /etc/ and /root/, a
# `journalctl … | grep "systemd-networkd…"` whose PATTERN holds a daemon-config
# keyword, and a `git commit -F -` whose message describes this very
# false-positive class and so blocks the commit that fixes it.
#
# SCRUBBED is $COMMAND with those prose regions blanked. It is used ONLY by the
# host-infra triggers (a) (b) (b') (d) (e). The kill-family triggers (g) (h) (i)
# and the session-service trigger (f) keep reading the RAW command: their quote
# handling is deliberate and documented at the cmd_pos comment below, and
# scrubbing there would regress the journal-grep pass case they were built for.
#
# The split is by what the quoted/heredoc text IS, never by the fact that it is
# quoted. A quoted string that is a command payload to an executing wrapper
# (ssh, sudo, sh -c, bash -c, env, docker exec, nohup, setsid) is a COMMAND and
# is left intact — `ssh host "sudo sh -c 'echo x > /etc/hosts'"` carries a real
# write inside quotes. Anything that cannot be classified is left intact too:
# unknown is not prose, and this gate fails closed.

scrub_prose() {
  # Pass 1 — heredoc bodies. A heredoc body is stripped only when its
  # introducing command is a known non-executing SINK, and (for `cat > FILE`)
  # the file being written is not a shell script. That second condition is
  # load-bearing: `cat > /tmp/fix.sh <<'S' … ssh h "sudo … >> /root/.ssh/…" … S`
  # followed by `bash /tmp/fix.sh` is a GENUINE root-credential write, and
  # stripping its body would pass it.
  awk '
    BEGIN { indoc = 0; delim = "" }
    {
      if (indoc) {
        # Verbatim, or equal once both sides are trimmed: ending the blanked
        # region early only means more of the command gets checked.
        t = $0; sub(/^[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t)
        if ($0 == delim || t == tdelim) { indoc = 0; print $0 }
        else print ""
        next
      }
      # Not a here-string (<<<), and a quoted delimiter is the whole quoted
      # word: <<'"'"'END-TEXT'"'"' closes at END-TEXT, never at END.
      if (match($0, /(^|[^<])<<-?[[:space:]]*("[^"]+"|'"'"'[^'"'"']+'"'"'|[A-Za-z_][A-Za-z0-9_]*)/)) {
        tag = substr($0, RSTART, RLENGTH)
        sub(/^[^<]?<<-?[[:space:]]*/, "", tag)
        gsub(/["'"'"']/, "", tag)
        if (strippable($0)) {
          delim = tag; indoc = 1
          tdelim = tag; sub(/^[[:space:]]+/, "", tdelim); sub(/[[:space:]]+$/, "", tdelim)
        }
      }
      print $0
    }
    # A commit or tag MESSAGE is prose by definition — it is never executed.
    function strippable(l,   tgt) {
      if (l ~ /(^|[;&|(])[[:space:]]*git[[:space:]]/ && l ~ /[[:space:]](commit|tag)([[:space:]]|$)/) return 1
      if (match(l, /cat[[:space:]]*>>?[[:space:]]*[^[:space:];&|<>]+/)) {
        tgt = substr(l, RSTART, RLENGTH)
        sub(/^cat[[:space:]]*>>?[[:space:]]*/, "", tgt)
        if (tgt ~ /\.(sh|bash|zsh|ksh)$/) return 0
        return 1
      }
      if (l ~ /(^|[;&|(])[[:space:]]*(jq|grep|sed|awk)[[:space:]]/) return 1
      return 0
    }
  ' <<<"$1" |
  # Pass 2 — quoted arguments to non-executing TEXT commands. `grep -iE "…"`,
  # `sed -n '…'`, `jq '…'`, `awk '…'`, and `echo`/`printf` WITHOUT a redirect
  # take patterns and literals, not commands. echo/printf are excluded the
  # moment the segment carries a redirect, because `echo x > /etc/hosts` is a
  # real write and must keep blocking.
  awk '
    {
      line = $0; out = ""; i = 1; n = length(line); seg = ""
      while (i <= n) {
        c = substr(line, i, 1)
        if (c == "\"" || c == "'"'"'") {
          # find the closing quote of the same kind
          j = i + 1
          while (j <= n && substr(line, j, 1) != c) j++
          span = substr(line, i, j - i + 1)
          if (prose_sink(seg)) out = out c c        # blank the span, keep quotes
          else out = out span
          seg = seg " "
          i = j + 1
          continue
        }
        if (index(";&|(", c)) seg = ""; else seg = seg c
        out = out c
        i++
      }
      print out
    }
    function prose_sink(s) {
      # a redirect in this segment disqualifies echo/printf — that is a write
      if (s ~ />/) return 0
      # A commit or tag MESSAGE is prose by definition: git never executes it.
      # A message describing this false-positive class would otherwise trip
      # trigger (a) on its own two words.
      if (s ~ /(^|[[:space:]])git([[:space:]]|$)/ && s ~ /[[:space:]](commit|tag)([[:space:]]|$)/) return 1
      if (s ~ /(^|[[:space:]])(grep|egrep|fgrep|rg|jq|awk)([[:space:]]|$)/) return 1
      if (s ~ /(^|[[:space:]])sed[[:space:]]+-n([[:space:]]|$)/) return 1
      if (s ~ /(^|[[:space:]])(echo|printf)([[:space:]]|$)/) return 1
      return 0
    }
  '
}

SCRUBBED=$(scrub_prose "$COMMAND")

# ── Read-only allowlist for trigger (a) ─────────────────────────────────────
#
# The block message says "Diagnose freely (read-only). Propose freely
# (text-only). Treatment requires authorization."
# This allowlist is what makes the first sentence true of the mechanism. It is
# a PASS list, never a block list — an unrecognized binary, an inner command
# that has to be computed, or anything with a write redirect BLOCKS. Every
# entry below is a read that real diagnosis needs, not a speculative one.

# A redirect that WRITES something. `2>&1`, `>&2` and `>/dev/null` are not
# writes to the host and appear in nearly every diagnostic command.
writes_via_redirect() {
  grep -qE '>>?[[:space:]]*(/dev/null|&[0-9-])' <<<"$1" && {
    # strip the benign ones, then look for any remaining redirect
    local rest
    rest=$(sed -E 's/>>?[[:space:]]*(\/dev\/null|&[0-9-])//g' <<<"$1")
    grep -qE '>>?[[:space:]]*[^[:space:]]' <<<"$rest" && return 0
    return 1
  }
  grep -qE '>>?[[:space:]]*[^[:space:]]' <<<"$1"
}

# ── Trigger (a) pre-screen: does a `sudo` run inside an `ssh` payload? ───────
#
# This CANNOT be a regex, and two review rounds proved it. The original
# `\bssh\b[^|;&]*\bsudo\b` demanded no `;`, `&` or `|` between the two words —
# but those are exactly what a remote payload contains, so
# `ssh nas "cd /tmp; sudo systemctl restart docker"` matched nothing and no
# later trigger caught it either. Patching it with a
# quoted-payload alternative `["'][^"']*` then failed on the FIRST nested quote,
# because a character class cannot track quote state — `ssh h "echo 'a;b';
# sudo systemctl restart docker"` walked straight through.
#
# So do the thing the regex was approximating: split the command on UNQUOTED
# separators only, and ask whether any resulting segment contains an `ssh`
# followed by a `sudo`. A `;` inside quotes is payload, not a separator.
#
# This is also what keeps a LOCAL sudo — which the rule explicitly permits —
# from being dragged in: `ssh host uptime; sudo apt update` splits into two
# segments, neither of which holds both words.
ssh_payload_has_sudo() {
  awk '
    # Whole input as ONE record: a quoted payload can span newlines, and
    # resetting quote state per line would lose track of it.
    BEGIN { RS = "\0" }
    {
      line = $0; n = length(line); i = 1; q = ""; ansi = 0; seg = ""
      while (i <= n) {
        c = substr(line, i, 1)
        # NOTE: no apostrophes anywhere in these awk comments — this program is
        # a bash single-quoted string, so one would end it mid-parse.
        #
        # A backslash escapes the next character when unquoted, inside double
        # quotes, and inside an ANSI-C string — but NOT inside a plain single
        # quote, where the shell treats it literally. Without the double-quote
        # case, the escaped quote in
        #   ssh h "echo \"a;b\"; sudo systemctl restart docker"
        # closed the payload early, the semicolon read as a real separator, and
        # the remote sudo landed in a segment with no ssh — fail-open.
        if (c == "\\" && (q == "" || q == "\"" || ansi)) {
          seg = seg c substr(line, i + 1, 1); i += 2; continue
        }
        if (q != "") { seg = seg c; if (c == q) { q = ""; ansi = 0 } i++; continue }
        # ANSI-C quoting — the dollar-single-quote form — DOES honour a
        # backslash-escaped quote, unlike a plain single quote. Treating the two
        # the same let an ANSI-C payload split before its own sudo and pass.
        if (c == "$" && substr(line, i + 1, 1) == "'"'"'") {
          q = "'"'"'"; ansi = 1; seg = seg c "'"'"'"; i += 2; continue
        }
        if (c == "\"" || c == "'"'"'") { q = c; ansi = 0; seg = seg c; i++; continue }
        if (c == ";" || c == "&" || c == "|") { emit(seg); seg = ""; i++; continue }
        seg = seg c; i++
      }
      emit(seg)
    }
    # `ssh` must come BEFORE the `sudo` it carries. `sudo ssh host uptime` is a
    # local sudo whose argument happens to be ssh, not a remote sudo.
    function emit(s,   si, ui) {
      si = match(s, /(^|[^[:alnum:]_.-])ssh([[:space:]]|$)/)
      if (si == 0) return
      ui = match(substr(s, si), /(^|[^[:alnum:]_.-])sudo([[:space:]]|$)/)
      if (ui > 0) found = 1
    }
    END { exit found ? 0 : 1 }
  ' <<<"$1"
}

# sqlite3 is a read only when ALL of these hold. Without -readonly, sqlite3 opens
# the database read/write and CREATES the file if the path is wrong; under sudo
# that is a host write. ~6 measured false positives use `docker exec … sqlite3
# <db> "SELECT …"` with no -readonly and still block. That is the right outcome:
# the remedy is one word at the call site. -readonly is checked on the SEGMENT
# ($1): it must be on this invocation, not merely somewhere in the command. The
# SQL is read on the full text ($2), since a quoted body spans newlines.
# -readonly protects the database and nothing else: the CLI's writefile() and
# edit() write files, load_extension() loads code, -cmd/-init run dot-commands,
# and .shell/.system run commands while .output/.once/.save/.backup/.import
# write, so each of them fails the read.
sqlite_read_ok() {
  local c="$1" full="$2"
  grep -qE '(^|[[:space:]])-readonly([[:space:]"'"'"']|$)' <<<"$c" || return 1
  grep -qiE '\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|REPLACE|TRUNCATE|VACUUM)\b' <<<"$full" && return 1
  grep -qiE '\bPRAGMA\b' <<<"$full" && return 1
  grep -qiE '\b(writefile|edit|load_extension)[[:space:]]*\(' <<<"$full" && return 1
  grep -qE '(^|[[:space:]])-(cmd|init)([[:space:]]|=|$)' <<<"$full" && return 1
  grep -qE '(^|[[:space:]"'"'"'])\.(shell|system|output|once|save|backup|import|load|excel|open|read|restore|cd|log)\b' <<<"$full" && return 1
  grep -qiE '\bSELECT\b' <<<"$full" || return 1
  return 0
}

# Is a single sudo-invoked command read-only? Fail closed: the default is no.
#
# $2 is the FULL command text. Two checks below deliberately read it rather
# than the segment: a quoted SQL body routinely spans newlines, and segment
# extraction stops at a newline, so a multi-line `SELECT` would otherwise look
# like a sqlite3 call with no verb at all (a multi-table join does). Widening the WRITE-keyword scan to the full text can only ever block
# more, never less.
readonly_sudo_cmd() {
  local c="$1"
  local full="${2:-$1}"
  # A segment routinely ends at a closing quote rather than whitespace
  # (`ssh nas2 "sudo midclt call alert.list"`), so every terminator below
  # accepts a quote as well as a space or end-of-string; otherwise a read
  # blocks purely on its trailing `"`.
  local T='([[:space:]"'"'"']|$)'

  # A write redirect anywhere in the segment disqualifies it outright.
  writes_via_redirect "$c" && return 1
  # `tee` writes by definition, even when its output is also piped onward.
  grep -qE '(^|[[:space:]|])tee([[:space:]]|$)' <<<"$c" && return 1

  # Dispatch on the command NAME at the head of the segment, never on the name
  # appearing anywhere in it. Matching anywhere is how `sudo journalctl -u
  # docker` took the docker branch and blocked: `docker` was the unit name, not
  # the binary. Leading env assignments and timing wrappers are skipped first so
  # `sudo timeout 20 zpool status` still resolves to `zpool`.
  # `norm` is the segment with those wrappers REMOVED, so it starts at the real
  # command. Every `^`-anchored verb test below matches against `norm`, never
  # `$c` — anchoring on the raw segment made `sudo timeout 20 zpool status`
  # block while `head` correctly said `zpool`, i.e. the comment above claimed a
  # normalization the matching did not use.
  local norm head
  norm=$(sed -E \
    -e 's/^[[:space:]]*//' \
    -e ':w' \
    -e 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|timeout[[:space:]]+[0-9smhd.]+|env|nice|ionice|command|stdbuf[[:space:]]+-[^[:space:]]+)[[:space:]]+//' \
    -e 'tw' \
    <<<"$c")
  head=${norm%%[[:space:]]*}
  head=${head##*/}          # /usr/bin/zpool and ./zpool are the same binary
  head=${head%%[\"\']*}     # a name flush against a closing quote

  # The arguments after the command name, one per element, quotes removed and
  # redirect tokens (`2>&1`, `>/dev/null`) dropped: the per-command option
  # rules below read these. A NAME is never enough on its own: `sort -o`,
  # `uniq IN OUT`, `date --set`, `hostname NAME`, `rg --pre` and
  # `awk 'BEGIN{system(...)}'` all passed as "diagnosis" while their names
  # sat on the plain list below.
  local -a args=()
  local a
  read -r -a args <<<"${norm#"${norm%%[[:space:]]*}"}"
  # A bare redirect operator (`2>`, `>>`, `&>`) takes the NEXT token as its
  # target, so that token is dropped too: `uniq in 2> /dev/null` has one operand.
  local -a kept=()
  local skipnext=0
  for a in ${args[@]+"${args[@]}"}; do
    a=${a//[\"\']/}
    if (( skipnext )); then skipnext=0; continue; fi
    if [[ "$a" =~ ^([0-9]*[\<\>]{1,2}\&?|\&\>{1,2})$ ]]; then skipnext=1; continue; fi
    [[ -z "$a" || "$a" =~ ^[0-9]*[\<\>]|^\&\> ]] && continue
    kept+=("$a")
  done
  args=(${kept[@]+"${kept[@]}"})

  # sqlite3 — the rule lives in sqlite_read_ok, shared with the container route.
  if [[ "$head" == "sqlite3" ]] ; then
    sqlite_read_ok "$c" "$full"
    return
  fi

  # docker — read verbs only, anchored at the command (a read verb that is
  # merely an ARGUMENT, as in `docker rm -f x docker ps`, is not a read). exec
  # hands its INNER command back to this same function, so a container gets
  # exactly the option rules a direct command gets: the container route once
  # kept its own shorter list, and `env touch`, `sed --in-place` and every
  # option-level write passed there while the direct route refused them.
  # `sh -c` / `bash -c` stay unlisted, because an unparsed payload cannot be
  # cleared.
  if [[ "$head" == "docker" ]] ; then
    grep -qE "^docker[[:space:]]+(ps|logs|inspect|images|version|info|top|port|stats|diff)${T}" <<<"$norm" && return 0
    local inner
    inner=$(sed -nE 's/^docker[[:space:]]+exec([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^[:space:]-][^[:space:]]*[[:space:]]+//p' <<<"$norm")
    [[ -n "$inner" ]] || return 1
    readonly_sudo_cmd "$inner" "$full"
    return
  fi

  # zpool / zfs — status and list read; everything else mutates a pool.
  if [[ "$head" == "zpool" || "$head" == "zfs" ]] ; then
    grep -qE "^[^[:space:]]+[[:space:]]+(status|list|get|history|iostat)${T}" <<<"$norm" && return 0
    return 1
  fi

  # smartctl — information flags only. -t starts a self-test, which writes to
  # the drive's own log and is a host action, so it is deliberately absent;
  # -s/-o/-S switch SMART, offline testing and attribute autosave. A long
  # option passes only from the read list: `--smart=off` beside `-a` disabled
  # SMART while the -a satisfied the check.
  if [[ "$head" == "smartctl" ]] ; then
    grep -qE '(^|[[:space:]])-[a-zA-Z]*[tXsoS]' <<<"$c" && return 1
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" == --* ]] || continue
      [[ "$a" =~ ^--(all|xall|health|info|attributes|capabilities|log|json|device|scan|scan-open|identify|format|quietmode|tolerance|badsum|report|nocheck|get|help|version|license)(=|$) ]] || return 1
    done
    grep -qE "(^|[[:space:]])-(a|H|l|i|A|x|c)${T}" <<<"$c" && return 0
    return 1
  fi

  # midclt — the TrueNAS middleware CLI. Read namespaces only.
  if [[ "$head" == "midclt" ]] ; then
    grep -qE "^midclt[[:space:]]+call[[:space:]]+[a-z_.]+\.(list|query|config|get_instance)${T}" <<<"$norm" && return 0
    return 1
  fi

  # journalctl — READ options only. --vacuum-size/-time/-files, --rotate,
  # --flush, --sync, --relinquish-var and --setup-keys all mutate persistent
  # journal state on the host, and --cursor-file writes the file it names, so
  # any of them blocks.
  if [[ "$head" == "journalctl" ]] ; then
    grep -qE '(^|[[:space:]])--(vacuum-[a-z]+|rotate|flush|sync|relinquish-var|setup-keys|update-catalog|cursor-file)([[:space:]]|=|$)' <<<"$c" && return 1
    return 0
  fi

  # systemctl — read verbs only. Every mutate verb stays with trigger (d)/(f).
  if [[ "$head" == "systemctl" ]] ; then
    grep -qE "^systemctl([[:space:]]+--[a-z-]+)*[[:space:]]+(show|status|is-enabled|is-active|is-failed|list-units|list-timers|list-unit-files|cat|get-default)${T}" <<<"$norm" && return 0
    return 1
  fi

  # ipmitool — `mc info`, `sensor list`, `chassis status` and `sdr` read.
  # `lan print` exposes BMC network config and `lan set` changes it; neither is
  # on the list. `sdr dump FILE` writes FILE and `sdr fill` writes the SDR.
  if [[ "$head" == "ipmitool" ]] ; then
    [[ "${args[0]:-}" == "sdr" && "${args[1]:-}" =~ ^(dump|fill)$ ]] && return 1
    grep -qE "^ipmitool[[:space:]]+(mc[[:space:]]+info|sensor[[:space:]]+list|sdr${T}|chassis[[:space:]]+status)" <<<"$norm" && return 0
    return 1
  fi

  # sed — read-only unless it edits in place (-i, --in-place, a cluster such as
  # -ni), runs a script file (-f), or its script holds a w/W (write) or e
  # (execute) command or s///w, s///e flag. `-n` alone was the old test, and
  # `sed -n -i s/a/b/ f` passed it. The script scan reads the full text, since a
  # script routinely crosses a separator the segment stops at.
  if [[ "$head" == "sed" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^-[A-Za-z]*[if]|^--(in-place|file) ]] && return 1
    done
    # Any character but a letter, `_` or `-` before the command letter, not only
    # `/`: an s command may use any delimiter (`s#a#b#w FILE`, `s|a|b|e`), and an
    # address may be a line number (`1e CMD`). `-` is excluded so `-e SCRIPT`
    # stays an option.
    grep -qE "[^A-Za-z_-][wWe]([[:space:]\"';}]|$)" <<<"$full" && return 1
    # An s command's flags, read with the delimiter it actually uses — any
    # character, `-` included (`s-a-b-w FILE`), matched by back-reference. A
    # backslash and the character after it are one unit, so an escaped
    # delimiter (`s-a-b\-w text-`) is text, not the end of a part. The pattern
    # is single-quoted: in double quotes bash turned `\\.` into `\.`, a literal
    # dot, and `s-a-b\n-w FILE` slipped through.
    local sre='s([^A-Za-z0-9[:space:]\\])([^\\]|\\.)*\1([^\\]|\\.)*\1[gpIiMm0-9]*([wW][[:space:]]|e([[:space:]"'"'"';}]|$))'
    grep -qE "$sre" <<<"$full" && return 1
    return 0
  fi

  # awk — a language, so its program decides. A system() call, getline from a
  # command (`"cmd" | getline`; getline from a file only reads), a coprocess, `print … >` / `print … |`, and @load/@include run or
  # write something; -f/-i/-l/-E load program text or code from elsewhere.
  # Scanned on the full text for the same reason as sed.
  if [[ "$head" == "awk" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^-[filE]|^--(file|include|load|exec) ]] && return 1
    done
    # gawk's indirect call (`f="system"; @f("cmd")`) names its function in a
    # string the scan cannot follow, so any `@name(` is treated as a write.
    # A backslash-newline joins two lines of the program, so the scan reads it
    # joined: `| \<newline> getline` is still a command piped into getline.
    local joined="${full//$'\\\n'/ }"
    grep -qE 'system[[:space:]]*\(|\|[[:space:]]*getline|\|&|@(load|include)|@[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(|printf?[^;}]*[|>]' <<<"$joined" && return 1
    return 0
  fi

  # sort — -o/--output writes, --compress-program runs a program.
  if [[ "$head" == "sort" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^-[A-Za-z]*o|^--(output|compress-program) ]] && return 1
    done
    return 0
  fi

  # uniq — a second file operand is the OUTPUT file.
  if [[ "$head" == "uniq" ]] ; then
    local n=0 skip=0
    for a in ${args[@]+"${args[@]}"}; do
      if (( skip )); then skip=0; continue; fi
      case "$a" in
        -f|-s|-w|--skip-fields|--skip-chars|--check-chars) skip=1 ;;
        -?*) ;;
        *) n=$((n + 1)) ;;
      esac
    done
    (( n <= 1 ))
    return
  fi

  # date — -s/--set sets the clock, and so does a bare MMDDhhmm[[CC]YY][.ss]
  # operand (`date 110212002026`).
  if [[ "$head" == "date" ]] ; then
    local value=0
    for a in ${args[@]+"${args[@]}"}; do
      # The value of -d/-f/-r (`date -d 20261102`) is read, not set.
      if (( value )); then value=0; continue; fi
      [[ "$a" =~ ^-[uRI]*[dfr]$ ]] && { value=1; continue; }
      [[ "$a" =~ ^-[uR]*s|^--set ]] && return 1
      [[ "$a" =~ ^[0-9]{8}([0-9]{2}|[0-9]{4})?(\.[0-9]{2})?$ ]] && return 1
    done
    return 0
  fi

  # hostname — any operand, -F/--file and -b/--boot SET the name; only the
  # display options read.
  if [[ "$head" == "hostname" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^-[sfdiIAayn]+$|^--(short|fqdn|long|domain|ip-address|ip-addresses|all-ip-addresses|all-fqdns|alias|nis|yp)$ ]] || return 1
    done
    return 0
  fi

  # rg — --pre runs a preprocessor per file; --hostname-bin runs a program.
  if [[ "$head" == "rg" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^--(pre|hostname-bin)(=|$) ]] && return 1
    done
    return 0
  fi

  # file — -C compiles a magic file, writing the result.
  if [[ "$head" == "file" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^-[A-Za-z]*C|^--compile ]] && return 1
    done
    return 0
  fi

  # pvecm — status and nodes read; add, delnode, expected, updatecerts change
  # the cluster.
  if [[ "$head" == "pvecm" ]] ; then
    [[ "${args[0]:-}" =~ ^(status|nodes)$ ]]
    return
  fi

  # nvidia-smi — query and list options only. Its setters (-pm, -pl, -r, -c,
  # -ac, -lgc, …) change GPU state, and -f writes a log file.
  if [[ "$head" == "nvidia-smi" ]] ; then
    local prev=""
    for a in ${args[@]+"${args[@]}"}; do
      if [[ "$prev" =~ ^-(i|d|l|lms)$ ]]; then prev=""; continue; fi
      [[ "$a" =~ ^(-q|--query|-L|--list-gpus|-x|--xml-format|-i|-d|-l|-lms|-u|-h|--help|--query-[a-z-]+=.*|--format=.*|--id=.*|--display=.*|--loop=.*|--loop-ms=.*|dmon|pmon|topo|-m)$ ]] || return 1
      prev="$a"
    done
    return 0
  fi

  # nc — reads only as a port probe (-z), and never with -e/-c, which run a
  # program on connect.
  if [[ "$head" == "nc" ]] ; then
    for a in ${args[@]+"${args[@]}"}; do
      [[ "$a" =~ ^-[A-Za-z]*[ec]|^--(exec|sh-exec|lua-exec) ]] && return 1
    done
    grep -qE '^nc[[:space:]]+(-[a-zA-Z]*z)' <<<"$norm" && return 0
    return 1
  fi

  # env — bare, it lists the environment. With a command it RUNS that command,
  # which the wrapper strip above already resolved to its own name.
  if [[ "$head" == "env" ]] ; then
    (( ${#args[@]} == 0 ))
    return
  fi

  # Plain text/inspection binaries — no option of these writes or runs
  # anything, so their arguments are free.
  case "$head" in
    grep|egrep|fgrep|ls|cat|head|tail|getent|ping|dig|host|uptime|df|du|\
free|wc|stat|readlink|realpath|lsblk|blkid|uname|id|which|tr|cut|md5sum|sha256sum)
      return 0 ;;
  esac

  # Anything else: unrecognized, therefore blocked.
  return 1
}

# Every sudo-invoked segment in the command must be read-only for the command
# to pass trigger (a). One unrecognized segment blocks the whole command —
# the max case: a chain mixing a read with a write is a write.
all_sudo_segments_readonly() {
  local text="$1" seg
  local -a segs=()
  # From each `sudo` token to the next unquoted separator. Truncation at a
  # separator is safe: classification keys on the command NAME, which is the
  # first token after sudo and its flags.
  while IFS= read -r seg; do
    [ -n "$seg" ] && segs+=("$seg")
  done < <(grep -oE '\bsudo\b([[:space:]]+-[a-zA-Z-]+)*[[:space:]]+[^;&|]*' <<<"$text" || true)

  # No sudo segment could be extracted, yet the trigger matched — the two words
  # are arranged in a way this parser cannot read. Fail closed.
  [ "${#segs[@]}" -eq 0 ] && return 1

  for seg in ${segs[@]+"${segs[@]}"}; do
    # Drop the `sudo` token and its own flags to expose the real command.
    local inner
    inner=$(sed -E 's/^[[:space:]]*sudo([[:space:]]+-[a-zA-Z-]+)*[[:space:]]+//' <<<"$seg")
    readonly_sudo_cmd "$inner" "$text" || return 1
  done
  return 0
}

# ── Trigger (d) helper: is this an enable of a unit already under
#    ~/.config/systemd/user/ ? ────────────────────────────────────────────────
#
# The rule exempts `~/.config/systemd/user/` by name. Four conditions, ALL
# required, and the fourth is what keeps this fail-closed: the unit's resolved
# target must sit in one of exactly two roots — that directory itself, or a
# checkout of this repo. The legitimate case symlinks
# nightly-report.timer from apps/<app>/systemd/ into
# ~/.config/systemd/user/, so the target IS a repo path by design, and repo
# paths are in scope for autonomous work under the rule's own carve-out. A
# denylist of protected roots was considered and rejected: it would still pass
# /opt, /srv, /run or another user's home.
# resolve_link <path> — the path with every symlink followed and the directory
# resolved physically; empty when it does not exist. `realpath` is not on every
# macOS, so this walks readlink itself.
resolve_link() {
  local p="$1" n=0 l
  while [ -L "$p" ] && [ "$n" -lt 40 ]; do
    l=$(readlink "$p")
    case "$l" in /*) p="$l" ;; *) p="$(dirname "$p")/$l" ;; esac
    n=$((n + 1))
  done
  [ -e "$p" ] || return 0
  printf '%s/%s\n' "$(cd "$(dirname "$p")" && pwd -P)" "$(basename "$p")"
}

# same_repo <path> <common> — <path> sits in a work tree of the repo whose git
# common dir (physical) is <common>: its main checkout or any linked worktree,
# wherever the worktree lives. Never a path inside a .git directory.
same_repo() {
  local d c
  [ -n "$2" ] || return 1
  d=$(dirname "$1")
  [ "$(git -C "$d" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || return 1
  c=$(git -C "$d" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$c" in /*) ;; *) c="$d/$c" ;; esac
  c=$(cd "$c" 2>/dev/null && pwd -P) || return 1
  [ "$c" = "$2" ]
}

user_unit_enable_ok() {
  local text="$1"
  local unit_dir="$HOME/.config/systemd/user"
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null || true)
  [ -z "$common" ] || common=$(cd "$common" 2>/dev/null && pwd -P || true)

  # 1. --user scope is mandatory; a system-scope enable never passes here.
  grep -qE '\bsystemctl\b([[:space:]]+--[a-z-]+)*[[:space:]]+--user\b|\bsystemctl[[:space:]]+--user\b' <<<"$text" || return 1

  # 3. The unit must be a literal in the command text. A name built from a
  #    variable or a substitution cannot be inspected, so it cannot be cleared.
  #
  #    `systemctl enable` takes a LIST, and every operand in it is enabled. An
  #    earlier version captured one trailing token, so
  #    `systemctl --user enable allowed.timer other.timer` was cleared on
  #    `allowed.timer` alone and `other.timer` was never resolved at all —
  #    the max case: one unchecked operand in a chain is the whole chain
  #    unchecked. Capture the full operand list, then check each.
  local tails
  tails=$(grep -oE '\bsystemctl\b([[:space:]]+--[a-z-]+)*[[:space:]]+enable([[:space:]]+--[a-z-]+)*[[:space:]]+[^;&|]*' <<<"$text" || true)
  [ -z "$tails" ] && return 1

  local line unit target rest seen=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Drop `systemctl`, its flags, `enable`, and enable's own flags; what
    # remains is the operand list.
    rest=$(sed -E 's/^[[:space:]]*systemctl([[:space:]]+--[a-z-]+)*[[:space:]]+enable([[:space:]]+--[a-z-]+)*[[:space:]]*//' <<<"$line")
    # Strip redirections before treating what is left as unit names. Without
    # this, `systemctl --user enable foo.timer 2>&1` read `2>&1` as a second
    # unit, failed to find it under ~/.config/systemd/user/, and blocked the
    # exact false positive this carve-out exists for. A redirect
    # TARGET is not a unit; a redirect that writes a protected path is still
    # caught by trigger (b), which reads the whole command.
    # The target is OPTIONAL (`*`, not `+`): the operand capture above stops at
    # `;`, `&` or `|`, so `… enable foo.timer 2>&1; echo x` arrives here as
    # `foo.timer 2>` with the `&1` already cut off. Requiring a target left the
    # bare `2>` behind, and it was then looked up as a unit name.
    rest=$(sed -E -e 's/[[:space:]]*[0-9]*>>?[[:space:]]*[^[:space:]]*//g' \
                  -e 's/[[:space:]]*[0-9]*<[[:space:]]*[^[:space:]]*//g' <<<"$rest")
    for unit in $rest; do
      case "$unit" in
        --*) continue ;;                    # a trailing flag, not a unit
        *'$'*|*'`'*|'"'*|"'"*|*'*'*|*'?'*|*'['*) return 1 ;;  # computed or glob — fail closed
      esac
      seen=$((seen + 1))

      # 2. The unit must already exist in the user unit directory. Enabling a
      #    unit that is not there yet means something else is about to place
      #    it, and this hook cannot see what.
      [ -e "$unit_dir/$unit" ] || [ -L "$unit_dir/$unit" ] || return 1

      # 4. The allowed roots, resolved. Anything else blocks. The trailing
      #    slash on each pattern is load-bearing: without it a root would also
      #    prefix-match a sibling named `<root>-evil/...`. The workbench is the
      #    main checkout of the repo this session is in AND every worktree of
      #    it, wherever the worktree lives: the target's own git common dir is
      #    compared with this session's, never a path prefix, which a
      #    worktree outside the checkout would miss.
      target=$(resolve_link "$unit_dir/$unit")
      [ -n "$target" ] || return 1
      case "$target" in
        "$unit_dir"/*) ;;
        "$HOME"/.claude/worktrees/*) ;;
        *) same_repo "$target" "$common" || return 1 ;;
      esac
    done
  done <<<"$tails"

  # No operand was actually examined — the enable exists but its units could not
  # be read out of the text. Fail closed.
  [ "$seen" -gt 0 ] || return 1
  return 0
}

# Command-position anchor shared by (g) (h) (i): start of string, or after
# ; & | ( or a backtick — so a command that merely MENTIONS one of these words
# inside a quoted argument (`grep -rn 'pkill -f' journal/*.md`) is not a match.
# The backtick covers legacy command substitution (PIDS=`pgrep -f x`; kill …).
# Quote characters are deliberately NOT in this class: adding them would match
# the journal-grep pass case, which is the one false positive that would make
# the guard unusable for gathering its own evidence.
cmd_pos='(^|[;&|(`]|[[:space:]]&&[[:space:]]|[[:space:]]\|\|[[:space:]])[[:space:]]*'
# Optional absolute or relative path prefix — /usr/bin/pkill and ./pgrep reach
# the same binary and carry the same hazard as the bare name.
path_pfx='([^[:space:];&|(`]*/)?'
# Bounded wrapper allowlist — `sudo pkill -x claude` and `nohup pkill -f x` sit
# at a command position behind a prefix. An explicit list, never a generic
# `\w+[[:space:]]+`: a generic one would swallow `grep -rn ` and regress the
# journal-grep pass case. `ssh` is here because a remote pkill of `claude`
# ends sessions on the target host exactly as a local one does.
wrapper='((sudo|doas|env|nohup|command|exec|setsid|time|ssh)([[:space:]]+[^[:space:];&|(`]+)*[[:space:]]+)*'
# An f-bearing flag anywhere in the argument list, any order, including a
# combined short form (`-af`, `-9f`) and the long form. The optional
# `[^|;&]*[[:space:]]` lets earlier flags precede it without requiring them.
# A matched form is not necessarily a VALID invocation (`-9f` is not portable);
# the branch errs toward blocking suspicious kill-family commands.
f_flag='([^|;&]*[[:space:]])?(-[a-zA-Z0-9]*f|--full)([[:space:]]|=)'
# A session-fatal process name as a whole shell TOKEN, not a substring: the
# delimiter classes stop `claude` from matching inside `claude-helper`, which
# is an unrelated binary and belongs to (g)'s generic message instead.
# `t3code` is here because killing it ends sessions exactly as (f) says
# restarting its unit does. It is the T3 Code server: every T3 thread's agent runs as its child, so one kill ends
# all of them, including the thread that typed the command.
self_name='([^|;&]*[[:space:]"'"'"'])?(claude|t3code)([[:space:]"'"'"']|$)'
# The same names as a bare token ANYWHERE in the command, for the two-condition
# (i2) branch below where the name is an argument to a lister, not to the kill.
self_tok='([[:space:]"'"'"'(]|^)(claude|t3code)([[:space:]"'"'"')]|$)'

# --- (i) pkill / killall naming the session's own process — checked BEFORE (g)
#     so `pkill -f claude` gets the session-specific message rather than the
#     generic self-kill one. Any matcher, any order: `-x claude`, `-f claude`,
#     bare `pkill claude`. Whole-token match, so `pkill -f claude-helper`
#     (an unrelated binary) falls through to (g)'s generic message instead.
if grep -qE "${cmd_pos}${wrapper}${path_pfx}(pkill|killall)[[:space:]]${self_name}" \
    <<<"$COMMAND" ; then
  block_kill_claude
fi

# --- (i2) the two-step form of the same kill: a process LISTER naming the
#     session's own process, in a command that also kills. `kill $(pgrep -x
#     claude)`, `pgrep -x claude | xargs kill`, `kill -9 $(pidof claude)`,
#     `ps aux | grep claude | awk '{print $2}' | xargs kill`. Neither (i) nor
#     (h) reaches these — (i) names pkill/killall, (h) needs an f-bearing
#     pgrep. Three conditions, all required, so the read-only forms
#     (`pgrep -a -x claude`, `ps aux | grep claude`) still PASS.
if grep -qE "${cmd_pos}${wrapper}${path_pfx}(pgrep|pidof|ps)[[:space:]]" \
      <<<"$COMMAND" \
    && grep -qE "$self_tok" <<<"$COMMAND" \
    && grep -qE '\bkill\b' <<<"$COMMAND" ; then
  block_kill_claude
fi

# --- (g) pkill -f self-kill, at a command position.
if grep -qE "${cmd_pos}${wrapper}${path_pfx}pkill[[:space:]]${f_flag}" \
    <<<"$COMMAND" ; then
  # Quoted heredoc delimiter: the body is literal prose containing backticks
  # and $, which must not expand (and must not trip shellcheck SC2016).
  IFS= read -r -d '' mechanism <<'EOS' || true
The pattern you pass to -f is matched against every process command line,
INCLUDING the shell this command runs in — its cmdline literally contains the
pattern you just typed. pkill spares its own pid but not its parent, so the
shell dies on SIGTERM: exit 144, no output, and every subsequent command in
the chain silently never runs.
EOS
  mechanism="${mechanism%$'\n'}"
  block_self_kill 'pkill -f kills the shell running it.' "$mechanism" 'pkill'
fi

# --- (h) pgrep -f whose OUTPUT reaches a kill — same trap, second route.
#     Two conditions, and the first demands observable data flow, not mere
#     co-occurrence: the pgrep must sit inside a command substitution
#     (`$(pgrep -f x)`, backtick) or be piped onward (`pgrep -f x | xargs`).
#     Requiring only "a kill word somewhere" blocked genuinely safe commands —
#     `pgrep -f node > /tmp/kill-list.txt`, `kill "$PID"; pgrep -af astro`,
#     `pgrep -f astro || echo "nothing to kill"` — under a message that was
#     false for them. `[^|]` after the pipe keeps `||` from reading as one.
#     `\bkill\b` does not match inside `pkill` (both sides are word
#     characters), so (g) and (h) stay independent. A bare `pgrep -f` with no
#     kill PASSES — reading the pid list is not the hazard.
if { grep -qE "[\$\`]\(?[[:space:]]*${wrapper}${path_pfx}pgrep[[:space:]]${f_flag}" \
        <<<"$COMMAND" \
      || grep -qE "${cmd_pos}${wrapper}${path_pfx}pgrep[[:space:]]${f_flag}[^|;&]*\|[^|]" \
        <<<"$COMMAND" ; } \
    && grep -qE '\bkill\b' <<<"$COMMAND" ; then
  IFS= read -r -d '' mechanism <<'EOS' || true
pgrep -f matches its pattern against every process command line, INCLUDING the
shell this command runs in — whose cmdline contains the pattern you just typed.
pgrep alone is harmless, but its output list therefore carries your own shell's
pid, and the kill you feed it into kills that shell: exit 144, no output, and
every subsequent command in the chain silently never runs.

The shape is
  for p in $(pgrep -f runTR.sh); do kill "$p"; done
EOS
  mechanism="${mechanism%$'\n'}"
  block_self_kill 'pgrep -f feeding a kill kills the shell running it.' \
    "$mechanism" 'pgrep and the kill'
fi

# --- (j) a kill by port. Read on SCRUBBED, so a heredoc body or a quoted
#     grep/echo argument that NAMES the command (a journal line about a
#     past port kill) is prose, not a command; and anchored at a command
#     position, as (g) (h) (i) are. The forms are the ones sessions actually
#     used, widened to the flag orders a narrower match missed:
#     `fuser -k -n tcp 3000`, `-km`, `--kill`, `xargs -r kill`, an awk between lsof and
#     xargs, and a loop over `$(lsof …)` — which, like (h), needs the lsof in
#     a substitution AND a kill in the same command, so `lsof -ti:3000` alone
#     still passes.
# A command substitution runs wherever it sits, even inside the double quotes
# scrub_prose blanks as an echo's prose (`echo "$(fuser -k 8791/tcp)"`), so the
# substitution forms are read on a view of the raw command that drops only what
# bash never expands: single-quoted spans outside double quotes (a `'` inside
# "…" is a literal character, and `$(…)` beside it still runs) and the body of
# a heredoc whose delimiter is quoted (<<'EOF', <<"EOF"). An unquoted heredoc
# expands, so its body stays. Quote state carries across lines.
SUBST_VIEW=$(awk -v sq="'" -v dq='"' '
  BEGIN { q = ""; indoc = 0 }
  {
    line = $0
    if (indoc) {
      # Verbatim, or equal once both sides are trimmed (ending early is the safe side).
      t = line; sub(/^[\t ]+/, "", t); sub(/[\t ]+$/, "", t)
      if (line == delim || t == tdelim) { indoc = 0; print ""; next }
      print (lit ? "" : line); next
    }
    out = ""; n = length(line); pending = ""
    for (i = 1; i <= n; i++) {
      c = substr(line, i, 1)
      if (q == sq) { if (c == sq) q = ""; continue }
      if (c == "\\") { out = out c substr(line, i + 1, 1); i++; continue }
      if (q == dq) { if (c == dq) q = ""; out = out c; continue }
      if (c == sq) { q = sq; continue }
      if (c == dq) { q = dq; out = out c; continue }
      # A here-string (<<<) is one token: its second `<` is not a heredoc.
      if (substr(line, i, 3) == "<<<") { out = out "<<<"; i += 2; continue }
      if (substr(line, i, 2) == "<<") {
        # The delimiter is the whole next word, quotes removed; any quote in
        # it makes the body literal (bash: "If any part of word is quoted").
        j = i + 2
        if (substr(line, j, 1) == "-") j++
        while (substr(line, j, 1) == " " || substr(line, j, 1) == "\t") j++
        tag = ""; plit = 0
        while (j <= n) {
          d = substr(line, j, 1)
          if (d == sq || d == dq) {
            plit = 1
            k = index(substr(line, j + 1), d)
            if (k == 0) { tag = tag substr(line, j + 1); j = n + 1; break }
            tag = tag substr(line, j + 1, k - 1); j += k + 1; continue
          }
          if (index(" \t;&|<>()", d) > 0) break
          tag = tag d; j++
        }
        if (tag != "") pending = tag
        out = out substr(line, i, j - i); i = j - 1; continue
      }
      out = out c
    }
    print out
    if (pending != "") {
      indoc = 1; delim = pending; lit = plit
      tdelim = pending; sub(/^[\t ]+/, "", tdelim); sub(/[\t ]+$/, "", tdelim)
    }
  }' <<<"$COMMAND")
fuser_kill='fuser[[:space:]]([^|;&)`]*[[:space:]])?(-[a-zA-Z]*k|--kill)'
subst='[$`]\(?[[:space:]]*'
if grep -qE "${cmd_pos}${wrapper}${path_pfx}${fuser_kill}" <<<"$SCRUBBED" \
    || grep -qE "${subst}${wrapper}${path_pfx}${fuser_kill}" <<<"$SUBST_VIEW" \
    || grep -qE "${cmd_pos}${wrapper}${path_pfx}lsof[[:space:]][^;&]*\|[^;&]*xargs[[:space:]]([^|;&]*[[:space:]])?kill\b" <<<"$SCRUBBED" \
    || { grep -qE "${subst}${wrapper}${path_pfx}lsof[[:space:]]" <<<"$SUBST_VIEW" \
           && grep -qE '\bkill\b' <<<"$SUBST_VIEW" ; } \
    || grep -qE "${cmd_pos}${wrapper}${path_pfx}((npx|pnpx|bunx|pnpm|yarn)[[:space:]]+([^[:space:];&|]+[[:space:]]+)*)?kill-port\b" <<<"$SCRUBBED" ; then
  block_port_kill
fi

# --- (f) session-hosting service restart. Checked AFTER the kill-family
#     triggers (i) (i2) (g) (h) (j): a command combining both forms should report
#     the kill, which is the one with no safe rewrite.
#     Reads the RAW command, not SCRUBBED: a restart of the session's own host
#     unit is fatal wherever it appears, and this trigger has no measured
#     false positive to clear.
if grep -qE 'systemctl[[:space:]]+([^|;&]*\b)?(restart|stop|disable)\b.*\b(t3code)\b' <<<"$COMMAND" ; then
  block "systemctl restart/stop/disable on session-hosting service" "Restarting, stopping or disabling a service that hosts this session ends the session."
fi

if ssh_payload_has_sudo "$SCRUBBED" ; then
  if ! all_sudo_segments_readonly "$SCRUBBED" ; then
    block "sudo over ssh (remote host)" "Shared host infrastructure is changed only with the user's authorization."
  fi
fi

# --- (b) writes under /etc/, /root/, /usr/local/, /var/lib/ via redirect or tee.
if grep -qE '(>|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*(/etc/|/root/|/usr/local/|/var/lib/)' <<<"$SCRUBBED" ; then
  block "write under /etc/ | /root/ | /usr/local/ | /var/lib/" "Shared host infrastructure is changed only with the user's authorization."
fi

# --- (b') editor invocation against same protected paths.
if grep -qE '\b(nano|vim|vi|emacs|sed[[:space:]]+-i)\b[[:space:]]+([^[:space:]]*[[:space:]]+)*(/etc/|/root/|/usr/local/|/var/lib/)' <<<"$SCRUBBED" ; then
  block "edit under /etc/ | /root/ | /usr/local/ | /var/lib/" "Shared host infrastructure is changed only with the user's authorization."
fi

# --- (c) ip link / addr / route mutate.
if grep -qE '\bip[[:space:]]+(link|addr|route)[[:space:]]+(add|del|set|change|flush|replace)\b' <<<"$SCRUBBED" ; then
  block "ip link/addr/route mutate" "Shared host infrastructure is changed only with the user's authorization."
fi

# --- (d) systemctl enable (persistent unit). The rule exempts units under
#     ~/.config/systemd/user/ by name, so an enable of a unit that already
#     lives there and resolves into that directory or a repo checkout passes;
#     see user_unit_enable_ok() for the four conditions and why the fourth is
#     an allowlist rather than a denylist. Everything else still blocks.
if grep -qE '\bsystemctl([[:space:]]+--[a-z-]+)*[[:space:]]+enable\b' <<<"$SCRUBBED" ; then
  if ! user_unit_enable_ok "$SCRUBBED" ; then
    block "systemctl enable (persistent unit)" "Shared host infrastructure is changed only with the user's authorization."
  fi
fi

# --- (d2) systemctl verb assembled from a variable or command substitution.
#     A gate any operator can route around by splitting a word is not a gate.
#     When the user has already authorized an enable, the plain command is
#     still blocked (this hook cannot see an approval), and assembling the verb
#     as `V=enab; systemctl --user "${V}le" ...` would walk straight through.
#     Blocking the shape costs nothing: a verb that has to be computed cannot
#     be inspected, so it can never be cleared on inspection.
#     Only the VERB position matches. `systemctl --user show "$unit"` and every
#     other read-only call passing a variable as the UNIT keeps working.
#     The remedy for an authorized-but-blocked command is in block() above: put
#     it in a script file with the authorization recorded as a comment, and run
#     the script. Handing the command back to the user is not an option.
if grep -qE '\bsystemctl\b([[:space:]]+--[a-z-]+)*[[:space:]]+["'"'"']?\$[{(]' <<<"$SCRUBBED" ; then
  block "systemctl verb built from a variable (cannot be inspected)" "Shared host infrastructure is changed only with the user's authorization."
fi

# --- (e) daemon configs.
if grep -qE '\b(daemon\.json|sshd_config|systemd-networkd|/etc/cni/|/etc/docker/|/etc/systemd/system/)\b' <<<"$SCRUBBED" ; then
  block "daemon config / systemd-networkd / /etc/systemd/system/" "Shared host infrastructure is changed only with the user's authorization."
fi

exit 0
