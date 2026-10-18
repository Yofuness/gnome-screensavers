# Architecture

How the pieces fit together, who owns what, and the design rules that keep it consistent. The README
covers what the extension does for users; this file covers how it does it. Update it whenever a change
alters a flow, adds state, or adds a design rule.

## Two processes

| Process | Entry point | May import | Talks to the other through |
| --- | --- | --- | --- |
| GNOME Shell | `extension.js` | Clutter, Meta, St, Shell, Gio, GLib | GSettings (it reads settings; prefs writes `preview-request`) |
| Settings window | `prefs.js` | Gtk, Adw, Gdk, Gio, GLib | GSettings, and the history file (read-only) |
| Window host | `windowHost.js` (`gjs -m`, `GDK_BACKEND=x11`) | Gtk 3, GdkX11, Gio, GLib | stdin/stdout lines with `windowPool.js` in the shell |

Shared modules (`registry.js`, `history.js`) must work in both the shell and the settings window,
so they import only Gio and GLib. Nothing imports `windowHost.js`; the shell only runs it.

## Modules

- **`extension.js`, the conductor.** Lock-screen integration and every timer. Decides *when* a
  screensaver starts, which savers go on which monitors, and when it stops. Owns the current
  `SaverSession`, the history runs, the idle inhibitor, the re-trigger watch, rotation and stagger
  timers, and the handover between sessions.
- **`saverSession.js`, one screensaver on screen.**
  - Spawns the saver processes, finds their windows, and shows them through `Clutter.Clone`s inside an
    opaque black overlay above the lock screen.
  - Owns the input filter: dismiss, skip key, media keys.
  - Shows the info overlay, and swaps the saver on one monitor (`swapSlot`).
  - Knows nothing about settings or history; it reports back through callbacks (`onShown`,
    `onDismiss`, `onFailed`, `onSkip`).
- **`windowPool.js` + `windowHost.js`, long-lived windows for the hacks.** See "Why hacks draw into
  pooled windows" below.
  - `WindowPool` (shell) starts the host on the first lease and owns it until `disable()`.
  - `lease(monitor)` hands out a free window, opening a new one only when none is free, and makes
    it fullscreen on that monitor. It resolves to `{xid, window, release()}`, or to null if the
    host can't provide one; the hack then opens its own window as before.
  - `release()` (called only once the hack has exited, so two hacks never share a window)
    unfullscreens the window and shrinks it to 1×1. Windows are never destroyed or unmapped.
  - `windowHost.js` is a separate process, so it may use Gtk. It creates undecorated,
    skip-taskbar, fully transparent, click-through windows on request and exits when its stdin
    closes. Override-redirect windows would avoid the window manager, but mutter doesn't pick up
    OpenGL frames drawn into them.
- **`registry.js`, the catalogue and the choosing.**
  - Scans `/usr/share/xscreensaver/config/*.xml` asynchronously and parses each hack's options.
  - Merges in custom commands.
  - Applies per-hack corrections and additions from **`hackFixes.js`** (plain JS, shared by both
    processes): `options(list)` corrects the option list (options may have `when: values => bool`,
    which the options dialog uses to show or hide rows), and `args(values)` builds arguments that
    span several options. Vermiculate uses it for Style (built-in patterns, Custom, or your own
    instring), a working Drawing speed, and Pattern length (`-xrm *ticks:N`). `DEFAULT_VALUES`
    overrides defaults (sonar).
  - Every "Frame rate" slider (`--delay %`) gets a `matchDisplay` switch in front of it
    (`withMatchDisplay`); when on, the slider is hidden and skipped. OpenGL hacks get
    `--delay 0` (vsync paces them to exactly the refresh rate; a pause would add to the drawing
    time); 2D hacks, which have no vsync, get `--delay 1e6/Hz` per monitor. The Hz comes from the shell (`refreshRate` in extension.js: the
    Clutter stage view covering that monitor), since prefs can't use Clutter.
  - OpenGL hacks (`gl="yes"` in their XML) get an Anti-aliasing select first (`ANTIALIAS_OPTION`:
    default / on / off); "default" follows the `antialias` key. On adds
    `-xrm '*multiSample: true'` (`_antialiasArgs`).
  - Turns a saver id into a per-monitor launcher (`launch(monitor)` → argv, title, env, and
    `windowed` for XScreenSaver hacks, Flurry included: those get `-window-id` and a pooled window).
  - Picks what plays (`choose` / `chooseMany`) and owns the shuffle queue and in-order playlist
    position.
  - Also holds the pure helpers prefs uses: playlist import/export and option parsing.
- **`infoOverlay.js`:**
  - `InfoOverlay` draws the clock and now playing in a chosen corner and monitor, with burn-in drift
    and scaling.
  - `MediaWatcher` tracks MPRIS players over D-Bus, for display and for the media keys.
- **`imageConfig.js`, shell only.** Writes the private `.xscreensaver` (picture folder, no desktop
  grabs) under `~/.local/share/<uuid>/xscreensaver-home/`. `xscreensaver-getimage` only reads
  `~/.xscreensaver`, so XScreenSaver hacks (not custom commands) are started with `HOME` pointing
  there and the real XDG folders passed through (`Registry` `env`, `SaverSession._spawn`).
- **`history.js`.** `HistoryWriter` appends JSON lines asynchronously and trims to the limit;
  `parseHistory` reads them for the History page.
- **`prefs.js`, the settings window.** Pages: General, Playlists, Library, History, Custom. It writes
  settings and never runs savers itself: it asks the shell through `preview-request`.
- **`debug.js`, tests only.** D-Bus hooks for `tools/headless-test.sh`. It's loaded only when
  `SCREENSAVERS_DEBUG=1`, and `make zip` strips it.

## Saver ids

| Id | Meaning |
| --- | --- |
| `flurry:<preset>` | XScreenSaver's port of the macOS Flurry with a preset |
| `xscreensaver:<hack>` | any installed hack |
| `custom:<n>` | the n-th entry of `custom-savers` (`Name\|command`) |

Per-saver option values live in `saver-options` under `optionsKey(id)`. All Flurry presets share one
key.

## Main flows

**Lock → screensaver.**
1. GNOME calls `ScreenShield._activateFade`, which we wrap (`InjectionManager`). `_interceptFade`
   saves the fade as `_pendingFade` and calls `startSaver({onLock: true})`.
2. `_planSlots` asks the registry for ids and builds one *slot* per saver process, based on
   `monitor-mode`:
   - `mirror`: one slot on the primary, shown on every monitor;
   - `same`: one slot per monitor, all with the same id;
   - `different`: one slot per monitor, each its own pick.
3. A new `SaverSession` starts.
4. The extension takes the idle inhibitor, starts the run timer (display duration) and schedules
   rotation.

**Run time over.** `_stopSession({resumeFade: true})` runs GNOME's original fade, so the screen blanks
exactly as it would without the extension. A Preview can't blank, so it shows a notice instead
(`_endTest`).

**Dismiss (key or click).** The session reports `onDismiss`; the extension stops it and arms the
re-trigger idle watch if the screen is still locked. Unlocking stops everything and cancels the
re-trigger.

**Skip, or a timed change in mirror/same mode: a session-level handover.**
1. `startSaver({rotate: true})` creates a new *hidden* session (overlay opacity 0) above the old one,
   which becomes `_outgoing`.
2. When the new one's first window appears, its overlay fades in, and only once the fade has finished
   is the outgoing session stopped and logged.

**A screensaver that won't start** (every process exits, or no window within the timeout: e.g.
VidWhacker, which exits without a video to play): `onFailed` → `_retryFailed`. When the source
picks (`_fixedId` false), it starts another pick, up to `MAX_FAILED_STARTS` in a row; during a
handover the outgoing session stays on screen meanwhile. A preview of one specific saver, or the
last failed attempt, ends the run as before (`_stopSession({resumeFade: true})`).

**No timed change for the selected screensaver.** `_rotationSeconds` is 0 when the Source is
"Selected screensaver" (`sourceOf` in registry.js, shared with prefs, which greys out Change
screensaver for it). The skip key still moves on to a random pick.

**Timed change in different mode: per-monitor and staggered.** `_staggeredChange` swaps monitor 0
now, monitor 1 three seconds later, and so on, through `SaverSession.swapSlot`. That fades the new
saver in over the old one on that monitor only.

**Preview from the settings window.**
1. Prefs writes `"<id>#<timestamp>"` (or `@test#…` for the Preview button) to `preview-request`.
2. The shell starts a session with an input grab (on the desktop, keys would otherwise go to the
   focused app).

**Why hacks draw into pooled windows.** With mutter 51, Xwayland 24.1 and Mesa 26.2, every large X
window that is destroyed or unmapped leaves its GPU buffers behind in gnome-shell, about 20–35 MB
per 1080p window. This was measured through gnome-shell's DRM fdinfo (`drm-total-system0`) and
happens with any X client (xeyes, glxgears), not only hacks. With a window per hack, a night of
5-minute rotation on two monitors held 14.8 GB. Hacks now draw into windows from the pool:
1. `SaverSession._spawn` leases a window for `windowed` launches.
2. It starts the hack with `-window-id 0x…` and sets `entry.window` to the leased `Meta.Window`.
3. It attaches clones as usual. `_fit` is skipped, because the pool already made the window
   fullscreen.

Process exit, `_remove` and `stop()` release the lease once the process has gone (`_end`,
`_terminate`). Unmapping leaks too, so idle windows stay mapped, shrunk to one transparent pixel.
Custom commands still open their own windows.

## State in extension.js

| Field | Meaning |
| --- | --- |
| `_session` | the session that's on screen, or on its way in during a handover |
| `_outgoing` | `{session, runs, reason}` during a handover; stopped once the new session covers it |
| `_runs` | history records for `_session`: one, or one per monitor in different mode (`_perMonitor`) |
| `_onLock` / `_test` | what kind of run this is (lock screen, Preview button, or plain preview) |
| `_fixedId` / `_failedStarts` | whether this run shows one specific saver (no retries), and failed starts in a row |
| `_pendingFade` | GNOME's fade we took over; resumed when the run time ends |
| `_pool` | the `WindowPool`, from `enable()` to `disable()` (its host process starts on the first lease) |
| `_rotateId`, `_staggerIds`, `_runTimerId`, `_noticeTimerId` | timers; all removed in `_stopSession` |

## Design rules

These keep it cohesive, so follow them in new code.

1. **Never uncover the lock screen.** Anything on screen is removed only after its replacement fully
   covers it: session handover, `swapSlot`, and a repeated skip during a handover (it replaces only
   the incoming one).
2. **One place stops everything.** `_stopSession` (extension) and `SaverSession.stop()` remove every
   timer, filter, signal and process they own. A new timer or signal gets its removal there too. A leaked input
   filter once left the user stuck on the lock screen.
3. **The session is dumb, the extension decides.** `SaverSession` gets slots and callbacks; settings,
   history and choosing stay in `extension.js` and `registry.js`.
4. **Choosing goes through the registry.** Every pick goes through `choose` / `chooseMany`:
   - a playlist wins over random, and random wins over the selected saver;
   - shuffling is a queue, so nothing repeats until the pool has played, and a new round doesn't start
     with what's on screen;
   - `avoid` keeps different monitors apart.
5. **Settings live in one place.**
   - Every setting is a schema key, and is shown on the General page only.
   - Other pages manage *things*: playlists, the library, history, custom commands.
   - One concept gets one control (e.g. Source covers `random`, `random-pool` and `active-playlist`).
   - Choosing what plays (Source, Shuffle) is on General; playlists themselves only hold names and
     screensavers.
6. **Live where cheap.** Overlay size, corner and monitor apply to a running screensaver. Things that
   change what's running (source, monitor mode) apply from the next start.
7. **Never let a saver's X window close per screensaver.** Each one leaks its GPU buffers in
   gnome-shell (see above), so XScreenSaver hacks always draw into pooled windows.
8. **Never block the shell.** File IO is async; savers are separate processes that get SIGTERM, then a
   force kill after 1.5 s.
9. **Every behaviour has a headless test.** A new flow gets a scenario function in
   `tools/headless-test.sh` (2 monitors, 3840×1080), driven through `debug.js`. Rule 1 is tested
   directly: `Covered` counts the monitors that show an opaque saver, sampled through every kind of
   change.

## Settings keys by area

| Area | Keys |
| --- | --- |
| Lock screen | `enabled-on-lock`, `run-time`, `retrigger-delay` |
| Selection | `saver`, `random`, `random-pool`, `favorites` (shown as Favourites), `active-playlist`, `shuffle`, `playlists`, `rotate-interval`, `skip-key`, `monitor-mode` |
| Overlay | `show-clock`, `show-media`, `overlay-scale`, `overlay-corner`, `overlay-monitor` |
| Graphics | `antialias` (OpenGL hacks; per-hack override in `saver-options`) |
| Images | `image-directory` (written to the private `.xscreensaver`) |
| History | `log-history`, `history-limit` (file: `~/.local/share/<uuid>/history.jsonl`) |
| Library and custom | `saver-options` (JSON), `custom-savers` |
| Internal | `preview-request` |
