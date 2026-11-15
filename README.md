# Koi

A springy, fluid fan app switcher for macOS. Lives in the menu bar. Press **Option + Space** and your apps
bloom around the cursor in a frosted fan — hover, type a letter, scroll for more, Return to launch.

- Real app icons, running-app dots, apps ranked by what you use most
- Magnetic lens, jelly spring physics, quick actions (New window / Hide / Quit)
- Light / dark, sizes, speeds, sounds (off by default)
- First launch plays a cinematic intro + full tutorial (replay any time from the menu-bar icon)

## Install
Download `Koi-mac-arm64.dmg` (Apple Silicon) or `Koi-mac-x64.dmg` (Intel) from Releases, drag Koi to Applications.
The build is unsigned, so the first time: right-click Koi → Open (or `xattr -cr /Applications/Koi.app`).

## Develop / build
```
npm install
npm start          # run
npm run dist       # build DMGs (on a Mac)
```
Releases are built by GitHub Actions: push a tag like `v1.0.0`.
