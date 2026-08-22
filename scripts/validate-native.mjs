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
  [validator, "words.count < 8", "concern detail threshold"],
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
if (gateway.includes("LocalizedError") || gateway.includes("errorDescription")) throw new Error("Swift-only LocalizedError overrides cannot be translated by Skip.");
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

const csharpFiles = await collectFiles("apps/vet-windows", ".cs");
for (const path of csharpFiles) {
  const problems = bracketProblems(await read(path));
  if (problems.length) throw new Error(`Unbalanced C# source ${path}: ${problems.join(", ")}`);
}

console.log(`Native client structure validated (${required.length} required files, ${expectations.length} behavioral contracts, ${swiftFiles.length} Swift and ${csharpFiles.length} C# sources balanced).`);
