# Koi

A springy, fluid fan app switcher for macOS. Lives in the menu bar. Press **Option + Space** and your apps
bloom around the cursor in a glass fan: point at a wedge or type a letter, scroll for more, Return to launch.

- Opens instantly: the app list, icons and running dots are cached (icons on disk, keyed by app and version) and refresh in the background
- Real app icons, running-app dots, apps ranked by what you use most
- Lumen's design language: its palette, liquid glass and hero banners; a hub in the app's own colour, magnetic lens, jelly springs, quick actions (New window, Hide, Quit)
- Dark and light, four sizes, three speeds, glass sounds (off by default)
- Zero cost while closed: the fan window really hides, nothing loops or polls
- First launch plays a cinematic intro and a full tutorial (replay any time from the menu-bar icon)

## Install
**Download:** [Apple Silicon (M1 to M4)](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-arm64.dmg) · [Intel](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-x64.dmg)

Drag Koi to Applications. Koi is ad-hoc signed (not notarized by Apple). If macOS says it is "damaged" or can't be opened, double-click **Fix-Koi-if-damaged.command** in the DMG (or run `xattr -cr /Applications/Koi.app`), then open it.

## Hotkeys
Menu-bar icon, then **Hotkeys** lets you record your own shortcut for opening the fan, plus global hotkeys that jump straight to any app (for example Option S for Safari). Modifier-only hotkeys (hold Command and Option) need Accessibility permission; Koi's key hook runs in its own small process, only while such a hotkey is set, and only ever sees key codes.

## Develop, test, build
```
npm install
npm start          # run
npm test           # smoke test, updater end to end, and the speed and idle harness (xvfb on Linux)
npm run dist       # build DMGs and zips (on a Mac)
```
`tools/draw-tray.py` draws the menu-bar icon frames, `tools/make-sounds.py` makes the glass sounds.

## Releasing
Bump `version` in `package.json` and push to `main`. GitHub Actions builds both architectures, rebuilds the key hook so its macOS event tap only asks for key events (`build/patch-uiohook.js`), checks the signatures and versions, and publishes `v<version>` with `RELEASE_NOTES.md` as the notes. Pushes that do not change the version do not release.

## Auto-update
Koi looks at GitHub Releases on launch, after waking from sleep, when you open the menu-bar panel, and every 10 minutes (a single HEAD request). When a newer version is out it downloads `Koi-mac-<arch>.zip` in the background, verifies the version inside, and shows the update card. **Restart and update** swaps the app and relaunches it in about 3 seconds; if the new build does not start, the old one is put back.
