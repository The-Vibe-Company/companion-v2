// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CompanionKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CompanionKit", targets: ["CompanionKit"]),
    ],
    targets: [
        .target(name: "CompanionKit"),
        .testTarget(name: "CompanionKitTests", dependencies: ["CompanionKit"]),
    ]
)
