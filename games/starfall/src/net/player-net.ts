import type { GameScene } from "../scenes/game-scene";
import { now as simNow } from "../shared/clock";
import { NET_INTERVAL_MS, XP, entityId } from "../shared/constants";
import type { BoostNetState, PlayerNetState } from "../shared/constants";
import { playerToWire } from "../shared/wire";
import { serializeBeam } from "../sys/beam";
import { asWireRecord, wireNum, wireStr } from "./wire-read";
import type { WireValue } from "./wire-read";

type NetScene = Pick<
  GameScene,
  | "alive"
  | "boosts"
  | "client"
  | "connected"
  | "host"
  | "hostCombat"
  | "invulnUntil"
  | "myId"
  | "offline"
  | "progress"
  | "shield"
  | "shipAngle"
  | "shipVX"
  | "shipVY"
  | "shipX"
  | "shipY"
  | "spawned"
  | "sync"
  | "weapon"
  | "weapons"
  | "world"
>;

/** My ship on the wire: the 20Hz state push (pose, shield, loadout, beams) and the inbound event router (kill credit for everyone, host commands when I am host). */
export class PlayerNet {
  // networking cadence
  private netAcc = 0;

  private readonly scene: NetScene;

  constructor(scene: NetScene) {
    this.scene = scene;
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
    for (const [kind, until] of this.scene.boosts) {
      out.push({ kind, until });
    }
    return out;
  }

  pushMyState(now: number): void {
    if (!this.scene.myId) {
      return;
    }
    const state: PlayerNetState = {
      alive: this.scene.alive,
      angle: this.scene.shipAngle,
      beams: this.scene.weapons.beams.filter((b) => !b.vanished && !b.fizzle).map(serializeBeam),
      boosts: this.boostsNetState(),
      invuln: now < this.scene.invulnUntil,
      level: this.scene.progress.level,
      overHp: Math.max(0, Math.round(this.scene.shield.overHp)),
      // present tracks "in the arena": spawned covers pre-spawn AND the paused
      // despawn (which clears spawned) in one flag.
      present: this.scene.spawned,
      sectorScore: Math.round(this.scene.progress.sectorScore),
      sentry:
        this.scene.weapons.sentry && now < this.scene.weapons.sentry.until
          ? {
              until: this.scene.weapons.sentry.until,
              x: this.scene.weapons.sentry.x,
              y: this.scene.weapons.sentry.y,
            }
          : null,
      shieldHp: Math.max(0, Math.round(this.scene.shield.shieldHp)),
      shieldMod: this.scene.shield.shieldModNetState(now),
      streak: this.scene.progress.streak,
      tesla: this.scene.weapons.teslaActive(now),
      vx: this.scene.shipVX,
      vy: this.scene.shipVY,
      weaponName: this.scene.weapon.name,
      windup: this.scene.weapons.windupFrac(),
      x: this.scene.shipX,
      xp: this.scene.progress.xp,
      y: this.scene.shipY,
    };
    if (!this.scene.offline && this.scene.connected) {
      this.scene.client.updateMyState(playerToWire(state));
    }
  }

  handleEvent(event: string, payload: WireValue, _from: string): void {
    const p = asWireRecord(payload);
    if (event === "player_killed") {
      // The killer awards itself: every client hears the victim's report.
      if (p && p["killerId"] === this.scene.myId) {
        this.scene.progress.registerKill(XP.PLAYER_KILL, simNow(), "player");
      }
      return;
    }
    if (!this.scene.sync.prepareHost() || !p) {
      return;
    }
    if (event === "asteroid_hit" || event === "ufo_hit" || event === "enemy_hit") {
      this.scene.hostCombat.hostHandleHit(event, p);
      return;
    }
    if (event === "proj_consumed") {
      this.scene.hostCombat.hostRemoveById(
        this.scene.world.enemyShots,
        wireStr(p["shotId"]),
        "enemyShots",
      );
    } else if (event === "item_pickup") {
      this.scene.hostCombat.hostRemoveById(this.scene.world.items, wireStr(p["itemId"]), "items");
    } else if (event === "shard_pickup") {
      this.scene.hostCombat.hostRemoveById(
        this.scene.world.shards,
        wireStr(p["shardId"]),
        "shards",
      );
    } else if (event === "singularity") {
      // SINGULARITY collapse: one shared pull entry; hostApplyPulls drags
      // enemies/asteroids until it expires (pruned in hostTick).
      const x = wireNum(p["x"]);
      const y = wireNum(p["y"]);
      const until = wireNum(p["until"]);
      if (x !== null && y !== null && until !== null) {
        this.scene.world.pulls.push({ id: entityId(), until, x, y });
        this.scene.host.dirty.pulls = true;
      }
    }
  }
}
