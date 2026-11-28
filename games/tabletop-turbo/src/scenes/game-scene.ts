import { notifyGameStarted } from "@repo/embed";
import { FixedRate, RemoteClock } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import * as THREE from "three";

import { driveAudio, idleAudio, sfx } from "../audio/sfx";
import type { Input } from "../input/input";
import { RemoteTrack, adoptCar, drawnOf, encodeCar, ghostOf, readPose, viewOf } from "../net/pose";
import type { CarView, PoseReport } from "../net/pose";
import { isJsonNumber, isJsonObject, isJsonString, numberOr } from "../net/wire";
import type { WireField } from "../net/wire";
import { Board, TABLE_Y } from "../render/board";
import { CarMesh } from "../render/car-mesh";
import { GlowGrid, SKID_SLOT } from "../render/glow-grid";
import { LightMap } from "../render/light-map";
import { Sparks } from "../render/fx";
import { itemName } from "../render/hud";
import type { Hud, HudRow } from "../render/hud";
import { ARROW, BEAM, ITEM_RAMP, Props, drawCrate } from "../render/props";
import {
  BOOST_MIN,
  BOTS,
  BOT_SEND_HZ,
  BUMPER_THROW,
  COUNTDOWN_MS,
  DENT_GAIN,
  GIANT_SCALE,
  GRID_SIZE,
  LOCAL_COLOR,
  MAX_SPEED,
  MAX_STEPS,
  PISTON_THROW,
  PUNCH_HOLD,
  PUNCH_REACH,
  PUNCH_RETRACT,
  PUNCH_STRIKE,
  PUNCH_THROW,
  RAM_THROW,
  RESPAWN_SECONDS,
  RESULTS_MS,
  ROUND_MS,
  SHRINK_MS,
  SEND_HZ,
  SPRING_REACH,
  SQUEEZE_POINTS,
  STEP,
  SWEEPER_THROW,
  KNOCK_TAU,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import { arenaFor, edgeDistance } from "../sim/arena";
import type { Arena } from "../sim/arena";
import { botInput, makeBrain, makeDirector, releaseBot } from "../sim/bot";
import type { BotBrain, BotView } from "../sim/bot";
import { clash, gridCar, heldItem, makeCar, punchReady } from "../sim/car";
import type { Car, CarInput, CarMode, Hit, HitHow } from "../sim/car";
import { deliver, grant, makeField, reward, stepField } from "../sim/field";
import type { Field, FieldEvent } from "../sim/field";
import { hazardThreat, pistonAt, shrinkAt } from "../sim/hazards";
import { crateAt } from "../sim/items";
import { BASE, CAR_RAMPS, RAMP, carRampFor, rampCss, tone } from "../pixel/palette";
import { PX_PER_UNIT, PixelStage } from "../pixel/stage";
import type { StageView } from "../pixel/stage";

type RacerKind = "me" | "bot" | "human";

interface Predicted {
  id: string;
  dx: number;
  dz: number;
  reach: number;
  t0: number;
  t1: number;
}

interface Racer {
  key: string;
  kind: RacerKind;
  name: string;
  css: string;
  ramp: number;
  slot: number;
  mesh: CarMesh;
  track: RemoteTrack | null;
  view: CarView;
  seen: boolean;
  fresh: boolean;
  launches: number;
  punches: number;
  mode: CarMode;
  air: boolean;
  item: string;
  punchT: number;
  flash: number;
  tumble: number;
  smokeT: number;
  bumperOut: number;
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

interface Flash {
  x: number;
  z: number;
  radius: number;
  power: number;
  age: number;
  life: number;
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
  punchReady: boolean;
  boost: number;
  item: string;
  /** The nearest rival that can be hit: offset on screen (x right, y down) and distance. */
  rival: { dx: number; dy: number; distance: number; edge: number };
  /** The way to the middle of the board, on screen. */
  centre: { dx: number; dy: number };
  falls: number;
  knockOffs: number;
}

const FRESH_START = "fresh-start";
const HIT_EVENT = "hit";
const CLASH_EVENT = "clash";
const KO_EVENT = "ko";
const PARTY = [RAMP.yellow, RAMP.pink, RAMP.cyan, RAMP.lime, RAMP.white] as const;
const MIN_ZOOM = 9;
const PITCH = (50 * Math.PI) / 180;
const VIEW_DIR = new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH));
const EYE_DISTANCE = 200;

const THROWS = {
  bumper: BUMPER_THROW,
  land: 2.6,
  piston: PISTON_THROW,
  punch: PUNCH_THROW,
  ram: RAM_THROW,
  sweeper: SWEEPER_THROW,
} as const satisfies Record<HitHow, number>;

const AWAY_MS = 2500;
const LATE_FALL_MS = 1200;

const TEST_SKIPS = new Map([
  ["active-play", 0],
  ["crate", 9500],
  ["finale", ROUND_MS - 6000],
  ["shrink", ROUND_MS - 26_500],
]);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isBotKey = (key: string) => /^b\d$/u.test(key);

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

const hitSound = (how: HitHow, power: number, involved: boolean) => {
  if (how === "punch") {
    sfx.hit(power, involved);
  } else if (how === "ram" || how === "land") {
    sfx.ram(involved);
  } else if (how === "bumper") {
    sfx.bounce(involved);
  } else {
    sfx.sweep(involved);
  }
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

const readHit: (value: WireField) => Hit | null = (value) => {
  if (!isJsonObject(value)) {
    return null;
  }

  const { by, dx, dz, how, id, reach } = value;
  const known = how === "punch" || how === "ram" || how === "land";

  if (!isJsonString(id) || !isJsonString(by) || !known) {
    return null;
  }

  if (!isJsonNumber(dx) || !isJsonNumber(dz) || !isJsonNumber(reach)) {
    return null;
  }

  const length = Math.hypot(dx, dz) || 1;

  return { by, dx: dx / length, dz: dz / length, how, id, reach: clamp(reach, 0, 22) };
};

const botKey = (index: number) => `b${index}`;
const crateKey = (round: number, index: number) => `crate:${round}:${index}`;

export class GameScene {
  private readonly client: MultiplayerClient;
  private readonly input: Input;
  private readonly hud: Hud;
  private readonly stage: PixelStage;
  private readonly lights = new LightMap();
  private readonly glow = new GlowGrid();
  private readonly sparks = new Sparks(900);
  private readonly arena: Arena = arenaFor(0);
  private readonly board: Board;
  private readonly props: Props;
  private readonly field: Field;
  private readonly brains = new Map<string, BotBrain>();
  private director = makeDirector();
  private readonly racers = new Map<string, Racer>();
  private readonly slots = new Map<string, number>();
  private readonly botClock = new RemoteClock();
  private readonly sendClock = new FixedRate(SEND_HZ);
  private readonly botSend = new FixedRate(BOT_SEND_HZ);
  private readonly inputs = new Map<string, CarInput>();
  private readonly pending = new Map<number, { key: string; item: ItemKind; at: number }>();
  private readonly foretold = new Set<string>();
  private readonly flashes: Flash[] = [];
  private readonly view: StageView = {
    eye: new THREE.Vector3(),
    target: new THREE.Vector3(0, 0, 1),
    zoom: PX_PER_UNIT,
  };

  private state: RoundState = { nextAt: 0, phase: "play", round: 0, startAt: 0 };
  private me: Car | null = null;
  private started = false;
  private firstRound = 0;
  private paused = false;
  private pausedAt = 0;
  private lastNow = 0;
  private clock = 0;
  private frame = 0;
  private acc = 0;
  private hitstop = 0;
  private shake = 0;
  private punchQueued = false;
  private wasHost = false;
  private lastHostId: string | null = null;
  private lastStatus = "";
  private lastCount = "";
  private warned = false;
  private dropped = false;
  private wasReady = true;
  private wasBoosting = false;
  private resultsShown = false;
  private lastCrate = -1;
  private knockOffs = 0;
  private myPlace = 1;
  private width = 1;
  private height = 1;

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
    this.field = makeField(this.arena);
    this.stage.setWorld(this.board.solids);
    this.stage.setBoard(this.board.map);
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.stage.resize(width, height);
  }

  render() {
    this.stage.render(this.view);
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
    notifyGameStarted();
    const car = makeCar(this.myKey(), false);
    car.modeT = RESPAWN_SECONDS;
    this.me = car;
    this.field.cars.set(car.key, car);
    this.client.sendToHost(FRESH_START, null);
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
        (racer) => racer.kind !== "bot" && racer.key !== asker,
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
      this.punchQueued = false;
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

  /** Playtest hook: jump to a named moment of a round. */
  setTestState(name: string) {
    if (name === "title") {
      return !this.started;
    }

    if (name === "sun" || name === "sun-off") {
      this.stage.setSun(name === "sun");

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

    if (!this.started && this.input.anyStart()) {
      this.start();
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

    if (!this.started || !me) {
      out.phase = "title";

      return;
    }

    out.phase = phaseOf(playing, ms, me.mode);
    const spot = this.stage.project(me.x, 0, me.z);
    out.player.x = Math.round(spot.x);
    out.player.y = Math.round(spot.y);
    const late = shrinkAt(ms).late || shrinkAt(ms).warn;
    out.edge = Math.round(edgeDistance(this.arena, me.x, me.z, late) * 10) / 10;
    out.threat = Math.round(hazardThreat(this.arena, ms / 1000, me.x, me.z) * 10) / 10;
    out.punchReady = me.cooldown <= 0 && me.mode === "drive";
    out.boost = Math.round(me.meter * 10) / 10;
    out.item = heldItem(me);
    out.falls = me.falls;
    out.centre.dx = Math.round(-me.x);
    out.centre.dy = Math.round(-me.z);
    let best = Number.POSITIVE_INFINITY;
    out.rival.distance = 99;

    for (const racer of this.racers.values()) {
      const gap = Math.hypot(racer.view.x - me.x, racer.view.z - me.z);

      if (racer.kind !== "me" && racer.view.mode === "drive" && !racer.view.safe && gap < best) {
        best = gap;
        out.rival.dx = Math.round((racer.view.x - me.x) * 10) / 10;
        out.rival.dy = Math.round((racer.view.z - me.z) * 10) / 10;
        out.rival.distance = Math.round(gap * 10) / 10;
        out.rival.edge =
          Math.round(edgeDistance(this.arena, racer.view.x, racer.view.z, late) * 10) / 10;
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
    this.client.clearClaims("crate:");
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
    field.events.length = 0;
    this.pending.clear();
    this.foretold.clear();
    this.glow.clear();
    this.director = makeDirector();
    this.warned = false;
    this.dropped = false;
    this.resultsShown = false;
    this.lastCrate = -1;
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
        gridCar(car, grid[GRID_SIZE - 1 - index] ?? { a: 0, x: 0, z: 0 });
        this.brains.set(key, makeBrain(index, next.round));
      }
    }

    for (const racer of this.racers.values()) {
      Object.assign(racer, { launches: 0, predicted: null, punches: 0 });
      racer.view = { ...racer.view, falls: 0, lastBy: "", launches: 0, outBy: "", punches: 0 };
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
        const car = makeCar(key, true);
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

    this.director = makeDirector();
  }

  private staffBots(seconds: number, now: number) {
    const count = Math.min(BOTS.length, GRID_SIZE - this.humans(now).length);

    for (const [index] of BOTS.entries()) {
      const key = botKey(index);
      const car = this.field.cars.get(key);

      if (index < count && !car) {
        const fresh = makeCar(key, true);
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

    if (victim) {
      this.hud.feed(by ? this.rowOf(by) : null, this.rowOf(victim));
    }

    if (by) {
      reward(this.field, by.key);
      const spot = this.stage.project(by.x, 2.5, by.z);
      this.hud.pop(`+${worth}`, spot.x, spot.y, by.css);
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
      this.clashFx(car.x - dx / length, car.z - dz / length, car.key === this.myKey());
    }
  }

  private gather(dt: number, now: number) {
    const { client, field } = this;

    for (const racer of this.racers.values()) {
      racer.seen = false;
    }

    field.ghosts.clear();

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

  private hear(key: string, kind: RacerKind, report: PoseReport) {
    if (report.round !== this.state.round) {
      return;
    }

    const racer = this.ensure(key, kind);
    racer.track?.push(report);
    const view = racer.track?.sample();

    if (view) {
      racer.view = view;
      racer.seen = true;
    }
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
      guess.reach * (1 - Math.exp(-Math.max(0, since) / KNOCK_TAU));

    const age = this.clock - guess.t0;
    let offset = travelled(age);

    if (guess.t1 >= 0) {
      offset -= travelled(this.clock - guess.t1);
    } else if (age > 0.5) {
      offset *= Math.max(0, 1 - (age - 0.5) / 0.2);
    }

    if ((guess.t1 >= 0 && this.clock - guess.t1 > 1) || (guess.t1 < 0 && age > 0.7 + dt)) {
      racer.predicted = null;
    }

    return { x: guess.dx * offset, z: guess.dz * offset };
  }

  private simulate(dt: number, seconds: number) {
    const { field } = this;
    const pressed = this.started && !this.paused ? this.input.read() : null;
    this.punchQueued ||= pressed?.punch === true;
    const shared = this.client.isHost && field.ghosts.size > 0;
    let held = "";

    if (this.hitstop > 0) {
      this.hitstop -= dt;

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
        this.inputs.set(this.me.key, { ...pressed, punch: this.punchQueued });
        this.punchQueued = false;
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
      views.push({ ...ghost, human: !isBotKey(ghost.key) });
    }

    const crate = crateAt(this.arena, field.round, field.time);
    const open = crate && !field.taken.has(crate.index) ? crate : null;

    for (const car of field.cars.values()) {
      const brain = car.bot ? this.brains.get(car.key) : null;

      if (brain) {
        this.inputs.set(
          car.key,
          botInput(brain, car, this.arena, field.time, views, open, this.director, STEP),
        );
      }
    }
  }

  private onFieldEvent(event: FieldEvent) {
    const mine = this.myKey();

    if (event.kind === "send") {
      this.client.sendEvent(HIT_EVENT, { h: { ...event.hit }, to: event.to });
      const racer = this.racers.get(event.to);

      if (racer) {
        const gain = (DENT_GAIN[racer.view.dent] ?? 1) * (racer.view.mod === "giant" ? 0.7 : 1);
        const reach = event.hit.reach * gain;
        racer.predicted = {
          dx: event.hit.dx,
          dz: event.hit.dz,
          id: event.hit.id,
          reach,
          t0: this.clock,
          t1: -1,
        };
        this.foretold.add(event.hit.id);
        this.impact(racer, event.hit.how, event.hit.by, reach, event.hit.dx, event.hit.dz);
      }
    } else if (event.kind === "clash") {
      this.clashFx(event.x, event.z, event.a === mine || event.b === mine);

      if (event.remote) {
        const car = this.field.cars.get(event.b);
        const other = this.racers.get(event.a);

        if (car && other) {
          const gap = Math.hypot(car.x - other.x, car.z - other.z) || 1;
          this.client.sendEvent(CLASH_EVENT, {
            a: event.a,
            dx: (other.x - car.x) / gap,
            dz: (other.z - car.z) / gap,
          });
        }
      }
    } else if (event.kind === "whiff" && event.key === mine) {
      sfx.whiff();
    } else if (event.kind === "reach") {
      this.reachCrate(event.key, event.crate, event.item);
    }
  }

  private reachCrate(key: string, crate: number, item: ItemKind) {
    const name = crateKey(this.field.round, crate);
    const waiting = this.pending.get(crate);

    if (this.client.ownerOf(name) === null && (!waiting || this.clock - waiting.at > 1)) {
      this.pending.set(crate, { at: this.clock, item, key });
      this.client.claim(name);
    }
  }

  private settleClaims(seconds: number) {
    const { client, field } = this;

    for (const [crate, want] of this.pending) {
      const owner = client.ownerOf(crateKey(field.round, crate));

      if (owner !== null) {
        this.pending.delete(crate);

        if (owner === client.playerId) {
          grant(field, want.key, crate, want.item);
        }
      }
    }

    const current = crateAt(this.arena, field.round, seconds);

    if (current && client.ownerOf(crateKey(field.round, current.index)) !== null) {
      field.taken.add(current.index);
    }
  }

  private publish(dt: number, now: number) {
    const { client, field, me } = this;

    if (me && this.sendClock.due(dt * 1000)) {
      client.updateMyState(encodeCar(me, now, this.state.round));
    }

    if (client.isHost && this.botSend.due(dt * 1000)) {
      const rows: JsonRecord = {};

      for (const car of field.cars.values()) {
        if (car.bot) {
          rows[car.key] = encodeCar(car, now, this.state.round);
        }
      }

      client.updateSharedState({ bots: rows });
    }
  }

  private slotFor(key: string) {
    let slot = this.slots.get(key);

    if (slot === undefined) {
      slot = (this.slots.size % 30) + 1;
      this.slots.set(key, slot);
    }

    return slot;
  }

  private ensure(key: string, kind: RacerKind) {
    const known = this.racers.get(key);

    if (known) {
      return known;
    }

    const taken = new Set<number>();

    for (const racer of this.racers.values()) {
      taken.add(racer.ramp);
    }

    const bot = kind === "bot" ? BOTS[Number(key.slice(1))] : null;
    const style = bot?.color ?? this.client.players[key]?.color ?? LOCAL_COLOR;
    const free = taken.size >= CAR_RAMPS.length ? new Set<number>() : taken;
    const ramp = carRampFor(style, free);
    const slot = this.slotFor(key);
    this.stage.setSlotRamp(slot, ramp);

    const racer: Racer = {
      air: false,
      bumperOut: 0,
      css: rampCss(ramp, BASE + 1),
      flash: 0,
      fresh: true,
      item: "",
      key,
      kind,
      launches: 0,
      mesh: new CarMesh(ramp),
      mode: "out",
      name: bot?.name ?? (kind === "me" ? "YOU" : `P-${tagFor(key)}`),
      predicted: null,
      punchT: 9,
      punches: 0,
      ramp,
      seen: true,
      slot,
      smokeT: 0,
      steer: 0,
      track: kind === "me" ? null : new RemoteTrack(kind === "bot" ? this.botClock : undefined),
      tumble: 0,
      view: viewOf(makeCar(key, kind === "bot")),
      x: 0,
      z: 0,
    };

    this.racers.set(key, racer);

    if (kind === "me") {
      this.hud.setTint(racer.css);
    }

    return racer;
  }

  private rowOf(racer: Racer) {
    return {
      css: racer.css,
      key: racer.key,
      me: racer.kind === "me",
      name: racer.name,
      out: racer.view.mode !== "drive",
      score: this.scoreOf(racer.key),
    } satisfies HudRow;
  }

  private present(dt: number, seconds: number) {
    const { field, stage } = this;
    stage.begin(dt);
    this.lights.reset();
    this.showOwn();

    for (const [key, racer] of this.racers) {
      if (racer.seen) {
        if (!field.cars.has(key) && !racer.track) {
          racer.track = new RemoteTrack(racer.kind === "bot" ? this.botClock : undefined);
        }

        this.follow(racer, dt);
        this.drawRacer(racer, dt, seconds);
      } else {
        this.racers.delete(key);
      }
    }

    const shrink = shrinkAt(seconds * 1000);
    this.shrinkFx(shrink);
    this.board.drawEnds(stage, shrink.drop, shrink.warn && Math.floor(this.clock * 7) % 2 === 0);
    this.props.draw(stage, this.lights, seconds, this.clock, dt);
    this.pistonFx(seconds, dt);
    this.showCrate(seconds);
    this.showFlashes(dt);
    this.sparks.update(dt);
    this.sparks.draw(stage.dabs);
    this.glow.decay(dt, 7);

    if (this.frame % 2 === 0) {
      stage.uploadPaint(this.glow.owner, this.glow.strength);
    }

    stage.uploadLight();
    this.updateCamera(dt);
    this.drive();
  }

  private showOwn() {
    const mine = this.myKey();

    for (const car of this.field.cars.values()) {
      const racer = this.ensure(car.key, car.key === mine ? "me" : "bot");

      if (racer.track && car.bot) {
        racer.track = null;
      }

      racer.view = viewOf(car);
      racer.seen = true;
      const drawn = drawnOf(car);
      Object.assign(racer, {
        bumperOut: drawn.bumperOut,
        steer: drawn.steer,
        tumble: drawn.tumble,
      });
    }
  }

  private showCrate(seconds: number) {
    const { field, stage } = this;
    const crate = crateAt(this.arena, field.round, seconds);

    if (!crate || field.taken.has(crate.index) || this.state.phase !== "play") {
      return;
    }

    drawCrate(stage, this.lights, crate, seconds, this.clock);

    if (crate.index !== this.lastCrate && seconds >= crate.landAt) {
      this.lastCrate = crate.index;
      sfx.crate();
      this.sparks.ring(crate.x, crate.z, ITEM_RAMP[crate.kind], 7, 16);
      const spot = stage.project(crate.x, 3, crate.z);
      this.hud.pop(itemName(crate.kind), spot.x, spot.y, rampCss(ITEM_RAMP[crate.kind], BASE + 1));
    }
  }

  private showFlashes(dt: number) {
    for (const flash of this.flashes) {
      flash.age += dt;
      const k = 1 - flash.age / flash.life;

      if (k > 0) {
        this.lights.pool(flash.x, flash.z, flash.radius * (1.2 - k * 0.4), flash.power * k);
      }
    }

    while (this.flashes.length > 0 && (this.flashes[0]?.age ?? 0) >= (this.flashes[0]?.life ?? 0)) {
      this.flashes.shift();
    }
  }

  private follow(racer: Racer, dt: number) {
    const { view } = racer;
    const offset = racer.track ? this.predict(racer, 0) : { x: 0, z: 0 };
    racer.x = view.x + offset.x;
    racer.z = view.z + offset.z;
    racer.flash = Math.max(0, racer.flash - dt);
    const mine = racer.kind === "me";

    if (racer.fresh) {
      Object.assign(racer, {
        air: view.y > 0.15 && view.mode === "drive",
        fresh: false,
        item: view.bumper === "plain" ? view.mod : view.bumper,
        launches: view.launches,
        mode: view.mode,
        punches: view.punches,
      });
    }

    this.followBlows(racer);

    if (racer.track) {
      racer.punchT += dt;
      const reach = PUNCH_REACH * (view.bumper === "spring" ? SPRING_REACH : 1);
      const t = racer.punchT;

      racer.bumperOut =
        t < PUNCH_STRIKE + PUNCH_HOLD
          ? reach * Math.min(1, t / (PUNCH_STRIKE * 0.5))
          : reach * Math.max(0, 1 - (t - PUNCH_STRIKE - PUNCH_HOLD) / PUNCH_RETRACT);
      racer.tumble = view.y > 0.1 && view.staggered ? racer.tumble + dt * 13 : 0;
      racer.steer = 0;
    }

    if (view.mode !== racer.mode) {
      this.onMode(racer, racer.mode, view.mode);
      racer.mode = view.mode;
    }

    this.followAir(racer);
    const item = view.bumper === "plain" ? view.mod : view.bumper;

    if (item !== "" && item !== racer.item) {
      this.sparks.ring(racer.x, racer.z, ITEM_RAMP[item], 9, 18);
      this.sparks.burst(racer.x, 1.4, racer.z, ITEM_RAMP[item], 14, 8);

      if (mine) {
        sfx.pickup();
        this.hud.banner(itemName(item), "warn", 1200);
      }
    }

    racer.item = item;
  }

  private followBlows(racer: Racer) {
    const { view } = racer;

    if (view.launches > racer.launches && !this.foretold.delete(view.hitId)) {
      const speed = Math.hypot(view.vx, view.vz) || 1;
      const gain = DENT_GAIN[Math.max(0, view.dent - (view.hitHow === "punch" ? 1 : 0))] ?? 1;
      const by = view.hitId.startsWith("hz-") ? "" : (view.hitId.split(":")[0] ?? "");
      this.impact(
        racer,
        view.hitHow,
        by,
        THROWS[view.hitHow] * gain,
        view.vx / speed,
        view.vz / speed,
      );
    }

    racer.launches = view.launches;

    if (view.punches > racer.punches) {
      racer.punchT = 0;
      sfx.punch(racer.kind === "me");
      const cos = Math.cos(view.a);
      const sin = Math.sin(view.a);

      for (let i = 0; i < 5; i += 1) {
        this.sparks.puff(
          racer.x + cos * (2 + i * 0.5),
          0.7,
          racer.z + sin * (2 + i * 0.5),
          RAMP.white,
          0.3,
        );
      }
    }

    racer.punches = view.punches;
  }

  private followAir(racer: Racer) {
    const { view } = racer;
    const air = view.y > 0.15 && view.mode === "drive";

    if (racer.air && !air && view.mode === "drive") {
      racer.mesh.thump();
      sfx.land(racer.kind === "me");

      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        this.sparks.puff(
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
    const mine = racer.kind === "me";

    if (to === "fall") {
      sfx.fall(mine);

      for (let i = 0; i < 10; i += 1) {
        this.sparks.puff(
          racer.x + (Math.random() - 0.5) * 2,
          0.3,
          racer.z + (Math.random() - 0.5) * 2,
          RAMP.cream,
          0.5,
        );
      }
    } else if (to === "out" && from === "fall") {
      sfx.out();
      this.sparks.confetti(racer.x, 0.5, racer.z, [racer.ramp, RAMP.white], 22);
      this.flashes.push({ age: 0, life: 0.3, power: 0.8, radius: 6, x: racer.x, z: racer.z });
    } else if (to === "drive" && from === "drop") {
      racer.mesh.thump();
      sfx.land(mine);
      this.sparks.ring(racer.x, racer.z, RAMP.cream, 10, 22);
      this.flashes.push({ age: 0, life: 0.3, power: 0.7, radius: 6, x: racer.x, z: racer.z });
      this.shake = Math.max(this.shake, mine ? 0.5 : 0.15);
    }
  }

  private impact(racer: Racer, how: HitHow, by: string, reach: number, dx: number, dz: number) {
    const mine = this.myKey();
    const involved = racer.key === mine || by === mine;
    const power = clamp(reach / 13, 0.15, 1);
    const attacker = this.racers.get(by);
    const ramp = attacker?.ramp ?? (how === "bumper" ? RAMP.pink : RAMP.hazard);
    racer.flash = 0.2 + power * 0.12;
    racer.mesh.thump();
    this.flashes.push({
      age: 0,
      life: 0.22,
      power: 1,
      radius: 4 + power * 5,
      x: racer.x,
      z: racer.z,
    });

    if (how !== "land") {
      this.sparks.ring(
        racer.x - dx,
        racer.z - dz,
        RAMP.white,
        8 + power * 10,
        14 + Math.round(power * 14),
      );
    }

    const count = Math.round(8 + power * 22);

    for (let i = 0; i < count; i += 1) {
      const spread = (Math.random() - 0.5) * 1.5;
      const speed = (6 + Math.random() * 16) * (0.5 + power);
      const a = Math.atan2(dz, dx) + spread;
      this.sparks.emit({
        gravity: 16,
        life: 0.25 + Math.random() * 0.4,
        ramp: i % 3 === 0 ? RAMP.white : ramp,
        size: 0.18 + Math.random() * 0.22,
        vx: Math.cos(a) * speed,
        vy: 2 + Math.random() * 7,
        vz: Math.sin(a) * speed,
        x: racer.x - dx * 0.8,
        y: 0.9,
        z: racer.z - dz * 0.8,
      });
    }

    hitSound(how, power, involved);

    if (how === "bumper") {
      this.props.ring(racer.x, racer.z);
    }

    if (involved) {
      const heavy = how === "punch" || how === "sweeper" || how === "piston";
      const stop = power > 0.7 ? 0.133 : 0.083;
      this.hitstop = Math.max(this.hitstop, heavy ? stop : 0.04);
      this.shake = Math.max(this.shake, heavy ? 0.5 + power * 0.7 : 0.3);
    }

    if (by === mine && how === "punch") {
      const spot = this.stage.project(racer.x, 2.4, racer.z);
      this.hud.pop(power > 0.75 ? "SMASH!" : "POW!", spot.x, spot.y, "#fff0c8");
    }
  }

  private clashFx(x: number, z: number, involved: boolean) {
    this.sparks.ring(x, z, RAMP.hazard, 14, 24);
    this.sparks.burst(x, 1, z, RAMP.white, 18, 12);
    this.flashes.push({ age: 0, life: 0.25, power: 1, radius: 7, x, z });

    if (involved) {
      sfx.clash();
      this.hitstop = Math.max(this.hitstop, 0.07);
      this.shake = Math.max(this.shake, 0.6);
      const spot = this.stage.project(x, 2.4, z);
      this.hud.pop("CLASH!", spot.x, spot.y, "#f2c200");
    }
  }

  private shrinkFx(shrink: { warn: boolean; late: boolean }) {
    if (this.state.phase !== "play") {
      return;
    }

    if (shrink.warn && !this.warned) {
      this.warned = true;
      sfx.warn();
      this.hud.banner("ENDS DROPPING  ·  DOUBLE POINTS", "warn", 2800);
    }

    if (shrink.late && !this.dropped) {
      this.dropped = true;
      sfx.drop();
      this.shake = Math.max(this.shake, 1);
      const edge = this.arena.halfX * 0.66;

      for (let i = 0; i < 40; i += 1) {
        const side = i % 2 === 0 ? 1 : -1;
        const z = (Math.random() - 0.5) * this.arena.halfZ * 2;
        this.sparks.puff(side * edge, 0.4, z, RAMP.cream, 0.6);
      }
    }
  }

  private pistonFx(seconds: number, dt: number) {
    if (seconds < 0 || this.state.phase !== "play") {
      return;
    }

    for (const hazard of this.arena.def.hazards) {
      if (hazard.kind === "piston") {
        const before = pistonAt(hazard, seconds - dt);
        const state = pistonAt(hazard, seconds);

        if (state.firing && !before.firing) {
          sfx.piston();
          this.flashes.push({
            age: 0,
            life: 0.3,
            power: 0.9,
            radius: 8,
            x: hazard.x + Math.cos(hazard.a) * 4,
            z: hazard.z + Math.sin(hazard.a) * 4,
          });
        }
      }
    }
  }

  private drawRacer(racer: Racer, dt: number, seconds: number) {
    const { view } = racer;
    const { stage } = this;

    if (view.mode === "out") {
      return;
    }

    const cos = Math.cos(view.a);
    const sin = Math.sin(view.a);
    const { late } = shrinkAt(seconds * 1000);
    const grounded = edgeDistance(this.arena, racer.x, racer.z, late) > 0;
    const falling = view.mode === "fall";
    racer.mesh.update(
      {
        boosting: view.boosting,
        bumper: racer.bumperOut,
        bumperLook: view.bumper,
        flash: racer.flash,
        ghost: view.safe && view.mode === "drive",
        grounded,
        heading: view.a,
        pitch: falling ? racer.tumble * 0.4 : 0,
        ready: view.ready,
        roll: Math.round((racer.tumble / (Math.PI / 4)) % 8) * (Math.PI / 4),
        size: view.mod === "giant" ? GIANT_SCALE : 1,
        steer: racer.steer,
        x: racer.x,
        y: Math.max(view.y, TABLE_Y),
        z: racer.z,
      },
      dt,
    );
    racer.mesh.draw(stage);

    if (view.mode === "drop") {
      stage.draw(BEAM, {
        ramp: racer.ramp,
        sheer: true,
        x: racer.x,
        y: 0,
        yaw: 0,
        z: racer.z,
      });

      this.lights.pool(racer.x, racer.z, 3.4, 0.6);

      return;
    }

    if (view.mode !== "drive") {
      return;
    }

    if (racer.kind === "me") {
      this.drawMarker(racer, view);
    }

    this.drawTrail(racer, dt, cos, sin);
  }

  private drawTrail(racer: Racer, dt: number, cos: number, sin: number) {
    const { view } = racer;
    racer.smokeT -= dt;

    const skid = view.staggered || Math.hypot(view.vx, view.vz) > MAX_SPEED * 1.2;

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
      this.sparks.puff(racer.x - cos * 1.4, 0.6, racer.z - sin * 1.4, racer.ramp, 0.45);
    }

    if (view.dent > 0) {
      this.sparks.puff(racer.x, 1.6, racer.z, view.dent > 1 ? RAMP.black : RAMP.white, 0.4);
    }

    if (view.dent > 1 && Math.random() < 0.5) {
      this.sparks.burst(racer.x, 1.3, racer.z, RAMP.hazard, 2, 5);
    }

    if (view.mod === "turbo") {
      this.sparks.puff(racer.x - cos * 1.6, 0.8, racer.z - sin * 1.6, RAMP.yellow, 0.5);
    }
  }

  private drawMarker(racer: Racer, view: CarView) {
    const car = this.me;
    const bob = Math.floor(this.clock * 4) % 2 === 0 ? 0 : 0.25;
    this.stage.draw(ARROW, {
      aloft: true,
      ramp: racer.ramp,
      x: racer.x,
      y: (view.mod === "giant" ? 4.6 : 3.5) + bob,
      yaw: 0,
      z: racer.z,
    });
    const ready = car ? punchReady(car) : 1;
    const lit = Math.round(ready * 16);
    const radius = 2.05 * (view.mod === "giant" ? 1.3 : 1);

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

  private updateCamera(dt: number) {
    const { arena, me, stage, view } = this;

    const fit = Math.min(
      stage.columns / (arena.halfX * 2 + 3),
      stage.rows / (arena.halfZ * 2 * Math.sin(PITCH) - TABLE_Y * Math.cos(PITCH) + 2.5),
    );

    const zoom = clamp(Math.floor(fit), MIN_ZOOM, PX_PER_UNIT);
    const wide = stage.columns / zoom;
    const deep = stage.rows / zoom / Math.sin(PITCH);
    const spanX = Math.max(0, arena.halfX + 3 - wide / 2);
    const spanZ = Math.max(0, arena.halfZ + 4 - deep / 2);
    const lead = me && this.started && me.mode !== "out" ? me : null;
    const fx = clamp(lead ? lead.x : view.target.x, -spanX, spanX);
    const fz = clamp(lead ? lead.z : view.target.z, -spanZ, spanZ);
    const ease = Math.min(1, dt * 5);
    view.zoom = zoom;
    view.target.x += (fx - view.target.x) * ease;
    view.target.z += (fz - view.target.z) * ease;
    this.shake = Math.max(0, this.shake - dt * 4);
    const jolt = this.shake * this.shake * 0.5;
    view.eye
      .copy(view.target)
      .addScaledVector(VIEW_DIR, EYE_DISTANCE)
      .add({ x: (Math.random() - 0.5) * jolt, y: 0, z: (Math.random() - 0.5) * jolt });
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
    hud.setClock(clamp(left, 0, ROUND_MS), round, left < 25_500 && state.phase === "play");
    hud.setScore(this.scoreOf(mine), this.myPlace);
    hud.setBoard(rows);

    if (me) {
      hud.setDash(punchReady(me), me.meter, me.meter >= BOOST_MIN || me.boosting, heldItem(me));
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
        this.sparks.confetti(racer.x, 2, racer.z, PARTY, 18);
      }
    }

    const wait = Math.max(0, Math.ceil((state.nextAt - now) / 1000));
    hud.showResults(true, rows, won, `Next round in ${wait}`);
  }
}
