import { now as simNow } from "../shared/clock";
import {
  ASTEROID_DROP_CHANCE,
  ASTEROID_MAX_RADIUS,
  BOOSTER_KINDS,
  BOSS_PHASE_MIN_MS,
  BOSS_REWARD_SHARDS,
  FODDER_DROP_CHANCE,
  FODDER_SHARD_MAX,
  FODDER_SHARD_MIN,
  ITEMS_MAX_LIVE,
  LOOT_BOOSTER_WEIGHTS,
  LOOT_CLASSES,
  LOOT_PITY,
  LOOT_SHIELD_WEIGHTS,
  SHARDS_MAX_LIVE,
  SHIELD_MOD_KINDS,
  SPLITTER_CHILDREN,
  SPLITTER_CHILD_SPEED,
  SPLITTER_GRACE_MS,
  UFO_BLINK_MS,
  WARDEN_SHIELDED_DR,
  WARDEN_VENT_DR,
  WEAPONS_SPECIAL,
  asteroidDestroyedBy,
  asteroidShardCount,
  asteroidSpeed,
  bossPhase,
  rollLootClass,
  rollWeightedKey,
  spawnEnemyState,
  spawnItemState,
  spawnShardState,
  spawnWeaponItemState,
} from "../shared/constants";
import type { ItemDrop, LootClass, SharedState } from "../shared/constants";
import { rand } from "../shared/rng";
import type { EnemyAi } from "../sys/enemy-ai";
import { DEG } from "../sys/geometry";
import type { HostHit } from "./intents";

/** Director state HostCombat reports into; the director is built after it. */
export interface HostCombatHooks {
  /** Frees the arena-wide boss slot and arms the spawn cooldown. */
  onBossKilled: (now: number) => void;
}

/** Lowest HP a hit may leave the boss at. While the phase floor is `held`
 *  the current phase's lower boundary holds; afterwards one hit may only
 *  reach the TOP of the next phase. +1 keeps hp strictly above the
 *  bossPhase() f > 0.66/0.33 cut. */
export const bossHpFloor = (phase: 1 | 2 | 3, held: boolean, maxHp: number) => {
  if (held) {
    if (phase === 1) {
      return 0.66 * maxHp + 1;
    }

    return phase === 2 ? 0.33 * maxHp + 1 : 1;
  }

  if (phase === 1) {
    return 0.33 * maxHp + 1;
  }

  return phase === 2 ? 1 : 0;
};

export interface HostCombatDeps {
  world: SharedState;
  ai: EnemyAi;
  hooks: HostCombatHooks;
}

/** Host-side resolution of reported hits: damage the shared asteroid/UFO/enemy, kill and split, shed shards, roll loot with per-class pity. */
export class HostCombat {
  private lootPity = { booster: 0, shield: 0, weapon: 0 } satisfies Record<LootClass, number>;

  private readonly world: SharedState;

  private readonly ai: EnemyAi;

  private readonly hooks: HostCombatHooks;

  constructor(deps: HostCombatDeps) {
    this.world = deps.world;
    this.ai = deps.ai;
    this.hooks = deps.hooks;
  }

  /** Host: apply a client's reported hit to the shared entity. */
  hostHandleHit(hit: HostHit) {
    switch (hit.kind) {
      case "ufo": {
        this.hostDamageUfo(hit.damage);
        break;
      }

      case "asteroid": {
        this.hostDamageAsteroid(hit.id, hit.damage);
        break;
      }

      case "enemy": {
        this.hostDamageEnemy(hit.id, hit.damage, hit.kx, hit.ky);
        break;
      }

      default: {
        hit satisfies never;
      }
    }
  }

  private hostDamageAsteroid(id: string, damage: number) {
    const w = this.world;
    const idx = w.asteroids.findIndex((a) => a.id === id);

    if (idx === -1) {
      return;
    }

    const a = w.asteroids[idx];

    if (!a) {
      return;
    }

    if (asteroidDestroyedBy(a.radius, damage)) {
      w.asteroids.splice(idx, 1);
      this.hostSpawnShards(a.x, a.y, asteroidShardCount(a.radius));
      this.hostRollLoot(a.x, a.y, ASTEROID_DROP_CHANCE, false);
    } else {
      const newRadius = a.radius - ASTEROID_MAX_RADIUS * Math.min(damage, 1);
      a.radius = newRadius;
      const ang = Math.atan2(a.vy, a.vx) + (rand() * 60 - 30) * DEG;
      const speed = asteroidSpeed(newRadius);
      a.vx = Math.cos(ang) * speed;
      a.vy = Math.sin(ang) * speed;
    }
  }

  private hostDamageUfo(damage: number) {
    const u = this.world.ufo;

    if (!u) {
      return;
    }

    u.hp -= damage * 100;
    u.blinkUntil = simNow() + UFO_BLINK_MS;

    if (u.hp <= 0) {
      this.world.items.push(spawnWeaponItemState(u.x, u.y));
      this.world.ufo = null;
    }
  }

  /** Apply reported damage + knockback; kill (split, loot) at ≤0 HP. */
  hostDamageEnemy(id: string, damageHp: number, kx: number, ky: number) {
    const w = this.world;
    const idx = w.enemies.findIndex((e) => e.id === id);

    if (idx === -1) {
      return;
    }

    const e = w.enemies[idx];

    if (!e) {
      return;
    }

    let dmg = damageHp;

    if (e.kind === "warden") {
      dmg *= e.shielded ? WARDEN_SHIELDED_DR : WARDEN_VENT_DR;
    }

    if (e.kind === "dreadnought") {
      const sim = this.ai.simFor(e.id);
      const now = simNow();
      const phase = bossPhase(e.hp, e.maxHp);

      if (sim.bossPhaseSeen !== phase) {
        sim.bossPhaseSeen = phase;
        sim.bossPhaseFloorUntil = now + BOSS_PHASE_MIN_MS;
      }

      const held = now < sim.bossPhaseFloorUntil;
      e.hp -= dmg;
      const floorHp = bossHpFloor(phase, held, e.maxHp);

      if (e.hp < floorHp) {
        e.hp = floorHp;
      }

      const phaseAfter = bossPhase(e.hp, e.maxHp);

      if (sim.bossPhaseSeen !== phaseAfter) {
        sim.bossPhaseSeen = phaseAfter;
        sim.bossPhaseFloorUntil = now + BOSS_PHASE_MIN_MS;
      }
    } else {
      e.hp -= dmg;
    }

    if (e.kind === "lancer") {
      e.vx += kx;
      e.vy += ky;
    } else if (e.kind === "dreadnought") {
    } else {
      const sim = this.ai.simFor(e.id);
      sim.kbVx += kx;
      sim.kbVy += ky;
    }

    e.blinkUntil = simNow() + UFO_BLINK_MS;

    if (e.hp <= 0) {
      this.hostKillEnemy(idx);
    }
  }

  hostKillEnemy(idx: number) {
    const w = this.world;
    const e = w.enemies[idx];

    if (!e) {
      return;
    }

    const broodParent = this.ai.enemySim.get(e.id)?.broodParent;

    if (broodParent) {
      const psim = this.ai.enemySim.get(broodParent);

      if (psim) {
        psim.broodCount = Math.max(0, psim.broodCount - 1);
      }
    }

    w.enemies.splice(idx, 1);
    this.ai.enemySim.delete(e.id);
    const now = simNow();

    if (e.kind === "dreadnought") {
      this.hostSpawnShards(e.x, e.y, BOSS_REWARD_SHARDS);
      this.hostRollLoot(e.x, e.y, 1, true);
      this.hostRollLoot(e.x, e.y, 1, true);
      this.hooks.onBossKilled(now);

      return;
    }

    if (e.kind === "splitter") {
      for (let i = 0; i < SPLITTER_CHILDREN; i += 1) {
        const ang = e.angle + (Math.PI * 2 * i) / SPLITTER_CHILDREN;
        const child = spawnEnemyState("drone", e.x + Math.cos(ang) * 10, e.y + Math.sin(ang) * 10);
        child.angle = ang;
        child.vx = Math.cos(ang) * SPLITTER_CHILD_SPEED;
        child.vy = Math.sin(ang) * SPLITTER_CHILD_SPEED;
        child.graceUntil = now + SPLITTER_GRACE_MS;
        const sim = this.ai.simFor(child.id);
        sim.nextAttackAt = child.graceUntil + 400;
        w.enemies.push(child);
      }
    }

    if (e.kind === "drone" || e.kind === "wasp") {
      this.hostSpawnShards(
        e.x,
        e.y,
        FODDER_SHARD_MIN + Math.floor(rand() * (FODDER_SHARD_MAX - FODDER_SHARD_MIN + 1)),
      );
      this.hostRollLoot(e.x, e.y, FODDER_DROP_CHANCE, true);
    } else {
      this.hostRollLoot(e.x, e.y, 1, true);
    }
  }

  /** Spawn `count` score shards at (x,y); oldest culled past the hard cap so
   *  a swarm wipe can't flood the wire (separate array; ITEMS_MAX_LIVE
   *  untouched). */
  hostSpawnShards(x: number, y: number, count: number) {
    const w = this.world;

    for (let i = 0; i < count; i += 1) {
      w.shards.push(spawnShardState(x, y));
    }

    if (w.shards.length > SHARDS_MAX_LIVE) {
      w.shards.splice(0, w.shards.length - SHARDS_MAX_LIVE);
    }
  }

  /** `bypassCap` (UFO-drop precedent): a GUARANTEED payout — the beacon hold
   *  crystal — must never be silently skipped by the in-flight item cap. */
  hostRollLoot(x: number, y: number, chance: number, feedPity: boolean, bypassCap = false) {
    const w = this.world;

    const bumpAll = () => {
      if (!feedPity) {
        return;
      }

      for (const c of LOOT_CLASSES) {
        this.lootPity[c] += 1;
      }
    };

    if (!bypassCap && w.items.length >= ITEMS_MAX_LIVE) {
      bumpAll();

      return;
    }

    let cls: LootClass | null = null;

    if (feedPity) {
      if (this.lootPity.shield >= LOOT_PITY.shield) {
        cls = "shield";
      } else if (this.lootPity.booster >= LOOT_PITY.booster) {
        cls = "booster";
      } else if (this.lootPity.weapon >= LOOT_PITY.weapon) {
        cls = "weapon";
      }
    }

    if (!cls && rand() >= chance) {
      bumpAll();

      return;
    }

    if (!cls) {
      cls = rollLootClass();
    }

    if (feedPity) {
      for (const c of LOOT_CLASSES) {
        if (c === cls) {
          this.lootPity[c] = 0;
        } else {
          this.lootPity[c] += 1;
        }
      }
    }

    let drop: ItemDrop;

    if (cls === "shield") {
      drop = {
        kind: "shield",
        shieldIdx: SHIELD_MOD_KINDS.indexOf(rollWeightedKey(LOOT_SHIELD_WEIGHTS)),
      };
    } else if (cls === "booster") {
      drop = {
        boosterIdx: BOOSTER_KINDS.indexOf(rollWeightedKey(LOOT_BOOSTER_WEIGHTS)),
        kind: "booster",
      };
    } else {
      drop = { kind: "weapon", weaponIdx: Math.floor(rand() * WEAPONS_SPECIAL.length) };
    }

    w.items.push(spawnItemState(x, y, drop));
  }
}
