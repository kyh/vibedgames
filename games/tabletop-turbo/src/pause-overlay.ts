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
      body: "Your bumper fires on a short cooldown and throws whatever is in front of it. It hits harder the faster you are going, so boost into a punch. Miss and the cooldown is longer.",
      title: "The bumper",
    },
    {
      body: "Each punch a car takes dents it: a dented car smokes, then sparks, and flies further. Dents wear off after a few seconds of not being hit, and a fall clears them.",
      title: "Dents",
    },
    {
      body: "The arm in the middle sweeps cars away, the pistons fire down their lit lanes, the pink bumpers bounce. Punch someone into one and the knock-off is still yours.",
      title: "The board fights too",
    },
    {
      body: "A beam of light says where the next crate lands. Mega bumper is wider and harder, long spring reaches twice as far, giant is heavy and hard to throw, turbo is boost that does not run out.",
      title: "Crates",
    },
    {
      body: "With 25 seconds left the two ends of the board blink, then fall away. Be in the middle.",
      title: "The ends drop",
    },
    {
      body: "Drive off on your own and you lose a point. If someone hit you in the last three seconds, it is theirs instead.",
      title: "Falling",
    },
  ],
  mute: { get: isMuted, set: setMuted },
});
