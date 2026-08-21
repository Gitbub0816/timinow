import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const required = [
  "apps/customer-mobile/Package.swift",
  "apps/customer-mobile/Darwin/project.yml",
  "apps/customer-mobile/Sources/TimiNowApp/Skip/skip.yml",
  "apps/customer-mobile/Sources/TimiNowUI/Skip/skip.yml",
  "apps/customer-mobile/Sources/TimiNowCore/Skip/skip.yml",
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
const [validator, gateway, onboarding, tracker, mini, alerts, clinicApi] = await Promise.all([
  read("apps/customer-mobile/Sources/TimiNowCore/ConcernValidator.swift"),
  read("apps/customer-mobile/Sources/TimiNowCore/APIClient.swift"),
  read("apps/customer-mobile/Sources/TimiNowUI/OnboardingView.swift"),
  read("apps/customer-mobile/Sources/TimiNowUI/OfferAndTrackerViews.swift"),
  read("apps/vet-windows/src/TimiVet/Views/MiniWindow.xaml"),
  read("apps/vet-windows/src/TimiVet/Services/AlertService.cs"),
  read("apps/vet-windows/src/TimiVet/Services/ClinicApiClient.cs")
]);

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

console.log(`Native client structure validated (${required.length} required files, ${expectations.length} behavioral contracts).`);
