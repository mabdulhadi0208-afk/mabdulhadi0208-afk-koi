# Koi: standing rules

**Every time Koi is updated, the cinematic intro and tutorial MUST be updated too** (`renderer/app.html`):
1. Rewrite `WHATS_NEW` (the "What is new" scene) with only that version's changes.
2. Add or adjust tutorial steps (`say('NN', ...)` in `tutorial()`) for any new or changed feature, and keep `STEPS` (currently 14) equal to the step count.
3. The version chip comes from the `v` query the app passes in, and from `__KOI_VERSION__`, which CI replaces with the `package.json` version.
4. Copy `renderer/app.html` to the web artifact (`koi.html`) and republish.

Speed and idle rules: the fan opens from memory and never waits on a scan, `ps` or icon extraction; only transform and
opacity animate; spring loops stop when settled; nothing loops, polls or animates while Koi is closed. `npm test` checks these.
No emojis anywhere in the app.
