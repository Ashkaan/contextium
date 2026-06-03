---
name: Playwright
description: Browser automation and screenshots via Playwright + Chromium
cli: "`npx playwright screenshot`"
hosts:
  - playwright.dev
aliases:
  - browse
  - browser automation
  - screenshot
  - web ui
  - chromium
  - browse agent
  - playwright screenshot
---

# Playwright Integration

Playwright + Chromium installed system-wide on the runner. **This setup uses the CLI only — no MCPs.** Three shapes for using it:

| Need | Tool |
|------|------|
| Single-URL screenshot / visual check | `npx playwright screenshot <url> <out.png>` |
| Multi-page / SPA / slideshow loop | Same CLI, but loop over deep-link URLs (`?slide=N`, `?page=N`, etc.) — see § "Multi-page loops" |
| True multi-step (form fills, JS interaction) | Inline Node script that imports the `playwright` npm package directly — see § "Multi-step via Node script" |

If you don't use Playwright MCP tools, don't dispatch a subagent expecting them (`mcp__playwright__*`). Either deep-link the URL so the CLI can do a single shot, or write an inline Node script that drives the browser API directly.

## Direct Playwright CLI

```bash
# Single screenshot (saved to current directory)
cd /tmp && npx playwright screenshot https://example.com screenshot.png

# Full-page screenshot
cd /tmp && npx playwright screenshot https://example.com --full-page screenshot.png

# Sized viewport
cd /tmp && npx playwright screenshot --viewport-size=1440,900 https://example.com screenshot.png

# With saved auth state (e.g., from a prior session)
cd /tmp && npx playwright screenshot --load-storage auth.json https://example.com screenshot.png
```

Then read the screenshot with the Read tool to view it.

**Auth-protected sites:** The CLI doesn't support custom headers directly. For SSO/Access or cookie-gated sites, use `--load-storage` with a previously saved state file.

## Multi-page loops (deep-link pattern)

When you need a screenshot of EACH slide / page / view of an app, the CLI is single-URL per invocation. The right pattern is to make the app deep-linkable (`?slide=N` URL param, hash routing, etc) and loop the CLI:

```bash
# Serve the built site
(cd dist && python3 -m http.server 4321 &)
sleep 1

mkdir -p /tmp/qa
for i in $(seq 1 15); do
  (cd /tmp && npx playwright screenshot --viewport-size=1440,900 \
    "http://localhost:4321/?slide=$i" "/tmp/qa/slide-$i.png")
done

pkill -f "python3 -m http.server 4321"
```

Then Read each PNG back and inspect. Don't trust subagent descriptions of screenshots — look at the pixels yourself.

If the target app doesn't support deep-linking, **add it** (small JS handler reading `URLSearchParams`) before screenshotting. The deep-link surface is independently useful (shareable links) and turns the entire multi-page QA into a one-liner.

## Multi-step via Node script

For genuine multi-step browser interaction (form fills, navigation between unrelated pages, dynamic content extraction), write a small inline Node script using the `playwright` npm package directly. No MCP, no subagent overhead. Example pattern:

```bash
node --input-type=module -e '
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("https://example.com/login");
await page.fill("#username", "...");
await page.fill("#password", "...");
await page.click("button[type=submit]");
await page.waitForURL("**/dashboard");
await page.screenshot({ path: "/tmp/dashboard.png" });
await browser.close();
'
```

If you hit `ERR_MODULE_NOT_FOUND`, install locally: `npm install playwright --prefix /tmp` and `import { chromium } from "/tmp/node_modules/playwright/index.mjs"`.

## Requirements

- Playwright + Chromium installed: `npx playwright install --with-deps chromium`

## Troubleshooting

- **"Chromium not found"**: Run `npx playwright install --with-deps chromium` on the runner
- **Timeout errors**: Browser tasks can be slow; consider adding context to the prompt about what to wait for
- **Auth required on target site**: Capture once with `--save-storage` after interactive login, then reuse via `--load-storage`

## Common invocations

### Smoke / auth check
```bash
npx playwright screenshot https://example.com /tmp/playwright-smoke.png >/dev/null && test -s /tmp/playwright-smoke.png && rm -f /tmp/playwright-smoke.png && echo playwright-ok
```

### Refresh / re-auth
Playwright has no auth surface itself. Per-site auth state is captured into a JSON file via `--save-storage` and reused via `--load-storage`.

### Common queries / actions
- Full-page screenshot: `npx playwright screenshot https://example.com --full-page /tmp/playwright-full-page.png`
- Save + reuse browser storage state: `npx playwright screenshot --save-storage /tmp/playwright-auth.json https://example.com /tmp/playwright-auth-bootstrap.png && npx playwright screenshot --load-storage /tmp/playwright-auth.json https://example.com /tmp/playwright-auth-reuse.png`
- Render local HTML to PNG at a square viewport (1080x1080): `TMP=/tmp/playwright-card-$$.html; OUT=/tmp/playwright-card-$$.png; printf '<html><body><h1>Playwright card</h1></body></html>' > "$TMP" && npx playwright screenshot --viewport-size=1080,1080 "$TMP" "$OUT" >/dev/null && test -s "$OUT" && rm -f "$TMP" "$OUT"`
- Multi-page deep-link loop (screenshot every slide/page of an SPA): see § "Multi-page loops (deep-link pattern)" above. Add `?slide=N` (or analogous) URL param support to the app first, then loop the CLI.
- True multi-step browser interaction (form fills, navigation chains): inline Node script using `playwright` npm package, per § "Multi-step via Node script" above.

### Common failures
- `Chromium not found` / Playwright launch failure → `npx playwright install --with-deps chromium`
- Auth-gated page returns login/challenge in screenshot → capture once with `--save-storage` after interactive login, then rerun with `--load-storage`
- Page renders blank → element-wait flag may be needed; switch to the inline Node script pattern (§ "Multi-step via Node script") so you can `page.waitForSelector(...)` before screenshotting
