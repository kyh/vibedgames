import { Math as PhaserMath } from "phaser";
import { sfx } from "../audio/sfx";
import { kindIndex } from "../net/wire-read";
import { now as simNow } from "../shared/clock";
import {
  ASTEROID_MAX_RADIUS,
  ASTEROID_MIN_RADIUS,
  BOOSTER_KINDS,
  BOOSTER_SPECS,
  ELITE_HP_BASE,
  LEVEL_CAP,
  OVERSHIELD_BONUS,
  SHIELD_MAX,
  SHIELD_MOD_DURATION_MS,
  SHIELD_MOD_KINDS,
  SIPHON_OVERHEAL_MAX,
  SPECIAL_WEAPON_DURATION_MS,
  WEAPONS_SPECIAL,
  bossHp,
  eliteHp,
  scaleWeaponForLevel,
  spawnEnemyState,
  spawnItemState,
  spawnOpeningAsteroid,
} from "../shared/constants";
import type { EnemyState, ItemDrop } from "../shared/constants";
import { dist2 } from "../sys/geometry";
import type { GameScene } from "../scenes/game-scene";
import type { TrailerStageApi, TrailerStaging } from "./trailer-staging";

/** Trailer staging levers (?trailer=1 only): every lever routes through the same gameplay paths the live game uses, so staged shots are real gameplay. */

/** Install the trailer staging overrides and return the scripted-staging
 *  surface. Only ever called by the trailer director under ?trailer=1 (the
 *  same query flag that forced this session offline in create()), so none
 *  of this runs in normal play. Every lever routes through the same code
 *  paths gameplay uses — spawn factories, hostDamageEnemy, gainXp, die —
 *  so staged shots are real gameplay. */
export const installTrailerStage = (scene: GameScene): TrailerStageApi => {
  const staging: TrailerStaging = {
    camPos: null,
    deathless: true,
    fire: false,
    frame: null,
    peers: null,
    steer: null,
  };
  scene.trailer = staging;
  return {
    clearAsteroids: (): void => {
      // Silent: the display sweep in syncAsteroids bursts any rock whose
      // state vanished, and 14 of those would play on the next reveal.
      scene.world.asteroids = [];
      for (const [, rec] of scene.view.asteroidObjs) {
        scene.tweens.killTweensOf(rec.gfx);
        rec.gfx.destroy();
      }
      scene.view.asteroidObjs.clear();
      scene.host.dirty.asteroids = true;
    },
    clearWorld: (): void => {
      sfx.stopAll();
      scene.hud.bossEncounters.reset();
      scene.hud.battleBeat.reset();
      scene.fx.reset();
      const w = scene.world;
      w.enemies = [];
      w.enemyShots = [];
      w.items = [];
      w.shards = [];
      w.pulls = [];
      w.beacon = null;
      w.ufo = null;
      // Re-stage from "arena just opened": keeps the organic director (safe
      // opening, spawn intervals, beacon cadence, boss guarantee) asleep for
      // the whole shot — everything on screen is placed by the director.
      w.arenaEpoch = simNow();
      scene.ai.enemySim.clear();
      scene.host.lastEnemySpawnAt = simNow();
      scene.host.lastAsteroidSpawnAt = simNow();
      scene.beacon.lastBeacon = null;
      scene.weapons.beams = [];
      scene.weapons.sentry = null;
      scene.view.splinters = [];
      scene.weapons.muzzleFlashes = [];
      scene.hits.predictedKills.clear();
      scene.pickups.recentPickups.clear();
      scene.pickups.recentShardPickups.clear();
      scene.shield.recentConsumedShots.clear();
      // Silent display cleanup — bypass the death-FX removal sweeps so a
      // cleared crowd doesn't explode into 40 shatters on the next cut.
      scene.view.ufoGfx?.destroy();
      scene.view.ufoGfx = null;
      scene.view.ufoId = "";
      for (const [, rec] of scene.view.enemyObjs) {
        rec.gfx.destroy();
      }
      scene.view.enemyObjs.clear();
      for (const [, rec] of scene.view.itemObjs) {
        scene.tweens.killTweensOf(rec.gfx);
        rec.gfx.destroy();
      }
      scene.view.itemObjs.clear();
      // Pilot combat state back to a clean baseline.
      scene.progress.streak = 0;
      scene.progress.comboTier = 1;
      scene.progress.comboExpiresAt = 0;
      scene.weapons.windupAcc = 0;
      scene.weapons.shootCooldown = 0;
      scene.shield.shieldHp = SHIELD_MAX;
      scene.shield.overHp = 0;
      scene.shield.shieldMod = null;
      scene.shield.shieldModUntil = 0;
      scene.boosts.clear();
      scene.invulnUntil = 0;
      scene.shield.phasedUntil = 0;
      scene.shield.contactIframeUntil = 0;
      scene.shield.impactArcs = [];
      scene.kickX = 0;
      scene.kickY = 0;
    },
    damageEnemy: (id, amount): void => scene.hostCombat.hostDamageEnemy(id, amount, 0, 0),
    enemies: (): readonly Readonly<EnemyState>[] => scene.world.enemies,
    forceStart: (): void => scene.forceOfflineSolo(),
    grantBooster: (kind): void => {
      if (kind === "repair") {
        scene.shield.shieldHp = Math.max(scene.shield.shieldHp, SHIELD_MAX);
        scene.shield.lastDamageAt = 0;
      } else {
        scene.boosts.set(kind, simNow() + BOOSTER_SPECS[kind].durationMs);
      }
    },
    grantShieldMod: (kind): void => {
      const now = simNow();
      scene.shield.shieldMod = kind;
      scene.shield.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
      scene.shield.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
      // blink armed from frame one
      scene.shield.phaseReadyAt = 0;
    },
    grantWeapon: (name): void => {
      const weapon = WEAPONS_SPECIAL.find((w) => w.name === name);
      if (!weapon) {
        return;
      }
      scene.specialBase = weapon;
      scene.weapon = scaleWeaponForLevel(weapon, scene.progress.level);
      scene.weaponUntil = simNow() + SPECIAL_WEAPON_DURATION_MS;
      scene.weapons.windupAcc = 0;
      // A staged swap starts its cadence now. Left alone, the outgoing
      // weapon's residual cooldown carries over, so a mid-shot swap to a
      // fast weapon can sit silent for most of a second — long enough to
      // push the beat it was granted for past the cut.
      scene.weapons.shootCooldown = 0;
    },
    grantXp: (amount): void => scene.progress.gainXp(amount, simNow()),
    killEnemy: (id): void => {
      const idx = scene.world.enemies.findIndex((en) => en.id === id);
      if (idx !== -1) {
        scene.hostCombat.hostKillEnemy(idx);
      }
    },
    killPlayer: (cause): void => {
      if (!scene.alive) {
        return;
      }
      scene.shield.shieldHp = 0;
      scene.shield.overHp = 0;
      scene.shield.die(simNow(), null, cause);
    },
    player: () => ({
      alive: scene.alive,
      angle: scene.shipAngle,
      level: scene.progress.level,
      shieldHp: scene.shield.shieldHp,
      vx: scene.shipVX,
      vy: scene.shipVY,
      weapon: scene.weapon.name,
      x: scene.shipX,
      y: scene.shipY,
    }),
    setEnemyHp: (id, hp): void => {
      const e = scene.world.enemies.find((en) => en.id === id);
      if (e) {
        e.hp = Math.max(1, hp);
      }
    },
    setLevel: (level, xpIntoLevel = 0): void => {
      scene.progress.level = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
      scene.progress.xp = Math.max(0, xpIntoLevel);
      scene.specialBase = null;
      scene.weaponUntil = 0;
      scene.progress.applyBaseLoadout(simNow());
    },
    setPlayerPose: (pose): void => {
      scene.spawned = true;
      scene.alive = true;
      scene.paused = false;
      scene.respawnAt = 0;
      // no spawn blink on camera
      scene.invulnUntil = 0;
      scene.shipX = pose.x;
      scene.shipY = pose.y;
      if (pose.angle !== undefined) {
        scene.shipAngle = pose.angle;
      }
      scene.shipVX = pose.vx ?? 0;
      scene.shipVY = pose.vy ?? 0;
      // Rocks deliberately survive clearWorld() (they are the arena's only
      // ambience), which means one staged for an earlier shot can be sitting
      // exactly where a later shot puts the ship — and asteroidContactDamage
      // then opens the scene by taking most of the shield. Clear the landing
      // zone. Silently: the display sweep bursts any asteroid whose state
      // vanished, and that burst would play on the reveal.
      for (let i = scene.world.asteroids.length - 1; i >= 0; i -= 1) {
        const a = scene.world.asteroids[i];
        if (!a) {
          continue;
        }
        const clear = a.radius + 70;
        if (dist2(a.x, a.y, pose.x, pose.y) > clear * clear) {
          continue;
        }
        scene.world.asteroids.splice(i, 1);
        const rec = scene.view.asteroidObjs.get(a.id);
        if (rec) {
          scene.tweens.killTweensOf(rec.gfx);
          rec.gfx.destroy();
          scene.view.asteroidObjs.delete(a.id);
        }
        scene.host.dirty.asteroids = true;
      }
      scene.cameras.main.centerOn(pose.x, pose.y);
    },
    setShieldHp: (hp): void => {
      scene.shield.shieldHp = Math.max(0, Math.min(SIPHON_OVERHEAL_MAX, hp));
    },
    setXp: (xpIntoLevel): void => {
      scene.progress.xp = Math.max(0, xpIntoLevel);
    },
    spawnAsteroid: (x, y, radius): void => {
      const a = spawnOpeningAsteroid(x, y);
      a.radius = PhaserMath.Clamp(radius, ASTEROID_MIN_RADIUS, ASTEROID_MAX_RADIUS);
      // Same reason as spawnItem, plus one more: rocks survive clearWorld(),
      // so a drifting staged rock wanders into later shots it was never
      // composed for.
      a.vx = 0;
      a.vy = 0;
      scene.world.asteroids.push(a);
      scene.host.dirty.asteroids = true;
    },
    spawnBeacon: (x, y, chargeS, activeS): void =>
      scene.host.hostSpawnBeacon(x, y, simNow(), chargeS, activeS),
    spawnEnemy: (kind, x, y, aimAt): string => {
      const e = spawnEnemyState(kind, x, y);
      if (aimAt) {
        e.angle = Math.atan2(aimAt.y - y, aimAt.x - x);
      }
      if (kind === "dreadnought") {
        e.hp = bossHp(Math.max(1, Object.keys(scene.peers).length));
        e.maxHp = e.hp;
      } else if (ELITE_HP_BASE.has(kind)) {
        e.hp = eliteHp(kind, scene.host.maxPresentLevel());
        e.maxHp = e.hp;
      }
      scene.world.enemies.push(e);
      scene.host.dirty.enemies = true;
      return e.id;
    },
    spawnItem: (cls, name, x, y): void => {
      let drop: ItemDrop | null = null;
      if (cls === "weapon") {
        const i = WEAPONS_SPECIAL.findIndex((w) => w.name === name);
        if (i !== -1) {
          drop = { kind: "weapon", weaponIdx: i };
        }
      } else if (cls === "shield") {
        const i = kindIndex(SHIELD_MOD_KINDS, name);
        if (i !== -1) {
          drop = { kind: "shield", shieldIdx: i };
        }
      } else {
        const i = kindIndex(BOOSTER_KINDS, name);
        if (i !== -1) {
          drop = { boosterIdx: i, kind: "booster" };
        }
      }
      if (!drop) {
        return;
      }
      const item = spawnItemState(x, y, drop);
      // Park it: the factory's 30 px/s scatter is drawn from the seeded
      // gameplay RNG, and over a ~0.7s approach it walks the crystal clear
      // of the 15px pickup radius the shot was composed around.
      item.vx = 0;
      item.vy = 0;
      scene.world.items.push(item);
      scene.host.dirty.items = true;
    },
    spawnShards: (count, x, y): void => scene.hostCombat.hostSpawnShards(x, y, count),
    staging,
    worldSize: () => ({ h: scene.world.playH, w: scene.world.playW }),
  };
};
