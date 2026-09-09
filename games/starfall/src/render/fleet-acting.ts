import { ENEMY_SPECS } from "../shared/constants";
import type { EnemyState } from "../shared/constants";
import { enemyChargeProgress } from "./charge-progress";

const IDLE_POSE = { recoil: 0, scaleX: 1, scaleY: 1 };

const RECOVERY_MS: Record<EnemyState["kind"], number> = {
  dreadnought: 340,
  drone: 220,
  lancer: 220,
  sniper: 220,
  spawner: 420,
  splitter: 220,
  warden: 220,
  wasp: 220,
};

/** Hull-only pose (recoil after a shot, squash during a windup). Aim, collider
 * and projectile origins stay authoritative; `attackAt` rides the wire so late
 * joins see the same kick. */
export const fleetPose = (
  enemy: EnemyState,
  now: number,
  chargeDuration: number,
  reduced: boolean,
) => {
  if (reduced) {
    return IDLE_POSE;
  }
  const age = now - enemy.attackAt;
  const recoveryMs = RECOVERY_MS[enemy.kind];
  if (age >= 0 && age < recoveryMs) {
    const release = (1 - age / recoveryMs) ** 2;
    return {
      recoil: Math.min(5, ENEMY_SPECS[enemy.kind].hitRadius * 0.13) * release,
      scaleX: 1 - 0.045 * release,
      scaleY: 1 + 0.045 * release,
    };
  }
  if (enemy.telegraphUntil > now) {
    const charge = enemyChargeProgress(enemy.telegraphUntil, now, chargeDuration);
    return { recoil: 0, scaleX: 1 - charge * 0.035, scaleY: 1 + charge * 0.035 };
  }
  if (enemy.kind === "lancer" && enemy.chargeUntil > now) {
    return { recoil: 0, scaleX: 1.06, scaleY: 0.96 };
  }
  return IDLE_POSE;
};

/** Same speed bands as the incoming-damage classifier. */
export const hostileShotLook = (speed: number): "lance" | "rail" | "burst" | "plasma" => {
  if (speed >= 800) {
    return "lance";
  }
  if (speed >= 600) {
    return "rail";
  }
  if (speed > 270) {
    return "burst";
  }
  return "plasma";
};
