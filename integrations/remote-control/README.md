# Remote Control

Mobile access to your AI agent for text-based interaction from a phone, tablet, or any device with a browser. Lets you query your knowledge base, create tasks, and trigger automations on the go.

## Requirements

- Host machine running the AI agent (always-on server or NAS)
- Secure remote access method (Cloudflare Tunnel, Tailscale, or WireGuard VPN)
- A lightweight web frontend or messaging bridge

## Setup

### Option A: Web Interface via Cloudflare Tunnel

1. Deploy a simple web chat interface on your host (e.g., a Node.js or Python app that proxies to your AI agent)
2. Set up a Cloudflare Tunnel to expose it securely:
   ```bash
   cloudflared tunnel create remote-ai
   cloudflared tunnel route dns remote-ai ai.yourdomain.com
   ```
3. Configure Cloudflare Zero Trust to require authentication:
   - Access > Applications > Add Application
   - Set policy to allow only your email address
4. Access from any device at `https://ai.yourdomain.com`

### Option B: Tailscale Private Network

1. Install Tailscale on your host machine and mobile device
2. Deploy the chat interface bound to `0.0.0.0:8080`
3. Access via Tailscale IP: `http://100.x.x.x:8080`
4. No public exposure -- only accessible on your private Tailscale network

### Option C: Messaging Bridge (Telegram, Signal)

1. Create a bot on your preferred platform (e.g., Telegram BotFather)
2. Deploy a bridge service that relays messages between the bot and your AI agent
3. Store the bot token in your credential vault
4. Configure as a systemd service for persistence (see `integrations/daedalus/`)

## Security Considerations

- Always use authentication -- never expose the agent interface to the public internet without access control
- Cloudflare Zero Trust or Tailscale are preferred over port forwarding
- Consider rate limiting to prevent abuse
- Log all remote interactions for audit

## Use Cases

- Sending quick queries to your AI from your phone
- Checking on automation status while away from your desk
- Creating tasks or journal entries on the go
- Getting quick answers from your knowledge base
- Triggering automations remotely ("run the daily briefing")
