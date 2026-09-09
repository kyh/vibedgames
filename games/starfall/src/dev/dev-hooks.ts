import type { MultiplayerClient } from "@vibedgames/multiplayer";
import { kindIndex } from "../net/wire-read";
import type { GameScene } from "../scenes/game-scene";
import { now as simNow } from "../shared/clock";
import {
  BOOSTER_KINDS,
  BOOSTER_SPECS,
  ELITE_HP_BASE,
  OVERSHIELD_BONUS,
  SHIELD_MAX,
  SHIELD_MOD_DURATION_MS,
  SHIELD_MOD_KINDS,
  SIPHON_OVERHEAL_MAX,
  SPECIAL_WEAPON_DURATION_MS,
  WEAPONS_SPECIAL,
  arenaIntensity,
  eliteHp,
  scaleWeaponForLevel,
  sectorIdx,
  sectorRelT,
  spawnEnemyState,
  spawnItemState,
  xpToNext,
} from "../shared/constants";
import type {
  BoostNetState,
  EnemyKind,
  ItemDrop,
  ItemState,
  ShieldModKind,
} from "../shared/constants";

/** DEV-only driving surface on `window.__starfall`: headless reviewers and the two-client harness poke the game through these. */

/** Diag snapshot surfaced to headless reviewers via `__starfall.summary()`. */
export interface StarfallSummary {
  alive: boolean;
  level: number;
  xp: number;
  runXp: number;
  xpToNext: number;
  streak: number;
  weapon: string;
  weaponUntil: number;
  windup: number;
  shieldHp: number;
  overHp: number;
  regen: boolean;
  mod: { kind: ShieldModKind; until: number } | null;
  boosts: BoostNetState[];
  mines: number;
  sentry: { x: number; y: number } | null;
  pulls: number;
  enemies: EnemyKind[];
  enemyShots: number;
  asteroids: number;
  items: ItemState["kind"][];
  shards: number;
  beams: number;
  isHost: boolean;
  intensity: number;
  now: number;
  recovery: { remainingMs: number; protectionMs: number; recapUntil: number };
  sector: { idx: number; rel: number; score: number; best: number; bossIdx: number };
}

/** The dev-only driving hooks installed on `window.__starfall` (DEV builds
 *  only — headless reviewers poke the game through these). */
export interface StarfallDevHooks {
  scene: GameScene;
  client: MultiplayerClient;
  spawnEnemy: (kind: EnemyKind, x?: number, y?: number) => string | null;
  damageEnemy: (id: string, amount: number) => number | null;
  grantShield: (raw: string) => void;
  grantBooster: (raw: string) => void;
  setShield: (hp: number) => void;
  damage: (amount: number) => string;
  grantWeapon: (ref: number | string) => void;
  spawnItem: (cls: "weapon" | "shield" | "booster", name: string, x?: number, y?: number) => void;
  dropShards: (count: number, x?: number, y?: number) => void;
  fire: () => void;
  spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number) => boolean;
  setArenaEpoch: (epochMs: number) => void;
  intensity: () => number;
  summary: () => StarfallSummary;
}

declare global {
  interface Window {
    __starfall?: StarfallDevHooks;
  }
}

export const installDevHooks = (scene: GameScene): void => {
  if (!import.meta.env.DEV) {
    return;
  }
  window.__starfall = {
    client: scene.client,
    /** Run a drain through the real applyDamage pipeline. */
    damage: (amount: number): string =>
      scene.shield.applyDamage(amount, scene.shipX + 12, scene.shipY, "DEV", null, simNow()),
    /** Host only: run damage through the real hostDamageEnemy pipeline
     *  (warden DR, boss phase floors, kill/loot). Returns the enemy's
     *  post-damage hp, or null if it died/never existed. */
    damageEnemy: (id: string, amount: number): number | null => {
      if (!scene.amHost) {
        return null;
      }
      scene.hostCombat.hostDamageEnemy(id, amount, 0, 0);
      return scene.world.enemies.find((e) => e.id === id)?.hp ?? null;
    },
    /** Host only: shed score shards near the ship. */
    dropShards: (count: number, x?: number, y?: number): void => {
      if (!scene.amHost) {
        return;
      }
      scene.hostCombat.hostSpawnShards(x ?? scene.shipX + 120, y ?? scene.shipY, count);
    },
    /** Fire one volley of the current weapon, no pointer needed. */
    fire: (): void => {
      scene.weapons.fireWeapon(simNow());
    },
    /** Grant a booster by kind name (repair applies instantly). */
    grantBooster: (raw: string): void => {
      const kind = BOOSTER_KINDS.find((k) => k === raw.toLowerCase());
      if (!kind) {
        return;
      }
      if (kind === "repair") {
        scene.shield.shieldHp = Math.max(scene.shield.shieldHp, SHIELD_MAX);
        scene.shield.lastDamageAt = 0;
      } else {
        scene.boosts.set(kind, simNow() + BOOSTER_SPECS[kind].durationMs);
      }
    },
    /** Grant a shield MOD by kind name (validated — bad kinds are ignored). */
    grantShield: (raw: string): void => {
      const lowered = raw.toLowerCase();
      const kind = SHIELD_MOD_KINDS.find((k) => k === lowered);
      if (!kind) {
        return;
      }
      const now = simNow();
      scene.shield.shieldMod = kind;
      scene.shield.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
      scene.shield.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
      scene.shield.phaseReadyAt = 0;
    },
    grantWeapon: (ref: number | string): void => {
      // One pass covers both call shapes: a number ref matches its index
      // (never a name), a string ref matches its name (never an index).
      const weapon = WEAPONS_SPECIAL.find((w, i) => w.name === ref || i === ref);
      if (!weapon) {
        return;
      }
      scene.specialBase = weapon;
      scene.weapon = scaleWeaponForLevel(weapon, scene.progress.level);
      scene.weaponUntil = simNow() + SPECIAL_WEAPON_DURATION_MS;
      scene.weapons.windupAcc = 0;
    },
    intensity: (): number =>
      arenaIntensity(Math.max(0, (simNow() - scene.world.arenaEpoch) / 1000)),
    scene,
    /** Host only: rewind/forward the intensity director. */
    setArenaEpoch: (epochMs: number): void => {
      if (!scene.amHost) {
        return;
      }
      scene.world.arenaEpoch = epochMs;
      if (!scene.offline) {
        scene.client.updateSharedState({ arenaEpoch: epochMs });
      }
    },
    /** Set the base shield directly; stamps the damage clock so regen
     *  behaves as after a real drain. 0 = death (via the real pipeline). */
    setShield: (hp: number): void => {
      const now = simNow();
      scene.shield.shieldHp = Math.min(SIPHON_OVERHEAL_MAX, hp);
      scene.shield.lastDamageAt = now;
      scene.shield.regenActive = false;
      if (scene.shield.shieldHp <= 0 && scene.alive) {
        scene.shield.die(now, null, "DEV");
      }
    },
    /** Host only: force-spawn a BEACON at (x,y) (defaults near the ship).
     *  Custom charge/active seconds exist for compressed-timer e2e probes;
     *  the real cadence gates are deliberately bypassed. */
    spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number): boolean => {
      if (!scene.amHost) {
        return false;
      }
      scene.host.hostSpawnBeacon(
        x ?? scene.shipX + 200,
        y ?? scene.shipY,
        simNow(),
        chargeS,
        activeS,
      );
      return true;
    },
    /** Host only: spawn an enemy near (or at) the given point. Elites get
     *  the same qa-018 level-scaled HP stamp as the organic spawn path, so
     *  probes measure shipping durability. */
    spawnEnemy: (kind: EnemyKind, x?: number, y?: number): string | null => {
      if (!scene.amHost) {
        return null;
      }
      const e = spawnEnemyState(kind, x ?? scene.shipX + 320, y ?? scene.shipY);
      if (ELITE_HP_BASE.has(kind)) {
        e.hp = eliteHp(kind, scene.host.maxPresentLevel());
        e.maxHp = e.hp;
      }
      scene.world.enemies.push(e);
      scene.host.dirty.enemies = true;
      return e.id;
    },
    /** Host only: drop a live item at (x,y) (defaults to the ship, so it gets
     *  picked up next frame, which is how stacking is exercised). */
    spawnItem: (cls: "weapon" | "shield" | "booster", name: string, x?: number, y?: number) => {
      if (!scene.amHost) {
        return;
      }
      let drop: ItemDrop | null = null;
      if (cls === "weapon") {
        const i = WEAPONS_SPECIAL.findIndex((w) => w.name === name.toUpperCase());
        if (i !== -1) {
          drop = { kind: "weapon", weaponIdx: i };
        }
      } else if (cls === "shield") {
        const i = kindIndex(SHIELD_MOD_KINDS, name.toLowerCase());
        if (i !== -1) {
          drop = { kind: "shield", shieldIdx: i };
        }
      } else {
        const i = kindIndex(BOOSTER_KINDS, name.toLowerCase());
        if (i !== -1) {
          drop = { boosterIdx: i, kind: "booster" };
        }
      }
      if (!drop) {
        return;
      }
      scene.world.items.push(spawnItemState(x ?? scene.shipX, y ?? scene.shipY, drop));
      scene.host.dirty.items = true;
    },
    summary: (): StarfallSummary => ({
      alive: scene.alive,
      asteroids: scene.world.asteroids.length,
      beams: scene.weapons.beams.length,
      boosts: scene.net.boostsNetState(),
      enemies: scene.world.enemies.map((e) => e.kind),
      enemyShots: scene.world.enemyShots.length,
      intensity: arenaIntensity(Math.max(0, (simNow() - scene.world.arenaEpoch) / 1000)),
      isHost: scene.amHost,
      items: scene.world.items.map((it) => it.kind),
      level: scene.progress.level,
      mines: scene.weapons.beams.filter((b) => b.mine && !b.exploding && !b.vanished).length,
      mod: scene.shield.shieldMod
        ? { kind: scene.shield.shieldMod, until: scene.shield.shieldModUntil }
        : null,
      now: simNow(),
      overHp: scene.shield.overHp,
      pulls: scene.world.pulls.length,
      recovery: {
        protectionMs: scene.alive ? Math.max(0, scene.invulnUntil - simNow()) : 0,
        recapUntil: scene.hud.recapUntil,
        remainingMs: scene.spawned && !scene.alive ? Math.max(0, scene.respawnAt - simNow()) : 0,
      },
      regen: scene.shield.regenActive,
      runXp: scene.progress.runXp,
      sector: {
        best: scene.hud.sectorBest,
        bossIdx: scene.world.sectorBossIdx,
        idx: sectorIdx(Math.max(0, (simNow() - scene.world.arenaEpoch) / 1000)),
        rel: sectorRelT(Math.max(0, (simNow() - scene.world.arenaEpoch) / 1000)),
        score: Math.round(scene.progress.sectorScore),
      },
      sentry: scene.weapons.sentry
        ? { x: scene.weapons.sentry.x, y: scene.weapons.sentry.y }
        : null,
      shards: scene.world.shards.length,
      shieldHp: Math.round(scene.shield.shieldHp * 10) / 10,
      streak: scene.progress.streak,
      weapon: scene.weapon.name,
      weaponUntil: scene.weaponUntil,
      windup: scene.weapons.windupFrac(),
      xp: scene.progress.xp,
      xpToNext: xpToNext(scene.progress.level),
    }),
  };
};
