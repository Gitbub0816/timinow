// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "timinow-customer",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14), .macCatalyst(.v17)],
    products: [
        .library(name: "TimiNowApp", type: .dynamic, targets: ["TimiNowApp"]),
        .library(name: "TimiNowUI", type: .dynamic, targets: ["TimiNowUI"]),
        .library(name: "TimiNowCore", type: .dynamic, targets: ["TimiNowCore"])
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
            name: "TimiNowApp",
            dependencies: ["TimiNowUI", "TimiNowCore", .product(name: "SkipUI", package: "skip-ui")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiNowUI",
            dependencies: ["TimiNowCore", .product(name: "SkipFuseUI", package: "skip-fuse-ui")],
            resources: [.process("Resources")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiNowCore",
            dependencies: [
                .product(name: "SkipFuse", package: "skip-fuse"),
                .product(name: "SkipModel", package: "skip-model")
            ],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .testTarget(
            name: "TimiNowCoreTests",
            dependencies: ["TimiNowCore", .product(name: "SkipTest", package: "skip")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        )
    ]
)
