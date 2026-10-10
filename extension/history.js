// SPDX-License-Identifier: GPL-2.0-or-later
// Local log of screensaver runs: one JSON object per line in
// ~/.local/share/<uuid>/history.jsonl.  Written only when the user turns on
// "log-history"; read by the preferences window's History page.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_LINES = 2000;
const KEEP_LINES = 1500;

Gio._promisify(Gio.File.prototype, 'append_to_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

export function historyFile(uuid) {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), uuid, 'history.jsonl']));
}

/** Parse the log, newest first.  Bad lines are skipped. */
export function parseHistory(text) {
    const entries = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const e = JSON.parse(line);
            if (e && typeof e.start === 'number' && typeof e.end === 'number')
                entries.push(e);
        } catch {
            // skip corrupt line
        }
    }
    return entries.sort((a, b) => b.start - a.start);
}

export class HistoryWriter {
    constructor(uuid) {
        this._file = historyFile(uuid);
        this._queue = Promise.resolve();
        this._appended = 0;
    }

    /** Append one run: {saver, name, start, end, ended, lock}.  Never throws. */
    record(entry) {
        const line = `${JSON.stringify(entry)}\n`;
        this._queue = this._queue.then(() => this._append(line)).catch(e =>
            console.warn(`[screensavers] history: ${e.message}`));
    }

    async _append(line) {
        try {
            // ~/.local/share always exists; only our own folder may be missing.
            await this._file.get_parent().make_directory_async(GLib.PRIORITY_LOW, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        const stream = await this._file.append_to_async(Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_LOW, null);
        await stream.write_bytes_async(new GLib.Bytes(new TextEncoder().encode(line)), GLib.PRIORITY_LOW, null);
        await stream.close_async(GLib.PRIORITY_LOW, null);
        // Check the size now and then rather than on every write.
        if (++this._appended % 50 === 0)
            await this._trim();
    }

    async _trim() {
        const [bytes] = await this._file.load_contents_async(null);
        const lines = new TextDecoder().decode(bytes).split('\n').filter(l => l.trim());
        if (lines.length <= MAX_LINES)
            return;
        const kept = `${lines.slice(-KEEP_LINES).join('\n')}\n`;
        await this._file.replace_contents_async(new TextEncoder().encode(kept), null, false,
            Gio.FileCreateFlags.PRIVATE, null);
    }

    /** Wait for queued writes (used when the extension is disabled). */
    flush() {
        return this._queue;
    }
}
