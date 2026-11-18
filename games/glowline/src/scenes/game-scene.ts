// The race: one scene for a solo run against bots and a full online grid.
//
// Who owns what:
// - Every player simulates their own kart and reports it at SEND_HZ.
// - The host runs the round clock (countdown, results, next track) and the
//   bots, all in shared state so a new host carries straight on.
// - Paint is never sent. Each client paints from the karts it sees, so the
//   road is derived from poses everyone already has.

import { notifyGameStarted } from "@repo/embed";
import { FixedRate } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import * as THREE from "three";

import { driveAudio, idleAudio, sfx } from "../audio/sfx";
import type { Input } from "../input/input";
import { BotField } from "../net/bot-field";
import { RemoteTrack, encodePose, poseOf, readPose } from "../net/pose";
import type { KartPose } from "../net/pose";
import { isJsonNumber, isJsonObject } from "../net/wire";
import { Sparks } from "../render/fx";
import type { Hud, MapDot, ResultRow } from "../render/hud";
import { setAccent } from "../render/hud";
import { KartMesh } from "../render/kart-mesh";
import { PaintLayer } from "../render/paint-layer";
import { World } from "../render/world";
import {
  BOTS,
  CHASSIS,
  COUNTDOWN_MS,
  FINISH_GRACE_MS,
  GRID_SIZE,
  KART_RADIUS,
  LAPS,
  LAUNCH_MAX,
  LAUNCH_MIN,
  LAUNCH_SECONDS,
  LOCAL_COLOR,
  MAX_SPEED,
  PAD_COOLDOWN,
  PAINT_MIN_SPEED,
  PAINT_RADIUS,
  PAINT_RADIUS_BOOST,
  PAINT_RADIUS_DRIFT,
  RESULTS_MS,
  SEND_HZ,
  SPIN_SECONDS,
  TURN_RATE,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import { CORNER_RATE, botInput, makeBrain } from "../sim/bot";
import {
  NO_INPUT,
  angleDelta,
  boostTier,
  kartLap,
  kartSpeed,
  raceLength,
  spawnKart,
  stepKart,
} from "../sim/kart";
import type { Kart, KartEvents, KartInput } from "../sim/kart";
import { PaintGrid } from "../sim/paint";
import { ordinal, rank } from "../sim/race";
import { TRACKS, curvatureAt, locate, pointAt, trackFor, wrapIndex } from "../sim/track";
import type { Track } from "../sim/track";
import { ITEM_EVENT, ItemSystem } from "./items";
import type { ItemHost } from "./items";

type RacerKind = "me" | "human" | "bot";

interface Racer {
  key: string;
  kind: RacerKind;
  name: string;
  color: THREE.Color;
  css: string;
  /** This kart's colour id in the local paint grid. */
  slot: number;
  mesh: KartMesh;
  pose: KartPose;
  /** Playback for a remote human; bots and the local kart have none. */
  track: RemoteTrack | null;
  /** Track sample hint, -1 to search the whole lap. */
  idx: number;
  lat: number;
  h: number;
  /** The gather pass that last saw it. */
  seen: number;
  lastA: number;
  lastDrift: number;
  lastSpin: number;
  steer: number;
  /** Where this kart last laid paint, so the next stamp can sweep from it. */
  brush: { x: number; z: number } | null;
}

interface RoundState {
  round: number;
  track: number;
  /** Room clock (ms) of the green light. */
  startAt: number;
  phase: "race" | "results";
  /** Room clock of the next round, during results. */
  nextAt: number;
}

export interface GameDiagnostics {
  frame: number;
  score: number;
  complete: boolean;
  player: { x: number; y: number };
  entities: number;
  phase: "title" | "countdown" | "race" | "finished" | "results";
  lap: number;
  place: number;
  /** Share of top speed, 0–1+. */
  speed: number;
  /** Signed angle (rad) from the kart's heading to the road ahead: + means steer right. */
  steerError: number;
  /** Offset from the centreline as a share of the half width: + is right, past ±1 is off the road. */
  lane: number;
  surface: string;
  drifting: boolean;
  /** Boost tier the current drift has earned, 0–3. */
  driftTier: number;
  boosting: boolean;
  /** Sharpest bend in the next stretch, signed: + turns right. */
  bendAhead: number;
  /** Carrying more speed than the bend ahead will take: brake. */
  tooFast: boolean;
  wrongWay: boolean;
  /** The item in hand ("" for none) and the glow orbs carried. */
  item: string;
  orbs: number;
}

/** Intent to the host: a driver just left the title; restart if nobody is racing. */
const FRESH_START = "fresh-start";

/** The camera's near plane everywhere but the overview. */
const NEAR = 0.8;

/** Cup points by finishing place. */
const CUP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1] as const;

/** Speedometer scale: world units per second to the km/h on the dial. */
const KMH = 4.6;

/** Highest paint slot the paint texture's palette holds. */
const MAX_SLOT = 31;

const TIER_COLORS = [
  new THREE.Color("#cfefff"),
  new THREE.Color("#7df9ff"),
  new THREE.Color("#ffd23f"),
  new THREE.Color("#ff3d81"),
] as const;
const WHITE = new THREE.Color("#ffffff");
const LOOK = new THREE.Vector3();
const HAZE = new THREE.Color();
const GOAL = new THREE.Vector3();

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Any colour pushed to full neon, so every kart's paint reads against the dark. */
const neon = (style: string): THREE.Color => {
  const color = new THREE.Color(style);
  const hsl = { h: 0, l: 0, s: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, 1, 0.56);
};

/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- FNV-1a is defined over
   UTF-16 code units and 32-bit wraparound; every peer must derive the same tag. */
const tagFor = (id: string): string => {
  let h = 2_166_136_261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return ((h >>> 0) % 1296).toString(36).toUpperCase().padStart(2, "0");
};
/* oxlint-enable no-bitwise, unicorn/prefer-code-point */

/** The kart's race number, as painted on its nose. */
const plateFor = (key: string, kind: RacerKind): string => {
  if (kind === "me") {
    return "1";
  }
  if (kind === "bot") {
    return String(Number(key.slice(1)) + 2);
  }
  return String(10 + (Number.parseInt(tagFor(key), 36) % 89));
};

const readRound = (shared: JsonRecord): RoundState | null => {
  const { nextAt, phase, round, startAt, track } = shared;
  if (!isJsonNumber(round) || !isJsonNumber(track) || !isJsonNumber(startAt)) {
    return null;
  }
  return {
    nextAt: isJsonNumber(nextAt) ? nextAt : 0,
    phase: phase === "results" ? "results" : "race",
    round,
    startAt,
    track,
  };
};

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, NEAR, 2600);

  private readonly paint = new PaintGrid();
  private readonly layer = new PaintLayer();
  private readonly sparks = new Sparks(this.scene);
  private readonly bots = new BotField();
  private readonly racers = new Map<string, Racer>();
  private readonly slots = new Map<string, number>();
  private readonly sendClock = new FixedRate(SEND_HZ);
  private readonly autopilot = makeBrain(3);

  private track: Track = trackFor(0);
  private trackIndex = 0;
  private world: World;
  private state: RoundState = { nextAt: 0, phase: "race", round: 0, startAt: 0, track: 0 };
  private me: Kart = spawnKart(this.track, 0);
  private started = false;
  private paused = false;
  private pausedAt = 0;
  private time = 0;
  private pass = 0;
  private frame = 0;
  private botCount = 0;
  private wasHost = false;
  private lastHostId: string | null = null;
  private lastStatus = "";
  private padReadyAt: number[] = [];

  private camHeading = 0;
  private camReady = false;
  private shake = 0;
  private fov = 62;

  private lastCount = 0;
  private lastLap = 0;
  private wrongWayFor = 0;
  private lastTier = 0;
  private myPlace = 1;

  private readonly client: MultiplayerClient;
  private readonly input: Input;
  private readonly hud: Hud;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly shadows: number;
  /** A fixed camera for captures: the whole circuit from above, or the grid under the lights. */
  private shot: "overview" | "grid" | null = null;
  private readonly items: ItemSystem;
  /** Frames between paint texture uploads: every other frame, every third without shadows (phones). */
  private readonly uploadEvery: number;
  /** The chassis picked on the title screen, and the kart shown there. */
  private chassis = 0;
  private preview: KartMesh | null = null;
  private previewStyle = "";
  /** Scene clock when the gas went down under the lights; 0 while it is up. */
  private gasAt = 0;
  private launched = false;

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
    this.renderer = renderer;
    this.shadows = shadows;
    this.uploadEvery = shadows > 0 ? 2 : 3;
    this.scene.fog = new THREE.Fog(this.track.def.palette.horizon, 260, 1500);
    this.world = this.buildWorld();
    this.hud.setTrack(this.track);
    this.layer.setColor(1, neon(LOCAL_COLOR));
    this.items = new ItemSystem(this.itemHost(), this.track);
  }

  /** Title screen: pick a chassis. */
  setChassis(index: number): void {
    if (!this.started) {
      this.chassis = clamp(Math.round(index), 0, CHASSIS.length - 1);
      this.previewStyle = "";
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** The RACE button, a key, or a pad: put this player on the grid. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.hud.showTitle(false);
    this.hud.showHud(true);
    this.input.setTouchVisible(true);
    notifyGameStarted();
    this.dropPreview();
    this.me = spawnKart(this.track, this.mySlot(), this.chassis);
    this.camReady = false;
    // Nobody else is mid-race: ask for a fresh green light instead of joining
    // a race the bots are already halfway through.
    this.client.sendToHost(FRESH_START, null);
  }

  /** Room events. The host's own intents loop back here too. */
  onRoomEvent(event: string, payload: JsonValue, from: string): void {
    if (event === ITEM_EVENT) {
      if (from !== this.client.playerId) {
        this.items.onEvent(payload, from);
      }
      return;
    }
    if (event !== FRESH_START || !this.client.isHost) {
      return;
    }
    // Restart only when the asker is the first driver out of the title. Anyone
    // already on the grid, even under the lights, keeps their countdown.
    const asker = from === this.client.playerId ? "me" : from;
    const others = [...this.racers.values()].some(
      (racer) => racer.kind !== "bot" && racer.key !== asker,
    );
    if (!others) {
      this.newRound(this.state.round + 1, this.trackIndex);
    }
  }

  /** Offline a pause freezes the race; online the room runs on and the kart coasts. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) {
      return;
    }
    this.paused = paused;
    const solo = this.client.connectionStatus === "offline";
    if (paused) {
      this.pausedAt = this.client.serverNow();
      idleAudio();
    } else if (solo) {
      // The clock ran while the world stood still: hand the time back.
      const held = this.client.serverNow() - this.pausedAt;
      this.client.updateSharedState({
        nextAt: this.state.nextAt > 0 ? this.state.nextAt + held : 0,
        startAt: this.state.startAt + held,
      });
      if (this.me.finishMs > 0) {
        this.me.finishMs += held;
      }
    }
  }

  /** Playtest hook: restart the race on the current circuit. */
  restart(): void {
    if (this.client.isHost) {
      this.newRound(this.state.round + 1, this.trackIndex);
    }
  }

  /** Playtest hook: `active-play` is straight onto the grid with the lights already green. */
  setTestState(name: string): boolean {
    if (name === "garage") {
      return !this.started;
    }
    if (name === "overview" || name === "grid") {
      this.start();
      this.shot = name;
      return true;
    }
    if (name !== "active-play") {
      return false;
    }
    this.shot = null;
    this.start();
    if (this.client.isHost) {
      this.client.updateSharedState({ startAt: Math.round(this.client.serverNow()) });
    }
    return true;
  }

  update(dt: number): void {
    const solo = this.client.connectionStatus === "offline";
    if (this.paused && solo) {
      return;
    }
    this.time += dt;
    this.frame += 1;
    this.input.update();
    if (!this.started && this.input.anyStart()) {
      this.start();
    }
    const now = this.client.serverNow();
    this.syncRoom(now);
    if (this.client.isHost) {
      this.hostTick(dt, now);
    }
    this.stepMe(dt, now);
    this.publish(dt, now);
    this.gather(dt, now);
    this.stepItems(now);
    this.paint.decay(dt);
    if (this.frame % this.uploadEvery === 0) {
      this.layer.upload(this.paint);
    }
    this.sparks.update(dt);
    this.updateCamera(dt);
    this.world.update(
      this.time,
      this.padReadyAt.map((at) => this.time >= at),
      LOOK,
    );
    this.startLights(now);
    this.updateHud(now);
  }

  writeDiagnostics(out: GameDiagnostics): void {
    const { me, track } = this;
    const speed = kartSpeed(me);
    const ahead = pointAt(track, me.idx + 8 + speed * 0.4, 0);
    const racing = this.state.phase === "race" && this.client.serverNow() >= this.state.startAt;
    let bend = 0;
    // The same window the bots brake for: further ahead the faster the kart.
    for (let d = 4; d <= 8 + speed * 0.9; d += 3) {
      const c = curvatureAt(track, me.idx + d);
      if (Math.abs(c) > Math.abs(bend)) {
        bend = c;
      }
    }
    out.frame = this.frame;
    out.score = Math.max(0, Math.round(me.prog));
    out.complete = me.finishMs > 0;
    out.player.x = me.x;
    out.player.y = me.z;
    out.entities = this.racers.size;
    out.phase = this.phaseName(racing);
    out.lap = kartLap(me, track);
    out.place = this.myPlace;
    out.speed = speed / MAX_SPEED;
    out.steerError = angleDelta(Math.atan2(ahead.z - me.z, ahead.x - me.x), me.a);
    out.lane = me.lat / track.halfWidth;
    out.surface = me.surface;
    out.drifting = me.drift !== 0;
    out.driftTier = boostTier(me.charge);
    out.boosting = me.boost > 0;
    out.bendAhead = bend;
    out.tooFast = Math.abs(bend) > 1e-4 && speed > (CORNER_RATE / Math.abs(bend)) * 1.12;
    out.wrongWay = this.wrongWayFor > 0.8;
    out.item = this.items.heldBy("me") ?? "";
    out.orbs = me.orbs;
  }

  private phaseName(racing: boolean): GameDiagnostics["phase"] {
    if (!this.started) {
      return "title";
    }
    if (this.state.phase === "results") {
      return "results";
    }
    if (this.me.finishMs > 0) {
      return "finished";
    }
    return racing ? "race" : "countdown";
  }

  // --- room -----------------------------------------------------------------

  private buildWorld(): World {
    const world = new World(this.track, this.layer, { shadows: this.shadows });
    this.scene.add(world.group);
    if (this.scene.fog instanceof THREE.Fog) {
      // Haze the colour of the low sky, so the far district melts into it.
      this.scene.fog.color
        .set(this.track.def.palette.mid)
        .lerp(HAZE.set(this.track.def.palette.horizon), 0.6);
    }
    this.scene.environment?.dispose();
    this.scene.environment = world.environment(this.renderer);
    this.scene.environmentIntensity = 0.8;
    return world;
  }

  private mySlot(): number {
    const ids = Object.keys(this.client.players).toSorted();
    const index = Math.max(0, ids.indexOf(this.client.playerId ?? ""));
    // Rotate the grid each round so the same id is not always on pole.
    return (index + this.state.round) % Math.max(1, ids.length);
  }

  /** Host: open round `round` on circuit `track` with a fresh countdown. */
  private newRound(round: number, track: number): void {
    const index = wrapIndex(track, TRACKS.length);
    this.bots.reset(trackFor(index), Math.max(1, Object.keys(this.client.players).length));
    const next: JsonRecord = {
      bots: {},
      nextAt: 0,
      phase: "race",
      round,
      startAt: Math.round(this.client.serverNow() + COUNTDOWN_MS),
      track: index,
    };
    if (index === 0) {
      // The first circuit opens a new cup: everyone back to nought.
      next["points"] = {};
    }
    this.client.updateSharedState(next);
    this.syncRoom(this.client.serverNow());
  }

  /** Follow shared state: adopt a new round, and react to host and link changes. */
  private syncRoom(now: number): void {
    const { client } = this;
    const next = readRound(client.sharedState);
    if (!next) {
      if (client.isHost) {
        this.newRound(1, 0);
      }
      return;
    }
    if (next.round !== this.state.round) {
      this.applyRound(next);
    }
    this.state = next;

    if (client.isHost && !this.wasHost && now > 0) {
      this.bots.adopt(
        this.track,
        client.sharedState["bots"],
        Math.max(1, Object.keys(client.players).length),
      );
    }
    this.wasHost = client.isHost;
    const status = client.connectionStatus;
    const reconnected = this.lastStatus === "reconnecting" && status === "connected";
    if (client.hostId !== this.lastHostId || reconnected) {
      this.bots.relearn();
    }
    if (reconnected) {
      for (const racer of this.racers.values()) {
        racer.track?.relearn();
      }
    }
    this.lastHostId = client.hostId;
    this.lastStatus = status;
  }

  private applyRound(next: RoundState): void {
    this.state = next;
    if (next.track !== this.trackIndex) {
      this.trackIndex = next.track;
      this.track = trackFor(next.track);
      this.world.dispose();
      this.world = this.buildWorld();
      this.hud.setTrack(this.track);
    }
    this.paint.clear();
    this.items.reset(this.track);
    this.gasAt = 0;
    this.launched = false;
    this.previewStyle = "";
    this.me = spawnKart(this.track, this.mySlot(), this.chassis);
    this.padReadyAt = this.track.pads.map(() => 0);
    this.lastCount = 0;
    this.lastLap = 0;
    this.wrongWayFor = 0;
    this.camReady = false;
    for (const racer of this.racers.values()) {
      racer.idx = -1;
    }
  }

  /** Host: bots, and the round's end. */
  private hostTick(dt: number, now: number): void {
    const { state, track } = this;
    const racing = state.phase === "race" && now >= state.startAt;
    const everyone = [...this.racers.values()];
    const humans = everyone.filter((racer) => racer.kind !== "bot");
    const leaderProg = humans.length > 0 ? Math.max(...humans.map((r) => r.pose.prog)) : null;
    this.bots.step({
      count: this.botCount,
      dt,
      leaderProg,
      now,
      others: new Map(everyone.map((racer) => [racer.key, racer.pose])),
      ownerAt: (x, z) => this.paint.ownerAt(x, z),
      racing,
      slotOf: (key) => this.slotFor(key),
      time: this.time,
      track,
    });
    if (this.bots.due(dt * 1000)) {
      this.client.updateSharedState({
        bots: this.bots.rows(this.botCount, now, state.round, (key) => this.holds(key)),
      });
    }
    if (state.phase === "results") {
      if (now >= state.nextAt) {
        this.newRound(state.round + 1, state.track + 1);
      }
      return;
    }
    // Nobody has left the title yet: hold the grid under the lights for them.
    if (humans.length === 0 && state.startAt - now < COUNTDOWN_MS - 1000) {
      this.client.updateSharedState({ startAt: Math.round(now + COUNTDOWN_MS) });
    }
    if (!racing || everyone.length === 0) {
      return;
    }
    // With humans on the grid the race is theirs to finish; a bots-only race
    // (everyone still on the title) ends when the bots do.
    const deciders = humans.length > 0 ? humans : everyone;
    const finished = everyone.filter((racer) => racer.pose.finishMs > 0);
    const first = finished.length > 0 ? Math.min(...finished.map((r) => r.pose.finishMs)) : 0;
    const allIn = deciders.every((racer) => racer.pose.finishMs > 0);
    if (allIn || (first > 0 && now > first + FINISH_GRACE_MS)) {
      this.client.updateSharedState({
        nextAt: Math.round(now + RESULTS_MS),
        phase: "results",
        points: this.scoreCup(),
      });
    }
  }

  /** The room-wide id a racer's cup points are kept under. */
  private cupKey(racer: Racer): string {
    return racer.kind === "me" ? (this.client.playerId ?? "me") : racer.key;
  }

  /** Host: the cup table after this race, as a fresh object for shared state. */
  private scoreCup(): JsonRecord {
    const table: JsonRecord = {};
    const before = this.client.sharedState["points"];
    if (isJsonObject(before)) {
      for (const [key, value] of Object.entries(before)) {
        if (isJsonNumber(value)) {
          table[key] = value;
        }
      }
    }
    for (const [i, racer] of this.standings().entries()) {
      const key = this.cupKey(racer);
      const had = table[key];
      table[key] = (isJsonNumber(had) ? had : 0) + (CUP_POINTS[i] ?? 0);
    }
    return table;
  }

  // --- the local kart -----------------------------------------------------------

  private stepMe(dt: number, now: number): void {
    if (!this.started) {
      return;
    }
    const { me, state, track } = this;
    const green = now >= state.startAt;
    if (state.phase === "race" && !green) {
      // On the grid under the lights: note when the gas goes down.
      const gas = !this.paused && this.input.launchHeld();
      if (!gas) {
        this.gasAt = 0;
      } else if (this.gasAt === 0) {
        this.gasAt = this.time;
      }
      return;
    }
    this.launch();
    const done = me.finishMs > 0 || state.phase === "results";
    let input: KartInput = NO_INPUT;
    if (done) {
      // A victory lap on autopilot, so the kart never parks on the racing line.
      input = botInput(me, track, this.autopilot, this.time, 0.55);
    } else if (!this.paused) {
      input = this.input.read();
    }
    const events = stepKart(me, input, track, dt, this.paint.ownerAt(me.x, me.z), 1);
    this.collide(me);
    this.react(events);
    this.raceCallouts(done, now, dt);
    const tier = boostTier(me.charge);
    if (tier > this.lastTier) {
      sfx.tier(tier);
    }
    this.lastTier = tier;
    driveAudio(kartSpeed(me) / MAX_SPEED, me.drift === 0 ? 0 : 0.25 + tier * 0.25, me.boost > 0);
  }

  /** The finish, each new lap, and driving the wrong way round. */
  private raceCallouts(done: boolean, now: number, dt: number): void {
    const { me, track } = this;
    if (!done && me.prog >= raceLength(track)) {
      me.finishMs = Math.round(now);
      sfx.finish();
      this.hud.callout(ordinal(this.myPlace), 2600, "go", "FINISHED");
    }
    const lap = Math.floor(me.prog / track.n);
    if (lap > this.lastLap && lap < LAPS && !done) {
      this.lastLap = lap;
      sfx.lap();
      this.hud.callout(lap === LAPS - 1 ? "FINAL LAP" : `LAP ${lap + 1}`, 1400);
    }
    const along =
      Math.cos(me.a) * (track.tx[me.idx] ?? 1) + Math.sin(me.a) * (track.tz[me.idx] ?? 0);
    this.wrongWayFor = along < -0.3 && kartSpeed(me) > 4 && !done ? this.wrongWayFor + dt : 0;
  }

  /** Push the local kart out of anyone it overlaps and bounce it off them. */
  private collide(me: Kart): void {
    for (const racer of this.racers.values()) {
      if (racer.kind !== "me") {
        const dx = me.x - racer.pose.x;
        const dz = me.z - racer.pose.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.01 && d < KART_RADIUS * 2) {
          const nx = dx / d;
          const nz = dz / d;
          me.x += nx * (KART_RADIUS * 2 - d);
          me.z += nz * (KART_RADIUS * 2 - d);
          const closing = me.vx * nx + me.vz * nz;
          if (closing < 0) {
            me.vx -= nx * closing * 1.4;
            me.vz -= nz * closing * 1.4;
            if (closing < -3) {
              this.shake = Math.min(1, this.shake + 0.35);
              sfx.bump();
              this.sparks.burst(me.x - nx, me.h + 0.6, me.z - nz, WHITE, 8, 7);
            }
          }
        }
      }
    }
  }

  private react(events: KartEvents): void {
    const { me } = this;
    if (events.boosted > 0) {
      sfx.boost(events.boosted);
      this.shake = Math.min(1, this.shake + 0.12 * events.boosted);
      this.sparks.burst(
        me.x - Math.cos(me.a) * 1.4,
        me.h + 0.5,
        me.z - Math.sin(me.a) * 1.4,
        TIER_COLORS[events.boosted] ?? WHITE,
        10 + events.boosted * 6,
        9,
      );
    }
    if (events.railHit > 3) {
      this.shake = Math.min(1, this.shake + events.railHit * 0.03);
      sfx.bump();
      this.sparks.burst(me.x, me.h + 0.5, me.z, WHITE, 6, 6);
    }
  }

  /** Off the line: gas pressed in the last beat before the green is a rocket start. */
  private launch(): void {
    if (this.launched) {
      return;
    }
    this.launched = true;
    const held = this.gasAt > 0 ? this.time - this.gasAt : 0;
    if (held >= LAUNCH_MIN && held <= LAUNCH_MAX && this.me.finishMs === 0) {
      this.me.boost = LAUNCH_SECONDS;
      sfx.boost(2);
      this.hud.callout("ROCKET START", 1100);
    }
  }

  /** Orbs, boxes and items for every kart on the road. */
  private stepItems(now: number): void {
    const racing = this.state.phase === "race" && now >= this.state.startAt;
    if (this.started && !this.paused && this.input.itemPressed()) {
      this.items.use("me");
    }
    const karts = [...this.racers.values()].map((racer) => ({
      holding: racer.pose.holding,
      key: racer.key,
      x: racer.pose.x,
      z: racer.pose.z,
    }));
    this.items.update(this.time, karts, racing);
  }

  /** Is this racer holding an item? Known first-hand for the karts simulated here. */
  private holds(key: string): boolean {
    return this.items.heldBy(key) !== null;
  }

  private itemHost(): ItemHost {
    return {
      client: this.client,
      colorOf: (key) => this.racers.get(key)?.color ?? WHITE,
      kartOf: (key) => {
        if (key === "me") {
          return this.started ? this.me : null;
        }
        return this.client.isHost ? this.bots.kart(key) : null;
      },
      notify: (what, kind) => this.notify(what, kind),
      paint: this.paint,
      scene: this.scene,
      shareOf: (key) => {
        const order = this.standings();
        const index = order.findIndex((racer) => racer.key === key);
        return order.length > 1 ? Math.max(0, index) / (order.length - 1) : 0;
      },
      slotOf: (key) => (key === "me" ? 1 : this.slotFor(key)),
      sparks: this.sparks,
    };
  }

  /** Something happened to the local kart: say so. */
  private notify(what: "orb" | "box" | "spin" | "used", kind?: ItemKind): void {
    if (what === "orb") {
      sfx.orb();
    } else if (what === "box") {
      sfx.box();
    } else if (what === "spin") {
      sfx.spin();
      this.shake = 1;
      this.hud.callout("SPUN OUT", 900, "warn");
    } else if (kind) {
      sfx.use(kind);
      this.shake = Math.min(1, this.shake + 0.2);
    }
  }

  /** The title screen's kart: this player's colour and chassis, parked on their grid slot. */
  private showPreview(dt: number): void {
    const style = this.client.players[this.client.playerId ?? ""]?.color ?? LOCAL_COLOR;
    const want = `${style}:${this.chassis}`;
    if (want !== this.previewStyle) {
      this.dropPreview();
      this.previewStyle = want;
      const color = neon(style);
      this.preview = new KartMesh(color, "1", this.chassis);
      this.scene.add(this.preview.group);
      setAccent(`#${color.getHexString()}`);
    }
    const slot = spawnKart(this.track, this.mySlot(), this.chassis);
    this.preview?.update(
      {
        boosting: false,
        drift: 0,
        heading: slot.a,
        speed: 0,
        spin: 0,
        steer: Math.sin(this.time * 0.8) * 0.5,
        x: slot.x,
        y: 0,
        z: slot.z,
      },
      dt,
    );
    // A slow orbit, close enough that the kart fills the frame.
    const angle = slot.a + 0.62 + Math.sin(this.time * 0.25) * 0.4;
    this.camera.fov = 40;
    this.camera.position.set(slot.x + Math.cos(angle) * 6.4, 2.1, slot.z + Math.sin(angle) * 6.4);
    LOOK.set(slot.x, 0.75, slot.z);
    this.camera.lookAt(LOOK);
    this.camera.updateProjectionMatrix();
  }

  private dropPreview(): void {
    if (this.preview) {
      this.preview.group.removeFromParent();
      this.preview.dispose();
      this.preview = null;
    }
  }

  private publish(dt: number, now: number): void {
    if (this.started && this.sendClock.due(dt * 1000)) {
      this.client.updateMyState(encodePose(this.me, now, this.state.round, this.holds("me")));
    }
  }

  // --- everyone on the road ---------------------------------------------------------

  private slotFor(key: string): number {
    const known = this.slots.get(key);
    if (known !== undefined) {
      return known;
    }
    // Slot 1 is the local kart; the rest take the lowest id no kart on the road
    // holds, and give it back when they leave (see gather).
    const held = new Set(this.slots.values());
    let slot = 2;
    while (held.has(slot) && slot < MAX_SLOT) {
      slot += 1;
    }
    this.slots.set(key, slot);
    return slot;
  }

  private ensure(key: string, kind: RacerKind, chassis: number): Racer {
    const existing = this.racers.get(key);
    if (existing) {
      existing.seen = this.pass;
      return existing;
    }
    let style: string = LOCAL_COLOR;
    let name = "You";
    if (kind === "bot") {
      const bot = BOTS[Number(key.slice(1))] ?? BOTS[0];
      style = bot.color;
      ({ name } = bot);
    } else {
      style = this.client.players[key]?.color ?? LOCAL_COLOR;
      name = kind === "me" ? "You" : `Racer ${tagFor(key)}`;
    }
    const color = neon(style);
    const slot = kind === "me" ? 1 : this.slotFor(key);
    this.layer.setColor(slot, color);
    const mesh = new KartMesh(color, plateFor(key, kind), chassis);
    this.scene.add(mesh.group);
    const racer: Racer = {
      brush: null,
      color,
      css: `#${color.getHexString()}`,
      h: 0,
      idx: -1,
      key,
      kind,
      lastA: 0,
      lastDrift: 0,
      lastSpin: 0,
      lat: 0,
      mesh,
      name,
      pose: poseOf(this.me),
      seen: this.pass,
      slot,
      steer: 0,
      track: kind === "human" ? new RemoteTrack() : null,
    };
    if (kind === "me") {
      setAccent(racer.css);
    }
    this.racers.set(key, racer);
    return racer;
  }

  /** Collect every kart on the road this frame, then draw and paint from each. */
  private gather(dt: number, now: number): void {
    const { client, state } = this;
    this.pass += 1;
    let humans = 0;
    if (this.started) {
      this.ensure("me", "me", this.chassis).pose = poseOf(this.me, this.holds("me"));
      humans += 1;
    }
    for (const player of Object.values(client.players)) {
      const report = player.id === client.playerId ? null : readPose(player.state);
      if (report && report.round === state.round) {
        const racer = this.ensure(player.id, "human", report.chassis);
        racer.track?.push(report);
        racer.pose = racer.track?.sample() ?? racer.pose;
        humans += 1;
      }
    }
    this.botCount = clamp(GRID_SIZE - humans, 0, BOTS.length);
    const rows = client.sharedState["bots"];
    for (const [key, pose] of this.bots.poses(
      client.isHost,
      rows,
      this.botCount,
      state.round,
      (bot) => this.holds(bot),
    )) {
      if (Number(key.slice(1)) < this.botCount) {
        this.ensure(key, "bot", pose.chassis).pose = pose;
      }
    }
    const racing = state.phase === "race" && now >= state.startAt;
    for (const [key, racer] of this.racers) {
      if (racer.seen === this.pass) {
        this.place(racer, dt, racing);
      } else {
        racer.mesh.group.removeFromParent();
        racer.mesh.dispose();
        this.racers.delete(key);
        this.slots.delete(key);
      }
    }
  }

  /** Put one kart on the road: mesh, paint, pads, sparks. */
  private place(racer: Racer, dt: number, racing: boolean): void {
    const { track } = this;
    const { pose } = racer;
    const where = locate(track, pose.x, pose.z, racer.idx);
    racer.idx = where.i;
    racer.lat = where.lat;
    racer.h = where.h;
    const turning = dt > 0 ? angleDelta(pose.a, racer.lastA) / dt / TURN_RATE : 0;
    const steer = racer.kind === "me" ? this.me.steer : clamp(turning * 1.4, -1, 1);
    racer.steer += (steer - racer.steer) * Math.min(1, dt * 12);
    racer.lastA = pose.a;
    if (pose.drift !== 0 && racer.lastDrift === 0) {
      racer.mesh.kick();
    }
    racer.lastDrift = pose.drift;
    if (pose.spin > 0 && racer.lastSpin <= 0) {
      racer.mesh.thump();
      this.sparks.burst(pose.x, 0.8, pose.z, WHITE, 16, 9);
    }
    racer.lastSpin = pose.spin;
    racer.mesh.update(
      {
        boosting: pose.boosting,
        drift: pose.drift,
        heading: pose.a,
        speed: pose.speed,
        spin: pose.spin > 0 ? 1 - pose.spin / SPIN_SECONDS : 0,
        steer: racer.steer,
        x: pose.x,
        y: where.h,
        z: pose.z,
      },
      dt,
    );
    const fx = Math.cos(pose.a);
    const fz = Math.sin(pose.a);
    // A rival right on top of the camera would fill the frame with its insides.
    racer.mesh.group.visible =
      racer.kind === "me" || this.camera.position.distanceToSquared(racer.mesh.group.position) > 22;
    if (!racing) {
      if (this.state.phase === "race") {
        // Under the lights every grid box is painted in its driver's colour.
        this.paint.stamp(pose.x + fx * 1.2, pose.z + fz * 1.2, 1.5, racer.slot);
      }
      racer.brush = null;
      return;
    }
    if (pose.speed > PAINT_MIN_SPEED && Math.abs(where.lat) <= track.halfWidth) {
      let radius = PAINT_RADIUS;
      if (pose.drift !== 0) {
        radius = PAINT_RADIUS_DRIFT;
      } else if (pose.boosting) {
        radius = PAINT_RADIUS_BOOST;
      }
      // Laid a full radius behind the kart: nobody rides the stripe they are laying.
      const back = radius + 1.6;
      const bx = pose.x - fx * back;
      const bz = pose.z - fz * back;
      // Sweep from the last stamp to this one, so a stroke is unbroken however
      // far the kart moved in a frame.
      const from = racer.brush ?? { x: bx, z: bz };
      const span = Math.hypot(bx - from.x, bz - from.z);
      const steps = span > 12 ? 1 : Math.max(1, Math.ceil(span / 0.45));
      for (let i = 1; i <= steps; i += 1) {
        const k = i / steps;
        this.paint.stamp(
          from.x + (bx - from.x) * k,
          from.z + (bz - from.z) * k,
          radius,
          racer.slot,
        );
      }
      racer.brush = { x: bx, z: bz };
    } else {
      racer.brush = null;
    }
    this.checkPads(racer);
    this.trail(racer, fx, fz);
  }

  /** A kart crossing an armed splat pad floods the road ahead in its colour. */
  private checkPads(racer: Racer): void {
    const { track } = this;
    for (const [i, pad] of track.pads.entries()) {
      const gap = wrapIndex(racer.idx - pad + track.n / 2, track.n) - track.n / 2;
      const armed = this.time >= (this.padReadyAt[i] ?? 0);
      if (armed && Math.abs(gap) <= 1.5 && Math.abs(racer.lat) < track.halfWidth * 0.75) {
        this.padReadyAt[i] = this.time + PAD_COOLDOWN;
        // Three fat stripes across the road, not a sheet: the road stays road.
        for (let k = 0; k < 3; k += 1) {
          for (const lane of [-0.66, -0.33, 0, 0.33, 0.66]) {
            const at = pointAt(track, pad + 4 + k * 4.5, lane * track.halfWidth);
            this.paint.stamp(at.x, at.z, 1.5, racer.slot);
          }
        }
        const centre = pointAt(track, pad + 6, 0);
        this.sparks.burst(centre.x, centre.h + 0.4, centre.z, racer.color, 40, 13);
        if (racer.kind === "me") {
          sfx.splat();
          this.shake = Math.min(1, this.shake + 0.25);
          this.hud.callout("SPLAT", 700);
        }
      }
    }
  }

  private trail(racer: Racer, fx: number, fz: number): void {
    const { pose } = racer;
    if (pose.drift !== 0) {
      const color = TIER_COLORS[boostTier(pose.charge)] ?? WHITE;
      const side = pose.drift;
      this.sparks.emit({
        color,
        gravity: 9,
        life: 0.22 + Math.random() * 0.2,
        size: 0.1 + Math.random() * 0.12,
        vx: -fx * 3 + fz * side * (2 + Math.random() * 4),
        vy: 1.5 + Math.random() * 3,
        vz: -fz * 3 - fx * side * (2 + Math.random() * 4),
        x: pose.x - fx * 1 + fz * side * 0.8,
        y: racer.h + 0.25,
        z: pose.z - fz * 1 - fx * side * 0.8,
      });
    }
    if (pose.boosting) {
      this.sparks.emit({
        color: racer.color,
        life: 0.25 + Math.random() * 0.15,
        size: 0.22 + Math.random() * 0.2,
        vx: -fx * (6 + Math.random() * 6) + (Math.random() - 0.5) * 2,
        vy: Math.random() * 1.5,
        vz: -fz * (6 + Math.random() * 6) + (Math.random() - 0.5) * 2,
        x: pose.x - fx * 1.5,
        y: racer.h + 0.5,
        z: pose.z - fz * 1.5,
      });
    }
  }

  // --- camera + HUD -----------------------------------------------------------------

  private standings(): Racer[] {
    return rank(
      [...this.racers.values()].map((racer) => ({
        finishMs: racer.pose.finishMs,
        key: racer.key,
        prog: racer.pose.prog,
        racer,
      })),
    ).map((entry) => entry.racer);
  }

  /** Five reds come on through the countdown, then green for a moment. */
  private startLights(now: number): void {
    const left = this.state.startAt - now;
    // One more red every 600 ms through the last three seconds: all five by the green.
    const lit = left > 3000 ? 0 : Math.min(5, 1 + Math.floor((3000 - left) / 600));
    const go = left <= 0 && left > -2500;
    this.world.setStartLights(left < -2500 || this.state.phase === "results" ? 0 : lit, go);
  }

  /** Capture cameras: fixed framings the critic loop matches to its reference shots. */
  private shotCamera(): boolean {
    if (this.shot === "overview") {
      this.camera.fov = 38;
      // Nothing is nearer than the rooftops from up here: spend the depth range on the ground.
      this.camera.near = 60;
      this.camera.position.set(-40, 235, 250);
      LOOK.set(0, 0, 8);
      this.world.setShadowReach(330);
    } else if (this.shot === "grid") {
      const line = pointAt(this.track, -16, 0);
      const fx = Math.cos(line.a);
      const fz = Math.sin(line.a);
      this.camera.near = NEAR;
      this.camera.fov = 58;
      this.camera.position.set(line.x - fx * 15 + fz * 1.5, 3.6, line.z - fz * 15 - fx * 1.5);
      LOOK.set(line.x + fx * 30, 2.6, line.z + fz * 30);
      // Hold the lights on three reds for as long as the capture takes.
      if (this.client.isHost) {
        this.client.updateSharedState({ startAt: Math.round(this.client.serverNow() + 1500) });
      }
    } else {
      return false;
    }
    this.camera.lookAt(LOOK);
    this.camera.updateProjectionMatrix();
    return true;
  }

  private updateCamera(dt: number): void {
    if (this.shotCamera()) {
      return;
    }
    // A capture framing may have pushed the near plane out; every other camera wants it close.
    this.camera.near = NEAR;
    if (!this.started) {
      this.showPreview(dt);
      return;
    }
    const order = this.standings();
    const subject = this.racers.get("me") ?? order[0];
    if (!subject) {
      // Empty road (a guest still waiting on the host's rows): look down the start straight.
      const at = pointAt(this.track, 0, 0);
      this.camera.position.set(at.x - Math.cos(at.a) * 30, at.h + 16, at.z - Math.sin(at.a) * 30);
      this.camera.lookAt(at.x, at.h, at.z);
      return;
    }
    const { pose } = subject;
    const mine = subject.kind === "me";
    // Follow where the kart is going, not where it points: a drift shows as a slide.
    const moving = mine && pose.speed > 6 ? Math.atan2(this.me.vz, this.me.vx) : pose.a;
    const blend = mine ? moving + angleDelta(pose.a, moving) * 0.35 : pose.a;
    if (!this.camReady) {
      this.camHeading = blend;
    }
    this.camHeading += angleDelta(blend, this.camHeading) * Math.min(1, dt * 5.5);
    const share = clamp(pose.speed / MAX_SPEED, 0, 1.4);
    const distance = mine ? 7.6 + share * 2.2 : 13;
    const height = mine ? 3.5 + share * 0.5 : 6.5;
    const cx = Math.cos(this.camHeading);
    const cz = Math.sin(this.camHeading);
    GOAL.set(pose.x - cx * distance, subject.h + height, pose.z - cz * distance);
    if (this.camReady) {
      this.camera.position.lerp(GOAL, Math.min(1, dt * 9));
    } else {
      this.camera.position.copy(GOAL);
      this.camReady = true;
    }
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const jolt = this.shake * this.shake * 0.5;
    this.camera.position.x += (Math.random() - 0.5) * jolt;
    this.camera.position.y += (Math.random() - 0.5) * jolt;
    LOOK.set(pose.x + cx * 7, subject.h + 1.3, pose.z + cz * 7);
    this.camera.lookAt(LOOK);
    const fov = 60 + share * 11 + (pose.boosting ? 9 : 0);
    this.fov += (fov - this.fov) * Math.min(1, dt * 5);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  private updateHud(now: number): void {
    const { hud, me, state } = this;
    hud.tick();
    const order = this.standings();
    this.myPlace = Math.max(1, order.findIndex((racer) => racer.kind === "me") + 1);
    const dots: MapDot[] = order.map((racer) => ({
      color: racer.css,
      me: racer.kind === "me",
      x: racer.pose.x,
      z: racer.pose.z,
    }));
    hud.drawMap(dots);
    this.updateNet(order);
    if (!this.started) {
      return;
    }
    const ahead = order[this.myPlace - 2];
    const gap = ahead ? (ahead.pose.prog - me.prog) / Math.max(12, kartSpeed(me)) : 0;
    hud.setRace({
      boosting: me.boost > 0,
      charge: me.charge,
      clockMs: Math.max(0, (me.finishMs > 0 ? me.finishMs : now) - state.startAt),
      gap: ahead && gap > 0 ? gap : 0,
      item: this.items.heldBy("me"),
      kmh: Math.round(kartSpeed(me) * KMH),
      lap: kartLap(me, this.track),
      orbs: me.orbs,
      place: this.myPlace,
      surface: me.surface,
      total: order.length,
    });
    if (this.frame % 6 === 0) {
      hud.setStandings(
        order.map((racer) => ({ color: racer.css, me: racer.kind === "me", name: racer.name })),
      );
    }
    if (state.phase === "results") {
      this.showResults(order, now);
      return;
    }
    hud.showResults(null);
    hud.showHud(true);
    this.input.setTouchVisible(true);
    this.countdown(now);
    if (this.wrongWayFor > 0.8) {
      hud.callout("WRONG WAY", 300, "warn");
    }
  }

  private updateNet(order: readonly Racer[]): void {
    const status = this.client.connectionStatus;
    const humans = order.filter((racer) => racer.kind !== "bot").length;
    let text = "connecting…";
    if (status === "offline") {
      text = "solo";
    } else if (status === "reconnecting") {
      text = "reconnecting…";
    } else if (status === "connected") {
      text = humans > 1 ? `${humans} racers online` : "online";
    }
    this.hud.setNet(text);
  }

  private countdown(now: number): void {
    const left = this.state.startAt - now;
    const count = left > 0 ? Math.ceil(left / 1000) : 0;
    if (count === this.lastCount) {
      return;
    }
    if (count === 0 && this.lastCount > 0) {
      this.hud.callout("GO!", 900);
      sfx.countdown(true);
    } else if (count > 0 && count <= 3) {
      this.hud.callout(String(count), 950);
      sfx.countdown(false);
    } else if (count > 3) {
      this.hud.callout("READY", 1800, "go", this.track.def.name.toUpperCase());
    }
    this.lastCount = count;
  }

  private showResults(order: readonly Racer[], now: number): void {
    const shares = this.paint.coverage(MAX_SLOT);
    const table = this.client.sharedState["points"];
    const pointsOf = (racer: Racer): number => {
      const value = isJsonObject(table) ? table[this.cupKey(racer)] : 0;
      return isJsonNumber(value) ? value : 0;
    };
    const rows: ResultRow[] = order.map((racer, i) => ({
      color: racer.css,
      me: racer.kind === "me",
      name: racer.name,
      paint: shares[racer.slot] ?? 0,
      place: i + 1,
      points: pointsOf(racer),
      timeMs: racer.pose.finishMs > 0 ? racer.pose.finishMs - this.state.startAt : 0,
    }));
    const heading = this.me.finishMs > 0 ? `${ordinal(this.myPlace)} PLACE` : "TIME UP";
    const race = this.state.track + 1;
    const last = race === TRACKS.length;
    const [champion] = order.toSorted((p, q) => pointsOf(q) - pointsOf(p));
    const sub = last
      ? `Cup final · ${champion?.name ?? "nobody"} takes the cup`
      : `${this.track.def.name} · race ${race} of ${TRACKS.length}`;
    this.hud.showResults(rows, heading, sub);
    const wait = Math.max(0, Math.ceil((this.state.nextAt - now) / 1000));
    const next = trackFor(this.state.track + 1).def.name;
    this.hud.setResultsNext(last ? `New cup: ${next} in ${wait}` : `Next: ${next} in ${wait}`);
    // The card is the whole screen now: the race readout would only sit behind it.
    this.hud.showHud(false);
    this.input.setTouchVisible(false);
    idleAudio();
  }
}
