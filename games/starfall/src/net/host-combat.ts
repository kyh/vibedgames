import type { GameScene } from "../scenes/game-scene";
import { now as simNow } from "../shared/clock";
import {
  ASTEROID_DROP_CHANCE,
  ASTEROID_MAX_RADIUS,
  BOOSTER_KINDS,
  BOSS_PHASE_MIN_MS,
  BOSS_REWARD_SHARDS,
  ELITE_HP_BASE,
  ENEMY_SPECS,
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
  eliteHpMult,
  rollLootClass,
  rollWeightedKey,
  spawnEnemyState,
  spawnItemState,
  spawnShardState,
  spawnWeaponItemState,
} from "../shared/constants";
import type { EnemyKind, ItemDrop, LootClass } from "../shared/constants";
import { rand } from "../shared/rng";
import { DEG } from "../sys/geometry";
import type { HostDirector } from "./host-director";
import { wireNum, wireStr } from "./wire-read";
import type { WireRecord } from "./wire-read";

type HostCombatScene = Pick<GameScene, "ai" | "host" | "world">;

/** Lowest HP a hit may leave the boss at. While the phase floor is `held`
 *  the current phase's lower boundary holds; afterwards one hit may only
 *  reach the TOP of the next phase. +1 keeps hp strictly above the
 *  bossPhase() f > 0.66/0.33 cut. */
export const bossHpFloor = (phase: 1 | 2 | 3, held: boolean, maxHp: number): number => {
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

/** Host-side resolution of reported hits: damage the shared asteroid/UFO/enemy, kill and split, shed shards, roll loot with per-class pity. */
export class HostCombat {
  /** Per-class pity counters (host-local, lost on migration — acceptable). */
  private lootPity = { booster: 0, shield: 0, weapon: 0 } satisfies Record<LootClass, number>;

  private readonly scene: HostCombatScene;

  constructor(scene: HostCombatScene) {
    this.scene = scene;
  }

  /** Host: apply a client's reported hit to the shared entity. */
  hostHandleHit(event: "asteroid_hit" | "ufo_hit" | "enemy_hit", p: WireRecord): void {
    const damage = wireNum(p["damage"]);
    if (damage === null) {
      return;
    }
    if (event === "ufo_hit") {
      this.hostDamageUfo(damage);
      return;
    }
    if (event === "asteroid_hit") {
      const id = wireStr(p["asteroidId"]);
      if (id !== null) {
        this.hostDamageAsteroid(id, damage);
      }
      return;
    }
    const id = wireStr(p["enemyId"]);
    if (id !== null) {
      const kx = wireNum(p["kx"]) ?? 0;
      const ky = wireNum(p["ky"]) ?? 0;
      this.hostDamageEnemy(id, damage, kx, ky);
    }
  }

  /** Host: a client claimed (consumed / picked up) a shared entity — drop it. */
  hostRemoveById<T extends { id: string }>(
    list: T[],
    id: string | null,
    field: keyof HostDirector["dirty"],
  ): void {
    if (id === null) {
      return;
    }
    const idx = list.findIndex((e) => e.id === id);
    if (idx !== -1) {
      list.splice(idx, 1);
      this.scene.host.dirty[field] = true;
    }
  }

  /** Kill XP for an enemy kind, computed at kill time. Elites pay
   *  round(base × eliteHpMult) so pts-per-second survives the durability
   *  retune; everything else (fodder, sniper, boss) pays the flat spec value.
   *  A Lv1 room pays exactly the pre-retune numbers by construction. */
  enemyKillXp(kind: EnemyKind): number {
    const base = ENEMY_SPECS[kind].xp;
    if (!ELITE_HP_BASE.has(kind)) {
      return base;
    }
    return Math.round(base * eliteHpMult(this.scene.host.maxPresentLevel()));
  }

  private hostDamageAsteroid(id: string, damage: number): void {
    const w = this.scene.world;
    const idx = w.asteroids.findIndex((a) => a.id === id);
    if (idx === -1) {
      return;
    }
    const a = w.asteroids[idx];
    if (!a) {
      return;
    }
    if (asteroidDestroyedBy(a.radius, damage)) {
      // display sweep bursts it
      w.asteroids.splice(idx, 1);
      // v3: rocks shed shards scaled by size (~r/15, 1..5) + an 11% item roll
      // (pure chance: asteroid rolls never feed or force pity).
      this.hostSpawnShards(a.x, a.y, asteroidShardCount(a.radius));
      this.hostRollLoot(a.x, a.y, ASTEROID_DROP_CHANCE, false);
    } else {
      // Radius shrink scales the drawn outline automatically (unit verts are
      // derived from the id and multiplied by radius) — no shape pop.
      const newRadius = a.radius - ASTEROID_MAX_RADIUS * Math.min(damage, 1);
      a.radius = newRadius;
      const ang = Math.atan2(a.vy, a.vx) + (rand() * 60 - 30) * DEG;
      const speed = asteroidSpeed(newRadius);
      a.vx = Math.cos(ang) * speed;
      a.vy = Math.sin(ang) * speed;
    }
    this.scene.host.dirty.asteroids = true;
  }

  private hostDamageUfo(damage: number): void {
    const u = this.scene.world.ufo;
    if (!u) {
      return;
    }
    u.hp -= damage * 100;
    u.blinkUntil = simNow() + UFO_BLINK_MS;
    if (u.hp <= 0) {
      this.scene.world.items.push(spawnWeaponItemState(u.x, u.y));
      this.scene.world.ufo = null;
      this.scene.host.dirty.items = true;
    }
    this.scene.host.dirty.ufo = true;
  }

  /** Apply reported damage + knockback; kill (split, loot) at ≤0 HP. */
  hostDamageEnemy(id: string, damageHp: number, kx: number, ky: number): void {
    const w = this.scene.world;
    const idx = w.enemies.findIndex((e) => e.id === id);
    if (idx === -1) {
      return;
    }
    const e = w.enemies[idx];
    if (!e) {
      return;
    }
    // WARDEN: heavy damage reduction while shielded; extra during the vent window.
    let dmg = damageHp;
    if (e.kind === "warden") {
      dmg *= e.shielded ? WARDEN_SHIELDED_DR : WARDEN_VENT_DR;
    }
    if (e.kind === "dreadnought") {
      // qa-009 per-phase duration floor: while the current phase is younger
      // than BOSS_PHASE_MIN_MS, damage can't cross its lower HP boundary
      // (phase 3's boundary = death). Once the window has run, one hit can
      // still only reach the TOP of the next phase — so no phase is ever
      // skipped outright, even by stacked specials in a full room.
      const sim = this.scene.ai.simFor(e.id);
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
      // qa-017: anchor the next phase's window AT the crossing hit. Without
      // this, the window only starts when a later hit's pre-damage read
      // observes the new phase — so a boss left at 1 HP mid-burst would
      // shrug the killing blow for a fresh 8s from whenever fire resumes.
      const phaseAfter = bossPhase(e.hp, e.maxHp);
      if (sim.bossPhaseSeen !== phaseAfter) {
        sim.bossPhaseSeen = phaseAfter;
        sim.bossPhaseFloorUntil = now + BOSS_PHASE_MIN_MS;
      }
    } else {
      e.hp -= dmg;
    }
    // LANCER's phases persist vx/vy, so direct knockback works; the others get
    // steering-overwritten every sim tick, so the impulse lives in the sim.
    // The boss owns its velocity too — don't let beams shove it off its orbit.
    if (e.kind === "lancer") {
      e.vx += kx;
      e.vy += ky;
    } else if (e.kind === "dreadnought") {
      // no knockback
    } else {
      const sim = this.scene.ai.simFor(e.id);
      sim.kbVx += kx;
      sim.kbVy += ky;
    }
    e.blinkUntil = simNow() + UFO_BLINK_MS;
    if (e.hp <= 0) {
      this.hostKillEnemy(idx);
    }
    this.scene.host.dirty.enemies = true;
  }

  hostKillEnemy(idx: number): void {
    const w = this.scene.world;
    const e = w.enemies[idx];
    if (!e) {
      return;
    }
    // A dying mite frees a slot in its parent's brood cap.
    const broodParent = this.scene.ai.enemySim.get(e.id)?.broodParent;
    if (broodParent) {
      const psim = this.scene.ai.enemySim.get(broodParent);
      if (psim) {
        psim.broodCount = Math.max(0, psim.broodCount - 1);
      }
    }
    w.enemies.splice(idx, 1);
    this.scene.ai.enemySim.delete(e.id);
    const now = simNow();
    if (e.kind === "dreadnought") {
      // Marquee reward: an XP fountain (past SHARDS_MAX_LIVE the oldest
      // shards on the field splice out — hostSpawnShards — so the burst
      // itself always lands whole) + two guaranteed drops. Free the
      // arena-wide slot + arm the cooldown.
      this.hostSpawnShards(e.x, e.y, BOSS_REWARD_SHARDS);
      this.hostRollLoot(e.x, e.y, 1, true);
      this.hostRollLoot(e.x, e.y, 1, true);
      this.scene.host.bossAlive = false;
      this.scene.host.lastBossKilledAt = now;
      this.scene.host.dirty.enemies = true;
      return;
    }
    if (e.kind === "splitter") {
      // Death is the attack: 3 drones pop outward, briefly harmless.
      for (let i = 0; i < SPLITTER_CHILDREN; i += 1) {
        const ang = e.angle + (Math.PI * 2 * i) / SPLITTER_CHILDREN;
        const child = spawnEnemyState("drone", e.x + Math.cos(ang) * 10, e.y + Math.sin(ang) * 10);
        child.angle = ang;
        child.vx = Math.cos(ang) * SPLITTER_CHILD_SPEED;
        child.vy = Math.sin(ang) * SPLITTER_CHILD_SPEED;
        child.graceUntil = now + SPLITTER_GRACE_MS;
        const sim = this.scene.ai.simFor(child.id);
        sim.nextAttackAt = child.graceUntil + 400;
        // children bypass the cap
        w.enemies.push(child);
      }
    }
    // v3 universal drops: fodder always sheds 1-2 score shards + a 18% item
    // roll; elites (lancer/splitter) drop a guaranteed item. UFO stays the
    // guaranteed-weapon pinata in hostDamageUfo.
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
    this.scene.host.dirty.enemies = true;
  }

  /** Spawn `count` score shards at (x,y); oldest culled past the hard cap so
   *  a swarm wipe can't flood the wire (separate array; ITEMS_MAX_LIVE
   *  untouched). */
  hostSpawnShards(x: number, y: number, count: number): void {
    const w = this.scene.world;
    for (let i = 0; i < count; i += 1) {
      w.shards.push(spawnShardState(x, y));
    }
    if (w.shards.length > SHARDS_MAX_LIVE) {
      w.shards.splice(0, w.shards.length - SHARDS_MAX_LIVE);
    }
    this.scene.host.dirty.shards = true;
  }

  /**
   * Hierarchical loot roll, v3: a per-source `chance` gates the drop (fodder
   * 18%, elites 1.0, asteroids 11%), then the class split (with per-class
   * pity when `feedPity`: enemy kills only, asteroid rolls never feed or
   * force pity) -> child table. Skipped past ITEMS_MAX_LIVE (the dry streak
   * still accrues pity); UFO drops bypass the cap.
   */
  /** `bypassCap` (UFO-drop precedent): a GUARANTEED payout — the beacon hold
   *  crystal — must never be silently skipped by the in-flight item cap. */
  hostRollLoot(x: number, y: number, chance: number, feedPity: boolean, bypassCap = false): void {
    const w = this.scene.world;
    const bumpAll = (): void => {
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
      // Ripe pity forces the drop regardless of the chance gate.
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
    this.scene.host.dirty.items = true;
  }
}
