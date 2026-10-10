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
	-cp extension/*.css $(BUILD)/ 2>/dev/null
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
zip: all
	rm -f $(UUID).zip
	cd $(BUILD) && zip -qr ../../$(UUID).zip . -x .stamp debug.js schemas/gschemas.compiled

test: all
	tools/headless-test.sh run

clean:
	rm -rf build $(UUID).zip

.PHONY: all install uninstall zip test clean
