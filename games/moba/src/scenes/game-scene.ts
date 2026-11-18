import { PhysicalGamepad, attachVirtualGamepad } from "@vibedgames/gamepad/phaser";
import type { PadButton, StickState } from "@vibedgames/gamepad/phaser";
import { createTouchControls, isOfflineRequested } from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { MultiplayerConnectionStatus } from "@vibedgames/multiplayer";
import type Phaser from "phaser";
import { BlendModes, Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";

import { KEYFRAME_MS, SIM_DT, TEAMS } from "../data/config";
import type { Team } from "../data/config";
import { HEROES, HERO_BY_ID } from "../data/heroes";
import type { AbilityDef, AbilityKey } from "../data/heroes";
import { ELEV_LIFT, TOWERS, WORLD, elevationFrac } from "../data/map";
import { activateItem, autoLevel, castAbility, levelAbility } from "../sim/abilities";
import { dealDamage, isEnemy } from "../sim/combat";
import { dist2 } from "../sim/math";
import type { Vec2 } from "../sim/math";
import { buyItem, createWorld, dashHero, issueOrder, spawnHero, step } from "../sim/world";
import type { FxEvent, Order, Unit, World } from "../sim/types";
import { resetSound, resumeAudio, sfx, toggleMute, updateSoundscape } from "../render/audio";
import { readSoundscape } from "../render/score";
import { structureAnnouncement } from "../render/objective-guidance";
import { presentationSettings, watchPresentationSettings } from "../render/presentation-settings";
import { WorldView } from "../render/view";
import { createPlaytestSense } from "../playtest/sense";
import {
  INTENT_EVENT,
  PARTY,
  TICK_EVENT,
  multiplayerHost,
  parseIntent,
  roomFromLocation,
} from "../net/protocol";
import type { Intent } from "../net/protocol";
import { restoreHostState, seatsOf } from "../net/host-state";
import type { OnlineSeat } from "../net/host-state";
import { GuestMirror, placeFollowers } from "../net/mirror";
import { HeroPredictor } from "../net/predict";
import { emptyGuestWorld, encodeWorld, sharedSnapAt, sharedSnapshot } from "../net/snapshot";
import type { Snapshot } from "../net/snapshot";
import { TickEncoder, parseTick } from "../net/stream";
import type { JsonValue } from "../net/json";

const TEAM_SIZE = 3;
const DEFAULT_SEED = 1234;
const LANE_SKIP_MAX_S = 45;
const LANE_SKIP_CONTACT = 900;
const LANE_POST_OFFSET = 110;
const SIM_CATCHUP_S = 0.2;
const SIM_STEPS_MAX = 6;
const HOST_STALL_MS = 4000;
const ONLINE_FALLBACK_MS = 8000;
const TELEPORT_PX = 120;

const TOUCH_CONTROLS_CSS = `
.moba-touch {
  --vg-touch-bg: rgba(28, 20, 16, 0.8);
  --vg-touch-bg-active: rgba(138, 115, 80, 0.55);
  --vg-touch-border: 2px solid #8a7350;
  --vg-touch-fg: #ffe8b0;
  flex-direction: column;
  top: calc(env(safe-area-inset-top, 0px) + 44px);
}
@media (orientation: landscape) {
  .moba-touch {
    flex-direction: row;
    top: calc(env(safe-area-inset-top, 0px) + 10px);
  }
}
`;

const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
const DASH_KEY = "F";
const MOUSE_AIM_HOLD_MS = 4000;
export const SLOT_LABEL = { E: "E", Q: "Q", R: "R", W: "W" } satisfies Record<AbilityKey, string>;

const PAD_CAST: readonly (readonly [PadButton, AbilityKey])[] = [
  ["x", "Q"],
  ["y", "W"],
  ["b", "E"],
  ["rb", "R"],
];

const stickDir16 = (s: StickState) => {
  if (!s.active || s.inDeadZone) {
    return null;
  }

  const a = (Math.round(s.angle / (Math.PI / 8)) * Math.PI) / 8;

  return {
    dx: Math.abs(Math.cos(a)) < 1e-6 ? 0 : Math.cos(a),
    dy: Math.abs(Math.sin(a)) < 1e-6 ? 0 : Math.sin(a),
  };
};

export interface ObjectiveNotice {
  kind: "notify";
  text: string;
  tone: "good" | "bad" | "neutral";
  priority: "objective" | "major" | "ending";
  at: number;
}

export type FeedEntry =
  | { kind: "kill"; killer: string; victim: string; team: Team; at: number }
  | ObjectiveNotice;

/** A notice the HUD holds up for as long as it applies, not for a few seconds. */
export type StatusNotice = Pick<ObjectiveNotice, "text" | "tone">;

const CONNECTION_NOTICE: Partial<Record<MultiplayerConnectionStatus, StatusNotice>> = {
  connecting: { text: "CONNECTING…", tone: "neutral" },
  reconnecting: { text: "RECONNECTING…", tone: "bad" },
};

/** Final primitives only: unassigned clients cannot imply a personal defeat or
 * borrow a teammate's stats. World winner and host authority remain unchanged. */
export type MatchResult = Readonly<
  { duration: number } & (
    | { kind: "unassigned"; winner: Team | null }
    | {
        kind: "assigned";
        outcome: "victory" | "defeat";
        winner: Team;
        team: Team;
        heroId: string;
        heroName: string;
        heroTitle: string;
        role: string;
        level: number;
        kills: number;
        deaths: number;
        assists: number;
        lastHits: number;
        denies: number;
        gold: number;
      }
  )
>;

const pickRoster = (first: string, n: number) => {
  const ids = [first];

  for (const h of HEROES) {
    if (ids.length >= n) {
      break;
    }

    if (!ids.includes(h.id)) {
      ids.push(h.id);
    }
  }

  return ids;
};

export class GameScene extends Scene {
  private world!: World;
  private view!: WorldView;
  private playerId = "";
  private acc = 0;
  private hostClock: number | null = null;
  private labelTimer = 0;
  private cam!: Phaser.Cameras.Scene2D.Camera;
  private followGo = false;
  private heroChoice = "ironvow";
  private seed = DEFAULT_SEED;
  private skipToLane = false;
  private damageDealt = 0;
  private scoreBaseline = 0;
  private sense = createPlaytestSense();
  private ended = false;
  private result: MatchResult | null = null;
  private hitStopUntil = 0;
  private inputPaused = false;
  private needsPauseHold = false;
  private moveKeys: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key> | null =
    null;
  private pad: ReturnType<typeof attachVirtualGamepad> | null = null;
  private touchControls: TouchControls | null = null;
  readonly physPad = new PhysicalGamepad();
  private lastDir = { dx: 0, dy: 0 };
  private aimDir = { x: 1, y: 0 };
  private mouseAimUntil = 0;
  uiBlocking = false;
  readonly feed: FeedEntry[] = [];

  private online = false;
  private unreachable = false;
  private net: MultiplayerClient | null = null;
  private picks: Record<string, string> = {};
  private assign: Record<string, OnlineSeat> = {};
  private joinedSelf = false;
  private netFx: FxEvent[] = [];
  private fxShipped = 0;
  private encoder = new TickEncoder();
  private readonly acks = new Map<string, { seq: number; at: number }>();
  private lastStamp = 0;
  private keyframeAt = 0;
  private keyframeStamp: number | null = null;
  private keyframePhase: World["phase"] | null = null;
  private rosterSig = "";
  private worldIsSim = false;
  private mirror: GuestMirror | null = null;
  private predictor: HeroPredictor | null = null;
  private seenSnap: Snapshot | null = null;
  private wasConnected = false;
  private hostSeen: string | null = null;
  private restateOrder = false;
  private stallShown = false;
  private adoptedHost = false;
  private joinResendAt = 0;
  private staleSnap: Snapshot | null = null;
  private readonly prevPos = new Map<string, Vec2>();

  constructor() {
    super("Game");
  }

  init(data: {
    heroId?: string;
    online?: boolean;
    seed?: number;
    skipToLane?: boolean;
    unreachable?: boolean;
  }) {
    if (data?.heroId) {
      this.heroChoice = data.heroId;
    }

    this.seed = data?.seed ?? DEFAULT_SEED;
    this.skipToLane = data?.skipToLane === true;
    this.online = !!data?.online && !isOfflineRequested();
    this.unreachable = data?.unreachable === true;
  }

  private resetMatchState() {
    resetSound();
    this.result = null;
    this.damageDealt = 0;
    this.scoreBaseline = 0;
    this.sense = createPlaytestSense();
    this.playerId = "";
    this.acc = 0;
    this.hostClock = null;
    this.labelTimer = 0;
    this.followGo = false;
    this.ended = false;
    this.hitStopUntil = 0;
    this.inputPaused = false;
    this.needsPauseHold = false;
    this.lastDir = { dx: 0, dy: 0 };
    this.aimDir = { x: 1, y: 0 };
    this.mouseAimUntil = 0;
    this.uiBlocking = false;
    this.net = null;
    this.picks = {};
    this.assign = {};
    this.joinedSelf = false;
    this.netFx = [];
    this.fxShipped = 0;
    this.encoder = new TickEncoder();
    this.acks.clear();
    this.lastStamp = 0;
    this.keyframeAt = 0;
    this.keyframeStamp = null;
    this.keyframePhase = null;
    this.rosterSig = "";
    this.worldIsSim = false;
    this.mirror = null;
    this.predictor = null;
    this.seenSnap = null;
    this.wasConnected = false;
    this.hostSeen = null;
    this.restateOrder = false;
    this.stallShown = false;
    this.adoptedHost = false;
    this.joinResendAt = 0;
    this.staleSnap = null;
    this.prevPos.clear();
    this.feed.length = 0;
    this.moveKeys = null;
  }

  create() {
    this.resetMatchState();

    this.view = new WorldView(this);
    this.view.poseOf = this.poseOf;
    this.view.buildTerrain();
    this.view.buildStructures();

    this.cam = this.cameras.main;
    this.cam.roundPixels = true;
    this.cam.setBackgroundColor("#0a0e16");
    this.applyZoom();
    const stopPresentationSettings = watchPresentationSettings(() => this.applyZoom());
    this.scale.on(Scale.Events.RESIZE, this.applyZoom, this);

    if (this.online) {
      this.startOnline();
    } else {
      this.startLocal();
    }

    if (this.unreachable) {
      this.feed.push({
        at: this.time.now,
        kind: "notify",
        priority: "major",
        text: "SERVER UNREACHABLE — PLAYING VS BOTS",
        tone: "neutral",
      });
    }

    this.bindInput();
    this.bindTouch();
    this.dropInputEdges();
    this.scene.launch("Hud", { game: this });

    if (import.meta.env.DEV) {
      this.installDebug();
      const at = new URLSearchParams(window.location.search).get("at");
      const me = this.player;

      if (at && me) {
        const [ax, ay] = at.split(",").map(Number);

        if (Number.isFinite(ax) && Number.isFinite(ay)) {
          me.x = ax ?? me.x;
          me.y = ay ?? me.y;
        }
      }
    }

    this.events.once(Scenes.Events.SHUTDOWN, () => {
      stopPresentationSettings();
      resetSound();
      this.scale.off(Scale.Events.RESIZE, this.applyZoom, this);
      this.pad?.destroy();
      this.pad = null;
      this.touchControls?.destroy();
      this.touchControls = null;
      this.physPad.destroy();
      this.net?.destroy();
      this.net = null;
    });

    const veil = document.querySelector("#veil");

    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 600);
    }
  }

  private startLocal() {
    this.world = createWorld(this.seed);
    const player = spawnHero(this.world, this.heroChoice, "radiant", "you", false, 0);
    this.playerId = player.id;
    this.view.playerHeroId = player.id;
    this.view.playerTeam = player.team;

    for (const [i, id] of pickRoster(this.heroChoice, TEAM_SIZE).slice(1).entries()) {
      spawnHero(this.world, id, "radiant", `botR${i}`, true, i + 1);
    }

    for (const [i, id] of pickRoster("emberhex", TEAM_SIZE).entries()) {
      spawnHero(this.world, id, "dire", `botD${i}`, true, i);
    }

    if (this.skipToLane) {
      this.walkToLane(player);
    }
  }

  private walkToLane(player: Unit) {
    const tower = TOWERS.find((t) => t.team === player.team && t.lane === "top" && t.tier === "t1");

    if (!tower) {
      return;
    }

    const post = { x: tower.x, y: tower.y + LANE_POST_OFFSET };
    issueOrder(this.world, player, { to: post, type: "attackMove" });

    const contact = () => {
      for (const u of this.world.units.values()) {
        if (
          u.kind === "creep" &&
          !u.neutral &&
          u.alive &&
          isEnemy(player, u) &&
          dist2(player, u) < LANE_SKIP_CONTACT * LANE_SKIP_CONTACT
        ) {
          return true;
        }
      }

      return false;
    };

    for (let t = 0; t < LANE_SKIP_MAX_S && !contact(); t += SIM_DT) {
      step(this.world, SIM_DT);
    }

    issueOrder(this.world, player, { type: "hold" });
    this.world.fx.length = 0;
    this.scoreBaseline = this.playScore();
  }

  private startOnline() {
    this.world = emptyGuestWorld();

    const net = new MultiplayerClient({
      fallbackMs: ONLINE_FALLBACK_MS,
      host: multiplayerHost(),
      maxPlayers: TEAM_SIZE * TEAMS.length,
      onEvent: (event, payload, from) => this.onNetEvent(event, payload, from),
      party: PARTY,
      room: roomFromLocation(),
    });

    this.net = net;
    this.mirror = new GuestMirror(this.world);
    this.predictor = new HeroPredictor();
    net.subscribe(() => this.onNetChange(net));
  }

  private playVsBots(net: MultiplayerClient) {
    net.destroy();
    this.net = null;
    this.scene.stop("Hud");
    this.scene.start("Game", { heroId: this.heroChoice, online: false, unreachable: true });
  }

  private onNetChange(net: MultiplayerClient) {
    if (net.connectionStatus === "offline") {
      this.playVsBots(net);

      return;
    }

    const connected = net.connectionStatus === "connected";

    if (!connected || !net.isHost) {
      this.adoptedHost = false;
    }

    if (!connected) {
      this.joinedSelf = false;
      this.staleSnap = sharedSnapshot(net.sharedState);
      this.wasConnected = false;
      this.mirror?.reset();

      return;
    }

    const joined = !this.wasConnected;
    this.wasConnected = true;

    if (net.hostId !== this.hostSeen) {
      this.hostSeen = net.hostId;

      if (!net.isHost) {
        this.mirror?.hostChanged();
        this.restateOrder = true;
      }
    }

    if (!net.isHost) {
      this.takeKeyframe(net, !joined);
    }
  }

  private takeKeyframe(net: MultiplayerClient, live: boolean) {
    const snap = this.roomSnapshot(net);
    const at = sharedSnapAt(net.sharedState);

    if (!snap || at === null || snap === this.seenSnap) {
      return;
    }

    this.seenSnap = snap;

    if (this.mirror?.keyframe(snap, at, live)) {
      this.predictor?.reset();
    }
  }

  private get amHost() {
    return !this.online || (this.net?.connectionStatus === "connected" && this.net.isHost);
  }

  private get seated() {
    if (!this.online) {
      return true;
    }

    const { net } = this;

    return net?.connectionStatus === "connected" && this.playerId === `h-${net.playerId}`;
  }

  private roomSnapshot(net: MultiplayerClient) {
    const snap = sharedSnapshot(net.sharedState);

    return snap === this.staleSnap ? null : snap;
  }

  /**
   * True in online mode (a peer may be connected or join any moment) — used by
   * the wrapper's pause handler so it never freezes a session other players
   * are relying on.
   */
  isOnline() {
    return this.online;
  }

  /** What the HUD holds up while this client is out of its room, or null. */
  get connectionNotice() {
    const status = this.net?.connectionStatus;

    return (status && CONNECTION_NOTICE[status]) ?? null;
  }

  private onNetEvent(event: string, payload: JsonValue, from: string) {
    if (event === TICK_EVENT) {
      this.onHostTick(payload, from);

      return;
    }

    if (event !== INTENT_EVENT) {
      return;
    }

    const intent = parseIntent(payload);

    if (!intent) {
      return;
    }

    if (intent.kind === "join") {
      this.picks[from] = intent.defId;

      if (this.amHost && this.world.phase === "ended" && !this.world.units.has(`h-${from}`)) {
        this.rematch();
      }

      return;
    }

    if (!this.amHost) {
      return;
    }

    if (this.net) {
      this.prepareOnlineHost(this.net);
    }

    if (this.world.phase === "ended") {
      return;
    }

    const u = this.world.units.get(`h-${from}`);

    if (!u) {
      return;
    }

    if (intent.seq !== undefined) {
      this.acks.set(u.id, { at: this.world.now, seq: intent.seq });
    }

    if (u.alive) {
      this.applyIntent(u, intent);
    }
  }

  private onHostTick(payload: JsonValue, from: string) {
    const { net, mirror, predictor } = this;

    if (!net || !mirror || net.isHost || from !== net.hostId) {
      return;
    }

    const tick = parseTick(payload);

    if (!tick) {
      return;
    }

    mirror.tick(tick, performance.now());
    const me = mirror.latest?.units.get(this.playerId);

    if (me && predictor) {
      const ack = tick.k?.find(([id]) => id === this.playerId);
      predictor.reconcile(me, ack ? [ack[1], ack[2]] : null);
    }
  }

  private applyIntent(u: Unit, intent: Intent) {
    switch (intent.kind) {
      case "order": {
        issueOrder(this.world, u, intent.order);
        break;
      }

      case "cast": {
        castAbility(this.world, u, {
          key: intent.key,
          point: intent.point,
          targetId: intent.targetId,
        });
        break;
      }

      case "level": {
        levelAbility(u, intent.key);
        break;
      }

      case "buy": {
        buyItem(this.world, u, intent.itemId);
        break;
      }

      case "useItem": {
        const id = u.hero?.items[intent.slot];

        if (id) {
          activateItem(this.world, u, id, intent.point);
        }

        break;
      }

      case "dash": {
        dashHero(this.world, u, intent.dx, intent.dy);
        break;
      }

      case "join": {
        break;
      }

      default: {
        break;
      }
    }
  }

  private reconcileOnlineHeroes() {
    if (!this.net) {
      return;
    }

    const ids = Object.keys(this.net.players);
    const want = new Set<string>();

    const occupied = {
      dire: new Set<number>(),
      radiant: new Set<number>(),
    } satisfies Record<Team, Set<number>>;

    this.assign = Object.fromEntries(
      Object.entries(this.assign).filter(([id]) => ids.includes(id)),
    );

    for (const id of ids) {
      if (!this.assign[id]) {
        this.assign[id] = this.seatNewcomer();
      }
    }

    for (const id of ids) {
      const a = this.assign[id];

      if (!a) {
        continue;
      }

      occupied[a.team].add(a.slot);
      this.spawnHuman(id, a, want);
    }

    this.fillBots(occupied, want);

    for (const [id, u] of this.world.units) {
      if (u.kind === "hero" && !want.has(id)) {
        this.world.units.delete(id);
      }
    }
  }

  private seatNewcomer() {
    const counts = { dire: 0, radiant: 0 };

    for (const a of Object.values(this.assign)) {
      counts[a.team] += 1;
    }

    const team: Team = counts.radiant <= counts.dire ? "radiant" : "dire";

    const used = new Set(
      Object.values(this.assign)
        .filter((seat) => seat.team === team)
        .map((seat) => seat.slot),
    );

    let slot = 0;

    while (used.has(slot)) {
      slot += 1;
    }

    return { slot, team };
  }

  private spawnHuman(id: string, seat: OnlineSeat, want: Set<string>) {
    const hid = `h-${id}`;
    const pick = this.picks[id];

    if (!pick) {
      return;
    }

    want.add(hid);
    const existing = this.world.units.get(hid);

    if (!existing) {
      spawnHero(this.world, pick, seat.team, id, false, seat.slot);
    } else if (
      existing.hero &&
      existing.hero.defId !== pick &&
      existing.hero.level === 1 &&
      existing.hero.kills === 0
    ) {
      this.world.units.delete(hid);
      spawnHero(this.world, pick, seat.team, id, false, seat.slot);
    }
  }

  private fillBots(occupied: Record<Team, Set<number>>, want: Set<string>) {
    for (const team of TEAMS) {
      for (let s = 0; s < TEAM_SIZE; s += 1) {
        if (occupied[team].has(s)) {
          continue;
        }

        const hid = `h-bot-${team}-${s}`;
        want.add(hid);

        if (!this.world.units.has(hid)) {
          const def =
            pickRoster(team === "radiant" ? "ironvow" : "emberhex", s + 1)[s] ?? "ironvow";

          spawnHero(this.world, def, team, `bot-${team}-${s}`, true, s);
        }
      }
    }
  }

  private prepareOnlineHost(net: MultiplayerClient) {
    if (this.adoptedHost || !this.amHost) {
      return;
    }

    const ours =
      this.worldIsSim &&
      this.keyframeStamp !== null &&
      sharedSnapAt(net.sharedState) === this.keyframeStamp;

    const replica = this.mirror?.resumable ?? null;
    const held = this.predictor?.order ?? null;

    const restored = ours
      ? seatsOf(this.world)
      : restoreHostState(this.world, replica ? encodeWorld(replica) : this.roomSnapshot(net));

    const me = this.player;

    if (held && me) {
      issueOrder(this.world, me, held);
    }

    this.assign = restored.seats;
    this.picks = { ...this.picks, ...restored.picks };
    this.adoptedHost = true;
    this.worldIsSim = true;
    this.mirror?.reset();
    this.predictor?.reset();
    this.netFx = [];
    this.fxShipped = this.world.fx.length;
    this.acks.clear();
    this.prevPos.clear();
    this.acc = 0;
    this.hostClock = null;
    this.lastStamp = Math.round(net.serverNow());
    this.publishKeyframe(net);
  }

  private cmd(intent: Intent) {
    if (this.result) {
      return;
    }

    if (this.inputPaused && !(intent.kind === "order" && intent.order.type === "hold")) {
      return;
    }

    if (!this.seated) {
      return;
    }

    if (this.amHost && this.net) {
      this.prepareOnlineHost(this.net);
    }

    if (this.world.phase === "ended") {
      return;
    }

    if (this.amHost) {
      const me = this.player;

      if (me) {
        this.applyIntent(me, intent);
      }

      return;
    }

    const seq = this.predictor?.input(intent, performance.now());
    this.net?.sendToHost(INTENT_EVENT, seq === undefined ? intent : { ...intent, seq });
  }

  get controlsPaused() {
    return this.inputPaused;
  }

  private dropInputEdges() {
    this.input.keyboard?.resetKeys();
    this.pad?.pad.reset();
    this.pad?.pad.nextFrame();
    this.pad?.pad.nextFrame();
    this.physPad.update();
    this.physPad.update();
  }

  clearHudInput() {
    this.dropInputEdges();
    this.needsPauseHold = true;
    this.flushPauseHold();
  }

  /** The online simulation continues under pause; only this player's input stops. */
  setControlsPaused(paused: boolean) {
    if (this.inputPaused === paused) {
      return;
    }

    this.inputPaused = paused;
    this.dropInputEdges();

    if (paused) {
      this.needsPauseHold = true;
    }

    this.flushPauseHold();
  }

  private flushPauseHold() {
    if (!this.needsPauseHold || !this.seated) {
      return;
    }

    this.cmd({ kind: "order", order: { type: "hold" } });
    this.lastDir = { dx: 0, dy: 0 };
    this.needsPauseHold = false;
  }

  get matchResult() {
    return this.result;
  }

  get worldRef() {
    return this.world;
  }
  get player() {
    return this.playerId ? this.world.units.get(this.playerId) : undefined;
  }
  /** The currently-visible world rectangle, for the minimap viewport box. */
  get cameraView() {
    return this.cam.worldView;
  }
  /** Hand the HUD any feed entries collected since the last frame, then clear. */
  drainFeed() {
    if (this.feed.length === 0) {
      return [];
    }

    const out = [...this.feed];
    this.feed.length = 0;

    return out;
  }

  private applyZoom() {
    const standard = PhaserMath.Clamp(this.scale.height / 900, 0.55, 1.3);
    this.cam.setZoom(
      presentationSettings().view === "close" ? Math.max(0.82, standard * 1.15) : standard,
    );
  }

  private bindInput() {
    this.input.mouse?.disableContextMenu();
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.mouseAimUntil = this.time.now + MOUSE_AIM_HOLD_MS;
      }
    });
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      resumeAudio();

      if (p.wasTouch) {
        return;
      }

      this.mouseAimUntil = this.time.now + MOUSE_AIM_HOLD_MS;

      if (this.uiBlocking) {
        return;
      }

      if (!(p.leftButtonDown() || p.rightButtonDown())) {
        return;
      }

      const hud = this.scene.get("Hud");

      if (hud?.input && hud.input.hitTestPointer(p).length > 0) {
        return;
      }

      this.issueClickOrder(p);
    });

    const kb = this.input.keyboard;

    if (!kb) {
      return;
    }

    for (const key of ABILITY_KEYS) {
      kb.on(`keydown-${key}`, (e: KeyboardEvent) => {
        if (e.shiftKey || e.ctrlKey) {
          this.levelSlot(key);
        } else {
          this.castSlot(key);
        }
      });
    }

    kb.on(`keydown-${DASH_KEY}`, () => this.dash());
    kb.on("keydown-H", () => this.cmd({ kind: "order", order: { type: "fountain" } }));

    for (const [i, code] of ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"].entries()) {
      kb.on(`keydown-${code}`, () => this.useItemSlot(i));
    }

    kb.on("keydown-M", () => {
      toggleMute();
      resumeAudio();
    });

    const KC = Input.Keyboard.KeyCodes;
    this.moveKeys = {
      down: kb.addKey(KC.DOWN, true),
      left: kb.addKey(KC.LEFT, true),
      right: kb.addKey(KC.RIGHT, true),
      up: kb.addKey(KC.UP, true),
    };
    kb.on("keydown-SPACE", (e: KeyboardEvent) => {
      e.preventDefault?.();
      this.spaceAttack();
    });
  }

  private bindTouch() {
    this.bindPad();
    this.touchControls = createTouchControls({
      className: "moba-touch",
      css: TOUCH_CONTROLS_CSS,
      styleId: "moba-touch-controls",
    });
  }

  private bindPad() {
    this.pad = attachVirtualGamepad(this, {
      buttons: [{ id: "attack" }],
      onFirstTouch: () => resumeAudio(),
      render: { blendMode: BlendModes.NORMAL, depth: 50_000 },
    });
  }

  private pollMovement() {
    if (this.inputPaused || this.needsPauseHold) {
      return;
    }

    if (!this.seated) {
      return;
    }

    const me = this.player;

    if (!me || !me.alive || this.uiBlocking) {
      if (this.uiBlocking && (this.lastDir.dx !== 0 || this.lastDir.dy !== 0)) {
        this.cmd({ kind: "order", order: { type: "hold" } });
      }

      this.lastDir = { dx: 0, dy: 0 };

      return;
    }

    const { dx, dy } = this.heldDirection();

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      this.aimDir = { x: dx / len, y: dy / len };
    }

    if (dx === this.lastDir.dx && dy === this.lastDir.dy) {
      return;
    }

    this.lastDir = { dx, dy };

    if (dx === 0 && dy === 0) {
      this.cmd({ kind: "order", order: { type: "hold" } });
    } else {
      this.cmd({ kind: "order", order: { dx, dy, type: "moveDir" } });
    }
  }

  private heldDirection() {
    let { dx, dy } = this.arrowDirection();

    if (dx === 0 && dy === 0 && this.physPad.connected) {
      ({ dx, dy } = this.dpadDirection());
    }

    if (dx === 0 && dy === 0) {
      const d =
        (this.pad ? stickDir16(this.pad.getStick()) : null) ?? stickDir16(this.physPad.getStick());

      if (d) {
        ({ dx, dy } = d);
      }
    }

    return { dx, dy };
  }

  private arrowDirection() {
    const k = this.moveKeys;
    let dx = 0;
    let dy = 0;

    if (k) {
      if (k.left.isDown) {
        dx -= 1;
      }

      if (k.right.isDown) {
        dx += 1;
      }

      if (k.up.isDown) {
        dy -= 1;
      }

      if (k.down.isDown) {
        dy += 1;
      }
    }

    return { dx, dy };
  }

  private dpadDirection() {
    let dx = 0;
    let dy = 0;

    if (this.physPad.isButtonDown("left")) {
      dx -= 1;
    }

    if (this.physPad.isButtonDown("right")) {
      dx += 1;
    }

    if (this.physPad.isButtonDown("up")) {
      dy -= 1;
    }

    if (this.physPad.isButtonDown("down")) {
      dy += 1;
    }

    return { dx, dy };
  }

  private pollPadButtons() {
    if (!this.physPad.connected) {
      return;
    }

    if (this.physPad.justPressed("a")) {
      this.spaceAttack();
    }

    for (const [btn, key] of PAD_CAST) {
      if (this.physPad.justPressed(btn)) {
        this.castSlot(key, true);
      }
    }

    if (this.physPad.justPressed("rt")) {
      this.dash();
    }
  }

  private spaceAttack() {
    const me = this.player;

    if (!me || !me.alive || this.uiBlocking) {
      return;
    }

    const target = this.nearestAttackTarget(me, 750);

    if (target) {
      this.cmd({ kind: "order", order: { targetId: target.id, type: "attackUnit" } });
    }
  }

  /** Quick dodge in the held/facing direction (host validates the cooldown).
   *  Public: the HUD dash box taps it too. */
  dash() {
    const me = this.player;

    if (!me || !me.alive || this.uiBlocking) {
      return;
    }

    const moving = this.lastDir.dx !== 0 || this.lastDir.dy !== 0;
    const dx = moving ? this.lastDir.dx : this.aimDir.x;
    const dy = moving ? this.lastDir.dy : this.aimDir.y;
    this.cmd({ dx, dy, kind: "dash" });
  }

  private collectFeed() {
    const { now } = this.time;
    const me = this.player;

    for (const fx of this.world.fx) {
      if (fx.t === "kill") {
        this.feed.push({
          at: now,
          killer: fx.killer,
          kind: "kill",
          team: fx.team,
          victim: fx.victim,
        });
      } else if (fx.t === "notify") {
        this.feed.push({
          at: now,
          kind: "notify",
          priority: "objective",
          text: fx.text,
          tone: fx.tone,
        });
      } else if (fx.t === "structureDown") {
        this.feed.push({
          kind: "notify",
          ...structureAnnouncement(this.world, fx, me?.team ?? null),
          at: now,
        });
      } else if (fx.t === "hit") {
        const target = this.world.units.get(fx.targetId);

        if (me?.hero && fx.attackerHero === me.hero.defId && target && isEnemy(me, target)) {
          this.damageDealt += fx.amount;
        }
      } else if (
        fx.t === "death" &&
        fx.kind === "hero" &&
        !this.online &&
        me &&
        dist2(me, fx) < 900 * 900
      ) {
        this.hitStopUntil = now + 110;
      }
    }

    if (this.feed.length > 40) {
      this.feed.splice(0, this.feed.length - 40);
    }
  }

  /** HUD button: return to the fountain (same as the H key). */
  recall() {
    this.cmd({ kind: "order", order: { type: "fountain" } });
  }

  /** HUD minimap → world: order the hero to travel to a clicked map point. */
  moveToWorldPoint(x: number, y: number) {
    const me = this.player;

    if (!me || !me.alive) {
      return;
    }

    this.lastDir = { dx: 0, dy: 0 };
    this.cmd({ kind: "order", order: { to: { x, y }, type: "attackMove" } });
  }

  private nearestAttackTarget(me: Unit, range: number) {
    let best: Unit | undefined;
    let bestD = range * range;

    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive) {
        continue;
      }

      if (u.kind === "structure" && !u.structure?.attackable) {
        continue;
      }

      if (u.statuses.some((s) => s.kind === "untargetable")) {
        continue;
      }

      const d = dist2(me, u);

      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }

    return best;
  }

  private issueClickOrder(p: Phaser.Input.Pointer) {
    const me = this.player;

    if (!me || !me.alive) {
      return;
    }

    this.lastDir = { dx: 0, dy: 0 };
    const wp = this.cam.getWorldPoint(p.x, p.y);
    const enemy = this.unitAt(wp.x, wp.y, (u) => isEnemy(me, u) && u.alive);

    if (enemy) {
      this.cmd({ kind: "order", order: { targetId: enemy.id, type: "attackUnit" } });
    } else {
      this.cmd({ kind: "order", order: { to: { x: wp.x, y: wp.y }, type: "move" } });
    }
  }

  /** Cast an ability, aimed at the mouse cursor (any direction, incl. diagonals).
   *  Keyboard players who steer with the arrow keys free-aim along their facing.
   *  `fromHud` marks casts tapped on a HUD slot — there the pointer sits on the
   *  button, not the battlefield, so aim at the nearest enemy / along facing. */
  castSlot(key: AbilityKey, fromHud = false) {
    const me = this.player;

    if (!me || !me.alive || !me.hero || this.uiBlocking) {
      return;
    }

    const def = HERO_BY_ID[me.hero.defId]?.abilities[key];

    if (!def) {
      return;
    }

    const cursor = this.cam.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);

    if (def.targeting === "unit") {
      const target = this.unitCastTarget(me, def, cursor, fromHud);

      if (target) {
        this.cmd({ key, kind: "cast", targetId: target.id });
      }
    } else if (def.targeting === "point") {
      this.cmd({ key, kind: "cast", point: this.pointCastAim(me, def.castRange, cursor, fromHud) });
    } else {
      this.cmd({ key, kind: "cast" });
    }
  }

  private unitCastTarget(me: Unit, def: AbilityDef, cursor: Vec2, fromHud: boolean) {
    const wantAlly = def.effect === "brewkeeper:Q";

    const hovered = fromHud
      ? undefined
      : this.unitAt(cursor.x, cursor.y, (u) =>
          wantAlly ? !isEnemy(me, u) && u.kind === "hero" && u.alive : isEnemy(me, u) && u.alive,
        );

    if (hovered) {
      return hovered;
    }

    return wantAlly
      ? (this.lowestAllyInRange(me, def.castRange) ?? me)
      : this.nearestEnemy(me, def.castRange);
  }

  private pointCastAim(me: Unit, r: number, cursor: Vec2, fromHud: boolean) {
    if (r <= 0) {
      return { x: me.x, y: me.y };
    }

    if (fromHud) {
      return this.touchAimPoint(me, r);
    }

    if (this.time.now > this.mouseAimUntil) {
      return { x: me.x + this.aimDir.x * r, y: me.y + this.aimDir.y * r };
    }

    const dx = cursor.x - me.x;
    const dy = cursor.y - me.y;
    const d = Math.hypot(dx, dy);

    return d > r && d > 0 ? { x: me.x + (dx / d) * r, y: me.y + (dy / d) * r } : cursor;
  }

  private aimDirection() {
    const me = this.player;

    if (!me?.alive) {
      return null;
    }

    if (this.time.now > this.mouseAimUntil) {
      return this.touchControls ? null : this.aimDir;
    }

    const cursor = this.cam.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);
    const dx = cursor.x - me.x;
    const dy = cursor.y - me.y;
    const d = Math.hypot(dx, dy);

    return d < 12 ? this.aimDir : { x: dx / d, y: dy / d };
  }

  private touchAimPoint(me: Unit, r: number) {
    const foe = this.nearestEnemyHero(me, r) ?? this.nearestEnemy(me, r);

    if (foe) {
      return { x: foe.x, y: foe.y };
    }

    return { x: me.x + this.aimDir.x * r, y: me.y + this.aimDir.y * r };
  }

  private nearestEnemyHero(me: Unit, range: number) {
    let best: Unit | undefined;
    let bestD = range * range;

    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive || u.kind !== "hero") {
        continue;
      }

      const d = dist2(me, u);

      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }

    return best;
  }

  levelSlot(key: AbilityKey) {
    this.cmd({ key, kind: "level" });
  }

  private lowestAllyInRange(me: Unit, range: number) {
    let best: Unit | undefined;
    let bestPct = 1.01;
    const r2 = range * range;

    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || !u.alive || isEnemy(me, u)) {
        continue;
      }

      if (dist2(me, u) > r2) {
        continue;
      }

      const pct = u.hp / u.maxHp;

      if (pct < bestPct) {
        bestPct = pct;
        best = u;
      }
    }

    return best;
  }

  private useItemSlot(i: number, fromHud = false) {
    const me = this.player;

    if (!me?.hero?.items[i]) {
      return;
    }

    if (fromHud) {
      const point = { x: me.x + this.aimDir.x * 600, y: me.y + this.aimDir.y * 600 };
      this.cmd({ kind: "useItem", point, slot: i });

      return;
    }

    const p = this.input.activePointer;
    const wp = this.cam.getWorldPoint(p.x, p.y);
    this.cmd({ kind: "useItem", point: { x: wp.x, y: wp.y }, slot: i });
  }

  buyItemForPlayer(id: string) {
    if (this.result || !this.seated) {
      return false;
    }

    if (this.amHost && this.net) {
      this.prepareOnlineHost(this.net);
    }

    if (this.world.phase === "ended") {
      return false;
    }

    const me = this.player;

    if (this.amHost && me) {
      return buyItem(this.world, me, id);
    }

    this.cmd({ itemId: id, kind: "buy" });

    return true;
  }
  useItemForPlayer(i: number) {
    this.useItemSlot(i, true);
  }

  private unitAt(x: number, y: number, pred: (u: Unit) => boolean) {
    let best: Unit | undefined;
    let bestD = Infinity;

    for (const u of this.world.units.values()) {
      if (!pred(u)) {
        continue;
      }

      if (u.kind === "structure" && !u.structure?.attackable) {
        continue;
      }

      const r = (u.radius + 28) * (u.radius + 28);
      const ly = u.y - elevationFrac(u.x, u.y) * ELEV_LIFT;
      const d = dist2({ x, y }, { x: u.x, y: ly });

      if (d <= r && d < bestD) {
        bestD = d;
        best = u;
      }
    }

    return best;
  }

  private updateTargetReticle() {
    const me = this.player;

    if (!me || !me.alive) {
      this.view.setTarget("");

      return;
    }

    this.view.setTarget(this.reticleTarget(me)?.id ?? "");
  }

  private reticleTarget(me: Unit) {
    if (me.order.type === "attackUnit") {
      const t = this.world.units.get(me.order.targetId);

      if (t && t.alive && isEnemy(me, t)) {
        return t;
      }
    }

    if (me.pendingAttack) {
      const t = this.world.units.get(me.pendingAttack.targetId);

      if (t && t.alive && isEnemy(me, t)) {
        return t;
      }
    }

    if (me.order.type === "idle" || me.order.type === "hold" || me.order.type === "attackMove") {
      const t = this.engageTarget(me);

      if (t) {
        return t;
      }
    }

    const p = this.input.activePointer;
    const wp = this.cam.getWorldPoint(p.x, p.y);

    return this.unitAt(wp.x, wp.y, (u) => isEnemy(me, u) && u.alive);
  }

  private engageTarget(me: Unit) {
    let best: Unit | undefined;
    let bestD = Infinity;

    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive) {
        continue;
      }

      if (u.kind === "structure" && !u.structure?.attackable) {
        continue;
      }

      if (u.statuses.some((s) => s.kind === "untargetable")) {
        continue;
      }

      const reach = me.attackRange + me.radius + u.radius + 30;
      const d = dist2(me, u);

      if (d <= reach * reach && d < bestD) {
        bestD = d;
        best = u;
      }
    }

    return best;
  }

  private nearestEnemy(me: Unit, range: number) {
    let best: Unit | undefined;
    let bestD = range * range;

    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive || u.kind === "structure") {
        continue;
      }

      const d = dist2(me, u);

      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }

    return best;
  }

  override update(_t: number, deltaMs: number) {
    const dt = Math.min(0.05, deltaMs / 1000);
    this.pad?.update();
    this.flushPauseHold();

    if (!this.inputPaused && this.pad?.justPressed("attack")) {
      this.spaceAttack();
    }

    this.physPad.update();

    if (!this.inputPaused) {
      this.pollPadButtons();
    }

    this.pollMovement();

    if (this.online) {
      this.tickOnline(deltaMs);
    } else {
      this.tickHost(deltaMs);
    }

    this.flushPauseHold();

    this.collectFeed();
    this.updateTargetReticle();
    this.view.setAim(this.aimDirection());
    this.view.sync(this.world, dt);
    updateSoundscape(
      this.result
        ? { kind: "ended", time: this.world.now / 1000 }
        : readSoundscape(this.world, this.playerId),
    );
    this.labelTimer += dt;

    if (this.labelTimer > 0.25) {
      this.labelTimer = 0;
      this.view.refreshLabels(this.world);
    }

    this.updateCamera(dt);

    if (this.world.phase === "ended" && !this.ended) {
      this.ended = true;
      this.showResult();
    }
  }

  private tickHost(deltaMs: number) {
    if (this.time.now < this.hitStopUntil) {
      return;
    }

    const now = performance.now();
    const elapsed = this.hostClock === null ? deltaMs : now - this.hostClock;
    this.hostClock = now;
    this.acc += Math.min(SIM_CATCHUP_S, elapsed / 1000);
    const stampNow = this.net?.serverNow(now) ?? now;
    let steps = 0;

    while (this.acc >= SIM_DT && steps < SIM_STEPS_MAX) {
      this.rememberPositions();
      step(this.world, SIM_DT);
      this.acc -= SIM_DT;
      steps += 1;
      this.shipStep(stampNow - this.acc * 1000);
    }

    const me = this.player;

    if (this.world.phase === "playing" && me?.hero && me.hero.abilityPoints > 0) {
      autoLevel(this.world, me);
    }
  }

  private rememberPositions() {
    this.prevPos.clear();

    for (const u of this.world.units.values()) {
      if (u.kind !== "structure") {
        this.prevPos.set(u.id, { x: u.x, y: u.y });
      }
    }

    for (const p of this.world.projectiles.values()) {
      this.prevPos.set(p.id, { x: p.x, y: p.y });
    }
  }

  private readonly poseOf = (id: string) => {
    if (!this.amHost) {
      return;
    }

    const cur = this.world.units.get(id) ?? this.world.projectiles.get(id);
    const prev = this.prevPos.get(id);

    if (!cur || !prev) {
      return;
    }

    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;

    if (dx * dx + dy * dy > TELEPORT_PX * TELEPORT_PX) {
      return;
    }

    const k = PhaserMath.Clamp(this.acc / SIM_DT, 0, 1);

    return { x: prev.x + dx * k, y: prev.y + dy * k };
  };

  private shipStep(stamp: number) {
    this.lastStamp = Math.round(stamp);
    const { net } = this;

    if (!this.online || !net?.playerId || !this.amHost) {
      return;
    }

    const fx = [...this.netFx, ...this.world.fx.slice(this.fxShipped)];
    this.netFx = [];
    this.fxShipped = this.world.fx.length;

    if (Object.keys(net.players).length < 2) {
      return;
    }

    const tick = this.encoder.encode(this.world, this.lastStamp, fx, this.ackRows());
    net.sendEvent(TICK_EVENT, tick, { except: net.playerId });
  }

  private ackRows() {
    const rows: [string, number, number][] = [];

    for (const [heroId, ack] of this.acks) {
      if (this.world.units.has(heroId)) {
        rows.push([heroId, ack.seq, Math.round(this.world.now - ack.at)]);
      } else {
        this.acks.delete(heroId);
      }
    }

    return rows;
  }

  private publishKeyframe(net: MultiplayerClient) {
    net.updateSharedState({
      snap: structuredClone(encodeWorld(this.world)),
      snapAt: this.lastStamp,
    });
    this.keyframeStamp = this.lastStamp;
    this.keyframeAt = performance.now();
    this.keyframePhase = this.world.phase;
    this.encoder.reset(this.world);
  }

  private rosterChanged(net: MultiplayerClient) {
    const sig = Object.entries(net.players)
      .map(([id, p]) => `${id}:${p.connected === false ? 0 : 1}`)
      .join(",");

    const changed = sig !== this.rosterSig;
    this.rosterSig = sig;

    return changed;
  }

  private tickOnline(deltaMs: number) {
    const { net } = this;

    if (!net || net.connectionStatus !== "connected") {
      return;
    }

    if (!this.joinedSelf && net.playerId) {
      this.joinedSelf = true;
      const playerId = `h-${net.playerId}`;

      if (this.playerId !== playerId) {
        this.lastDir = { dx: 0, dy: 0 };
      }

      this.playerId = playerId;
      this.view.playerHeroId = this.playerId;
      net.sendEvent(INTENT_EVENT, { defId: this.heroChoice, kind: "join" } satisfies Intent);
      this.joinResendAt = this.time.now + 3000;
    }

    if (this.joinedSelf && this.time.now >= this.joinResendAt) {
      this.joinResendAt = this.time.now + 3000;
      net.sendEvent(INTENT_EVENT, { defId: this.heroChoice, kind: "join" } satisfies Intent);
    }

    if (this.amHost) {
      this.prepareOnlineHost(net);

      if (net.playerId && !this.picks[net.playerId]) {
        this.picks[net.playerId] = this.heroChoice;
      }

      if (this.world.phase !== "ended") {
        this.reconcileOnlineHeroes();
      }

      if (this.rosterChanged(net)) {
        this.publishKeyframe(net);
      }

      this.tickHost(deltaMs);
      this.netFx.push(...this.world.fx.slice(this.fxShipped));
      this.fxShipped = 0;

      if (
        this.world.phase !== this.keyframePhase ||
        performance.now() - this.keyframeAt >= KEYFRAME_MS
      ) {
        this.publishKeyframe(net);
      }

      const me = this.player;

      if (me) {
        this.view.playerTeam = me.team;
      }
    } else {
      this.followHost(net);
    }
  }

  private followHost(net: MultiplayerClient) {
    const { mirror, predictor } = this;

    if (!mirror || !predictor) {
      return;
    }

    this.worldIsSim = false;
    const now = performance.now();
    mirror.frame(now, this.playerId);
    const host = mirror.latest;
    predictor.frame(host?.units.get(this.playerId), host, now);
    predictor.draw(this.world);
    placeFollowers(this.world);

    if (this.restateOrder && net.hostId && this.seated) {
      this.restateOrder = false;
      const { order } = predictor;

      if (order) {
        this.cmd({ kind: "order", order });
      }
    }

    this.watchHostStall(mirror.lastTickAt, now);

    if (this.ended && this.world.phase !== "ended") {
      this.resumeMatch();
    }

    const me = this.player;

    if (me) {
      this.view.playerTeam = me.team;
    }
  }

  private watchHostStall(lastTickAt: number, now: number) {
    if (lastTickAt === 0 || now - lastTickAt < HOST_STALL_MS || this.world.phase === "ended") {
      this.stallShown = false;

      return;
    }

    if (this.stallShown) {
      return;
    }

    this.stallShown = true;
    this.feed.push({
      at: this.time.now,
      kind: "notify",
      priority: "major",
      text: "HOST CONNECTION LOST — WAITING FOR A NEW HOST",
      tone: "bad",
    });
  }

  private updateCamera(dt: number) {
    const me = this.player;

    const fallback =
      this.world.units.get(`${me?.team === "dire" ? "d" : "r"}-ancient`) ??
      this.world.units.get("r-ancient");

    const target = me && me.alive ? (this.poseOf(me.id) ?? me) : fallback;

    if (!target) {
      return;
    }

    const { cam } = this;
    const hw = cam.width / (2 * cam.zoom);
    const hh = cam.height / (2 * cam.zoom);
    const cx = PhaserMath.Clamp(target.x, hw, WORLD.width - hw);
    const cy = PhaserMath.Clamp(target.y, hh, WORLD.height - hh);
    const sx = cx - cam.width / 2;
    const sy = cy - cam.height / 2;

    if (this.followGo) {
      const k = 1 - 0.0001 ** dt;
      cam.setScroll(PhaserMath.Linear(cam.scrollX, sx, k), PhaserMath.Linear(cam.scrollY, sy, k));
    } else {
      cam.setScroll(sx, sy);
      this.followGo = true;
    }

    cam.setScroll(cam.scrollX + this.view.shakeX, cam.scrollY + this.view.shakeY);
    cam.setRotation(this.view.shakeRot);
  }

  private showResult() {
    const me = this.player;
    const h = me?.hero;
    const def = h ? HERO_BY_ID[h.defId] : undefined;
    const { winner } = this.world;
    const common = { duration: this.world.gameTime };

    if (me && h && def && winner) {
      const win = winner === me.team;
      this.result = {
        ...common,
        assists: h.assists,
        deaths: h.deaths,
        denies: h.denies,
        gold: h.gold,
        heroId: h.defId,
        heroName: def.name,
        heroTitle: def.title,
        kills: h.kills,
        kind: "assigned",
        lastHits: h.lastHits,
        level: h.level,
        outcome: win ? "victory" : "defeat",
        role: def.role,
        team: me.team,
        winner,
      };
      sfx.victory(win);
    } else {
      this.result = { ...common, kind: "unassigned", winner };
    }

    this.uiBlocking = true;
    this.pad?.destroy();
    this.pad = null;
  }

  /** Only the simulating client can start the next match; a promoted guest
   *  earns the button while it sits on the result screen. */
  get canReplay() {
    return this.result !== null && this.amHost;
  }

  /** Result buttons share their existing once-click/40ms response in Hud. */
  leaveResult(action: "again" | "menu") {
    if (!this.result || (action === "again" && !this.canReplay)) {
      return;
    }

    if (action === "again") {
      if (this.online) {
        this.rematch();
      } else {
        this.scene.stop("Hud");
        this.scene.start("Game", { heroId: this.heroChoice, online: false });
      }
    } else {
      this.net?.destroy();
      this.scene.stop("Hud");
      this.scene.start("Menu");
    }
  }

  private rematch() {
    restoreHostState(this.world, null);
    this.assign = {};
    this.netFx = [];
    this.fxShipped = 0;
    this.acks.clear();
    this.prevPos.clear();
    this.acc = 0;
    this.hostClock = null;

    if (this.net) {
      this.publishKeyframe(this.net);
    }

    this.resumeMatch();
  }

  private resumeMatch() {
    this.result = null;
    this.ended = false;
    this.uiBlocking = false;
    this.followGo = false;

    if (!this.pad) {
      this.bindPad();
    }

    this.scene.stop("Hud");
    this.scene.launch("Hud", { game: this });
  }

  private playScore() {
    const h = this.player?.hero;

    return h
      ? Math.round(this.damageDealt) +
          h.lastHits * 50 +
          h.denies * 25 +
          h.kills * 500 +
          h.assists * 200
      : 0;
  }

  diagnostics() {
    const me = this.player;
    const h = me?.hero;

    return {
      complete: this.world.phase === "ended",
      entities: this.world.units.size,
      frame: this.game.loop.frame,
      fx: this.view.fxCounts(),
      phase: this.world.phase,
      player: me
        ? {
            alive: me.alive,
            hp: Math.round(me.hp),
            hpPct: Math.round((me.hp / me.maxHp) * 100) / 100,
            level: h?.level ?? 1,
            mp: Math.round(me.mp),
            respawnInSec: me.alive || !h ? 0 : Math.ceil((h.respawnAt - this.world.now) / 1000),
            x: Math.round(me.x),
            y: Math.round(me.y),
          }
        : undefined,
      score: this.playScore() - this.scoreBaseline,
      stats: h
        ? {
            assists: h.assists,
            damageDealt: Math.round(this.damageDealt),
            deaths: h.deaths,
            gold: Math.floor(h.gold),
            kills: h.kills,
            lastHits: h.lastHits,
          }
        : undefined,
      ...(me ? this.sense(this.world, me, this.cam.worldView) : undefined),
    };
  }

  private installDebug() {
    Object.assign(window, {
      __moba: {
        cast: (key: AbilityKey, point?: { x: number; y: number }, targetId?: string) => {
          const me = this.player;

          if (me) {
            castAbility(this.world, me, { key, point, targetId });
          }
        },
        encode: () => encodeWorld(this.world),
        kill: (id: string) => {
          const u = this.world.units.get(id);

          if (!u) {
            return;
          }

          if (u.structure) {
            u.structure.attackable = true;
          }

          dealDamage(this.world, this.player ?? null, u, 1e9, "pure", {});
        },
        netcode: () => ({
          correction: this.predictor?.correction ?? null,
          predicted: this.predictor?.hero
            ? { x: this.predictor.hero.x, y: this.predictor.hero.y }
            : null,
          synced: this.net?.serverClock.synced ?? false,
        }),
        online: () => {
          const { net } = this;

          return net
            ? {
                hostId: net.hostId,
                id: net.playerId,
                isHost: net.isHost,
                players: Object.keys(net.players),
                status: net.connectionStatus,
              }
            : null;
        },
        order: (o: Order) => {
          const me = this.player;

          if (me) {
            issueOrder(this.world, me, o);
          }
        },
        player: () => this.player,
        scene: this,
        step: (n: number) => {
          for (let i = 0; i < n; i += 1) {
            step(this.world, SIM_DT);
          }
        },
        world: this.world,
      },
    });
  }
}
