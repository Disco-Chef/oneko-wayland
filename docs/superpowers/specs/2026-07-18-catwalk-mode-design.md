# Catwalk mode

Date: 2026-07-18
Status: agreed, awaiting implementation plan

## Overview

A third cat mode, `catwalk`, joining `focus` and `mouse`. Catwalk cats live on
the focused window's titlebar like focus-mode cats, but they do not chase the
pointer. Each cat strolls left and right on its own schedule, pauses, sometimes
grooms, and takes long naps. A cat that wanders up to a sleeping sibling wakes
it, with consequences. Strut, snooze, repeat: the titlebar is their runway.

## Behavior model

Each catwalk cat runs this loop, independently of its siblings:

- **Wander.** Pick a random destination x along the focused window's titlebar
  (within the window's left/right corners), walk there at the cat's normal
  speed, and pause on arrival for a couple of seconds.
- **Pauses.** A pause is the existing STOP state and may include the classic
  grooming animations (JARE, KAKI). Each pause also rolls a small chance
  (EARLY_NAP_CHANCE) to turn into a full nap ahead of schedule.
- **Energy budget.** On spawn, and after every nap, the cat draws a waking
  allowance from WANDER_ENERGY_MIN..MAX. When it runs out, the cat settles
  through the full pre-sleep sequence (JARE, KAKI, AKUBI) and falls asleep.
- **Nap.** Sleep duration is drawn from NAP_MIN..MAX. The sleeper pins itself
  to the window it fell asleep on: it stays on that titlebar even when focus
  moves elsewhere, and rides along if the window is dragged. Awake cats always
  wander the currently focused window.
- **Waking.** A sleeper wakes when any of these happens:
  1. its nap timer runs out (natural waking);
  2. a wandering sibling comes within WAKE_RADIUS (rude);
  3. the pointer enters its sprite box, i.e. a poke (rude);
  4. its pinned window is closed or minimized (no reaction roll, just AWAKE,
     then it rejoins the focused window).
- **Rude waking reactions.** On a rude waking the cat rolls one of four
  reactions, equal odds:
  1. startle (AWAKE frame), a short grooming sulk, then resume wandering;
  2. get up and walk off away from the offender, then resume the normal cycle;
  3. look around and doze back off, keeping the remaining nap time;
  4. chase the offender for CHASE_TIME (the sibling that woke it, or the
     pointer if the poke came from the pointer), then resume the normal cycle.
- Every waking except reaction 3 grants a fresh energy budget and moves the
  cat's attention back to the focused window. Chain reactions (a woken cat
  waking further sleepers) are allowed and, frankly, the point.

## Constants

All timings live as named constants in `cat.js`, next to the existing oneko
ones (STOP_TIME, JARE_TIME, ...), expressed in ticks derived from the cat's
tick interval so `--time` scales the whole personality:

| Constant | Default | Meaning |
|---|---|---|
| WANDER_ENERGY_MIN / MAX | 20 s / 40 s | waking allowance per cycle |
| NAP_MIN / MAX | 60 s / 180 s | nap duration |
| EARLY_NAP_CHANCE | 0.15 | per-pause chance to nap early |
| WAKE_RADIUS | 1.5 sprite widths | how close a sibling must get to wake a sleeper |
| CHASE_TIME | 5 s | how long a chase reaction lasts |

No new CLI flags for these. If tuning ever feels necessary they can be
promoted to flags later.

## Architecture

Approach: cats get to know their siblings; all behavior stays in `cat.js` as
an extension of the existing state machine. No coordinator object.

- **`extension.js`**
  - `_validate()`: allowed modes become `['focus', 'mouse', 'catwalk']`.
  - `_spawn()`: pass a siblings accessor, `() => [...this._cats.values()]`,
    into the `Cat` constructor.
- **`cat.js`**
  - New state `CHASE` in the `State` enum. STOP doubles as the wander pause.
  - New per-cat fields: `_energy` (remaining waking ticks), `_napUntil`
    (remaining nap ticks), `_napPlanned` (whether the current groom chain ends
    in sleep), `_pinnedWindow` plus the x offset from its frame origin, and
    `_wanderTarget`.
  - `_target()` gets a third branch: catwalk cats return their current wander
    destination on the focused window's titlebar (or their pinned window's,
    while asleep) instead of anything pointer-derived.
  - A `poke(offender)` method: called on a sleeping cat by a wandering sibling
    that gets within WAKE_RADIUS during its `_tick()`, or triggered by the
    pointer entering the sprite box. The sleeper decides its own reaction.
    With MAX_CATS = 6 the proximity scan is at most 5 distance checks per cat
    per tick.
  - `--offset-x` is ignored in catwalk mode (destinations are random, offsets
    exist to keep focus-mode cats from stacking). `--offset-y` still applies,
    so a cat can be sunk onto the bar. `--catch-distance` still decides
    arrival; `--wake-distance` is unused (movement is self-directed).
- **Fallback.** No usable focused window (desktop, everything minimized):
  awake cats wander along the bottom edge of the screen, the floor. Focus
  mode's fallback (chase the pointer) would contradict this mode's spirit.

## CLI

`bin/oneko-wayland`: add `catwalk` to the `--mode` choices and mention it in
the help text. The mode string already flows through D-Bus, persistence and
restore untouched. Runtime state (energy, nap timers, pins) is not persisted;
cats wake up fresh at login like the rest of us pretend to.

## Aliases (`~/.aliases`, dotfiles symlink)

- New alias, next to its siblings:

  ```sh
  alias catswalk='oneko-wayland add Adonis      --bg gray      --fg white     --speed 14    --offset=35   --time 100000  --mode catwalk &&
                  oneko-wayland add MrPickles   --bg orange    --fg brown     --speed 16    --offset=-35  --time 100500  --mode catwalk &&
                  oneko-wayland add Sultana     --body white   --outline red  --speed 15    --offset-x=0  --time 100250  --mode catwalk'
  ```

- Fix: Sultana inside `catsmouse` says `--mode focus`; change to
  `--mode mouse` (confirmed slip, not a design choice).

## README

- Document the catwalk mode alongside focus and mouse, and add `catswalk` to
  the alias example block.
- Recolor the standalone examples to Sultana's scheme, `--body white
  --outline red`: Pickles (the quick-start example and the recoloring
  example) and Rex (who keeps `--animal dog`; the variants are 1-bit bitmaps,
  so the recoloring genuinely applies to him too). Stripes passes no colors
  and stays as is.

## Edge cases

- **Pinned window dragged:** the sleeper re-reads `get_frame_rect()` each tick
  and rides along at the same offset from the window's origin.
- **Pinned window closed/minimized:** wake without a reaction roll, rejoin the
  focused window.
- **Focus changes:** sleepers stay put on their pinned window; awake cats pick
  their next wander destination on the newly focused window.
- **Stacked sleepers:** overlap is allowed, cats are liquids. A "walk off"
  reaction picks a direction away from the offender.
- **Overview:** already handled; the whole cat group hides.
- **Pointer poke vs. name tag:** the poke check reuses the same sprite-box
  test as the hover label, so poking a sleeper also shows its name. Fitting:
  you would say its name while poking it.

## Testing

Manual, in the nested devkit session (`--devkit`), with the trio spawned in
catwalk mode:

1. Wandering stays within the titlebar's horizontal bounds.
2. Pauses occasionally deepen into naps; energy exhaustion always does.
3. A wanderer waking a sleeper produces each of the four reactions over
   several trials, chase included, and chase disengages after CHASE_TIME.
4. Pointer poke wakes a sleeper.
5. Focus switch: sleepers stay behind, wanderers migrate.
6. Dragging the pinned window carries the sleeper along.
7. Closing the pinned window sends the sleeper to the focused window.
8. No focused window: cats wander the bottom edge.
9. Survives extension disable/enable and a fresh login restore.
10. `catsmouse` now sends all three cats after the pointer.

## Out of scope

- CLI flags for catwalk timings.
- A coordinator/manager refactor of ticking (six timers stay six timers).
- Persisting nap/energy state across logins.
- Cat-to-cat interactions in focus/mouse modes.
