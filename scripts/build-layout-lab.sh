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

# An iPad, because the app is iPad-only: three panes side by side need the
# width, and TARGETED_DEVICE_FAMILY=2 says so. An iPhone destination is
# rejected by xcodebuild with "doesn't match any of LayoutLab.app's targeted
# device families", which is the setting working rather than a problem.
#
# Resolve a UDID rather than a name. simctl prints
#
#     iPad Pro 13-inch (M5) (2E8DF8DB-...-CBDEBF5EABB9) (Shutdown)
#
# so a name carries parentheses of its own, and matching up to the first "("
# yields the bare word "iPad" — which matches no device and produces a wall
# of "destinations compatible with this scheme". A UDID has none of that
# ambiguity and also pins the runtime, so -destination cannot pick a
# different iPad from the one that gets booted below.
UDID=""
LINES="$(xcrun simctl list devices available | grep -E '^[[:space:]]+iPad' || true)"
[ -n "$LINES" ] || { echo "No iPad simulator is available. Add one in Xcode > Windows > Devices and Simulators." >&2; exit 1; }

if [ -n "$DEVICE" ]; then
  MATCH="$(printf '%s\n' "$LINES" | grep -i -- "$DEVICE" | tail -1 || true)"
  [ -n "$MATCH" ] || {
    echo "No available iPad simulator matches '$DEVICE'. These exist:" >&2
    printf '%s\n' "$LINES" | sed -E 's/ *\([0-9A-Fa-f-]{36}\).*//' | sed 's/^ *//' | sort -u >&2
    exit 1
  }
else
  # simctl groups by runtime in ascending order, so the last iPad line is on
  # the newest installed runtime.
  MATCH="$(printf '%s\n' "$LINES" | tail -1)"
fi

UDID="$(printf '%s\n' "$MATCH" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' | head -1)"
NAME="$(printf '%s\n' "$MATCH" | sed -E 's/ *\([0-9A-Fa-f-]{36}\).*//' | sed 's/^ *//')"
[ -n "$UDID" ] || { echo "Could not read a simulator id out of: $MATCH" >&2; exit 1; }

echo "==> building for $NAME ($UDID)"
DERIVED="$APP/.build/derived"
mkdir -p "$DERIVED"
xcodebuild -project "$APP/Darwin/LayoutLab.xcodeproj" \
  -scheme LayoutLab \
  -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  build > "$DERIVED/build.log" 2>&1 || {
    # Show what actually broke. `| tail -N` on a full xcodebuild log buries
    # the compiler diagnostics under the failed-command summary, which names
    # the file but never the reason.
    echo
    echo "Build failed. Diagnostics:"
    grep -E '(error|warning):' "$DERIVED/build.log" | sort -u | head -40 || true
    echo
    echo "Full log: $DERIVED/build.log"
    exit 1
  }

BUILT="$DERIVED/Build/Products/Debug-iphonesimulator/LayoutLab.app"
[ -d "$BUILT" ] || { echo "Build produced no app at $BUILT" >&2; exit 1; }

echo "==> installing on $NAME"
xcrun simctl boot "$UDID" 2>/dev/null || true
# Opening the Simulator is the one step here with no stable answer: `open -a`
# is a LaunchServices lookup that goes stale when Xcode.app is replaced in
# place, and the path under the developer directory moved in Xcode 27. So try
# the known locations, then the bundle identifier, and if none of them work
# say so and carry on — the app is already installed either way, and failing
# the whole script at the last line over a window is absurd.
SIM=""
for candidate in \
  "$(xcode-select -p)/Applications/Simulator.app" \
  "$(dirname "$(xcode-select -p)")/Applications/Simulator.app" \
  "/Applications/Simulator.app"; do
  if [ -d "$candidate" ]; then SIM="$candidate"; break; fi
done
if [ -z "$SIM" ]; then
  SIM="$(find "$(dirname "$(xcode-select -p)")" -maxdepth 4 -name Simulator.app -type d 2>/dev/null | head -1)"
fi

if [ -n "$SIM" ]; then
  open "$SIM"
elif ! open -b com.apple.iphonesimulator 2>/dev/null; then
  echo "    (could not find Simulator.app \u2014 open it from Xcode; the app is installed)"
fi
# By id, not "booted": another simulator may already be running from the
# customer app's build script, and "booted" would install into that one.
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$BUILT"
xcrun simctl launch "$UDID" solutions.clearkey.layoutlab >/dev/null
echo "==> running on $NAME"
