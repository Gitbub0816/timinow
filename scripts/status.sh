#!/usr/bin/env bash
#
# What is actually deployed right now.
#
#   ./scripts/status.sh
#
# Answers the two questions that come up when something is not working: does
# this Worker exist, and does it have its secrets. Reads live state from
# Cloudflare rather than inferring it from the configs.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/status.sh" >&2
  exit 1
fi

set -uo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad()  { printf '  \033[31mno\033[0m    %s\n' "$*"; }
dim()  { printf '  \033[2m%s\033[0m\n' "$*"; }

command -v npx >/dev/null || { echo "npx is required" >&2; exit 1; }

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not signed in to Cloudflare. Run: npx wrangler login" >&2
  exit 1
fi

bold "Cloudflare account"
npx wrangler whoami 2>/dev/null | grep -iE 'account name|account id' | sed 's/^/  /' || dim "(could not read account)"

# Which secrets each Worker is supposed to hold.
check_worker() { # check_worker CONFIG NAME SECRET...
  local config="$1" name="$2"; shift 2
  bold "$name  ($config)"

  local secrets
  if secrets="$(npx wrangler secret list --config "$config" 2>/dev/null)"; then
    ok "deployed"
    local key
    for key in "$@"; do
      if printf '%s' "$secrets" | grep -q "\"$key\""; then
        ok "secret $key"
      else
        bad "secret $key is NOT set"
      fi
    done
  else
    bad "not deployed yet — nothing has been published under this name"
    dim "secrets cannot be set until it is: npm run deploy"
    return
  fi

  # Custom Domains are what make the hostnames answer.
  local host
  for host in $(node -e '
    const fs=require("fs");
    const text=fs.readFileSync(process.argv[1],"utf8").replace(/^\s*\/\/.*$/gm,"");
    const routes=JSON.parse(text).routes||[];
    console.log(routes.map(r=>r.pattern.split("/")[0]).join(" "));
  ' "$config"); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/api/health" 2>/dev/null)"
    if [ "$code" = "200" ]; then ok "https://$host answers"; else bad "https://$host returned ${code:-no response}"; fi
  done
}

check_worker wrangler.jsonc       "timinow (customer)"  CLERK_SECRET_KEY STRIPE_SECRET_KEY
check_worker wrangler.vet.jsonc   "timinow-vet"         CLERK_SECRET_KEY
check_worker wrangler.admin.jsonc "timinow-admin"       CLERK_SECRET_KEY
check_worker wrangler.voice.jsonc "timinow-voice"       CLERK_SECRET_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN

bold "GitHub repository secrets"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  listed="$(gh secret list 2>/dev/null | awk '{print $1}')"
  for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID MAPBOX_DOWNLOADS_TOKEN; do
    if printf '%s' "$listed" | grep -qx "$key"; then ok "$key"; else bad "$key is NOT set"; fi
  done
else
  dim "gh not installed or not signed in — skipping"
fi

bold "Next"
echo "  Anything 'not deployed'   ->  npm run deploy:all"
echo "  Secrets missing after that ->  ./scripts/bootstrap.sh ~/Downloads/env.example"
echo "  Hostname not answering     ->  ./scripts/check-dns.sh"
