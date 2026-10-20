# Screensavers for GNOME

Run classic **X11 screensavers on GNOME Wayland**, right over the lock screen. GNOME on Wayland has no
screensaver support, and the XScreenSaver collection (about 250 savers) was written for X11. This
extension runs those programs unmodified through Xwayland and shows them over the lock screen, whether
you lock manually (Super+L) or the session auto-locks. It works on GNOME 50 and 51.

I made this because I love **Flurry**, the screensaver that shipped with macOS. XScreenSaver includes a
port of the original Flurry source, with all its presets, and it's the default here. Any other
XScreenSaver hack, or any program you add yourself, can run instead.

- A **key press or click** stops the saver and shows the unlock prompt. Moving the mouse doesn't.
- The saver runs until GNOME's **Screen Blank** time (Settings ▸ Power), then the screen blanks
  as usual. With Screen Blank set to *Never*, it runs until you press a key. A fixed time can be set
  under General ▸ Display duration.
- **Multiple monitors** (General ▸ Screensaver selection):
  - *Mirrored* (default): one screensaver shown identically on every monitor, in sync.
  - *Same screensaver*: a separate copy on each monitor.
  - *Different on each*: each monitor gets its own pick from the source, like XScreenSaver's
    `random` mode. Skip changes all of them; timed changes go one monitor at a time.
- **Per-screensaver settings**: the ⚙ button next to a screensaver in the Library opens its options (speed, density,
  colours and so on), generated from XScreenSaver's own config files. Screensavers with a Frame rate
  slider also get **Match display refresh rate**, which draws one frame per refresh of the monitor
  they're on.
- **Anti-aliasing** for 3D (OpenGL) screensavers: on by default; switch it off for all of them on General, and
  overridable per screensaver in its ⚙ settings (some look better without it).
- **Discrete graphics card** (General): on laptops with two GPUs (NVIDIA Optimus, AMD hybrid),
  render screensavers on the faster one. Needs `switcheroo-control`; costs battery.
- **Clock and now playing** in any corner of any monitor (top left of the primary by default),
  resizable from 25% to 200%.
  Media keys (play/pause/next/previous) control your player without stopping the screensaver.
- **Source** (General page): the screensaver selected in the Library, a random one of your
  **Favourites** (the ★ in the Library), a random one of **all** screensavers, or a playlist, with a
  **Shuffle** switch for playlists (shuffled plays every screensaver once before any repeats).
- **Playlists**: named lists of screensavers. Playlists can be exported to a file and imported
  again (or shared).
- **Change screensaver**: move on to the next one every few minutes.
- **Skip key** (Right arrow by default, configurable): jump to the next screensaver without
  dismissing it.
- **Resume after dismissal**: comes back after you dismiss it, once the lock screen has been left alone for a set time.
- **History**: a local log of which screensaver ran when, browsable in the settings window. Keeps the
  newest 2000 runs by default (configurable up to 1,000,000); can be turned off.
- **Images**: choose a picture folder for the screensavers that show pictures (Jigsaw, Distort,
  GLSlideshow, Photo Pile…). The extension keeps its own private copy of XScreenSaver's image settings,
  so your `~/.xscreensaver` is never touched, and desktop snapshots are always off.
- **Preview button** (top left of the settings window): run the whole lock-screen experience (random
  pick, overlay, run time, rotation) without locking.

## Install

First install XScreenSaver's screensaver programs (Flurry and the 3D ones are in the OpenGL package).
Only the programs are used, never the XScreenSaver daemon.

| System | Command |
| --- | --- |
| Arch, EndeavourOS, Manjaro | `sudo pacman -S xscreensaver` |
| Fedora Workstation | `sudo dnf install xscreensaver-extras xscreensaver-gl-extras` |
| Bazzite, Silverblue and other image-based Fedora | `rpm-ostree install xscreensaver-extras xscreensaver-gl-extras`, then restart |
| Debian, Ubuntu, Mint | `sudo apt install xscreensaver-data-extra xscreensaver-gl-extra` |

Install XScreenSaver on the system itself: a copy in a toolbox or distrobox container isn't found. If
it's missing, the settings window says so and shows the command for your system.

Then install the extension:

```sh
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

XScreenSaver hacks don't open windows of their own. They draw (`-window-id`) into a few long-lived,
invisible windows owned by a small helper process (`windowHost.js`). GNOME 51 keeps the GPU memory of
every large X window that closes, roughly 25 MB a time, and a fresh window per screensaver added up
to gigabytes after a day of rotation. Custom commands still open their own windows.

GNOME normally fades to black right after locking, and that fade also tells the power daemon to blank.
The extension wraps that fade (`ScreenShield._activateFade`): it shows the saver instead, holds an idle
inhibitor while the saver runs, and when the run time is over it lets the original fade happen.

## Files

| Path | What |
| --- | --- |
| `extension/extension.js` | Lock-screen integration, run timer, idle inhibitor. |
| `extension/saverSession.js` | Spawns savers, finds their windows, clones them on screen, handles input. |
| `extension/windowPool.js` | Hands out long-lived windows for the hacks to draw into, so no window closes per screensaver. |
| `extension/windowHost.js` | The helper process (GJS, Gtk 3 on X11) that owns those windows. |
| `extension/infoOverlay.js` | Clock/date and now-playing overlay; MPRIS for the media keys. |
| `extension/gpu.js` | Asks switcheroo-control for the discrete GPU's environment (PRIME offload). |
| `extension/history.js` | The optional run log (`~/.local/share/screensavers@yofuness.github.io/history.jsonl`). |
| `extension/imageConfig.js` | Private `.xscreensaver` for the picture folder; hacks get it through their `HOME`. |
| `extension/hackFixes.js` | Per-hack corrections to XScreenSaver's option lists (e.g. Vermiculate's styles and custom worms). |
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
- mirrored, same and different monitor modes (including staggered timed changes);
- per-screensaver settings reach the command line;
- the clock overlay shows, resizes and moves corner/monitor live, and media keys reach the player without dismissing;
- rotation swaps savers without a gap;
- playlists play in order and loop, the skip key moves on without dismissing, and other keys still dismiss;
- the saver comes back after being dismissed, and not after unlocking;
- history is written and trimmed to its limit;
- the Preview button's run ends with its notice and never locks.

It also checks that no monitor is ever left uncovered (lock screen or desktop showing through) during
skips, mashed skips, rotation and staggered changes.

`make test-gnome50` runs the same suite against GNOME Shell 50, in a Fedora 44 container (needs
Docker). The container has no systemd, so `tools/gnome50/fake-logind.js` stands in for logind and GDM
on its system bus, answering like the real ones do for the test shell's made-up session.

Choose which hacks to test with `HACKS="glmatrix pipes" make test`, or run only some scenarios with
`SCENARIOS="monitors overlay" make test` (scenario names are listed in `tools/headless-test.sh`). The
pixel checks need `python-numpy`.

## License

GPL-2.0-or-later, the same as GNOME Shell. See [LICENSE](LICENSE). XScreenSaver and its hacks are separate
programs with their own licenses; this extension only launches them.
