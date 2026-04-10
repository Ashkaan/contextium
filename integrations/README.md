# Integrations

Connect your AI to the tools you already use. Each integration has a README with setup instructions, authentication details, and usage examples.

## Your Integrations

*No integrations configured yet. Set them up as you need them.*

## Available Integrations

Browse `templates/integrations/` for all available connectors — or just ask your AI:

> "Connect my Google Calendar"
> "Set up 1Password for credential management"
> "I want to use Todoist for task tracking"

Your AI will read the integration docs and walk you through setup.

| Category | Integrations |
|----------|-------------|
| **Productivity** | [1Password](../templates/integrations/1password/), [Google Workspace](../templates/integrations/google-workspace/), [Todoist](../templates/integrations/todoist/), [Notion](../templates/integrations/notion/), [Zoom](../templates/integrations/zoom/) |
| **AI Delegation** | [Gemini](../templates/integrations/gemini/), [Codex](../templates/integrations/codex/), [Ollama](../templates/integrations/ollama/), [Browse](../templates/integrations/browse/), [Stitch](../templates/integrations/stitch/) |
| **Automation** | [Windmill](../templates/integrations/windmill/), [n8n](../templates/integrations/n8n/) |
| **Infrastructure** | [Cloudflare](../templates/integrations/cloudflare/), [TrueNAS](../templates/integrations/truenas/), [Garage](../templates/integrations/garage/), [Home Assistant](../templates/integrations/home-assistant/) |
| **Business** | [QuickBooks](../templates/integrations/qbo/), [Monarch](../templates/integrations/monarch/), [Autotask](../templates/integrations/autotask/), [NinjaOne](../templates/integrations/ninjaone/), [Strety](../templates/integrations/strety/), [Hudu](../templates/integrations/hudu/), [MSPBots](../templates/integrations/mspbots/) |
| **Interfaces** | [TRMNL](../templates/integrations/trmnl/), [Remote Control](../templates/integrations/remote-control/), [HAPI](../templates/integrations/hapi/), [VS Code](../templates/integrations/vscode/) |

## Adding an Integration

1. Copy the template from `templates/integrations/{name}/` to `integrations/{name}/`
2. Follow the setup instructions in the README
3. Store credentials in your vault (see [1Password](../templates/integrations/1password/))
