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
        .library(name: "CompanionNotificationAvatar", targets: ["CompanionNotificationAvatar"]),
    ],
    targets: [
        .target(name: "CompanionKit"),
        .target(name: "CompanionNotificationAvatar", dependencies: ["CompanionKit"]),
        .testTarget(name: "CompanionKitTests", dependencies: ["CompanionKit"]),
        .testTarget(
            name: "CompanionNotificationAvatarTests",
            dependencies: ["CompanionNotificationAvatar"]
        ),
    ]
)
