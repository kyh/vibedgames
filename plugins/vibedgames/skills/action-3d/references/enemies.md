# Enemies, hordes, bots and bosses

## They reach you

- **Every enemy type reaches the player from every place the player can
  stand**, measured by a test that spawns each type around the map and counts
  arrivals. Places meant to be unreachable are marked, and the player is
  moved off them.
- **Every jump, drop, climb and gap is a navigation link** the planner can
  use (off-mesh links in recast-navigation / `three-pathfinding` portals),
  including geometry the player builds during play.
- **The navigation agent matches the body** that walks it: radius, height,
  climb and slope from the controller, or the planner offers routes the body
  can't take.
- **Stuck enemies recover in small steps**: re-path, sidestep, small hop,
  then relocate, and only where no camera sees it. A stuck body the player is
  watching is never teleported.
- **Nobody idles while they know where you are.** No pacing in a small area,
  no frozen enemy, every nav region has an exit.
- **Path requests never hitch.** Budget them per frame, spread across
  frames, and cache.

## They fight

- **A new player meets enemies within seconds**, and keeps meeting them.
  The opening is survivable because early enemies die fast, not because
  they're absent.
- **Each enemy attacks on its own readable clock**: wind-up, strike,
  recovery. Several can hit at once. Damage is counted in blows to down.
- **Pace in what the player experiences**: enemies met per minute, longest
  lull, blows to down. Write targets for each and measure them from real runs.
- **The enemies-remaining number** equals alive plus still queued, every
  drawn enemy can be hit, and every hittable enemy is drawn.

## They move like bodies

- Walk and run clips play at their authored rate; speed picks the clip, the
  clip doesn't stretch to fit speed. Feet don't slide; nobody treads against a
  wall.
- The player's sprint beats the fastest chaser by a clear margin.
- **Hit reactions in place**: the upper body reacts (additive layer), and a
  push becomes real steps. Never slide sideways and snap back.
- **Deaths fall with weight and go limp**: energy weapons drop a body where
  it stands, shotguns and explosives throw it. Nothing flies off. Bodies
  never vanish in view; they sink or fade after a deadline off camera.
- No bind pose, spread arms, torn mesh or untextured body, at any LOD.
- **A crowd reads as individuals**: vary scale ±5–8%, tint, clip start time
  and playback rate. No enemy fills the first-person view.

## Bots that stand in for players

They move with purpose: peek, use cover, strafe in committed legs, aim and
miss like people (reaction delay 180–300 ms, aim that settles rather than
snaps). They never spin, clump or stand in the open, they hunt a camper,
and they use the same body, input path and senses as a player (no seeing
through walls).

AI teammates follow, fight, revive and keep up; measure their success on the
routes they actually walked, with teleports counted separately.

## Bosses

- **Every special attack is announced in time to answer it**, and the warning
  travels at the speed of the real damage (a ground marker that fills as the
  slam winds up). A skill the player already has can beat it.
- **At every moment the player knows the one current goal**, where to shoot,
  and whether the shot did anything (a hit flash on the weak point, a health
  bar that moves).
- Size boss health from the damage the expected loadout deals in each
  vulnerable window, and keep that number in one place.
- The boss breathes, shifts and reacts on every screen it appears on; feet
  stay planted; clips never slide it across the floor.
