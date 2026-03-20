// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AirlockCompanion",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/smittytone/HighlighterSwift.git", from: "3.0.0")
    ],
    targets: [
        .executableTarget(
            name: "AirlockCompanion",
            dependencies: [
                .product(name: "Highlighter", package: "HighlighterSwift")
            ],
            path: "AirlockCompanion",
            exclude: ["Info.plist", "Entitlements.plist", "AppIcon.icns"]
        ),
        .testTarget(
            name: "AirlockCompanionTests",
            dependencies: ["AirlockCompanion"],
            path: "AirlockCompanionTests"
        )
    ]
)
