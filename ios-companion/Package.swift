// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AirlockCompanionIOS",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .executable(name: "AirlockCompanionIOS", targets: ["AirlockCompanionIOS"])
    ],
    targets: [
        .executableTarget(
            name: "AirlockCompanionIOS",
            path: "AirlockCompanionIOS",
            exclude: ["Info.plist", "AirlockCompanionIOS.entitlements"]
        )
    ]
)
