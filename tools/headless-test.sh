#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Runs the extension in a throwaway headless gnome-shell, isolated from the real
# session: its own D-Bus, dconf database, data dirs and Wayland socket.  A bogus
# XDG_SESSION_ID stops it attaching to the real logind session, which would let
# the two shells see each other's lock/unlock.
#
#   tools/headless-test.sh start            start the test shell (two virtual monitors)
#   tools/headless-test.sh call METHOD ...  call a debug D-Bus method (Lock, Preview, Key, ...)
#   tools/headless-test.sh shot FILE.png    screenshot of the test shell
#   tools/headless-test.sh log              show the shell's log
#   tools/headless-test.sh stop             stop it
#   tools/headless-test.sh run              start, run the end-to-end checks, stop
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=screensavers@yofuness.github.io
T=${SCREENSAVERS_TEST_DIR:-${TMPDIR:-/tmp}/screensavers-test}
MONITORS=${SCREENSAVERS_TEST_MONITORS:-"1920x1080 1920x1080"}

bus() { cat "$T/bus"; }

call() {
    local method=$1; shift
    DBUS_SESSION_BUS_ADDRESS=$(bus) gdbus call --session --dest org.gnome.Shell \
        --object-path /io/github/yofuness/Screensavers/Debug \
        --method "io.github.yofuness.Screensavers.Debug.$method" "$@"
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
        XDG_SESSION_ID=screensavers-test-none \
        SCREENSAVERS_TEST_ROTATE_SECONDS=8 \
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
# Count clearly changed pixels at full resolution: sparse savers (glmatrix)
# change few pixels, which an average would hide.
n = min(len(a), len(b))
changed = sum(1 for i in range(1, n, ca) if abs(a[i] - b[i]) > 40)
print(f"{mean:.2f} {changed}")
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

# corner_brighter ON OFF: top-left corner of monitor 0 is brighter in ON.
corner_brighter() {
    python3 -I - "$1" "$2" <<'EOF'
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
def corner(p):
    pb = GdkPixbuf.Pixbuf.new_from_file(p).new_subpixbuf(0, 0, 500, 260)
    px, n, rs = pb.get_pixels(), pb.get_n_channels(), pb.get_rowstride()
    return sum(px[y * rs + x * n] for y in range(0, 260, 3) for x in range(0, 500, 3))
on, off = corner(sys.argv[1]), corner(sys.argv[2])
print(f"     corner brightness on={on} off={off}")
sys.exit(0 if on > off * 1.2 else 1)
EOF
}

# bright_extent FILE: width of the lit area in the top-left of monitor 0.
bright_extent() {
    python3 -I - "$1" <<'EOF'
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
pb = GdkPixbuf.Pixbuf.new_from_file(sys.argv[1])
px, n, rs = pb.get_pixels(), pb.get_n_channels(), pb.get_rowstride()
right = 0
for y in range(0, 500, 2):
    for x in range(0, 1400, 2):
        o = y * rs + x * n
        r, g, b = px[o], px[o + 1], px[o + 2]
        # Neutral white (the clock text); the saver's bright pixels are tinted.
        if min(r, g, b) > 150 and max(r, g, b) - min(r, g, b) < 20:
            right = max(right, x)
print(right)
EOF
}

# white_in FILE X Y W H: count of neutral-white pixels (overlay text) in a region.
white_in() {
    python3 -I - "$@" <<'EOF'
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
x0, y0, w, h = map(int, sys.argv[2:6])
pb = GdkPixbuf.Pixbuf.new_from_file(sys.argv[1]).new_subpixbuf(x0, y0, w, h)
px, n, rs = pb.get_pixels(), pb.get_n_channels(), pb.get_rowstride()
count = 0
for y in range(0, h, 2):
    for x in range(0, w, 2):
        o = y * rs + x * n
        r, g, b = px[o], px[o + 1], px[o + 2]
        if min(r, g, b) > 150 and max(r, g, b) - min(r, g, b) < 20:
            count += 1
print(count)
EOF
}

# centre_lit FILE: something light sits in the middle of monitor 0.
centre_lit() {
    python3 -I - "$1" <<'EOF'
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
pb = GdkPixbuf.Pixbuf.new_from_file(sys.argv[1]).new_subpixbuf(760, 500, 400, 80)
px, n, rs = pb.get_pixels(), pb.get_n_channels(), pb.get_rowstride()
white = sum(1 for y in range(80) for x in range(400) if min(px[y*rs+x*n:y*rs+x*n+3]) > 200)
sys.exit(0 if white > 200 else 1)
EOF
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
    echo "     brightness=$mean changed_pixels=$diff"
    check "$1: screen not black" "awk 'BEGIN{exit !($mean > 1)}'"
    check "$1: animating" "[ $diff -gt 1000 ]"
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

    echo "== per-hack options reach the command line"
    set_key saver-options "'{\"xscreensaver:glmatrix\": {\"density\": 10, \"fog\": false}}'"
    call Preview 'xscreensaver:glmatrix' >/dev/null; sleep 3
    check "glmatrix got --density 10 --no-fog" "pgrep -af /usr/lib/xscreensaver/glmatrix | grep -q -- '--density 10 --no-fog'"
    call Stop >/dev/null; sleep 2
    set_key saver-options "'{}'"

    echo "== sonar defaults to simulation (no ping privileges needed)"
    call Preview 'xscreensaver:sonar' >/dev/null; sleep 3
    check "sonar started with --ping simulation" "pgrep -af /usr/lib/xscreensaver/sonar | grep -q -- '--ping simulation'"
    call Stop >/dev/null; sleep 2
    set_key saver-options "'{\"xscreensaver:sonar\": {\"ping\": \"sn\"}}'"
    call Preview 'xscreensaver:sonar' >/dev/null; sleep 3
    check "user's choice overrides the default" "pgrep -af /usr/lib/xscreensaver/sonar | grep -qv -- '--ping'"
    call Stop >/dev/null; sleep 2
    set_key saver-options "'{}'"

    echo "== playlist in order + skip key"
    set_key playlists "'[{\"name\": \"Pair\", \"savers\": [\"flurry:fire\", \"xscreensaver:abstractile\"], \"shuffle\": false}]'"
    set_key active-playlist "'Pair'"
    set_key preview-request "'@test#2'"; sleep 4
    check "playlist starts with its first saver" "call Status | grep -q '\"saver\":\"flurry:fire\"'"
    call KeyVal 65363 >/dev/null; sleep 4
    check "skip key moves to the next saver" "call Status | grep -q '\"saver\":\"xscreensaver:abstractile\"'"
    check "skip did not dismiss" "[ \$(shown_count) -eq 2 ]"
    check "old saver's processes gone after the skip" "[ -z \"\$(saver_pids '$FLURRY fire')\" ]"
    call KeyVal 65363 >/dev/null; sleep 4
    check "in-order playlist loops back to the start" "call Status | grep -q '\"saver\":\"flurry:fire\"'"
    call Key >/dev/null; sleep 2.5
    check "other keys still dismiss" "[ -z \"\$(saver_pids /usr/lib/xscreensaver/)\" ]"
    check "history records the skip" "grep -q '\"ended\":\"skipped\"' '$T/data/$UUID/history.jsonl'"
    set_key skip-key "uint32 0"
    set_key preview-request "'@test#3'"; sleep 4
    call KeyVal 65363 >/dev/null; sleep 2.5
    check "with no skip key, Right dismisses" "[ -z \"\$(saver_pids /usr/lib/xscreensaver/)\" ]"
    set_key skip-key "uint32 65363"
    set_key active-playlist "''"
    set_key playlists "'[]'"

    echo "== clock overlay on the primary monitor"
    call Preview 'flurry:classic' >/dev/null; sleep 4
    shot "$T/shots/overlay-on.png"
    call Stop >/dev/null; sleep 2
    set_key show-clock false
    call Preview 'flurry:classic' >/dev/null; sleep 4
    shot "$T/shots/overlay-off.png"
    call Stop >/dev/null; sleep 2
    set_key show-clock true
    check "clock region is brighter with the clock on" "corner_brighter '$T/shots/overlay-on.png' '$T/shots/overlay-off.png'"

    echo "== now playing + media keys"
    : >"$T/mpris-calls"
    DBUS_SESSION_BUS_ADDRESS=$(bus) python3 "$ROOT/tools/fake-mpris.py" "$T/mpris-calls" &
    local mpris=$!
    sleep 1.5
    call Preview 'flurry:classic' >/dev/null; sleep 3
    check "overlay knows the playing track" "call Status | grep -q '\"media\":\"Test Track\"'"
    shot "$T/shots/media.png"
    call MediaKey >/dev/null; sleep 1
    check "play/pause reached the player" "grep -q PlayPause '$T/mpris-calls'"
    check "media key did not dismiss" "[ \$(shown_count) -eq 2 ]"
    call Stop >/dev/null; sleep 2
    kill "$mpris" 2>/dev/null || true

    echo "== rotation swaps savers without a gap"
    set_key rotate-interval 1
    set_key random true
    set_key favorites "['flurry:fire', 'xscreensaver:abstractile']"
    call Preview 'flurry:classic' >/dev/null; sleep 4
    local first; first=$(call Status | grep -o '"saver":"[^"]*"')
    sleep 6
    shot "$T/shots/rotated.png"
    local second; second=$(call Status | grep -o '"saver":"[^"]*"')
    echo "     $first -> $second"
    check "saver changed" "[ -n \"$second\" ] && [ \"$first\" != \"$second\" ]"
    check "old saver processes gone" "[ -z \"\$(saver_pids '$FLURRY classic')\" ]"
    call Stop >/dev/null; sleep 2
    set_key rotate-interval 0
    set_key random false
    set_key favorites "@as []"

    echo "== re-trigger after dismissing on the lock screen"
    set_key retrigger-delay 3
    call Lock >/dev/null; sleep 4
    call Key >/dev/null; sleep 1.5
    check "dismissed" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    sleep 4
    check "saver came back after 3 s idle" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    check "still locked" "is_locked"
    call Key >/dev/null; sleep 1.5
    call Unlock >/dev/null; sleep 5
    check "no re-trigger after unlock" "[ -z \"\$(saver_pids '$FLURRY')\" ]"

    echo "== history log"
    local log="$T/data/$UUID/history.jsonl"
    sleep 1
    check "history file written" "[ -s '$log' ]"
    check "records a key dismissal" "grep -q '\"ended\":\"key\"' '$log'"
    check "records the saver name" "grep -q '\"name\":\"Flurry (Classic)\"' '$log'"
    [ -s "$log" ] && tail -n 3 "$log" | sed 's/^/     /'

    echo "== overlay size changes live"
    # glmatrix: its green rain can't be mistaken for the white overlay text
    # (Flurry's white-hot core sometimes drifts into the measured corner).
    call Preview 'xscreensaver:glmatrix' >/dev/null; sleep 4
    shot "$T/shots/size100.png"
    set_key overlay-scale 200; sleep 1.5
    shot "$T/shots/size200.png"
    set_key overlay-scale 50; sleep 1.5
    shot "$T/shots/size50.png"
    call Stop >/dev/null; sleep 2
    set_key overlay-scale 100
    local w100 w200 w50
    w100=$(bright_extent "$T/shots/size100.png"); w200=$(bright_extent "$T/shots/size200.png"); w50=$(bright_extent "$T/shots/size50.png")
    echo "     overlay width: 50%=$w50 100%=$w100 200%=$w200"
    check "200% is clearly bigger" "[ $w200 -gt \$(( w100 * 3 / 2 )) ]"
    check "50% is clearly smaller" "[ $w50 -lt \$(( w100 * 3 / 4 )) ]"

    echo "== overlay corner and monitor"
    local connector tl br m1
    connector=$(call Connectors | grep -o '"[^"]*"' | sed -n 2p | tr -d '"')
    echo "     second monitor: $connector"
    call Preview 'xscreensaver:glmatrix' >/dev/null; sleep 4
    set_key overlay-corner "'bottom-right'"; sleep 1.5
    shot "$T/shots/corner-br.png"
    set_key overlay-monitor "'$connector'"; sleep 1.5
    shot "$T/shots/monitor-1.png"
    call Stop >/dev/null; sleep 2
    set_key overlay-corner "'top-left'"; set_key overlay-monitor "''"
    tl=$(white_in "$T/shots/corner-br.png" 0 0 700 400)
    br=$(white_in "$T/shots/corner-br.png" 1220 680 700 400)
    m1=$(white_in "$T/shots/monitor-1.png" 3140 680 700 400)
    echo "     white pixels: top-left=$tl bottom-right=$br second monitor bottom-right=$m1"
    check "bottom-right corner has the overlay" "[ $br -gt 100 ] && [ $tl -lt \$(( br / 10 )) ]"
    check "overlay moves to the chosen monitor" "[ -n '$connector' ] && [ $m1 -gt 100 ]"

    echo "== history limit trims to the newest runs"
    local log="$T/data/$UUID/history.jsonl"
    python3 -c "
import json
with open('$log', 'w') as f:
    for i in range(130):
        f.write(json.dumps({'id': 'seed', 'name': 'Seed %d' % i, 'start': i, 'end': i + 1, 'ended': 'key', 'lock': True}) + '\n')
"
    set_key history-limit 100; sleep 1
    call Preview 'flurry:fire' >/dev/null; sleep 3
    call Stop >/dev/null; sleep 2
    echo "     lines after trim: $(wc -l < "$log")"
    check "trimmed to 100 runs" "[ \$(wc -l < '$log') -eq 100 ]"
    check "oldest runs dropped" "! grep -q '\"Seed 0\"' '$log'"
    check "newest run kept" "tail -n1 '$log' | grep -q 'flurry:fire'"
    set_key history-limit 2000

    echo "== test lock screen"
    set_key run-time 5
    set_key preview-request "'@test#1'"; sleep 3
    check "test saver running" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    sleep 3.5
    shot "$T/shots/test-notice.png"
    check "notice shown at run time (centre lit)" "centre_lit '$T/shots/test-notice.png'"
    sleep 3.5
    check "test stopped after the notice" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check "never locked" "! is_locked"
    check "history marks it as a test" "tail -n1 '$log' | grep -q '\"test\":true'"
    set_key run-time -1

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
