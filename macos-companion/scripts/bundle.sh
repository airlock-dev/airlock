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
VERSION_SOURCE="git"

if [ -n "${VERSION:-}" ]; then
    VERSION_TAG="$VERSION"
    VERSION_SOURCE="explicit"
else
    VERSION_TAG="$(git -C "$PROJECT_DIR" describe --tags --match 'companion-v*' --abbrev=0 2>/dev/null || true)"
fi

APP_VERSION="${VERSION_TAG#companion-v}"
if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" = "$VERSION_TAG" ]; then
    APP_VERSION="0.0.0"
fi

DISPLAY_VERSION="$APP_VERSION"
if [ "$VERSION_SOURCE" != "explicit" ] &&
    ! git -C "$PROJECT_DIR" describe --tags --match "companion-v$APP_VERSION" --exact-match >/dev/null 2>&1; then
    SHORT_SHA="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
    if [ -n "$SHORT_SHA" ] && [ "$APP_VERSION" != "0.0.0" ]; then
        DISPLAY_VERSION="${APP_VERSION}-dev+${SHORT_SHA}"
    else
        DISPLAY_VERSION="${APP_VERSION} (dev)"
    fi
fi

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
cat > "$CONTENTS/Info.plist" << PLIST
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
    <string>${APP_VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${APP_VERSION}</string>
    <key>AirlockCompanionDisplayVersion</key>
    <string>${DISPLAY_VERSION}</string>
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
echo "Version: $DISPLAY_VERSION"
echo ""
echo "Run with:"
echo "  open $APP_DIR"
echo "  # or: $MACOS/$APP_NAME"
