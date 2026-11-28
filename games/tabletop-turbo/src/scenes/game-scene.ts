import { notifyGameStarted } from "@repo/embed";
import { FixedRate, RemoteClock } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import * as THREE from "three";

import { driveAudio, idleAudio, setWorldLevel, sfx } from "../audio/sfx";
import type { Input } from "../input/input";
import { encodeHit, readHit } from "../net/blow";
import {
  RemoteTrack,
  adoptCar,
  drawnOf,
  encodeCar,
  ghostOf,
  readPose,
  shotOf,
  viewOf,
} from "../net/pose";
import type { CarView, PoseReport } from "../net/pose";
import { isJsonNumber, isJsonObject, isJsonString, numberOr } from "../net/wire";
import { BASE, CAR_RAMPS, RAMP, rampCss, tone } from "../pixel/palette";
import { PX_PER_UNIT, PixelStage } from "../pixel/stage";
import type { StageView } from "../pixel/stage";
import { Board, TABLE_Y } from "../render/board";
import { CarMesh } from "../render/car-mesh";
import { GlowGrid, SKID_SLOT } from "../render/glow-grid";
import { specialName } from "../render/hud";
import type { Hud, HudRow, HudTag } from "../render/hud";
import { LightMap } from "../render/light-map";
import {
  ARROW,
  BEAM,
  OIL_SLOT,
  PODIUM,
  Props,
  SPECIAL_RAMP,
  drawCube,
  drawShot,
} from "../render/props";
import type { Blip } from "../render/radar";
import {
  BOOST_MIN,
  BOTS,
  BOT_SEND_HZ,
  BUMPER_THROW,
  COUNTDOWN_MS,
  DAMAGE_GAIN,
  GRID_SIZE,
  MAX_SPEED,
  MAX_STEPS,
  PISTON_THROW,
  RAM_THROW,
  RESPAWN_SECONDS,
  RESULTS_MS,
  ROUND_MS,
  SEND_HZ,
  SHRINK_MS,
  SQUEEZE_POINTS,
  STEP,
  SWEEPER_THROW,
} from "../shared/constants";
import { arenaFor, edgeDistance } from "../sim/arena";
import type { Arena } from "../sim/arena";
import { botInput, makeBrain, makeDirector, releaseBot } from "../sim/bot";
import type { BotBrain, BotView } from "../sim/bot";
import {
  attackReady,
  clash,
  flightOf,
  gridCar,
  launchOf,
  makeCar,
  stickInput,
  swingAt,
  wrapAngle,
} from "../sim/car";
import type { Car, CarInput, CarMode, Hit, HitHow } from "../sim/car";
import { cubesAt } from "../sim/cubes";
import { deliver, makeField } from "../sim/field";
import type { Field, FieldEvent } from "../sim/field";
import { hazardGone, hazardThreat, pistonAt, shrinkAt } from "../sim/hazards";
import { CAR_KINDS, KINDS } from "../sim/kinds";
import type { CarKind } from "../sim/kinds";
import { shotLife } from "../sim/shots";
import type { Shot } from "../sim/shots";
import {
  GIANT_SCALE,
  GIANT_WEIGHT,
  MINE_THROW,
  ROCKET_THROW,
  SEEKER_SPEED,
  SEEKER_THROW,
  SHOCK_THROW,
  STOMP_THROW,
  ZAP_RADIUS,
  specialFor,
} from "../sim/specials";
import type { ModKind, SpecialKind } from "../sim/specials";
import { grant, reward, stepField } from "../sim/step";
import { Effects } from "./effects";

type Who = "me" | "bot" | "human";

interface Predicted {
  id: string;
  dx: number;
  dz: number;
  reach: number;
  tau: number;
  t0: number;
  t1: number;
}

interface Racer {
  key: string;
  who: Who;
  name: string;
  css: string;
  rgb: number;
  ramp: number;
  colour: number;
  slot: number;
  mesh: CarMesh;
  track: RemoteTrack | null;
  view: CarView;
  seen: boolean;
  fresh: boolean;
  launches: number;
  attacks: number;
  uses: number;
  mode: CarMode;
  mod: ModKind;
  special: SpecialKind | "";
  slipping: boolean;
  air: boolean;
  attackT: number;
  flash: number;
  tumble: number;
  smokeT: number;
  swing: number;
  steer: number;
  x: number;
  z: number;
  predicted: Predicted | null;
}

interface RoundState {
  round: number;
  startAt: number;
  phase: "play" | "results";
  nextAt: number;
}

export interface GameDiagnostics {
  phase: "title" | "countdown" | "play" | "out" | "results";
  frame: number;
  entities: number;
  score: number;
  place: number;
  complete: boolean;
  player: { x: number; y: number };
  /** Seconds left in the round. */
  timeLeft: number;
  /** Distance to the nearest edge or hole, world units: under 2 is close. */
  edge: number;
  /** 0–1: something on the board is about to hit where the car stands. */
  threat: number;
  attackReady: boolean;
  /** How far the car's own attack reaches. */
  range: number;
  boost: number;
  /** The special in hand, or "". */
  special: string;
  /** Damage on the car: the more, the further a blow throws it. */
  damage: number;
  /**
   * The nearest rival that can be hit, as the driver sees it: `ahead` of the
   * nose (negative: behind), `side` to the right (negative: left).
   */
  rival: { ahead: number; side: number; distance: number; edge: number; damage: number };
  /** The way to the middle of the board, the same way. */
  centre: { ahead: number; side: number };
  /** The nearest power cube on its pad, the same way: distance 99 if there is none. */
  cube: { ahead: number; side: number; distance: number };
  falls: number;
  knockOffs: number;
  car: string;
}

const FRESH_START = "fresh-start";
const HIT_EVENT = "hit";
const CLASH_EVENT = "clash";
const KO_EVENT = "ko";
const PARTY = [RAMP.yellow, RAMP.pink, RAMP.cyan, RAMP.lime, RAMP.white] as const;
const MIN_ZOOM = 9;
const PITCH = (50 * Math.PI) / 180;
const EYE_DISTANCE = 200;
const NORTH = -Math.PI / 2;
const CAM_TURN = 4.2;
const CAM_LEAD = 5;
const SHOW_SCALE = 1.7;
const AWAY_MS = 2500;
const LATE_FALL_MS = 1200;

const REACH_GUESS = {
  bumper: BUMPER_THROW,
  dash: KINDS.dart.throw,
  land: 2.6,
  magnet: 5,
  mine: MINE_THROW,
  piston: PISTON_THROW,
  punch: KINDS.bumper.throw,
  ram: RAM_THROW,
  rocket: ROCKET_THROW,
  scoop: KINDS.scoop.throw,
  seeker: SEEKER_THROW,
  shock: SHOCK_THROW,
  shot: KINDS.popper.throw,
  slam: KINDS.brick.throw,
  spin: KINDS.twister.throw,
  stomp: STOMP_THROW,
  sweeper: SWEEPER_THROW,
  zap: 0.5,
} as const satisfies Record<HitHow, number>;

const FIXED = new Set<HitHow>(["land", "magnet", "zap"]);

const TEST_SKIPS = new Map([
  ["active-play", 0],
  ["cubes", 9500],
  ["finale", ROUND_MS - 6000],
  ["shrink", ROUND_MS - SHRINK_MS - 1500],
]);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isBotKey = (key: string) => /^b\d$/u.test(key);
const botKey = (index: number) => `b${index}`;
const cubeKey = (round: number, id: number) => `cube:${round}:${id}`;
const rampOf = (colour: number) => CAR_RAMPS[colour % CAR_RAMPS.length] ?? CAR_RAMPS[0];
const round1 = (v: number) => Math.round(v * 10) / 10;

const botKind = (index: number, round: number) =>
  CAR_KINDS[(index + Math.max(0, round)) % CAR_KINDS.length] ?? "bumper";

const reachOf = (kind: CarKind) => {
  const { attack } = KINDS[kind];

  if (attack === "shot") {
    return 16;
  }

  if (attack === "dash") {
    return 7;
  }

  return attack === "punch" ? 4.6 : 3.4;
};

const phaseOf = (playing: boolean, ms: number, mode: CarMode) => {
  if (!playing) {
    return "results";
  }

  if (ms < 0) {
    return "countdown";
  }

  return mode === "drive" ? "play" : "out";
};

const netText = (status: string, humans: number) => {
  if (status === "offline") {
    return "SOLO";
  }

  return status === "connected" ? `ONLINE ${humans}` : "...";
};

const countText = (seconds: number, left: number) => {
  if (seconds < 0) {
    return String(Math.min(3, Math.ceil(-seconds)));
  }

  if (seconds < 0.8) {
    return "GO";
  }

  return left > 0 && left <= 5000 ? String(Math.ceil(left / 1000)) : "";
};

const throwOf = (view: CarView, hit: Hit) => {
  if (FIXED.has(hit.how)) {
    return hit.reach;
  }

  const weight = KINDS[view.kind].weight * (view.mod === "giant" ? GIANT_WEIGHT : 1);

  return launchOf(hit.reach, view.damage, weight);
};

/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- FNV-1a is defined over
   UTF-16 code units and 32-bit wraparound; every peer must derive the same tag. */
const tagFor = (id: string) => {
  let h = 2_166_136_261;

  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }

  return ((h >>> 0) % 1296).toString(36).toUpperCase().padStart(2, "0");
};
/* oxlint-enable no-bitwise, unicorn/prefer-code-point */

const readRound: (shared: JsonRecord) => RoundState | null = (shared) => {
  const { nextAt, phase, round, startAt } = shared;

  if (!isJsonNumber(round) || !isJsonNumber(startAt)) {
    return null;
  }

  return {
    nextAt: isJsonNumber(nextAt) ? nextAt : 0,
    phase: phase === "results" ? "results" : "play",
    round,
    startAt,
  };
};

export class GameScene {
  private readonly client: MultiplayerClient;
  private readonly input: Input;
  private readonly hud: Hud;
  private readonly stage: PixelStage;
  private readonly lights = new LightMap();
  private readonly glow = new GlowGrid();
  private readonly arena: Arena = arenaFor(0);
  private readonly board: Board;
  private readonly props: Props;
  private readonly fx: Effects;
  private readonly field: Field;
  private readonly brains = new Map<string, BotBrain>();
  private director = makeDirector();
  private readonly racers = new Map<string, Racer>();
  private readonly slots = new Map<string, number>();
  private readonly botClock = new RemoteClock();
  private readonly sendClock = new FixedRate(SEND_HZ);
  private readonly botSend = new FixedRate(BOT_SEND_HZ);
  private readonly inputs = new Map<string, CarInput>();
  private readonly pending = new Map<number, { key: string; at: number }>();
  private readonly foretold = new Set<string>();
  private readonly heard = new Map<string, PoseReport>();
  private readonly steered = new Map<string, number>();
  private readonly landed = new Set<number>();
  private readonly shown = new Map<number, { x: number; z: number }>();
  private readonly botColours: number[] = [];
  private readonly tags: HudTag[] = [];
  private readonly blips: Blip[] = [];
  private readonly showcars = new Map<CarKind, CarMesh>();
  private readonly aim = new THREE.Vector3();
  private readonly view: StageView = {
    eye: new THREE.Vector3(),
    target: new THREE.Vector3(0, 0, 1),
    zoom: PX_PER_UNIT,
  };

  private state: RoundState = { nextAt: 0, phase: "play", round: 0, startAt: 0 };
  private me: Car | null = null;
  private kind: CarKind = "bumper";
  private colour = 0;
  private started = false;
  private firstRound = 0;
  private paused = false;
  private pausedAt = 0;
  private lastNow = 0;
  private clock = 0;
  private frame = 0;
  private acc = 0;
  private yaw = NORTH;
  private attackQueued = false;
  private specialQueued = false;
  private wasHost = false;
  private lastHostId: string | null = null;
  private lastStatus = "";
  private lastCount = "";
  private warned = false;
  private dropped = false;
  private wasReady = true;
  private wasBoosting = false;
  private resultsShown = false;
  private knockOffs = 0;
  private myPlace = 1;

  constructor(
    client: MultiplayerClient,
    input: Input,
    hud: Hud,
    renderer: THREE.WebGLRenderer,
    shadows: number,
  ) {
    this.client = client;
    this.input = input;
    this.hud = hud;
    this.stage = new PixelStage(renderer, shadows, this.lights.bytes);
    this.board = new Board(this.arena);
    this.props = new Props(this.arena);
    this.fx = new Effects(this.stage, hud, this.lights, this.props);
    this.field = makeField(this.arena);
    this.stage.setWorld(this.board.solids);
    this.stage.setBoard(this.board.map);
    this.stage.setSlotRamp(OIL_SLOT, RAMP.purple);
  }

  /** Whether the player is off the title and on the board. */
  get playing() {
    return this.started;
  }

  resize(width: number, height: number) {
    this.stage.resize(width, height);
  }

  render() {
    this.stage.render(this.view);
    this.tagCars();
  }

  /** The car the player will drive, and which of the car colours it wears. */
  setLoadout(kind: CarKind, colour: number) {
    this.kind = kind;
    this.colour = ((colour % CAR_RAMPS.length) + CAR_RAMPS.length) % CAR_RAMPS.length;
    this.input.setTint(rampCss(rampOf(this.colour), BASE + 1));
  }

  /** Off the title and onto the board. */
  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.firstRound = this.state.round;
    this.hud.showTitle(false);
    this.hud.showHud(true);
    this.input.setTouchVisible(true);
    setWorldLevel(1);
    notifyGameStarted();
    const car = makeCar(this.myKey(), false, this.kind);
    car.modeT = RESPAWN_SECONDS;
    this.me = car;
    this.field.cars.set(car.key, car);
    this.yaw = NORTH;
    this.client.sendToHost(FRESH_START, null);
  }

  /** Back to the title to pick another car. The room plays on without this one. */
  leave() {
    const { me } = this;

    if (!this.started || !me) {
      return;
    }

    this.started = false;
    this.me = null;
    this.field.cars.delete(me.key);
    this.racers.delete(me.key);
    this.client.updateMyState({ t: 0 });
    this.resultsShown = false;
    this.hud.showResults(false);
    this.hud.showHud(false);
    this.hud.showTitle(true);
    this.hud.setTags([]);
    this.input.setTouchVisible(false);
    this.input.clear();
    setWorldLevel(0.25);
    idleAudio();
  }

  /** Room events. The host's own intents loop back here too. */
  onRoomEvent(event: string, payload: JsonValue, from: string) {
    if (event === HIT_EVENT) {
      this.onHit(payload, from);
    } else if (event === CLASH_EVENT) {
      this.onClash(payload);
    } else if (event === KO_EVENT) {
      this.onKo(payload);
    } else if (event === FRESH_START && this.client.isHost) {
      const asker = from === this.client.playerId ? this.myKey() : from;

      const others = [...this.racers.values()].some(
        (racer) => racer.who !== "bot" && racer.key !== asker,
      );

      if (!others) {
        this.newRound(this.state.round + 1);
      }
    }
  }

  /** Offline a pause freezes the round; online the room runs on and the car sits still. */
  setPaused(paused: boolean) {
    if (paused === this.paused) {
      return;
    }

    this.paused = paused;
    const solo = this.client.connectionStatus === "offline";

    if (paused) {
      this.pausedAt = this.client.serverNow();
      this.input.clear();
      this.attackQueued = false;
      this.specialQueued = false;
      idleAudio();
    } else if (solo) {
      const held = this.client.serverNow() - this.pausedAt;
      this.client.updateSharedState({
        nextAt: this.state.nextAt > 0 ? this.state.nextAt + held : 0,
        startAt: this.state.startAt + held,
      });
    }
  }

  /** Playtest hook: a new round, now. */
  restart() {
    if (this.client.isHost) {
      this.newRound(this.state.round + 1);
    }
  }

  /** Playtest hook: jump to a named moment of a round, or hand the car a special. */
  setTestState(name: string) {
    if (name === "title") {
      return !this.started;
    }

    if (name === "sun" || name === "sun-off") {
      this.stage.setSun(name === "sun");

      return true;
    }

    const special = name.startsWith("special-") ? name.slice(8) : "";

    if (special in SPECIAL_RAMP && this.me) {
      Object.assign(this.me, { special });

      return true;
    }

    const skip = TEST_SKIPS.get(name) ?? null;

    if (skip === null && name !== "results") {
      return false;
    }

    this.start();

    if (this.client.isHost) {
      const now = this.client.serverNow();
      this.client.updateSharedState({
        startAt: Math.round(now - (skip ?? ROUND_MS - 100)),
      });
    }

    return true;
  }

  update(dt: number) {
    const solo = this.client.connectionStatus === "offline";

    if (this.paused && solo) {
      return;
    }

    this.clock += dt;
    this.frame += 1;
    this.input.update();
    this.hud.tick();

    if (!this.started) {
      const pick = this.input.pick();
      this.hud.nudgePick(pick.across, pick.down);

      if (this.input.anyStart()) {
        this.start();
      }
    }

    const now = this.client.serverNow();
    this.rekey();
    this.wake(now);
    this.syncRoom(now);
    const known = this.state.round > 0;
    const seconds = known ? (now - this.state.startAt) / 1000 : -COUNTDOWN_MS / 1000;
    this.gather(dt, now);

    if (this.hosting()) {
      this.staffBots(seconds, now);
    }

    if (known) {
      this.simulate(dt, seconds);
    }

    this.settleClaims(seconds);
    this.publish(dt, now);

    if (this.hosting()) {
      this.hostTick(now);
    }

    this.present(dt, seconds);
    this.updateHud(now, seconds);
  }

  writeDiagnostics(out: GameDiagnostics) {
    const { me } = this;
    const now = this.client.serverNow();
    const ms = now - this.state.startAt;
    const playing = this.state.phase === "play";
    out.frame = this.frame;
    out.entities = this.racers.size;
    out.complete = this.started && !playing;
    out.timeLeft = Math.max(0, Math.round((ROUND_MS - ms) / 100) / 10);
    out.score = this.scoreOf(this.myKey());
    out.place = this.myPlace;
    out.knockOffs = this.knockOffs;
    out.car = this.kind;

    if (!this.started || !me) {
      out.phase = "title";

      return;
    }

    out.phase = phaseOf(playing, ms, me.mode);
    const spot = this.stage.project(me.x, 0, me.z);
    out.player.x = Math.round(spot.x);
    out.player.y = Math.round(spot.y);
    const shrink = shrinkAt(ms);
    const late = shrink.late || shrink.warn;
    out.edge = round1(edgeDistance(this.arena, me.x, me.z, late));
    out.threat = round1(hazardThreat(this.arena, ms / 1000, me.x, me.z, shrink.late));
    out.attackReady = me.cooldown <= 0 && me.mode === "drive";
    out.range = reachOf(me.kind);
    out.boost = round1(me.meter);
    out.special = me.special;
    out.damage = Math.round(me.damage);
    out.falls = me.falls;
    const cos = Math.cos(me.a);
    const sin = Math.sin(me.a);

    const seen = (x: number, z: number) => ({
      ahead: round1((x - me.x) * cos + (z - me.z) * sin),
      side: round1(-(x - me.x) * sin + (z - me.z) * cos),
    });

    Object.assign(out.centre, seen(0, 0));
    let best = Number.POSITIVE_INFINITY;
    out.rival.distance = 99;

    for (const racer of this.racers.values()) {
      const gap = Math.hypot(racer.view.x - me.x, racer.view.z - me.z);

      if (racer.who !== "me" && racer.view.mode === "drive" && !racer.view.safe && gap < best) {
        best = gap;
        Object.assign(out.rival, seen(racer.view.x, racer.view.z), {
          damage: Math.round(racer.view.damage),
          distance: round1(gap),
          edge: round1(edgeDistance(this.arena, racer.view.x, racer.view.z, late)),
        });
      }
    }

    out.cube.distance = 99;

    for (const cube of this.shown.values()) {
      const gap = Math.hypot(cube.x - me.x, cube.z - me.z);

      if (gap < out.cube.distance) {
        Object.assign(out.cube, seen(cube.x, cube.z), { distance: round1(gap) });
      }
    }
  }

  private myKey() {
    return this.client.playerId ?? "me";
  }

  private rekey() {
    const { me } = this;
    const key = this.myKey();

    if (me && me.key !== key) {
      this.field.cars.delete(me.key);
      this.racers.delete(me.key);
      me.key = key;
      me.falls = 0;
      this.field.cars.set(key, me);
    }
  }

  private hosting() {
    const { client } = this;

    return client.isHost && (client.connectionStatus === "offline" || client.serverClock.synced);
  }

  private wake(now: number) {
    const { me } = this;

    if (me && this.lastNow > 0 && now - this.lastNow > AWAY_MS) {
      Object.assign(me, {
        kx: 0,
        kz: 0,
        lockAny: 0,
        stagger: 0,
        vx: 0,
        vz: 0,
      } satisfies Partial<Car>);
    }

    this.lastNow = now;
  }

  private humans(now: number) {
    const { client } = this;
    const ids: string[] = [];

    for (const player of Object.values(client.players)) {
      if (player.id === client.playerId) {
        if (this.started) {
          ids.push(player.id);
        }
      } else if (player.connected !== false) {
        const report = readPose(player.state);

        if (report && now - report.t < AWAY_MS) {
          ids.push(player.id);
        }
      }
    }

    return ids.toSorted();
  }

  private mySlot() {
    const ids = this.humans(this.client.serverNow());

    return Math.max(0, ids.indexOf(this.client.playerId ?? "")) % GRID_SIZE;
  }

  private scoreOf(key: string) {
    const { scores } = this.client.sharedState;

    return isJsonObject(scores) ? numberOr(scores[key], 0) : 0;
  }

  private newRound(round: number) {
    this.client.clearClaims("cube:");
    this.client.updateSharedState({
      bots: {},
      counted: {},
      nextAt: 0,
      phase: "play",
      round,
      scores: {},
      startAt: Math.round(this.client.serverNow() + COUNTDOWN_MS),
    });
    this.syncRoom(this.client.serverNow());
  }

  private syncRoom(now: number) {
    const { client } = this;
    const next = readRound(client.sharedState);

    if (!next) {
      if (this.hosting()) {
        this.newRound(1);
      }

      return;
    }

    if (next.round !== this.state.round) {
      this.applyRound(next);
    }

    this.state = next;

    if (client.isHost && !this.wasHost && now > 0) {
      this.adoptBots();
    } else if (!client.isHost && this.wasHost) {
      this.dropBots();
    }

    this.wasHost = client.isHost;
    const status = client.connectionStatus;
    const reconnected = this.lastStatus === "reconnecting" && status === "connected";

    if (client.hostId !== this.lastHostId || reconnected) {
      this.botClock.relearn();
    }

    if (reconnected) {
      for (const racer of this.racers.values()) {
        racer.track?.relearn();
      }
    }

    this.lastHostId = client.hostId;
    this.lastStatus = status;
  }

  private applyRound(next: RoundState) {
    const { field, me } = this;
    this.state = next;
    field.round = next.round;
    field.seq = 0;
    field.taken.clear();
    field.shots.length = 0;
    field.events.length = 0;
    this.pending.clear();
    this.foretold.clear();
    this.steered.clear();
    this.landed.clear();
    this.shown.clear();
    this.glow.clear();
    this.director = makeDirector();
    this.warned = false;
    this.dropped = false;
    this.resultsShown = false;
    this.knockOffs = 0;
    this.hud.showResults(false);
    const { grid } = this.arena.def;

    if (me) {
      gridCar(me, grid[this.mySlot()] ?? { a: 0, x: 0, z: 0 });

      if (this.client.serverNow() >= next.startAt) {
        Object.assign(me, { mode: "out", modeT: RESPAWN_SECONDS } satisfies Partial<Car>);
      }
    }

    for (const [key, car] of field.cars) {
      if (car.bot) {
        const index = Number(key.slice(1));
        car.kind = botKind(index, next.round);
        car.cooldownOf = KINDS[car.kind].cooldown;
        gridCar(car, grid[GRID_SIZE - 1 - index] ?? { a: 0, x: 0, z: 0 });
        this.brains.set(key, makeBrain(index, next.round));
      }
    }

    for (const racer of this.racers.values()) {
      Object.assign(racer, { attacks: 0, launches: 0, predicted: null, uses: 0 });
      racer.view = {
        ...racer.view,
        attacks: 0,
        falls: 0,
        lastBy: "",
        launches: 0,
        outBy: "",
        uses: 0,
      };
    }
  }

  private adoptBots() {
    const rows = this.client.sharedState.bots;

    if (!isJsonObject(rows)) {
      return;
    }

    for (const [key, row] of Object.entries(rows)) {
      const report = readPose(row);

      if (report && report.round === this.state.round && !this.field.cars.has(key)) {
        const car = makeCar(key, true, report.kind);
        adoptCar(car, report);
        this.field.cars.set(key, car);
        this.brains.set(key, makeBrain(Number(key.slice(1)), this.state.round));
      }
    }
  }

  private dropBots() {
    for (const [key, car] of this.field.cars) {
      if (car.bot) {
        this.field.cars.delete(key);
      }
    }

    this.field.shots.length = 0;
    this.director = makeDirector();
  }

  private staffBots(seconds: number, now: number) {
    const count = Math.min(BOTS.length, GRID_SIZE - this.humans(now).length);
    this.paintBots();

    for (const [index] of BOTS.entries()) {
      const key = botKey(index);
      const car = this.field.cars.get(key);

      if (index < count && !car) {
        const fresh = makeCar(key, true, botKind(index, this.state.round));
        fresh.modeT = RESPAWN_SECONDS;

        if (seconds < 0) {
          gridCar(fresh, this.arena.def.grid[GRID_SIZE - 1 - index] ?? { a: 0, x: 0, z: 0 });
        }

        this.field.cars.set(key, fresh);
        this.brains.set(key, makeBrain(index, this.state.round));
      } else if (index >= count && car) {
        this.field.cars.delete(key);
        releaseBot(this.director, key);
      }
    }
  }

  private paintBots() {
    const taken = new Set<number>();

    if (this.started) {
      taken.add(this.colour);
    }

    for (const racer of this.racers.values()) {
      if (racer.who === "human") {
        taken.add(racer.colour);
      }
    }

    const free = CAR_RAMPS.map((_ramp, index) => index).filter((index) => !taken.has(index));

    for (const [index] of BOTS.entries()) {
      this.botColours[index] = free[index % Math.max(1, free.length)] ?? index % CAR_RAMPS.length;
    }
  }

  private hostTick(now: number) {
    const { state } = this;

    if (state.phase === "results") {
      if (now < state.startAt + ROUND_MS + LATE_FALL_MS) {
        this.scoreFalls(true);
      }

      if (now >= state.nextAt) {
        this.newRound(state.round + 1);
      }

      return;
    }

    this.scoreFalls(false);

    if (now >= state.startAt + ROUND_MS) {
      this.client.updateSharedState({ nextAt: Math.round(now + RESULTS_MS), phase: "results" });
    }
  }

  private tallies() {
    const rows: { key: string; falls: number; outBy: string }[] = [];

    for (const car of this.field.cars.values()) {
      rows.push({ falls: car.falls, key: car.key, outBy: car.outBy });
    }

    for (const racer of this.racers.values()) {
      if (racer.track && racer.seen && !this.field.cars.has(racer.key)) {
        rows.push({ falls: racer.view.falls, key: racer.key, outBy: racer.view.outBy });
      }
    }

    return rows;
  }

  private scoreFalls(creditedOnly: boolean) {
    const shared = this.client.sharedState;
    const counted: JsonRecord = isJsonObject(shared.counted) ? { ...shared.counted } : {};
    const scores: JsonRecord = isJsonObject(shared.scores) ? { ...shared.scores } : {};
    let changed = false;

    for (const row of this.tallies()) {
      const seen = numberOr(counted[row.key], 0);

      if (row.falls !== seen) {
        counted[row.key] = row.falls;
        changed = true;
      }

      if (row.falls > seen) {
        this.scoreFall(row.key, row.outBy, scores, creditedOnly);
      }
    }

    if (changed) {
      this.client.updateSharedState({ counted, scores });
    }
  }

  private scoreFall(key: string, by: string, scores: JsonRecord, creditedOnly: boolean) {
    const alone = by === "" || by === key;
    const since = this.client.serverNow() - this.state.startAt;
    const worth = since >= ROUND_MS - SHRINK_MS ? SQUEEZE_POINTS : 1;

    if (alone && !creditedOnly) {
      scores[key] = Math.max(0, numberOr(scores[key], 0) - 1);
      this.client.sendEvent(KO_EVENT, { b: "", n: 1, v: key });
    } else if (!alone && this.racers.has(by)) {
      scores[by] = numberOr(scores[by], 0) + worth;
      this.client.sendEvent(KO_EVENT, { b: by, n: worth, v: key });
    }
  }

  private onKo(payload: JsonValue) {
    if (!isJsonObject(payload) || !isJsonString(payload.v) || !isJsonString(payload.b)) {
      return;
    }

    const victim = this.racers.get(payload.v);
    const by = this.racers.get(payload.b) ?? null;
    const mine = this.myKey();
    const worth = clamp(numberOr(payload.n, 1), 1, SQUEEZE_POINTS);

    if (victim && this.started) {
      this.hud.feed(by ? this.rowOf(by) : null, this.rowOf(victim));
    }

    if (by) {
      reward(this.field, by.key);

      if (this.started) {
        this.fx.say(`+${worth}`, by.x, 2.5, by.z, by.css);
      }
    }

    if (by?.key === mine) {
      this.knockOffs += 1;
      this.hud.banner(`KNOCK-OFF  +${worth}`, "good", 1300);
      sfx.knockOff();
    } else if (victim?.key === mine) {
      this.hud.banner(by ? `KNOCKED OFF BY ${by.name}` : "YOU FELL OFF  -1", "bad", 1500);
      sfx.knockedOut();
    }
  }

  private onHit(payload: JsonValue, from: string) {
    if (from === this.client.playerId || !isJsonObject(payload) || !isJsonString(payload.to)) {
      return;
    }

    const hit = readHit(payload.h);
    const car = this.field.cars.get(payload.to);

    if (hit && car && !this.field.cars.has(hit.by)) {
      deliver(this.field, car, hit);
    }
  }

  private onClash(payload: JsonValue) {
    if (!isJsonObject(payload) || !isJsonString(payload.a)) {
      return;
    }

    const car = this.field.cars.get(payload.a);
    const { dx, dz } = payload;
    const out = car?.mode === "drive" && (car.phase === "strike" || car.phase === "hold");

    if (car && out && isJsonNumber(dx) && isJsonNumber(dz)) {
      const length = Math.hypot(dx, dz) || 1;
      clash(car, dx / length, dz / length);
      this.fx.clash(car.x - dx / length, car.z - dz / length, car.key === this.myKey());
    }
  }

  private gather(dt: number, now: number) {
    const { client, field } = this;

    for (const racer of this.racers.values()) {
      racer.seen = false;
    }

    field.ghosts.clear();
    this.heard.clear();

    for (const player of Object.values(client.players)) {
      const away = player.id === client.playerId || player.connected === false;
      const report = away ? null : readPose(player.state);

      if (report && now - report.t < AWAY_MS) {
        this.hear(player.id, "human", report);
      }
    }

    const rows = client.isHost ? null : client.sharedState.bots;

    for (const [key, row] of Object.entries(isJsonObject(rows) ? rows : {})) {
      const report = readPose(row);

      if (report) {
        this.hear(key, "bot", report);
      }
    }

    this.hearShots(now);
    this.dropShots();

    for (const racer of this.racers.values()) {
      if (racer.seen && racer.track) {
        const predicted = this.predict(racer, dt);
        const ghost = ghostOf(racer.key, racer.view);
        ghost.x += predicted.x;
        ghost.z += predicted.z;
        field.ghosts.set(racer.key, ghost);
      }
    }
  }

  private hear(key: string, who: Who, report: PoseReport) {
    if (report.round !== this.state.round || this.field.cars.has(key)) {
      return;
    }

    const racer = this.ensure(key, who, report.colour);
    this.paint(racer, report.colour);
    racer.track?.push(report);
    const view = racer.track?.sample();

    if (view) {
      racer.view = view;
      racer.seen = true;
      this.heard.set(key, report);
    }
  }

  private hearShots(now: number) {
    const { shots } = this.field;

    for (const [owner, report] of this.heard) {
      const lag = clamp((now - report.t) / 1000, 0, 0.4);

      for (const row of report.shots) {
        const id = `${owner}:${report.round}:${row.seq}`;
        let shot = shots.find((other) => other.id === id);

        if (!shot) {
          shot = shotOf(owner, report.round, row);
          shots.push(shot);
        }

        if (row.kind === "seeker" && this.steered.get(id) !== report.t) {
          this.steered.set(id, report.t);
          const x = row.x + Math.cos(row.a) * SEEKER_SPEED * lag;
          const z = row.z + Math.sin(row.a) * SEEKER_SPEED * lag;
          shot.x += (x - shot.x) * 0.5;
          shot.z += (z - shot.z) * 0.5;
          shot.a = row.a;
          shot.target = row.target;
        }
      }
    }
  }

  private dropShots() {
    const { shots } = this.field;

    for (let i = shots.length - 1; i >= 0; i -= 1) {
      const shot = shots[i];
      const report = shot ? this.heard.get(shot.by) : undefined;
      const seq = shot ? Number(shot.id.slice(shot.id.lastIndexOf(":") + 1)) : 0;

      if (shot && !shot.own && report?.shots.some((row) => row.seq === seq) !== true) {
        shots.splice(i, 1);
        this.steered.delete(shot.id);
        const early = this.field.time - shot.t0 < shotLife(shot.kind) - 0.05;
        this.popShot(shot, early || shot.kind === "rocket");
      }
    }
  }

  private popShot(shot: Shot, burst: boolean) {
    const owner = this.racers.get(shot.by);
    this.fx.pop(shot, burst, owner?.ramp ?? RAMP.white, shot.by === this.myKey());
  }

  private predict(racer: Racer, dt: number) {
    const guess = racer.predicted;

    if (!guess) {
      return { x: 0, z: 0 };
    }

    if (guess.t1 < 0 && racer.view.hitId === guess.id) {
      guess.t1 = this.clock;
    }

    const travelled = (since: number) =>
      guess.reach * (1 - Math.exp(-Math.max(0, since) / guess.tau));

    const age = this.clock - guess.t0;
    let offset = travelled(age);

    if (guess.t1 >= 0) {
      offset -= travelled(this.clock - guess.t1);
    } else if (age > 0.5) {
      offset *= Math.max(0, 1 - (age - 0.5) / 0.2);
    }

    if ((guess.t1 >= 0 && this.clock - guess.t1 > 1.4) || (guess.t1 < 0 && age > 0.7 + dt)) {
      racer.predicted = null;
    }

    return { x: guess.dx * offset, z: guess.dz * offset };
  }

  private simulate(dt: number, seconds: number) {
    const { field, fx } = this;
    const pressed = this.started && !this.paused ? this.input.read() : null;
    this.attackQueued ||= pressed?.attack === true;
    this.specialQueued ||= pressed?.special === true;
    const shared = this.client.isHost && field.ghosts.size > 0;
    let held = "";

    if (fx.hitstop > 0) {
      fx.hitstop -= dt;

      if (!shared) {
        this.acc = 0;
        field.time = seconds;

        return;
      }

      held = this.me?.key ?? "";
    }

    this.acc += dt;
    const steps = Math.min(MAX_STEPS, Math.floor(this.acc / STEP));
    this.acc = steps === MAX_STEPS ? 0 : this.acc - steps * STEP;
    field.time = seconds - steps * STEP;

    for (let i = 0; i < steps; i += 1) {
      this.inputs.clear();

      if (this.me && pressed && held === "") {
        this.inputs.set(this.me.key, {
          ...stickInput(pressed.sx, pressed.sy),
          attack: this.attackQueued,
          boost: pressed.boost,
          special: this.specialQueued,
        });
        this.attackQueued = false;
        this.specialQueued = false;
      }

      if (this.brains.size > 0 && this.client.isHost) {
        this.thinkBots();
      }

      stepField(field, this.inputs, STEP, held);

      for (const event of field.events) {
        this.onFieldEvent(event);
      }

      field.events.length = 0;
    }
  }

  private thinkBots() {
    const { field } = this;
    const views: BotView[] = [];

    for (const car of field.cars.values()) {
      views.push({
        alive: car.mode === "drive",
        damage: car.damage,
        human: !car.bot,
        key: car.key,
        safe: car.safe > 0,
        vx: car.vx,
        vz: car.vz,
        x: car.x,
        z: car.z,
      });
    }

    for (const ghost of field.ghosts.values()) {
      views.push({
        ...ghost,
        damage: this.racers.get(ghost.key)?.view.damage ?? 0,
        human: !isBotKey(ghost.key),
      });
    }

    const { late } = shrinkAt(field.time * 1000);
    const cubes = cubesAt(this.arena, field.time, late).filter((cube) => !field.taken.has(cube.id));

    for (const car of field.cars.values()) {
      const brain = car.bot ? this.brains.get(car.key) : null;

      if (brain) {
        this.inputs.set(
          car.key,
          botInput(brain, car, this.arena, field.time, views, cubes, this.director, STEP),
        );
      }
    }
  }

  private onFieldEvent(event: FieldEvent) {
    const mine = this.myKey();

    if (event.kind === "send") {
      this.sendHit(event.to, event.hit);
    } else if (event.kind === "hit") {
      const racer = this.racers.get(event.to);

      if (racer) {
        this.foretold.add(event.hit.id);
        this.impact(racer, event.hit.how, event.hit.by, event.reach, event.hit.dx, event.hit.dz);
      }
    } else if (event.kind === "block") {
      this.fx.block(event.x, event.z, event.key === mine);
    } else if (event.kind === "clash") {
      this.onClashEvent(event.a, event.b, event.x, event.z, event.remote);
    } else if (event.kind === "whiff" && event.key === mine) {
      sfx.whiff();
    } else if (event.kind === "reach") {
      this.reachCube(event.key, event.cube);
    } else if (event.kind === "pop") {
      this.popShot(event.shot, event.burst);
    }
  }

  private sendHit(to: string, hit: Hit) {
    this.client.sendEvent(HIT_EVENT, { h: encodeHit(hit), to });
    const racer = this.racers.get(to);

    if (!racer) {
      return;
    }

    if (racer.view.mod === "shield" && hit.how !== "land") {
      this.fx.block(racer.x, racer.z, hit.by === this.myKey());

      return;
    }

    const reach = throwOf(racer.view, hit);
    racer.predicted = {
      dx: hit.dx,
      dz: hit.dz,
      id: hit.id,
      reach,
      t0: this.clock,
      t1: -1,
      tau: flightOf(reach).tau,
    };
    this.foretold.add(hit.id);
    this.impact(racer, hit.how, hit.by, reach, hit.dx, hit.dz);
  }

  private onClashEvent(a: string, b: string, x: number, z: number, remote: boolean) {
    const mine = this.myKey();
    this.fx.clash(x, z, a === mine || b === mine);

    if (remote) {
      const car = this.field.cars.get(b);
      const other = this.racers.get(a);

      if (car && other) {
        const gap = Math.hypot(car.x - other.x, car.z - other.z) || 1;
        this.client.sendEvent(CLASH_EVENT, {
          a,
          dx: (other.x - car.x) / gap,
          dz: (other.z - car.z) / gap,
        });
      }
    }
  }

  private reachCube(key: string, cube: number) {
    const name = cubeKey(this.field.round, cube);
    const waiting = this.pending.get(cube);

    if (this.client.ownerOf(name) === null && (!waiting || this.clock - waiting.at > 1)) {
      this.pending.set(cube, { at: this.clock, key });
      this.client.claim(name);
    }
  }

  private placeOf(key: string) {
    const mine = this.scoreOf(key);
    let place = 1;

    for (const racer of this.racers.values()) {
      if (racer.key !== key && this.scoreOf(racer.key) > mine) {
        place += 1;
      }
    }

    return place;
  }

  private settleClaims(seconds: number) {
    const { client, field } = this;

    for (const [cube, want] of this.pending) {
      const owner = client.ownerOf(cubeKey(field.round, cube));

      if (owner !== null) {
        this.pending.delete(cube);

        if (owner === client.playerId) {
          const special = specialFor(field.round, cube, this.placeOf(want.key), this.racers.size);
          grant(field, want.key, cube, special);
        }
      }
    }

    for (const cube of cubesAt(this.arena, seconds, false)) {
      if (client.ownerOf(cubeKey(field.round, cube.id)) !== null) {
        field.taken.add(cube.id);
      }
    }
  }

  private publish(dt: number, now: number) {
    const { client, field, me } = this;
    const { round } = this.state;

    if (me && this.sendClock.due(dt * 1000)) {
      client.updateMyState(encodeCar(me, now, round, this.colour, field.shots));
    }

    if (client.isHost && this.botSend.due(dt * 1000)) {
      const rows: JsonRecord = {};

      for (const car of field.cars.values()) {
        if (car.bot) {
          const colour = this.botColours[Number(car.key.slice(1))] ?? 0;
          rows[car.key] = encodeCar(car, now, round, colour, field.shots);
        }
      }

      client.updateSharedState({ bots: rows });
    }
  }

  private slotFor(key: string) {
    let slot = this.slots.get(key);

    if (slot === undefined) {
      slot = (this.slots.size % (OIL_SLOT - 1)) + 1;
      this.slots.set(key, slot);
    }

    return slot;
  }

  private ensure(key: string, who: Who, colour: number) {
    const known = this.racers.get(key);

    if (known) {
      return known;
    }

    const bot = who === "bot" ? BOTS[Number(key.slice(1))] : null;
    const ramp = rampOf(colour);
    const slot = this.slotFor(key);
    const css = rampCss(ramp, BASE + 1);
    this.stage.setSlotRamp(slot, ramp);
    const view = viewOf(makeCar(key, who === "bot"));

    const racer: Racer = {
      air: false,
      attackT: 9,
      attacks: 0,
      colour,
      css,
      flash: 0,
      fresh: true,
      key,
      launches: 0,
      mesh: new CarMesh(view.kind),
      mod: "",
      mode: "out",
      name: bot ?? (who === "me" ? "YOU" : `P-${tagFor(key)}`),
      predicted: null,
      ramp,
      rgb: Number.parseInt(css.slice(1), 16),
      seen: true,
      slipping: false,
      slot,
      smokeT: 0,
      special: "",
      steer: 0,
      swing: 0,
      track: who === "me" ? null : new RemoteTrack(who === "bot" ? this.botClock : undefined),
      tumble: 0,
      uses: 0,
      view,
      who,
      x: 0,
      z: 0,
    };

    this.racers.set(key, racer);

    if (who === "human" && this.started) {
      this.hud.banner(`${racer.name} JOINED`, "plain", 1400);
    }

    return racer;
  }

  private paint(racer: Racer, colour: number) {
    if (racer.colour !== colour) {
      const ramp = rampOf(colour);
      const css = rampCss(ramp, BASE + 1);
      Object.assign(racer, { colour, css, ramp, rgb: Number.parseInt(css.slice(1), 16) });
      this.stage.setSlotRamp(racer.slot, ramp);
    }
  }

  private rowOf(racer: Racer) {
    return {
      css: racer.css,
      key: racer.key,
      me: racer.who === "me",
      name: racer.name,
      out: racer.view.mode !== "drive",
      score: this.scoreOf(racer.key),
    } satisfies HudRow;
  }

  private present(dt: number, seconds: number) {
    const { field, fx, stage } = this;
    stage.begin();
    this.lights.reset();
    this.showOwn();
    const shrink = shrinkAt(seconds * 1000);
    const live = this.state.phase === "play" && seconds > 0.5;

    for (const [key, racer] of this.racers) {
      if (racer.seen) {
        if (!field.cars.has(key) && !racer.track) {
          racer.track = new RemoteTrack(racer.who === "bot" ? this.botClock : undefined);
        }

        this.follow(racer, dt);
        this.drawRacer(racer, dt, shrink.late);
      } else {
        this.racers.delete(key);

        if (live && racer.mode === "drive") {
          fx.poof(racer.x, racer.z, racer.ramp);
        }
      }
    }

    this.shrinkFx(shrink);
    this.board.drawEnds(stage, shrink.drop, shrink.warn && Math.floor(this.clock * 7) % 2 === 0);
    this.props.draw(stage, this.lights, seconds, this.clock, dt, shrink.drop);
    this.pistonFx(seconds, dt, shrink.late);
    this.showCubes(seconds, shrink.late);

    for (const shot of field.shots) {
      const ramp = this.racers.get(shot.by)?.ramp ?? RAMP.white;
      drawShot(stage, this.lights, this.glow, shot, seconds, this.clock, ramp);
    }

    this.updateCamera(dt);
    this.showroom(dt);
    fx.draw(dt);
    this.glow.decay(dt, 7);

    if (this.frame % 2 === 0) {
      stage.uploadPaint(this.glow.owner, this.glow.strength);
    }

    if (this.lights.changed) {
      stage.uploadLight();
    }

    this.sweepRadar(shrink);
    this.drive();
  }

  private showOwn() {
    const mine = this.myKey();

    for (const car of this.field.cars.values()) {
      const isMine = car.key === mine;
      const colour = isMine ? this.colour : (this.botColours[Number(car.key.slice(1))] ?? 0);
      const racer = this.ensure(car.key, isMine ? "me" : "bot", colour);
      this.paint(racer, colour);

      if (racer.track && car.bot) {
        racer.track = null;
      }

      racer.view = viewOf(car);
      racer.seen = true;
      const drawn = drawnOf(car);
      Object.assign(racer, { steer: drawn.steer, swing: drawn.swing, tumble: drawn.tumble });
    }
  }

  private showCubes(seconds: number, late: boolean) {
    const { field, fx, stage } = this;
    const playing = this.state.phase === "play";
    const cubes = playing ? cubesAt(this.arena, seconds, late) : [];
    const before = new Map(this.shown);
    this.shown.clear();

    for (const cube of cubes) {
      if (!field.taken.has(cube.id)) {
        drawCube(stage, this.lights, cube, seconds, this.clock);

        if (seconds >= cube.landAt) {
          this.shown.set(cube.id, cube);
        }

        if (seconds >= cube.landAt && !this.landed.has(cube.id)) {
          this.landed.add(cube.id);

          if (seconds - cube.landAt < 0.5) {
            fx.sparks.ring(cube.x, cube.z, RAMP.yellow, 7, 16);

            if (fx.hears(cube.x, cube.z)) {
              sfx.cube();
            }
          }
        }
      }
    }

    for (const [id, at] of before) {
      if (field.taken.has(id)) {
        fx.sparkle(at.x, at.z, RAMP.yellow);
      }
    }
  }

  private follow(racer: Racer, dt: number) {
    const { view } = racer;
    const offset = racer.track ? this.predict(racer, 0) : { x: 0, z: 0 };
    racer.x = view.x + offset.x;
    racer.z = view.z + offset.z;
    racer.flash = Math.max(0, racer.flash - dt);

    if (racer.mesh.kind !== view.kind) {
      racer.mesh = new CarMesh(view.kind);
    }

    if (racer.fresh) {
      Object.assign(racer, {
        air: view.y > 0.15 && view.mode === "drive",
        attacks: view.attacks,
        fresh: false,
        launches: view.launches,
        mod: view.mod,
        mode: view.mode,
        slipping: view.slipping,
        special: view.special,
        uses: view.uses,
      });
    }

    this.followBlows(racer);
    this.followActs(racer);

    if (racer.track) {
      racer.attackT += dt;
      racer.swing = swingAt(view.kind, racer.attackT);
      racer.tumble = view.y > 0.1 && view.staggered ? racer.tumble + dt * 13 : 0;
      racer.steer = 0;
    }

    if (view.mode !== racer.mode) {
      this.onMode(racer, racer.mode, view.mode);
      racer.mode = view.mode;
    }

    this.followAir(racer);
    this.followGear(racer);
  }

  private followBlows(racer: Racer) {
    const { view } = racer;

    if (view.launches > racer.launches && !this.foretold.delete(view.hitId)) {
      const speed = Math.hypot(view.vx, view.vz) || 1;
      const by = view.hitId.startsWith("hz-") ? "" : (view.hitId.split(":")[0] ?? "");
      const gain = FIXED.has(view.hitHow) ? 1 : 1 + view.damage * DAMAGE_GAIN;
      this.impact(
        racer,
        view.hitHow,
        by,
        REACH_GUESS[view.hitHow] * gain,
        view.vx / speed,
        view.vz / speed,
      );
    }

    racer.launches = view.launches;
  }

  private followActs(racer: Racer) {
    const { view } = racer;
    const mine = racer.who === "me";
    const spot = { a: view.a, ramp: racer.ramp, x: racer.x, z: racer.z };

    if (view.attacks > racer.attacks) {
      racer.attackT = 0;
      this.fx.swing(KINDS[view.kind].attack, spot, mine);
    }

    racer.attacks = view.attacks;

    if (view.uses > racer.uses && view.usedKind !== "") {
      this.fx.use(view.usedKind, spot, mine);

      if (view.usedKind === "zap") {
        this.zapFrom(racer);
      }
    }

    racer.uses = view.uses;
  }

  private zapFrom(racer: Racer) {
    for (const other of this.racers.values()) {
      const gap = Math.hypot(other.x - racer.x, other.z - racer.z);

      if (other !== racer && other.view.mode === "drive" && !other.view.safe && gap < ZAP_RADIUS) {
        this.fx.bolt(racer.x, racer.z, other.x, other.z);
      }
    }
  }

  private followGear(racer: Racer) {
    const { view } = racer;
    const mine = racer.who === "me";
    const spot = { a: view.a, ramp: racer.ramp, x: racer.x, z: racer.z };

    if (view.special !== "" && view.special !== racer.special) {
      this.fx.sparkle(racer.x, racer.z, SPECIAL_RAMP[view.special]);

      if (mine) {
        sfx.pickup();
        this.hud.banner(specialName(view.special), "warn", 1100);
      }
    }

    racer.special = view.special;

    if (view.slipping && !racer.slipping) {
      this.fx.slip(spot, mine);
    }

    racer.slipping = view.slipping;
    racer.mod = view.mod;
  }

  private followAir(racer: Racer) {
    const { view } = racer;
    const air = view.y > 0.15 && view.mode === "drive";
    const mine = racer.who === "me";

    if (racer.air && !air && view.mode === "drive") {
      racer.mesh.thump();

      if (mine || this.fx.hears(racer.x, racer.z)) {
        sfx.land(mine);
      }

      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        this.fx.sparks.puff(
          racer.x + Math.cos(a) * 1.2,
          0.3,
          racer.z + Math.sin(a) * 1.2,
          RAMP.tile,
          0.4,
        );
      }
    }

    racer.air = air;
  }

  private onMode(racer: Racer, from: CarMode, to: CarMode) {
    const mine = racer.who === "me";
    const { fx } = this;
    const near = mine || fx.hears(racer.x, racer.z);

    if (to === "fall") {
      if (near) {
        sfx.fall(mine);
      }

      for (let i = 0; i < 10; i += 1) {
        fx.sparks.puff(
          racer.x + (Math.random() - 0.5) * 2,
          0.3,
          racer.z + (Math.random() - 0.5) * 2,
          RAMP.cream,
          0.5,
        );
      }
    } else if (to === "out" && from === "fall") {
      if (near) {
        sfx.out();
      }

      fx.sparks.confetti(racer.x, 0.5, racer.z, [racer.ramp, RAMP.white], 22);
      fx.flash(racer.x, racer.z, 6, 0.8, 0.3);
    } else if (to === "drive" && from === "drop") {
      racer.mesh.thump();

      if (near) {
        sfx.land(mine);
      }

      fx.sparks.ring(racer.x, racer.z, RAMP.cream, 10, 22);
      fx.flash(racer.x, racer.z, 6, 0.7, 0.3);
      fx.shake = Math.max(fx.shake, mine ? 0.5 : 0);
    }
  }

  private impact(racer: Racer, how: HitHow, by: string, reach: number, dx: number, dz: number) {
    const mine = this.myKey();
    const attacker = this.racers.get(by);
    const power = clamp(reach / 14, 0.15, 1);
    racer.flash = 0.2 + power * 0.12;
    racer.mesh.thump();
    this.fx.impact({
      dx,
      dz,
      how,
      involved: racer.key === mine || by === mine,
      mine: by === mine,
      ramp: attacker?.ramp ?? (how === "bumper" ? RAMP.pink : RAMP.hazard),
      reach,
      x: racer.x,
      z: racer.z,
    });

    if (how === "stomp" && attacker) {
      const spot = { a: 0, ramp: attacker.ramp, x: attacker.x, z: attacker.z };
      this.fx.stomp(spot, by === mine);
    }
  }

  private shrinkFx(shrink: { warn: boolean; late: boolean }) {
    if (this.state.phase !== "play") {
      return;
    }

    if (shrink.warn && !this.warned) {
      this.warned = true;

      if (this.started) {
        sfx.warn();
        this.hud.banner("THE RIM DROPS  ·  DOUBLE POINTS", "warn", 2800);
      }
    }

    if (shrink.late && !this.dropped) {
      this.dropped = true;

      if (this.started) {
        sfx.drop();
        this.fx.shake = Math.max(this.fx.shake, 1);
      }

      const { halfX, halfZ } = this.arena;

      for (let i = 0; i < 70; i += 1) {
        const x = (Math.random() - 0.5) * halfX * 2;
        const z = (Math.random() - 0.5) * halfZ * 2;
        const rim = edgeDistance(this.arena, x, z, true);

        if (rim < 0 && rim > -5 && edgeDistance(this.arena, x, z) > 0) {
          this.fx.sparks.puff(x, 0.4, z, RAMP.cream, 0.7);
        }
      }
    }
  }

  private pistonFx(seconds: number, dt: number, late: boolean) {
    if (seconds < 0 || this.state.phase !== "play") {
      return;
    }

    for (const hazard of this.arena.def.hazards) {
      if (hazard.kind === "piston" && !hazardGone(this.arena, hazard, late)) {
        const before = pistonAt(hazard, seconds - dt);
        const state = pistonAt(hazard, seconds);

        if (state.firing && !before.firing) {
          const x = hazard.x + Math.cos(hazard.a) * 4;
          const z = hazard.z + Math.sin(hazard.a) * 4;
          this.fx.flash(x, z, 8, 0.9, 0.3);

          if (this.fx.hears(x, z)) {
            sfx.piston();
          }
        }
      }
    }
  }

  private drawRacer(racer: Racer, dt: number, late: boolean) {
    const { view } = racer;
    const { stage } = this;

    if (view.mode === "out") {
      return;
    }

    const grounded = edgeDistance(this.arena, racer.x, racer.z, late) > 0;
    const falling = view.mode === "fall";
    racer.mesh.update(
      {
        boosting: view.boosting,
        flash: racer.flash,
        ghost: view.safe && view.mode === "drive",
        grounded,
        heading: view.a,
        pitch: falling ? racer.tumble * 0.4 : 0,
        ready: view.ready,
        roll: Math.round((racer.tumble / (Math.PI / 4)) % 8) * (Math.PI / 4),
        shield: view.mod === "shield",
        size: view.mod === "giant" ? GIANT_SCALE : 1,
        slipping: view.slipping,
        steer: racer.steer,
        swing: racer.swing,
        x: racer.x,
        y: Math.max(view.y, TABLE_Y),
        z: racer.z,
      },
      dt,
    );
    racer.mesh.draw(stage, racer.ramp);

    if (view.mode === "drop") {
      stage.draw(BEAM, { ramp: racer.ramp, sheer: true, x: racer.x, y: 0, yaw: 0, z: racer.z });
      this.lights.pool(racer.x, racer.z, 3.4, 0.6);

      return;
    }

    if (view.mode !== "drive") {
      return;
    }

    if (racer.who === "me") {
      this.drawMarker(racer, view);
    }

    this.drawTrail(racer, dt);
  }

  private drawTrail(racer: Racer, dt: number) {
    const { view } = racer;
    const { sparks } = this.fx;
    const cos = Math.cos(view.a);
    const sin = Math.sin(view.a);
    racer.smokeT -= dt;
    const skid = view.staggered || view.slipping || Math.hypot(view.vx, view.vz) > MAX_SPEED * 1.25;

    if (view.y < 0.1 && (view.boosting || skid)) {
      const slot = view.boosting ? racer.slot : SKID_SLOT;

      for (const side of [-0.8, 0.8]) {
        for (const along of [-0.85, 0.85]) {
          this.glow.stamp(
            racer.x + cos * along - sin * side,
            racer.z + sin * along + cos * side,
            0.2,
            slot,
            view.boosting ? 1 : 0.9,
          );
        }
      }
    }

    if (racer.smokeT > 0) {
      return;
    }

    racer.smokeT = 0.09;

    if (view.boosting) {
      const ramp = view.mod === "turbo" ? RAMP.yellow : racer.ramp;
      sparks.puff(racer.x - cos * 1.4, 0.6, racer.z - sin * 1.4, ramp, 0.45);
    }

    if (view.damage >= 60) {
      sparks.puff(racer.x, 1.6, racer.z, view.damage >= 120 ? RAMP.black : RAMP.white, 0.4);
    }

    if (view.damage >= 120 && Math.random() < 0.5) {
      sparks.burst(racer.x, 1.3, racer.z, RAMP.hazard, 2, 5);
    }
  }

  private drawMarker(racer: Racer, view: CarView) {
    const car = this.me;
    const bob = Math.floor(this.clock * 4) % 2 === 0 ? 0 : 0.25;
    const big = view.mod === "giant";
    this.stage.draw(ARROW, {
      aloft: true,
      ramp: racer.ramp,
      x: racer.x,
      y: Math.max(0, view.y) + (big ? 4.8 : 3.6) + bob,
      yaw: this.yaw + Math.PI / 2,
      z: racer.z,
    });
    const ready = car ? attackReady(car) : 1;
    const lit = Math.round(ready * 16);
    const radius = 2.05 * (big ? 1.3 : 1);

    for (let i = 0; i < 16; i += 1) {
      const a = view.a + Math.PI + (i / 16) * Math.PI * 2;
      const on = i < lit;
      const full = tone(racer.ramp, BASE + 2);
      this.stage.dabs.push(
        racer.x + Math.cos(a) * radius,
        0.07,
        racer.z + Math.sin(a) * radius,
        on ? 0.2 : 0.1,
        ready >= 1 ? full : tone(on ? racer.ramp : RAMP.iron, on ? BASE : BASE + 1),
        true,
      );
    }
  }

  private showroom(dt: number) {
    if (this.started) {
      return;
    }

    const { stage } = this;
    const z = this.arena.halfZ + 12;
    let mesh = this.showcars.get(this.kind);

    if (!mesh) {
      mesh = new CarMesh(this.kind);
      this.showcars.set(this.kind, mesh);
    }

    const beat = (this.clock % 3.2) - 2.2;
    const swing = swingAt(this.kind, beat);
    stage.draw(PODIUM, { x: 0, y: TABLE_Y, yaw: this.clock * 0.6, z });
    mesh.update(
      {
        boosting: false,
        flash: 0,
        ghost: false,
        grounded: false,
        heading: this.clock * 0.6 + 0.6,
        pitch: 0,
        ready: beat < 0,
        roll: 0,
        shield: false,
        size: SHOW_SCALE,
        slipping: false,
        steer: 0,
        swing,
        x: 0,
        y: TABLE_Y + 0.8,
        z,
      },
      dt,
    );
    mesh.draw(stage, rampOf(this.colour));
    this.lights.pool(0, z, 8, 0.2);
  }

  private zoomFor() {
    const { stage } = this;

    return clamp(Math.round(Math.sqrt((stage.columns * stage.rows) / 1250)), MIN_ZOOM, PX_PER_UNIT);
  }

  private showCamera() {
    const { aim, stage, view } = this;
    const at = this.hud.showcaseAt();
    const right = (at.x - 0.5) * stage.columns;
    const up = (0.5 - at.y) * stage.rows;
    this.yaw = NORTH;
    view.zoom = PX_PER_UNIT;
    aim.set(
      -right / view.zoom,
      TABLE_Y + 2.4,
      this.arena.halfZ + 12 + up / view.zoom / Math.sin(PITCH),
    );
    this.fx.listen(0, 0);
  }

  private chaseCamera(dt: number) {
    const { aim, me, view } = this;
    const lead = me && me.mode !== "out" ? me : null;
    const steady = lead?.mode === "drive" && lead.stagger <= 0 && lead.slip <= 0;

    if (lead && steady) {
      const turn = wrapAngle(lead.a - this.yaw);
      this.yaw = wrapAngle(this.yaw + turn * Math.min(1, dt * CAM_TURN));
    }

    const x = lead ? lead.x + Math.cos(this.yaw) * CAM_LEAD : aim.x;
    const z = lead ? lead.z + Math.sin(this.yaw) * CAM_LEAD : aim.z;
    const ease = Math.min(1, dt * 6);
    view.zoom = this.zoomFor();
    aim.set(aim.x + (x - aim.x) * ease, aim.y * (1 - ease), aim.z + (z - aim.z) * ease);
    this.fx.listen(aim.x, aim.z);
  }

  private updateCamera(dt: number) {
    const { aim, fx, view } = this;
    fx.shake = Math.max(0, fx.shake - dt * 4);

    if (this.started) {
      this.chaseCamera(dt);
    } else {
      this.showCamera();
    }

    const jolt = this.started ? fx.shake * fx.shake * 0.5 : 0;
    const kick = () => Math.round((Math.random() - 0.5) * jolt * view.zoom) / view.zoom;
    const flat = Math.cos(PITCH);
    view.target.set(aim.x + kick(), aim.y, aim.z + kick());
    view.eye.set(
      view.target.x - Math.cos(this.yaw) * flat * EYE_DISTANCE,
      view.target.y + Math.sin(PITCH) * EYE_DISTANCE,
      view.target.z - Math.sin(this.yaw) * flat * EYE_DISTANCE,
    );
  }

  private tagCars() {
    const { tags } = this;
    tags.length = 0;

    if (!this.started) {
      return;
    }

    const wide = window.innerWidth;
    const high = window.innerHeight;

    for (const racer of this.racers.values()) {
      const { view } = racer;

      if (racer.who !== "me" && racer.seen && view.mode === "drive" && tags.length < 8) {
        const lift = (view.mod === "giant" ? 4 : 2.9) + Math.max(0, view.y);
        const spot = this.stage.project(racer.x, lift, racer.z);

        if (spot.x > 0 && spot.x < wide && spot.y > 0 && spot.y < high) {
          tags.push({
            damage: view.damage,
            name: racer.who === "human" ? racer.name : "",
            x: spot.x,
            y: spot.y,
          });
        }
      }
    }

    this.hud.setTags(tags);
  }

  private sweepRadar(shrink: { warn: boolean; late: boolean }) {
    const { blips, me } = this;

    if (!this.started || !me) {
      return;
    }

    blips.length = 0;

    for (const cube of this.shown.values()) {
      blips.push({ big: false, rgb: 0xff_e0_66, x: cube.x, z: cube.z });
    }

    for (const racer of this.racers.values()) {
      if (racer.who !== "me" && racer.seen && racer.view.mode === "drive") {
        blips.push({ big: true, rgb: racer.rgb, x: racer.x, z: racer.z });
      }
    }

    const at = me.mode === "out" ? this.aim : me;
    this.hud.radar.draw(this.arena, at, this.yaw, shrink.late, shrink.warn, blips);
  }

  private drive() {
    const { me } = this;
    const playing = this.state.phase === "play";

    if (!me || !this.started || me.mode !== "drive" || !playing) {
      idleAudio();

      return;
    }

    driveAudio(Math.min(1, Math.hypot(me.vx, me.vz) / MAX_SPEED), me.boosting);

    if (me.boosting && !this.wasBoosting) {
      sfx.boost();
    }

    this.wasBoosting = me.boosting;
    const ready = me.cooldown <= 0;

    if (ready && !this.wasReady) {
      sfx.ready();
    }

    this.wasReady = ready;
  }

  private standings() {
    const rows = [...this.racers.values()].map((racer) => this.rowOf(racer));

    return rows.toSorted((p, q) => q.score - p.score || p.name.localeCompare(q.name));
  }

  private updateHud(now: number, seconds: number) {
    const { hud, me, state } = this;
    const rows = this.standings();
    const mine = this.myKey();
    this.myPlace = Math.max(1, rows.findIndex((row) => row.key === mine) + 1);
    const humans = rows.filter((row) => !isBotKey(row.key)).length;
    hud.setNet(netText(this.client.connectionStatus, humans));

    if (!this.started) {
      return;
    }

    const left = ROUND_MS - seconds * 1000;
    const round = Math.max(1, state.round - this.firstRound);
    hud.setClock(clamp(left, 0, ROUND_MS), round, left < SHRINK_MS && state.phase === "play");
    hud.setScore(this.scoreOf(mine), this.myPlace);
    hud.setBoard(rows);

    if (me) {
      hud.setDash(
        attackReady(me),
        me.meter,
        me.meter >= BOOST_MIN || me.boosting,
        me.special,
        me.mode === "drive" ? me.damage : 0,
      );
    }

    const count = state.phase === "play" ? countText(seconds, left) : "";

    if (count !== this.lastCount) {
      this.lastCount = count;
      hud.count(count);

      if (count !== "") {
        sfx.countdown(count === "GO");
      }
    }

    this.updateResults(now, rows);
  }

  private updateResults(now: number, rows: readonly HudRow[]) {
    const { hud, state } = this;

    if (state.phase !== "results") {
      if (this.resultsShown) {
        this.resultsShown = false;
        this.input.setTouchVisible(true);
        hud.showResults(false);
      }

      return;
    }

    const won = rows[0]?.key === this.myKey() && (rows[0]?.score ?? 0) > 0;

    if (!this.resultsShown) {
      this.resultsShown = true;
      sfx.results(won);
      this.input.setTouchVisible(false);

      for (const racer of won ? this.racers.values() : []) {
        this.fx.sparks.confetti(racer.x, 2, racer.z, PARTY, 18);
      }
    }

    const wait = Math.max(0, Math.ceil((state.nextAt - now) / 1000));
    hud.showResults(true, rows, won, `Next round in ${wait}`);
  }
}
