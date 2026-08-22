#!/usr/bin/env bash
#
# Build the customer app and run it on a simulator.
#
#   ./scripts/build-ios-app.sh
#   ./scripts/build-ios-app.sh --device 'iPhone 17 Pro'
#   ./scripts/build-ios-app.sh --build-only
#
# A simulator build needs no Apple developer account and no signing. Putting it
# on a real iPhone does — ./scripts/install-ios-device.sh handles that over
# USB-C, and ./scripts/upload-testflight.sh sends a build to TestFlight.
#
# Maps and turn-by-turn are only compiled in when a Mapbox downloads token is
# configured, because the Mapbox SDKs are binary dependencies fetched over
# authenticated HTTP. `./scripts/bootstrap.sh <env-file>` writes that token to
# ~/.netrc; this script sets TIMI_MAPBOX itself when it finds it there. Without
# it you get the non-Mapbox fallback — a ranked clinic list, no live map — and
# the run below says so rather than leaving you to notice.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/build-ios-app.sh" >&2
  exit 1
fi

set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/apple-build.sh

# A killed script must not leave the heartbeat behind.
trap 'stop_heartbeat' EXIT INT TERM

DEVICE=""
RUN=true
while [ $# -gt 0 ]; do
  case "$1" in
    --device)     DEVICE="${2:-}"; shift 2 ;;
    --build-only) RUN=false; shift ;;
    *)            die "unknown option: $1" ;;
  esac
done

APP_DIR="apps/customer-mobile"
BUNDLE_ID="solutions.clearkey.timinow"

command -v xcodebuild >/dev/null || die "Xcode is required (the full app, not just the command line tools)."
command -v xcodegen   >/dev/null || die "xcodegen is required: brew install xcodegen"

bold "1. Mapbox"
select_mapbox

bold "2. Simulator"
if [ -z "$DEVICE" ]; then
  # Newest booted simulator if there is one, otherwise the newest available
  # iPhone. Picking by name rather than by udid keeps the message readable.
  DEVICE="$(xcrun simctl list devices available --json \
    | python3 -c '
import json, sys
data = json.load(sys.stdin)["devices"]
booted = [d["name"] for runtime in data for d in data[runtime] if d.get("state") == "Booted"]
if booted:
    print(booted[0]); raise SystemExit
iphones = [d["name"] for runtime in sorted(data) for d in data[runtime] if d["name"].startswith("iPhone")]
print(iphones[-1] if iphones else "")')"
fi
[ -n "$DEVICE" ] || die "  No iPhone simulator available. Install one in Xcode -> Settings -> Components."
echo "  $DEVICE"

bold "3. Xcode project"
( cd "$APP_DIR/Darwin" && xcodegen generate >/dev/null )
echo "  generated"

bold "4. Build"
dim "  The first build compiles the whole Skip stack — expect several minutes."
dim "  Full output: /tmp/timi-ios-build.log"
run_build /tmp/timi-ios-build.log "$APP_DIR" xcodebuild \
  -workspace Project.xcworkspace \
  -scheme TimiNow \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -derivedDataPath build \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
  build
if [ "$BUILD_STATUS" -ne 0 ]; then
  summarise_failure /tmp/timi-ios-build.log
  die "  Build failed after $(( SECONDS / 60 ))m. Full log: /tmp/timi-ios-build.log"
fi
echo "  finished in $(( SECONDS / 60 ))m $(( SECONDS % 60 ))s"

BUILT="$APP_DIR/build/Build/Products/Debug-iphonesimulator/TimiNow.app"
[ -d "$BUILT" ] || die "  Build reported success but $BUILT is missing."
echo "  built $BUILT"

bold "5. Run"
if $RUN; then
  xcrun simctl boot "$DEVICE" 2>/dev/null || true
  open -a Simulator
  xcrun simctl install booted "$BUILT"
  xcrun simctl launch booted "$BUNDLE_ID" >/dev/null
  echo "  running on $DEVICE"
else
  dim "  skipped (--build-only)"
fi
echo
