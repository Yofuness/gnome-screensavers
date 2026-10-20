// SPDX-License-Identifier: GPL-2.0-or-later
// The environment that makes a process render on the discrete GPU (NVIDIA
// Optimus / PRIME offload), as switcheroo-control reports it. GNOME Shell's
// "Launch using Discrete Graphics Card" uses the same source. Shared by the
// shell and prefs.js, so Gio/GLib only.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'net.hadess.SwitcherooControl';
const OBJECT_PATH = '/net/hadess/SwitcherooControl';

/**
 * Resolves to {NAME: value} for the first non-default GPU, or null when
 * switcheroo-control isn't running or there is only one GPU.
 */
export function discreteGpuEnv(cancellable = null) {
    return new Promise(resolve => {
        Gio.DBus.system.call(BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [BUS_NAME, 'GPUs']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                try {
                    const [gpus] = conn.call_finish(res).recursiveUnpack();
                    const gpu = gpus.find(g => !g.Default);
                    const list = gpu?.Environment ?? [];
                    if (list.length === 0 || list.length % 2) {
                        resolve(null);
                        return;
                    }
                    const env = {};
                    for (let i = 0; i < list.length; i += 2)
                        env[list[i]] = list[i + 1];
                    resolve(env);
                } catch {
                    // No switcheroo-control, or cancelled: no discrete GPU to offer.
                    resolve(null);
                }
            });
    });
}
