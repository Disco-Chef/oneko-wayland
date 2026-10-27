import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

let _sprites = null;

export function loadSprites(extensionPath) {
    if (!_sprites) {
        const path = GLib.build_filenamev([extensionPath, 'sprites.json']);
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            throw new Error(`cannot read ${path}`);
        _sprites = JSON.parse(new TextDecoder().decode(bytes));
    }
    return _sprites;
}

/**
 * Turn one frame's bit rows into horizontal paint runs, grouped by color:
 * within the mask shape, bits=1 is foreground ink, bits=0 background
 * (mirrors oneko's XCreatePixmapFromBitmapData + shape mask).
 * Returns {fg: [[x, y, len], ...], bg: [[x, y, len], ...]}.
 */
export function frameRuns(frame) {
    const runs = {fg: [], bg: []};
    for (let y = 0; y < frame.h; y++) {
        const mask = frame.mask[y];
        const bits = frame.bits[y];
        let x = 0;
        while (x < frame.w) {
            if (!((mask >> x) & 1)) {
                x++;
                continue;
            }
            const isFg = (bits >> x) & 1;
            let end = x + 1;
            while (end < frame.w && ((mask >> end) & 1) &&
                   (((bits >> end) & 1) === isFg))
                end++;
            runs[isFg ? 'fg' : 'bg'].push([x, y, end - x]);
            x = end;
        }
    }
    return runs;
}

export function buildRunTable(frames) {
    const table = {};
    for (const name in frames)
        table[name] = frameRuns(frames[name]);
    return table;
}

/*
 * Support for the "web neko" sprite sheets: a single image holding an 8×4
 * grid of frames. Compatible skins (aliens, robot cats, top-hat cats and
 * many more) can be found at:
 *   - The Neko Archive: https://bomvel.neocities.org/neko/  (sheets/*.png)
 *   - Web Neko:         https://webneko.net/
 * These skins are fan art by individual pixel artists; most are unsigned and
 * carry no license. Check the hosting page for the artist's name and credit
 * them when you can. We deliberately do not bundle any of them in this repo.
 *
 * Two grid arrangements exist. Keys are our oneko frame names; values are
 * [column, row] in the grid.
 *
 * 1. The webneko.net / Neko Archive layout (263×164: 32px cells with 1px
 *    separators, footprint art below the 4 sprite rows). Verified by
 *    fingerprinting the archive's neko.png against the original oneko
 *    bitmaps; every cell matches exactly.
 */
const WEBNEKO_CELLS = {
    mati2: [0, 0], jare2: [1, 0], kaki1: [2, 0], kaki2: [3, 0],
    mati3: [4, 0], sleep1: [5, 0], sleep2: [6, 0], awake: [7, 0],
    down1: [0, 1], down2: [1, 1], dwright1: [2, 1], dwright2: [3, 1],
    right1: [4, 1], right2: [5, 1], upright1: [6, 1], upright2: [7, 1],
    up1: [0, 2], up2: [1, 2], upleft1: [2, 2], upleft2: [3, 2],
    left1: [4, 2], left2: [5, 2], dwleft1: [6, 2], dwleft2: [7, 2],
    dtogi1: [0, 3], dtogi2: [1, 3], rtogi1: [2, 3], rtogi2: [3, 3],
    utogi1: [4, 3], utogi2: [5, 3], ltogi1: [6, 3], ltogi2: [7, 3],
};

/*
 * 2. The oneko.js layout (flush 256×128 grid, no separators), as defined by
 *    the spriteSets table in https://github.com/adryd325/oneko.js; it has
 *    no face-washing frame, so jare2 reuses idle.
 */
const ONEKOJS_CELLS = {
    mati2: [3, 3],                      // idle
    awake: [7, 3],                      // alert
    kaki1: [5, 0], kaki2: [6, 0],       // scratchSelf (3rd frame unused)
    utogi1: [0, 0], utogi2: [0, 1],     // scratchWallN
    dtogi1: [7, 1], dtogi2: [6, 2],     // scratchWallS
    rtogi1: [2, 2], rtogi2: [2, 3],     // scratchWallE
    ltogi1: [4, 0], ltogi2: [4, 1],     // scratchWallW
    mati3: [3, 2],                      // tired (yawn)
    sleep1: [2, 0], sleep2: [2, 1],
    up1: [1, 2], up2: [1, 3],
    upright1: [0, 2], upright2: [0, 3],
    right1: [3, 0], right2: [3, 1],
    dwright1: [5, 1], dwright2: [5, 2],
    down1: [6, 3], down2: [7, 2],
    dwleft1: [5, 3], dwleft2: [6, 1],
    left1: [4, 2], left2: [4, 3],
    upleft1: [1, 0], upleft2: [1, 1],
    jare2: [3, 3],
};

// Many skins leave some cells blank (the alien has no wash or wall-scratch
// frames, for instance). Substitute something sensible rather than blinking
// invisible.
const FRAME_FALLBACKS = {
    jare2: 'mati2', mati3: 'mati2', awake: 'mati2',
    kaki1: 'mati2', kaki2: 'kaki1',
    sleep1: 'mati2', sleep2: 'sleep1',
    ltogi1: 'kaki1', ltogi2: 'kaki2',
    rtogi1: 'kaki1', rtogi2: 'kaki2',
    utogi1: 'kaki1', utogi2: 'kaki2',
    dtogi1: 'kaki1', dtogi2: 'kaki2',
    up2: 'up1', down2: 'down1', left2: 'left1', right2: 'right1',
    upleft2: 'upleft1', upright2: 'upright1',
    dwleft2: 'dwleft1', dwright2: 'dwright1',
};

/**
 * Slice a web-neko sheet into per-frame colored runs:
 * {frameName: {w, h, runs: [[x, y, len, r, g, b, a], ...]}}.
 * Unlike the two-tone XBM sprites these keep their own colors, so the cat's
 * body/outline options only affect the hover name tag.
 */
export function loadSheet(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    // Two grid flavors exist in the wild:
    //  - oneko.js style: 8 columns flush together (256x128, stride == cell)
    //  - webneko/Neko Archive style: 1px separator between cells and extra
    //    footprint art below the 4 sprite rows (263x164, stride == cell + 1)
    let stride, cw, cells;
    if (width % 8 === 0) {
        stride = width / 8;
        cw = stride;
        cells = ONEKOJS_CELLS;
    } else if ((width + 1) % 8 === 0) {
        stride = (width + 1) / 8;
        cw = stride - 1;
        cells = WEBNEKO_CELLS;
    } else {
        throw new Error(`${path}: ${width}x${height} is not an 8x4 sprite grid`);
    }
    const ch = cw;
    if (height < 4 * stride - 1)
        throw new Error(`${path}: ${width}x${height} is too short for 4 sprite rows`);
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const hasAlpha = pixbuf.get_has_alpha();
    const pixels = pixbuf.get_pixels();

    const at = (px, py) => {
        const o = py * rowstride + px * channels;
        const a = hasAlpha ? pixels[o + 3] : 255;
        return [pixels[o], pixels[o + 1], pixels[o + 2], a];
    };

    // webneko-family sheets are chroma-keyed rather than alpha-transparent:
    // the background is a solid color (turquoise, historically), and the
    // top-left pixel of the sheet is always background.
    const key = at(0, 0);
    const keyed = key[3] >= 8;
    const isClear = (r, g, b, a) =>
        a < 8 || (keyed && r === key[0] && g === key[1] && b === key[2]);

    const frames = {};
    for (const [name, [cx, cy]] of Object.entries(cells)) {
        const runs = [];
        for (let y = 0; y < ch; y++) {
            let x = 0;
            while (x < cw) {
                const [r, g, b, a] = at(cx * stride + x, cy * stride + y);
                if (isClear(r, g, b, a)) {
                    x++;
                    continue;
                }
                let end = x + 1;
                while (end < cw) {
                    const [r2, g2, b2, a2] = at(cx * stride + end, cy * stride + y);
                    if (r2 !== r || g2 !== g || b2 !== b || a2 !== a)
                        break;
                    end++;
                }
                runs.push([x, y, end - x, r, g, b, a]);
                x = end;
            }
        }
        frames[name] = {w: cw, h: ch, runs};
    }
    for (const [name, fallback] of Object.entries(FRAME_FALLBACKS)) {
        if (!frames[name].runs.length && frames[fallback].runs.length)
            frames[name] = frames[fallback];
    }
    if (!frames.mati2.runs.length)
        throw new Error(`${path}: no usable idle frame; is this really a neko sprite sheet?`);
    return frames;
}
