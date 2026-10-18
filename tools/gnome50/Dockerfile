# SPDX-License-Identifier: GPL-2.0-or-later
# Fedora 44 ships GNOME 50: runs the headless test suite against GNOME Shell 50
# (`make test-gnome50`).  The repository is mounted at /work.
FROM fedora:44

RUN dnf -y install --setopt=install_weak_deps=False \
        gnome-shell xorg-x11-server-Xwayland mesa-dri-drivers \
        xscreensaver-base xscreensaver-extras xscreensaver-gl-extras \
        gtk3 gjs dconf dbus-daemon dbus-tools glib2 \
        python3 python3-numpy python3-gobject gdk-pixbuf2 \
        procps-ng util-linux fuse3 gawk findutils make \
    && dnf clean all

# Let the stand-in GDM (fake-logind.js, run as root) own its name.
RUN printf '%s\n' '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"' \
        '"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">' \
        '<busconfig><policy user="root"><allow own="org.gnome.DisplayManager"/></policy>' \
        '<policy context="default"><allow send_destination="org.gnome.DisplayManager"/></policy></busconfig>' \
        > /etc/dbus-1/system.d/test-gdm.conf

ARG UID=1000
RUN useradd -m -u "$UID" tester
WORKDIR /work
ENTRYPOINT ["/work/tools/gnome50/run.sh"]
