#!/usr/bin/env bash
#
# Put one source image everywhere an icon is needed.
#
#   ./scripts/apply-icon.sh ~/Downloads/timinow-icon.png
#
# Generates, from a single square PNG (1024x1024 or larger):
#
#   public/assets/icons/         favicon + PWA + apple-touch, for all three
#   apps/*/public/assets/icons/  web surfaces (customer, vet, admin)
#   apps/customer-mobile/Darwin/Assets.xcassets/AppIcon.appiconset/
#   apps/vet-desktop/Darwin/Assets.xcassets/AppIcon.appiconset/
#   apps/vet-windows/src/TimiVet/Assets/timinow.ico
#
# Uses sips and iconutil, both of which ship with macOS — no Homebrew, no
# ImageMagick. Re-run it whenever the source art changes.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/apply-icon.sh <source.png>" >&2
  exit 1
fi

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

SOURCE="${1:-}"
[ -n "$SOURCE" ] && [ -f "$SOURCE" ] || die "usage: $0 <path-to-square-png>
example: $0 ~/Downloads/timinow-icon.png"

command -v sips     >/dev/null || die "sips is required (it ships with macOS)."
command -v iconutil >/dev/null || die "iconutil is required (it ships with macOS)."

WIDTH=$(sips -g pixelWidth  "$SOURCE" | awk '/pixelWidth/  { print $2 }')
HEIGHT=$(sips -g pixelHeight "$SOURCE" | awk '/pixelHeight/ { print $2 }')
[ "$WIDTH" = "$HEIGHT" ] || die "  The source must be square; this one is ${WIDTH}x${HEIGHT}."
[ "$WIDTH" -ge 1024 ] || die "  The source must be at least 1024x1024; this one is ${WIDTH}x${WIDTH}.
  Every size below is produced by scaling down, so anything smaller is soft
  on a Retina display and in the App Store listing."
echo "source ${WIDTH}x${HEIGHT}: $SOURCE"

png() { # png SIZE DESTINATION
  sips -s format png -z "$1" "$1" "$SOURCE" --out "$2" >/dev/null
}

bold "1. Web (favicon, PWA, apple-touch)"
for surface in public apps/vet-web/public apps/admin-console/public; do
  [ -d "$surface" ] || continue
  mkdir -p "$surface/assets/icons"
  png 32   "$surface/assets/icons/icon-32.png"
  png 180  "$surface/assets/icons/apple-touch-icon.png"
  png 192  "$surface/assets/icons/icon-192.png"
  png 512  "$surface/assets/icons/icon-512.png"
  echo "  $surface/assets/icons"
done

bold "2. iOS app icon"
IOS="apps/customer-mobile/Darwin/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$IOS"
png 1024 "$IOS/icon-1024.png"
cat > "$IOS/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "icon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
echo "  $IOS"

bold "3. macOS app icon"
MAC="apps/vet-desktop/Darwin/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$MAC"
for size in 16 32 64 128 256 512 1024; do png "$size" "$MAC/icon-$size.png"; done
{
  echo '{'
  echo '  "images" : ['
  # macOS wants each point size at 1x and 2x; the 2x file is simply the next
  # power of two up, which is why every size above is generated.
  first=true
  for pair in "16 16" "16 32" "32 32" "32 64" "128 128" "128 256" "256 256" "256 512" "512 512" "512 1024"; do
    set -- $pair
    point="$1"; pixels="$2"
    scale="1x"; [ "$pixels" != "$point" ] && scale="2x"
    $first || echo ','
    first=false
    printf '    { "filename" : "icon-%s.png", "idiom" : "mac", "scale" : "%s", "size" : "%sx%s" }' \
      "$pixels" "$scale" "$point" "$point"
  done
  echo
  echo '  ],'
  echo '  "info" : { "author" : "xcode", "version" : 1 }'
  echo '}'
} > "$MAC/Contents.json"
python3 -c "import json,sys; json.load(open('$MAC/Contents.json'))" \
  || die "  Generated an invalid Contents.json for the macOS icon set."
echo "  $MAC"

bold "4. Windows icon"
WIN="apps/vet-windows/src/TimiVet/Assets"
mkdir -p "$WIN"
ICONSET=$(mktemp -d)/timinow.iconset
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  png "$size" "$ICONSET/icon_${size}x${size}.png"
done
# .ico is a container of PNGs; sips writes one directly from the largest.
sips -s format microsoft-icon "$ICONSET/icon_256x256.png" --out "$WIN/timinow.ico" >/dev/null
echo "  $WIN/timinow.ico"

bold "5. Source of truth"
mkdir -p assets
cp "$SOURCE" assets/timinow-icon.png
echo "  assets/timinow-icon.png"
dim "  Committed so this script can be re-run on any machine."
echo
