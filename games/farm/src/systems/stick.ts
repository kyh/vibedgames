import type { StickState } from "@vibedgames/gamepad";

/** A stick reading turned into a movement intent. */
export type StickMove = { dx: number; dy: number; run: boolean };

/** Shared stick→movement rule for the virtual (touch) stick and a physical
 *  pad's left stick: direction from the angle, full deflection (>0.95) runs —
 *  the same rule the keyboard expresses with SHIFT. Null when idle. */
export function stickMove(stick: StickState): StickMove | null {
  if (!stick.active || stick.inDeadZone) return null;
  return {
    dx: Math.cos(stick.angle),
    dy: Math.sin(stick.angle),
    run: stick.magnitude > 0.95,
  };
}
