/**
 * Delete operating-system junk from every directory that is published as
 * public static assets, before a deploy uploads it.
 *
 * `.assetsignore` is the supported way to do this and it is checked in, but it
 * is only honoured by newer Wrangler: a deploy run with 4.125 uploaded
 * `public/.DS_Store` regardless, and https://timinow.pet/.DS_Store answered 200
 * with 6 KB listing every filename in the directory. `.gitignore` has no say
 * here either — Wrangler builds its upload list from disk, not from git, which
 * is exactly why a file nobody had ever committed ended up in production.
 *
 * So this does not depend on a version or on a config file being read. It
 * removes the files, which no tool can then decline to ignore. macOS recreates
 * .DS_Store the moment Finder looks at the folder, so it runs on every deploy
 * rather than once.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Every directory named as an assets `directory` in a wrangler config. */
const roots = ["public", "apps/admin-console/public", "apps/vet-web/public", "apps/voice-gateway/public", "apps/blog/public"];

/** Junk only. Nothing here is ever a real asset. */
const junk = [/^\.DS_Store$/, /^\._/, /^\.Spotlight-V100$/, /^\.Trashes$/, /^Thumbs\.db$/i, /^desktop\.ini$/i];

let removed = 0;
async function sweep(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // A surface that does not exist in this checkout is not an error.
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (junk.some((pattern) => pattern.test(entry.name))) {
      await rm(path, { recursive: true, force: true });
      console.log(`  removed ${path}`);
      removed += 1;
    } else if (entry.isDirectory()) {
      await sweep(path);
    }
  }
}

for (const root of roots) await sweep(root);
console.log(removed ? `Removed ${removed} junk file(s) before deploy.` : "Assets are clean.");
