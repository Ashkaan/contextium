---
paths: null
---

# Ask Before Host Infra Changes

Diagnose freely, propose freely, treat only with permission. Always loaded.

## ask-before-host-infra-changes
When fixing a problem requires changing shared infrastructure on any machine other than this repo's
working tree, MUST stop and ask before executing — even when the change is small, additive,
reversible, documented, or "the standard fix."

What counts:

- host networking (interfaces, addresses, routes, NetworkManager, systemd-networkd)
- daemon configuration (`/etc/docker/daemon.json`, `/etc/ssh/sshd_config`, anything else under `/etc/`)
- creating or enabling a systemd unit outside your own user scope
- root-owned credentials and keys
- anything that survives a reboot on a machine other than your workstation

The cheap pre-flight is a single question about the next command: does it use `sudo` on another
machine, write under `/etc/`, `/root/`, `/usr/local/` or `/var/lib/`, change a network interface or
route, enable a persistent unit, or edit daemon config? If yes — stop, print the exact commands you
would run, name what they affect and how to undo them, and ask.

**Reading is not treating.** Inspect anything: read configs, tail logs, run status commands, form a
diagnosis. Propose anything in text. The line is at execution.

Repo-local file edits, application code, container restarts through your orchestrator, and edits
inside a container's own filesystem are all in scope for autonomous work — they are recoverable from
the repo, and none of them outlive a redeploy. [2026-05-16]

## never-restart-your-own-host
When a `systemctl restart|stop|disable` (or any kill) would hit a service whose process tree contains
the session you are running in, MUST stop and ask — executing it terminates the session issuing the
command, usually mid-task and with no record of what it was doing.

The same applies to anything else that severs the session's own connection: dropping the tunnel or
proxy serving the interface you are talking through, restarting networking on a host you are connected
to over SSH from that host. Pre-flight: am I inside the thing I am about to restart? If yes — or if
you are not sure — ask.

MUST NOT chain a service restart onto another command "to apply the config." That is the shape this
fails in: the config edit succeeds, the restart kills the session, and nobody sees whether it worked. [2026-05-15]
