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

import {SaverSession} from './saverSession.js';
import {Registry} from './registry.js';

export default class ScreensaversExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sessionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        this.registry = new Registry(this, this._settings);
        this._session = null;
        this._pendingFade = null;
        this._passFade = false;

        const ext = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(ScreenShield.prototype, '_activateFade',
            original => function (lightbox, time) {
                if (ext._interceptFade(this, original, lightbox, time))
                    return;
                original.call(this, lightbox, time);
            });

        Main.screenShield?.connectObject('locked-changed', () => this._onLockedChanged(), this);

        // Lets the preferences window start a preview in the shell.
        this._dbus = Gio.DBusExportedObject.wrapJSObject(`
            <node><interface name="local.johann.Screensavers">
              <method name="Preview"><arg type="s" direction="in" name="id"/></method>
            </interface></node>`, {
            Preview: id => this.startSaver({id: id || null}),
        });
        this._dbus.export(Gio.DBus.session, '/local/johann/Screensavers');

        if (GLib.getenv('SCREENSAVERS_DEBUG')) {
            import('./debug.js').then(({DebugInterface}) => {
                if (this._settings)
                    this._debug = new DebugInterface(this);
            }).catch(e => this.log(`debug interface: ${e}`));
        }
        this.log('enabled');
    }

    disable() {
        // Runs on logout and when the extension is turned off; never while
        // locked, because we declare the unlock-dialog session mode.
        this._debug?.destroy();
        this._debug = null;
        this._dbus?.unexport();
        this._dbus = null;
        this._stopSession({resumeFade: false});
        Main.screenShield?.disconnectObject(this);
        this._injections.clear();
        this._injections = null;
        this.registry = null;
        this._settings = null;
        this._sessionSettings = null;
    }

    log(msg) {
        console.log(`[screensavers] ${msg}`);
    }

    get session() {
        return this._session;
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

    /**
     * Start a saver.  onLock: started in place of GNOME's fade (stops at the run
     * time and then lets the fade continue); otherwise a preview that runs until
     * a key press or click.
     */
    startSaver({onLock = false, id = null} = {}) {
        // Replace any running saver, but keep the fade GNOME just asked for.
        const pending = this._pendingFade;
        this._stopSession({resumeFade: false});
        this._pendingFade = onLock ? pending : null;
        const saverId = id ?? this.registry.choose();
        const launch = this.registry.launcher(saverId);
        if (!launch) {
            this.log(`unknown saver "${saverId}"`);
            return false;
        }
        this.log(`starting ${saverId}${onLock ? ' (lock)' : ' (preview)'}`);
        this._onLock = onLock;
        this._session = new SaverSession({
            launch,
            log: m => this.log(m),
            onDismiss: () => this._dismiss(),
            onFailed: () => this._stopSession({resumeFade: true}),
        });
        this._session.start();
        if (onLock)
            this._inhibitIdle();

        const runTime = this._runTimeSeconds();
        if (onLock && runTime > 0) {
            this._runTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, runTime, () => {
                this._runTimerId = 0;
                this.log('run time over, letting the screen blank');
                this._stopSession({resumeFade: true});
                return GLib.SOURCE_REMOVE;
            });
        }
        return true;
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
                    this.log(`idle inhibit failed: ${e.message}`);
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

    _dismiss() {
        const pending = this._pendingFade;
        this._stopSession({resumeFade: false});
        // Idle without locking (lock disabled): GNOME raised its shield and a
        // modal grab expecting to fade; undo that like user activity would.
        if (pending && Main.screenShield && !Main.screenShield.locked)
            Main.screenShield.deactivate(false);
    }

    _stopSession({resumeFade}) {
        if (this._runTimerId) {
            GLib.source_remove(this._runTimerId);
            this._runTimerId = 0;
        }
        this._session?.stop();
        this._session = null;
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
        // Unlocked: a lock-time saver must go away.
        if (this._session && this._onLock && !Main.screenShield.locked)
            this._stopSession({resumeFade: false});
    }
}
