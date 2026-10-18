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
#   tools/headless-test.sh prefs            start the shell if needed and open the settings window
#   tools/headless-test.sh log              show the shell's log
#   tools/headless-test.sh stop             stop it
#   tools/headless-test.sh run              start, run the end-to-end checks, stop
#
# SCENARIOS="monitors overlay" limits `run` to those scenarios (for iterating;
# always run them all before committing).  Pixel checks need python-numpy.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=screensavers@yofuness.github.io
T=${SCREENSAVERS_TEST_DIR:-${TMPDIR:-/tmp}/screensavers-test}
MONITORS=${SCREENSAVERS_TEST_MONITORS:-"1920x1080 1920x1080"}
# Unix socket paths are limited to 108 bytes, so the runtime dir must be short.
RUNTIME=/tmp/sstest-$(id -u)
# Where the hacks are installed (Arch: lib, Fedora: libexec), as registry.js looks.
HACK_DIR=$(for d in /usr/lib/xscreensaver /usr/libexec/xscreensaver /usr/lib64/xscreensaver; do
    [ -d "$d" ] && { echo "$d"; break; }; done)

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
            # The virtual pointer starts in the top-left hot corner; its first
            # move would open the overview over everything.
            dconf write /org/gnome/desktop/interface/enable-hot-corners false
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

# Open the settings window in the test shell (starting it if needed).
prefs() {
    if [ ! -f "$T/pid" ] || ! call Status >/dev/null 2>&1; then
        start
    fi
    DBUS_SESSION_BUS_ADDRESS=$(bus) XDG_RUNTIME_DIR="$RUNTIME" WAYLAND_DISPLAY=wayland-sstest \
        XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" \
        bash -c 'dbus-update-activation-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME &&
            gnome-extensions prefs '"$UUID"
    sleep 3
    echo "settings window open; tabs are at y≈148 (General, Playlists, Library, History, Custom)"
}

shot() {
    call Screenshot "$1" >/dev/null
}

# ── Pixel checks ───────────────────────────────────────────────────────────
# All load a screenshot as an (height, width, channels) array.  Full
# resolution where it matters: sparse savers change too few pixels for an
# average to notice.

PIXELS_PY='
import sys
import numpy as np
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
def load(path):
    pb = GdkPixbuf.Pixbuf.new_from_file(path)
    h, w, n, rs = pb.get_height(), pb.get_width(), pb.get_n_channels(), pb.get_rowstride()
    raw = np.frombuffer(pb.get_pixels(), np.uint8)
    raw = np.pad(raw, (0, h * rs - raw.size))
    return raw.reshape(h, rs)[:, :w * n].reshape(h, w, n).astype(np.int32), raw
def neutral_white(rgb):
    lo, hi = rgb.min(axis=2), rgb.max(axis=2)
    return (lo > 150) & (hi - lo < 20)
'

pixels() {
    local code=$1; shift
    python3 -I -c "$PIXELS_PY$code" "$@"
}

# analyze A B: mean brightness of A, and how many pixels clearly changed.
analyze() {
    pixels '
a, araw = load(sys.argv[1])
b, braw = load(sys.argv[2])
step = 97
mean = araw[::step].astype(np.int64).sum() / (araw.size / step)
n = min(araw.size, braw.size)
changed = int((np.abs(araw[1:n:a.shape[2]].astype(np.int32) - braw[1:n:a.shape[2]].astype(np.int32)) > 40).sum())
print(f"{mean:.2f} {changed}")
' "$@"
}

# bright_extent FILE: width of the lit (neutral white) area in the top-left of monitor 0.
bright_extent() {
    pixels '
mask = neutral_white(load(sys.argv[1])[0][0:500:2, 0:1400:2, :3])
xs = np.nonzero(mask.any(axis=0))[0]
print(int(xs.max()) * 2 if xs.size else 0)
' "$@"
}

# white_in FILE X Y W H [lit]: count of neutral-white pixels (overlay text) in a
# region (every 2nd pixel), or of any lit pixel with "lit".
white_in() {
    pixels '
x0, y0, w, h = map(int, sys.argv[2:6])
region = load(sys.argv[1])[0][y0:y0 + h:2, x0:x0 + w:2, :3]
lit = len(sys.argv) > 6 and sys.argv[6] == "lit"
print(int((region.max(axis=2) > 40).sum() if lit else neutral_white(region).sum()))
' "$@"
}

# mirror_match FILE: both monitors (side by side, 1920 wide each) show the same
# picture.  The top 320 rows are skipped: the clock is only on the primary.
mirror_match() {
    pixels '
img = load(sys.argv[1])[0]
a = img[320:1080:4, 0:1920:4, :3]
b = img[320:1080:4, 1920:3840:4, :3]
diff = int((np.abs(a - b).sum(axis=2) > 60).sum())
lit = int((a.sum(axis=2) > 60).sum())
print(f"     differing samples={diff} lit samples={lit}")
sys.exit(0 if lit > 20 and diff < lit / 10 else 1)
' "$@"
}

# test_hue_share FILE: share of spring-green pixels (hue 135-165 degrees, any
# shading) on monitor 0, in thousandths.  XScreenSaver's built-in test image
# (colour bars and an orange logo) has none of that hue.
test_hue_share() {
    pixels '
img = load(sys.argv[1])[0][:, :1920, :3]
r, g, b = img[..., 0], img[..., 1], img[..., 2]
ok = (g > 80) & (g > b) & (b > r) & (g - r > 60)
hue = 120 + 60 * (b - r) / np.maximum(g - r, 1)
print(int((ok & (hue > 135) & (hue < 165)).mean() * 1000))
' "$@"
}

# centre_lit FILE: something light sits in the middle of monitor 0.
centre_lit() {
    pixels '
region = load(sys.argv[1])[0][500:580, 760:1160, :3]
sys.exit(0 if int((region.min(axis=2) > 200).sum()) > 200 else 1)
' "$@"
}

# ── Checks and waiting ────────────────────────────────────────────────────

# On a failure, show what was running: leftovers are the usual suspect.
fail() {
    echo "  FAIL $1"
    FAILED=1
    echo "     saver processes: $(saver_cmdlines "$HACK_DIR/" | tr '\n' ';')"
    echo "     status: $(call Status 2>/dev/null || true)"
}

check() {
    local name=$1 cond=$2
    if eval "$cond"; then echo "  ok   $name"; else fail "$name"; fi
}

now_ms() { local t=${EPOCHREALTIME/./}; echo $((t / 1000)); }

# wait_for SECONDS CONDITION: poll until the condition holds; false on timeout.
wait_for() {
    local end; end=$(( $(now_ms) + $(awk -v s="$1" 'BEGIN { printf "%d", s * 1000 }') ))
    while :; do
        eval "$2" && return 0
        [ "$(now_ms)" -ge "$end" ] && return 1
        sleep 0.2
    done
}

# check_within SECONDS NAME CONDITION: like check, but passes as soon as the
# condition holds, and fails only after SECONDS.
check_within() {
    local timeout=$1 name=$2 cond=$3
    if wait_for "$timeout" "$cond"; then echo "  ok   $name"; else fail "$name"; fi
}

is_locked() {
    call Status | grep -q '"locked":true'
}

# Processes of this test shell's savers.  Each saver runs in its own session
# (setsid) and what it forks may be re-parented, so match by environment.  A
# privileged hack's environment can't be read (Sonar has cap_net_raw), but it
# is a direct child of the test shell.
test_env() {
    { tr '\0' '\n' <"/proc/$1/environ"; } 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$RUNTIME"
}

test_shell_pid() {
    local p
    for p in $(pgrep -x gnome-shell || true); do
        test_env "$p" && { echo "$p"; return 0; }
    done
    return 0
}

saver_pids() {
    local p shell; shell=$(test_shell_pid)
    for p in $(pgrep -f -- "$1" || true); do
        if test_env "$p" || { [ -n "$shell" ] && [ "$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" = "$shell" ]; }; then
            echo "$p"
        fi
    done
    return 0
}

# Full command lines of matching processes ("pid command line", like pgrep -a).
# Written in one go: a reader that stops early (grep -q) must not make this
# fail with SIGPIPE under pipefail.
saver_cmdlines() {
    local p out=''
    for p in $(saver_pids "$1"); do
        out+="$p $({ tr '\0' ' ' <"/proc/$p/cmdline"; } 2>/dev/null)"$'\n'
    done
    printf '%s' "$out"
}

shown_count() {
    call Status | grep -o '"shown":true' | wc -l
}

covered() {
    call Covered | sed 's/.*uint32 \([0-9]*\).*/\1/'
}

# Every monitor shows its saver and no handover is in progress.
settled() {
    [ "$(shown_count)" -ge 2 ] && call Status | grep -q '"outgoing":false' && [ "$(covered)" -eq 2 ]
}

# No session and no saver processes left (the previous scenario is gone).
clean() {
    call Status | grep -q '"session":null' && [ -z "$(saver_pids $HACK_DIR/)" ]
}

stop_saver() {
    call Stop >/dev/null
    wait_for 6 clean || echo "     (warning: saver still running after Stop)"
}

# watch_covered SECONDS: sample how many times not every monitor was covered.
watch_covered() {
    local end bad=0; end=$(( $(now_ms) + $1 * 1000 ))
    while [ "$(now_ms)" -lt "$end" ]; do
        [ "$(covered)" -lt 2 ] && bad=$((bad + 1))
        sleep 0.05
    done
    echo "$bad"
}

set_key() {
    DBUS_SESSION_BUS_ADDRESS=$(bus) XDG_CONFIG_HOME="$T/config" \
        dconf write "/org/gnome/shell/extensions/screensavers/$1" "$2"
}

# expect_animating NAME: once shown, the screen is not black, and a later
# screenshot (every 2 s, up to 6 s) differs from the first.  Some savers pause
# between patterns (abstractile), so one fixed pair could land in a pause.
expect_animating() {
    local S="$T/shots" tag mean diff=0 i; tag=$(echo "$1" | tr -c 'a-zA-Z0-9\n' '_')
    wait_for 8 "[ \$(shown_count) -ge 2 ]" || true
    sleep 2
    shot "$S/$tag-1.png"
    for i in 2 3 4; do
        sleep 2; shot "$S/$tag-$i.png"
        read -r mean diff < <(analyze "$S/$tag-1.png" "$S/$tag-$i.png" 2>/dev/null)
        [ "$diff" -gt 1000 ] && break
    done
    echo "     brightness=$mean changed_pixels=$diff"
    check "$1: screen not black" "awk 'BEGIN{exit !($mean > 1)}'"
    check "$1: animating" "[ $diff -gt 1000 ]"
}

FLURRY="$HACK_DIR/flurry --preset"
# The saver shown now, or "none" (never fails: a failure here would end the run silently).
saver_now() { call Status | grep -o '"saver":"[^"]*"' || echo none; }

# savers_json: the saver id per slot, e.g. ["a","b"].
savers_json() {
    call Status | grep -o '"savers":\[[^]]*\]' | sed 's/"savers"://'
}

# ── Scenarios ─────────────────────────────────────────────────────────────

scenario_lock() {
    echo "== lock shows Flurry over the lock screen"
    call Lock >/dev/null
    check_within 8 "both monitors show a clone" "[ \$(shown_count) -eq 2 ]"
    expect_animating "flurry on lock"
    check "one flurry per monitor" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"

    echo "== mouse motion does not dismiss"
    call Motion >/dev/null; sleep 1.5
    check "still running after motion" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"

    echo "== a key press dismisses it, the lock screen stays"
    call Key >/dev/null
    check_within 4 "saver processes gone" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    shot "$T/shots/after-key.png"
    check "still locked" "is_locked"

    echo "== unlocking while a saver runs stops it"
    call Unlock >/dev/null; wait_for 4 "! is_locked" || true
    call Lock >/dev/null
    check_within 8 "saver back on relock" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    call Unlock >/dev/null
    check_within 5 "saver gone after unlock" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check_within 3 "unlocked" "! is_locked"

    echo "== a click dismisses a preview"
    call Preview 'flurry:fire' >/dev/null
    check_within 6 "preview running" "[ \$(shown_count) -eq 2 ]"
    call Click >/dev/null
    check_within 5 "preview gone after click" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    wait_for 4 clean || true

    echo "== run time over: saver stops and GNOME's fade/blank continues"
    set_key run-time 4
    call Lock >/dev/null; sleep 4
    check "running before run time" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    check_within 6 "stopped after run time" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check_within 3 "shield reports active (GNOME may blank now)" "call Status | grep -q '\"active\":true'"
    call Unlock >/dev/null; wait_for 4 "! is_locked" || true
    set_key run-time -1

    echo "== auto-lock: session goes idle -> saver first, then GNOME locks underneath"
    call Idle >/dev/null
    check_within 6 "saver running on idle" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    check_within 15 "session locked after the fade time" "is_locked"
    check "saver still running once locked" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    expect_animating "flurry after auto-lock"
    call Key >/dev/null
    check_within 5 "key dismisses, lock remains" "[ -z \"\$(saver_pids '$FLURRY')\" ] && is_locked"
    call Unlock >/dev/null; wait_for 4 "! is_locked" || true

    echo "== a crashing saver removes the overlay"
    call Preview 'flurry:classic' >/dev/null
    wait_for 6 "[ \$(shown_count) -eq 2 ]" || true
    kill -KILL $(saver_pids "$FLURRY") 2>/dev/null || true
    check_within 4 "session cleared" "call Status | grep -q '\"session\":null'"
}

scenario_hacks() {
    for hack in ${HACKS:-glmatrix fireworkx molecule pipes abstractile galaxy}; do
        [ "$hack" = flurry ] && continue
        echo "== xscreensaver: $hack"
        call Preview "xscreensaver:$hack" >/dev/null
        check_within 8 "$hack: window shown on both monitors" "[ \$(shown_count) -eq 2 ]"
        expect_animating "$hack"
        call Stop >/dev/null
        check_within 5 "$hack: processes gone" "[ -z \"\$(saver_pids $HACK_DIR/$hack)\" ]"
        wait_for 4 clean || true
    done
}

scenario_options() {
    echo "== per-hack options reach the command line"
    set_key saver-options "'{\"xscreensaver:glmatrix\": {\"density\": 10, \"fog\": false}}'"
    call Preview 'xscreensaver:glmatrix' >/dev/null
    check_within 6 "glmatrix got --density 10 --no-fog" "saver_cmdlines $HACK_DIR/glmatrix | grep -q -- '--density 10 --no-fog'"
    stop_saver

    echo "== frame rate: the slider, or match the display's refresh rate"
    local j=$HACK_DIR/jigsaw d
    set_key saver-options "'{\"xscreensaver:jigsaw\": {\"delay\": 30000}}'"
    call Preview 'xscreensaver:jigsaw' >/dev/null
    check_within 6 "the frame rate slider passes its (inverted) delay" "saver_cmdlines $j | grep -q -- '--delay 70000'"
    stop_saver
    set_key saver-options "'{\"xscreensaver:jigsaw\": {\"delay\": 30000, \"matchDisplay\": true}}'"
    call Preview 'xscreensaver:jigsaw' >/dev/null
    check_within 6 "match display, OpenGL: no pause on either copy (vsync paces it)" "[ \$(saver_cmdlines $j | grep -cE -- '--delay 0( |\$)') -eq 2 ]"
    stop_saver
    local c=$HACK_DIR/cwaves
    set_key saver-options "'{\"xscreensaver:cwaves\": {\"matchDisplay\": true}}'"
    call Preview 'xscreensaver:cwaves' >/dev/null
    check_within 6 "match display, 2D: every monitor's copy gets a pause" "[ \$(saver_cmdlines $c | grep -c -- '--delay') -eq 2 ]"
    for d in $(saver_cmdlines $c | grep -o -- '--delay [0-9]*' | cut -d' ' -f2); do
        echo "     delay: $d µs ($(( 1000000 / d )) Hz)"
        check "2D pause matches a 30–250 Hz display" "[ $d -ge 4000 ] && [ $d -le 34000 ]"
    done
    stop_saver
    set_key saver-options "'{}'"

    echo "== anti-aliasing: General default, per-screensaver override, OpenGL only"
    local g=$HACK_DIR/glmatrix aa
    aa() {
        set_key antialias "$1"; set_key saver-options "'{\"$2\": {$3}}'"
        call Preview "$2" >/dev/null
        wait_for 6 "[ -n \"\$(saver_pids $4)\" ]" || true
    }
    aa false xscreensaver:glmatrix "" $g
    check_within 6 "General off: no multiSample" "[ -n \"\$(saver_pids $g)\" ] && ! saver_cmdlines $g | grep -q multiSample"
    stop_saver
    aa true xscreensaver:glmatrix "" $g
    check_within 6 "General on: -xrm *multiSample: true" "saver_cmdlines $g | grep -q -- '-xrm \*multiSample: true'"
    stop_saver
    aa true xscreensaver:glmatrix "\"antialias\": \"off\"" $g
    check_within 6 "per-screensaver Off beats General on" "[ -n \"\$(saver_pids $g)\" ] && ! saver_cmdlines $g | grep -q multiSample"
    stop_saver
    aa false xscreensaver:glmatrix "\"antialias\": \"on\"" $g
    check_within 6 "per-screensaver On beats General off" "saver_cmdlines $g | grep -q -- '-xrm \*multiSample: true'"
    stop_saver
    aa true xscreensaver:abstractile "" $HACK_DIR/abstractile
    check_within 6 "2D screensavers never get it" "[ -n \"\$(saver_pids $HACK_DIR/abstractile)\" ] && ! saver_cmdlines $HACK_DIR/abstractile | grep -q multiSample"
    stop_saver
    set_key antialias true; set_key saver-options "'{}'"

    echo "== vermiculate: styles, custom worms and pattern length"
    local v=$HACK_DIR/vermiculate
    vermi() {
        set_key saver-options "'{\"xscreensaver:vermiculate\": {$1}}'"
        call Preview 'xscreensaver:vermiculate' >/dev/null
        wait_for 6 "[ -n \"\$(saver_pids $v)\" ]" || true
    }
    vermi ""
    check_within 6 "random style (default) passes no --instring, -xrm or --speed" "[ -n \"\$(saver_pids $v)\" ] && ! saver_cmdlines $v | grep -q -- '--instring\|-xrm\|--speed'"
    stop_saver
    vermi "\"ticks\": 80000"
    check_within 6 "pattern length: -xrm *ticks:80000" "saver_cmdlines $v | grep -q -- '-xrm \\*ticks:80000'"
    stop_saver
    vermi "\"style\": \"swarm\""
    check_within 6 "built-in style passes its instring and the drawing speed" "saver_cmdlines $v | grep -q -- '--instring mn1r*#by1i#lcalc1#fn --speed 300'"
    stop_saver
    vermi "\"style\": \"custom\", \"worms\": 3, \"movement\": \"3\", \"maze\": true, \"breakWalls\": true"
    check_within 6 "custom style builds its instring" "saver_cmdlines $v | grep -q -- '--instring mn333#g#yek --speed 300'"
    stop_saver
    vermi "\"style\": \"instring\", \"instring\": \"g\""
    check_within 6 "own instring is passed as typed" "saver_cmdlines $v | grep -q -- '--instring g --speed 300'"
    stop_saver

    # The drawing speed must really change the drawing once a style is set
    # (with the random style the hack ignores it).
    local slow fast
    set_key monitor-mode "'mirror'"; set_key show-clock false; set_key show-media false
    vermi "\"style\": \"menagerie\", \"speed\": 1"; sleep 4; shot "$T/shots/vermi-slow.png"; stop_saver
    vermi "\"style\": \"menagerie\", \"speed\": 1000"; sleep 4; shot "$T/shots/vermi-fast.png"; stop_saver
    set_key monitor-mode "'same'"; set_key show-clock true; set_key show-media true
    slow=$(white_in "$T/shots/vermi-slow.png" 0 0 1920 1080 lit); fast=$(white_in "$T/shots/vermi-fast.png" 0 0 1920 1080 lit)
    echo "     lit pixels after 4 s: speed 1=$slow speed 1000=$fast"
    check "drawing speed changes how fast it draws" "[ $fast -gt \$(( slow * 10 + 100 )) ]"
    set_key saver-options "'{}'"

    echo "== sonar defaults to simulation (no ping privileges needed)"
    call Preview 'xscreensaver:sonar' >/dev/null
    check_within 6 "sonar started with --ping simulation" "saver_cmdlines $HACK_DIR/sonar | grep -q -- '--ping simulation'"
    stop_saver
    set_key saver-options "'{\"xscreensaver:sonar\": {\"ping\": \"sn\"}}'"
    call Preview 'xscreensaver:sonar' >/dev/null
    check_within 6 "user's choice overrides the default" "saver_cmdlines $HACK_DIR/sonar | grep -qv -- '--ping'"
    stop_saver
    set_key saver-options "'{}'"
}

scenario_failures() {
    echo "== a screensaver that won't start (vidwhacker) is replaced, not the end"
    set_key playlists "'[{\"name\": \"Broken first\", \"savers\": [\"xscreensaver:vidwhacker\", \"xscreensaver:abstractile\"]}, {\"name\": \"Broken middle\", \"savers\": [\"xscreensaver:abstractile\", \"xscreensaver:vidwhacker\", \"flurry:fire\"]}]'"
    set_key shuffle false
    set_key active-playlist "'Broken first'"
    set_key preview-request "'@test#20'"
    check_within 10 "start: the next saver plays instead" "call Status | grep -q '\"saver\":\"xscreensaver:abstractile\"' && settled"
    call Key >/dev/null; wait_for 5 clean || true

    set_key active-playlist "'Broken middle'"
    set_key preview-request "'@test#21'"
    check_within 6 "skip test starts on abstractile" "call Status | grep -q '\"saver\":\"xscreensaver:abstractile\"' && settled"
    call KeyVal 65363 >/dev/null
    local gaps; gaps=$(watch_covered 3)
    check_within 8 "skip: passes over it to the next saver" "call Status | grep -q '\"saver\":\"flurry:fire\"' && settled"
    echo "     samples with a monitor uncovered during the skip: $gaps"
    check "skip: the old saver stays until the next one shows" "[ $gaps -eq 0 ]"
    call Key >/dev/null; wait_for 5 clean || true
    set_key active-playlist "''"; set_key playlists "'[]'"; set_key shuffle true

    set_key preview-request "'xscreensaver:vidwhacker#22'"
    check_within 10 "previewing it on its own just ends" "clean"
}

scenario_playlists() {
    echo "== playlist in order + skip key"
    set_key playlists "'[{\"name\": \"Pair\", \"savers\": [\"flurry:fire\", \"xscreensaver:abstractile\"]}]'"
    set_key active-playlist "'Pair'"
    set_key shuffle false
    set_key preview-request "'@test#2'"
    check_within 6 "playlist starts with its first saver" "call Status | grep -q '\"saver\":\"flurry:fire\"'"
    wait_for 6 settled || true
    call KeyVal 65363 >/dev/null
    local gaps; gaps=$(watch_covered 2)
    check_within 6 "skip key moves to the next saver" "call Status | grep -q '\"saver\":\"xscreensaver:abstractile\"'"
    check_within 6 "skip did not dismiss" "[ \$(shown_count) -eq 2 ]"
    check_within 4 "old saver's processes gone after the skip" "[ -z \"\$(saver_pids '$FLURRY fire')\" ]"
    echo "     samples with a monitor uncovered during the skip: $gaps"
    check "skip never uncovers a monitor" "[ $gaps -eq 0 ]"
    wait_for 6 settled || true
    call KeyVal 65363 >/dev/null
    check_within 6 "in-order playlist loops back to the start" "call Status | grep -q '\"saver\":\"flurry:fire\"'"
    wait_for 6 settled || true
    call Key >/dev/null
    check_within 5 "other keys still dismiss" "[ -z \"\$(saver_pids $HACK_DIR/)\" ]"
    check_within 3 "history records the skip" "grep -q '\"ended\":\"skipped\"' '$T/data/$UUID/history.jsonl'"

    echo "== shuffled playlist plays everything once before repeating"
    set_key playlists "'[{\"name\": \"Trio\", \"savers\": [\"flurry:fire\", \"flurry:water\", \"xscreensaver:abstractile\"]}]'"
    set_key active-playlist "'Trio'"
    set_key shuffle true
    local played=""
    set_key preview-request "'@test#4'"; wait_for 6 settled || true
    played="$played $(saver_now)"
    call KeyVal 65363 >/dev/null; sleep 0.5; wait_for 6 settled || true
    played="$played $(saver_now)"
    call KeyVal 65363 >/dev/null; sleep 0.5; wait_for 6 settled || true
    played="$played $(saver_now)"
    echo "     played:$played"
    local distinct
    distinct=$(echo "$played" | tr ' ' '\n' | grep . | sort -u | wc -l)
    check "three different savers in a row" "[ $distinct -eq 3 ]"

    echo "     (mashing the skip key)"
    local end mash_gaps=0; end=$(( $(now_ms) + 4000 ))
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        call KeyVal 65363 >/dev/null
        [ "$(covered)" -lt 2 ] && mash_gaps=$((mash_gaps + 1))
        sleep 0.15
    done
    while [ "$(now_ms)" -lt "$end" ]; do
        [ "$(covered)" -lt 2 ] && mash_gaps=$((mash_gaps + 1))
        sleep 0.05
    done
    check_within 6 "mashing skip leaves one saver per monitor" "settled && [ \$(shown_count) -eq 2 ] && [ \$(saver_pids $HACK_DIR/ | wc -l) -eq 2 ]"
    echo "     samples with a monitor uncovered while mashing: $mash_gaps"
    check "mashing never uncovers a monitor" "[ $mash_gaps -eq 0 ]"
    call Key >/dev/null; wait_for 5 clean || true
    set_key active-playlist "'Pair'"

    set_key skip-key "uint32 0"
    set_key preview-request "'@test#3'"; wait_for 6 settled || true
    call KeyVal 65363 >/dev/null
    check_within 4 "with no skip key, Right dismisses" "[ -z \"\$(saver_pids $HACK_DIR/)\" ]"
    set_key skip-key "uint32 65363"
    set_key active-playlist "''"
    set_key playlists "'[]'"
    set_key shuffle true
}

scenario_sources() {
    echo "== source: Favourites plays only favourites"
    set_key favorites "['flurry:fire']"
    set_key random true
    set_key random-pool "'favourites'"
    local seen="" i
    set_key preview-request "'@test#7'"; wait_for 6 settled || true
    seen="$(saver_now)"
    for i in 1 2; do
        call KeyVal 65363 >/dev/null; sleep 0.5; wait_for 6 settled || true
        seen="$seen $(saver_now)"
    done
    echo "     shown: $seen"
    check "favourites: only the favourite plays" "[ \$(echo '$seen' | tr ' ' '\n' | grep -vc '\"saver\":\"flurry:fire\"') -eq 0 ]"
    call Key >/dev/null; wait_for 5 clean || true

    echo "== source: All screensavers plays beyond the favourites"
    set_key random-pool "'all'"
    set_key preview-request "'@test#8'"; wait_for 6 settled || true
    seen="$(saver_now)"
    for i in 1 2 3; do
        call KeyVal 65363 >/dev/null; sleep 0.5; wait_for 6 settled || true
        seen="$seen $(saver_now)"
    done
    echo "     shown: $seen"
    check "all: a screensaver showed after every skip" "! echo '$seen' | grep -qw none"
    check "all: plays screensavers that aren't favourites" "[ \$(echo '$seen' | tr ' ' '\n' | grep -vc '\"saver\":\"flurry:fire\"') -gt 0 ]"
    check "all: never the same one twice in a row" "python3 -c '
import sys
seq = sys.argv[1].split()
sys.exit(any(a == b for a, b in zip(seq, seq[1:])))' '$seen'"
    call Key >/dev/null; wait_for 5 clean || true
    set_key random false
    set_key random-pool "'favourites'"
    set_key favorites "@as []"
}

scenario_images() {
    echo "== picture folder for image screensavers (jigsaw)"
    local pics="$T/pictures" home="$T/data/$UUID/xscreensaver-home" pid share
    mkdir -p "$pics/sub"
    python3 -I -c "
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 800, 600)
pb.fill(0x00ff80ff)
pb.savev('$pics/sub/spring-green.png', 'png', [], [])"
    set_key monitor-mode "'mirror'"; set_key show-clock false; set_key show-media false
    set_key image-directory "'$pics'"
    check_within 3 "private .xscreensaver points at the folder" "grep -q 'imageDirectory:.*$pics' '$home/.xscreensaver' && grep -q 'chooseRandomImages:.True' '$home/.xscreensaver'"
    check "desktop grabs are off" "grep -q 'grabDesktopImages:.False' '$home/.xscreensaver'"
    call Preview 'xscreensaver:jigsaw' >/dev/null
    wait_for 6 "[ -n \"\$(saver_pids $HACK_DIR/jigsaw)\" ]" || true
    pid=$(saver_pids $HACK_DIR/jigsaw | head -1)
    check "jigsaw runs with the private HOME" "tr '\\0' '\\n' < /proc/$pid/environ | grep -qx 'HOME=$home'"
    check_within 15 "jigsaw shows a picture from the folder" "shot '$T/shots/jigsaw-picture.png' && [ \$(test_hue_share '$T/shots/jigsaw-picture.png') -gt 100 ]"
    echo "     test colour share: $(test_hue_share "$T/shots/jigsaw-picture.png")/1000"
    stop_saver
    set_key image-directory "''"
    check_within 3 "clearing the folder turns pictures off" "grep -q 'chooseRandomImages:.False' '$home/.xscreensaver'"
    call Preview 'xscreensaver:jigsaw' >/dev/null; wait_for 6 settled || true; sleep 8
    shot "$T/shots/jigsaw-builtin.png"; share=$(test_hue_share "$T/shots/jigsaw-builtin.png")
    echo "     test colour share without a folder: $share/1000"
    check "without a folder it shows its built-in image" "[ $share -lt 60 ]"
    stop_saver
    set_key monitor-mode "'same'"; set_key show-clock true; set_key show-media true
}

scenario_overlay() {
    echo "== clock overlay on the primary monitor"
    # glmatrix and white pixels only: Flurry's white-hot core can drift into
    # the corner and look like the clock.
    call Preview 'xscreensaver:glmatrix' >/dev/null; wait_for 6 settled || true; sleep 1
    shot "$T/shots/overlay-on.png"
    stop_saver
    set_key show-clock false
    call Preview 'xscreensaver:glmatrix' >/dev/null; wait_for 6 settled || true; sleep 1
    shot "$T/shots/overlay-off.png"
    stop_saver
    set_key show-clock true
    local on off
    on=$(white_in "$T/shots/overlay-on.png" 0 0 500 260); off=$(white_in "$T/shots/overlay-off.png" 0 0 500 260)
    echo "     white pixels in the clock corner: on=$on off=$off"
    check "clock region is brighter with the clock on" "[ $on -gt 100 ] && [ $off -lt \$(( on / 10 )) ]"

    echo "== now playing + media keys"
    : >"$T/mpris-calls"
    DBUS_SESSION_BUS_ADDRESS=$(bus) python3 "$ROOT/tools/fake-mpris.py" "$T/mpris-calls" &
    local mpris=$!
    sleep 1.5
    call Preview 'flurry:classic' >/dev/null
    check_within 5 "overlay knows the playing track" "call Status | grep -q '\"media\":\"Test Track\"'"
    shot "$T/shots/media.png"
    call MediaKey >/dev/null; sleep 1
    check "play/pause reached the player" "grep -q PlayPause '$T/mpris-calls'"
    check "media key did not dismiss" "[ \$(shown_count) -eq 2 ]"
    stop_saver
    kill "$mpris" 2>/dev/null || true

    echo "== overlay size changes live"
    # glmatrix: its green rain can't be mistaken for the white overlay text
    # (Flurry's white-hot core sometimes drifts into the measured corner).
    call Preview 'xscreensaver:glmatrix' >/dev/null; wait_for 6 settled || true; sleep 1
    shot "$T/shots/size100.png"
    set_key overlay-scale 200; sleep 1.5
    shot "$T/shots/size200.png"
    set_key overlay-scale 50; sleep 1.5
    shot "$T/shots/size50.png"
    stop_saver
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
    call Preview 'xscreensaver:glmatrix' >/dev/null; wait_for 6 settled || true; sleep 1
    set_key overlay-corner "'bottom-right'"; sleep 1.5
    shot "$T/shots/corner-br.png"
    set_key overlay-monitor "'$connector'"; sleep 1.5
    shot "$T/shots/monitor-1.png"
    stop_saver
    set_key overlay-corner "'top-left'"; set_key overlay-monitor "''"
    tl=$(white_in "$T/shots/corner-br.png" 0 0 700 400)
    br=$(white_in "$T/shots/corner-br.png" 1220 680 700 400)
    m1=$(white_in "$T/shots/monitor-1.png" 3140 680 700 400)
    echo "     white pixels: top-left=$tl bottom-right=$br second monitor bottom-right=$m1"
    check "bottom-right corner has the overlay" "[ $br -gt 100 ] && [ $tl -lt \$(( br / 10 )) ]"
    check "overlay moves to the chosen monitor" "[ -n '$connector' ] && [ $m1 -gt 100 ]"
}

scenario_rotation() {
    echo "== rotation swaps savers without a gap"
    set_key rotate-interval 1
    set_key random true
    set_key favorites "['flurry:fire', 'xscreensaver:abstractile']"
    call Preview 'flurry:classic' >/dev/null; wait_for 6 settled || true
    local first; first=$(saver_now)
    check_within 14 "saver changed" "[ \"\$(saver_now)\" != none ] && [ \"\$(saver_now)\" != '$first' ]"
    local gaps; gaps=$(watch_covered 2)
    shot "$T/shots/rotated.png"
    echo "     $first -> $(saver_now); samples uncovered during the change: $gaps"
    check_within 4 "old saver processes gone" "[ -z \"\$(saver_pids '$FLURRY classic')\" ]"
    check "rotation never uncovers a monitor" "[ $gaps -eq 0 ]"
    stop_saver
    set_key random false
    set_key favorites "@as []"

    echo "== the selected screensaver never changes on the interval"
    set_key preview-request "'@test#50'"
    wait_for 6 settled || true
    local selected; selected=$(saver_now)
    sleep 12
    check "the selected screensaver still plays after the interval" "[ \"\$(saver_now)\" = '$selected' ] && [ '$selected' != none ]"
    call KeyVal 65363 >/dev/null
    sleep 3
    check "the skip key does nothing for the selected screensaver" "[ \"\$(saver_now)\" = '$selected' ] && call Status | grep -q '\"outgoing\":false'"
    check "the skip key doesn't dismiss it either" "[ \$(shown_count) -ge 2 ]"
    call Key >/dev/null; wait_for 5 clean || true
    set_key rotate-interval 0
}

scenario_monitors() {
    echo "== multiple monitors: mirrored"
    set_key monitor-mode "'mirror'"
    call Preview 'xscreensaver:abstractile' >/dev/null; wait_for 6 settled || true
    check "mirrored: one saver process" "[ \$(saver_pids $HACK_DIR/ | wc -l) -eq 1 ]"
    check "mirrored: both monitors covered" "[ \$(shown_count) -eq 2 ]"
    # Retried until enough is drawn to compare (abstractile starts nearly black).
    check_within 10 "mirrored: both monitors show the same picture" "shot '$T/shots/mirror.png' && mirror_match '$T/shots/mirror.png'"
    stop_saver

    echo "== multiple monitors: different on each"
    set_key monitor-mode "'different'"
    set_key playlists "'[{\"name\": \"Trio\", \"savers\": [\"flurry:fire\", \"xscreensaver:glmatrix\", \"xscreensaver:abstractile\"]}]'"
    set_key active-playlist "'Trio'"
    set_key preview-request "'@test#5'"; wait_for 6 settled || true
    local first second
    first=$(savers_json)
    echo "     savers: $first"
    check "different: two processes" "[ \$(saver_pids $HACK_DIR/ | wc -l) -eq 2 ]"
    check "different: each monitor its own saver" "python3 -c 'import json,sys; a=json.loads(sys.argv[1]); sys.exit(not (len(a)==2 and a[0]!=a[1]))' '$first'"
    call KeyVal 65363 >/dev/null; sleep 0.5
    check_within 6 "different: still covered after skip" "settled && [ \$(shown_count) -ge 2 ]"
    second=$(savers_json)
    echo "     after skip: $second"
    check "different: skip changes every monitor" "python3 -c 'import json,sys; a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2]); sys.exit(not (a[0]!=b[0] and a[1]!=b[1] and b[0]!=b[1]))' '$first' '$second'"
    call Key >/dev/null; wait_for 5 clean || true

    echo "== multiple monitors: staggered timed change"
    set_key rotate-interval 1
    set_key preview-request "'@test#6'"; wait_for 6 settled || true
    local log="" uncovered=0 now
    local end; end=$(( $(now_ms) + 22000 ))
    while [ "$(now_ms)" -lt "$end" ]; do
        now=$(savers_json)
        [ "$now" != "${log##* }" ] && log="$log $now"
        [ "$(covered)" -lt 2 ] && uncovered=$((uncovered + 1))
        sleep 0.2
    done
    echo "     sequence:$log"
    check "staggered: monitors changed one at a time" "python3 -c '
import json, sys
seq = [json.loads(x) for x in sys.argv[1].split()]
steps = [(a, b) for a, b in zip(seq, seq[1:])]
ok = any(a[0] != b[0] and a[1] == b[1] for a, b in steps) and any(a[1] != b[1] and a[0] == b[0] for a, b in steps)
sys.exit(not ok)' '$log'"
    check "staggered: never the same saver on both monitors" "python3 -c '
import json, sys
sys.exit(any(len(set(json.loads(x))) < 2 for x in sys.argv[1].split()))' '$log'"
    echo "     samples with a monitor uncovered: $uncovered"
    check "staggered: monitors stay covered" "[ $uncovered -eq 0 ]"
    call Key >/dev/null; wait_for 5 clean || true
    set_key rotate-interval 0
    set_key active-playlist "''"
    set_key playlists "'[]'"
    set_key monitor-mode "'same'"
}

scenario_retrigger() {
    echo "== re-trigger after dismissing on the lock screen"
    set_key retrigger-delay 3
    call Lock >/dev/null
    wait_for 8 "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]" || true
    call Key >/dev/null
    check_within 4 "dismissed" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check_within 7 "saver came back after 3 s idle" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    check "still locked" "is_locked"
    call Key >/dev/null
    wait_for 4 "[ -z \"\$(saver_pids '$FLURRY')\" ]" || true
    call Unlock >/dev/null; sleep 5
    check "no re-trigger after unlock" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
}

scenario_history() {
    echo "== history log"
    local log="$T/data/$UUID/history.jsonl"
    call Preview 'flurry:classic' >/dev/null; wait_for 6 settled || true
    call Key >/dev/null; wait_for 5 clean || true
    check_within 3 "history file written" "[ -s '$log' ]"
    check_within 3 "records a key dismissal" "grep -q '\"ended\":\"key\"' '$log'"
    check "records the saver name" "grep -q '\"name\":\"Flurry (Classic)\"' '$log'"
    [ -s "$log" ] && tail -n 3 "$log" | sed 's/^/     /'

    echo "== history limit trims to the newest runs"
    python3 -c "
import json
with open('$log', 'w') as f:
    for i in range(130):
        f.write(json.dumps({'id': 'seed', 'name': 'Seed %d' % i, 'start': i, 'end': i + 1, 'ended': 'key', 'lock': True}) + '\n')
"
    set_key history-limit 100; sleep 1
    call Preview 'flurry:fire' >/dev/null; wait_for 6 settled || true
    stop_saver
    check_within 4 "trimmed to 100 runs" "[ \$(wc -l < '$log') -eq 100 ]"
    echo "     lines after trim: $(wc -l < "$log")"
    check "oldest runs dropped" "! grep -q '\"Seed 0\"' '$log'"
    check "newest run kept" "tail -n1 '$log' | grep -q 'flurry:fire'"
    set_key history-limit 2000
}

scenario_preview_button() {
    echo "== test lock screen"
    local log="$T/data/$UUID/history.jsonl"
    set_key run-time 5
    set_key preview-request "'@test#1'"; sleep 3
    check "test saver running" "[ \$(saver_pids '$FLURRY' | wc -l) -eq 2 ]"
    sleep 3.5
    shot "$T/shots/test-notice.png"
    check "notice shown at run time (centre lit)" "centre_lit '$T/shots/test-notice.png'"
    check_within 4 "test stopped after the notice" "[ -z \"\$(saver_pids '$FLURRY')\" ]"
    check "never locked" "! is_locked"
    check_within 3 "history marks it as a test" "tail -n1 '$log' | grep -q '\"test\":true'"
    set_key run-time -1
}

scenario_reuse() {
    echo "== hacks draw into long-lived host windows (mutter leaks every destroyed or unmapped one)"
    set_key random true
    set_key random-pool "'all'"
    set_key preview-request "'@test#40'"
    wait_for 8 settled || true
    call KeyVal 65363 >/dev/null; wait_for 8 settled || true
    call KeyVal 65363 >/dev/null; wait_for 8 settled || true
    local early; early=$(host_windows)
    local i own=0
    for i in 1 2 3 4 5 6; do
        call KeyVal 65363 >/dev/null; wait_for 8 settled || true
        own=$((own + $(call Status | { grep -o '"leased":false' || true; } | wc -l)))
    done
    local late; late=$(host_windows)
    echo "     host windows after 2 skips: $early, after 8: $late"
    check "skips reuse the host windows instead of opening new ones" "[ $late -eq $early ]"
    check "at most a few host windows per monitor" "[ $late -le 6 ]"
    check "every hack drew into a host window" "[ $own -eq 0 ]"
    call Key >/dev/null; wait_for 5 clean || true
    set_key random false; set_key random-pool "'favourites'"
    check "the window host stays running between screensavers" "[ -n \"\$(saver_pids windowHost.js)\" ]"
    check "host windows aren't in the overview or Alt+Tab" "call Status | grep -q '\"hostListed\":0'"

    DBUS_SESSION_BUS_ADDRESS=$(bus) gnome-extensions disable "$UUID"
    check_within 5 "disabling the extension ends the window host" "[ -z \"\$(saver_pids windowHost.js)\" ]"
    DBUS_SESSION_BUS_ADDRESS=$(bus) gnome-extensions enable "$UUID"
    wait_for 10 "call Status >/dev/null 2>&1" || true
    set_key preview-request "'xscreensaver:glmatrix#41'"
    check_within 10 "after enabling again, a hack shows in a new host" "settled && [ \$(host_windows) -ge 1 ]"
    stop_saver
}

# How many windows the window host has open.
host_windows() {
    { call Status | grep -o '"hostWindows":[0-9]*' || echo :0; } | cut -d: -f2
}

scenario_install_help() {
    echo "== the install command shown when XScreenSaver is missing, per distribution"
    # A copy: gjs can't import from a path with spaces.
    mkdir -p "$T/js" && cp "$ROOT"/extension/{registry,hackFixes}.js "$T/js/"
    cat >"$T/js/cases.js" <<JS
import {installCommand} from 'file://$T/js/registry.js';
const ostree = 'rpm-ostree install xscreensaver-extras xscreensaver-gl-extras';
const dnf = 'sudo dnf install xscreensaver-extras xscreensaver-gl-extras';
const apt = 'sudo apt install xscreensaver-data-extra xscreensaver-gl-extra';
const pacman = 'sudo pacman -S xscreensaver';
const cases = [
    ['ID=bazzite\nID_LIKE="fedora"\nVARIANT_ID=bazzite-gnome', true, ostree],
    ['ID=fedora\nVARIANT_ID=silverblue', true, ostree],
    ['ID=fedora\nVERSION_ID=44', false, dnf],
    ['ID=arch', false, pacman],
    ['ID=endeavouros\nID_LIKE=arch', false, pacman],
    ['ID=ubuntu\nID_LIKE=debian', false, apt],
    ['ID=linuxmint\nID_LIKE="ubuntu debian"', false, apt],
    ['ID=debian', false, apt],
    ['ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"', false, null],
    ['', false, null],
];
for (const [text, image, want] of cases) {
    const got = installCommand(text, image)?.[0] ?? null;
    if (got !== want)
        print(\`\${JSON.stringify(text)} gave \${got}\`);
}
JS
    local wrong; wrong=$(gjs -m "$T/js/cases.js" 2>&1)
    [ -n "$wrong" ] && echo "     $wrong"
    check "each distribution gets its own install command" "[ -z \"\$wrong\" ]"
}

scenario_children() {
    echo "== stopping a saver also stops what it forked (Map Scroller's tile loader)"
    local m=$HACK_DIR/mapscroller
    call Preview 'xscreensaver:mapscroller' >/dev/null
    check_within 10 "map scroller forked its loader" "[ \$(saver_pids $m | wc -l) -gt 2 ]"
    echo "     map scroller processes: $(saver_pids $m | wc -l) (2 savers + their loaders)"
    call Stop >/dev/null
    check_within 5 "none of its processes are left" "[ -z \"\$(saver_pids $m)\" ]"
    wait_for 4 clean || true
}

ALL_SCENARIOS="lock hacks options playlists failures children reuse sources images overlay rotation monitors retrigger history preview_button install_help"

run() {
    FAILED=0
    local t0; t0=$(now_ms)
    start
    # Most scenarios count one saver process per monitor; the monitor modes
    # get their own scenario.
    set_key monitor-mode "'same'"

    for name in ${SCENARIOS:-$ALL_SCENARIOS}; do
        local ts; ts=$(now_ms)
        "scenario_$name"
        echo "     ($name: $(( ($(now_ms) - ts) / 1000 )) s)"
    done

    if grep -q "JS ERROR" "$T/shell.log"; then
        echo "  FAIL JS errors in log:"; grep -A3 "JS ERROR" "$T/shell.log" | head -20; FAILED=1
    fi
    stop
    echo "total: $(( ($(now_ms) - t0) / 1000 )) s${SCENARIOS:+ (only: $SCENARIOS)}"
    [ "$FAILED" = 0 ] && echo "ALL OK" || { echo "SOME CHECKS FAILED"; return 1; }
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    call) shift; call "$@" ;;
    shot) shot "$2" ;;
    prefs) prefs ;;
    log) cat "$T/shell.log" ;;
    run) run ;;
    *) sed -n '2,17p' "$0"; exit 1 ;;
esac
