import {
  BOSS_P1_TELEGRAPH_MS,
  BOSS_P2_AIM_MS,
  BOSS_P3_TELEGRAPH_MS,
  bossPhase,
  DRONE_TELEGRAPH_MS,
  LANCER_WINDUP_MS,
  SNIPER_AIM_MS,
  SPAWNER_TELEGRAPH_MS,
  WARDEN_TELEGRAPH_MS,
  WASP_TELEGRAPH_MS,
  type EnemyState,
} from "../shared/constants";

/** Read once per new warning deadline. Boss lances can outlive their phase;
 * phase at warning start owns the duration, even if HP changes mid-charge. */
export function enemyChargeDuration(enemy: EnemyState): number {
  switch (enemy.kind) {
    case "drone":
      return DRONE_TELEGRAPH_MS;
    case "wasp":
      return WASP_TELEGRAPH_MS;
    case "lancer":
      return LANCER_WINDUP_MS;
    case "warden":
      return WARDEN_TELEGRAPH_MS;
    case "sniper":
      return SNIPER_AIM_MS;
    case "spawner":
      return SPAWNER_TELEGRAPH_MS;
    case "dreadnought":
      return bossPhase(enemy.hp, enemy.maxHp) === 2
        ? BOSS_P2_AIM_MS
        : bossPhase(enemy.hp, enemy.maxHp) === 3
          ? BOSS_P3_TELEGRAPH_MS
          : BOSS_P1_TELEGRAPH_MS;
    case "splitter":
      return 0;
  }
}

/** Rendering only: never recalculate aim or move the host's deadline. */
export function enemyChargeProgress(deadline: number, now: number, duration: number): number {
  return duration > 0 ? Math.max(0, Math.min(1, 1 - (deadline - now) / duration)) : 0;
}

/** The host selects the firing pattern from current HP, even during a charge.
 * Cached timing cannot keep a stale lance warning over an upcoming nova. */
export function usesLockedAim(enemy: EnemyState): boolean {
  return (
    enemy.kind === "sniper" ||
    (enemy.kind === "dreadnought" && bossPhase(enemy.hp, enemy.maxHp) === 2)
  );
}
