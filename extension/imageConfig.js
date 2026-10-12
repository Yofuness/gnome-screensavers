// SPDX-License-Identifier: GPL-2.0-or-later
// Pictures for the hacks that show images (Jigsaw, Distort, GLSlideshow...).
// They ask xscreensaver-getimage for an image, and it only takes its settings
// from ~/.xscreensaver.  Rather than edit the user's own file, the extension
// keeps a private one and starts XScreenSaver hacks with HOME pointing at its
// folder (the real config, cache and data folders are passed on unchanged).
// Desktop grabs are always off: they would show the desktop on the lock screen.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

async function makeDirectory(dir) {
    try {
        await dir.make_directory_async(GLib.PRIORITY_LOW, null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}

export class ImageConfig {
    constructor(uuid) {
        this._dataDir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), uuid]));
        this._home = this._dataDir.get_child('xscreensaver-home');
        this._queue = Promise.resolve();
    }

    /** Environment for an XScreenSaver hack: the private HOME, real XDG folders. */
    get env() {
        return {
            HOME: this._home.get_path(),
            XDG_CONFIG_HOME: GLib.get_user_config_dir(),
            XDG_CACHE_HOME: GLib.get_user_cache_dir(),
            XDG_DATA_HOME: GLib.get_user_data_dir(),
        };
    }

    /** Write the private ~/.xscreensaver for this picture folder ('' = none). */
    write(folder) {
        const text = [
            'grabDesktopImages:\tFalse',
            `chooseRandomImages:\t${folder ? 'True' : 'False'}`,
            `imageDirectory:\t${folder}`,
            '',
        ].join('\n');
        this._queue = this._queue.then(() => this._write(text)).catch(e =>
            console.warn(`[screensavers] picture folder: ${e.message}`));
        return this._queue;
    }

    async _write(text) {
        // The private home lives in our data folder; create the parent first.
        await makeDirectory(this._dataDir);
        await makeDirectory(this._home);
        await this._home.get_child('.xscreensaver').replace_contents_async(
            new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
