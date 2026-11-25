#!/bin/bash
# Builds Koi's window switcher helper (native/koi-switch.swift) as one universal binary: native/bin/koi-switch.
# macOS only (CI runs it on macos-latest). Any failure stops the release build: Koi 2.1 never ships without it.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin build
MIN=12.3
for arch in arm64 x86_64; do
  echo "== swiftc $arch"
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN" -module-name KoiSwitch \
    -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework ScreenCaptureKit \
    koi-switch.swift -o "build/koi-switch-$arch"
done
lipo -create build/koi-switch-arm64 build/koi-switch-x86_64 -output bin/koi-switch
chmod 755 bin/koi-switch
lipo -info bin/koi-switch
lipo -info bin/koi-switch | grep -q arm64 && lipo -info bin/koi-switch | grep -q x86_64 || { echo "::error::koi-switch is not universal"; exit 1; }
