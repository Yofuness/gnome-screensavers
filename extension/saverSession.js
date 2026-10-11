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
const ATTACH_RETRY_MS = 50;
const ATTACH_RETRIES = 100;
const SIGTERM = 15;

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
     * @param {(monitor: object) => {argv: string[], title?: string}} params.launch
     *   saver command for one monitor
     * @param {(reason: 'key'|'click') => void} params.onDismiss  called on key press / click
     * @param {() => void} params.onFailed   called when no saver window could be shown
     * @param {() => void} params.onShown    called once the first saver window is on screen
     * @param {() => void} params.onSkip     called when the skip key is pressed
     * @param {number} params.skipKeyval     the skip key (0 = none)
     * @param {boolean} params.hidden        start invisible and fade in once shown (rotation)
     * @param {boolean} params.grab          take an input grab (previews on the desktop)
     * @param {{showClock: boolean, showMedia: boolean, scale: number}} params.info
     */
    constructor({launch, onDismiss, onFailed, onShown, onSkip, skipKeyval, hidden, grab, info}) {
        this._launch = launch;
        this._onDismiss = onDismiss;
        this._onFailed = onFailed;
        this._onShown = onShown;
        this._onSkip = onSkip;
        this._skipKeyval = skipKeyval;
        this._hidden = hidden;
        this._wantGrab = grab;
        this._info = info;
        this._entries = [];
    }

    start() {
        this._cancellable = new Gio.Cancellable();

        // Opaque black overlay above everything (lock screen and its lightboxes).
        this._overlay = new St.Widget({
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
        // The watcher is needed even without the overlay, for the media keys.
        this.media = new MediaWatcher(() => this._infoBox?.syncMedia());
        if (this._info.showClock || this._info.showMedia) {
            this._infoBox = new InfoOverlay({
                monitor: Main.layoutManager.primaryMonitor,
                showClock: this._info.showClock,
                showMedia: this._info.showMedia,
                media: this.media,
                scale: this._info.scale,
            });
            this._overlay.add_child(this._infoBox.actor);
        }
        Main.layoutManager.uiGroup.set_child_above_sibling(this._overlay, null);
        // Lightboxes raise themselves when they fade in; keep the saver on top.
        this._raiseId = Main.layoutManager.uiGroup.connect('child-added', () =>
            Main.layoutManager.uiGroup.set_child_above_sibling(this._overlay, null));

        // On the desktop, key presses would go straight to the focused app window
        // and never reach the shell; a grab routes them to us.  (The lock screen
        // holds its own grab, so lock-time savers don't need one.)
        if (this._wantGrab)
            this._grab = Main.pushModal(this._overlay);

        // An event filter sees every input event before grabs route it, so it
        // works whatever the lock screen or unlock dialog has grabbed or focused.
        this._filterId = Clutter.Event.add_filter(global.stage, event => this._onEvent(event));

        this._windowCreatedId = global.display.connect('window-created',
            (_display, window) => this._onWindowCreated(window));

        for (const monitor of Main.layoutManager.monitors)
            this._spawn(monitor);

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_TIMEOUT_MS, () => {
            this._timeoutId = 0;
            if (!this._entries.some(e => e.clone)) {
                console.warn('[screensavers] no screensaver window appeared in time');
                this._onFailed();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Key presses and clicks dismiss; the skip key asks for the next saver;
    // media keys go to the player; pointer motion and scrolling pass through.
    _onEvent(event) {
        const type = event.type();
        const isKey = type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE;
        if (isKey && MEDIA_KEYS.has(event.get_key_symbol())) {
            if (type === Clutter.EventType.KEY_PRESS)
                this.media.command(MEDIA_KEYS.get(event.get_key_symbol()));
            return Clutter.EVENT_STOP;
        }
        if (isKey && this._skipKeyval && event.get_key_symbol() === this._skipKeyval) {
            if (type === Clutter.EventType.KEY_PRESS && !this._skipId) {
                // Leave the filter callback before starting the next saver.
                this._skipId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    this._skipId = 0;
                    this._onSkip();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS ||
            type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this._dismissId) {
                const reason = type === Clutter.EventType.KEY_PRESS ? 'key' : 'click';
                // Leave the filter callback before tearing down.
                this._dismissId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
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
    }

    _spawn(monitor) {
        const {argv, title} = this._launch(monitor);
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`[screensavers] failed to start ${argv[0]}: ${e.message}`);
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

        proc.wait_async(this._cancellable, (_proc, res) => {
            try {
                proc.wait_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            this._detach(entry);
            entry.proc = null;
            if (!this._entries.some(e => e.proc))
                this._onFailed();
        });
    }

    _onWindowCreated(window) {
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
        this._attachWhenReady(entry, 0);
    }

    // The window actor may not exist yet when window-created fires.  Before the
    // first frame the clone is simply empty, which shows as the black backdrop.
    _attachWhenReady(entry, tries) {
        if (entry.window.get_compositor_private()) {
            this._attach(entry);
            return;
        }
        if (tries >= ATTACH_RETRIES)
            return;
        entry.retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ATTACH_RETRY_MS, () => {
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
        const {monitor} = entry;
        entry.box = new St.Widget({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            clip_to_allocation: true,
        });
        entry.clone = new Clutter.Clone({source: entry.window.get_compositor_private()});
        entry.box.add_child(entry.clone);
        this._overlay.add_child(entry.box);
        if (this._infoBox)
            this._overlay.set_child_above_sibling(this._infoBox.actor, null);
        this._layout(entry);
        entry.sizeId = entry.window.connect('size-changed', () => this._layout(entry));
        entry.posId = entry.window.connect('position-changed', () => this._layout(entry));

        if (this._onShown) {
            if (this._hidden)
                this._overlay.ease({opacity: 255, duration: 800});
            this._onShown();
            this._onShown = null;
        }
    }

    // Place the clone so the window's frame exactly covers the monitor, scaling
    // when the program refused the requested size.
    _layout(entry) {
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

    /** A centred message on the primary monitor (used by the Test button). */
    showNotice(text) {
        const m = Main.layoutManager.primaryMonitor;
        const label = new St.Label({text, style_class: 'screensavers-notice', opacity: 0});
        this._overlay.add_child(label);
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(-1);
        label.set_position(m.x + Math.round((m.width - w) / 2), m.y + Math.round((m.height - h) / 2));
        label.ease({opacity: 255, duration: 400});
    }

    setInfoScale(scale) {
        this._infoBox?.setScale(scale);
    }

    /** Remove everything; the owner drops its reference afterwards. */
    stop() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._dismissId)
            GLib.source_remove(this._dismissId);
        this._dismissId = 0;
        if (this._skipId)
            GLib.source_remove(this._skipId);
        this._skipId = 0;
        this._cancellable.cancel();

        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        Clutter.Event.remove_filter(this._filterId);
        global.display.disconnect(this._windowCreatedId);
        Main.layoutManager.uiGroup.disconnect(this._raiseId);

        for (const entry of this._entries) {
            this._detach(entry);
            if (entry.proc)
                this._terminate(entry.proc);
        }
        this._entries = [];
        this._infoBox?.destroy();
        this._infoBox = null;
        this.media.destroy();
        this.media = null;
        this._overlay.destroy();
        this._overlay = null;
    }

    // SIGTERM now, SIGKILL if it is still running after the grace period.
    _terminate(proc) {
        proc.send_signal(SIGTERM);
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
