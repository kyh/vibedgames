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
} from "../shared/constants";
import type { EnemyState } from "../shared/constants";

const CHARGE_DURATION_MS: Record<Exclude<EnemyState["kind"], "dreadnought">, number> = {
  drone: DRONE_TELEGRAPH_MS,
  lancer: LANCER_WINDUP_MS,
  sniper: SNIPER_AIM_MS,
  spawner: SPAWNER_TELEGRAPH_MS,
  splitter: 0,
  warden: WARDEN_TELEGRAPH_MS,
  wasp: WASP_TELEGRAPH_MS,
};

const bossChargeDuration = (phase: number): number => {
  if (phase === 2) {
    return BOSS_P2_AIM_MS;
  }
  if (phase === 3) {
    return BOSS_P3_TELEGRAPH_MS;
  }
  return BOSS_P1_TELEGRAPH_MS;
};

/** Read once per new warning deadline: the boss phase at warning start owns
 * the duration, even if HP crosses a phase threshold mid-charge. */
export const enemyChargeDuration = (enemy: EnemyState): number => {
  if (enemy.kind === "dreadnought") {
    return bossChargeDuration(bossPhase(enemy.hp, enemy.maxHp));
  }
  return CHARGE_DURATION_MS[enemy.kind];
};

/** 0→1 across the windup; rendering only, the host's deadline is never moved. */
export const enemyChargeProgress = (deadline: number, now: number, duration: number): number =>
  duration > 0 ? Math.max(0, Math.min(1, 1 - (deadline - now) / duration)) : 0;

/** Sniper and the boss's phase 2 aim locked lances at the warning start. */
export const usesLockedAim = (enemy: EnemyState): boolean =>
  enemy.kind === "sniper" ||
  (enemy.kind === "dreadnought" && bossPhase(enemy.hp, enemy.maxHp) === 2);
