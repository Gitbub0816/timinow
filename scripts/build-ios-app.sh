#!/usr/bin/env bash
#
# Build the customer app and run it on a simulator.
#
#   ./scripts/build-ios-app.sh
#   ./scripts/build-ios-app.sh --device 'iPhone 17 Pro'
#   ./scripts/build-ios-app.sh --build-only
#
# A simulator build needs no Apple developer account and no signing. Putting
# the app on a real iPhone does: open Project.xcworkspace, pick your team under
# Signing & Capabilities, and run it from Xcode.
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

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

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
if grep -q "api.mapbox.com" "$HOME/.netrc" 2>/dev/null; then
  export TIMI_MAPBOX=1
  echo "  downloads token found — building with the map and turn-by-turn"
else
  warn "  No api.mapbox.com entry in ~/.netrc, so this build takes the"
  warn "  non-Mapbox fallback: a ranked clinic list, no live map, no navigation."
  dim  "  ./scripts/bootstrap.sh <your-env-file> writes that entry for you."
fi

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
( cd "$APP_DIR" && xcodebuild \
    -workspace Project.xcworkspace \
    -scheme TimiNow \
    -sdk iphonesimulator \
    -destination "platform=iOS Simulator,name=$DEVICE" \
    -derivedDataPath build \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    CODE_SIGNING_ALLOWED=NO \
    build ) > /tmp/timi-ios-build.log 2>&1 || {
      echo
      grep -E "error:" /tmp/timi-ios-build.log | sort -u | head -20 >&2
      die "  Build failed. Full log: /tmp/timi-ios-build.log"
    }

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
