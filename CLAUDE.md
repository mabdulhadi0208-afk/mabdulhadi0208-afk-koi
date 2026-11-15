# Koi — standing rules

**Every time Koi is updated, the cinematic intro/tutorial MUST be updated too** (`renderer/app.html`):
1. Add the new items to `WHATS_NEW` (shown in the "What's new" intro scene).
2. Add/adjust tutorial steps (`say('NN', ...)` in `tutorial()`) for any new or changed feature, and keep the `say()` progress denominator (currently 15) equal to the step count.
3. The version chip comes from `__KOI_VERSION__`, replaced in CI with `1.0.${run_number}`.
4. Copy `renderer/app.html` to the web artifact (`koi.html`) and republish.
