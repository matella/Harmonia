// swift-tools-version: 5.9
// Shared date rules and widget snapshot contract for the iOS widget extension, the
// watchOS app and its complications. Test on any Mac with: cd ios/HarmoniaCore && swift test
import PackageDescription

let package = Package(
    name: "HarmoniaCore",
    platforms: [.iOS(.v15), .watchOS(.v9), .macOS(.v12)],
    products: [
        .library(name: "HarmoniaCore", targets: ["HarmoniaCore"]),
    ],
    targets: [
        .target(name: "HarmoniaCore"),
        .testTarget(name: "HarmoniaCoreTests", dependencies: ["HarmoniaCore"]),
    ]
)
