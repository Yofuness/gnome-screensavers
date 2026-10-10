// SPDX-License-Identifier: GPL-2.0-or-later
// Catalogue of available savers and how to launch them.
//
// Saver ids:
//   flurry:<preset>        XScreenSaver's port of the original macOS Flurry, per preset
//   xscreensaver:<hack>    any installed XScreenSaver hack (X11 window via Xwayland)
//   custom:<n>             user command from the "custom-savers" setting

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HACK_DIRS = ['/usr/lib/xscreensaver', '/usr/libexec/xscreensaver', '/usr/lib64/xscreensaver'];
const CONFIG_DIR = '/usr/share/xscreensaver/config';

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

function numberOption(a) {
    const low = Number(a.low), high = Number(a.high), def = Number(a.default);
    if (![low, high, def].every(Number.isFinite) || !a.arg)
        return null;
    return {
        type: 'number', id: a.id, label: a._label ?? a.id,
        lowLabel: a['_low-label'] ?? '', highLabel: a['_high-label'] ?? '',
        low, high, default: def, arg: a.arg,
        invert: a.convert === 'invert', spin: a.type === 'spinbutton',
    };
}

function booleanOption(a) {
    if (!a['arg-set'] && !a['arg-unset'])
        return null;
    return {
        type: 'boolean', id: a.id, label: a._label ?? a.id,
        default: !a['arg-set'], set: a['arg-set'] ?? '', unset: a['arg-unset'] ?? '',
    };
}

function selectOption(a, body) {
    const choices = [...body.matchAll(/<option\b([^>]*?)\/?>/g)].map((o, i) => {
        const oa = xmlAttrs(o[1]);
        return {id: oa.id ?? String(i), label: oa._label ?? oa.id ?? String(i), arg: oa['arg-set'] ?? ''};
    });
    if (choices.length < 2)
        return null;
    const def = choices.find(c => !c.arg) ?? choices[0];
    return {type: 'select', id: a.id, label: a._label ?? a.id, default: def.id, choices};
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
        const a = xmlAttrs(m[2] ?? m[3]);
        if (!a.id)
            continue;
        let option;
        if (m[1] === 'number')
            option = numberOption(a);
        else if (m[1] === 'boolean')
            option = booleanOption(a);
        else if (m[1])
            option = a.arg ? {type: 'string', id: a.id, label: a._label ?? a.id, default: '', arg: a.arg} : null;
        else
            option = selectOption(a, m[4]);
        if (option)
            options.push(option);
    }
    return options;
}

/** Command-line arguments for the values that differ from each option's default. */
export function optionArgs(options, values) {
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

/** All stored option values ("saver-options"); the key may hold hand-edited JSON. */
export function readSaverOptions(settings) {
    try {
        return JSON.parse(settings.get_string('saver-options'));
    } catch {
        return {};
    }
}

/** The key that option values are stored under for a saver id. */
export function optionsKey(id) {
    return id.startsWith('flurry:') ? 'xscreensaver:flurry' : id;
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
        description: desc.trim().replace(/\s+/g, ' ').split(/ (?:https?:|Written by)/)[0],
    };
}

async function isDirectory(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
        return info.get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
        return false;
    }
}

async function listXmlFiles(dir) {
    const names = [];
    const en = await Gio.File.new_for_path(dir).enumerate_children_async(
        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each batch depends on the previous one
        const batch = await en.next_files_async(64, GLib.PRIORITY_LOW, null);
        if (!batch.length)
            break;
        names.push(...batch.map(i => i.get_name()).filter(n => n.endsWith('.xml')));
    }
    return names;
}

/** One hack from its config file, or null if it isn't installed or unreadable. */
async function loadHack(hackDir, file) {
    try {
        const [bytes] = await Gio.File.new_for_path(`${CONFIG_DIR}/${file}`).load_contents_async(null);
        const info = parseHackConfig(new TextDecoder('latin1').decode(bytes));
        if (!info?.name)
            return null;
        const exe = `${hackDir}/${info.name}`;
        const exeInfo = await Gio.File.new_for_path(exe).query_info_async(
            'access::can-execute', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
        return exeInfo.get_attribute_boolean('access::can-execute') ? {...info, exe} : null;
    } catch {
        return null;
    }
}

export class Registry {
    constructor(settings) {
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
        const found = await Promise.all(HACK_DIRS.map(isDirectory));
        const hackDir = HACK_DIRS[found.indexOf(true)];
        let hacks = [];
        if (hackDir) {
            const files = await listXmlFiles(CONFIG_DIR).catch(() => []);
            hacks = (await Promise.all(files.map(f => loadHack(hackDir, f)))).filter(Boolean);
        }
        hacks.sort((a, b) => a.label.localeCompare(b.label));
        this._hacks = hacks;
    }

    _hack(name) {
        return (this._hacks ?? []).find(h => h.name === name) ?? null;
    }

    _customs() {
        return this._settings.get_strv('custom-savers').map((line, i) => {
            const bar = line.indexOf('|');
            const name = bar >= 0 ? line.slice(0, bar).trim() : `Custom ${i + 1}`;
            const command = bar >= 0 ? line.slice(bar + 1).trim() : line.trim();
            return {id: `custom:${i}`, name, command};
        }).filter(c => c.command);
    }

    /** All savers as {id, name, group, description}. */
    list() {
        const out = [];
        for (const p of this._hack('flurry')?.presets ?? []) {
            out.push({
                id: `flurry:${p.name}`,
                name: `Flurry (${p.label})`,
                group: 'Flurry',
                description: 'The original macOS Flurry, as ported to XScreenSaver.',
            });
        }
        for (const h of this._hacks ?? []) {
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

    /** Settable options for a saver (empty for custom commands). */
    options(id) {
        const key = optionsKey(id);
        if (!key.startsWith('xscreensaver:'))
            return [];
        const options = this._hack(key.slice('xscreensaver:'.length))?.options ?? [];
        // Flurry's preset is chosen through its own list entries.
        if (id.startsWith('flurry:'))
            return options.filter(o => !(o.type === 'select' && o.choices.some(c => c.arg.startsWith('--preset'))));
        return options;
    }

    _extraArgs(id) {
        return optionArgs(this.options(id), readSaverOptions(this._settings)[optionsKey(id)] ?? {});
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
        const colon = id.indexOf(':');
        const [kind, arg] = [id.slice(0, colon), id.slice(colon + 1)];
        if (kind === 'flurry') {
            const flurry = this._hack('flurry');
            if (!flurry)
                return null;
            const preset = flurry.presets.some(p => p.name === arg) ? arg : 'classic';
            const argv = [flurry.exe, '--preset', preset, ...this._extraArgs(id)];
            return () => ({argv, title: flurry.label});
        }
        if (kind === 'xscreensaver') {
            const hack = this._hack(arg);
            if (!hack)
                return null;
            // With no -root / -window-id a hack opens its own top-level X window.
            const argv = [hack.exe, ...this._extraArgs(id)];
            return () => ({argv, title: hack.label});
        }
        if (kind === 'custom') {
            const c = this._customs().find(x => x.id === id);
            if (!c)
                return null;
            let argv;
            try {
                [, argv] = GLib.shell_parse_argv(c.command);
            } catch (e) {
                console.warn(`[screensavers] can't parse custom command "${c.command}": ${e.message}`);
                return null;
            }
            return monitor => ({
                argv: argv.map(a => a
                    .replaceAll('%w', String(monitor.width))
                    .replaceAll('%h', String(monitor.height))),
            });
        }
        return null;
    }
}
