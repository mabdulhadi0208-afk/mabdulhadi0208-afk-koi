## Koi 2.0.2: smooth from the very first open

- **No more laggy first open.** When Koi had been sitting idle for five minutes or more, the first fan stuttered. macOS and Chromium were putting the hidden fan to sleep (slower cores, throttled timers, thrown-away frames). The fan now stays ready, and the first open is as smooth as every other one. Koi still uses no CPU while it waits.
- **Warms up as you reach for it.** The moment the first key of a modifier hotkey (like Command in Command + Option) goes down, Koi wakes the fan, so it is ready before the second key lands.
- **The bloom gets the whole Mac.** Koi refreshes your app list only after the fan has finished opening, never during it.

**Download:** [Apple Silicon](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-arm64.dmg) · [Intel](https://github.com/mabdulhadi0208-afk/mabdulhadi0208-afk-koi/releases/latest/download/Koi-mac-x64.dmg). Already on Koi? It updates itself.
