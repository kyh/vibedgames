import { now as simNow } from "../shared/clock";
import { NET_INTERVAL_MS, XP, entityId } from "../shared/constants";
import type { BoostNetState, PlayerNetState, SharedState } from "../shared/constants";
import { playerToWire } from "../shared/wire";
import type { DirtyFlags } from "../state/dirty-flags";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { serializeBeam } from "../sys/beam";
import type { Progression } from "../sys/progression";
import type { Shield } from "../sys/shield";
import type { Weapons } from "../sys/weapons";
import type { HostCombat } from "./host-combat";
import { asWireRecord, wireNum, wireStr } from "./wire-read";
import type { WireValue } from "./wire-read";
import type { WorldSync } from "./world-sync";

export interface PlayerNetDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  dirty: DirtyFlags;
  weapons: Weapons;
  hostCombat: HostCombat;
  sync: WorldSync;
  shield: Shield;
  progress: Progression;
}

/** My ship on the wire: the 20Hz state push (pose, shield, loadout, beams) and the inbound event router (kill credit for everyone, host commands when I am host). */
export class PlayerNet {
  // networking cadence
  private netAcc = 0;

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly dirty: DirtyFlags;

  private readonly weapons: Weapons;

  private readonly hostCombat: HostCombat;

  private readonly sync: WorldSync;

  private readonly shield: Shield;

  private readonly progress: Progression;

  constructor(deps: PlayerNetDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.dirty = deps.dirty;
    this.weapons = deps.weapons;
    this.hostCombat = deps.hostCombat;
    this.sync = deps.sync;
    this.shield = deps.shield;
    this.progress = deps.progress;
  }

  netSend(delta: number, now: number): void {
    this.netAcc += delta;
    if (this.netAcc < NET_INTERVAL_MS) {
      return;
    }
    this.netAcc = 0;
    this.pushMyState(now);
  }

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
    const state: PlayerNetState = {
      alive: this.pilot.alive,
      angle: this.pilot.shipAngle,
      beams: this.weapons.beams.filter((b) => !b.vanished && !b.fizzle).map(serializeBeam),
      boosts: this.boostsNetState(),
      invuln: now < this.pilot.invulnUntil,
      level: this.progress.level,
      overHp: Math.max(0, Math.round(this.shield.overHp)),
      // present tracks "in the arena": spawned covers pre-spawn AND the paused
      // despawn (which clears spawned) in one flag.
      present: this.pilot.spawned,
      sectorScore: Math.round(this.progress.sectorScore),
      sentry:
        this.weapons.sentry && now < this.weapons.sentry.until
          ? {
              until: this.weapons.sentry.until,
              x: this.weapons.sentry.x,
              y: this.weapons.sentry.y,
            }
          : null,
      shieldHp: Math.max(0, Math.round(this.shield.shieldHp)),
      shieldMod: this.shield.shieldModNetState(now),
      streak: this.progress.streak,
      tesla: this.weapons.teslaActive(now),
      vx: this.pilot.shipVX,
      vy: this.pilot.shipVY,
      weaponName: this.pilot.weapon.name,
      windup: this.weapons.windupFrac(),
      x: this.pilot.shipX,
      xp: this.progress.xp,
      y: this.pilot.shipY,
    };
    if (!this.link.offline && this.link.connected) {
      this.link.pushMyState(playerToWire(state));
    }
  }

  handleEvent(event: string, payload: WireValue, _from: string): void {
    const p = asWireRecord(payload);
    if (event === "player_killed") {
      // The killer awards itself: every client hears the victim's report.
      if (p && p["killerId"] === this.link.myId) {
        this.progress.registerKill(XP.PLAYER_KILL, simNow(), "player");
      }
      return;
    }
    if (!this.sync.prepareHost() || !p) {
      return;
    }
    if (event === "asteroid_hit" || event === "ufo_hit" || event === "enemy_hit") {
      this.hostCombat.hostHandleHit(event, p);
      return;
    }
    if (event === "proj_consumed") {
      this.hostCombat.hostRemoveById(this.world.enemyShots, wireStr(p["shotId"]), "enemyShots");
    } else if (event === "item_pickup") {
      this.hostCombat.hostRemoveById(this.world.items, wireStr(p["itemId"]), "items");
    } else if (event === "shard_pickup") {
      this.hostCombat.hostRemoveById(this.world.shards, wireStr(p["shardId"]), "shards");
    } else if (event === "singularity") {
      // SINGULARITY collapse: one shared pull entry; hostApplyPulls drags
      // enemies/asteroids until it expires (pruned in hostTick).
      const x = wireNum(p["x"]);
      const y = wireNum(p["y"]);
      const until = wireNum(p["until"]);
      if (x !== null && y !== null && until !== null) {
        this.world.pulls.push({ id: entityId(), until, x, y });
        this.dirty.pulls = true;
      }
    }
  }
}
