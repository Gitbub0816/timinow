#!/usr/bin/env bash
#
# Build the macOS veterinary console and put it in /Applications.
#
#   ./scripts/build-mac-app.sh
#   ./scripts/build-mac-app.sh --team ABCDE12345
#   ./scripts/build-mac-app.sh --no-install
#
# The console keeps its Clerk credentials in the Keychain rather than in the
# settings file, which means the app declares a keychain-access-group, which
# means macOS will only run it signed by a real development certificate.
# `CODE_SIGNING_ALLOWED=NO` produces a bundle that builds and then refuses to
# launch, so this script signs properly instead.
#
# The team is found in this order: --team, DEVELOPMENT_TEAM in the
# environment, Darwin/Local.xcconfig, then the Apple Development certificate
# in your login keychain. Whatever it resolves is written to
# Darwin/Local.xcconfig (git-ignored) so every later build and every Xcode
# launch picks it up without being asked again.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/build-mac-app.sh" >&2
  exit 1
fi

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# A silent terminal for ten minutes is indistinguishable from a hang, and the
# first build genuinely takes that long: Skip transpiles its whole stack before
# Xcode compiles anything. So the output is piped through a filter rather than
# hidden in a log — the log is still written, for summarising a failure.
#
# Piped rather than followed with `tail -f`: in `a | b | c &` the shell reports
# only c's pid, so killing it would leave tail running after the script exits.
# Matches the phase headings xcodebuild prints, plus anything that names an
# error. The skipstone plugin's own output is thousands of note: lines naming
# every transpiled file, which is the one phase that must NOT be echoed — so
# the heartbeat below covers the silence instead.
BUILD_FILTER='^(Skip |Compiling|Compile|Build|Ld |Link|CodeSign|Signing|Touch|Copy|Prepare|Resolve|Apply build tool|Process build tool|Create|Validate|\*\* |error:|.*: error:)'

# xcodebuild goes quiet for minutes at a time while Skip transpiles its stack.
# Without this there is no way to tell that from a hang.
start_heartbeat() {
  ( elapsed=0
    while true; do
      sleep 30
      elapsed=$(( elapsed + 30 ))
      printf '\033[2m  … still building (%dm%02ds)\033[0m\n' "$(( elapsed / 60 ))" "$(( elapsed % 60 ))"
    done ) &
  HEARTBEAT_PID=$!
}

stop_heartbeat() {
  [ -n "${HEARTBEAT_PID:-}" ] && kill "$HEARTBEAT_PID" 2>/dev/null
  HEARTBEAT_PID=""
}

# A killed script must not leave the heartbeat behind.
trap 'stop_heartbeat' EXIT INT TERM

TEAM="${DEVELOPMENT_TEAM:-}"
INSTALL=true
while [ $# -gt 0 ]; do
  case "$1" in
    --team)       TEAM="${2:-}"; shift 2 ;;
    --no-install) INSTALL=false; shift ;;
    *)            die "unknown option: $1" ;;
  esac
done

APP_DIR="apps/vet-desktop"
LOCAL_CONFIG="$APP_DIR/Darwin/Local.xcconfig"

command -v xcodebuild >/dev/null || die "Xcode is required (xcode-select --install is not enough — the full Xcode app)."
command -v xcodegen   >/dev/null || die "xcodegen is required: brew install xcodegen"

bold "1. Signing identity"
if [ -z "$TEAM" ] && [ -f "$LOCAL_CONFIG" ]; then
  TEAM="$(awk -F'=' '/^[[:space:]]*DEVELOPMENT_TEAM/ { gsub(/[[:space:]]/, "", $2); print $2 }' "$LOCAL_CONFIG")"
  [ -n "$TEAM" ] && dim "  from $LOCAL_CONFIG"
fi
if [ -z "$TEAM" ]; then
  # The team id is the OU of the Apple Development certificate. The name in
  # parentheses on the certificate is the individual, not the team, so reading
  # it from there gives a value that looks right and signs nothing.
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | tr ',/' '\n\n' | awk -F'=' '/OU=/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
  [ -n "$TEAM" ] && dim "  from the Apple Development certificate in your login keychain"
fi
if [ -z "$TEAM" ]; then
  die "  No Apple development team found.

  Open Xcode once, sign in under Settings -> Accounts, and let it create a
  development certificate. Then run this again, or pass the team directly:

    ./scripts/build-mac-app.sh --team ABCDE12345

  The team id is the ten-character string beside your name at
  https://developer.apple.com/account (Membership details)."
fi
echo "  team $TEAM"

printf '// Written by scripts/build-mac-app.sh. Git-ignored, personal to this machine.\nDEVELOPMENT_TEAM = %s\n' "$TEAM" > "$LOCAL_CONFIG"

bold "2. Xcode project"
( cd "$APP_DIR/Darwin" && xcodegen generate >/dev/null )
echo "  generated"

bold "3. Build"
dim "  The first build compiles the whole Skip stack — expect several minutes."
dim "  Full output: /tmp/timi-mac-build.log"
set +e +o pipefail
start_heartbeat
# -allowProvisioningUpdates lets Xcode create the development profile for the
# keychain-access-group on first run rather than failing with a bare
# "requires a development certificate". It talks to Apple to do that, so if
# this stalls at signing, the account it needs is not signed in: open Xcode ->
# Settings -> Accounts, add your Apple ID, then run this again.
( cd "$APP_DIR" && xcodebuild \
    -workspace Project.xcworkspace \
    -scheme TimiVet \
    -destination 'generic/platform=macOS' \
    -configuration Release \
    -derivedDataPath build \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM" \
    build ) 2>&1 \
  | tee /tmp/timi-mac-build.log \
  | grep --line-buffered -E "$BUILD_FILTER" \
  | awk '{ if (length($0) > 110) $0 = substr($0, 1, 107) "..."; print "  " $0; fflush() }'
BUILD_STATUS=${PIPESTATUS[0]}
set -e -o pipefail
stop_heartbeat
if [ "$BUILD_STATUS" -ne 0 ]; then
  echo >&2
  grep -E "error:" /tmp/timi-mac-build.log | sort -u | head -20 >&2
  die "  Build failed after $(( SECONDS / 60 ))m. Full log: /tmp/timi-mac-build.log"
fi
echo "  finished in $(( SECONDS / 60 ))m $(( SECONDS % 60 ))s"

BUILT="$APP_DIR/build/Build/Products/Release/TimiVet.app"
[ -d "$BUILT" ] || die "  Build reported success but $BUILT is missing."
echo "  built $BUILT"

bold "4. Install"
if $INSTALL; then
  rm -rf "/Applications/TimiVet.app"
  cp -R "$BUILT" /Applications/
  echo "  /Applications/TimiVet.app"
  dim "  open -a TimiVet"
else
  dim "  skipped (--no-install)"
  dim "  open $BUILT"
fi
echo
