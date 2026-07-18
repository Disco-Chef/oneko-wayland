import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {buildRunTable} from './sprites.js';

// Constants lifted from oneko.h so the personality matches the original.
const STOP_TIME = 4;
const JARE_TIME = 10;
const KAKI_TIME = 4;
const AKUBI_TIME = 6;
const AWAKE_TIME = 3;
const TOGI_TIME = 10;

const State = {
    STOP: 'stop',
    JARE: 'jare',       // washing its face
    KAKI: 'kaki',       // scratching itself
    AKUBI: 'akubi',     // yawning
    SLEEP: 'sleep',
    AWAKE: 'awake',
    MOVE: 'move',
    TOGI: 'togi',       // clawing at the window border
};

// Octant order for atan2(-dy, dx) starting at "east", counter-clockwise.
const DIR_FRAMES = ['right', 'upright', 'up', 'upleft', 'left', 'dwleft', 'down', 'dwright'];

function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

export class Cat {
    constructor(config, frames, parent, siblings = () => []) {
        this.config = config;
        this._siblings = siblings;
        this._mode = config.mode;
        this._speed = config.speed;
        this._offset = config.offset;
        this._offsetY = config.offsetY;
        this._fg = hexToRgb(config.fg);
        this._bg = hexToRgb(config.bg);
        // Two sprite flavors: recolorable two-tone XBM frames (bits + mask),
        // or pre-colored web-neko sheet frames (see sprites.js loadSheet).
        this._colored = Boolean(frames.mati2.runs);
        this._runs = this._colored ? frames : buildRunTable(frames);
        this._spriteSize = frames.mati2.w;

        const themeScale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._size = Math.round(this._spriteSize * config.scale * themeScale);
        // wake: how far the target must be before a resting cat gets up;
        // catch: how close counts as arrived. Both oneko's IDLE_SPACE=6 by
        // default; configurable à la glreno/oneko's triggerDistance.
        this._wake = config.wake * config.scale * themeScale;
        this._catch = config.catch * config.scale * themeScale;

        const [px, py] = global.get_pointer();
        this._x = px;
        this._y = py;
        this._state = State.STOP;
        this._stateCount = 0;
        this._tickCount = 0;
        this._dir = 'down';
        this._togiDir = 'ltogi';
        this._frame = 'mati2';

        this._actor = new St.DrawingArea({
            reactive: false,
            width: this._size,
            height: this._size,
        });
        this._destroyed = false;
        this._actor.connect('repaint', area => this._repaint(area));
        // If the actor is disposed out from under us (e.g. the shell tearing
        // down on logout/kill), stop ticking before a queued timer can touch
        // the dead C object.
        this._actor.connect('destroy', () => this.destroy());
        parent.add_child(this._actor);
        this._actor.set_position(Math.round(this._x), Math.round(this._y));

        // Name tag shown while the pointer is over the cat. The cat itself
        // stays non-reactive (it must not steal clicks from the window under
        // it), so hovering is detected in _tick() from the pointer we already
        // poll, not through Clutter events.
        this._label = new St.Label({
            text: config.name,
            reactive: false,
            style: `background-color: ${config.bg}; color: ${config.fg};` +
                'border-radius: 6px; padding: 1px 6px;' +
                'font-size: 11px; font-weight: bold;',
        });
        this._label.hide();
        parent.add_child(this._label);

        this._tickMs = Math.max(20, Math.round(config.time));
        this._timer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._tickMs, () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        const actor = this._actor;
        this._actor = null;
        actor?.destroy();
        this._label?.destroy();
        this._label = null;
    }

    _repaint(area) {
        const cr = area.get_context();
        const s = this._size / this._spriteSize;
        const runs = this._runs[this._frame];
        if (this._colored) {
            for (const [x, y, len, r, g, b, a] of runs.runs) {
                cr.setSourceRGBA(r / 255, g / 255, b / 255, a / 255);
                cr.rectangle(x * s, y * s, len * s, s);
                cr.fill();
            }
        } else {
            for (const [color, list] of [[this._bg, runs.bg], [this._fg, runs.fg]]) {
                cr.setSourceRGB(color[0], color[1], color[2]);
                for (const [x, y, len] of list)
                    cr.rectangle(x * s, y * s, len * s, s);
                cr.fill();
            }
        }
        cr.$dispose();
    }

    // The focused window, if it's one a cat can perch on.
    _focusWindow() {
        const win = global.display.focus_window;
        if (win && !win.minimized &&
            win.get_window_type() !== Meta.WindowType.DESKTOP &&
            win.get_window_type() !== Meta.WindowType.DOCK)
            return win;
        return null;
    }

    // Where the cat wants to be, and whether the pointer is beyond a window
    // border ('left'/'right') so it should claw at it once it gets there.
    _target() {
        const [px, py] = global.get_pointer();
        const size = this._size;
        const mx = px + this._offset;

        if (this._mode === 'focus') {
            const win = this._focusWindow();
            if (win) {
                // oneko -tofocus: sit on the top border; x chases the pointer
                // but never crosses the window's left/right corners.
                const r = win.get_frame_rect();
                let tx, edge = null;
                if (mx < r.x + size / 2) {
                    tx = r.x + this._offset;
                    if (px < r.x)
                        edge = 'left';
                } else if (mx > r.x + r.width - size / 2) {
                    tx = r.x + r.width - size + this._offset;
                    if (px > r.x + r.width)
                        edge = 'right';
                } else {
                    tx = mx - size / 2;
                }
                return {x: tx, y: Math.max(0, r.y - size + this._offsetY), edge, px, py};
            }
        }
        // mouse mode, or no usable focus window: classic pointer chasing.
        const stage = global.stage;
        const tx = Math.min(Math.max(mx - size / 2, 0), stage.width - size);
        const ty = Math.min(Math.max(py - size + this._offsetY, 0), stage.height - size);
        return {x: tx, y: ty, edge: null, px, py};
    }

    _setState(state) {
        this._state = state;
        this._stateCount = 0;
    }

    _stepTowards(dx, dy, distance) {
        let moveX = dx, moveY = dy;
        if (distance > this._speed) {
            moveX = this._speed * dx / distance;
            moveY = this._speed * dy / distance;
        }
        this._x += moveX;
        this._y += moveY;
        const octant = Math.round(Math.atan2(-moveY, moveX) * 4 / Math.PI);
        this._dir = DIR_FRAMES[(octant + 8) % 8];
        this._actor.set_position(Math.round(this._x), Math.round(this._y));
    }

    // The original oneko brain: chase the target, rest when it's caught.
    _tickChase(target) {
        const dx = target.x - this._x;
        const dy = target.y - this._y;
        const distance = Math.hypot(dx, dy);
        const wantsMove = distance > this._wake;

        switch (this._state) {
        case State.STOP:
            if (wantsMove) {
                this._setState(State.AWAKE);
            } else if (this._stateCount >= STOP_TIME) {
                if (target.edge) {
                    this._togiDir = target.edge === 'left' ? 'ltogi' : 'rtogi';
                    this._setState(State.TOGI);
                } else {
                    this._setState(State.JARE);
                }
            }
            break;
        case State.JARE:
            if (wantsMove)
                this._setState(State.AWAKE);
            else if (this._stateCount >= JARE_TIME)
                this._setState(State.KAKI);
            break;
        case State.KAKI:
            if (wantsMove)
                this._setState(State.AWAKE);
            else if (this._stateCount >= KAKI_TIME)
                this._setState(State.AKUBI);
            break;
        case State.AKUBI:
            if (wantsMove)
                this._setState(State.AWAKE);
            else if (this._stateCount >= AKUBI_TIME)
                this._setState(State.SLEEP);
            break;
        case State.SLEEP:
            if (wantsMove)
                this._setState(State.AWAKE);
            break;
        case State.TOGI:
            if (wantsMove)
                this._setState(State.AWAKE);
            else if (this._stateCount >= TOGI_TIME)
                this._setState(State.KAKI);
            break;
        case State.AWAKE:
            if (this._stateCount >= AWAKE_TIME)
                this._setState(State.MOVE);
            break;
        case State.MOVE: {
            if (distance <= this._catch) {
                this._setState(State.STOP);
                break;
            }
            this._stepTowards(dx, dy, distance);
            break;
        }
        }
    }

    _tick() {
        this._tickCount = (this._tickCount + 1) % 9999;
        if (this._tickCount % 2 === 0)
            this._stateCount++;

        const target = this._target();
        this._tickChase(target);

        const frame = this._currentFrame();
        if (frame !== this._frame) {
            this._frame = frame;
            this._actor.queue_repaint();
        }

        this._updateLabel(target.px, target.py);
    }

    _updateLabel(px, py) {
        const hovered = px >= this._x && px < this._x + this._size &&
                        py >= this._y && py < this._y + this._size;
        if (!hovered) {
            this._label.hide();
            return;
        }
        const [lw, lh] = [this._label.width, this._label.height];
        const lx = Math.min(Math.max(Math.round(this._x + this._size / 2 - lw / 2), 0),
            global.stage.width - lw);
        let ly = Math.round(this._y - lh - 4);
        if (ly < 0)  // riding a maximized window: no room above, tag below
            ly = Math.round(this._y + this._size + 4);
        this._label.set_position(lx, ly);
        this._label.show();
    }

    _currentFrame() {
        const alt = this._tickCount % 2 ? '2' : '1';
        switch (this._state) {
        case State.STOP:
            return 'mati2';
        case State.JARE:
            return this._tickCount % 2 ? 'jare2' : 'mati2';
        case State.KAKI:
            return `kaki${alt}`;
        case State.AKUBI:
            return 'mati3';
        case State.SLEEP:
            return Math.floor(this._tickCount / 4) % 2 ? 'sleep2' : 'sleep1';
        case State.AWAKE:
            return 'awake';
        case State.TOGI:
            return `${this._togiDir}${alt}`;
        case State.MOVE:
            return `${this._dir}${alt}`;
        default:
            return 'mati2';
        }
    }
}
