// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "timinow-vet-desktop",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    products: [
        // Only the product the Xcode project links — see the customer
        // package's Package.swift for why a same-named library product for
        // each target breaks the app build.
        .library(name: "TimiVetApp", type: .dynamic, targets: ["TimiVetApp"])
    ],
    dependencies: [
        .package(url: "https://source.skip.tools/skip.git", from: "1.7.0"),
        .package(url: "https://source.skip.tools/skip-ui.git", from: "1.29.3"),
        .package(url: "https://source.skip.tools/skip-model.git", from: "1.5.0"),
        .package(url: "https://source.skip.tools/skip-fuse-ui.git", from: "1.0.0"),
        .package(url: "https://source.skip.tools/skip-fuse.git", from: "1.0.2")
    ],
    targets: [
        .target(
            name: "TimiVetApp",
            dependencies: ["TimiVetUI", "TimiVetCore", .product(name: "SkipUI", package: "skip-ui")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiVetUI",
            dependencies: ["TimiVetCore", .product(name: "SkipFuseUI", package: "skip-fuse-ui")],
            resources: [.process("Resources")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiVetCore",
            dependencies: [
                .product(name: "SkipFuse", package: "skip-fuse"),
                .product(name: "SkipModel", package: "skip-model")
            ],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .testTarget(
            name: "TimiVetCoreTests",
            dependencies: ["TimiVetCore", .product(name: "SkipTest", package: "skip")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        )
    ]
)
