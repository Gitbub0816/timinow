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

. scripts/lib/apple-build.sh

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
if [ -z "$TEAM" ]; then
  TEAM="$(resolve_team "$LOCAL_CONFIG")"
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
if [ -n "${RESOLVED_TEAM_SOURCE:-}" ]; then dim "  from $RESOLVED_TEAM_SOURCE"; fi

printf '// Written by scripts/build-mac-app.sh. Git-ignored, personal to this machine.\nDEVELOPMENT_TEAM = %s\n' "$TEAM" > "$LOCAL_CONFIG"

bold "2. Xcode project"
( cd "$APP_DIR/Darwin" && xcodegen generate >/dev/null )
echo "  generated"

bold "3. Build"
dim "  Plain macOS package, no dependencies — this should take well under a minute."
dim "  Full output: /tmp/timi-mac-build.log"
# -allowProvisioningUpdates lets Xcode create the development profile on first
# run rather than failing with a bare "requires a development certificate". It
# talks to Apple to do that, so if this stalls at signing, the account it needs
# is not signed in: open Xcode -> Settings -> Accounts, add your Apple ID, then
# run this again.
run_build /tmp/timi-mac-build.log "$APP_DIR" xcodebuild \
  -workspace Project.xcworkspace \
  -scheme TimiVet \
  -destination 'generic/platform=macOS' \
  -configuration Release \
  -derivedDataPath build \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  build
if [ "$BUILD_STATUS" -ne 0 ]; then
  summarise_failure /tmp/timi-mac-build.log
  die "  Build failed after $(( SECONDS / 60 ))m. Full log: /tmp/timi-mac-build.log"
fi
echo "  finished in $(( SECONDS / 60 ))m $(( SECONDS % 60 ))s"

BUILT="$APP_DIR/build/Build/Products/Release/TimiVet.app"
[ -d "$BUILT" ] || die "  Build reported success but $BUILT is missing."
echo "  built $BUILT"

# A build can succeed and still produce a bundle launchd refuses: the app is
# sandboxed and asks for a keychain group, so it needs a valid signature and an
# embedded provisioning profile. Without them the only symptom is "Launch
# failed ... Unknown error: 163" (EBADEXEC) at open time, which says nothing
# about the cause. Checking here turns that into a message at build time.
bold "3b. Signature"
# By exit status, not by output: codesign --verify is silent on success, so
# grepping its output for a reassuring phrase reports every valid signature as
# invalid.
if ! codesign --verify --strict "$BUILT" 2>/dev/null; then
  codesign --verify --strict --verbose=2 "$BUILT" 2>&1 | tail -5 >&2
  die "  The bundle is not validly signed, so macOS will refuse to launch it."
fi
echo "  signature valid"
if [ -f "$BUILT/Contents/embedded.provisionprofile" ]; then
  echo "  provisioning profile embedded"
else
  warn "  No embedded provisioning profile. A sandboxed app asking for a"
  warn "  keychain group needs one, and without it launchd fails with"
  warn "  \"Unknown error: 163\". Xcode creates it the first time it signs with"
  warn "  a real Apple ID — open Xcode, Settings -> Accounts, add your Apple ID,"
  warn "  then run this again."
fi

# Signed and valid still does not mean launchable: a missing dynamic library or
# an unauthorised entitlement kills the process at exec, and the only symptom
# at `open` time is a message that names neither. Launching it here turns that
# into a failure with the real reason attached.
bold "3c. Launch"
"$BUILT/Contents/MacOS/TimiVet" >/tmp/timi-mac-launch.log 2>&1 &
LAUNCH_PID=$!
sleep 3
if kill -0 "$LAUNCH_PID" 2>/dev/null; then
  # Children first: a GUI app can spawn helpers that would otherwise be
  # reparented to launchd and left running.
  pkill -P "$LAUNCH_PID" 2>/dev/null || true
  kill "$LAUNCH_PID" 2>/dev/null || true
  echo "  starts cleanly"
else
  wait "$LAUNCH_PID" 2>/dev/null
  LAUNCH_STATUS=$?
  echo >&2
  tail -5 /tmp/timi-mac-launch.log >&2 2>/dev/null || true
  if [ "$LAUNCH_STATUS" -eq 137 ] || [ "$LAUNCH_STATUS" -eq 134 ]; then
    warn "  The app was killed at launch (status $LAUNCH_STATUS). The most recent"
    warn "  crash report says why, and names the missing library or the rejected"
    warn "  entitlement directly:"
    dim  "    ls -t ~/Library/Logs/DiagnosticReports/TimiVet* | head -1"
  fi
  die "  Built and signed, but it does not start (status $LAUNCH_STATUS)."
fi

bold "4. Install"
if $INSTALL; then
  rm -rf "/Applications/TimiVet.app"
  # ditto, not cp -R: cp can mangle the symlink layout inside a bundle and
  # invalidate the signature that was just verified.
  ditto "$BUILT" "/Applications/TimiVet.app"
  echo "  /Applications/TimiVet.app"
  # By path, not by name: `open -a TimiVet` asks LaunchServices, which happily
  # picks the copy still sitting in the build directory.
  dim "  open /Applications/TimiVet.app"
else
  dim "  skipped (--no-install)"
  dim "  open $BUILT"
fi
echo
