# oneko-wayland legacy

The classic [oneko](https://en.wikipedia.org/wiki/Neko_(software)) desktop
cats, reborn for GNOME on Wayland.

With Wayland becoming so prevalent, an updated machine meant that my old oneko
aliases could not work anymore. This brought me great sadness. This is a big
virtual hug to oneko for all the joy it brought me, the longing I felt while
I couldn't use it, and the determination it gave me to just make a working
wayland version.

Anyway, on X11, oneko worked by drawing an override-redirect window and asking the X
server where the pointer and every window were. Wayland deliberately forbids
all of that: a client can't know the global pointer position, can't know where
other windows are, and can't position itself. The only place that knowledge
still exists is inside the compositor, so this project is a **GNOME Shell
extension** (the cats are drawn by Mutter itself), plus a small
**`oneko-wayland-legacy` CLI** that talks to it over D-Bus.

The signature behavior is faithfully ported from oneko's `-tofocus` mode: each
cat rides the **top edge of the focused window**, chasing your pointer left
and right but never crossing the window's left or right corners, and never
wandering up or down. When the pointer leaves the window sideways, the cat
sits at the corner and claws at the border (the original *togi* animation).
The full state machine is ported (wash, scratch, yawn, sleep) with the
original timing constants from `oneko.h`.

## Compatibility

This is a **GNOME Shell extension**, so it works on any distro whose desktop
is GNOME (Ubuntu, Fedora Workstation, Arch with GNOME installed, etc.) on
Wayland (X11 GNOME too, though there you could still run classic oneko).

It does **not** work on other Wayland desktops: KDE Plasma, Hyprland (and
therefore Omarchy), sway, etc. "Wayland" is only a protocol: it deliberately
gives apps no way to see the pointer, other windows' positions, or to place
themselves, so the cats must live *inside* the compositor. This code lives
inside GNOME's compositor (Mutter); each other compositor would need its own
port (a Hyprland one would be a layer-shell client driven by `hyprctl`, a
totally different codebase).

## Install

Requirements: GNOME Shell 50 (e.g. Ubuntu 26.04) on Wayland, `python3` with
PyGObject (`python3-gi` on Debian/Ubuntu, `python-gobject` on Arch,
preinstalled on every GNOME distro), `make`.

```sh
git clone -b legacy https://github.com/Disco-Chef/oneko-wayland oneko-wayland-legacy
cd oneko-wayland-legacy
./install.sh
```

Then **log out and back in once** (a Wayland session can't load a brand-new
extension in place; updates to an already-installed one also need a relogin).
Check it's alive:

```sh
gnome-extensions info oneko-wayland-legacy@disco-chef
oneko-wayland-legacy add Pickles --body orange --outline brown
```

The installer also fixes the most common silent failure. GNOME has a master
setting, `org.gnome.shell disable-user-extensions`; when it is set to `true`
(its value on some fresh installs) every user-installed extension is disabled
at once, so nothing in `~/.local/share/gnome-shell/extensions` loads and no
error appears anywhere. The installer sets it back to `false`.
`make uninstall` removes everything.

## Usage

```sh
oneko-wayland-legacy add NAME [options]     # spawn (or replace) a cat
oneko-wayland-legacy remove NAME | --all    # send cats home
oneko-wayland-legacy list
```

| Option | Meaning | Default |
| --- | --- | --- |
| `-a, --animal` | `neko`, `tora` (tiger-striped), `dog`, `sakura`, `tomoyo` | `neko` |
| `--body` | body/fill color (CSS name or `#rrggbb`) | `white` |
| `--outline` | outline & details color | `black` |
| `-s, --speed` | pixels covered per animation step | `13` |
| `--fps` | animation steps per second | `8` |
| `-o, --offset-x` | shift the cat's spot right(+)/left(−), in px | `0` |
| `--offset-y` | shift the cat's spot down(+)/up(−), in px | `0` |
| `--wake-distance` | how far (px) the target must be before a resting cat gets up (try `64` for a lazy cat) | `6` |
| `--catch-distance` | how close (px) counts as having caught the target | `6` |
| `-m, --mode` | `focus` = ride the focused window (old `-tofocus`), `mouse` = free pointer chasing | `focus` |
| `--scale` | sprite scale factor (try `2` on big screens) | `1` |

Old-timer aliases keep working: `--variant`, `--fg`, `--bg`, `--offset`, and
`-t/--time` (step interval in ms; values ≥ 5000 are read as oneko-style µs).

Cats **persist across logins** until you `remove` them, so no terminal needs to
stay open, so no more sacrificial gnome-terminal tabs.

**Hover over a cat** to see its name tag (drawn in the cat's own colors).
The cats never intercept your clicks; hovering is watched from the same
pointer polling that drives the chase.

## Sprites

### The built-in five

The repo ships the original public-domain oneko sprite sets, selected with
`--animal`: **neko** (the classic white cat), **tora** (tiger-striped),
**dog**, **sakura** and **tomoyo** (the two Cardcaptor Sakura characters from
the "sakura" fork this code descends from). These are 1-bit bitmaps, which is
what makes `--body`/`--outline` recoloring possible: one sprite set, any
color cat:

```sh
oneko-wayland-legacy add Pickles --body orange --outline brown   # orange cat
oneko-wayland-legacy add Rex --animal dog --body '#c0f0ff'       # pastel blue dog
oneko-wayland-legacy add Stripes --animal tora --scale 2         # big tiger
```

### Custom sprite sheets (`--sheet`)

`--sheet` accepts the "web neko" sprite sheets used by the JavaScript neko
ports: a single PNG with an 8×4 grid of frames. Find them at:

- **[The Neko Archive](https://bomvel.neocities.org/neko/)**: the biggest
  collection: aliens, robot cats, ghosts, Metroids, chocobos, dressed-up
  cats... Click a skin to get its sheet PNG.
- **[webneko.net](https://webneko.net/)**: the classic Web Neko server many
  of those skins originate from.
- For the historically curious: [Suzanne Morine's Neko kitty collection](https://web.archive.org/web/20220220223719/http://users.frii.com/suzannem/neko/directory/index.html)
  (archived) is the 2001-era catalog of the original Windows-Neko libraries
  that many of these skins descend from.

```sh
oneko-wayland-legacy add Zim --sheet ~/Downloads/alien.png --mode mouse
oneko-wayland-legacy add Chapeau --sheet ~/Downloads/fancy.png   # the top-hat cat
```

Things worth knowing about sheets:

- **Both grid dialects are auto-detected**: the webneko/Archive format
  (263×164, 32px cells with 1px separators and footprint art at the bottom)
  and the [oneko.js](https://github.com/adryd325/oneko.js) format (flush
  256×128). Scaled-up multiples of the flush format work too.
- **Chroma-key transparency is handled**: many sheets use a solid turquoise
  background instead of alpha; the top-left pixel is taken as the background
  color when it's opaque.
- **Missing frames degrade gracefully.** Many skins don't draw every frame
  (the alien has no face-wash or wall-scratch cells). The cat substitutes the
  nearest equivalent (e.g. self-scratch instead of border-clawing) rather
  than turning invisible. If a sheet has no idle frame at all, you get a
  clear error instead of an invisible pet.
- **Sheets keep their own colors**, so `--body`/`--outline` then only tint the
  hover name tag.
- The sheet path is stored with the cat, so it must stay where it was when
  you added the cat (keep them somewhere stable like `~/Downloads/neko-sheets/`).
  If a sheet file disappears, that cat is skipped at next login and the rest
  survive.
- **Licensing**: the built-in sprites are public domain; web skins are fan
  art by individual pixel artists, mostly unsigned and without stated
  licenses. That's why none are bundled here; download the ones you like
  for your own desktop and credit the artist named on the hosting page when
  you can. Don't redistribute them (e.g. don't commit them to a public
  fork).

## The old aliases, reborn

The slightly different `--time` values (µs, like classic oneko) are
deliberate: they desync the three cats so they don't animate in lockstep.

```zsh
alias catswindow='oneko-wayland-legacy add MrPickles --body orange --outline brown --speed 14 --offset-x=35  --time 100000 --mode focus &&
                  oneko-wayland-legacy add Adonis    --body grey   --outline black --speed 16 --offset-x=-35 --time 100500 --mode focus &&
                  oneko-wayland-legacy add Sultana   --body white  --outline red   --speed 15 --offset-x=0   --time 100250 --mode focus'

alias catsmouse='oneko-wayland-legacy add MrPickles --body orange --outline brown --speed 14 --offset-x=35  --time 100000 --mode mouse &&
                 oneko-wayland-legacy add Adonis    --body grey   --outline black --speed 16 --offset-x=-35 --time 100500 --mode mouse &&
                 oneko-wayland-legacy add Sultana   --body white  --outline red   --speed 15 --offset-x=0   --time 100250 --mode mouse'

alias catsgohome='oneko-wayland-legacy remove --all'
```

Running `catsmouse` after `catswindow` just switches the same three cats'
mode, since `add` replaces a cat with the same name.

## Performance

Each cat is a 32×32 area redrawn at most `--fps` times a second (8 by
default), so the cost is small and scales linearly with the number of cats and
the frame rate. Measured against GNOME Shell's own CPU use (`/proc/PID/stat`,
headless 1280×720), as a share of **one** core:

| cats | idle (sitting) | all running at once (worst case) |
| ---- | -------------- | -------------------------------- |
| 1    | ~0.5%          | ~2%                              |
| 3    | ~1.5%          | ~5%                              |
| 6    | ~3%            | ~9%                              |

Marginally that's roughly **0.5%/cat idle** and **~1.5%/cat while running**
(the running figure is a pessimistic ceiling: it forces every cat to move and
repaint on every tick; normally a cat only moves when the pointer does, and
only the cats on the focused window react). On an 8-core machine even six cats
tearing around at once is about 1% of total CPU. Raising `--fps` raises the
cost proportionally; lowering it (e.g. `--fps 4`) halves it.

## Troubleshooting

- **`oneko-wayland-legacy: the extension is not running`**: you haven't logged out
  since installing, or the extension isn't enabled. Check
  `gnome-extensions info oneko-wayland-legacy@disco-chef` (state should be ACTIVE
  after a relogin).
- **Extension never appears at all**: make sure
  `gsettings get org.gnome.shell disable-user-extensions` is `false` and
  `gsettings get org.gnome.shell allow-extension-installation` is `true`
  (the installer checks both).
- **Different GNOME version**: add your major version to `shell-version` in
  `extension/oneko-wayland-legacy@disco-chef/metadata.json` and re-run
  `./install.sh`. The APIs used are stable across recent GNOME releases, but
  only 50 is tested.

## Development

If, like me, you didn't know: a GNOME Shell extension isn't a background
process you can restart, it's JavaScript loaded *into* `gnome-shell` itself,
and on Wayland the shell only reads that code at login. So there's no live
reload. After any edit to the extension you `make install` (which repacks and
copies it into `~/.local/share/gnome-shell/extensions/`) and then **log out
and back in** for the new code to run; `gnome-extensions disable/enable` will
not pick up changed code. Your cats come back from the saved state file on the
next login. Only `sprites.json` regeneration is separate (`make sprites`), and
you only need it if you touch `assets/` or the converter.

The one way to skip the logout while iterating is `make devkit`, which opens a
GNOME Shell development-kit instance (a shell in a window on a private D-Bus);
run `./install.sh` first so it picks up your latest code. `make pack` builds a
distributable `dist/oneko-wayland-legacy@disco-chef.shell-extension.zip` that others
can install with `gnome-extensions install`. Sprites are the original oneko XBM bitmaps
(vendored in `assets/`, public domain, by Masayuki Koba / Tatsuya Kato);
`tools/xbm2json.py` converts them to the `sprites.json` the extension renders
with Cairo, recolored per cat.

## Layout

```
extension/oneko-wayland-legacy@disco-chef/   the GNOME Shell extension
  extension.js                        lifecycle, D-Bus service, persistence
  cat.js                              the cat: state machine + rendering
  sprites.js                          XBM run-length painter
  sprites.json                        generated from assets/ (make sprites)
bin/oneko-wayland-legacy                     CLI (D-Bus client)
assets/                               original oneko bitmaps + masks
tools/xbm2json.py                     sprite converter
```

## Credits

oneko-wayland stands on decades of other people's work:

- **oneko** itself, and the original cat and tiger (`tora`) sprites: Tatsuya
  Kato, built from Masayuki Koba's original X11 *xneko*.
- **Dog sprites**: John Lerchey (`jl4l+@andrew.cmu.edu`); the dog support and
  auto-raise code in the original: Eric Anderson (`eanders+@cmu.edu`).
- **The `sakura` and `tomoyo` sprites, and the `-tofocus` window-tracking mode
  this whole project is built around**: Kiichiroh Mukose, whose "sakura" fork
  of oneko is the version this descends from. The characters Sakura Kinomoto
  and Tomoyo Daidouji are from *Cardcaptor Sakura* (CLAMP / Kodansha).
- **Custom sprite sheets** (`--sheet`): the 8×4 sheet layout follows
  [oneko.js](https://github.com/adryd325/oneko.js) by adryd325; skins come
  from [The Neko Archive](https://bomvel.neocities.org/neko/) and
  [webneko.net](https://webneko.net/), drawn by many individual pixel artists
  (credit them per the page you get the skin from).

The original oneko sprites are public domain; see `LICENSE`. This project
(the extension, CLI, and tooling) is MIT.
