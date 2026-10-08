// A guest's copy of the host's world. Frames and ~1 Hz snapshots are applied
// the moment they arrive, in arrival order — except the motion of remote
// bodies, which renders INTERP_DELAY_MS behind the newest arrival, blended
// between the two frames that bracket that moment, so everyone else moves as
// smoothly as the host simulated them whatever the arrival jitter. Projectiles
// are the exception the other way: their hits land as fx on arrival, so they
// fly in the present, extrapolated along their velocity. The guest's own hero
// is predicted (net/own-hero.ts); the mirror only reports what the host said.
// Every host stamps its frames with the room's server time, so the clock all
// of this runs on outlives the host that happens to be sending.
import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { SenderClock } from "@vibedgames/multiplayer";
import { INTERP_DELAY_MS } from "../data/config";
import { isJsonNumber, isJsonObject, isJsonString } from "../data/json";
import type { JsonObject, JsonValue } from "../data/json";
import { ALL_ABILITY_KEYS } from "../sim/types";
import type {
  Coin,
  Delivery,
  FxEvent,
  GroundEffect,
  PendingStrike,
  Projectile,
  Unit,
  World,
} from "../sim/types";
import { ArrivalClock } from "./arrival-clock";
import { applySnapshot, blankUnit } from "./snapshot";
import type { Frame, Snapshot } from "./snapshot";

interface Pose {
  x: number;
  y: number;
  /** Aim heading, radians on the ground plane: atan2(aimY, aimX). */
  yaw: number;
}

const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
  yaw: lerpAngle(a.yaw, b.yaw, k),
});

/** A body that moved this far between frames teleported (respawn, blink). */
const TELEPORT_DIST = 6;
/** How far the sim clock runs past the newest frame when frames are late (ms). */
const MAX_AHEAD_MS = 150;
/** How far a projectile flies past its newest frame (ms). */
const MAX_SHOT_AHEAD_MS = 150;

/** What the host last said about the guest's own hero. */
export interface OwnReport {
  x: number;
  y: number;
  alive: boolean;
  /** The newest input the host applied, and World.now when it did. */
  ack: number | null;
  ackAt: number | null;
  /** World.now of the frame this report comes from. */
  n: number;
  /** Host-side motion, for the predictor to adopt what it did not predict. */
  dashUntil: number;
  dashVx: number;
  dashVy: number;
  jumpUntil: number;
}

interface RemoteBody {
  interp: Interpolator<Pose>;
  pose: Pose;
  aimX: number;
  aimY: number;
  pushed: Pose | null;
}

interface ShotBase {
  x: number;
  y: number;
  n: number;
}

/** Remote bodies take position and aim from interpolation, not the row. */
const REMOTE_SKIP = new Set(["x", "y", "aimX", "aimY"]);
/** The guest's own hero takes these from prediction (net/own-hero.ts) —
 *  knockback included, which prediction leaves to reconciliation. */
const OWN_SKIP = new Set([
  "x",
  "y",
  "vx",
  "vy",
  "steerVx",
  "steerVy",
  "facing",
  "aimX",
  "aimY",
  "moveX",
  "moveY",
  "attackHeld",
  "jumpUntil",
  "dashUntil",
  "dashVx",
  "dashVy",
  "kbUntil",
]);
const NO_SKIP = new Set<string>();

// Creep leash anchors carry sample values only so `fits` knows their kinds.
const UNIT_TEMPLATE: JsonObject = { ...blankUnit(), campId: "", homeX: 0, homeY: 0 };
const PHASES: World["phase"][] = ["lobby", "playing", "ended"];

/** A wire value of the right JSON kind for a field whose template is `proto`;
 *  object, array and nullable fields keep the host's structure as sent. */
const fits = (proto: JsonValue | undefined, value: JsonValue): boolean => {
  if (proto === undefined) {
    return false;
  }
  if (isJsonNumber(proto)) {
    return isJsonNumber(value);
  }
  if (isJsonString(proto)) {
    return isJsonString(value);
  }
  if (proto === true || proto === false) {
    return value === true || value === false;
  }
  return true;
};

/** Copy the row's fields onto `target` where they fit `template`. */
const assignRow = (
  target: JsonObject,
  row: JsonObject,
  template: JsonObject,
  skip: ReadonlySet<string>,
): void => {
  for (const [key, value] of Object.entries(row)) {
    if (!skip.has(key) && fits(template[key], value)) {
      target[key] = value;
    }
  }
};

const isRowMap = (v: JsonValue | undefined): v is Record<string, JsonObject> =>
  isJsonObject(v) && Object.values(v).every((row) => isJsonObject(row));

const idList = (v: JsonValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((id): id is string => isJsonString(id)) : [];

/** Validate a frame event's envelope. The fields inside rows are checked as
 *  they are applied. */
export const parseFrame = (payload: JsonValue): Frame | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { t, n, gt, u, p, g, c, d, w, b, fx } = payload;
  if (!isJsonNumber(t) || !isJsonNumber(n) || !isJsonNumber(gt)) {
    return null;
  }
  const frame: Frame = { gt, n, t };
  if (isRowMap(u)) {
    frame.u = u;
  }
  if (isRowMap(p)) {
    frame.p = p;
  }
  if (isRowMap(g)) {
    frame.g = g;
  }
  if (isRowMap(c)) {
    frame.c = c;
  }
  if (isRowMap(d)) {
    frame.d = d;
  }
  frame.ug = idList(payload["ug"]);
  frame.pg = idList(payload["pg"]);
  frame.gg = idList(payload["gg"]);
  frame.cg = idList(payload["cg"]);
  frame.dg = idList(payload["dg"]);
  if (isJsonObject(w)) {
    frame.w = w;
  }
  if (isJsonObject(b)) {
    frame.b = b;
  }
  if (Array.isArray(fx)) {
    // SAFETY: frames are written only by the host's FrameEncoder (this same
    // build serializing World.fx); fx are render-only and never feed back
    // into the sim.
    frame.fx = fx as FxEvent[];
  }
  return frame;
};

const blankProjectile = (): Projectile => ({
  damage: 0,
  dtype: "physical",
  hitIds: [],
  hitRadius: 0,
  id: "",
  isAttack: false,
  kind: "",
  launchH: 0,
  onHit: { tag: "none" },
  ownerId: "",
  pierce: false,
  radius: 0,
  range: 0,
  speed: 0,
  targetId: null,
  team: "",
  traveled: 0,
  vx: 0,
  vy: 0,
  x: 0,
  y: 0,
});
const PROJECTILE_TEMPLATE: JsonObject = { ...blankProjectile(), burstAtEnd: false };

const blankGround = (): GroundEffect => ({
  effect: "",
  id: "",
  nextTick: Number.POSITIVE_INFINITY,
  ownerId: "",
  radius: 0,
  team: "",
  tickInterval: 0,
  until: 0,
  x: 0,
  y: 0,
});
// Optional fields carry sample values only so `fits` knows their kinds.
const GROUND_TEMPLATE: JsonObject = {
  ...blankGround(),
  allyHps: 0,
  detonateAt: 0,
  detonateDmg: 0,
  detonateDtype: "",
  dtype: "",
  enemyDps: 0,
  hexMs: 0,
  rootMs: 0,
  slowMs: 0,
  slowPct: 0,
  stunMs: 0,
  telegraph: false,
};

const blankCoin = (): Coin => ({
  expireAt: 0,
  fromX: 0,
  fromY: 0,
  gold: 0,
  id: "",
  landAt: 0,
  x: 0,
  y: 0,
});
const COIN_TEMPLATE: JsonObject = { ...blankCoin(), loot: false };

const blankDelivery = (): Delivery => ({ expireAt: 0, id: "", x: 0, y: 0 });
const DELIVERY_TEMPLATE: JsonObject = blankDelivery();

/** Apply id-keyed rows to an array collection; rows for unknown ids create
 *  items only when they arrive complete (carrying `required`). */
const applyListRows = <T extends JsonObject & { id: string }>(
  list: T[],
  rows: Record<string, JsonObject> | undefined,
  gone: string[] | undefined,
  make: () => T,
  template: JsonObject,
  required: string,
): T[] => {
  let out = list;
  if (gone && gone.length > 0) {
    const drop = new Set(gone);
    out = out.filter((item) => !drop.has(item.id));
  }
  for (const [id, row] of Object.entries(rows ?? {})) {
    let item = out.find((candidate) => candidate.id === id);
    if (!item) {
      if (row[required] === undefined) {
        continue;
      }
      item = make();
      item.id = id;
      out.push(item);
    }
    assignRow(item, row, template, NO_SKIP);
  }
  return out;
};

/** One pending strike as the host's encoder wrote it, or null. Strikes feed
 *  a promoted guest's sim, so each field is checked rather than trusted. */
const parseStrike = (v: JsonValue): PendingStrike | null => {
  if (!isJsonObject(v)) {
    return null;
  }
  const { at, casterId, key, dx, dy, px, py, ox, oy, targetId } = v;
  const known = ALL_ABILITY_KEYS.find((k) => k === key);
  if (
    !known ||
    !isJsonString(casterId) ||
    !isJsonNumber(at) ||
    !isJsonNumber(dx) ||
    !isJsonNumber(dy) ||
    !isJsonNumber(px) ||
    !isJsonNumber(py) ||
    !isJsonNumber(ox) ||
    !isJsonNumber(oy)
  ) {
    return null;
  }
  const strike: PendingStrike = { at, casterId, dx, dy, key: known, ox, oy, px, py };
  if (isJsonString(targetId)) {
    strike.targetId = targetId;
  }
  return strike;
};

/** The sim's bookkeeping a frame changed: the id counter, the RNG, camp
 *  timers and strikes still to land — nothing a guest draws, everything a
 *  promoted guest's sim needs to carry on exactly where the host stopped. */
const applyBookkeeping = (world: World, row: JsonObject): void => {
  const { seq, rngState, campRespawnAt, strikes } = row;
  if (isJsonNumber(seq)) {
    world.seq = seq;
  }
  if (isJsonNumber(rngState)) {
    world.rngState = rngState;
  }
  if (isJsonObject(campRespawnAt)) {
    const camps: Record<string, number> = {};
    for (const [id, at] of Object.entries(campRespawnAt)) {
      if (isJsonNumber(at)) {
        camps[id] = at;
      }
    }
    world.campRespawnAt = camps;
  }
  if (Array.isArray(strikes)) {
    world.strikes = strikes.flatMap((v) => parseStrike(v) ?? []);
  }
};

/** World scalars and the boss, as a frame changed them. */
const applyScalars = (world: World, frame: Frame): void => {
  const { w: row, b: boss } = frame;
  if (row) {
    const { phase, winner, leaderId, killGoal, matchTime, suddenDeath, nextCoinAt } = row;
    const known = PHASES.find((p) => p === phase);
    if (known) {
      world.phase = known;
    }
    if (winner === null || isJsonString(winner)) {
      world.winner = winner;
    }
    if (leaderId === null || isJsonString(leaderId)) {
      world.leaderId = leaderId;
    }
    if (isJsonNumber(killGoal)) {
      world.killGoal = killGoal;
    }
    if (isJsonNumber(matchTime)) {
      world.matchTime = matchTime;
    }
    if (suddenDeath === true || suddenDeath === false) {
      world.suddenDeath = suddenDeath;
    }
    if (isJsonNumber(nextCoinAt)) {
      world.nextCoinAt = nextCoinAt;
    }
    if (isJsonNumber(row["nextDeliveryAt"])) {
      world.nextDeliveryAt = row["nextDeliveryAt"];
    }
    applyBookkeeping(world, row);
  }
  if (boss) {
    const target: JsonObject = world.boss;
    assignRow(target, boss, { ...world.boss }, NO_SKIP);
  }
};

/** A remote body's newest pose, with whichever of its fields the row moved. */
const updatePose = (body: RemoteBody, row: JsonObject): void => {
  const { x, y, aimX, aimY } = row;
  const pose = { ...body.pose };
  if (isJsonNumber(x)) {
    pose.x = x;
  }
  if (isJsonNumber(y)) {
    pose.y = y;
  }
  if (isJsonNumber(aimX) || isJsonNumber(aimY)) {
    body.aimX = isJsonNumber(aimX) ? aimX : body.aimX;
    body.aimY = isJsonNumber(aimY) ? aimY : body.aimY;
    pose.yaw = Math.atan2(body.aimY, body.aimX);
  }
  body.pose = pose;
};

export class NetMirror {
  /** The host's time as of the newest arrival — shared by every remote body. */
  readonly clock: ArrivalClock;
  /** Id of the guest's own hero (predicted, never interpolated). */
  ownId = "";
  private readonly bodies = new Map<string, RemoteBody>();
  private readonly shots = new Map<string, ShotBase>();
  private latest: { t: number; n: number; gt: number } | null = null;
  private floorNow = Number.NEGATIVE_INFINITY;
  private own: OwnReport | null = null;
  /** A snapshot arrived live and every frame since: the copy is the host's world. */
  private whole = false;

  /** `server` is the room's server clock (`client.serverClock`). */
  constructor(server: SenderClock) {
    this.clock = new ArrivalClock(server);
  }

  /** Forget interpolation and timing: a new match or a new world (positions
   *  restart). The clock stays: it is the server's, whoever hosts. */
  reset(): void {
    this.bodies.clear();
    this.shots.clear();
    this.latest = null;
    this.floorNow = Number.NEGATIVE_INFINITY;
    this.own = null;
    this.whole = false;
  }

  /**
   * Make this copy the host's world as of the newest frame, ready to step:
   * the clock on that frame's tick, and remote bodies and projectiles back
   * where the host last put them (they are drawn behind and ahead of it). The
   * own hero stays as prediction drew it. False, with nothing touched, unless
   * the copy is whole — a snapshot that arrived live and every frame since;
   * the one found on joining misses whatever changed before we arrived.
   */
  takeOver(world: World): boolean {
    const { latest } = this;
    if (!this.whole || !latest) {
      return false;
    }
    world.now = latest.n;
    world.gameTime = latest.gt;
    for (const [id, body] of this.bodies) {
      const u = world.units.get(id);
      if (u && id !== this.ownId) {
        u.x = body.pose.x;
        u.y = body.pose.y;
        u.aimX = body.aimX;
        u.aimY = body.aimY;
      }
    }
    for (const [id, base] of this.shots) {
      const p = world.projectiles.get(id);
      if (p) {
        p.x = base.x;
        p.y = base.y;
      }
    }
    return true;
  }

  /** Apply one frame. Returns the host's view of the own hero, if present.
   *  Frames are deltas, so every one is applied, whatever its stamp. */
  applyFrame(world: World, frame: Frame, receivedAt: number): OwnReport | null {
    this.clock.arrived(frame.t, receivedAt);
    applyScalars(world, frame);
    this.applyUnits(world, frame);
    this.applyProjectiles(world, frame);
    world.grounds = applyListRows(
      world.grounds,
      frame.g,
      frame.gg,
      blankGround,
      GROUND_TEMPLATE,
      "effect",
    );
    world.coins = applyListRows(world.coins, frame.c, frame.cg, blankCoin, COIN_TEMPLATE, "landAt");
    world.deliveries = applyListRows(
      world.deliveries,
      frame.d,
      frame.dg,
      blankDelivery,
      DELIVERY_TEMPLATE,
      "expireAt",
    );
    if (frame.fx) {
      world.fx.push(...frame.fx);
    }
    this.latest = { gt: frame.gt, n: frame.n, t: frame.t };
    this.pushPoses(world, frame.t, receivedAt);
    return this.ownReport(world, frame.n);
  }

  /** Adopt a full snapshot (the ~1 Hz resync, a late join, a new match).
   *  `live` is false for the one found on joining, which frames sent before
   *  we arrived have already moved past. */
  applySnapshot(
    world: World,
    snap: Snapshot,
    t: number | null,
    receivedAt: number,
    live: boolean,
  ): void {
    if (this.latest && snap.now < this.latest.n) {
      // A world from further back (a new host that only had the room's
      // snapshot, the one found on rejoining): what is buffered never
      // happened on its timeline.
      this.bodies.clear();
      this.shots.clear();
      this.latest = null;
      this.floorNow = Number.NEGATIVE_INFINITY;
    }
    this.whole = live;
    applySnapshot(world, snap);
    for (const id of this.bodies.keys()) {
      const u = world.units.get(id);
      if (!u || u.kind === "prop" || id === this.ownId) {
        this.bodies.delete(id);
      }
    }
    for (const u of world.units.values()) {
      if (u.id === this.ownId) {
        this.own = this.reportOf(u, snap.now);
      } else if (u.kind !== "prop") {
        const body = this.body(u);
        body.aimX = u.aimX;
        body.aimY = u.aimY;
        body.pose = { x: u.x, y: u.y, yaw: Math.atan2(u.aimY, u.aimX) };
      }
    }
    this.shots.clear();
    for (const p of world.projectiles.values()) {
      this.shots.set(p.id, { n: snap.now, x: p.x, y: p.y });
    }
    if (t !== null && (!this.latest || live)) {
      // Before any frame (a join), the snapshot is all there is to draw; a
      // live one is the newest word from the host until its tick's frame.
      const first = !this.latest;
      this.latest = { gt: snap.gameTime, n: snap.now, t };
      if (first) {
        this.pushPoses(world, t, receivedAt);
      }
    }
  }

  /** Bring the world to this render frame: the sim clock, every remote body at
   *  its interpolated pose, every projectile at its extrapolated spot. */
  render(world: World, localNow: number): void {
    const { latest } = this;
    if (!latest) {
      return;
    }
    const playing = world.phase === "playing";
    const ahead = Math.min(MAX_AHEAD_MS, Math.max(0, this.clock.now(localNow) - latest.t));
    world.now = Math.max(this.floorNow, latest.n + (playing ? ahead : 0));
    this.floorNow = world.now;
    world.gameTime = latest.gt + (playing ? (world.now - latest.n) / 1000 : 0);
    for (const [id, body] of this.bodies) {
      const u = id === this.ownId ? undefined : world.units.get(id);
      const pose = body.interp.sample(localNow);
      if (u && pose) {
        u.x = pose.x;
        u.y = pose.y;
        u.aimX = Math.cos(pose.yaw);
        u.aimY = Math.sin(pose.yaw);
      }
    }
    for (const [id, base] of this.shots) {
      const p = world.projectiles.get(id);
      if (p) {
        const dt = Math.min(MAX_SHOT_AHEAD_MS, Math.max(0, world.now - base.n)) / 1000;
        p.x = base.x + p.vx * dt;
        p.y = base.y + p.vy * dt;
      }
    }
  }

  private applyUnits(world: World, frame: Frame): void {
    for (const id of frame.ug ?? []) {
      world.units.delete(id);
      this.bodies.delete(id);
    }
    for (const [id, row] of Object.entries(frame.u ?? {})) {
      let u = world.units.get(id);
      const created = !u;
      if (!u) {
        // A partial row for a unit this guest never saw (it joined after the
        // unit appeared): the next snapshot brings it whole.
        if (!isJsonString(row["kind"])) {
          continue;
        }
        u = blankUnit();
        u.id = id;
        world.units.set(id, u);
      }
      const fields: JsonObject = u;
      if (id === this.ownId) {
        // a hero just spawned starts prediction from where the host put it
        assignRow(fields, row, UNIT_TEMPLATE, created ? NO_SKIP : OWN_SKIP);
        this.updateOwn(u, row);
      } else if (u.kind === "prop" || row["kind"] === "prop") {
        // props never move: their rows land as they are
        assignRow(fields, row, UNIT_TEMPLATE, NO_SKIP);
      } else {
        assignRow(fields, row, UNIT_TEMPLATE, REMOTE_SKIP);
        updatePose(this.body(u), row);
      }
    }
  }

  private applyProjectiles(world: World, frame: Frame): void {
    for (const id of frame.pg ?? []) {
      world.projectiles.delete(id);
      this.shots.delete(id);
    }
    for (const [id, row] of Object.entries(frame.p ?? {})) {
      let p = world.projectiles.get(id);
      if (!p) {
        if (!isJsonString(row["kind"])) {
          continue;
        }
        p = blankProjectile();
        p.id = id;
        world.projectiles.set(id, p);
      }
      const base = this.shots.get(id) ?? { n: frame.n, x: p.x, y: p.y };
      // The rendered position is extrapolated in place; restore the last
      // authoritative one before a row moves it.
      p.x = base.x;
      p.y = base.y;
      const fields: JsonObject = p;
      assignRow(fields, row, PROJECTILE_TEMPLATE, NO_SKIP);
      if (row["x"] !== undefined || row["y"] !== undefined) {
        this.shots.set(id, { n: frame.n, x: p.x, y: p.y });
      } else {
        this.shots.set(id, base);
      }
    }
  }

  private body(u: Unit): RemoteBody {
    let body = this.bodies.get(u.id);
    if (!body) {
      body = {
        aimX: u.aimX,
        aimY: u.aimY,
        interp: new Interpolator<Pose>({
          clock: this.clock,
          delayMs: INTERP_DELAY_MS,
          lerp: lerpPose,
        }),
        pose: { x: u.x, y: u.y, yaw: Math.atan2(u.aimY, u.aimX) },
        pushed: null,
      };
      this.bodies.set(u.id, body);
    }
    return body;
  }

  /** Every remote body gets a sample per frame, moved or not, so one that
   *  stopped is seen to stop rather than extrapolated past where it stood. */
  private pushPoses(world: World, t: number, receivedAt: number): void {
    for (const [id, body] of this.bodies) {
      if (id === this.ownId || !world.units.has(id)) {
        this.bodies.delete(id);
        continue;
      }
      const last = body.pushed;
      if (last && Math.hypot(body.pose.x - last.x, body.pose.y - last.y) > TELEPORT_DIST) {
        body.interp.clear();
      }
      body.interp.push(t, body.pose, receivedAt);
      body.pushed = body.pose;
    }
  }

  private updateOwn(u: Unit, row: JsonObject): void {
    const { x, y, ack, ackAt, dashUntil, dashVx, dashVy, jumpUntil } = row;
    // The unit's own x/y are the prediction's: report nothing until the host
    // (a snapshot, or a row that moves the hero) says where it is.
    if (!this.own && !(isJsonNumber(x) && isJsonNumber(y))) {
      return;
    }
    const own = this.own ?? this.reportOf(u, 0);
    if (isJsonNumber(x)) {
      own.x = x;
    }
    if (isJsonNumber(y)) {
      own.y = y;
    }
    if (isJsonNumber(ack)) {
      own.ack = ack;
    }
    if (isJsonNumber(ackAt)) {
      own.ackAt = ackAt;
    }
    if (isJsonNumber(dashUntil)) {
      own.dashUntil = dashUntil;
    }
    if (isJsonNumber(dashVx)) {
      own.dashVx = dashVx;
    }
    if (isJsonNumber(dashVy)) {
      own.dashVy = dashVy;
    }
    if (isJsonNumber(jumpUntil)) {
      own.jumpUntil = jumpUntil;
    }
    this.own = own;
  }

  private reportOf(u: Unit, n: number): OwnReport {
    return {
      ack: this.own?.ack ?? null,
      ackAt: this.own?.ackAt ?? null,
      alive: u.alive,
      dashUntil: u.dashUntil,
      dashVx: u.dashVx,
      dashVy: u.dashVy,
      jumpUntil: u.jumpUntil,
      n,
      x: u.x,
      y: u.y,
    };
  }

  private ownReport(world: World, n: number): OwnReport | null {
    const u = world.units.get(this.ownId);
    const { own } = this;
    if (!u || !own) {
      return null;
    }
    own.alive = u.alive;
    own.n = n;
    return { ...own };
  }
}
