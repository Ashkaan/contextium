---
name: Proxmox
description: Hypervisor cluster running VMs and LXC containers
hosts:
  - <node-1>
  - <node-2>
  - <node-3>
  - <node-4>
aliases:
  - proxmox
  - pve
  - hypervisor
typed_client:
  - none
access:
  - api
  - ssh
  - browser
uses: none
base_url: https://<node>:8006/api2/json
auth: api token (PVEAPIToken header)
onepassword_item: none
rate_limit: none documented
cli: Web UI / REST API / SSH
---
# Proxmox Integration

**Access order:** api, ssh, browser — the token API reaches VM, backup and task-status operations without a host key, SSH adds node shell work, and the web UI is manual.

A Proxmox VE cluster of hypervisor nodes running VMs and LXC containers. Fill in your own node names and addresses below.

**Cluster nodes (example shape):**

| Node | Role | LAN IP | IPMI IP |
|------|------|--------|---------|
| `<node-1>` | Hypervisor | `<lan-ip>` | `<ipmi-ip>` |
| `<node-2>` | Hypervisor | `<lan-ip>` | `<ipmi-ip>` |
| `<node-3>` | Hypervisor | `<lan-ip>` | `<ipmi-ip>` |
| `<node-4>` | Hypervisor | `<lan-ip>` | `<ipmi-ip>` |

**Web UI:** `https://<node>:8006`
**API endpoint:** `https://<node>:8006/api2/json/`
**SSH:** `ssh root@<node>`

## Access

API token authentication preferred over root password. Generate via web UI: Datacenter → Permissions → API Tokens. Save to your secrets vault as `Proxmox - <consumer>` (token + secret).

```bash
PVE_TOKEN="root@pam!<token-name>=<secret-uuid>"
curl -fsS -k -H "Authorization: PVEAPIToken=$PVE_TOKEN" \
  "https://<node>:8006/api2/json/nodes/<node>/status"
```

For SSH: deploy keys to each node manually or via your provisioning tooling.

## IPMI access

If your nodes have out-of-band IPMI on a management VLAN, the web UI is typically at `https://<node>-ipmi`. Useful for:
- Power on/off remotely
- Console access when network is down
- Hardware sensor monitoring

## Common tasks

| Task | How |
|------|-----|
| List VMs on a node | `GET /nodes/<node>/qemu` |
| List containers | `GET /nodes/<node>/lxc` |
| Start / stop VM | `POST /nodes/<node>/qemu/<vmid>/status/start` |
| VM backup | `POST /nodes/<node>/vzdump` |
| Cluster status | `GET /cluster/status` |
| API docs | https://pve.proxmox.com/pve-docs/api-viewer/ |

## Common invocations

Primarily web-UI; access via `https://<node>:8006` (internal-only by default). REST API curl patterns are in the "Access" section above; full API at https://pve.proxmox.com/pve-docs/api-viewer/. SSH access: `ssh root@<node>`.
