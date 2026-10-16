// SPDX-License-Identifier: GPL-2.0-or-later
// Long-lived X windows for XScreenSaver hacks to draw into (`-window-id`),
// owned by the window host process (windowHost.js).
//
// mutter 51 / Xwayland leaves a large X window's GPU buffers behind in
// gnome-shell whenever the window is destroyed or unmapped (~20-35 MB each), so
// a window per hack leaked on every change of screensaver: gigabytes after a
// day of rotation.  Windows from this pool are never destroyed or unmapped
// while the extension is enabled: a lease makes one fullscreen on a monitor,
// and releasing it shrinks it to one (transparent) pixel for the next lease.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HOST_ARGV = ['gjs', '-m'];
const TITLE_PREFIX = 'screensavers-host-';
// How long a lease waits for the host's window before giving up (the caller
// then lets the hack open its own window).
const LEASE_TIMEOUT_MS = 5000;
// How long a lease waits for the window to take the monitor's size.
const RESIZE_TIMEOUT_MS = 1000;
const PARKED = [0, 0, 1, 1];

export class WindowPool {
    /** @param {string} hostPath  path of windowHost.js */
    constructor(hostPath) {
        this._hostPath = hostPath;
        this._proc = null;
        this._slots = [];
        this._writes = Promise.resolve();
        this._windowCreatedId = global.display.connect('window-created',
            (_display, window) => this._onWindowCreated(window));
    }

    /** Windows the host has open (for tests). */
    get size() {
        return this._slots.length;
    }

    /**
     * A window covering `monitor`, for one hack.  Resolves to
     * {xid, window: Meta.Window, release()} or to null when the host can't
     * provide one.  Release only once the hack has exited, so two hacks never
     * draw into one window.
     */
    lease(monitor) {
        if (!this._ensureHost())
            return Promise.resolve(null);
        let slot = this._slots.find(s => !s.busy && s.window);
        if (!slot) {
            slot = {n: this._slots.length, xid: null, window: null, busy: false, waiters: []};
            this._slots.push(slot);
            this._send(`open ${slot.n} ${this._geometry(monitor)}`);
        }
        slot.busy = true;
        const proc = this._proc;
        return new Promise(resolve => {
            let done = false;
            let timeoutId = 0;
            const finish = ready => {
                if (done)
                    return;
                done = true;
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                if (!ready || this._proc !== proc) {
                    this._release(slot, proc);
                    resolve(null);
                    return;
                }
                this._fit(slot.window, monitor);
                this._fitted(slot, monitor, () => resolve({
                    xid: slot.xid,
                    window: slot.window,
                    release: () => this._release(slot, proc),
                }));
            };
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEASE_TIMEOUT_MS, () => {
                timeoutId = 0;
                console.warn('[screensavers] the window host did not provide a window in time');
                finish(false);
                return GLib.SOURCE_REMOVE;
            });
            if (slot.xid !== null && slot.window)
                finish(true);
            else
                slot.waiters.push(finish);
        });
    }

    destroy() {
        global.display.disconnect(this._windowCreatedId);
        this._stopHost();
    }

    // Fullscreen on the monitor: exact size, nothing in the way.
    _fit(window, monitor) {
        if (window.get_monitor() !== monitor.index)
            window.move_to_monitor(monitor.index);
        if (!window.is_fullscreen())
            window.make_fullscreen();
    }

    _geometry(monitor) {
        return [monitor.x, monitor.y, monitor.width, monitor.height].join(' ');
    }

    // Run `done` once the window has the monitor's size (or after a short
    // wait), so the hack starts at full size rather than at the parked 1x1.
    _fitted(slot, monitor, done) {
        const fits = () => {
            const rect = slot.window.get_frame_rect();
            return rect.width === monitor.width && rect.height === monitor.height;
        };
        if (fits()) {
            done();
            return;
        }
        let timeoutId = 0;
        let sizeId = 0;
        const finish = () => {
            slot.window.disconnect(sizeId);
            if (timeoutId)
                GLib.source_remove(timeoutId);
            done();
        };
        sizeId = slot.window.connect('size-changed', () => {
            if (fits())
                finish();
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE_TIMEOUT_MS, () => {
            timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    _release(slot, proc) {
        if (this._proc !== proc || !slot.busy)
            return;
        slot.busy = false;
        if (slot.window?.is_fullscreen())
            slot.window.unmake_fullscreen();
        this._send(`place ${slot.n} ${PARKED.join(' ')}`);
    }

    _ensureHost() {
        if (this._proc)
            return true;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            launcher.setenv('GDK_BACKEND', 'x11', true);
            this._proc = launcher.spawnv([...HOST_ARGV, this._hostPath]);
        } catch (e) {
            console.warn(`[screensavers] failed to start the window host: ${e.message}`);
            return false;
        }
        const proc = this._proc;
        this._cancellable = new Gio.Cancellable();
        this._pid = Number(proc.get_identifier());
        this._stdin = proc.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        this._writes = Promise.resolve();
        this._readLine(proc);
        proc.wait_async(this._cancellable, () => {
            if (this._proc !== proc)
                return;
            console.warn('[screensavers] the window host exited');
            this._dropHost();
        });
        return true;
    }

    _readLine(proc) {
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null || this._proc !== proc)
                return;
            const [word, n, xid] = line.trim().split(/\s+/);
            const slot = this._slots[Number(n)];
            if (word === 'window' && slot) {
                slot.xid = Number(xid);
                this._ready(slot);
            }
            this._readLine(proc);
        });
    }

    _onWindowCreated(window) {
        const title = window.get_title() ?? '';
        if (!this._proc || !title.startsWith(TITLE_PREFIX))
            return;
        const pid = window.get_pid();
        if (pid > 0 && pid !== this._pid)
            return;
        const slot = this._slots[Number(title.slice(TITLE_PREFIX.length))];
        if (!slot || slot.window)
            return;
        slot.window = window;
        this._ready(slot);
    }

    _ready(slot) {
        if (slot.xid === null || !slot.window)
            return;
        const waiters = slot.waiters;
        slot.waiters = [];
        waiters.forEach(finish => finish(true));
    }

    // Queue a command; writes go out one at a time, in order.
    _send(command) {
        const stdin = this._stdin;
        const bytes = new GLib.Bytes(new TextEncoder().encode(`${command}\n`));
        this._writes = this._writes.then(() => new Promise(resolve => {
            stdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
                try {
                    stream.write_bytes_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[screensavers] writing to the window host: ${e.message}`);
                }
                resolve();
            });
        }));
    }

    // Forget the host and its windows; pending leases resolve to null.
    _dropHost() {
        const slots = this._slots;
        this._proc = null;
        this._slots = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stdin = null;
        this._stdout = null;
        for (const slot of slots)
            slot.waiters.forEach(finish => finish(false));
    }

    _stopHost() {
        const proc = this._proc;
        this._dropHost();
        // Closing the windows here leaks their buffers once, at logout or when
        // the extension is turned off, not on every screensaver.
        proc?.force_exit();
    }
}
