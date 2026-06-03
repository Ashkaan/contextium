---
name: pfSense
description: Open-source firewall/router; version-scrape helper for upgrade tracking
cli: HTTPS scrape (no auth)
typed_client: integrations/pfsense/pfsense.ts
hosts:
  - pfsense.org
  - www.pfsense.org
---

# pfSense Integration

pfSense Community Edition runs on your network firewall/router. Source: Netgate. The integration is a public download-page scrape used to check for available CE upgrades.

## TypeScript Client

Canonical typed reference: [`pfsense.ts`](pfsense.ts).

```ts
import { getLatestPfSenseVersion, type PfSenseVersionResult } from "../../integrations/pfsense/pfsense.ts";
```

### Export surface

| Function / Type | Purpose |
|---|---|
| `getLatestPfSenseVersion(timeoutMs?)` | Scrapes `pfsense.org/download/` for the latest CE release version |
| `PfSenseVersionResult` | Tagged union: `{ ok: true, version }` or `{ ok: false, cause: "http_fail"\|"parse_fail" }` |

The result type distinguishes HTTP failure (escalate — site down) from parse failure (informational — Netgate page tweak). Two regex anchors prevent silent breakage from page restructuring.

## Notes

- No auth, no API key — public download page.
- 15-second AbortSignal timeout default; bump for slow networks.
- Filename pattern primary anchor: `pfSense-CE-<X.Y.Z>-RELEASE`.

## Common invocations

### Smoke / auth check
```bash
node --input-type=module -e "import { getLatestPfSenseVersion } from './integrations/pfsense/pfsense.ts'; const r=await getLatestPfSenseVersion(); console.log(JSON.stringify(r));"
```

### Refresh / re-auth
No auth — public scrape. If the smoke check fails with `cause: "http_fail"`, the page is down or unreachable; if `cause: "parse_fail"`, the Netgate page restructured and `getLatestPfSenseVersion` regex anchors need updating in `pfsense.ts`.

### Common queries / actions
- Latest CE version (default 15s timeout): `node --input-type=module -e "import { getLatestPfSenseVersion } from './integrations/pfsense/pfsense.ts'; const r=await getLatestPfSenseVersion(); console.log(r.ok ? r.version : 'ERR:'+r.cause);"`
- Latest CE version (60s timeout for slow networks): `node --input-type=module -e "import { getLatestPfSenseVersion } from './integrations/pfsense/pfsense.ts'; const r=await getLatestPfSenseVersion(60_000); console.log(JSON.stringify(r));"`
- Compare against your running firewall: fetch the latest version above, then SSH the box for the installed version comparison.
- Raw download-page sniff (debug parse_fail): `curl -s --max-time 15 https://www.pfsense.org/download/ | grep -oE 'pfSense-CE-[A-Za-z0-9.-]+-RELEASE' | head -3`

### Common failures
- `cause: "http_fail", status: 5xx` → Netgate site down or rate-limiting; retry after a few minutes, no action needed if transient.
- `cause: "http_fail", status: 4xx` → Page URL changed; verify `https://www.pfsense.org/download/` still resolves, update fetch URL in `pfsense.ts` if Netgate moved it.
- `cause: "parse_fail"` → HTML restructured; both regex anchors (filename pattern + Version label block) failed; inspect with the curl command above and update anchors in `pfsense.ts`.
- `AbortError: The operation was aborted` → Fetch exceeded `timeoutMs`; rerun with the 60s-timeout snippet above.
