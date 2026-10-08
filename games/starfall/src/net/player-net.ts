import { FixedRate } from "@vibedgames/multiplayer";
import { now as simNow } from "../shared/clock";
import { PLAYER_NET_HZ, XP, entityId } from "../shared/constants";
import type { BoostNetState, PlayerNetState, SharedState } from "../shared/constants";
import { playerToWire } from "../shared/wire";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import type { Progression } from "../sys/progression";
import type { RemoteFire } from "../sys/remote-fire";
import type { Shield } from "../sys/shield";
import type { Weapons } from "../sys/weapons";
import type { HostCombat } from "./host-combat";
import { readIntents } from "./intents";
import { removeById } from "./shared-world";
import { asWireRecord } from "./wire-read";
import type { WireValue } from "./wire-read";
import type { WorldSync } from "./world-sync";

export interface PlayerNetDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  weapons: Weapons;
  hostCombat: HostCombat;
  sync: WorldSync;
  shield: Shield;
  progress: Progression;
  remoteFire: RemoteFire;
}

/** My ship on the wire — a fixed-rate push of flat primitives, stamped for the receivers' interpolation — and the inbound event router: other players' shots, kill credit, and host intents when I am host. */
export class PlayerNet {
  /** Steady send cadence: keeps the remainder, so updates leave evenly. */
  private readonly sendRate = new FixedRate(PLAYER_NET_HZ);

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly weapons: Weapons;

  private readonly hostCombat: HostCombat;

  private readonly sync: WorldSync;

  private readonly shield: Shield;

  private readonly progress: Progression;

  private readonly remoteFire: RemoteFire;

  constructor(deps: PlayerNetDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.weapons = deps.weapons;
    this.hostCombat = deps.hostCombat;
    this.sync = deps.sync;
    this.shield = deps.shield;
    this.progress = deps.progress;
    this.remoteFire = deps.remoteFire;
  }

  netSend(delta: number, now: number): void {
    if (this.sendRate.due(delta)) {
      this.pushMyState(now);
    }
  }

  /** My live boosters and their expiries (the DEV summary). */
  boostsNetState(): BoostNetState[] {
    const out: BoostNetState[] = [];
    for (const [kind, until] of this.pilot.boosts) {
      out.push({ kind, until });
    }
    return out;
  }

  pushMyState(now: number): void {
    if (!this.link.myId) {
      return;
    }
    const { boosts } = this.pilot;
    const state: PlayerNetState = {
      alive: this.pilot.alive,
      angle: this.pilot.shipAngle,
      invuln: now < this.pilot.invulnUntil,
      level: this.progress.level,
      magnet: boosts.has("magnet"),
      nitro: boosts.has("nitro"),
      overHp: Math.max(0, Math.round(this.shield.overHp)),
      // present tracks "in the arena": spawned covers pre-spawn AND the paused
      // despawn (which clears spawned) in one flag.
      present: this.pilot.spawned,
      sectorScore: Math.round(this.progress.sectorScore),
      shieldHp: Math.max(0, Math.round(this.shield.shieldHp)),
      shieldMod: this.shield.shieldModNetState(now),
      streak: this.progress.streak,
      // The interpolation stamp: the same clock my fire events carry.
      t: performance.now(),
      tesla: this.weapons.teslaActive(now),
      twin: boosts.has("twin"),
      vx: this.pilot.shipVX,
      vy: this.pilot.shipVY,
      weaponName: this.pilot.weapon.name,
      windup: this.weapons.windupFrac(),
      x: this.pilot.shipX,
      xp: this.progress.xp,
      y: this.pilot.shipY,
    };
    this.link.pushMyState(playerToWire(state));
  }

  handleEvent(event: string, payload: WireValue, from: string): void {
    if (event === "fire") {
      this.remoteFire.receive(from, payload, performance.now());
      return;
    }
    if (event === "player_killed") {
      // Only the killer is sent the victim's report; it credits itself.
      if (asWireRecord(payload)?.["killerId"] === this.link.myId) {
        this.progress.registerKill(XP.PLAYER_KILL, simNow(), "player");
      }
      return;
    }
    if (event !== "intents" || !this.sync.prepareHost()) {
      return;
    }
    const batch = readIntents(payload);
    if (!batch) {
      return;
    }
    for (const hit of batch.hits) {
      this.hostCombat.hostHandleHit(hit);
    }
    for (const id of batch.shots) {
      removeById(this.world.enemyShots, id);
    }
    for (const id of batch.items) {
      removeById(this.world.items, id);
    }
    for (const id of batch.shards) {
      removeById(this.world.shards, id);
    }
    // SINGULARITY collapse: one shared pull entry; hostApplyPulls drags
    // enemies/asteroids until it expires (pruned in hostTick).
    const now = simNow();
    for (const pull of batch.pulls) {
      this.world.pulls.push({ id: entityId(), until: now + pull.ms, x: pull.x, y: pull.y });
    }
  }
}
