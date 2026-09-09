import { PhysicalGamepad, attachVirtualGamepad } from "@vibedgames/gamepad/phaser";
import type { PadButton, StickState } from "@vibedgames/gamepad/phaser";
import { createTouchControls, isOfflineRequested } from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import { SIM_DT, SNAPSHOT_HZ, TEAMS } from "../data/config";
import type { Team } from "../data/config";
import { HEROES, HERO_BY_ID } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import { ELEV_LIFT, WORLD, elevationFrac } from "../data/map";
import { autoLevel, castAbility, levelAbility, useItem } from "../sim/abilities";
import { dealDamage, isEnemy } from "../sim/combat";
import { dist2 } from "../sim/math";
import type { Vec2 } from "../sim/math";
import { buyItem, createWorld, dashHero, issueOrder, spawnHero, step } from "../sim/world";
import type { Order, Unit, World } from "../sim/types";
import {
  isMuted,
  resetSound,
  resumeAudio,
  setMuted,
  sfx,
  toggleMute,
  updateSoundscape,
} from "../render/audio";
import { readSoundscape } from "../render/score";
import { structureAnnouncement } from "../render/objective-guidance";
import { presentationSettings, watchPresentationSettings } from "../render/presentation-settings";
import { WorldView } from "../render/view";
import {
  INTENT_EVENT,
  MULTIPLAYER_HOST,
  PARTY,
  parseIntent,
  roomFromLocation,
} from "../net/protocol";
import type { Intent } from "../net/protocol";
import { restoreHostState } from "../net/host-state";
import type { OnlineSeat } from "../net/host-state";
import {
  applySnapshot,
  emptyGuestWorld,
  encodeWorld,
  sharedFxBatch,
  sharedFxSeq,
  sharedSnapshot,
} from "../net/snapshot";
import type { Snapshot } from "../net/snapshot";
import type { JsonValue } from "../net/json";

const TEAM_SIZE = 3;
// A slow frame owes the sim its full wall time, else a laggy host's world
// crawls for every guest. Both caps bound the burst so a machine that cannot
// keep up degrades to slow motion instead of spiralling into longer frames.
const SIM_CATCHUP_S = 0.2;
const SIM_STEPS_MAX = 6;
// Guests: snapshots that stop advancing for this long get a banner. The server
// migrates host after 6s without the host's heartbeat, so this is the warning
// before the switch, not a takeover (only the elected host may write state).
const HOST_STALL_MS = 4000;

// The shared pause/mute cluster's stock corner is top-right, which the compact
// HUD already spends on the team-score capsule — so a portrait phone drops it
// into a column underneath. Colours echo the HUD's carved-bronze buttons.
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

// Keyboard-first scheme with hands split so nothing overlaps: MOVE with the arrow
// keys (right hand), ABILITIES on Q/W/E/R (left hand), F = dash, Space = attack.
const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
const DASH_KEY = "F";
export const SLOT_LABEL = { Q: "Q", W: "W", E: "E", R: "R" } satisfies Record<AbilityKey, string>;

// Physical pad: face buttons cast (A is the attack button, so R lands on RB).
const PAD_CAST: readonly (readonly [PadButton, AbilityKey])[] = [
  ["x", "Q"],
  ["y", "W"],
  ["b", "E"],
  ["rb", "R"],
];

/** Quantize a stick to 16 headings so analog wobble doesn't re-send the
 *  change-detected order every frame. Null while idle / in the dead zone. */
function stickDir16(s: StickState): { dx: number; dy: number } | null {
  if (!s.active || s.inDeadZone) return null;
  const a = (Math.round(s.angle / (Math.PI / 8)) * Math.PI) / 8;
  return {
    dx: Math.abs(Math.cos(a)) < 1e-6 ? 0 : Math.cos(a),
    dy: Math.abs(Math.sin(a)) < 1e-6 ? 0 : Math.sin(a),
  };
}

export type ObjectiveNotice = {
  kind: "notify";
  text: string;
  tone: "good" | "bad" | "neutral";
  priority: "objective" | "major" | "ending";
  at: number;
};
export type FeedEntry =
  | { kind: "kill"; killer: string; victim: string; team: Team; at: number }
  | ObjectiveNotice;

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

export class GameScene extends Phaser.Scene {
  private world!: World;
  private view!: WorldView;
  private playerId = "";
  private acc = 0;
  private hostClock: number | null = null;
  private labelTimer = 0;
  private cam!: Phaser.Cameras.Scene2D.Camera;
  private followGo = false;
  private heroChoice = "ironvow";
  private ended = false;
  private result: MatchResult | null = null;
  private hitStopUntil = 0; // brief sim freeze on nearby hero kills (game feel)
  private inputPaused = false;
  private needsPauseHold = false;
  private moveKeys: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key> | null =
    null;
  private pad: ReturnType<typeof attachVirtualGamepad> | null = null;
  private touchControls: TouchControls | null = null;
  // Physical controller — polled once per frame here (before the HUD's update,
  // which reads it for shop/scoreboard buttons; the Hud scene updates after us).
  readonly physPad = new PhysicalGamepad();
  private lastDir = { dx: 0, dy: 0 };
  private aimDir = { x: 1, y: 0 }; // last movement direction — drives keyboard ability aim
  uiBlocking = false; // set by the HUD while a modal (shop) is open — pauses hero input
  // kill feed / announcements drained from world.fx for the HUD (which reads them
  // before the WorldView clears world.fx each frame)
  readonly feed: FeedEntry[] = [];

  // multiplayer
  private online = false;
  private net: MultiplayerClient | null = null;
  private picks: Record<string, string> = {}; // connId -> defId (host)
  private assign: Record<string, OnlineSeat> = {}; // stable team/slot per conn (host)
  private joinedSelf = false;
  private snapAcc = 0;
  private netFx: World["fx"] = [];
  private fxSeqOut = 0; // host: increments per fx broadcast
  private inheritedFxCount = 0; // accepted old-host FX for this renderer only
  private lastFxSeq = -1; // guest: last fx batch ingested
  // The server owns election. A disconnected/demoted client must adopt the
  // shared snapshot again before it may simulate, even with the same id.
  private adoptedHost = false;
  private joinResendAt = 0;
  // The SDK keeps its shared-state mirror across a transport drop and, on
  // reconnect, only overlays what the server still holds. A snapshot object
  // that survives the round trip is therefore our pre-drop copy, not the
  // room's — never re-adopt it as authority.
  private staleSnap: Snapshot | null = null;
  private lastSnapSeq = -1;
  private snapStalledAt = Infinity;

  constructor() {
    super("Game");
  }

  init(data: { heroId?: string; online?: boolean }): void {
    if (data?.heroId) this.heroChoice = data.heroId;
    // The one choke point for online mode — both the lobby's PLAY ONLINE
    // button and the `?online=1` deep link arrive here, so `?offline=1` is
    // enforced once and no socket can be opened behind it.
    this.online = !!data?.online && !isOfflineRequested();
  }

  /** Reset every mutable per-match field (the scene instance is reused on restart). */
  private resetMatchState(): void {
    resetSound();
    this.result = null;
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
    this.uiBlocking = false;
    this.net = null;
    this.picks = {};
    this.assign = {};
    this.joinedSelf = false;
    this.snapAcc = 0;
    this.netFx = [];
    this.fxSeqOut = 0;
    this.lastFxSeq = -1;
    this.inheritedFxCount = 0;
    this.adoptedHost = false;
    this.joinResendAt = 0;
    this.staleSnap = null;
    this.lastSnapSeq = -1;
    this.snapStalledAt = Infinity;
    this.feed.length = 0;
    this.moveKeys = null;
  }

  create(): void {
    // Phaser reuses the scene instance across restarts (PLAY AGAIN / menu round-trips),
    // so reset all mutable per-match state here — otherwise stale fields (e.g. `ended`)
    // leak into the next match. See memory: phaser4-scene-instance-reuse.
    this.resetMatchState();

    this.view = new WorldView(this);
    this.view.buildTerrain();
    this.view.buildStructures();

    this.cam = this.cameras.main;
    this.cam.roundPixels = true;
    this.cam.setBackgroundColor("#0a0e16");
    this.applyZoom();
    const stopPresentationSettings = watchPresentationSettings(() => this.applyZoom());
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyZoom, this);

    if (this.online) this.startOnline();
    else this.startLocal();

    this.bindInput();
    this.bindTouch();
    // The menu's confirm press must not become the first attack.
    this.dropInputEdges();
    this.scene.launch("Hud", { game: this });
    if (import.meta.env.DEV) {
      this.installDebug();
      // ?at=x,y drops the player at a world point on spawn so headless captures can
      // frame any region (terrain plateaus etc.) deterministically.
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

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      stopPresentationSettings();
      resetSound();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.applyZoom, this);
      this.pad?.destroy();
      this.pad = null;
      this.touchControls?.destroy();
      this.touchControls = null;
      this.physPad.destroy();
      this.net?.destroy();
      this.net = null;
    });

    const veil = document.getElementById("veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 600);
    }
  }

  // ---- modes ---------------------------------------------------------------
  private startLocal(): void {
    this.world = createWorld(1234);
    const player = spawnHero(this.world, this.heroChoice, "radiant", "you", false, 0);
    this.playerId = player.id;
    this.view.playerHeroId = player.id;
    this.view.playerTeam = player.team;
    pickRoster(this.heroChoice, TEAM_SIZE)
      .slice(1)
      .forEach((id, i) => spawnHero(this.world, id, "radiant", `botR${i}`, true, i + 1));
    pickRoster("emberhex", TEAM_SIZE).forEach((id, i) =>
      spawnHero(this.world, id, "dire", `botD${i}`, true, i),
    );
  }

  private startOnline(): void {
    // guests render this; the host overwrites its own with a real sim world
    this.world = emptyGuestWorld();
    this.net = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: PARTY,
      room: roomFromLocation(),
      onEvent: (event, payload, from) =>
        // SAFETY: event payloads arrive as JSON websocket frames (or a local
        // echo of a JSON-safe send), so JsonValue covers every possible value.
        this.onNetEvent(event, payload as JsonValue, from),
    });
    const net = this.net;
    net.subscribe(() => {
      if (net.connectionStatus !== "connected" || !net.isHost) this.adoptedHost = false;
      if (net.connectionStatus === "connected") return;
      this.joinedSelf = false;
      this.staleSnap = sharedSnapshot(net.sharedState);
    });
  }

  /** The one host/guest decision: offline always simulates; online, only the
   *  connected, server-elected client does. */
  private get amHost(): boolean {
    return !this.online || (this.net?.connectionStatus === "connected" && this.net.isHost);
  }

  /** Whether this client may act: offline, or connected under the seat its
   *  hero was spawned for (a reconnect can hand out a new id). */
  private get seated(): boolean {
    if (!this.online) return true;
    const net = this.net;
    return net?.connectionStatus === "connected" && this.playerId === `h-${net.playerId}`;
  }

  /** The room's current snapshot, or null when the mirror only holds our own
   *  pre-drop copy (see staleSnap). */
  private roomSnapshot(net: MultiplayerClient): Snapshot | null {
    const snap = sharedSnapshot(net.sharedState);
    return snap === this.staleSnap ? null : snap;
  }

  /**
   * True in online mode (a peer may be connected or join any moment) — used by
   * the wrapper's pause handler so it never freezes a session other players
   * are relying on.
   */
  isOnline(): boolean {
    return this.online;
  }

  // ---- networking ----------------------------------------------------------
  private onNetEvent(event: string, payload: JsonValue, from: string): void {
    if (event !== INTENT_EVENT) return;
    const intent = parseIntent(payload);
    if (!intent) return; // drop malformed / version-skewed peer messages
    // Retain choices as a guest so an elected host can seat pending joins.
    if (intent.kind === "join") {
      this.picks[from] = intent.defId;
      // A newcomer to a finished match would otherwise spectate the result
      // until the last finisher leaves the room.
      if (this.amHost && this.world.phase === "ended" && !this.world.units.has(`h-${from}`))
        this.rematch();
      return;
    }
    if (!this.amHost) return; // only the server-elected host applies intents
    if (this.net) this.prepareOnlineHost(this.net);
    if (this.world.phase === "ended") return;
    const u = this.world.units.get(`h-${from}`);
    if (!u || !u.alive) return;
    this.applyIntent(u, intent);
  }

  private applyIntent(u: Unit, intent: Intent): void {
    switch (intent.kind) {
      case "order":
        issueOrder(this.world, u, intent.order);
        break;
      case "cast":
        castAbility(this.world, u, {
          key: intent.key,
          point: intent.point,
          targetId: intent.targetId,
        });
        break;
      case "level":
        levelAbility(u, intent.key);
        break;
      case "buy":
        buyItem(this.world, u, intent.itemId);
        break;
      case "useItem": {
        const id = u.hero?.items[intent.slot];
        if (id) useItem(this.world, u, id, intent.point);
        break;
      }
      case "dash":
        dashHero(this.world, u, intent.dx, intent.dy);
        break;
      case "join":
        break;
    }
  }

  /** Host: ensure a hero exists per connected human + fill teams with bots.
   * Team/slot assignment is STABLE per connection (balanced on first sight) so a
   * later join never reshuffles existing players. A human's hero waits until we
   * know their pick (the join intent), so nobody spawns as the wrong hero. */
  private reconcileOnlineHeroes(): void {
    if (!this.net) return;
    const ids = Object.keys(this.net.players);
    const want = new Set<string>();
    const occupied = {
      radiant: new Set<number>(),
      dire: new Set<number>(),
    } satisfies Record<Team, Set<number>>;
    // Reclaim only departed seats; existing heroes retain their original slots.
    for (const id of Object.keys(this.assign)) if (!ids.includes(id)) delete this.assign[id];

    // assign newcomers to the lighter team, stably
    for (const id of ids) {
      if (!this.assign[id]) {
        const counts = { radiant: 0, dire: 0 };
        for (const a of Object.values(this.assign)) counts[a.team]++;
        const team: Team = counts.radiant <= counts.dire ? "radiant" : "dire";
        const used = new Set(
          Object.values(this.assign)
            .filter((seat) => seat.team === team)
            .map((seat) => seat.slot),
        );
        let slot = 0;
        while (used.has(slot)) slot++;
        this.assign[id] = { team, slot };
      }
    }

    for (const id of ids) {
      const a = this.assign[id];
      if (!a) continue; // assigned just above for every id; guards the index type
      occupied[a.team].add(a.slot);
      const hid = `h-${id}`;
      const pick = this.picks[id];
      if (!pick) continue; // wait for their hero choice
      want.add(hid);
      const existing = this.world.units.get(hid);
      if (!existing) {
        spawnHero(this.world, pick, a.team, id, false, a.slot);
      } else if (
        existing.hero &&
        existing.hero.defId !== pick &&
        existing.hero.level === 1 &&
        existing.hero.kills === 0
      ) {
        // pick arrived after a provisional spawn: respawn as the chosen hero
        this.world.units.delete(hid);
        spawnHero(this.world, pick, a.team, id, false, a.slot);
      }
    }
    // bots fill each team to TEAM_SIZE
    for (const team of TEAMS) {
      for (let s = 0; s < TEAM_SIZE; s++) {
        if (occupied[team].has(s)) continue;
        const hid = `h-bot-${team}-${s}`;
        want.add(hid);
        if (!this.world.units.has(hid)) {
          const def =
            pickRoster(team === "radiant" ? "ironvow" : "emberhex", s + 1)[s] ?? "ironvow";
          spawnHero(this.world, def, team, `bot-${team}-${s}`, true, s);
        }
      }
    }
    // remove hero units no longer wanted (departed humans / surplus bots)
    for (const [id, u] of this.world.units) {
      if (u.kind === "hero" && !want.has(id)) this.world.units.delete(id);
    }
  }

  private prepareOnlineHost(net: MultiplayerClient): void {
    if (this.adoptedHost || !this.amHost) return;
    const restored = restoreHostState(this.world, this.roomSnapshot(net));
    this.assign = restored.seats;
    this.picks = { ...this.picks, ...restored.picks };
    this.adoptedHost = true;
    this.fxSeqOut = sharedFxSeq(net.sharedState) ?? 0;
    this.netFx = [];
    this.acc = 0;
    this.hostClock = null;
    this.inheritedFxCount = this.ingestSharedFx(net);
  }

  private ingestSharedFx(net: MultiplayerClient): number {
    const seq = sharedFxSeq(net.sharedState);
    if (seq === null || seq === this.lastFxSeq) return 0;
    this.lastFxSeq = seq;
    const batch = sharedFxBatch(net.sharedState);
    this.world.fx.push(...batch);
    return batch.length;
  }

  // ---- player commands (apply as authority, else send intent) --------------
  private cmd(intent: Intent): void {
    if (this.result) return;
    if (this.inputPaused && !(intent.kind === "order" && intent.order.type === "hold")) return;
    if (!this.seated) return;
    if (this.amHost && this.net) this.prepareOnlineHost(this.net);
    if (this.world.phase === "ended") return;
    if (this.amHost) {
      const me = this.player;
      if (me) this.applyIntent(me, intent);
    } else {
      this.net?.sendEvent(INTENT_EVENT, intent);
    }
  }

  get controlsPaused(): boolean {
    return this.inputPaused;
  }

  /** Drop every held key/touch/button edge. HUD panels and the pause overlay
   *  can eat the matching key-up, which would otherwise leave a phantom hold. */
  private dropInputEdges(): void {
    this.input.keyboard?.resetKeys();
    this.pad?.pad.reset();
    // reset releases held touches; two frames also drain a tap that landed first.
    this.pad?.pad.nextFrame();
    this.pad?.pad.nextFrame();
    // Two samples baseline the controller so the button that closed a panel or
    // resumed play cannot also attack on the next frame.
    this.physPad.update();
    this.physPad.update();
  }

  clearHudInput(): void {
    this.dropInputEdges();
    this.needsPauseHold = true;
    this.flushPauseHold();
  }

  /** The online simulation continues under pause; only this player's input stops. */
  setControlsPaused(paused: boolean): void {
    if (this.inputPaused === paused) return;
    this.inputPaused = paused;
    this.dropInputEdges();
    if (paused) this.needsPauseHold = true;
    this.flushPauseHold();
  }

  private flushPauseHold(): void {
    if (!this.needsPauseHold || !this.seated) return;
    this.cmd({ kind: "order", order: { type: "hold" } });
    this.lastDir = { dx: 0, dy: 0 };
    this.needsPauseHold = false;
  }

  get matchResult(): MatchResult | null {
    return this.result;
  }

  get worldRef(): World {
    return this.world;
  }
  get player(): Unit | undefined {
    return this.playerId ? this.world.units.get(this.playerId) : undefined;
  }
  /** The currently-visible world rectangle, for the minimap viewport box. */
  get cameraView(): Phaser.Geom.Rectangle {
    return this.cam.worldView;
  }
  /** Hand the HUD any feed entries collected since the last frame, then clear. */
  drainFeed(): FeedEntry[] {
    if (this.feed.length === 0) return [];
    const out = this.feed.slice();
    this.feed.length = 0;
    return out;
  }

  private applyZoom(): void {
    // Standard preserves the original framing. Close is an explicit preference
    // for larger heroes, especially on short screens; picking uses this camera.
    const standard = Phaser.Math.Clamp(this.scale.height / 900, 0.55, 1.3);
    this.cam.setZoom(
      presentationSettings().view === "close" ? Math.max(0.82, standard * 1.15) : standard,
    );
  }

  // ---- input ---------------------------------------------------------------
  private bindInput(): void {
    this.input.mouse?.disableContextMenu();
    // Mouse is a full complement to the keyboard scheme (which stays the primary,
    // keyboard-first control): LEFT or RIGHT click moves to the point, or attacks
    // an enemy clicked on. Keyboard steering/abilities remain fully usable.
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      resumeAudio();
      if (p.wasTouch) return; // touches steer the virtual stick, never click-to-move
      if (this.uiBlocking) return; // shop/modal open — ignore world clicks
      if (!(p.leftButtonDown() || p.rightButtonDown())) return;
      // don't move when the click was actually on a HUD widget (minimap, ability
      // bar, item slots, shop) — that scene sits on top and handles its own clicks.
      const hud = this.scene.get("Hud");
      if (hud?.input && hud.input.hitTestPointer(p).length > 0) return;
      this.issueClickOrder(p);
    });

    const kb = this.input.keyboard;
    if (!kb) return;
    // abilities on Q/W/E/R (left hand); Shift/Ctrl + key levels it
    for (const key of ABILITY_KEYS) {
      kb.on(`keydown-${key}`, (e: KeyboardEvent) => {
        if (e.shiftKey || e.ctrlKey) this.levelSlot(key);
        else this.castSlot(key);
      });
    }
    kb.on(`keydown-${DASH_KEY}`, () => this.dash());
    kb.on("keydown-H", () => this.cmd({ kind: "order", order: { type: "fountain" } }));
    ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"].forEach((code, i) => {
      kb.on(`keydown-${code}`, () => this.useItemSlot(i));
    });
    kb.on("keydown-M", () => {
      toggleMute();
      resumeAudio();
      this.touchControls?.sync();
    });

    // Movement: arrow keys (right hand, held). Space = basic attack. Camera follows.
    const KC = Phaser.Input.Keyboard.KeyCodes;
    this.moveKeys = {
      up: kb.addKey(KC.UP, true),
      down: kb.addKey(KC.DOWN, true),
      left: kb.addKey(KC.LEFT, true),
      right: kb.addKey(KC.RIGHT, true),
    };
    kb.on("keydown-SPACE", (e: KeyboardEvent) => {
      e.preventDefault?.();
      this.spaceAttack();
    });
  }

  /** Touch controls: a floating stick steers (mirroring the arrow-key order
   *  stream); any second finger on the battlefield is a basic attack. Taps on
   *  HUD widgets never reach the pad — the HUD scene sits above this one and
   *  captures touches on its interactive objects. */
  private bindTouch(): void {
    this.bindPad();
    // Pause is Escape-bound and mute is M-bound, so without this a phone player
    // cannot leave the match and never learns the game has sound.
    this.touchControls = createTouchControls({
      className: "moba-touch",
      css: TOUCH_CONTROLS_CSS,
      styleId: "moba-touch-controls",
      mute: {
        get: () => isMuted(),
        set: (next) => {
          setMuted(next);
          resumeAudio();
        },
      },
    });
  }

  private bindPad(): void {
    this.pad = attachVirtualGamepad(this, {
      buttons: [{ id: "attack" }], // rest button: any non-stick finger attacks
      // above the y-sorted world (unit depth = y, up to WORLD.height); the HUD
      // scene still renders over it
      render: { depth: 50000, blendMode: Phaser.BlendModes.NORMAL },
      onFirstTouch: () => resumeAudio(),
    });
  }

  /** Poll held arrow keys / the virtual stick and stream a direction order when
   *  it changes. */
  private pollMovement(): void {
    if (this.inputPaused || this.needsPauseHold) return;
    // Keep the last accepted keyboard direction during a transport gap. A
    // release must send HOLD on return; unchanged idle must preserve mouse orders.
    if (!this.seated) return;
    const me = this.player;
    // while dead/unspawned or a modal (shop) is open, forget the last direction so a
    // still-held key re-fires a fresh order the moment control returns.
    if (!me || !me.alive || this.uiBlocking) {
      if (this.uiBlocking && (this.lastDir.dx !== 0 || this.lastDir.dy !== 0))
        this.cmd({ kind: "order", order: { type: "hold" } });
      this.lastDir = { dx: 0, dy: 0 };
      return;
    }
    const k = this.moveKeys;
    let dx = 0;
    let dy = 0;
    if (k) {
      if (k.left.isDown) dx -= 1;
      if (k.right.isDown) dx += 1;
      if (k.up.isDown) dy -= 1;
      if (k.down.isDown) dy += 1;
    }
    // physical dpad: 4-way (diagonals via two buttons), same as the arrows
    if (dx === 0 && dy === 0 && this.physPad.connected) {
      if (this.physPad.isButtonDown("left")) dx -= 1;
      if (this.physPad.isButtonDown("right")) dx += 1;
      if (this.physPad.isButtonDown("up")) dy -= 1;
      if (this.physPad.isButtonDown("down")) dy += 1;
    }
    if (dx === 0 && dy === 0) {
      // touch stick, then the physical left stick — both stream the same
      // 16-heading quantized order the arrows do
      const d =
        (this.pad ? stickDir16(this.pad.getStick()) : null) ?? stickDir16(this.physPad.getStick());
      if (d) {
        dx = d.dx;
        dy = d.dy;
      }
    }
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      this.aimDir = { x: dx / len, y: dy / len }; // remember facing for keyboard ability aim
    }
    if (dx === this.lastDir.dx && dy === this.lastDir.dy) return; // only on change
    this.lastDir = { dx, dy };
    if (dx === 0 && dy === 0) this.cmd({ kind: "order", order: { type: "hold" } });
    else this.cmd({ kind: "order", order: { type: "moveDir", dx, dy } });
  }

  /** Controller buttons: A attacks (Space), X/Y/B/RB cast (HUD-style auto-aim —
   *  a pad has no cursor), RT dashes (F). SELECT/START live in the HUD, which
   *  reads this pad after our update. The command handlers guard uiBlocking, so
   *  while the shop is open A falls through to the HUD's buy instead. */
  private pollPadButtons(): void {
    if (!this.physPad.connected) return;
    if (this.physPad.justPressed("a")) this.spaceAttack();
    for (const [btn, key] of PAD_CAST) {
      if (this.physPad.justPressed(btn)) this.castSlot(key, true);
    }
    if (this.physPad.justPressed("rt")) this.dash();
  }

  private spaceAttack(): void {
    const me = this.player;
    if (!me || !me.alive || this.uiBlocking) return;
    const target = this.nearestAttackTarget(me, 750);
    if (target) this.cmd({ kind: "order", order: { type: "attackUnit", targetId: target.id } });
  }

  /** Quick dodge in the held/facing direction (host validates the cooldown).
   *  Public: the HUD dash box taps it too. */
  dash(): void {
    const me = this.player;
    if (!me || !me.alive || this.uiBlocking) return;
    const moving = this.lastDir.dx !== 0 || this.lastDir.dy !== 0;
    const dx = moving ? this.lastDir.dx : this.aimDir.x;
    const dy = moving ? this.lastDir.dy : this.aimDir.y;
    this.cmd({ kind: "dash", dx, dy });
  }

  /** Pull kill/announce events out of world.fx for the HUD before the view drains them. */
  private collectFeed(): void {
    const now = this.time.now;
    const me = this.player;
    for (const fx of this.world.fx) {
      if (fx.t === "kill")
        this.feed.push({
          kind: "kill",
          killer: fx.killer,
          victim: fx.victim,
          team: fx.team,
          at: now,
        });
      else if (fx.t === "notify")
        this.feed.push({
          kind: "notify",
          text: fx.text,
          tone: fx.tone,
          priority: "objective",
          at: now,
        });
      else if (fx.t === "structureDown") {
        this.feed.push({
          kind: "notify",
          ...structureAnnouncement(this.world, fx, me?.team ?? null),
          at: now,
        });
      } else if (
        fx.t === "death" &&
        fx.kind === "hero" &&
        !this.online &&
        me &&
        dist2(me, fx) < 900 * 900
      ) {
        // hit-stop: a beat of frozen sim when a hero dies near you sells the kill.
        // Local only — online the host freezing its sim would stall every client.
        this.hitStopUntil = now + 110;
      }
    }
    if (this.feed.length > 40) this.feed.splice(0, this.feed.length - 40);
  }

  /** HUD button: return to the fountain (same as the H key). */
  recall(): void {
    this.cmd({ kind: "order", order: { type: "fountain" } });
  }

  /** HUD minimap → world: order the hero to travel to a clicked map point. */
  moveToWorldPoint(x: number, y: number): void {
    const me = this.player;
    if (!me || !me.alive) return;
    this.lastDir = { dx: 0, dy: 0 };
    this.cmd({ kind: "order", order: { type: "attackMove", to: { x, y } } });
  }

  private nearestAttackTarget(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestD = range * range;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive) continue;
      if (u.kind === "structure" && !u.structure?.attackable) continue;
      if (u.statuses.some((s) => s.kind === "untargetable")) continue;
      const d = dist2(me, u);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private issueClickOrder(p: Phaser.Input.Pointer): void {
    const me = this.player;
    if (!me || !me.alive) return;
    this.lastDir = { dx: 0, dy: 0 }; // a mouse order supersedes held-key steering
    const wp = this.cam.getWorldPoint(p.x, p.y);
    const enemy = this.unitAt(wp.x, wp.y, (u) => isEnemy(me, u) && u.alive);
    if (enemy) this.cmd({ kind: "order", order: { type: "attackUnit", targetId: enemy.id } });
    else this.cmd({ kind: "order", order: { type: "move", to: { x: wp.x, y: wp.y } } });
  }

  /** Cast an ability, aimed at the mouse cursor (any direction, incl. diagonals).
   *  Keyboard players who steer with the arrow keys free-aim along their facing.
   *  `fromHud` marks casts tapped on a HUD slot — there the pointer sits on the
   *  button, not the battlefield, so aim at the nearest enemy / along facing. */
  castSlot(key: AbilityKey, fromHud = false): void {
    const me = this.player;
    if (!me || !me.alive || !me.hero || this.uiBlocking) return;
    const def = HERO_BY_ID[me.hero.defId]?.abilities[key];
    if (!def) return;
    const cursor = this.cam.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);
    if (def.targeting === "unit") {
      const wantAlly = def.effect === "brewkeeper:Q";
      // prefer the unit under the cursor; fall back to the obvious auto-target
      const hovered = fromHud
        ? undefined
        : this.unitAt(cursor.x, cursor.y, (u) =>
            wantAlly ? !isEnemy(me, u) && u.kind === "hero" && u.alive : isEnemy(me, u) && u.alive,
          );
      const target =
        hovered ??
        (wantAlly
          ? (this.lowestAllyInRange(me, def.castRange) ?? me)
          : this.nearestEnemy(me, def.castRange));
      if (target) this.cmd({ kind: "cast", key, targetId: target.id });
    } else if (def.targeting === "point") {
      const r = def.castRange;
      let point: Vec2;
      if (r <= 0) {
        point = { x: me.x, y: me.y }; // self-centred (e.g. Last Call)
      } else if (fromHud) {
        point = this.touchAimPoint(me, r);
      } else if (this.lastDir.dx !== 0 || this.lastDir.dy !== 0) {
        // keyboard/stick steering: fire along the direction you're holding
        point = { x: me.x + this.aimDir.x * r, y: me.y + this.aimDir.y * r };
      } else {
        // aim at the cursor, clamped to cast range
        const dx = cursor.x - me.x;
        const dy = cursor.y - me.y;
        const d = Math.hypot(dx, dy);
        point = d > r && d > 0 ? { x: me.x + (dx / d) * r, y: me.y + (dy / d) * r } : cursor;
      }
      this.cmd({ kind: "cast", key, point });
    } else {
      this.cmd({ kind: "cast", key });
    }
  }

  /** Aim for HUD-tapped point casts: the nearest enemy hero in range, else any
   *  nearest enemy, else along the movement facing at full range. */
  private touchAimPoint(me: Unit, r: number): Vec2 {
    const foe = this.nearestEnemyHero(me, r) ?? this.nearestEnemy(me, r);
    if (foe) return { x: foe.x, y: foe.y };
    return { x: me.x + this.aimDir.x * r, y: me.y + this.aimDir.y * r };
  }

  private nearestEnemyHero(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestD = range * range;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive || u.kind !== "hero") continue;
      const d = dist2(me, u);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  levelSlot(key: AbilityKey): void {
    this.cmd({ kind: "level", key });
  }

  private lowestAllyInRange(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestPct = 1.01;
    const r2 = range * range;
    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || !u.alive || isEnemy(me, u)) continue;
      if (dist2(me, u) > r2) continue;
      const pct = u.hp / u.maxHp;
      if (pct < bestPct) {
        bestPct = pct;
        best = u;
      }
    }
    return best;
  }

  private useItemSlot(i: number, fromHud = false): void {
    const me = this.player;
    if (!me?.hero?.items[i]) return;
    if (fromHud) {
      // slot tapped on the HUD: aim point actives (blink) along the movement
      // facing instead of at the tapped button. 600 = the blink range cap.
      const point = { x: me.x + this.aimDir.x * 600, y: me.y + this.aimDir.y * 600 };
      this.cmd({ kind: "useItem", slot: i, point });
      return;
    }
    const p = this.input.activePointer;
    const wp = this.cam.getWorldPoint(p.x, p.y);
    this.cmd({ kind: "useItem", slot: i, point: { x: wp.x, y: wp.y } });
  }

  buyItemForPlayer(id: string): boolean {
    if (this.result || !this.seated) return false;
    if (this.amHost && this.net) this.prepareOnlineHost(this.net);
    if (this.world.phase === "ended") return false;
    const me = this.player;
    if (this.amHost && me) return buyItem(this.world, me, id);
    this.cmd({ kind: "buy", itemId: id });
    return true; // optimistic; host validates
  }
  useItemForPlayer(i: number): void {
    this.useItemSlot(i, true);
  }

  private unitAt(x: number, y: number, pred: (u: Unit) => boolean): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.world.units.values()) {
      if (!pred(u)) continue;
      // structures are clickable attack targets too — but only once their tier
      // gate is open, so a click on a protected tower falls through to a move
      if (u.kind === "structure" && !u.structure?.attackable) continue;
      const r = (u.radius + 28) * (u.radius + 28);
      // units on high ground render lifted, so test against their on-screen position
      const ly = u.y - elevationFrac(u.x, u.y) * ELEV_LIFT;
      const d = dist2({ x, y }, { x: u.x, y: ly });
      if (d <= r && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Mark whoever the player is engaging with the Cursor_04 reticle. Resolves, in
   *  priority: explicit attack order → current swing → the enemy the hero is set to
   *  auto-attack (so it persists between swings) → the enemy under the cursor. */
  private updateTargetReticle(): void {
    const me = this.player;
    if (!me || !me.alive) {
      this.view.setTarget("");
      return;
    }
    let id = "";
    if (me.order.type === "attackUnit") {
      const t = this.world.units.get(me.order.targetId);
      if (t && t.alive && isEnemy(me, t)) id = t.id;
    }
    if (!id && me.pendingAttack) {
      const t = this.world.units.get(me.pendingAttack.targetId);
      if (t && t.alive && isEnemy(me, t)) id = t.id;
    }
    // auto-attack acquisition: while holding/idle/attack-moving the hero attacks the
    // nearest enemy in range — keep the reticle pinned to it the whole time.
    if (
      !id &&
      (me.order.type === "idle" || me.order.type === "hold" || me.order.type === "attackMove")
    ) {
      const t = this.engageTarget(me);
      if (t) id = t.id;
    }
    if (!id) {
      const p = this.input.activePointer;
      const wp = this.cam.getWorldPoint(p.x, p.y);
      const hov = this.unitAt(wp.x, wp.y, (u) => isEnemy(me, u) && u.alive);
      if (hov) id = hov.id;
    }
    this.view.setTarget(id);
  }

  /** Nearest enemy within auto-attack reach (mirrors the sim's acquire range). */
  private engageTarget(me: Unit): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive) continue;
      if (u.kind === "structure" && !u.structure?.attackable) continue;
      if (u.statuses.some((s) => s.kind === "untargetable")) continue;
      const reach = me.attackRange + me.radius + u.radius + 30;
      const d = dist2(me, u);
      if (d <= reach * reach && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private nearestEnemy(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestD = range * range;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive || u.kind === "structure") continue;
      const d = dist2(me, u);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  // ---- loop ----------------------------------------------------------------
  override update(_t: number, deltaMs: number): void {
    const dt = Math.min(0.05, deltaMs / 1000);
    this.pad?.update(); // reconcile stale touches + publish press edges
    this.flushPauseHold();
    if (!this.inputPaused && this.pad?.justPressed("attack")) this.spaceAttack();
    this.physPad.update(); // poll the controller + publish press edges
    if (!this.inputPaused) this.pollPadButtons();
    this.pollMovement();
    if (this.online) this.tickOnline(dt, deltaMs);
    else this.tickHost(deltaMs);
    this.flushPauseHold();

    this.collectFeed();
    this.updateTargetReticle();
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

  private tickHost(deltaMs: number): void {
    if (this.time.now < this.hitStopUntil) return; // hit-stop: hold the sim a beat
    // Phaser clamps delta to one frame while the window is unfocused, and a
    // background tab's rAF runs at ~1 Hz, so the host's world would crawl
    // for every guest. Owe the sim wall time instead, capped like any hitch.
    const now = performance.now();
    const elapsed = this.hostClock === null ? deltaMs : now - this.hostClock;
    this.hostClock = now;
    this.acc += Math.min(SIM_CATCHUP_S, elapsed / 1000);
    let steps = 0;
    while (this.acc >= SIM_DT && steps < SIM_STEPS_MAX) {
      step(this.world, SIM_DT);
      this.acc -= SIM_DT;
      steps++;
    }
    const me = this.player;
    if (this.world.phase === "playing" && me?.hero && me.hero.abilityPoints > 0)
      autoLevel(this.world, me);
  }

  private tickOnline(dt: number, deltaMs: number): void {
    const net = this.net;
    if (!net || net.connectionStatus !== "connected") return;
    // announce our hero pick once
    if (!this.joinedSelf && net.playerId) {
      this.joinedSelf = true;
      const playerId = `h-${net.playerId}`;
      if (this.playerId !== playerId) this.lastDir = { dx: 0, dy: 0 };
      this.playerId = playerId;
      this.view.playerHeroId = this.playerId;
      net.sendEvent(INTENT_EVENT, { kind: "join", defId: this.heroChoice } satisfies Intent);
      this.joinResendAt = this.time.now + 3000;
    }
    // periodically re-announce our pick so a host that joined/took over after us
    // still learns which hero to spawn for us.
    if (this.joinedSelf && this.time.now >= this.joinResendAt) {
      this.joinResendAt = this.time.now + 3000;
      net.sendEvent(INTENT_EVENT, { kind: "join", defId: this.heroChoice } satisfies Intent);
    }

    if (this.amHost) {
      this.prepareOnlineHost(net);
      // ensure host's own pick recorded
      if (net.playerId && !this.picks[net.playerId]) this.picks[net.playerId] = this.heroChoice;
      if (this.world.phase !== "ended") this.reconcileOnlineHeroes();
      this.tickHost(deltaMs);
      // capture the fx this step produced BEFORE our own renderer drains them in
      // view.sync() — the sim's hits/deaths/casts only exist in world.fx now, so
      // capturing before tickHost (as before) always saw an empty array and guests
      // got no damage numbers, sparks, explosions, or kill feed.
      // A promoted guest may also have an unseen old host batch for its own
      // renderer. Broadcasting that again would replay it on every other peer.
      this.netFx.push(...this.world.fx.slice(this.inheritedFxCount));
      this.inheritedFxCount = 0;
      // set my team for HUD coloring
      const me = this.player;
      if (me) this.view.playerTeam = me.team;
      this.broadcast(dt);
    } else {
      // guest: render the latest snapshot
      const snap = this.roomSnapshot(net);
      if (snap) {
        this.watchHostStall(snap);
        applySnapshot(this.world, snap);
        // the host started a rematch: leave the result screen with it
        if (this.ended && this.world.phase !== "ended") this.resumeMatch();
      }
      // The renderer runs faster than snapshots; consume each batch once.
      this.ingestSharedFx(net);
      const me = this.player;
      if (me) this.view.playerTeam = me.team;
    }
  }

  private watchHostStall(snap: Snapshot): void {
    const now = this.time.now;
    if (snap.seq !== this.lastSnapSeq || snap.phase === "ended") {
      this.lastSnapSeq = snap.seq;
      this.snapStalledAt = now + HOST_STALL_MS;
    } else if (now >= this.snapStalledAt) {
      this.snapStalledAt = Infinity;
      this.feed.push({
        kind: "notify",
        text: "HOST CONNECTION LOST — WAITING FOR A NEW HOST",
        tone: "bad",
        priority: "major",
        at: now,
      });
    }
  }

  private broadcast(dt: number): void {
    this.snapAcc += dt;
    if (this.snapAcc < 1 / SNAPSHOT_HZ) return;
    this.snapAcc = 0;
    this.fxSeqOut += 1;
    this.net?.updateSharedState({
      snap: encodeWorld(this.world),
      fx: this.netFx,
      fxSeq: this.fxSeqOut,
    });
    // Our renderer consumes these same events in this update. Reconnecting or
    // becoming a guest must not play our own last broadcast a second time.
    this.lastFxSeq = this.fxSeqOut;
    this.netFx = [];
  }

  private updateCamera(dt: number): void {
    const me = this.player;
    const fallback =
      this.world.units.get(`${me?.team === "dire" ? "d" : "r"}-ancient`) ??
      this.world.units.get("r-ancient");
    const target = me && me.alive ? me : fallback;
    if (!target) return;
    const cam = this.cam;
    const hw = cam.width / (2 * cam.zoom); // half the VISIBLE world width
    const hh = cam.height / (2 * cam.zoom);
    const cx = Phaser.Math.Clamp(target.x, hw, WORLD.width - hw);
    const cy = Phaser.Math.Clamp(target.y, hh, WORLD.height - hh);
    // Phaser zooms around the viewport midpoint (= scroll + size/2, regardless
    // of zoom), so convert the clamped centre with the UNZOOMED half-size —
    // using hw/hh here pushes the view past the world edge whenever zoom < 1
    // (the black-band-at-the-fountain bug on short/phone viewports).
    const sx = cx - cam.width / 2;
    const sy = cy - cam.height / 2;
    if (!this.followGo) {
      cam.setScroll(sx, sy);
      this.followGo = true;
    } else {
      const k = 1 - Math.pow(0.0001, dt);
      cam.setScroll(Phaser.Math.Linear(cam.scrollX, sx, k), Phaser.Math.Linear(cam.scrollY, sy, k));
    }
    // trauma shake, applied on top of the settled follow (re-based each frame so it
    // never drifts). The WorldView owns the trauma accumulator + decay.
    cam.setScroll(cam.scrollX + this.view.shakeX, cam.scrollY + this.view.shakeY);
    cam.setRotation(this.view.shakeRot);
  }

  private showResult(): void {
    const me = this.player;
    const h = me?.hero;
    const def = h ? HERO_BY_ID[h.defId] : undefined;
    const winner = this.world.winner;
    const common = { duration: this.world.gameTime };
    if (me && h && def && winner) {
      const win = winner === me.team;
      this.result = {
        ...common,
        kind: "assigned",
        outcome: win ? "victory" : "defeat",
        winner,
        team: me.team,
        heroId: h.defId,
        heroName: def.name,
        heroTitle: def.title,
        role: def.role,
        level: h.level,
        kills: h.kills,
        deaths: h.deaths,
        assists: h.assists,
        lastHits: h.lastHits,
        denies: h.denies,
        gold: h.gold,
      };
      sfx.victory(win);
    } else this.result = { ...common, kind: "unassigned", winner };
    this.uiBlocking = true;
    this.pad?.destroy();
    this.pad = null;
  }

  /** Only the simulating client can start the next match; a promoted guest
   *  earns the button while it sits on the result screen. */
  get canReplay(): boolean {
    return this.result !== null && this.amHost;
  }

  /** Result buttons share their existing once-click/40ms response in Hud. */
  leaveResult(action: "again" | "menu"): void {
    if (!this.result || (action === "again" && !this.canReplay)) return;
    if (action === "again") {
      if (this.online) this.rematch();
      else {
        this.scene.stop("Hud");
        this.scene.start("Game", { heroId: this.heroChoice, online: false });
      }
    } else {
      this.net?.destroy();
      this.scene.stop("Hud");
      this.scene.start("Menu");
    }
  }

  /** Host: seed a fresh match in place, keeping every connection's pick so
   *  the next reconcile reseats everyone. Guests follow the phase flip. */
  private rematch(): void {
    restoreHostState(this.world, null);
    this.assign = {};
    this.netFx = [];
    this.inheritedFxCount = 0;
    this.acc = 0;
    this.hostClock = null;
    this.resumeMatch();
  }

  /** Leave the result screen for a match that is playing again. */
  private resumeMatch(): void {
    this.result = null;
    this.ended = false;
    this.uiBlocking = false;
    this.followGo = false;
    if (!this.pad) this.bindPad();
    this.scene.stop("Hud");
    this.scene.launch("Hud", { game: this });
  }

  diagnostics() {
    const me = this.player;
    return {
      frame: this.game.loop.frame,
      phase: this.world.phase,
      player: me ? { x: me.x, y: me.y, hp: me.hp, alive: me.alive } : null,
      score: me?.hero?.gold ?? 0,
      complete: this.world.phase === "ended",
      entities: this.world.units.size,
      fx: this.view.fxCounts(),
    };
  }

  private installDebug(): void {
    Object.assign(window, {
      __moba: {
        scene: this,
        world: this.world,
        player: () => this.player,
        encode: () => encodeWorld(this.world),
        online: () => {
          const net = this.net;
          return net
            ? {
                status: net.connectionStatus,
                id: net.playerId,
                hostId: net.hostId,
                isHost: net.isHost,
                players: Object.keys(net.players),
              }
            : null;
        },
        step: (n: number) => {
          for (let i = 0; i < n; i++) step(this.world, SIM_DT);
        },
        order: (o: Order) => {
          const me = this.player;
          if (me) issueOrder(this.world, me, o);
        },
        cast: (key: AbilityKey, point?: { x: number; y: number }, targetId?: string) => {
          const me = this.player;
          if (me) castAbility(this.world, me, { key, point, targetId });
        },
        kill: (id: string) => {
          const u = this.world.units.get(id);
          if (!u) return;
          // Structures stay protected until their tier falls; a test kill
          // skips the ladder.
          if (u.structure) u.structure.attackable = true;
          dealDamage(this.world, this.player ?? null, u, 1e9, "pure", {});
        },
      },
    });
  }
}

function pickRoster(first: string, n: number): string[] {
  const ids = [first];
  for (const h of HEROES) {
    if (ids.length >= n) break;
    if (!ids.includes(h.id)) ids.push(h.id);
  }
  return ids;
}
