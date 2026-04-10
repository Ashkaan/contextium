# Google Stitch Integration

**CLI:** `gemini -p "stitch: your design prompt"` (via Gemini CLI extension)

Google Stitch generates production-ready UI from text or image prompts. Integrated as a Gemini CLI extension -- all MCP overhead stays in Gemini's context window, not the main session's.

## Usage

```bash
# Generate UI from a text description
gemini -p "stitch: design a dashboard showing sales pipeline with status cards, conversion funnel chart, and recent activity feed"

# Generate UI from a screenshot/image
gemini -p "stitch: recreate this UI with modern styling" --image path/to/screenshot.png
```

The extension returns HTML + screenshots. Pass the output to your AI coding assistant for implementation in your preferred stack.

## Workflow

1. **Design** -- describe the UI to Stitch via Gemini
2. **Review** -- Stitch returns HTML mockup + screenshot
3. **Implement** -- translate the mockup to your framework's components and styling

## Configuration

### Prerequisites

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated
- A Google Stitch API key (get one at [stitch.withgoogle.com](https://stitch.withgoogle.com/) -> Settings -> API Keys)

### Extension Setup

1. Create the extension config directory:
   ```bash
   mkdir -p ~/.gemini/extensions/Stitch
   ```

2. Create `~/.gemini/extensions/Stitch/gemini-extension.json` with the Stitch MCP server configuration. This tells the Gemini CLI how to connect to Stitch's API.

3. Store your API key:
   - **Credential store item:** `{YOUR_CREDENTIAL_STORE_ITEM}`
   - **Field:** `api_key`
   - **Auth method:** API key (via `X-Goog-Api-Key` header)

4. To rotate the key: create a new one at [stitch.withgoogle.com](https://stitch.withgoogle.com/) -> Settings -> API Keys, update your credential store, then update the extension config.

## Delegation

This integration follows a delegation-first pattern. Stitch runs inside Gemini's context -- your main session only sees the summarized result. Log non-trivial design delegations in your journal:
- `gemini+stitch: designed referral dashboard UI -> 3 screens generated`
