# Integrations

External service connectors live here, one folder per product (`integrations/<product>/`).
Each holds a `README.md` documenting hosts, auth path, and common invocations, plus a typed
client. This dir starts empty. Docs-only starters for common services live in the Contextium
repo, under `templates/integrations/`, not in your workbench; to pull one in, re-run `install.sh`
from that repo with `--integrations "<name>"` (or pick it from the list when it asks).

See `docs/architecture.md` for the apps-vs-integrations boundary.

## Manifest

Every `integrations/<name>/README.md` opens with this frontmatter, keys in this order:

| Key | What it holds |
|---|---|
| `name` | The product's display name. |
| `description` | One line: what the product is and what you use it for. |
| `hosts` | Block list of the hostnames the product answers on; what a session looks up. |
| `aliases` | Block list of the other names people call it. |
| `typed_client` | Block list of this folder's non-test `.ts` files, primary first, every one listed; or the single item `none` when the client lives in an app or nowhere. |
| `access` | Block list of the shapes the product offers, ranked by capability (below). |
| `uses` | The one shape your code goes through, or `none` when no code reaches the product. |
| `uses-why` | Optional. Required when `uses` is not the first `access` entry (below). |
| `base_url` | The URL the code or a session starts from. |
| `auth` | How a caller authenticates, or `none`. |
| `onepassword_item` | `CREDS.<key>` from `integrations/1password/credentials.ts` — the stable key, never a 1Password title — or `none`. |
| `rate_limit` | The documented limit, or `none documented`. |
| `cli` | The command or surface a person or session types first. |

**The five shapes** are `cli` (a local binary for the product), `api` (HTTP, REST, GraphQL, S3, JSON-RPC), `ssh` (commands on a host over SSH), `mcp` (an MCP server that serves the product) and `browser` (a person's or Playwright's browser). `access` lists only the shapes that exist for the product. `mcp` is listed when an MCP server serving the product exists and the README body names it — existence, as for every other shape.

**Capability decides; the order only breaks ties.** `access` is ordered by capability for that product, most capable first: the shape that covers most of what you need from it (the reads, writes, restarts and so on that the README and its callers perform) ranks first. Between shapes of equal capability, the canonical order `cli`, `api`, `ssh`, `mcp`, `browser` decides. A README listing more than one shape states its ranking in one line of its body, `**Access order:** … — <why>`.

So `access[0]` is the most capable shape, and `uses-why` is owed exactly when the code does not take it: whenever `uses` is neither `none` nor the first `access` entry, `uses-why` says in one sentence why the code takes the shape it does — what that shape can do, or where it runs, that made it the choice. It may be present otherwise.

Scalars are single lines; one containing `: `, or starting with a YAML indicator such as `` ` `` or `[`, is wrapped in double quotes. No nested maps.

`.agents/checks/check-integration-manifest.ts` enforces all of this except the capability ranking itself, which is a reading no script can make; `land.ts` runs it over every README a close changes, before the commit. `--all` checks every README. `CREDS.<key>` is checked against `integrations/1password/credentials.ts`, so a workbench without one names `none`.
