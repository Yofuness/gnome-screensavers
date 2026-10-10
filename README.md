# Screensavers for GNOME

A GNOME Shell extension (GNOME 51, Wayland) that shows a screensaver **over the lock screen**,
whether you lock manually (Super+L) or the session auto-locks. The default is the macOS **Flurry**
screensaver: XScreenSaver's port of the original Flurry source, with all its presets. Any installed
**XScreenSaver** hack (about 250 of them) can run instead, or any program you add yourself.

- A **key press or click** stops the saver and shows the unlock prompt. Moving the mouse doesn't.
- The saver runs until GNOME's **Screen Blank** time (Settings ▸ Power), then the screen blanks
  as usual. With Screen Blank set to *Never*, it runs until you press a key. You can choose a fixed time
  instead in the extension's settings.
- Each monitor runs its own copy of the saver.

## Install

```sh
sudo pacman -S xscreensaver   # provides Flurry and the other hacks (only the hack programs are used)
make install                  # installs to ~/.local/share/gnome-shell/extensions and enables it
```

Then **log out and back in**; Wayland can't load a new extension into a running session. Settings
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
| `extension/registry.js` | Saver catalogue: Flurry presets and XScreenSaver hacks (read from `/usr/share/xscreensaver/config`), plus custom commands. |
| `extension/prefs.js` | Settings window. |
| `extension/debug.js` | Test-only D-Bus hooks, loaded only when `SCREENSAVERS_DEBUG=1`. |
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
- several XScreenSaver hacks render.

Choose which hacks to test with `HACKS="glmatrix pipes" make test`.
