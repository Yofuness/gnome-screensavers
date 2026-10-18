// SPDX-License-Identifier: GPL-2.0-or-later
// Screensavers: shows a screensaver over the GNOME lock screen.
//
// GNOME starts its fade-to-black (and, through it, tells the power daemon the
// "screensaver" is active so the display blanks) from ScreenShield._activateFade.
// We wrap that method: instead of fading, we show a saver; when the saver's
// run time is up we let the original fade happen and GNOME blanks as usual.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ScreenShield} from 'resource:///org/gnome/shell/ui/screenShield.js';

import {SaverSession, killStragglers} from './saverSession.js';
import {WindowPool} from './windowPool.js';
import {Registry, sourceOf} from './registry.js';
import {HistoryWriter} from './history.js';
import {ImageConfig} from './imageConfig.js';

// Refresh rate (Hz) of the stage view showing a monitor's centre; 0 if unknown
// (the registry then assumes 60).
function refreshRate(monitor) {
    try {
        const x = monitor.x + monitor.width / 2, y = monitor.y + monitor.height / 2;
        for (const view of global.stage.peek_stage_views()) {
            const r = new Mtk.Rectangle();
            view.get_layout(r);
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                return view.get_refresh_rate();
        }
    } catch (e) {
        console.warn(`[screensavers] can't read the refresh rate: ${e.message}`);
    }
    return 0;
}

const NOTICE_SECONDS = 3;
// With a different saver on each monitor, timed changes go one monitor at a
// time, this far apart (as XScreenSaver staggers its cycling).
const STAGGER_SECONDS = 3;
// Screensavers that won't start in a row before giving up (see _retryFailed).
const MAX_FAILED_STARTS = 3;

export default class ScreensaversExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sessionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        this._images = new ImageConfig(this.uuid);
        this._images.write(this._settings.get_string('image-directory'));
        this._registry = new Registry(this._settings, {env: this._images.env, refreshRate});
        this._registryReady = this._registry.load().catch(e =>
            console.warn(`[screensavers] scanning screensavers: ${e.message}`));
        this._history = new HistoryWriter(this.uuid);
        this._pool = new WindowPool(GLib.build_filenamev([this.path, 'windowHost.js']));
        this._session = null;
        this._runs = null;
        this._staggerIds = [];
        this._outgoing = null;
        this._fixedId = false;
        this._failedStarts = 0;
        this._pendingFade = null;
        this._pendingStart = null;

        // Main.screenShield only exists when the system allows locking.
        this._shield = Main.screenShield;
        if (this._shield) {
            const ext = this;
            this._injections = new InjectionManager();
            this._injections.overrideMethod(ScreenShield.prototype, '_activateFade', original => {
                ext._originalFade = original;
                return function (lightbox, time) {
                    if (!ext._interceptFade(this, original, lightbox, time))
                        original.call(this, lightbox, time);
                };
            });
            this._shield.connectObject('locked-changed', () => this._onLockedChanged(), this);
        }

        // The preferences window asks for a preview by writing "<saver id>#<time>"
        // to this key; the time part makes repeated requests for one saver count.
        this._settings.connectObject(
            'changed::preview-request', () => this._onPreviewRequest(),
            'changed::history-limit', () => this._history.recount(),
            'changed::image-directory', () => this._images.write(this._settings.get_string('image-directory')),
            'changed::overlay-scale', () => this._session?.setInfoScale(this._overlayScale()),
            'changed::overlay-corner', () => this._session?.setInfoLayout(this._overlayLayout()),
            'changed::overlay-monitor', () => this._session?.setInfoLayout(this._overlayLayout()),
            this);

        // BEGIN DEBUG (removed from the extensions.gnome.org package by `make zip`)
        if (GLib.getenv('SCREENSAVERS_DEBUG')) {
            import('./debug.js').then(({DebugInterface}) => {
                if (this._settings)
                    this._debug = new DebugInterface(this);
            });
        }
        // END DEBUG
    }

    disable() {
        // This extension uses the unlock-dialog session mode because its whole
        // purpose is to show a screensaver on the lock screen, so it must stay
        // enabled while the session is locked.  disable() therefore runs only on
        // logout or when the user turns the extension off, never on lock/unlock.
        // BEGIN DEBUG
        this._debug?.destroy();
        this._debug = null;
        // END DEBUG
        this._settings.disconnectObject(this);
        this._cancelRetrigger();
        this._stopSession({resumeFade: false, reason: 'disabled'});
        killStragglers();
        this._pool.destroy();
        this._pool = null;
        this._shield?.disconnectObject(this);
        this._injections?.clear();
        this._injections = null;
        this._originalFade = null;
        this._shield = null;
        this._pendingStart = null;
        this._history = null;
        this._images = null;
        this._registry = null;
        this._settings = null;
        this._sessionSettings = null;
    }

    _onPreviewRequest() {
        const request = this._settings.get_string('preview-request');
        const id = request.slice(0, request.lastIndexOf('#'));
        if (!id || this._shield?.locked)
            return;
        if (id === '@test')
            this.startSaver({test: true});
        else
            this.startSaver({id});
    }

    // Called instead of ScreenShield._activateFade.  Returns true when we took over.
    _interceptFade(shield, original, lightbox, time) {
        if (this._passFade || !this._settings.get_boolean('enabled-on-lock'))
            return false;
        this._pendingFade = {shield, original, lightbox, time};
        if (this._session)
            return true;
        return this.startSaver({onLock: true});
    }

    _overlayScale() {
        return this._settings.get_int('overlay-scale') / 100;
    }

    // The chosen monitor (by connector name), or the primary one if it's unset
    // or not connected.
    _overlayLayout() {
        const layout = Main.layoutManager;
        const connector = this._settings.get_string('overlay-monitor');
        const index = connector
            ? global.backend.get_monitor_manager().get_monitor_for_connector(connector)
            : -1;
        return {
            monitor: layout.monitors[index] ?? layout.primaryMonitor,
            corner: this._settings.get_string('overlay-corner'),
        };
    }

    /**
     * Start a saver.  onLock: started in place of GNOME's fade (stops at the run
     * time and then lets the fade continue); otherwise a preview that runs until
     * a key press or click.  rotate: replace the current saver without a gap
     * (skipped: because the user pressed the skip key).
     * test: a preview that behaves like the lock screen (choice, run time,
     * rotation) without locking.
     */
    startSaver({onLock = false, id = null, rotate = false, skipped = false, test = false} = {}) {
        if (!this._registry.loaded)
            return this._startWhenLoaded({onLock, id, test});
        this._cancelRetrigger();

        const slots = this._planSlots(id, rotate);
        if (!slots)
            return false;

        this._handOver({onLock, rotate, skipped, test});
        if (!rotate)
            this._fixedId = !!id;

        const session = this._createSession(slots, rotate);
        this._session = session;
        // One history entry per monitor when each shows its own saver.
        this._perMonitor = slots.length > 1 && this._monitorMode() === 'different' && !id;
        this._runs = this._perMonitor
            ? slots.map((slot, i) => this._newRun(slot.id, i))
            : [this._newRun(slots[0].id)];
        session.start();

        if (rotate)
            return true;
        if (onLock)
            this._inhibitIdle();
        if (onLock || test)
            this._startRunTimer();
        this._scheduleRotation();
        return true;
    }

    // How savers are spread over the monitors: "mirror" (one saver, shown on
    // every monitor), "same" (a copy per monitor) or "different" (a pick per
    // monitor).  With one monitor they're all the same thing.
    _monitorMode() {
        return Main.layoutManager.monitors.length > 1
            ? this._settings.get_string('monitor-mode')
            : 'mirror';
    }

    // The saver processes to start: [{monitor, id, launch, mirror}].  null if
    // nothing can run.
    _planSlots(id, rotate) {
        const monitors = Main.layoutManager.monitors;
        const mode = this._monitorMode();
        const count = mode === 'different' && !id ? monitors.length : 1;
        const current = this._runs?.at(-1)?.id ?? null;
        // A rotation or skip gives each monitor something other than what it
        // shows now.
        const previous = rotate ? (this._runs ?? []).map(run => run.id) : [];
        const ids = id ? [id] : this._registry.chooseMany(count, {random: rotate, current, previous});
        const picks = [];
        for (const saverId of ids) {
            const launch = this._registry.launcher(saverId);
            if (launch)
                picks.push({id: saverId, launch});
            else
                console.warn(`[screensavers] unknown screensaver "${saverId}"`);
        }
        if (!picks.length)
            return null;
        if (mode === 'mirror')
            return [{monitor: Main.layoutManager.primaryMonitor, ...picks[0], mirror: true}];
        return monitors.map((monitor, i) => ({monitor, ...picks[i % picks.length]}));
    }

    _newRun(id, monitor) {
        return {
            id,
            name: this._registry.list().find(s => s.id === id)?.name ?? id,
            start: Date.now(),
            lock: this._onLock,
            ...this._test ? {test: true} : {},
            ...monitor !== undefined ? {monitor} : {},
        };
    }

    // A rotation or skip keeps the old saver on screen until the new one shows;
    // anything else replaces it now, but keeps the fade GNOME just asked for.
    _handOver({onLock, rotate, skipped, test}) {
        if (rotate) {
            if (this._outgoing) {
                // A handover is still running (the skip key was pressed again
                // before the next saver finished fading in): replace only the
                // one on its way in, and keep the one on screen until a saver
                // has fully covered it.  It never showed, so it isn't logged.
                this._session.stop();
                return;
            }
            this._cancelStagger();
            this._outgoing = {session: this._session, runs: this._runs, reason: skipped ? 'skipped' : 'rotated'};
            return;
        }
        const pending = this._pendingFade;
        this._stopSession({resumeFade: false, reason: 'replaced'});
        this._pendingFade = onLock ? pending : null;
        this._onLock = onLock;
        this._test = test;
    }

    // Right after login the saver list may still be loading; start once it's
    // ready.  Only the latest request counts.
    _startWhenLoaded(request) {
        const waiting = this._pendingStart;
        this._pendingStart = request;
        if (!waiting) {
            this._registryReady.then(() => {
                const start = this._pendingStart;
                this._pendingStart = null;
                if (start)
                    this.startSaver(start);
            });
        }
        return true;
    }

    _createSession(slots, hidden) {
        const session = new SaverSession({
            slots,
            pool: this._pool,
            hidden,
            grab: !this._onLock,
            info: {
                showClock: this._settings.get_boolean('show-clock'),
                showMedia: this._settings.get_boolean('show-media'),
                scale: this._overlayScale(),
                ...this._overlayLayout(),
            },
            onDismiss: reason => {
                if (this._session === session)
                    this._dismiss(reason);
            },
            onFailed: () => {
                if (this._session === session && !this._retryFailed())
                    this._stopSession({resumeFade: true, reason: 'failed'});
            },
            onShown: () => {
                if (this._session === session) {
                    this._failedStarts = 0;
                    this._stopOutgoing();
                }
            },
            onSkip: () => {
                if (this._session === session)
                    this._skip();
            },
            skipKeyval: this._settings.get_uint('skip-key'),
        });
        return session;
    }

    // A picked screensaver that won't start (VidWhacker, for one, exits without
    // a video to play) shouldn't end the screensaver: when the source
    // picks, try another.  During a skip or rotation the one on screen stays
    // until the replacement shows.  Returns false to give up.
    _retryFailed() {
        if (this._fixedId || this._failedStarts >= MAX_FAILED_STARTS) {
            this._failedStarts = 0;
            return false;
        }
        this._failedStarts++;
        console.warn(`[screensavers] ${this._runs?.map(run => run.id).join(', ')} didn't start; trying another`);
        if (this._outgoing)
            return this.startSaver({rotate: true, skipped: this._outgoing.reason === 'skipped'});
        this._runs = null;          // it never showed, so it isn't logged
        return this.startSaver({onLock: this._onLock, test: this._test});
    }

    _startRunTimer() {
        const runTime = this._runTimeSeconds();
        if (runTime <= 0)
            return;
        this._runTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, runTime, () => {
            this._runTimerId = 0;
            if (this._test)
                this._endTest();
            else
                this._stopSession({resumeFade: true, reason: 'run-time'});
            return GLib.SOURCE_REMOVE;
        });
    }

    // A test can't hand over to GNOME's fade; say what would happen instead.
    _endTest() {
        this._session.showNotice('Your screen would blank now');
        this._noticeTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, NOTICE_SECONDS, () => {
            this._noticeTimerId = 0;
            this._stopSession({resumeFade: false, reason: 'run-time'});
            return GLib.SOURCE_REMOVE;
        });
    }

    // Next saver now; the rotation timer starts over from here.
    _skip() {
        this._cancelStagger();
        if (this._rotateId)
            GLib.source_remove(this._rotateId);
        this._rotateId = 0;
        this.startSaver({onLock: this._onLock, rotate: true, skipped: true});
        this._scheduleRotation();
    }

    // The selected screensaver is one screensaver: nothing to change to.
    _rotationSeconds() {
        if (sourceOf(this._settings) === 'selected')
            return 0;
        return this._settings.get_int('rotate-interval') * 60;
    }

    _scheduleRotation() {
        const seconds = this._rotationSeconds();
        if (seconds <= 0)
            return;
        this._rotateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (this._perMonitor)
                this._staggeredChange();
            else
                this.startSaver({onLock: this._onLock, rotate: true});
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Each monitor moves on to its next saver in turn, a few seconds apart.
    _staggeredChange() {
        this._cancelStagger();
        this._runs.forEach((_run, i) => {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, i * STAGGER_SECONDS, () => {
                this._staggerIds = this._staggerIds.filter(x => x !== id);
                this._changeMonitor(i);
                return GLib.SOURCE_REMOVE;
            });
            this._staggerIds.push(id);
        });
    }

    _cancelStagger() {
        this._staggerIds.forEach(id => GLib.source_remove(id));
        this._staggerIds = [];
    }

    // Swap the saver on one monitor; history moves on once the new one shows.
    _changeMonitor(i) {
        const session = this._session;
        // Not what this monitor shows now, nor what the others keep showing.
        const saverId = this._registry.choose({
            random: true,
            current: this._runs[i].id,
            avoid: this._runs.filter((_run, j) => j !== i).map(run => run.id),
            previous: [this._runs[i].id],
        });
        const launch = this._registry.launcher(saverId);
        if (!session || !launch)
            return;
        session.swapSlot(i, {id: saverId, launch}, () => {
            if (this._session !== session)
                return;
            this._logRun(this._runs[i], 'rotated');
            this._runs[i] = this._newRun(saverId, i);
        });
    }

    // While a lock-time saver runs, keep the power daemon from blanking: once
    // the lock screen reports "active" it would blank within seconds.  This is
    // the same idle inhibitor video players take; released when the saver stops.
    // _inhibiting covers the time between the request and its reply.
    _inhibitIdle() {
        if (this._inhibitCookie || this._inhibiting)
            return;
        this._inhibiting = true;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Inhibit',
            new GLib.Variant('(susu)', [this.uuid, 0, 'Showing a screensaver', 8]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                this._inhibiting = false;
                let cookie;
                try {
                    [cookie] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    console.warn(`[screensavers] idle inhibit failed: ${e.message}`);
                    return;
                }
                if (this._session && this._onLock)
                    this._inhibitCookie = cookie;
                else
                    this._releaseCookie(cookie);
            });
    }

    _uninhibitIdle() {
        if (this._inhibitCookie)
            this._releaseCookie(this._inhibitCookie);
        this._inhibitCookie = 0;
    }

    _releaseCookie(cookie) {
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Uninhibit', new GLib.Variant('(u)', [cookie]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _runTimeSeconds() {
        const setting = this._settings.get_int('run-time');
        if (setting >= 0)
            return setting;
        return this._sessionSettings.get_uint('idle-delay');
    }

    _dismiss(reason) {
        const pending = this._pendingFade;
        this._stopSession({resumeFade: false, reason});
        if (!this._shield)
            return;
        if (this._shield.locked) {
            this._armRetrigger();
        } else if (pending) {
            // Idle without locking (lock disabled): GNOME raised its shield and a
            // modal grab expecting to fade; undo that like user activity would.
            this._shield.deactivate(false);
        }
    }

    // After a dismissal on the lock screen, bring the saver back once the user
    // has been idle for "retrigger-delay" seconds.
    _armRetrigger() {
        this._cancelRetrigger();
        const delay = this._settings.get_int('retrigger-delay');
        if (delay <= 0)
            return;
        this._retriggerWatch = global.backend.get_core_idle_monitor().add_idle_watch(delay * 1000, () => {
            this._cancelRetrigger();
            const shield = this._shield;
            if (this._session || !shield.locked || !this._settings.get_boolean('enabled-on-lock'))
                return;
            // Close a half-used unlock prompt, as GNOME does when the user goes idle.
            shield._maybeCancelDialog();
            this._pendingFade = {
                shield,
                original: this._originalFade,
                lightbox: shield._shortLightbox,
                time: 0,
            };
            this.startSaver({onLock: true});
        });
    }

    _cancelRetrigger() {
        if (this._retriggerWatch)
            global.backend.get_core_idle_monitor().remove_watch(this._retriggerWatch);
        this._retriggerWatch = 0;
    }

    _logRun(run, ended) {
        if (this._settings.get_boolean('log-history'))
            this._history.record({...run, end: Date.now(), ended}, this._settings.get_int('history-limit'));
    }

    _logRuns(runs, ended) {
        runs?.forEach(run => this._logRun(run, ended));
    }

    // The saver being replaced by a rotation or skip.
    _stopOutgoing() {
        if (!this._outgoing)
            return;
        this._logRuns(this._outgoing.runs, this._outgoing.reason);
        this._outgoing.session.stop();
        this._outgoing = null;
    }

    _stopSession({resumeFade, reason}) {
        if (this._runTimerId)
            GLib.source_remove(this._runTimerId);
        this._runTimerId = 0;
        if (this._rotateId)
            GLib.source_remove(this._rotateId);
        this._rotateId = 0;
        if (this._noticeTimerId)
            GLib.source_remove(this._noticeTimerId);
        this._noticeTimerId = 0;
        this._cancelStagger();

        this._stopOutgoing();
        if (this._session) {
            this._logRuns(this._runs, reason);
            this._session.stop();
        }
        this._session = null;
        this._runs = null;
        this._uninhibitIdle();

        const pending = this._pendingFade;
        this._pendingFade = null;
        if (resumeFade && pending) {
            // The original fade can call activate(), which calls _activateFade
            // again; let that call through instead of starting another saver.
            this._passFade = true;
            try {
                pending.original.call(pending.shield, pending.lightbox, pending.time);
            } finally {
                this._passFade = false;
            }
        }
    }

    _onLockedChanged() {
        if (this._shield.locked)
            return;
        // Unlocked: a lock-time saver must go away, and nothing should come back.
        this._cancelRetrigger();
        if (this._session && this._onLock)
            this._stopSession({resumeFade: false, reason: 'unlock'});
    }
}
