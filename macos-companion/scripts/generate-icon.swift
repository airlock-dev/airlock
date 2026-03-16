#!/usr/bin/env swift
// Generates an AppIcon.icns from the lock.shield SF Symbol
import AppKit

let sizes: [(CGFloat, String)] = [
    (16, "16x16"),
    (32, "16x16@2x"),
    (32, "32x32"),
    (64, "32x32@2x"),
    (128, "128x128"),
    (256, "128x128@2x"),
    (256, "256x256"),
    (512, "256x256@2x"),
    (512, "512x512"),
    (1024, "512x512@2x"),
]

func renderIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    // Dark background with rounded corners
    let bgRect = NSRect(x: 0, y: 0, width: size, height: size)
    let cornerRadius = size * 0.2
    let bgPath = NSBezierPath(roundedRect: bgRect, xRadius: cornerRadius, yRadius: cornerRadius)
    NSColor(calibratedRed: 0.12, green: 0.13, blue: 0.17, alpha: 1.0).setFill()
    bgPath.fill()

    // Draw the SF Symbol in white
    let symbolPointSize = size * 0.75
    let config = NSImage.SymbolConfiguration(pointSize: symbolPointSize, weight: .medium)
        .applying(.init(paletteColors: [.white]))
    if let symbol = NSImage(systemSymbolName: "lock.shield", accessibilityDescription: nil)?
        .withSymbolConfiguration(config) {
        let symbolSize = symbol.size
        let origin = NSPoint(
            x: (size - symbolSize.width) / 2,
            y: (size - symbolSize.height) / 2
        )
        symbol.draw(at: origin, from: .zero, operation: .sourceOver, fraction: 1.0)
    }

    image.unlockFocus()
    return image
}

// Get output directory from args
let outputDir: String
if CommandLine.arguments.count > 1 {
    outputDir = CommandLine.arguments[1]
} else {
    outputDir = "."
}

// Create iconset directory
let iconsetPath = "\(outputDir)/AppIcon.iconset"
let fm = FileManager.default
try? fm.removeItem(atPath: iconsetPath)
try fm.createDirectory(atPath: iconsetPath, withIntermediateDirectories: true)

// Render each size
for (size, name) in sizes {
    let image = renderIcon(size: size)
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let pngData = bitmap.representation(using: .png, properties: [:])
    else {
        print("Failed to render \(name)")
        continue
    }
    let filePath = "\(iconsetPath)/icon_\(name).png"
    try pngData.write(to: URL(fileURLWithPath: filePath))
}

// Convert iconset to icns
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconsetPath, "-o", "\(outputDir)/AppIcon.icns"]
try process.run()
process.waitUntilExit()

if process.terminationStatus == 0 {
    print("Generated \(outputDir)/AppIcon.icns")
    try? fm.removeItem(atPath: iconsetPath)
} else {
    print("iconutil failed with status \(process.terminationStatus)")
}
