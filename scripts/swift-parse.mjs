#!/usr/bin/env node
/**
 * Parse every Swift source in the repository.
 *
 * `scripts/syntax.mjs` does this for the Workers and the browser bundles, and
 * `scripts/validate-native.mjs` checks the native clients' structure — but
 * structure checks are regular expressions, and a regular expression cannot
 * tell you that a brace is missing. Until this existed, the first thing that
 * knew whether the Swift was even well-formed was Xcode, several minutes and
 * one machine away, which is a slow way to find out that an edit landed a
 * paren in the wrong place.
 *
 * This is `swiftc -parse`: syntax only. It resolves no modules and checks no
 * types, so it runs anywhere a Swift toolchain does — including this repo's
 * Linux CI, where SwiftUI does not exist and a real build never will. It is
 * not a substitute for building the app; it is the cheap half of the answer,
 * available in seconds rather than minutes.
 *
 * With no toolchain on the machine it says so and passes, because failing a
 * check for a tool the environment was never going to have teaches people to
 * ignore the check. Set SWIFTC to point at a specific compiler.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function toolchain() {
  if (process.env.SWIFTC) return process.env.SWIFTC;
  for (const probe of [["swiftc", ["--version"]], ["xcrun", ["--find", "swiftc"]]]) {
    try {
      const out = execFileSync(probe[0], probe[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return probe[0] === "xcrun" ? out.trim() : "swiftc";
    } catch { /* not this one */ }
  }
  return null;
}

function swiftFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".build" || entry === "build" || entry === ".git" || entry === "DerivedData") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) swiftFiles(path, found);
    else if (entry.endsWith(".swift")) found.push(path);
  }
  return found;
}

const swiftc = toolchain();
const files = swiftFiles("apps").sort();

if (!swiftc) {
  console.log(`swift-parse: skipped, no Swift toolchain on this machine (${files.length} files unchecked).`);
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  // One file at a time: parsing them together makes the compiler resolve
  // names across the batch, which is type-checking by the back door and
  // fails on every module this machine does not have.
  const run = spawnSync(swiftc, ["-parse", "-suppress-warnings", file], { encoding: "utf8" });
  if (run.status !== 0) {
    failed += 1;
    console.error(`${file}:`);
    for (const line of (run.stderr || run.stdout || "").split("\n").slice(0, 8)) {
      if (line.trim()) console.error(`  ${line}`);
    }
  }
}

if (failed) {
  console.error(`\nswift-parse: ${failed} of ${files.length} Swift files do not parse.`);
  process.exit(1);
}
console.log(`swift-parse: ok (${files.length} Swift sources parse).`);
