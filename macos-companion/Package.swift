// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AirlockCompanion",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "AirlockCompanion",
            path: "AirlockCompanion",
            exclude: ["Info.plist"]
        ),
        .testTarget(
            name: "AirlockCompanionTests",
            dependencies: ["AirlockCompanion"],
            path: "AirlockCompanionTests"
        )
    ]
)
