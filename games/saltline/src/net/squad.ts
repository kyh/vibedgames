// The other squad members, as this client sees them: an avatar each, played
// back from their own body reports on a clock that learns each sender's route,
// and — on the host — a stand-in the machines can see, chase and shoot. A hit
// on a stand-in becomes a `hurt` event to that player, whose own client applies
// it to their own body.
import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { EnemyTarget, SaltlineGame } from "../core/types";
import { Avatar } from "./avatar";
import { PHASE } from "./protocol";
import { isNum } from "./wire";

interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
}

const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  crouch: lerp(a.crouch, b.crouch, k),
  pitch: lerp(a.pitch, b.pitch, k),
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
  yaw: lerpAngle(a.yaw, b.yaw, k),
  z: lerp(a.z, b.z, k),
});

/** A stable two-digit callsign from a player id: "B4-17". */
export const callsignOf = (id: string): string => {
  let hash = 0;
  for (const ch of id) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  }
  return `B4-${String(10 + (hash % 90))}`;
};

export interface Member {
  readonly id: string;
  readonly callsign: string;
  readonly avatar: Avatar;
  readonly interp: Interpolator<Pose>;
  readonly target: EnemyTarget;
  phase: number;
  hp: number;
  connected: boolean;
}

export interface SquadEvents {
  joined: (member: Member) => void;
  left: (member: Member) => void;
  down: (member: Member) => void;
  hurt: (member: Member, amount: number, from: Vector3 | undefined) => void;
}

export class Squad {
  readonly members = new Map<string, Member>();
  private readonly game: SaltlineGame;
  private readonly events: SquadEvents;

  constructor(game: SaltlineGame, events: SquadEvents) {
    this.game = game;
    this.events = events;
  }

  /** Bodies the machines may hunt: the members out on the dock. */
  targets(): EnemyTarget[] {
    const out: EnemyTarget[] = [];
    for (const member of this.members.values()) {
      if (member.target.alive) {
        out.push(member.target);
      }
    }
    return out;
  }

  /** Any member deployed (alive or down) — the run is theirs too. */
  anyInRun(): boolean {
    for (const member of this.members.values()) {
      if (member.phase === PHASE.deployed || member.phase === PHASE.down) {
        return true;
      }
    }
    return false;
  }

  update(players: Record<string, Player>, myId: string, dt: number): void {
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) {
        continue;
      }
      const member = this.members.get(id) ?? this.add(id, player.color ?? "#ffb347");
      this.read(member, player, dt);
    }
    for (const [id, member] of this.members) {
      if (players[id]) {
        continue;
      }
      this.members.delete(id);
      member.avatar.dispose();
      this.events.left(member);
    }
  }

  clear(): void {
    for (const member of this.members.values()) {
      member.avatar.dispose();
    }
    this.members.clear();
  }

  private add(id: string, color: string): Member {
    const callsign = callsignOf(id);
    const avatar = new Avatar(callsign, color);
    avatar.root.visible = false;
    this.game.scene.add(avatar.root);
    const pos = new Vector3();
    const eye = new Vector3();
    const target: EnemyTarget = {
      alive: false,
      crouching: false,
      damage: (amount, from) => {
        if (target.alive) {
          this.events.hurt(member, amount, from);
        }
      },
      eye,
      pos,
      speed: 0,
      vel: new Vector3(),
    };
    const member: Member = {
      avatar,
      callsign,
      connected: true,
      hp: 100,
      id,
      interp: new Interpolator<Pose>({ lerp: lerpPose }),
      phase: PHASE.menu,
      target,
    };
    this.members.set(id, member);
    this.events.joined(member);
    return member;
  }

  private read(member: Member, player: Player, dt: number): void {
    const s = player.state ?? {};
    const { t, x, y, z, yaw, pitch } = s;
    member.connected = player.connected !== false;
    if (isNum(t) && isNum(x) && isNum(y) && isNum(z) && isNum(yaw) && isNum(pitch)) {
      member.interp.push(t, { crouch: s.c === 1 ? 1 : 0, pitch, x, y, yaw, z });
    }
    const phase = isNum(s.ph) ? s.ph : PHASE.menu;
    const alive = s.a === 1;
    if (member.phase === PHASE.deployed && phase === PHASE.down) {
      this.events.down(member);
    }
    member.phase = phase;
    member.hp = isNum(s.hp) ? s.hp : member.hp;

    const pose = member.interp.sample();
    const onDock = phase === PHASE.deployed || phase === PHASE.down;
    member.avatar.root.visible = Boolean(pose) && onDock;
    const { target } = member;
    if (!pose) {
      target.alive = false;
      return;
    }
    member.avatar.update({ ...pose, alive }, dt);
    if (dt > 0) {
      target.vel.set(pose.x - target.pos.x, pose.y - target.pos.y, pose.z - target.pos.z);
      target.vel.multiplyScalar(1 / dt).clampLength(0, 12);
    }
    target.pos.set(pose.x, pose.y, pose.z);
    target.eye.set(pose.x, pose.y + (pose.crouch > 0.5 ? 1.05 : 1.68), pose.z);
    target.crouching = pose.crouch > 0.5;
    target.speed = Math.hypot(target.vel.x, target.vel.z);
    target.alive = alive && phase === PHASE.deployed && member.connected;
  }
}
