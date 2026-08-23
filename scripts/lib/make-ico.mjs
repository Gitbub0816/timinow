// Windows renders a PNG-compressed ICO entry only at 256x256. Below that it
// expects a BMP/DIB, and an ICO that is PNG all the way down loads as nothing
// at all — no error, no fallback, just a blank square in the taskbar and on
// the .exe. Which is what shipped.
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** Minimal PNG reader: 8-bit truecolour+alpha, no interlace. Enough for icons. */
function decodePNG(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8, width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  // 6 is truecolour with alpha, 2 is truecolour without. These icons are
  // opaque and exported as 2; a later re-export with transparency would be 6.
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG: depth ${depth}, colour type ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]; position += 1;
    const line = raw.subarray(position, position + stride); position += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  return { width, height, pixels, channels };
}

/** A 32-bit BGRA DIB, bottom-up, with the AND mask an ICO still requires. */
function encodeDIB({ width, height, pixels, channels }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);   // XOR and AND stacked
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const source = (height - 1 - y) * width * channels;
    for (let x = 0; x < width; x += 1) {
      const from = source + x * channels, to = (y * width + x) * 4;
      xor[to] = pixels[from + 2]; xor[to + 1] = pixels[from + 1];
      xor[to + 2] = pixels[from];
      xor[to + 3] = channels === 4 ? pixels[from + 3] : 255;
    }
  }
  // Zero AND mask: alpha does the work, but the rows must still be there and
  // padded to 32 bits or every offset after this one is wrong.
  const maskStride = Math.ceil(width / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(maskStride * height)]);
}

// Usage: node scripts/lib/make-ico.mjs <dir-of-icon-N.png> <out.ico> [sizes]
// Called by scripts/apply-icon.sh after it resizes, and used directly to build
// the committed apps/vet-windows/src/TimiVet/Assets/timinow.ico from the macOS
// console's icon set, so both consoles wear the same face.
const source = process.argv[2] || "apps/vet-desktop/Darwin/Assets.xcassets/AppIcon.appiconset";
const out = process.argv[3] || "apps/vet-windows/src/TimiVet/Assets/timinow.ico";
const sizes = (process.argv[4] || "16,32,64,128,256").split(",").map(Number);
const entries = sizes.map((size) => {
  const png = readFileSync(`${source}/icon-${size}.png`);
  return { size, png: size === 256, data: size === 256 ? png : encodeDIB(decodePNG(png)) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const directory = Buffer.alloc(16 * entries.length);
let offset = header.length + directory.length;
entries.forEach((entry, index) => {
  const at = index * 16;
  directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at);
  directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(entry.data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += entry.data.length;
});
writeFileSync(out, Buffer.concat([header, directory, ...entries.map((e) => e.data)]));
console.log(entries.map((e) => `${e.size}${e.png ? " png" : " dib"} ${e.data.length}B`).join("  "));
