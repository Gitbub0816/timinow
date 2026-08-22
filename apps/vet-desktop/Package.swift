// swift-tools-version: 5.9
import PackageDescription

// No Skip here, deliberately. The veterinary console ships to macOS, and the
// clinic's other surfaces are the Windows client (apps/vet-windows) and the web
// console at providers.timinow.pet — there is no Android console and no plan
// for one. Carrying skipstone anyway meant every build transpiled this package
// to Kotlin first, which is minutes of work per build to produce something
// nothing consumes, and it is where a local build could wedge with no output.
//
// The customer app (apps/customer-mobile) is the one that genuinely needs Skip:
// it ships to iOS *and* Android from the same sources.
let package = Package(
    name: "timinow-vet-desktop",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    products: [
        // Only the product the Xcode project links — see the customer
        // package's Package.swift for why a same-named library product for
        // each target breaks the app build.
        //
        // Static, not dynamic. A dynamic product has to be embedded in
        // Contents/Frameworks or dyld cannot find it at launch: the app builds
        // and signs cleanly, then dies immediately with "Library not loaded:
        // @rpath/TimiVetApp.framework". Nothing here needs a separate dylib —
        // that was a requirement of Skip's Android bridge, which this package
        // no longer has — so linking the code straight into the executable
        // removes the failure rather than adding an embed phase to carry it.
        .library(name: "TimiVetApp", type: .static, targets: ["TimiVetApp"])
    ],
    targets: [
        .target(name: "TimiVetApp", dependencies: ["TimiVetUI", "TimiVetCore"]),
        .target(name: "TimiVetUI", dependencies: ["TimiVetCore"], resources: [.process("Resources")]),
        .target(name: "TimiVetCore"),
        .testTarget(name: "TimiVetCoreTests", dependencies: ["TimiVetCore"])
    ]
)
