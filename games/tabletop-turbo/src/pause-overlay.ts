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
      body: "The chevron pads across the road lay three fat stripes of your colour for whoever hits them first, then rest for a few seconds.",
      title: "Splat pads",
    },
    {
      body: "Each glow orb adds a little top speed, up to ten. A spin-out costs you three.",
      title: "Orbs",
    },
    {
      body: "Boxes hold one item. Turbo is a long boost. The paint bomb lands ahead, splats your colour and spins whoever is under it. Solvent strips rival paint around you and makes you immune to slick for a few seconds. The blot is a puddle you leave behind. The further back you are, the better the roll.",
      title: "Items",
    },
    {
      body: "Press the gas in the last beat before the lights go green for a rocket start. On touch, hold DRIFT instead.",
      title: "Rocket start",
    },
  ],
  mute: { get: isMuted, set: setMuted },
});
