// SPDX-License-Identifier: GPL-2.0-or-later
// Screensavers: shows a screensaver over the GNOME lock screen.
//
// GNOME starts its fade-to-black (and, through it, tells the power daemon the
// "screensaver" is active so the display blanks) from ScreenShield._activateFade.
// We wrap that method: instead of fading, we show a saver; when the saver's
// run time is up we let the original fade happen and GNOME blanks as usual.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ScreenShield} from 'resource:///org/gnome/shell/ui/screenShield.js';

import {SaverSession, killStragglers} from './saverSession.js';
import {Registry} from './registry.js';
import {HistoryWriter} from './history.js';

const NOTICE_SECONDS = 3;

export default class ScreensaversExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sessionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        this._registry = new Registry(this._settings);
        this._registryReady = this._registry.load().catch(e =>
            console.warn(`[screensavers] scanning screensavers: ${e.message}`));
        this._history = new HistoryWriter(this.uuid);
        this._session = null;
        this._run = null;
        this._outgoing = null;
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
        this._shield?.disconnectObject(this);
        this._injections?.clear();
        this._injections = null;
        this._originalFade = null;
        this._shield = null;
        this._pendingStart = null;
        this._history = null;
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

        const saverId = id ?? (rotate
            ? this._registry.choose({random: true, exclude: this._run?.id})
            : this._registry.choose());
        const launch = this._registry.launcher(saverId);
        if (!launch) {
            console.warn(`[screensavers] unknown screensaver "${saverId}"`);
            return false;
        }

        this._handOver({onLock, rotate, skipped, test});

        const session = this._createSession(launch, rotate);
        this._session = session;
        this._run = {
            id: saverId,
            name: this._registry.list().find(s => s.id === saverId)?.name ?? saverId,
            start: Date.now(),
            lock: this._onLock,
            ...this._test ? {test: true} : {},
        };
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

    // A rotation or skip keeps the old saver on screen until the new one shows;
    // anything else replaces it now, but keeps the fade GNOME just asked for.
    _handOver({onLock, rotate, skipped, test}) {
        if (rotate) {
            this._stopOutgoing();
            this._outgoing = {session: this._session, run: this._run, reason: skipped ? 'skipped' : 'rotated'};
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

    _createSession(launch, hidden) {
        const session = new SaverSession({
            launch,
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
                if (this._session === session)
                    this._stopSession({resumeFade: true, reason: 'failed'});
            },
            onShown: () => {
                if (this._session === session)
                    this._stopOutgoing();
            },
            onSkip: () => {
                if (this._session === session)
                    this._skip();
            },
            skipKeyval: this._settings.get_uint('skip-key'),
        });
        return session;
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
        if (this._rotateId)
            GLib.source_remove(this._rotateId);
        this._rotateId = 0;
        this.startSaver({onLock: this._onLock, rotate: true, skipped: true});
        this._scheduleRotation();
    }

    _rotationSeconds() {
        return this._settings.get_int('rotate-interval') * 60;
    }

    _scheduleRotation() {
        const seconds = this._rotationSeconds();
        if (seconds <= 0)
            return;
        this._rotateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this.startSaver({onLock: this._onLock, rotate: true});
            return GLib.SOURCE_CONTINUE;
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

    // The saver being replaced by a rotation or skip.
    _stopOutgoing() {
        if (!this._outgoing)
            return;
        this._logRun(this._outgoing.run, this._outgoing.reason);
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

        this._stopOutgoing();
        if (this._session) {
            this._logRun(this._run, reason);
            this._session.stop();
        }
        this._session = null;
        this._run = null;
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
