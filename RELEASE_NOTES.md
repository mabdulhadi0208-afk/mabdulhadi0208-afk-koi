## Koi 2.0.1: Command + Option works again

- **Modifier-only hotkeys work again.** Command + Option (and any other modifier-only hotkey) opens the fan again, the instant both keys are down. In 2.0.0 the key listener ran in a separate helper process that could not hear the keys on macOS; it now runs inside Koi again, as it did in 1.x.
- **Never stuck.** A key release macOS loses (sleep, password fields) can no longer jam your hotkey until you restart Koi.
- **A permission card that fixes itself.** If macOS forgets Koi's Accessibility permission after an update (System Settings can still show Koi switched on), Koi shows a card with the exact steps and a button that opens the right page. The hotkey turns back on the moment you are done, no restart.
- **Koi notices when it goes deaf.** If keys stop reaching Koi, it quietly restarts its key listener, and only asks you when that is not enough.

**If Command + Option does nothing after updating:** open System Settings, Privacy and Security, Accessibility, select Koi, click the minus button, then click plus and add Koi from Applications again. Koi picks it up by itself.

**Download:** [Apple Silicon](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-arm64.dmg) · [Intel](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-x64.dmg). Already on Koi? It updates itself.
