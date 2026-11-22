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
  WEAPON_DEFAULT,
  bossHp,
  eliteHp,
  scaleWeaponForLevel,
  spawnEnemyState,
  spawnItemState,
  spawnOpeningAsteroid,
} from "../shared/constants";
import type { ItemDrop } from "../shared/constants";
import { newBeam } from "../sys/beam";
import { dist2 } from "../sys/geometry";
import type { SceneInternals } from "../scenes/game-scene";
import type { TrailerStageApi, TrailerStaging } from "./trailer-staging";

const STAGED_BOLT_LEN = 14;

/** Install the trailer staging overrides and return the scripted-staging
 *  surface. Only ever called by the trailer director under ?trailer=1 (the
 *  same query flag that forced this session offline in create()), so none
 *  of this runs in normal play. Every lever routes through the same code
 *  paths gameplay uses — spawn factories, hostDamageEnemy, gainXp, die —
 *  so staged shots are real gameplay. */
export const installTrailerStage: (scene: SceneInternals) => TrailerStageApi = (scene) => {
  const staging: TrailerStaging = {
    camPos: null,
    deathless: true,
    fire: false,
    frame: null,
    peers: null,
    steer: null,
  };

  scene.link.trailer = staging;

  return {
    clearAsteroids: () => {
      scene.world.asteroids = [];

      for (const [, rec] of scene.view.asteroidObjs) {
        scene.tweens.killTweensOf(rec.gfx);
        rec.gfx.destroy();
      }

      scene.view.asteroidObjs.clear();
    },
    clearWorld: () => {
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
      scene.pickups.clear();
      scene.shield.recentConsumedShots.clear();
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
      scene.progress.streak = 0;
      scene.progress.comboTier = 1;
      scene.progress.comboExpiresAt = 0;
      scene.weapons.windupAcc = 0;
      scene.weapons.shootCooldown = 0;
      scene.shield.shieldHp = SHIELD_MAX;
      scene.shield.overHp = 0;
      scene.shield.shieldMod = null;
      scene.shield.shieldModUntil = 0;
      scene.pilot.boosts.clear();
      scene.pilot.invulnUntil = 0;
      scene.shield.phasedUntil = 0;
      scene.shield.contactIframeUntil = 0;
      scene.shield.impactArcs = [];
      scene.pilot.kickX = 0;
      scene.pilot.kickY = 0;
    },
    damageEnemy: (id, amount) => scene.hostCombat.hostDamageEnemy(id, amount, 0, 0),
    enemies: () => scene.world.enemies,
    forceStart: () => scene.forceOfflineSolo(),
    grantBooster: (kind) => {
      if (kind === "repair") {
        scene.shield.shieldHp = Math.max(scene.shield.shieldHp, SHIELD_MAX);
        scene.shield.lastDamageAt = 0;
      } else {
        scene.pilot.boosts.set(kind, simNow() + BOOSTER_SPECS[kind].durationMs);
      }
    },
    grantShieldMod: (kind) => {
      const now = simNow();
      scene.shield.shieldMod = kind;
      scene.shield.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
      scene.shield.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
      scene.shield.phaseReadyAt = 0;
    },
    grantWeapon: (name) => {
      const weapon = WEAPONS_SPECIAL.find((w) => w.name === name);

      if (!weapon) {
        return;
      }

      scene.pilot.specialBase = weapon;
      scene.pilot.weapon = scaleWeaponForLevel(weapon, scene.progress.level);
      scene.pilot.weaponUntil = simNow() + SPECIAL_WEAPON_DURATION_MS;
      scene.weapons.windupAcc = 0;
      scene.weapons.shootCooldown = 0;
    },
    grantXp: (amount) => scene.progress.gainXp(amount, simNow()),
    killEnemy: (id) => {
      const idx = scene.world.enemies.findIndex((en) => en.id === id);

      if (idx !== -1) {
        scene.hostCombat.hostKillEnemy(idx);
      }
    },
    killPlayer: (cause) => {
      if (!scene.pilot.alive) {
        return;
      }

      scene.shield.shieldHp = 0;
      scene.shield.overHp = 0;
      scene.shield.die(simNow(), null, cause);
    },
    player: () => ({
      alive: scene.pilot.alive,
      angle: scene.pilot.shipAngle,
      level: scene.progress.level,
      shieldHp: scene.shield.shieldHp,
      vx: scene.pilot.shipVX,
      vy: scene.pilot.shipVY,
      weapon: scene.pilot.weapon.name,
      x: scene.pilot.shipX,
      y: scene.pilot.shipY,
    }),
    setEnemyHp: (id, hp) => {
      const e = scene.world.enemies.find((en) => en.id === id);

      if (e) {
        e.hp = Math.max(1, hp);
      }
    },
    setLevel: (level, xpIntoLevel = 0) => {
      scene.progress.level = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
      scene.progress.xp = Math.max(0, xpIntoLevel);
      scene.pilot.specialBase = null;
      scene.pilot.weaponUntil = 0;
      scene.progress.applyBaseLoadout(simNow());
    },
    setPlayerPose: (pose) => {
      scene.pilot.spawned = true;
      scene.pilot.alive = true;
      scene.link.paused = false;
      scene.pilot.respawnAt = 0;
      scene.pilot.invulnUntil = 0;
      scene.pilot.shipX = pose.x;
      scene.pilot.shipY = pose.y;

      if (pose.angle !== undefined) {
        scene.pilot.shipAngle = pose.angle;
      }

      scene.pilot.shipVX = pose.vx ?? 0;
      scene.pilot.shipVY = pose.vy ?? 0;

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
      }

      scene.cameras.main.centerOn(pose.x, pose.y);
    },
    setShieldHp: (hp) => {
      scene.shield.shieldHp = Math.max(0, Math.min(SIPHON_OVERHEAL_MAX, hp));
    },
    setXp: (xpIntoLevel) => {
      scene.progress.xp = Math.max(0, xpIntoLevel);
    },
    spawnAsteroid: (x, y, radius) => {
      const a = spawnOpeningAsteroid(x, y);
      a.radius = PhaserMath.Clamp(radius, ASTEROID_MIN_RADIUS, ASTEROID_MAX_RADIUS);
      a.vx = 0;
      a.vy = 0;
      scene.world.asteroids.push(a);
    },
    spawnBeacon: (x, y, chargeS, activeS) =>
      scene.host.hostSpawnBeacon(x, y, simNow(), chargeS, activeS),
    spawnEnemy: (kind, x, y, aimAt) => {
      const e = spawnEnemyState(kind, x, y);

      if (aimAt) {
        e.angle = Math.atan2(aimAt.y - y, aimAt.x - x);
      }

      if (kind === "dreadnought") {
        e.hp = bossHp(Math.max(1, Object.keys(scene.link.peers).length));
        e.maxHp = e.hp;
      } else if (ELITE_HP_BASE.has(kind)) {
        e.hp = eliteHp(kind, scene.host.maxPresentLevel());
        e.maxHp = e.hp;
      }

      scene.world.enemies.push(e);

      return e.id satisfies string;
    },
    spawnItem: (cls, name, x, y) => {
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
      item.vx = 0;
      item.vy = 0;
      scene.world.items.push(item);
    },
    spawnShards: (count, x, y) => scene.hostCombat.hostSpawnShards(x, y, count),
    stagePeerBolts: (id, bolts) => {
      if (!bolts) {
        scene.remoteFire.stage(id, null);

        return;
      }

      const now = simNow();
      scene.remoteFire.stage(
        id,
        bolts.map((bolt) => {
          const speed = Math.hypot(bolt.vx, bolt.vy) || 1;
          const angle = Math.atan2(bolt.vy, bolt.vx);
          const weapon = { ...WEAPON_DEFAULT, power: bolt.power, tint: bolt.tint, width: 1 };
          const b = newBeam({ x: bolt.x, y: bolt.y }, angle, weapon, now);
          b.released = true;
          b.tail.x = bolt.x - (bolt.vx / speed) * STAGED_BOLT_LEN;
          b.tail.y = bolt.y - (bolt.vy / speed) * STAGED_BOLT_LEN;

          return b;
        }),
      );
    },
    staging,
    worldSize: () => ({ h: scene.world.playH, w: scene.world.playW }),
  };
};
