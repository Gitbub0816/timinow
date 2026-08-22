#!/usr/bin/env bash
#
# One-command production bootstrap.
#
#   ./scripts/bootstrap.sh ~/Downloads/env.example
#   ./scripts/bootstrap.sh ~/Downloads/env.example --dry-run
#   ./scripts/bootstrap.sh ~/Downloads/env.example --secrets-only
#   ./scripts/bootstrap.sh ~/Downloads/env.example --no-pull
#
# This is the only command needed. It brings the checkout up to date first, so
# there is no separate pull to remember and no merge conflict to resolve: step
# 1 rewrites the wrangler configs from the env file on every run, so whatever
# this script last wrote into them is disposable. Anything else uncommitted
# stops the run rather than being discarded.
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

ENV_FILE=""
DRY=false
SECRETS_ONLY=false
PULL=true

# Every argument is read, in any order, so the flags combine — `--dry-run
# --no-pull` used to silently ignore the second one.
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY=true ;;
    --secrets-only) SECRETS_ONLY=true ;;
    --no-pull)      PULL=false ;;
    -*)             echo "unknown option: $arg" >&2; exit 1 ;;
    *)              [ -n "$ENV_FILE" ] && { echo "more than one env file given: $ENV_FILE and $arg" >&2; exit 1; }
                    ENV_FILE="$arg" ;;
  esac
done

if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "usage: $0 <path-to-env-file> [--dry-run] [--secrets-only] [--no-pull]" >&2
  echo "example: $0 ~/Downloads/env.example" >&2
  exit 1
fi

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
  $DRY || echo "  set   $key -> $*"
}

bold "0. Latest code"
if ! $PULL; then
  dim "  skipped (--no-pull)"
elif ! command -v git >/dev/null 2>&1 || [ ! -d .git ]; then
  dim "  not a git checkout — skipping"
else
  CONFIGS="wrangler.jsonc wrangler.vet.jsonc wrangler.admin.jsonc wrangler.voice.jsonc"
  BRANCH=$(git rev-parse --abbrev-ref HEAD)

  # Step 1 rewrites these four from the env file on every run, so whatever this
  # script last wrote into them is disposable. Dropping them here is what turns
  # "pull, resolve a conflict, re-run" into a single command.
  if $DRY; then
    dim "    would restore the wrangler configs, then fast-forward $BRANCH"
  else
    git checkout -- $CONFIGS 2>/dev/null || true
  fi

  # Anything else uncommitted is someone's real work, so it stops the run.
  OTHER=$(git status --porcelain -- . \
    ":(exclude)wrangler.jsonc" ":(exclude)wrangler.vet.jsonc" \
    ":(exclude)wrangler.admin.jsonc" ":(exclude)wrangler.voice.jsonc" \
    | grep -v '^?? ' || true)
  if [ -n "$OTHER" ]; then
    die "  Uncommitted changes beyond the wrangler configs, so nothing was pulled
  and nothing was deployed:

$OTHER

  Commit or stash them and run this again, or deploy exactly what is in this
  checkout without pulling:

    ./scripts/bootstrap.sh $ENV_FILE --no-pull"
  fi

  if ! $DRY; then
    if ! git fetch origin "$BRANCH" >/dev/null 2>&1; then
      warn "  Could not reach the remote — continuing with the local checkout."
    else
      AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
      if [ "$AHEAD" != "0" ]; then
        die "  This checkout has $AHEAD commit(s) the remote does not, so it was left
  as it is rather than rewound. Push them first, or deploy what you have:

    ./scripts/bootstrap.sh $ENV_FILE --no-pull"
      fi
      BEFORE=$(git rev-parse --short HEAD)
      git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 \
        || git reset --hard "origin/$BRANCH" >/dev/null
      AFTER=$(git rev-parse --short HEAD)
      if [ "$BEFORE" = "$AFTER" ]; then
        dim "  already current ($AFTER)"
      else
        echo "  updated $BEFORE -> $AFTER"
        # A pull can move the dependencies the rest of this script runs on.
        if [ package.json -nt node_modules ]; then
          dim "  package.json changed — reinstalling"
          npm install --silent
        fi
      fi
    fi
  fi
fi
echo

bold "1. Public configuration"
# The voice Worker is deliberately absent from these two: it serves no browser
# UI, so it needs neither a Clerk publishable key nor a map token.
set_var CLERK_PUBLISHABLE_KEY  "$CUSTOMER" "$VET" "$ADMIN"
# The token-verification settings. These were committed values until now, which
# meant re-pointing at a different Clerk instance took a code change rather than
# an env-file edit. CLERK_JWKS_URL is normally blank — the Worker derives the
# JWKS endpoint from the publishable key — and a blank value is skipped, so
# leaving it empty keeps the derivation.
set_var CLERK_ISSUER           "$CUSTOMER" "$VET" "$ADMIN"
set_var CLERK_JWKS_URL         "$CUSTOMER" "$VET" "$ADMIN"
set_var CLERK_TOKEN_TEMPLATE   "$CUSTOMER" "$VET" "$ADMIN"
set_var AUTHORIZED_PARTIES     "$CUSTOMER" "$VET" "$ADMIN"
set_var MAPBOX_PUBLIC_TOKEN    "$CUSTOMER" "$VET" "$ADMIN"
set_var MAPBOX_STYLE_URL       "$CUSTOMER" "$VET" "$ADMIN" "$VOICE"
set_var MAPBOX_NAVIGATION_STYLE_URL "$CUSTOMER" "$VET" "$ADMIN"
set_var STRIPE_PUBLISHABLE_KEY "$CUSTOMER"
set_var TWILIO_FROM_NUMBER     "$VOICE"
set_var VOICE_PUBLIC_URL       "$VOICE"
set_var VOICE_CALLS_ENABLED    "$VOICE"
set_var VOICE_MAX_ATTEMPTS     "$VOICE"
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
if $DRY; then
  dim "    would run: npm run check"
else
  if ! npm run check; then
    echo >&2
    die "  The configuration does not agree with itself, so nothing was deployed
  and no secrets were set. The error above names the specific disagreement.

  A common cause is a half-resolved merge in the wrangler configs. To take the
  committed versions and start again:

    git checkout HEAD -- wrangler.jsonc wrangler.vet.jsonc wrangler.admin.jsonc wrangler.voice.jsonc
    ./scripts/bootstrap.sh $ENV_FILE

  If the Workers are already deployed and you only need their secrets:

    ./scripts/bootstrap.sh $ENV_FILE --secrets-only"
  fi
fi
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

# The Mapbox SDKs are binary dependencies fetched over HTTP, and SwiftPM
# authenticates to api.mapbox.com through ~/.netrc — there is no other way to
# hand it the downloads token. Without it the iOS app builds the non-Mapbox
# fallback: a ranked list instead of a live map, and no turn-by-turn at all.
# Writing it here means the token is never pasted into a terminal.
bold "6b. Mapbox downloads token (this machine)"
DOWNLOADS_TOKEN="$(env_value MAPBOX_DOWNLOADS_TOKEN)"
if [ -z "$DOWNLOADS_TOKEN" ]; then
  dim "  skip  MAPBOX_DOWNLOADS_TOKEN (blank in env file)"
elif $DRY; then
  dim "    would write the api.mapbox.com entry in $HOME/.netrc"
else
  case "$DOWNLOADS_TOKEN" in
    sk.*) ;;
    *) die "  MAPBOX_DOWNLOADS_TOKEN must be a secret token starting with sk. — a
  pk. token has no DOWNLOADS:READ scope and the SDKs will not fetch." ;;
  esac
  NETRC="$HOME/.netrc"
  # Only our own entry is touched. A ~/.netrc is shared with every other tool
  # on the machine, so replacing the file wholesale would break them.
  if [ -f "$NETRC" ]; then
    awk '
      /^[[:space:]]*machine[[:space:]]/ { ours = ($2 == "api.mapbox.com") }
      !ours { print }
    ' "$NETRC" > "$NETRC.timi" && mv "$NETRC.timi" "$NETRC"
  fi
  printf 'machine api.mapbox.com\n  login mapbox\n  password %s\n' "$DOWNLOADS_TOKEN" >> "$NETRC"
  chmod 600 "$NETRC"
  echo "  set   MAPBOX_DOWNLOADS_TOKEN -> $NETRC"
  dim "  export TIMI_MAPBOX=1 before building the iOS app to link the SDKs."
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
