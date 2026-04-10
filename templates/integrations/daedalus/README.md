# Daedalus

Local service management for systemd services and timers on host machines.

## Requirements

- SSH access to the service host
- sudo privileges for systemd management

## Setup

1. Configure SSH key access to your service host
2. Store connection details in your credential vault
3. Verify: `ssh host "systemctl --user list-timers"`

## Key Operations

```bash
# Timer management
ssh host "systemctl --user start my-job.timer"
ssh host "systemctl --user stop my-job.timer"
ssh host "systemctl --user list-timers --all"

# Service management
ssh host "systemctl --user status my-service"
ssh host "systemctl --user restart my-service"
ssh host "journalctl --user -u my-service --since '1 hour ago'"
```

## Deployment Pattern

1. Create a systemd service unit file
2. Create a timer unit file (for scheduled execution)
3. Deploy via SSH: copy units, reload daemon, enable timer
4. Verify with `systemctl --user list-timers`

## Use Cases

- Running scheduled automations via systemd timers
- Managing persistent daemon processes
- Deploying local scripts that need to run on a schedule
- Monitoring service health and logs
