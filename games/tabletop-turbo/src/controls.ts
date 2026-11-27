import type { ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "drive (the way you point)", input: "W A S D / ARROWS", method: "keys" },
  { action: "fire the bumper", input: "SPACE / J", method: "keys" },
  { action: "boost (hold)", input: "SHIFT / K", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "drive (the way you point)", input: "DRAG", method: "touch" },
  { action: "fire the bumper", input: "PUNCH", method: "touch" },
  { action: "boost (hold)", input: "BOOST", method: "touch" },
  { action: "drive (the way you point)", input: "STICK", method: "controller" },
  { action: "fire the bumper", input: "A / X / RT", method: "controller" },
  { action: "boost (hold)", input: "B / RB / LT", method: "controller" },
];
