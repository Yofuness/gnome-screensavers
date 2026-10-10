// SPDX-License-Identifier: GPL-2.0-or-later
// Catalogue of available savers and how to launch them.
//
// Saver ids:
//   flurry:<preset>        XScreenSaver's port of the original macOS Flurry, per preset
//   xscreensaver:<hack>    any installed XScreenSaver hack (X11 window via Xwayland)
//   custom:<n>             user command from the "custom-savers" setting

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Preset names used by the old bundled clone, mapped to the original's.
const OLD_FLURRY_PRESETS = {rainbow: 'rgb', mono: 'classic'};
const HACK_DIRS = ['/usr/lib/xscreensaver', '/usr/libexec/xscreensaver', '/usr/lib64/xscreensaver'];
const CONFIG_DIRS = ['/usr/share/xscreensaver/config'];

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder('latin1').decode(bytes) : null;
    } catch {
        return null;
    }
}

function listDir(path) {
    const names = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)))
            names.push(info.get_name());
    } catch {
        // missing directory
    }
    return names;
}

/** Parse one XScreenSaver config XML just enough for a label and description. */
function parseHackConfig(xml) {
    const root = xml.match(/<screensaver\b([^>]*)>/);
    if (!root)
        return null;
    const attr = name => root[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const desc = xml.match(/<_description>([\s\S]*?)<\/_description>/)?.[1] ?? '';
    // <option _label="Fire" arg-set="--preset fire"/> entries, if the hack has presets.
    const presets = [...xml.matchAll(/<option\b[^>]*_label="([^"]*)"[^>]*arg-set="--preset ([^"]+)"/g)]
        .map(m => ({label: m[1], name: m[2]}));
    return {
        presets,
        name: attr('name'),
        label: attr('_label') ?? attr('name'),
        gl: attr('gl') === 'yes',
        description: desc.trim().replace(/\s+/g, ' ').split(/ (?:https?:|Written by)/)[0],
    };
}

export class Registry {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._hacks = null;
    }

    get loaded() {
        return this._hacks !== null;
    }

    /**
     * Scan the installed hacks without blocking: the shell calls this once at
     * enable() and waits for it before showing a saver.  (The preferences
     * window, a separate process, uses the synchronous scan below.)
     */
    async load() {
        if (this._hacks)
            return;
        const isDir = async path => {
            try {
                const info = await Gio.File.new_for_path(path).query_info_async(
                    'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
                return info.get_file_type() === Gio.FileType.DIRECTORY;
            } catch {
                return false;
            }
        };
        let hackDir = null;
        for (const d of HACK_DIRS) {
            if (await isDir(d)) {
                hackDir = d;
                break;
            }
        }
        const hacks = [];
        for (const configDir of hackDir ? CONFIG_DIRS : []) {
            let names = [];
            try {
                const en = await Gio.File.new_for_path(configDir).enumerate_children_async(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
                let batch;
                while ((batch = await en.next_files_async(64, GLib.PRIORITY_LOW, null)).length)
                    names.push(...batch.map(i => i.get_name()));
            } catch {
                names = [];
            }
            for (const file of names.filter(n => n.endsWith('.xml'))) {
                try {
                    const [bytes] = await Gio.File.new_for_path(`${configDir}/${file}`)
                        .load_contents_async(null);
                    const info = parseHackConfig(new TextDecoder('latin1').decode(bytes));
                    if (!info?.name)
                        continue;
                    const exe = `${hackDir}/${info.name}`;
                    const exeInfo = await Gio.File.new_for_path(exe).query_info_async(
                        'access::can-execute', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
                    if (exeInfo.get_attribute_boolean('access::can-execute'))
                        hacks.push({...info, exe});
                } catch {
                    // unreadable config or missing program: skip it
                }
            }
        }
        hacks.sort((a, b) => a.label.localeCompare(b.label));
        this._hacks = hacks;
    }

    _scanHacks() {
        if (this._hacks)
            return this._hacks;
        const hackDir = HACK_DIRS.find(d => GLib.file_test(d, GLib.FileTest.IS_DIR));
        const hacks = [];
        if (hackDir) {
            for (const configDir of CONFIG_DIRS) {
                for (const file of listDir(configDir)) {
                    if (!file.endsWith('.xml'))
                        continue;
                    const info = parseHackConfig(readText(`${configDir}/${file}`) ?? '');
                    if (!info?.name)
                        continue;
                    const exe = `${hackDir}/${info.name}`;
                    if (!GLib.file_test(exe, GLib.FileTest.IS_EXECUTABLE))
                        continue;
                    hacks.push({...info, exe});
                }
            }
        }
        hacks.sort((a, b) => a.label.localeCompare(b.label));
        this._hacks = hacks;
        return hacks;
    }

    _customs() {
        return this._settings.get_strv('custom-savers').map((line, i) => {
            const bar = line.indexOf('|');
            const name = bar >= 0 ? line.slice(0, bar).trim() : `Custom ${i + 1}`;
            const command = bar >= 0 ? line.slice(bar + 1).trim() : line.trim();
            return {id: `custom:${i}`, name, command};
        }).filter(c => c.command);
    }

    _flurry() {
        return this._scanHacks().find(h => h.name === 'flurry') ?? null;
    }

    /** All savers as {id, name, group, description}. */
    list() {
        const out = [];
        const flurry = this._flurry();
        for (const p of flurry?.presets ?? []) {
            out.push({
                id: `flurry:${p.name}`,
                name: `Flurry (${p.label})`,
                group: 'Flurry',
                description: 'The original macOS Flurry, as ported to XScreenSaver.',
            });
        }
        for (const h of this._scanHacks()) {
            if (h.name === 'flurry')
                continue; // listed above, once per preset
            out.push({
                id: `xscreensaver:${h.name}`,
                name: h.label,
                group: 'XScreenSaver',
                description: h.description,
            });
        }
        for (const c of this._customs())
            out.push({id: c.id, name: c.name, group: 'Custom', description: c.command});
        return out;
    }

    /** Pick the saver to run now, honouring the random/favourites settings. */
    choose() {
        if (this._settings.get_boolean('random')) {
            const favs = this._settings.get_strv('favorites');
            const pool = favs.length ? favs : this.list().map(s => s.id);
            if (pool.length)
                return pool[Math.floor(Math.random() * pool.length)];
        }
        return this._settings.get_string('saver');
    }

    /**
     * Turn a saver id into a per-monitor launcher for SaverSession.
     * Returns null for unknown ids.
     */
    launcher(id) {
        const [kind, arg] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
        if (kind === 'flurry') {
            const flurry = this._flurry();
            if (!flurry)
                return null;
            const wanted = OLD_FLURRY_PRESETS[arg] ?? arg;
            const preset = flurry.presets.some(p => p.name === wanted) ? wanted : 'classic';
            return () => ({argv: [flurry.exe, '--preset', preset], title: flurry.label});
        }
        if (kind === 'xscreensaver') {
            const hack = this._scanHacks().find(h => h.name === arg);
            if (!hack)
                return null;
            // With no -root / -window-id a hack opens its own top-level X window.
            return () => ({argv: [hack.exe], title: hack.label});
        }
        if (kind === 'custom') {
            const c = this._customs().find(x => x.id === id);
            if (!c)
                return null;
            const [ok, argv] = GLib.shell_parse_argv(c.command);
            if (!ok)
                return null;
            return monitor => ({
                argv: argv.map(a => a
                    .replaceAll('%w', String(monitor.width))
                    .replaceAll('%h', String(monitor.height))),
            });
        }
        return null;
    }
}
