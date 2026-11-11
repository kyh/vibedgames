// The other players, as this client sees them: an avatar each, played back
// from their own body reports on a clock that learns each sender's route, in
// their team's colour. `bodies()` is what the host's rules read positions
// from; `hitTest()` is what this client's own shots are tested against.
import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import { Raycaster, Vector3 } from "three";
import type { Mesh, Object3D } from "three";

import type { StrikeforceGame, ShotHit } from "../core/types";
import { Avatar } from "./avatar";
import { TEAM_COLOR } from "./protocol";
import type { Bodies, Point, Team } from "./rules";
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

/** A stable two-digit callsign from a player id: "SF-17". */
export const callsignOf = (id: string): string => {
  let hash = 0;
  for (const ch of id) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  }
  return `SF-${String(10 + (hash % 90))}`;
};

export interface Opponent {
  readonly id: string;
  readonly callsign: string;
  avatar: Avatar | null;
  team: Team | null;
  readonly interp: Interpolator<Pose>;
  /** Latest reported (not interpolated) body, for the host's rules. */
  reported: Point | null;
  /** The life (rules.ts) the body says it is playing. */
  life: number;
  hp: number;
  alive: boolean;
  /** Past the title screen: in the match. */
  deployed: boolean;
  connected: boolean;
  /** The interpolated pose this frame, or null before the first report. */
  pose: Pose | null;
}

export interface PlayerEvents {
  joined: (p: Opponent) => void;
  left: (p: Opponent) => void;
}

const readReport = (p: Opponent, player: Player): void => {
  const s = player.state ?? {};
  const { t, x, y, z, yaw, pitch } = s;
  p.connected = player.connected !== false;
  p.alive = s.a === 1;
  p.deployed = s.d === 1;
  p.hp = isNum(s.hp) ? s.hp : p.hp;
  p.life = isNum(s.l) ? s.l : p.life;
  if (isNum(t) && isNum(x) && isNum(y) && isNum(z) && isNum(yaw) && isNum(pitch)) {
    p.interp.push(t, { crouch: s.c === 1 ? 1 : 0, pitch, x, y, yaw, z });
    p.reported = { x, y, z };
  }
};

export class Players {
  readonly all = new Map<string, Opponent>();
  private readonly game: StrikeforceGame;
  private readonly events: PlayerEvents;
  private readonly ray = new Raycaster();

  constructor(game: StrikeforceGame, events: PlayerEvents) {
    this.game = game;
    this.events = events;
  }

  /** Read every other player's report and pose its avatar. `teamOf` is the host's roster. */
  update(
    players: Record<string, Player>,
    myId: string,
    myTeam: Team | null,
    teamOf: (id: string) => { team: Team; alive: boolean } | null,
    dt: number,
  ): void {
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) {
        continue;
      }
      const p = this.all.get(id) ?? this.add(id);
      readReport(p, player);
      const seat = teamOf(id);
      this.dress(p, seat?.team ?? null, myTeam);
      p.pose = p.interp.sample() ?? null;
      const shown = Boolean(p.pose && p.avatar && seat);
      if (p.avatar) {
        p.avatar.root.visible = shown;
        if (p.pose && shown) {
          p.avatar.update({ ...p.pose, alive: seat?.alive ?? false }, dt);
        }
      }
    }
    for (const [id, p] of this.all) {
      if (players[id]) {
        continue;
      }
      this.all.delete(id);
      p.avatar?.dispose();
      this.events.left(p);
    }
  }

  /** Everyone's latest reported position, for the host's rules. */
  bodies(): Bodies {
    const out: Bodies = {};
    for (const [id, p] of this.all) {
      out[id] = p.reported ?? undefined;
    }
    return out;
  }

  /**
   * The nearest living enemy hitbox along a shot, closer than `maxDist`.
   * `enemies` are the ids on the other team.
   */
  hitTest(
    origin: Vector3,
    dir: Vector3,
    maxDist: number,
    isEnemy: (id: string) => boolean,
  ): (ShotHit & { id: string }) | null {
    const boxes: Mesh[] = [];
    const owner = new Map<Object3D, string>();
    for (const [id, p] of this.all) {
      if (!p.avatar || !p.avatar.root.visible || !isEnemy(id)) {
        continue;
      }
      p.avatar.root.updateMatrixWorld(true);
      for (const box of p.avatar.hitboxes) {
        boxes.push(box);
        owner.set(box, id);
      }
    }
    if (boxes.length === 0) {
      return null;
    }
    this.ray.set(origin, dir);
    this.ray.far = maxDist;
    const [hit] = this.ray.intersectObjects(boxes, false);
    const id = hit ? owner.get(hit.object) : undefined;
    if (!hit || !id) {
      return null;
    }
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : dir.clone().negate();
    return {
      dist: hit.distance,
      id,
      normal,
      part: hit.object.userData.part === "head" ? "head" : "body",
      point: hit.point.clone(),
      who: hit.object,
    };
  }

  /** Keep every avatar out of the scene's way (solo PvE, the title). */
  hide(): void {
    for (const p of this.all.values()) {
      if (p.avatar) {
        p.avatar.root.visible = false;
      }
    }
  }

  clear(): void {
    for (const p of this.all.values()) {
      p.avatar?.dispose();
    }
    this.all.clear();
  }

  private add(id: string): Opponent {
    const p: Opponent = {
      alive: false,
      avatar: null,
      callsign: callsignOf(id),
      connected: true,
      deployed: false,
      hp: 100,
      id,
      interp: new Interpolator<Pose>({ lerp: lerpPose }),
      life: -1,
      pose: null,
      reported: null,
      team: null,
    };
    this.all.set(id, p);
    this.events.joined(p);
    return p;
  }

  /** Build (or rebuild, if the team changed) the avatar in its team's colour. */
  private dress(p: Opponent, team: Team | null, myTeam: Team | null): void {
    if (team === null) {
      return;
    }
    if (p.team !== team || !p.avatar) {
      p.avatar?.dispose();
      p.avatar = new Avatar(p.callsign, TEAM_COLOR[team]);
      p.avatar.root.visible = false;
      this.game.scene.add(p.avatar.root);
      p.team = team;
      p.interp.clear();
    }
    p.avatar.setFriendly(team === myTeam);
  }
}

export const toVector = (p: Point): Vector3 => new Vector3(p.x, p.y, p.z);
