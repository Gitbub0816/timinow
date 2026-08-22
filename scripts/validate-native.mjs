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
    if (["bin", "obj", ".build", ".swiftpm", "node_modules"].includes(entry.name)) continue;
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
  "apps/vet-desktop/Sources/TimiVetCore/Skip/skip.yml",
  "apps/vet-desktop/Sources/TimiVetUI/Skip/skip.yml",
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

const csharpFiles = await collectFiles("apps/vet-windows", ".cs");
for (const path of csharpFiles) {
  const problems = bracketProblems(await read(path));
  if (problems.length) throw new Error(`Unbalanced C# source ${path}: ${problems.join(", ")}`);
}

console.log(`Native client structure validated (${required.length} required files, ${expectations.length} behavioral contracts, ${swiftFiles.length} Swift and ${csharpFiles.length} C# sources balanced).`);
