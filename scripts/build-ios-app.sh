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
# Without this there is no way to tell that from a hang — and it does hang: two
# builds at once block on SwiftPM's shared lock with no message at all. So the
# heartbeat watches the log grow, and says so when it stops.
start_heartbeat() { # start_heartbeat LOGFILE
  ( log="$1"
    elapsed=0
    last_size=0
    stalled=0
    while true; do
      sleep 30
      elapsed=$(( elapsed + 30 ))
      size=$(wc -c < "$log" 2>/dev/null || echo 0)
      if [ "$size" -eq "$last_size" ]; then
        stalled=$(( stalled + 30 ))
      else
        stalled=0
        last_size="$size"
      fi
      if [ "$stalled" -ge 120 ]; then
        printf '\033[33m  Nothing written for %dm. Last line:\033[0m\n' "$(( stalled / 60 ))"
        printf '\033[2m    %s\033[0m\n' "$(tail -1 "$log" 2>/dev/null | cut -c1-100)"
        printf '\033[33m  If another xcodebuild or Xcode itself is open on this package, they are\033[0m\n'
        printf '\033[33m  sharing SwiftPM'"'"'s lock and this one waits forever. Check with:\033[0m\n'
        printf '\033[2m    ps -eo pid,etime,args | grep [x]codebuild\033[0m\n'
        stalled=0
      else
        printf '\033[2m  … still building (%dm%02ds)\033[0m\n' "$(( elapsed / 60 ))" "$(( elapsed % 60 ))"
      fi
    done ) &
  HEARTBEAT_PID=$!
}

stop_heartbeat() {
  [ -n "${HEARTBEAT_PID:-}" ] && kill "$HEARTBEAT_PID" 2>/dev/null
  HEARTBEAT_PID=""
}

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
dim "  The first build compiles the whole Skip stack — expect several minutes."
dim "  Full output: /tmp/timi-ios-build.log"
set +e +o pipefail
start_heartbeat /tmp/timi-ios-build.log
( cd "$APP_DIR" && xcodebuild \
    -workspace Project.xcworkspace \
    -scheme TimiNow \
    -destination "platform=iOS Simulator,name=$DEVICE" \
    -derivedDataPath build \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    CODE_SIGNING_ALLOWED=NO \
    build ) 2>&1 \
  | tee /tmp/timi-ios-build.log \
  | grep --line-buffered -E "$BUILD_FILTER" \
  | awk '{ if (length($0) > 110) $0 = substr($0, 1, 107) "..."; print "  " $0; fflush() }'
BUILD_STATUS=${PIPESTATUS[0]}
set -e -o pipefail
stop_heartbeat
if [ "$BUILD_STATUS" -ne 0 ]; then
  echo >&2
  grep -E "error:" /tmp/timi-ios-build.log | sort -u | head -20 >&2
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
