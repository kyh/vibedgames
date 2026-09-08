import { ENEMY_SPECS, type EnemyState } from "../shared/constants";
import { enemyChargeProgress } from "./charge-progress";

/** Hull-only pose. Accepted attack time survives late joins without replaying
 * a fresh kick; aim, collider and projectile origins stay authoritative. */
export function fleetPose(
  enemy: EnemyState,
  now: number,
  chargeDuration: number,
  reduced: boolean,
) {
  const idle = { recoil: 0, scaleX: 1, scaleY: 1 };
  if (reduced) return idle;
  const age = now - (enemy.attackAt ?? -Infinity);
  const recoveryMs = enemy.kind === "dreadnought" ? 340 : enemy.kind === "spawner" ? 420 : 220;
  if (age >= 0 && age < recoveryMs) {
    const release = Math.pow(1 - age / recoveryMs, 2);
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
  if (enemy.kind === "lancer" && enemy.chargeUntil > now)
    return { recoil: 0, scaleX: 1.06, scaleY: 0.96 };
  return idle;
}

const TRAIL_INTERVAL_MS = 1000 / 60;

/** Sim time owns emission. Long gaps skip backlog; paused frames emit nothing. */
export function chargeTrail(nextAt: number | null, now: number, active: boolean) {
  if (!active) return { nextAt: null, count: 0 };
  const dueAt = nextAt ?? now;
  const due = Math.max(0, Math.floor((now - dueAt) / TRAIL_INTERVAL_MS + 1e-7) + 1);
  return { nextAt: dueAt + due * TRAIL_INTERVAL_MS, count: Math.min(3, due) };
}

/** Same speed bands as the existing damage classifier; no guessed shooter. */
export function hostileShotLook(speed: number): "lance" | "rail" | "burst" | "plasma" {
  if (speed >= 800) return "lance";
  if (speed >= 600) return "rail";
  if (speed > 270) return "burst";
  return "plasma";
}
