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
STAGE=$(mktemp -d)
for size in 16 32 48 64 128 256; do
  png "$size" "$STAGE/icon-$size.png"
done
# Written here rather than with `sips -s format microsoft-icon`, which cannot
# write that format on current macOS — it prints "Can't write format" and then
# segfaults. An .ico is only a small header followed by the PNG files
# themselves, so building it directly is both shorter and reliable.
node -e '
const fs = require("fs");
const sizes = [16, 32, 48, 64, 128, 256];
const stage = process.argv[1];
const out = process.argv[2];
const images = sizes.map((size) => ({ size, data: fs.readFileSync(`${stage}/icon-${size}.png`) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);              // reserved
header.writeUInt16LE(1, 2);              // 1 = icon
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(16 * images.length);
let offset = header.length + directory.length;
images.forEach((image, index) => {
  const at = index * 16;
  // 256 is stored as 0: the field is one byte and 256 does not fit.
  directory.writeUInt8(image.size === 256 ? 0 : image.size, at);
  directory.writeUInt8(image.size === 256 ? 0 : image.size, at + 1);
  directory.writeUInt8(0, at + 2);       // palette size
  directory.writeUInt8(0, at + 3);       // reserved
  directory.writeUInt16LE(1, at + 4);    // colour planes
  directory.writeUInt16LE(32, at + 6);   // bits per pixel
  directory.writeUInt32LE(image.data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.data.length;
});

fs.writeFileSync(out, Buffer.concat([header, directory, ...images.map((i) => i.data)]));
' "$STAGE" "$WIN/timinow.ico"
node -e '
const fs = require("fs");
const data = fs.readFileSync(process.argv[1]);
if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) throw new Error("not an icon file");
const count = data.readUInt16LE(4);
if (!count) throw new Error("no images");
for (let index = 0; index < count; index += 1) {
  const at = 6 + index * 16;
  const size = data.readUInt32LE(at + 8);
  const offset = data.readUInt32LE(at + 12);
  if (offset + size > data.length) throw new Error("entry " + index + " points past the end");
  if (data.subarray(offset, offset + 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("entry " + index + " is not a PNG");
}
' "$WIN/timinow.ico" || die "  Wrote an invalid $WIN/timinow.ico."
echo "  $WIN/timinow.ico"

bold "5. Source of truth"
mkdir -p assets
cp "$SOURCE" assets/timinow-icon.png
echo "  assets/timinow-icon.png"
dim "  Committed so this script can be re-run on any machine."
echo
