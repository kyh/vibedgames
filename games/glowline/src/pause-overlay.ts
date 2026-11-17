// The stock pause overlay, fed the game's controls and a short how-to-play.

import { createPauseOverlay } from "@repo/embed";

import { isMuted, setMuted } from "./audio/sfx";
import { CONTROLS } from "./controls";

export const pauseOverlay = createPauseOverlay({
  controls: CONTROLS,
  help: [
    {
      body: "Every kart lays a stripe of its own colour as it drives. Paint lasts about half a minute, and the newest coat always wins.",
      title: "Paint the road",
    },
    {
      body: "On your own colour you accelerate harder and top out faster. On anyone else's you lose grip and speed. Lap one lays your line; later laps are about riding it and wrecking theirs.",
      title: "Your glow, their slick",
    },
    {
      body: "Hold drift into a corner to slide and paint a wide stripe. The bar fills through three tiers; let go to cash the tier in as a boost.",
      title: "Drift to boost",
    },
    {
      body: "The glowing pads across the road flood the next stretch in the colour of whoever hits them first, then rest for a few seconds.",
      title: "Splat pads",
    },
  ],
  mute: { get: isMuted, set: setMuted },
});
