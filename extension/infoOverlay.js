// SPDX-License-Identifier: GPL-2.0-or-later
// Clock and now-playing info shown in the top-left corner of the primary
// monitor while a screensaver runs, plus MPRIS control for the media keys.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const DRIFT_SECONDS = 120;   // nudge the overlay around to avoid burn-in
const DRIFT_PIXELS = 40;
const MARGIN_X = 48;
const MARGIN_Y = 40;

// Sizes at 100%; scaled by setting fonts directly so text stays sharp at any size.
const BASE = {time: 64, date: 16, title: 13, artist: 11, player: 9, art: 56, mediaGap: 28, artGap: 14};

// Players can vanish or refuse a call at any time; only cancellation is expected.
function ignoreCancelled(e) {
    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        console.warn(`[screensavers] media player: ${e.message}`);
}

/** Tracks MPRIS players on the session bus and picks the one that matters. */
export class MediaWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._players = new Map();   // bus name -> {proxy, identity}
        this._cancellable = new Gio.Cancellable();
        this._ownerId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner)
                    this._add(name);
                else
                    this._remove(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                let names;
                try {
                    [names] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    ignoreCancelled(e);
                    return;
                }
                names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._add(n));
            });
    }

    _add(name) {
        if (this._players.has(name))
            return;
        const entry = {proxy: null, identity: name.slice(MPRIS_PREFIX.length).split('.')[0]};
        this._players.set(name, entry);
        Gio.DBusProxy.new(Gio.DBus.session, Gio.DBusProxyFlags.NONE, null, name,
            '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', this._cancellable,
            (_o, res) => {
                try {
                    entry.proxy = Gio.DBusProxy.new_finish(res);
                } catch (e) {
                    ignoreCancelled(e);
                    return;
                }
                if (this._players.get(name) !== entry)
                    return;
                entry.changedId = entry.proxy.connect('g-properties-changed', () => this._onChange());
                this._onChange();
            });
        // Friendly player name ("Spotify", "Firefox") from the root interface.
        Gio.DBus.session.call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', 'Identity']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                // Without an Identity the bus-name fallback stays.
                try {
                    entry.identity = conn.call_finish(res).deepUnpack()[0].deepUnpack();
                } catch (e) {
                    ignoreCancelled(e);
                    return;
                }
                this._onChange();
            });
    }

    _remove(name) {
        const entry = this._players.get(name);
        if (entry?.changedId)
            entry.proxy.disconnect(entry.changedId);
        this._players.delete(name);
        this._onChange();
    }

    /** The playing player, else a paused one, as {identity, title, artist, album, art, status}. */
    current() {
        let best = null;
        for (const entry of this._players.values()) {
            const p = entry.proxy;
            if (!p)
                continue;
            const status = p.get_cached_property('PlaybackStatus')?.deepUnpack() ?? 'Stopped';
            const meta = p.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
            const title = meta['xesam:title'];
            if (!title || status === 'Stopped')
                continue;
            const info = {
                entry,
                identity: entry.identity,
                title,
                artist: [].concat(meta['xesam:artist'] ?? []).join(', '),
                album: meta['xesam:album'] ?? '',
                art: meta['mpris:artUrl'] ?? '',
                status,
            };
            if (status === 'Playing')
                return info;
            best ??= info;
        }
        return best;
    }

    /** Send PlayPause / Next / Previous to the current player. */
    command(method) {
        const target = this.current()?.entry ?? [...this._players.values()].find(e => e.proxy);
        target?.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        for (const entry of this._players.values()) {
            if (entry.changedId)
                entry.proxy.disconnect(entry.changedId);
        }
        this._players.clear();
    }
}

/** The clock + now-playing box for the primary monitor. */
export class InfoOverlay {
    constructor({monitor, showClock, showMedia, media, scale = 1}) {
        this._monitor = monitor;
        this._media = media;
        this._scale = scale;
        this.actor = new St.BoxLayout({
            style_class: 'screensavers-info',
            orientation: Clutter.Orientation.VERTICAL,
            x: monitor.x + Math.round(MARGIN_X * scale),
            y: monitor.y + Math.round(MARGIN_Y * scale),
        });

        if (showClock) {
            this._time = new St.Label({style_class: 'screensavers-time', x_align: Clutter.ActorAlign.START});
            this._date = new St.Label({style_class: 'screensavers-date', x_align: Clutter.ActorAlign.START});
            this.actor.add_child(this._time);
            this.actor.add_child(this._date);
            this._clock = new GnomeDesktop.WallClock({time_only: true});
            this._clockId = this._clock.connect('notify::clock', () => this._syncClock());
            this._syncClock();
        }

        if (showMedia) {
            this._mediaBox = new St.BoxLayout({style_class: 'screensavers-media', x_align: Clutter.ActorAlign.START});
            this._art = new St.Icon({style_class: 'screensavers-art', icon_size: 56});
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
            this._title = new St.Label({style_class: 'screensavers-title'});
            this._artist = new St.Label({style_class: 'screensavers-artist'});
            this._player = new St.Label({style_class: 'screensavers-player'});
            text.add_child(this._title);
            text.add_child(this._artist);
            text.add_child(this._player);
            this._mediaBox.add_child(this._art);
            this._mediaBox.add_child(text);
            this.actor.add_child(this._mediaBox);
            this.syncMedia();
        }

        this.setScale(scale);
        this._driftId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, DRIFT_SECONDS, () => {
            const s = this._scale;
            this.actor.ease({
                x: monitor.x + Math.round((MARGIN_X + Math.random() * DRIFT_PIXELS) * s),
                y: monitor.y + Math.round((MARGIN_Y + Math.random() * DRIFT_PIXELS) * s),
                duration: 4000,
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Resize the overlay (1 = 100%); safe to call while it is on screen. */
    setScale(scale) {
        this._scale = scale;
        const pt = n => `font-size: ${(n * scale).toFixed(1)}pt;`;
        const px = n => Math.round(n * scale);
        this._time?.set_style(pt(BASE.time));
        this._date?.set_style(pt(BASE.date));
        this._title?.set_style(pt(BASE.title));
        this._artist?.set_style(pt(BASE.artist));
        this._player?.set_style(pt(BASE.player));
        if (this._art)
            this._art.icon_size = px(BASE.art);
        this._mediaBox?.set_style(`margin-top: ${px(BASE.mediaGap)}px; spacing: ${px(BASE.artGap)}px;`);
        this.actor.remove_all_transitions();
        this.actor.set_position(this._monitor.x + px(MARGIN_X), this._monitor.y + px(MARGIN_Y));
    }

    _syncClock() {
        // WallClock follows the user's 12/24-hour preference.
        // The 12-hour format pads single-digit hours with a space; drop it.
        this._time.text = this._clock.clock.trim();
        this._date.text = GLib.DateTime.new_now_local().format('%A, %B %-d');
    }

    syncMedia() {
        if (!this._mediaBox)
            return;
        const now = this._media.current();
        this._mediaBox.visible = !!now;
        if (!now)
            return;
        this._title.text = now.title;
        this._artist.text = [now.artist, now.album].filter(Boolean).join(' — ');
        this._artist.visible = !!this._artist.text;
        this._player.text = now.status === 'Paused' ? `${now.identity} · paused` : now.identity;
        // Only local art; remote URLs would need a network fetch on the lock screen.
        if (now.art.startsWith('file://')) {
            this._art.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(now.art)});
        } else {
            this._art.gicon = null;
            this._art.icon_name = 'audio-x-generic-symbolic';
        }
    }

    destroy() {
        if (this._driftId)
            GLib.source_remove(this._driftId);
        this._driftId = 0;
        if (this._clockId)
            this._clock.disconnect(this._clockId);
        this._clock = null;
        this.actor.destroy();
    }
}
