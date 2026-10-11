// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    Registry, mergePlaylistFile, optionsKey, playlistsToFile, readPlaylists, readSaverOptions,
} from './registry.js';
import {historyFile, parseHistory} from './history.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');

const esc = s => GLib.markup_escape_text(String(s), -1);

function formatDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 60)
        return `${seconds} s`;
    const m = Math.round(seconds / 60);
    if (m < 60)
        return `${m} min`;
    const h = Math.floor(m / 60), rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
}

// Ask the shell for a preview; it watches this key (see extension.js).
function preview(settings, id) {
    settings.set_string('preview-request', `${id}#${GLib.get_real_time()}`);
}

// Option labels in the XScreenSaver XML sometimes fall back to the bare id.
function optionLabel(o) {
    return o.label === o.id ? o.label.replace(/^./, c => c.toUpperCase()) : o.label;
}

/**
 * A row for an integer setting with short dropdown labels; the subtitle explains
 * what the selected choice does.  `also` lists further [object, signal] pairs
 * that change the explanation.
 *
 * An ActionRow with a separate dropdown rather than an Adw.ComboRow: the
 * ComboRow shrinks its value label to make room for a long subtitle, while a
 * Gtk.DropDown keeps its full width and the subtitle wraps instead.
 */
function choiceRow(settings, key, title, choices, also = []) {
    const row = new Adw.ActionRow({title, subtitle_lines: 0});
    const dropdown = Gtk.DropDown.new_from_strings(choices.map(c => c.label));
    dropdown.valign = Gtk.Align.CENTER;
    row.add_suffix(dropdown);
    row.activatable_widget = dropdown;

    const sync = () => {
        const v = settings.get_int(key);
        let i = choices.findIndex(c => c.value === v);
        if (i < 0)
            i = 0;
        if (dropdown.selected !== i)
            dropdown.selected = i;
        row.subtitle = choices[i].explain();
    };
    dropdown.connect('notify::selected', () => {
        const c = choices[dropdown.selected];
        if (c && settings.get_int(key) !== c.value)
            settings.set_int(key, c.value);
        row.subtitle = c?.explain() ?? '';
    });
    settings.connect(`changed::${key}`, sync);
    for (const [object, signal] of also)
        object.connect(signal, sync);
    sync();
    return row;
}

// The first widget of a type inside `widget` (for parts Adwaita has no API for).
function findDescendant(widget, type) {
    if (widget instanceof type)
        return widget;
    for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) {
        const found = findDescendant(c, type);
        if (found)
            return found;
    }
    return null;
}

// Grey out an overlay row when both the clock and now playing are off.
function needsOverlay(settings, row) {
    const sync = () => {
        row.sensitive = settings.get_boolean('show-clock') || settings.get_boolean('show-media');
    };
    settings.connect('changed::show-clock', sync);
    settings.connect('changed::show-media', sync);
    sync();
}

// The current Source: 'selected', 'favourites', 'all' or 'playlist:<name>'.
function sourceOf(settings) {
    const active = settings.get_string('active-playlist');
    if (active && readPlaylists(settings).some(p => p.name === active))
        return `playlist:${active}`;
    if (!settings.get_boolean('random'))
        return 'selected';
    return settings.get_string('random-pool') === 'all' ? 'all' : 'favourites';
}

const CORNERS = [
    ['top-left', 'Top left'],
    ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'],
    ['bottom-right', 'Bottom right'],
];

const ENDED = {
    key: ['input-keyboard-symbolic', 'Stopped by a key press'],
    click: ['input-mouse-symbolic', 'Stopped by a click'],
    'run-time': ['alarm-symbolic', 'Display duration over, screen turned off'],
    unlock: ['changes-allow-symbolic', 'Unlocked'],
    rotated: ['media-playlist-shuffle-symbolic', 'Changed to the next screensaver'],
    skipped: ['media-skip-forward-symbolic', 'Skipped with the skip key'],
    failed: ['dialog-warning-symbolic', 'Screensaver failed to start'],
};

export default class ScreensaversPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const registry = new Registry(settings);
        window.set_default_size(900, 860);
        window.search_enabled = false;
        const general = this._buildGeneralPage(settings, registry, window);
        window.add(general);
        window.add(this._buildPlaylistsPage(settings, registry, window));
        window.add(this._buildLibraryPage(settings, registry, window));
        window.add(this._buildHistoryPage(settings, window, general));
        window.add(this._buildCustomPage(settings, window));
        this._addTestButton(window, settings);
    }

    // A "Preview" button at the left of the title bar: runs the screensaver as it
    // would on the lock screen (your choice or a random pick, overlay, run time,
    // rotation) without locking.  PreferencesWindow has no API for header
    // buttons, so find its header bar and pack the button there.
    _addTestButton(window, settings) {
        const header = findDescendant(window, Adw.HeaderBar);
        if (!header)
            return;
        const button = new Gtk.Button({
            label: 'Preview',
            css_classes: ['suggested-action'],
            tooltip_text: 'Run the screensaver as it would appear when locked, without locking. ' +
                'Press a key or click to stop.',
        });
        button.connect('clicked', () => preview(settings, '@test'));
        header.pack_start(button);
    }

    // ── Library page ────────────────────────────────────────────────────

    _buildLibraryPage(settings, registry, window) {
        const page = new Adw.PreferencesPage({
            title: 'Library',
            icon_name: 'preferences-desktop-screensaver-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Screensavers',
            description: 'The radio button selects the screensaver used when General ▸ Source is ' +
                '“Selected screensaver”. ★ adds it to your Favourites, ⚙ opens its settings and ▶ previews it ' +
                '(press a key or click to stop).',
        });
        page.add(group);

        // Full width, under the description, directly above the list.
        const search = new Gtk.SearchEntry({placeholder_text: 'Search screensavers', margin_bottom: 12});
        group.add(search);

        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        group.add(list);

        const favourites = () => new Set(settings.get_strv('favorites'));
        let radioGroup = null;
        const radios = new Map();
        const rowSavers = new Map();

        const syncSelected = () => {
            const radio = radios.get(settings.get_string('saver'));
            if (radio && !radio.active)
                radio.active = true;
        };
        settings.connect('changed::saver', syncSelected);

        // The saver list is read from disk asynchronously; fill it in when ready.
        // Also rebuilt when custom commands change, so new ones appear at once.
        const populate = () => {
            list.remove_all();
            radios.clear();
            rowSavers.clear();
            radioGroup = null;
            const savers = registry.list();
            if (!savers.length) {
                group.description = 'No screensavers found. Install the xscreensaver package ' +
                    '(e.g. “sudo pacman -S xscreensaver”), then reopen this window.';
            }

            for (const saver of savers) {
                const row = new Adw.ActionRow({
                    title: esc(saver.name),
                    subtitle: esc(`${saver.group} · ${saver.description}`),
                    subtitle_lines: 2,
                });
                rowSavers.set(row, saver);

                const radio = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
                if (radioGroup)
                    radio.set_group(radioGroup);
                else
                    radioGroup = radio;
                radio.connect('toggled', () => {
                    if (radio.active && settings.get_string('saver') !== saver.id)
                        settings.set_string('saver', saver.id);
                });
                radios.set(saver.id, radio);
                row.add_prefix(radio);
                row.activatable_widget = radio;

                const star = new Gtk.ToggleButton({
                    icon_name: 'starred-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    active: favourites().has(saver.id),
                });
                const syncStar = () => {
                    star.tooltip_text = star.active ? 'Remove from Favourites' : 'Add to Favourites';
                };
                syncStar();
                star.connect('toggled', () => {
                    syncStar();
                    const favs = favourites();
                    if (star.active)
                        favs.add(saver.id);
                    else
                        favs.delete(saver.id);
                    settings.set_strv('favorites', [...favs]);
                });
                row.add_suffix(star);

                if (registry.options(saver.id).length) {
                    const gear = new Gtk.Button({
                        icon_name: 'emblem-system-symbolic',
                        valign: Gtk.Align.CENTER,
                        tooltip_text: 'Settings for this screensaver',
                        css_classes: ['flat'],
                    });
                    gear.connect('clicked', () => this._openOptions(settings, registry, saver, window));
                    row.add_suffix(gear);
                }

                const play = new Gtk.Button({
                    icon_name: 'media-playback-start-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Preview (press a key or click to stop)',
                    css_classes: ['flat'],
                });
                play.connect('clicked', () => preview(settings, saver.id));
                row.add_suffix(play);

                list.append(row);
            }
            syncSelected();
        };
        registry.load().then(() => {
            populate();
            settings.connect('changed::custom-savers', populate);
        }).catch(e => console.warn(`[screensavers] ${e.message}`));

        list.set_filter_func(row => {
            const q = search.text.trim().toLowerCase();
            if (!q)
                return true;
            const s = rowSavers.get(row);
            return `${s.name} ${s.group} ${s.description}`.toLowerCase().includes(q);
        });
        search.connect('search-changed', () => list.invalidate_filter());

        return page;
    }

    // A settings dialog generated from the hack's XScreenSaver config.
    _openOptions(settings, registry, saver, window) {
        const options = registry.options(saver.id);
        const key = optionsKey(saver.id);
        const defaults = registry.defaults(saver.id);
        const values = registry.values(saver.id);
        const save = () => {
            const all = readSaverOptions(settings);
            const changed = Object.fromEntries(Object.entries(values)
                .filter(([id, v]) => defaults[id] !== v));
            if (Object.keys(changed).length)
                all[key] = changed;
            else
                delete all[key];
            settings.set_string('saver-options', JSON.stringify(all));
        };
        // Rows that only apply to some settings (`when`, from hackFixes.js).
        const conditional = [];
        const syncVisible = () => {
            for (const [o, row] of conditional)
                row.visible = o.when(values);
        };
        const set = (id, v) => {
            values[id] = v;
            save();
            syncVisible();
        };

        // Tall enough for every row, so rows that appear later (`when`) don't
        // land below the fold; long lists scroll.
        const dialog = new Adw.PreferencesDialog({
            title: saver.name,
            search_enabled: false,
            content_height: Math.min(760, 230 + 60 * options.length),
        });
        const page = new Adw.PreferencesPage();
        dialog.add(page);
        const group = new Adw.PreferencesGroup({
            title: saver.name,
            description: saver.id.startsWith('flurry:')
                ? 'These settings apply to every Flurry preset.'
                : saver.description,
        });
        page.add(group);

        const widgets = [];
        const add = (o, row) => {
            if (o.when)
                conditional.push([o, row]);
            group.add(row);
        };
        for (const o of options) {
            const current = values[o.id];
            if (o.type === 'number') {
                const integer = [o.low, o.high, o.default].every(Number.isInteger);
                const range = o.high - o.low;
                const step = integer ? Math.max(1, Math.round(range / 100)) : range / 100;
                const adj = new Gtk.Adjustment({lower: o.low, upper: o.high, step_increment: step,
                    page_increment: step * 10, value: Number(current)});
                let row;
                if (o.spin) {
                    row = new Adw.SpinRow({title: esc(o.label), adjustment: adj, digits: integer ? 0 : 2});
                } else {
                    row = new Adw.ActionRow({
                        title: esc(optionLabel(o)),
                        subtitle: esc([o.lowLabel, o.highLabel].filter(Boolean).join(' ⟷ ')),
                    });
                    row.add_suffix(new Gtk.Scale({adjustment: adj, width_request: 260,
                        valign: Gtk.Align.CENTER, draw_value: false}));
                }
                adj.connect('value-changed', () => set(o.id,
                    integer ? Math.round(adj.value) : Math.round(adj.value * 1000) / 1000));
                widgets.push(() => {
                    adj.value = defaults[o.id];
                });
                add(o, row);
            } else if (o.type === 'boolean') {
                const row = new Adw.SwitchRow({title: esc(o.label), active: !!current});
                row.connect('notify::active', () => set(o.id, row.active));
                widgets.push(() => {
                    row.active = defaults[o.id];
                });
                add(o, row);
            } else if (o.type === 'select') {
                const row = new Adw.ComboRow({
                    title: esc(optionLabel(o)),
                    model: Gtk.StringList.new(o.choices.map(c => c.label)),
                    selected: Math.max(0, o.choices.findIndex(c => c.id === current)),
                });
                row.connect('notify::selected', () => set(o.id, o.choices[row.selected].id));
                widgets.push(() => {
                    row.selected = Math.max(0, o.choices.findIndex(c => c.id === defaults[o.id]));
                });
                add(o, row);
            } else {
                const row = new Adw.EntryRow({title: esc(o.label), text: String(current ?? ''),
                    show_apply_button: true});
                row.connect('apply', () => set(o.id, row.text));
                widgets.push(() => {
                    row.text = '';
                });
                add(o, row);
            }
        }
        syncVisible();

        const actions = new Gtk.Box({spacing: 12, halign: Gtk.Align.END, margin_top: 18});
        const reset = new Gtk.Button({label: 'Reset to defaults'});
        reset.connect('clicked', () => {
            widgets.forEach(r => r());
            Object.assign(values, defaults);
            save();
            syncVisible();
        });
        const play = new Gtk.Button({label: 'Preview', css_classes: ['suggested-action']});
        play.connect('clicked', () => preview(settings, saver.id));
        actions.append(reset);
        actions.append(play);
        group.add(actions);

        dialog.present(window);
    }

    // ── General page ────────────────────────────────────────────────────

    _buildGeneralPage(settings, registry, window) {
        const sessionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const lock = new Adw.PreferencesGroup({
            title: 'Lock screen',
            description: 'A key press or click dismisses the screensaver and shows the unlock prompt. ' +
                'Moving the mouse does not, and media keys control your player instead.',
        });
        page.add(lock);

        const onLock = new Adw.SwitchRow({title: 'Show screensaver when locked'});
        settings.bind('enabled-on-lock', onLock, 'active', Gio.SettingsBindFlags.DEFAULT);
        lock.add(onLock);

        const blankText = () => {
            const s = sessionSettings.get_uint('idle-delay');
            return s ? formatDuration(s) : 'Never';
        };
        const duration = choiceRow(settings, 'run-time', 'Display duration', [
            {value: -1, label: 'Match Screen Blank', explain: () => sessionSettings.get_uint('idle-delay')
                ? `Runs for your Screen Blank time (Settings ▸ Power, currently ${blankText()}), then the screen turns off.`
                : 'Screen Blank (Settings ▸ Power) is set to Never, so it runs until dismissed.'},
            {value: 0, label: 'Until dismissed',
                explain: () => 'Never stops on its own; the screen stays on while locked.'},
            ...[60, 300, 600, 900, 1800, 3600].map(v => ({
                value: v, label: formatDuration(v),
                explain: () => `Runs for ${formatDuration(v)}, then the screen turns off.`,
            })),
        ], [[sessionSettings, 'changed::idle-delay']]);
        lock.add(duration);

        const resume = choiceRow(settings, 'retrigger-delay', 'Resume after dismissal', [
            {value: 0, label: 'Never',
                explain: () => 'After a key press or click, the lock screen stays until you unlock.'},
            ...[15, 30, 60, 120, 300].map(v => ({
                value: v, label: formatDuration(v),
                explain: () => `Starts again after the lock screen is left idle for ${formatDuration(v)}.`,
            })),
        ]);
        lock.add(resume);
        // Only meaningful when locking shows a screensaver.
        for (const row of [duration, resume])
            settings.bind('enabled-on-lock', row, 'sensitive', Gio.SettingsBindFlags.GET);

        const selection = new Adw.PreferencesGroup({title: 'Screensaver selection'});
        page.add(selection);
        selection.add(this._sourceRow(settings, registry));
        selection.add(this._shuffleRow(settings));

        selection.add(choiceRow(settings, 'rotate-interval', 'Change screensaver', [
            {value: 0, label: 'Never', explain: () => 'Shows one screensaver the whole time.'},
            ...[1, 2, 5, 10, 15, 30, 60].map(m => ({
                value: m, label: `Every ${formatDuration(m * 60)}`,
                explain: () => `Moves on to the next screensaver from the source every ${formatDuration(m * 60)}.`,
            })),
        ]));
        selection.add(this._skipKeyRow(settings, window));
        selection.add(this._monitorModeRow(settings));

        const overlay = new Adw.PreferencesGroup({
            title: 'Overlay',
            description: 'The clock and what is playing, shown over the screensaver.',
        });
        page.add(overlay);
        const clock = new Adw.SwitchRow({title: 'Clock and date'});
        settings.bind('show-clock', clock, 'active', Gio.SettingsBindFlags.DEFAULT);
        overlay.add(clock);
        const media = new Adw.SwitchRow({
            title: 'Now playing',
            subtitle: 'Title and artist from your music or video player',
        });
        settings.bind('show-media', media, 'active', Gio.SettingsBindFlags.DEFAULT);
        overlay.add(media);
        overlay.add(this._sizeRow(settings));
        overlay.add(this._cornerRow(settings));
        overlay.add(this._monitorRow(settings));

        const history = new Adw.PreferencesGroup({
            title: 'History',
            description: 'A record of which screensaver ran when, stored only on this computer. ' +
                'Browse it on the History page.',
        });
        page.add(history);
        const log = new Adw.SwitchRow({title: 'Record history'});
        settings.bind('log-history', log, 'active', Gio.SettingsBindFlags.DEFAULT);
        history.add(log);

        const limit = new Adw.SpinRow({
            title: 'History size',
            adjustment: new Gtk.Adjustment({lower: 100, upper: 1000000, step_increment: 100,
                page_increment: 1000}),
        });
        settings.bind('history-limit', limit, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('log-history', limit, 'sensitive', Gio.SettingsBindFlags.GET);
        const syncLimit = () => {
            // About 150 bytes per run.
            const bytes = settings.get_int('history-limit') * 150;
            limit.subtitle = `Runs to keep; older ones are removed (about ${GLib.format_size(bytes)} on disk)`;
        };
        settings.connect('changed::history-limit', syncLimit);
        syncLimit();
        history.add(limit);

        return page;
    }

    // Where screensavers come from: the one selected in the Library, a random
    // favourite, a random one of all, or a playlist.  One choice over the
    // `random`, `random-pool` and `active-playlist` keys, which
    // registry.choose() reads (a playlist wins over random, random over the
    // selection).
    _sourceRow(settings, registry) {
        const row = new Adw.ActionRow({title: 'Source', subtitle_lines: 0});
        const dropdown = new Gtk.DropDown({valign: Gtk.Align.CENTER});
        row.add_suffix(dropdown);
        row.activatable_widget = dropdown;

        let values = [];
        let syncing = false;
        const explain = value => {
            const count = registry.list().length;
            if (value === 'favourites') {
                return settings.get_strv('favorites').length
                    ? 'A random favourite each time.'
                    : 'You have no favourites yet, so any screensaver can play. Add some with ★ in the Library.';
            }
            if (value === 'all')
                return `A random screensaver from all ${count} installed.`;
            if (value.startsWith('playlist:')) {
                const name = value.slice('playlist:'.length);
                const n = readPlaylists(settings).find(p => p.name === name)?.savers.length ?? 0;
                return `${n} screensaver${n === 1 ? '' : 's'}. Edit it on the Playlists page.`;
            }
            const id = settings.get_string('saver');
            const name = registry.list().find(s => s.id === id)?.name ?? id;
            return `${name}. Choose another in the Library.`;
        };
        const sync = () => {
            syncing = true;
            const playlists = readPlaylists(settings).map(p => p.name);
            const next = ['selected', 'favourites', 'all', ...playlists.map(n => `playlist:${n}`)];
            // Replace the model only when the playlists changed: swapping it
            // while the dropdown is handling a click crashes GTK.
            if (next.join('\n') !== values.join('\n')) {
                values = next;
                dropdown.model = Gtk.StringList.new(['Selected screensaver', 'Favourites', 'All screensavers',
                    ...playlists.map(n => `Playlist: ${n}`)]);
            }
            const value = sourceOf(settings);
            dropdown.selected = Math.max(0, values.indexOf(value));
            row.subtitle = esc(explain(value));
            syncing = false;
        };
        dropdown.connect('notify::selected', () => {
            if (syncing)
                return;
            const value = values[dropdown.selected] ?? 'selected';
            const playlist = value.startsWith('playlist:') ? value.slice('playlist:'.length) : '';
            settings.set_string('active-playlist', playlist);
            if (value === 'favourites' || value === 'all')
                settings.set_string('random-pool', value);
            settings.set_boolean('random', value === 'favourites' || value === 'all');
        });
        // Choosing an entry writes several keys; sync once afterwards, outside
        // the dropdown's own signal handler.
        let idleId = 0;
        const queueSync = () => {
            idleId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                idleId = 0;
                sync();
                return GLib.SOURCE_REMOVE;
            });
        };
        for (const key of ['playlists', 'active-playlist', 'random', 'random-pool', 'saver', 'favorites'])
            settings.connect(`changed::${key}`, queueSync);
        row.connect('destroy', () => {
            if (idleId)
                GLib.source_remove(idleId);
        });
        sync();
        // Saver names arrive with the asynchronously loaded catalogue.
        registry.load().then(sync).catch(e => console.warn(`[screensavers] ${e.message}`));
        return row;
    }

    // Whether a playlist plays shuffled; only a playlist source has an order.
    _shuffleRow(settings) {
        const row = new Adw.SwitchRow({title: 'Shuffle', subtitle_lines: 0});
        settings.bind('shuffle', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        const sync = () => {
            const playlist = sourceOf(settings).startsWith('playlist:');
            row.sensitive = playlist;
            if (!playlist)
                row.subtitle = 'Favourites and All screensavers always play in a random order.';
            else if (settings.get_boolean('shuffle'))
                row.subtitle = 'Plays the playlist in a random order, every screensaver once before any repeats.';
            else
                row.subtitle = 'Plays the playlist top to bottom, then starts over.';
        };
        for (const key of ['shuffle', 'playlists', 'active-playlist', 'random'])
            settings.connect(`changed::${key}`, sync);
        sync();
        return row;
    }

    // Overlay size: a slider with marked steps, the current value, a reset
    // button and a preview.  A running preview resizes live as it moves.
    _sizeRow(settings) {
        const row = new Adw.ActionRow({
            title: 'Size',
            subtitle: 'Press Preview in the title bar to see changes live',
        });
        const adj = new Gtk.Adjustment({lower: 25, upper: 200, step_increment: 5, page_increment: 25});
        const scale = new Gtk.Scale({
            adjustment: adj,
            width_request: 240,
            valign: Gtk.Align.CENTER,
            draw_value: false,
            round_digits: 0,
        });
        for (const mark of [25, 100, 200])
            scale.add_mark(mark, Gtk.PositionType.BOTTOM, `${mark}%`);
        for (const mark of [50, 75, 150])
            scale.add_mark(mark, Gtk.PositionType.BOTTOM, null);
        const value = new Gtk.Label({width_chars: 5, xalign: 1, css_classes: ['numeric']});
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Back to 100%',
            css_classes: ['flat'],
        });
        const sync = () => {
            const v = settings.get_int('overlay-scale');
            if (adj.value !== v)
                adj.value = v;
            value.label = `${v}%`;
            // Grey out rather than hide: hiding resized the slider under the
            // pointer mid-drag, which flipped the value back and forth.
            reset.sensitive = v !== 100;
        };
        adj.connect('value-changed', () => {
            // Snap to steps of 5.
            const v = Math.round(adj.value / 5) * 5;
            if (settings.get_int('overlay-scale') !== v)
                settings.set_int('overlay-scale', v);
            value.label = `${v}%`;
        });
        reset.connect('clicked', () => settings.set_int('overlay-scale', 100));
        settings.connect('changed::overlay-scale', sync);
        sync();

        needsOverlay(settings, row);

        row.add_suffix(value);
        row.add_suffix(scale);
        row.add_suffix(reset);
        return row;
    }

    // Only shown with more than one monitor.
    _monitorModeRow(settings) {
        const modes = [
            ['mirror', 'Mirrored', 'Every monitor shows the same picture, in sync.'],
            ['same', 'Same screensaver', 'Each monitor runs its own copy of the screensaver at its own resolution.'],
            ['different', 'Different on each', 'Each monitor gets its own screensaver from the source. ' +
                'Skipping changes all of them; timed changes go one monitor at a time.'],
        ];
        const row = new Adw.ActionRow({title: 'Multiple monitors', subtitle_lines: 0});
        const dropdown = Gtk.DropDown.new_from_strings(modes.map(m => m[1]));
        dropdown.valign = Gtk.Align.CENTER;
        row.add_suffix(dropdown);
        row.activatable_widget = dropdown;
        const sync = () => {
            const i = Math.max(0, modes.findIndex(m => m[0] === settings.get_string('monitor-mode')));
            if (dropdown.selected !== i)
                dropdown.selected = i;
            let subtitle = modes[i][2];
            if (modes[i][0] === 'different' && sourceOf(settings) === 'selected')
                subtitle += ' With “Selected screensaver” as the source, every monitor shows that one.';
            row.subtitle = subtitle;
        };
        dropdown.connect('notify::selected', () => {
            const value = modes[dropdown.selected]?.[0];
            if (value && settings.get_string('monitor-mode') !== value)
                settings.set_string('monitor-mode', value);
        });
        for (const key of ['monitor-mode', 'random', 'active-playlist'])
            settings.connect(`changed::${key}`, sync);
        sync();

        const monitors = Gdk.Display.get_default().get_monitors();
        const syncVisible = () => {
            row.visible = monitors.get_n_items() > 1;
        };
        monitors.connect('items-changed', syncVisible);
        syncVisible();
        return row;
    }

    _cornerRow(settings) {
        const row = new Adw.ActionRow({title: 'Position'});
        const dropdown = Gtk.DropDown.new_from_strings(CORNERS.map(c => c[1]));
        dropdown.valign = Gtk.Align.CENTER;
        row.add_suffix(dropdown);
        row.activatable_widget = dropdown;
        const sync = () => {
            const i = CORNERS.findIndex(c => c[0] === settings.get_string('overlay-corner'));
            if (dropdown.selected !== Math.max(0, i))
                dropdown.selected = Math.max(0, i);
        };
        dropdown.connect('notify::selected', () => {
            const value = CORNERS[dropdown.selected]?.[0];
            if (value && settings.get_string('overlay-corner') !== value)
                settings.set_string('overlay-corner', value);
        });
        settings.connect('changed::overlay-corner', sync);
        sync();
        needsOverlay(settings, row);
        return row;
    }

    // Monitors are stored by connector name ("DP-1"), which stays the same
    // across reboots and when other monitors are plugged in or removed.
    _monitorRow(settings) {
        const row = new Adw.ActionRow({title: 'Monitor', subtitle_lines: 0});
        const dropdown = new Gtk.DropDown({valign: Gtk.Align.CENTER});
        row.add_suffix(dropdown);
        row.activatable_widget = dropdown;
        const monitors = Gdk.Display.get_default().get_monitors();

        let values = [];
        let syncing = false;
        const sync = () => {
            syncing = true;
            const saved = settings.get_string('overlay-monitor');
            const labels = ['Primary'];
            values = [''];
            for (let i = 0; i < monitors.get_n_items(); i++) {
                const m = monitors.get_item(i);
                const connector = m.get_connector();
                if (!connector)
                    continue;
                const name = m.get_description() || [m.get_manufacturer(), m.get_model()].filter(Boolean).join(' ');
                values.push(connector);
                labels.push(name ? `${name} (${connector})` : connector);
            }
            const missing = saved && !values.includes(saved);
            if (missing) {
                values.push(saved);
                labels.push(`${saved} (not connected)`);
            }
            dropdown.model = Gtk.StringList.new(labels);
            dropdown.selected = Math.max(0, values.indexOf(saved));
            row.subtitle = missing
                ? 'This monitor is not connected, so the primary monitor is used.'
                : '';
            syncing = false;
        };
        dropdown.connect('notify::selected', () => {
            if (!syncing)
                settings.set_string('overlay-monitor', values[dropdown.selected] ?? '');
        });
        settings.connect('changed::overlay-monitor', sync);
        monitors.connect('items-changed', sync);
        sync();
        needsOverlay(settings, row);
        return row;
    }

    // The key that skips to the next screensaver: click, then press a key.
    _skipKeyRow(settings, window) {
        const row = new Adw.ActionRow({
            title: 'Skip key',
            subtitle: 'Shows the next screensaver from the source. Every other key still dismisses.',
        });
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'No skip key',
            css_classes: ['flat'],
        });
        const sync = () => {
            const keyval = settings.get_uint('skip-key');
            button.label = keyval ? Gtk.accelerator_get_label(keyval, 0) : 'None';
            clear.sensitive = keyval !== 0;
        };
        settings.connect('changed::skip-key', sync);
        sync();
        clear.connect('clicked', () => settings.set_uint('skip-key', 0));

        button.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Press a key',
                body: 'Press the key that should skip to the next screensaver. Escape cancels.',
            });
            dialog.add_response('cancel', 'Cancel');
            const keys = new Gtk.EventControllerKey();
            keys.connect('key-pressed', (_c, keyval) => {
                const modifiers = [Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R];
                if (modifiers.includes(keyval))
                    return Gdk.EVENT_PROPAGATE;
                if (keyval !== Gdk.KEY_Escape)
                    settings.set_uint('skip-key', Gdk.keyval_to_lower(keyval));
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(keys);
            dialog.present(window);
        });

        row.add_suffix(button);
        row.add_suffix(clear);
        return row;
    }

    // ── Playlists page ──────────────────────────────────────────────────

    _buildPlaylistsPage(settings, registry, window) {
        const page = new Adw.PreferencesPage({
            title: 'Playlists',
            icon_name: 'view-list-symbolic',
        });
        const save = playlists => settings.set_string('playlists', JSON.stringify(playlists));
        const names = () => new Map(registry.list().map(s => [s.id, s.name]));

        const listGroup = new Adw.PreferencesGroup({
            title: 'Your playlists',
            description: 'To play a playlist, choose it under General ▸ Source.',
        });
        page.add(listGroup);
        const newButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'New playlist'}),
            css_classes: ['flat'],
        });
        const importButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'document-open-symbolic', label: 'Import'}),
            tooltip_text: 'Add playlists from an exported file',
            css_classes: ['flat'],
        });
        const exportButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'document-save-symbolic', label: 'Export'}),
            tooltip_text: 'Save all playlists to a file',
            css_classes: ['flat'],
        });
        const headerButtons = new Gtk.Box({spacing: 6});
        [importButton, exportButton, newButton].forEach(b => headerButtons.append(b));
        listGroup.set_header_suffix(headerButtons);
        importButton.connect('clicked', () => this._importPlaylists(window, settings));
        exportButton.connect('clicked', () => this._exportPlaylists(window, settings));

        const expanded = new Set();
        let rows = [];
        const rebuild = () => {
            // Rebuilding the rows resets the page's scroll position; put it back
            // once the new rows are laid out, so editing a long playlist doesn't
            // jump to the top.
            const scroll = findDescendant(page, Gtk.ScrolledWindow)?.vadjustment;
            const position = scroll?.value ?? 0;
            if (scroll) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    scroll.value = position;
                    return GLib.SOURCE_REMOVE;
                });
            }
            rows.forEach(r => listGroup.remove(r));
            rows = [];
            const playlists = readPlaylists(settings);
            const saverNames = names();
            playlists.forEach((playlist, index) => {
                const row = this._playlistRow(playlist, saverNames, {
                    inUse: playlist.name === settings.get_string('active-playlist'),
                    previewSaver: id => preview(settings, id),
                    expanded: expanded.has(playlist.name),
                    onExpanded: open => (open ? expanded.add(playlist.name) : expanded.delete(playlist.name)),
                    update: changed => {
                        const all = readPlaylists(settings);
                        all[index] = {...all[index], ...changed};
                        save(all);
                    },
                    rename: () => this._askName(window, 'Rename playlist', playlist.name, name => {
                        const all = readPlaylists(settings);
                        all[index].name = name;
                        if (settings.get_string('active-playlist') === playlist.name)
                            settings.set_string('active-playlist', name);
                        save(all);
                    }),
                    remove: () => {
                        const all = readPlaylists(settings);
                        all.splice(index, 1);
                        if (settings.get_string('active-playlist') === playlist.name)
                            settings.set_string('active-playlist', '');
                        save(all);
                    },
                    add: () => this._pickSavers(window, settings, registry, playlist.savers, picked => {
                        const all = readPlaylists(settings);
                        all[index].savers = [...all[index].savers, ...picked];
                        save(all);
                    }),
                });
                listGroup.add(row);
                rows.push(row);
            });
            if (!playlists.length) {
                const empty = new Adw.ActionRow({title: 'No playlists yet'});
                listGroup.add(empty);
                rows.push(empty);
            }
        };

        newButton.connect('clicked', () => this._askName(window, 'New playlist', '', name => {
            expanded.add(name);
            save([...readPlaylists(settings), {name, savers: []}]);
        }));

        settings.connect('changed::playlists', rebuild);
        settings.connect('changed::active-playlist', rebuild);
        // Saver names come from the asynchronously loaded catalogue.
        registry.load().then(rebuild).catch(e => console.warn(`[screensavers] ${e.message}`));
        return page;
    }

    // One playlist: its screensavers in order, and actions.
    _playlistRow(playlist, saverNames, {inUse, expanded, onExpanded, update, rename, remove, add, previewSaver}) {
        const count = playlist.savers.length;
        const row = new Adw.ExpanderRow({
            title: esc(playlist.name),
            subtitle: `${count} screensaver${count === 1 ? '' : 's'}`,
            expanded,
        });
        row.connect('notify::expanded', () => onExpanded(row.expanded));
        if (inUse) {
            row.add_suffix(new Gtk.Label({label: 'In use', valign: Gtk.Align.CENTER,
                tooltip_text: 'Chosen under General ▸ Source', css_classes: ['dim-label', 'caption-heading']}));
        }

        const actions = [
            ['document-edit-symbolic', 'Rename', rename],
            ['user-trash-symbolic', 'Delete playlist', remove],
        ];
        for (const [icon, tooltip, callback] of actions) {
            const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip,
                valign: Gtk.Align.CENTER, css_classes: ['flat']});
            button.connect('clicked', callback);
            row.add_suffix(button);
        }


        const move = (from, to) => {
            const savers = [...playlist.savers];
            const [id] = savers.splice(from, 1);
            savers.splice(to, 0, id);
            update({savers});
        };
        playlist.savers.forEach((id, i) => {
            const saverRow = new Adw.ActionRow({title: esc(saverNames.get(id) ?? id)});
            const buttons = [
                ['media-playback-start-symbolic', 'Preview (press a key or click to stop)', true,
                    () => previewSaver(id)],
                ['go-up-symbolic', 'Move up', i > 0, () => move(i, i - 1)],
                ['go-down-symbolic', 'Move down', i < count - 1, () => move(i, i + 1)],
                ['list-remove-symbolic', 'Remove from playlist', true,
                    () => update({savers: playlist.savers.filter((_, j) => j !== i)})],
            ];
            for (const [icon, tooltip, sensitive, callback] of buttons) {
                const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, sensitive,
                    valign: Gtk.Align.CENTER, css_classes: ['flat']});
                button.connect('clicked', callback);
                saverRow.add_suffix(button);
            }
            row.add_row(saverRow);
        });

        const addRow = new Adw.ButtonRow({title: 'Add screensavers…', start_icon_name: 'list-add-symbolic'});
        addRow.connect('activated', add);
        row.add_row(addRow);
        return row;
    }

    // Write every playlist to a JSON file the user picks.
    async _exportPlaylists(window, settings) {
        const playlists = readPlaylists(settings);
        if (!playlists.length) {
            window.add_toast(new Adw.Toast({title: 'There are no playlists to export'}));
            return;
        }
        const dialog = new Gtk.FileDialog({title: 'Export playlists', initial_name: 'screensaver-playlists.json'});
        let file;
        try {
            file = await dialog.save(window, null);
        } catch {
            return; // dismissed
        }
        try {
            await file.replace_contents_async(new TextEncoder().encode(playlistsToFile(playlists)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            window.add_toast(new Adw.Toast({title: `Exported ${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`}));
        } catch (e) {
            window.add_toast(new Adw.Toast({title: `Couldn't export: ${e.message}`}));
        }
    }

    // Add the playlists from an exported file; clashing names get a number.
    async _importPlaylists(window, settings) {
        const filter = new Gtk.FileFilter({name: 'Playlist files'});
        filter.add_suffix('json');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Import playlists', filters});
        let file;
        try {
            file = await dialog.open(window, null);
        } catch {
            return; // dismissed
        }
        try {
            const [bytes] = await file.load_contents_async(null);
            const {playlists, added} = mergePlaylistFile(readPlaylists(settings), new TextDecoder().decode(bytes));
            settings.set_string('playlists', JSON.stringify(playlists));
            window.add_toast(new Adw.Toast({title: `Imported ${added} playlist${added === 1 ? '' : 's'}`}));
        } catch (e) {
            window.add_toast(new Adw.Toast({title: `Couldn't import: ${e.message}`}));
        }
    }

    // Ask for a playlist name; calls done(name) with a non-empty, trimmed name.
    _askName(window, heading, initial, done) {
        const dialog = new Adw.AlertDialog({heading});
        const entry = new Gtk.Entry({text: initial, activates_default: true});
        dialog.extra_child = entry;
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('ok', 'Save');
        dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
        dialog.default_response = 'ok';
        dialog.connect('response', (_d, response) => {
            const name = entry.text.trim();
            if (response === 'ok' && name)
                done(name);
        });
        dialog.present(window);
    }

    // A searchable checklist of screensavers not yet in the playlist.
    _pickSavers(window, settings, registry, existing, done) {
        const dialog = new Adw.Dialog({title: 'Add screensavers', content_width: 460, content_height: 560});
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
        const cancel = new Gtk.Button({label: 'Cancel'});
        const addButton = new Gtk.Button({label: 'Add', css_classes: ['suggested-action'], sensitive: false});
        header.pack_start(cancel);
        header.pack_end(addButton);
        view.add_top_bar(header);

        const search = new Gtk.SearchEntry({placeholder_text: 'Search screensavers', hexpand: true});
        const favouritesOnly = new Gtk.ToggleButton({
            child: new Adw.ButtonContent({icon_name: 'starred-symbolic', label: 'Favourites'}),
            tooltip_text: 'Only show Favourites',
        });
        const filterBar = new Gtk.Box({spacing: 6, margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6});
        filterBar.append(search);
        filterBar.append(favouritesOnly);
        view.add_top_bar(filterBar);
        const favourites = new Set(settings.get_strv('favorites'));
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'],
            margin_start: 12, margin_end: 12, margin_bottom: 12});
        view.content = new Gtk.ScrolledWindow({child: list, vexpand: true});
        dialog.child = view;

        const picked = [];
        const rowSavers = new Map();
        for (const saver of registry.list().filter(s => !existing.includes(s.id))) {
            const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            check.connect('toggled', () => {
                if (check.active)
                    picked.push(saver.id);
                else
                    picked.splice(picked.indexOf(saver.id), 1);
                addButton.sensitive = picked.length > 0;
            });
            const row = new Adw.ActionRow({title: esc(saver.name), subtitle: esc(saver.group), activatable_widget: check});
            row.add_prefix(check);
            list.append(row);
            rowSavers.set(row, saver);
        }
        list.set_filter_func(row => {
            const q = search.text.trim().toLowerCase();
            const s = rowSavers.get(row);
            if (favouritesOnly.active && !favourites.has(s.id))
                return false;
            return !q || `${s.name} ${s.group}`.toLowerCase().includes(q);
        });
        search.connect('search-changed', () => list.invalidate_filter());
        favouritesOnly.connect('toggled', () => list.invalidate_filter());

        cancel.connect('clicked', () => dialog.close());
        addButton.connect('clicked', () => {
            done(picked);
            dialog.close();
        });
        dialog.present(window);
    }

    // ── History page ────────────────────────────────────────────────────

    _buildHistoryPage(settings, window, generalPage) {
        const file = historyFile(this.uuid);
        const page = new Adw.PreferencesPage({
            title: 'History',
            icon_name: 'document-open-recent-symbolic',
        });

        const header = new Adw.PreferencesGroup();
        page.add(header);

        // Shown while recording is off; existing entries stay visible.
        const off = new Adw.Banner({
            title: 'Recording is off, so new runs are not added',
            button_label: 'Settings',
            revealed: !settings.get_boolean('log-history'),
            margin_bottom: 12,
        });
        off.connect('button-clicked', () => window.set_visible_page(generalPage));
        settings.connect('changed::log-history', () => {
            off.revealed = !settings.get_boolean('log-history');
        });
        header.add(off);

        // Full width, like the Library search.
        const toolbar = new Gtk.Box({spacing: 6});
        const search = new Gtk.SearchEntry({placeholder_text: 'Filter by screensaver', hexpand: true});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Reload'});
        const open = new Gtk.Button({icon_name: 'document-open-symbolic', tooltip_text: 'Open the log file'});
        const clear = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Clear history',
            css_classes: ['destructive-action']});
        [search, refresh, open, clear].forEach(w => toolbar.append(w));
        header.add(toolbar);

        let groups = [];
        let days = 30;
        let entries = [];

        // Read without blocking the window; a large log can take a moment.
        let loadId = 0;
        const load = async () => {
            const id = ++loadId;
            let result = [];
            try {
                const [bytes] = await file.load_contents_async(null);
                result = parseHistory(new TextDecoder().decode(bytes));
            } catch {
                result = [];
            }
            if (id === loadId)
                entries = result;
            return id === loadId;
        };

        const render = () => {
            groups.forEach(g => page.remove(g));
            groups = [];
            const add = g => {
                page.add(g);
                groups.push(g);
            };
            const q = search.text.trim().toLowerCase();
            const shown = entries.filter(e => !q || `${e.name} ${e.id}`.toLowerCase().includes(q));

            if (!entries.length) {
                const empty = new Adw.PreferencesGroup({
                    description: settings.get_boolean('log-history')
                        ? 'Nothing logged yet. Runs appear here after a screensaver has been shown.'
                        : 'Nothing recorded. Turn on recording under General ▸ History.',
                });
                add(empty);
                return;
            }

            // Summary over the last 30 days.
            const since = Date.now() - 30 * 86400e3;
            const recent = shown.filter(e => e.start >= since);
            const total = recent.reduce((t, e) => t + Math.max(0, e.end - e.start), 0) / 1000;
            const counts = new Map();
            for (const e of recent)
                counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
            const top = [...counts].sort((a, b) => b[1] - a[1])[0];
            const summary = new Adw.PreferencesGroup({title: 'Last 30 days'});
            const stat = (title, value) => {
                const row = new Adw.ActionRow({title, css_classes: ['property']});
                row.subtitle = esc(value);
                summary.add(row);
            };
            stat('Screensaver runs', String(recent.length));
            stat('Time on screen', formatDuration(total));
            stat('Most shown', top ? `${top[0]} (${top[1]}×)` : '—');
            add(summary);

            // One group per day, newest first.
            const cutoff = Date.now() - days * 86400e3;
            const byDay = new Map();
            for (const e of shown) {
                if (e.start < cutoff)
                    continue;
                const day = GLib.DateTime.new_from_unix_local(Math.floor(e.start / 1000)).format('%A, %B %-d, %Y');
                if (!byDay.has(day))
                    byDay.set(day, []);
                byDay.get(day).push(e);
            }
            const fmtTime = ms => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%H:%M');
            for (const [day, list] of byDay) {
                const dayTotal = list.reduce((t, e) => t + Math.max(0, e.end - e.start), 0) / 1000;
                const g = new Adw.PreferencesGroup({
                    title: esc(day),
                    description: `${list.length} run${list.length === 1 ? '' : 's'} · ${formatDuration(dayTotal)}`,
                });
                for (const e of list) {
                    const [icon, why] = ENDED[e.ended] ?? ['media-playback-stop-symbolic', 'Stopped'];
                    const row = new Adw.ActionRow({
                        title: esc(e.name ?? e.id),
                        subtitle: esc(`${fmtTime(e.start)} – ${fmtTime(e.end)} · ${
                            formatDuration((e.end - e.start) / 1000)} · ${why}${e.monitor !== undefined ? ` · monitor ${e.monitor + 1}` : ''}${
                                e.test ? ' · test' : e.lock ? '' : ' · preview'}`),
                    });
                    row.add_prefix(new Gtk.Image({icon_name: icon, tooltip_text: why}));
                    g.add(row);
                }
                add(g);
            }

            const older = shown.filter(e => e.start < cutoff).length;
            if (older) {
                const more = new Adw.PreferencesGroup();
                const btn = new Gtk.Button({label: `Show older (${older} more)`, halign: Gtk.Align.CENTER,
                    css_classes: ['pill']});
                btn.connect('clicked', () => {
                    days += 30;
                    render();
                });
                more.add(btn);
                add(more);
            }
        };

        const reload = () => {
            load().then(current => {
                if (current)
                    render();
            });
        };
        refresh.connect('clicked', reload);
        search.connect('search-changed', render);
        settings.connect('changed::log-history', render);
        open.connect('clicked', () => {
            if (file.query_exists(null))
                Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
            else
                window.add_toast(new Adw.Toast({title: 'No history file yet'}));
        });
        clear.connect('clicked', () => {
            const confirm = new Adw.AlertDialog({
                heading: 'Clear history?',
                body: 'This deletes the record of every screensaver run.',
            });
            confirm.add_response('cancel', 'Cancel');
            confirm.add_response('clear', 'Clear');
            confirm.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
            confirm.connect('response', (_d, response) => {
                if (response !== 'clear')
                    return;
                try {
                    file.delete(null);
                } catch {
                    // already gone
                }
                reload();
            });
            confirm.present(window);
        });
        // Fresh data whenever the page is opened.
        window.connect('notify::visible-page', () => {
            if (window.visible_page === page)
                reload();
        });
        reload();
        return page;
    }

    // ── Custom page ─────────────────────────────────────────────────────

    _buildCustomPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Custom',
            icon_name: 'list-add-symbolic',
        });

        const add = new Adw.PreferencesGroup({
            title: 'Add a custom screensaver',
            description: 'Any program that opens a window works: it is started once per monitor and ' +
                'shown fullscreen over the lock screen. In the command, %w and %h are replaced by ' +
                'the monitor size. X11 programs run through Xwayland. Only add programs you trust: ' +
                'whatever they draw appears on your lock screen.',
        });
        page.add(add);

        const name = new Adw.EntryRow({title: 'Name'});
        const command = new Adw.EntryRow({title: 'Command, e.g. /usr/lib/xscreensaver/glmatrix --density 80'});
        add.add(name);
        add.add(command);
        const addButton = new Gtk.Button({
            label: 'Add',
            halign: Gtk.Align.END,
            margin_top: 12,
            css_classes: ['suggested-action'],
        });
        add.add(addButton);

        const existing = new Adw.PreferencesGroup({title: 'Your custom screensavers'});
        page.add(existing);
        let rows = [];

        const rebuild = () => {
            for (const r of rows)
                existing.remove(r);
            rows = [];
            const entries = settings.get_strv('custom-savers');
            entries.forEach((line, i) => {
                const bar = line.indexOf('|');
                const row = new Adw.ActionRow({
                    title: esc(bar >= 0 ? line.slice(0, bar) : `Custom ${i + 1}`),
                    subtitle: esc(bar >= 0 ? line.slice(bar + 1) : line),
                });
                const play = new Gtk.Button({
                    icon_name: 'media-playback-start-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Preview',
                });
                play.connect('clicked', () => preview(settings, `custom:${i}`));
                const del = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Remove',
                });
                del.connect('clicked', () => {
                    const list = settings.get_strv('custom-savers');
                    list.splice(i, 1);
                    settings.set_strv('custom-savers', list);
                });
                row.add_suffix(play);
                row.add_suffix(del);
                existing.add(row);
                rows.push(row);
            });
            if (!entries.length) {
                const empty = new Adw.ActionRow({title: 'None yet'});
                existing.add(empty);
                rows.push(empty);
            }
        };
        rebuild();
        settings.connect('changed::custom-savers', rebuild);

        addButton.connect('clicked', () => {
            const cmd = command.text.trim();
            if (!cmd)
                return;
            try {
                GLib.shell_parse_argv(cmd);
            } catch {
                window.add_toast(new Adw.Toast({title: 'That command could not be parsed'}));
                return;
            }
            const label = name.text.trim().replaceAll('|', '/') || cmd.split(/\s+/)[0].split('/').pop();
            settings.set_strv('custom-savers', [...settings.get_strv('custom-savers'), `${label}|${cmd}`]);
            name.text = '';
            command.text = '';
            window.add_toast(new Adw.Toast({title: `Added “${label}” to the Library`}));
        });

        return page;
    }
}
