#!/usr/bin/env bash
#
# Build and run Layout Lab on an iPad simulator.
#
#   ./scripts/build-layout-lab.sh
#   ./scripts/build-layout-lab.sh --device 'iPad Pro 13'
#
# No signing, no Apple account, no network: it is a simulator build of an app
# that talks to nothing. See apps/layout-lab/README.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/layout-lab"
DEVICE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v xcodegen >/dev/null 2>&1 || {
  echo "xcodegen is not installed. brew install xcodegen" >&2; exit 1; }

echo "==> generating the Xcode project"
( cd "$APP/Darwin" && xcodegen generate )

# An iPad, because the app is iPad-only — three panes side by side need the
# width, and TARGETED_DEVICE_FAMILY says so.
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices available \
    | grep -oE 'iPad[^(]*' | sed 's/ *$//' | tail -1)"
fi
[ -n "$DEVICE" ] || { echo "No iPad simulator found. Create one in Xcode." >&2; exit 1; }

echo "==> building for $DEVICE"
DERIVED="$APP/.build/derived"
xcodebuild -project "$APP/Darwin/LayoutLab.xcodeproj" \
  -scheme LayoutLab \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  build | tail -20

BUILT="$DERIVED/Build/Products/Debug-iphonesimulator/LayoutLab.app"
[ -d "$BUILT" ] || { echo "Build produced no app at $BUILT" >&2; exit 1; }

echo "==> installing on $DEVICE"
xcrun simctl boot "$DEVICE" 2>/dev/null || true
open -a Simulator
xcrun simctl install booted "$BUILT"
xcrun simctl launch booted solutions.clearkey.layoutlab >/dev/null
echo "==> running"
