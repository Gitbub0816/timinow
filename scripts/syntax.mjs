// Syntax-checks every JavaScript file the three Workers and the three browser
// bundles ship, so a typo in a console cannot reach a deploy.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transform } from "esbuild";

const run = promisify(execFile);
const roots = ["src", "public", "scripts", "apps/vet-web", "apps/admin-console", "apps/voice-gateway", "apps/widget-demo", "apps/blog"];
const skipDirectories = new Set(["node_modules", ".wrangler", ".git", "assets", "bin", "obj"]);

async function collect(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (skipDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(path)));
    else if ([".js", ".mjs"].includes(extname(entry.name))) found.push(path);
  }
  return found;
}

const failures = [];
const files = (await Promise.all(roots.map(collect))).flat().sort();
if (!files.length) throw new Error("No JavaScript sources were found to check");

/**
 * The same duplicate-key problem, in the configs.
 *
 * `node --check` catches nothing here because these are not JavaScript, and
 * JSON.parse is worse than silent: it accepts a duplicate key and keeps the
 * LAST one. A second `"services"` block added to wrangler.jsonc — with the
 * first one already three screens further down — deployed a Worker whose
 * service bindings were whatever the later block said, and the binding the
 * new code needed simply was not there. The Worker started, the deploy
 * reported success, the health check passed, and /blog answered 404.
 *
 * So: every key, at every level, once.
 */
function duplicateKeysIn(source) {
  // Comments first, since JSONC allows them and a // inside a string must not
  // be mistaken for one. Scanning handles both at once below.
  const stack = [];
  const duplicates = [];
  let index = 0;
  let pendingKey = null;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2) + 2;
      continue;
    }
    if (character === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      pendingKey = source.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (character === ":" && pendingKey !== null && stack.length) {
      const seen = stack[stack.length - 1];
      if (seen.has(pendingKey)) duplicates.push(pendingKey);
      seen.add(pendingKey);
      pendingKey = null;
      index += 1;
      continue;
    }
    if (character === "{") { stack.push(new Set()); pendingKey = null; }
    else if (character === "}") { stack.pop(); pendingKey = null; }
    else if (character === "," || character === "[" || character === "]") pendingKey = null;
    index += 1;
  }
  return duplicates;
}

for (const config of (await readdir(".")).filter((name) => /^wrangler.*\.jsonc?$/.test(name)).sort()) {
  const duplicates = duplicateKeysIn(await readFile(config, "utf8"));
  if (duplicates.length) {
    failures.push(`${config}\nDuplicate key(s): ${[...new Set(duplicates)].join(", ")}. JSON keeps the last one silently, so the first is dead configuration that still reads as live.`);
  }
}

for (const file of files) {
  // Service workers reference globals Node does not define, but `--check` only
  // parses, so this stays a pure syntax gate.
  await run(process.execPath, ["--check", file]).catch((error) => {
    failures.push(`${file}\n${error.stderr || error.message}`);
  });

  /**
   * A stray control character parses fine and ruins everything downstream.
   * One reached src/match-alias.js as a sentinel inside a string literal:
   * node ran it, but git, grep, and every editor called the file binary, so
   * it stopped being reviewable. Tabs, newlines and carriage returns are
   * ordinary; nothing else below 0x20 belongs in source.
   */
  const source = await readFile(file, "utf8");
  const control = source.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  if (control) {
    const offset = source.indexOf(control[0]);
    const line = source.slice(0, offset).split("\n").length;
    failures.push(`${file}:${line}\nContains control character U+${control[0].codePointAt(0).toString(16).padStart(4, "0").toUpperCase()}. It parses, but git and grep will treat the file as binary and stop showing you its contents.`);
  }

  /**
   * `node --check` cannot see a duplicate key: `{ a: 1, a: 2 }` is legal
   * JavaScript and the last one silently wins. That makes the first assignment
   * dead code that still reads as live, which is the dangerous shape — one in
   * normalizeOfferRow (src/db.js) set `locationId` unconditionally and then
   * again, further down, conditionally on whether the clinic may be revealed.
   * Correct only by accident of ordering: deleting the second would have
   * unmasked a clinic's identity before the customer selected it, and nothing
   * would have failed.
   *
   * esbuild flags it, and is already here as a Wrangler dependency — the same
   * warning was scrolling past on every deploy with nobody reading it. Making
   * it fail the gate is the difference between a warning and a check.
   */
  const warnings = await transform(source, { loader: "js", format: "esm" })
    .then((result) => result.warnings)
    .catch(() => []);
  for (const warning of warnings) {
    if (warning.id !== "duplicate-object-key") continue;
    failures.push(`${file}:${warning.location?.line ?? "?"}\n${warning.text}. The last one wins, so the earlier assignment is dead code that still reads as live.`);
  }
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  throw new Error(`${failures.length} file(s) failed the syntax check`);
}

console.log(`Syntax check passed for ${files.length} JavaScript files across every Worker and browser bundle.`);
