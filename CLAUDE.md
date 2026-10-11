# CLAUDE.md

GNOME Shell 51 extension (`screensavers@yofuness.github.io`) that shows XScreenSaver hacks over the
lock screen. See README.md for features, architecture and the file table.

## Commands
- `make all` builds into `build/`; `make install` installs to ~/.local (the user must log out and back in
  for extension.js changes; prefs.js changes only need the settings window reopened).
- `make test` runs the end-to-end suite in an isolated headless gnome-shell. It must print `ALL OK`.
- `npm run lint` (run `npm install` first if `@eslint/js` is missing). CI runs it too.
- `make zip` builds the upload zip; it strips `debug.js`.

## Headless shell for manual checks / screenshots
- Run `make all` first: the shell copies the extension from `build/`, not `extension/`.
- `export SCREENSAVERS_TEST_DIR=<scratch dir>; tools/headless-test.sh start`, then export
  `DBUS_SESSION_BUS_ADDRESS=$(cat $SCREENSAVERS_TEST_DIR/bus)`, `XDG_RUNTIME_DIR=/tmp/sstest-$UID`,
  `WAYLAND_DISPLAY=wayland-sstest`, `XDG_CONFIG_HOME=$SCREENSAVERS_TEST_DIR/config` and
  `XDG_DATA_HOME=$SCREENSAVERS_TEST_DIR/data`.
- Then run `dbus-update-activation-environment` with those variables, and open the settings window
  with `gnome-extensions prefs screensavers@yofuness.github.io`.
- Drive it with `tools/headless-test.sh call ClickAt X Y`, `call KeyVal N` and `shot file.png`
  (the screen is 3840x1080 with two monitors; the settings window's tabs are at y≈148). Set
  settings with `dconf write /org/gnome/shell/extensions/screensavers/...`.
- The shell is zsh: unquoted `$var` doesn't word-split.
- Stop the shell with `tools/headless-test.sh stop`. The test shell uses a fake `XDG_SESSION_ID`, so
  it never touches the real logind session.

## GNOME 51 gotchas
- `Clutter.keyval_from_name` doesn't exist. The skip key is stored as a keyval (`u`).
- `Gio.File.make_directory_with_parents_async` doesn't exist. Use `make_directory_async`.
- Use async Gio file IO only (extensions.gnome.org review requirement).
- Any exception in the lock path can leave the user stuck locked. Guard it, and make sure sessions are
  always stopped (an earlier bug leaked input filters that swallowed keys).

## Settings window (prefs.js)
- Pages in this order: General, Playlists, Library, History, Custom. Each page has one job: settings
  live only on General, and History is view-only.
- `monitor-mode`: "mirror" runs one process on the primary and clones its window onto every monitor
  (cover-scaled); "same" runs a copy per monitor; "different" gives each monitor its own pick
  (`registry.chooseMany`), with staggered timed changes via `SaverSession.swapSlot`. The test suite
  starts in "same" mode because most scenarios count one process per monitor.
- General ▸ Source is a single control over the `random` and `active-playlist` keys
  (`registry.choose()`: a playlist wins over random, random over the selected `saver`).

## Releases
- After each change, the user asks for a semver bump of `version-name` in `extension/metadata.json`,
  plus release notes in Markdown.
- The user tags `v*` themselves; CI then attaches the zip to the release.
- Commit and push to `main` (the user's normal workflow), then `make install`.

## extensions.gnome.org
- **Every change must follow the review guidelines**: see
  [docs/extension-guidelines.md](docs/extension-guidelines.md) (each rule and how this project meets
  it). The ones most easily broken:
  - everything created in `enable()` (actors, signals, timeouts, idle sources, processes) is undone in
    `disable()`; nothing GObject-based at module scope;
  - no Gtk/Gdk/Adw in shell code; no Clutter/Meta/St/Shell in `prefs.js` or the modules it imports;
  - no imaginary APIs: check that a GNOME 51 API exists (typelib or docs) before using it;
  - no debug logging; only `console.warn` for real failures;
  - test-only code lives in `debug.js` or between `// BEGIN DEBUG` / `// END DEBUG`, which `make zip`
    strips;
  - keyboard handling on the lock screen exists only while a screensaver is shown;
  - new settings go in the schema.
- Version 0.2.2 was rejected; the compliance clean-up went into 0.2.4. The author must be able to
  explain the code, and AI assistance should be disclosed honestly.
- Shexli flags `shell-version` 51; this is explained in the review notes.
