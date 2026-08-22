#!/usr/bin/env bash
#
# One-command production bootstrap.
#
#   ./scripts/bootstrap.sh ~/Downloads/env.example
#   ./scripts/bootstrap.sh ~/Downloads/env.example --dry-run
#   ./scripts/bootstrap.sh ~/Downloads/env.example --secrets-only
#
# Reads a filled-in env file and puts every value where it actually belongs:
#
#   public values  -> the vars block of the wrangler config that needs them
#   secrets        -> `wrangler secret put`, per Worker, never written to disk
#   build secrets  -> `gh secret set`, for the repository
#
# Then migrates the production database, deploys all four Workers, and checks
# that each one answers.
#
# Safe to re-run. Values left blank in the env file are skipped, not cleared.

# macOS ships bash 3.2, so nothing here may use bash 4 features — no
# associative arrays, no mapfile. Verified against that constraint.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "This script needs bash. Run it as: bash scripts/bootstrap.sh <env-file>" >&2
  exit 1
fi

set -euo pipefail

ENV_FILE="${1:-}"
DRY_RUN="${2:-}"
[ "${1:-}" = "--dry-run" ] && { ENV_FILE=""; DRY_RUN="--dry-run"; }

if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "usage: $0 <path-to-env-file> [--dry-run]" >&2
  echo "example: $0 ~/Downloads/env.example" >&2
  exit 1
fi

DRY=false
SECRETS_ONLY=false
case "$DRY_RUN" in
  --dry-run)      DRY=true ;;
  --secrets-only) SECRETS_ONLY=true ;;
esac

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
run()  { if $DRY; then dim "    would run: $*"; else "$@"; fi; }

# ---------------------------------------------------------------- prereqs ---

command -v node >/dev/null || die "node is required (brew install node)"
command -v npx  >/dev/null || die "npx is required"
[ -d node_modules ] || die "run 'npm install' first"

if ! $DRY; then
  npx wrangler whoami >/dev/null 2>&1 \
    || die "not signed in to Cloudflare — run: npx wrangler login"
fi

# ------------------------------------------------------------ read the env ---
# Values are held in shell variables only; nothing is echoed and nothing is
# written back to disk.

# macOS still ships bash 3.2, which has no associative arrays, so values are
# read from the file on demand rather than held in a map. There are about twenty
# lookups; the cost is irrelevant and the script runs everywhere.

env_value() {
  awk -v want="$1" '
    /^[[:space:]]*#/ { next }
    {
      idx = index($0, "=")
      if (idx == 0) next
      key = substr($0, 1, idx - 1)
      val = substr($0, idx + 1)
      gsub(/[[:space:]]/, "", key)
      if (key != want) next
      sub(/[[:space:]]+$/, "", val)
      sub(/^[[:space:]]+/, "", val)
      if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
      else if (val ~ /^\047.*\047$/) val = substr(val, 2, length(val) - 2)
      print val
      exit
    }
  ' "$ENV_FILE"
}

have() { [ -n "$(env_value "$1")" ]; }

FOUND=$(awk '
  /^[[:space:]]*#/ { next }
  {
    idx = index($0, "=")
    if (idx == 0) next
    val = substr($0, idx + 1)
    gsub(/[[:space:]]/, "", val)
    if (val != "") n++
  }
  END { print n + 0 }
' "$ENV_FILE")

bold "Read $FOUND non-empty values from $ENV_FILE"
echo


# ------------------------------------------------- public vars -> configs ---
# These are served to browsers by /api/config, so they are configuration rather
# than secrets and belong in version control with the routes they go with.

CUSTOMER=wrangler.jsonc
VET=wrangler.vet.jsonc
ADMIN=wrangler.admin.jsonc
VOICE=wrangler.voice.jsonc

# Everything written by set_var ends up in `/api/config`, which is public by
# design. A secret pasted into one of these slots is not a configuration
# mistake, it is a disclosure — so refuse it here rather than discover it from
# a scanner after it has been committed.
looks_secret() { # looks_secret KEY VALUE
  case "$2" in
    sk.*)                 echo "a Mapbox secret token (sk.)"; return 0 ;;
    sk_live_*|sk_test_*)  echo "a Clerk or Stripe secret key (sk_)"; return 0 ;;
    rk_live_*|rk_test_*)  echo "a Stripe restricted key (rk_)"; return 0 ;;
    whsec_*)              echo "a webhook signing secret (whsec_)"; return 0 ;;
    SG.*)                 echo "a SendGrid key (SG.)"; return 0 ;;
  esac
  # Twilio auth tokens are 32 hex characters with no prefix to key off.
  if [ "$1" = "TWILIO_AUTH_TOKEN" ] || printf '%s' "$2" | grep -Eq '^[0-9a-f]{32}$'; then
    case "$1" in
      *TOKEN*|*SECRET*|*AUTH*) echo "a 32-character token"; return 0 ;;
    esac
  fi
  return 1
}

set_var() { # set_var KEY CONFIG...
  local key="$1"; shift
  local value
  value="$(env_value "$key")"
  [ -n "$value" ] || { dim "  skip  $key (blank in env file)"; return 0; }

  local why
  if why="$(looks_secret "$key" "$value")"; then
    echo >&2
    die "  $key holds what looks like $why.

  That value would be written into a committed config and served to every
  browser by /api/config. Nothing was changed.

  $key must be the PUBLIC value:
    MAPBOX_PUBLIC_TOKEN     starts with pk.
    CLERK_PUBLISHABLE_KEY   starts with pk_live_ or pk_test_
    STRIPE_PUBLISHABLE_KEY  starts with pk_live_ or pk_test_

  A Mapbox sk. token is the downloads token. It is not a Worker variable at
  all — it belongs in ~/.netrc on the machine that builds the iOS app, and as
  the MAPBOX_DOWNLOADS_TOKEN repository secret. Put it under that name in your
  env file instead, fix $key, and re-run.

  If that token has already been committed anywhere, rotate it."
  fi
  for config in "$@"; do
    if $DRY; then
      if grep -q "\"$key\"[[:space:]]*:" "$config"; then
        dim "    would set $key in $config"
      else
        die "  $key has no slot in $config — add it to that file's vars block first"
      fi
    else
      KEY="$key" VALUE="$value" CONFIG="$config" node -e '
        const fs = require("fs");
        const { KEY, VALUE, CONFIG } = process.env;
        const text = fs.readFileSync(CONFIG, "utf8");
        const pattern = new RegExp(`("${KEY}"\\s*:\\s*)"[^"]*"`);
        if (!pattern.test(text)) {
          console.error(`    ${KEY} has no slot in ${CONFIG} — add it to that vars block first`);
          process.exit(1);
        }
        // A replacement *function*, not a string. A $1 or $& appearing inside a
        // Clerk key or Mapbox token would otherwise be read as a backreference
        // and silently corrupt the file.
        const quoted = JSON.stringify(VALUE);
        const updated = text.replace(pattern, (_match, prefix) => prefix + quoted);
        // Refuse to leave a config we just broke.
        JSON.parse(updated.replace(/^\s*\/\/.*$/gm, ""));
        fs.writeFileSync(CONFIG, updated);
      '
    fi
  done
  echo "  set   $key -> $*"
}

bold "1. Public configuration"
# The voice Worker is deliberately absent from these two: it serves no browser
# UI, so it needs neither a Clerk publishable key nor a map token.
set_var CLERK_PUBLISHABLE_KEY  "$CUSTOMER" "$VET" "$ADMIN"
set_var MAPBOX_PUBLIC_TOKEN    "$CUSTOMER" "$VET" "$ADMIN"
set_var STRIPE_PUBLISHABLE_KEY "$CUSTOMER"
set_var TWILIO_FROM_NUMBER     "$VOICE"
set_var PLATFORM_ADMIN_EMAILS  "$ADMIN"
set_var PLATFORM_ADMIN_USER_IDS "$ADMIN"
# Shared by both ends of the immediate-dispatch path, so it goes to both.
set_var VOICE_DRAIN_TOKEN      "$CUSTOMER" "$VOICE"
echo

# ------------------------------------------------ secrets -> each Worker ---
# Piped on stdin so no secret ever appears in argv or shell history.

# ------------------------------------------------ validate, ship, secure ---
#
# Order matters here, and the first version of this script had it wrong.
# `wrangler secret put` refuses to run against a Worker whose latest version is
# not deployed, which is always true before the first deploy. So the Workers are
# created first, then the secrets are attached to them.
#
# Deploying before the secrets land is safe: sign-in verifies Clerk tokens
# against public JWKS, so the only thing unavailable in the gap is the Clerk
# Backend API — metadata repair and the admin console — and nothing has traffic
# yet anyway.

if $SECRETS_ONLY; then
  bold "Secrets only — skipping validation, migration, and deploy"
  echo
else

bold "2. Configuration check"
run npm run check
echo

bold "3. Production database"
if $DRY; then
  dim "    would run: npm run db:migrate:remote"
else
  npm run db:migrate:remote
fi
echo

bold "4. Deploy"
if $DRY; then
  dim "    would run: npm run deploy:all"
else
  read -r -p "Deploy all four Workers to production? [y/N] " reply
  case "$reply" in
    [yY]*) npm run deploy:all ;;
    *) die "  Secrets cannot be set before the Workers exist. Re-run when ready to deploy." ;;
  esac
fi
echo

fi   # end of the block skipped by --secrets-only

put_secret() { # put_secret KEY CONFIG...
  local key="$1"; shift
  local value
  value="$(env_value "$key")"
  [ -n "$value" ] || { dim "  skip  $key (blank in env file)"; return 0; }
  local config
  for config in "$@"; do
    if $DRY; then
      dim "    would run: wrangler secret put $key --config $config"
    else
      # Piped on stdin so no secret reaches argv or shell history.
      if printf '%s' "$value" | npx wrangler secret put "$key" --config "$config" >/dev/null 2>&1; then
        :
      elif printf '%s' "$value" | npx wrangler versions secret put "$key" --config "$config" >/dev/null 2>&1; then
        # Gradual-deployment mode: the secret lands on a new version that still
        # needs promoting.
        npx wrangler versions deploy --config "$config" --yes >/dev/null 2>&1 \
          || warn "  $key staged on a new version of $config — promote it in the dashboard"
      else
        die "failed to set $key on $config
  Try it by hand to see the reason:
    npx wrangler secret put $key --config $config"
      fi
    fi
    echo "  set   $key -> $config"
  done
}

bold "5. Worker secrets"
put_secret CLERK_SECRET_KEY      "$CUSTOMER" "$VET" "$ADMIN" "$VOICE"
put_secret TWILIO_ACCOUNT_SID    "$VOICE"
put_secret TWILIO_AUTH_TOKEN     "$VOICE"
put_secret STRIPE_SECRET_KEY     "$CUSTOMER"
put_secret STRIPE_WEBHOOK_SECRET "$CUSTOMER"
echo

# Only what a workflow actually consumes. Setting a secret nothing reads is
# noise that looks like configuration.
bold "6. GitHub repository secrets"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh_secret() {
    local key="$1"
    local value
    value="$(env_value "$key")"
    [ -n "$value" ] || { dim "  skip  $key (blank in env file)"; return 0; }
    if $DRY; then
      dim "    would run: gh secret set $key"
    else
      printf '%s' "$value" | gh secret set "$key" >/dev/null || die "failed to set $key"
    fi
    echo "  set   $key -> repository"
  }
  # Consumed by .github/workflows/deploy.yml (manual dispatch).
  gh_secret CLOUDFLARE_API_TOKEN
  gh_secret CLOUDFLARE_ACCOUNT_ID
  # Consumed by the iOS job only when it builds with TIMI_MAPBOX=1.
  gh_secret MAPBOX_DOWNLOADS_TOKEN
else
  warn "  gh not installed or not signed in — skipping repository secrets."
  warn "  brew install gh && gh auth login, then re-run."
fi
echo

bold "7. Health"
if ! $DRY; then
  for host in timinow.pet providers.timinow.pet admin.timinow.pet voice.timinow.pet; do
    printf '  %-24s ' "$host"
    curl -fsS --max-time 10 "https://$host/api/health" 2>/dev/null || printf 'no response'
    echo
  done
fi
echo

bold "Done."
echo "Public values changed in the wrangler configs — review and commit:"
echo "    git diff --stat"
echo "    git add wrangler.jsonc wrangler.vet.jsonc wrangler.admin.jsonc wrangler.voice.jsonc"
echo "    git commit -m 'Configure production keys' && git push"
