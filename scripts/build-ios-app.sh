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
#
# In-app card payment (StripePaymentSheet) needs no such credential and is
# compiled in by default; pass --no-stripe to build the hosted-fallback
# deposit screen instead.

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
export NO_STRIPE="${NO_STRIPE:-}"
export NO_DIDIT="${NO_DIDIT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --device)     DEVICE="${2:-}"; shift 2 ;;
    --build-only) RUN=false; shift ;;
    --no-stripe)  NO_STRIPE=1; shift ;;
    --no-didit)   NO_DIDIT=1; shift ;;
    *)            die "unknown option: $1" ;;
  esac
done

APP_DIR="apps/customer-mobile"
BUNDLE_ID="solutions.clearkey.timinow"

command -v xcodebuild >/dev/null || die "Xcode is required (the full app, not just the command line tools)."
command -v xcodegen   >/dev/null || die "xcodegen is required: brew install xcodegen"

bold "1. Mapbox"
select_mapbox

bold "1b. Card payment"
select_stripe

bold "1c. Identity verification"
select_didit

bold "2. Simulator"
# --device is matched against the simulators that actually exist rather than
# passed to xcodebuild verbatim. A name that is close but not exact used to
# reach xcodebuild as an unresolvable -destination and fail several lines
# later with a wall of destination syntax, which says nothing about the one
# thing that was wrong. Substring, case-insensitive, and on no match it prints
# the list — including any simulator you have renamed yourself.
# Kept, because the resolution below overwrites DEVICE and step 2b needs to
# know what was originally asked for.
WANTED="$DEVICE"
AVAILABLE="$(mktemp)"
DEVICE="$(xcrun simctl list devices available --json \
  | DEVICE_NAME="$DEVICE" python3 -c '
import json, os, sys

wanted = (os.environ.get("DEVICE_NAME") or "").strip().lower()
runtimes = json.load(sys.stdin)["devices"]
# Runtime keys sort oldest-first, so the last match is the newest OS.
devices = [(runtime, d) for runtime in sorted(runtimes) for d in runtimes[runtime]]

with open(sys.argv[1], "w") as listing:
    for runtime, d in devices:
        state = " (booted)" if d.get("state") == "Booted" else ""
        name = d["name"]
        os_name = runtime.rsplit(".", 1)[-1].replace("-", " ")
        listing.write("    " + name + " - " + os_name + state + "\n")

# The destination below is an iOS Simulator, so only iOS runtimes can be
# chosen — a watchOS simulator matched by name would be handed to xcodebuild
# as an iOS destination and fail. They stay in the listing above so a name
# that matched only a watch is visibly accounted for.
ios = [(runtime, d) for runtime, d in devices if ".iOS-" in runtime]

if wanted:
    matches = [d for _, d in ios if wanted in d["name"].lower()]
    # An exact name wins outright — "iPhone 17" should not land on
    # "iPhone 17 Pro" just because that one happens to be booted. Failing
    # that, a booted match is the one already on screen, then the newest.
    exact = [d for d in matches if d["name"].lower() == wanted]
    booted = [d for d in matches if d.get("state") == "Booted"]
    chosen = exact or booted or matches
    print(chosen[-1]["name"] if chosen else "")
    raise SystemExit

booted = [d["name"] for _, d in ios if d.get("state") == "Booted"]
if booted:
    print(booted[0]); raise SystemExit
iphones = [d["name"] for _, d in ios if d["name"].startswith("iPhone")]
print(iphones[-1] if iphones else "")' "$AVAILABLE")"

# A model can be supported by the installed runtimes and still have no
# simulator, because Xcode only creates a default handful — every other one is
# a `simctl create` away. Not knowing that reads as "this iPhone does not
# exist" when the truth is "nobody has made one yet", so rather than print a
# list that omits the answer, make it.
if [ -z "$DEVICE" ] && [ -n "$WANTED" ]; then
  RUNTIMES="$(mktemp)"
  xcrun simctl list runtimes --json > "$RUNTIMES" 2>/dev/null || echo '{"runtimes":[]}' > "$RUNTIMES"
  CREATE="$(xcrun simctl list devicetypes --json 2>/dev/null \
    | DEVICE_NAME="$WANTED" python3 -c '
import json, os, sys

wanted = os.environ["DEVICE_NAME"].strip().lower()
try:
    types = json.load(sys.stdin)["devicetypes"]
    runtimes = json.load(open(sys.argv[1]))["runtimes"]
except Exception:
    raise SystemExit

def version(runtime):
    parts = (runtime.get("version") or "0").split(".")
    return tuple(int(p) if p.isdigit() else 0 for p in parts)

matches = [t for t in types if wanted in t["name"].lower()]
exact = [t for t in matches if t["name"].lower() == wanted]
matches = exact or matches

best = None
for device_type in matches:
    for runtime in runtimes:
        if not runtime.get("isAvailable"):
            continue
        if "SimRuntime.iOS-" not in (runtime.get("identifier") or ""):
            continue
        supported = runtime.get("supportedDeviceTypes") or []
        if not any(s.get("identifier") == device_type["identifier"] for s in supported):
            continue
        if best is None or version(runtime) > best[0]:
            best = (version(runtime), device_type, runtime)

if best is None:
    raise SystemExit
_, device_type, runtime = best
print("\t".join([device_type["name"], device_type["identifier"], runtime["identifier"]]))' "$RUNTIMES")"
  rm -f "$RUNTIMES"
  if [ -n "$CREATE" ]; then
    NEW_NAME="$(printf '%s' "$CREATE" | cut -f1)"
    NEW_TYPE="$(printf '%s' "$CREATE" | cut -f2)"
    NEW_RUNTIME="$(printf '%s' "$CREATE" | cut -f3)"
    if xcrun simctl create "$NEW_NAME" "$NEW_TYPE" "$NEW_RUNTIME" >/dev/null 2>&1; then
      DEVICE="$NEW_NAME"
      echo "  no $NEW_NAME simulator existed — created one"
      dim "  Remove it later with: xcrun simctl delete '\''$NEW_NAME'\''"
    fi
  fi
fi

if [ -z "$DEVICE" ]; then
  LISTING="$(cat "$AVAILABLE")"
  rm -f "$AVAILABLE"
  if [ -n "$LISTING" ]; then
    die "  No simulator matched. These exist:

$LISTING
  Pass --device with part of one of those names. Simulators you have renamed
  in Xcode appear under the name you gave them.

  A model missing from that list and from what this could create is one whose
  runtime is not installed — a new iPhone usually needs the iOS version it
  shipped with, not merely the newest one you happen to have. Xcode ->
  Settings -> Components, or from here:

    xcodebuild -downloadPlatform iOS                  # newest
    xcodebuild -downloadPlatform iOS -buildVersion 27.1

  It is a several-gigabyte download. Run this again once it finishes and the
  simulator will be created for you."
  fi
  die "  No simulator is installed at all. Add one in Xcode -> Settings -> Components."
fi
rm -f "$AVAILABLE"
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
