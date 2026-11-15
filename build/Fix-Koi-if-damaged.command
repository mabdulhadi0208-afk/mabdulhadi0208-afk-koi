#!/bin/bash
# Run this once if macOS says Koi is "damaged" or "can't be opened".
APP="/Applications/Koi.app"
if [ ! -d "$APP" ]; then
  osascript -e 'display dialog "Drag Koi into your Applications folder first, then run this again." buttons {"OK"} default button 1 with icon caution'
  exit 0
fi
xattr -cr "$APP"
open "$APP"
osascript -e 'display notification "Koi is unlocked and opening." with title "Koi"'
