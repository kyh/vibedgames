# First-person weapons and view models

Players compare a gun with every shooter they have played. These rules keep
it from reading as a toy.

## The model

- **Built from reference, silhouette first.** Match proportions from the
  side, top and back against photographs or the person's spec, from the
  camera players know it from, before any surface detail.
- **Small exact parts** (sights, levers, ports, screws) are modelled
  parametrically (`image-to-threejs`), or come from licensed models with the
  credit on file. A generated mesh rarely gets them right.
- **A studio render beside the reference** (neutral light, same angle and
  size), plus the in-game view as a third panel, before the weapon enters the
  game.
- **Moving parts are separate named meshes** with sockets (`muzzle`,
  `eject`, `mag`, `grip_l`, `grip_r`), so animation, effects and hands attach
  to real places.

## In view

- **One size per class**: every gun of a class covers about the same share of
  the screen at hip, aimed, sprinting and drawing, on wide, standard and phone
  aspect ratios. Rests level at hip; always in hand; clear of the HUD.
- **Render the view model in its own pass** with its own FOV (~50–60°
  vertical), its own near plane and depth, so it never clips into walls and
  world post never smears it. It never casts into the world.
- **Still when the player is still.** Sway, bob and recoil are designed
  motion with causes. Under real mouse look, camera-attached objects track the
  view exactly; any lag lives in the weapon's designed sway, never in the
  camera.
- **One complete weapon, always.** The player, bots, menus, killcams and
  pickups each show exactly one finished weapon. Never bare hands, floating
  parts or a generic stand-in, and every variant (a pickup, a menu preview, an
  upgrade) matches the loadout version in model, scale, finish and optic.
- **The first frame of play** has the chosen weapon finished, lit and at
  rest. No raise or reveal animation plays on spawn unless designed.

## Aiming

- When aimed, the rear sight, front sight and the point of impact at range
  line up through the screen centre, tops level, at the weapon's eye relief.
  No hand, sleeve or receiver sits on that line.
- **Zoom starts on the press frame**, with FOV, weapon offset and look
  sensitivity on one curve. A shot fired once the sight picture shows lands on
  the reticle. Releasing restores the hip state on the same curve.
- Bolt cycles, reloads and firing never force the player to release and press
  aim again.

## Reloads and hands

- **A reload is a sequence of named beats** for that mechanism (mag out, mag
  in, bolt release), each beat's time in one data file both the animation and
  the sound read. Empty and partial reloads differ.
- **Readable at full speed from the player's camera**: the work happens in the
  picture and lit, a hand travels into and out of every action, nothing pops.
- **Hands keep one scale and material** in every state, touch the grips
  without sinking into them, and the support hand stays on the gun.

## Numbers

- Rate of fire, aim time, swap and draw time, recoil and spread from the
  reference class, decided the same at any frame rate.
- Audit damage as **time to kill** across a run, per weapon per range.
- **Hit zones** score correctly from front, side and back; a hit marker shows
  only for scored damage.
- Firing lights the weapon for at most a frame; no heat glow unless designed.

## Random rewards

A mystery box or crate has written odds, a pity timer for the rarest result,
visible rarity on every result, weights that keep the weakest results rare,
and a reveal that is an event. Every path that grants a rare item uses the
same odds (`game-balance`).
