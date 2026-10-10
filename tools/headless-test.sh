#!/bin/bash
# Runs the extension in a throwaway headless gnome-shell, isolated from the real
# session: its own D-Bus, dconf database, data dirs and Wayland socket.
#
#   tools/headless-test.sh start            start the test shell (two virtual monitors)
#   tools/headless-test.sh call METHOD ...  call a debug D-Bus method (Lock, Preview, Key, ...)
#   tools/headless-test.sh shot FILE.png    screenshot of the test shell
#   tools/headless-test.sh log              show the shell's log
#   tools/headless-test.sh stop             stop it
#   tools/headless-test.sh run              start, run the end-to-end checks, stop
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=screensavers@johann.local
T=${SCREENSAVERS_TEST_DIR:-${TMPDIR:-/tmp}/screensavers-test}
MONITORS=${SCREENSAVERS_TEST_MONITORS:-"1920x1080 1920x1080"}

bus() { cat "$T/bus"; }

call() {
    local method=$1; shift
    DBUS_SESSION_BUS_ADDRESS=$(bus) gdbus call --session --dest org.gnome.Shell \
        --object-path /local/johann/Screensavers/Debug \
        --method "local.johann.Screensavers.Debug.$method" "$@"
}

start() {
    stop >/dev/null 2>&1 || true
    rm -rf "$T"
    mkdir -p "$T"/{data/gnome-shell/extensions,config,cache,shots}
    # Unix socket paths are limited to 108 bytes, so the runtime dir must be short.
    RUNTIME=/tmp/sstest-$(id -u)
    fusermount3 -u "$RUNTIME/gvfs" 2>/dev/null || true
    rm -rf "$RUNTIME"; mkdir -m 700 "$RUNTIME"
    cp -r "$ROOT/build/$UUID" "$T/data/gnome-shell/extensions/"
    local vm=()
    for m in $MONITORS; do vm+=(--virtual-monitor "$m"); done

    env -i HOME="$HOME" USER="$USER" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
        XDG_DATA_HOME="$T/data" XDG_CONFIG_HOME="$T/config" XDG_CACHE_HOME="$T/cache" \
        XDG_RUNTIME_DIR="$RUNTIME" XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" \
        SCREENSAVERS_DEBUG=1 GVFS_DISABLE_FUSE=1 \
        setsid dbus-run-session -- bash -c '
            echo "$DBUS_SESSION_BUS_ADDRESS" > "'"$T"'/bus"
            dconf write /org/gnome/shell/enabled-extensions "[\"'"$UUID"'\"]"
            dconf write /org/gnome/shell/disable-user-extensions false
            dconf write /org/gnome/shell/welcome-dialog-last-shown-version "\"999\""
            exec gnome-shell --headless --wayland --wayland-display=wayland-sstest '"${vm[*]}"'
        ' >"$T/shell.log" 2>&1 &
    echo $! >"$T/pid"

    for _ in $(seq 60); do
        if [ -s "$T/bus" ] && call Status >/dev/null 2>&1; then
            echo "test shell up ($T)"
            return 0
        fi
        sleep 0.5
    done
    echo "test shell did not come up; log:" >&2
    tail -n 40 "$T/shell.log" >&2
    return 1
}

stop() {
    [ -f "$T/pid" ] || return 0
    local pid; pid=$(cat "$T/pid")
    # setsid made the shell the leader of its own process group: take it all down.
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$T/pid"
}

shot() {
    call Screenshot "$1" >/dev/null
}

# Mean brightness and difference between two screenshots, via ffmpeg-free python.
analyze() {
    python3 -I - "$@" <<'EOF'
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
def load(p):
    pb = GdkPixbuf.Pixbuf.new_from_file(p)
    return pb.get_pixels(), pb.get_n_channels()
a, ca = load(sys.argv[1])
b, cb = load(sys.argv[2])
step = 97
mean = sum(a[i] for i in range(0, len(a), step)) / (len(a) / step)
diff = sum(abs(a[i] - b[i]) for i in range(0, min(len(a), len(b)), step)) / (len(a) / step)
print(f"{mean:.2f} {diff:.2f}")
EOF
}

check() {
    local name=$1 cond=$2
    if eval "$cond"; then echo "  ok   $name"; else echo "  FAIL $name"; FAILED=1; fi
}

is_locked() {
    call Status | grep -q '"locked":true'
}

saver_pids() {
    pgrep -f -s "$(cat "$T/pid")" -- "$1" || true
}

shown_count() {
    call Status | grep -o '"shown":true' | wc -l
}

set_key() {
    DBUS_SESSION_BUS_ADDRESS=$(bus) XDG_CONFIG_HOME="$T/config" \
        dconf write "/org/gnome/shell/extensions/screensavers/$1" "$2"
}

# expect_animating NAME: two screenshots a second apart must be non-black and differ.
expect_animating() {
    local S="$T/shots" tag; tag=$(echo "$1" | tr -c 'a-zA-Z0-9\n' '_')
    shot "$S/$tag-1.png"; sleep 2; shot "$S/$tag-2.png"
    read -r mean diff < <(analyze "$S/$tag-1.png" "$S/$tag-2.png" 2>/dev/null)
    echo "     brightness=$mean change=$diff"
    check "$1: screen not black" "awk 'BEGIN{exit !($mean > 1)}'"
    check "$1: animating" "awk 'BEGIN{exit !($diff > 0.2)}'"
}

FLURRY='/usr/lib/xscreensaver/flurry --preset'

run() {
    FAILED=0
    start
    sleep 2

    echo "== lock shows Flurry over the lock screen"
    call Lock >/dev/null
    sleep 6
    expect_animating "flurry on lock"
    check "one flurry per monitor" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    check "both monitors show a clone" "[ \$(shown_count) -eq 2 ]"

    echo "== mouse motion does not dismiss"
    call Motion >/dev/null; sleep 1.5
    check "still running after motion" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"

    echo "== a key press dismisses it, the lock screen stays"
    call Key >/dev/null; sleep 2.5
    shot "$T/shots/after-key.png"
    check "saver processes gone" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check "still locked" "is_locked"

    echo "== unlocking while a saver runs stops it"
    call Unlock >/dev/null; sleep 2
    call Lock >/dev/null; sleep 5
    check "saver back on relock" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    call Unlock >/dev/null; sleep 2.5
    check "saver gone after unlock" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check "unlocked" "! is_locked"

    echo "== a click dismisses a preview"
    call Preview 'flurry:fire' >/dev/null; sleep 3
    check "preview running" "[ \$(shown_count) -eq 2 ]"
    call Click >/dev/null; sleep 2.5
    check "preview gone after click" "[ -z \"\$(saver_pids '$FLURRY')\" ]"

    echo "== run time over: saver stops and GNOME's fade/blank continues"
    set_key run-time 4
    call Lock >/dev/null; sleep 4
    check "running before run time" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    sleep 5
    check "stopped after run time" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check "shield reports active (GNOME may blank now)" "call Status | grep -q '\"active\":true'"
    call Unlock >/dev/null; sleep 2
    set_key run-time -1

    echo "== auto-lock: session goes idle -> saver first, then GNOME locks underneath"
    call Idle >/dev/null; sleep 3
    check "saver running on idle" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    sleep 10
    check "session locked after the fade time" "is_locked"
    check "saver still running once locked" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    expect_animating "flurry after auto-lock"
    call Key >/dev/null; sleep 2.5
    check "key dismisses, lock remains" "[ -z \"\$(saver_pids '$FLURRY')\" ] && is_locked"
    call Unlock >/dev/null; sleep 2

    echo "== a crashing saver removes the overlay"
    call Preview 'flurry:classic' >/dev/null; sleep 3
    pkill -KILL -f -s "$(cat "$T/pid")" -- "$FLURRY" || true
    sleep 1.5
    check "session cleared" "call Status | grep -q '\"session\":null'"

    for hack in ${HACKS:-glmatrix fireworkx molecule pipes abstractile galaxy}; do
        [ "$hack" = flurry ] && continue
        echo "== xscreensaver: $hack"
        call Preview "xscreensaver:$hack" >/dev/null; sleep 5
        check "$hack: window shown on both monitors" "[ \$(shown_count) -eq 2 ]"
        expect_animating "$hack"
        call Stop >/dev/null; sleep 2.5
        check "$hack: processes gone" "[ -z \"\$(saver_pids /usr/lib/xscreensaver/$hack)\" ]"
    done

    if grep -q "JS ERROR" "$T/shell.log"; then
        echo "  FAIL JS errors in log:"; grep -A3 "JS ERROR" "$T/shell.log" | head -20; FAILED=1
    fi
    stop
    [ "$FAILED" = 0 ] && echo "ALL OK" || { echo "SOME CHECKS FAILED"; return 1; }
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    call) shift; call "$@" ;;
    shot) shot "$2" ;;
    log) cat "$T/shell.log" ;;
    run) run ;;
    *) sed -n '2,11p' "$0"; exit 1 ;;
esac
