import { sfx } from "../audio/sfx";
import { removeById } from "../net/shared-world";
import type { FxPool } from "../render/fx-pool";
import { now as simNow } from "../shared/clock";
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
import type { ItemState, SharedState } from "../shared/constants";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { dist2 } from "./geometry";
import type { Progression } from "./progression";
import type { Shield } from "./shield";
import type { Weapons } from "./weapons";

const ITEM_KEY = "i:";
const SHARD_KEY = "s:";

/** Claim keys, one per pickup: the server settles who got it — first come,
 *  first served, in one hop, the host no faster than anyone. */
export const itemClaimKey = (id: string) => `${ITEM_KEY}${id}`;
export const shardClaimKey = (id: string) => `${SHARD_KEY}${id}`;

const CLAIM_SLACK_MS = 2000;
const PENDING_MS = 5000;

export interface PickupsDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  shield: Shield;
  weapons: Weapons;
  progress: Progression;
}

/**
 * Owner-side pickups. Two ships can reach one drop within a round trip, so
 * each is claimed (Link.claim): on contact it vanishes here with its sparkle
 * and sound, and the weapon/shield-mod/booster or XP lands when the server
 * names this client the owner — a refused claim never pays. Everyone hears a
 * grant, so a taken pickup leaves every copy at once; the host drops claimed
 * ones from the world it shares (HostDirector).
 */
export class Pickups {
  private readonly pendingItems = new Map<string, { at: number; item: ItemState }>();

  private readonly pendingShards = new Map<string, { at: number; xp: number }>();

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly shield: Shield;

  private readonly weapons: Weapons;

  private readonly progress: Progression;

  constructor(deps: PickupsDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.shield = deps.shield;
    this.weapons = deps.weapons;
    this.progress = deps.progress;
  }

  /** Trailer re-stage: forget every pending claim. */
  clear() {
    this.pendingItems.clear();
    this.pendingShards.clear();
  }

  /** Mine pending, or claimed by anyone: a snapshot must not bring it back. */
  itemTaken(id: string) {
    return this.pendingItems.has(id) || this.link.claimed(itemClaimKey(id));
  }

  shardTaken(id: string) {
    return this.pendingShards.has(id) || this.link.claimed(shardClaimKey(id));
  }

  /** A claim's answer (Link onClaim — the socket listener, or at once
   *  offline). A grant takes the pickup out of this copy whoever won; the
   *  winner applies what it gives. */
  onClaim(key: string, owner: string | null) {
    if (owner === null) {
      return;
    }

    const mine = owner === this.link.myId;
    const now = simNow();

    if (key.startsWith(ITEM_KEY)) {
      const id = key.slice(ITEM_KEY.length);
      removeById(this.world.items, id);
      const pending = this.pendingItems.get(id);
      this.pendingItems.delete(id);

      if (pending && mine && this.pilot.alive && this.pilot.spawned) {
        this.applyItem(pending.item, now);
      }
    } else if (key.startsWith(SHARD_KEY)) {
      const id = key.slice(SHARD_KEY.length);
      removeById(this.world.shards, id);
      const pending = this.pendingShards.get(id);
      this.pendingShards.delete(id);

      if (pending && mine) {
        this.progress.gainXp(pending.xp, now);
      }
    }
  }

  pickupItems(now: number) {
    if (!this.pilot.alive || !this.pilot.spawned || now < this.shield.phasedUntil) {
      return;
    }

    if (!this.link.canClaim) {
      return;
    }

    const { items } = this.world;

    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];

      if (!it || this.itemTaken(it.id)) {
        continue;
      }

      if (
        dist2(it.x, it.y, this.pilot.shipX, this.pilot.shipY) >
        ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS
      ) {
        continue;
      }

      items.splice(i, 1);
      this.pendingItems.set(it.id, { at: now, item: it });
      this.itemTouchFx(it);
      this.link.claim(itemClaimKey(it.id), it.diesAt - now + CLAIM_SLACK_MS);
    }

    this.expireClaims(now);
  }

  private applyItem(it: ItemState, now: number) {
    if (it.kind === "weapon") {
      this.pickupWeapon(it.weaponIdx, now);
    } else if (it.kind === "shield") {
      this.pickupShieldMod(it.shieldIdx, now);
    } else {
      this.pickupBooster(it.boosterIdx, now);
    }
  }

  private itemTouchFx(it: ItemState) {
    if (it.kind === "weapon") {
      this.pickupSparks((WEAPONS_SPECIAL[it.weaponIdx] ?? WEAPON_DEFAULT).tint);
      sfx.play("pickup", { priority: "local" });
    } else if (it.kind === "shield") {
      this.pickupSparks(SHIELD_MOD_SPECS[SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield"].tint);
      sfx.play("pickup_shield", { priority: "local" });
    } else {
      this.pickupSparks(BOOSTER_SPECS[BOOSTER_KINDS[it.boosterIdx] ?? "repair"].tint);
      sfx.play("pickup_booster", { priority: "local" });
    }
  }

  private pickupSparks(tint: number) {
    this.fx.sparks(this.pilot.shipX, this.pilot.shipY, 14, tint, {
      lifeMax: 420,
      lifeMin: 200,
      speedMax: 140,
      speedMin: 30,
    });
  }

  private pickupWeapon(weaponIdx: number, now: number) {
    const weapon = WEAPONS_SPECIAL[weaponIdx] ?? WEAPON_DEFAULT;

    if (weapon.name === this.pilot.weapon.name && now < this.pilot.weaponUntil) {
      this.pilot.weaponUntil = Math.min(
        this.pilot.weaponUntil + SPECIAL_WEAPON_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );
    } else {
      this.pilot.specialBase = weapon;
      this.pilot.weapon = scaleWeaponForLevel(weapon, this.progress.level);
      this.pilot.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS;
      this.weapons.windupAcc = 0;
    }

    if (!this.link.trailer) {
      this.pilot.mastery.pickup(this.pilot.weapon.name, now, this.pilot.weaponUntil);
    }
  }

  private pickupShieldMod(shieldIdx: number, now: number) {
    const kind = SHIELD_MOD_KINDS[shieldIdx] ?? "overshield";

    if (kind === this.shield.shieldMod && now < this.shield.shieldModUntil) {
      this.shield.shieldModUntil = Math.min(
        this.shield.shieldModUntil + SHIELD_MOD_DURATION_MS,
        now + ITEM_STACK_CAP_MS,
      );

      if (kind === "overshield") {
        this.shield.overHp = OVERSHIELD_BONUS;
      }

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
  }

  private pickupBooster(boosterIdx: number, now: number) {
    const kind = BOOSTER_KINDS[boosterIdx] ?? "repair";

    if (kind === "repair") {
      this.shield.shieldHp = Math.max(this.shield.shieldHp, SHIELD_MAX);
      this.shield.lastDamageAt = 0;
      this.shield.repairSweepUntil = now + 200;
      sfx.play("shield_regen");
    } else {
      const cur = this.pilot.boosts.get(kind);
      const dur = BOOSTER_SPECS[kind].durationMs;
      this.pilot.boosts.set(
        kind,
        cur !== undefined && cur > now ? Math.min(cur + dur, now + ITEM_STACK_CAP_MS) : now + dur,
      );
    }
  }

  private expireClaims(now: number) {
    for (const [id, pending] of this.pendingItems) {
      if (now - pending.at > PENDING_MS) {
        this.pendingItems.delete(id);
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
   *  never combo-multiplied; SALVAGE doubles it). Claimed like items: the
   *  sparkle on contact, the XP once the claim comes back mine. */
  collectShards(now: number) {
    if (!this.pilot.alive || !this.pilot.spawned || now < this.shield.phasedUntil) {
      return;
    }

    if (!this.link.canClaim) {
      return;
    }

    const r2 = SHARD_PICKUP_RADIUS * SHARD_PICKUP_RADIUS;
    const { shards } = this.world;
    const orbXp = (this.pilot.boosts.get("salvage") ?? 0) > now ? XP.ORB * SALVAGE_MULT : XP.ORB;

    for (let i = shards.length - 1; i >= 0; i -= 1) {
      const s = shards[i];

      if (!s || this.shardTaken(s.id)) {
        continue;
      }

      if (dist2(s.x, s.y, this.pilot.shipX, this.pilot.shipY) > r2) {
        continue;
      }

      shards.splice(i, 1);
      this.pendingShards.set(s.id, { at: now, xp: orbXp });
      this.link.claim(shardClaimKey(s.id), s.diesAt - now + CLAIM_SLACK_MS);
      this.fx.sparks(s.x, s.y, 3, SHARD_TINT, {
        lifeMax: 220,
        lifeMin: 120,
        scale: 0.4,
        speedMax: 90,
        speedMin: 20,
      });
      sfx.play("pickup", { gain: 0.25, rate: 1.6 });
    }

    for (const [id, pending] of this.pendingShards) {
      if (now - pending.at > PENDING_MS) {
        this.pendingShards.delete(id);
      }
    }
  }
}
