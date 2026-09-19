// swift-tools-version: 5.9
import PackageDescription

// Deliberately dependency-free.
//
// The point of this app is to be a place to try layouts without the customer
// app's build being in the way: no Skip, no Mapbox, no Stripe, no Clerk, no
// network. It shares no code with apps/customer-mobile — the Tími colours and
// the card treatment are *copied* into LabTheme.swift rather than imported,
// because importing TimiNowUI would drag in the whole transpiled-for-Android
// dependency graph to draw six rectangles.
//
// The cost of that copy is that the two can drift. That is the right trade
// here: this is a sketchpad whose output is a JSON file, not a shipping
// surface, and a sketchpad that cannot build is worth nothing.
let package = Package(
    name: "layout-lab",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LayoutLabKit", type: .static, targets: ["LayoutLabKit"])
    ],
    targets: [
        .target(name: "LayoutLabKit")
    ]
)
