# Plan: switch Flurry to XScreenSaver's port of the original

## Context
The extension works in the real session: Flurry shows when locking, the screen doesn't blank early,
and a key press or click dismisses it. But the user still finds my hand-written Flurry clone's ribbons
too thin compared with macOS. They also pointed out that XScreenSaver already includes Flurry.

That's right. XScreenSaver's `flurry` hack is a port of Calum Robinson's original Flurry source, the
same code Apple shipped. It has the original presets: classic, rgb, fire, water, binary, psychedelic
and insane. The extension already runs XScreenSaver hacks through Xwayland and clones their windows,
and that path passed all its tests. So the right move is to use the real Flurry and retire the clone,
rather than keep tuning an approximation.

## Steps
1. **Verify first (gate).** In the headless test shell, preview `xscreensaver:flurry` with
   `--preset classic`, take screenshots 2 s apart, and compare them side by side against frames from
   the downloaded macOS video (`scratchpad/video/clip.mp4`, `clip2.mp4`). Check that the ribbon
   thickness, glow and motion match, and that it animates rather than smearing. The original fades its
   trails by drawing translucent black over the previous frame, which depends on the previous frame
   being kept; Xwayland/GLX might not do that, and the screenshots will show it. If it fails, stop and
   report back before changing anything else.
2. **Registry (`extension/registry.js`):** add saver ids `flurry:<preset>` that launch
   `/usr/lib/xscreensaver/flurry --preset <preset>`, using the preset list parsed from
   `/usr/share/xscreensaver/config/flurry.xml` (`<option ... arg-set="--preset X">`). Show these as
   "Flurry (Classic)" and so on at the top of the list. Keep the plain `xscreensaver:flurry` entry out of
   the list to avoid a duplicate. Keep the id format `flurry:classic`, so the user's current
   `saver` setting keeps working. Map the old clone's preset names: `rainbow` → `rgb` and
   `mono` → `classic`.
3. **Remove the clone:** delete `flurry.c` and the `flurry` binary; take out of the `Makefile` the
   Flurry build rule and the step that copies it into the extension's `bin/`; delete the now-unused
   `flurry-idle.py` and `flurry-idle.service`. If the `xscreensaver` package is missing, the registry
   simply lists no savers and the settings window says to install it.
4. **Tests (`tools/headless-test.sh`):** the saver-process checks currently match `bin/flurry --embed`;
   change them to `/usr/lib/xscreensaver/flurry`. Add the visual check from step 1 as a scenario. Run
   `make test` until everything passes.
5. **Docs:** update `README.md` (Flurry now comes from XScreenSaver's port of the original; xscreensaver
   becomes a dependency) and the schema default description.
6. **Install:** `make install`; the user logs out and back in (or reboots) to load it.

## Verification
- Step 1's side-by-side screenshots against the macOS reference frames. I look at these myself and
  include them in the report.
- `make test` passes in full: lock, mouse motion ignored, key/click dismiss, unlock, run time, auto-lock,
  crash, and the hacks.
- The user locks the real session and confirms the ribbons look like macOS.
