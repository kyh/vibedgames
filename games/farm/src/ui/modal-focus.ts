import type { Dir4 } from "@vibedgames/gamepad";

/** What a key means while a modal owns input: the game's own interact and
 *  movement keys, so a modal needs no bindings a player hasn't already learnt. */
export type ModalIntent = { kind: "confirm" } | { kind: "move"; dir: Dir4 };

const MOVE_KEYS = new Map<string, Dir4>([
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["KeyA", "left"],
  ["KeyD", "right"],
  ["KeyS", "down"],
  ["KeyW", "up"],
]);

const CONFIRM_KEYS: ReadonlySet<string> = new Set(["KeyE", "Space", "Enter", "NumpadEnter"]);

export const modalIntent = (code: string): ModalIntent | null => {
  if (CONFIRM_KEYS.has(code)) {
    return { kind: "confirm" };
  }
  const dir = MOVE_KEYS.get(code);
  return dir ? { dir, kind: "move" } : null;
};

const AXIS: Readonly<Record<Dir4, { x: number; y: number }>> = {
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
};

/** Sideways drift costs double, so a press follows its row or column before it jumps to another. */
const DRIFT_COST = 2;

/** The button a direction press lands on: the nearest one that way, or the
 *  current one when nothing lies that way (focus never wraps or gets lost). */
export const nextFocus = (
  points: readonly { x: number; y: number }[],
  current: number,
  dir: Dir4,
): number => {
  const from = points[current];
  if (!from) {
    return points.length > 0 ? 0 : -1;
  }
  const axis = AXIS[dir];
  let best = current;
  let bestCost = Infinity;
  for (const [i, p] of points.entries()) {
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const along = dx * axis.x + dy * axis.y;
    if (i === current || along <= 0.5) {
      continue;
    }
    const drift = Math.abs(dx * axis.y) + Math.abs(dy * axis.x);
    const cost = along + drift * DRIFT_COST;
    if (cost < bestCost) {
      best = i;
      bestCost = cost;
    }
  }
  return best;
};
