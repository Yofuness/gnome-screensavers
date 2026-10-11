# Screensavers for GNOME

Run classic **X11 screensavers on GNOME Wayland**, right over the lock screen. GNOME on Wayland has no
screensaver support, and the XScreenSaver collection (about 250 savers) was written for X11. This
extension runs those programs unmodified through Xwayland and shows them over the lock screen, whether
you lock manually (Super+L) or the session auto-locks.

I made this because I love **Flurry**, the screensaver that shipped with macOS. XScreenSaver includes a
port of the original Flurry source, with all its presets, and it's the default here. Any other
XScreenSaver hack, or any program you add yourself, can run instead.

- A **key press or click** stops the saver and shows the unlock prompt. Moving the mouse doesn't.
- The saver runs until GNOME's **Screen Blank** time (Settings ▸ Power), then the screen blanks
  as usual. With Screen Blank set to *Never*, it runs until you press a key. A fixed time can be set
  under General ▸ Display duration.
- Each monitor runs its own copy of the saver.
- **Per-screensaver settings**: the ⚙ button next to a screensaver in the Library opens its options (speed, density,
  colours and so on), generated from XScreenSaver's own config files.
- **Clock and now playing** in the top-left corner of the primary monitor, resizable from 50% to 200%.
  Media keys (play/pause/next/previous) control your player without stopping the screensaver.
- **Source** (General page): the screensaver selected in the Library, a random starred one, or a
  playlist.
- **Playlists**: named lists of screensavers, shuffled or played in order. Playlists can be exported to a file and
  imported again (or shared).
- **Change screensaver**: move on to the next one every few minutes.
- **Skip key** (Right arrow by default, configurable): jump to the next screensaver without
  dismissing it.
- **Resume after dismissal**: comes back after you dismiss it, once the lock screen has been left alone for a set time.
- **History**: a local log of which screensaver ran when, browsable in the settings window. Keeps the
  newest 2000 runs by default (configurable up to 1,000,000); can be turned off.
- **Test button** (top left of the settings window): run the whole lock-screen experience (random
  pick, overlay, run time, rotation) without locking.

## Install

```sh
sudo pacman -S xscreensaver   # provides Flurry and the other hacks (only the hack programs are used)
make install                  # installs to ~/.local/share/gnome-shell/extensions
```

Then **log out and back in** (Wayland can't load a new extension into a running session) and turn
it on in the Extensions app. Settings
are in the Extensions app (or `gnome-extensions prefs screensavers@yofuness.github.io`).

## How it works

Normal application windows are never drawn on the GNOME lock screen. The extension starts the saver
as an ordinary program (one per monitor), makes its window fullscreen on that monitor, and shows a
live **clone** of that window on top of the lock screen. The saver never receives input; the lock
screen keeps it, so it can't see your password. XScreenSaver hacks are X11 programs and run through
Xwayland.

GNOME normally fades to black right after locking, and that fade also tells the power daemon to blank.
The extension wraps that fade (`ScreenShield._activateFade`): it shows the saver instead, holds an idle
inhibitor while the saver runs, and when the run time is over it lets the original fade happen.

## Files

| Path | What |
| --- | --- |
| `extension/extension.js` | Lock-screen integration, run timer, idle inhibitor. |
| `extension/saverSession.js` | Spawns savers, finds their windows, clones them on screen, handles input. |
| `extension/infoOverlay.js` | Clock/date and now-playing overlay; MPRIS for the media keys. |
| `extension/history.js` | The optional run log (`~/.local/share/screensavers@yofuness.github.io/history.jsonl`). |
| `extension/registry.js` | Saver catalogue and per-hack options, read from `/usr/share/xscreensaver/config`, plus custom commands. |
| `extension/prefs.js` | Settings window. |
| `extension/debug.js` | Test-only D-Bus hooks, loaded only when `SCREENSAVERS_DEBUG=1`. |
| `tools/fake-mpris.py` | Fake media player used by the tests. |
| `.github/workflows/build.yml` | CI: ESLint, and builds the upload zip (attached to releases on `v*` tags). |
| `eslint.config.js` | GNOME's recommended ESLint rules (`npm install && npm run lint`). |
| `tools/headless-test.sh` | End-to-end tests in an isolated headless gnome-shell (`make test`). |

## Custom screensavers

Settings ▸ Custom: give a name and a command. The program must open a window; `%w` and `%h` are
replaced with the monitor size. For example: `/usr/lib/xscreensaver/glmatrix --density 80`.

## Testing

`make test` starts a throwaway headless GNOME Shell with its own D-Bus, dconf and data directories, so
your real session isn't touched. It then checks that:

- locking shows an animated saver on every monitor;
- mouse motion doesn't stop it, but a key press or click does;
- unlocking stops it;
- the run-time limit hands back to GNOME's blanking;
- auto-lock from idle works;
- a crashing saver is cleaned up;
- several XScreenSaver hacks render;
- per-screensaver settings reach the command line;
- the clock overlay shows, resizes live, and media keys reach the player without dismissing;
- rotation swaps savers without a gap;
- playlists play in order and loop, the skip key moves on without dismissing, and other keys still dismiss;
- the saver comes back after being dismissed, and not after unlocking;
- history is written and trimmed to its limit;
- the Test button's run ends with its notice and never locks.

Choose which hacks to test with `HACKS="glmatrix pipes" make test`.

## License

GPL-2.0-or-later, the same as GNOME Shell. See [LICENSE](LICENSE). XScreenSaver and its hacks are separate
programs with their own licenses; this extension only launches them.
