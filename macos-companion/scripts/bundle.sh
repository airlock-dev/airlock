#!/bin/bash
# Creates a minimal .app bundle from the SPM-built binary
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="AirlockCompanion"
APP_DIR="$PROJECT_DIR/.build/${APP_NAME}.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
BINARY="$PROJECT_DIR/.build/arm64-apple-macosx/debug/$APP_NAME"

# Build first
echo "Building $APP_NAME..."
cd "$PROJECT_DIR" && swift build 2>&1

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at $BINARY"
    exit 1
fi

# Create .app structure
rm -rf "$APP_DIR"
mkdir -p "$MACOS"

# Copy binary
cp "$BINARY" "$MACOS/$APP_NAME"

# Copy app icon
RESOURCES="$CONTENTS/Resources"
mkdir -p "$RESOURCES"
if [ -f "$PROJECT_DIR/AirlockCompanion/AppIcon.icns" ]; then
    cp "$PROJECT_DIR/AirlockCompanion/AppIcon.icns" "$RESOURCES/AppIcon.icns"
fi

# Create Info.plist
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AirlockCompanion</string>
    <key>CFBundleDisplayName</key>
    <string>Airlock Companion</string>
    <key>CFBundleIdentifier</key>
    <string>bot.airlock.companion</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>AirlockCompanion</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

# Create entitlements for notifications
cat > "$CONTENTS/Entitlements.plist" << 'ENTITLEMENTS'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
</dict>
</plist>
ENTITLEMENTS

# Ad-hoc sign the app so macOS grants notification permissions
echo "Signing..."
codesign --force --deep --sign - --entitlements "$CONTENTS/Entitlements.plist" "$APP_DIR"

echo "Built: $APP_DIR"
echo ""
echo "Run with:"
echo "  open $APP_DIR"
echo "  # or: $MACOS/$APP_NAME"
