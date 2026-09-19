#!/usr/bin/env node
/**
 * The fold wheel's geometry, checked as arithmetic rather than by eye.
 *
 * `DuoWheel` places three windows and a button on an arc around a pivot. Those
 * are absolute positions, so nothing in SwiftUI will tell you when two of them
 * land on top of each other or when one leaves the box — it just draws the
 * overlap and clips the overflow, which is exactly what the first three
 * versions of this control shipped. The numbers live in Swift; this reads them
 * back out and re-derives the layout, so a later tweak to `radius` or `step`
 * that pushes a window under the button fails the build instead of the review.
 *
 * It deliberately parses the source rather than duplicating the constants: a
 * second copy of the numbers would drift, and then the check would be
 * confirming its own arithmetic instead of the control's.
 */
import { readFileSync } from "node:fs";

const FILE = "apps/customer-mobile/Sources/TimiNowUI/DuoWheel.swift";
const src = readFileSync(FILE, "utf8");

function constant(name) {
  const m = src.match(new RegExp(`private let ${name}: (?:CGFloat|Double) = (-?[0-9.]+)`));
  if (!m) throw new Error(`${FILE}: could not find '${name}' — did it get renamed?`);
  return Number(m[1]);
}

const box = constant("boxWidth");
const boxHeight = constant("boxHeight");
const pivotInset = constant("pivotInset");
const radius = constant("radius");
const step = constant("step");
const focusAngle = constant("focusAngle");
const hubRadius = constant("hubRadius");

// The window sizes are written where they are used, as a ternary on `focused`.
const frame = src.match(
  /\.frame\(width: CGFloat\(focused \? (\d+) : (\d+)\), height: CGFloat\(focused \? (\d+) : (\d+)\)\)/
);
if (!frame) throw new Error(`${FILE}: could not read DuoWindow's frame sizes`);
const [focusW, sideW, focusH, sideH] = frame.slice(1, 5).map(Number);

const px = box - pivotInset;
const py = boxHeight - pivotInset;
const at = (deg, r) => {
  const t = (deg * Math.PI) / 180;
  return [px + r * Math.cos(t), py + r * Math.sin(t)];
};

const boxes = {};
for (const slot of [-1, 0, 1]) {
  const [x, y] = at(focusAngle + slot * step, radius);
  const w = slot === 0 ? focusW : sideW;
  const h = slot === 0 ? focusH : sideH;
  boxes[`window ${slot}`] = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
}
boxes["button"] = [px - hubRadius, py - hubRadius, px + hubRadius, py + hubRadius];
// The track never runs more than 1.3 steps either side of the focus.
{
  const xs = [], ys = [];
  for (let k = 0; k <= 80; k++) {
    const [x, y] = at(focusAngle - step * 1.3 + (step * 2.6 * k) / 80, radius);
    xs.push(x); ys.push(y);
  }
  boxes["track"] = [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2];
}

const MIN_GAP = 6;      // between the three windows
const MIN_CLEAR = 12;   // between the button's circle and any window

const problems = [];
for (const [name, [x0, y0, x1, y1]] of Object.entries(boxes)) {
  if (x0 < -0.5 || y0 < -0.5 || x1 > box + 0.5 || y1 > boxHeight + 0.5) {
    problems.push(
      `${name} leaves the ${box}x${boxHeight} box: x ${x0.toFixed(0)}..${x1.toFixed(0)}, y ${y0.toFixed(0)}..${y1.toFixed(0)}`
    );
  }
}
for (const [a, b] of [["window -1", "window 0"], ["window 0", "window 1"], ["window -1", "window 1"]]) {
  const [ax0, ay0, ax1, ay1] = boxes[a];
  const [bx0, by0, bx1, by1] = boxes[b];
  const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  const oy = Math.min(ay1, by1) - Math.max(ay0, by0);
  if (ox > -MIN_GAP && oy > -MIN_GAP) {
    problems.push(`${a} and ${b} are ${Math.max(ox, oy).toFixed(0)}pt from touching`);
  }
}
for (const name of ["window -1", "window 0", "window 1"]) {
  const [x0, y0, x1, y1] = boxes[name];
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  const clear = Math.hypot(dx, dy) - hubRadius;
  if (clear < MIN_CLEAR) {
    problems.push(`the button clears ${name} by only ${clear.toFixed(0)}pt (want ${MIN_CLEAR})`);
  }
}

if (problems.length) {
  console.error("Fold wheel geometry is wrong:");
  for (const p of problems) console.error(`  · ${p}`);
  console.error(`\nEdit the constants in ${FILE} until this passes.`);
  process.exit(1);
}
console.log(`duo-wheel-geometry: ok (${box}x${boxHeight} box, r${radius}, ${step}° step, ${hubRadius * 2}pt button)`);
