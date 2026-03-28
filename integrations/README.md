# Integrations

External tools and services configured for use with your AI agent.

Each integration has a README explaining setup and usage. Configure only what you need — the onboarding and setup
projects will guide you.

## Quick Reference

| Integration                           | Type           | Use For                                          |
| ------------------------------------- | -------------- | ------------------------------------------------ |
| [1Password](1password/)               | Credentials    | Secure vault for API keys and secrets            |
| [Google Workspace](google-workspace/) | Productivity   | Drive, Sheets, Gmail, Calendar, Contacts         |
| [Google Auth](google-auth/)           | Auth           | OAuth2 credential management for Google APIs     |
| [Todoist](todoist/)                   | Productivity   | Task management                                  |
| [Notion](notion/)                     | Productivity   | Knowledge base, wikis, project management        |
| [Zoom](zoom/)                         | Productivity   | Meeting summaries via AI Companion               |
| [Windmill](windmill/)                 | Automation     | Workflow automation platform                     |
| [Cloudflare](cloudflare/)             | Infrastructure | Pages, Workers, DNS, Zero Trust                  |
| [TrueNAS](truenas/)                   | Infrastructure | NAS and container management                     |
| [Codex](codex/)                       | AI             | Code generation and bulk editing agent           |
| [Gemini](gemini/)                     | AI             | Research and web tasks agent                     |
| [Browse](browse/)                     | AI             | Browser automation via Playwright                |
| [Ollama](ollama/)                     | AI             | Local inference — private, offline, cost-free    |
| [Stitch](stitch/)                     | AI             | Google's AI UI design tool — text to working UI  |
| [Home Assistant](home-assistant/)     | Smart Home     | Home automation API                              |
| [Autotask](autotask/)                 | Business       | PSA/ticketing system                             |
| [NinjaOne](ninjaone/)                 | Business       | Device inventory and RMM                         |
| [QuickBooks](qbo/)                    | Finance        | Business accounting                              |
| [Monarch](monarch/)                   | Finance        | Personal finance tracking                        |
| [Strety](strety/)                     | Business       | EOS platform (scorecards, rocks)                 |
| [Hudu](hudu/)                         | Business       | IT documentation platform                        |
| [MSPBots](mspbots/)                   | Business       | MSP-specific analytics                           |
| [Garage](garage/)                     | Infrastructure | S3-compatible object storage                     |
| [Daedalus](daedalus/)                 | Infrastructure | Local services and timer management              |
| [TRMNL](trmnl/)                       | Display        | E-ink dashboard display                          |
| [Remote Control](remote-control/)     | Mobile         | Mobile access to AI agent                        |
| [HAPI](hapi/)                         | Voice          | Voice interface (STT + TTS)                      |
| [VSCode](vscode/)                     | Development    | Remote development tunnel                        |
| [n8n](n8n/)                           | Automation     | Alternative workflow platform                    |
| [Host Docs Map](host-docs-map/)       | Reference      | Documentation hosting reference                  |

## Adding an Integration

1. Create `integrations/{name}/README.md`
2. Follow the format in existing READMEs
3. Add to the quick reference table above
4. Store credentials in your vault (see [1Password](1password/))
