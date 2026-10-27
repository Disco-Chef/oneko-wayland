# idleprowl scenes: cuddle, chase, fight

Date: 2026-10-27
Status: draft, awaiting Nikos's review

## Overview

idleprowl cats currently wander, groom, nap and react to bumps one cat at a
time. This adds three **two-cat scenes** so the cats visibly have a social
life on the desktop: a **cuddle**, a **chase** (with four possible endings)
and a **fight** (old-school cartoon smoke puff). They are meant to be little
moments you catch out of the corner of your eye while working, which play out
in full without you having to babysit them.

Base: the `idleprowl` branch with the October performance and behavior fixes
(sleep stride, overview pause, paint-once frames, bump wakes in idleprowl,
300 px wake distance, 6 to 15 s idle countdown, edge-triggered hover).

## Scope

- **idleprowl only.** `prowl`, `focus` and `mouse` behave exactly as today.
- **neko only.** A scene needs both cats to be the `neko` variant drawn from
  the built-in sprites. Other animals (`dog`, `sakura`, `tomoyo`, `tora`) and
  cats using a custom `--sheet` skin never join a scene. Other animals get
  their own art later, as separate work.
- **Two cats per scene**, and a cat is in at most one scene at a time.

## Rules shared by every scene

1. **Protected window.** Each scene draws a protected window of 10 to 20 s
   when it starts. During it, nothing outside the pair affects the scene:
   pointer movement, hovers and other cats are all ignored.
2. **Pointer movement never touches scene cats**, protected or not. The
   idleprowl wake-on-movement (300 px) and the idle countdown do not apply to
   a cat while it is in a scene.
3. **After the protected window**, a scene ends on whichever comes first:
   - its **natural end**: a further 6 to 15 s (the same range as the idle
     countdown, `IDLE_MIN` to `IDLE_MAX`), so a scene lasts 16 to 35 s in all;
   - a **hover**: the pointer arriving on either cat of the pair (edge
     triggered, like today: resting the pointer there does not count again);
   - **another cat interacting**: a third cat bumping into either cat of the
     pair;
   - a scene-specific **fidget** ending, where one of the pair loses interest
     (described per scene below).
4. **Third cats** walk past a scene. During the protected window their bumps
   do nothing to the pair, and they cannot start a scene with either cat
   until it is over.
5. **After a scene**, both cats go back to ordinary idleprowl behavior. If the
   pointer has been still long enough, the normal idle countdown can then send
   them to sleep as usual.

## How scenes start

Three triggers, all idleprowl and neko only, and only for cats not already in
a scene:

- **Matching rolls.** Now and then each eligible cat rolls a number. When two
  cats hold the same number, they start a scene together. Which scene: cuddle
  or chase, at equal odds (my call). A fight only ever starts from a chase.
- **A bump.** Today a cat that walks into a sleeping idleprowl cat wakes it
  with one of three reactions (groom, walk off, chase). Cuddle becomes a
  fourth outcome, and the existing chase outcome becomes the new chase scene,
  with the woken cat as the chaser. All four at equal odds (my call).
- **A hover.** The pointer arriving on an idleprowl neko, asleep or walking,
  makes that cat the chaser in a new chase scene against another eligible
  neko, picked at random (my call). A sleeping chaser wakes first. If no other
  cat is eligible, nothing happens: idleprowl still has no wake on hover.

Rough frequency of matching rolls: my call is about one scene every few
minutes with three cats, tunable by a constant.

## Cuddle

1. The two cats walk to each other and meet on a shared spot (my call: the
   first cat's spot; the second walks over). They meet on a perch, never in
   mid-air.
2. They settle into a **yin-yang curl**: head to tail, each cat's head at the
   other's rear, with the bottom of the cats (belly, chest, legs and feet)
   facing the person at the screen.
3. While curled they show an awake curl (gentle breathing or tail flick, two
   frames). If the pointer has been still for the idle countdown, they switch
   to a dozing curl (two frames, in the style of the existing sleep frames).
4. **Fidget ending:** after the protected window, at a small chance per
   second, one cat stretches and wanders off; the other stays curled alone for
   a moment, then goes back to normal (my call).
5. Natural end, hover or another cat: both uncurl, stretch and go back to
   wandering.

## Chase

1. The chaser sets off towards the target, using the run frames. Its speed
   **ramps up in visible steps** to a cap (my call: 1.5x, 2x then 2.5x normal
   speed, one step about every half second).
2. The target does not react while it is being chased. If it is walking, it
   keeps walking and the chaser homes in on it.
3. On arrival, the target reacts:
   - **asleep target: always spooked.** It only notices at the last moment:
     a "!" bubble pops above its head and it jumps straight up with its fur
     on end, then lands.
   - **awake target:** one of three at equal odds (my call):
     - **Annoyed.** Ears flat and tail swishing, then a "HISS" speech bubble
       and a swat. The chaser says "OUCH" in a bubble and rubs its nose with
       a paw, then slinks off; the target goes back to what it was doing (my
       call).
     - **Runs away.** The target bolts the opposite way at the chaser's top
       speed for a few seconds. The chaser stops and looks puzzled (my call:
       a "?" bubble), then the scene ends.
     - **Fight.** Goes straight into the fight scene below; the chase's
       protected window carries over (my call).
4. **Fidget ending:** the chaser gives up mid-run and wanders off (my call).

## Fight

1. **Face-off:** the two cats take positions facing each other on the perch,
   about one and a half sprite widths apart.
2. **Hind legs:** both rise up on their hind legs.
3. **Bow:** both bow.
4. **Leap:** both jump towards each other.
5. **Smoke puff:** an old-school cartoon dust cloud replaces both cats. Random
   paws, tails and heads pop out of it here and there. The puff is most of the
   scene's running time.
6. **Aftermath:** the puff clears and both cats sit **dazed**, fur ruffled,
   with stars orbiting their heads, for a few seconds, then each wanders off.
7. Hover or another cat after the protected window: cut to the aftermath (my
   call).
8. **Fidget ending:** the puff clears early and one cat slinks away while the
   other sits dazed (my call).

## Art

- **Drawn by Claude, reviewed by Nikos.** Every new frame and effect is shown
  to Nikos as an enlarged PNG preview before it goes into the extension.
- **Style:** match the existing neko frames as closely as possible: 32x32,
  1-bit bitmap plus mask, recolored per cat with its body and outline colors.
- **No gore and no blood**, anywhere, including the fight.
- **Speech bubbles use pixel lettering,** drawn as bitmaps in the same blocky
  style: "!", "HISS", "OUCH" and "?". No system font. Bubble colors: black on
  white regardless of the cat's colors (my call).
- **Effects** (bubbles, orbiting stars, smoke puff and the paws, tails and
  heads popping out of it) are drawn as their own bitmaps, separate from the
  cat frames. The puff is bigger than one cat.
- **Facing:** poses that face a direction are needed facing both left and
  right. Drawing one way and mirroring is fine.

Expected new neko frames (a starting list for the builder):

| Scene | Frames |
|---|---|
| Cuddle | two-cat curl, awake (2) and dozing (2) |
| Chase | spooked jump with fur on end (2 to 3) |
| Chase | annoyed ears flat and tail swish (2), swat (1) |
| Chase | nose rub (2) |
| Fight | hind legs (1), bow (1), leap (1 to 2) |
| Fight | dazed sit with ruffled fur (1 to 2) |
| Effects | bubbles "!", "HISS", "OUCH", "?"; stars (3 to 4); puff (4 to 6); popping paw, tail, head (3 or more) |

## Constraints

- **One timer per cat, always.** Cats keep their own, deliberately desynced
  tick intervals. Never introduce a shared ticker; a scene must coordinate the
  two cats through shared scene state each cat reads on its own tick.
- **Performance.** The original complaint was a sluggish desktop. Scenes must
  not add steady per-tick cost when no scene is running, frames are painted
  once and swapped (as today), and effects follow the same rule.
- **Legacy modes untouched.** focus and mouse stay identical to the original
  oneko; the `legacy` branch keeps a pure copy.
- **Visible testing.** Smoke tests run in a visible nested shell
  (`gnome-shell --devkit`), with a temporary saved-cats folder and the
  working-tree extension, never headless.

## Non-goals

- Scenes in `prowl`, `focus` or `mouse`.
- Scenes for other animals or custom `--sheet` skins.
- Scenes with more than two cats.
- Sound.

## Anti-goals

- Gore or blood.
- A scene being cut short by ordinary mouse use.
- Art that looks out of place next to the original oneko frames.
- Any noticeable extra load on gnome-shell.

## Left to the builder

- How the matching-roll mechanic works internally, as long as it reads as
  "two cats happened to pick the same number".
- How the two-cat cuddle and the puff are rendered: one wide sprite or several
  overlapping 32x32 actors.
- Which cat's timer drives shared effects such as the puff and stars.
- Exact frame counts, timings within each scene, and the speed-ramp constants.
- A way to force a scene for testing (for example a debug D-Bus method or
  CLI command), and whether it ships.
