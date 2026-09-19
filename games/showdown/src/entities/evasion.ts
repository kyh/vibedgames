import { BRAWLER_RADIUS } from "../config";
import type { BrawlerId } from "../config";
import type { Position } from "../world/collision";

export interface EvasionState {
  angle: number;
  elapsed: number;
}

export const EVADE = {
  cooldown: 2.4,
  distance: 3,
  duration: 0.36,
  invulnerable: 0.24,
};

export type EvadeStyle = "roll" | "dash" | "blink";

export const evadeStyle = (id: BrawlerId): EvadeStyle => {
  switch (id) {
    case "dusty":
    case "titan": {
      return "dash";
    }
    case "fuse":
    case "nyx":
    case "moss": {
      return "blink";
    }
    case "ace":
    case "rowan":
    case "flint":
    case "pip": {
      return "roll";
    }
    default: {
      const unreachable: never = id;
      throw new Error(`Unknown evade style: ${unreachable}`);
    }
  }
};

export const createEvasion = (dx: number, dz: number, facing: number): EvasionState => ({
  angle:
    Math.hypot(dx, dz) > 0.001
      ? Math.atan2(dx, dz)
      : Math.atan2(Math.sin(facing), Math.cos(facing)),
  elapsed: 0,
});

export const evasionInvulnerable = (state: EvasionState | null): boolean =>
  state !== null && state.elapsed < EVADE.invulnerable;

interface EvasionWorld {
  heightAt: (x: number, z: number) => number;
  resolveCircle: (position: Position, radius: number) => void;
}

/** Short collision steps keep even a low-frame-rate blink on walkable ground. */
export const advanceEvasion = (
  state: EvasionState,
  position: Position & { y: number },
  world: EvasionWorld,
  dt: number,
): boolean => {
  const time = Math.max(0, Math.min(dt, EVADE.duration - state.elapsed));
  let remaining = (time / EVADE.duration) * EVADE.distance;
  const dx = Math.sin(state.angle);
  const dz = Math.cos(state.angle);
  while (remaining > 0) {
    const step = Math.min(remaining, 0.12);
    remaining -= step;
    position.x += dx * step;
    position.z += dz * step;
    world.resolveCircle(position, BRAWLER_RADIUS);
  }
  position.y = world.heightAt(position.x, position.z);
  state.elapsed = Math.min(EVADE.duration, state.elapsed + time);
  return state.elapsed >= EVADE.duration;
};
