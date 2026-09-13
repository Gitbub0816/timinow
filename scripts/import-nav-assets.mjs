#!/usr/bin/env node
/**
 * Turns the navigation asset system (assets/navigation/**.svg) into one
 * compact JSON resource the iOS app replays at runtime.
 *
 *   node scripts/import-nav-assets.mjs          # regenerate
 *   node scripts/import-nav-assets.mjs --check  # fail if the copy is stale
 *
 * Why a build step rather than shipping the SVGs: SwiftUI has no SVG
 * renderer, and the alternatives are all worse. An asset catalogue would give
 * up `currentColor` tinting and CarPlay's `symbolImage`; a runtime SVG parser
 * would put path parsing, arc conversion and marker resolution on the hot path
 * of a screen somebody reads at 60 mph, and every parser bug would be a device
 * bug. Parsing once, here, leaves the app replaying a list of absolute
 * move/line/curve/close commands — which is the one thing SwiftUI's `Path`,
 * UIKit's `UIBezierPath` and Skip's Android bridge all do identically.
 *
 * The output keeps the design system's own contract: geometry only, painted in
 * `currentColor`, so state stays a tint and never becomes a second file.
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SOURCE = path.join(ROOT, "assets/navigation");
const OUTPUT = path.join(ROOT, "apps/customer-mobile/Sources/TimiNowUI/Resources/nav-assets.json");

/* ───────────────────────────────────────────────── path data ───── */

/** Splits a `d` attribute into [command, ...numbers] tuples. */
function tokenize(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const out = [];
  let current = null;
  for (const token of tokens) {
    if (/[a-zA-Z]/.test(token)) {
      current = { command: token, args: [] };
      out.push(current);
    } else if (current) {
      current.args.push(Number(token));
    }
  }
  return out;
}

/** How many numbers each command consumes per repetition. */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Converts one elliptical arc into cubic Bézier segments.
 *
 * Implements the endpoint-to-centre parameterisation from the SVG spec's
 * implementation notes (F.6.5) — the arcs in this asset set are roundabout
 * rims and shield corners, and approximating them with chords would show.
 */
function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [["L", x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  rx = Math.abs(rx);
  ry = Math.abs(ry);
  // Scale up radii that cannot span the endpoints (spec F.6.6).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let value = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) value = -value;
    return value;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  // A cubic tracks a circular arc well up to a quarter turn; past that, split.
  const segments = Math.max(1, Math.ceil(Math.abs(delta / (Math.PI / 2))));
  const step = delta / segments;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const out = [];
  let theta = theta1;
  let px = x1;
  let py = y1;
  for (let i = 0; i < segments; i++) {
    const next = theta + step;
    const cosA = Math.cos(theta);
    const sinA = Math.sin(theta);
    const cosB = Math.cos(next);
    const sinB = Math.sin(next);

    const ex = cx + cosPhi * rx * cosB - sinPhi * ry * sinB;
    const ey = cy + sinPhi * rx * cosB + cosPhi * ry * sinB;

    const d1x = -rx * sinA;
    const d1y = ry * cosA;
    const d2x = -rx * sinB;
    const d2y = ry * cosB;

    const c1x = px + alpha * (cosPhi * d1x - sinPhi * d1y);
    const c1y = py + alpha * (sinPhi * d1x + cosPhi * d1y);
    const c2x = ex - alpha * (cosPhi * d2x - sinPhi * d2y);
    const c2y = ey - alpha * (sinPhi * d2x + cosPhi * d2y);

    out.push(["C", c1x, c1y, c2x, c2y, ex, ey]);
    theta = next;
    px = ex;
    py = ey;
  }
  return out;
}

/**
 * Normalises a `d` attribute to absolute M / L / C / Q / Z commands.
 *
 * Relative forms, shorthand (H, V, S, T) and arcs are all resolved here so the
 * runtime never has to know they exist.
 */
function normalizePath(d) {
  const out = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Reflection points for the S / T shorthands.
  let lastControlX = null;
  let lastControlY = null;
  let lastQuadX = null;
  let lastQuadY = null;

  for (const token of tokenize(d)) {
    const upper = token.command.toUpperCase();
    const relative = token.command !== upper;
    const arity = ARITY[upper];
    if (arity === undefined) continue;

    // A command may repeat its argument group; "M" repeats as "L" per spec.
    let args = token.args;
    let first = true;
    do {
      const slice = arity === 0 ? [] : args.slice(0, arity);
      args = arity === 0 ? [] : args.slice(arity);
      if (arity > 0 && slice.length < arity) break;
      let kind = upper;
      if (kind === "M" && !first) kind = "L";

      switch (kind) {
        case "M": {
          x = relative ? x + slice[0] : slice[0];
          y = relative ? y + slice[1] : slice[1];
          startX = x;
          startY = y;
          out.push(["M", x, y]);
          lastControlX = lastControlY = lastQuadX = lastQuadY = null;
          break;
        }
        case "L": {
          x = relative ? x + slice[0] : slice[0];
          y = relative ? y + slice[1] : slice[1];
          out.push(["L", x, y]);
          lastControlX = lastControlY = lastQuadX = lastQuadY = null;
          break;
        }
        case "H": {
          x = relative ? x + slice[0] : slice[0];
          out.push(["L", x, y]);
          lastControlX = lastControlY = lastQuadX = lastQuadY = null;
          break;
        }
        case "V": {
          y = relative ? y + slice[0] : slice[0];
          out.push(["L", x, y]);
          lastControlX = lastControlY = lastQuadX = lastQuadY = null;
          break;
        }
        case "C": {
          const c1x = relative ? x + slice[0] : slice[0];
          const c1y = relative ? y + slice[1] : slice[1];
          const c2x = relative ? x + slice[2] : slice[2];
          const c2y = relative ? y + slice[3] : slice[3];
          x = relative ? x + slice[4] : slice[4];
          y = relative ? y + slice[5] : slice[5];
          out.push(["C", c1x, c1y, c2x, c2y, x, y]);
          lastControlX = c2x;
          lastControlY = c2y;
          lastQuadX = lastQuadY = null;
          break;
        }
        case "S": {
          const c1x = lastControlX === null ? x : 2 * x - lastControlX;
          const c1y = lastControlY === null ? y : 2 * y - lastControlY;
          const c2x = relative ? x + slice[0] : slice[0];
          const c2y = relative ? y + slice[1] : slice[1];
          x = relative ? x + slice[2] : slice[2];
          y = relative ? y + slice[3] : slice[3];
          out.push(["C", c1x, c1y, c2x, c2y, x, y]);
          lastControlX = c2x;
          lastControlY = c2y;
          lastQuadX = lastQuadY = null;
          break;
        }
        case "Q": {
          const qx = relative ? x + slice[0] : slice[0];
          const qy = relative ? y + slice[1] : slice[1];
          x = relative ? x + slice[2] : slice[2];
          y = relative ? y + slice[3] : slice[3];
          out.push(["Q", qx, qy, x, y]);
          lastQuadX = qx;
          lastQuadY = qy;
          lastControlX = lastControlY = null;
          break;
        }
        case "T": {
          const qx = lastQuadX === null ? x : 2 * x - lastQuadX;
          const qy = lastQuadY === null ? y : 2 * y - lastQuadY;
          x = relative ? x + slice[0] : slice[0];
          y = relative ? y + slice[1] : slice[1];
          out.push(["Q", qx, qy, x, y]);
          lastQuadX = qx;
          lastQuadY = qy;
          lastControlX = lastControlY = null;
          break;
        }
        case "A": {
          const ex = relative ? x + slice[5] : slice[5];
          const ey = relative ? y + slice[6] : slice[6];
          for (const segment of arcToCubics(x, y, slice[0], slice[1], slice[2], slice[3], slice[4], ex, ey)) {
            out.push(segment);
          }
          x = ex;
          y = ey;
          lastControlX = lastControlY = lastQuadX = lastQuadY = null;
          break;
        }
        case "Z": {
          out.push(["Z"]);
          x = startX;
          y = startY;
          lastControlX = lastControlY = lastQuadX = lastQuadY = null;
          break;
        }
      }
      first = false;
    } while (args.length > 0);
  }
  return out;
}

/** The drawn end point and the direction of travel arriving at it. */
function endTangent(commands) {
  let x = 0;
  let y = 0;
  let previousX = 0;
  let previousY = 0;
  for (const command of commands) {
    const [kind] = command;
    previousX = x;
    previousY = y;
    if (kind === "M" || kind === "L") {
      x = command[1];
      y = command[2];
    } else if (kind === "Q") {
      previousX = command[1];
      previousY = command[2];
      x = command[3];
      y = command[4];
    } else if (kind === "C") {
      previousX = command[3];
      previousY = command[4];
      x = command[5];
      y = command[6];
    }
  }
  let dx = x - previousX;
  let dy = y - previousY;
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }
  return { x, y, angle: Math.atan2(dy, dx) };
}

/* ─────────────────────────────────────────────────── elements ───── */

const attribute = (tag, name) => {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : null;
};

const round = (value) => Math.round(value * 100) / 100;

function ellipseCommands(cx, cy, r) {
  // Four quarter-arc cubics — the same approximation arcToCubics uses.
  const k = 0.5522847498307936 * r;
  return [
    ["M", cx, cy - r],
    ["C", cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ["C", cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    ["C", cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ["C", cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    ["Z"]
  ];
}

function rectCommands(x, y, w, h, rx) {
  if (!rx) {
    return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
  }
  const r = Math.min(rx, w / 2, h / 2);
  const k = 0.5522847498307936 * r;
  return [
    ["M", x + r, y],
    ["L", x + w - r, y],
    ["C", x + w - r + k, y, x + w, y + r - k, x + w, y + r],
    ["L", x + w, y + h - r],
    ["C", x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h],
    ["L", x + r, y + h],
    ["C", x + r - k, y + h, x, y + h - r + k, x, y + h - r],
    ["L", x, y + r],
    ["C", x, y + r - k, x + r - k, y, x + r, y],
    ["Z"]
  ];
}

/** Resolves `marker-end` into explicit filled geometry at the path's end. */
function markerShape(marker, commands, strokeWidth, fill) {
  const tip = endTangent(commands);
  const viewBox = (marker.viewBox || "0 0 12 12").split(/[\s,]+/).map(Number);
  const unitScale = marker.markerUnits === "userSpaceOnUse" ? 1 : strokeWidth;
  const scale = (marker.markerWidth * unitScale) / (viewBox[2] || 12);
  const cos = Math.cos(tip.angle);
  const sin = Math.sin(tip.angle);
  const place = (px, py) => {
    const ox = (px - marker.refX) * scale;
    const oy = (py - marker.refY) * scale;
    return [round(tip.x + ox * cos - oy * sin), round(tip.y + ox * sin + oy * cos)];
  };
  const out = [];
  for (const command of normalizePath(marker.d)) {
    const [kind, ...args] = command;
    if (kind === "Z") {
      out.push(["Z"]);
      continue;
    }
    const points = [];
    for (let i = 0; i < args.length; i += 2) points.push(...place(args[i], args[i + 1]));
    out.push([kind, ...points]);
  }
  return { fill, commands: out };
}

/** Reads one SVG into an ordered list of fill / stroke shapes. */
function parseSvg(source) {
  const viewBox = (attribute(source, "viewBox") || "0 0 120 120").split(/[\s,]+/).map(Number);

  const markers = {};
  for (const block of source.match(/<marker[\s\S]*?<\/marker>/g) || []) {
    const id = attribute(block, "id");
    const inner = block.match(/<path[^>]*>/);
    if (!id || !inner) continue;
    markers[id] = {
      viewBox: attribute(block, "viewBox"),
      refX: Number(attribute(block, "refX") || 0),
      refY: Number(attribute(block, "refY") || 0),
      markerWidth: Number(attribute(block, "markerWidth") || 3),
      markerUnits: attribute(block, "markerUnits") || "strokeWidth",
      d: attribute(inner[0], "d") || ""
    };
  }

  // Everything outside <defs>, in document order.
  const body = source.replace(/<defs[\s\S]*?<\/defs>/g, "");
  const shapes = [];

  const tagPattern = /<(path|circle|rect|polygon|text)\b([^>]*)>/g;
  let match;
  while ((match = tagPattern.exec(body)) !== null) {
    const [, element, rawAttributes] = match;
    const tag = `<${element}${rawAttributes}>`;

    if (element === "text") {
      // Kept, not skipped. The system's rule that text is never baked into
      // artwork is about *data* — a route number, a road name, a distance.
      // The lettering on a state plate is the marker's own design, the way
      // CALIFORNIA is printed on a real California state route shield, and
      // dropping it leaves a green blob. The route number is still the
      // renderer's to supply.
      const content = body.slice(tagPattern.lastIndex).match(/^([^<]*)/);
      const label = (content ? content[1] : "").trim();
      if (!label) continue;
      shapes.push({
        type: "text",
        text: label,
        x: round(Number(attribute(tag, "x") || 0)),
        y: round(Number(attribute(tag, "y") || 0)),
        size: Number(attribute(tag, "font-size") || 10),
        weight: Number(attribute(tag, "font-weight") || 400),
        anchor: attribute(tag, "text-anchor") || "start",
        tracking: Number(attribute(tag, "letter-spacing") || 0),
        color: attribute(tag, "fill") || "currentColor"
      });
      continue;
    }

    let commands;
    if (element === "path") {
      commands = normalizePath(attribute(tag, "d") || "");
    } else if (element === "circle") {
      commands = ellipseCommands(
        Number(attribute(tag, "cx") || 0),
        Number(attribute(tag, "cy") || 0),
        Number(attribute(tag, "r") || 0)
      );
    } else if (element === "rect") {
      commands = rectCommands(
        Number(attribute(tag, "x") || 0),
        Number(attribute(tag, "y") || 0),
        Number(attribute(tag, "width") || 0),
        Number(attribute(tag, "height") || 0),
        Number(attribute(tag, "rx") || 0)
      );
    } else {
      const points = (attribute(tag, "points") || "").split(/[\s,]+/).filter(Boolean).map(Number);
      commands = [];
      for (let i = 0; i + 1 < points.length; i += 2) {
        commands.push([i === 0 ? "M" : "L", points[i], points[i + 1]]);
      }
      commands.push(["Z"]);
    }
    if (commands.length === 0) continue;

    const rounded = commands.map(([kind, ...args]) => [kind, ...args.map(round)]);
    const stroke = attribute(tag, "stroke");
    const strokeWidth = Number(attribute(tag, "stroke-width") || 0);
    const fill = attribute(tag, "fill");
    const opacity = attribute(tag, "opacity");

    if (fill && fill !== "none") {
      const shape = { type: "fill", commands: rounded, color: fill };
      if (opacity) shape.opacity = Number(opacity);
      shapes.push(shape);
    }
    if (stroke && stroke !== "none" && strokeWidth > 0) {
      const shape = {
        type: "stroke",
        commands: rounded,
        color: stroke,
        width: strokeWidth,
        cap: attribute(tag, "stroke-linecap") || "butt",
        join: attribute(tag, "stroke-linejoin") || "miter"
      };
      if (opacity) shape.opacity = Number(opacity);
      const dash = attribute(tag, "stroke-dasharray");
      if (dash) shape.dash = dash.split(/[\s,]+/).filter(Boolean).map(Number);
      shapes.push(shape);
    }

    const markerRef = attribute(tag, "marker-end");
    const markerId = markerRef && markerRef.match(/url\(#([^)]+)\)/);
    if (markerId && markers[markerId[1]]) {
      const marker = markers[markerId[1]];
      const head = markerShape(marker, commands, strokeWidth || 1, stroke || "currentColor");
      shapes.push({ type: "fill", commands: head.commands, color: head.fill });
    }
  }

  return { viewBox: [viewBox[2] || 120, viewBox[3] || 120], shapes };
}

/* ────────────────────────────────────────────────────── build ───── */

/** The bounding box of every point the shapes draw. */
function contentBounds(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of shapes) {
    if (shape.type === "text") {
      // Approximate: lettering sits inside the plate it labels, so it never
      // sets the bounds. Counting a guessed text box would only shrink the
      // artwork around it.
      continue;
    }
    // Half the stroke width spills either side of the centre line.
    const pad = shape.type === "stroke" ? (shape.width || 0) / 2 : 0;
    for (const [, ...args] of shape.commands) {
      for (let i = 0; i + 1 < args.length; i += 2) {
        minX = Math.min(minX, args[i] - pad);
        maxX = Math.max(maxX, args[i] + pad);
        minY = Math.min(minY, args[i + 1] - pad);
        maxY = Math.max(maxY, args[i + 1] + pad);
      }
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory)) {
    const full = path.join(directory, entry);
    if ((await stat(full)).isDirectory()) found.push(...(await walk(full)));
    else if (entry.endsWith(".svg")) found.push(full);
  }
  return found.sort();
}

async function build() {
  const files = await walk(SOURCE);
  const assets = {};
  const warnings = [];

  for (const file of files) {
    const key = path
      .relative(SOURCE, file)
      .replace(/\.svg$/, "")
      .split(path.sep)
      .join("/");
    const source = await readFile(file, "utf8");
    const parsed = parseSvg(source);

    // The `signal` variants stroke with url(#sig) — a gradient no file in the
    // pack defines — so they would paint nothing at all. Recorded rather than
    // silently repainted: the app uses the flat `currentColor` set, and this
    // names the gap instead of hiding it.
    const unresolved = source.match(/url\(#(?!t\b)([^)]+)\)/g);
    if (unresolved) warnings.push(`${key}: unresolved paint reference ${[...new Set(unresolved)].join(", ")}`);
    if (parsed.shapes.length === 0) warnings.push(`${key}: no drawable geometry`);

    // Some primitives draw past their own viewBox — the roundabouts put the
    // resolved arrowhead up to 22 units outside it, which a browser clips and
    // a driver would read as a headless stub. Rather than clip or silently
    // redraw someone else's artwork, the emitted box is the union of the
    // declared viewBox and what the asset actually draws, so the renderer
    // fits the whole primitive. Assets that already fit are untouched.
    const bounds = contentBounds(parsed.shapes);
    let box = [0, 0, parsed.viewBox[0], parsed.viewBox[1]];
    if (bounds) {
      const minX = Math.min(0, bounds[0]);
      const minY = Math.min(0, bounds[1]);
      const maxX = Math.max(parsed.viewBox[0], bounds[2]);
      const maxY = Math.max(parsed.viewBox[1], bounds[3]);
      box = [round(minX), round(minY), round(maxX - minX), round(maxY - minY)];
      if (minX < -0.5 || minY < -0.5 || maxX > parsed.viewBox[0] + 0.5 || maxY > parsed.viewBox[1] + 0.5) {
        warnings.push(
          `${key}: draws outside its ${parsed.viewBox[0]}x${parsed.viewBox[1]} viewBox ` +
          `(${box.join(", ")}) — a browser clips this; the app fits it instead`
        );
      }
    }
    assets[key] = { box, shapes: parsed.shapes };
  }

  return { assets, warnings };
}

const { assets, warnings } = await build();
const payload = {
  note: "Generated by scripts/import-nav-assets.mjs from assets/navigation — do not edit by hand.",
  assets
};
const serialized = JSON.stringify(payload);

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = await readFile(OUTPUT, "utf8");
  } catch {
    console.error("nav-assets.json is missing. Run: node scripts/import-nav-assets.mjs");
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error("nav-assets.json is stale. Run: node scripts/import-nav-assets.mjs");
    process.exit(1);
  }
  console.log(`nav-assets: ${Object.keys(assets).length} primitives in sync.`);
} else {
  await writeFile(OUTPUT, serialized);
  console.log(`nav-assets: wrote ${Object.keys(assets).length} primitives (${Math.round(serialized.length / 1024)}KB).`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
}
