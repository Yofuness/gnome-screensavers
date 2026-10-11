# extensions.gnome.org review guidelines

A summary of the official rules
(<https://gjs.guide/extensions/review-guidelines/review-guidelines.html>, checked 2026-10-11) and how
this extension meets each one. Check every change against this list before it ships. If the official
page changes, update this file.

## Lifecycle: enable() / disable()

| Rule | How this extension meets it |
| --- | --- |
| Nothing created or modified before `enable()`. At import and in the constructor, only static data (`Map`, `RegExp`, constants) is allowed; GObjects (`Gio.Settings`, `St.Widget`, …) are not. | Module scope in `extension.js`, `saverSession.js`, `registry.js` and `infoOverlay.js` holds only constants. `stragglers` in `saverSession.js` is a plain `Map` that `killStragglers()` empties in `disable()`. |
| Everything `enable()` creates is undone in `disable()`: destroy objects, disconnect signals, remove main-loop sources (even ones that would stop on their own). | `disable()` stops the session, which destroys the actors, removes the input filter and timeouts, and kills the processes. It also cancels the re-trigger watch, disconnects `connectObject` signals and clears the `InjectionManager`. **Every new `GLib.timeout_add` / `idle_add` / `connect` needs a matching removal on the stop path.** |
| No `GObject.Object.run_dispose()` unless unavoidable, and then with a comment saying why. | Not used. |

## Imports and code

| Rule | How this extension meets it |
| --- | --- |
| No deprecated modules: `ByteArray` (use `TextDecoder`), `Lang` (use classes and `bind`), `Mainloop` (use `GLib.timeout_add`). | ESM only; `TextDecoder` for file contents. |
| No `Gdk`, `Gtk` or `Adw` in the shell process. | Only `prefs.js` imports them. |
| No `Clutter`, `Meta`, `St` or `Shell` in prefs. | `prefs.js` and what it imports (`registry.js`, `history.js`) must stay free of them. **Keep shared modules shell-free.** |
| Readable code: not minified or obfuscated. ESLint is recommended. | `npm run lint` with GNOME's rules; CI runs it. |
| No excessive logging: only important messages and errors. | Only `console.warn` for real failures (a saver that won't start, a D-Bus error). **No debug logging in shipped code.** |
| Don't modify or interact with other extensions or the extension system. | Not done. |

## AI-generated code

The rule: AI may be used as a tool, but the developer must be able to explain every line. Code is
rejected for:
- excessive or unnecessary code;
- inconsistent style;
- **imaginary APIs**;
- comments that read like LLM prompts.

For this project that means:
- **Verify every GNOME API exists in GNOME 51** before using it, for example by grepping the typelib
  with `strings /usr/lib/mutter-51/Meta-51.typelib`. `Clutter.keyval_from_name` and
  `make_directory_with_parents_async` were both imaginary, and both were caught by the tests.
- Comments explain *why*, briefly; they never address an assistant.
- No defensive `try/catch` or code paths that nothing needs.
- Match the existing style.

## Subprocesses and files

| Rule | How this extension meets it |
| --- | --- |
| External scripts and binaries are discouraged; none may be bundled. Spawn processes carefully and make sure they exit. | Only the user's installed XScreenSaver hacks and their own custom commands run, through `Gio.Subprocess`. They get SIGTERM, then a force kill after 1.5 s (`_terminate`), and `killStragglers()` in `disable()`. |
| Privileged subprocesses: avoid them; if one is unavoidable, use `pkexec` on a file the user can't write. | None. (Sonar's ping privileges are left to the user; sonar defaults to simulation mode.) |
| Installing from pip / npm / … only through explicit user action. | Nothing is installed. `node_modules` is for linting only and is not in the zip. |
| File IO (project rule, from review feedback): async only in the shell. | `history.js` and `registry.js` use the `*_async` Gio calls. |

## Session modes

| Rule | How this extension meets it |
| --- | --- |
| Use `unlock-dialog` only if the extension needs to run on the lock screen. | It does: showing the screensaver over the lock screen is the whole point. |
| `disable()` must have a comment explaining why `unlock-dialog` is used. | At the top of `disable()` in `extension.js`. **Keep it.** |
| Disconnect keyboard-event signals in `unlock-dialog` mode. | The input filter only exists while a screensaver is shown, and is removed in `SaverSession.stop()`. Its job is to turn a key press into dismissal, skip, or media control, never to read typed text. The password field belongs to the lock screen and the filter is gone before it appears. **Don't add keyboard handling that outlives a session.** |
| Extensions must not disable selectively (e.g. only some parts on lock). | `disable()` tears everything down. |

## metadata.json

- Well-formed, accurate, no unnecessary keys.
- `uuid` is `screensavers@yofuness.github.io` (allowed characters only; not a `gnome.org` namespace).
- No `version` key: extensions.gnome.org sets it. Use `version-name` for our own semver.
- `shell-version` lists only released stable versions, plus at most one development release. No
  future versions. (Shexli flags `51`; this is explained in the review notes.)
- `url` points to the GitHub repo.
- `session-modes` lists `user` and `unlock-dialog`; both are needed.
- No `donations` key unless it's actually used.
- Description: a reasonable length, with `\n` paragraph breaks.

## GSettings

- The schema id starts with `org.gnome.shell.extensions`, and the path with `/org/gnome/shell/extensions/`.
- The file is named `<schema-id>.gschema.xml` and the XML is included in the zip.
- **Every new key goes in that schema**, with a summary.

## Privacy and content

- No telemetry. Nothing leaves the computer. History is a local file in `~/.local/share`.
- Clipboard access must be declared. Not used.
- Names, text and screenshots follow the GNOME Code of Conduct. No political content.
- No copyrighted or trademarked media without permission. XScreenSaver's hacks are launched, never
  bundled.

## Licensing

- GPL-2.0-or-later (`LICENSE`, plus an SPDX header in every source file).
- Code copied from another extension needs attribution to its author in the shipped files.

## The zip (`make zip`)

- Only what's needed at runtime: the JS, `metadata.json`, `stylesheet.css` and the schema XML.
- Leave out tests, tools, `node_modules`, build scripts, `.po` files and unused media.
- `debug.js` and the `// BEGIN DEBUG … END DEBUG` blocks are stripped by `make zip`. **Any new
  test-only code must sit inside those markers or in `debug.js`.**
- Before uploading, unzip it and check the contents.

## Recommended

- Follow the GNOME HIG in preferences (Adwaita rows and pages, sentence-case labels).
- Keep the code consistent and easy to review.
