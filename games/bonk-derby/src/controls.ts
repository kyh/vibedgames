import type { ControlsManifest } from "@repo/embed";

export const CONTROLS: ControlsManifest = [
  { action: "go and back up", input: "W S / UP DOWN", method: "keys" },
  { action: "steer", input: "A D / LEFT RIGHT", method: "keys" },
  { action: "attack", input: "SPACE / J", method: "keys" },
  { action: "use your special", input: "E / L", method: "keys" },
  { action: "boost (hold)", input: "SHIFT / K", method: "keys" },
  { action: "mute", input: "M", method: "keys" },
  { action: "drive: up to go, across to steer", input: "DRAG", method: "touch" },
  { action: "attack", input: "HIT", method: "touch" },
  { action: "use your special", input: "ITEM", method: "touch" },
  { action: "boost (hold)", input: "BOOST", method: "touch" },
  { action: "drive: up to go, across to steer", input: "STICK", method: "controller" },
  { action: "attack", input: "A / X / RT", method: "controller" },
  { action: "use your special", input: "Y / LB", method: "controller" },
  { action: "boost (hold)", input: "B / RB / LT", method: "controller" },
];
