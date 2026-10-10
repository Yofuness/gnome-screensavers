# SPDX-License-Identifier: GPL-2.0-or-later
UUID := screensavers@yofuness.github.io
BUILD := build/$(UUID)
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
EXT_SRC := $(wildcard extension/*.js extension/*.json extension/*.css) \
           extension/schemas/org.gnome.shell.extensions.screensavers.gschema.xml

all: $(BUILD)/.stamp

# Self-contained extension directory: JS and compiled schemas.
$(BUILD)/.stamp: $(EXT_SRC)
	rm -rf $(BUILD)
	mkdir -p $(BUILD)/schemas
	cp extension/*.js extension/metadata.json $(BUILD)/
	$(if $(wildcard extension/*.css),cp extension/*.css $(BUILD)/)
	cp extension/schemas/*.gschema.xml $(BUILD)/schemas/
	glib-compile-schemas --strict $(BUILD)/schemas
	touch $@

# Installs for the current user; takes effect after logging out and back in.
install: all
	rm -rf $(EXT_DIR)
	mkdir -p $(dir $(EXT_DIR))
	cp -r $(BUILD) $(EXT_DIR)
	rm -f $(EXT_DIR)/.stamp
	gnome-extensions enable $(UUID) || true
	@echo "Installed. Log out and back in to load it (Wayland can't reload extensions live)."

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(EXT_DIR)

# Upload package for extensions.gnome.org; leaves out the test-only debug hooks and the
# compiled schema (GNOME compiles schemas itself since 44).
# The BEGIN DEBUG ... END DEBUG block in extension.js (which loads debug.js) is
# stripped from the packaged copy too.
zip: all
	rm -rf build/zip $(UUID).zip
	cp -r $(BUILD) build/zip
	rm -f build/zip/.stamp build/zip/debug.js build/zip/schemas/gschemas.compiled
	sed -i '/BEGIN DEBUG/,/END DEBUG/d' build/zip/extension.js
	! grep -q "debug.js" build/zip/extension.js
	cd build/zip && zip -qr ../../$(UUID).zip .

test: all
	tools/headless-test.sh run

clean:
	rm -rf build $(UUID).zip

.PHONY: all install uninstall zip test clean
