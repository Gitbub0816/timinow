#!/usr/bin/env node
/**
 * Emit the fold screens as SVG, for opening in a design tool.
 *
 * A screenshot of the running app is not a design source: you cannot move a
 * pixel in it. This writes the same screens as real vector layers with real
 * text, so they open in Sketch (or anything else) as something to push around
 * rather than something to trace.
 *
 * The wheel's geometry is read out of `DuoWheel.swift` rather than restated
 * here, for the same reason `scripts/duo-wheel-geometry.mjs` does it: a second
 * copy of the numbers drifts, and then the design source stops describing the
 * app. Change the Swift and re-run this; the SVG follows.
 *
 *   node scripts/duo-fold-svg.mjs [outDir]      (default: build/fold-svg)
 *
 * Two honest limits, both worth knowing before designing against this:
 *
 *  · The canvas is 1000x703pt, which is the fold-open size this repo has been
 *    working to. It has not been confirmed against a real iPhone Duo. Confirm
 *    it before treating any of this as pixel-accurate.
 *  · Icons are placeholders. The app draws SF Symbols, which have no SVG
 *    equivalent to ship here, so each one is an outlined square carrying its
 *    symbol name. Replace them with purpose-drawn glyphs per CLAUDE.md #8 —
 *    do not substitute emoji.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SWIFT = "apps/customer-mobile/Sources/TimiNowUI/DuoWheel.swift";
const src = readFileSync(SWIFT, "utf8");
const num = (name) => {
  const m = src.match(new RegExp(`private let ${name}: (?:CGFloat|Double) = (-?[0-9.]+)`));
  if (!m) throw new Error(`${SWIFT}: no constant '${name}'`);
  return Number(m[1]);
};
const frame = src.match(
  /\.frame\(width: CGFloat\(focused \? (\d+) : (\d+)\), height: CGFloat\(focused \? (\d+) : (\d+)\)\)/
);
if (!frame) throw new Error(`${SWIFT}: could not read DuoWindow's frame sizes`);
const [focusW, sideW, focusH, sideH] = frame.slice(1, 5).map(Number);

const W = num("boxWidth"), H = num("boxHeight"), PIVOT = num("pivotInset");
const R = num("radius"), STEP = num("step"), FOCUS = num("focusAngle"), HUB = num("hubRadius");

// Straight from TimiColor in Theme.swift.
const C = {
  ink: "#111B3B", paper: "#FFFAF0", blue: "#2357D9", blueSoft: "#E5ECFF",
  coral: "#F25F4C", coralSoft: "#FFE5DF", gold: "#F7C84B", goldSoft: "#FFF0B9",
  canvas: "#F6F7FB", green: "#12855D", greenSoft: "#DCF0E7", muted: "#5B6072",
};

const SCREEN = { w: 1000, h: 703 };
const RAIL = 66, EDGE = 34, BOTTOM = 28;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f = (n) => Number(n.toFixed(2));

/** An icon placeholder. The app draws an SF Symbol here; this is a box with
 *  its name, so nobody mistakes it for finished artwork. */
function icon(cx, cy, size, name) {
  const r = size / 2;
  return `<g id="icon-placeholder/${esc(name)}">
    <rect x="${f(cx - r)}" y="${f(cy - r)}" width="${size}" height="${size}" rx="${f(size * 0.26)}"
          fill="none" stroke="${C.ink}" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.5"/>
    <text x="${f(cx)}" y="${f(cy + 3)}" font-family="SF Mono, Menlo, monospace" font-size="7"
          fill="${C.muted}" text-anchor="middle">${esc(name)}</text></g>`;
}

function wheel(group) {
  const ox = SCREEN.w - RAIL - EDGE - W, oy = SCREEN.h - BOTTOM - H;
  const px = ox + W - PIVOT, py = oy + H - PIVOT;
  const at = (deg, r) => {
    const t = (deg * Math.PI) / 180;
    return [px + r * Math.cos(t), py + r * Math.sin(t)];
  };
  const { actions, focusIndex } = group;
  const lo = FOCUS - Math.min(STEP * 1.3, focusIndex * STEP + STEP * 0.55);
  const hi = FOCUS + Math.min(STEP * 1.3, (actions.length - 1 - focusIndex) * STEP + STEP * 0.55);
  const [ax, ay] = at(lo, R), [bx, by] = at(hi, R);

  let out = `<g id="wheel">
    <path id="track" d="M ${f(ax)} ${f(ay)} A ${R} ${R} 0 0 1 ${f(bx)} ${f(by)}"
          fill="none" stroke="${C.ink}" stroke-opacity="0.4" stroke-width="3" stroke-linecap="round"/>`;

  for (const slot of [-1, 1]) {
    const i = focusIndex + slot;
    if (i < 0 || i >= actions.length) continue;
    const [x, y] = at(FOCUS + slot * STEP, R);
    const x0 = x - sideW / 2, y0 = y - sideH / 2;
    out += `<g id="window-peek/${esc(actions[i].label)}" opacity="0.62">
      <rect x="${f(x0 + 3)}" y="${f(y0 + 4)}" width="${sideW}" height="${sideH}" rx="15" fill="${C.ink}" opacity="0.55"/>
      <rect x="${f(x0)}" y="${f(y0)}" width="${sideW}" height="${sideH}" rx="15"
            fill="${C.paper}" stroke="${C.ink}" stroke-width="2" stroke-opacity="0.5"/>
      ${icon(x, y - 8, 20, actions[i].symbol)}
      <text x="${f(x)}" y="${f(y + 17)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="10"
            font-weight="700" fill="${C.muted}" text-anchor="middle">${esc(actions[i].label)}</text></g>`;
  }

  const [fx, fy] = at(FOCUS, R);
  const fx0 = fx - focusW / 2, fy0 = fy - focusH / 2;
  out += `<g id="window-focus/${esc(actions[focusIndex].label)}">
    <rect x="${f(fx0 + 5)}" y="${f(fy0 + 6)}" width="${focusW}" height="${focusH}" rx="18" fill="${C.ink}" opacity="0.9"/>
    <rect x="${f(fx0)}" y="${f(fy0)}" width="${focusW}" height="${focusH}" rx="18"
          fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>
    ${icon(fx, fy - 12, 26, actions[focusIndex].symbol)}
    <text x="${f(fx)}" y="${f(fy + 24)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="14"
          font-weight="900" fill="${C.ink}" text-anchor="middle">${esc(actions[focusIndex].label)}</text></g>`;

  out += `<g id="hub">
    <circle cx="${f(px + 5)}" cy="${f(py + 6)}" r="${HUB}" fill="${C.ink}" opacity="0.9"/>
    <circle cx="${f(px)}" cy="${f(py)}" r="${HUB}" fill="${C.coral}" stroke="${C.ink}" stroke-width="3"/>
    <text x="${f(px)}" y="${f(py + 4)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="26"
          font-weight="900" fill="${C.paper}" text-anchor="middle">&#10003;</text>
    <text x="${f(px)}" y="${f(py + 26)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="10"
          font-weight="900" letter-spacing="1.5" fill="${C.paper}" text-anchor="middle">CHOOSE</text></g>`;

  // The group label and the position dots that sit above the wheel.
  out += `<g id="wheel-header">
    <text x="${f(ox + W)}" y="${f(oy - 30)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="11"
          font-weight="900" letter-spacing="1.3" fill="${C.muted}" text-anchor="end">${esc(group.label.toUpperCase())}</text>`;
  const dots = group.groupCount ?? 5, active = group.groupIndex ?? 0;
  let dx = ox + W;
  for (let i = dots - 1; i >= 0; i--) {
    const wdt = i === active ? 16 : 6;
    dx -= wdt;
    out += `<rect x="${f(dx)}" y="${f(oy - 22)}" width="${wdt}" height="6" rx="3"
             fill="${i === active ? C.coral : C.ink}" ${i === active ? "" : 'opacity="0.25"'}/>`;
    dx -= 4;
  }
  return out + `</g></g>`;
}

function rail(active) {
  const x = SCREEN.w - RAIL;
  const items = ["find", "pets", "activity", "fund", "settings"];
  let out = `<g id="menu-rail">
    <rect x="${x}" y="0" width="${RAIL}" height="${SCREEN.h}" fill="${C.paper}"/>
    <line x1="${x}" y1="0" x2="${x}" y2="${SCREEN.h}" stroke="${C.ink}" stroke-width="2"/>`;
  const top = SCREEN.h / 2 - (items.length * 56) / 2;
  items.forEach((name, i) => {
    const cy = top + i * 56 + 23;
    if (name === active) {
      out += `<rect x="${x + 10}" y="${f(cy - 23)}" width="${RAIL - 20}" height="46" rx="14" fill="${C.ink}"/>`;
    }
    out += icon(x + RAIL / 2, cy, 40, name);
  });
  return out + `</g>`;
}

function stage(s) {
  const inset = W + EDGE + RAIL + 20;
  const right = SCREEN.w - inset;
  let out = `<g id="stage">`;
  let y = 120;
  if (s.answered?.length) {
    let cx = 40;
    out += `<g id="answered-chips">`;
    for (const chip of s.answered) {
      const wdt = 26 + chip.length * 7.4;
      out += `<rect x="${f(cx)}" y="${f(y - 18)}" width="${f(wdt)}" height="30" rx="15"
               fill="#FFFFFF" stroke="${C.ink}" stroke-width="1.5" stroke-opacity="0.3"/>
        <text x="${f(cx + 11)}" y="${f(y + 2)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="11"
              font-weight="900" fill="${C.green}">&#10003;</text>
        <text x="${f(cx + 24)}" y="${f(y + 2)}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="13"
              font-weight="700" fill="${C.ink}">${esc(chip)}</text>`;
      cx += wdt + 10;
    }
    out += `</g>`;
  }
  y = 300;
  out += `<g id="stage-question">
    <text x="40" y="${y}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="17"
          font-weight="700" fill="${C.muted}">${esc(s.question)}</text></g>`;
  out += `<g id="stage-answer">
    <rect x="45" y="${y + 36}" width="96" height="96" rx="26" fill="${C.ink}" opacity="0.9"/>
    <rect x="40" y="${y + 30}" width="96" height="96" rx="26" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>
    ${icon(88, y + 78, 54, s.symbol)}
    <text x="162" y="${y + 88}" font-family="SF Pro Display, Helvetica, sans-serif" font-size="46"
          font-weight="900" fill="${C.ink}">${esc(s.answer)}</text>`;
  if (s.detail) {
    out += `<text x="162" y="${y + 116}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="17"
             fill="${C.muted}">${esc(s.detail)}</text>`;
  }
  out += `</g>`;
  out += `<g id="safety-notice">
    <text x="40" y="${SCREEN.h - 42}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="12" fill="${C.muted}">T&#237;mi is not a veterinary practice and does not give medical advice.</text>
    <text x="40" y="${SCREEN.h - 24}" font-family="SF Pro Text, Helvetica, sans-serif" font-size="12" fill="${C.muted}">If your animal is in distress, go to the nearest open hospital now.</text></g>`;
  out += `<line id="stage-edge-guide" x1="${f(right)}" y1="0" x2="${f(right)}" y2="${SCREEN.h}"
           stroke="${C.coral}" stroke-width="1" stroke-dasharray="4 6" opacity="0.35"/>`;
  return out + `</g>`;
}

function screen(name, s) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN.w}" height="${SCREEN.h}"
     viewBox="0 0 ${SCREEN.w} ${SCREEN.h}">
  <title>${esc(name)}</title>
  <rect id="paper" x="0" y="0" width="${SCREEN.w}" height="${SCREEN.h}" fill="${C.paper}"/>
  ${stage(s)}
  ${rail(s.section)}
  ${wheel(s.group)}
</svg>
`;
}

const SCREENS = {
  "01-species": {
    section: "find", question: "Select Bill's species · 3 of 6",
    answer: "Rabbit", symbol: "hare.fill",
    answered: ["Bill"],
    group: {
      label: "Select Bill's species", focusIndex: 2, groupIndex: 1, groupCount: 5,
      actions: [
        { label: "Dog", symbol: "dog.fill" }, { label: "Cat", symbol: "cat.fill" },
        { label: "Rabbit", symbol: "hare.fill" }, { label: "Bird", symbol: "bird.fill" },
        { label: "Reptile", symbol: "lizard.fill" }, { label: "Other", symbol: "pawprint.fill" },
      ],
    },
  },
  "02-clinics": {
    section: "find", question: "Choose a clinic · 2 of 4",
    answer: "Clinic B", symbol: "cross.case.fill",
    detail: "12 min away · ready in 25 min · $180 est.",
    answered: ["Bill", "Rabbit", "Urgent"],
    group: {
      label: "Choose a clinic", focusIndex: 1, groupIndex: 3, groupCount: 5,
      actions: [
        { label: "Clinic A", symbol: "cross.case.fill" }, { label: "Clinic B", symbol: "cross.case.fill" },
        { label: "Clinic C", symbol: "cross.case.fill" }, { label: "Clinic D", symbol: "cross.case.fill" },
      ],
    },
  },
  "03-menu": {
    section: "pets", question: "Where to · 2 of 5",
    answer: "Pets", symbol: "pawprint.fill",
    group: {
      label: "Where to", focusIndex: 1, groupIndex: 0, groupCount: 5,
      actions: [
        { label: "Find care", symbol: "magnifyingglass" }, { label: "Pets", symbol: "pawprint.fill" },
        { label: "Activity", symbol: "clock.fill" }, { label: "The Fund", symbol: "heart.fill" },
        { label: "Settings", symbol: "gearshape.fill" },
      ],
    },
  },
};

const outDir = process.argv[2] || "build/fold-svg";
mkdirSync(outDir, { recursive: true });
for (const [name, s] of Object.entries(SCREENS)) {
  writeFileSync(join(outDir, `${name}.svg`), screen(name, s));
}
// A swatch sheet, so the palette arrives in the design file as artwork rather
// than as hex codes someone retypes.
const keys = Object.keys(C);
let sw = `<svg xmlns="http://www.w3.org/2000/svg" width="${keys.length * 120}" height="180" viewBox="0 0 ${keys.length * 120} 180">
  <title>Timi palette</title><rect width="100%" height="100%" fill="#FFFFFF"/>`;
keys.forEach((k, i) => {
  sw += `<g id="swatch/${k}">
    <rect x="${i * 120 + 16}" y="30" width="88" height="88" rx="12" fill="${C[k]}" stroke="${C.ink}" stroke-width="2"/>
    <text x="${i * 120 + 60}" y="138" font-family="SF Pro Text, Helvetica, sans-serif" font-size="13" font-weight="700" fill="${C.ink}" text-anchor="middle">${k}</text>
    <text x="${i * 120 + 60}" y="156" font-family="SF Mono, Menlo, monospace" font-size="11" fill="${C.muted}" text-anchor="middle">${C[k]}</text></g>`;
});
writeFileSync(join(outDir, "00-palette.svg"), sw + `</svg>\n`);

console.log(`duo-fold-svg: wrote ${Object.keys(SCREENS).length + 1} files to ${outDir}/`);
console.log(`  canvas ${SCREEN.w}x${SCREEN.h}pt (UNCONFIRMED against real hardware)`);
console.log(`  wheel  r${R}, ${STEP}° step, ${HUB * 2}pt button — read from ${SWIFT}`);
