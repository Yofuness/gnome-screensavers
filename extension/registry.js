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

function xmlAttrs(tag) {
    const out = {};
    for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g))
        out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    return out;
}

/**
 * The user-settable options of a hack, in document order, from its config XML:
 *   {type: 'number', id, label, lowLabel, highLabel, low, high, default, arg, invert, spin}
 *   {type: 'boolean', id, label, default, set, unset}
 *   {type: 'select', id, label, default, choices: [{id, label, arg}]}
 *   {type: 'string', id, label, default: '', arg}
 * Image, text and video helpers are skipped.
 */
export function parseOptions(xml) {
    const options = [];
    const re = /<(number|boolean|string|file)\b([^>]*?)\/?>|<select\b([^>]*)>([\s\S]*?)<\/select>/g;
    for (const m of xml.matchAll(re)) {
        if (m[1]) {
            const a = xmlAttrs(m[2]);
            if (!a.id)
                continue;
            if (m[1] === 'number') {
                const low = Number(a.low), high = Number(a.high), def = Number(a.default);
                if (![low, high, def].every(Number.isFinite) || !a.arg)
                    continue;
                options.push({
                    type: 'number', id: a.id, label: a._label ?? a.id,
                    lowLabel: a['_low-label'] ?? '', highLabel: a['_high-label'] ?? '',
                    low, high, default: def, arg: a.arg,
                    invert: a.convert === 'invert', spin: a.type === 'spinbutton',
                });
            } else if (m[1] === 'boolean') {
                if (!a['arg-set'] && !a['arg-unset'])
                    continue;
                options.push({
                    type: 'boolean', id: a.id, label: a._label ?? a.id,
                    default: !a['arg-set'], set: a['arg-set'] ?? '', unset: a['arg-unset'] ?? '',
                });
            } else if (a.arg) {
                options.push({type: 'string', id: a.id, label: a._label ?? a.id, default: '', arg: a.arg});
            }
        } else {
            const a = xmlAttrs(m[3]);
            const choices = [...m[4].matchAll(/<option\b([^>]*?)\/?>/g)].map((o, i) => {
                const oa = xmlAttrs(o[1]);
                return {id: oa.id ?? String(i), label: oa._label ?? oa.id ?? String(i), arg: oa['arg-set'] ?? ''};
            });
            if (!a.id || choices.length < 2)
                continue;
            const def = choices.find(c => !c.arg) ?? choices[0];
            options.push({type: 'select', id: a.id, label: a._label ?? a.id, default: def.id, choices});
        }
    }
    return options;
}

/** Command-line arguments for the values that differ from each option's default. */
export function optionArgs(options, values = {}) {
    const fill = (template, value) => template.trim().split(/\s+/).map(t => t.replace('%', value));
    const args = [];
    for (const o of options) {
        if (!(o.id in values) || values[o.id] === o.default)
            continue;
        const v = values[o.id];
        if (o.type === 'number') {
            const n = Number(v);
            if (!Number.isFinite(n))
                continue;
            const out = o.invert ? o.high + o.low - n : n;
            args.push(...fill(o.arg, String(Math.round(out * 1000) / 1000)));
        } else if (o.type === 'boolean') {
            const flag = v ? o.set : o.unset;
            if (flag)
                args.push(...flag.trim().split(/\s+/));
        } else if (o.type === 'select') {
            const choice = o.choices.find(c => c.id === v);
            if (choice?.arg)
                args.push(...choice.arg.trim().split(/\s+/));
        } else if (o.type === 'string' && typeof v === 'string' && v) {
            args.push(...fill(o.arg, v));
        }
    }
    return args;
}

/** Parse one XScreenSaver config XML: label, description, presets and options. */
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
        options: parseOptions(xml),
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
     * Scan the installed hacks without blocking.  The shell calls this once at
     * enable() and waits for it before showing a saver; the preferences window
     * fills in its list when it completes.
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

    /** Installed hacks; empty until load() has finished. */
    _scanHacks() {
        return this._hacks ?? [];
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

    /** The key that option values are stored under for a saver id. */
    optionsKey(id) {
        return id.startsWith('flurry:') ? 'xscreensaver:flurry' : id;
    }

    /** Settable options for a saver (empty for custom commands). */
    options(id) {
        const key = this.optionsKey(id);
        if (!key.startsWith('xscreensaver:'))
            return [];
        const hack = this._scanHacks().find(h => h.name === key.slice('xscreensaver:'.length));
        let options = hack?.options ?? [];
        // Flurry's preset is chosen through its own list entries.
        if (id.startsWith('flurry:'))
            options = options.filter(o => !(o.type === 'select' && o.choices.some(c => c.arg.startsWith('--preset'))));
        return options;
    }

    storedValues(id) {
        try {
            return JSON.parse(this._settings.get_string('saver-options'))[this.optionsKey(id)] ?? {};
        } catch {
            return {};
        }
    }

    _extraArgs(id) {
        return optionArgs(this.options(id), this.storedValues(id));
    }

    /**
     * Pick the saver to run now, honouring the random/favourites settings.
     * random forces a random pick (rotation); exclude avoids repeating a saver.
     */
    choose({random = false, exclude = null} = {}) {
        if (random || this._settings.get_boolean('random')) {
            const favs = this._settings.get_strv('favorites');
            let pool = favs.length ? favs : this.list().map(s => s.id);
            if (pool.length > 1 && exclude)
                pool = pool.filter(p => p !== exclude);
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
            const extra = this._extraArgs(id);
            return () => ({argv: [flurry.exe, '--preset', preset, ...extra], title: flurry.label});
        }
        if (kind === 'xscreensaver') {
            const hack = this._scanHacks().find(h => h.name === arg);
            if (!hack)
                return null;
            // With no -root / -window-id a hack opens its own top-level X window.
            const extra = this._extraArgs(id);
            return () => ({argv: [hack.exe, ...extra], title: hack.label});
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
