// SPDX-License-Identifier: GPL-2.0-or-later
// Catalogue of available savers and how to launch them.
//
// Saver ids:
//   flurry:<preset>        XScreenSaver's port of the original macOS Flurry, per preset
//   xscreensaver:<hack>    any installed XScreenSaver hack (X11 window via Xwayland)
//   custom:<n>             user command from the "custom-savers" setting

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {HACK_FIXES} from './hackFixes.js';

const HACK_DIRS = ['/usr/lib/xscreensaver', '/usr/libexec/xscreensaver', '/usr/lib64/xscreensaver'];
const CONFIG_DIR = '/usr/share/xscreensaver/config';

// Defaults that differ from the hack's own, used until the user picks a value.
// Sonar pings real hosts by default, which needs raw-socket privileges a
// screensaver started by the shell may not have; its simulation needs none.
const DEFAULT_VALUES = {
    'xscreensaver:sonar': {ping: 'sim'},
};

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
 * Image, text and video helpers are skipped.  hackFixes.js may correct the
 * list per hack; its options can add `when: values => bool`.
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
    return withMatchDisplay(options);
}

const MATCH_DISPLAY = 'matchDisplay';

/**
 * Most hacks have a "Frame rate" slider: --delay, the microseconds slept after
 * each frame.  Add a "Match display" switch in front of it; when on, the
 * slider is hidden and the launcher passes the delay for the monitor's
 * refresh rate instead (Registry.launcher).
 */
function withMatchDisplay(options) {
    const i = options.findIndex(isFrameDelay);
    if (i < 0)
        return options;
    const delay = options[i];
    return [
        ...options.slice(0, i),
        {type: 'boolean', id: MATCH_DISPLAY, label: 'Match display refresh rate', default: false,
            set: '', unset: '', subtitle: 'Draws one frame per screen refresh instead of using the slider.'},
        {...delay, when: values => !values[MATCH_DISPLAY] && (delay.when?.(values) ?? true)},
        ...options.slice(i + 1),
    ];
}

function isFrameDelay(o) {
    return o.type === 'number' && o.label === 'Frame rate' && o.arg.trim() === '--delay %';
}

/** --delay (microseconds per frame) for a refresh rate in Hz, within the slider's range. */
export function frameDelay(option, hz) {
    const us = Math.round(1e6 / (hz > 0 ? hz : 60));
    return Math.min(option.high, Math.max(option.low, us));
}

// An option with a non-default value whose row applies (`when`).
function isSet(o, values) {
    return o.id in values && values[o.id] !== o.default && (o.when?.(values) ?? true);
}

/** Command-line arguments for the values that differ from each hack's own default. */
export function optionArgs(options, values) {
    const fill = (template, value) => template.trim().split(/\s+/).map(t => t.replace('%', value));
    const args = [];
    for (const o of options) {
        if (!isSet(o, values))
            continue;
        const v = values[o.id];
        if ((o.type === 'number' || o.type === 'string') && !o.arg)
            continue;                   // built by the hack's own args() (hackFixes.js)
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

/** Saved playlists ("playlists"): [{name, savers: [ids]}]. */
export function readPlaylists(settings) {
    try {
        const list = JSON.parse(settings.get_string('playlists'));
        return Array.isArray(list)
            ? list.filter(p => p?.name && Array.isArray(p.savers)).map(p => ({name: p.name, savers: p.savers}))
            : [];
    } catch {
        return [];
    }
}

const PLAYLIST_FILE_FORMAT = 'gnome-screensavers-playlists';

/** The contents of an exported playlist file. */
export function playlistsToFile(playlists) {
    return `${JSON.stringify({format: PLAYLIST_FILE_FORMAT, version: 1, playlists}, null, 2)}\n`;
}

/**
 * Add the playlists from an exported file to `existing`; clashing names get a
 * number.  Returns {playlists, added}; throws if the text isn't a playlist file.
 */
export function mergePlaylistFile(existing, text) {
    const data = JSON.parse(text);
    if (data?.format !== PLAYLIST_FILE_FORMAT || !Array.isArray(data.playlists))
        throw new Error('not a playlist file');
    const imported = data.playlists
        .filter(p => typeof p?.name === 'string' && p.name.trim() && Array.isArray(p.savers))
        .map(p => ({name: p.name.trim(), savers: p.savers.filter(id => typeof id === 'string')}));
    const playlists = [...existing];
    const taken = new Set(playlists.map(p => p.name));
    for (const playlist of imported) {
        let name = playlist.name;
        for (let n = 2; taken.has(name); n++)
            name = `${playlist.name} (${n})`;
        taken.add(name);
        playlists.push({...playlist, name});
    }
    return {playlists, added: imported.length};
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
    const name = attr('name');
    const fix = HACK_FIXES[name]?.options ?? (options => options);
    return {
        presets,
        options: fix(parseOptions(xml)),
        name,
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

function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export class Registry {
    /**
     * env: extra environment for XScreenSaver hacks (the shell passes the
     * private HOME from imageConfig.js); custom commands run unchanged.
     * refreshRate: monitor => Hz, for the "Match display refresh rate" option.
     */
    constructor(settings, {env = null, refreshRate = () => 60} = {}) {
        this._settings = settings;
        this._env = env;
        this._refreshRate = refreshRate;
        this._hacks = null;
        this._shuffle = {key: null, queue: []};
    }

    /**
     * Shuffle like a music player: play the whole pool in a random order, then
     * reshuffle.  Nothing repeats until everything has played, and a new round
     * never starts with the one that just played.  Editing the pool starts a
     * new round.  avoid: savers on other monitors, skipped over while the
     * round has something else left.
     */
    _nextShuffled(pool, current, avoid = new Set()) {
        if (!pool.length)
            return null;
        const key = [...pool].sort().join('\n');
        const state = this._shuffle;
        if (state.key !== key) {
            state.key = key;
            state.queue = [];
        }
        if (!state.queue.length) {
            state.queue = shuffled(pool);
            if (state.queue.length > 1 && state.queue[0] === current)
                state.queue.push(state.queue.shift());
        }
        const i = state.queue.findIndex(id => !avoid.has(id));
        return state.queue.splice(Math.max(0, i), 1)[0];
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

    /** Default values for a saver's options, including our overrides. */
    defaults(id) {
        const values = Object.fromEntries(this.options(id).map(o => [o.id, o.default]));
        return {...values, ...DEFAULT_VALUES[optionsKey(id)]};
    }

    /** Option values for a saver: the user's choices over the defaults. */
    values(id) {
        return {...this.defaults(id), ...readSaverOptions(this._settings)[optionsKey(id)]};
    }

    _extraArgs(id) {
        const values = this.values(id);
        const fixArgs = HACK_FIXES[optionsKey(id).slice('xscreensaver:'.length)]?.args;
        return [...optionArgs(this.options(id), values), ...fixArgs?.(values) ?? []];
    }

    // Per-monitor arguments: the frame delay when "Match display" is on.
    _monitorArgs(id, monitor) {
        const delay = this.options(id).find(isFrameDelay);
        if (!delay || !this.values(id)[MATCH_DISPLAY])
            return [];
        return ['--delay', String(frameDelay(delay, this._refreshRate(monitor)))];
    }

    // The active playlist, limited to savers that are installed; null if none.
    _activePlaylist() {
        const name = this._settings.get_string('active-playlist');
        const playlist = name && readPlaylists(this._settings).find(p => p.name === name);
        if (!playlist)
            return null;
        const known = new Set(this.list().map(s => s.id));
        const savers = playlist.savers.filter(id => known.has(id));
        return savers.length ? {...playlist, savers} : null;
    }

    /** Pick the saver to run now; see chooseMany(). */
    choose(options = {}) {
        return this.chooseMany(1, options)[0];
    }

    /**
     * Pick n savers to run now (one per monitor when monitors differ).  An
     * active playlist wins: shuffled, or in order continuing where it left off
     * (consecutive items for consecutive monitors; "shuffle" decides).
     * Otherwise "random" picks from "random-pool" (favourites, or all); the
     * random argument forces that (rotation, skipping).  current is the saver
     * on screen, so a new shuffle round
     * doesn't start with it.  avoid: savers staying on other monitors;
     * previous[i]: what pick i replaces.  Picks in one call avoid each other
     * too.  The selected saver is the same n times.
     */
    chooseMany(n, {random = false, current = null, avoid = [], previous = []} = {}) {
        const taken = new Set(avoid);
        const times = f => Array.from({length: n}, (_, i) => f(i));
        const shuffledPick = (pool, i) => {
            const skip = new Set(taken);
            if (previous[i])
                skip.add(previous[i]);
            const id = this._nextShuffled(pool, current, skip);
            taken.add(id);
            return id;
        };
        const playlist = this._activePlaylist();
        if (playlist) {
            if (this._settings.get_boolean('shuffle'))
                return times(i => shuffledPick(playlist.savers, i));
            if (this._playlistName !== playlist.name)
                this._playlistPos = -1;
            this._playlistName = playlist.name;
            return times(() => {
                this._playlistPos = (this._playlistPos + 1) % playlist.savers.length;
                return playlist.savers[this._playlistPos];
            });
        }
        if (random || this._settings.get_boolean('random')) {
            const all = this.list().map(s => s.id);
            const favs = this._settings.get_strv('favorites');
            const pool = this._settings.get_string('random-pool') === 'favourites' && favs.length ? favs : all;
            if (pool.length)
                return times(i => shuffledPick(pool, i));
        }
        return times(() => this._settings.get_string('saver'));
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
            return monitor => ({argv: [...argv, ...this._monitorArgs(id, monitor)], title: flurry.label, env: this._env});
        }
        if (kind === 'xscreensaver') {
            const hack = this._hack(arg);
            if (!hack)
                return null;
            // With no -root / -window-id a hack opens its own top-level X window.
            const argv = [hack.exe, ...this._extraArgs(id)];
            return monitor => ({argv: [...argv, ...this._monitorArgs(id, monitor)], title: hack.label, env: this._env});
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
