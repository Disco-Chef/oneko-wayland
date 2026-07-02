UUID   = oneko-wayland@disco-chef
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
BINDIR = $(HOME)/.local/bin

all: sprites

sprites:
	python3 tools/xbm2json.py

install:
	./install.sh

pack: sprites
	mkdir -p dist
	gnome-extensions pack --force \
		--extra-source=cat.js \
		--extra-source=sprites.js \
		--extra-source=sprites.json \
		--out-dir=dist \
		extension/$(UUID)

uninstall:
	-gnome-extensions disable $(UUID) 2>/dev/null
	rm -rf $(EXTDIR)
	rm -f $(BINDIR)/oneko-wayland

# Development: run a GNOME Shell development-kit instance (a shell in a
# window) with a private D-Bus, so you can iterate without logging out.
devkit:
	dbus-run-session -- gnome-shell --devkit

.PHONY: all sprites install pack uninstall devkit
