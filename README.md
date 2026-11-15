# Koi

A springy, fluid fan app switcher for macOS. Lives in the menu bar. Press **Option + Space** and your apps
bloom around the cursor in a frosted fan — hover, type a letter, scroll for more, Return to launch.

- Real app icons, running-app dots, apps ranked by what you use most
- Magnetic lens, jelly spring physics, quick actions (New window / Hide / Quit)
- Light / dark, sizes, speeds, sounds (off by default)
- First launch plays a cinematic intro + full tutorial (replay any time from the menu-bar icon)

## Install
**Download:** [Apple Silicon (M1/M2/M3/M4)](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-arm64.dmg) · [Intel](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-x64.dmg)

Download `Koi-mac-arm64.dmg` (Apple Silicon) or `Koi-mac-x64.dmg` (Intel) from Releases, drag Koi to Applications.
Koi is ad-hoc signed (not notarized by Apple). If macOS says it is "damaged" or can't be opened, double-click **Fix-Koi-if-damaged.command** in the DMG (or run `xattr -cr /Applications/Koi.app`), then open it.

## Hotkeys
Menu-bar icon → **Hotkeys…** lets you record your own shortcut for opening the fan, plus global hotkeys that jump straight to any app (e.g. ⌥S → Safari).

## Develop / build
```
npm install
npm start          # run
npm run dist       # build DMGs (on a Mac)
```
Releases are built by GitHub Actions: push a tag like `v1.0.0`.

## Auto-update
Koi checks GitHub Releases in the background (every 30 s, on launch, and after waking from sleep), downloads the new version, verifies it and shows a floating update card. One click on **Restart & update** swaps the app and relaunches it in about 3 seconds. Menu-bar icon → **Check for updates** forces a check.
