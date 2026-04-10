# TrueNAS

NAS and container management via SSH for storage and Docker workloads.

## Requirements

- TrueNAS instance (SCALE preferred for Docker support)
- SSH key access to the NAS host

## Setup

1. Enable SSH on your TrueNAS instance
2. Add your SSH public key to the NAS user
3. Store the SSH connection details in your credential vault
4. Test: `ssh user@nas-hostname "docker ps"`

## Key Operations

```bash
ssh nas "docker ps"                    # List running containers
ssh nas "docker restart <container>"   # Restart a container
ssh nas "docker logs <container>"      # View container logs
ssh nas "zpool status"                 # Check storage pool health
ssh nas "df -h"                        # Check disk usage
```

## Use Cases

- Managing Docker containers running on NAS hardware
- Monitoring storage pool health and capacity
- Verifying backup completion
- Restarting services after updates
