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

export default class ScreensaversExtension extends Extension {
    enable() {
        this._verbose = !!GLib.getenv('SCREENSAVERS_DEBUG');
        this._settings = this.getSettings();
        this._sessionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        this.registry = new Registry(this, this._settings);
        this._registryReady = this.registry.load().catch(e => this.warn(`scanning savers: ${e}`));
        this._history = new HistoryWriter(this.uuid, () => this._settings?.get_int('history-limit') ?? 2000);
        this._session = null;
        this._run = null;           // {id, name, start, lock} for the session on screen
        this._pendingFade = null;
        this._passFade = false;

        const ext = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(ScreenShield.prototype, '_activateFade',
            original => {
                ext._originalFade = original;
                return function (lightbox, time) {
                    if (ext._interceptFade(this, original, lightbox, time))
                        return;
                    original.call(this, lightbox, time);
                };
            });

        Main.screenShield?.connectObject('locked-changed', () => this._onLockedChanged(), this);

        // The preferences window asks for a preview by writing "<saver id>#<time>"
        // to this key; the time part makes repeated requests for one saver count.
        this._settings.connectObject('changed::preview-request', () => {
            const request = this._settings.get_string('preview-request');
            const id = request.slice(0, request.lastIndexOf('#'));
            if (!id || Main.screenShield?.locked)
                return;
            if (id === '@test')
                this.startSaver({test: true});
            else
                this.startSaver({id});
        }, this);
        this._settings.connectObject('changed::history-limit', () => this._history?.recount(), this);
        // Resize the overlay of a running saver as the slider moves.
        this._settings.connectObject('changed::overlay-scale', () =>
            this._session?.setInfoScale(this._overlayScale()), this);

        // BEGIN DEBUG (removed from the extensions.gnome.org package by `make zip`)
        if (this._verbose) {
            import('./debug.js').then(({DebugInterface}) => {
                if (this._settings)
                    this._debug = new DebugInterface(this);
            }).catch(e => this.warn(`debug interface: ${e}`));
        }
        // END DEBUG
    }

    disable() {
        // This extension uses the unlock-dialog session mode because its whole
        // purpose is to show a screensaver on the lock screen, so it must stay
        // enabled while the session is locked.  disable() therefore runs only on
        // logout or when the user turns the extension off, never on lock/unlock.
        // Everything it set up is torn down here: the running saver and its
        // processes, timers, the idle inhibitor, the input filter and the
        // ScreenShield override.
        this._debug?.destroy();
        this._debug = null;
        this._settings.disconnectObject(this);
        this._cancelRetrigger();
        this._stopSession({resumeFade: false, reason: 'disabled'});
        killStragglers();
        Main.screenShield?.disconnectObject(this);
        this._injections.clear();
        this._injections = null;
        this._originalFade = null;
        this._history = null;
        this.registry = null;
        this._settings = null;
        this._sessionSettings = null;
    }

    // Progress messages only when debugging; problems always.
    log(msg) {
        if (this._verbose)
            console.log(`[screensavers] ${msg}`);
    }

    warn(msg) {
        console.warn(`[screensavers] ${msg}`);
    }

    get session() {
        return this._session;
    }

    get currentSaverId() {
        return this._run?.id ?? null;
    }

    // Called instead of ScreenShield._activateFade.  Returns true when we took over.
    _interceptFade(shield, original, lightbox, time) {
        if (this._passFade || !this._settings.get_boolean('enabled-on-lock'))
            return false;
        this._pendingFade = {shield, original, lightbox, time};
        if (this._session)
            return true; // already showing a saver; GNOME asked to fade again
        return this.startSaver({onLock: true});
    }

    _overlayScale() {
        return this._settings.get_int('overlay-scale') / 100;
    }

    /**
     * Start a saver.  onLock: started in place of GNOME's fade (stops at the run
     * time and then lets the fade continue); otherwise a preview that runs until
     * a key press or click.  rotate: replace the current saver without a gap.
     * test: a preview that behaves like the lock screen (choice, run time,
     * rotation) without locking.
     */
    startSaver({onLock = false, id = null, rotate = false, test = false} = {}) {
        // Right after login the saver list may still be loading; start once it's ready.
        if (!this.registry.loaded) {
            if (!this._waitingForRegistry) {
                this._waitingForRegistry = true;
                this._registryReady.then(() => {
                    this._waitingForRegistry = false;
                    if (this.registry)
                        this.startSaver({onLock, id, test});
                });
            }
            return true;
        }
        this._cancelRetrigger();

        const saverId = id ?? (rotate
            ? this.registry.choose({random: true, exclude: this._run?.id})
            : this.registry.choose());
        const launch = this.registry.launcher(saverId);
        if (!launch) {
            this.warn(`unknown saver "${saverId}"`);
            return false;
        }

        // A rotation keeps the old saver on screen until the new one shows; anything
        // else replaces it now, but keeps the fade GNOME just asked for.
        const previous = rotate ? {session: this._session, run: this._run} : null;
        if (!rotate) {
            const pending = this._pendingFade;
            this._stopSession({resumeFade: false, reason: 'replaced'});
            this._pendingFade = onLock ? pending : null;
            this._onLock = onLock;
            this._test = test;
        }

        this.log(`starting ${saverId}${rotate ? ' (rotation)' : onLock ? ' (lock)' : this._test ? ' (test)' : ' (preview)'}`);
        const session = new SaverSession({
            launch,
            hidden: rotate,
            grab: !this._onLock,
            info: {
                showClock: this._settings.get_boolean('show-clock'),
                showMedia: this._settings.get_boolean('show-media'),
                scale: this._overlayScale(),
            },
            log: m => this.log(m),
            warn: m => this.warn(m),
            onDismiss: reason => {
                if (this._session === session)
                    this._dismiss(reason);
            },
            onFailed: () => {
                if (this._session === session)
                    this._stopSession({resumeFade: true, reason: 'failed'});
            },
            onShown: () => {
                if (previous?.session) {
                    this._logRun(previous.run, 'rotated');
                    previous.session.stop();
                }
            },
        });
        this._session = session;
        this._run = {
            id: saverId,
            name: this.registry.list().find(s => s.id === saverId)?.name ?? saverId,
            start: Date.now(),
            lock: !!this._onLock,
            ...this._test ? {test: true} : {},
        };
        session.start();

        if (rotate)
            return true;
        if (onLock)
            this._inhibitIdle();

        const runTime = this._runTimeSeconds();
        if ((onLock || test) && runTime > 0) {
            this._runTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, runTime, () => {
                this._runTimerId = 0;
                if (this._test) {
                    // A test can't hand over to GNOME's fade; say what would happen.
                    this.log('test run time over');
                    this._session?.showNotice('Your screen would blank now');
                    this._noticeTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                        this._noticeTimerId = 0;
                        this._stopSession({resumeFade: false, reason: 'run-time'});
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                }
                this.log('run time over, letting the screen blank');
                this._stopSession({resumeFade: true, reason: 'run-time'});
                return GLib.SOURCE_REMOVE;
            });
        }
        this._scheduleRotation();
        return true;
    }

    _scheduleRotation() {
        const minutes = this._settings.get_int('rotate-interval');
        if (minutes <= 0)
            return;
        // Test hook: rotate after this many seconds instead of minutes.
        const testSeconds = Number(GLib.getenv('SCREENSAVERS_TEST_ROTATE_SECONDS') ?? 0);
        const seconds = this._verbose && testSeconds > 0 ? testSeconds : minutes * 60;
        this._rotateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (this._session)
                this.startSaver({onLock: this._onLock, rotate: true});
            return GLib.SOURCE_CONTINUE;
        });
    }

    // While a lock-time saver runs, keep the power daemon from blanking: once
    // the lock screen reports "active" it would blank within seconds.  This is
    // the same idle inhibitor video players take; released when the saver stops.
    _inhibitIdle() {
        if (this._inhibitCookie || this._inhibiting)
            return;
        this._inhibiting = true;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Inhibit',
            new GLib.Variant('(susu)', [this.uuid, 0, 'Showing a screensaver', 8]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                this._inhibiting = false;
                try {
                    const [cookie] = conn.call_finish(res).deepUnpack();
                    if (this._session && this._onLock)
                        this._inhibitCookie = cookie;
                    else
                        this._releaseCookie(cookie); // saver already gone
                } catch (e) {
                    this.warn(`idle inhibit failed: ${e.message}`);
                }
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
        // Idle without locking (lock disabled): GNOME raised its shield and a
        // modal grab expecting to fade; undo that like user activity would.
        if (pending && Main.screenShield && !Main.screenShield.locked)
            Main.screenShield.deactivate(false);
        if (Main.screenShield?.locked)
            this._armRetrigger();
    }

    // After a dismissal on the lock screen, bring the saver back once the user
    // has been idle for "retrigger-delay" seconds.
    _armRetrigger() {
        this._cancelRetrigger();
        const delay = this._settings.get_int('retrigger-delay');
        if (delay <= 0 || !this._originalFade)
            return;
        const monitor = global.backend.get_core_idle_monitor();
        this._retriggerWatch = monitor.add_idle_watch(delay * 1000, () => {
            this._cancelRetrigger();
            const shield = Main.screenShield;
            if (this._session || !shield?.locked || !this._settings.get_boolean('enabled-on-lock'))
                return;
            this.log('idle again on the lock screen, showing the saver');
            // Close a half-used unlock prompt, as GNOME does when the user goes idle.
            shield._maybeCancelDialog?.();
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
        if (!run || !this._settings?.get_boolean('log-history'))
            return;
        this._history?.record({...run, end: Date.now(), ended});
    }

    _stopSession({resumeFade, reason = 'stopped'}) {
        if (this._runTimerId) {
            GLib.source_remove(this._runTimerId);
            this._runTimerId = 0;
        }
        if (this._rotateId) {
            GLib.source_remove(this._rotateId);
            this._rotateId = 0;
        }
        if (this._noticeTimerId) {
            GLib.source_remove(this._noticeTimerId);
            this._noticeTimerId = 0;
        }
        if (this._session)
            this._logRun(this._run, reason);
        this._session?.stop();
        this._session = null;
        this._run = null;
        this._uninhibitIdle();
        const pending = this._pendingFade;
        this._pendingFade = null;
        if (resumeFade && pending) {
            this._passFade = true;
            try {
                pending.original.call(pending.shield, pending.lightbox, pending.time);
            } finally {
                this._passFade = false;
            }
        }
    }

    _onLockedChanged() {
        if (Main.screenShield.locked)
            return;
        // Unlocked: a lock-time saver must go away, and nothing should come back.
        this._cancelRetrigger();
        if (this._session && this._onLock)
            this._stopSession({resumeFade: false, reason: 'unlock'});
    }
}
