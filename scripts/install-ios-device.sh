#!/usr/bin/env bash
#
# Build the customer app and install it on an iPhone plugged in over USB-C.
#
#   ./scripts/install-ios-device.sh
#   ./scripts/install-ios-device.sh --device "Caleb's iPhone"
#   ./scripts/install-ios-device.sh --team ABCDE12345
#   ./scripts/install-ios-device.sh --build-only
#
# No Xcode window at any point. What it does need, once:
#
#   * An Apple ID signed in under Xcode -> Settings -> Accounts. A free one is
#     enough — the app then expires after seven days and this script reinstalls
#     it. A paid Apple Developer Program membership makes it a year.
#   * Developer Mode on the phone: Settings -> Privacy & Security -> Developer
#     Mode, on, then reboot. The toggle only appears after a Mac has tried to
#     install something, so if you cannot find it, run this once and look again.
#   * The phone unlocked and trusting this Mac ("Trust This Computer?").
#
# CarPlay is stripped from the device build. The entitlement it needs
# (com.apple.developer.carplay-driving-navigation) is restricted: Apple issues
# no provisioning profile carrying it until a separate CarPlay request is
# approved, so leaving it in fails at signing with a message about profiles
# rather than about CarPlay. Pass --carplay once that approval lands.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/install-ios-device.sh" >&2
  exit 1
fi

set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/apple-build.sh
trap 'stop_heartbeat' EXIT INT TERM

TEAM="${DEVELOPMENT_TEAM:-}"
DEVICE=""
INSTALL=true
CARPLAY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --team)       TEAM="${2:-}"; shift 2 ;;
    --device)     DEVICE="${2:-}"; shift 2 ;;
    --build-only) INSTALL=false; shift ;;
    --carplay)    CARPLAY=true; shift ;;
    *)            die "unknown option: $1" ;;
  esac
done

APP_DIR="apps/customer-mobile"
BUNDLE_ID="solutions.clearkey.timinow"
LOCAL_CONFIG="$APP_DIR/Darwin/Local.xcconfig"
LOG=/tmp/timi-ios-device.log

command -v xcodebuild >/dev/null || die "Xcode is required (the full app, not just the command line tools)."
command -v xcodegen   >/dev/null || die "xcodegen is required: brew install xcodegen"
xcrun devicectl --version >/dev/null 2>&1 \
  || die "xcrun devicectl is missing. It ships with Xcode 15 and later; check xcode-select -p points at the full Xcode."

bold "1. Signing identity"
[ -n "$TEAM" ] || TEAM="$(resolve_team "$LOCAL_CONFIG")"
[ -n "$TEAM" ] || die "  No Apple development team found.

  Open Xcode once, sign in under Settings -> Accounts, and let it create a
  development certificate. Then run this again, or pass the team directly:

    ./scripts/install-ios-device.sh --team ABCDE12345

  The team id is the ten-character string beside your name at
  https://developer.apple.com/account (Membership details)."
echo "  team $TEAM"
if [ -n "${RESOLVED_TEAM_SOURCE:-}" ]; then dim "  from $RESOLVED_TEAM_SOURCE"; fi

bold "2. Entitlements"
# Written next to the committed one and pointed at from Local.xcconfig, which
# TimiNow.xcconfig includes last — see project.yml for why this cannot be a
# target setting.
ENTITLEMENTS="TimiNow.entitlements"
if $CARPLAY; then
  warn "  Keeping the restricted CarPlay entitlement (--carplay). If Apple has"
  warn "  not approved it for $BUNDLE_ID, signing fails with a message about"
  warn "  missing provisioning profiles, not about CarPlay."
else
  ENTITLEMENTS="TimiNow.local.entitlements"
  cp "$APP_DIR/Darwin/TimiNow.entitlements" "$APP_DIR/Darwin/$ENTITLEMENTS"
  for key in com.apple.developer.carplay-driving-navigation \
             com.apple.developer.carplay-audio \
             com.apple.developer.carplay-communication; do
    /usr/libexec/PlistBuddy -c "Delete :$key" "$APP_DIR/Darwin/$ENTITLEMENTS" >/dev/null 2>&1 || true
  done
  echo "  CarPlay removed for this build; everything else kept"
  dim  "  iOS never instantiates the CarPlay scene without the entitlement anyway,"
  dim  "  so nothing you can test on the phone itself is lost."
fi
{
  echo "// Written by scripts/install-ios-device.sh. Git-ignored, personal to this machine."
  echo "DEVELOPMENT_TEAM = $TEAM"
  echo "CODE_SIGN_ENTITLEMENTS = $ENTITLEMENTS"
} > "$LOCAL_CONFIG"

bold "3. iPhone"
DEVICES_JSON="$(mktemp)"
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null 2>&1 || true
SELECTED="$(DEVICE_NAME="$DEVICE" python3 -c '
import json, os, sys

wanted = os.environ.get("DEVICE_NAME") or ""
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    devices = []

def usable(device):
    hardware = device.get("hardwareProperties", {})
    connection = device.get("connectionProperties", {})
    if hardware.get("platform") != "iOS":
        return False
    return connection.get("pairingState") == "paired"

candidates = [d for d in devices if usable(d)]
if wanted:
    candidates = [d for d in candidates
                  if wanted.lower() in d.get("deviceProperties", {}).get("name", "").lower()
                  or wanted == d.get("identifier")]
# A cable beats Wi-Fi: a wired device is present now, where a network one may
# be in another room and asleep.
candidates.sort(key=lambda d: d.get("connectionProperties", {}).get("transportType") != "wired")
if not candidates:
    raise SystemExit
best = candidates[0]
print("\t".join([
    best.get("identifier", ""),
    best.get("deviceProperties", {}).get("name", "iPhone"),
    best.get("connectionProperties", {}).get("transportType", "unknown"),
    best.get("deviceProperties", {}).get("osVersionNumber", "?"),
]))' "$DEVICES_JSON")"
rm -f "$DEVICES_JSON"

if [ -z "$SELECTED" ]; then
  die "  No paired iPhone found.

  Plug it in with the USB-C cable, unlock it, and answer \"Trust\" if it asks.
  Then check what the Mac can see:

    xcrun devicectl list devices

  A phone that appears there but not here is either not paired or not an
  iPhone — pass --device with part of its name to be explicit."
fi
DEVICE_ID="$(printf '%s' "$SELECTED" | cut -f1)"
DEVICE_NAME="$(printf '%s' "$SELECTED" | cut -f2)"
DEVICE_LINK="$(printf '%s' "$SELECTED" | cut -f3)"
DEVICE_OS="$(printf '%s' "$SELECTED" | cut -f4)"
echo "  $DEVICE_NAME — iOS $DEVICE_OS, $DEVICE_LINK"

bold "4. Mapbox"
select_mapbox

bold "5. Xcode project"
( cd "$APP_DIR/Darwin" && xcodegen generate >/dev/null )
echo "  generated"

bold "6. Build"
dim "  Signed for a real device, so this talks to Apple the first time."
dim "  Full output: $LOG"
# generic/platform=iOS rather than the device's own id: xcodebuild identifies
# devices by UDID and devicectl by its own CoreDevice UUID, and they are not
# the same string. A generic device build produces exactly the same bundle.
run_build "$LOG" "$APP_DIR" xcodebuild \
  -workspace Project.xcworkspace \
  -scheme TimiNow \
  -destination 'generic/platform=iOS' \
  -configuration Debug \
  -derivedDataPath build \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  build
if [ "$BUILD_STATUS" -ne 0 ]; then
  summarise_failure "$LOG"
  if grep -q "requires a provisioning profile\|No profiles for\|doesn't support the" "$LOG"; then
    warn "  That is a signing failure, not a compile failure. Either the Apple ID"
    warn "  in Xcode -> Settings -> Accounts cannot create a profile for"
    warn "  $BUNDLE_ID, or an entitlement in the build is one Apple has not"
    warn "  granted for it."
  fi
  die "  Build failed after $(( SECONDS / 60 ))m. Full log: $LOG"
fi
echo "  finished in $(( SECONDS / 60 ))m $(( SECONDS % 60 ))s"

BUILT="$APP_DIR/build/Build/Products/Debug-iphoneos/TimiNow.app"
[ -d "$BUILT" ] || die "  Build reported success but $BUILT is missing."
echo "  built $BUILT"

bold "7. Install"
if ! $INSTALL; then
  dim "  skipped (--build-only)"
  dim "  xcrun devicectl device install app --device $DEVICE_ID $BUILT"
  echo
  exit 0
fi
# Status from devicectl, not from tail: a pipeline reports its last command,
# and tail succeeds whatever it was handed.
set +e +o pipefail
xcrun devicectl device install app --device "$DEVICE_ID" "$BUILT" 2>&1 | tail -20
INSTALL_STATUS=${PIPESTATUS[0]}
set -e -o pipefail
if [ "$INSTALL_STATUS" -ne 0 ]; then
  warn "  If that failed on the device rather than on the file:"
  warn "    * unlock the phone and leave it unlocked while this runs"
  warn "    * Settings -> Privacy & Security -> Developer Mode, on, then reboot"
  die  "  Install failed."
fi
echo "  installed on $DEVICE_NAME"

bold "8. Launch"
# --console attaches to the app's output, so a process that dies on launch says
# why — a missing dylib, a rejected entitlement, a fatalError. Without it the
# only signal is that the app closes, and the reason has to be hunted for in
# the device's crash reports.
LAUNCH_LOG=/tmp/timi-ios-launch.log
set +e +o pipefail
( xcrun devicectl device process launch \
    --device "$DEVICE_ID" \
    --console \
    --terminate-existing \
    "$BUNDLE_ID" > "$LAUNCH_LOG" 2>&1 ) &
LAUNCH_PID=$!
CONSOLE_WAIT=0
while [ "$CONSOLE_WAIT" -lt 12 ] && kill -0 "$LAUNCH_PID" 2>/dev/null; do
  sleep 1
  CONSOLE_WAIT=$(( CONSOLE_WAIT + 1 ))
done
STILL_RUNNING=0
kill -0 "$LAUNCH_PID" 2>/dev/null && STILL_RUNNING=1
pkill -P "$LAUNCH_PID" 2>/dev/null
kill "$LAUNCH_PID" 2>/dev/null
set -e -o pipefail

if [ "$STILL_RUNNING" -eq 1 ] && ! grep -qiE "terminated|crash|Library not loaded|dyld|Fatal error" "$LAUNCH_LOG" 2>/dev/null; then
  echo "  running — still up after ${CONSOLE_WAIT}s"
else
  echo >&2
  warn "  It launched and then stopped. Everything the app printed:"
  # The dyld and fatalError lines are the ones that name a cause; the rest is
  # ordinary logging, so it is kept but the summary leads with the cause.
  {
    grep -iE "Library not loaded|dyld|Fatal error|Terminating|NSException|Referenced from|Reason:" "$LAUNCH_LOG" 2>/dev/null | head -12
    echo "--- last lines ---"
    tail -15 "$LAUNCH_LOG" 2>/dev/null
  } | copy_and_show >&2
  echo >&2
  dim "  Full output: $LAUNCH_LOG"
  warn "  If instead it never started at all, the certificate is untrusted until"
  warn "  you say so: Settings -> General -> VPN & Device Management -> Trust."
fi
echo
