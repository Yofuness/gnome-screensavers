#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Minimal MPRIS player for the headless tests.

Owns org.mpris.MediaPlayer2.fakeplayer on the session bus, reports a playing
track, and appends the name of every Player method called to the file given
as the first argument (so the tests can check media keys reached it).
Optional further arguments override the title, artist, album and player name.
"""
import sys

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

XML = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
  </interface>
</node>
"""

calls_file = sys.argv[1]
TITLE, ARTIST, ALBUM, IDENTITY = (sys.argv[2:6] + ["Test Track", "Test Artist", "Test Album", "Fake Player"][len(sys.argv[2:6]):])
status = "Playing"


def method_call(conn, sender, path, iface, method, params, invocation):
    global status
    with open(calls_file, "a") as f:
        f.write(method + "\n")
    if method == "PlayPause":
        status = "Paused" if status == "Playing" else "Playing"
        conn.emit_signal(None, path, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                         GLib.Variant("(sa{sv}as)", (iface, {"PlaybackStatus": GLib.Variant("s", status)}, [])))
    invocation.return_value(None)


def get_property(conn, sender, path, iface, prop):
    if prop == "Identity":
        return GLib.Variant("s", IDENTITY)
    if prop == "PlaybackStatus":
        return GLib.Variant("s", status)
    if prop == "Metadata":
        return GLib.Variant("a{sv}", {
            "xesam:title": GLib.Variant("s", TITLE),
            "xesam:artist": GLib.Variant("as", [ARTIST]),
            "xesam:album": GLib.Variant("s", ALBUM),
        })
    return None


def on_bus(conn, name):
    for iface in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
        conn.register_object("/org/mpris/MediaPlayer2", iface, method_call, get_property, None)


Gio.bus_own_name(Gio.BusType.SESSION, "org.mpris.MediaPlayer2.fakeplayer",
                 Gio.BusNameOwnerFlags.NONE, on_bus, None, None)
GLib.MainLoop().run()
