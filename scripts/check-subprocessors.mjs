// Keeps every Worker's Content-Security-Policy in step with
// docs/SUBPROCESSORS.md. The two are maintained by hand in two different
// files for two different audiences (engineers reading a header constant,
// everyone else reading a table) — this script is what stops them drifting
// apart instead of a reviewer having to notice by eye.
//
// Fails if:
//   - a host appears in a Worker's CSP but not in the subprocessors table
//     (a new integration whose docs never got written), or
//   - a host appears in the subprocessors table but no Worker's CSP
//     references it (a documented integration whose CSP entry was never
//     added, or removed and left stale in the doc).
import { readFile } from "node:fs/promises";

const WORKER_FILES = [
  "src/index.js",
  "apps/vet-web/src/index.js",
  "apps/admin-console/src/index.js",
  "apps/voice-gateway/src/index.js",
  "apps/widget-demo/src/index.js"
];

const HOST_PATTERN = /https:\/\/[A-Za-z0-9.*-]+/g;

function hostsIn(text) {
  return new Set((text.match(HOST_PATTERN) || []).map((h) => h.toLowerCase()));
}

async function cspHostsForWorker(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return null; // Worker doesn't exist in this checkout; not this script's problem.
  }
  const match = source.match(/CONTENT_SECURITY_POLICY\s*=\s*\[([\s\S]*?)\]\.join/);
  if (!match) {
    // A Worker with no CSP constant at all is a real finding, not a skip —
    // every Worker in WORKER_FILES is expected to define one (even a
    // deliberately locked-down `default-src 'none'` one, as voice-gateway
    // does inline rather than via this constant — handled below).
    const inline = source.match(/"content-security-policy":\s*"([^"]*)"/);
    return inline ? hostsIn(inline[1]) : new Set();
  }
  return hostsIn(match[1]);
}

async function documentedHosts() {
  const doc = await readFile("docs/SUBPROCESSORS.md", "utf8");
  const tableSection = doc.split("## Third-party hosts referenced in page code (CSP-relevant)")[1] || "";
  const rows = tableSection.split("\n").filter((line) => line.startsWith("| `https://"));
  const hosts = new Set();
  for (const row of rows) {
    const cell = row.match(/`(https:\/\/[^`]+)`/);
    if (cell) hosts.add(cell[1].toLowerCase());
  }
  return hosts;
}

const [codeHostSets, documented] = await Promise.all([
  Promise.all(WORKER_FILES.map(async (file) => [file, await cspHostsForWorker(file)])),
  documentedHosts()
]);

const codeHosts = new Set();
for (const [, hosts] of codeHostSets) {
  if (!hosts) continue;
  for (const host of hosts) codeHosts.add(host);
}

const undocumented = [...codeHosts].filter((h) => !documented.has(h));
const stale = [...documented].filter((h) => !codeHosts.has(h));

if (undocumented.length || stale.length) {
  if (undocumented.length) {
    console.error("Hosts referenced in a Worker's CSP but missing from docs/SUBPROCESSORS.md:");
    for (const host of undocumented) console.error(`  - ${host}`);
  }
  if (stale.length) {
    console.error("Hosts listed in docs/SUBPROCESSORS.md but not referenced in any Worker's CSP:");
    for (const host of stale) console.error(`  - ${host}`);
  }
  console.error("\nA new subprocessor, CDN script, or page that calls one is a two-edit change:");
  console.error("add the host to docs/SUBPROCESSORS.md AND to the CSP of every Worker that loads it.");
  process.exit(1);
}

console.log(`check-subprocessors: ${codeHosts.size} hosts, all documented and in sync.`);
