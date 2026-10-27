#!/usr/bin/env bash
# oneko-wayland installer: builds sprites, packs and installs the GNOME Shell
# extension, installs the CLI, and sanity-checks the settings that commonly
# prevent user extensions from loading.
set -euo pipefail

UUID=oneko-wayland-legacy@disco-chef
HERE=$(cd "$(dirname "$0")" && pwd)

say()  { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- requirements -----------------------------------------------------------
command -v gnome-shell >/dev/null 2>&1 ||
    die "gnome-shell not found; this project only works on GNOME."
command -v gnome-extensions >/dev/null 2>&1 ||
    die "the gnome-extensions tool is missing (it ships with gnome-shell)."
command -v python3 >/dev/null 2>&1 ||
    die "python3 is required."
python3 -c 'import gi' 2>/dev/null ||
    die "the CLI needs python3-gi (PyGObject).
       Debian/Ubuntu: sudo apt install python3-gi
       Fedora:        sudo dnf install python3-gobject
       Arch:          sudo pacman -S python-gobject"

SHELL_MAJOR=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if ! grep -q "\"$SHELL_MAJOR\"" "$HERE/extension/$UUID/metadata.json"; then
    warn "GNOME Shell $SHELL_MAJOR is not in the tested list ($(grep -o '"shell-version": \[[^]]*\]' "$HERE/extension/$UUID/metadata.json"))."
    warn "Add \"$SHELL_MAJOR\" to extension/$UUID/metadata.json shell-version and re-run if you want to try anyway."
fi

# --- build + install the extension -----------------------------------------
say "building sprites.json from the original oneko bitmaps"
python3 "$HERE/tools/xbm2json.py" >/dev/null

say "packing and installing the extension"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gnome-extensions pack --force \
    --extra-source=cat.js \
    --extra-source=sprites.js \
    --extra-source=sprites.json \
    --out-dir="$TMP" \
    "$HERE/extension/$UUID"
gnome-extensions install --force "$TMP/$UUID.shell-extension.zip"

# --- install the CLI ---------------------------------------------------------
mkdir -p "$HOME/.local/bin"
install -m 755 "$HERE/bin/oneko-wayland-legacy" "$HOME/.local/bin/oneko-wayland-legacy"
say "installed CLI to ~/.local/bin/oneko-wayland-legacy"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn '~/.local/bin is not on your PATH; add it to use `oneko-wayland-legacy`.' ;;
esac

# --- settings that silently block user extensions ---------------------------
if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = "true" ]; then
    gsettings set org.gnome.shell disable-user-extensions false
    say "turned the global user-extensions switch back on (it was off, which"
    say "silently disables every user-installed extension)"
fi
if [ "$(gsettings get org.gnome.shell allow-extension-installation 2>/dev/null || echo true)" = "false" ]; then
    warn "org.gnome.shell allow-extension-installation is false; GNOME will not"
    warn "even scan ~/.local/share/gnome-shell/extensions. Fix with:"
    warn "  gsettings set org.gnome.shell allow-extension-installation true"
fi

# --- enable ------------------------------------------------------------------
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
else
    # The running shell only scans for extensions at login, so register the
    # UUID directly in dconf; it takes effect at the next login.
    python3 - <<'PY'
from gi.repository import Gio
s = Gio.Settings.new("org.gnome.shell")
enabled = s.get_strv("enabled-extensions")
uuid = "oneko-wayland-legacy@disco-chef"
if uuid not in enabled:
    s.set_strv("enabled-extensions", enabled + [uuid])
Gio.Settings.sync()
PY
fi

# --- done --------------------------------------------------------------------
echo
if gdbus call --session --dest org.oneko.WaylandLegacy \
        --object-path /org/oneko/WaylandLegacy \
        --method org.oneko.WaylandLegacy.ListCats >/dev/null 2>&1; then
    echo "Done. A version of the extension is already running, so you can add"
    echo "a cat right now:"
    echo "  oneko-wayland-legacy add Pickles --body orange --outline brown"
    echo
    echo "But if you just UPDATED oneko-wayland, log out and back in first: a"
    echo "Wayland session keeps running the old code until you do."
else
    echo "Done. Log out and back in once (a running Wayland session cannot load"
    echo "a brand-new extension in place), then add a cat:"
    echo "  oneko-wayland-legacy add Pickles --body orange --outline brown"
fi
