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

// Prowl mode personality. Wall-clock seconds (converted per cat by
// _drawTicks), so --time changes animation smoothness, not the schedule.
const WANDER_ENERGY_MIN = 20;   // waking allowance between naps
const WANDER_ENERGY_MAX = 40;
const NAP_MIN = 60;             // a nap is a commitment
const NAP_MAX = 180;
const PAUSE_MIN = 2;            // stroll pause between destinations
const PAUSE_MAX = 4;
const EARLY_NAP_CHANCE = 0.15;  // per-pause chance to nap ahead of schedule
const GROOM_CHANCE = 0.3;       // per-pause chance to groom instead of stroll
const POKE_SNOOZE = 3;          // ignore pokes this long after dozing back off
const DOZE_BACK_CHANCE = 0.35; // after a sulk or walk-off, odds of dozing back off
const CHASE_TIME = 5;           // how long a chase reaction lasts
const WAKE_RADIUS = 1.5;        // sprite widths; any closer is rude

// idleprowl: the pointer is the pulse. Movement past the deadzone is real
// activity (wakes a sleeper); a quiet spell sends an awake cat to sleep.
const IDLE_MIN = 2;             // per-cat quiet spell before settling
const IDLE_MAX = 6;
const POINTER_DEADZONE = 75;    // raw px; smaller nudges (anti screen-dim) are ignored
const SHORT_NAP_MIN = 3;        // a voluntary cat-nap while you're active
const SHORT_NAP_MAX = 12;
const SHORT_NAP_CHANCE = 0.15;  // per-pause chance of one

const State = {
    STOP: 'stop',
    JARE: 'jare',       // washing its face
    KAKI: 'kaki',       // scratching itself
    AKUBI: 'akubi',     // yawning
    SLEEP: 'sleep',
    AWAKE: 'awake',
    MOVE: 'move',
    TOGI: 'togi',       // clawing at the window border
    CHASE: 'chase',     // going after whoever dared wake it
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

        // Prowl-mode state (inert in the other modes).
        this._energy = 0;
        this._napTicks = 0;
        this._napPlanned = false;
        this._pauseTicks = 0;
        this._pokeCooldown = 0;
        this._afterAwake = null;
        this._chaseTarget = null;
        this._chaseTicks = 0;
        this._wanderX = null;
        this._pinned = null;
        this._moving = false;        // are we actually closing distance this tick
        this._dozeBackAfter = false; // poke reaction should end by dozing off again
        this._napStash = 0;          // nap ticks left when a poke pulled us up
        this._pointerAnchor = null;  // last pointer spot that counted as movement
        this._idleTicks = 0;         // ticks since that movement
        this._idleLimit = this._drawTicks(IDLE_MIN, IDLE_MAX);
        this._shortNap = false;  // idleprowl: this sleep is a self-timed cat-nap

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
        if (this._mode === 'prowl' || this._mode === 'idleprowl')
            this._energy = this._drawTicks(WANDER_ENERGY_MIN, WANDER_ENERGY_MAX);
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
        this._unpin();
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

    _drawTicks(minS, maxS) {
        return Math.round((minS + Math.random() * (maxS - minS)) * 1000 / this._tickMs);
    }

    // Where a prowl cat may roam: the focused window's top edge, or the
    // bottom of the screen (the floor) when there's nothing to perch on.
    _wanderRange() {
        const win = this._focusWindow();
        if (win) {
            const r = win.get_frame_rect();
            return [r.x, Math.max(r.x, r.x + r.width - this._size)];
        }
        return [0, Math.max(0, global.stage.width - this._size)];
    }

    _awayFrom(ox) {
        const [lo, hi] = this._wanderRange();
        const mid = (lo + hi) / 2;
        return ox >= mid
            ? lo + Math.random() * (mid - lo)
            : mid + Math.random() * (hi - mid);
    }

    // idleprowl: did the pointer move beyond the deadzone since we last
    // anchored? Maintains the anchor. A small in-place jiggle (keeping a short
    // screen-dim timeout at bay) stays inside the deadzone and reads as still.
    _pointerMoved(px, py) {
        if (this._pointerAnchor === null) {
            this._pointerAnchor = [px, py];
            return false;
        }
        const [ax, ay] = this._pointerAnchor;
        if (Math.hypot(px - ax, py - ay) > POINTER_DEADZONE) {
            this._pointerAnchor = [px, py];
            return true;
        }
        return false;
    }

    _unpin() {
        if (this._pinned) {
            this._pinned.win.disconnect(this._pinned.id);
            this._pinned = null;
        }
    }

    _fallAsleep(napTicks = null) {
        this._napTicks = napTicks ?? this._drawTicks(NAP_MIN, NAP_MAX);
        this._napPlanned = false;
        const win = this._focusWindow();
        if (win) {
            const r = win.get_frame_rect();
            this._pinned = {
                win,
                dx: Math.min(Math.max(this._x - r.x, 0),
                    Math.max(0, r.width - this._size)),
                // the perch is being demolished: wake up, no reaction roll
                id: win.connect('unmanaging', () => this._wakeUp()),
            };
        }
        this._setState(State.SLEEP);
    }

    // Tail of a sulk or walk-off: settle back into the nap we were pulled out
    // of, keeping whatever time was left. The cooldown stops the offender still
    // loitering nearby from instantly re-waking us.
    _dozeBack() {
        this._dozeBackAfter = false;
        this._pokeCooldown = this._drawTicks(POKE_SNOOZE, POKE_SNOOZE);
        this._fallAsleep(this._napStash > 0 ? this._napStash : null);
    }

    _wakeUp() {
        this._unpin();
        this._shortNap = false;
        this._napTicks = 0;
        this._energy = this._drawTicks(WANDER_ENERGY_MIN, WANDER_ENERGY_MAX);
        this._wanderX = null;
        this._afterAwake = null;
        this._chaseTarget = null;
        this._setState(State.AWAKE);
    }

    // Someone got too close to (or prodded) a sleeper. Your cursor always gets
    // a chase; another cat gets one of three reactions. Only sleepers are
    // grabbed. POKE_SNOOZE keeps a doze-off from becoming a wake-up loop.
    poke(offender, offenderX) {
        if (this._mode !== 'prowl' || this._state !== State.SLEEP ||
            this._pokeCooldown > 0)
            return;
        if (offender === 'pointer') {  // oh, it is ON, and it stays on if re-poked
            this._wakeUp();
            this._afterAwake = 'chase';
            this._chaseTarget = 'pointer';
            this._chaseTicks = this._drawTicks(CHASE_TIME, CHASE_TIME);
            return;
        }
        const remaining = this._napTicks;  // stash before _wakeUp zeroes it
        switch (Math.floor(Math.random() * 3)) {
        case 0:  // startle, groom the indignity away, then maybe doze off again
            this._wakeUp();
            this._afterAwake = 'groom';
            this._napStash = remaining;
            this._dozeBackAfter = Math.random() < DOZE_BACK_CHANCE;
            break;
        case 1:  // get up and walk off the other way, then maybe doze off again
            this._wakeUp();
            this._afterAwake = 'move';
            this._wanderX = this._awayFrom(offenderX);
            this._napStash = remaining;
            this._dozeBackAfter = Math.random() < DOZE_BACK_CHANCE;
            break;
        case 2:  // give chase
            this._wakeUp();
            this._afterAwake = 'chase';
            this._chaseTarget = offender;
            this._chaseTicks = this._drawTicks(CHASE_TIME, CHASE_TIME);
            break;
        }
    }

    // A pause just ended: nap if due (or unlucky), groom, or stroll on.
    _nextIdleAction() {
        if (this._mode === 'idleprowl') {
            // no energy budget here; the odd short self-nap is the only
            // voluntary sleep, and it winds down like any other nap.
            if (Math.random() < SHORT_NAP_CHANCE) {
                this._shortNap = true;
                this._napPlanned = true;
                this._setState(State.JARE);
            } else if (Math.random() < GROOM_CHANCE) {
                this._napPlanned = false;
                this._setState(State.JARE);
            } else {
                this._wanderX = null;
                this._setState(State.MOVE);
            }
            return;
        }
        if (this._energy <= 0 || Math.random() < EARLY_NAP_CHANCE) {
            this._napPlanned = true;
            this._setState(State.JARE);
        } else if (Math.random() < GROOM_CHANCE) {
            this._napPlanned = false;
            this._setState(State.JARE);
        } else {
            this._wanderX = null;
            this._setState(State.MOVE);
        }
    }

    // Where the cat wants to be, and whether the pointer is beyond a window
    // border ('left'/'right') so it should claw at it once it gets there.
    _target() {
        if (this._mode === 'prowl' || this._mode === 'idleprowl')
            return this._prowlTarget();
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

    // Prowl cats ignore the pointer: the target is wherever the cat has
    // decided to go. px/py still flow through for the hover label.
    _prowlTarget() {
        const [px, py] = global.get_pointer();
        const size = this._size;

        if (this._state === State.SLEEP) {
            if (this._pinned) {
                const r = this._pinned.win.get_frame_rect();
                return {x: r.x + this._pinned.dx,
                    y: Math.max(0, r.y - size + this._offsetY), px, py};
            }
            return {x: this._x, y: this._y, px, py};  // asleep on the floor
        }
        if (this._state === State.CHASE) {
            const t = this._chaseTarget;
            return t === 'pointer'
                ? {x: px - size / 2, y: py - size / 2, px, py}
                : {x: t._x, y: t._y, px, py};
        }
        const [lo, hi] = this._wanderRange();
        if (this._wanderX === null || this._wanderX < lo || this._wanderX > hi)
            this._wanderX = lo + Math.random() * (hi - lo);
        const win = this._focusWindow();
        const y = win
            ? Math.max(0, win.get_frame_rect().y - size + this._offsetY)
            : global.stage.height - size + this._offsetY;
        return {x: this._wanderX, y, px, py};
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

    // The prowl brain: self-directed strolls, long naps, strong opinions
    // about being woken. The pointer is scenery (mostly; see poke()).
    _tickProwl(target) {
        if (this._mode === 'idleprowl') {
            const active = this._pointerMoved(target.px, target.py);
            if (active) {
                this._idleTicks = 0;
                this._idleLimit = this._drawTicks(IDLE_MIN, IDLE_MAX);
                if (this._state === State.SLEEP && !this._shortNap) {
                    this._wakeUp();  // an idle-sleep wakes on movement; a cat-nap runs its timer
                    return;  // stir this tick, rejoin the wander next tick
                }
            } else {
                this._idleTicks++;
                // been quiet long enough: plop where we are and wind down
                const settling = this._state === State.JARE ||
                    this._state === State.KAKI || this._state === State.AKUBI;
                if (this._state !== State.SLEEP && this._state !== State.AWAKE &&
                    !settling && this._idleTicks >= this._idleLimit) {
                    this._napPlanned = true;
                    this._setState(State.JARE);
                }
            }
        } else if (this._state !== State.SLEEP && this._energy > 0) {
            this._energy--;  // prowl only: internal awake budget
        }
        if (this._pokeCooldown > 0)
            this._pokeCooldown--;

        const dx = target.x - this._x;
        const dy = target.y - this._y;
        const distance = Math.hypot(dx, dy);

        switch (this._state) {
        case State.STOP:
            if (this._pauseTicks-- <= 0)
                this._nextIdleAction();
            break;
        case State.JARE:
            if (this._stateCount >= JARE_TIME)
                this._setState(State.KAKI);
            break;
        case State.KAKI:
            if (this._stateCount >= KAKI_TIME) {
                if (this._napPlanned) {
                    this._setState(State.AKUBI);
                } else if (this._dozeBackAfter) {
                    this._dozeBack();
                } else {
                    this._wanderX = null;
                    this._setState(State.MOVE);
                }
            }
            break;
        case State.AKUBI:
            if (this._stateCount >= AKUBI_TIME)
                this._fallAsleep(this._shortNap
                    ? this._drawTicks(SHORT_NAP_MIN, SHORT_NAP_MAX)
                    : null);
            break;
        case State.SLEEP:
            this._napTicks--;
            if (this._pinned?.win.minimized) {
                this._wakeUp();
                break;
            }
            if (target.px >= this._x && target.px < this._x + this._size &&
                target.py >= this._y && target.py < this._y + this._size) {
                this.poke('pointer', target.px);
                break;
            }
            if (this._mode === 'idleprowl') {
                if (this._shortNap && this._napTicks <= 0) {
                    if (this._idleTicks < this._idleLimit) {
                        this._shortNap = false;
                        this._wakeUp();  // you're still about: up and at it
                        break;
                    }
                    this._shortNap = false;  // you've gone quiet: this is now an idle-sleep
                }
                // idle-sleep: no timer, wait for the pointer (handled at tick top)
            } else if (this._napTicks <= 0) {
                this._wakeUp();  // prowl: nap timer expired
                break;
            }
            // ride along if the pinned window was dragged
            if (Math.round(this._x) !== Math.round(target.x) ||
                Math.round(this._y) !== Math.round(target.y)) {
                this._x = target.x;
                this._y = target.y;
                this._actor.set_position(Math.round(this._x), Math.round(this._y));
            }
            break;
        case State.AWAKE:
            if (this._stateCount >= AWAKE_TIME) {
                const next = this._afterAwake ?? 'move';
                this._afterAwake = null;
                if (next === 'groom') {
                    this._napPlanned = false;
                    this._setState(State.JARE);
                } else if (next === 'sleep') {
                    this._setState(State.SLEEP);
                } else if (next === 'chase') {
                    this._setState(State.CHASE);
                } else {
                    this._setState(State.MOVE);
                }
            }
            break;
        case State.MOVE:
        case State.CHASE:
            if (this._state === State.CHASE) {
                // re-poking (the cursor back over the cat) keeps a pointer chase alive
                if (this._chaseTarget === 'pointer' &&
                    target.px >= this._x && target.px < this._x + this._size &&
                    target.py >= this._y && target.py < this._y + this._size)
                    this._chaseTicks = this._drawTicks(CHASE_TIME, CHASE_TIME);
                this._chaseTicks--;
                if (this._chaseTicks <= 0) {
                    this._moving = false;
                    this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                    this._chaseTarget = null;
                    this._setState(State.STOP);
                    break;
                }
            }
            if (distance > this._catch) {
                this._moving = true;
                this._stepTowards(dx, dy, distance);
                for (const cat of this._siblings()) {
                    if (cat !== this && cat._state === State.SLEEP &&
                        Math.hypot(cat._x - this._x, cat._y - this._y) <
                            WAKE_RADIUS * this._size)
                        cat.poke(this, this._x);
                }
            } else {
                this._moving = false;  // arrived / caught: stand, don't paddle
                if (this._state === State.MOVE) {
                    if (this._dozeBackAfter) {
                        this._dozeBack();
                        break;
                    }
                    this._wanderX = null;
                    this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                    this._setState(State.STOP);
                } else if (this._chaseTarget !== 'pointer') {
                    // caught a sibling: stop here, the two park together
                    this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                    this._chaseTarget = null;
                    this._setState(State.STOP);
                }
                // caught the pointer: hold a settled frame; the timer runs on
            }
            break;
        }
    }

    _tick() {
        this._tickCount = (this._tickCount + 1) % 9999;
        if (this._tickCount % 2 === 0)
            this._stateCount++;

        const target = this._target();
        if (this._mode === 'prowl' || this._mode === 'idleprowl')
            this._tickProwl(target);
        else
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
        case State.CHASE:
            // only the prowl brain stands still in MOVE (see _tickProwl)
            if (this._mode !== 'prowl' && this._mode !== 'idleprowl')
                return `${this._dir}${alt}`;
            return this._moving ? `${this._dir}${alt}` : 'mati2';
        default:
            return 'mati2';
        }
    }
}
