import { sfx } from "../audio/sfx";
import type { FxPool } from "../render/fx-pool";
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
import type { SharedState } from "../shared/constants";
import type { DirtyFlags } from "../state/dirty-flags";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { dist2 } from "./geometry";
import type { Progression } from "./progression";
import type { Shield } from "./shield";
import type { Weapons } from "./weapons";

export interface PickupsDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  dirty: DirtyFlags;
  shield: Shield;
  weapons: Weapons;
  progress: Progression;
}

/** Owner-side pickups: claim items and shards on contact, apply the weapon/shield-mod/booster, and guard the claim until the host's removal echoes back. */
export class Pickups {
  /** Items we picked up locally, awaiting host confirmation (id → time). */
  recentPickups = new Map<string, number>();

  /** Shards we collected locally, awaiting host removal (id -> time), the
   *  same claimer-guard pattern as items. */
  recentShardPickups = new Map<string, number>();

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly dirty: DirtyFlags;

  private readonly shield: Shield;

  private readonly weapons: Weapons;

  private readonly progress: Progression;

  constructor(deps: PickupsDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.dirty = deps.dirty;
    this.shield = deps.shield;
    this.weapons = deps.weapons;
    this.progress = deps.progress;
  }

  pickupItems(now: number): void {
    if (!this.pilot.alive || !this.pilot.spawned || now < this.shield.phasedUntil) {
      return;
    }
    const { items } = this.world;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (!it || this.recentPickups.has(it.id)) {
        continue;
      }
      if (
        dist2(it.x, it.y, this.pilot.shipX, this.pilot.shipY) >
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
      this.link.send("item_pickup", { itemId: it.id });
      // Remove locally right away; the host event (or the next reconcile,
      // guarded by recentPickups) makes it stick.
      items.splice(i, 1);
      if (this.link.amHost) {
        this.dirty.items = true;
      }
    }
    this.expireClaims(now);
  }

  private pickupSparks(tint: number): void {
    this.fx.sparks(this.pilot.shipX, this.pilot.shipY, 14, tint, {
      lifeMax: 420,
      lifeMin: 200,
      speedMax: 140,
      speedMin: 30,
    });
  }

  private pickupWeapon(weaponIdx: number, now: number): void {
    const weapon = WEAPONS_SPECIAL[weaponIdx] ?? WEAPON_DEFAULT;
    if (weapon.name === this.pilot.weapon.name && now < this.pilot.weaponUntil) {
      // v3 stacking: same weapon EXTENDS the timer (+full duration,
      // capped at ITEM_STACK_CAP_MS out from now).
      this.pilot.weaponUntil = Math.min(
        this.pilot.weaponUntil + SPECIAL_WEAPON_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
    } else {
      // Keep the unscaled base so a later level-up re-scales it (no compounding).
      this.pilot.specialBase = weapon;
      this.pilot.weapon = scaleWeaponForLevel(weapon, this.progress.level);
      // replace resets the timer
      this.pilot.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS;
      this.weapons.windupAcc = 0;
    }
    if (!this.link.trailer) {
      this.pilot.mastery.pickup(this.pilot.weapon.name, now, this.pilot.weaponUntil);
    }
    this.pickupSparks(weapon.tint);
    sfx.play("pickup", { priority: "local" });
  }

  /** Timed shield MODIFIER on the base shield (one held; same kind extends
   *  +20s capped at 60s out AND refreshes its resource; different kind
   *  replaces). */
  private pickupShieldMod(shieldIdx: number, now: number): void {
    const kind = SHIELD_MOD_KINDS[shieldIdx] ?? "overshield";
    if (kind === this.shield.shieldMod && now < this.shield.shieldModUntil) {
      this.shield.shieldModUntil = Math.min(
        this.shield.shieldModUntil + SHIELD_MOD_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
      // bonus refill
      if (kind === "overshield") {
        this.shield.overHp = OVERSHIELD_BONUS;
      }
      // blink ready again
      if (kind === "phase") {
        this.shield.phaseReadyAt = 0;
      }
    } else {
      this.shield.shieldMod = kind;
      this.shield.shieldModUntil = now + SHIELD_MOD_DURATION_MS;
      this.shield.overHp = kind === "overshield" ? OVERSHIELD_BONUS : 0;
      this.shield.phaseReadyAt = 0;
    }
    this.shield.haloFlashUntil = now + 200;
    this.pickupSparks(SHIELD_MOD_SPECS[kind].tint);
    sfx.play("pickup_shield", { priority: "local" });
  }

  private pickupBooster(boosterIdx: number, now: number): void {
    const kind = BOOSTER_KINDS[boosterIdx] ?? "repair";
    if (kind === "repair") {
      // Instant: base only — never fills the OVERSHIELD bonus.
      this.shield.shieldHp = Math.max(this.shield.shieldHp, SHIELD_MAX);
      this.shield.lastDamageAt = 0;
      this.shield.repairSweepUntil = now + 200;
      sfx.play("shield_regen");
    } else {
      // Different kinds stack freely; the SAME kind extends its timer
      // (+its duration, capped at ITEM_STACK_CAP_MS out from now).
      const cur = this.pilot.boosts.get(kind);
      const dur = BOOSTER_SPECS[kind].durationMs;
      this.pilot.boosts.set(
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
    for (const [id, t] of this.shield.recentConsumedShots) {
      if (now - t > 5000) {
        this.shield.recentConsumedShots.delete(id);
      }
    }
    for (const [id, t] of this.shield.ramImmunity) {
      if (now > t) {
        this.shield.ramImmunity.delete(id);
      }
    }
    for (const [id, t] of this.shield.pvpIframeUntil) {
      if (now > t) {
        this.shield.pvpIframeUntil.delete(id);
      }
    }
  }

  /** XP orbs (former score shards): generous-radius hoover, +XP.ORB each (flat,
   *  never combo-multiplied; SALVAGE doubles it). Same claimer pattern as items:
   *  collect locally, tell the host, guard reconciles. */
  collectShards(now: number): void {
    if (!this.pilot.alive || !this.pilot.spawned || now < this.shield.phasedUntil) {
      return;
    }
    const r2 = SHARD_PICKUP_RADIUS * SHARD_PICKUP_RADIUS;
    const { shards } = this.world;
    const orbXp = (this.pilot.boosts.get("salvage") ?? 0) > now ? XP.ORB * SALVAGE_MULT : XP.ORB;
    for (let i = shards.length - 1; i >= 0; i -= 1) {
      const s = shards[i];
      if (!s || this.recentShardPickups.has(s.id)) {
        continue;
      }
      if (dist2(s.x, s.y, this.pilot.shipX, this.pilot.shipY) > r2) {
        continue;
      }
      this.progress.gainXp(orbXp, now);
      this.recentShardPickups.set(s.id, now);
      this.link.send("shard_pickup", { shardId: s.id });
      shards.splice(i, 1);
      if (this.link.amHost) {
        this.dirty.shards = true;
      }
      // Pooled sparkle + soft collect blip (pickup chirp, low gain, pitched up).
      this.fx.sparks(s.x, s.y, 3, SHARD_TINT, {
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
