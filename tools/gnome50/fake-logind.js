// SPDX-License-Identifier: GPL-2.0-or-later
// Just enough of logind's Manager for gnome-shell to start in a container, and
// GDM's version (gnome-shell only creates the lock screen when GDM answers).
// It answers like the real logind does for the test shell's made-up session
// (XDG_SESSION_ID=screensavers-test-none): no such session or user, so the
// shell never touches a real session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const XML = `<node><interface name="org.freedesktop.login1.Manager">
  <method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/>
    <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="out"/></method>
  <method name="GetSession"><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
  <method name="GetUser"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
  <method name="ListSessions"><arg type="a(susso)" direction="out"/></method>
  <method name="CanRebootToBootLoaderMenu"><arg type="s" direction="out"/></method>
  <method name="SetRebootToBootLoaderMenu"><arg type="t" direction="in"/></method>
  <signal name="PrepareForSleep"><arg type="b"/></signal>
  <signal name="SessionRemoved"><arg type="s"/><arg type="o"/></signal>
</interface></node>`;

const manager = {
    InhibitAsync(_params, invocation) {
        invocation.return_dbus_error('org.freedesktop.DBus.Error.NotSupported', 'No inhibitors in the test container');
    },
    GetSessionAsync([id], invocation) {
        invocation.return_dbus_error('org.freedesktop.login1.NoSuchSession', `No session '${id}' known`);
    },
    GetUserAsync([uid], invocation) {
        invocation.return_dbus_error('org.freedesktop.login1.NoSuchUser', `No user '${uid}' known`);
    },
    ListSessions() {
        return [];
    },
    CanRebootToBootLoaderMenu() {
        return 'na';
    },
    SetRebootToBootLoaderMenu() {},
};

const GDM_XML = `<node><interface name="org.gnome.DisplayManager.Manager">
  <property name="Version" type="s" access="read"/>
</interface></node>`;

const loop = new GLib.MainLoop(null, false);

function serve(name, path, xml, object) {
    Gio.DBusExportedObject.wrapJSObject(xml, object).export(Gio.DBus.system, path);
    Gio.bus_own_name_on_connection(Gio.DBus.system, name, Gio.BusNameOwnerFlags.NONE, null, () => {
        printerr(`fake-logind: could not own ${name}`);
        loop.quit();
    });
}

serve('org.freedesktop.login1', '/org/freedesktop/login1', XML, manager);
serve('org.gnome.DisplayManager', '/org/gnome/DisplayManager/Manager', GDM_XML, {Version: '50.0'});
loop.run();
