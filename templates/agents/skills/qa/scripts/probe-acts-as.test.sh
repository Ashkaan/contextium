#!/usr/bin/env bash
# Test harness for the act-as path: `qa_probe_acts_as` in lib.sh reads the
# person a target's wrangler config lets the Access service token act as, and
# the capture scripts accept `--auth-act-as` to send it as `X-Portal-Act-As`.
# Also the Cloudflare registry lookups (Pages projects, Workers custom domains)
# that resolve a `--live` URL, and the STATUS GATE (exit 9).
#
# Why: an app that treats a service token alone as a machine answers every page
# with "service tokens cannot access this page", and a capture of that is read
# as "only a signed-in person can check this live". The app treats the token as
# the person PROBE_ACTS_AS names when the request carries the header.
#
# The registry lookups need wrangler's CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID; fake values are set below, and curl is stubbed to fail
# wherever a refresh would reach the network.
#
# peers: lib.sh, serve.sh, screenshot.sh, interaction-check.sh, interaction-check.mjs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
source "$SCRIPT_DIR/lib.sh"

pass=0 fail=0
check() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name — got '$got', want '$want'" >&2
  fi
}

tmp="$(mktemp -d -t qa-act-as-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
export CLOUDFLARE_API_TOKEN="test-token" CLOUDFLARE_ACCOUNT_ID="test-account"

# 1. The line shape an app declares.
mkdir -p "$tmp/portal"
cat > "$tmp/portal/wrangler.toml" <<'EOF'
name = "portal-example-com"
routes = [{ pattern = "portal.example.com", custom_domain = true }]
[vars]
ACCESS_AUD = "aud1,aud2"
PROBE_ACTS_AS = "0123456789abcdef0123456789abcdef.access someone@example.com"
EOF
check "toml: the email PROBE_ACTS_AS names" "$(qa_probe_acts_as "$tmp/portal")" "someone@example.com"

# 2. A wrangler.jsonc config.
mkdir -p "$tmp/jsonc"
cat > "$tmp/jsonc/wrangler.jsonc" <<'EOF'
{
  // comment
  "vars": { "PROBE_ACTS_AS": "probe.access Someone@Example.com" }
}
EOF
check "jsonc: the email, lower-cased" "$(qa_probe_acts_as "$tmp/jsonc")" "someone@example.com"

# 3. No PROBE_ACTS_AS: nothing, so no header is sent.
mkdir -p "$tmp/plain"
printf 'name = "site"\n[vars]\nFOO = "bar"\n' > "$tmp/plain/wrangler.toml"
check "no key: empty" "$(qa_probe_acts_as "$tmp/plain")" ""

# 4. No wrangler config at all.
mkdir -p "$tmp/none"
check "no config: empty" "$(qa_probe_acts_as "$tmp/none")" ""

# 5. A value with no email in its second field: empty, never a guess.
mkdir -p "$tmp/bad"
printf 'PROBE_ACTS_AS = "only-a-client-id"\n' > "$tmp/bad/wrangler.toml"
check "no email: empty" "$(qa_probe_acts_as "$tmp/bad")" ""

# 6. Both capture scripts accept the flag: with the other required arguments
#    missing they must stop at usage (exit 2 with "usage:"), not at "unknown flag".
for s in screenshot.sh interaction-check.sh; do
  set +e
  out="$(bash "$SCRIPT_DIR/$s" --auth-act-as someone@example.com 2>&1)"
  rc=$?
  set -e
  check "$s: exit on missing args" "$rc" "2"
  check "$s: --auth-act-as is a known flag" "$(grep -c 'unknown flag' <<<"$out" || true)" "0"
done

# 7. The header is on the wire. Needs a Playwright already on the machine (a
#    test never downloads one); without it the capture checks are skipped, said.

# TOML literal strings ('…') are as valid as basic ones ("…"): every reader takes both.
mkdir -p "$tmp/lit"
cat > "$tmp/lit/wrangler.toml" <<'EOF'
name = 'lit-worker'
route = { pattern = 'lit.example.com/*', custom_domain = true }
[vars]
PROBE_ACTS_AS = 'probe.access someone@example.com'
EOF
check "toml literal: the Worker name" "$(qa_wrangler_name "$tmp/lit")" "lit-worker"
check "toml literal: the route pattern" "$(qa_wrangler_routes "$tmp/lit")" "lit.example.com/*"
check "toml literal: the email PROBE_ACTS_AS names" "$(qa_probe_acts_as "$tmp/lit")" "someone@example.com"
printf 'name = "q"\nroute = "plain.example.com/*"\n' > "$tmp/lit/wrangler.toml"
check "toml: a bare route string" "$(qa_wrangler_routes "$tmp/lit")" "plain.example.com/*"
printf '%s\n' "PROBE_ACTS_AS = 'lit\\\\x someone@example.com'" > "$tmp/lit/wrangler.toml"
check "toml literal: a backslash stays as written" "$(grep PROBE_ACTS_AS "$tmp/lit/wrangler.toml" | qa_toml_value)" 'lit\\x someone@example.com'
printf '%s\n' "PROBE_ACTS_AS = \"probe.access o'brien@example.com\"" > "$tmp/lit/wrangler.toml"
check "toml basic: an apostrophe inside a double-quoted value" "$(grep PROBE_ACTS_AS "$tmp/lit/wrangler.toml" | qa_toml_value)" "probe.access o'brien@example.com"
check "toml: a last line with no final newline" "$(printf "PROBE_ACTS_AS = 'x.access last@example.com'" | qa_toml_value)" "x.access last@example.com"

if ! (QA_NO_INSTALL=1 qa_playwright_node_modules >/dev/null 2>&1); then
  echo "probe-acts-as: capture checks SKIPPED — no Playwright with an installed chromium"
else
  #    capture's browser sends; the token pair comes from the environment exactly
  #    as qa_resolve_cf_access leaves it.
  srv_log="$tmp/headers.json"
  node -e '
    const http = require("http"), fs = require("fs");
    const s = http.createServer((q, r) => {
      if (q.url === "/") fs.writeFileSync(process.argv[1], JSON.stringify(q.headers));
      const code = q.url === "/forbidden" || q.url === "/500" ? 403 : q.url === "/404" ? 404 : 200;
      r.writeHead(code, { "content-type": "text/html" });
      r.end("<!doctype html><title>t</title><main style=\"padding:40px;font:24px sans-serif;background:#123;color:#fed\"><h1>Act-as probe page</h1><p>" + "text ".repeat(200) + "</p></main>");
    }).listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(s.address().port)));
    setTimeout(() => process.exit(0), 120000);
  ' "$srv_log" "$tmp/port" &
  srv_pid=$!
  for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
  port="$(cat "$tmp/port")"
  set +e
  QA_CF_ACCESS_ID="probe-id" QA_CF_ACCESS_SECRET="probe-secret" QA_SHOTS_ROOT="$tmp/shots" \
    bash "$SCRIPT_DIR/screenshot.sh" --url "http://127.0.0.1:$port" --repo-slug t --run-id t \
    --pages "/" --viewports 800 --no-motion --auth-act-as someone@example.com >"$tmp/shot.log" 2>&1
  shot_rc=$?
  set -e
  # A full-ink 403 is not a page: the status gate refuses it (exit 9). A route
  # that is the error page (/404) is exempt.
  set +e
  QA_SHOTS_ROOT="$tmp/shots" bash "$SCRIPT_DIR/screenshot.sh" --url "http://127.0.0.1:$port" --repo-slug t --run-id t403 \
    --pages "/forbidden" --viewports 800 --no-motion >"$tmp/shot403.log" 2>&1
  rc403=$?
  QA_SHOTS_ROOT="$tmp/shots" bash "$SCRIPT_DIR/screenshot.sh" --url "http://127.0.0.1:$port" --repo-slug t --run-id t404 \
    --pages "/404" --viewports 800 --no-motion >"$tmp/shot404.log" 2>&1
  rc404=$?
  QA_SHOTS_ROOT="$tmp/shots" bash "$SCRIPT_DIR/screenshot.sh" --url "http://127.0.0.1:$port" --repo-slug t --run-id t500 \
    --pages "/500" --viewports 800 --no-motion >"$tmp/shot500.log" 2>&1
  rc500=$?
  set -e
  kill "$srv_pid" 2>/dev/null || true
  check "screenshot.sh: a 403 route exits 9" "$rc403" "9"
  check "screenshot.sh: the 403 names act-as" "$(grep -c 'auth-act-as' "$tmp/shot403.log" || true)" "1"
  check "screenshot.sh: /404 is exempt" "$rc404" "0"
  check "screenshot.sh: /500 answering 403 is still refused" "$rc500" "9"
  check "screenshot.sh ran" "$shot_rc" "0"
  [[ "$shot_rc" -eq 0 ]] || tail -5 "$tmp/shot.log" >&2
  check "the browser sent X-Portal-Act-As" "$(jq -r '."x-portal-act-as" // ""' "$srv_log" 2>/dev/null)" "someone@example.com"
  check "beside the token" "$(jq -r '."cf-access-client-id" // ""' "$srv_log" 2>/dev/null)" "probe-id"
fi

# 8. A Worker-deployed portal's live URL: the Worker name the repo declares,
#    matched against a Workers custom-domain registry answer (the fixture stands
#    in for GET /accounts/<id>/workers/domains, cached where lib.sh caches it).
check "toml: the Worker name" "$(qa_wrangler_name "$tmp/portal")" "portal-example-com"
check "no config: no Worker name" "$(qa_wrangler_name "$tmp/none")" ""
printf 'name = "dash"\n[[d1_databases]]\nname = "NOT_THIS"\n' > "$tmp/plain/wrangler.toml"
check "toml: the top-level name, not a table's" "$(qa_wrangler_name "$tmp/plain")" "dash"
export QA_CF_WORKERS_DOMAINS_CACHE="$tmp/domains.json"
cat > "$QA_CF_WORKERS_DOMAINS_CACHE" <<'EOF2'
{"success":true,"result":[
 {"hostname":"other.example.com","service":"other","environment":"production"},
 {"hostname":"staging.portal.example.com","service":"portal-example-com","environment":"staging"},
 {"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}
EOF2
check "workers: the production custom domain" "$(qa_derive_live_url_from_workers "$tmp/portal")" "https://portal.example.com"
check "workers: no domain for the service → nothing" "$(qa_derive_live_url_from_workers "$tmp/plain" || true)" ""

# 9. A commented-out value never wins over the active one.
mkdir -p "$tmp/commented"
printf 'name = "p"\n[vars]\n# PROBE_ACTS_AS = "old.access old@example.com"\nPROBE_ACTS_AS = "new.access someone@example.com"\n' > "$tmp/commented/wrangler.toml"
check "toml: the active line, not the comment" "$(qa_probe_acts_as "$tmp/commented")" "someone@example.com"

# 10. JSONC as wrangler accepts it: block comments, trailing commas, a // inside a string.
mkdir -p "$tmp/jsonc2"
cat > "$tmp/jsonc2/wrangler.jsonc" <<'EOF2'
{
  /* block
     comment */
  "name": "portal-example-com",
  "routes": [{ "pattern": "portal.example.com", "custom_domain": true },],
  "vars": { "DOCS": "https://x.test//y", "PROBE_ACTS_AS": "probe.access SomeOne@example.com", },
}
EOF2
check "jsonc: name through block comments and trailing commas" "$(qa_wrangler_name "$tmp/jsonc2")" "portal-example-com"
check "jsonc: act-as through the same" "$(qa_probe_acts_as "$tmp/jsonc2")" "someone@example.com"

# 11. Several production hostnames: the one the repo declares wins; none declared is ambiguous.
cat > "$QA_CF_WORKERS_DOMAINS_CACHE" <<'EOF2'
{"success":true,"result":[
 {"hostname":"www.portal.example.com","service":"portal-example-com","environment":"production"},
 {"hostname":"portal.example.com","service":"portal-example-com","environment":"production"},
 {"hostname":"a.dash.test","service":"dash","environment":"production"},
 {"hostname":"b.dash.test","service":"dash","environment":"production"}]}
EOF2
check "workers: the declared route among several" "$(qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null)" "https://portal.example.com"
check "workers: several and none declared → nothing" "$(qa_derive_live_url_from_workers "$tmp/plain" 2>/dev/null || true)" ""

# 12. A failed refresh keeps the last good copy; an error body never counts.
mkdir -p "$tmp/bin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/curl"; chmod +x "$tmp/bin/curl"
touch -t 200001010000 "$QA_CF_WORKERS_DOMAINS_CACHE"   # stale: -d is GNU-only
check "workers: stale cache, refresh fails → still resolves" \
  "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null)" "https://portal.example.com"
printf '{"success":false,"errors":[{"code":10000}],"result":null}' > "$QA_CF_WORKERS_DOMAINS_CACHE"
check "workers: an error body is not a registry" \
  "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null || true)" ""

# 13. serve.sh --live emits the live URL and the act-as person for a Worker portal.
cat > "$QA_CF_WORKERS_DOMAINS_CACHE" <<'EOF2'
{"success":true,"result":[{"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}
EOF2
export QA_CF_PAGES_CACHE="$tmp/pages.json"
printf '{"success":true,"result":[]}' > "$QA_CF_PAGES_CACHE"
mkdir -p "$tmp/portal/src/pages"; printf '<h1>x</h1>\n' > "$tmp/portal/src/pages/index.html"
printf '{"name":"portal","scripts":{"build":"true"},"devDependencies":{"vite":"1"}}\n' > "$tmp/portal/package.json"
set +e
live="$(PATH="$tmp/bin:$PATH" bash "$SCRIPT_DIR/serve.sh" up --repo "$tmp/portal" --mode live --run-id t 2>"$tmp/serve.err")"
set -e
check "serve.sh --live: the Worker's URL" "$(grep '^QA_URL=' <<<"$live")" "QA_URL=https://portal.example.com"
check "serve.sh --live: the act-as person" "$(grep '^QA_AUTH_ACT_AS=' <<<"$live")" "QA_AUTH_ACT_AS=someone@example.com"
[[ -n "$live" ]] || tail -3 "$tmp/serve.err" >&2

# 14. ",}" inside a string is text, not a trailing comma.
mkdir -p "$tmp/jsonc3"
printf '{\n  "name": "n",\n  "vars": { "NOTE": "a,}b", "PROBE_ACTS_AS": "p.access x@example.com" },\n}\n' > "$tmp/jsonc3/wrangler.jsonc"
check "jsonc: a string holding ,} survives" "$(qa_wrangler_config "$tmp/jsonc3" | jq -r .vars.NOTE)" "a,}b"

# 15. A success:true body without a result list is not a registry.
printf '{"success":true,"result":null}' > "$QA_CF_WORKERS_DOMAINS_CACHE"
check "workers: success without a result list → nothing" \
  "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null || true)" ""

# 15b. Entries that are not registry entries do not replace a good copy.
cat > "$QA_CF_WORKERS_DOMAINS_CACHE" <<'EOF2'
{"success":true,"result":[{"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}
EOF2
check "workers: a good copy resolves" "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null)" "https://portal.example.com"
printf '{"success":true,"result":[{}]}' > "$QA_CF_WORKERS_DOMAINS_CACHE"
printf '{"success":true,"result":[{"hostname":"","service":"portal-example-com"}]}' > "$QA_CF_WORKERS_DOMAINS_CACHE"
check "workers: an empty hostname is not an entry" \
  "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null || true)" ""
printf '{"success":true,"result":[{}]}' > "$QA_CF_WORKERS_DOMAINS_CACHE"
check "workers: success with empty entries → nothing" \
  "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null || true)" ""

# 15c. Pages: a project whose domains hold a null is not a registry entry.
printf '{"success":true,"result":[{"name":"x","domains":[null],"source":{"config":{"repo_name":"x"}}}]}' > "$QA_CF_PAGES_CACHE"
check "pages: domains:[null] → nothing" "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_cf x 2>/dev/null || true)" ""
printf '{"success":true,"result":[{"name":"x","domains":["x.pages.dev","x.test"],"source":{"config":{"repo_name":"x"}}}]}' > "$QA_CF_PAGES_CACHE"
check "pages: a good entry still resolves" "$(PATH="$tmp/bin:$PATH" qa_derive_live_url_from_cf x 2>/dev/null)" "https://x.test"

# 16. a11y.sh takes the same auth flags (usage stop, not "unknown flag").
set +e
out="$(bash "$SCRIPT_DIR/a11y.sh" --auth-act-as someone@example.com --auth-op-item x 2>&1)"; rc=$?
set -e
check "a11y.sh: exit on missing args" "$rc" "2"
check "a11y.sh: auth flags are known" "$(grep -c 'unknown flag' <<<"$out" || true)" "0"

# 17. Without wrangler's credentials there is no registry to ask, even with a
#     good cached copy: the lookup is the user's account or nothing.
printf '{"success":true,"result":[{"hostname":"portal.example.com","service":"portal-example-com","environment":"production"}]}' > "$QA_CF_WORKERS_DOMAINS_CACHE"
printf '{"success":true,"result":[{"name":"x","domains":["x.test"],"source":{"config":{"repo_name":"x"}}}]}' > "$QA_CF_PAGES_CACHE"
check "workers: with credentials, the cached copy resolves" "$(qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null)" "https://portal.example.com"
check "workers: no CLOUDFLARE_ACCOUNT_ID → nothing" \
  "$(unset CLOUDFLARE_ACCOUNT_ID; qa_derive_live_url_from_workers "$tmp/portal" 2>/dev/null || true)" ""
check "pages: no CLOUDFLARE_API_TOKEN → nothing" \
  "$(unset CLOUDFLARE_API_TOKEN; qa_derive_live_url_from_cf x 2>/dev/null || true)" ""

echo "probe-acts-as: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
