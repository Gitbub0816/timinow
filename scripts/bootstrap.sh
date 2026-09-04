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
# Every key left blank in the env file, repeated in the closing summary.
SKIPPED=""
DRY=false
SECRETS_ONLY=false
PULL=true
INSPECT=false
TEST_CALL=""
TEST_VOICE=""
TTS_CHECK=false

# Every argument is read, in any order, so the flags combine — `--dry-run
# --no-pull` used to silently ignore the second one.
while [ $# -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --dry-run)      DRY=true ;;
    --secrets-only) SECRETS_ONLY=true ;;
    --no-pull)      PULL=false ;;
    --inspect)      INSPECT=true ;;
    --test-call)    TEST_CALL="${2:-}"; shift ;;
    --voice)        TEST_VOICE="${2:-}"; shift ;;
    --tts-check)    TTS_CHECK=true ;;
    -*)             echo "unknown option: $arg" >&2; exit 1 ;;
    *)              [ -n "$ENV_FILE" ] && { echo "more than one env file given: $ENV_FILE and $arg" >&2; exit 1; }
                    ENV_FILE="$arg" ;;
  esac
  shift
done

if [ -z "$ENV_FILE" ]; then
  echo "usage: $0 <path-to-env-file> [--dry-run] [--secrets-only] [--no-pull] [--inspect] [--tts-check] [--test-call +1... [--voice NAME]]" >&2
  echo "example: $0 ~/Downloads/env.example" >&2
  exit 1
fi

# "It printed the usage" and "that file is not where you think it is" are two
# different problems, and printing the first for the second sends you off to
# re-read the flags when the answer is a path.
if [ ! -f "$ENV_FILE" ]; then
  echo "no env file at: $ENV_FILE" >&2
  case "$ENV_FILE" in
    /*) ;;
    *)  echo "  (looked relative to $PWD)" >&2 ;;
  esac
  # A file of that name sitting somewhere obvious is worth naming, since the
  # usual mistake is the directory rather than the name.
  BASENAME="$(basename "$ENV_FILE")"
  for WHERE in "$PWD" "$HOME" "$HOME/Downloads" "$HOME/Desktop" "$(dirname "$0")/.."; do
    if [ -f "$WHERE/$BASENAME" ]; then
      # Canonicalised, so the suggestion is a path worth copying rather than
      # one with a scripts/.. in the middle of it.
      FOUND="$(cd "$WHERE" && pwd)/$BASENAME"
      echo >&2
      echo "found one here — did you mean:" >&2
      echo "    $0 $FOUND" >&2
      break
    fi
  done
  exit 1
fi

# Absolute before the cd below, or a relative path stops resolving the moment
# the script moves to the repository root.
case "$ENV_FILE" in
  /*) ;;
  *)  ENV_FILE="$PWD/$ENV_FILE" ;;
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

# The last non-empty assignment wins, which is what a shell does when it sources
# the same file, and what the file looks like it means. Reading the first one
# instead — as this did — makes a copy of .env.example with the real values
# appended below the placeholders resolve to every placeholder: the key is
# plainly in the file, and every lookup comes back blank.
#
# `export KEY=value` counts too. Stripping all whitespace from the key turned
# that into `exportKEY`, which matched nothing, with the same silent result.
env_value() {
  awk -v want="$1" '
    /^[[:space:]]*#/ { next }
    {
      idx = index($0, "=")
      if (idx == 0) next
      key = substr($0, 1, idx - 1)
      val = substr($0, idx + 1)
      sub(/^[[:space:]]*export[[:space:]]+/, "", key)
      gsub(/[[:space:]]/, "", key)
      if (key != want) next
      sub(/[[:space:]]+$/, "", val)
      sub(/^[[:space:]]+/, "", val)
      if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
      else if (val ~ /^\047.*\047$/) val = substr(val, 2, length(val) - 2)
      if (val != "") last = val
    }
    END { if (last != "") print last }
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
# Say so when a key is assigned more than once. It is legal and the last
# non-empty one wins, but it is also exactly what a half-filled copy of
# .env.example looks like, and the reader deserves to know which value is
# actually in play before it turns up in production.
# Two assignments of the same key with two different non-empty values is not a
# stale placeholder — it is a coin toss over a production credential, and the
# loser is invisible. A Clerk key set twice deployed the wrong instance and
# took sign-in down on every surface while the file plainly showed the right
# one further up. Refused rather than resolved.
CONFLICTS="$(awk '
  /^[[:space:]]*#/ { next }
  {
    idx = index($0, "=")
    if (idx == 0) next
    key = substr($0, 1, idx - 1)
    val = substr($0, idx + 1)
    sub(/^[[:space:]]*export[[:space:]]+/, "", key)
    gsub(/[[:space:]]/, "", key)
    sub(/^[[:space:]]+/, "", val); sub(/[[:space:]]+$/, "", val)
    if (key == "" || val == "") next
    if (key in value) { if (value[key] != val) conflict[key] = 1 }
    else value[key] = val
  }
  END { for (k in conflict) printf "%s ", k }
' "$ENV_FILE")"
if [ -n "$CONFLICTS" ]; then
  die "  Assigned twice, with different values, in $ENV_FILE:

    $CONFLICTS

  Whichever comes last would win and the other would vanish silently, so
  nothing was deployed. Note that \"export KEY=value\" counts — a plain
  search for \"^KEY=\" will not show you the second one. Find them all with:

    grep -nE '^[[:space:]]*(export[[:space:]]+)?($(printf '%s' "$CONFLICTS" | tr -s ' ' '|' | sed 's/|$//'))=' $ENV_FILE

  Delete the wrong one and run this again."
fi

DUPLICATES="$(awk '
  /^[[:space:]]*#/ { next }
  {
    idx = index($0, "=")
    if (idx == 0) next
    key = substr($0, 1, idx - 1)
    sub(/^[[:space:]]*export[[:space:]]+/, "", key)
    gsub(/[[:space:]]/, "", key)
    if (key == "") next
    seen[key]++
  }
  END { for (k in seen) if (seen[k] > 1) printf "%s ", k }
' "$ENV_FILE")"
if [ -n "$DUPLICATES" ]; then
  warn "  Assigned more than once: $DUPLICATES"
  dim  "  The last non-empty value wins, as a shell would. If you copied"
  dim  "  .env.example and added your values below rather than filling in the"
  dim  "  placeholders, those placeholders are the earlier, blank ones."
fi
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
  [ -n "$value" ] || { dim "  skip  $key (blank in env file)"; SKIPPED="$SKIPPED $key"; return 0; }

  # A setting whose name ends in _URL has to be one. Catching it here beats
  # letting it reach the configuration check, which can only report that
  # something downstream could not parse it.
  case "$key" in
    *_URL)
      case "$value" in
        https://*/) die "  $key is \"$value\". Drop the trailing slash — it makes every
  signed callback URL differ from the one Twilio signs. Nothing was changed." ;;
        https://*)  ;;
        http://*)   die "  $key is \"$value\". It must be https. Nothing was changed." ;;
        mapbox://*) ;;
        *)          die "  $key is \"$value\", which is not a URL. It needs the scheme:

    $key=https://$value

  Nothing was changed." ;;
      esac ;;
  esac

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

# What is in the env file, without putting any of it on screen.
#
# Half the questions in a bad deploy are "is that value actually set, and is it
# the right shape" — and answering them with grep prints live secrets into a
# terminal, a scrollback buffer, and whatever they get pasted into. Two
# characters and a length answer the same question and disclose nothing.
if $INSPECT; then
  bold "$ENV_FILE"
  awk '
    /^[[:space:]]*#/ { next }
    {
      idx = index($0, "=")
      if (idx == 0) next
      key = substr($0, 1, idx - 1)
      val = substr($0, idx + 1)
      sub(/^[[:space:]]*export[[:space:]]+/, "", key)
      gsub(/[[:space:]]/, "", key)
      sub(/[[:space:]]+$/, "", val)
      if (key == "") next
      if (val == "") { printf "  %-32s (blank)\n", key; next }
      printf "  %-32s %s… %d characters\n", key, substr(val, 1, 2), length(val)
    }
  ' "$ENV_FILE"
  echo
  exit 0
fi

# Place one test call, reading the env file with the same reader everything
# else here uses.
#
# The alternative is a shell one-liner with a grep in it, and a grep does not
# know about `export KEY=value`, a quoted value, a duplicate assignment, or a
# trailing carriage return — all of which this reader handles and all of which
# have already cost a round trip. The token never reaches argv.
if $TTS_CHECK; then
  ORIGIN="$(env_value VOICE_PUBLIC_URL)"
  [ -n "$ORIGIN" ] || ORIGIN="https://voice.timinow.pet"
  ORIGIN="${ORIGIN%/}"
  TOKEN="$(env_value VOICE_DRAIN_TOKEN)"
  bold "Gemini voice check"
  echo "  through $ORIGIN"
  BODY="{}"
  [ -n "$TEST_VOICE" ] && BODY="{\"voice\":\"$TEST_VOICE\"}"
  echo
  curl -sS -X POST "$ORIGIN/api/voice/tts-check" \
    -H "x-timi-drain-token: $TOKEN" \
    -H "content-type: application/json" \
    -d "$BODY"
  echo
  echo
  dim "  ok:true means the call will play that voice. ok:false gives Google's"
  dim "  own reason and names the Twilio voice speaking in its place."
  dim "  Try a specific one:  $0 $ENV_FILE --tts-check --voice Kore"
  exit 0
fi

if [ -n "$TEST_CALL" ]; then
  ORIGIN="$(env_value VOICE_PUBLIC_URL)"
  [ -n "$ORIGIN" ] || ORIGIN="https://voice.timinow.pet"
  ORIGIN="${ORIGIN%/}"
  TOKEN="$(env_value VOICE_DRAIN_TOKEN)"
  SOURCE="$ENV_FILE"
  # What was actually deployed. This flag exits before step 0, so a value added
  # to the env file since the last full run is still sitting on this machine —
  # and the Worker then answers about a token it has never been given, which
  # reads as though the env file were wrong.
  DEPLOYED="$(CONFIG="$VOICE" node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.env.CONFIG, "utf8").replace(/^\s*\/\/.*$/gm, "");
    process.stdout.write((JSON.parse(text).vars || {}).VOICE_DRAIN_TOKEN || "");
  ' 2>/dev/null || true)"
  # Falling back to the wrangler config, because that is what was deployed and
  # therefore what the Worker is actually checking against. A blank value in the
  # env file leaves whatever the config held — set_var skips blanks by design,
  # so "keep the current value" is a legitimate answer — and the two can drift.
  # Testing against the env file alone reports a token missing while the Worker
  # is happily holding one.
  if [ -z "$TOKEN" ] && [ -n "$DEPLOYED" ]; then
    TOKEN="$DEPLOYED"
    SOURCE="$VOICE (blank in the env file)"
  fi
  bold "Test call"
  echo "  to      $TEST_CALL"
  echo "  through $ORIGIN"
  if [ -z "$TOKEN" ]; then
    die "  VOICE_DRAIN_TOKEN is blank in $ENV_FILE and in $VOICE, and the endpoint
  will not place a billable call without it. Add one and deploy it:

    echo \"VOICE_DRAIN_TOKEN=\$(openssl rand -hex 24)\" >> $ENV_FILE
    $0 $ENV_FILE"
  fi
  dim "  token   ${TOKEN%${TOKEN#??}}… ${#TOKEN} characters, from $SOURCE"
  if [ "$TOKEN" != "$DEPLOYED" ]; then
    echo
    die "  That token is in $ENV_FILE but has not been deployed — $VOICE
  still holds $([ -n "$DEPLOYED" ] && echo "a different one" || echo "none at all"), and the Worker checks against what it was
  given. This flag stops before the deploy step on purpose.

  Deploy first, then call:

    $0 $ENV_FILE
    $0 $ENV_FILE --test-call $TEST_CALL"
  fi
  echo
  if [ -n "$TEST_VOICE" ]; then
    echo "  voice   $TEST_VOICE (this call only — set VOICE_SAY_VOICE to keep it)"
    BODY="{\"to\":\"$TEST_CALL\",\"voice\":\"$TEST_VOICE\"}"
  else
    CONFIGURED="$(env_value VOICE_SAY_VOICE)"
    echo "  voice   ${CONFIGURED:-Polly.Joanna-Neural (the default)}"
    BODY="{\"to\":\"$TEST_CALL\"}"
  fi
  echo
  curl -sS -X POST "$ORIGIN/api/voice/test-call" \
    -H "x-timi-drain-token: $TOKEN" \
    -H "content-type: application/json" \
    -d "$BODY"
  echo
  echo
  dim "  Auditioning voices: re-run with --voice NAME. Nothing is deployed, so"
  dim "  each call can use a different one. Some to try, most natural first:"
  dim "    Google.en-US-Chirp3-HD-Aoede      Google.en-US-Chirp3-HD-Charon"
  dim "    Google.en-US-Neural2-F            Google.en-US-Studio-O"
  dim "    Polly.Danielle-Neural             Polly.Joanna-Neural"
  dim "  A name Twilio does not know fails at answer time — the call connects"
  dim "  and then drops — so if a voice goes silent, that is the name."
  dim "  Keep the one you like: VOICE_SAY_VOICE=<name> in $ENV_FILE, then re-run."
  exit 0
fi

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
set_var MAPBOX_STYLE_URL       "$CUSTOMER" "$VET" "$ADMIN" "$VOICE"
set_var MAPBOX_NAVIGATION_STYLE_URL "$CUSTOMER" "$VET" "$ADMIN"
# The admin console needs the publishable key too: it initializes ConnectJS to
# render Stripe's embedded onboarding component inside the workspace page.
set_var STRIPE_PUBLISHABLE_KEY "$CUSTOMER" "$ADMIN"
set_var STRIPE_ACCOUNTS_API    "$ADMIN"
set_var TWILIO_FROM_NUMBER     "$VOICE"
set_var TWILIO_MESSAGING_FROM  "$VOICE"
set_var TWILIO_MESSAGING_SERVICE_SID "$VOICE"
set_var PUBLIC_APP_URL         "$CUSTOMER"
set_var VOICE_PUBLIC_URL       "$VOICE"
set_var VOICE_CALLS_ENABLED    "$VOICE"
set_var VOICE_MAX_ATTEMPTS     "$VOICE"
set_var VOICE_SAY_VOICE        "$VOICE"
set_var GEMINI_TTS_VOICE       "$VOICE"
set_var GEMINI_TTS_MODEL       "$VOICE"
set_var GEMINI_TTS_STYLE       "$VOICE"
set_var PLATFORM_ADMIN_EMAILS  "$ADMIN"
set_var PLATFORM_ADMIN_USER_IDS "$ADMIN"
# Shared by both ends of the immediate-dispatch path, so it goes to both.
set_var VOICE_DRAIN_TOKEN      "$CUSTOMER" "$VOICE"
# Optional for the drain itself, which no-ops on an empty queue and is reachable
# over the service binding regardless. Not optional for /api/voice/test-call,
# which places a real, billable call and therefore refuses to run without one —
# and "not permitted" is a confusing answer when the reason is that nobody ever
# set a token.
if ! have VOICE_DRAIN_TOKEN; then
  warn "  VOICE_DRAIN_TOKEN is blank, so /api/voice/test-call will refuse to"
  warn "  place a test call. Add a line like this to $ENV_FILE and re-run:"
  dim  "    VOICE_DRAIN_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
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

# The publishable key carries its own host, base64-encoded. CLERK_ISSUER and
# CLERK_JWKS_URL name the same instance separately, and a file edited halfway —
# key updated, issuer left behind — deploys a Worker that hands browsers one
# instance and verifies tokens against another. Every symptom of that points
# somewhere else.
if ! $DRY && have CLERK_PUBLISHABLE_KEY; then
  CLERK_HOST_FROM_KEY="$(printf '%s' "$(env_value CLERK_PUBLISHABLE_KEY)" | node -e '
    let key = "";
    process.stdin.on("data", (chunk) => { key += chunk; });
    process.stdin.on("end", () => {
      const encoded = key.trim().replace(/^pk_(live|test)_/, "");
      if (!encoded || encoded === key.trim()) return;
      const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) process.stdout.write(host);
    });
  ' 2>/dev/null || true)"
  for PAIR in "CLERK_ISSUER" "CLERK_JWKS_URL"; do
    PAIR_VALUE="$(env_value "$PAIR")"
    [ -n "$PAIR_VALUE" ] || continue
    PAIR_HOST="$(printf '%s' "$PAIR_VALUE" | sed -E 's#^https?://##; s#/.*$##')"
    if [ -n "$CLERK_HOST_FROM_KEY" ] && [ "$PAIR_HOST" != "$CLERK_HOST_FROM_KEY" ]; then
      die "  $PAIR names $PAIR_HOST, but CLERK_PUBLISHABLE_KEY decodes to
  $CLERK_HOST_FROM_KEY. They must be the same Clerk instance — browsers would
  be sent to one and tokens verified against the other.

  This is what a half-finished edit looks like. Nothing was deployed."
    fi
  done
fi

bold "1b. Sign-in is possible"
# A blank CLERK_PUBLISHABLE_KEY is not a configuration, it is an outage: the
# Worker deploys, the page loads, and /api/config serves null, so ClerkJS never
# initialises and nobody can sign in on any surface. Every other blank value in
# the env file is a legitimate "keep the default", which is why set_var skips
# them — this is the one where skipping ships a dead site. Checked against the
# configs about to be deployed, not against the env file, so a value that was
# never written is caught the same as one that was cleared.
for CONFIG in "$CUSTOMER" "$VET" "$ADMIN"; do
  REQUIRED="$(CONFIG="$CONFIG" node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.env.CONFIG, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const vars = JSON.parse(text).vars || {};
    process.stdout.write(vars.SIGN_IN_REQUIRED === "true" ? (vars.CLERK_PUBLISHABLE_KEY || "") : "exempt");
  ')"
  if [ -z "$REQUIRED" ]; then
    die "  $CONFIG requires sign-in and has no CLERK_PUBLISHABLE_KEY.

  Deploying it would serve a sign-in page that cannot sign anyone in: the
  browser asks /api/config for the key, gets null, and ClerkJS never starts.
  Nothing was deployed.

  Put the publishable key from your Clerk instance in $ENV_FILE:

    CLERK_PUBLISHABLE_KEY=pk_live_...

  It is on Clerk's dashboard under Configure -> API keys, and it is public —
  it is served to every browser by design. The matching CLERK_SECRET_KEY is
  not, and goes in the same file as a secret."
  fi
done
echo "  all three browser surfaces have a publishable key"
echo

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
  # Cloudflare answers an unauthorized D1 request with code 7403 and the
  # sentence "The given account is not valid or is not authorized to access
  # this service", which names neither D1 nor the credential being used and
  # reads like a broken account. It is almost always one of two things, and
  # both are worth saying out loud rather than leaving to a search engine.
  if ! npm run db:migrate:remote; then
    warn ""
    warn "  The migration was refused. Two things cause this and the message names neither:"
    warn ""
    warn "  1. CLOUDFLARE_API_TOKEN is set in this shell. wrangler prefers it over the"
    warn "     account you logged in as, and a token with Workers Scripts:Edit but not"
    warn "     D1:Edit deploys perfectly and cannot touch the database — which is exactly"
    warn "     what a half-working setup looks like."
    warn "       unset CLOUDFLARE_API_TOKEN   then run this again"
    warn ""
    warn "  2. The login predates D1, or belongs to another account."
    warn "       npx wrangler login           then run this again"
    warn ""
    warn "  npx wrangler whoami prints which of the two you have: it names the account"
    warn "  and, for a token, the permissions it carries."
    die "  Nothing was deployed. The database has to be migrated before the Workers that read it."
  fi
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

# Values whose shape is knowable, checked here rather than at the moment they
# are used. A Twilio API Key SID starts SK and an Account SID starts AC; they
# are the same length and Twilio answers a call made with the wrong one with
# the single word "Authenticate", hours after the deploy that caused it.
check_secret_shape() { # check_secret_shape KEY VALUE
  case "$1" in
    TWILIO_ACCOUNT_SID)
      case "$2" in
        AC*) [ "${#2}" -eq 34 ] || die "  TWILIO_ACCOUNT_SID is ${#2} characters. An Account SID is \"AC\" and 32 hex characters." ;;
        SK*) die "  TWILIO_ACCOUNT_SID starts \"SK\", which is an API Key SID, not an Account SID.

  They are the same length and easy to confuse. Only the Account SID works:
  it goes into the request URL as /Accounts/AC.../Calls.json, so an API key
  there produces a 401 saying only \"Authenticate\".

  Both are on the Twilio console home page. Take the Account SID (AC...) and
  the Auth Token beside it — and check TWILIO_AUTH_TOKEN too, since an API
  Key Secret is also 32 characters and looks just as plausible. The auth
  token is what signs the webhooks, so the wrong one breaks inbound calls as
  well as outbound." ;;
        *)   die "  TWILIO_ACCOUNT_SID does not look like an Account SID. It is \"AC\" and 32 hex characters, from the Twilio console home page." ;;
      esac ;;
    TWILIO_AUTH_TOKEN)
      [ "${#2}" -eq 32 ] || die "  TWILIO_AUTH_TOKEN is ${#2} characters; a Twilio auth token is 32. Check for a truncated paste or surrounding quotes." ;;
    STRIPE_SECRET_KEY)
      case "$2" in
        sk_live_*|sk_test_*|rk_live_*|rk_test_*) : ;;
        pk_*) die "  STRIPE_SECRET_KEY starts \"pk_\", which is the PUBLISHABLE key.

  They sit next to each other on the same dashboard page and are easy to swap.
  A publishable key here means every charge, transfer and refund is refused
  with \"Invalid API Key provided\", and the reverse mistake is worse — a
  secret key in STRIPE_PUBLISHABLE_KEY is served to every browser by
  /api/config. Take the one revealed behind \"Reveal live key\"." ;;
        whsec_*) die "  STRIPE_SECRET_KEY starts \"whsec_\", which is a webhook signing secret. That belongs in STRIPE_WEBHOOK_SECRET." ;;
        *) die "  STRIPE_SECRET_KEY does not look like a Stripe secret key. It starts sk_live_, sk_test_, or rk_ for a restricted key." ;;
      esac ;;
    STRIPE_WEBHOOK_SECRET)
      case "$2" in
        whsec_*) : ;;
        # This one is worth naming precisely. A webhook endpoint configured
        # with the wrong secret does not fail loudly — it rejects every event,
        # so deposits are charged and never marked paid, clinics are never
        # transferred to, and the only symptom is a queue of failed deliveries
        # in a Stripe dashboard nobody is watching.
        sk_*|pk_*) die "  STRIPE_WEBHOOK_SECRET holds an API key, not a webhook signing secret.

  The signing secret starts \"whsec_\" and is specific to one endpoint. Find
  it under Developers → Webhooks → your endpoint → \"Reveal\". With the wrong
  value here the Worker rejects every event Stripe sends: deposits get charged
  and never marked paid, and nothing is ever transferred to a clinic." ;;
        *) die "  STRIPE_WEBHOOK_SECRET does not start \"whsec_\". It is per-endpoint — Developers → Webhooks → your endpoint → Reveal." ;;
      esac ;;
  esac
}

put_secret() { # put_secret KEY CONFIG...
  local key="$1"; shift
  local value
  value="$(env_value "$key")"
  [ -n "$value" ] || { dim "  skip  $key (blank in env file)"; SKIPPED="$SKIPPED $key"; return 0; }
  check_secret_shape "$key" "$value"
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

# Ask Twilio whether the pair is real, rather than finding out on the first
# call. Both values can be perfectly well formed and still belong to different
# accounts, or the token can have been rotated in the console — and the only
# symptom is a 401 whose body is the word "Authenticate", arriving whenever a
# clinic finally needed a phone call.
#
# One GET, no telephony, nothing billable. Credentials go in on stdin rather
# than argv, so they never appear in `ps` or in shell history.
if ! $DRY && have TWILIO_ACCOUNT_SID && have TWILIO_AUTH_TOKEN; then
  bold "4b. Twilio credentials"
  TW_SID="$(env_value TWILIO_ACCOUNT_SID)"
  TW_STATUS="$(printf 'user = "%s:%s"\n' "$TW_SID" "$(env_value TWILIO_AUTH_TOKEN)" \
    | curl -sS --config - -o /dev/null -w '%{http_code}' --max-time 20 \
      "https://api.twilio.com/2010-04-01/Accounts/$TW_SID.json" 2>/dev/null || echo "000")"
  case "$TW_STATUS" in
    200) echo "  accepted by Twilio" ;;
    401) die "  Twilio rejected TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN together (401).

  Both are the right shape, so this is not a typo — they do not belong to the
  same active account. The usual causes, in order:

    * the Auth Token is an API Key Secret. Both are 32 characters, and the
      one that works here is the Auth Token on the Twilio console home page,
      directly beside the Account SID.
    * the token was rotated in the console, and this is the previous one.
    * the SID is a subaccount's and the token is the parent account's.

  Copy both from the console home page in one go, at the same moment.
  Nothing was deployed." ;;
    000) warn "  Could not reach Twilio to check the credentials — continuing." ;;
    *)   warn "  Twilio answered $TW_STATUS when checking the credentials. Continuing," ;
         warn "  but expect calls to fail if this is not a transient error." ;;
  esac
  echo
fi

# Ask Stripe whether the key works, and whether the two keys are the same
# account and the same mode, rather than finding out when somebody's card is
# declined. `GET /v1/balance` is a read: no charge, no object created, nothing
# billable. The key goes in on stdin so it never reaches argv or shell history.
#
# The mode mismatch is the one worth catching. A live secret key with a test
# publishable key looks entirely fine on both dashboards and fails only at the
# moment a real customer confirms a payment, with "No such payment_intent".
if ! $DRY && have STRIPE_SECRET_KEY; then
  bold "4c. Stripe credentials"
  ST_SECRET="$(env_value STRIPE_SECRET_KEY)"
  ST_STATUS="$(printf 'user = "%s:"\n' "$ST_SECRET" \
    | curl -sS --config - -o /dev/null -w '%{http_code}' --max-time 20 \
      "https://api.stripe.com/v1/balance" 2>/dev/null || echo "000")"
  case "$ST_STATUS" in
    200) echo "  accepted by Stripe" ;;
    401) die "  Stripe rejected STRIPE_SECRET_KEY (401).

  The key is the right shape, so this is not a typo: it has been rolled,
  deleted, or belongs to a different account. Take a fresh one from
  Developers → API keys. Nothing was deployed." ;;
    403) warn "  Stripe answered 403. If this is a restricted key, it needs write access to" ;
         warn "  PaymentIntents, Transfers, Refunds, Connect accounts and Account sessions." ;;
    000) warn "  Could not reach Stripe to check the key — continuing." ;;
    *)   warn "  Stripe answered $ST_STATUS when checking the key. Continuing, but expect" ;
         warn "  deposits to fail if this is not transient." ;;
  esac

  if have STRIPE_PUBLISHABLE_KEY; then
    ST_PUB="$(env_value STRIPE_PUBLISHABLE_KEY)"
    ST_SECRET_MODE="test"; case "$ST_SECRET" in *_live_*) ST_SECRET_MODE="live" ;; esac
    ST_PUB_MODE="test";    case "$ST_PUB"    in pk_live_*) ST_PUB_MODE="live" ;; esac
    if [ "$ST_SECRET_MODE" != "$ST_PUB_MODE" ]; then
      die "  STRIPE_SECRET_KEY is a ${ST_SECRET_MODE} key and STRIPE_PUBLISHABLE_KEY is a ${ST_PUB_MODE} key.

  A mixed pair fails in the least helpful way there is. The PaymentIntent is
  created in one mode and the browser or app tries to confirm it in the other,
  so the customer sees \"No such payment_intent\" at the moment they press pay,
  and both dashboards look perfectly healthy. Take both keys from the same
  page, in the same mode. Nothing was deployed."
    fi
    echo "  secret and publishable keys are both ${ST_SECRET_MODE} mode"
  fi
  echo
fi

bold "5. Worker secrets"
put_secret CLERK_SECRET_KEY      "$CUSTOMER" "$VET" "$ADMIN" "$VOICE"
# Not a secret in the security sense — it is served to every browser by
# /api/config — but GitHub's scanner flags any Mapbox token, so committing it
# would block every future push with a false positive. Delivered as a secret so
# it never enters version control at all. Worker code reads it identically.
put_secret MAPBOX_PUBLIC_TOKEN   "$CUSTOMER" "$VET" "$ADMIN"
put_secret TWILIO_ACCOUNT_SID    "$VOICE"
put_secret TWILIO_AUTH_TOKEN     "$VOICE"
put_secret GEMINI_API_KEY        "$VOICE"
# Signs Feature B's care-search restore link. Only the customer Worker builds
# or verifies one.
put_secret SEARCH_LINK_SECRET    "$CUSTOMER"
# The customer Worker charges the deposit and receives the webhook; the admin
# Worker creates connected accounts and reads their capabilities. The
# veterinary Worker gets neither — its payouts view reads the D1 ledger and
# never talks to Stripe, so there is no reason to put a key that can move
# money on it.
put_secret STRIPE_SECRET_KEY     "$CUSTOMER" "$ADMIN"
# Only the Worker that serves /api/stripe/webhook.
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
    [ -n "$value" ] || { dim "  skip  $key (blank in env file)"; SKIPPED="$SKIPPED $key"; return 0; }
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

bold "8. Clerk"
# Every Worker can be deployed correctly and every client still stuck on
# "Tími could not reach Clerk": the publishable key names a Frontend API host,
# and if that host does not answer, sign-in cannot start anywhere. The apps
# have no way to tell that apart from a bad Worker URL, so it is checked here,
# where the answer is knowable.
if ! $DRY; then
  CONFIG="$(curl -fsS --max-time 10 "https://timinow.pet/api/config" 2>/dev/null || true)"
  CLERK_HOST="$(printf '%s' "$CONFIG" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let key;
      try { key = JSON.parse(raw).clerkPublishableKey; } catch { return; }
      if (typeof key !== "string") return;
      const encoded = key.replace(/^pk_(live|test)_/, "");
      if (encoded === key) return;
      // Clerk base64-encodes the host and terminates it with a dollar sign.
      const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) process.stdout.write(host);
    });
  ' 2>/dev/null || true)"
  if [ -z "$CLERK_HOST" ]; then
    warn "  timinow.pet/api/config serves no usable CLERK_PUBLISHABLE_KEY, so"
    warn "  sign-in cannot start on any surface. Set CLERK_PUBLISHABLE_KEY in"
    warn "  your env file and run this again."
  else
    printf '  %-26s ' "$CLERK_HOST"
    JWKS="$(curl -fsS --max-time 10 "https://$CLERK_HOST/.well-known/jwks.json" 2>/dev/null || true)"
    if printf '%s' "$JWKS" | grep -q '"keys"'; then
      echo "serving JWKS"
    else
      echo "NOT ANSWERING"
      warn "  Until this host answers, every client says \"could not reach Clerk\"."
      case "$JWKS" in
        *"prohibited IP"*|*"Error 1000"*)
          warn "  Cloudflare is refusing it — \"DNS points to prohibited IP\". The"
          warn "  record for $CLERK_HOST is proxied (orange cloud), and Clerk's"
          warn "  own frontend-api.clerk.services sits behind Cloudflare too, so"
          warn "  the proxy resolves to itself and stops."
          dim  "  Cloudflare -> DNS: set clerk, accounts, clkmail, clk._domainkey"
          dim  "  and clk2._domainkey to DNS only (grey cloud). Nothing else changes."
          ;;
        "")
          warn "  Nothing answered at all, so the DNS record is missing entirely."
          dim  "  Clerk's dashboard lists the CNAMEs to add, under Configure -> Domains."
          ;;
        *)
          warn "  It answered, but not with a JWKS:"
          dim  "    $(printf '%s' "$JWKS" | head -1 | cut -c1-96)"
          ;;
      esac
      warn "  The key itself may also simply be the wrong instance's — a key from"
      warn "  a deleted or renamed Clerk application decodes to a host that no"
      warn "  longer exists, and looks exactly like this."
    fi

    # The iPhone and macOS apps talk to Clerk as native clients, which is the
    # only way an app can create an account: web-mode /v1/client/sign_ups is
    # guarded by a Turnstile CAPTCHA that a native app has no way to render,
    # and Clerk answers it with captcha_missing_token. Nothing about that error
    # names the toggle that fixes it, so this asks Clerk directly.
    printf '  %-26s ' "native API"
    NATIVE="$(curl -fsS --max-time 10 -X POST "https://$CLERK_HOST/v1/client?_is_native=true" 2>/dev/null || curl -sS --max-time 10 -X POST "https://$CLERK_HOST/v1/client?_is_native=true" 2>/dev/null || true)"
    case "$NATIVE" in
      *native_api_disabled*)
        echo "DISABLED"
        warn "  The Apple apps can sign existing people in, but nobody can create"
        warn "  an account: Clerk rejects the sign-up with captcha_missing_token."
        dim  "  Clerk dashboard -> Configure -> Native applications: enable it."
        ;;
      "")
        warn "could not be checked (no answer)"
        ;;
      *)
        echo "enabled"
        ;;
    esac

    # What the instance requires before a sign-up can complete. The apps sign
    # people in with a code and never ask for a password, so a required
    # password means nobody can ever create an account — the sign-up is made,
    # the code is accepted, and the account still does not exist. Clerk states
    # this plainly at /v1/environment, and nowhere the apps can show it.
    printf '  %-26s ' "sign-up requirements"
    ENVJSON="$(curl -fsS --max-time 10 "https://$CLERK_HOST/v1/environment?_is_native=true" 2>/dev/null || true)"
    REQUIRED="$(printf '%s' "$ENVJSON" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        let attributes;
        try { const body = JSON.parse(raw); attributes = (body.response || body).user_settings.attributes; }
        catch { return; }
        const required = Object.entries(attributes)
          .filter(([, value]) => value && value.enabled && value.required)
          .map(([name]) => name);
        process.stdout.write(required.join(" "));
      });
    ' 2>/dev/null || true)"
    if [ -z "$ENVJSON" ]; then
      warn "could not be checked (no answer)"
    else
      echo "${REQUIRED:-none}"
      case " $REQUIRED " in
        *" password "*)
          warn "  A password is required, and neither app asks for one, so nobody"
          warn "  can create an account: the code is accepted and the sign-up"
          warn "  still ends at missing_requirements."
          dim  "  Clerk dashboard -> Configure -> Email, phone, username:"
          dim  "  set Password to optional (or off)."
          ;;
      esac
      case " $REQUIRED " in
        *" phone_number "*)
          case " $REQUIRED " in
            *" email_address "*) ;;
            *)
              dim  "  Only a mobile number can create an account here — an email"
              dim  "  address alone will never satisfy phone_number."
              ;;
          esac
          ;;
      esac
    fi
  fi
fi
echo

if [ -n "$SKIPPED" ]; then
  # Blank is a legitimate answer for most of these — CLERK_JWKS_URL is meant to
  # be derived, STRIPE_* is not configured yet. It is legitimate right up until
  # it is the one you needed, and by then it has scrolled off the top.
  warn "Left blank in $ENV_FILE, so nothing was deployed for them:"
  for KEY in $SKIPPED; do dim "    $KEY"; done
  echo
fi

bold "Done."
echo "Public values changed in the wrangler configs. They are deployed already —"
echo "committing them is optional, and only worth it for values you want other"
echo "machines to inherit (hostnames, style URLs, admin emails):"
echo "    git diff --stat"
echo "    git add wrangler.jsonc wrangler.vet.jsonc wrangler.admin.jsonc wrangler.voice.jsonc"
echo "    git commit -m 'Configure production keys' && git push"
echo
echo "Never 'git add -A' after this runs: it sweeps up every config at once, and"
echo "one rejected file blocks the whole push."
echo
echo "And do not 'git pull' by hand before running this again. Step 1 above"
echo "rewrites those four configs every time, so a plain pull stops on \"local"
echo "changes would be overwritten\". Step 0 already pulls, and discards exactly"
echo "those four files first because it is about to overwrite them anyway."
