// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Registry} from './registry.js';
import {historyFile, parseHistory} from './history.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

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

/**
 * A combo row for an integer setting with short labels; the subtitle explains
 * what the selected choice does, so long descriptions never get cut off.
 */
function choiceRow(settings, key, title, choices) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(c => c.label)),
        subtitle_lines: 3,
    });
    const sync = () => {
        const v = settings.get_int(key);
        let i = choices.findIndex(c => c.value === v);
        if (i < 0)
            i = 0;
        if (row.selected !== i)
            row.selected = i;
        row.subtitle = choices[i].explain();
    };
    row.connect('notify::selected', () => {
        const c = choices[row.selected];
        if (c && settings.get_int(key) !== c.value)
            settings.set_int(key, c.value);
        row.subtitle = c?.explain() ?? '';
    });
    settings.connect(`changed::${key}`, sync);
    sync();
    return row;
}

const ENDED = {
    key: ['input-keyboard-symbolic', 'Stopped by a key press'],
    click: ['input-mouse-symbolic', 'Stopped by a click'],
    'run-time': ['alarm-symbolic', 'Run time over, screen blanked'],
    unlock: ['changes-allow-symbolic', 'Unlocked'],
    rotated: ['media-playlist-shuffle-symbolic', 'Rotated to the next screensaver'],
    failed: ['dialog-warning-symbolic', 'Screensaver failed to start'],
};

export default class ScreensaversPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const registry = new Registry(this, settings);
        window.set_default_size(760, 860);
        window.search_enabled = false;
        window.add(this._buildSaversPage(settings, registry, window));
        window.add(this._buildBehaviourPage(settings));
        window.add(this._buildHistoryPage(settings, window));
        window.add(this._buildCustomPage(settings, window));
    }

    // ── Screensaver page ────────────────────────────────────────────────

    _buildSaversPage(settings, registry, window) {
        const page = new Adw.PreferencesPage({
            title: 'Screensaver',
            icon_name: 'preferences-desktop-screensaver-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Screensavers',
            description: 'Pick the one to show. ☆ adds it to the random rotation, ⚙ changes its ' +
                'settings, ▶ previews it (press a key or click to stop).',
        });
        page.add(group);

        const search = new Gtk.SearchEntry({placeholder_text: 'Search screensavers', hexpand: true});
        group.set_header_suffix(search);

        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        group.add(list);

        const savers = registry.list();
        if (!savers.length) {
            group.description = 'No screensavers found. Install the xscreensaver package ' +
                '(e.g. “sudo pacman -S xscreensaver”), then reopen this window.';
        }
        const favourites = () => new Set(settings.get_strv('favorites'));
        let radioGroup = null;
        const radios = new Map();

        for (const saver of savers) {
            const row = new Adw.ActionRow({
                title: esc(saver.name),
                subtitle: esc(`${saver.group} · ${saver.description}`),
                subtitle_lines: 2,
            });
            row._saver = saver;

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
                tooltip_text: 'Include in random rotation',
                css_classes: ['flat'],
                active: favourites().has(saver.id),
            });
            star.connect('toggled', () => {
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

        const syncSelected = () => {
            const radio = radios.get(settings.get_string('saver'));
            if (radio && !radio.active)
                radio.active = true;
        };
        syncSelected();
        settings.connect('changed::saver', syncSelected);

        list.set_filter_func(row => {
            const q = search.text.trim().toLowerCase();
            if (!q)
                return true;
            const s = row._saver;
            return `${s.name} ${s.group} ${s.description}`.toLowerCase().includes(q);
        });
        search.connect('search-changed', () => list.invalidate_filter());

        return page;
    }

    // A settings dialog generated from the hack's XScreenSaver config.
    _openOptions(settings, registry, saver, window) {
        const options = registry.options(saver.id);
        const key = registry.optionsKey(saver.id);
        const read = () => {
            try {
                return JSON.parse(settings.get_string('saver-options'));
            } catch {
                return {};
            }
        };
        const values = {...read()[key] ?? {}};
        const save = () => {
            const all = read();
            const changed = Object.fromEntries(Object.entries(values)
                .filter(([id, v]) => options.find(o => o.id === id)?.default !== v));
            if (Object.keys(changed).length)
                all[key] = changed;
            else
                delete all[key];
            settings.set_string('saver-options', JSON.stringify(all));
        };
        const set = (id, v) => {
            values[id] = v;
            save();
        };

        const dialog = new Adw.PreferencesDialog({title: saver.name, search_enabled: false});
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
        for (const o of options) {
            const current = o.id in values ? values[o.id] : o.default;
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
                        title: esc(o.label === o.id ? o.label.replace(/^./, c => c.toUpperCase()) : o.label),
                        subtitle: esc([o.lowLabel, o.highLabel].filter(Boolean).join(' ⟷ ')),
                    });
                    row.add_suffix(new Gtk.Scale({adjustment: adj, width_request: 260,
                        valign: Gtk.Align.CENTER, draw_value: false}));
                }
                adj.connect('value-changed', () => set(o.id,
                    integer ? Math.round(adj.value) : Math.round(adj.value * 1000) / 1000));
                widgets.push(() => {
                    adj.value = o.default;
                });
                group.add(row);
            } else if (o.type === 'boolean') {
                const row = new Adw.SwitchRow({title: esc(o.label), active: !!current});
                row.connect('notify::active', () => set(o.id, row.active));
                widgets.push(() => {
                    row.active = o.default;
                });
                group.add(row);
            } else if (o.type === 'select') {
                const row = new Adw.ComboRow({
                    title: esc(o.label === o.id ? o.label.replace(/^./, c => c.toUpperCase()) : o.label),
                    model: Gtk.StringList.new(o.choices.map(c => c.label)),
                    selected: Math.max(0, o.choices.findIndex(c => c.id === current)),
                });
                row.connect('notify::selected', () => set(o.id, o.choices[row.selected].id));
                widgets.push(() => {
                    row.selected = Math.max(0, o.choices.findIndex(c => c.id === o.default));
                });
                group.add(row);
            } else {
                const row = new Adw.EntryRow({title: esc(o.label), text: String(current ?? ''),
                    show_apply_button: true});
                row.connect('apply', () => set(o.id, row.text));
                widgets.push(() => {
                    row.text = '';
                });
                group.add(row);
            }
        }

        const actions = new Gtk.Box({spacing: 12, halign: Gtk.Align.END, margin_top: 18});
        const reset = new Gtk.Button({label: 'Reset to defaults'});
        reset.connect('clicked', () => {
            widgets.forEach(r => r());
            for (const k of Object.keys(values))
                delete values[k];
            save();
        });
        const play = new Gtk.Button({label: 'Preview', css_classes: ['suggested-action']});
        play.connect('clicked', () => preview(settings, saver.id));
        actions.append(reset);
        actions.append(play);
        group.add(actions);

        dialog.present(window);
    }

    // ── Behaviour page ──────────────────────────────────────────────────

    _buildBehaviourPage(settings) {
        const sessionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        const page = new Adw.PreferencesPage({
            title: 'Behaviour',
            icon_name: 'preferences-system-symbolic',
        });

        const lock = new Adw.PreferencesGroup({
            title: 'On the lock screen',
            description: 'A key press or click stops the screensaver and shows the unlock prompt. ' +
                'Moving the mouse does not, and media keys control your music instead.',
        });
        page.add(lock);

        const onLock = new Adw.SwitchRow({title: 'Show a screensaver when the screen locks'});
        settings.bind('enabled-on-lock', onLock, 'active', Gio.SettingsBindFlags.DEFAULT);
        lock.add(onLock);

        const test = new Adw.ActionRow({
            title: 'Test lock screen',
            subtitle: 'Runs the screensaver exactly as it would when locked (your choice or a random pick, ' +
                'overlay, run time, rotation) without locking. Press a key or click to stop. ' +
                '“Come back after dismissing” is not simulated.',
            subtitle_lines: 4,
        });
        const testButton = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action']});
        testButton.connect('clicked', () => preview(settings, '@test'));
        test.add_suffix(testButton);
        test.activatable_widget = testButton;
        lock.add(test);

        const blankText = () => {
            const s = sessionSettings.get_uint('idle-delay');
            return s ? formatDuration(s) : 'Never';
        };
        const runTime = choiceRow(settings, 'run-time', 'Run time', [
            {value: -1, label: 'Screen Blank', explain: () => sessionSettings.get_uint('idle-delay')
                ? `Runs for your Screen Blank time (Settings ▸ Power, currently ${blankText()}), then the screen blanks.`
                : 'Your Screen Blank (Settings ▸ Power) is Never, so it runs until a key press or click.'},
            {value: 0, label: 'Key or click',
                explain: () => 'Never stops on its own; the screen stays on while locked.'},
            ...[60, 300, 600, 900, 1800, 3600].map(v => ({
                value: v, label: formatDuration(v),
                explain: () => `Runs for ${formatDuration(v)}, then the screen blanks.`,
            })),
        ]);
        sessionSettings.connect('changed::idle-delay', () => runTime.notify('selected'));
        lock.add(runTime);

        const retrigger = choiceRow(settings, 'retrigger-delay', 'Come back after dismissing', [
            {value: 0, label: 'Never',
                explain: () => 'After a key press or click, the lock screen stays until you unlock.'},
            ...[15, 30, 60, 120, 300].map(v => ({
                value: v, label: formatDuration(v),
                explain: () => `Returns after ${formatDuration(v)} untouched on the lock screen.`,
            })),
        ]);
        lock.add(retrigger);

        const choose = new Adw.PreferencesGroup({title: 'Choosing a screensaver'});
        page.add(choose);

        const random = new Adw.SwitchRow({
            title: 'Random screensaver each time',
            subtitle: 'Picks from your starred screensavers, or from all of them if none are starred',
        });
        settings.bind('random', random, 'active', Gio.SettingsBindFlags.DEFAULT);
        choose.add(random);

        choose.add(choiceRow(settings, 'rotate-interval', 'Switch screensavers', [
            {value: 0, label: 'Never', explain: () => 'Shows one screensaver the whole time.'},
            ...[1, 2, 5, 10, 15, 30, 60].map(m => ({
                value: m, label: `Every ${formatDuration(m * 60)}`,
                explain: () => `Changes to another random screensaver every ${formatDuration(m * 60)} ` +
                    '(from your starred ones, or all of them if none are starred).',
            })),
        ]));

        const overlay = new Adw.PreferencesGroup({
            title: 'Overlay',
            description: 'Shown in the top-left corner of the primary monitor.',
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

        const history = new Adw.PreferencesGroup({title: 'History'});
        page.add(history);
        const log = new Adw.SwitchRow({
            title: 'Keep a history of screensaver runs',
            subtitle: 'Stored only on this computer; browse it on the History page',
        });
        settings.bind('log-history', log, 'active', Gio.SettingsBindFlags.DEFAULT);
        history.add(log);

        const limit = new Adw.SpinRow({
            title: 'Runs to keep',
            adjustment: new Gtk.Adjustment({lower: 100, upper: 1000000, step_increment: 100,
                page_increment: 1000}),
        });
        settings.bind('history-limit', limit, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('log-history', limit, 'sensitive', Gio.SettingsBindFlags.GET);
        const syncLimit = () => {
            // About 150 bytes per run.
            const bytes = settings.get_int('history-limit') * 150;
            limit.subtitle = `The newest ones are kept; up to about ${GLib.format_size(bytes)} on disk`;
        };
        settings.connect('changed::history-limit', syncLimit);
        syncLimit();
        history.add(limit);

        return page;
    }

    // Overlay size: a slider with marked steps, the current value, a reset
    // button and a preview.  A running preview resizes live as it moves.
    _sizeRow(settings) {
        const row = new Adw.ActionRow({
            title: 'Size',
            subtitle: 'Drag while a preview runs to see the change live',
        });
        const adj = new Gtk.Adjustment({lower: 50, upper: 200, step_increment: 5, page_increment: 25});
        const scale = new Gtk.Scale({
            adjustment: adj,
            width_request: 240,
            valign: Gtk.Align.CENTER,
            draw_value: false,
            round_digits: 0,
        });
        for (const mark of [50, 100, 150, 200])
            scale.add_mark(mark, Gtk.PositionType.BOTTOM, `${mark}%`);
        scale.add_mark(75, Gtk.PositionType.BOTTOM, null);
        const value = new Gtk.Label({width_chars: 5, xalign: 1, css_classes: ['numeric']});
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Back to 100%',
            css_classes: ['flat'],
        });
        const play = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Preview the selected screensaver',
            css_classes: ['flat'],
        });

        const sync = () => {
            const v = settings.get_int('overlay-scale');
            if (adj.value !== v)
                adj.value = v;
            value.label = `${v}%`;
            reset.visible = v !== 100;
        };
        adj.connect('value-changed', () => {
            // Snap to steps of 5.
            const v = Math.round(adj.value / 5) * 5;
            if (settings.get_int('overlay-scale') !== v)
                settings.set_int('overlay-scale', v);
            value.label = `${v}%`;
        });
        reset.connect('clicked', () => settings.set_int('overlay-scale', 100));
        play.connect('clicked', () => preview(settings, settings.get_string('saver')));
        settings.connect('changed::overlay-scale', sync);
        sync();

        // Nothing to size when both parts of the overlay are off.
        const syncSensitive = () => {
            row.sensitive = settings.get_boolean('show-clock') || settings.get_boolean('show-media');
        };
        settings.connect('changed::show-clock', syncSensitive);
        settings.connect('changed::show-media', syncSensitive);
        syncSensitive();

        row.add_suffix(value);
        row.add_suffix(scale);
        row.add_suffix(reset);
        row.add_suffix(play);
        return row;
    }

    // ── History page ────────────────────────────────────────────────────

    _buildHistoryPage(settings, window) {
        const file = historyFile(this.uuid);
        const page = new Adw.PreferencesPage({
            title: 'History',
            icon_name: 'document-open-recent-symbolic',
        });

        const header = new Adw.PreferencesGroup();
        page.add(header);
        const logRow = new Adw.SwitchRow({
            title: 'Keep a history of screensaver runs',
            subtitle: 'Stored only on this computer',
        });
        settings.bind('log-history', logRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        header.add(logRow);

        const toolbar = new Gtk.Box({spacing: 6});
        const search = new Gtk.SearchEntry({placeholder_text: 'Filter by screensaver', hexpand: true});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Reload'});
        const open = new Gtk.Button({icon_name: 'document-open-symbolic', tooltip_text: 'Open the log file'});
        const clear = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Clear history',
            css_classes: ['destructive-action']});
        [search, refresh, open, clear].forEach(w => toolbar.append(w));
        header.set_header_suffix(toolbar);

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
                        : 'History is off. Turn it on above to start logging when each screensaver runs.',
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
                            formatDuration((e.end - e.start) / 1000)} · ${why}${e.test ? ' · test' : e.lock ? '' : ' · preview'}`),
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
            title: 'Add a screensaver',
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

        const existing = new Adw.PreferencesGroup({title: 'Your screensavers'});
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
            const [ok] = (() => {
                try {
                    return GLib.shell_parse_argv(cmd);
                } catch {
                    return [false];
                }
            })();
            if (!ok) {
                window.add_toast(new Adw.Toast({title: 'That command could not be parsed'}));
                return;
            }
            const label = name.text.trim().replaceAll('|', '/') || cmd.split(/\s+/)[0].split('/').pop();
            settings.set_strv('custom-savers', [...settings.get_strv('custom-savers'), `${label}|${cmd}`]);
            name.text = '';
            command.text = '';
            window.add_toast(new Adw.Toast({title: `Added “${label}”. Reopen this window to select it.`}));
        });

        return page;
    }
}
