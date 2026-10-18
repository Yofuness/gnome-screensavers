# CLAUDE.md

GNOME Shell 50 and 51 extension (`screensavers@yofuness.github.io`) that shows XScreenSaver hacks over the
lock screen. See README.md for features, and **[docs/architecture.md](docs/architecture.md) for how
the modules fit together, the main flows, the state, and the design rules**. Read it before changing
behaviour, and update it when a change alters a flow, adds state, or adds a rule.

## Commands
- `make all` builds into `build/`; `make install` installs to ~/.local (the user must log out and back in
  for extension.js changes; prefs.js changes only need the settings window reopened).
- `make test` runs the end-to-end suite in an isolated headless gnome-shell (about 2.5 min). It must
  print `ALL OK`. While iterating, run only the relevant scenarios with
  `SCENARIOS="monitors playlists" make test`, but **always run the full suite before committing**.
- Tests wait on conditions (`check_within`, `wait_for`) rather than fixed sleeps. Fixed sleeps are
  only for checks that something does *not* happen, or that time passes. A new behaviour gets a
  scenario function in `tools/headless-test.sh`; a screen-coverage property is checked with
  `watch_covered` / `covered` (debug `Covered`: monitors showing an opaque saver).
- `make test-gnome50` runs the same suite against GNOME Shell 50 (Fedora 44 container, Docker; about
  4 min, plus a few minutes the first time to build the image). **Run it too before committing a
  change to shell code**: both versions are supported. Hack paths differ (Fedora: `/usr/libexec`), so
  tests use `$HACK_DIR`.
- `npm run lint` (run `npm install` first if `@eslint/js` is missing). CI runs it too.
- `make zip` builds the upload zip; it strips `debug.js`.

## Headless shell for manual checks / screenshots
- Run `make all` first: the shell copies the extension from `build/`, not `extension/`.
- `export SCREENSAVERS_TEST_DIR=<scratch dir>`, then `tools/headless-test.sh prefs` starts the shell
  (if needed) and opens the settings window. `tools/headless-test.sh start` starts the shell only.
- For `dconf` on the test shell, export `DBUS_SESSION_BUS_ADDRESS=$(cat $SCREENSAVERS_TEST_DIR/bus)`
  and `XDG_CONFIG_HOME=$SCREENSAVERS_TEST_DIR/config`.
- Hot corners are off in the test shell: the virtual pointer starts in the top-left corner, and its
  first move used to open the overview, which swallowed clicks.
- Drive it with `tools/headless-test.sh call ClickAt X Y`, `call KeyVal N` and `shot file.png`
  (the screen is 3840x1080 with two monitors; the settings window's tabs are at y≈148). Set
  settings with `dconf write /org/gnome/shell/extensions/screensavers/...`.
- The shell is zsh: unquoted `$var` doesn't word-split.
- In tests, look at saver processes only through `saver_pids` / `saver_cmdlines`, which match by the
  test shell's `XDG_RUNTIME_DIR` in each process's environment. An unscoped `pgrep -f` also matches
  other shells whose command line mentions the path. Savers run in their own session (`setsid`), and
  what they fork may be re-parented, so neither session nor parent identifies them.
- XScreenSaver hacks accept `-xrm '*resource: value'` for internal settings their config doesn't
  expose; check a hack's source for the resource name before relying on it.
- Stop the shell with `tools/headless-test.sh stop`. The test shell uses a fake `XDG_SESSION_ID`, so
  it never touches the real logind session.

## GNOME 50/51 gotchas
- Every large X window that closes or unmaps leaks its GPU buffers inside gnome-shell (~20–35 MB each;
  a mutter/Xwayland bug). Hacks therefore draw into long-lived windows from `windowPool.js` via
  `-window-id`; never go back to a window per hack. Measure on the real session with
  gnome-shell's `/proc/<pid>/fdinfo/<render fd>` `drm-total-system0`. The headless shell can't
  show the leak (its Xwayland uses shm buffers).
- Override-redirect windows don't work for this: mutter doesn't pick up OpenGL frames drawn into them.
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
- General ▸ Source is a single control over the `random`, `random-pool` and `active-playlist` keys
  (`registry.choose()`: a playlist wins over random, random over the selected `saver`). Shuffle is the
  global `shuffle` key, on General, not part of a playlist.
- UI wording: starred screensavers are called **Favourites** (the key stays `favorites`; the star icon
  stays).

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
  - no imaginary APIs: check that an API exists in **both GNOME 50 and 51** (typelib or docs) before
    using it; the GNOME 50 container has the 50 typelibs (`/usr/lib64/mutter-18/`);
  - no debug logging; only `console.warn` for real failures;
  - test-only code lives in `debug.js` or between `// BEGIN DEBUG` / `// END DEBUG`, which `make zip`
    strips;
  - keyboard handling on the lock screen exists only while a screensaver is shown;
  - new settings go in the schema.
- Version 0.2.2 was rejected; the compliance clean-up went into 0.2.4. The author must be able to
  explain the code, and AI assistance should be disclosed honestly.
- Shexli flags `shell-version` 51; this is explained in the review notes.
