#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Container entry point: gnome-shell needs a system bus, which a container
# doesn't have, so start one (as root) with a stand-in logind, then run the
# given command as tester.
set -euo pipefail
mkdir -p /run/dbus /run/systemd/seats   # gnome-shell checks the latter for systemd
dbus-daemon --system --fork
gjs -m /work/tools/gnome50/fake-logind.js &
for _ in $(seq 50); do
    gdbus introspect --system --dest org.freedesktop.login1 --object-path /org/freedesktop/login1 >/dev/null 2>&1 && break
    sleep 0.1
done
exec runuser -u tester -- env HOME=/home/tester USER=tester SCENARIOS="${SCENARIOS:-}" "$@"
