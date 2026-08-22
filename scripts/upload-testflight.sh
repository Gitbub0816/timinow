#!/usr/bin/env bash
#
# Archive the customer app and send it to TestFlight.
#
#   ./scripts/upload-testflight.sh --api-key ABC123XYZ --api-issuer 6053b7fe-...
#   ./scripts/upload-testflight.sh --export-only
#   ./scripts/upload-testflight.sh --build 42
#
# No Xcode window, no Transporter app. What has to be true first:
#
#   * A paid Apple Developer Program membership. TestFlight is not available
#     on a free Apple ID — for a personal-account install use
#     scripts/install-ios-device.sh instead.
#   * An app record in App Store Connect for solutions.clearkey.timinow.
#     Apps -> + -> New App. Nothing here can create it for you.
#   * An App Store Connect API key: Users and Access -> Integrations -> App
#     Store Connect API -> +. Download the .p8 ONCE — Apple never shows it
#     again — and put it at
#       ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
#     Note the Key ID and the Issuer ID from that page; pass them with
#     --api-key and --api-issuer, or set ASC_KEY_ID and ASC_ISSUER_ID.
#
# The build number defaults to the current time, because App Store Connect
# rejects any upload whose CFBundleVersion is not higher than the last one it
# accepted, and a hand-maintained counter is one more thing to forget.
#
# CarPlay is stripped unless --carplay: the entitlement is restricted and
# Apple issues no distribution profile carrying it until a separate CarPlay
# request is approved. See Darwin/TimiNow.entitlements and docs/NAVIGATION.md.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/upload-testflight.sh" >&2
  exit 1
fi

set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/apple-build.sh
trap 'stop_heartbeat' EXIT INT TERM

TEAM="${DEVELOPMENT_TEAM:-}"
KEY_ID="${ASC_KEY_ID:-}"
ISSUER_ID="${ASC_ISSUER_ID:-}"
KEY_PATH="${ASC_KEY_PATH:-}"
BUILD_NUMBER=""
CARPLAY=false
UPLOAD=true
while [ $# -gt 0 ]; do
  case "$1" in
    --team)        TEAM="${2:-}"; shift 2 ;;
    --api-key)     KEY_ID="${2:-}"; shift 2 ;;
    --api-issuer)  ISSUER_ID="${2:-}"; shift 2 ;;
    --api-key-path) KEY_PATH="${2:-}"; shift 2 ;;
    --build)       BUILD_NUMBER="${2:-}"; shift 2 ;;
    --carplay)     CARPLAY=true; shift ;;
    --export-only) UPLOAD=false; shift ;;
    *)             die "unknown option: $1" ;;
  esac
done

APP_DIR="apps/customer-mobile"
BUNDLE_ID="solutions.clearkey.timinow"
LOCAL_CONFIG="$APP_DIR/Darwin/Local.xcconfig"
ARCHIVE="$PWD/$APP_DIR/build/TimiNow.xcarchive"
EXPORT_DIR="$PWD/$APP_DIR/build/testflight"
LOG=/tmp/timi-testflight.log

command -v xcodebuild >/dev/null || die "Xcode is required (the full app, not just the command line tools)."
command -v xcodegen   >/dev/null || die "xcodegen is required: brew install xcodegen"

bold "1. Signing identity"
[ -n "$TEAM" ] || TEAM="$(resolve_team "$LOCAL_CONFIG")"
[ -n "$TEAM" ] || die "  No Apple development team found. Pass one:

    ./scripts/upload-testflight.sh --team ABCDE12345 --api-key ... --api-issuer ...

  The team id is the ten-character string beside your name at
  https://developer.apple.com/account (Membership details)."
echo "  team $TEAM"
if [ -n "${RESOLVED_TEAM_SOURCE:-}" ]; then dim "  from $RESOLVED_TEAM_SOURCE"; fi

bold "2. App Store Connect key"
if $UPLOAD; then
  [ -n "$KEY_ID" ] && [ -n "$ISSUER_ID" ] || die "  An API key is required to upload.

    ./scripts/upload-testflight.sh --api-key <KEY ID> --api-issuer <ISSUER ID>

  Both are on the App Store Connect page that issued the key: Users and
  Access -> Integrations -> App Store Connect API. Use --export-only to build
  an .ipa without uploading."
  if [ -z "$KEY_PATH" ]; then
    for candidate in "$HOME/.appstoreconnect/private_keys" "$HOME/.private_keys" "$HOME/private_keys" "./private_keys"; do
      if [ -f "$candidate/AuthKey_$KEY_ID.p8" ]; then KEY_PATH="$candidate/AuthKey_$KEY_ID.p8"; break; fi
    done
  fi
  [ -n "$KEY_PATH" ] && [ -f "$KEY_PATH" ] || die "  Cannot find AuthKey_$KEY_ID.p8.

  Apple lets you download it exactly once, at the moment the key is created.
  Put it here and run this again:

    mkdir -p ~/.appstoreconnect/private_keys
    mv ~/Downloads/AuthKey_$KEY_ID.p8 ~/.appstoreconnect/private_keys/

  If it is lost, revoke that key in App Store Connect and issue a new one."
  echo "  key $KEY_ID"
  dim  "  $KEY_PATH"
else
  dim "  skipped (--export-only)"
fi

bold "3. Build number"
# Minutes since the epoch would be tidier, but CFBundleVersion is at most three
# dot-separated integers each below 2^32, and a yymmddHHMM stamp fits with room
# to spare while staying readable and monotonic.
[ -n "$BUILD_NUMBER" ] || BUILD_NUMBER="$(date +%y%m%d%H%M)"
case "$BUILD_NUMBER" in
  ''|*[!0-9.]*) die "  --build must be digits and dots only; got \"$BUILD_NUMBER\"." ;;
esac
echo "  $BUILD_NUMBER"

bold "4. Entitlements"
ENTITLEMENTS="TimiNow.entitlements"
if $CARPLAY; then
  warn "  Keeping the restricted CarPlay entitlement (--carplay). Without Apple's"
  warn "  approval for $BUNDLE_ID the archive fails at signing."
else
  ENTITLEMENTS="TimiNow.local.entitlements"
  cp "$APP_DIR/Darwin/TimiNow.entitlements" "$APP_DIR/Darwin/$ENTITLEMENTS"
  for key in com.apple.developer.carplay-driving-navigation \
             com.apple.developer.carplay-audio \
             com.apple.developer.carplay-communication; do
    /usr/libexec/PlistBuddy -c "Delete :$key" "$APP_DIR/Darwin/$ENTITLEMENTS" >/dev/null 2>&1 || true
  done
  echo "  CarPlay removed for this upload; everything else kept"
fi
{
  echo "// Written by scripts/upload-testflight.sh. Git-ignored, personal to this machine."
  echo "DEVELOPMENT_TEAM = $TEAM"
  echo "CODE_SIGN_ENTITLEMENTS = $ENTITLEMENTS"
} > "$LOCAL_CONFIG"

bold "5. Mapbox"
select_mapbox

bold "6. Xcode project"
( cd "$APP_DIR/Darwin" && xcodegen generate >/dev/null )
echo "  generated"

bold "7. Archive"
dim "  Release build for a real device, signed for distribution."
dim "  Full output: $LOG"
rm -rf "$ARCHIVE"
run_build "$LOG" "$APP_DIR" xcodebuild \
  -workspace Project.xcworkspace \
  -scheme TimiNow \
  -destination 'generic/platform=iOS' \
  -configuration Release \
  -archivePath "$ARCHIVE" \
  -derivedDataPath build \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  archive
if [ "$BUILD_STATUS" -ne 0 ]; then
  summarise_failure "$LOG"
  die "  Archive failed after $(( SECONDS / 60 ))m. Full log: $LOG"
fi
[ -d "$ARCHIVE" ] || die "  Archive reported success but $ARCHIVE is missing."
echo "  $ARCHIVE"

bold "8. Export"
# Apple renamed the App Store export method in Xcode 15.3. Passing the wrong
# spelling fails with "invalid method", which reads like a bug in this script
# rather than a version difference, so pick by version.
XCODE_VERSION="$(xcodebuild -version | awk '/^Xcode/ { print $2; exit }')"
XCODE_MAJOR="${XCODE_VERSION%%.*}"
XCODE_MINOR="$(printf '%s' "$XCODE_VERSION" | cut -d. -f2)"
[ -n "$XCODE_MINOR" ] || XCODE_MINOR=0
if [ "$XCODE_MAJOR" -gt 15 ] || { [ "$XCODE_MAJOR" -eq 15 ] && [ "$XCODE_MINOR" -ge 3 ]; }; then
  METHOD="app-store-connect"
else
  METHOD="app-store"
fi
DESTINATION="export"
$UPLOAD && DESTINATION="upload"
OPTIONS="$APP_DIR/build/ExportOptions.plist"
cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>$METHOD</string>
    <key>destination</key><string>$DESTINATION</string>
    <key>teamID</key><string>$TEAM</string>
    <key>signingStyle</key><string>automatic</string>
    <key>uploadSymbols</key><true/>
    <!-- Otherwise Xcode picks its own build number and the one above is lost. -->
    <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
echo "  method $METHOD, destination $DESTINATION"

rm -rf "$EXPORT_DIR"
# An array, not a string: a home directory with a space in it would otherwise
# split into two arguments and xcodebuild would report a missing archive.
EXPORT_ARGS=(
  -exportArchive
  -archivePath "$ARCHIVE"
  -exportOptionsPlist "$PWD/$OPTIONS"
  -exportPath "$EXPORT_DIR"
  -allowProvisioningUpdates
)
if $UPLOAD; then
  EXPORT_ARGS+=(
    -authenticationKeyPath "$KEY_PATH"
    -authenticationKeyID "$KEY_ID"
    -authenticationKeyIssuerID "$ISSUER_ID"
  )
fi
run_build "$LOG" "$APP_DIR" xcodebuild "${EXPORT_ARGS[@]}"
if [ "$BUILD_STATUS" -ne 0 ]; then
  summarise_failure "$LOG"
  if grep -q "No suitable application records\|not found on the App Store" "$LOG"; then
    warn "  App Store Connect has no app record for $BUNDLE_ID. Create it first:"
    warn "  App Store Connect -> Apps -> + -> New App, with that exact bundle ID."
  fi
  if grep -q "bundle version must be higher\|already been used" "$LOG"; then
    warn "  Build $BUILD_NUMBER is already taken in App Store Connect. Pass a"
    warn "  higher one with --build, or wait a minute and re-run for a new stamp."
  fi
  die "  Export failed after $(( SECONDS / 60 ))m. Full log: $LOG"
fi

bold "9. Done"
if $UPLOAD; then
  echo "  Uploaded build $BUILD_NUMBER."
  dim  "  App Store Connect processes it for a few minutes before it appears"
  dim  "  under TestFlight; you get an email either way. Add yourself as an"
  dim  "  internal tester and it arrives in the TestFlight app on the phone."
else
  echo "  $EXPORT_DIR"
  dim  "  Upload it later with the same key:"
  dim  "    ./scripts/upload-testflight.sh --api-key $KEY_ID --api-issuer <ISSUER>"
fi
echo
