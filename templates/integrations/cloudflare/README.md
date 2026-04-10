# Cloudflare

Pages, Workers, DNS, Tunnels, and Zero Trust for web hosting and infrastructure.

## Requirements

- Cloudflare account
- API token with appropriate permissions

## Setup

1. Create an API token at dash.cloudflare.com > My Profile > API Tokens
2. Select permissions: Zone:DNS, Pages, Workers, etc.
3. Store the token in your credential vault
4. Install CLI: `npm install -g wrangler`

## Key Services

| Service    | Use                              |
| ---------- | -------------------------------- |
| Pages      | Static site hosting with CI/CD   |
| Workers    | Serverless functions at the edge |
| DNS        | Domain management                |
| Tunnels    | Expose local services securely   |
| Zero Trust | Access control for internal apps |

## Common Commands

```bash
wrangler pages deploy ./dist     # Deploy a Pages site
wrangler dev                     # Local Workers development
wrangler tunnel run <name>       # Start a tunnel
```

## Use Cases

- Hosting web apps and dashboards
- Running serverless API endpoints
- Managing DNS records programmatically
- Securing access to self-hosted services via Zero Trust
