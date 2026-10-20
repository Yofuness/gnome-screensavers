// SPDX-License-Identifier: GPL-2.0-or-later
// Test hooks, exported only when gnome-shell runs with SCREENSAVERS_DEBUG=1
// (the isolated headless shell in tools/headless-test.sh).  Lets a script lock
// the session, start savers, take screenshots and simulate input.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const IFACE = `
<node>
  <interface name="io.github.yofuness.Screensavers.Debug">
    <method name="Lock"/>
    <method name="Unlock"/>
    <method name="Motion"/>
    <method name="Idle"/>
    <method name="Preview"><arg type="s" direction="in" name="id"/></method>
    <method name="Stop"/>
    <method name="Key"/>
    <method name="MediaKey"/>
    <method name="KeyVal"><arg type="u" direction="in" name="keyval"/></method>
    <method name="Click"/>
    <method name="ClickAt">
      <arg type="d" direction="in" name="x"/>
      <arg type="d" direction="in" name="y"/>
    </method>
    <method name="Scroll"><arg type="i" direction="in" name="steps"/></method>
    <method name="Screenshot">
      <arg type="s" direction="in" name="path"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="Status"><arg type="s" direction="out" name="json"/></method>
    <method name="List"><arg type="s" direction="out" name="json"/></method>
    <method name="Connectors"><arg type="s" direction="out" name="json"/></method>
    <method name="Covered"><arg type="u" direction="out" name="monitors"/></method>
  </interface>
</node>`;

export class DebugInterface {
    constructor(extension) {
        this._ext = extension;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/io/github/yofuness/Screensavers/Debug');
        const seat = global.stage.context.get_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        // Rotate after SCREENSAVERS_TEST_ROTATE_SECONDS instead of whole minutes.
        const rotateSeconds = Number(GLib.getenv('SCREENSAVERS_TEST_ROTATE_SECONDS') ?? 0);
        if (rotateSeconds > 0) {
            const minutes = extension._rotationSeconds.bind(extension);
            extension._rotationSeconds = () => (minutes() > 0 ? rotateSeconds : 0);
        }

        // Pretend switcheroo-control reported a second GPU with NAME=value.
        const gpu = GLib.getenv('SCREENSAVERS_TEST_GPU_ENV');
        if (gpu) {
            const [name, value] = gpu.split('=');
            Object.defineProperty(extension, '_gpuEnv', {
                configurable: true, get: () => ({[name]: value}), set: () => {},
            });
        }
    }

    destroy() {
        this._dbus.unexport();
    }

    Lock() {
        Main.screenShield.lock(true);
    }

    Unlock() {
        Main.screenShield.deactivate(false);
    }

    // What GNOME does when the session's presence turns idle (auto-lock path).
    Idle() {
        Main.screenShield._onStatusChanged(3 /* GnomeSession.PresenceStatus.IDLE */);
    }

    Motion() {
        const t = GLib.get_monotonic_time();
        for (let i = 0; i < 10; i++)
            this._pointer.notify_relative_motion(t + i * 1000, 15, 10);
    }

    Preview(id) {
        this._ext.startSaver({id: id || null});
    }

    Stop() {
        this._ext._stopSession({resumeFade: false, reason: 'stopped'});
    }

    Key() {
        const t = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(t + 1000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    }

    // Press and release a key by keyval, e.g. 65363 for Right.
    KeyVal(keyval) {
        const t = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(t + 1000, keyval, Clutter.KeyState.RELEASED);
    }

    MediaKey() {
        const t = GLib.get_monotonic_time();
        // Raw evdev code (KEY_PLAYPAUSE), as a real keyboard sends it.
        this._keyboard.notify_key(t, 164, Clutter.KeyState.PRESSED);
        this._keyboard.notify_key(t + 1000, 164, Clutter.KeyState.RELEASED);
    }

    Click() {
        const t = GLib.get_monotonic_time();
        this._pointer.notify_button(t, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(t + 1000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    ClickAt(x, y) {
        const t = GLib.get_monotonic_time();
        this._pointer.notify_absolute_motion(t, x, y);
        this._pointer.notify_button(t + 1000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(t + 2000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    // Mouse wheel at the pointer: positive scrolls down.
    Scroll(steps) {
        const t = GLib.get_monotonic_time();
        for (let i = 0; i < Math.abs(steps); i++) {
            this._pointer.notify_discrete_scroll(t + i * 1000,
                steps > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP,
                Clutter.ScrollSource.WHEEL);
        }
    }

    ScreenshotAsync([path], invocation) {
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shooter = new Shell.Screenshot();
        shooter.screenshot(false, stream, (obj, res) => {
            let ok = false;
            try {
                obj.screenshot_finish(res);
                ok = true;
            } catch (e) {
                this._ext.log(`screenshot failed: ${e.message}`);
            }
            stream.close(null);
            invocation.return_value(new GLib.Variant('(b)', [ok]));
        });
    }

    Status() {
        return JSON.stringify({
            locked: Main.screenShield.locked,
            active: Main.screenShield.active,
            lightbox: Main.screenShield._shortLightbox?.active ?? null,
            mode: Main.sessionMode.currentMode,
            session: this._sessionStatus(),
            saver: this._ext._runs?.[0]?.id ?? null,
            outgoing: !!this._ext._outgoing,
            savers: this._ext._session?.ids ?? [],
            media: this._ext._session?.media.current()?.title ?? null,
            hostWindows: this._ext._pool?.size ?? 0,
            // Host windows the overview, Alt+Tab or the dash would list.
            hostListed: global.display.list_all_windows()
                .filter(w => (w.get_title() ?? '').startsWith('screensavers-host-') && !w.skip_taskbar).length,
            monitors: Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height]),
        });
    }

    // How many monitors are fully covered by a saver picture right now: an
    // opaque clone (not mid-fade) in an opaque overlay, from the current or the
    // outgoing session.  Fewer than all monitors means the lock screen or
    // desktop shows through.
    Covered() {
        const opaque = actor => actor.opacity === 255 && !actor.get_transition('opacity');
        const covered = new Set();
        for (const session of [this._ext._session, this._ext._outgoing?.session]) {
            if (!session?._overlay || !opaque(session._overlay))
                continue;
            for (const entry of session._entries) {
                for (const view of entry.views) {
                    if (opaque(view.box))
                        covered.add(view.monitor.index);
                }
            }
        }
        return covered.size;
    }

    // Connector names of each monitor (by index), e.g. [["Meta-0"], ["Meta-1"]].
    Connectors() {
        const result = [];
        for (const lm of global.backend.get_monitor_manager().get_logical_monitors())
            result[lm.get_number()] = lm.get_monitors().map(m => m.get_connector());
        return JSON.stringify(result);
    }

    List() {
        return JSON.stringify(this._ext._registry.list());
    }

    // One record per monitor a saver covers (a mirrored saver covers several).
    _sessionStatus() {
        const session = this._ext._session;
        if (!session)
            return null;
        return session._entries.flatMap(e => {
            const base = {pid: e.pid, id: e.id, alive: !!e.proc, window: !!e.window, leased: !!e.lease};
            return e.views.length
                ? e.views.map(v => ({...base, monitor: v.monitor.index, shown: true}))
                : [{...base, monitor: e.monitor.index, shown: false}];
        });
    }
}
