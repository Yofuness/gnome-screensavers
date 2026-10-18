// SPDX-License-Identifier: GPL-2.0-or-later
// A running screensaver: saver processes shown through live Clutter.Clones of
// their windows — one process per monitor, or one process mirrored onto every
// monitor.  XScreenSaver hacks draw into windows leased from a WindowPool.  Client windows are never painted on the
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
const FADE_MS = 800;
// A saver counts as shown only once it has kept running this long after
// fading in.  A hack drawing into a pooled window is on screen before it has
// proved it works; one that exits straight away (VidWhacker without videos)
// must leave the saver it was replacing in place.
const SHOWN_GRACE_MS = 1000;

// Media keys control the current player instead of dismissing the saver.
const MEDIA_KEYS = new Map([
    [Clutter.KEY_AudioPlay, 'PlayPause'],
    [Clutter.KEY_AudioPause, 'PlayPause'],
    [Clutter.KEY_AudioNext, 'Next'],
    [Clutter.KEY_AudioPrev, 'Previous'],
]);

// Savers asked to exit but not yet gone: {id, pid}, with the timer that
// force-kills them.  Module-level so the extension can clean them up in
// disable().
const stragglers = new Map();

/** Force-kill any saver still shutting down and drop its timer. */
export function killStragglers() {
    for (const [proc, {id, pid}] of stragglers) {
        GLib.source_remove(id);
        proc.force_exit();
        signalGroup(pid, 'KILL');
    }
    stragglers.clear();
}

// Every saver runs in its own process group (started through `setsid`), as
// XScreenSaver runs its hacks, so stopping one also stops the processes it
// forked: Map Scroller's tile loader outlived it otherwise.  GLib can't signal
// a process group, so util-linux's kill does.  A group that is already gone
// is not an error.
function signalGroup(pid, signal) {
    if (!pid)
        return;
    try {
        Gio.Subprocess.new(['kill', '-s', signal, '--', `-${pid}`], Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        console.warn(`[screensavers] signalling saver ${pid}: ${e.message}`);
    }
}

export class SaverSession {
    /**
     * @param {object} params
     * @param {{monitor: object, id: string,
     *   launch: (monitor: object) => {argv: string[], title?: string, windowed?: boolean},
     *   mirror?: boolean}[]} params.slots
     *   one saver process each: started on `monitor`, and shown on every
     *   monitor when `mirror` is set; `windowed` ones get `-window-id` and a
     *   window from `pool`
     * @param {import('./windowPool.js').WindowPool|null} params.pool
     * @param {(reason: 'key'|'click') => void} params.onDismiss  called on key press / click
     * @param {() => void} params.onFailed   called when no saver window could be shown
     * @param {() => void} params.onShown    called once the first saver window is on screen
     * @param {() => void} params.onSkip     called when the skip key is pressed
     * @param {number} params.skipKeyval     the skip key (0 = none)
     * @param {boolean} params.hidden        start invisible and fade in once shown (rotation)
     * @param {boolean} params.grab          take an input grab (previews on the desktop)
     * @param {{showClock: boolean, showMedia: boolean, scale: number}} params.info
     */
    constructor({slots, pool, onDismiss, onFailed, onShown, onSkip, skipKeyval, hidden, grab, info}) {
        this._slots = slots;
        this._pool = pool;
        this._onDismiss = onDismiss;
        this._onFailed = onFailed;
        this._onShown = onShown;
        this._onSkip = onSkip;
        this._skipKeyval = skipKeyval;
        this._hidden = hidden;
        this._wantGrab = grab;
        this._info = info;
        this._entries = [];
        this._graceIds = new Set();
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

        // Clock and now-playing in a corner of one monitor, above the saver clones.
        // The watcher is needed even without the overlay, for the media keys.
        this.media = new MediaWatcher(() => this._infoBox?.syncMedia());
        if (this._info.showClock || this._info.showMedia) {
            this._infoBox = new InfoOverlay({
                monitor: this._info.monitor,
                corner: this._info.corner,
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

        this._slots.forEach((slot, index) => this._spawn(slot, index));

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_TIMEOUT_MS, () => {
            this._timeoutId = 0;
            if (!this._entries.some(e => e.views.length)) {
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

    // Start the saver for one slot.  `pending` entries (a per-monitor swap)
    // fade in over the entry they replace and call onShown once they cover it.
    // XScreenSaver hacks draw into a window leased from the pool (see
    // windowPool.js); without one they open their own, as other savers do.
    _spawn(slot, index, {pending = false, onShown = null} = {}) {
        const {monitor, id, launch, mirror} = slot;
        const {argv, title, env, windowed} = launch(monitor);
        const entry = {
            index,
            id,
            monitor,
            targets: mirror ? [...Main.layoutManager.monitors] : [monitor],
            proc: null,
            pid: 0,
            lease: null,
            title,
            window: null,
            views: [],
            pending,
            onShown,
        };
        this._entries.push(entry);
        if (!windowed || !this._pool) {
            this._startProcess(entry, argv, env);
            return;
        }
        this._pool.lease(monitor).then(lease => {
            if (!this._entries.includes(entry)) {
                lease?.release();
                return;
            }
            entry.lease = lease;
            if (!lease) {
                this._startProcess(entry, argv, env);
                return;
            }
            if (!this._startProcess(entry, [...argv, '-window-id', `0x${lease.xid.toString(16)}`], env))
                return;
            entry.window = lease.window;
            this._attachWhenReady(entry, 0);
        });
    }

    // Returns false when the program couldn't be started (the entry is gone).
    _startProcess(entry, argv, env) {
        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            for (const [name, value] of Object.entries(env ?? {}))
                launcher.setenv(name, value, true);
            // setsid execs the saver in place (same pid), as a new group.
            proc = launcher.spawnv(['setsid', ...argv]);
        } catch (e) {
            console.warn(`[screensavers] failed to start ${argv[0]}: ${e.message}`);
            this._entries = this._entries.filter(other => other !== entry);
            entry.lease?.release();
            entry.lease = null;
            return false;
        }
        entry.proc = proc;
        entry.pid = Number(proc.get_identifier());

        proc.wait_async(this._cancellable, (_proc, res) => {
            try {
                proc.wait_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            this._detach(entry);
            entry.proc = null;
            signalGroup(entry.pid, 'KILL');  // anything it forked
            entry.lease?.release();
            entry.lease = null;
            // A replacement that died just goes; the saver it was meant to
            // replace stays on screen.
            if (entry.pending) {
                this._entries = this._entries.filter(e => e !== entry);
                return;
            }
            if (!this._entries.some(e => e.proc))
                this._onFailed();
        });
        return true;
    }

    /**
     * Replace the saver of one slot (a per-monitor change), fading the new one
     * in over the old.  A swap requested while one is still on its way in
     * replaces only that one.  onShown runs once the new saver covers the old.
     */
    swapSlot(index, {id, launch}, onShown) {
        const waiting = this._entries.find(e => e.index === index && e.pending);
        if (waiting)
            this._remove(waiting);
        const current = this._entries.find(e => e.index === index && !e.pending);
        const slot = {...this._slots[index], id, launch};
        this._slots[index] = slot;
        this._spawn(slot, index, {
            pending: true,
            onShown: entry => {
                entry.pending = false;
                if (current)
                    this._remove(current);
                onShown();
            },
        });
    }

    // Take an entry off screen and stop its process.
    _remove(entry) {
        this._entries = this._entries.filter(e => e !== entry);
        this._detach(entry);
        this._end(entry);
    }

    // Stop an entry's process; its leased window goes back to the pool once
    // the process has exited, so no two hacks ever draw into one window.
    _end(entry) {
        if (entry.proc)
            this._terminate(entry.proc, entry.pid, entry.lease);
        else
            entry.lease?.release();
        entry.proc = null;
        entry.lease = null;
    }

    /** The saver id shown in each slot (for status and tests). */
    get ids() {
        return this._slots.map(s => s.id);
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
        const actor = entry.window.get_compositor_private();
        for (const monitor of entry.targets) {
            const box = new St.Widget({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                clip_to_allocation: true,
                opacity: entry.pending ? 0 : 255,
            });
            const clone = new Clutter.Clone({source: actor});
            box.add_child(clone);
            this._overlay.add_child(box);
            entry.views.push({monitor, box, clone});
        }
        if (this._infoBox)
            this._overlay.set_child_above_sibling(this._infoBox.actor, null);
        this._layout(entry);
        entry.sizeId = entry.window.connect('size-changed', () => this._layout(entry));
        entry.posId = entry.window.connect('position-changed', () => this._layout(entry));

        if (entry.pending) {
            // Above the saver it replaces, fading in; that one goes only once
            // this one fully covers it.
            const shown = entry.onShown;
            entry.onShown = null;
            entry.views.forEach(({box}, i) => box.ease({
                opacity: 255,
                duration: FADE_MS,
                onComplete: i === 0 ? () => this._afterGrace(entry, () => shown(entry)) : undefined,
            }));
            return;
        }

        if (this._onShown) {
            const shown = this._onShown;
            this._onShown = null;
            // Fading in over the outgoing saver: it may only go once this one
            // fully covers it, or the lock screen shows through the fade.
            if (this._hidden)
                this._overlay.ease({opacity: 255, duration: FADE_MS, onComplete: () => this._afterGrace(entry, shown)});
            else
                this._afterGrace(entry, shown);
        }
    }

    // Run `done` once the entry has kept running for SHOWN_GRACE_MS; if its
    // process exits first, the exit handler deals with it instead.
    _afterGrace(entry, done) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOWN_GRACE_MS, () => {
            this._graceIds.delete(id);
            if (entry.proc && this._entries.includes(entry))
                done();
            return GLib.SOURCE_REMOVE;
        });
        this._graceIds.add(id);
    }

    // Place each clone so the window's frame covers its monitor.  On the saver's
    // own monitor that's an exact fit (scaling when the program refused the
    // requested size); a mirror on a monitor of another shape is scaled to
    // cover it, centred and cropped, so nothing is stretched.
    _layout(entry) {
        const frame = entry.window.get_frame_rect();
        const buffer = entry.window.get_buffer_rect();
        if (frame.width <= 0 || frame.height <= 0)
            return;
        for (const {monitor, clone} of entry.views) {
            let sx = monitor.width / frame.width;
            let sy = monitor.height / frame.height;
            let ox = 0, oy = 0;
            if (monitor !== entry.monitor) {
                sx = Math.max(sx, sy);
                sy = sx;
                ox = (monitor.width - frame.width * sx) / 2;
                oy = (monitor.height - frame.height * sy) / 2;
            }
            clone.set_scale(sx, sy);
            clone.set_position(ox + (buffer.x - frame.x) * sx, oy + (buffer.y - frame.y) * sy);
        }
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
        for (const {box} of entry.views)
            box.destroy();
        entry.views = [];
    }

    /** A centred message on the primary monitor (used by the Preview button). */
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

    setInfoLayout(layout) {
        this._infoBox?.setLayout(layout);
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
        for (const id of this._graceIds)
            GLib.source_remove(id);
        this._graceIds.clear();
        this._cancellable.cancel();

        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        Clutter.Event.remove_filter(this._filterId);
        global.display.disconnect(this._windowCreatedId);
        Main.layoutManager.uiGroup.disconnect(this._raiseId);

        for (const entry of this._entries) {
            this._detach(entry);
            this._end(entry);
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
    // Its whole process group gets the same, and SIGKILL once the saver is
    // gone, for whatever it left behind.
    _terminate(proc, pid, lease) {
        proc.send_signal(SIGTERM);
        signalGroup(pid, 'TERM');
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KILL_GRACE_MS, () => {
            stragglers.delete(proc);
            proc.force_exit();
            signalGroup(pid, 'KILL');
            return GLib.SOURCE_REMOVE;
        });
        stragglers.set(proc, {id, pid});
        proc.wait_async(null, () => {
            signalGroup(pid, 'KILL');
            lease?.release();
            if (stragglers.get(proc)?.id === id) {
                GLib.source_remove(id);
                stragglers.delete(proc);
            }
        });
    }
}
