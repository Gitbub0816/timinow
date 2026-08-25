import { access, readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

/** Walk a directory tree collecting sources with the given extension. */
async function collectFiles(root, extension) {
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    // Only our own sources. "build" is where scripts/build-*-app.sh put derived
    // data, which contains every dependency's full source — checking Mapbox's
    // brace balance is both meaningless and, since it uses syntax this lexer
    // does not model, a guaranteed false failure.
    if (["bin", "obj", "build", ".build", "DerivedData", "SourcePackages",
         "checkouts", ".swiftpm", "node_modules"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await collectFiles(path, extension)));
    else if (extname(entry.name) === extension) found.push(path);
  }
  return found.sort();
}


const root = process.cwd();
const required = [
  "apps/customer-mobile/Package.swift",
  "apps/customer-mobile/Darwin/project.yml",
  "apps/customer-mobile/Sources/TimiNowApp/Skip/skip.yml",
  "apps/customer-mobile/Sources/TimiNowUI/Skip/skip.yml",
  "apps/customer-mobile/Sources/TimiNowCore/Skip/skip.yml",
  "apps/customer-mobile/Tests/TimiNowCoreTests/Skip/skip.yml",
  "apps/customer-mobile/Sources/TimiNowCore/ConcernValidator.swift",
  "apps/customer-mobile/Sources/TimiNowUI/Resources/timi-care-companion.png",
  "apps/customer-mobile/Sources/TimiNowUI/OnboardingView.swift",
  "apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift",
  "apps/vet-windows/TimiVet.sln",
  "apps/vet-windows/src/TimiVet/TimiVet.csproj",
  "apps/vet-windows/src/TimiVet/Views/MainWindow.xaml",
  "apps/vet-windows/src/TimiVet/Views/MiniWindow.xaml",
  "apps/vet-windows/src/TimiVet/Services/AlertService.cs",
  "apps/vet-desktop/Package.swift",
  "apps/vet-desktop/Darwin/project.yml",
  "apps/vet-desktop/Sources/TimiVetUI/FloatingPanel.swift",
  "apps/vet-desktop/Sources/TimiVetCore/AuthController.swift"
];

await Promise.all(required.map((path) => access(resolve(root, path))));

const read = async (path) => readFile(resolve(root, path), "utf8");
const [validator, gateway, appStore, theme, onboarding, tracker, mini, alerts, clinicApi] = await Promise.all([
  read("apps/customer-mobile/Sources/TimiNowCore/ConcernValidator.swift"),
  read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift"),
  read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift"),
  read("apps/customer-mobile/Sources/TimiNowUI/Theme.swift"),
  read("apps/customer-mobile/Sources/TimiNowUI/OnboardingView.swift"),
  read("apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift"),
  read("apps/vet-windows/src/TimiVet/Views/MiniWindow.xaml"),
  read("apps/vet-windows/src/TimiVet/Services/AlertService.cs"),
  read("apps/vet-windows/src/TimiVet/Services/ClinicApiClient.cs")
]);
const settingsStore = await read("apps/vet-windows/src/TimiVet/Services/SettingsStore.cs");
const nativeWorkflow = await read(".github/workflows/native-clients.yml");

const expectations = [
  [validator, "not acting like", "deterministic vague-concern rule"],
  // The Worker's threshold, not a second opinion: it measures characters as
  // well as words, and this asked for eight words and counted no characters.
  [validator, "trimmed.count < 30 || words.count < 6", "concern detail threshold"],
  [gateway, "targetLimit: 30", "30-clinic fan-out contract"],
  [tracker, "sorted.prefix(5)", "five-offer comparison"],
  [onboarding, "completeOnboarding", "guided onboarding completion"],
  [mini, 'Topmost="True"', "always-on-top floating queue"],
  [mini, 'ResizeMode="CanResizeWithGrip"', "resizable floating queue"],
  [alerts, "NotifyIcon", "Windows tray alerts"],
  [clinicApi, "api/clinic/dashboard", "clinic dashboard integration"],
  [clinicApi, "search-targets", "clinic offer integration"]
];

for (const [source, needle, label] of expectations) {
  if (!source.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
}

if (gateway.includes("bearerToken: String? = nil, session:")) throw new Error("URLSession must not appear in the public Skip bridge surface.");
// Comments stripped first. The file explains this very rule, and a guard that
// fires on its own explanation can never be satisfied — the same trap the
// xcconfig and keychain checks already had to be taught.
{
  const executable = gateway.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  if (executable.includes("LocalizedError") || executable.includes("errorDescription")) {
    throw new Error("Swift-only LocalizedError overrides cannot be translated by Skip. Callers read TimiAPIError.message through AppStore.describe instead.");
  }
}
if (appStore.includes("init(defaults: UserDefaults")) throw new Error("UserDefaults must not appear in the public Skip bridge surface.");
if (appStore.includes("where: { $0.id == self.selectedPetId }")) throw new Error("AppStore initialization must not capture self before all members are initialized.");
if (/public\s+(struct|extension).*ButtonStyle|public\s+func\s+timiCard/.test(theme)) throw new Error("SwiftUI implementation helpers must stay out of the public Skip bridge surface.");
if (!clinicApi.includes("using System.Net.Http;")) throw new Error("Windows HTTP client namespace is not imported.");
if (!settingsStore.includes("using System.IO;")) throw new Error("Windows settings storage namespace is not imported.");

// The macOS console must keep the two properties that make it a console rather
// than another window: a genuinely always-on-top panel, and credentials that
// never touch the settings file.
const macPanel = await read("apps/vet-desktop/Sources/TimiVetUI/FloatingPanel.swift");
if (!macPanel.includes("NSPanel")) throw new Error("The macOS floating console must be an NSPanel.");
if (!macPanel.includes(".floating")) throw new Error("The macOS floating console must sit at the floating window level.");
const macSettings = await read("apps/vet-desktop/Sources/TimiVetCore/SettingsStore.swift");
if (/bearerToken|sessionToken/i.test(macSettings)) throw new Error("macOS credentials must live in the Keychain, not the settings file.");
if (!nativeWorkflow.includes("apps/vet-desktop")) throw new Error("CI must build the macOS veterinary console.");
if (!nativeWorkflow.includes('SKIP_BRIDGE=1 swift package resolve') || !nativeWorkflow.includes('install-swift-android-sdk: "true"')) throw new Error("Skip Fuse CI must install and resolve the native Android bridge.");
if (!nativeWorkflow.includes('timi-swift-test.log')) throw new Error("Skip test output must be bounded so CI failures remain diagnosable.");
if (!nativeWorkflow.includes('swift test --filter ConcernValidatorTests')) throw new Error("Native CI must run the deterministic intake validator tests without invoking the host-only Android harness.");

for (const path of [
  "apps/customer-mobile/Sources/TimiNowUI/Components.swift",
  "apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift",
  "apps/customer-mobile/Sources/TimiNowUI/IntakeFlowView.swift",
  "apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift",
  "apps/customer-mobile/Sources/TimiNowUI/OnboardingView.swift",
  "apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift"
]) {
  const source = await read(path);
  if (source.includes("@State private")) throw new Error(`Private SwiftUI state cannot be bridged by Skip: ${path}`);
  if (/navigationBarHidden|navigationBarTitleDisplayMode|textInputAutocapitalization/.test(source)) throw new Error(`iOS-only view modifier breaks Swift package validation on macOS: ${path}`);
}

/**
 * No Swift or .NET toolchain runs here, so an unclosed brace in a native source
 * would otherwise reach a developer's Mac before anyone noticed. Lex each file
 * well enough to ignore strings and comments, then check that every bracket and
 * every conditional-compilation block closes.
 */
function stripLiterals(text, { hashComments = false } = {}) {
  const out = [];
  let index = 0;
  let inString = false;
  let inMultiline = false;
  let inLineComment = false;
  let blockDepth = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] || "";
    if (inLineComment) {
      if (character === "\n") { inLineComment = false; out.push(character); }
      index += 1; continue;
    }
    if (blockDepth) {
      if (character === "*" && next === "/") { blockDepth -= 1; index += 2; continue; }
      if (character === "/" && next === "*") { blockDepth += 1; index += 2; continue; }
      if (character === "\n") out.push(character);
      index += 1; continue;
    }
    if (inMultiline) {
      if (text.startsWith('"""', index)) { inMultiline = false; index += 3; continue; }
      if (character === "\n") out.push(character);
      index += 1; continue;
    }
    if (inString) {
      if (character === "\\") { index += 2; continue; }
      if (character === '"') inString = false;
      index += 1; continue;
    }
    if (text.startsWith('"""', index)) { inMultiline = true; index += 3; continue; }
    if (character === '"') { inString = true; index += 1; continue; }
    if (character === "/" && next === "/") { inLineComment = true; index += 2; continue; }
    if (character === "/" && next === "*") { blockDepth = 1; index += 2; continue; }
    if (hashComments && character === "#") { inLineComment = true; index += 1; continue; }
    out.push(character); index += 1;
  }
  return out.join("");
}

function bracketProblems(source) {
  const stripped = stripLiterals(source);
  const problems = [];
  for (const [open, close, label] of [["{", "}", "braces"], ["(", ")", "parentheses"], ["[", "]", "brackets"]]) {
    const delta = stripped.split(open).length - stripped.split(close).length;
    if (delta) problems.push(`${delta > 0 ? delta : -delta} unclosed ${label}`);
  }
  return problems;
}

const swiftFiles = (await Promise.all(
  ["apps/customer-mobile", "apps/vet-desktop"].map(async (root) => collectFiles(root, ".swift"))
)).flat();

for (const path of swiftFiles) {
  const source = await read(path);
  const problems = bracketProblems(source);
  const opens = (source.match(/^\s*#if\b/gm) || []).length;
  const closes = (source.match(/^\s*#endif\b/gm) || []).length;
  if (opens !== closes) problems.push(`${opens} #if versus ${closes} #endif`);
  if (problems.length) throw new Error(`Unbalanced Swift source ${path}: ${problems.join(", ")}`);
}

/**
 * Two patterns Swift accepts happily and Skip's Android transpile rejects. Both
 * cost a full CI round trip to discover, and neither error message points
 * obviously at the line that caused it, so catch them here.
 */
for (const path of swiftFiles) {
  const source = await read(path);

  // Skip can only merge properties and functions into a type declared in
  // another module. An initializer in such an extension fails with "this
  // extension cannot be merged into its extended Kotlin type".
  const ownTypes = /^(?:public |internal )?(?:struct|enum|class|actor|protocol)\s+(\w+)/gm;
  const declared = new Set([...source.matchAll(ownTypes)].map((match) => match[1]));
  for (const match of source.matchAll(/^extension\s+(\w+)[^{]*\{/gm)) {
    const extended = match[1];
    if (declared.has(extended)) continue;
    const body = source.slice(match.index + match[0].length);
    const end = body.indexOf("\n}");
    if (/^\s+(?:public\s+|internal\s+)?(?:convenience\s+)?init[(<]/m.test(body.slice(0, end === -1 ? undefined : end))) {
      throw new Error(`${path}: extension on ${extended} declares an initializer. Skip can only merge properties and functions into a type from another module — use a static factory on one of our own types instead.`);
    }
  }

  // Skip cannot resolve a leading-dot member against a parameter of a function
  // we declare ourselves: "unable to determine the owning type for member".
  const leadingDot = source.match(/\.(?:timiCard|timiVetCard|timiVetEyebrow)\(\s*\.\w+/);
  if (leadingDot) {
    throw new Error(`${path}: ${leadingDot[0]} passes a leading-dot member to one of our own helpers. Skip cannot infer the owning type — write it out, e.g. Color.white.`);
  }

  // The customer package declares macOS so that `swift test` can run on a Mac
  // at all, which means every UI source is compiled for macOS too — and these
  // SwiftUI APIs do not exist there. The app never ships to macOS, so the
  // macOS branch only has to compile.
  const macUnavailable = source.match(/\.(fullScreenCover|navigationBarTitleDisplayMode|navigationBarHidden|statusBarHidden|indexViewStyle)\(/);
  if (macUnavailable && !/os\(macOS\)/.test(source)) {
    throw new Error(`${path}: uses ${macUnavailable[1]}, which is unavailable on macOS, with no os(macOS) branch. swift test builds this target for the host, so the core unit tests fail on a Mac.`);
  }

  // A default argument is evaluated at the call site, so a public function
  // cannot name a private member in one. Swift rejects this outright; it
  // reached CI once because the only build that compiles this module is the
  // macOS/iOS one.
  const privateStatics = new Set(
    [...source.matchAll(/^\s*private\s+static\s+(?:let|var)\s+(\w+)/gm)].map((m) => m[1])
  );
  if (privateStatics.size) {
    for (const declaration of source.matchAll(/^\s*public\s+(?:static\s+)?func\s+\w+[^{]*?\)(?:\s*(?:async|throws|rethrows))*\s*(?:->[^{]*)?\{/gms)) {
      for (const argument of declaration[0].matchAll(/[:,]\s*[^,()]*?=\s*(\w+)/g)) {
        if (privateStatics.has(argument[1])) {
          throw new Error(`${path}: a public function defaults an argument to the private ${argument[1]}. Swift evaluates a default at the call site, so it must be at least as visible as the function — default to nil and resolve inside instead.`);
        }
      }
    }
  }

  // Conditional variants of one function must agree on their signature. The
  // Mapbox, non-Mapbox, and Android paths are compiled one at a time, so a
  // parameter added to the real implementation and forgotten on the stub only
  // fails on the machine that builds the other branch. Overloads in the same
  // branch (delegate methods) are untouched — only mutually exclusive
  // declarations are compared.
  const branchPaths = [];
  {
    const stack = [];
    let blocks = 0;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*#if\b/.test(line)) stack.push({ id: (blocks += 1), branch: 0 });
      else if (/^\s*#(?:else|elseif)\b/.test(line) && stack.length) stack[stack.length - 1].branch += 1;
      else if (/^\s*#endif\b/.test(line)) stack.pop();
      const declaration = line.match(/\bfunc\s+(\w+)\s*\(/);
      if (!declaration) continue;
      // Parameters can wrap, so read forward until the argument list closes.
      let text = lines.slice(i, i + 20).join("\n").slice(line.indexOf(declaration[0]) + declaration[0].length);
      let depth = 1;
      let end = 0;
      while (end < text.length && depth > 0) {
        if (text[end] === "(") depth += 1;
        if (text[end] === ")") depth -= 1;
        end += 1;
      }
      const labels = text
        .slice(0, Math.max(0, end - 1))
        .split(",")
        .map((argument) => argument.trim().split(/[\s:]/)[0])
        .filter(Boolean)
        .join(", ");
      branchPaths.push({ name: declaration[1], labels, path: stack.map((b) => `${b.id}:${b.branch}`), line: i + 1 });
    }
  }
  for (let a = 0; a < branchPaths.length; a += 1) {
    for (let b = a + 1; b < branchPaths.length; b += 1) {
      const left = branchPaths[a];
      const right = branchPaths[b];
      if (left.name !== right.name || left.labels === right.labels) continue;
      const exclusive = left.path.some((entry) => {
        const [id, branch] = entry.split(":");
        return right.path.some((other) => other.startsWith(`${id}:`) && other !== `${id}:${branch}`);
      });
      if (exclusive) {
        throw new Error(`${path}: conditional variants of ${left.name} disagree — line ${left.line} takes (${left.labels}) but line ${right.line} takes (${right.labels}). Only one branch compiles at a time, so the other only fails elsewhere.`);
      }
    }
  }

  // Skip's bridge generator emits a non-optional @Sendable closure for a
  // bridged callback property, so an optional one produces generated Swift
  // that does not compile. Only the bridged core modules are affected.
  if (/Sources\/(?:TimiVetCore|TimiNowCore)\//.test(path)) {
    const optionalClosure = source.match(/^\s*public\s+var\s+(\w+)\s*:\s*\(\([^)]*\)\s*->\s*\w+\)\?/m);
    if (optionalClosure) {
      throw new Error(`${path}: public var ${optionalClosure[1]} is an optional closure on a Skip-bridged type. The generated bridge assumes a non-optional closure and fails to compile — give it a no-op default instead.`);
    }
  }
}

// The Mapbox SDKs import UIKit, so they must stay out of any non-iOS build:
// `swift test` compiles the whole package for the host, and a Mac with a
// downloads token configured would otherwise fail inside Mapbox's own sources.
{
  const manifest = await read("apps/customer-mobile/Package.swift");
  for (const product of manifest.matchAll(/\.product\(name:\s*"(Mapbox\w+)"[^)]*\)/g)) {
    if (!/condition:/.test(product[0])) {
      throw new Error(`apps/customer-mobile/Package.swift: ${product[1]} is added with no platform condition. Mapbox is iOS-only — add condition: .when(platforms: [.iOS]) or the macOS build of the package fails on 'no such module UIKit'.`);
    }
  }
  // The condition has to be written out at each call site. Binding it to a
  // `let x: TargetDependencyCondition` makes Swift pick the obsolete
  // `when(platforms:)` overload that takes an optional, and the manifest stops
  // evaluating at all — which reads as the whole toolchain failing to install.
  if (/:\s*TargetDependencyCondition\b/.test(manifest)) {
    throw new Error("apps/customer-mobile/Package.swift: a TargetDependencyCondition is bound to a named variable. That selects an obsolete when(platforms:) overload and the manifest fails to evaluate — write .when(platforms: [.iOS]) inline instead.");
  }
}

// A protocol requirement spelled `{ get async }` must be satisfied by an
// equally async implementation. Swift accepts a @MainActor synchronous
// property, but Skip transpiles the requirement to a suspend function and the
// synchronous getter to a plain one, so Kotlin reports the abstract member as
// unimplemented.
for (const module of ["apps/vet-desktop/Sources/TimiVetCore", "apps/customer-mobile/Sources/TimiNowCore"]) {
  const sources = await collectFiles(module, ".swift");
  const asyncRequirements = new Set();
  const bodies = [];
  for (const path of sources) {
    const source = await read(path);
    bodies.push({ path, source });
    for (const requirement of source.matchAll(/^\s*var\s+(\w+)\s*:[^{]+\{\s*get\s+async\s*\}/gm)) {
      asyncRequirements.add(requirement[1]);
    }
  }
  for (const { path, source } of bodies) {
    for (const property of source.matchAll(/^\s*public\s+var\s+(\w+)\s*:[^{=]+\{([^}]*)\}/gm)) {
      if (!asyncRequirements.has(property[1])) continue;
      if (/get\s+async/.test(property[2])) continue;
      throw new Error(`${path}: public var ${property[1]} satisfies a { get async } protocol requirement with a synchronous getter. Skip generates a suspend function for the requirement and a plain one here, so the Kotlin class does not implement it — spell the getter { get async { ... } }.`);
    }
  }
}

// XCTest re-exports Foundation on Apple platforms, so a test can name
// JSONEncoder or URLSession with no import and still compile — until Skip
// transpiles it and Kotlin cannot resolve the reference. The same applies to
// any transpiled source: name a Foundation type, import Foundation.
{
  const foundationTypes = /\b(JSONEncoder|JSONDecoder|JSONSerialization|URLSession|URLRequest|URLComponents|DateFormatter|ISO8601DateFormatter|NumberFormatter|UUID|Locale|Calendar|TimeZone|Bundle|NotificationCenter|UserDefaults)\b/;
  const transpiled = [
    "apps/vet-desktop/Sources", "apps/vet-desktop/Tests",
    "apps/customer-mobile/Sources", "apps/customer-mobile/Tests"
  ];
  for (const root of transpiled) {
    for (const path of await collectFiles(root, ".swift")) {
      // TimiNowCarPlay is Apple-only and never transpiled (see Package.swift).
      if (path.includes("/TimiNowCarPlay/")) continue;
      const source = await read(path);
      const named = source.match(foundationTypes);
      if (named && !/^import Foundation$/m.test(source)) {
        throw new Error(`${path}: names ${named[1]} without importing Foundation. XCTest and UIKit re-export it on Apple platforms, so this compiles natively and fails only once Skip transpiles it to Kotlin.`);
      }
    }
  }
}

// A type the app module names has to be public in the module that declares
// it. Xcode can hide this — the app target may see the sources directly — so
// it surfaces only in the SwiftPM build, and only once everything ahead of it
// compiles.
for (const [appRoot, libraryRoots] of [
  ["apps/customer-mobile/Sources/TimiNowApp",
   ["apps/customer-mobile/Sources/TimiNowUI", "apps/customer-mobile/Sources/TimiNowCore"]],
  ["apps/vet-desktop/Sources/TimiVetApp",
   ["apps/vet-desktop/Sources/TimiVetUI", "apps/vet-desktop/Sources/TimiVetCore"]]
]) {
  const declarations = new Map();
  for (const root of libraryRoots) {
    for (const path of await collectFiles(root, ".swift")) {
      const source = await read(path);
      for (const d of source.matchAll(/^\s*(public\s+)?(?:@\w+\s+)*(?:final\s+)?(?:struct|class|enum|actor)\s+(\w+)/gm)) {
        // A name declared twice (conditional variants) counts as public only
        // when every declaration of it is.
        const isPublic = Boolean(d[1]);
        declarations.set(d[2], declarations.has(d[2]) ? declarations.get(d[2]) && isPublic : isPublic);
      }
    }
  }
  for (const path of await collectFiles(appRoot, ".swift")) {
    const source = await read(path);
    for (const [name, isPublic] of declarations) {
      if (isPublic) continue;
      if (!new RegExp(`\\b${name}\\b`).test(source)) continue;
      throw new Error(`${path}: names ${name}, which its own module does not declare public. Every declaration of it has to be public or the SwiftPM build cannot see it across the module boundary.`);
    }
  }
}

// skipstone is a SwiftPM build plugin, and xcodebuild refuses to run one that
// was never trusted interactively. In CI that surfaces as "Validate plug-in
// skipstone in package skip" with no other explanation, so every xcodebuild
// invocation has to opt out of the prompt.
{
  const workflow = await read(".github/workflows/native-clients.yml");
  const invocations = workflow.split(/^\s*xcodebuild$/m).slice(1);
  for (const invocation of invocations) {
    const command = invocation.split(/\n\s*\n/)[0];
    const scheme = (command.match(/-scheme\s+(\S+)/) || [])[1] || "(unnamed)";
    if (!command.includes("-skipPackagePluginValidation")) {
      throw new Error(`.github/workflows/native-clients.yml: the ${scheme} build does not pass -skipPackagePluginValidation. xcodebuild will refuse to run the skipstone build plugin and fail with "Validate plug-in".`);
    }
  }
  if (!invocations.length) throw new Error(".github/workflows/native-clients.yml: no xcodebuild invocation found — the native apps are no longer being compiled.");
}

// A library product named after a target that an app product already owns the
// linkage of makes Xcode refuse the whole build. Only declare products the
// Xcode projects actually link.
for (const [manifestPath, projectPath] of [
  ["apps/customer-mobile/Package.swift", "apps/customer-mobile/Darwin/project.yml"],
  ["apps/vet-desktop/Package.swift", "apps/vet-desktop/Darwin/project.yml"]
]) {
  const manifest = await read(manifestPath);
  const project = await read(projectPath);
  const linked = new Set([...project.matchAll(/product:\s*(\w+)/g)].map((m) => m[1]));
  for (const product of manifest.matchAll(/\.library\(name:\s*"(\w+)"/g)) {
    if (!linked.has(product[1])) {
      throw new Error(`${manifestPath}: declares the library product ${product[1]}, which ${projectPath} never links. A product named after a target reached through another product makes Xcode refuse the build — drop it.`);
    }
  }
  for (const name of linked) {
    if (!manifest.includes(`.library(name: "${name}"`)) {
      throw new Error(`${projectPath}: links the product ${name}, which ${manifestPath} does not declare.`);
    }
  }
}

// The console stores credentials in the Keychain, so it declares a
// keychain-access-group, so macOS refuses to launch it signed ad-hoc. Building
// it with CODE_SIGNING_ALLOWED=NO produces a bundle that looks fine and then
// does nothing, which is why there is a script that signs it for real.
{
  const entitlements = await read("apps/vet-desktop/Darwin/TimiVet.entitlements");
  const builder = await read("scripts/build-mac-app.sh");
  const keychain = await read("apps/vet-desktop/Sources/TimiVetCore/KeychainStore.swift");
  // An explicit keychain group forces a provisioning profile listing that App
  // ID; without one macOS kills the process at exec. Only declare it if the
  // code actually sets kSecAttrAccessGroup — otherwise it costs a profile and
  // buys nothing.
  if (/^\s*<key>keychain-access-groups<\/key>/m.test(entitlements) && !keychain.includes("kSecAttrAccessGroup")) {
    throw new Error("apps/vet-desktop/Darwin/TimiVet.entitlements declares keychain-access-groups, but KeychainStore never sets kSecAttrAccessGroup. The entitlement only forces a provisioning profile requirement — macOS SIGKILLs the app without one.");
  }
  if (/^\s*<key>keychain-access-groups<\/key>/m.test(entitlements)) {
    // Comments are stripped first: the script explains this very hazard, and
    // matching its own explanation would fail the build forever.
    const executable = builder.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    if (/CODE_SIGNING_ALLOWED\s*=\s*NO/.test(executable)) {
      throw new Error("scripts/build-mac-app.sh disables code signing, but the console declares a keychain-access-group — the app would build and then refuse to launch.");
    }
    if (!builder.includes("-allowProvisioningUpdates")) {
      throw new Error("scripts/build-mac-app.sh must pass -allowProvisioningUpdates so Xcode can create the development profile the keychain-access-group needs.");
    }
  }
  // The macOS deployment of the credentials rule itself.
  const settings = await read("apps/vet-desktop/Sources/TimiVetCore/SettingsStore.swift");
  if (/bearerToken|sessionToken/i.test(settings)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetCore/SettingsStore.swift: credentials must stay in the Keychain, not the settings file.");
  }
}

// The console is deliberately Skip-free: it ships to macOS only, so transpiling
// it to Kotlin on every build produced something nothing consumes and cost
// minutes each time — including a local build that could wedge inside the
// plugin with no output at all. If an Android console is ever wanted, this
// guard is the place to reconsider it, not an import that quietly creeps back.
{
  // Comments stripped first: the manifest explains at length why Skip is gone,
  // and matching that explanation would fail the build forever. Same trap the
  // signing guard fell into.
  const manifest = (await read("apps/vet-desktop/Package.swift"))
    .split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  if (/skip/i.test(manifest)) {
    throw new Error("apps/vet-desktop/Package.swift names Skip again. The console is macOS-only — adding Skip back puts a Kotlin transpile in front of every build.");
  }
  for (const path of await collectFiles("apps/vet-desktop/Sources", ".swift")) {
    const source = await read(path);
    if (/^import Skip\w+/m.test(source) || /\bos\(Android\)/.test(source)) {
      throw new Error(`${path}: imports Skip or branches on Android, but the console has no Android build — the branch is unreachable and the import will not resolve.`);
    }
  }
}

// xcconfig comments are //, not #. A leading # is a preprocessor directive, so
// a shell-style comment does not read as a comment at all — it fails the build
// with "unsupported preprocessor directive", naming the first word of the
// comment as the directive.
for (const path of [
  "apps/vet-desktop/Darwin/TimiVet.xcconfig",
  "apps/customer-mobile/Darwin/TimiNow.xcconfig"
]) {
  const source = await read(path);
  source.split("\n").forEach((line, index) => {
    // The space matters: Xcode reads "# Optional" as the directive Optional.
    const directive = line.match(/^#\s*(\w+)/);
    if (directive && !["include", "if", "else", "elseif", "endif", "error", "warning"].includes(directive[1])) {
      throw new Error(`${path}:${index + 1}: "#${directive[1]}" is not an xcconfig directive. Comments here start with // — a leading # fails the build with "unsupported preprocessor directive".`);
    }
  });
}

// -sdk pins one SDK across every target a scheme builds. The customer app
// embeds a watchOS target, whose sources import WatchKit, so forcing
// iphonesimulator on the whole scheme fails with "no such module 'WatchKit'".
// -destination alone lets each target use the SDK it belongs to.
{
  const workflow = await read(".github/workflows/native-clients.yml");
  const script = await read("scripts/build-ios-app.sh");
  for (const [label, text] of [[".github/workflows/native-clients.yml", workflow], ["scripts/build-ios-app.sh", script]]) {
    if (/^\s*-sdk\s/m.test(text)) {
      throw new Error(`${label}: passes -sdk to xcodebuild. That pins one SDK across every target in the scheme, and the embedded watchOS target then compiles against the iOS SDK — use -destination alone.`);
    }
  }
}

// The Mapbox frameworks are binary, and a binary Swift module can only be read
// by a compiler at least as new as the one that built it. Enabling Mapbox in CI
// without first checking the runner's toolchain fails with "this SDK is not
// supported by the compiler" and a cascade of missing types — a failure that
// belongs to the runner image, not to the diff being tested.
{
  const workflow = await read(".github/workflows/native-clients.yml");
  const step = workflow.slice(workflow.indexOf("- name: Configure Mapbox downloads"));
  const configure = step.slice(0, step.indexOf("- name: Resolve Swift packages"));
  if (!/TIMI_MAPBOX=1/.test(configure)) {
    throw new Error(".github/workflows/native-clients.yml: the Mapbox step no longer sets TIMI_MAPBOX=1, so CI never compiles the Mapbox path at all.");
  }
  if (!/Apple Swift version/.test(configure)) {
    throw new Error(".github/workflows/native-clients.yml: the Mapbox step enables TIMI_MAPBOX=1 without checking the runner's Swift version. The Mapbox binaries need Swift 6.2 or newer; an older toolchain fails with \"failed to build module 'MapboxCoreMaps'\".");
  }
  if (!/DEVELOPER_DIR:\s*\$\{\{\s*env\.MAPBOX_DEVELOPER_DIR\s*\}\}/.test(workflow)) {
    throw new Error(".github/workflows/native-clients.yml: the iOS build does not use MAPBOX_DEVELOPER_DIR, so the toolchain the Mapbox step selected is never the one xcodebuild runs.");
  }
}

// Some of the navigation SDK's types are declared `@_spi(MapboxInternal)
// public`, which is not the same as public: a plain `import` leaves them out
// of scope, and the compiler says "cannot find X in scope" about a symbol that
// is plainly there in the SDK sources. The import has to carry the same SPI
// group.
{
  const spiSymbols = ["SystemSpeechSynthesizer"];
  for (const path of await collectFiles("apps/customer-mobile/Sources", ".swift")) {
    const source = await read(path);
    for (const symbol of spiSymbols) {
      if (!new RegExp(`\\b${symbol}\\b`).test(source)) continue;
      if (/@_spi\(MapboxInternal\)\s+import MapboxNavigationCore/.test(source)) continue;
      throw new Error(`${path}: names ${symbol}, which MapboxNavigationCore declares @_spi(MapboxInternal). Import it as "@_spi(MapboxInternal) import MapboxNavigationCore" or the symbol is not in scope.`);
    }
  }
}

// A @MainActor type can only be constructed from the main actor, so a factory
// that builds one has to be isolated too. Swift catches it — "call to main
// actor-isolated initializer in a synchronous nonisolated context" — but only
// once everything ahead of it has compiled, which for this package is minutes.
for (const path of await collectFiles("apps/customer-mobile/Sources", ".swift")) {
  const source = await read(path);
  const isolated = new Set(
    [...source.matchAll(/@MainActor\s+(?:public\s+|final\s+|internal\s+)*(?:class|struct|actor)\s+(\w+)/g)].map((m) => m[1])
  );
  if (!isolated.size) continue;
  for (const factory of source.matchAll(/(@MainActor\s+)?\b(?:public\s+|internal\s+)?enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, mainActor, name, body] = factory;
    if (mainActor) continue;
    const built = [...isolated].find((type) => new RegExp(`->\\s*${type}\\b`).test(body) && new RegExp(`\\b${type}\\s*\\(`).test(body));
    if (built) {
      throw new Error(`${path}: ${name} constructs ${built}, which is @MainActor, but ${name} is not. Annotate ${name} with @MainActor — a nonisolated factory cannot call a main-actor initializer.`);
    }
  }
}

// Getting the app onto a phone, by cable or through TestFlight, needs a real
// signature and a version pair. Each of these is a failure whose message names
// something other than its cause, so they are checked here instead.
{
  const project = await read("apps/customer-mobile/Darwin/project.yml");
  const info = await read("apps/customer-mobile/Darwin/Info.plist");
  const xcconfig = await read("apps/customer-mobile/Darwin/TimiNow.xcconfig");

  // A target setting outranks the xcconfig, so declaring it in both places
  // means the scripts' entitlements override is silently ignored and the
  // restricted CarPlay key stays in the build.
  if (/^\s*CODE_SIGN_ENTITLEMENTS\s*:/m.test(project)) {
    throw new Error("apps/customer-mobile/Darwin/project.yml sets CODE_SIGN_ENTITLEMENTS as a target setting, which outranks TimiNow.xcconfig. The device and TestFlight scripts override it through Local.xcconfig, and cannot while this is here.");
  }
  if (!/^CODE_SIGN_ENTITLEMENTS\s*=/m.test(xcconfig)) {
    throw new Error("apps/customer-mobile/Darwin/TimiNow.xcconfig no longer sets CODE_SIGN_ENTITLEMENTS, so the app builds with no entitlements at all.");
  }
  if (!/#include\?\s+"Local\.xcconfig"/.test(xcconfig)) {
    throw new Error("apps/customer-mobile/Darwin/TimiNow.xcconfig must include Local.xcconfig last — that is where the build scripts write the team and the entitlements override.");
  }

  // GENERATE_INFOPLIST_FILE is NO for this target, so nothing injects the
  // version keys. Without them devicectl refuses the install and App Store
  // Connect refuses the upload, neither of them mentioning Info.plist.
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString"]) {
    if (!info.includes(`<key>${key}</key>`)) {
      throw new Error(`apps/customer-mobile/Darwin/Info.plist has no ${key}. Installing on a device and uploading to TestFlight both fail without it, and neither error names the plist.`);
    }
  }
  for (const setting of ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION"]) {
    if (!new RegExp(`^\\s*${setting}\\s*:`, "m").test(project)) {
      throw new Error(`apps/customer-mobile/Darwin/project.yml does not set ${setting}, which Info.plist reads through $(${setting}). It would resolve to an empty string.`);
    }
  }

  // CODE_SIGNING_ALLOWED=NO is right for a compile check and produces a bundle
  // no device will run. These two scripts exist precisely to sign for real.
  for (const path of ["scripts/install-ios-device.sh", "scripts/upload-testflight.sh"]) {
    const script = await read(path);
    const executable = script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    if (/CODE_SIGNING_ALLOWED\s*=\s*NO/.test(executable)) {
      throw new Error(`${path} disables code signing. The bundle would build and then be refused by the device or by App Store Connect.`);
    }
    if (!script.includes("-allowProvisioningUpdates")) {
      throw new Error(`${path} must pass -allowProvisioningUpdates so Xcode can create the provisioning profile rather than failing with "requires a development certificate".`);
    }
  }
}

// App Store validation is stricter than a device install: the archive signs,
// installs, and runs, and then "xcodebuild -exportArchive" with destination
// upload rejects the bundle. Every rule below was learned from a rejected
// upload on 2026-08-25, and no device build or CI compile exercises any of
// them.
{
  const project = await read("apps/customer-mobile/Darwin/project.yml");
  const info = await read("apps/customer-mobile/Darwin/Info.plist");
  const xcconfig = await read("apps/customer-mobile/Darwin/TimiNow.xcconfig");

  // Skip.env sets MARKETING_VERSION = 0.1.0 for the Skip tooling, and
  // TimiNow.xcconfig includes it — an xcconfig outranks project.yml's
  // project-level settings, so unless the xcconfig restates the version, the
  // iPhone app archives as 0.1.0 while the watch companion (which has no
  // xcconfig) archives as project.yml's value, and App Store Connect rejects
  // the pair: "CFBundleShortVersionString Mismatch".
  const projectVersion = project.match(/^\s*MARKETING_VERSION:\s*"?([\w.]+)"?\s*$/m)?.[1];
  const xcconfigVersion = xcconfig.match(/^MARKETING_VERSION\s*=\s*(\S+)/m)?.[1];
  if (!xcconfigVersion) {
    throw new Error("apps/customer-mobile/Darwin/TimiNow.xcconfig does not set MARKETING_VERSION after including Skip.env, so Skip.env's 0.1.0 wins for the iPhone app while the watch app reads project.yml — App Store Connect rejects the version mismatch.");
  }
  if (projectVersion !== xcconfigVersion) {
    throw new Error(`MARKETING_VERSION disagrees: project.yml says ${projectVersion} (what the watch app gets) but TimiNow.xcconfig says ${xcconfigVersion} (what the iPhone app gets). App Store Connect rejects a watch app whose version differs from its container.`);
  }

  // A watch app with no icon passes every build and every device install,
  // then fails upload validation twice over: "Missing Icons" and a missing
  // CFBundleIconName (actool writes that key only when it compiles an icon).
  const watchIconContents = await read("apps/customer-mobile/Darwin/WatchAssets.xcassets/AppIcon.appiconset/Contents.json");
  if (!watchIconContents.includes('"platform" : "watchos"')) {
    throw new Error("WatchAssets.xcassets/AppIcon.appiconset is not a watchOS icon (Contents.json has no watchos platform entry). Upload validation reports Missing Icons for the watch app.");
  }
  await access(resolve(root, "apps/customer-mobile/Darwin/WatchAssets.xcassets/AppIcon.appiconset/icon-1024.png")).catch(() => {
    throw new Error("WatchAssets.xcassets/AppIcon.appiconset/icon-1024.png is missing — the Contents.json points at a file that is not there, and the watch app uploads iconless.");
  });
  const watchTarget = project.slice(project.indexOf("TimiNowWatch:"));
  if (!watchTarget.includes("WatchAssets.xcassets")) {
    throw new Error("project.yml's TimiNowWatch target does not list WatchAssets.xcassets in sources, so the watch icon catalog never compiles into the bundle.");
  }
  if (!/ASSETCATALOG_COMPILER_APPICON_NAME:\s*AppIcon/.test(watchTarget)) {
    throw new Error("project.yml's TimiNowWatch target does not set ASSETCATALOG_COMPILER_APPICON_NAME, so actool compiles the catalog without marking an app icon and CFBundleIconName is never written.");
  }

  // watchOS refuses portrait-only: a watch worn crown-left renders upside
  // down, so validation demands both portrait orientations.
  if (!/INFOPLIST_KEY_UISupportedInterfaceOrientations:.*UIInterfaceOrientationPortraitUpsideDown/.test(watchTarget)) {
    throw new Error("project.yml's TimiNowWatch orientations omit UIInterfaceOrientationPortraitUpsideDown. Upload validation rejects a portrait-only watch app.");
  }

  // The iPhone app is portrait-only by design (Info.plist), which is legal
  // for an iPhone-only app and illegal for one that also claims iPad:
  // TARGETED_DEVICE_FAMILY "1,2" obliges all four orientations or
  // UIRequiresFullScreen. Keep the family at 1 everywhere, or change the
  // orientation story deliberately in both files at once.
  const portraitOnly = info.includes("UIInterfaceOrientationPortrait") && !info.includes("UIInterfaceOrientationLandscapeLeft");
  if (portraitOnly && !info.includes("UIRequiresFullScreen")) {
    for (const [file, source, pattern] of [
      ["project.yml", project, /TARGETED_DEVICE_FAMILY:\s*"?1\s*,\s*2"?/],
      ["TimiNow.xcconfig", xcconfig, /^TARGETED_DEVICE_FAMILY\s*=\s*1\s*,\s*2/m]
    ]) {
      if (pattern.test(source)) {
        throw new Error(`apps/customer-mobile/Darwin/${file} claims iPad (TARGETED_DEVICE_FAMILY 1,2) while Info.plist is portrait-only without UIRequiresFullScreen. Upload validation rejects the bundle; keep the family at 1 or add the orientations deliberately.`);
      }
    }
  }

  // Belt for the braces above: the iPhone app's Info.plist is hand-written
  // (GENERATE_INFOPLIST_FILE = NO), so CFBundleIconName is spelled out there
  // rather than trusted to actool's merge.
  if (!info.includes("<key>CFBundleIconName</key>")) {
    throw new Error("apps/customer-mobile/Darwin/Info.plist has no CFBundleIconName. Upload validation requires it and a device install never checks.");
  }
}

// The Mapbox access token is optional exactly once, in AppStore, because it is
// absent until /api/config answers. Every UI declaration below that is a plain
// String, unwrapped at the one call site. Threading the optional deeper means
// handing it to Mapbox initializers that take a String — a build error that
// exists only on the Mapbox path, so nothing short of a device build with a
// downloads token ever sees it.
for (const path of await collectFiles("apps/customer-mobile/Sources/TimiNowUI", ".swift")) {
  const source = await read(path);
  const optional = source.match(/^\s*(?:public\s+|private\s+)?(?:var|let)\s+(mapToken|mapboxAccessToken)\s*:\s*String\?/m);
  if (optional) {
    throw new Error(`${path}: declares ${optional[1]} as String?. The optional belongs to AppStore alone — unwrap it at the call site with ?? "" and keep every UI declaration non-optional, or the Mapbox build fails on "value of optional type must be unwrapped".`);
  }
  const parameter = source.match(/\b(mapToken|mapboxAccessToken)\s*:\s*String\?[,)]/);
  if (parameter) {
    throw new Error(`${path}: takes ${parameter[1]} as String?. Same reason — the Mapbox initializers it reaches take a String.`);
  }
}

// A protocol with default implementations does not complain about a near-miss:
// the wrong signature satisfies nothing, the default runs, and the method is
// simply never called. didArriveAt returns Void in
// mapbox-navigation-ios v3.27.0; returning Bool cost us arrival detection with
// no build error and no run-time complaint.
{
  const path = "apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift";
  const source = await read(path);
  if (/didArriveAt\s+waypoint:\s*Waypoint\)\s*->/.test(source)) {
    throw new Error(`${path}: navigationViewController(_:didArriveAt:) returns a value. The SDK declares it returning Void, so this satisfies no protocol requirement, the default implementation runs, and arrival is never reported.`);
  }
  if (!/didArriveAt\s+waypoint:\s*Waypoint\)\s*\{/.test(source)) {
    throw new Error(`${path}: no longer implements navigationViewController(_:didArriveAt:), so arriving at the clinic records nothing.`);
  }
}

// `Color` has three reachable `opacity(_:)` members — its own, `View`'s, and
// `ShapeStyle`'s. Handed to a parameter that takes any ShapeStyle (stroke,
// fill, background), more than one fits, and the compiler reports "ambiguous
// use of 'opacity'". It only bites once the overload set is crowded, so it
// appears on the Mapbox build and not the fallback, in files with no Mapbox in
// them — which makes it look like anything but what it is. Color.faded(_:)
// returns a concrete Color and ends the argument.
//
// Scoped to the customer app: it is the one that carries Mapbox. The console
// has the same shape and no crowded overload set, so it is left alone rather
// than churned.
for (const path of await collectFiles("apps/customer-mobile/Sources", ".swift")) {
  const source = await read(path);
  const ambiguous = source.match(/\.(stroke|fill|background)\([^)\n]*?\.opacity\(/);
  if (ambiguous) {
    const line = source.slice(0, ambiguous.index).split("\n").length;
    throw new Error(`${path}:${line}: passes a Color's .opacity(...) to .${ambiguous[1]}(...), which takes any ShapeStyle. Use .faded(...) instead — it returns a concrete Color, so the call is not ambiguous.`);
  }
}

// A ternary of bare numeric literals handed to an overloaded SwiftUI modifier
// — scaleEffect, opacity, offset, frame, shadow, lineWidth — leaves the
// literal's type for the solver to pick, and several overloads accept it. The
// error is "ambiguous use of <that modifier>", it names a modifier nobody
// touched, and it only appears once the module's overload set is crowded
// enough, which is why the Mapbox build hits it and the fallback CI build does
// not. CGFloat(...) or Double(...) around the ternary settles it.
{
  const MODIFIERS = "scaleEffect|opacity|offset|frame|shadow|lineWidth|zoom|padding|blur|rotationEffect";
  const bare = new RegExp(`\\b(${MODIFIERS})\\(([^()]*?)\\?[^:()]*:\\s*-?\\d+(?:\\.\\d+)?\\s*[,)]`);
  for (const path of await collectFiles("apps/customer-mobile/Sources/TimiNowUI", ".swift")) {
    const source = await read(path);
    for (const [index, line] of source.split("\n").entries()) {
      // Only the argument itself matters; a conversion anywhere in it means the
      // literal already has a type.
      const stripped = line.replace(/\b(?:CGFloat|Double|Int|Float)\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "TYPED");
      const hit = stripped.match(bare);
      if (hit) {
        throw new Error(`${path}:${index + 1}: .${hit[1]}(...) is given a ternary of bare numeric literals. Wrap it in CGFloat(...) or Double(...) — untyped, several overloads accept it and the build fails with "ambiguous use of '${hit[1]}'".`);
      }
    }
  }
}

// With GENERATE_INFOPLIST_FILE off, the Info.plist is used exactly as written
// and nothing injects the identity keys. Missing CFBundleIdentifier, the build
// succeeds, produces a .app, and the install is refused with "not a valid
// bundle … Failed to get the identifier for the app to be installed" — a
// message that reads like a signing or Developer Mode problem and is neither.
for (const app of ["customer-mobile", "vet-desktop"]) {
  const xcconfigs = {
    "customer-mobile": "apps/customer-mobile/Darwin/TimiNow.xcconfig",
    "vet-desktop": "apps/vet-desktop/Darwin/TimiVet.xcconfig"
  };
  const xcconfig = await read(xcconfigs[app]);
  if (!/GENERATE_INFOPLIST_FILE\s*=\s*NO/.test(xcconfig)) continue;
  const path = `apps/${app}/Darwin/Info.plist`;
  const info = await read(path);
  for (const key of ["CFBundleIdentifier", "CFBundleExecutable", "CFBundlePackageType", "CFBundleName"]) {
    if (!info.includes(`<key>${key}</key>`)) {
      throw new Error(`${path} has no ${key}, and ${xcconfigs[app]} sets GENERATE_INFOPLIST_FILE = NO, so nothing supplies it. The app builds and then will not install.`);
    }
  }
}

// One bundle identifier, named in five places: the Xcode target, the launch in
// each of the three build scripts, and the watch app's companion key. xcodegen
// would otherwise derive it from bundleIdPrefix and the target name — giving a
// capital T — and the app then installs and cannot be launched by id, with the
// watch silently never pairing.
{
  const project = await read("apps/customer-mobile/Darwin/project.yml");
  const declared = project.match(/^\s*PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)\s*$/m);
  if (!declared) {
    throw new Error("apps/customer-mobile/Darwin/project.yml does not set PRODUCT_BUNDLE_IDENTIFIER for the app target, so xcodegen derives it from the target name and it stops matching everything else that names it.");
  }
  const bundleId = declared[1];
  for (const script of ["scripts/build-ios-app.sh", "scripts/install-ios-device.sh", "scripts/upload-testflight.sh"]) {
    const text = await read(script);
    const used = text.match(/^BUNDLE_ID="([^"]+)"/m);
    if (!used) throw new Error(`${script} no longer defines BUNDLE_ID.`);
    if (used[1] !== bundleId) {
      throw new Error(`${script} launches ${used[1]} but the app is built as ${bundleId}. It would install and then fail to start.`);
    }
  }
  const companion = project.match(/INFOPLIST_KEY_WKCompanionAppBundleIdentifier:\s*(\S+)/);
  if (companion && companion[1] !== bundleId) {
    throw new Error(`apps/customer-mobile/Darwin/project.yml: the watch app names ${companion[1]} as its companion, but the phone app is ${bundleId}. The watch would never pair.`);
  }
}

// The Worker answers a failure with { "error": { "code", "message" } } — a
// nested object. The client decoded `error` as a top-level string, so every
// error response failed to decode, the `try?` swallowed it, and the app showed
// a generic sentence instead. The Worker's actual reason never once reached a
// screen, which is why every failure in this app has been unreadable.
{
  const worker = await read("src/index.js");
  const nests = /return json\(\s*\{\s*error:\s*\{\s*code\s*,\s*message/.test(worker);
  const models = await read("apps/customer-mobile/Sources/TimiNowCore/Models.swift");
  const envelope = models.match(/struct APIErrorEnvelope[\s\S]*?\n\}/);
  if (!envelope) throw new Error("apps/customer-mobile/Sources/TimiNowCore/Models.swift no longer declares APIErrorEnvelope, so no server error can be read.");
  const nestsToo = /struct \w+: Codable[\s\S]*?var code/.test(envelope[0]) && /var error:\s*\w+\?/.test(envelope[0]);
  if (nests && !nestsToo) {
    throw new Error("src/index.js answers errors as { error: { code, message } }, but APIErrorEnvelope decodes them flat. Decoding fails on every error response and the real reason is replaced by a generic fallback.");
  }
}

// Sign-in is the difference between an app that works and one that shows a
// 401. These are the seams where it silently stops working: a gate that no
// longer gates, a token that is never handed to the gateway, a session that is
// never restored. None of them fail loudly — the app just asks for a password
// again, or stops asking and starts refusing.
{
  const auth = await read("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift");
  const root = await read("apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift");
  const app = await read("apps/customer-mobile/Sources/TimiNowApp/TimiNowApp.swift");
  const store = await read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift");

  if (!/store\.auth\.signInRequired\s*&&\s*!store\.auth\.isSignedIn/.test(root)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift no longer gates on sign-in, so the app reaches the Worker unauthenticated and every request comes back 401.");
  }
  if (!/await store\.auth\.start\(\)/.test(app)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowApp/TimiNowApp.swift no longer calls auth.start(), so a stored session is never restored and sign-in is demanded at every launch.");
  }
  if (!/gateway\.bearerToken = workerToken/.test(auth)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift no longer hands the minted token to the gateway. Signing in would appear to work and every API call would still be unauthenticated.");
  }
  if (!/keychain/.test(auth)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift no longer persists the credential in the Keychain — the session would not survive a relaunch.");
  }
  // A long-lived Clerk cookie in UserDefaults is a plist any backup can read.
  // Comments stripped first: the rule is about what the code does, and a
  // doc comment explaining why the credential is not in UserDefaults was
  // enough to trip it.
  const authCode = auth.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  if (/defaults\.set\([^)]*(clientCookie|workerToken)/.test(store) || /UserDefaults/.test(authCode)) {
    throw new Error("The Clerk credential must stay in the Keychain, not UserDefaults.");
  }
  if (!/looksLikeUnknownAccount/.test(auth)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift no longer turns an unknown identifier into sign-up. A first-time pet owner would be told their account was not found, with nothing to do about it.");
  }
}

// @Observable rewrites every stored property into a computed one backed by an
// init accessor, and those accessors may only refer to other stored
// properties. So `lazy` is rejected outright, and a default expression naming
// another property fails with "init accessor cannot refer to property" from a
// generated file with no line of yours in it. Both belong in init instead.
for (const path of await collectFiles("apps/customer-mobile/Sources", ".swift")) {
  const source = await read(path);
  if (!/@Observable/.test(source)) continue;
  const lazyStored = source.match(/^\s*(?:public\s+)?(?:private\(set\)\s+)?lazy\s+var\s+(\w+)/m);
  if (lazyStored) {
    throw new Error(`${path}: '${lazyStored[1]}' is lazy inside an @Observable type. The macro turns stored properties into computed ones, and lazy cannot be used on a computed property — assign it in init instead.`);
  }
}

// `#if canImport(M)` asks whether M is available. It does not import it. A
// file that guards on canImport and then names a type from M, without an
// `import M` anywhere, compiles fine while M is absent and fails the moment it
// is present — which is the reverse of what the guard was written to do, and
// it surfaces only on the machine that has the SDK.
for (const root of ["apps/customer-mobile/Sources", "apps/vet-desktop/Sources"]) {
  for (const path of await collectFiles(root, ".swift")) {
    const source = await read(path);
    for (const guard of source.matchAll(/canImport\((\w+)\)/g)) {
      const module = guard[1];
      // The import may carry an SPI group — see the @_spi check above.
      if (new RegExp(`^\\s*(?:@_spi\\(\\w+\\)\\s+)?import ${module}\\b`, "m").test(source)) continue;
      throw new Error(`${path}: guards on canImport(${module}) but never imports ${module}. canImport only tests availability — without the import, any type from that module is out of scope and the build fails wherever the module actually exists.`);
    }
  }
}

// A Mapbox `Map { }` closure is a MapContentBuilder, and SwiftUI's ForEach is
// not MapContent — the SDK ships ForEvery for exactly this. Verified against
// mapbox-maps-ios 11.26: ForEvery.swift says "similar to SwiftUI ForEach, but
// works with MapContent", and only ForEvery has the MapContent conformance.
{
  const path = "apps/customer-mobile/Sources/TimiNowUI/ClinicMapView.swift";
  const source = await read(path);
  const mapBuilder = source.match(/Map\(viewport:[^)]*\)\s*\{[\s\S]*?\n        \}/);
  if (mapBuilder && /\bForEach\(/.test(mapBuilder[0])) {
    throw new Error(`${path}: uses ForEach inside a Mapbox Map builder. That closure takes MapContent, which ForEach does not conform to — use ForEvery.`);
  }
}

// A dynamic library product has to be embedded in the bundle, or dyld cannot
// find it at launch — the app builds, signs, validates, installs, and then
// dies immediately with "Library not loaded: @rpath/...".
//
// Every app, not just the console. This check used to read vet-desktop alone,
// carrying a comment claiming the customer app was different because "Xcode
// embeds SwiftPM dynamic products into an iOS app itself". It does not. The
// customer app had the identical defect and crashed on launch the identical
// way, and the guard written for that exact bug was scoped past it.
for (const app of ["customer-mobile", "vet-desktop"]) {
  const manifest = await read(`apps/${app}/Package.swift`);
  const project = await read(`apps/${app}/Darwin/project.yml`);
  for (const product of manifest.matchAll(/\.library\(name:\s*"(\w+)",\s*type:\s*\.dynamic/g)) {
    // An embed of some other target — the watch app, say — does not embed this.
    const embedded = new RegExp(`product:\\s*${product[1]}[\\s\\S]{0,120}?embed:\\s*true`).test(project);
    if (!embedded) {
      throw new Error(`apps/${app}/Package.swift: ${product[1]} is a dynamic library that apps/${app}/Darwin/project.yml never embeds. dyld will not find it at launch — make it .static.`);
    }
  }
}

// A public type's protocol-requirement implementations must be public too:
// Swift rejects "method X must be declared public because it matches a
// requirement in public protocol Y". Internal types are unaffected, which is
// why this only looks at public ones — making a type public, as happened to
// WatchBridge, silently puts every one of its delegate methods in scope for
// this rule.
for (const root of ["apps/customer-mobile/Sources", "apps/customer-mobile/Watch", "apps/vet-desktop/Sources"]) {
  for (const path of await collectFiles(root, ".swift")) {
    const lines = (await read(path)).split("\n");
    lines.forEach((line, index) => {
      const declaration = line.match(/^public\s+(?:@\w+\s+)*(?:final\s+)?(?:class|struct|extension)\s+(\w+)([^{]*)\{/);
      if (!declaration || !(declaration[2] || "").includes("Delegate")) return;
      let depth = 1;
      for (let cursor = index + 1; cursor < lines.length && depth > 0; cursor += 1) {
        depth += (lines[cursor].match(/\{/g) || []).length - (lines[cursor].match(/\}/g) || []).length;
        const method = lines[cursor].match(/^\s*(?:nonisolated\s+)?(public\s+|private\s+|fileprivate\s+|internal\s+)?func\s+(\w+)/);
        if (method && !method[1]) {
          throw new Error(`${path}:${cursor + 1}: ${declaration[1]} is public and conforms to a delegate protocol, but ${method[2]} has no access level. Swift requires a public type's protocol-requirement implementations to be public — mark it public, or private if it is a helper.`);
        }
      }
    });
  }
}

// A stored-property default is dead the moment an explicit initializer assigns
// the same parameter over it. AppSettings declared
// `apiBaseUrl = TimiVetEnvironment.defaultAPIBaseURL` and then took
// `apiBaseUrl: String = ""` in its init, so `AppSettings()` — every first
// launch — produced a blank address. The console then reported "Could not read
// no Worker address/api/config", which reads as a Clerk or a DNS fault and is
// neither, with the correct default sitting two lines above in the same file.
{
  const path = "apps/vet-desktop/Sources/TimiVetCore/ClinicModels.swift";
  const source = await read(path);
  const body = source.match(/public struct AppSettings[^{]*\{([\s\S]*?)\n\}/);
  if (!body) throw new Error(`${path} no longer declares AppSettings.`);
  const stored = new Map();
  for (const match of body[1].matchAll(/^\s*public var (\w+):\s*[^=\n]+=\s*(.+?)\s*$/gm)) {
    stored.set(match[1], match[2]);
  }
  const init = body[1].match(/public init\(([\s\S]*?)\)\s*\{/);
  if (!init) throw new Error(`${path}: AppSettings no longer declares an explicit init.`);
  for (const match of init[1].matchAll(/(\w+):\s*[^=,]+=\s*("(?:[^"\\]|\\.)*"|[^,)]+?)\s*(?:,|$)/g)) {
    const declared = stored.get(match[1]);
    if (declared === undefined) continue;
    if (declared !== match[2].trim()) {
      throw new Error(`${path}: AppSettings.${match[1]} defaults to ${declared} as a property but to ${match[2].trim()} in init. The init wins, so the property default never applies — make them the same or drop one.`);
    }
  }
}

// Both Apple clients talk to Clerk's Frontend API as native clients
// (`_is_native=true`, client JWT in the Authorization header) rather than as
// browsers. It is not a preference: Clerk guards `/v1/client/sign_ups` with a
// Turnstile CAPTCHA that only a web page can render, so a web-mode sign-up is
// answered with `captcha_missing_token` and nobody without an account can ever
// make one. Each seam below is a way to have the query parameter and still not
// be a native client.
for (const path of [
  "apps/customer-mobile/Sources/TimiNowCore/AuthController.swift",
  "apps/vet-desktop/Sources/TimiVetCore/AuthController.swift"
]) {
  const source = await read(path);
  const seams = [
    [/URLQueryItem\(name: "_is_native", value: "true"\)/, 'never sends _is_native=true, so Clerk treats it as a browser and sign-up is rejected with captcha_missing_token.'],
    [/request\.setValue\(token, forHTTPHeaderField: "Authorization"\)/, 'never puts the Clerk device token in the Authorization header, so every native request arrives as a brand-new anonymous client.'],
    [/request\.httpShouldHandleCookies = !clerkNativeMode/, 'leaves the cookie jar on in native mode. Clerk refuses a request carrying both Origin and Authorization.'],
    [/if clerkNativeMode \{ absorbDeviceToken\(http\) \}\n\s*guard \(200\.\.<300\)/, 'absorbs the device token after the status check rather than before it. Clerk issues the client JWT on failure responses too, and the sign-up flow is reached only through the 422 that /sign_ins returns for an unknown address — the following request would go out unauthenticated.'],
    [/var clerkDeviceToken: String\?/, 'does not persist the device token, so the session cannot be resumed and sign-in greets the user at every launch.'],
    [/native_api_disabled/, 'does not recognise native_api_disabled, so an instance without the Native API toggle cannot fall back to the cookie path and sign-in breaks entirely.']
  ];
  for (const [pattern, complaint] of seams) {
    if (!pattern.test(source)) throw new Error(`${path} ${complaint}`);
  }
}

// Clerk reports two different things about an incomplete sign-up:
// `unverified_fields`, which is just the code about to be sent, and
// `missing_fields`, which is what the instance requires and this app never
// asks for. Reading only the status leads a new customer through a code that
// is accepted and then leaves them with no account and "another step" as the
// explanation.
{
  const path = "apps/customer-mobile/Sources/TimiNowCore/AuthController.swift";
  const source = await read(path);
  if (!/var missingFields: \[String\]\?/.test(source)) {
    throw new Error(`${path}: ClerkWireSignUp does not decode missing_fields, so nothing can tell a new customer what the sign-up still needs.`);
  }
  if (!/signUpBlocker\(signUp\.missingFields \?\? \[\]\)/.test(source)) {
    throw new Error(`${path}: the sign-up path does not check missing_fields before sending a verification code. On an instance that requires a password, the code arrives, is accepted, and the account still does not exist.`);
  }
}

// /api/config is where the Clerk publishable key comes from, so a client that
// demands a session before it will send the request has locked itself out: no
// config, no Clerk host, no sign-in, no session, no config. The console
// reported it as "Could not read https://providers.timinow.pet/api/config —
// Sign in to Tími before contacting a production Worker", which names the
// Worker and Clerk and blames neither correctly — the request was never sent.
{
  const path = "apps/vet-desktop/Sources/TimiVetCore/ClinicAPIClient.swift";
  const source = await read(path);
  if (!/isPublic\(url\)/.test(source) || !/api\/config/.test(source.slice(source.indexOf("isPublic")))) {
    throw new Error(`${path} throws signInRequired for every unauthenticated request, /api/config included. Sign-in can then never start, because the Clerk key lives behind exactly that request.`);
  }
}

// A pet profile you can create and never correct is a bug report waiting to
// happen: the editor was hardcoded to "Add a pet", so a typo in a name was
// permanent and a pet that died stayed on the list forever.
{
  const store = await read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift");
  if (!/func deletePet\(/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift has no deletePet, so a pet profile can be added and never removed.");
  }
  // selectedPet, the draft and the launch path all index pets[0]; an empty
  // list is a crash on next open, not an empty screen.
  if (!/pets\.first \?\? Self\.placeholderPet/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift: selectedPet falls back to pets[0], which traps on an empty list. An account with no pets is an ordinary state.");
  }
  // No sample animal on a fresh install. A seeded pet is how a stranger's
  // "Otis" ended up greeting a brand-new customer on a shared device.
  if (/DemoData\.pet/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift seeds a demo pet. A new account must start with none.");
  }
  if (!/func forgetAccountData\(\)/.test(store) || !/timi\.accountId/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift does not scope device-local data to an account. Pets, history and contact details live in UserDefaults, so signing in as somebody else shows them the previous person's animal.");
  }
  const auth = await read("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift");
  if (!/onSignedOut\(\)/.test(auth)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift no longer tells the store to forget account data on sign-out.");
  }
  const view = await read("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift");
  if (!/var editing: PetProfile\?/.test(view)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift: PetEditor does not take a pet to edit, so every save creates a new profile.");
  }
  if (!/id: existing\?\.id \?\? UUID\(\)\.uuidString/.test(view)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift: PetEditor saves without carrying the edited pet's id, so editing adds a duplicate instead of updating.");
  }
}

// Sign-up collects the name, email and phone the intake form asks for, and
// hands them to the store. Without the handover the account knows who you are
// and the care request still asks, which is the complaint that started this.
{
  const path = "apps/customer-mobile/Sources/TimiNowCore/AuthController.swift";
  const source = await read(path);
  for (const [pattern, complaint] of [
    [/case profile/, "has no profile stage, so sign-up sends one address and Clerk never gets the phone number it requires."],
    [/\("phone_number", phone\)/, "creates the sign-up without a phone number."],
    [/\("first_name", first\)/, "creates the sign-up without a name, so clinics have nobody to expect."],
    [/onProfileResolved\(profile\)/, "never hands the profile back, so the intake form keeps asking for details the account already holds."],
    [/hasPrefix\("reset_password"\)/, "offers Clerk's password-reset strategies as sign-in choices. A phone-only account then shows a two-item picker — \"Text me a code\" and \"Reset password by text\" — instead of going straight to the code screen."],
    [/unverifiedFields/, "does not read unverified_fields, so a sign-up needing a second code stops with \"another step\" instead of sending it."]
  ]) {
    if (!pattern.test(source)) throw new Error(`${path} ${complaint}`);
  }
  const store = await read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift");
  if (!/auth\.onProfileResolved = /.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift never subscribes to onProfileResolved, so nothing sign-in learns reaches the intake form.");
  }
}

// Every closed set the Worker validates, checked against what the phone app
// actually sends. This is the class of bug that made the app unusable rather
// than merely broken: `startedWhen` was a free-text field — placeholder
// "Example: around 7 AM today" — and the Worker takes one of five tokens, so
// no care request the app has ever sent could be accepted. The web form
// (public/index.html) had the right dropdown all along, which is exactly why
// nobody caught it: the surface being exercised was not the surface shipping.
{
  const worker = await read("src/index.js");
  const catalog = await read("src/catalog.js");
  const setFrom = (source, name) => {
    const match = source.match(new RegExp(`${name} = new Set\\(\\[([^\\]]*)\\]`));
    if (!match) throw new Error(`Could not read ${name} from the Worker.`);
    return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]));
  };
  const rawValues = (source, enumName) => {
    const body = source.match(new RegExp(`enum ${enumName}[^{]*\\{([\\s\\S]*?)\\n\\}`));
    if (!body) throw new Error(`Could not read ${enumName} from the Swift sources.`);
    const values = new Set();
    for (const line of body[1].split("\n")) {
      const explicit = line.match(/^\s*case\s+(\w+)\s*=\s*"([^"]+)"/);
      if (explicit) { values.add(explicit[2]); continue; }
      const implicit = line.match(/^\s*case\s+([\w,\s]+)$/);
      // `case dog, cat, rabbit` — a bare case's raw value is its own name.
      if (implicit) for (const name of implicit[1].split(",")) {
        const trimmed = name.trim();
        if (trimmed) values.add(trimmed);
      }
    }
    return values;
  };
  const models = await read("apps/customer-mobile/Sources/TimiNowCore/Models.swift");
  const validator = await read("apps/customer-mobile/Sources/TimiNowCore/ConcernValidator.swift");
  const intake = await read("apps/customer-mobile/Sources/TimiNowUI/IntakeFlowView.swift");

  const symptomList = intake.match(/let symptoms = \[([\s\S]*?)\n\s*\]/);
  if (!symptomList) throw new Error("apps/customer-mobile/Sources/TimiNowUI/IntakeFlowView.swift no longer declares the symptom option list.");
  const symptomKeys = new Set([...symptomList[1].matchAll(/\("([a-z_]+)",/g)].map((hit) => hit[1]));

  const comparisons = [
    ["startedWhen", rawValues(validator, "ConcernOnset"), setFrom(worker, "VALID_ONSETS"), "src/index.js VALID_ONSETS", "ConcernOnset"],
    ["symptoms", symptomKeys, setFrom(worker, "VALID_SYMPTOMS"), "src/index.js VALID_SYMPTOMS", "IntakeFlowView's symptom list"],
    ["pet.species", rawValues(models, "PetSpecies"), setFrom(catalog, "VALID_SPECIES"), "src/catalog.js VALID_SPECIES", "PetSpecies"],
    ["urgency", rawValues(models, "CareUrgency"), setFrom(catalog, "VALID_URGENCY"), "src/catalog.js VALID_URGENCY", "CareUrgency"]
  ];
  for (const [field, sent, accepted, workerName, swiftName] of comparisons) {
    const rejected = [...sent].filter((value) => !accepted.has(value));
    if (rejected.length) {
      throw new Error(`${swiftName} can send ${field} = ${rejected.join(", ")}, which ${workerName} does not accept. Every care request choosing one is refused with 422 VALIDATION_FAILED on the last screen of the flow.`);
    }
  }
  // Onsets are the one set that must match in both directions: a token the
  // Worker takes and the app never offers is a choice a customer cannot make.
  const onsets = rawValues(validator, "ConcernOnset");
  const missing = [...setFrom(worker, "VALID_ONSETS")].filter((value) => !onsets.has(value));
  if (missing.length) {
    throw new Error(`ConcernOnset does not offer ${missing.join(", ")}, which src/index.js accepts. Nobody can choose them.`);
  }
  // And it has to be a choice, not typed.
  if (/TextField\([^)]*text: \$store\.draft\.startedWhen/.test(intake)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/IntakeFlowView.swift binds startedWhen to a TextField. Free text cannot match the Worker's five tokens, so every request is rejected.");
  }

  // The two closed sets the tracker screen posts into, which live as bare
  // string literals scattered across the UI rather than as a type.
  const literalsIn = (sources, pattern) => {
    const found = new Set();
    for (const source of sources) for (const hit of source.matchAll(pattern)) found.add(hit[1]);
    return found;
  };
  const uiSources = [];
  for (const path of await collectFiles("apps/customer-mobile/Sources/TimiNowUI", ".swift")) {
    uiSources.push(await read(path));
  }
  const setLiteral = (name) => {
    const match = worker.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
    return match ? new Set([...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1])) : null;
  };
  // These are declared inline in their handlers, so read them by their message.
  const milestones = new Set(["arrived", "triaged", "seen", "departed", "staff_wait_quote"]);
  const customerStatuses = new Set(["cancelled", "en_route", "arrived"]);
  if (!worker.includes('new Set(["arrived", "triaged", "seen", "departed", "staff_wait_quote"])')) {
    throw new Error("src/index.js no longer declares the observation milestone set this check compares against — update scripts/validate-native.mjs alongside it.");
  }
  if (!worker.includes('new Set(["cancelled", "en_route", "arrived"])')) {
    throw new Error("src/index.js no longer declares the customer intake-status set this check compares against — update scripts/validate-native.mjs alongside it.");
  }
  void setLiteral;
  for (const [label, sent, accepted, endpoint] of [
    ["milestone", literalsIn(uiSources, /store\.record\("([a-z_]+)"\)/g), milestones, "POST /api/observations"],
    ["status", literalsIn(uiSources, /updateIntake\(status: "([a-z_]+)"\)/g), customerStatuses, "POST /api/intakes/{id}/status"]
  ]) {
    const rejected = [...sent].filter((value) => !accepted.has(value));
    if (rejected.length) {
      throw new Error(`The tracker screen posts ${label} = ${rejected.join(", ")} to ${endpoint}, which the Worker rejects with 422.`);
    }
  }
}

// Query strings drift the same way request bodies do, and just as silently.
// The phone app asked /api/locations for `latitude`, `longitude` and
// `radiusMiles`; handleLocationSearch reads `lat`, `lng` and `radius`. It got
// a 200 every time, with no coordinates — so no distance on any clinic, no
// radius filter, and the list sorted alphabetically by name. The app has never
// once shown the nearest hospital, and nothing anywhere said so.
{
  const worker = await read("src/index.js");
  const handler = worker.match(/async function handleLocationSearch[\s\S]*?\n\}/);
  if (!handler) throw new Error("src/index.js no longer declares handleLocationSearch.");
  const understood = new Set([...handler[0].matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((hit) => hit[1]));
  const client = await read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift");
  const call = client.match(/public func locations\([\s\S]*?\n    \}/);
  if (!call) throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift no longer declares locations(latitude:longitude:species:...).");
  const sent = [...call[0].matchAll(/URLQueryItem\(name: "([^"]+)"/g)].map((hit) => hit[1]);
  const ignored = sent.filter((name) => !understood.has(name));
  if (ignored.length) {
    throw new Error(`apps/customer-mobile/Sources/TimiNowCore/APIClient.swift sends /api/locations?${ignored.join("&")}, which handleLocationSearch never reads. The request succeeds and the parameters are dropped — no distances, no radius, alphabetical order.`);
  }
  for (const required of ["lat", "lng"]) {
    if (!sent.includes(required)) {
      throw new Error(`apps/customer-mobile/Sources/TimiNowCore/APIClient.swift does not send ${required} to /api/locations, so the Worker cannot sort clinics by distance.`);
    }
  }
}

// "Do not wait for an app response", and nothing to press. The notice told
// somebody whose animal may be dying to get to an emergency hospital, on a
// screen that knew where they were and which hospitals take emergencies.
{
  const components = await read("apps/customer-mobile/Sources/TimiNowUI/Components.swift");
  if (!/Button \{ Task \{ await store\.findEmergencyCare\(\) \} \}/.test(components)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/Components.swift: SafetyBanner no longer offers the emergency-care action, so the notice is advice with nothing to act on.");
  }
  const store = await read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift");
  if (!/gateway\.emergencyPlaces\(/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift no longer asks for emergency places, so the button has nothing to show.");
  }
  const client = await read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift");
  // The Tími network is not the answer to "where is the nearest emergency
  // hospital". /api/emergency-nearby merges map data; /api/locations does not.
  if (!/api\/emergency-nearby/.test(client)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift asks /api/locations for emergency care, which returns only enrolled providers. In a city with three partners that is a list of three, and the nearest real emergency hospital is not on it.");
  }
  const worker = await read("src/index.js");
  if (!/findEmergencyVeterinaryPlaces\(/.test(worker)) {
    throw new Error("src/index.js no longer merges map data into /api/emergency-nearby, so the list is the Tími network again.");
  }
  if (!/notice:/.test(worker.slice(worker.indexOf("handleEmergencyNearby")))) {
    throw new Error("src/index.js serves emergency places without the notice saying they are unverified map listings. A POI listing presented as a triaged recommendation is the worst kind of wrong.");
  }
  // The root mounts the sheet, not each banner: the button is on three
  // screens and a list that disappears with the screen under it is worse
  // than not offering one.
  const root = await read("apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift");
  if (!/sheet\(isPresented: \$store\.showEmergencyList\)/.test(root)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift does not present the emergency list, so the button loads results nothing shows.");
  }
}

// Text entry in the app's own hand. `.roundedBorder` and a 1pt hairline at 18%
// ink are the defaults a form gets when nobody styles it, and next to a coral
// button with a 2pt border and a five-point drop they read as another app.
for (const path of [
  "apps/customer-mobile/Sources/TimiNowUI/SignInView.swift",
  "apps/customer-mobile/Sources/TimiNowUI/IntakeFlowView.swift"
]) {
  const source = await read(path);
  if (/textFieldStyle\(\.roundedBorder\)/.test(source)) {
    throw new Error(`${path} uses .roundedBorder — the system's grey hairline — on a screen built from 2pt ink borders and hard offset shadows. Use .timiField().`);
  }
  if (/RoundedRectangle\(cornerRadius: 15\)\.stroke\(TimiColor\.ink\.faded\(0\.18\)\)/.test(source)) {
    throw new Error(`${path} still draws a hairline field border by hand. Use .timiField() so every field matches.`);
  }
}

// The terms version a client sends must be the one the Worker accepts. It
// rejects anything else outright, so a bump applied in one place and not the
// other is a 422 on the last screen of the flow with nothing pointing at the
// notice that changed. The string used to be a literal in eight files.
{
  const catalog = await read("src/catalog.js");
  const declared = catalog.match(/export const LEGAL_VERSION = "([^"]+)"/);
  if (!declared) throw new Error("src/catalog.js no longer declares LEGAL_VERSION.");
  const client = await read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift");
  const sent = client.match(/enum TimiLegal \{[\s\S]*?static let version = "([^"]+)"/);
  if (!sent) throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift no longer declares TimiLegal.version.");
  if (sent[1] !== declared[1]) {
    throw new Error(`The phone app accepts terms version ${sent[1]}; the Worker accepts ${declared[1]}. Every care request is refused with 422 VALIDATION_FAILED.`);
  }
  // And nowhere else may carry its own copy.
  for (const path of ["apps/customer-mobile/Sources/TimiNowCore/APIClient.swift", "public/app.js", "src/index.js"]) {
    const source = await read(path);
    const strays = [...source.matchAll(/legalVersion: "(\d{4}-\d{2}-\d{2})"/g)].map((hit) => hit[1]);
    if (strays.length) {
      throw new Error(`${path} hardcodes legalVersion ${strays.join(", ")}. Read it from LEGAL_VERSION (or /api/config) so it cannot drift from the Worker that validates it.`);
    }
  }
}

// Which credential staffs a provider is an operator's field, and the two Sets
// that police it live in different Workers.
{
  const catalog = await read("src/catalog.js");
  const admin = await read("apps/admin-console/src/index.js");
  const values = (source) => {
    const match = source.match(/VALID_STAFFING = new Set\(\[([^\]]*)\]/);
    if (!match) return null;
    return [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]).sort().join(",");
  };
  const expected = values(catalog);
  const actual = values(admin);
  if (!expected) throw new Error("src/catalog.js no longer declares VALID_STAFFING.");
  if (!actual) throw new Error("apps/admin-console/src/index.js no longer declares VALID_STAFFING, so any string could be stored as a staffing level.");
  if (expected !== actual) {
    throw new Error(`apps/admin-console/src/index.js accepts staffing levels [${actual}] but src/catalog.js recognises [${expected}]. A level the customer Worker does not know reads as veterinarian-staffed, which is the wrong direction to be wrong in.`);
  }
  // The notice is composed once, server-side, so it cannot be reworded per
  // screen. A client that builds its own would drift from the legal text.
  const worker = await read("src/index.js");
  if (!/staffingNotice:/.test(worker)) {
    throw new Error("src/index.js no longer composes staffingNotice, so each client would have to word the scope-of-practice notice itself.");
  }
  // Both places somebody meets a clinic: the offer they choose between, and
  // the one they were confirmed with. Counted rather than merely present,
  // because dropping one leaves the other matching.
  for (const [path, required] of [
    ["apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift", 2],
    ["apps/customer-mobile/Sources/TimiNowUI/Components.swift", 1]
  ]) {
    const source = await read(path);
    const shown = [...source.matchAll(/StaffingNotice\(notice:/g)].length;
    if (shown < required) {
      throw new Error(`${path} shows the staffing notice in ${shown} of ${required} places. Wherever it is missing, a technician-staffed provider is indistinguishable from a veterinarian-staffed one at the moment somebody chooses.`);
    }
  }
}

// Cancelling is not failing. SwiftUI cancels the search screen's polling task
// when that screen goes away, which cancels the request in flight; URLSession
// reports it as an error whose description is the single word "cancelled", so
// pressing Cancel put "Could not reach …/api/searches/search_7af97a9e:
// cancelled" on screen as though something had broken.
{
  const client = await read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift");
  if (!/if Task\.isCancelled \{ throw CancellationError\(\) \}/.test(client)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift reports a cancelled request as a transport failure. Pressing Cancel then shows an error toast.");
  }
  const store = await read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift");
  const reportBody = store.match(/func report\(_ error: Error\) \{[\s\S]*?\n    \}/);
  if (!reportBody) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift no longer has report(_:), so a cancelled poll surfaces as a failure.");
  }
  if (!/error is CancellationError/.test(reportBody[0])) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift: report(_:) no longer drops cancellations, which is the only reason it exists.");
  }
  // Nothing outside report(_:) may turn a caught error into screen text: a
  // catch that writes errorMessage directly is both a cancellation toast and
  // a raw diagnostic — a route, a status and a record id — in front of a
  // customer.
  const raw = [...store.matchAll(/errorMessage = Self\.describe\(error\)/g)].length
    + [...store.matchAll(/errorMessage = error\.(message|localizedDescription)/g)].length;
  if (raw !== 0) {
    throw new Error(`apps/customer-mobile/Sources/TimiNowCore/AppStore.swift renders a caught error directly in ${raw} places. Everything goes through report(_:), which shows a sentence and sends the detail to the Worker.`);
  }
  if (!/ErrorPresenter\.present\(error\)/.test(store) || !/gateway\.reportFailure\(report\)/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift: report(_:) must present a public sentence and send the diagnostics to /api/client-errors, not put the diagnostics on screen.");
  }
}

// Optional medical context is optional the whole way down: never required to
// make a request, and never presented as anything but what the owner typed.
{
  const worker = await read("src/index.js");
  if (!/cleanString\(pet\.medications, 500\)/.test(worker) || !/cleanString\(pet\.allergies, 500\)/.test(worker)) {
    throw new Error("src/index.js no longer reads pet.medications and pet.allergies, so anything an owner records is dropped before it reaches a clinic.");
  }
  const errorsBlock = worker.slice(worker.indexOf("function validateIntake"), worker.indexOf("clinicConcernSummary ="));
  if (/errors\.push\([^)]*(medication|allerg)/i.test(errorsBlock)) {
    throw new Error("src/index.js validates medications or allergies as required. They are optional, and a care request must never depend on them.");
  }
  const legal = await read("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift");
  for (const [needle, what] of [
    ["veterinary technician", "the scope-of-practice notice for technician-staffed providers"],
    ["Medications and allergies you record", "the notice covering optional medical information"]
  ]) {
    if (!legal.includes(needle)) {
      throw new Error(`apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift is missing ${what}. Both are shipped behaviour and both need a notice.`);
    }
  }
  if (!legal.includes("Finding emergency hospitals")) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift is missing the notice covering emergency listings taken from third-party map data. Most of that list is not a Tími provider and none of it is verified.");
  }
  const web = await read("public/index.html");
  for (const needle of ["veterinary technician", "Medications and allergies you record", "medications or allergies you choose to record", "Finding emergency hospitals"]) {
    if (!web.includes(needle)) {
      throw new Error(`public/index.html is missing the legal text for "${needle}". The web and the phone must carry the same notices.`);
    }
  }
}

// A network blip at launch is not a sign-out. `catch { signOutLocally() }`
// treated "Clerk says this session is gone" and "the phone had no network for
// a second while the app opened" as the same thing — and signOutLocally
// deletes the Keychain item, so one blip signed somebody out permanently and,
// once the store began clearing account data on sign-out, took their pets and
// their history with it.
for (const [path, marker] of [
  ["apps/customer-mobile/Sources/TimiNowCore/AuthController.swift", "isCredentialRejected"],
  ["apps/vet-desktop/Sources/TimiVetCore/AuthController.swift", "isCredentialRejected"]
]) {
  const source = await read(path);
  if (!source.includes(marker) || !/func resumeWithoutChecking\(\)/.test(source)) {
    throw new Error(`${path} signs out on any failure while restoring a session. Only Clerk rejecting the credential is a sign-out; a timeout or a 5xx says nothing about the account, and the Keychain item is deleted either way.`);
  }
  // The restore path must not have a bare catch-all that reaches signOutLocally.
  const restore = source.slice(source.indexOf("let client = try await getClient()"));
  const firstCatchAll = restore.indexOf("} catch {");
  const body = restore.slice(firstCatchAll, firstCatchAll + 140);
  if (firstCatchAll !== -1 && /signOutLocally\(\)/.test(body)) {
    throw new Error(`${path}: the catch-all while restoring a session still calls signOutLocally(). That is the blip-signs-you-out bug.`);
  }
}

// The console paints a light palette by hand; AppKit's own controls follow the
// system appearance. On a Mac in dark mode that put dark text boxes inside
// light cards with their labels black on black, and nothing in the decision
// workspace could be read. The phone app pins itself light the same way.
{
  const delegate = await read("apps/vet-desktop/Sources/TimiVetApp/AppDelegate.swift");
  if (!/NSApp\.appearance = NSAppearance\(named: \.aqua\)/.test(delegate)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetApp/AppDelegate.swift does not pin the console to the light appearance. Every system control in the workspace renders dark against hand-painted light cards.");
  }
  for (const path of [
    "apps/vet-desktop/Sources/TimiVetApp/TimiVetApp.swift",
    "apps/vet-desktop/Sources/TimiVetUI/FloatingPanel.swift"
  ]) {
    const source = await read(path);
    if (!/preferredColorScheme\(\.light\)/.test(source)) {
      throw new Error(`${path} hosts a SwiftUI hierarchy in an AppKit window without pinning its colour scheme, so it follows the system into dark mode on its own.`);
    }
  }
}

// A queue alert has to lead to an answer. It led to "Open decision workspace":
// find the window, read four number fields, press a button — for what is
// almost always "yes, usual window" or "no, we're full".
{
  const store = await read("apps/vet-desktop/Sources/TimiVetCore/ClinicStore.swift");
  if (!/func answer\(_ request: ClinicRequest, decline: Bool\)/.test(store)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetCore/ClinicStore.swift has no one-press answer, so every response has to go through the decision workspace.");
  }
  for (const path of [
    "apps/vet-desktop/Sources/TimiVetUI/MiniConsoleView.swift",
    "apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift"
  ]) {
    const source = await read(path);
    if (!/store\.answer\(request, decline: false\)/.test(source) || !/store\.answer\(request, decline: true\)/.test(source)) {
      throw new Error(`${path} does not offer accept and decline on the request itself. The floating panel raising an alert whose only action is "open another window" is what this replaced.`);
    }
  }
  const alerts = await read("apps/vet-desktop/Sources/TimiVetUI/AlertCenter.swift");
  const alertCode = alerts.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  if (/NSSound\.beep\(\)/.test(alertCode)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetUI/AlertCenter.swift uses NSSound.beep(), which follows the separate Alert Volume slider and is routinely silent. Play a named sound through normal output.");
  }
  if (!/func playAlert\(emergency: Bool\)/.test(alerts) || !/private var alertSound: NSSound\?/.test(alerts)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetUI/AlertCenter.swift must hold the NSSound while it plays — one released mid-sound simply stops, which is its own silent-alert bug.");
  }
}

// One offer on screen with no sign that more are coming reads as the final
// answer, and waiting for a second that may never arrive is the delay this
// app exists to remove.
{
  const offers = await read("apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift");
  if (!/var stillCollecting: Bool/.test(offers) || !/Still asking/.test(offers)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift does not say whether more clinics are still being asked, so the first offer looks like the last one.");
  }
}

// A Clerk session token lives about a minute. Two callers out of seven
// refreshed it, so anything done more than sixty seconds after signing in
// went out with a dead token and came back 401 AUTHENTICATION_REQUIRED —
// which reads as being signed out, and was not.
{
  const client = await read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift");
  if (!/weak var tokenProvider: TimiSessionTokenProviding\?/.test(client)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift has no token provider, so every caller has to remember to refresh — and five of seven did not.");
  }
  if (!/tokenProvider\.ensureFreshToken\(\)/.test(client)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift does not mint a token per request. A token minted at sign-in is dead a minute later.");
  }
  if (!/forceRefreshToken\(\)/.test(client) || !/http\.statusCode == 401, !retried/.test(client)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift does not retry once on a 401 with a freshly minted token, so a token that expired in flight signs somebody out.");
  }
  const store = await read("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift");
  if (!/gateway\.tokenProvider = self\.auth/.test(store)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AppStore.swift never gives the gateway a token provider, so it falls back to whatever token was last set by hand.");
  }
}

// Diagnostics are for operators. "Sign in is required to continue. (401
// [AUTHENTICATION_REQUIRED] from /api/intakes/intake_be49b8c2…/status)" names
// an internal route and a record id, tells somebody to do what they have
// already done, and was not even true.
{
  const presenter = await read("apps/customer-mobile/Sources/TimiNowCore/ErrorPresenter.swift");
  if (!/static let vague/.test(presenter) || !/func diagnostics\(/.test(presenter)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/ErrorPresenter.swift must separate what a person is shown from what an operator is sent.");
  }
  const auth = await read("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift");
  if (/errorMessage = error\.message/.test(auth)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift renders TimiAPIError.message directly, which appends \"(422 [code] from /v1/client/…)\" to every sign-in error.");
  }
  const worker = await read("src/index.js");
  if (!/path === "\/api\/client-errors"/.test(worker) || !/function recordClientError/.test(worker)) {
    throw new Error("src/index.js has no /api/client-errors ingest, so the detail the apps stopped showing has nowhere to go.");
  }
  const adminWorker = await read("apps/admin-console/src/index.js");
  if (!/handleClientErrors/.test(adminWorker)) {
    throw new Error("apps/admin-console/src/index.js does not serve client errors, so nothing an app reports can be read.");
  }
  const adminApp = await read("apps/admin-console/public/app.js");
  if (!/loadClientErrors/.test(adminApp)) {
    throw new Error("apps/admin-console/public/app.js has no client-errors screen, so a customer reading out a reference has nowhere to be looked up.");
  }
}

// The pet sheet is the one screen a customer reaches from a coral button with
// a 2pt ink border, so a grouped system Form makes the join obvious.
{
  const support = await read("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift");
  const editor = support.slice(support.indexOf("struct PetEditor: View {"), support.indexOf("struct ActivityView: View {"));
  if (/\bForm\s*\{/.test(editor) || /NavigationStack/.test(editor)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift: PetEditor is back to a system Form. Every other screen in this app is painted by hand.");
  }
  if (!/timiField\(\)/.test(editor)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift: PetEditor's fields are not Tími fields.");
  }
}

// A practice with one person at the desk and a phone already ringing has a
// real reason to say no to an automated call. The columns for it shipped with
// the voice gateway, carrying a note that a console was expected to expose
// them; none did, so every clinic ran on the default.
{
  const worker = await read("src/index.js");
  if (!/path === "\/api\/clinic\/call-preferences"/.test(worker)) {
    throw new Error("src/index.js exposes no calling preferences, so a clinic cannot turn the phone call off.");
  }
  const client = await read("apps/vet-desktop/Sources/TimiVetCore/ClinicAPIClient.swift");
  if (!/updateCallPreferences\(/.test(client)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetCore/ClinicAPIClient.swift cannot change calling preferences, so the console has nothing to save.");
  }
  const console_ = await read("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift");
  if (!/Call this clinic about new requests/.test(console_)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift has no calling-preferences control.");
  }
}

/**
 * The payment seams.
 *
 * Everything here is a rule that, when broken, breaks *silently* — the tests
 * still pass, the app still works, and the failure is money in the wrong place
 * discovered weeks later by somebody reading a Stripe report. That is what
 * makes them worth a build failure rather than a code review.
 */
{
  // Comments stripped first. These files explain the very rules being
  // checked — "the fee is never an application_fee_amount" is written out in
  // prose at the top of src/payments.js — and a guard that fires on its own
  // explanation can never be satisfied. Same trap the Skip/LocalizedError
  // check above already had to be taught.
  const executable = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

  const workerSource = await read("src/index.js");
  const stripeSource = await read("src/stripe.js");
  const paymentsSource = await read("src/payments.js");
  const adminSource = await read("apps/admin-console/src/index.js");
  const worker = executable(workerSource);
  const stripe = executable(stripeSource);
  const payments = executable(paymentsSource);
  const adminWorker = executable(adminSource);

  /* 1. The webhook must verify its signature. */

  // A webhook endpoint that skips verification is a public URL where anybody
  // who can guess an intake id can post a payment_intent.succeeded: the
  // deposit is marked paid, real money is transferred to a clinic, and the
  // customer is told their care is confirmed. There is no Stripe SDK in a
  // Worker to do this for us, so the check is ours and it is the entire
  // security boundary of the endpoint.
  if (!worker.includes('path === "/api/stripe/webhook"')) {
    throw new Error("src/index.js no longer serves the Stripe webhook, so nothing moves payment state.");
  }
  {
    const start = worker.indexOf("async function handleStripeWebhook");
    if (start < 0) throw new Error("src/index.js has no handleStripeWebhook; the webhook route must have a handler that verifies signatures.");
    const handler = worker.slice(start, worker.indexOf("\n}", start));
    if (!handler.includes("verifyWebhookSignature")) {
      throw new Error("The Stripe webhook handler does not call verifyWebhookSignature. Without it the endpoint is a public URL that marks deposits paid.");
    }
    // Verification must come before anything reads the event. Parsing first
    // and verifying later is the same hole with more steps.
    if (handler.indexOf("verifyWebhookSignature") > handler.indexOf("JSON.parse")) {
      throw new Error("The Stripe webhook handler parses the body before verifying the signature. Verify first.");
    }
    if (!handler.includes("request.text()")) {
      throw new Error("The Stripe webhook handler must read the raw request body. Re-serialized JSON does not hash to the signature Stripe sent.");
    }
    if (!/handleStripeEvent/.test(handler)) {
      throw new Error("The Stripe webhook handler must dispatch through handleStripeEvent, which is where the idempotency claim lives.");
    }
  }
  {
    // Scoped to the verifier's own body, not the file. A
    // `constantTimeEquals` that is defined and never called is the same bug
    // with better documentation.
    const start = stripe.indexOf("export async function verifyWebhookSignature");
    if (start < 0) throw new Error("src/stripe.js no longer exports verifyWebhookSignature.");
    const verifier = stripe.slice(start, stripe.indexOf("\n}", start));
    for (const [needle, why] of [
      ["SHA-256", "Stripe signs webhooks with HMAC-SHA256; another hash verifies nothing"],
      ["constantTimeEquals", "signature comparison must be constant time, or the endpoint leaks the expected signature a byte at a time"],
      ["toleranceSeconds", "a captured request stays cryptographically valid forever; only a timestamp tolerance makes it stale"]
    ]) {
      if (!verifier.includes(needle)) throw new Error(`verifyWebhookSignature does not use ${needle}: ${why}.`);
    }
  }
  // Only v1. Stripe sends a fake v0 scheme on test events, and accepting any
  // scheme that is not v1 is the downgrade attack its own docs warn about.
  if (!/prefix === "v1"/.test(stripe)) {
    throw new Error('src/stripe.js must accept only the v1 signature scheme. Any other scheme is a downgrade attack.');
  }

  /* 2. The client is never trusted to mark a payment paid. */

  // `payment-status` used to reach into Stripe and write `payment_status`
  // from whatever it found, which made a client-triggered GET the thing that
  // marked a deposit paid. Payment state changes belong to the webhook.
  {
    const start = worker.indexOf("async function refreshPayment");
    if (start < 0) throw new Error("src/index.js no longer has refreshPayment; GET /api/intakes/{id}/payment-status must keep working.");
    const handler = worker.slice(start, worker.indexOf("\n}", start));
    if (/UPDATE\s+intake_requests/i.test(handler)) {
      throw new Error("refreshPayment writes to intake_requests. A GET a client can trigger must never change payment state — that is what the webhook is for.");
    }
  }
  // Nowhere in a request-handling Worker may set a deposit paid. The one
  // legitimate writer is src/payments.js: from the webhook, or from the demo
  // path when there is no Stripe at all.
  for (const [label, source] of [["src/index.js", worker], ["apps/admin-console/src/index.js", adminWorker]]) {
    if (/payment_status\s*=\s*'paid'/.test(source)) {
      throw new Error(`${label} marks a deposit paid directly. Only src/payments.js may do that, and only from a verified webhook or the demo path.`);
    }
  }

  /* 3. The ledger is written from webhook handling, not from a request. */

  // A ledger row written when a request handler *asks* for something records
  // an intention, not a fact. Refunds fail, transfers are refused, cards
  // decline — and a row written optimistically claims money moved that never
  // did, which is exactly the discrepancy the ledger exists to catch.
  for (const [label, source] of [["src/index.js", worker], ["apps/admin-console/src/index.js", adminWorker]]) {
    if (/recordLedgerEntry\s*\(/.test(source)) {
      throw new Error(`${label} writes ledger rows directly. Ledger writes belong in src/payments.js, driven by a verified Stripe event.`);
    }
    if (/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+payment_ledger/i.test(source)) {
      throw new Error(`${label} inserts into payment_ledger directly. That table is written only by src/payments.js.`);
    }
  }
  if (!payments.includes("INSERT OR IGNORE INTO payment_ledger")) {
    throw new Error("src/payments.js must insert ledger rows with INSERT OR IGNORE, so a webhook redelivered mid-flight cannot write a second row.");
  }
  if (!payments.includes("INSERT INTO stripe_events")) {
    throw new Error("src/payments.js must claim an event id in stripe_events before processing it. Stripe redelivers, and a charge.refunded applied twice halves the ledger's credibility and doubles its refund total.");
  }

  /* 4. Separate charges and transfers, not destination charges. */

  // The split is not knowable at charge time — see the funds-flow note at the
  // top of src/payments.js. Either of these parameters would move the money
  // when the card is authorized, before the intake outcome exists.
  for (const [label, source] of [["src/stripe.js", stripe], ["src/payments.js", payments]]) {
    if (/application_fee_amount/.test(source)) {
      throw new Error(`${label} uses application_fee_amount. Tími's fee is collected by transferring less: the clinic does not own this charge, so it cannot pay a fee out of it.`);
    }
    if (/transfer_data/.test(source)) {
      throw new Error(`${label} sets transfer_data, which makes this a destination charge. The destination and the amount are not known at charge time.`);
    }
  }
  // A transfer with no source_transaction fails whenever the platform's
  // available balance has not caught up with the charge — which, for a
  // deposit taken hours ago, is most of the time.
  if (!/sourceTransaction/.test(payments) || !/source_transaction/.test(stripe)) {
    throw new Error("A clinic transfer must name the charge that funded it (source_transaction), or it fails until the deposit settles.");
  }
  // The legacy account type is mutually exclusive with controller properties
  // and quietly hands Stripe a bundle of defaults we then cannot change.
  // `controller.stripe_dashboard.type` is a different `type` and a legitimate
  // one — it is how an account gets the Express dashboard without being an
  // Express account — so that hash is removed before the check.
  if (/["']?type["']?\s*:\s*["'](?:standard|express|custom)["']/.test(stripe.replace(/stripe_dashboard\s*:\s*\{[^}]*\}/g, ""))) {
    throw new Error("src/stripe.js sends the legacy connected-account type parameter. Use controller properties (v1) or configuration.recipient (v2).");
  }
  // Transferring to an account whose capability is not active fails at Stripe
  // with an error nobody sees, and the customer's money then sits in the
  // platform balance indefinitely with nothing recording why.
  if (!/transferEligibility/.test(payments) || !worker.includes("settleOutstandingIntakes")) {
    throw new Error("Settlement must check transfer eligibility before paying a clinic, and an unsettled intake must be retried by a sweep.");
  }

  /* 5. Nothing logs a secret. */

  for (const [label, source] of [["src/stripe.js", stripe], ["src/payments.js", payments], ["src/index.js", worker]]) {
    for (const line of source.split("\n")) {
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
      if (/console\.(log|warn|error|info)/.test(line) && /client_secret|clientSecret|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET/.test(line)) {
        throw new Error(`${label} logs a secret or a client secret. Anyone who can read that log can complete the payment.`);
      }
    }
  }

  // A webhook event that failed while being applied has to be retryable.
  //
  // Claiming an event id with a bare INSERT and reading any existing row as
  // "already handled" means one transient fault drops the event permanently:
  // Stripe retries, we answer "duplicate", and a customer stays charged with
  // an intake that never reaches paid. The re-claim must therefore be
  // conditional on the previous attempt having ended in `failed` — unconditional
  // would let it steal an event from a delivery still in flight, and absent
  // brings the original bug back.
  if (!/UPDATE stripe_events SET status = 'received'[^"]*WHERE id = \? AND status = 'failed'/.test(payments)) {
    throw new Error("src/payments.js does not re-claim a failed webhook event. Stripe's retry is the only chance that event will ever get, and answering it \"duplicate\" leaves the customer charged and the intake unpaid forever.");
  }

  // The ledger records what Stripe said, including what it could not match.
  const ledgerMigration = await read("migrations/0008_payments_ledger.sql");
  const ledgerTable = ledgerMigration.slice(
    ledgerMigration.indexOf("CREATE TABLE IF NOT EXISTS payment_ledger"),
    ledgerMigration.indexOf("CREATE INDEX IF NOT EXISTS idx_payment_ledger")
  );
  if (/REFERENCES/.test(ledgerTable)) {
    throw new Error("migrations/0008_payments_ledger.sql: payment_ledger carries a foreign key. Its ids come from Stripe metadata, which can name an intake that was deleted or never existed — a constraint there makes the INSERT fail and the ledger silently refuse to record money that moved.");
  }
}

// ---------------------------------------------------------------------------
// The Windows veterinary console. Every seam below is one that would fail
// silently: the app still builds, still starts, still shows a queue, and is
// wrong in a way nobody discovers until a clinic is holding it.
// ---------------------------------------------------------------------------
{
  const windowsRoot = "apps/vet-windows/src/TimiVet";
  const [models, settingsSource, clerkAuth, apiSource, alertSource, mainViewModel, mainWindow, miniWindow, appShell] =
    await Promise.all([
      read(`${windowsRoot}/Models/ClinicModels.cs`),
      read(`${windowsRoot}/Services/SettingsStore.cs`),
      read(`${windowsRoot}/Services/ClerkAuthService.cs`),
      read(`${windowsRoot}/Services/ClinicApiClient.cs`),
      read(`${windowsRoot}/Services/AlertService.cs`),
      read(`${windowsRoot}/ViewModels/MainViewModel.cs`),
      read(`${windowsRoot}/Views/MainWindow.xaml`),
      read(`${windowsRoot}/Views/MiniWindow.xaml`),
      read(`${windowsRoot}/App.xaml.cs`)
    ]);

  /** The body of one C# member, so an ordering check cannot be satisfied by a match elsewhere in the file. */
  const memberBody = (source, signature) => {
    const start = source.indexOf(signature);
    if (start === -1) return "";
    const rest = source.slice(start + signature.length);
    const next = rest.search(/\n {4}(?:\/\/\/|\[|private|public|internal|protected|static)/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /** Comments stripped, for a check whose own explanation would otherwise satisfy or trip it. */
  const executable = (source) => source.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");

  // A console that makes a receptionist type a Cloudflare Worker URL before it will do anything is a
  // console nobody gets to use. The address has one correct answer for every clinic Tími runs.
  if (!/DefaultApiBaseUrl = "https:\/\/providers\.timinow\.pet"/.test(models)) {
    throw new Error(`${windowsRoot}/Models/ClinicModels.cs does not name the production Worker, so a fresh install has no address to talk to and reports it as a Clerk failure.`);
  }
  if (!/public string ApiBaseUrl \{ get; set; \} = TimiVetEnvironment\.DefaultApiBaseUrl;/.test(models)) {
    throw new Error(`${windowsRoot}/Models/ClinicModels.cs: AppSettings.ApiBaseUrl does not default to the production Worker. A blank default is not neutral — it is a first launch that cannot reach /api/config.`);
  }
  // The C# equivalent of the initializer-versus-init bug the Swift side had: deserializing an older
  // settings.json assigns its empty string straight over the property default.
  if (!/IsNullOrWhiteSpace\(settings\.ApiBaseUrl\)/.test(settingsSource) || !/settings\.ApiBaseUrl = TimiVetEnvironment\.DefaultApiBaseUrl/.test(settingsSource)) {
    throw new Error(`${windowsRoot}/Services/SettingsStore.cs does not restore the default address when the stored one is blank. Every settings.json written by an older build carries "ApiBaseUrl": "", and deserialization overwrites the property default with it.`);
  }

  // Native Clerk mode. Each seam is a way to send `_is_native=true` and still not be a native client.
  const nativeSeams = [
    [/_is_native=true/, "never sends _is_native=true, so Clerk treats a signed desktop app as a browser and guards sign-in with a Turnstile challenge it cannot render."],
    [/TryAddWithoutValidation\("Authorization", _deviceToken\)/, "never puts the Clerk client JWT in the Authorization header, so every request arrives as a brand-new anonymous client and the session can never be resumed."],
    [/UseCookies = false/, "sends native requests through a client with a cookie jar. Clerk refuses a request carrying both an Authorization header and browser cookies, and HttpClientHandler.UseCookies cannot be changed per request."],
    [/_nativeMode \? _nativeHttp : _webHttp/, "does not pick its HttpClient by mode, so native and cookie requests share one cookie policy."],
    [/ClerkDeviceToken = _deviceToken/, "never writes the device token to the credential store, so the session cannot be resumed and sign-in greets the clinic again at every launch."],
    [/native_api_disabled/, "does not recognise native_api_disabled, so an instance without the Native API toggle cannot fall back to the cookie path and sign-in breaks outright."]
  ];
  const clerkAuthCode = executable(clerkAuth);
  for (const [pattern, complaint] of nativeSeams) {
    if (!pattern.test(clerkAuthCode)) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs ${complaint}`);
    }
  }
  const credentialSource = await read(`${windowsRoot}/Services/CredentialStore.cs`);
  if (!/public string\? ClerkDeviceToken \{ get; set; \}/.test(credentialSource)) {
    throw new Error(`${windowsRoot}/Services/CredentialStore.cs has nowhere to keep Clerk's native client JWT, so the only credential a native sign-in produces is thrown away at exit.`);
  }

  // The device token has to be absorbed before the status check. Clerk issues the client JWT on failure
  // responses too, and ordinary steps of this flow run straight through one — an unknown identifier is a
  // 422 — so taking it only on success leaves the next request unauthenticated.
  {
    const perform = memberBody(clerkAuth, "private async Task<ClerkResponse> PerformClerkRequestAsync");
    if (!perform) throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs no longer routes Clerk calls through one place, so nothing can guarantee the device token is read from every response.`);
    const absorbAt = perform.indexOf("AbsorbDeviceToken(response)");
    const statusAt = perform.search(/IsSuccessStatusCode|IsSuccess\b/);
    if (absorbAt === -1) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs does not absorb the Clerk device token from the response at all.`);
    }
    if (statusAt !== -1 && statusAt < absorbAt) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs absorbs the Clerk device token after the status check. Clerk issues it on failure responses too, and the request after a rejection would go out unauthenticated.`);
    }
  }

  // A network blip at launch is not a sign-out. The old shape returned false on any failure, which sent
  // the operator to a sign-in window — and signing in again is what replaced a perfectly good credential.
  if (!/IsCredentialRejected/.test(clerkAuth) || !/private SessionRestoreOutcome ResumeWithoutChecking\(\)/.test(clerkAuth)) {
    throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs treats every restore failure alike. Only Clerk refusing the credential (401/403/404) is a sign-out; a timeout or a 5xx says nothing about the account.`);
  }
  {
    const restore = clerkAuth.slice(clerkAuth.indexOf("var client = await GetClientAsync(ct);"));
    const bareCatch = restore.match(/\n\s*catch\s*\n\s*\{([\s\S]{0,240}?)\n\s*\}/);
    if (!bareCatch) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs: the restore path has no catch-all, so an unexpected failure escapes into the launch sequence rather than resuming quietly.`);
    }
    if (/SignOutLocally\(\)/.test(bareCatch[1]) || /_credentials\.Clear\(\)/.test(bareCatch[1])) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs: the catch-all while restoring a session erases the credential. That is the blip-signs-you-out bug.`);
    }
    // And it has to actually resume. The two checks above are satisfied by a
    // ResumeWithoutChecking that returns Rejected — the method is present, the
    // catch-all deletes nothing itself, and the caller signs out one frame
    // later on the outcome it was handed. Verified by making exactly that
    // change and watching the validator pass.
    const resumeBody = memberBody(clerkAuth, "private SessionRestoreOutcome ResumeWithoutChecking()");
    if (!resumeBody) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs no longer declares ResumeWithoutChecking, so an unreachable Clerk has no outcome that means "try again later".`);
    }
    if (/SessionRestoreOutcome\.Rejected/.test(resumeBody)) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs: ResumeWithoutChecking returns Rejected. Being unable to reach Clerk is not Clerk refusing the credential, and Rejected is the outcome that erases it — one blip on a clinic's morning Wi-Fi would sign them out permanently.`);
    }
    if (!/SessionRestoreOutcome\.(ResumedUnverified|Unreachable)/.test(resumeBody)) {
      throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs: ResumeWithoutChecking returns neither ResumedUnverified nor Unreachable, so there is no path that keeps a credential through a network failure.`);
    }
    // Erasing is allowed in exactly one place: the handler for a credential
    // Clerk actually refused.
    const erasingCatches = [...clerkAuth.matchAll(/catch[^\n]*\n\s*\{[\s\S]{0,300}?SignOutLocally\(\)/g)];
    for (const hit of erasingCatches) {
      if (!/IsCredentialRejected/.test(hit[0])) {
        throw new Error(`${windowsRoot}/Services/ClerkAuthService.cs erases the credential from a catch that is not filtered on IsCredentialRejected. Only Clerk saying no is a sign-out.`);
      }
    }
  }
  if (!/CanResumeClinicSessionOffline/.test(appShell)) {
    throw new Error(`${windowsRoot}/App.xaml.cs drops to the sign-in window whenever /api/session cannot be reached, so a console opened before the network is up asks a clinic to complete a sign-in it has no connection for.`);
  }

  // /api/config carries the Clerk publishable key, so a client that demands a session before sending it
  // has locked sign-in out of itself: no config, no Clerk host, no sign-in, no session, no config.
  if (!/IsPublic\(url\)/.test(apiSource) || !/api\/config/.test(apiSource.slice(apiSource.indexOf("private static bool IsPublic")))) {
    throw new Error(`${windowsRoot}/Services/ClinicApiClient.cs refuses every unauthenticated request, /api/config included. Sign-in can then never start, because the Clerk key lives behind exactly that request.`);
  }

  // A queue alert has to lead to an answer, not to another window.
  if (!/private async Task AnswerAsync\(ClinicRequest request, bool decline\)/.test(mainViewModel)) {
    throw new Error(`${windowsRoot}/ViewModels/MainViewModel.cs has no one-press answer, so every response has to go through the decision workspace: find the row, read four number fields, press a button.`);
  }
  for (const [path, source] of [["Views/MainWindow.xaml", mainWindow], ["Views/MiniWindow.xaml", miniWindow]]) {
    if (!/AcceptRequestCommand/.test(source) || !/DeclineRequestCommand/.test(source)) {
      throw new Error(`${windowsRoot}/${path} does not offer accept and decline on the request itself. A floating panel that raises an alert whose only action is "open another window" is what this replaced.`);
    }
  }

  // The alert sound. SystemSounds routes to the Windows "System sounds" channel, a slider separate from
  // output volume that the "No Sounds" scheme most managed clinic images ship with mutes outright.
  if (/SystemSounds\./.test(executable(alertSource))) {
    throw new Error(`${windowsRoot}/Services/AlertService.cs plays the Windows event beep, which follows the separate System sounds channel and is routinely silent. Play real audio through the app's own output.`);
  }
  if (!/private SoundPlayer\? _alertPlayer/.test(alertSource) || !/public void PreviewAlert\(\)/.test(alertSource)) {
    throw new Error(`${windowsRoot}/Services/AlertService.cs must hold the player for the length of the sound — one collected mid-sound simply stops — and must expose a preview, because "no sound fires" cannot be diagnosed by waiting for a real patient.`);
  }
  if (!/TestAlertCommand/.test(mainWindow)) {
    throw new Error(`${windowsRoot}/Views/MainWindow.xaml has no Test button for the intake alert.`);
  }

  // Calling preferences: a practice with one person at the desk and a phone already ringing has a real
  // reason to say no to an automated call.
  if (!/UpdateCallPreferencesAsync\(/.test(apiSource)) {
    throw new Error(`${windowsRoot}/Services/ClinicApiClient.cs cannot change calling preferences, so the console has nothing to save.`);
  }
  if (!/Call this clinic about new requests/.test(mainWindow)) {
    throw new Error(`${windowsRoot}/Views/MainWindow.xaml has no calling-preferences control.`);
  }

  // Owner-recorded medications and allergies, labelled as unverified, on the request itself.
  if (!/OwnerSuppliedMedicalLine/.test(mainWindow) || !/REPORTED BY OWNER, UNVERIFIED/.test(mainWindow)) {
    throw new Error(`${windowsRoot}/Views/MainWindow.xaml does not render the owner-recorded medications and allergies, or does not label them unverified. ClinicModels carries them either way, so the omission is invisible.`);
  }

  // The console must not stop updating in silence. A stale queue that still says LIVE reads as an empty
  // waiting room from across the room.
  if (!/ConsoleConnectionState/.test(mainViewModel) || !/private static readonly int\[\] BackoffSeconds/.test(mainViewModel)) {
    throw new Error(`${windowsRoot}/ViewModels/MainViewModel.cs has no connection state and no backoff, so a Worker it cannot reach is retried every few seconds forever while the screen claims to be live.`);
  }
  // The subscription, not the unsubscription in Dispose — which is what a bare name match finds.
  if (!/NetworkChange\.NetworkAvailabilityChanged \+=/.test(mainViewModel)) {
    throw new Error(`${windowsRoot}/ViewModels/MainViewModel.cs ignores the network coming back, so the console waits out a full backoff after Windows already knows it is connected.`);
  }

  // WPF resolves control colours through SystemColors, which follow Windows. The console's palette is
  // painted by hand and light; the macOS console was unreadable in dark mode for exactly this reason.
  const themeSource = await read(`${windowsRoot}/Theme/Theme.xaml`);
  for (const key of ["SystemColors.WindowBrushKey", "SystemColors.ControlTextBrushKey", "SystemColors.HighlightBrushKey"]) {
    if (!themeSource.includes(key)) {
      throw new Error(`${windowsRoot}/Theme/Theme.xaml does not pin ${key}. Stock control templates look it up dynamically, so on a machine in dark mode or high contrast the console renders dark fields inside hand-painted light cards.`);
    }
  }

  // CI has to build what the project actually targets; an SDK older than the TargetFramework fails as
  // NETSDK1045, which reads as a broken project rather than as a stale runner.
  const csproj = await read("apps/vet-windows/src/TimiVet/TimiVet.csproj");
  const framework = csproj.match(/<TargetFramework>net(\d+)\.0-windows/);
  if (!framework) throw new Error("apps/vet-windows/src/TimiVet/TimiVet.csproj no longer declares a Windows target framework.");
  if (!nativeWorkflow.includes(`dotnet-version: "${framework[1]}.0.x"`)) {
    throw new Error(`.github/workflows/native-clients.yml installs a .NET SDK that does not match apps/vet-windows/src/TimiVet/TimiVet.csproj's net${framework[1]}.0 target, so the Windows job fails with NETSDK1045.`);
  }
}

// The emergency list is the one customer screen that used to hand navigation to
// Apple Maps unconditionally, because its entries come from Mapbox POI data
// rather than from a clinic record. That distinction mattered to the code and
// to nobody holding the phone, and it is easy to reintroduce: the Apple Maps
// link still lives on this row on purpose, so deleting the Navigate button
// leaves a screen that looks finished.
{
  const components = await read("apps/customer-mobile/Sources/TimiNowUI/Components.swift");
  const row = components.slice(components.indexOf("struct EmergencyClinicRow"));
  // Comment lines first: two guards in this file have already been satisfied by
  // their own explanatory prose rather than by any code.
  const rowCode = row.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  if (!/NavigationScreen\(/.test(rowCode)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/Components.swift: EmergencyClinicRow no longer presents NavigationScreen, so an emergency hospital found on the map sends the customer out to Apple Maps even on a build that has turn-by-turn compiled in.");
  }
  const rowLines = rowCode.split("\n");
  const opensNavigation = rowLines.findIndex((line) => /showNavigation = true/.test(line));
  if (opensNavigation < 0) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/Components.swift: EmergencyClinicRow has no button that opens Tími navigation. The Apple Maps link on this row is deliberate, so removing the Navigate button leaves a screen that looks finished and never uses our own turn-by-turn.");
  }
  const guarding = rowLines.slice(Math.max(0, opensNavigation - 5), opensNavigation).join("\n");
  if (!/TurnByTurn\.isAvailable/.test(guarding) || !/place\.navigationDestination/.test(guarding)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/Components.swift: EmergencyClinicRow's Navigate button is not gated on TurnByTurn.isAvailable and a navigable destination, so on a build without the Mapbox SDK it opens the \"navigation not included in this build\" card, and on a POI with no coordinates it opens an empty one.");
  }
  if (!/recordsArrival: false/.test(rowCode)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/Components.swift: EmergencyClinicRow presents NavigationScreen without recordsArrival: false. record(\"arrived\") writes against currentIntake, so somebody with a confirmed appointment at one clinic who drives to an emergency hospital marks that appointment arrived — and the clinic is told to expect a patient who is on the way somewhere else.");
  }
  if (!/AppleMapsFallback\.directionsURL/.test(rowCode)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/Components.swift: EmergencyClinicRow builds its own Apple Maps URL again instead of using AppleMapsFallback. Two copies of that link only stay identical while somebody remembers both.");
  }
}

// NavigationScreen is presented inside a cover bound to the presenter's own
// state. Ending navigation cleared store.navigationDestination and nothing
// else, which is not what the cover is bound to, so the screen stayed up and
// the only way out was to force-quit the app.
{
  const navigation = await read("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift");
  if (!/var onFinish: \(\) -> Void/.test(navigation)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift: NavigationScreen has no onFinish, so whatever presented it is never told to dismiss.");
  }
  for (const path of [
    "apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift",
    "apps/customer-mobile/Sources/TimiNowUI/Components.swift"
  ]) {
    const source = await read(path);
    for (const call of source.split("NavigationScreen(").slice(1)) {
      // The call's own argument list: up to the first line that closes it.
      const args = call.slice(0, call.indexOf(")"));
      if (!/onFinish:/.test(args)) {
        throw new Error(`${path}: a NavigationScreen is presented without onFinish, so "End navigation" clears the store and leaves the full-screen cover up.`);
      }
    }
  }
}

// Both build configurations have to answer the availability question. Only one
// of them is compiled on any given machine, so a missing branch is a build
// error that CI finds and a developer does not.
{
  const navigation = await read("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift");
  const declarations = navigation.match(/static let isAvailable = (true|false)/g) || [];
  if (!declarations.includes("static let isAvailable = true") || !declarations.includes("static let isAvailable = false")) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift: TurnByTurn.isAvailable is not declared in both branches of the Mapbox #if, so one build configuration does not compile.");
  }
}

// Sign-in is one-time codes and nothing else, on every native surface. The
// owner removed passwords and OAuth deliberately; the fastest way for them to
// come back is a well-meaning revert, and the second-fastest is dormant auth
// code being wired back up "because it was already there".
{
  const signInView = await read("apps/customer-mobile/Sources/TimiNowUI/SignInView.swift");
  if (/SecureField\(/.test(signInView)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SignInView.swift shows a password field again. Sign-in is email/phone one-time codes only.");
  }
  const macAuth = await read("apps/vet-desktop/Sources/TimiVetCore/AuthController.swift");
  if (/ASWebAuthenticationSession|strategy=oauth|passkey/i.test(macAuth.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("///")).join("\n"))) {
    throw new Error("apps/vet-desktop/Sources/TimiVetCore/AuthController.swift has OAuth or passkey plumbing again. The consoles sign in with one-time codes only.");
  }
  const winSignIn = await read("apps/vet-windows/src/TimiVet/Views/SignInWindow.xaml");
  if (/PasswordBox/.test(winSignIn)) {
    throw new Error("apps/vet-windows/src/TimiVet/Views/SignInWindow.xaml has a PasswordBox again. Sign-in is email/phone one-time codes only.");
  }
  const winAuth = await read("apps/vet-windows/src/TimiVet/Services/ClerkAuthService.cs");
  if (/HttpListener|RunRedirectSignInAsync/.test(winAuth)) {
    throw new Error("apps/vet-windows/src/TimiVet/Services/ClerkAuthService.cs has the loopback OAuth flow again.");
  }
}

// The customer pays a $25 Tími service fee at the time of service, and the
// one place that must say so is the screen where they pay. The full $50
// schedule lives in the legal sections and the clinic payouts panels.
{
  const deposit = await read("apps/customer-mobile/Sources/TimiNowUI/DepositView.swift");
  if (!/T\u00edmi service fee, charged at the time of service/.test(deposit) && !/Tími service fee, charged at the time of service/.test(deposit)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/DepositView.swift no longer discloses the Tími service fee at checkout.");
  }
  for (const [path, needle] of [
    ["apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift", "$50 per completed intake"],
    ["apps/vet-windows/src/TimiVet/Views/MainWindow.xaml", "$50 per completed intake"],
  ]) {
    const source = await read(path);
    if (!source.includes(needle)) {
      throw new Error(`${path} no longer states the real service fee (${needle}) in the payouts panel, leaving clinics with the old vague wording.`);
    }
  }
}

// The splash exists to end the sign-in flash at launch: it must hold until
// session restore has actually been attempted, not just for a fixed delay.
{
  const app = await read("apps/customer-mobile/Sources/TimiNowApp/TimiNowApp.swift");
  const code = app.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("///")).join("\n");
  if (!/SplashView/.test(code) || !/\bhasAttemptedRestore\b(?![A-Za-z0-9_])/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowApp/TimiNowApp.swift no longer gates the splash on hasAttemptedRestore, so the launch flashes the sign-in screen again.");
  }
}

// The two Mapbox preconditions that were killing Navigate, pulled from the
// device's own log. Both are traps, not throws - nothing catchable, the app
// simply goes away - so the only defence is making them impossible to ship.
{
  // 1. "Fatal error: No access token provided". Navigation v3's CoreConfig
  // token feeds routing and speech; every map pane reads the process-wide
  // MapboxOptions.accessToken instead, and nothing set it.
  const stack = await read("apps/customer-mobile/Sources/TimiNowUI/MapboxStack.swift");
  if (!/MapboxOptions\.accessToken = token/.test(stack)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/MapboxStack.swift no longer sets MapboxOptions.accessToken. The map inside NavigationViewController reads only that global and traps fatally without it: 'No access token provided', straight off the device log.");
  }
  const root = await read("apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift");
  if (!/TimiMapboxToken\.apply\(store\.mapToken\)/.test(root)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/CustomerRootView.swift no longer applies the Mapbox token when /api/config supplies it, so the first map pane to render before navigation starts traps with 'No access token provided'.");
  }

  // 2. RouteVoiceController.swift:114 traps unless UIBackgroundModes has
  // "audio". Parsed positionally, not by substring, so an entry under some
  // other key cannot satisfy it.
  const plist = await read("apps/customer-mobile/Darwin/Info.plist");
  const at = plist.indexOf("<key>UIBackgroundModes</key>");
  if (at < 0) {
    throw new Error("apps/customer-mobile/Darwin/Info.plist has no UIBackgroundModes. MapboxNavigationCore's RouteVoiceController traps at init without 'audio' in it (RouteVoiceController.swift:114), so pressing Navigate with voice enabled closes the app.");
  }
  const arrayEnd = plist.indexOf("</array>", at);
  const entries = plist.slice(at, arrayEnd);
  if (!entries.includes("<string>audio</string>")) {
    throw new Error("apps/customer-mobile/Darwin/Info.plist: UIBackgroundModes no longer contains 'audio', which RouteVoiceController requires on pain of a fatal trap.");
  }
}

// The navigation breadcrumb must cover the live screen. The first version
// cleared it the moment the controller presented, and the crash lived exactly
// there - the presented map's first frames - so the next launch reported
// "none recorded", which reads as innocence and was a blind spot.
{
  const nav = await read("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift");
  const code = nav.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///")).join("\n");
  if (!code.includes('TimiBreadcrumb.mark("nav:live")')) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift no longer marks nav:live after presenting the navigation controller, so a crash in the live screen's first frames reports nothing.");
  }
  if (!code.includes('TimiBreadcrumb.mark("nav:host_setup")')) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift no longer marks nav:host_setup in makeUIViewController, so a crash before viewDidLoad reports nothing.");
  }
  const finish = code.slice(code.indexOf("private func finish()"));
  if (!/TimiBreadcrumb\.clear\(\)/.test(finish.slice(0, 200))) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/NavigationView.swift: finish() no longer clears the breadcrumb, so every normally-ended drive reports itself as a crash at the next launch.");
  }
}

// MapboxNavigationProvider owns the SDK's process-wide navigator, tile store
// and billing session. There is meant to be one for the life of the app. This
// app built one per route preview and another on every press of Navigate,
// because the provider carried the trip's voice and the voice knew the pet's
// name — and the second construction is not a failure this code can catch:
// nothing throws, nothing returns nil, the app simply goes away.
{
  const built = [];
  for (const path of swiftFiles) {
    const source = await read(path);
    const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///")).join("\n");
    if (/MapboxNavigationProvider\(/.test(code)) built.push(path);
  }
  if (built.length !== 1 || !built[0].endsWith("MapboxStack.swift")) {
    throw new Error(`MapboxNavigationProvider is constructed in ${built.length} file(s) (${built.join(", ")}). There must be exactly one, in MapboxStack.swift: the SDK's navigator is process-wide and a second provider takes the app down with no catchable error.`);
  }
}

// keyboardType and textInputAutocapitalization exist on iOS and in Skip's
// Android bridge, and not on macOS - and `swift test` builds TimiNowUI for the
// macOS host. Every bare call was a host-build error, which failed CI's test
// step, which SKIPPED the step that compiles the real iOS app: the one job
// that could catch device-only mistakes spent days being cancelled by a
// keyboard hint. The shims in Theme.swift are the only place either may be
// named.
{
  for (const path of swiftFiles) {
    if (!path.startsWith("apps/customer-mobile/")) continue;
    if (path.endsWith("/Theme.swift")) continue;
    const source = await read(path);
    const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///")).join("\n");
    if (/\.keyboardType\(/.test(code) || /\.textInputAutocapitalization\(/.test(code)) {
      throw new Error(`${path} calls keyboardType or textInputAutocapitalization directly. Those are iOS-only and this module also builds for the macOS host, where the call is a compile error that takes CI's entire iOS pipeline down. Use .timiKeyboard(...) / .timiNoAutocapitalization() from Theme.swift.`);
    }
  }
}

// An automatic sign-out must not delete the customer's data.
//
// Clerk's native API does not refuse a device token it no longer recognises —
// it returns a brand-new empty client with 200 OK. So "your token was not
// accepted" and "you signed out elsewhere" arrive identically, and reading the
// first as the second signed the person out at every launch, cleared the
// Keychain, and through onSignedOut deleted their pets, their care history and
// their own name. Three symptoms, one line.
{
  const auth = await read("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift");
  const code = auth.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///")).join("\n");

  if (!/if sessions\.isEmpty \{[\s\S]{0,400}resumeWithoutChecking\(\)/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift: an empty Clerk client is treated as a sign-out again. Clerk answers an unrecognised device token with an empty client and 200 OK, so that path signs somebody out on every launch and takes their pets with it.");
  }
  // A customer's session is *pending*, not active, whenever the Clerk
  // instance forces organization selection - customers have no organization
  // to choose, so pending is the permanent state of every customer session
  // under that toggle. A restore that accepts only "active" therefore signs
  // every customer out at every launch, which is precisely the bug that
  // survived four rounds of Keychain fixes.
  if (!/\[\"active\", \"pending\"\]/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift: session restore no longer accepts a pending session. Under force_organization_selection every customer session is pending forever, so this signs every customer out at every launch.");
  }
  if (!/private func signOutLocally\(explicit: Bool\)/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift: signOutLocally no longer distinguishes a sign-out somebody asked for from one this code decided on. Only the first may clear device-local data — the second is a guess about a credential, and a guess must not delete somebody's animals.");
  }
  if (!/if explicit \{ onSignedOut\(\) \}/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift: signOutLocally fires onSignedOut unconditionally, so an automatic sign-out clears pets, history and the owner's name with no undo.");
  }
  // The launch path must never call it with explicit: true.
  const start = code.slice(code.indexOf("public func start() async"), code.indexOf("private func resumeWithoutChecking"));
  if (/signOutLocally\(explicit: true\)/.test(start)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowCore/AuthController.swift: start() signs out explicitly, which clears device-local data on a launch-time credential check.");
  }
}

// Two files in one module declaring the same type name.
//
// PetPayload existed in APIClient.swift as the pet inside a care search, and a
// second PetPayload was added in Models.swift for a stored pet record — two
// genuinely different shapes that happened to describe the same noun. Swift
// rejects it, so it cost a device build rather than a subtle bug, but nothing
// short of a compiler was looking: a Worker-side check passes, the unit tests
// on the host do not build that module, and CI's Mapbox path is the only place
// it surfaces.
{
  const modules = new Map();
  for (const path of swiftFiles) {
    // Sources/<Module>/File.swift
    const module = path.split("/").slice(0, -1).join("/");
    if (!modules.has(module)) modules.set(module, new Map());
    const declarations = modules.get(module);
    const source = await read(path);
    for (const line of source.split("\n")) {
      // Top-level only: an indented declaration is nested inside something and
      // is namespaced by it, which the check above this one covers.
      const match = line.match(/^(?:public |private |internal |fileprivate |final |)*(?:struct|enum|class|actor|protocol) ([A-Z]\w*)/);
      if (!match) continue;
      if (/^\s/.test(line)) continue;
      const name = match[1];
      if (declarations.has(name) && declarations.get(name) !== path) {
        throw new Error(`${path} declares ${name}, and so does ${declarations.get(name)}. Two files in one Swift module cannot both declare a type of that name — the build fails with "invalid redeclaration". If they describe different things, name them differently.`);
      }
      declarations.set(name, path);
    }
  }
}

// A public type declared inside a class is a nested type: TimiGateway.ClientErrorReport,
// not ClientErrorReport. Swift is happy with that right up until another file
// in the same module names it unqualified, and then the failure is "cannot
// find X in scope" at the *use* site — which reads as a missing file rather
// than as a brace in the wrong place, a hundred lines away in a file nobody
// was editing. Nothing but a device build was finding it.
{
  const swiftSources = new Map();
  for (const path of swiftFiles) swiftSources.set(path, await read(path));

  for (const [path, source] of swiftSources) {
    for (const line of source.split("\n")) {
      // Indented, therefore nested inside something.
      const declaration = line.match(/^\s+public (?:final )?(?:struct|enum|class|actor|protocol) ([A-Z]\w*)/);
      if (!declaration) continue;
      const name = declaration[1];
      for (const [otherPath, otherSource] of swiftSources) {
        if (otherPath === path) continue;
        // Unqualified uses only. `Outer.Inner` from another file is a
        // deliberately nested type being named properly.
        const unqualified = new RegExp(`(^|[^\\w.])${name}\\b`, "m");
        const code = otherSource.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        if (unqualified.test(code)) {
          throw new Error(`${path} declares ${name} nested inside another type, but ${otherPath} names it unqualified. Move it to file scope: as written this fails with "cannot find '${name}' in scope" at the use site, which points at the wrong file entirely.`);
        }
      }
    }
  }
}

// A WPF window's Width and Height are device-independent pixels, not screen
// pixels. At 125% scaling — the Windows default on most laptops — a 1920x1080
// display is 1536x864 of them, and the console's 1440x920 did not fit. Centred
// anyway, half the overflow went above the top edge and took the title bar
// with it, so the app opened with no minimize, maximize or close and a cropped
// first row. Every developer machine runs at 100%, where this never happens.
{
  const windowFit = await read("apps/vet-windows/src/TimiVet/Views/WindowFit.cs");
  if (!/SystemParameters\.WorkArea/.test(windowFit)) {
    throw new Error("apps/vet-windows/src/TimiVet/Views/WindowFit.cs no longer bounds windows by SystemParameters.WorkArea, so a window larger than the desktop opens with its title bar off the top of the screen.");
  }

  for (const path of await collectFiles("apps/vet-windows/src/TimiVet/Views", ".xaml")) {
    const xaml = await read(path);
    // Only windows the framework places for us. MiniWindow positions itself.
    if (!/WindowStartupLocation="CenterScreen"/.test(xaml)) continue;
    const codeBehind = `${path}.cs`;
    const source = await read(codeBehind).catch(() => "");
    if (!/FitToWorkArea\(\)/.test(source)) {
      throw new Error(`${codeBehind}: this window is centred by WindowStartupLocation but never calls FitToWorkArea(), so on a display whose scaling makes the desktop smaller than the window, it opens with its title bar — and minimize, maximize and close with it — above the top edge of the screen.`);
    }
  }
}

// The Windows icon is committed rather than generated at build time: the
// generator is a macOS script and the build machine is a Windows one, so a
// conditional reference meant a working app with a blank taskbar icon and no
// warning anywhere.
{
  const csproj = await read("apps/vet-windows/src/TimiVet/TimiVet.csproj");
  if (/<ApplicationIcon Condition=/.test(csproj) || /<Resource Include="Assets\\timinow\.ico" Condition=/.test(csproj)) {
    throw new Error("apps/vet-windows/src/TimiVet/TimiVet.csproj makes the application icon conditional on the file existing, so a checkout without it builds an app with a blank Windows icon and reports nothing.");
  }
  const icon = await readFile(resolve(root, "apps/vet-windows/src/TimiVet/Assets/timinow.ico"));
  if (icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1) {
    throw new Error("apps/vet-windows/src/TimiVet/Assets/timinow.ico is not an icon file. Windows shows a blank square rather than failing, so nothing else reports this.");
  }
  const count = icon.readUInt16LE(4);
  if (!count) throw new Error("apps/vet-windows/src/TimiVet/Assets/timinow.ico contains no images.");
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const declared = icon.readUInt8(at) || 256;
    const size = icon.readUInt32LE(at + 8);
    const offset = icon.readUInt32LE(at + 12);
    if (offset + size > icon.length) throw new Error(`apps/vet-windows/src/TimiVet/Assets/timinow.ico: image ${index} points past the end of the file.`);
    const isPNG = icon.subarray(offset, offset + 8).toString("hex") === "89504e470d0a1a0a";
    // Windows honours a PNG-compressed entry at 256x256 and nowhere else.
    // Below that it wants a BMP/DIB, and an ICO that is PNG all the way down
    // loads as nothing: no error, no fallback, a blank square in the taskbar
    // and on the .exe. That is exactly what shipped, and the file passed every
    // structural check while it did.
    if (declared === 256 && !isPNG) {
      throw new Error("apps/vet-windows/src/TimiVet/Assets/timinow.ico: the 256x256 image is not PNG-compressed, which makes the file far larger than it needs to be.");
    }
    if (declared < 256) {
      if (isPNG) {
        throw new Error(`apps/vet-windows/src/TimiVet/Assets/timinow.ico: the ${declared}x${declared} image is a PNG. Windows only decodes PNG entries at 256x256, so an icon built this way renders as a blank square with nothing reporting it. Rebuild with scripts/lib/make-ico.mjs.`);
      }
      if (icon.readUInt32LE(offset) !== 40) {
        throw new Error(`apps/vet-windows/src/TimiVet/Assets/timinow.ico: the ${declared}x${declared} image does not begin with a 40-byte BITMAPINFOHEADER.`);
      }
      // Height is doubled in an ICO: the colour rows and the AND mask.
      if (icon.readInt32LE(offset + 8) !== declared * 2) {
        throw new Error(`apps/vet-windows/src/TimiVet/Assets/timinow.ico: the ${declared}x${declared} image declares a height of ${icon.readInt32LE(offset + 8)} rather than ${declared * 2}. An ICO's DIB height counts the colour rows and the AND mask together; getting it wrong shows the icon squashed into its top half.`);
      }
    }
  }
}

// The customer app is ink borders, serif headlines and coral on a warm canvas.
// A stock `Form` is grouped grey sections, hairline separators and system
// small-caps headers — the look of every settings screen on the phone. The pet
// sheet was rewritten off exactly that and Settings was left behind, so the
// tab bar had three Tími screens and one that belonged to somebody else.
{
  const support = await read("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift");
  const code = support.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///")).join("\n");
  if (/\bForm\s*\{/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift uses a SwiftUI Form. That is the system settings look, and it is the one thing these screens are not supposed to be — see PetEditor, which was rewritten off it.");
  }
  // A Picker on iOS is a wheel or a menu drawn by the system, in the system's
  // colours, which is the same problem one control at a time.
  if (/\bPicker\(/.test(code)) {
    throw new Error("apps/customer-mobile/Sources/TimiNowUI/SupportViews.swift uses a system Picker. The chip rows next to it are what this app selects with.");
  }
}

// "Requests awaiting a decision" listed every request the clinic had, on both
// consoles. Answering one left it in the queue looking undecided apart from its
// buttons, which a status converter hid — while the count beside the heading,
// bound to the pending metric, correctly said none were waiting. Both floating
// panels had it right, which is how it survived: the shape that was tested was
// not the shape that was used.
{
  const consoleView = await read("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift");
  const queue = consoleView.slice(consoleView.indexOf("Requests awaiting a decision"));
  const loop = queue.match(/ForEach\(store\.(\w+)\)/);
  if (!loop) throw new Error("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift: the review queue no longer iterates a store collection, so this check cannot tell which one it shows.");
  if (loop[1] !== "pendingRequests") {
    throw new Error(`apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift: the review queue lists store.${loop[1]} rather than store.pendingRequests, so a request stays in "awaiting a decision" after it has been answered.`);
  }

  const mainWindow = await read("apps/vet-windows/src/TimiVet/Views/MainWindow.xaml");
  const bound = mainWindow.match(/ItemsSource="\{Binding (\w+)\}" SelectedItem="\{Binding SelectedRequest\}"/);
  if (!bound) throw new Error("apps/vet-windows/src/TimiVet/Views/MainWindow.xaml: the review queue no longer binds an items source alongside SelectedRequest.");
  if (bound[1] !== "PendingRequests") {
    throw new Error(`apps/vet-windows/src/TimiVet/Views/MainWindow.xaml: the review queue binds ${bound[1]} rather than PendingRequests, so an answered request stays in "awaiting a decision".`);
  }
}

// The install script is the reason "which build am I running" stopped being a
// question on Windows. It must keep the same two protections the raw publish
// line carries, plus the Start Menu shortcut that makes the app findable.
{
  const install = await read("apps/vet-windows/install.ps1");
  if (!/Stop-Process -Name TimiVet/.test(install)) {
    throw new Error("apps/vet-windows/install.ps1 no longer stops a running TimiVet before publishing, so the publish fails on the exe lock and silently leaves the old binary installed.");
  }
  if (!/IncludeNativeLibrariesForSelfExtract=true/.test(install)) {
    throw new Error("apps/vet-windows/install.ps1 publishes without IncludeNativeLibrariesForSelfExtract, so the installed exe will not start on a machine it is copied to.");
  }
  if (!/LASTEXITCODE -ne 0/.test(install) || !/\.CreateShortcut\(/.test(install)) {
    throw new Error("apps/vet-windows/install.ps1 must refuse to install a failed build and must create the Start Menu shortcut - without the shortcut the app goes back to being unfindable.");
  }
}

// A single-file publish rewrites TimiVet.exe in place, and Windows refuses to
// delete a running executable. With the console open, GenerateBundle fails with
// UnauthorizedAccessException and MSBuild stack frames — never the sentence
// "the app is running" — after every earlier step has reported success. The
// .exe left behind is the previous build, which starts fine and behaves like
// the previous build.
{
  const readme = await read("apps/vet-windows/README.md");
  const publishLine = readme.split("\n").find((line) => line.includes("dotnet publish") && line.includes("PublishSingleFile"));
  if (!publishLine) throw new Error("apps/vet-windows/README.md no longer documents a single-file publish command.");
  if (!/IncludeNativeLibrariesForSelfExtract=true/.test(publishLine)) {
    throw new Error("apps/vet-windows/README.md's publish command omits IncludeNativeLibrariesForSelfExtract, so WPF's native libraries land beside the exe instead of inside it and the copied .exe will not start elsewhere.");
  }
  if (!/Stop-Process -Name TimiVet/.test(publishLine)) {
    throw new Error("apps/vet-windows/README.md's publish command no longer stops a running TimiVet first, so publishing while the console is open fails with UnauthorizedAccessException and silently leaves the previous build in place.");
  }
}

// Both consoles reported every outcome into a status line at the top of the
// window — in the same grey as the poll's own "next check in 15 sec", which
// overwrites it within seconds. A button at the bottom of the decision
// workspace therefore produced no visible change anywhere near the pointer,
// and the honest response to a button that appears to do nothing is to press
// it again. On "Send availability offer" that is a second offer.
{
  const store = await read("apps/vet-desktop/Sources/TimiVetCore/ClinicStore.swift");
  if (!/func succeed\(/.test(store) || !/func fail\(/.test(store)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetCore/ClinicStore.swift no longer routes outcomes through succeed/fail, so nothing confirms an action where the operator is looking.");
  }
  const consoleView = await read("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift");
  if (!/ForEach\(store\.toasts\)/.test(consoleView)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift does not iterate store.toasts, so the confirmations are produced and never shown.");
  }
  if (!/overlay\(alignment: \.bottomTrailing\)/.test(consoleView)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetUI/ConsoleView.swift no longer overlays the toast layer. In the layout stack instead, a confirmation appearing shifts the queue underneath it at the moment somebody is reaching for a row.");
  }

  const viewModel = await read("apps/vet-windows/src/TimiVet/ViewModels/MainViewModel.cs");
  if (!/private void Succeed\(/.test(viewModel) || !/private void Fail\(/.test(viewModel)) {
    throw new Error("apps/vet-windows/src/TimiVet/ViewModels/MainViewModel.cs no longer routes outcomes through Succeed/Fail.");
  }
  const mainWindow = await read("apps/vet-windows/src/TimiVet/Views/MainWindow.xaml");
  if (!/Toasts\.Toasts/.test(mainWindow)) {
    throw new Error("apps/vet-windows/src/TimiVet/Views/MainWindow.xaml does not render the toast collection.");
  }

  // A press that only changes fill opacity, on a coloured button against a
  // coloured card, is very close to no feedback at all.
  const theme = await read("apps/vet-desktop/Sources/TimiVetUI/Theme.swift");
  if (!/func timiVetPress\(/.test(theme) || !/scaleEffect/.test(theme)) {
    throw new Error("apps/vet-desktop/Sources/TimiVetUI/Theme.swift: the button styles no longer move on press.");
  }
  const windowsTheme = await read("apps/vet-windows/src/TimiVet/Theme/Theme.xaml");
  if (!/Property="IsPressed" Value="True"[\s\S]{0,900}ScaleTransform/.test(windowsTheme)) {
    throw new Error("apps/vet-windows/src/TimiVet/Theme/Theme.xaml: the pressed trigger no longer scales the button, so a press changes opacity and nothing else.");
  }
  // A Trigger can only target an element in the template's name scope, and the
  // contents of a RenderTransform are not in it. Naming the transform and
  // pointing a Setter at it fails the XAML compile with MC4111 — a build error,
  // not something the running app could have reported.
  if (/<(?:Scale|Translate|Rotate|Skew)Transform x:Name=/.test(windowsTheme)) {
    throw new Error("apps/vet-windows/src/TimiVet/Theme/Theme.xaml names a transform inside a RenderTransform. A Trigger cannot target it: the XAML compiler rejects it with MC4111. Set the whole RenderTransform property in the Setter instead.");
  }
}

// The Windows payouts panel. The macOS console has had one since Stripe landed
// and this one did not, which is what two codebases for one product costs.
{
  const mainWindow = await read("apps/vet-windows/src/TimiVet/Views/MainWindow.xaml");
  if (!/Payouts from Tími/.test(mainWindow) || !/Payouts\.Earnings\.Transfers/.test(mainWindow)) {
    throw new Error("apps/vet-windows/src/TimiVet/Views/MainWindow.xaml has no payouts panel, so a clinic on Windows cannot see what Tími has sent it.");
  }
  const api = await read("apps/vet-windows/src/TimiVet/Services/ClinicApiClient.cs");
  if (!/api\/clinic\/payouts/.test(api)) {
    throw new Error("apps/vet-windows/src/TimiVet/Services/ClinicApiClient.cs no longer calls /api/clinic/payouts.");
  }
}

// Clear() then Add() on every poll tells WPF that every row is gone, so the
// queue rebuilt itself every few seconds — taking the scroll position, the
// selection and the keyboard focus with it.
{
  const viewModel = await read("apps/vet-windows/src/TimiVet/ViewModels/MainViewModel.cs");
  const refresh = viewModel.slice(viewModel.indexOf("public async Task RefreshAsync"), viewModel.indexOf("private static void Merge"));
  if (/Requests\.Clear\(\)/.test(refresh) || /PendingRequests\.Clear\(\)/.test(refresh)) {
    throw new Error("apps/vet-windows/src/TimiVet/ViewModels/MainViewModel.cs: RefreshAsync empties its collections again. That is a full teardown of the queue on every poll, which resets scroll, selection and focus under whoever is reading it.");
  }
  const models = await read("apps/vet-windows/src/TimiVet/Models/ClinicModels.cs");
  if (!/class ClinicRequest : INotifyPropertyChanged/.test(models) || !/public void CopyFrom\(/.test(models)) {
    throw new Error("apps/vet-windows/src/TimiVet/Models/ClinicModels.cs: ClinicRequest cannot report its own changes, so merging in place leaves rows showing stale values.");
  }
}

const csharpFiles = await collectFiles("apps/vet-windows", ".cs");
for (const path of csharpFiles) {
  const problems = bracketProblems(await read(path));
  if (problems.length) throw new Error(`Unbalanced C# source ${path}: ${problems.join(", ")}`);
}

console.log(`Native client structure validated (${required.length} required files, ${expectations.length} behavioral contracts, ${swiftFiles.length} Swift and ${csharpFiles.length} C# sources balanced).`);
