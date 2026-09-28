---
name: pfSense
description: Open-source firewall/router; download-page scrape for upgrade tracking
cli: HTTPS scrape (no auth)
hosts:
  - pfsense.org
  - www.pfsense.org
---

# pfSense Integration

pfSense Community Edition runs on your network firewall/router. Source: Netgate. The integration is a scrape of the public download page, used to check for available CE upgrades.

## If you write a checker

Nothing here ships one; the `curl` below is the whole check. If a scheduled job tracks upgrades, this is its shape:

- Fetch `https://www.pfsense.org/download/` with a timeout (15s default; longer on slow networks).
- Parse with two anchors so a page tweak does not silently break it: the filename pattern `pfSense-CE-<X.Y.Z>-RELEASE` first, the page's Version label block as a fallback.
- Return a tagged result: `{ ok: true, version }`, or `{ ok: false, cause: "http_fail" | "parse_fail" }`. The distinction matters: `http_fail` means the site is down (escalate), `parse_fail` means Netgate changed the page (informational; fix the anchors).

## Notes

- No auth, no API key — public download page.
- The filename list also carries installer variants (`pfSense-CE-memstick-…`); the numeric pattern below skips them.

## Common invocations

### Smoke / latest version
```bash
page=$(curl -fsS --max-time 15 https://www.pfsense.org/download/) || { echo "http_fail"; exit 1; }
v=$(printf '%s' "$page" | grep -oE 'pfSense-CE-[0-9.]+-RELEASE' | sort -uV | tail -1 | grep -oE '[0-9]+(\.[0-9]+)+')
[ -n "$v" ] || v=$(printf '%s' "$page" | tr '\n' ' ' | sed 's/<[^>]*>/ /g' | grep -oE 'Version: +[0-9]+(\.[0-9]+)+' | head -1 | grep -oE '[0-9]+(\.[0-9]+)+')
if [ -n "$v" ]; then echo "$v"; else echo "parse_fail"; exit 2; fi
```

Prints the version, or `http_fail` (exit 1: the page is down or unreachable) or `parse_fail` (exit 2: both anchors missed, so Netgate changed the page).

### Refresh / re-auth
No auth — public scrape. If the fetch fails, the page is down or unreachable; if it succeeds but the grep prints nothing, Netgate restructured the page and the anchor needs updating.

### Common queries / actions
- Slow network: raise `--max-time 15` to `60` in the snippet above.
- Compare against your running firewall: fetch the latest version above, then SSH the box for the installed version.
- Raw download-page sniff (debug a parse failure): `curl -fsS --max-time 15 https://www.pfsense.org/download/ | grep -oE 'pfSense-CE-[A-Za-z0-9.-]+-RELEASE' | head -3`

### Common failures
- HTTP 5xx → Netgate site down or rate-limiting; retry after a few minutes, no action needed if transient.
- HTTP 4xx → page URL changed; verify `https://www.pfsense.org/download/` still resolves and update the URL if Netgate moved it.
- Empty grep output → HTML restructured; inspect with the raw sniff above and update the anchor.
- `curl: (28) Operation timed out` → fetch exceeded `--max-time`; rerun with the 60s variant.
