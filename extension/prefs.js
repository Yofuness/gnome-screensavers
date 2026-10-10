// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Registry} from './registry.js';

const RUN_TIMES = [
    [-1, 'Until the screen blanks (Settings ▸ Power ▸ Screen Blank)'],
    [0, 'Until a key press or click'],
    [60, '1 minute'],
    [300, '5 minutes'],
    [600, '10 minutes'],
    [900, '15 minutes'],
    [1800, '30 minutes'],
    [3600, '1 hour'],
];

// Ask the shell for a preview; it watches this key (see extension.js).
function preview(settings, id) {
    settings.set_string('preview-request', `${id}#${GLib.get_real_time()}`);
}

export default class ScreensaversPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const registry = new Registry(this, settings);
        window.set_default_size(720, 820);
        window.add(this._buildSaversPage(settings, registry));
        window.add(this._buildCustomPage(settings, registry, window));
    }

    _buildSaversPage(settings, registry) {
        const page = new Adw.PreferencesPage({
            title: 'Screensaver',
            icon_name: 'preferences-desktop-screensaver-symbolic',
        });

        const behaviour = new Adw.PreferencesGroup({
            title: 'Behaviour',
            description: 'The screensaver appears when the screen locks. ' +
                'A key press or click stops it and shows the unlock prompt; moving the mouse does not.',
        });
        page.add(behaviour);

        const onLock = new Adw.SwitchRow({title: 'Show when the screen locks'});
        settings.bind('enabled-on-lock', onLock, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(onLock);

        const runTime = new Adw.ComboRow({
            title: 'Run time',
            subtitle: 'After this the screen blanks as usual',
            model: Gtk.StringList.new(RUN_TIMES.map(([, label]) => label)),
        });
        const syncRunTime = () => {
            const v = settings.get_int('run-time');
            const i = RUN_TIMES.findIndex(([s]) => s === v);
            runTime.selected = i >= 0 ? i : 0;
        };
        syncRunTime();
        runTime.connect('notify::selected', () => {
            const v = RUN_TIMES[runTime.selected]?.[0] ?? -1;
            if (settings.get_int('run-time') !== v)
                settings.set_int('run-time', v);
        });
        settings.connect('changed::run-time', syncRunTime);
        behaviour.add(runTime);

        const random = new Adw.SwitchRow({
            title: 'Random screensaver each time',
            subtitle: 'Picks from your starred savers, or from all of them if none are starred',
        });
        settings.bind('random', random, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(random);

        // Saver list with search, selection, favourites and preview.
        const group = new Adw.PreferencesGroup({title: 'Screensavers'});
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
                title: GLib.markup_escape_text(saver.name, -1),
                subtitle: GLib.markup_escape_text(`${saver.group} · ${saver.description}`, -1),
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

    _buildCustomPage(settings, registry, window) {
        const page = new Adw.PreferencesPage({
            title: 'Custom',
            icon_name: 'list-add-symbolic',
        });

        const add = new Adw.PreferencesGroup({
            title: 'Add a screensaver',
            description: 'Any program that opens a window works: it is started once per monitor and ' +
                'shown fullscreen over the lock screen. In the command, %w and %h are replaced by ' +
                'the monitor size. X11 programs run through Xwayland.',
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
                    title: GLib.markup_escape_text(bar >= 0 ? line.slice(0, bar) : `Custom ${i + 1}`, -1),
                    subtitle: GLib.markup_escape_text(bar >= 0 ? line.slice(bar + 1) : line, -1),
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
