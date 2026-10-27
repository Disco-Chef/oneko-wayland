# Catwalk Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third cat mode, `catwalk`: cats stroll the focused window's titlebar on their own schedule, take long naps pinned to the window they fell asleep on, and wake each other (with one of four random reactions) when a wanderer gets too close.

**Architecture:** All behavior stays in `cat.js` as an extension of the existing oneko state machine (new CHASE state; STOP doubles as the stroll pause). `extension.js` passes each Cat an accessor to its siblings and allows the new mode string; `bin/oneko-wayland` adds it to `--mode` choices. No coordinator object, no new files.

**Tech Stack:** GJS (GNOME Shell 50 extension, ES modules, `gi://` imports), Python 3 + PyGObject CLI, GNU Make.

**Spec:** `docs/superpowers/specs/2026-07-18-catwalk-mode-design.md` — read it first.

## Global Constraints

- GNOME Shell 50 target; no new dependencies, no new files.
- All catwalk timings are named constants in `cat.js`; **no new CLI flags**.
- Constants are wall-clock seconds converted to ticks per cat (`--time` changes animation smoothness, not the schedule): WANDER_ENERGY 20–40 s, NAP 60–180 s, EARLY_NAP_CHANCE 0.15, WAKE_RADIUS 1.5 sprite widths, CHASE_TIME 5 s.
- `MAX_CATS = 6` unchanged.
- User-facing text (README, CLI help) uses American spelling.
- Commit messages: lowercase, informal (repo style), **no Co-Authored-By line** (repo owner's rule).

## Testing Story (read before Task 1)

There is no unit-test infrastructure: the extension is JavaScript loaded *into* gnome-shell, and its logic is inseparable from `global.stage`, `Meta`, and `St`. Verification per task is therefore:

1. **Syntax gate** after every JS edit: `node --input-type=module --check < <file>` (imports of `gi://` are syntactically fine; node just parses).
2. **Devkit smoke tests** where behavior is observable: `./install.sh` then run a nested shell on a private bus. The CLI inside that session talks to the *nested* shell's extension.
3. **IMPORTANT:** never test against the live desktop session. It runs the old code until the next relogin and would reject `--mode catwalk`.
4. **State-file caveat:** the nested shell shares `~/.local/state/oneko-wayland-cats.json` with the real session. Always end a devkit run with `oneko-wayland remove --all`, and after the final task remind the user to re-run their alias in the real session so their trio is re-saved.

Devkit smoke harness (used by several tasks; `sleep 8` gives the nested shell time to load):

```sh
cd /home/nikos/code/Disco-Chef/oneko-wayland && ./install.sh && \
dbus-run-session -- bash -c '
  gnome-shell --devkit &>/tmp/claude-devkit.log &
  sleep 8
  oneko-wayland add Naptunia --mode catwalk --body white --outline red
  oneko-wayland list
  oneko-wayland remove --all
  kill %1 2>/dev/null'
```

---

### Task 0: Housekeeping — commit the pre-existing hunk

`extension.js` has one uncommitted pre-existing hunk (pretty-printed state file, added by the repo owner). Feature commits must not swallow it. `.gitignore` and `tools/xbm2json.py` are also dirty; **leave those two alone entirely**.

**Files:**
- Commit only: `extension/oneko-wayland@disco-chef/extension.js`

- [ ] **Step 1: Confirm the hunk is only the state-file pretty-print**

Run: `git diff extension/oneko-wayland@disco-chef/extension.js`
Expected: a single hunk in `_saveState()` adding a comment and `null, 2` to `JSON.stringify`. If anything else shows up, stop and ask the user.

- [ ] **Step 2: Commit it on its own**

```bash
git add extension/oneko-wayland@disco-chef/extension.js
git commit -m "save state indented so it can be eyeballed"
```

---

### Task 1: Groundwork refactor in cat.js (no behavior change)

Extract helpers the catwalk code will share with the existing modes, and give Cat a siblings accessor. After this task the extension behaves exactly as before.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/cat.js`
- Modify: `extension/oneko-wayland@disco-chef/extension.js:163` (`_spawn`)

**Interfaces:**
- Produces: `Cat.constructor(config, frames, parent, siblings = () => [])`; `this._siblings` (function returning `Cat[]`); `this._tickMs` (number, ms per tick); `_focusWindow()` (returns `Meta.Window` or `null`); `_stepTowards(dx, dy, distance)` (moves the actor one step, updates `this._dir`); `_tickChase(target)` (the whole old mode switch).

- [ ] **Step 1: Add the siblings parameter and `_tickMs`**

In `cat.js`, change the constructor signature and the timer setup:

```js
export class Cat {
    constructor(config, frames, parent, siblings = () => []) {
        this.config = config;
        this._siblings = siblings;
        this._mode = config.mode;
```

and replace the timer creation (currently `Math.max(20, Math.round(config.time))` inline) with:

```js
        this._tickMs = Math.max(20, Math.round(config.time));
        this._timer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._tickMs, () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
```

- [ ] **Step 2: Extract `_focusWindow()`**

Add below `_repaint()`:

```js
    // The focused window, if it's one a cat can perch on.
    _focusWindow() {
        const win = global.display.focus_window;
        if (win && !win.minimized &&
            win.get_window_type() !== Meta.WindowType.DESKTOP &&
            win.get_window_type() !== Meta.WindowType.DOCK)
            return win;
        return null;
    }
```

and rewrite the start of `_target()`'s focus branch to use it:

```js
        if (this._mode === 'focus') {
            const win = this._focusWindow();
            if (win) {
```

(the inner body — frame rect, corner clamping, edge detection — stays exactly as it is).

- [ ] **Step 3: Extract `_stepTowards()` and `_tickChase()`**

Add below `_setState()`:

```js
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
```

Then move the entire `switch (this._state) {...}` block (with its `dx`/`dy`/`distance`/`wantsMove` preamble) out of `_tick()` into a new method `_tickChase(target)`, with the `State.MOVE` case now delegating:

```js
    // The original oneko brain: chase the target, rest when it's caught.
    _tickChase(target) {
        const dx = target.x - this._x;
        const dy = target.y - this._y;
        const distance = Math.hypot(dx, dy);
        const wantsMove = distance > this._wake;

        switch (this._state) {
        // ... all existing cases unchanged, except MOVE:
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
```

`_tick()` becomes:

```js
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
```

- [ ] **Step 4: Pass the accessor from the extension**

In `extension.js` `_spawn()`:

```js
        this._cats.set(config.name,
            new Cat(config, frames, this._group, () => [...this._cats.values()]));
```

- [ ] **Step 5: Syntax gate**

Run:
```sh
node --input-type=module --check < extension/oneko-wayland@disco-chef/cat.js
node --input-type=module --check < extension/oneko-wayland@disco-chef/extension.js
```
Expected: no output, exit 0, for both.

- [ ] **Step 6: Devkit smoke — existing modes unbroken**

Run the devkit harness from the Testing Story, but with `--mode focus` instead of `--mode catwalk` (catwalk doesn't exist yet). Expected: `Naptunia the neko is on the prowl (focus mode, ...)`, then a list line, then `all cats sent home`. Also `grep -i "oneko\|error" /tmp/claude-devkit.log` shows no oneko-wayland errors.

- [ ] **Step 7: Commit**

```bash
git add extension/oneko-wayland@disco-chef/cat.js extension/oneko-wayland@disco-chef/extension.js
git commit -m "cat.js groundwork: extract chase brain, meet the siblings"
```

---

### Task 2: Mode plumbing — extension validation and CLI

Let `catwalk` through the front door. Until Task 3 lands, a catwalk cat temporarily behaves like a mouse-mode cat (it falls into `_target()`'s pointer branch); that's a known, harmless intermediate state.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/extension.js:122-123` (`_validate`)
- Modify: `bin/oneko-wayland:265-267` (`--mode` argument)

**Interfaces:**
- Produces: `config.mode === 'catwalk'` reaches `Cat` untouched through D-Bus, save, and restore.

- [ ] **Step 1: Extension validation**

In `_validate()`:

```js
        if (!['focus', 'mouse', 'catwalk'].includes(config.mode))
            throw new Error('mode must be "focus", "mouse" or "catwalk"');
```

- [ ] **Step 2: CLI choices and help**

In `bin/oneko-wayland`:

```python
    add.add_argument("-m", "--mode", choices=["focus", "mouse", "catwalk"], default="focus",
                     help="focus: ride the focused window's top edge (like "
                          "-tofocus); mouse: free pointer chasing; catwalk: "
                          "stroll the focused window's top edge and nap on "
                          "your own schedule (default: focus)")
```

- [ ] **Step 3: Syntax gates**

Run:
```sh
node --input-type=module --check < extension/oneko-wayland@disco-chef/extension.js
python3 -m py_compile bin/oneko-wayland
bin/oneko-wayland add --help | grep catwalk
```
Expected: first two silent; the grep prints the choices line and the help text.

- [ ] **Step 4: Devkit smoke — catwalk accepted**

Run the devkit harness from the Testing Story as written (`--mode catwalk`). Expected: `Naptunia the neko is on the prowl (catwalk mode, ...)` and `mode=catwalk` in the list output.

- [ ] **Step 5: Commit**

```bash
git add extension/oneko-wayland@disco-chef/extension.js bin/oneko-wayland
git commit -m "let catwalk through the door (cli + validation)"
```

---

### Task 3: The catwalk brain — wander, pause, nap, pin

The core loop for a *lone* catwalk cat: stroll to random spots on the focused titlebar, pause, sometimes groom, nap on schedule or by chance, pin to the window while asleep, wake naturally. Sibling waking and reactions are Task 4.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/cat.js`

**Interfaces:**
- Consumes: `_focusWindow()`, `_stepTowards()`, `this._siblings`, `this._tickMs` from Task 1.
- Produces: `_tickCatwalk(target)`, `_catwalkTarget()`, `_wanderRange()`, `_drawTicks(minS, maxS)`, `_fallAsleep()`, `_wakeUp()`, `_unpin()`, `_nextIdleAction()`; fields `_energy`, `_napTicks`, `_napPlanned`, `_pauseTicks`, `_pokeCooldown`, `_afterAwake`, `_chaseTarget`, `_chaseTicks`, `_wanderX`, `_pinned`. Task 4 relies on all of these names exactly.

- [ ] **Step 1: Constants**

After `const TOGI_TIME = 10;`:

```js
// Catwalk mode personality. Wall-clock seconds (converted per cat by
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
const CHASE_TIME = 5;           // how long a chase reaction lasts
const WAKE_RADIUS = 1.5;        // sprite widths; any closer is rude
```

and add to the `State` enum:

```js
    CHASE: 'chase',     // going after whoever dared wake it
```

- [ ] **Step 2: Constructor fields**

After the `this._frame = 'mati2';` line:

```js
        // Catwalk-mode state (inert in the other modes).
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
```

and after `this._tickMs = ...` (needs `_tickMs`):

```js
        if (this._mode === 'catwalk')
            this._energy = this._drawTicks(WANDER_ENERGY_MIN, WANDER_ENERGY_MAX);
```

- [ ] **Step 3: Helpers**

Add below `_focusWindow()`:

```js
    _drawTicks(minS, maxS) {
        return Math.round((minS + Math.random() * (maxS - minS)) * 1000 / this._tickMs);
    }

    // Where a catwalk cat may roam: the focused window's top edge, or the
    // bottom of the screen (the floor) when there's nothing to perch on.
    _wanderRange() {
        const win = this._focusWindow();
        if (win) {
            const r = win.get_frame_rect();
            return [r.x, Math.max(r.x, r.x + r.width - this._size)];
        }
        return [0, Math.max(0, global.stage.width - this._size)];
    }

    _unpin() {
        if (this._pinned) {
            this._pinned.win.disconnect(this._pinned.id);
            this._pinned = null;
        }
    }

    _fallAsleep() {
        this._napTicks = this._drawTicks(NAP_MIN, NAP_MAX);
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

    _wakeUp() {
        this._unpin();
        this._napTicks = 0;
        this._energy = this._drawTicks(WANDER_ENERGY_MIN, WANDER_ENERGY_MAX);
        this._wanderX = null;
        this._afterAwake = null;
        this._setState(State.AWAKE);
    }

    // A pause just ended: nap if due (or unlucky), groom, or stroll on.
    _nextIdleAction() {
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
```

- [ ] **Step 4: The catwalk target**

Add below `_target()`:

```js
    // Catwalk cats ignore the pointer: the target is wherever the cat has
    // decided to go. px/py still flow through for the hover label.
    _catwalkTarget() {
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
```

and dispatch at the top of `_target()`:

```js
    _target() {
        if (this._mode === 'catwalk')
            return this._catwalkTarget();
        const [px, py] = global.get_pointer();
```

(note `--offset-x` is deliberately not applied in catwalk mode; `--offset-y` is, via the `y` computations above.)

- [ ] **Step 5: The catwalk tick**

Add below `_tickChase()` (the CHASE case is wired here but unreachable until Task 4 sets the state):

```js
    // The catwalk brain: self-directed strolls, long naps, strong opinions
    // about being woken. The pointer is scenery (mostly; see poke()).
    _tickCatwalk(target) {
        if (this._state !== State.SLEEP && this._energy > 0)
            this._energy--;
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
                } else {
                    this._wanderX = null;
                    this._setState(State.MOVE);
                }
            }
            break;
        case State.AKUBI:
            if (this._stateCount >= AKUBI_TIME)
                this._fallAsleep();
            break;
        case State.SLEEP:
            this._napTicks--;
            if (this._pinned?.win.minimized) {
                this._wakeUp();
                break;
            }
            if (this._napTicks <= 0) {
                this._wakeUp();
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
                this._chaseTicks--;
                if (this._chaseTicks <= 0) {
                    this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                    this._setState(State.STOP);
                    break;
                }
            }
            if (distance > this._catch)
                this._stepTowards(dx, dy, distance);
            else if (this._state === State.MOVE) {
                this._wanderX = null;
                this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                this._setState(State.STOP);
            }
            break;
        }
    }
```

Dispatch in `_tick()`:

```js
        const target = this._target();
        if (this._mode === 'catwalk')
            this._tickCatwalk(target);
        else
            this._tickChase(target);
```

- [ ] **Step 6: Frames and teardown**

In `_currentFrame()`, make CHASE share the run frames:

```js
        case State.MOVE:
        case State.CHASE:
            return `${this._dir}${alt}`;
```

In `destroy()`, before `const actor = this._actor;`:

```js
        this._unpin();
```

- [ ] **Step 7: Syntax gate**

Run: `node --input-type=module --check < extension/oneko-wayland@disco-chef/cat.js`
Expected: silent, exit 0.

- [ ] **Step 8: Devkit observation**

Run `./install.sh`, then `make devkit` (leave it up), and *in a second terminal, on the devkit's bus* — easiest is to run the whole thing scripted as in the Testing Story but keep the shell alive longer:

```sh
dbus-run-session -- bash -c '
  gnome-shell --devkit &>/tmp/claude-devkit.log &
  sleep 8
  oneko-wayland add Naptunia --mode catwalk --body white --outline red
  echo "watch for ~60s: cat should stroll the focused titlebar, pause, groom, eventually sleep"
  sleep 60
  oneko-wayland remove --all
  kill %1 2>/dev/null'
```

Verify by watching the nested shell window (open a window inside it and focus it): the cat strolls to random spots along the titlebar, pauses a couple of seconds, occasionally grooms, and (with EARLY_NAP_CHANCE per pause) may curl up. `grep -iE "JS ERROR|oneko" /tmp/claude-devkit.log` must show no errors.

- [ ] **Step 9: Commit**

```bash
git add extension/oneko-wayland@disco-chef/cat.js
git commit -m "catwalk mode: stroll, pause, groom, nap, pin"
```

---

### Task 4: Waking — pokes, reactions, and the chase

Cats wake sleeping siblings by proximity; the pointer wakes by touch; the woken cat rolls one of four reactions.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/cat.js`

**Interfaces:**
- Consumes: everything Task 3 produced.
- Produces: `poke(offender, offenderX)` — public; `offender` is a `Cat` or the string `'pointer'`; `_awayFrom(ox)` (returns an x in the wander range, on the far side from `ox`).

- [ ] **Step 1: `_awayFrom()`**

Below `_wanderRange()`:

```js
    _awayFrom(ox) {
        const [lo, hi] = this._wanderRange();
        const mid = (lo + hi) / 2;
        return ox >= mid
            ? lo + Math.random() * (mid - lo)
            : mid + Math.random() * (hi - mid);
    }
```

- [ ] **Step 2: `poke()`**

Below `_wakeUp()`:

```js
    // Someone (a strolling sibling, or the pointer) got too close to a
    // sleeper. The sleeper decides how to take it: four reactions, equal
    // odds. POKE_SNOOZE keeps a doze-off from becoming a wake-up loop while
    // the offender is still standing there.
    poke(offender, offenderX) {
        if (this._mode !== 'catwalk' || this._state !== State.SLEEP ||
            this._pokeCooldown > 0)
            return;
        switch (Math.floor(Math.random() * 4)) {
        case 0:  // startle, groom the indignity away, carry on
            this._wakeUp();
            this._afterAwake = 'groom';
            break;
        case 1:  // get up and walk off, pointedly, the other way
            this._wakeUp();
            this._afterAwake = 'move';
            this._wanderX = this._awayFrom(offenderX);
            break;
        case 2:  // look around, decide it wasn't worth it, doze off again
            this._pokeCooldown = this._drawTicks(POKE_SNOOZE, POKE_SNOOZE);
            this._afterAwake = 'sleep';
            this._setState(State.AWAKE);
            break;
        case 3:  // oh, it is ON
            this._wakeUp();
            this._afterAwake = 'chase';
            this._chaseTarget = offender;
            this._chaseTicks = this._drawTicks(CHASE_TIME, CHASE_TIME);
            break;
        }
    }
```

(Note case 2 must not call `_wakeUp()`: the pin and the remaining `_napTicks` survive a doze-off.)

- [ ] **Step 3: Wire the two wake sources into `_tickCatwalk()`**

In the `State.SLEEP` case, after the `minimized` check and before the `_napTicks <= 0` check, add the pointer poke:

```js
            if (target.px >= this._x && target.px < this._x + this._size &&
                target.py >= this._y && target.py < this._y + this._size) {
                this.poke('pointer', target.px);
                break;
            }
```

In the combined `State.MOVE`/`State.CHASE` case, right after the `this._stepTowards(dx, dy, distance);` call:

```js
                for (const cat of this._siblings()) {
                    if (cat !== this && cat._state === State.SLEEP &&
                        Math.hypot(cat._x - this._x, cat._y - this._y) <
                            WAKE_RADIUS * this._size)
                        cat.poke(this, this._x);
                }
```

(`poke()` itself rejects non-catwalk cats, so a focus-mode sleeper can't be woken by a passing flâneur.)

- [ ] **Step 4: Syntax gate**

Run: `node --input-type=module --check < extension/oneko-wayland@disco-chef/cat.js`
Expected: silent, exit 0.

- [ ] **Step 5: Devkit observation**

As Task 3 Step 8, but spawn three cats and shrink the schedule so naps happen fast. Temporarily (do NOT commit) set `WANDER_ENERGY_MIN = 5`, `WANDER_ENERGY_MAX = 10`, `NAP_MIN = 30`, `NAP_MAX = 40`, reinstall, then:

```sh
dbus-run-session -- bash -c '
  gnome-shell --devkit &>/tmp/claude-devkit.log &
  sleep 8
  oneko-wayland add Naptunia  --mode catwalk --body white --outline red
  oneko-wayland add Dozer     --mode catwalk --body white --outline red --speed 16 --time 100500
  oneko-wayland add Snoozanne --mode catwalk --body white --outline red --speed 15 --time 100250
  sleep 180
  oneko-wayland remove --all
  kill %1 2>/dev/null'
```

Watch for: sleepers being woken by passing cats; all four reactions across a few wakings (startle+groom, walk-off, doze-back, chase); a chase visibly following the offender then disengaging; poking a sleeper with the pointer waking it. `grep -iE "JS ERROR" /tmp/claude-devkit.log` must be empty. **Then restore the four constants to 20/40/60/180 and reinstall.**

- [ ] **Step 6: Verify constants were restored**

Run: `grep -n "WANDER_ENERGY_MIN = 20\|WANDER_ENERGY_MAX = 40\|NAP_MIN = 60\|NAP_MAX = 180" extension/oneko-wayland@disco-chef/cat.js | wc -l`
Expected: `4`

- [ ] **Step 7: Commit**

```bash
git add extension/oneko-wayland@disco-chef/cat.js
git commit -m "catwalk mode: rude awakenings, four ways"
```

---

### Task 5: README

Document the mode; recolor the standalone examples to Sultana's livery (`--body white --outline red`). The alias block keeps its three distinct color schemes (it mirrors the owner's real aliases).

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Intro paragraph**

After the `-tofocus` paragraph (ends "...original timing constants from `oneko.h`." at line 26), add:

```markdown
There is also a third, more contemplative mode: `catwalk`. Those cats keep to
the focused window's top edge but ignore your pointer; they stroll to spots of
their own choosing, groom, and take long naps pinned to the window they fell
asleep on. A cat that wanders into a sleeping colleague wakes it, and the
woken cat picks one of four reactions, one of which is a chase. Poking a
sleeper with the pointer counts as a waking, and yes, it may chase the pointer
for it.
```

- [ ] **Step 2: Quick-start example (line 60)**

```sh
oneko-wayland add Pickles --body white --outline red
```

- [ ] **Step 3: Mode row in the options table (line 89)**

```markdown
| `-m, --mode` | `focus` = ride the focused window (old `-tofocus`), `mouse` = free pointer chasing, `catwalk` = stroll the focused window and nap on its own schedule | `focus` |
```

- [ ] **Step 4: Recoloring examples (lines 113-117)**

```sh
oneko-wayland add Pickles --body white --outline red     # white cat, red trim
oneko-wayland add Rex --animal dog --body white --outline red   # matching dog
oneko-wayland add Stripes --animal tora --scale 2        # big tiger
```

- [ ] **Step 5: Alias block (after the `catsmouse` alias, line 177)**

```zsh
alias catswalk='oneko-wayland add MrPickles --body orange --outline brown --speed 14 --offset-x=35  --time 100000 --mode catwalk &&
                oneko-wayland add Adonis    --body grey   --outline black --speed 16 --offset-x=-35 --time 100500 --mode catwalk &&
                oneko-wayland add Sultana   --body white  --outline red   --speed 15 --offset-x=0   --time 100250 --mode catwalk'
```

- [ ] **Step 6: Sanity pass**

Run: `grep -n "catwalk\|white --outline red" README.md`
Expected: hits in the intro, options table, both example blocks, and the alias block; no stray "orange cat" comment left on the recolored lines.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "readme: catwalk mode, and the examples dress like sultana now"
```

---

### Task 6: Aliases (`~/.aliases` — NOT in this repo)

`~/.aliases` is a symlink into the owner's dotfiles. Edit the file through the symlink; do not commit anything anywhere for this task (the dotfiles repo is the owner's business).

**Files:**
- Modify: `~/.aliases` (add `catswalk` after `catsmouse`; fix Sultana's mode inside `catsmouse`)

- [ ] **Step 1: Fix the confirmed slip**

In the `catsmouse` alias, Sultana's line ends `--mode focus`; change it to `--mode mouse`.

- [ ] **Step 2: Add `catswalk`**

Insert after the `catsmouse` alias, matching the file's column alignment:

```zsh
alias catswalk='oneko-wayland add Adonis       --bg gray      --fg white     --speed 14    --offset=35   --time 100000  --mode catwalk &&
                oneko-wayland add MrPickles    --bg orange    --fg brown     --speed 16    --offset=-35  --time 100500  --mode catwalk &&
                oneko-wayland add Sultana      --body white   --outline red  --speed 15    --offset-x=0  --time 100250  --mode catwalk'
```

- [ ] **Step 3: Parse check**

Run: `zsh -fn ~/.aliases`
Expected: silent, exit 0.

---

### Task 7: Final verification (with the user)

**Files:** none.

- [ ] **Step 1: Full install and devkit checklist**

Run `./install.sh`, then `make devkit`, spawn the trio via the real alias inside the devkit bus (or the three-cat command from Task 4 Step 5 with stock constants), and walk the spec's checklist:

1. Wandering stays within the titlebar's horizontal bounds.
2. Pauses occasionally deepen into naps; energy exhaustion always does (be patient: stock schedule is 20-40 s awake, 60-180 s naps).
3. Wakings produce varied reactions; chases disengage after ~5 s.
4. Pointer poke wakes a sleeper.
5. Focus switch: sleepers stay behind, wanderers migrate.
6. Dragging the pinned window carries the sleeper along.
7. Closing the pinned window sends the sleeper to the focused window.
8. No focused window: cats wander the bottom edge.
9. Disable/enable the extension in the devkit: cats come back.
10. `oneko-wayland remove --all` at the end (shared state file!).

- [ ] **Step 2: Hand back to the user**

Remind them: the *real* session still runs the old code, so `catswalk` works there only after a logout/login; and because the devkit shared the state file, they should re-run their alias once in the real session to re-save their cats.

---

## Self-Review Notes

- Spec coverage: behavior model (Tasks 3-4), constants (Task 3 Step 1), architecture/siblings (Task 1), fallback floor (`_wanderRange`), CLI (Task 2), aliases incl. Sultana fix (Task 6), README recoloring (Task 5), edge cases (pin drag/close/minimize in Task 3, cooldown in Task 4), testing checklist (Task 7). Out-of-scope items untouched.
- GROOM_CHANCE, PAUSE_MIN/MAX and POKE_SNOOZE are additions beyond the spec's constants table: the spec's "pauses may include grooming", "pause for a couple of seconds", and the doze-back re-poke loop needed concrete values.
- Type consistency: `poke(offender, offenderX)` matches both call sites (`cat.poke(this, this._x)`, `this.poke('pointer', target.px)`); `_afterAwake` values (`'groom' | 'move' | 'sleep' | 'chase'`) match the AWAKE dispatcher.
