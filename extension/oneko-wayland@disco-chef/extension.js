import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Cat} from './cat.js';
import {loadSheet, loadSprites} from './sprites.js';

const BUS_NAME = 'org.oneko.Wayland';
const OBJECT_PATH = '/org/oneko/Wayland';

const IFACE = `
<node>
  <interface name="org.oneko.Wayland">
    <method name="AddCat">
      <arg type="s" direction="in" name="config"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="RemoveCat">
      <arg type="s" direction="in" name="name"/>
      <arg type="b" direction="out" name="removed"/>
    </method>
    <method name="ListCats">
      <arg type="s" direction="out" name="cats"/>
    </method>
    <method name="Clear"/>
  </interface>
</node>`;

// A cat is an actor plus a timer polling the pointer every >=20ms; each is
// restored on every login. Cap how many can exist and how long a name tag can
// get, so a misbehaving (or hostile) session-bus caller can't exhaust the
// compositor or persist a runaway across logins.
const MAX_CATS = 6;
const MAX_NAME = 48;
// A --sheet file is parsed by GdkPixbuf *inside gnome-shell* and re-parsed at
// every login. Restrict it to a small PNG so we only ever exercise the PNG
// loader on a bounded input, not GdkPixbuf's full multi-format attack surface.
const MAX_SHEET_BYTES = 4 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Defaults match oneko's neko entry in AnimalDefaultsDataTable
// (speed 13 px/tick, interval 125000 µs).
const DEFAULTS = {
    variant: 'neko',
    fg: '#000000',
    bg: '#ffffff',
    speed: 13,
    time: 125,
    offset: 0,
    offsetY: 0,
    wake: 6,
    catch: 6,
    mode: 'focus',
    scale: 1,
    sheet: null,
};

export default class OnekoWaylandExtension extends Extension {
    enable() {
        this._sprites = loadSprites(this.path);
        this._cats = new Map();

        this._group = new Clutter.Actor();
        Main.layoutManager.uiGroup.add_child(this._group);

        // Cats make no sense floating over the Activities overview, and
        // hidden cats have no reason to keep ticking.
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._group.hide();
            for (const cat of this._cats.values())
                cat.pause();
        });
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            this._group.show();
            for (const cat of this._cats.values())
                cat.resume();
        });

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._busNameId = Gio.bus_own_name_on_connection(Gio.DBus.session,
            BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);

        this._restoreState();
    }

    disable() {
        if (this._busNameId) {
            Gio.bus_unown_name(this._busNameId);
            this._busNameId = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
        for (const cat of this._cats.values())
            cat.destroy();
        this._cats.clear();
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewShowingId = 0;
        }
        this._group?.destroy();
        this._group = null;
        this._sprites = null;
    }

    _validate(raw) {
        const config = {...DEFAULTS, ...raw};
        if (typeof config.name !== 'string' || !config.name.length)
            throw new Error('cat needs a non-empty "name"');
        if (config.name.length > MAX_NAME)
            throw new Error(`name too long (max ${MAX_NAME} characters)`);
        if (!(config.variant in this._sprites))
            throw new Error(`unknown variant "${config.variant}" (have: ${Object.keys(this._sprites).join(', ')})`);
        if (config.sheet) {
            if (typeof config.sheet !== 'string' || !GLib.path_is_absolute(config.sheet))
                throw new Error('sheet must be an absolute path to a PNG sprite sheet');
            if (!GLib.file_test(config.sheet, GLib.FileTest.EXISTS))
                throw new Error(`sprite sheet not found: ${config.sheet}`);
            this._checkSheet(config.sheet);
        }
        for (const key of ['fg', 'bg']) {
            if (!/^#[0-9a-fA-F]{6}$/.test(config[key]))
                throw new Error(`${key} must be #rrggbb, got "${config[key]}"`);
        }
        if (config.mode === 'catwalk')  // renamed to prowl; keep old saved state working
            config.mode = 'prowl';
        if (!['focus', 'mouse', 'prowl', 'idleprowl'].includes(config.mode))
            throw new Error('mode must be "focus", "mouse", "prowl" or "idleprowl"');
        config.speed = Math.max(1, Number(config.speed) || DEFAULTS.speed);
        config.time = Math.max(20, Number(config.time) || DEFAULTS.time);
        config.offset = Number(config.offset) || 0;
        config.offsetY = Number(config.offsetY) || 0;
        config.catch = Math.min(512, Math.max(1, Number(config.catch) || DEFAULTS.catch));
        // A wake distance below the catch distance would make the cat stop,
        // instantly "wake", stop again... jitter forever. Keep wake >= catch.
        config.wake = Math.min(4096, Math.max(config.catch, Number(config.wake) || DEFAULTS.wake));
        config.scale = Math.min(8, Math.max(0.5, Number(config.scale) || 1));
        return config;
    }

    // The sheet is opened by GdkPixbuf inside the compositor and reopened at
    // every login, so constrain it before it ever reaches the loader: reject
    // anything over MAX_SHEET_BYTES and anything that isn't a PNG (by magic,
    // not extension), which keeps us on the PNG loader rather than exposing
    // GdkPixbuf's whole set of format loaders to an attacker-influenced file.
    _checkSheet(path) {
        const file = Gio.File.new_for_path(path);
        const size = file.query_info('standard::size',
            Gio.FileQueryInfoFlags.NONE, null).get_size();
        if (size > MAX_SHEET_BYTES)
            throw new Error(`sprite sheet too large (max ${MAX_SHEET_BYTES >> 20} MiB)`);
        const stream = file.read(null);
        try {
            const header = stream.read_bytes(PNG_MAGIC.length, null).get_data();
            if (!header || header.length < PNG_MAGIC.length ||
                !PNG_MAGIC.every((b, i) => header[i] === b))
                throw new Error('sprite sheet must be a PNG file');
        } finally {
            stream.close(null);
        }
    }

    _spawn(config) {
        const frames = config.sheet
            ? loadSheet(config.sheet)
            : this._sprites[config.variant];
        this._cats.get(config.name)?.destroy();
        const cat = new Cat(config, frames, this._group, () => this._cats.values());
        if (Main.overview.visible)
            cat.pause();
        this._cats.set(config.name, cat);
    }

    AddCat(configJson) {
        try {
            const config = this._validate(JSON.parse(configJson));
            if (!this._cats.has(config.name) && this._cats.size >= MAX_CATS)
                throw new Error(`too many cats (max ${MAX_CATS}); remove some first`);
            this._spawn(config);
            this._saveState();
            return JSON.stringify({ok: true, cat: config});
        } catch (e) {
            return JSON.stringify({error: e.message});
        }
    }

    RemoveCat(name) {
        const cat = this._cats.get(name);
        if (!cat)
            return false;
        cat.destroy();
        this._cats.delete(name);
        this._saveState();
        return true;
    }

    ListCats() {
        return JSON.stringify([...this._cats.values()].map(c => c.config));
    }

    Clear() {
        for (const cat of this._cats.values())
            cat.destroy();
        this._cats.clear();
        this._saveState();
    }

    get _stateFile() {
        return GLib.build_filenamev([GLib.get_user_state_dir(), 'oneko-wayland-cats.json']);
    }

    _saveState() {
        // Indented so the state file is inspectable when debugging a cat
        // that fails to restore at login.
        const data = JSON.stringify([...this._cats.values()].map(c => c.config), null, 2);
        try {
            GLib.file_set_contents(this._stateFile, data);
        } catch (e) {
            console.warn(`oneko-wayland: could not save state: ${e.message}`);
        }
    }

    _restoreState() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._stateFile);
            if (!ok)
                return;
            for (const raw of JSON.parse(new TextDecoder().decode(bytes))) {
                if (this._cats.size >= MAX_CATS) {
                    console.warn(`oneko-wayland: reached ${MAX_CATS} cats; ignoring the rest of the saved state`);
                    break;
                }
                try {
                    this._spawn(this._validate(raw));
                } catch (e) {
                    // e.g. a --sheet file deleted since last login: skip this
                    // cat, keep the others.
                    console.warn(`oneko-wayland: not restoring "${raw?.name}": ${e.message}`);
                }
            }
        } catch (e) {
            if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
                console.warn(`oneko-wayland: could not restore cats: ${e.message}`);
        }
    }
}
