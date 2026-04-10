# VSCode

Remote development tunnel for editing and development access from anywhere.

## Requirements

- VS Code installed on the host machine
- VS Code CLI (`code` command)
- GitHub or Microsoft account for tunnel auth

## Setup

1. Install VS Code on your development host
2. Start a tunnel: `code tunnel`
3. Authenticate with your GitHub or Microsoft account
4. Configure as a systemd service for persistence:

```ini
[Service]
ExecStart=/usr/bin/code tunnel --accept-server-license-terms
Restart=always
```

5. Access from any browser at `vscode.dev` or via the VS Code desktop app

## Use Cases

- Remote editing from any device with a browser
- Full IDE access to your development environment
- Extension support for language servers and debugging
- Pair programming and code review
