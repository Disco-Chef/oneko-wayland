# idleprowl mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `catwalk` to `prowl` (keeping `catwalk` as a back-compat alias), tidy up prowl's poke/chase behaviour, and add a fourth mode `idleprowl` whose cats prowl while the pointer is active and sleep while it's idle.

**Architecture:** All behaviour lives in `extension/oneko-wayland@disco-chef/cat.js` as an extension of the existing per-cat state machine; no coordinator. Mode strings are validated in two places (`bin/oneko-wayland` CLI and `extension.js` `_validate`) and flow untouched through D-Bus, persistence and restore. `prowl` and `idleprowl` share one brain (`_tickProwl` / `_prowlTarget`); the only difference is what drives sleep: an internal energy budget for prowl, pointer idleness for idleprowl.

**Tech Stack:** GJS (GNOME Shell 45+ ESM extension), Python 3 CLI front-end, D-Bus (`org.oneko.Wayland`).

## Verification approach (read before starting)

There is no unit-test framework: the code runs inside gnome-shell against live compositor objects (`global.get_pointer`, `St.DrawingArea`, `Meta` windows). But there IS a real automated gate, the **headless smoke test** used when this project was built. It catches the failure mode that matters most for these edits: an exception thrown in the per-cat tick loop (a typo'd property, a bad method call, a broken state transition) surfaces as a `JS ERROR` in the shell log.

Each task verifies in three tiers:

1. **Syntax gate** (instant):
   - JS: `node --check extension/oneko-wayland@disco-chef/cat.js` and same for `extension.js`. `node --check` parses ESM including `import ... from 'gi://...'` lines without resolving them, so it catches typos and brace/paren errors.
   - CLI: `python3 -m py_compile bin/oneko-wayland`.
2. **Headless smoke test** (automated, ~20s): after `make install`, run the script below in the mode(s) that task touches. It boots a private, headless gnome-shell, spawns three cats, lets them tick, and fails on any extension `JS ERROR` or if the cats did not spawn. Modes per task: Tasks 1-2 -> `prowl`; Tasks 3-5 -> `idleprowl`; Task 6 -> run both. (`prowl`/`idleprowl` only exist after Tasks 1/3 respectively; before that, smoke-test in `catwalk`/`focus`.)
3. **Interactive devkit check** (manual, for behaviour the log can't assert): the poke reactions, chase feel, the deadzone jiggle, wake-on-movement. Each task lists the exact spawn commands and what to watch for. Run via `make devkit` (`dbus-run-session -- gnome-shell --devkit`), a nested shell in a window; inside it `gnome-extensions enable oneko-wayland@disco-chef`, then `oneko-wayland add ...`. To clear cats: `oneko-wayland remove --all` (there is no `clear` subcommand).

**The smoke-test script** (write once to `tools/headless-smoke.sh`; it is a dev helper, not committed):

```bash
#!/usr/bin/env bash
# Headless smoke test for oneko-wayland. Isolates XDG_STATE_HOME so it can
# neither see nor overwrite your real saved cats. Usage: headless-smoke.sh [mode] [secs]
set -uo pipefail
MODE="${1:-catwalk}"; TICK_SECONDS="${2:-8}"
CLI="$HOME/.local/bin/oneko-wayland"
LOG="$(mktemp)"; STATE_DIR="$(mktemp -d)"
dbus-run-session -- env XDG_STATE_HOME="$STATE_DIR" bash -c '
  set -uo pipefail
  gnome-shell --headless --virtual-monitor 1920x1080 & SHELL_PID=$!
  for i in $(seq 1 50); do
    gdbus introspect --session --dest org.oneko.Wayland \
      --object-path /org/oneko/Wayland >/dev/null 2>&1 && break
    sleep 0.5
  done
  "'"$CLI"'" add SmokeA --speed 16 --offset=35  --time 100000 --mode '"$MODE"'
  "'"$CLI"'" add SmokeB --speed 16 --offset=-35 --time 100200 --mode '"$MODE"'
  "'"$CLI"'" add SmokeC --speed 16 --offset=0   --time 100400 --mode '"$MODE"'
  sleep '"$TICK_SECONDS"'
  kill "$SHELL_PID" 2>/dev/null; wait "$SHELL_PID" 2>/dev/null
' >"$LOG" 2>&1
spawned=$(grep -c "is on the prowl" "$LOG"); echo "cats spawned: $spawned"
fail=0
[ "$spawned" -lt 3 ] && { echo "FAIL: expected 3 cats, got $spawned"; grep -iE "invalid choice|error" "$LOG" | grep -vi "evolution\|portal\|vfs\|calendar\|secret" | head; fail=1; }
if grep -E "JS ERROR" "$LOG" | grep -Ei "oneko|disco-chef|cat\.js|extension\.js" >/dev/null; then
  echo "FAIL: extension JS error:"; grep -E "JS ERROR" "$LOG" | grep -Ei "oneko|disco-chef|cat\.js|extension\.js"; fail=1
fi
[ "$fail" = 0 ] && echo "OK: 3 cats ticked ${TICK_SECONDS}s in '${MODE}' with no extension JS errors"
rm -rf "$LOG" "$STATE_DIR"; exit "$fail"
```

Run with a timeout, e.g. `timeout 120 bash tools/headless-smoke.sh prowl 8`. This exact script has been verified green against HEAD (`catwalk` mode). **Do not remove the `XDG_STATE_HOME` isolation**: without it a successful run overwrites `~/.local/state/oneko-wayland-cats.json` and wipes the user's real cats.

When a task says "commit", stage only the files that task changed. `tools/headless-smoke.sh` is never staged.

## Global Constraints

- Mode canonical values are `focus`, `mouse`, `prowl`, `idleprowl`. `catwalk` is accepted everywhere a mode is read and normalised to `prowl`; it is never advertised in help or README.
- `cat.js` only ever sees the canonical strings `prowl` and `idleprowl` (normalisation happens at the CLI and in `extension.js:_validate` before the string reaches `cat.js`).
- All timings are named constants at the top of `cat.js`, expressed in wall-clock seconds and converted per cat by `_drawTicks(minS, maxS)` so `--time` scales the whole personality. No new CLI flags.
- Constant values (exact): `DOZE_BACK_CHANCE = 0.35`, `IDLE_MIN = 2`, `IDLE_MAX = 6`, `POINTER_DEADZONE = 75`, `SHORT_NAP_MIN = 3`, `SHORT_NAP_MAX = 12`, `SHORT_NAP_CHANCE = 0.15`. `POINTER_DEADZONE` is in raw screen pixels (not scaled).
- `MAX_CATS = 6`; persistence, restore and D-Bus are untouched. Runtime state (energy, idle timers, pointer anchor, pins) is never persisted.
- No em dashes in commit messages or README prose. Commit messages in the repo's existing lowercase-prefix voice (e.g. `prowl: ...`), no `Co-Authored-By`.

---

### Task 1: Rename `catwalk` to `prowl` (with back-compat alias)

Pure rename plus normalisation. After this task everything behaves exactly as before, but under the name `prowl`; `--mode catwalk` and old saved state still work.

**Files:**
- Modify: `bin/oneko-wayland` (add a `mode` normaliser; change the `--mode` argument)
- Modify: `extension/oneko-wayland@disco-chef/extension.js:122-123`
- Modify: `extension/oneko-wayland@disco-chef/cat.js` (11 sites: comments, mode checks, method names)

**Interfaces:**
- Produces: `cat.js` methods `_tickProwl(target)` and `_prowlTarget()` (renamed from `_tickCatwalk` / `_catwalkTarget`); mode gate `this._mode === 'prowl'`. Later tasks extend these to also match `'idleprowl'`.

- [ ] **Step 1: Add a `mode` normaliser to the CLI**

In `bin/oneko-wayland`, immediately after the `interval` function (which ends around line 92), add:

```python
def mode(value):
    v = value.strip().lower()
    if v == "catwalk":  # renamed to prowl; still accepted so old scripts work
        v = "prowl"
    if v not in ("focus", "mouse", "prowl"):
        raise argparse.ArgumentTypeError(
            f"{value!r} is not one of: focus, mouse, prowl")
    return v
```

- [ ] **Step 2: Point `--mode` at the normaliser**

Replace the `--mode` argument (currently `bin/oneko-wayland:265-269`):

```python
    add.add_argument("-m", "--mode", choices=["focus", "mouse", "catwalk"], default="focus",
                     help="focus: ride the focused window's top edge (like "
                          "-tofocus); mouse: free pointer chasing; catwalk: "
                          "stroll the focused window's top edge and nap on "
                          "your own schedule (default: focus)")
```

with:

```python
    add.add_argument("-m", "--mode", type=mode, metavar="MODE", default="focus",
                     help="focus: ride the focused window's top edge (like "
                          "-tofocus); mouse: free pointer chasing; prowl: "
                          "stroll the focused window's top edge and nap on "
                          "your own schedule (default: focus)")
```

- [ ] **Step 3: Syntax-check the CLI**

Run: `python3 -m py_compile bin/oneko-wayland`
Expected: no output, exit 0.

- [ ] **Step 4: Normalise the mode in `extension.js`**

Replace `extension/oneko-wayland@disco-chef/extension.js:122-123`:

```javascript
        if (!['focus', 'mouse', 'catwalk'].includes(config.mode))
            throw new Error('mode must be "focus", "mouse" or "catwalk"');
```

with:

```javascript
        if (config.mode === 'catwalk')  // renamed to prowl; keep old saved state working
            config.mode = 'prowl';
        if (!['focus', 'mouse', 'prowl'].includes(config.mode))
            throw new Error('mode must be "focus", "mouse" or "prowl"');
```

- [ ] **Step 5: Rename in `cat.js` (comments and the mode gate)**

Apply these exact replacements in `extension/oneko-wayland@disco-chef/cat.js`:

- Line 15: `// Catwalk mode personality. Wall-clock seconds (converted per cat by` -> `// Prowl mode personality. Wall-clock seconds (converted per cat by`
- Line 83: `        // Catwalk-mode state (inert in the other modes).` -> `        // Prowl-mode state (inert in the other modes).`
- Line 124: `        if (this._mode === 'catwalk')` -> `        if (this._mode === 'prowl')`
- Line 186: `    // Where a catwalk cat may roam: the focused window's top edge, or the` -> `    // Where a prowl cat may roam: the focused window's top edge, or the`
- Line 244: `        if (this._mode !== 'catwalk' || this._state !== State.SLEEP ||` -> `        if (this._mode !== 'prowl' || this._state !== State.SLEEP ||`
- Line 322: `    // Catwalk cats ignore the pointer: the target is wherever the cat has` -> `    // Prowl cats ignore the pointer: the target is wherever the cat has`
- Line 433: `    // The catwalk brain: self-directed strolls, long naps, strong opinions` -> `    // The prowl brain: self-directed strolls, long naps, strong opinions`

- [ ] **Step 6: Rename the two methods and their call sites in `cat.js`**

- Line 288-289: replace
  ```javascript
          if (this._mode === 'catwalk')
              return this._catwalkTarget();
  ```
  with
  ```javascript
          if (this._mode === 'prowl')
              return this._prowlTarget();
  ```
- Line 324: `    _catwalkTarget() {` -> `    _prowlTarget() {`
- Line 435: `    _tickCatwalk(target) {` -> `    _tickProwl(target) {`
- Line 541-542: replace
  ```javascript
          if (this._mode === 'catwalk')
              this._tickCatwalk(target);
  ```
  with
  ```javascript
          if (this._mode === 'prowl')
              this._tickProwl(target);
  ```

- [ ] **Step 7: Syntax-check the JS**

Run: `node --check extension/oneko-wayland@disco-chef/cat.js && node --check extension/oneko-wayland@disco-chef/extension.js`
Expected: no output, exit 0.

- [ ] **Step 8: Confirm no `catwalk` references remain in `cat.js`**

Run: `grep -n "catwalk\|Catwalk\|_catwalkTarget\|_tickCatwalk" extension/oneko-wayland@disco-chef/cat.js`
Expected: no matches (exit 1).

- [ ] **Step 9: Manual devkit check**

`make install`, restart the extension in the nested session, then:
```
oneko-wayland clear
oneko-wayland add TestProwl  --speed 15 --time 100000 --mode prowl
oneko-wayland add TestOld    --speed 15 --time 100000 --mode catwalk
```
Expected: both spawn (no error JSON), both stroll the focused window's top edge and nap exactly like the old catwalk mode. `oneko-wayland list` shows both with `"mode": "prowl"` (catwalk normalised).

- [ ] **Step 10: Commit**

```bash
git add bin/oneko-wayland extension/oneko-wayland@disco-chef/cat.js extension/oneko-wayland@disco-chef/extension.js
git commit -m "prowl: rename catwalk, keep the old name as an alias"
```

---

### Task 2: prowl poke and chase overhaul

Covers spec 1a, 1b, 1c together, because they all rewrite the same two hotspots (`poke()` and the MOVE/CHASE handler) and splitting them would mean editing those functions twice with contradictory intermediate states. Three behaviour changes:

- **1a:** sibling poke rolls one of three reactions (sulk-groom, walk-off, chase); doze-back is no longer standalone, only a `DOZE_BACK_CHANCE` tail after a sulk or a walk-off, keeping the remaining nap time.
- **1b:** a pointer poke always chases the cursor (only sleepers are grabbed) and re-poking refreshes the timer.
- **1c:** a chaser shows run frames only while actually moving; catching a sibling ends the chase; catching the pointer holds a settled frame while the timer runs on.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/cat.js` (constants, constructor fields, `_fallAsleep`, `poke`, `_tickProwl` STOP/KAKI/MOVE/CHASE handling, `_currentFrame`)

**Interfaces:**
- Consumes: `_tickProwl`, `_prowlTarget`, `_drawTicks`, `_wakeUp`, `_awayFrom`, `_focusWindow` (from Task 1 and existing code).
- Produces: new fields `_moving` (bool), `_dozeBackAfter` (bool), `_napStash` (int ticks); new method `_dozeBack()`; `_fallAsleep(napTicks = null)` signature; `poke(offender, offenderX)` with offender-split behaviour.

- [ ] **Step 1: Add the `DOZE_BACK_CHANCE` constant**

In `cat.js`, after the `POKE_SNOOZE` constant (line 25), add:

```javascript
const DOZE_BACK_CHANCE = 0.35; // after a sulk or walk-off, odds of dozing back off
```

- [ ] **Step 2: Add the new per-cat fields**

In the constructor, after `this._pinned = null;` (line 93), add:

```javascript
        this._moving = false;        // are we actually closing distance this tick
        this._dozeBackAfter = false; // poke reaction should end by dozing off again
        this._napStash = 0;          // nap ticks left when a poke pulled us up
```

- [ ] **Step 3: Let `_fallAsleep` accept a nap duration**

Replace the first two lines of `_fallAsleep` (currently `cat.js:212-214`):

```javascript
    _fallAsleep() {
        this._napTicks = this._drawTicks(NAP_MIN, NAP_MAX);
        this._napPlanned = false;
```

with:

```javascript
    _fallAsleep(napTicks = null) {
        this._napTicks = napTicks ?? this._drawTicks(NAP_MIN, NAP_MAX);
        this._napPlanned = false;
```

- [ ] **Step 4: Add the `_dozeBack` helper**

Immediately after `_fallAsleep` (which ends at `cat.js:227` with its closing brace), add:

```javascript
    // Tail of a sulk or walk-off: settle back into the nap we were pulled out
    // of, keeping whatever time was left. The cooldown stops the offender still
    // loitering nearby from instantly re-waking us.
    _dozeBack() {
        this._dozeBackAfter = false;
        this._pokeCooldown = this._drawTicks(POKE_SNOOZE, POKE_SNOOZE);
        this._fallAsleep(this._napStash > 0 ? this._napStash : null);
    }
```

- [ ] **Step 5: Rewrite `poke()`**

Replace the whole `poke` method (currently `cat.js:243-269`) with:

```javascript
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
```

- [ ] **Step 6: Doze-back tail on the groom path (KAKI)**

In `_tickProwl`, replace the KAKI case (currently `cat.js:454-463`):

```javascript
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
```

with:

```javascript
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
```

- [ ] **Step 7: Rewrite the MOVE/CHASE handler (refresh, caught-target, moving flag, walk-off doze)**

Replace the MOVE/CHASE case (currently `cat.js:507-531`):

```javascript
        case State.MOVE:
        case State.CHASE:
            if (this._state === State.CHASE) {
                this._chaseTicks--;
                if (this._chaseTicks <= 0) {
                    this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                    this._chaseTarget = null;
                    this._setState(State.STOP);
                    break;
                }
            }
            if (distance > this._catch) {
                this._stepTowards(dx, dy, distance);
                for (const cat of this._siblings()) {
                    if (cat !== this && cat._state === State.SLEEP &&
                        Math.hypot(cat._x - this._x, cat._y - this._y) <
                            WAKE_RADIUS * this._size)
                        cat.poke(this, this._x);
                }
            } else if (this._state === State.MOVE) {
                this._wanderX = null;
                this._pauseTicks = this._drawTicks(PAUSE_MIN, PAUSE_MAX);
                this._setState(State.STOP);
            }
            break;
```

with:

```javascript
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
```

- [ ] **Step 8: Show a settled frame when a chaser is standing still**

In `_currentFrame`, replace the MOVE/CHASE case (currently `cat.js:589-591`):

```javascript
        case State.MOVE:
        case State.CHASE:
            return `${this._dir}${alt}`;
```

with:

```javascript
        case State.MOVE:
        case State.CHASE:
            return this._moving ? `${this._dir}${alt}` : 'mati2';
```

- [ ] **Step 9: Syntax-check**

Run: `node --check extension/oneko-wayland@disco-chef/cat.js`
Expected: no output, exit 0.

- [ ] **Step 10: Manual devkit check**

`make install`, restart the extension, then spawn a trio so siblings poke each other:
```
oneko-wayland clear
oneko-wayland add A --speed 16 --offset=35  --time 100000 --mode prowl
oneko-wayland add B --speed 16 --offset=-35 --time 100200 --mode prowl
oneko-wayland add C --speed 16 --offset=0   --time 100400 --mode prowl
```
Expected over a few minutes:
- A cat that catches a sleeping sibling at the window edge **stops** beside it instead of running on the spot.
- Over several sibling wakes you see sulk-groom, walk-off, and chase; after a sulk or walk-off the cat sometimes flops back to sleep and sometimes carries on. A standalone "doze straight back" with no groom or walk-off never happens.
- Hover the pointer onto a sleeping cat: it **always** gives chase. Move the cursor and it follows; park the cursor on top of it and it sits (still frame), springing back into the run when you move; keep the cursor on/over it and the chase never times out; leave it be and the chase ends after ~5 s.

- [ ] **Step 11: Commit**

```bash
git add extension/oneko-wayland@disco-chef/cat.js
git commit -m "prowl: your cursor always gets a chase, siblings roll three ways, and nobody paddles on the spot"
```

---

### Task 3: Route `idleprowl` through the prowl brain

Introduce the mode name end to end, dispatched to `_tickProwl` / `_prowlTarget`. At the end of this task an `idleprowl` cat behaves exactly like a `prowl` cat; Tasks 4 and 5 add the pointer-driven behaviour.

**Files:**
- Modify: `bin/oneko-wayland` (`mode` normaliser accepts `idleprowl`)
- Modify: `extension/oneko-wayland@disco-chef/extension.js:122-125` (allow `idleprowl`)
- Modify: `extension/oneko-wayland@disco-chef/cat.js` (three dispatch gates accept `idleprowl`)

**Interfaces:**
- Consumes: `_tickProwl`, `_prowlTarget`, `this._mode === 'prowl'` gates from Task 1.
- Produces: `idleprowl` as a valid mode reaching `cat.js`; the dispatch predicate becomes `this._mode === 'prowl' || this._mode === 'idleprowl'`.

- [ ] **Step 1: Accept `idleprowl` at the CLI**

In `bin/oneko-wayland`, in the `mode` function from Task 1, change the membership check:

```python
    if v not in ("focus", "mouse", "prowl"):
        raise argparse.ArgumentTypeError(
            f"{value!r} is not one of: focus, mouse, prowl")
```

to:

```python
    if v not in ("focus", "mouse", "prowl", "idleprowl"):
        raise argparse.ArgumentTypeError(
            f"{value!r} is not one of: focus, mouse, prowl, idleprowl")
```

Also extend the `--mode` help string to mention it. Change the help text tail from:

```python
                          "your own schedule (default: focus)")
```

to:

```python
                          "your own schedule; idleprowl: prowl while you're at "
                          "the machine, sleep when the pointer goes still "
                          "(default: focus)")
```

- [ ] **Step 2: Syntax-check the CLI**

Run: `python3 -m py_compile bin/oneko-wayland`
Expected: no output, exit 0.

- [ ] **Step 3: Accept `idleprowl` in `extension.js`**

Replace the validation block (from Task 1, `extension.js:122-125`):

```javascript
        if (config.mode === 'catwalk')  // renamed to prowl; keep old saved state working
            config.mode = 'prowl';
        if (!['focus', 'mouse', 'prowl'].includes(config.mode))
            throw new Error('mode must be "focus", "mouse" or "prowl"');
```

with:

```javascript
        if (config.mode === 'catwalk')  // renamed to prowl; keep old saved state working
            config.mode = 'prowl';
        if (!['focus', 'mouse', 'prowl', 'idleprowl'].includes(config.mode))
            throw new Error('mode must be "focus", "mouse", "prowl" or "idleprowl"');
```

- [ ] **Step 4: Dispatch `idleprowl` to the prowl brain in `cat.js`**

Three gates, all currently `this._mode === 'prowl'` (from Task 1). Extend each to also match `idleprowl`:

- Constructor energy seed (line 124):
  ```javascript
          if (this._mode === 'prowl')
              this._energy = this._drawTicks(WANDER_ENERGY_MIN, WANDER_ENERGY_MAX);
  ```
  becomes
  ```javascript
          if (this._mode === 'prowl' || this._mode === 'idleprowl')
              this._energy = this._drawTicks(WANDER_ENERGY_MIN, WANDER_ENERGY_MAX);
  ```
  (Task 4 stops idleprowl using energy; seeding it here is harmless until then.)
- `_target()` gate (line 288-289):
  ```javascript
          if (this._mode === 'prowl')
              return this._prowlTarget();
  ```
  becomes
  ```javascript
          if (this._mode === 'prowl' || this._mode === 'idleprowl')
              return this._prowlTarget();
  ```
- `_tick()` gate (line 541-542):
  ```javascript
          if (this._mode === 'prowl')
              this._tickProwl(target);
  ```
  becomes
  ```javascript
          if (this._mode === 'prowl' || this._mode === 'idleprowl')
              this._tickProwl(target);
  ```

Note: `poke()`'s `this._mode !== 'prowl'` guard is deliberately left as-is, so idleprowl ignores pointer pokes (the spec's intent; Task 4's activity-wake supersedes them).

- [ ] **Step 5: Syntax-check the JS**

Run: `node --check extension/oneko-wayland@disco-chef/cat.js && node --check extension/oneko-wayland@disco-chef/extension.js`
Expected: no output, exit 0.

- [ ] **Step 6: Manual devkit check**

`make install`, restart the extension, then:
```
oneko-wayland clear
oneko-wayland add Idle1 --speed 15 --time 100000 --mode idleprowl
```
Expected: spawns without error, `oneko-wayland list` shows `"mode": "idleprowl"`, and the cat behaves just like a prowl cat for now (strolls, naps on its energy schedule, ignores the pointer). This confirms the plumbing before behaviour lands.

- [ ] **Step 7: Commit**

```bash
git add bin/oneko-wayland extension/oneko-wayland@disco-chef/cat.js extension/oneko-wayland@disco-chef/extension.js
git commit -m "idleprowl: let the new mode in, riding the prowl brain for now"
```

---

### Task 4: idleprowl pointer-activity driver

The heart of the mode. Pointer movement past a deadzone is the master awake/asleep signal: real movement wakes a sleeper, and a per-cat quiet spell sends an awake cat into a wind-down sleep with no nap timer. Energy is switched off for idleprowl.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/cat.js` (constants, constructor fields, new `_pointerMoved` helper, `_tickProwl` gating and energy skip, SLEEP handling)

**Interfaces:**
- Consumes: `_drawTicks`, `_wakeUp`, `_setState`, `_focusWindow`, `_prowlTarget` returning `{x, y, px, py}`.
- Produces: fields `_pointerAnchor` (`[x, y]` or null), `_idleTicks` (int), `_idleLimit` (int ticks); method `_pointerMoved(px, py)` returning bool.

- [ ] **Step 1: Add the idleprowl constants**

In `cat.js`, after the `DOZE_BACK_CHANCE` constant (added in Task 2), add:

```javascript
// idleprowl: the pointer is the pulse. Movement past the deadzone is real
// activity (wakes a sleeper); a quiet spell sends an awake cat to sleep.
const IDLE_MIN = 2;             // per-cat quiet spell before settling
const IDLE_MAX = 6;
const POINTER_DEADZONE = 75;    // raw px; smaller nudges (anti screen-dim) are ignored
```

- [ ] **Step 2: Add the idleprowl per-cat fields**

In the constructor, after the fields added in Task 2 (`this._napStash = 0;`), add:

```javascript
        this._pointerAnchor = null;  // last pointer spot that counted as movement
        this._idleTicks = 0;         // ticks since that movement
        this._idleLimit = this._drawTicks(IDLE_MIN, IDLE_MAX);
```

- [ ] **Step 3: Add the `_pointerMoved` helper**

After the `_pointerMoved` will sit naturally next to the other geometry helpers; add it immediately after `_awayFrom` (which ends at `cat.js:203`):

```javascript
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
```

- [ ] **Step 4: Gate the top of `_tickProwl` for idleprowl (wake, settle, skip energy)**

The current top of `_tickProwl` (`cat.js:435-439`) is:

```javascript
    _tickProwl(target) {
        if (this._state !== State.SLEEP && this._energy > 0)
            this._energy--;
        if (this._pokeCooldown > 0)
            this._pokeCooldown--;
```

Replace it with:

```javascript
    _tickProwl(target) {
        if (this._mode === 'idleprowl') {
            const active = this._pointerMoved(target.px, target.py);
            if (active) {
                this._idleTicks = 0;
                this._idleLimit = this._drawTicks(IDLE_MIN, IDLE_MAX);
                if (this._state === State.SLEEP) {
                    this._wakeUp();
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
```

- [ ] **Step 5: Don't wake an idle-sleeper on a nap timer**

In `_tickProwl`'s SLEEP case, the natural-wake check is currently (`cat.js:479-482`):

```javascript
            if (this._napTicks <= 0) {
                this._wakeUp();
                break;
            }
```

Replace it with:

```javascript
            if (this._mode !== 'idleprowl' && this._napTicks <= 0) {
                this._wakeUp();  // prowl: nap timer expired. idleprowl waits for the pointer.
                break;
            }
```

(The `_napTicks--` on the line above stays; for idleprowl it simply runs harmlessly into negatives and is ignored.)

- [ ] **Step 6: Don't grant an energy budget when an idle-sleeper wakes**

`_wakeUp` (`cat.js:229-237`) currently always draws a fresh energy budget. That budget is unused in idleprowl, but drawing it is harmless, so no change is required here. Leave `_wakeUp` as is. (This step is a deliberate no-op, recorded so a reviewer knows it was considered.)

- [ ] **Step 7: Syntax-check**

Run: `node --check extension/oneko-wayland@disco-chef/cat.js`
Expected: no output, exit 0.

- [ ] **Step 8: Manual devkit check**

`make install`, restart the extension, then:
```
oneko-wayland clear
oneko-wayland add Zzz1 --speed 16 --offset=35  --time 100000 --mode idleprowl
oneko-wayland add Zzz2 --speed 16 --offset=-35 --time 100200 --mode idleprowl
```
Expected:
- While you move the mouse around: both cats stroll, pause and groom (their prowl wander), never chasing the pointer.
- Stop touching the mouse: after ~2 to 6 s each cat winds down (wash, scratch, yawn) and sleeps, the two settling a moment apart rather than together.
- Leave it still for a long time: they stay asleep, no nap-timer wake-ups.
- A small in-place jiggle of a few pixels (imitating the anti screen-dim nudge): they keep sleeping.
- A real sweep of the pointer across the screen: they wake and resume strolling.

- [ ] **Step 9: Commit**

```bash
git add extension/oneko-wayland@disco-chef/cat.js
git commit -m "idleprowl: the pointer is the pulse. move it, they prowl. leave it, they sleep"
```

---

### Task 5: idleprowl short self-naps and the sleep blend

During an active spell an idleprowl cat occasionally takes a short cat-nap it wakes itself from; if the pointer goes idle mid-nap, that nap seamlessly becomes an open-ended idle-sleep.

**Files:**
- Modify: `extension/oneko-wayland@disco-chef/cat.js` (constants, a `_shortNap` field, `_nextIdleAction` short-nap roll, SLEEP handling blend)

**Interfaces:**
- Consumes: `_nextIdleAction`, `_fallAsleep(napTicks)`, `_wakeUp`, `_idleTicks`, `_idleLimit`, `_setState` (from earlier tasks).
- Produces: constants `SHORT_NAP_MIN/MAX/CHANCE`; field `_shortNap` (bool).

- [ ] **Step 1: Add the short-nap constants**

In `cat.js`, after the `POINTER_DEADZONE` constant (Task 4), add:

```javascript
const SHORT_NAP_MIN = 3;        // a voluntary cat-nap while you're active
const SHORT_NAP_MAX = 12;
const SHORT_NAP_CHANCE = 0.15;  // per-pause chance of one
```

- [ ] **Step 2: Add the `_shortNap` field**

In the constructor, after `this._idleLimit = this._drawTicks(IDLE_MIN, IDLE_MAX);` (Task 4), add:

```javascript
        this._shortNap = false;  // idleprowl: this sleep is a self-timed cat-nap
```

- [ ] **Step 3: Roll a short nap at a pause, in idleprowl**

`_nextIdleAction` (`cat.js:272-283`) currently is:

```javascript
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

Replace it with:

```javascript
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
```

- [ ] **Step 4: Give a short nap its short duration**

A short-nap reaches sleep through the normal wind-down, which ends in `_fallAsleep()` from the AKUBI case (`cat.js:464-467`):

```javascript
        case State.AKUBI:
            if (this._stateCount >= AKUBI_TIME)
                this._fallAsleep();
            break;
```

Replace it with:

```javascript
        case State.AKUBI:
            if (this._stateCount >= AKUBI_TIME)
                this._fallAsleep(this._shortNap
                    ? this._drawTicks(SHORT_NAP_MIN, SHORT_NAP_MAX)
                    : null);
            break;
```

- [ ] **Step 5a: A short self-nap runs its own timer, not woken by the pointer**

A deliberate cat-nap should last its `SHORT_NAP` duration even while you keep mousing, then the cat gets up on its own; only an *idle-sleep* wakes on movement. In the Task 4 tick-top gating, the movement-wake branch is currently:

```javascript
                if (this._state === State.SLEEP) {
                    this._wakeUp();
                    return;  // stir this tick, rejoin the wander next tick
                }
```

Replace it with:

```javascript
                if (this._state === State.SLEEP && !this._shortNap) {
                    this._wakeUp();  // an idle-sleep wakes on movement; a cat-nap runs its timer
                    return;  // stir this tick, rejoin the wander next tick
                }
```

(The `this._idleTicks = 0` reset just above it still runs for a short-napper, so `_idleTicks` keeps tracking how long since you last really moved, which Step 5b relies on.)

- [ ] **Step 5b: Blend the short nap into idle-sleep on expiry**

Extend the SLEEP handling from Task 4. The idleprowl natural-wake guard is currently (after Task 4):

```javascript
            if (this._mode !== 'idleprowl' && this._napTicks <= 0) {
                this._wakeUp();  // prowl: nap timer expired. idleprowl waits for the pointer.
                break;
            }
```

Replace it with:

```javascript
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

- [ ] **Step 6: Clear `_shortNap` on any wake**

So a pointer-driven wake mid short-nap doesn't leave the flag set. In `_wakeUp` (`cat.js:229-237`), after `this._unpin();`, add:

```javascript
        this._shortNap = false;
```

- [ ] **Step 7: Syntax-check**

Run: `node --check extension/oneko-wayland@disco-chef/cat.js`
Expected: no output, exit 0.

- [ ] **Step 8: Manual devkit check**

`make install`, restart the extension, then:
```
oneko-wayland clear
oneko-wayland add Nap1 --speed 16 --offset=35  --time 100000 --mode idleprowl
oneko-wayland add Nap2 --speed 16 --offset=-35 --time 100200 --mode idleprowl
```
Expected, while keeping the mouse gently active (small real movements past the deadzone every few seconds so they stay "awake"):
- Now and then a cat takes a brief nap (a few seconds) and gets itself back up while you're still active.
- If, during one of those short naps, you stop touching the mouse entirely, the cat stays down and the nap turns into a full idle-sleep (it does not pop back up on the short timer).
- Everything from Task 4 (settle on idle, wake on real movement, ignore jiggle) still holds.

- [ ] **Step 9: Commit**

```bash
git add extension/oneko-wayland@disco-chef/cat.js
git commit -m "idleprowl: the odd cat-nap while you're around, that melts into a proper sleep when you go"
```

---

### Task 6: Docs (README) and the alias note

Consolidated documentation pass: rename the catwalk section to prowl with its finished behaviour, document idleprowl, and refresh the alias example. Kept as one task so the README is rewritten once against the finished behaviour rather than nudged by every code task.

**Files:**
- Modify: `README.md` (mode prose around lines 28-34, the `--mode` table row around line 97, the alias block around lines 187-189)

- [ ] **Step 1: Rewrite the mode prose**

Replace `README.md:28-34`:

```markdown
There is also a third, more contemplative mode: `catwalk`. Those cats keep to
the focused window's top edge but ignore your pointer; they stroll to spots of
their own choosing, groom, and take long naps pinned to the window they fell
asleep on. A cat that wanders into a sleeping colleague wakes it, and the
woken cat picks one of four reactions, one of which is a chase. Poking a
sleeper with the pointer counts as a waking, and yes, it may chase the pointer
for it.
```

with:

```markdown
There is also a third, more contemplative mode: `prowl` (once called
`catwalk`, which still works as an alias). Those cats keep to the focused
window's top edge but ignore your pointer; they stroll to spots of their own
choosing, groom, and take long naps pinned to the window they fell asleep on.
A cat that wanders into a sleeping colleague wakes it, and the woken cat rolls
one of three reactions: a sulk-and-groom, a pointed walk off the other way, or
a chase; after a sulk or a walk-off it might just flop back to sleep. Poke a
sleeper with your pointer and it always gives chase, following the cursor for a
few seconds; poke it again to keep the chase going, or park the cursor on it
and it sits until you move.

And a fourth, `idleprowl`: the same self-directed prowl, but the pointer is its
pulse. While you're using the mouse the cats prowl, pause, groom and take the
odd short nap; leave the pointer still for a couple of seconds and they wind
down and sleep, staying down until you move it again. Small nudges (the kind
you make to keep a short screen-dim timeout at bay) are ignored, so only real
movement rouses them.
```

- [ ] **Step 2: Update the `--mode` table row**

Replace `README.md:97`:

```markdown
| `-m, --mode` | `focus` = ride the focused window (old `-tofocus`), `mouse` = free pointer chasing, `catwalk` = stroll the focused window and nap on its own schedule | `focus` |
```

with:

```markdown
| `-m, --mode` | `focus` = ride the focused window (old `-tofocus`), `mouse` = free pointer chasing, `prowl` = stroll the focused window and nap on its own schedule (old name `catwalk` still accepted), `idleprowl` = prowl while you're at the machine, sleep when the pointer goes still | `focus` |
```

- [ ] **Step 3: Refresh the alias block**

Replace `README.md:187-189`:

```
alias catswalk='oneko-wayland add MrPickles --body orange --outline brown --speed 14 --offset-x=35  --time 100000 --mode catwalk &&
                oneko-wayland add Adonis    --body grey   --outline black --speed 16 --offset-x=-35 --time 100500 --mode catwalk &&
                oneko-wayland add Sultana   --body white  --outline red   --speed 15 --offset-x=0   --time 100250 --mode catwalk'
```

with:

```
alias catswalk='oneko-wayland add MrPickles --body orange --outline brown --speed 14 --offset-x=35  --time 100000 --mode prowl &&
                oneko-wayland add Adonis    --body grey   --outline black --speed 16 --offset-x=-35 --time 100500 --mode prowl &&
                oneko-wayland add Sultana   --body white  --outline red   --speed 15 --offset-x=0   --time 100250 --mode prowl'

alias catsidleprowl='oneko-wayland add MrPickles --body orange --outline brown --speed 14 --offset-x=35  --time 100000 --mode idleprowl &&
                     oneko-wayland add Adonis    --body grey   --outline black --speed 16 --offset-x=-35 --time 100500 --mode idleprowl &&
                     oneko-wayland add Sultana   --body white  --outline red   --speed 15 --offset-x=0   --time 100250 --mode idleprowl'
```

- [ ] **Step 4: Verify the rendered section**

Run: `grep -n "prowl\|idleprowl\|catwalk" README.md`
Expected: `prowl` and `idleprowl` appear in the prose, table and both aliases; the only `catwalk` mentions are the "still works as an alias" notes.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "readme: catwalk is prowl now, and meet idleprowl"
```

- [ ] **Step 6: (Manual, outside the repo) the real alias**

Your live aliases live in `~/.aliases` (a dotfiles symlink), not in this repo. When ready, mirror the README change there: point the existing `catswalk` alias at `--mode prowl` and add a `catsidleprowl` alias. This is a manual dotfiles edit, not part of the repo commit.

---

## Self-Review

**Spec coverage:**
- Rename catwalk -> prowl with alias: Task 1 (code + CLI), Task 6 (README); back-compat normalisation in both CLI and `extension.js` (Task 1) covers old saved state.
- 1a doze-back tail: Task 2 (poke three-way, `_dozeBack`, KAKI and MOVE branches, `DOZE_BACK_CHANCE`).
- 1b pointer exclusive + refresh: Task 2 (`poke` pointer branch + CHASE refresh check).
- 1c caught chaser / settled frame: Task 2 (MOVE/CHASE handler + `_moving` + `_currentFrame`).
- idleprowl mode plumbing: Task 3.
- Mouse-as-pulse deadzone driver, settle on idle, open-ended sleep, skip energy: Task 4.
- Short self-naps and the short-nap/idle-sleep blend: Task 5.
- Constants table: `DOZE_BACK_CHANCE` (Task 2); `IDLE_MIN/MAX`, `POINTER_DEADZONE` (Task 4); `SHORT_NAP_MIN/MAX/CHANCE` (Task 5).
- README + alias: Task 6, with the `~/.aliases` step called out as external.
- Edge cases from the spec: pinned-window drag/close/minimise unchanged (inherited, untouched); anti-dim jiggle (Task 4 deadzone); short-nap expiry while idle (Task 5 blend); old saved `catwalk` normalised (Task 1).

**Placeholder scan:** No TBD/TODO; every code step shows full before/after. Task 4 Step 6 is an explicit, labelled no-op (documented decision), not a placeholder.

**Type/name consistency:** `_tickProwl`/`_prowlTarget` (Task 1) used by Tasks 3-5. `_fallAsleep(napTicks = null)` defined Task 2, called with an argument in Tasks 2, 5. `_dozeBack`, `_dozeBackAfter`, `_napStash`, `_moving` defined Task 2, used within Task 2. `_pointerMoved`, `_pointerAnchor`, `_idleTicks`, `_idleLimit` defined Task 4, used in Tasks 4-5. `_shortNap` defined Task 5, used in Task 5. Mode predicate `this._mode === 'prowl' || this._mode === 'idleprowl'` consistent across the three dispatch gates (Task 3).

**Ordering note:** Line numbers cited are from the pre-change file; after Task 2 inserts constants and fields, later line references shift. Anchor edits by the surrounding code shown, not by absolute line number.
