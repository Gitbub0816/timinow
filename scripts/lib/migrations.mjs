/**
 * Apply every migration, in order, to a test database.
 *
 * Each test harness used to carry its own hand-written list of migration
 * files. Six lists drifted apart the moment a new migration landed, and the
 * failure they produced — "no such table" from a module the test was not even
 * about — cost more to diagnose than the lists ever saved. Production applies
 * all of them in order; so does this.
 */

import { readdir, readFile } from "node:fs/promises";

/** Every migration filename on disk, in lexical order, which is apply order. */
export async function migrationFiles(directory = "migrations") {
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Apply them all to a `node:sqlite` DatabaseSync.
 *
 * Returns the list applied, so a harness can print or assert on it. A failure
 * names the file that failed, because "syntax error near ORDER" with no file
 * attached is a bad afternoon.
 */
export async function applyMigrations(database, directory = "migrations") {
  const files = await migrationFiles(directory);
  for (const file of files) {
    try {
      database.exec(await readFile(`${directory}/${file}`, "utf8"));
    } catch (error) {
      throw new Error(`migrations/${file} failed to apply: ${error.message}`);
    }
  }
  return files;
}
