# idleprowl mode (and prowl tune-ups)

Date: 2026-07-27
Status: agreed, awaiting implementation plan

## Overview

Two related pieces of work in `cat.js`:

1. **Rename `catwalk` to `prowl`**, keeping `catwalk` as a back-compat alias so
   nobody's saved cats or muscle memory break, and tidy up three things about
   how prowl cats behave (the poke reactions, the pointer chase, and a chaser
   that runs on the spot).
2. **A fourth mode, `idleprowl`**: prowl's self-directed feet, but the pointer
   decides whether the cats are up. Move the mouse and they prowl; leave it
   still and they settle down and sleep until you're back. It borrows focus
   mode's sleep-when-you-leave instinct, not its pointer chasing.

The driving complaint: prowl cats sleep on an internal timer that has nothing to
do with what the human is doing, which after years of focus mode feels like the
cats have wandered off the script. idleprowl ties their liveliness back to your
presence. As a bonus it dissolves the "they nap too much / naps are too long"
tuning problem entirely: there is no nap length to get right, they sleep for
exactly as long as you're away.

## Part 1: prowl (renamed catwalk) behavior edits

These apply to the existing mode under its new name. Nothing about the energy
budget or the 60-to-180s naps changes; only the three items below.

### 1a. Poke reactions: doze-back becomes a tail, not a reaction

Today a cat woken by a wandering sibling rolls one of four reactions at equal
odds (`poke()`): sulk-and-groom, walk off, doze back, or chase. Doze-back stops
being a standalone reaction. The immediate roll becomes **three** outcomes at
equal odds:

1. **sulk and groom**, then roll `DOZE_BACK_CHANCE` to either doze back off
   (keeping the remaining nap time) or carry on wandering;
2. **walk off** away from the offender, then the same `DOZE_BACK_CHANCE` roll;
3. **chase** the offender for `CHASE_TIME`, which fully wakes it.

Doze-back can now only happen as the tail of a sulk or a walk-off, never on its
own. Chase always wakes. When a cat does doze back, it keeps whatever nap time
was left rather than resetting the clock (as the old standalone doze-back did).

### 1b. Pointer poke: exclusive, refreshable chase

Today a pointer entering a sleeping cat's sprite box runs the same four-way
roll. In prowl the pointer poke becomes deterministic and separate from the
sibling logic:

- A pointer entering a **sleeping** cat's box always starts a chase after the
  pointer (`_chaseTarget = 'pointer'`), for `CHASE_TIME`.
- While that chase is running, the pointer re-entering the cat's box **refreshes**
  the timer to a fresh `CHASE_TIME`. So you can lead the cat around the titlebar
  by re-poking, and it only gives up once `CHASE_TIME` passes with no fresh poke.
- Only sleeping cats are grabbed. An awake, wandering cat is left to its stroll;
  the cursor grazing it does nothing. (A cat already chasing the pointer is a
  continuation of a poke, not a new grab, so it refreshes.)

Sibling poke keeps the three-reaction model from 1a. Split cleanly by who did
the poking: your cursor always gets a chase, another cat gets the drama.

### 1c. A caught chaser stops running on the spot

Bug in the current MOVE/CHASE handler: the "arrived, so stop" branch is guarded
by `State.MOVE` only, so a chaser that catches its target neither steps nor
stops. It sits there running down its chase timer while `_currentFrame()` keeps
returning the walk frames, i.e. legs pumping on the spot. Since the quarry is
usually a sibling settling into a nap at the window edge (a stationary target),
the chaser reaches it and paddles in place for up to the full `CHASE_TIME`.

Fix, in two parts:

- **A chaser only shows the run frames while it is actually closing distance.**
  Standing still (target caught) shows a settled frame.
- **Catching the target ends a sibling chase.** The chaser reaches the sibling
  at the edge, stops, and the two end up parked there together (drop into the
  normal post-move pause). A **pointer** chase does not end on catch: if you
  park the cursor on the cat it sits there settled, springs back into the run
  the moment you move, and the chase still lapses when `CHASE_TIME` runs out (or
  is refreshed by a re-poke, per 1b).

### New constant

| Constant | Default | Meaning |
|---|---|---|
| DOZE_BACK_CHANCE | 0.35 | after a sulk or walk-off, chance to doze back vs. carry on |

## Part 2: idleprowl mode

idleprowl inherits prowl's whole world: it perches on the focused window's
titlebar, pins itself to the window it fell asleep on, rides along if that
window is dragged, and wanders the bottom edge of the screen (the floor) when
there's nothing to perch on. What changes is what drives sleep.

### The mouse is the pulse

The pointer is not a movement target (idleprowl never chases it to get around).
It is an **activity signal**, sampled every tick (we already poll
`global.get_pointer()`), gated by a deadzone:

- Each cat remembers the pointer position that last counted as real movement
  (an anchor). Every tick it measures the distance from that anchor.
- Movement past `POINTER_DEADZONE` is **real activity**: it wakes the cat if
  asleep and re-anchors. Movement within the deadzone registers as nothing.

The deadzone is what lets you jiggle the mouse to keep a short screen-dim
timeout at bay without rousing the cats: an anti-dim nudge stays within the
deadzone of one spot, so they sleep straight through it. Genuine use travels
hundreds of pixels and crosses it instantly. If a pure radius proves too twitchy
in practice, the fallback is to also require the movement to be sustained across
a few ticks (filters a single sharp jerk); start with just the radius.

Activity detection is per cat off the same global pointer, so real movement
wakes them all at once, but each runs its own idle countdown and its own wake
beat, so they drift in and out of step rather than snapping in unison. No
coordinator object, consistent with the existing "cats know their siblings"
architecture.

### Awake, idle, asleep

- **Active** (pointer crossed the deadzone recently): the cat runs prowl's
  ordinary wander, minus the energy budget. Stroll to a random spot on the
  titlebar, pause, groom, yawn, and occasionally take a **short self-nap** it
  wakes itself from. It never chases the pointer to move.
- **Going idle**: once the pointer has been quiet (no deadzone crossing) for a
  per-cat spell drawn from `IDLE_MIN..IDLE_MAX`, the cat stops where it is and
  winds down through the full pre-sleep sequence (JARE, KAKI, AKUBI) into
  SLEEP, pinning itself to the current focused window like a prowl sleeper.
- **Asleep**: open-ended. An idle-sleeping cat has no nap timer; it sleeps until
  the pointer next crosses the deadzone, then wakes (AWAKE beat) and rejoins the
  wander. Walk away for an hour, it sleeps an hour. Nudge the mouse, it's up.

### Short self-naps vs. idle-sleep

Two kinds of sleep coexist, and they blend seamlessly:

- **Short self-nap**: a voluntary cat-nap during an active spell, rolled per
  pause (`SHORT_NAP_CHANCE`) with a short duration (`SHORT_NAP_MIN..MAX`). While
  the pointer stays active, the cat wakes itself when the short timer expires.
- **Idle-sleep**: the mouse-driven sleep above, no timer.

The seam: if the pointer goes idle while a cat is in a short self-nap, the short
timer simply stops mattering, the cat stays down and its nap becomes an
idle-sleep. If the pointer is still active when the short timer expires, it gets
up. One SLEEP state, two exit conditions (pointer activity always; short-nap
timer only while the pointer is active).

### The energy budget is gone here

idleprowl does not use `WANDER_ENERGY` or the 60-to-180s `NAP` at all. There is
no energy to deplete and no exhaustion sleep, because the human's activity, not
an internal clock, decides when the cats rest. Waking an idle-sleeper does not
draw a fresh energy budget (it would be unused).

### Sibling poke still applies

A wanderer brushing a sleeping sibling still triggers `poke()` with the
three-reaction model from Part 1a. In idleprowl this only fires when a wanderer
passes a sibling mid short-self-nap during an active spell, because when the
pointer is idle everyone is asleep and nobody is wandering to do the poking.
Pointer poke does **not** apply in idleprowl: any mouse movement real enough to
reach a cat has already crossed the deadzone and roused the lot, so there is
nothing left for a pointer poke to do.

### Constants

| Constant | Default | Meaning |
|---|---|---|
| IDLE_MIN / MAX | 2 s / 6 s | per-cat quiet spell before the cat settles |
| POINTER_DEADZONE | 75 px | pointer movement under this is ignored (anti-dim) |
| SHORT_NAP_MIN / MAX | 3 s / 12 s | length of a voluntary cat-nap while active |
| SHORT_NAP_CHANCE | 0.15 | per-pause chance of a short self-nap |

As with the existing catwalk constants, no new CLI flags. If tuning ever feels
necessary (the deadzone especially, since jiggle habits differ) they can be
promoted to flags later.

## Architecture

All behavior stays in `cat.js`, extending the existing state machine; no
coordinator. `extension.js` and the CLI change only where the mode strings live.

- **`cat.js`**
  - Rename `_tickCatwalk` to `_tickProwl` and `_catwalkTarget` to
    `_prowlTarget`. Both prowl and idleprowl share this brain; the mode string
    is `this._mode` (`'prowl'` or `'idleprowl'`).
  - **Pointer activity helper**: per-cat `_pointerAnchor`, `_idleTicks`, and a
    small method that, given the current pointer, returns whether real activity
    happened this tick and maintains the anchor. Used only in idleprowl.
  - **idleprowl gating** sits at the top of the shared prowl tick:
    - if idleprowl and activity happened this tick and the cat is asleep, wake
      it (no energy draw);
    - if idleprowl and the pointer has been idle past the cat's drawn
      `IDLE_MIN..MAX`, and the cat is awake and not already settling, begin the
      pre-sleep wind-down;
    - skip the energy decrement and the energy-exhaustion path entirely in
      idleprowl.
  - **SLEEP handling** gains the idleprowl exit rules: wake on pointer activity
    always; honor the short-nap timer only while the pointer is active; drop the
    fixed nap-timer expiry that prowl uses.
  - **`poke()`** splits its reaction table: pointer offender in prowl always
    chases and refreshes; sibling offender rolls the three-reaction model with
    the `DOZE_BACK_CHANCE` tail. idleprowl ignores pointer pokes.
  - **MOVE/CHASE handler and `_currentFrame()`**: a chaser shows run frames only
    while closing distance; catching a sibling ends the chase, catching the
    pointer holds and can refresh.
- **`extension.js`**
  - `_validate()`: allowed modes become `['focus', 'mouse', 'prowl',
    'idleprowl']`, with `'catwalk'` accepted and normalized to `'prowl'` on the
    way in (CLI add and restore), so old saved state and the old alias keep
    working while `cat.js` only ever sees `'prowl'`.
- **Fallback** (no usable focused window): same as prowl, awake cats wander the
  floor. An idle-sleeping cat with no window sleeps on the floor where it
  plopped.

## CLI

`bin/oneko-wayland`: `--mode` choices become `focus`, `mouse`, `prowl`,
`idleprowl`. `catwalk` is still accepted (normalized to `prowl`) so existing
scripts and the `catswalk` alias don't break; it just isn't advertised in the
help. Help text gains a line for `prowl` (was catwalk) and one for `idleprowl`.
Mode strings flow through D-Bus, persistence and restore untouched; runtime
state (idle timers, anchors, pins) is not persisted, cats wake fresh at login.

## Aliases (`~/.aliases`, dotfiles symlink)

- The existing `catswalk` alias keeps working via the back-compat alias; update
  its `--mode catwalk` to `--mode prowl` at leisure.
- New alias for the new mode, mirroring the `catswalk` example (same cast):

  ```sh
  alias catsidleprowl='oneko-wayland add Adonis      --bg gray      --fg white     --speed 14    --offset=35   --time 100000  --mode idleprowl &&
                       oneko-wayland add MrPickles   --bg orange    --fg brown     --speed 16    --offset=-35  --time 100500  --mode idleprowl &&
                       oneko-wayland add Sultana     --body white   --outline red  --speed 15    --offset-x=0  --time 100250  --mode idleprowl'
  ```

## README

- Rename the catwalk section to prowl, noting `catwalk` still works as an alias.
- Document idleprowl alongside it: prowls while you're at the machine, sleeps
  when you step away, wakes on real pointer movement (small jiggles ignored).
- Add the `catsidleprowl` example to the alias block.

## Edge cases

- **Pointer parked on a chasing cat (prowl):** shows a settled frame, not a run
  on the spot; keeps refreshing the chase while the cursor overlaps it.
- **Mouse goes idle mid-chase or mid-stroll (idleprowl):** the cat winds down
  from wherever it is; the human left, so the current errand is abandoned.
- **Short-nap timer expires while idle (idleprowl):** the cat stays asleep, its
  nap has become an idle-sleep.
- **Pinned window dragged / closed / minimized (both):** unchanged from prowl;
  ride along, or wake without a reaction roll and rejoin the focused window.
- **Anti-dim jiggle (idleprowl):** stays within `POINTER_DEADZONE`, cats sleep
  through it. A jiggle bigger than the deadzone will wake them; tune the
  constant up if that bites.
- **Old saved cats with `mode: "catwalk"`:** normalized to `prowl` on restore.

## Testing

Manual, in the nested devkit session (`--devkit`), a trio spawned per mode.

prowl edits:
1. Sibling poke produces sulk, walk-off, and chase over several trials; sulk and
   walk-off sometimes doze back off and sometimes carry on; standalone doze-back
   never occurs.
2. A chaser that catches a sibling at the edge stops instead of running on the
   spot.
3. Pointer poke on a sleeper always chases; re-poking refreshes the timer;
   parking the cursor on the cat holds a settled frame and resumes on move.
4. `--mode catwalk` still spawns a prowl cat; an old saved catwalk cat restores.

idleprowl:
5. Mouse active: cats wander, pause, groom, and take the odd short nap; never
   chase the pointer to move.
6. Mouse still for 2 to 6 s: each cat settles through the pre-sleep sequence and
   sleeps, staggered.
7. Real movement wakes them; a small in-place jiggle does not.
8. Long idle: cats stay asleep with no nap-timer wake-up.
9. Short nap interrupted by going idle turns into an idle-sleep.
10. Focus switch, window drag, window close behave as in prowl.
11. No focused window: cats wander and idle-sleep on the floor.
12. Survives extension disable/enable and a fresh login restore.

## Out of scope

- CLI flags for any of the timings or the deadzone.
- A coordinator/manager refactor of ticking (timers stay per cat).
- Persisting idle/nap/anchor state across logins.
- Cat-to-cat interactions in focus/mouse modes.
- Any change to prowl's energy budget or nap durations (idleprowl sidesteps
  them; prowl keeps them as they were).
