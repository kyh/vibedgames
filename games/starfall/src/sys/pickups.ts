import { sfx } from "../audio/sfx";
import type { GameScene } from "../scenes/game-scene";
import {
  BOOSTER_KINDS,
  BOOSTER_SPECS,
  ITEM_PICKUP_RADIUS,
  ITEM_STACK_CAP_MS,
  OVERSHIELD_BONUS,
  SALVAGE_MULT,
  SHARD_PICKUP_RADIUS,
  SHARD_TINT,
  SHIELD_MAX,
  SHIELD_MOD_DURATION_MS,
  SHIELD_MOD_KINDS,
  SHIELD_MOD_SPECS,
  SPECIAL_WEAPON_DURATION_MS,
  WEAPONS_SPECIAL,
  WEAPON_DEFAULT,
  XP,
  scaleWeaponForLevel,
} from "../shared/constants";
import { dist2 } from "./geometry";

type PickupsScene = Pick<
  GameScene,
  | "alive"
  | "amHost"
  | "boosts"
  | "fx"
  | "host"
  | "mastery"
  | "netSendEvent"
  | "progress"
  | "shield"
  | "shipX"
  | "shipY"
  | "spawned"
  | "specialBase"
  | "trailer"
  | "weapon"
  | "weaponUntil"
  | "weapons"
  | "world"
>;

/** Owner-side pickups: claim items and shards on contact, apply the weapon/shield-mod/booster, and guard the claim until the host's removal echoes back. */
export class Pickups {
  /** Items we picked up locally, awaiting host confirmation (id → time). */
  recentPickups = new Map<string, number>();

  /** Shards we collected locally, awaiting host removal (id -> time), the
   *  same claimer-guard pattern as items. */
  recentShardPickups = new Map<string, number>();

  private readonly scene: PickupsScene;

  constructor(scene: PickupsScene) {
    this.scene = scene;
  }

  pickupItems(now: number): void {
    if (!this.scene.alive || !this.scene.spawned || now < this.scene.shield.phasedUntil) {
      return;
    }
    const { items } = this.scene.world;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (!it || this.recentPickups.has(it.id)) {
        continue;
      }
      if (
        dist2(it.x, it.y, this.scene.shipX, this.scene.shipY) >
        ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS
      ) {
        continue;
      }
      if (it.kind === "weapon") {
        this.pickupWeapon(it.weaponIdx, now);
      } else if (it.kind === "shield") {
        this.pickupShieldMod(it.shieldIdx, now);
      } else {
        this.pickupBooster(it.boosterIdx, now);
      }
      this.recentPickups.set(it.id, now);
      this.scene.netSendEvent("item_pickup", { itemId: it.id });
      // Remove locally right away; the host event (or the next reconcile,
      // guarded by recentPickups) makes it stick.
      items.splice(i, 1);
      if (this.scene.amHost) {
        this.scene.host.dirty.items = true;
      }
    }
    this.expireClaims(now);
  }

  private pickupSparks(tint: number): void {
    this.scene.fx.sparks(this.scene.shipX, this.scene.shipY, 14, tint, {
      lifeMax: 420,
      lifeMin: 200,
      speedMax: 140,
      speedMin: 30,
    });
  }

  private pickupWeapon(weaponIdx: number, now: number): void {
    const weapon = WEAPONS_SPECIAL[weaponIdx] ?? WEAPON_DEFAULT;
    if (weapon.name === this.scene.weapon.name && now < this.scene.weaponUntil) {
      // v3 stacking: same weapon EXTENDS the timer (+full duration,
      // capped at ITEM_STACK_CAP_MS out from now).
      this.scene.weaponUntil = Math.min(
        this.scene.weaponUntil + SPECIAL_WEAPON_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
    } else {
      // Keep the unscaled base so a later level-up re-scales it (no compounding).
      this.scene.specialBase = weapon;
      this.scene.weapon = scaleWeaponForLevel(weapon, this.scene.progress.level);
      // replace resets the timer
      this.scene.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS;
      this.scene.weapons.windupAcc = 0;
    }
    if (!this.scene.trailer) {
      this.scene.mastery.pickup(this.scene.weapon.name, now, this.scene.weaponUntil);
    }
    this.pickupSparks(weapon.tint);
    sfx.play("pickup", { priority: "local" });
  }

  /** Timed shield MODIFIER on the base shield (one held; same kind extends
   *  +20s capped at 60s out AND refreshes its resource; different kind
   *  replaces). */
  private pickupShieldMod(shieldIdx: number, now: number): void {
    const kind = SHIELD_MOD_KINDS[shieldIdx] ?? "overshield";
    if (kind === this.scene.shield.shieldMod && now < this.scene.shield.shieldModUntil) {
      this.scene.shield.shieldModUntil = Math.min(
        this.scene.shield.shieldModUntil + SHIELD_MOD_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
      // bonus refill
      if (kind === "overshield") {
        this.scene.shield.overHp = OVERSHIELD_BONUS;
      }
      // blink ready again
      if (kind === "phase") {
        this.scene.shield.phaseReadyAt = 0;
      }
    } else {
      this.scene.shield.shieldMod = kind;
      this.scene.shield.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
      this.scene.shield.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
      this.scene.shield.phaseReadyAt = 0;
    }
    this.scene.shield.haloFlashUntil = now + 200;
    this.pickupSparks(SHIELD_MOD_SPECS[kind].tint);
    sfx.play("pickup_shield", { priority: "local" });
  }

  private pickupBooster(boosterIdx: number, now: number): void {
    const kind = BOOSTER_KINDS[boosterIdx] ?? "repair";
    if (kind === "repair") {
      // Instant: base only — never fills the OVERSHIELD bonus.
      this.scene.shield.shieldHp = Math.max(this.scene.shield.shieldHp, SHIELD_MAX);
      this.scene.shield.lastDamageAt = 0;
      this.scene.shield.repairSweepUntil = now + 200;
      sfx.play("shield_regen");
    } else {
      // Different kinds stack freely; the SAME kind extends its timer
      // (+its duration, capped at ITEM_STACK_CAP_MS out from now).
      const cur = this.scene.boosts.get(kind);
      const dur = BOOSTER_SPECS[kind].durationMs;
      this.scene.boosts.set(
        kind,
        cur !== undefined && cur > now ? Math.min(cur + dur, now + ITEM_STACK_CAP_MS) : now + dur,
      );
    }
    this.pickupSparks(BOOSTER_SPECS[kind].tint);
    sfx.play("pickup_booster", { priority: "local" });
  }

  /** Age out the local claim guards (pickups, consumed shots, RAM and PvP i-frames). */
  private expireClaims(now: number): void {
    for (const [id, t] of this.recentPickups) {
      if (now - t > 5000) {
        this.recentPickups.delete(id);
      }
    }
    for (const [id, t] of this.scene.shield.recentConsumedShots) {
      if (now - t > 5000) {
        this.scene.shield.recentConsumedShots.delete(id);
      }
    }
    for (const [id, t] of this.scene.shield.ramImmunity) {
      if (now > t) {
        this.scene.shield.ramImmunity.delete(id);
      }
    }
    for (const [id, t] of this.scene.shield.pvpIframeUntil) {
      if (now > t) {
        this.scene.shield.pvpIframeUntil.delete(id);
      }
    }
  }

  /** XP orbs (former score shards): generous-radius hoover, +XP.ORB each (flat,
   *  never combo-multiplied; SALVAGE doubles it). Same claimer pattern as items:
   *  collect locally, tell the host, guard reconciles. */
  collectShards(now: number): void {
    if (!this.scene.alive || !this.scene.spawned || now < this.scene.shield.phasedUntil) {
      return;
    }
    const r2 = SHARD_PICKUP_RADIUS * SHARD_PICKUP_RADIUS;
    const { shards } = this.scene.world;
    const orbXp = (this.scene.boosts.get("salvage") ?? 0) > now ? XP.ORB * SALVAGE_MULT : XP.ORB;
    for (let i = shards.length - 1; i >= 0; i -= 1) {
      const s = shards[i];
      if (!s || this.recentShardPickups.has(s.id)) {
        continue;
      }
      if (dist2(s.x, s.y, this.scene.shipX, this.scene.shipY) > r2) {
        continue;
      }
      this.scene.progress.gainXp(orbXp, now);
      this.recentShardPickups.set(s.id, now);
      this.scene.netSendEvent("shard_pickup", { shardId: s.id });
      shards.splice(i, 1);
      if (this.scene.amHost) {
        this.scene.host.dirty.shards = true;
      }
      // Pooled sparkle + soft collect blip (pickup chirp, low gain, pitched up).
      this.scene.fx.sparks(s.x, s.y, 3, SHARD_TINT, {
        lifeMax: 220,
        lifeMin: 120,
        scale: 0.4,
        speedMax: 90,
        speedMin: 20,
      });
      sfx.play("pickup", { gain: 0.25, rate: 1.6 });
    }
    for (const [id, t] of this.recentShardPickups) {
      if (now - t > 5000) {
        this.recentShardPickups.delete(id);
      }
    }
  }
}
