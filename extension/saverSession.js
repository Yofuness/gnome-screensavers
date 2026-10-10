// SPDX-License-Identifier: GPL-2.0-or-later
// A running screensaver: one saver process per monitor, each shown through a
// live Clutter.Clone of its window.  Client windows are never painted on the
// lock screen, but a clone of one is, and the saver itself never receives
// input — the lock screen keeps it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {InfoOverlay, MediaWatcher} from './infoOverlay.js';

const WINDOW_TIMEOUT_MS = 8000;
const KILL_GRACE_MS = 1500;

// Media keys control the current player instead of dismissing the saver.
const MEDIA_KEYS = new Map([
    [Clutter.KEY_AudioPlay, 'PlayPause'],
    [Clutter.KEY_AudioPause, 'PlayPause'],
    [Clutter.KEY_AudioNext, 'Next'],
    [Clutter.KEY_AudioPrev, 'Previous'],
]);

// Savers asked to exit but not yet gone, with the timer that force-kills them.
// Module-level so the extension can clean them up in disable().
const stragglers = new Map();

/** Force-kill any saver still shutting down and drop its timer. */
export function killStragglers() {
    for (const [proc, id] of stragglers) {
        GLib.source_remove(id);
        proc.force_exit();
    }
    stragglers.clear();
}

export class SaverSession {
    /**
     * @param {object} params
     * @param {(monitor: object) => {argv: string[], env?: object, title?: string}} params.launch
     *   saver command for one monitor
     * @param {(reason: 'key'|'click') => void} params.onDismiss  called on key press / click
     * @param {() => void} params.onFailed   called when no saver window could be shown
     * @param {() => void} [params.onShown]  called once the first saver window is on screen
     * @param {boolean} [params.hidden]      start invisible and fade in once shown (rotation)
     * @param {boolean} [params.grab]        take an input grab (previews on the desktop)
     * @param {{showClock: boolean, showMedia: boolean}} [params.info]  overlay contents
     * @param {(msg: string) => void} params.log   progress messages
     * @param {(msg: string) => void} params.warn  problems
     */
    constructor({launch, onDismiss, onFailed, onShown, hidden = false, grab = false, info = {}, log, warn}) {
        this._wantGrab = grab;
        this._launch = launch;
        this._onDismiss = onDismiss;
        this._onFailed = onFailed;
        this._onShown = onShown ?? (() => {});
        this._hidden = hidden;
        this._info = info;
        this._log = log;
        this._warn = warn;
        this._entries = [];
        this._stopped = false;
    }

    get running() {
        return !this._stopped;
    }

    start() {
        // Opaque black overlay above everything (lock screen and its lightboxes).
        this._overlay = new St.Widget({
            name: 'screensaversOverlay',
            style: 'background-color: black;',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            opacity: this._hidden ? 0 : 255,
        });
        Main.layoutManager.uiGroup.add_child(this._overlay);

        // Clock and now-playing on the primary monitor, above the saver clones.
        this._media = new MediaWatcher(() => this._infoBox?.syncMedia());
        if (this._info.showClock || this._info.showMedia) {
            this._infoBox = new InfoOverlay({
                monitor: Main.layoutManager.primaryMonitor,
                showClock: !!this._info.showClock,
                showMedia: !!this._info.showMedia,
                media: this._media,
                scale: this._info.scale ?? 1,
            });
            this._overlay.add_child(this._infoBox.actor);
        }
        Main.layoutManager.uiGroup.set_child_above_sibling(this._overlay, null);
        // Lightboxes raise themselves when they fade in; keep the saver on top.
        this._raiseId = Main.layoutManager.uiGroup.connect('child-added', () => {
            if (this._overlay)
                Main.layoutManager.uiGroup.set_child_above_sibling(this._overlay, null);
        });

        // On the desktop, key presses would go straight to the focused app window
        // and never reach the shell; a grab routes them to us.  (The lock screen
        // holds its own grab, so lock-time savers don't need one.)
        if (this._wantGrab)
            this._grab = Main.pushModal(this._overlay);

        // An event filter sees every input event before grabs route it, so it
        // works whatever the lock screen or unlock dialog has grabbed or focused.
        // Only key presses and clicks dismiss; pointer motion and scrolling pass.
        this._filterId = Clutter.Event.add_filter(global.stage, event => {
            const type = event.type();
            if ((type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE) &&
                MEDIA_KEYS.has(event.get_key_symbol())) {
                if (type === Clutter.EventType.KEY_PRESS) {
                    this._log(`media key: ${MEDIA_KEYS.get(event.get_key_symbol())}`);
                    this._media.command(MEDIA_KEYS.get(event.get_key_symbol()));
                }
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.KEY_PRESS ||
                type === Clutter.EventType.BUTTON_PRESS ||
                type === Clutter.EventType.TOUCH_BEGIN) {
                if (!this._dismissed) {
                    this._dismissed = true;
                    const reason = type === Clutter.EventType.KEY_PRESS ? 'key' : 'click';
                    this._log(`dismissed by ${reason}`);
                    // Leave the filter callback before tearing down.
                    this._dismissId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                        this._dismissId = 0;
                        this._onDismiss(reason);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.KEY_RELEASE ||
                type === Clutter.EventType.BUTTON_RELEASE ||
                type === Clutter.EventType.TOUCH_END)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });

        this._windowCreatedId = global.display.connect('window-created',
            (_display, window) => this._onWindowCreated(window));

        for (const monitor of Main.layoutManager.monitors)
            this._spawn(monitor);

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_TIMEOUT_MS, () => {
            this._timeoutId = 0;
            if (!this._entries.some(e => e.clone)) {
                this._warn('no saver window appeared in time');
                this._onFailed();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _spawn(monitor) {
        const {argv, env = {}, title} = this._launch(monitor);
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        for (const [k, v] of Object.entries(env))
            launcher.setenv(k, v, true);
        let proc;
        try {
            proc = launcher.spawnv(argv);
        } catch (e) {
            this._warn(`failed to start ${argv.join(' ')}: ${e.message}`);
            return;
        }
        const entry = {
            monitor,
            proc,
            pid: Number(proc.get_identifier()),
            title,
            window: null,
            clone: null,
            box: null,
        };
        this._entries.push(entry);
        this._log(`started ${argv.join(' ')} (pid ${entry.pid}) for monitor ${monitor.index}`);

        proc.wait_async(null, () => {
            if (this._stopped)
                return;
            this._log(`saver pid ${entry.pid} exited`);
            this._detach(entry);
            entry.proc = null;
            if (!this._entries.some(e => e.proc))
                this._onFailed();
        });
    }

    _onWindowCreated(window) {
        if (this._stopped)
            return;
        const pid = window.get_pid();
        // Match by pid first; X11 programs that don't report one fall back to title.
        let entry = this._entries.find(e => !e.window && e.pid === pid);
        if (!entry) {
            const title = window.get_title() ?? '';
            entry = this._entries.find(e => !e.window && e.title && title.includes(e.title));
        }
        if (!entry)
            return;
        entry.window = window;
        // Mutter places new windows after this signal, so fit again once shown.
        entry.shownId = window.connect('shown', () => this._fit(entry));
        this._fit(entry);
        this._attachWhenReady(entry);
    }

    // The window actor may not exist yet when window-created fires.  Before the
    // first frame the clone is simply empty, which shows as the black backdrop.
    _attachWhenReady(entry, tries = 0) {
        if (this._stopped || entry.clone || !entry.window)
            return;
        if (entry.window.get_compositor_private()) {
            this._attach(entry);
            return;
        }
        if (tries > 100)
            return;
        entry.retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            entry.retryId = 0;
            this._attachWhenReady(entry, tries + 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Fullscreen on its own monitor: exact size, and no title bar on X11 windows.
    _fit(entry) {
        const {window, monitor} = entry;
        if (window.get_monitor() !== monitor.index)
            window.move_to_monitor(monitor.index);
        if (!window.is_fullscreen())
            window.make_fullscreen();
    }

    _attach(entry) {
        if (this._stopped || entry.clone)
            return;
        const actor = entry.window.get_compositor_private();
        if (!actor)
            return;
        const {monitor} = entry;
        entry.box = new St.Widget({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            clip_to_allocation: true,
        });
        entry.clone = new Clutter.Clone({source: actor});
        entry.box.add_child(entry.clone);
        this._overlay.add_child(entry.box);
        if (this._infoBox)
            this._overlay.set_child_above_sibling(this._infoBox.actor, null);
        this._layout(entry);
        entry.sizeId = entry.window.connect('size-changed', () => this._layout(entry));
        entry.posId = entry.window.connect('position-changed', () => this._layout(entry));
        this._log(`showing saver pid ${entry.pid} on monitor ${monitor.index}`);
        if (!this._shown) {
            this._shown = true;
            if (this._hidden)
                this._overlay.ease({opacity: 255, duration: 800});
            this._onShown();
        }
    }

    // Place the clone so the window's frame exactly covers the monitor, scaling
    // when the program refused the requested size.
    _layout(entry) {
        if (!entry.clone)
            return;
        const frame = entry.window.get_frame_rect();
        const buffer = entry.window.get_buffer_rect();
        if (frame.width <= 0 || frame.height <= 0)
            return;
        const sx = entry.monitor.width / frame.width;
        const sy = entry.monitor.height / frame.height;
        entry.clone.set_scale(sx, sy);
        entry.clone.set_position((buffer.x - frame.x) * sx, (buffer.y - frame.y) * sy);
    }

    _detach(entry) {
        if (entry.retryId)
            GLib.source_remove(entry.retryId);
        entry.retryId = 0;
        for (const key of ['sizeId', 'posId', 'shownId']) {
            if (entry[key])
                entry.window.disconnect(entry[key]);
            entry[key] = 0;
        }
        entry.box?.destroy();
        entry.box = null;
        entry.clone = null;
    }

    /** Snapshot of what is running, for the debug interface. */
    /** A centred message on the primary monitor (used by "Test lock screen"). */
    showNotice(text) {
        if (!this._overlay)
            return;
        const m = Main.layoutManager.primaryMonitor;
        const label = new St.Label({text, style_class: 'screensavers-notice', opacity: 0});
        this._overlay.add_child(label);
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(-1);
        label.set_position(m.x + Math.round((m.width - w) / 2), m.y + Math.round((m.height - h) / 2));
        label.ease({opacity: 255, duration: 400});
    }

    /** Resize the clock/media overlay of the running saver. */
    setInfoScale(scale) {
        this._info.scale = scale;
        this._infoBox?.setScale(scale);
    }

    /** Title of the track the overlay would show, for the debug interface. */
    mediaTitle() {
        return this._media?.current()?.title ?? null;
    }

    status() {
        return this._entries.map(e => ({
            pid: e.pid,
            monitor: e.monitor.index,
            alive: !!e.proc,
            window: !!e.window,
            shown: !!e.clone,
            frame: e.window ? (({x, y, width, height}) => ({x, y, width, height}))(e.window.get_frame_rect()) : null,
        }));
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._dismissId)
            GLib.source_remove(this._dismissId);
        this._dismissId = 0;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._filterId) {
            Clutter.Event.remove_filter(this._filterId);
            this._filterId = 0;
        }
        if (this._windowCreatedId)
            global.display.disconnect(this._windowCreatedId);
        if (this._raiseId)
            Main.layoutManager.uiGroup.disconnect(this._raiseId);
        for (const entry of this._entries) {
            this._detach(entry);
            if (entry.proc) {
                const proc = entry.proc;
                proc.send_signal(15);
                // Escalate if it ignores SIGTERM.
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KILL_GRACE_MS, () => {
                    stragglers.delete(proc);
                    proc.force_exit();
                    return GLib.SOURCE_REMOVE;
                });
                stragglers.set(proc, id);
                proc.wait_async(null, () => {
                    if (stragglers.get(proc) === id) {
                        GLib.source_remove(id);
                        stragglers.delete(proc);
                    }
                });
            }
        }
        this._entries = [];
        this._infoBox?.destroy();
        this._infoBox = null;
        this._media?.destroy();
        this._media = null;
        this._overlay?.destroy();
        this._overlay = null;
        this._log('stopped');
    }
}
