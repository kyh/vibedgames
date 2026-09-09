import { Math as PhaserMath } from "phaser";
import { sfx } from "../audio/sfx";
import type { FxPool } from "../render/fx-pool";
import type { TraumaCamera } from "../render/trauma-camera";
import {
  BEACON_CHARGE_S,
  BEACON_HOLD_BONUS_XP,
  BEACON_RADIUS,
  BEACON_TICK_MS,
  BEACON_TINT,
  BEACON_XP_PER_TICK,
} from "../shared/constants";
import type { BeaconState, SharedState } from "../shared/constants";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import type { Progression } from "./progression";

export interface BeaconClientDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  trauma: TraumaCamera;
  progress: Progression;
}

/** Every client's view of the BEACON event: owner-simulated trickle/hold awards, charge blips and the armed/clash/payout cues. */
export class BeaconClient {
  // BEACON client-side bookkeeping (every client, owner-simulated awards)
  /** Last non-null beacon snapshot — expiry payout + fx trigger off it. */
  lastBeacon: BeaconState | null = null;

  /** Highest trickle tick index already granted/skipped for this instance. */
  private beaconTickIdx = 0;

  /** Charge blips played (rising pitch, one per second of CHARGE). */
  private beaconBlipIdx = -1;

  /** True once the CHARGE→ACTIVE flash+chime fired for this instance. */
  private beaconArmedFxDone = false;

  private beaconLastClashAt = 0;

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly trauma: TraumaCamera;

  private readonly progress: Progression;

  constructor(deps: BeaconClientDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.trauma = deps.trauma;
    this.progress = deps.progress;
  }

  /** BEACON client side (every client, host included): the owner-simulated XP
   *  trickle + hold bonus, and the charge/arm/clash audio. Awards key off the
   *  HOST-written controllerId/contested — the same snapshot everywhere — so
   *  each client granting itself XP stays consistent (existing XP model). */
  tickBeaconClient(now: number): void {
    const raw = this.world.beacon;
    // A locally-elapsed beacon is already gone (guests see expiry up to one
    // snapshot before the host's null patch arrives).
    const b = raw && now < raw.diesAt ? raw : null;
    const prev = this.lastBeacon;

    // Previous instance ended: fire the expiry payout exactly once, off the
    // host's last written control state. Only a NATURAL expiry pays — a
    // beacon that vanished early (fresh arena adoption) just disappears.
    const ended = prev && (!b || b.activeAt !== prev.activeAt) && now >= prev.diesAt - 100;
    if (ended && prev.controllerId !== null && !prev.contested) {
      this.beaconPayoutFx(prev, now);
    }
    if (!b) {
      // Gone (naturally paid out above, or vanished early → no payout ever).
      this.lastBeacon = null;
      return;
    }
    if (!prev || prev.activeAt !== b.activeAt) {
      // New instance: reset the per-instance bookkeeping.
      this.beaconTickIdx = 0;
      this.beaconBlipIdx = -1;
      this.beaconArmedFxDone = false;
    }
    if (now < b.activeAt) {
      this.tickBeaconCharge(b, now);
    } else {
      this.tickBeaconActive(b, now);
    }
    this.lastBeacon = { ...b };
  }

  /** Beacon audio falls off with distance from my ship. */
  private beaconGain(x: number, y: number): number {
    const d = Math.hypot(x - this.pilot.shipX, y - this.pilot.shipY);
    return PhaserMath.Clamp(1 - d / 3500, 0.2, 1);
  }

  /** Gold shockwave — fx only, no damage; every client draws it. The
   *  controller alone banks the hold bonus. */
  private beaconPayoutFx(prev: BeaconState, now: number): void {
    this.fx.ring(prev.x, prev.y, 40, BEACON_RADIUS, 650, BEACON_TINT, 0.9);
    this.fx.sparks(prev.x, prev.y, 14, BEACON_TINT, {
      lifeMax: 500,
      lifeMin: 250,
      speedMax: 260,
      speedMin: 80,
    });
    if (prev.controllerId === this.link.myId) {
      this.progress.gainXp(BEACON_HOLD_BONUS_XP, now);
      this.trauma.add(0.08);
      sfx.play("beacon_active", { rate: 1.4 });
    }
  }

  /** CHARGE: one blip per second, pitch ratcheting up (distance-attenuated). */
  private tickBeaconCharge(b: BeaconState, now: number): void {
    const idx = Math.floor((now - (b.activeAt - BEACON_CHARGE_S * 1000)) / 1000);
    if (idx > this.beaconBlipIdx && idx >= 0) {
      this.beaconBlipIdx = idx;
      sfx.play("beacon_charge", { gain: this.beaconGain(b.x, b.y), rate: 1 + idx * 0.09 });
    }
  }

  private tickBeaconActive(b: BeaconState, now: number): void {
    if (!this.beaconArmedFxDone) {
      // CHARGE → ACTIVE: arena-audible chime + full-ring flash.
      this.beaconArmedFxDone = true;
      sfx.play("beacon_active");
      this.fx.ring(b.x, b.y, BEACON_RADIUS * 0.6, BEACON_RADIUS * 1.2, 500, BEACON_TINT, 0.9);
    }
    if (b.contested && now - this.beaconLastClashAt > 700) {
      this.beaconLastClashAt = now;
      sfx.play("beacon_clash", { gain: this.beaconGain(b.x, b.y) });
    }
    // Trickle: 3 XP per elapsed 1s tick while the host names me sole
    // controller. Tick indices derive from activeAt, so every client counts
    // the same boundaries; capped at 2 per frame-batch (a hidden tab can't
    // claim a backlog it may not have controlled through).
    const tickIdx = Math.floor((now - b.activeAt) / BEACON_TICK_MS);
    if (tickIdx > this.beaconTickIdx) {
      const elapsed = Math.min(tickIdx - this.beaconTickIdx, 2);
      this.beaconTickIdx = tickIdx;
      if (b.controllerId === this.link.myId && !b.contested && this.pilot.alive) {
        this.progress.gainXp(BEACON_XP_PER_TICK * elapsed, now);
        this.fx.converge(this.pilot.shipX, this.pilot.shipY, 3, 60, 320, BEACON_TINT);
      }
    }
  }
}
