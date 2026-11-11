// A guest's copy of the host's machines. Each host enemy becomes a local body
// spawned passive (its brain never runs) and posed every frame from the host's
// snapshots through an Interpolator on the host's clock. When the host's entry
// disappears mid-run the body is handed to its own death animation (the drone's
// fall, the hound's collapse), which runs locally from then on.
import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { JsonRecord } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { EnemyBody, EnemyType, SaltlineGame } from "../core/types";
import { nums } from "./wire";

/** Pose slots that are angles, per type (see `_net` in saltline-core.js). */
const ANGLES: Record<EnemyType, ReadonlySet<number>> = {
  gull: new Set([4, 5, 6, 7, 8]),
  hound: new Set([4, 7, 9]),
};

const typeOf = (pose: readonly number[]): EnemyType => (pose[0] === 1 ? "hound" : "gull");

const lerpPose = (a: number[], b: number[], k: number): number[] => {
  const angles = ANGLES[typeOf(b)];
  const last = b.length - 1;
  return b.map((bv, i) => {
    const av = a[i] ?? bv;
    if (i === 0 || i === last) {
      return bv;
    }
    return angles.has(i) ? lerpAngle(av, bv, k) : lerp(av, bv, k);
  });
};

interface Puppet {
  body: EnemyBody;
  interp: Interpolator<number[]>;
}

export class Puppets {
  /** One clock for every pose the host sends. */
  readonly clock = new RemoteClock();
  private readonly byNetId = new Map<string, Puppet>();
  private readonly netIds = new Map<EnemyBody, string>();
  private readonly spot = new Vector3();
  private readonly game: SaltlineGame;

  constructor(game: SaltlineGame) {
    this.game = game;
  }

  /** The host's id for a local body, or null if it is not one of the host's. */
  netIdOf(body: EnemyBody): string | null {
    return this.netIds.get(body) ?? null;
  }

  get size(): number {
    return this.byNetId.size;
  }

  byId(netId: string): EnemyBody | null {
    return this.byNetId.get(netId)?.body ?? null;
  }

  /** Apply one host snapshot's `en` table. `live` false: the host has no run. */
  apply(stamp: number, table: JsonRecord, live: boolean): void {
    for (const [netId, raw] of Object.entries(table)) {
      const pose = nums(raw, 13);
      if (!pose) {
        continue;
      }
      let puppet = this.byNetId.get(netId);
      if (!puppet) {
        const created = this.spawn(netId, pose);
        if (!created) {
          continue;
        }
        puppet = created;
      }
      puppet.interp.push(stamp, pose);
    }
    for (const [netId, puppet] of this.byNetId) {
      if (netId in table) {
        continue;
      }
      if (live && puppet.body.alive) {
        // Killed on the host: play the death here. The body stays mapped until
        // its wreck retires, so a late hit on it still names the right id.
        puppet.body._kill(null);
      } else if (!live) {
        this.drop(netId, puppet);
      }
    }
  }

  /** Every frame: pose the living, let the dead finish falling. */
  step(dt: number): void {
    for (const [netId, puppet] of this.byNetId) {
      const { body } = puppet;
      if (!body.active) {
        this.forget(netId, puppet);
        continue;
      }
      if (body.alive) {
        const pose = puppet.interp.sample();
        if (pose) {
          body._puppet(dt, pose);
        }
      } else {
        body._update(dt);
      }
    }
  }

  /** Forget every mapping. `deactivate` also removes the bodies from the world. */
  clear(deactivate: boolean): void {
    for (const [netId, puppet] of this.byNetId) {
      if (deactivate && puppet.body.active) {
        this.drop(netId, puppet);
      } else {
        this.forget(netId, puppet);
      }
    }
    this.clock.relearn();
  }

  /**
   * This client is the host now: the bodies it was drawing become real
   * machines, alert and hunting from where they stand.
   */
  promote(): void {
    for (const [netId, puppet] of this.byNetId) {
      const { body } = puppet;
      if (body.alive) {
        body.passive = false;
        body.mode = "investigate";
      }
      this.forget(netId, puppet);
    }
  }

  private spawn(netId: string, pose: readonly number[]): Puppet | null {
    this.spot.set(pose[1] ?? 0, pose[2] ?? 0, pose[3] ?? 0);
    const body = this.game.enemies.spawn(typeOf(pose), this.spot, {
      passive: true,
      yaw: pose[4] ?? 0,
    });
    if (!body) {
      return null;
    }
    const puppet: Puppet = {
      body,
      interp: new Interpolator<number[]>({ clock: this.clock, lerp: lerpPose }),
    };
    this.byNetId.set(netId, puppet);
    this.netIds.set(body, netId);
    return puppet;
  }

  private drop(netId: string, puppet: Puppet): void {
    const { list } = this.game.enemies;
    const at = list.indexOf(puppet.body);
    if (at !== -1) {
      list.splice(at, 1);
    }
    puppet.body._deactivate();
    this.forget(netId, puppet);
  }

  private forget(netId: string, puppet: Puppet): void {
    this.byNetId.delete(netId);
    this.netIds.delete(puppet.body);
  }
}
