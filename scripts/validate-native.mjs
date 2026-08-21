import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  "apps/vet-windows/src/TimiVet/Services/AlertService.cs"
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

console.log(`Native client structure validated (${required.length} required files, ${expectations.length} behavioral contracts).`);
