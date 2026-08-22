// Syntax-checks every JavaScript file the three Workers and the three browser
// bundles ship, so a typo in a console cannot reach a deploy.
import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const roots = ["src", "public", "scripts", "apps/vet-web", "apps/admin-console", "apps/voice-gateway"];
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

const files = (await Promise.all(roots.map(collect))).flat().sort();
if (!files.length) throw new Error("No JavaScript sources were found to check");

const failures = [];
for (const file of files) {
  // Service workers reference globals Node does not define, but `--check` only
  // parses, so this stays a pure syntax gate.
  await run(process.execPath, ["--check", file]).catch((error) => {
    failures.push(`${file}\n${error.stderr || error.message}`);
  });
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  throw new Error(`${failures.length} file(s) failed the syntax check`);
}

console.log(`Syntax check passed for ${files.length} JavaScript files across every Worker and browser bundle.`);
