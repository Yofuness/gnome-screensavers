// SPDX-License-Identifier: GPL-2.0-or-later
// Window host: a small separate process (run with `gjs -m`, GDK_BACKEND=x11)
// that owns the X windows XScreenSaver hacks draw into (`-window-id`).
//
// Why: with mutter 51 / Xwayland, every large X window that is destroyed or
// unmapped leaves its GPU buffers behind in gnome-shell (~20-35 MB each).  A
// hack per window leaked that on every change of screensaver.  These windows
// are created once and stay mapped for as long as the extension is enabled:
// in use the shell makes them fullscreen on a monitor, idle they shrink to one
// pixel.  They're never seen directly: fully transparent (the shell's clones
// paint them opaque), click-through, undecorated, and left out of the
// overview, Alt+Tab, the dash and attention notifications (skip-taskbar).
// (Override-redirect windows would be simpler, but mutter doesn't pick up
// OpenGL frames drawn into them.)
//
// Protocol, one command per line on stdin:
//   open <n> <x> <y> <w> <h>   create window n (answers "window <n> <xid>")
//   place <n> <x> <y> <w> <h>  move and resize window n, and paint it black
// The host exits when stdin closes, so it never outlives the shell.
// It is never imported by the shell or the preferences window.

import cairo from 'cairo';
import GdkX11 from 'gi://GdkX11?version=3.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';

Gtk.init(null);

const windows = new Map();
const output = new Gio.DataOutputStream({base_stream: new GioUnix.OutputStream({fd: 1})});
const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0})});

function open(n, [x, y, width, height]) {
    const window = new Gtk.Window({
        type: Gtk.WindowType.TOPLEVEL,
        title: `screensavers-host-${n}`,
        app_paintable: true,
        decorated: false,
        skip_taskbar_hint: true,
        skip_pager_hint: true,
        accept_focus: false,
        focus_on_map: false,
        opacity: 0,
    });
    window.set_keep_below(true);
    window.connect('realize', () => window.input_shape_combine_region(new cairo.Region()));
    window.connect('draw', (_window, cr) => {
        cr.setSourceRGB(0, 0, 0);
        cr.paint();
        cr.$dispose();
        return true;
    });
    window.move(x, y);
    window.resize(width, height);
    window.show();
    windows.set(n, window);
    const xid = GdkX11.X11Window.prototype.get_xid.call(window.get_window());
    output.put_string(`window ${n} ${xid}\n`, null);
}

function place(n, [x, y, width, height]) {
    const window = windows.get(n);
    if (!window)
        return;
    window.move(x, y);
    window.resize(width, height);
    window.queue_draw();
}

function handle(line) {
    const [command, n, ...rest] = line.trim().split(/\s+/);
    const geometry = rest.map(Number);
    if (geometry.length !== 4 || geometry.some(v => !Number.isFinite(v)))
        return;
    if (command === 'open' && !windows.has(n))
        open(n, geometry);
    else if (command === 'place')
        place(n, geometry);
}

function readLine() {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
        let line = null;
        try {
            [line] = stream.read_line_finish_utf8(res);
        } catch {
            line = null;
        }
        if (line === null) {
            Gtk.main_quit();
            return;
        }
        handle(line);
        readLine();
    });
}

readLine();
Gtk.main();
