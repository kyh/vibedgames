// Guest-side mirror of the host's sim. The guest's own body is predicted from
// local input and reconciled against the host at matching moments
// (prediction.ts); every other brawler renders from frames stamped with the
// room's server time, INTERP_DELAY_MS behind the newest frame that could have
// arrived by now or as far as the stream needs (frame-clock.ts,
// interpolation.ts). FX, projectile spawns and loot changes play when that
// same render time reaches the frame that carried them, so a muzzle flash
// leaves the muzzle it belongs to. Bullets and bombs fly locally from their
// spawn rows, and the guest's own shots fly from the button press; the host's
// copies decide every hit. The HUD banners are derived here from phase and
// roster edges.
import type * as THREE from "three";

import { placeLob } from "../combat/bombs";
import {
  BULLET_Y,
  drawProjectile,
  finishProjectileMesh,
  SPENT_IMPACT,
  WALL_IMPACT,
} from "../combat/bullets";
import type { BombSlot, Cube, GhostSink, LootBox } from "../combat/combat";
import { setBombAppearance } from "../combat/combat";
import { BRAWLER_RADIUS } from "../config";
import type { LobAttack, ProjectileAttack } from "../config";
import type { Brawler } from "../entities/brawler";
import { leapFlight, leapPoint } from "../entities/movement";
import type { Game } from "../game";
import { setSpectateCopy } from "../hud-lobby";
import { pushOwnApart } from "../roster-sim";
import { clamp } from "../utils";
import { GRID } from "../world/grid";
import { conformGroundGeometry } from "../world/terrain";
import { FrameClock } from "./frame-clock";
import { spawnFromNet } from "./host";
import type { OwnPose } from "./host";
import { IntentLink } from "./intent-link";
import { maxHpFor, PuppetTrack } from "./interpolation";
import type { OwnPrediction } from "./prediction";
import type { FxRecord, LobRow, ShotRow } from "./presentation";
import { replayBatch } from "./presentation";
import type { Arrival } from "./session";
import { decodeFrame } from "./snapshot";
import type {
  BoxState,
  BrawlerState,
  CubeSpot,
  FrameState,
  MatchState,
  NetPhase,
} from "./snapshot";

const SPECTATE_LIVE = "SPECTATING · next brawl after this one";
const SPECTATE_ENDED = "SPECTATING · next brawl starting soon";
const MARKER_COLOR = 0xff_40_30;
const SUPER_MARKER_COLOR = 0xff_c2_3a;
/** Longest a bullet moves per sub-step, as on the host, so it cannot skip through cover. */
const BULLET_STEP = 0.2;
/** Events queued beyond this play at once: the render clock has fallen too far behind. */
const MAX_EVENTS = 240;

/** A bullet flown locally: from a host spawn row, or straight from this guest's own trigger. */
interface GhostBullet {
  alive: boolean;
  attack: ProjectileAttack;
  /** The owner's colour object, shared: a shot allocates nothing. */
  color: THREE.Color;
  dx: number;
  dz: number;
  /** The host's id for it, or 0 for this guest's own predicted shot. */
  id: number;
  isSuper: boolean;
  own: boolean;
  radius: number;
  speed: number;
  trail: number;
  travel: number;
  x: number;
  z: number;
}

interface GhostBomb {
  a: LobAttack;
  color: THREE.Color;
  done: boolean;
  fuse: number;
  isSuper: boolean;
  landed: boolean;
  own: boolean;
  owner: Brawler;
  slot: BombSlot;
  sx: number;
  sy: number;
  sz: number;
  t: number;
  tx: number;
  tz: number;
}

/** A host fx batch, with the roster its owner indices refer to. */
interface FxEvent {
  kind: "fx";
  roster: readonly Brawler[];
  rows: FxRecord[];
  t: number;
}

interface LootEvent {
  boxes: BoxState[] | null;
  broken: number[] | null;
  cubes: CubeSpot[] | null;
  kind: "loot";
  t: number;
}

type TimedEvent = FxEvent | LootEvent;

const cubeKey = (x: number, z: number): string => `${x},${z}`;

/** Rows this guest presented itself when it predicted them: its own actions and its own projectiles. */
const isOwnRow = (row: FxRecord, own: number): boolean =>
  own >= 0 &&
  (row.k === "fx" || row.k === "sfx" || row.k === "shot" || row.k === "lob") &&
  row.o === own;

export class GuestView implements GhostSink {
  /** This guest's own controls, on their way to the host. */
  readonly link: IntentLink;
  /** Sequence of the last frame folded in. */
  seq = -1;
  private readonly game: Game;
  /** The host's frames' clock, shared by every remote body and the event timeline. */
  private readonly clock = new FrameClock();
  private readonly tracks = new Map<Brawler, PuppetTrack>();
  /** Bodies in the host's roster order: the order of every frame's rows. */
  private roster: Brawler[] = [];
  private rosterVersion = -1;
  private match: MatchState | null = null;
  private own: Brawler | null = null;
  private readonly boxes = new Map<number, LootBox>();
  private readonly cubes = new Map<string, Cube[]>();
  private bullets: GhostBullet[] = [];
  private bombs: GhostBomb[] = [];
  private events: TimedEvent[] = [];
  private lastFrameT = 0;
  private brokenApplied = 0;
  private gen = -1;
  private lastPhase: NetPhase | null = null;
  private lastAliveCount = -1;
  private ownAlive = true;
  private ownHp = 0;
  private ownReady = false;

  constructor(game: Game) {
    this.game = game;
    this.link = new IntentLink(() => game.session);
  }

  get prediction(): OwnPrediction {
    return this.link.prediction;
  }

  get hasWorld(): boolean {
    return this.gen >= 0;
  }

  /** How far behind server time remote bodies render: the relay's fastest trip plus the render delay. */
  get interpDelayMs(): number | null {
    const now = this.clock.synced ? (this.game.session?.serverTime() ?? null) : null;
    return now === null ? null : Math.round(now - this.clock.renderTime(performance.now()));
  }

  /** Where this guest last drew its own body — newer than any frame, for a promotion. */
  get ownPose(): OwnPose | null {
    return this.own?.alive ? { x: this.own.x, z: this.own.z } : null;
  }

  /** Fold in one message from the host. A new generation or seed rebuilds everything first. */
  ingest(arrival: Arrival): void {
    if (arrival.match) {
      this.match = arrival.match;
    }
    const { match } = this;
    let stamp = this.lastFrameT;
    const frame = arrival.frame && match ? decodeFrame(arrival.frame, match) : null;
    if (frame && match) {
      if (match.gen !== this.gen || match.seed !== this.game.world.seed) {
        this.beginGeneration(match);
      }
      if (match.rosterVersion !== this.rosterVersion) {
        this.syncRoster(match, frame);
      }
      this.applyFrame(frame, arrival);
      stamp = frame.t;
    }
    if (!this.hasWorld) {
      return;
    }
    if (arrival.match) {
      this.game.winner = arrival.match.winner;
    }
    this.enqueue(stamp, arrival);
  }

  /** Per step, before the bodies move: the local phase clock, remote poses, due events. */
  update(dt: number, now: number): void {
    this.tickPhase(dt);
    if (!this.clock.synced) {
      return;
    }
    for (const [b, track] of this.tracks) {
      track.pose(b, now, this.game.world);
    }
    this.playDue(this.clock.renderTime(now));
  }

  /** After the bodies moved: the push other bodies give ours, then the host's correction. */
  settle(dt: number): void {
    const b = this.own;
    if (!b?.alive) {
      return;
    }
    const pos = b.root.position;
    if (!b.airborne) {
      pushOwnApart(b, this.roster);
    }
    const fix = this.prediction.settle(pos.x, pos.z, dt * 1000);
    if (fix.x === 0 && fix.y === 0) {
      return;
    }
    pos.x += fix.x;
    pos.z += fix.y;
    if (!b.airborne) {
      this.game.world.resolveCircle(pos, BRAWLER_RADIUS);
      pos.y = this.game.world.heightAt(pos.x, pos.z);
    }
  }

  /** Per step: fly bullets and bombs, animate loot. */
  updateProjectiles(dt: number): void {
    this.updateBullets(dt);
    this.updateBombs(dt);
    this.game.combat.present(dt);
  }

  /**
   * The host changed: new acknowledgments, and our input must reach it at
   * once. Its frames are stamped on the same server clock as the last host's,
   * so the timeline — remote bodies, queued rows and events — runs straight
   * on; the frame clock relearns the new host's route from its first frame and
   * eases onto it.
   */
  hostChanged(): void {
    this.prediction.reset(this.own);
    this.link.resend();
  }

  /** Drop everything guest-owned (leaving, promotion, demotion, a new brawl). */
  reset(): void {
    const { game } = this;
    for (const b of this.roster) {
      game.removeBrawler(b, false);
    }
    this.roster = [];
    this.rosterVersion = -1;
    this.tracks.clear();
    this.own = null;
    for (const box of this.boxes.values()) {
      game.combat.removeBox(box);
    }
    this.boxes.clear();
    for (const list of this.cubes.values()) {
      for (const cube of list) {
        game.combat.removeCube(cube);
      }
    }
    this.cubes.clear();
    this.bullets = [];
    game.combat.bulletMesh.count = 0;
    game.combat.thornMesh.count = 0;
    this.bombs = [];
    this.hideBombSlots();
    this.events = [];
    this.brokenApplied = 0;
    this.gen = -1;
    this.lastPhase = null;
    this.lastAliveCount = -1;
    this.prediction.reset(null);
    setSpectateCopy(null);
  }

  // ── GhostSink: this guest's own projectiles, from its predicted body ──

  readonly bullet = (
    owner: Brawler,
    x: number,
    z: number,
    dx: number,
    dz: number,
    attack: ProjectileAttack,
    isSuper: boolean,
    speed: number,
  ): void => {
    this.addBullet(owner, { dx, dz, x, z }, attack, isSuper, speed, 0);
  };

  readonly bomb = (
    owner: Brawler,
    sx: number,
    sy: number,
    sz: number,
    tx: number,
    tz: number,
    attack: LobAttack,
    isSuper: boolean,
  ): void => {
    this.addBomb(owner, attack, isSuper, true, [sx, sy, sz, tx, tz]);
  };

  // ── frames ──

  private beginGeneration(match: MatchState): void {
    const { game } = this;
    this.reset();
    if (game.world.seed !== match.seed) {
      game.rebuildWorld(match.seed);
    }
    game.clearEntities();
    game.world.broken = [];
    game.hud.hideResult();
    game.pendingResult = null;
    game.spectate = null;
    game.generation = match.gen;
    game.shakeAmp = 0;
    game.lastCount = 4;
    this.gen = match.gen;
    this.ownAlive = true;
    game.world.aoDirty = true;
    game.world.aoTimer = 0;
  }

  /** Bring the bodies in line with a new roster; a body that stays keeps its history. */
  private syncRoster(match: MatchState, frame: FrameState): void {
    const { game } = this;
    const mine = game.session?.playerId ?? null;
    const byId = new Map(this.roster.map((b) => [b.netId, b]));
    const next: Brawler[] = [];
    for (const [i, identity] of match.roster.entries()) {
      const state = frame.brawlers[i];
      if (!state) {
        continue;
      }
      let b = byId.get(identity.id);
      byId.delete(identity.id);
      if (!b) {
        const own = identity.owner !== null && identity.owner === mine;
        b = spawnFromNet(game, identity, state, own ? "predict" : "puppet", own);
        game.addBrawler(b, false);
        if (own) {
          this.adoptOwn(b, state);
        } else {
          this.tracks.set(b, new PuppetTrack(this.clock));
        }
      }
      next.push(b);
    }
    for (const b of byId.values()) {
      game.removeBrawler(b, false);
      this.tracks.delete(b);
      if (b === this.own) {
        this.own = null;
      }
    }
    this.roster = next;
    this.rosterVersion = match.rosterVersion;
    this.syncSpectateCopy();
  }

  private adoptOwn(b: Brawler, n: BrawlerState): void {
    this.own = b;
    this.game.adoptLocalSeat(b);
    this.ownHp = n.hp;
    this.ownAlive = n.alive;
    this.ownReady = n.charge >= 1;
    this.prediction.reset(b);
    // The host learns this body's input — and starts acknowledging it — straight away.
    this.link.resend();
  }

  private applyFrame(frame: FrameState, { host, receivedAt }: Arrival): void {
    this.seq = frame.seq;
    if (this.game.session) {
      this.game.session.seq = frame.seq;
    }
    this.lastFrameT = frame.t;
    this.clock.arrived(frame.t, receivedAt, host);
    this.syncPhase(frame);
    for (const [i, state] of frame.brawlers.entries()) {
      const b = this.roster[i];
      if (b && b === this.own) {
        this.applyOwn(b, state);
      } else if (b) {
        this.tracks.get(b)?.receive(frame.t, state, receivedAt);
      }
    }
    this.syncAliveCount(frame);
  }

  /** The host's row for our own body: authority over vitals, a correction signal for the pose. */
  private applyOwn(b: Brawler, n: BrawlerState): void {
    const verdict = this.prediction.receive(b, n);
    const lead = verdict.at === null ? 0 : (this.prediction.clock - verdict.at) / 1000;
    if (n.hp < b.hp) {
      b.flash = 1;
      b.squash = 1;
    }
    b.hp = n.hp;
    b.maxHp = maxHpFor(b.def, n.cubes);
    b.cubes = n.cubes;
    b.kills = n.kills;
    b.rank = n.rank;
    // Shots and supers still on their way are already spent locally; adopt the host's count once it has them.
    if (verdict.ammoSettled) {
      b.ammo = n.ammo;
      b.reloadT = n.reload;
      b.catchUpReload(lead);
    }
    if (verdict.chargeSettled) {
      b.superCharge = n.charge;
    }
    if (verdict.leapCancelled) {
      b.cancelLeap();
    }
    this.followHostLeap(b, n, lead);
    if (b.alive && !n.alive) {
      b.alive = false;
      b.hp = 0;
      b.deadT = 0;
      b.burst = null;
      b.swing = null;
      b.meleeCue = null;
      b.rangedCue = null;
      b.evasion = null;
      b.evadePending = false;
      b.leap = null;
      b.netLeap = null;
      b.netAir = false;
    }
    this.syncOwn(b, n);
  }

  /** A leap this guest did not start (a host forced it): the host flies the body until it lands. */
  private followHostLeap(b: Brawler, n: BrawlerState, lead: number): void {
    const flight = leapFlight(b.def);
    const leap = b.leap === null && n.alive ? n.leap : null;
    if (leap && leap.t + lead < flight) {
      b.netAir = true;
      b.netLeap = { ...leap };
      const pos = b.root.position;
      leapPoint(leap, flight, this.game.world.heightAt, pos);
      pos.x = n.x;
      pos.z = n.z;
      return;
    }
    if (b.netAir) {
      // Down again: as far as prediction is concerned, a teleport.
      b.netAir = false;
      b.netLeap = null;
      b.root.position.set(n.x, this.game.world.heightAt(n.x, n.z), n.z);
      this.prediction.forgetHistory();
    }
  }

  private syncOwn(b: Brawler, n: BrawlerState): void {
    const { game } = this;
    if (n.hp < this.ownHp && n.alive) {
      game.onPlayerHurt(this.ownHp - n.hp);
      if (game.gas.active && game.gas.depthAt(b.x, b.z) > 0.35) {
        game.audio.play("gas");
      }
    }
    this.ownHp = n.hp;
    const ready = n.charge >= 1;
    if (ready && !this.ownReady) {
      game.audio.play("ready");
    }
    this.ownReady = ready;
    if (this.ownAlive && !n.alive) {
      game.localDown(n.rank, null);
    }
    this.ownAlive = n.alive;
  }

  // ── phase ──

  private syncPhase(frame: FrameState): void {
    const { game } = this;
    const first = this.lastPhase === null;
    let { phase } = frame;
    if (phase === "countdown") {
      // Our own body runs about a round trip ahead of the host's copy of it:
      // let it go when that copy will, not a round trip later.
      game.countdownT = frame.clock - (this.prediction.lagMs ?? 0) / 1000;
      game.matchTime = 0;
      if (this.lastPhase === "playing" || game.countdownLeft <= 0) {
        phase = "playing";
      }
    } else {
      game.matchTime = frame.clock;
    }
    if (first) {
      // Joining a brawl already under way: its gas is not news.
      game.gas.update(0, game.matchTime, false);
    }
    this.enterPhase(phase);
  }

  private enterPhase(phase: NetPhase): void {
    const { game } = this;
    const previous = this.lastPhase;
    this.lastPhase = phase;
    game.state = phase;
    if (phase === "countdown") {
      game.announceCount();
    } else if (previous === "countdown") {
      game.announceGo();
    }
    const decided = phase === "ended" && previous !== null && previous !== "ended";
    if (decided && this.ownAlive && game.player?.alive) {
      game.localWin();
    }
    if (phase === "ended" || previous === "ended") {
      this.syncSpectateCopy();
    }
  }

  /** Between frames the phase clocks run on locally. */
  private tickPhase(dt: number): void {
    const { game } = this;
    if (game.state !== "countdown") {
      game.matchTime += dt;
      return;
    }
    game.countdownT -= dt;
    if (game.countdownLeft <= 0) {
      this.enterPhase("playing");
    } else {
      game.announceCount();
    }
  }

  private syncSpectateCopy(): void {
    if (this.own) {
      setSpectateCopy(null);
      return;
    }
    setSpectateCopy(this.lastPhase === "ended" ? SPECTATE_ENDED : SPECTATE_LIVE);
  }

  private syncAliveCount(frame: FrameState): void {
    const { game } = this;
    const alive = frame.brawlers.filter((n) => n.alive).length;
    const previous = this.lastAliveCount;
    this.lastAliveCount = alive;
    if (previous > 2 && alive === 2 && game.player?.alive && game.state === "playing") {
      game.hud.banner("SHOWDOWN!", 1.5, true);
    }
  }

  // ── the render-time timeline ──

  private enqueue(t: number, arrival: Arrival): void {
    const own = this.own ? this.roster.indexOf(this.own) : -1;
    const rows = arrival.fx.filter((row) => !isOwnRow(row, own));
    if (rows.length > 0) {
      this.events.push({ kind: "fx", roster: this.roster, rows, t });
    }
    const { boxes, broken, cubes } = arrival;
    if (boxes || broken || cubes) {
      this.events.push({ boxes, broken, cubes, kind: "loot", t });
    }
    if (this.events.length > MAX_EVENTS) {
      this.playDue(Number.POSITIVE_INFINITY);
    }
  }

  private playDue(renderAt: number): void {
    let played = 0;
    for (const event of this.events) {
      if (event.t > renderAt) {
        break;
      }
      this.play(event, renderAt);
      played += 1;
    }
    if (played > 0) {
      this.events.splice(0, played);
    }
  }

  private play(event: TimedEvent, renderAt: number): void {
    if (event.kind === "loot") {
      this.applyLoot(event);
      return;
    }
    const late = Number.isFinite(renderAt) ? Math.max(0, renderAt - event.t) / 1000 : 0;
    const replay: FxRecord[] = [];
    for (const row of event.rows) {
      if (row.k === "shot") {
        this.spawnShot(row, event.roster, late);
      } else if (row.k === "lob") {
        this.spawnLob(row, event.roster, late);
      } else if (row.k === "gone") {
        this.dropBullet(row.i);
      } else {
        replay.push(row);
      }
    }
    replayBatch(this.game.effects, this.game.hud, replay, this.game.localSeatId);
  }

  private applyLoot(event: LootEvent): void {
    if (event.broken) {
      this.syncBroken(event.broken);
    }
    if (event.boxes) {
      this.syncBoxes(event.boxes);
    }
    if (event.cubes) {
      this.syncCubes(event.cubes);
    }
  }

  private syncBroken(broken: readonly number[]): void {
    const { world } = this.game;
    if (broken.length < this.brokenApplied) {
      this.brokenApplied = 0;
    }
    for (let k = this.brokenApplied; k < broken.length; k += 1) {
      const i = broken[k];
      if (i !== undefined) {
        world.destroyTile(i % GRID, Math.floor(i / GRID));
      }
    }
    this.brokenApplied = broken.length;
  }

  private syncBoxes(rows: readonly BoxState[]): void {
    const { combat, world } = this.game;
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.i);
      let box = this.boxes.get(row.i);
      if (!box) {
        const spot = world.boxSpots[row.i];
        if (!spot) {
          continue;
        }
        box = combat.addBox(spot[0], spot[1]);
        this.boxes.set(row.i, box);
      }
      if (row.hp < box.hp) {
        box.shake = 1;
      }
      box.hp = row.hp;
    }
    for (const [i, box] of this.boxes) {
      if (!seen.has(i)) {
        combat.removeBox(box);
        this.boxes.delete(i);
      }
    }
  }

  private syncCubes(spots: readonly CubeSpot[]): void {
    const { combat } = this.game;
    const wanted = new Map<string, number>();
    for (const cube of spots) {
      const key = cubeKey(cube.x, cube.z);
      wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
    for (const [key, list] of this.cubes) {
      const keep = wanted.get(key) ?? 0;
      while (list.length > keep) {
        const cube = list.pop();
        if (cube) {
          combat.removeCube(cube);
        }
      }
      if (list.length === 0) {
        this.cubes.delete(key);
      }
    }
    for (const cube of spots) {
      const key = cubeKey(cube.x, cube.z);
      const list = this.cubes.get(key) ?? [];
      if (list.length < (wanted.get(key) ?? 0)) {
        combat.spawnCube(cube.x, cube.z, cube.x, cube.z);
        const spawned = combat.cubes.at(-1);
        if (spawned) {
          list.push(spawned);
        }
      }
      this.cubes.set(key, list);
    }
  }

  // ── projectiles ──

  private spawnShot(row: ShotRow, roster: readonly Brawler[], late: number): void {
    const owner = roster[row.o];
    const isSuper = row.s === 1;
    const attack = isSuper ? owner?.def.super : owner?.def.attack;
    if (!owner || (attack?.kind !== "burst" && attack?.kind !== "spread")) {
      return;
    }
    const angle = row.d / 1000;
    const at = { dx: Math.sin(angle), dz: Math.cos(angle), x: row.x / 100, z: row.z / 100 };
    const bullet = this.addBullet(owner, at, attack, isSuper, row.v / 100, row.i);
    // The render clock may already be past the spawn: start the bullet where it has got to.
    this.flyBullet(bullet, late);
  }

  private spawnLob(row: LobRow, roster: readonly Brawler[], late: number): void {
    const owner = roster[row.o];
    const isSuper = row.s === 1;
    const attack = isSuper ? owner?.def.super : owner?.def.attack;
    if (!owner || attack?.kind !== "lob") {
      return;
    }
    const path = [row.x, row.y, row.z, row.tx, row.tz].map((n) => n / 100);
    const bomb = this.addBomb(owner, attack, isSuper, false, path);
    if (bomb) {
      this.stepBomb(bomb, late);
    }
  }

  private addBullet(
    owner: Brawler,
    at: { dx: number; dz: number; x: number; z: number },
    attack: ProjectileAttack,
    isSuper: boolean,
    speed: number,
    id: number,
  ): GhostBullet {
    const bullet: GhostBullet = {
      alive: true,
      attack,
      color: owner.bulletColor(isSuper),
      dx: at.dx,
      dz: at.dz,
      id,
      isSuper,
      own: id === 0,
      radius: attack.radius,
      speed,
      trail: 0,
      travel: 0,
      x: at.x,
      z: at.z,
    };
    this.bullets.push(bullet);
    return bullet;
  }

  private dropBullet(id: number): void {
    for (const bullet of this.bullets) {
      if (bullet.id === id) {
        bullet.alive = false;
      }
    }
  }

  /** Fly a bullet in short steps. Cover and range stop every bullet; our own also stop on a body. */
  private flyBullet(g: GhostBullet, dt: number): void {
    const { world } = this.game;
    let remaining = g.speed * dt;
    while (remaining > 0 && g.alive) {
      const step = Math.min(remaining, BULLET_STEP);
      remaining -= step;
      g.x += g.dx * step;
      g.z += g.dz * step;
      g.travel += step;
      if (world.blocksShots(world.toTile(g.x), world.toTile(g.z))) {
        this.endBullet(g, g.x - g.dx * 0.12, g.z - g.dz * 0.12, WALL_IMPACT);
      } else if (g.own && !g.attack.pierce && this.strikesBody(g)) {
        // Whether it hurt is the host's call; its impact arrives with the verdict.
        g.alive = false;
      } else if (g.travel >= g.attack.range) {
        this.endBullet(g, g.x, g.z, SPENT_IMPACT);
      }
    }
  }

  /** The puff where a bullet stops: ours locally, a remote one's comes from the host. */
  private endBullet(g: GhostBullet, x: number, z: number, size: number): void {
    g.alive = false;
    if (g.own) {
      const y = BULLET_Y + this.game.world.heightAt(x, z);
      this.game.effects.impact(x, y, z, g.color, size);
    }
  }

  private strikesBody(g: GhostBullet): boolean {
    const reach = BRAWLER_RADIUS + 0.06 + g.radius;
    for (const b of this.roster) {
      if (b === this.own || !b.alive || b.airborne || b.evadingInvulnerable) {
        continue;
      }
      const ox = b.x - g.x;
      const oz = b.z - g.z;
      if (ox * ox + oz * oz <= reach * reach) {
        return true;
      }
    }
    return false;
  }

  private updateBullets(dt: number): void {
    const { combat, effects, lighting, world } = this.game;
    let arrows = 0;
    let thorns = 0;
    for (const b of this.bullets) {
      this.flyBullet(b, dt);
      const thorn = b.attack.style === "thorn";
      const mesh = thorn ? combat.thornMesh : combat.bulletMesh;
      const count = thorn ? thorns : arrows;
      if (!b.alive || count >= mesh.instanceMatrix.count) {
        continue;
      }
      const ground = world.heightAt(b.x, b.z);
      drawProjectile(mesh, count, b, b.attack.style, b.attack.range - b.travel, ground);
      if (thorn) {
        thorns += 1;
      } else {
        arrows += 1;
      }
      const y = BULLET_Y + ground;
      if (b.isSuper) {
        lighting.addLight(b.x, y, b.z, b.color, 0.25, 2.5);
      }
      b.trail -= dt;
      if (b.trail <= 0) {
        b.trail = 0.045;
        effects.trail(b.x, y, b.z, b.color, b.isSuper ? 0.15 : 0.065);
      }
    }
    this.bullets = this.bullets.filter((b) => b.alive);
    finishProjectileMesh(combat.bulletMesh, arrows);
    finishProjectileMesh(combat.thornMesh, thorns);
  }

  private addBomb(
    owner: Brawler,
    a: LobAttack,
    isSuper: boolean,
    own: boolean,
    path: readonly number[],
  ): GhostBomb | null {
    const { combat, world } = this.game;
    const slot = combat.bombPool.find((candidate) => !candidate.busy);
    const [sx = 0, sy = 0, sz = 0, tx = 0, tz = 0] = path;
    if (!slot) {
      return null;
    }
    const color = owner.bulletColor(isSuper);
    setBombAppearance(slot, a.style, color);
    slot.busy = true;
    slot.group.visible = true;
    slot.group.scale.setScalar(a.big ? 1.75 : 1);
    slot.ring.visible = true;
    slot.ring.position.set(tx, world.heightAt(tx, tz) + 0.05, tz);
    slot.ring.scale.set(a.blast, 1, a.blast);
    conformGroundGeometry(slot.ring.geometry, tx, tz, a.blast);
    conformGroundGeometry(slot.fillDisc.geometry, tx, tz, a.blast);
    const markerColor = isSuper ? SUPER_MARKER_COLOR : MARKER_COLOR;
    slot.ring.material.color.set(markerColor);
    slot.fillDisc.material.color.set(markerColor);
    const bomb: GhostBomb = {
      a,
      color,
      done: false,
      fuse: a.fuse,
      isSuper,
      landed: false,
      own,
      owner,
      slot,
      sx,
      sy,
      sz,
      t: 0,
      tx,
      tz,
    };
    placeLob(bomb, world.heightAt, slot.group.position);
    this.bombs.push(bomb);
    return bomb;
  }

  /** The host's flight and fuse, drawn locally. Our own bomb also shows its landing and blast. */
  private stepBomb(bomb: GhostBomb, dt: number): void {
    const { combat, effects, world } = this.game;
    const { a, slot } = bomb;
    if (bomb.landed) {
      bomb.fuse -= dt;
      slot.group.position.y = world.heightAt(bomb.tx, bomb.tz) + 0.2 * slot.group.scale.x;
    } else {
      bomb.t += dt;
      slot.group.rotation.x += dt * 9;
      slot.group.rotation.z += dt * 5;
      if (placeLob(bomb, world.heightAt, slot.group.position) >= 1) {
        bomb.landed = true;
        if (bomb.own) {
          effects.dust(bomb.tx, bomb.tz, 4, 1.4);
        }
      }
    }
    if (bomb.landed && bomb.fuse <= 0) {
      bomb.done = true;
      slot.busy = false;
      slot.group.visible = false;
      slot.ring.visible = false;
      if (bomb.own) {
        combat.showBlast(bomb.tx, bomb.tz, a, bomb.owner, bomb.isSuper);
      }
    }
  }

  private updateBombs(dt: number): void {
    const { effects, elapsed, lighting } = this.game;
    for (const bomb of this.bombs) {
      this.stepBomb(bomb, dt);
      if (bomb.done) {
        continue;
      }
      const { a, slot } = bomb;
      // The marker fills and the spark flickers faster as the fuse runs down.
      const urgency = bomb.landed ? 1 - clamp(bomb.fuse / a.fuse, 0, 1) : 0;
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * (14 + urgency * 30));
      slot.spark.scale.setScalar(0.8 + pulse * 0.9);
      slot.ring.material.opacity = 0.55 + pulse * 0.35;
      slot.fillDisc.material.opacity = 0.1 + urgency * 0.22;
      const p = slot.group.position;
      effects.trail(p.x, p.y, p.z, bomb.color, a.big ? 0.46 : 0.26);
      lighting.addLight(p.x, p.y + 0.3, p.z, bomb.color, 2.2 + pulse * 2.5, 4);
      if (Math.random() < dt * 40) {
        effects.spark(p.x, p.y + 0.25 * slot.group.scale.x, p.z, bomb.color);
      }
    }
    this.bombs = this.bombs.filter((bomb) => !bomb.done);
  }

  private hideBombSlots(): void {
    for (const slot of this.game.combat.bombPool) {
      slot.busy = false;
      slot.group.visible = false;
      slot.ring.visible = false;
    }
  }
}
