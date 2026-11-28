import { createPauseOverlay } from "@repo/embed";

import { isMuted, setMuted } from "./audio/sfx";
import { CONTROLS } from "./controls";

export const pauseOverlay = createPauseOverlay({
  controls: CONTROLS,
  help: [
    {
      body: "Eight cars on a board with no walls. Knock the others over the edge, or into a hole. Every knock-off is a point; most points when the clock runs out wins.",
      title: "Knock them off",
    },
    {
      body: "Six cars, six attacks. Bumper punches ahead, Dart lunges through, Brick hops and slams, Popper fires a puck, Scoop flips cars over its roof, Twister bats away everything near. Fast cars are light and fly far; heavy ones hit hard and turn slow.",
      title: "Your car",
    },
    {
      body: "Every hit adds to a car's damage, and the more it carries the further the next hit throws it. A car at 100% is one good hit from the edge. A fall puts it back to zero.",
      title: "Damage",
    },
    {
      body: "Drive over a power cube to take a special. You carry one at a time: use it to pick up another. Rockets, seekers, mines, oil, a shockwave, a magnet, a zap, a shield, giant, turbo, a wrench that clears your damage, a spring that stomps.",
      title: "Power cubes",
    },
    {
      body: "The arm in the middle sweeps cars away, the pistons fire down their lit lanes, the pink bumpers bounce. Knock someone into one and the knock-off is still yours.",
      title: "The board fights too",
    },
    {
      body: "With 35 seconds left the rim of the board blinks, then falls away, and every knock-off is worth two. Be in the middle.",
      title: "The rim drops",
    },
    {
      body: "Drive off on your own and you lose a point. If someone hit you in the last few seconds, it is theirs instead.",
      title: "Falling",
    },
  ],
  mute: { get: isMuted, set: setMuted },
});
