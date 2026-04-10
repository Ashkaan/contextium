# Browse

Browser automation via Playwright for web scraping and UI interaction.

## Requirements

- Node.js runtime
- Playwright installed with Chromium browser

## Setup

1. Install Playwright: `npm install playwright`
2. Install browsers: `npx playwright install chromium`
3. Verify: `npx playwright --version`

## Key Operations

```javascript
// Navigate and extract content
await page.goto("https://example.com");
const text = await page.textContent("selector");

// Fill forms and click buttons
await page.fill('input[name="query"]', "search term");
await page.click('button[type="submit"]');

// Screenshot for verification
await page.screenshot({ path: "screenshot.png" });
```

## When to Use Browse

- Web pages that don't offer APIs
- Form submissions and multi-step web flows
- Visual verification (screenshots)
- Scraping data from rendered pages

## Use Cases

- Extracting data from sites without APIs
- Automating web-based workflows
- Taking screenshots for documentation
- Testing web applications
