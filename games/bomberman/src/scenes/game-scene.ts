import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { PhysicalGamepad, attachVirtualGamepad, stickDirection4 } from "@vibedgames/gamepad/phaser";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import { BlendModes, Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";
import type { GameObjects } from "phaser";

import {
  baseStats,
  BASE_MOVE_MS,
  BOT_BOMB_CHANCE,
  BOT_MOVE_MS,
  COLORS,
  EXPLOSION_MS,
  FUSE_MS,
  GRID_COLS,
  GRID_ROWS,
  MAX_BOMBS,
  MAX_BOTS,
  MAX_RANGE,
  MIN_MOVE_MS,
  newGrid,
  POWERUP_DROP_CHANCE,
  SPAWN_POINTS,
  SPEED_STEP_MS,
  OFFLINE_FALLBACK_MS,
  TARGET_FIGHTERS,
  TILE,
  tileKey,
  WORLD_H,
  WORLD_W,
} from "../shared/constants";
import type {
  Bomb,
  Bot,
  Cell,
  Dir,
  PlayerStats,
  PowerupKind,
  SharedState,
} from "../shared/constants";
import { buildControls, ensureStyle as ensureControlsStyle } from "../pause-overlay";
import { now as simNow } from "../util/clock";

declare global {
  interface Window {
    /** Dev-console hook (DEV builds only). */
    __bb?: { scene: GameScene; client: MultiplayerClient | undefined };
  }
}

interface PlayerObjs {
  container: GameObjects.Container;
  sprite: GameObjects.Sprite;
  ring: GameObjects.Graphics;
  label: GameObjects.Text;
  marker: GameObjects.Triangle | null;
  col: number;
  row: number;
}

/** A unified view over humans (connections) and bots for rendering + rules. */
interface Fighter {
  id: string;
  col: number;
  row: number;
  colorIdx: number;
  dir: Dir;
  moving: boolean;
  isBot: boolean;
  isLocal: boolean;
  order: number;
}

const DIR_VECT = {
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
} satisfies Record<Dir, [number, number]>;
const DIRS: Dir[] = ["up", "down", "left", "right"];

const POWERUP_KINDS: PowerupKind[] = ["bomb", "fire", "speed"];
const POWERUP_TEX = {
  bomb: "pow-bomb",
  fire: "pow-fire",
  speed: "pow-speed",
} satisfies Record<PowerupKind, string>;
const POWERUP_GLOW = {
  bomb: 0xff_e1_4a,
  fire: 0xff_7a_2a,
  speed: 0x5d_b8_ff,
} satisfies Record<PowerupKind, number>;

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

const ROOM = "bomberman-default";

/** Detected at boot (not on first touch) so the first HUD paint already shows
 *  touch-worded hints on phones. */
export const TOUCH_UI = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

/** Grass extends this far past the arena so the follow camera never shows void. */
const FLOOR_PAD = TILE * 20;

const emptyShared = (): SharedState =>
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over from the previous round.
  ({
    blasts: {},
    bombs: {},
    bots: {},
    deaths: {},
    grid: newGrid(),
    powerups: {},
    startedAt: simNow(),
    stats: {},
    winner: null,
  });

/** JSON value as it comes off the wire — multiplayer payloads are JSON.parse output. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface JsonObject {
  [key: string]: JsonValue;
}
/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = NonNullable<Player["state"]>[string] | undefined;

// Wire-JSON narrowing helpers. Runtime `typeof` is banned by the lint, so these
// use typeof-free checks; JSON can only carry finite numbers, so Number.isFinite
// is the exact number test.
const isJsonObject = (v: WireField): v is JsonObject =>
  Object.prototype.toString.call(v) === "[object Object]";
const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);

const isShared = (v: MultiplayerClient["sharedState"]): v is SharedState =>
  isJsonObject(v) && Array.isArray(v["grid"]);

interface PartialPS {
  col?: number;
  row?: number;
  colorIdx?: number;
  dir?: Dir;
  moving?: boolean;
}

const readPlayerState = (player: Player | undefined): PartialPS => {
  const s = player?.state;
  if (!s) {
    return {};
  }
  const num = (k: string): number | undefined => {
    const v = s[k];
    return isJsonNumber(v) ? v : undefined;
  };
  const dv = s["dir"];
  const dir: Dir | undefined =
    dv === "up" || dv === "down" || dv === "left" || dv === "right" ? dv : undefined;
  const mv = s["moving"];
  return {
    col: num("col"),
    colorIdx: num("colorIdx"),
    dir,
    moving: mv === true || mv === false ? mv : undefined,
    row: num("row"),
  };
};

const rowY = (row: number): number => row * TILE + TILE / 2;
const manhattan = (c1: number, r1: number, c2: number, r2: number): number =>
  Math.abs(c1 - c2) + Math.abs(r1 - r2);
const structuredCloneBots = (bots: Record<string, Bot>) => {
  const out: Record<string, Bot> = {};
  for (const [id, b] of Object.entries(bots)) {
    out[id] = { ...b };
  }
  return out;
};
const randomKind = (): PowerupKind =>
  POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)] ?? "bomb";
/** Is there a bomb on this tile? */
const bombOn = (bombs: Record<string, Bomb>, col: number, row: number): boolean =>
  Object.values(bombs).some((b) => b.col === col && b.row === row);
// ---- module helpers (pure) --------------------------------------------------

const colX = (col: number): number => col * TILE + TILE / 2;
const makeBomb = (ownerId: string, col: number, row: number, range: number): Bomb => {
  const now = simNow();
  return { col, id: `b-${ownerId}-${now}-${col}-${row}`, ownerId, placedAt: now, range, row };
};
const grantPowerup = (stats: PlayerStats, kind: PowerupKind): PlayerStats => {
  switch (kind) {
    case "bomb": {
      return { ...stats, bombs: Math.min(MAX_BOMBS, stats.bombs + 1) };
    }
    case "fire": {
      return { ...stats, range: Math.min(MAX_RANGE, stats.range + 1) };
    }
    case "speed": {
      return { ...stats, speed: Math.max(MIN_MOVE_MS, stats.speed - SPEED_STEP_MS) };
    }
    // no default
  }
};
const computeBlastTiles = (grid: Cell[][], bomb: Bomb) => {
  const tiles: { col: number; row: number }[] = [{ col: bomb.col, row: bomb.row }];
  const crates: { col: number; row: number }[] = [];
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let step = 1; step <= bomb.range; step += 1) {
      const c = bomb.col + dc * step;
      const r = bomb.row + dr * step;
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === "wall") {
        break;
      }
      tiles.push({ col: c, row: r });
      if (cell.kind === "crate") {
        crates.push({ col: c, row: r });
        break;
      }
    }
  }
  return { crates, tiles };
};
const neighborOf = (col: number, row: number, dir: Dir): Neighbor => {
  const [dc, dr] = DIR_VECT[dir];
  return { c: col + dc, dir, key: tileKey(col + dc, row + dr), r: row + dr };
};
/**
 * Breadth-first search for the nearest tile not in `unsafe`, returning the
 * direction of the first step toward it (or null if no safe tile is reachable).
 * Walks only empty, bomb-free tiles. Used both to flee live danger and to
 * vet a prospective bomb's escape route.
 */
const fleeDir = (
  grid: Cell[][],
  bombs: Bomb[],
  col: number,
  row: number,
  unsafe: Set<string>,
): Dir | null => {
  const blocked = (c: number, r: number): boolean =>
    grid[r]?.[c]?.kind !== "empty" || bombs.some((b) => b.col === c && b.row === r);
  const visited = new Set<string>([tileKey(col, row)]);
  let frontier: { c: number; r: number; firstDir: Dir }[] = [];
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;
    const k = tileKey(c, r);
    if (blocked(c, r)) {
      continue;
    }
    visited.add(k);
    if (!unsafe.has(k)) {
      return dir;
    }
    frontier.push({ c, firstDir: dir, r });
  }
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const nextF: { c: number; r: number; firstDir: Dir }[] = [];
    for (const node of frontier) {
      for (const dir of DIRS) {
        const [dc, dr] = DIR_VECT[dir];
        const c = node.c + dc;
        const r = node.r + dr;
        const k = tileKey(c, r);
        if (visited.has(k) || blocked(c, r)) {
          continue;
        }
        visited.add(k);
        if (!unsafe.has(k)) {
          return node.firstDir;
        }
        nextF.push({ c, firstDir: node.firstDir, r });
      }
    }
    frontier = nextF;
  }
  return null;
};
// ---- bot AI helpers ---------------------------------------------------------

const botNeighbors = (s: SharedState, col: number, row: number): Neighbor[] => {
  const out: Neighbor[] = [];
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;
    if (s.grid[r]?.[c]?.kind !== "empty") {
      continue;
    }
    if (Object.values(s.bombs).some((b) => b.col === c && b.row === r)) {
      continue;
    }
    out.push({ c, dir, key: tileKey(c, r), r });
  }
  return out;
};
const adjacentCrate = (grid: Cell[][], col: number, row: number): boolean =>
  DIRS.some((dir) => {
    const [dc, dr] = DIR_VECT[dir];
    return grid[row + dr]?.[col + dc]?.kind === "crate";
  });
const enemyInLine = (
  grid: Cell[][],
  bot: Bot,
  range: number,
  fighters: [string, number, number][],
): boolean => {
  const enemyTiles = new Set(
    fighters.filter(([id]) => id !== bot.id).map(([, c, r]) => tileKey(c, r)),
  );
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    for (let step = 1; step <= range; step += 1) {
      const c = bot.col + dc * step;
      const r = bot.row + dr * step;
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === "wall" || cell.kind === "crate") {
        break;
      }
      if (enemyTiles.has(tileKey(c, r))) {
        return true;
      }
    }
  }
  return false;
};
const nearestEnemy = (
  bot: Bot,
  fighters: [string, number, number][],
): { col: number; row: number } | null => {
  let best: { col: number; row: number } | null = null;
  let bestD = Infinity;
  for (const [id, c, r] of fighters) {
    if (id === bot.id) {
      continue;
    }
    const dd = manhattan(bot.col, bot.row, c, r);
    if (dd < bestD) {
      bestD = dd;
      best = { col: c, row: r };
    }
  }
  return best;
};
const nearestCrate = (
  grid: Cell[][],
  col: number,
  row: number,
): { col: number; row: number } | null => {
  let best: { col: number; row: number } | null = null;
  let bestD = Infinity;
  for (const [r, gr] of grid.entries()) {
    for (const [c, cell] of gr.entries()) {
      if (cell.kind !== "crate") {
        continue;
      }
      const dd = manhattan(col, row, c, r);
      if (dd < bestD) {
        bestD = dd;
        best = { col: c, row: r };
      }
    }
  }
  return best;
};
const moveBot = (bot: Bot, to: Neighbor | null, now: number): void => {
  if (!to) {
    bot.moving = false;
    bot.nextMoveAt = now + BOT_MOVE_MS;
    return;
  }
  bot.col = to.c;
  bot.row = to.r;
  bot.dir = to.dir;
  bot.moving = true;
  bot.nextMoveAt = now + BOT_MOVE_MS;
};
const addBomb = (
  next: SharedState,
  ownerId: string,
  col: number,
  row: number,
  stats: PlayerStats,
): void => {
  if (bombOn(next.bombs, col, row)) {
    return;
  }
  const bomb = makeBomb(ownerId, col, row, stats.range);
  next.bombs[bomb.id] = bomb;
};
/** Tiles that are unsafe right now: every bomb's eventual blast + live blasts. */
const dangerSet = (s: SharedState): Set<string> => {
  const danger = new Set<string>();
  for (const bomb of Object.values(s.bombs)) {
    for (const t of computeBlastTiles(s.grid, bomb).tiles) {
      danger.add(tileKey(t.col, t.row));
    }
  }
  for (const blast of Object.values(s.blasts)) {
    for (const t of blast.tiles) {
      danger.add(tileKey(t.col, t.row));
    }
  }
  return danger;
};
/** Which top-level shared fields changed this host tick. */
interface Dirty {
  blasts: boolean;
  bombs: boolean;
  bots: boolean;
  deaths: boolean;
  grid: boolean;
  powerups: boolean;
  stats: boolean;
  winner: boolean;
}

/** A copy of `record` without the entries `keep` rejects — the same object when
 *  nothing was dropped, so callers can flag a change by identity. */
const keepKeys = <T>(
  record: Record<string, T>,
  keep: (key: string, value: T) => boolean,
): Record<string, T> => {
  const entries = Object.entries(record).filter(([k, v]) => keep(k, v));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
};

/** HUD label tint: white for me, warm for a bot, cool for a rival. */
const labelColor = (isMe: boolean, isBot: boolean): string => {
  if (isMe) {
    return "#ffffff";
  }
  return isBot ? "#ffd0d0" : "#dfe6ff";
};

const playerTexture = (dir: Dir): string => {
  if (dir === "up") {
    return "player-up";
  }
  return dir === "down" ? "player-down" : "player-side";
};

const walkAnim = (dir: Dir): string => {
  if (dir === "up") {
    return "walk-up";
  }
  return dir === "down" ? "walk-down" : "walk-side";
};

interface Neighbor {
  dir: Dir;
  c: number;
  r: number;
  key: string;
}

/** The candidate step that lands nearest `target` (first wins on a tie). */
const closestTo = (
  options: readonly Neighbor[],
  target: { col: number; row: number },
): Neighbor | null => {
  let best: Neighbor | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = manhattan(o.c, o.r, target.col, target.row);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
};

export class GameScene extends Scene {
  private client!: MultiplayerClient;

  private tileObjs: (GameObjects.Image | null)[][] = [];
  private tileKind: (Cell["kind"] | null)[][] = [];
  private bombSprites = new Map<string, GameObjects.Image>();
  private blastSprites = new Map<string, GameObjects.Sprite[]>();
  private powerupObjs = new Map<string, GameObjects.Container>();
  private powerupKind = new Map<string, PowerupKind>();
  private players = new Map<string, PlayerObjs>();
  private deathSeen = new Set<string>();
  private followStarted = false;

  private myCol = 0;
  private myRow = 0;
  private myDir: Dir = "down";
  private moving = false;
  private moveCooldown = 0;
  private lastMoveAt = 0;
  private hostTickAcc = 0;
  private localBombSeq = 1;
  private queuedDir: Dir | null = null;
  /** Arrow + WASD key pairs per direction — either key held keeps you moving. */
  private heldKeys!: Record<Dir, [Input.Keyboard.Key, Input.Keyboard.Key]>;
  /** Touch controls: a floating move-joystick (snapped to 4 directions) plus a
   *  fixed bomb button. Inert until the first finger lands. */
  private gamepad!: PhaserGamepad;
  /** Physical controller: stick/d-pad move, A bombs, START restarts. */
  private readonly pad = new PhysicalGamepad();
  /** Touch-only pause button. No mute accessor — the game ships no audio. */
  private touchControls: TouchControls | null = null;
  private unwatchControls: (() => void) | null = null;
  /** When we entered a restartable state (dead or round over); null while
   *  fighting. Gates tap-to-restart — see bindInput. */
  private restartableSince: number | null = null;

  private statusEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private startEl: HTMLElement | null = null;
  /** False until the player dismisses the start screen. Gates spawning so the
   *  player isn't dropped into a live arena while still reading the controls;
   *  bots and the host seed keep running behind the overlay. */
  private started = false;
  // Last strings written to each HUD element, to skip redundant DOM writes.
  private lastStatus: string | null = null;
  private lastPlayers: string | null = null;
  private lastStats: string | null = null;
  private lastBanner: string | null = null;

  /** Net/shared state changed since the last render sync — see update(). */
  private netDirty = true;

  /** One reusable spark emitter for every burst() (created in create()). */
  private sparkEmitter: GameObjects.Particles.ParticleEmitter | null = null;

  // Solo fallback: if the party server can't be reached, this client becomes
  // its own host over the same code paths — events loop back, shared state
  // lives locally, and the bots make it a real match (you vs 3 bots).
  private offline = false;
  private everConnected = false;
  /** Stamped on the first update() tick (not create()) — see maybeGoOffline. */
  private bootedAt = 0;
  private offlineShared: SharedState | null = null;
  private offlineMyState: JsonObject = {};

  /** Connected to the room, or running the solo offline fallback. */
  private get live(): boolean {
    return this.offline || this.client.connectionStatus === "connected";
  }

  /**
   * True when freezing the sim is safe: solo-offline, or connected but the only
   * human in the room. False when other humans share the arena — freezing a
   * wall-clock sim would stall them. Mirrors the `soloArena` gate in update();
   * read by the wrapper pause handler in main.ts.
   */
  get freezable(): boolean {
    return Object.keys(this.peers).length <= 1;
  }

  private get amHost(): boolean {
    return this.offline || this.client.isHost;
  }

  private get myId(): string | null {
    return this.offline ? "solo" : this.client.playerId;
  }

  private get peers(): typeof this.client.players {
    return this.offline
      ? { solo: { id: "solo", state: this.offlineMyState } }
      : this.client.players;
  }

  /** Events loop straight back into the local host when offline. */
  private netSendEvent(event: string, payload: JsonObject): void {
    if (this.offline) {
      this.handleEvent(event, payload, "solo");
    } else {
      this.client.sendEvent(event, payload);
    }
  }

  /** Per-player state shallow-merges, mirroring the package's semantics. */
  private netUpdateMyState(patch: JsonObject): void {
    this.netDirty = true;
    if (this.offline) {
      Object.assign(this.offlineMyState, patch);
    } else {
      this.client.updateMyState(patch);
    }
  }

  /** Shared-state patches shallow-merge, mirroring the package's semantics. */
  private netPatchShared(patch: Partial<SharedState>): void {
    this.netDirty = true;
    if (this.offline) {
      if (this.offlineShared) {
        this.offlineShared = { ...this.offlineShared, ...patch };
      }
    } else {
      this.client.updateSharedState(patch);
    }
  }

  /** Poll once per frame: drives the solo-fallback grace window. */
  private maybeGoOffline(): void {
    // Start the grace window on the FIRST update() tick, not at create():
    // counting load time against the deadline would wrongly drop a slow-booting
    // client to solo before its socket ever got a chance to connect.
    if (this.bootedAt === 0) {
      this.bootedAt = Date.now();
    }
    if (this.client.connectionStatus === "connected") {
      this.everConnected = true;
      return;
    }
    // Once we've been in a room, a drop is transient — let the socket
    // reconnect instead of permanently stranding the player in solo.
    if (this.everConnected) {
      return;
    }
    // Pre-connect errors/closes are NOT instant failures: the socket retries
    // by itself, so the deadline is the only fallback trigger.
    if (Date.now() - this.bootedAt < OFFLINE_FALLBACK_MS) {
      return;
    }
    this.offline = true;
    // no subscribe() offline — kick the first onUpdate
    this.netDirty = true;
    // stop reconnect attempts; refresh to go online
    this.client.destroy();
  }

  constructor() {
    super("Game");
  }

  create(): void {
    this.statusEl = document.querySelector("#status");
    this.playersEl = document.querySelector("#players");
    this.statsEl = document.querySelector("#stats");
    this.bannerEl = document.querySelector("#banner");
    this.buildStartScreen();

    // Continuous grass field, larger than the arena so the follow camera shows
    // grass (not black) past the world edge when centred on a corner spawn.
    this.add
      .tileSprite(-FLOOR_PAD, -FLOOR_PAD, WORLD_W + FLOOR_PAD * 2, WORLD_H + FLOOR_PAD * 2, "floor")
      .setOrigin(0, 0)
      .setDepth(-10);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0e1020");
    cam.roundPixels = true;
    this.applyZoom();
    this.scale.on(Scale.Events.RESIZE, this.applyZoom, this);

    // One spark emitter shared by every burst() (crates, deaths, pickups):
    // re-tinted and exploded in place instead of allocating one per call.
    this.sparkEmitter = this.add
      .particles(0, 0, "spark", {
        alpha: { end: 0, start: 1 },
        angle: { max: 360, min: 0 },
        blendMode: BlendModes.ADD,
        emitting: false,
        lifespan: { max: 560, min: 280 },
        scale: { end: 0, start: 1.1 },
        speed: { max: 190, min: 40 },
      })
      .setDepth(40);

    // Explicit offline boot (?offline=1): never dial the party server. A
    // failed WebSocket handshake logs a browser console error the page cannot
    // suppress, so an offline-by-intent run (bot playtest, deliberate solo)
    // must skip the socket entirely rather than lean on the failure fallback
    // (maybeGoOffline), which would also hold the round behind `live` for the
    // whole grace window. Every `this.client` access is guarded by
    // `this.offline`, so the client simply never exists on this path.
    if (isOfflineRequested()) {
      this.offline = true;
      // no subscribe() offline — kick the first onUpdate
      this.netDirty = true;
      this.ensureSeeded();
    } else {
      // No `initialState`: the package re-applies it whenever a client becomes
      // host, which would wipe a live round on host migration. Instead the first
      // host seeds the world explicitly (see `ensureSeeded`) — a promoted guest
      // already has the shared state and won't reset it.
      this.client = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        onEvent: (event, payload, from) => {
          // SAFETY: wire payloads are JSON.parse output (or loop back from
          // netSendEvent's JsonObject), so they are JSON values by construction.
          this.handleEvent(event, payload as JsonValue, from);
        },
        party: "vg-server",
        room: ROOM,
      });
      this.client.subscribe(() => {
        this.netDirty = true;
      });
    }

    this.bindInput();

    this.events.on(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.applyZoom, this);
      this.gamepad.destroy();
      this.touchControls?.destroy();
      if (!this.offline) {
        this.client.destroy();
        // offline already destroyed it
      }
    });

    if (import.meta.env.DEV) {
      Object.assign(window, { __bb: { client: this.client, scene: this } });
    }
  }

  private applyZoom(): void {
    // Keep ~9.5 board rows AND ~7.5 columns on screen — whichever needs the
    // wider FOV wins, so portrait phones aren't blind to bombs whose blast
    // (up to MAX_RANGE tiles) would land from off-screen. Clamped for
    // tiny/huge screens.
    const zoom = PhaserMath.Clamp(
      Math.min(this.scale.height / (9.5 * TILE), this.scale.width / (7.5 * TILE)),
      0.6,
      2.4,
    );
    this.cameras.main.setZoom(zoom);
  }

  override update(_time: number, delta: number): void {
    if (!this.offline) {
      this.maybeGoOffline();
    }
    // subscribe() (online) and the net* writers (offline) mark the scene
    // dirty; run the render sync at most once per frame, and only when
    // something actually changed. Runs even while connecting so the HUD
    // shows the connection status.
    if (this.netDirty) {
      this.netDirty = false;
      this.onUpdate();
    }
    // The pad polls outside the `live` gate: "press any pad button to start"
    // must work while still connecting, exactly like the keyboard listener.
    this.pad.update();
    if (!this.started && ["a", "b", "x", "y", "start"].some((b) => this.pad.justPressed(b))) {
      this.beginPlay();
    }
    if (!this.live) {
      return;
    }
    // reconcile dropped touches + redraw the overlay
    this.gamepad.update();
    if (this.started) {
      if (this.pad.justPressed("a")) {
        this.requestBomb();
      }
      if (this.pad.justPressed("start")) {
        this.requestRestart();
      }
    }
    this.handleInput(delta);
    this.settleMoving();
    this.updateCamera();
    // Hold the world (bots, bombs, round end) while the start screen is up, or
    // the round can be decided against a player who is still reading. Only safe
    // when no other human is present: freezing a shared arena would stall them.
    // `offline` means "no server", not "solo" — a connected solo host still
    // needs the hold, so gate on the human count instead.
    const soloArena = Object.keys(this.peers).length <= 1;
    if (this.amHost && (this.started || !soloArena)) {
      this.hostTick(delta);
    }
  }

  /**
   * Center the local player. We clamp only to the (padded) grass field, not the
   * arena, so the player stays dead-center even at a corner spawn — the edge
   * just shows grass. (Phaser's `startFollow`+`setBounds` clamps against the
   * unzoomed canvas and jams the player into the corner, which is how you lose
   * track of yourself.)
   */
  private updateCamera(): void {
    const id = this.myId;
    if (!id) {
      return;
    }
    const me = this.players.get(id);
    if (!me) {
      return;
    }
    const cam = this.cameras.main;
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
    const cx = PhaserMath.Clamp(me.container.x, -FLOOR_PAD + halfW, WORLD_W + FLOOR_PAD - halfW);
    const cy = PhaserMath.Clamp(me.container.y, -FLOOR_PAD + halfH, WORLD_H + FLOOR_PAD - halfH);
    // Phaser zooms around the midpoint (scroll + half the CANVAS size), so
    // centring subtracts cam.width/2 — halfW/H above (the zoomed visible
    // extent) are only for keeping the view inside the grass field.
    const tx = cx - cam.width / 2;
    const ty = cy - cam.height / 2;
    if (this.followStarted) {
      cam.setScroll(
        PhaserMath.Linear(cam.scrollX, tx, 0.16),
        PhaserMath.Linear(cam.scrollY, ty, 0.16),
      );
    } else {
      cam.setScroll(tx, ty);
      this.followStarted = true;
    }
  }

  // ---- input ---------------------------------------------------------------

  private bindInput(): void {
    // Mobile controls: a floating move-joystick anywhere on screen, plus a
    // fixed bomb button bottom-right, above the board. Tap-to-bomb fires on the
    // press edge. Attached before the keyboard guard so touch works even with
    // no keyboard present.
    this.gamepad = attachVirtualGamepad(this, {
      buttons: [
        {
          id: "bomb",
          label: "💣",
          position: ({ height, inset, width }) => ({
            x: width - 84 - inset.right,
            y: height - 84 - inset.bottom,
          }),
          radius: 52,
        },
      ],
      onButtonDown: (id) => {
        if (id === "bomb") {
          this.requestBomb();
        }
      },
      render: { blendMode: BlendModes.NORMAL, depth: 1000 },
      // Pre-show the bomb button on touch devices — an invisible button is
      // undiscoverable before the first touch.
      visible: "coarse",
    });

    // Touch path to restart (R has no on-screen equivalent): while dead or
    // after the round ends, any fresh tap restarts. The arming delay stops
    // frantic bomb-taps that land just as you die from resetting the round.
    this.input.on(Input.Events.POINTER_DOWN, (p: Input.Pointer) => {
      if (!p.wasTouch) {
        return;
      }
      if (this.restartableSince === null) {
        return;
      }
      if (simNow() - this.restartableSince < 600) {
        return;
      }
      this.requestRestart();
    });

    const k = this.input.keyboard;
    if (!k) {
      return;
    }
    k.on("keydown-SPACE", () => this.requestBomb());
    k.on("keydown-B", () => this.requestBomb());
    k.on("keydown-R", () => this.requestRestart());

    const KEY_TO_DIR: [string, Dir][] = [
      ["LEFT", "left"],
      ["A", "left"],
      ["RIGHT", "right"],
      ["D", "right"],
      ["UP", "up"],
      ["W", "up"],
      ["DOWN", "down"],
      ["S", "down"],
    ];
    for (const [code, dir] of KEY_TO_DIR) {
      k.on(`keydown-${code}`, () => {
        this.queuedDir = dir;
      });
    }
    this.heldKeys = {
      down: [k.addKey("DOWN"), k.addKey("S")],
      left: [k.addKey("LEFT"), k.addKey("A")],
      right: [k.addKey("RIGHT"), k.addKey("D")],
      up: [k.addKey("UP"), k.addKey("W")],
    };
  }

  private handleInput(delta: number): void {
    const id = this.myId;
    if (!this.started) {
      return;
    }
    if (!this.isAlive(id)) {
      return;
    }
    this.moveCooldown = Math.max(0, this.moveCooldown - delta);
    if (this.moveCooldown > 0) {
      return;
    }
    const dir = this.readDir();
    if (!dir) {
      return;
    }
    const [dc, dr] = DIR_VECT[dir];
    const nc = this.myCol + dc;
    const nr = this.myRow + dr;
    if (!this.passable(nc, nr)) {
      return;
    }
    this.myCol = nc;
    this.myRow = nr;
    this.myDir = dir;
    this.moving = true;
    this.moveCooldown = this.myStats().speed;
    this.lastMoveAt = this.time.now;
    this.netUpdateMyState({ col: nc, colorIdx: this.myColorIdx(), dir, moving: true, row: nr });
    this.tweenPlayer(id, nc, nr, this.moveCooldown);
  }

  /** Drop back to the idle pose shortly after the last successful step. */
  private settleMoving(): void {
    if (!this.moving) {
      return;
    }
    if (this.time.now - this.lastMoveAt < this.myStats().speed + 70) {
      return;
    }
    this.moving = false;
    if (this.myId) {
      this.netUpdateMyState({ moving: false });
    }
  }

  private readDir(): Dir | null {
    if (this.queuedDir) {
      const d = this.queuedDir;
      this.queuedDir = null;
      return d;
    }
    if (this.heldKeys) {
      if (this.heldKeys.left.some((key) => key.isDown)) {
        return "left";
      }
      if (this.heldKeys.right.some((key) => key.isDown)) {
        return "right";
      }
      if (this.heldKeys.up.some((key) => key.isDown)) {
        return "up";
      }
      if (this.heldKeys.down.some((key) => key.isDown)) {
        return "down";
      }
    }
    // Physical pad: d-pad first (exact), then the analog stick.
    if (this.pad.connected) {
      if (this.pad.isButtonDown("left")) {
        return "left";
      }
      if (this.pad.isButtonDown("right")) {
        return "right";
      }
      if (this.pad.isButtonDown("up")) {
        return "up";
      }
      if (this.pad.isButtonDown("down")) {
        return "down";
      }
      const padDir = stickDirection4(this.pad.getStick());
      if (padDir) {
        return padDir;
      }
    }
    // Held touch stick, snapped to the grid's 4 directions.
    return stickDirection4(this.gamepad.getStick());
  }

  private requestBomb(): void {
    const id = this.myId;
    if (!this.started) {
      return;
    }
    if (!this.isAlive(id)) {
      return;
    }
    if (this.bombAt(this.myCol, this.myRow)) {
      return;
    }
    const localId = this.localBombSeq;
    this.localBombSeq += 1;
    this.netSendEvent("place_bomb", {
      col: this.myCol,
      localId,
      row: this.myRow,
    });
  }

  private requestRestart(): void {
    if (!this.started) {
      return;
    }
    // Host, guest, and offline all funnel through the request_restart handler:
    // the host (or the offline loopback) resets the world and broadcasts
    // round_restart, which the server echoes back to the sender too.
    this.netSendEvent("request_restart", {});
  }

  private respawnSelf(): void {
    const id = this.myId;
    if (!id) {
      return;
    }
    const idx = Object.keys(this.peers).indexOf(id);
    if (idx === -1) {
      return;
    }
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0];
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.myDir = "down";
    this.moving = false;
    // Snap our own container — the local player is never tweened by syncPlayers,
    // so without this the sprite would linger at its death spot after a restart.
    const objs = this.players.get(id);
    if (objs) {
      objs.container.setPosition(colX(spawn.col), rowY(spawn.row));
      objs.col = spawn.col;
      objs.row = spawn.row;
    }
    this.netUpdateMyState({
      col: spawn.col,
      colorIdx: idx % COLORS.length,
      dir: "down",
      moving: false,
      row: spawn.row,
    });
  }

  // ---- connection callbacks ------------------------------------------------

  private handleEvent(event: string, payload: JsonValue, from: string): void {
    if (event === "round_restart") {
      this.respawnSelf();
      return;
    }
    if (!this.amHost) {
      return;
    }
    if (event === "place_bomb") {
      const p = isJsonObject(payload) ? payload : null;
      const col = p?.["col"];
      const row = p?.["row"];
      if (isJsonNumber(col) && isJsonNumber(row)) {
        this.hostPlaceBomb(from, col, row);
      }
    } else if (event === "request_restart") {
      this.writeShared(emptyShared());
      this.netSendEvent("round_restart", {});
    }
  }

  private onUpdate(): void {
    this.ensureSeeded();
    this.trackRestartable();
    this.setStatus(this.statusText());
    this.setPlayersList(this.playersListText());
    this.setStats(this.statsText());
    this.setBanner();
    // No body until the start screen is dismissed — bots and the host seed run
    // on behind the overlay, but the player isn't dropped in mid-read.
    if (this.started) {
      this.ensureMySpawn();
    }
    this.syncGrid();
    this.syncBombs();
    this.syncBlasts();
    this.syncPowerups();
    this.syncPlayers();
  }

  /** Arm/disarm tap-to-restart as the death/round-over state changes. */
  private trackRestartable(): void {
    const s = this.shared();
    const restartable = this.live && s !== null && (s.winner !== null || !this.isAlive(this.myId));
    if (restartable) {
      this.restartableSince ??= simNow();
    } else {
      this.restartableSince = null;
    }
  }

  // ---- shared-state rendering ----------------------------------------------

  private shared(): SharedState | null {
    if (this.offline) {
      return this.offlineShared;
      // local state is authoritative solo
    }
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
  }

  /**
   * The first host to connect seeds the world. Guests adopt the host's
   * existing state; a guest promoted to host after a migration keeps the
   * live round instead of resetting it.
   */
  private ensureSeeded(): void {
    if (this.offline) {
      if (!this.offlineShared) {
        this.offlineShared = emptyShared();
      }
      return;
    }
    if (this.amHost && this.client.connectionStatus === "connected" && !this.shared()) {
      this.writeShared(emptyShared());
    }
  }

  /** Humans (connections) + bots (shared state), unified for rendering. */
  private fighters(): Fighter[] {
    const out: Fighter[] = [];
    const { myId } = this;
    let order = 0;
    for (const [id, player] of Object.entries(this.peers)) {
      const ps = readPlayerState(player);
      const fb = SPAWN_POINTS[order] ?? SPAWN_POINTS[0];
      out.push({
        col: ps.col ?? fb.col,
        colorIdx: (ps.colorIdx ?? order) % COLORS.length,
        dir: ps.dir ?? "down",
        id,
        isBot: false,
        isLocal: id === myId,
        moving: ps.moving ?? false,
        order,
        row: ps.row ?? fb.row,
      });
      order += 1;
    }
    const s = this.shared();
    if (s) {
      for (const bot of Object.values(s.bots ?? {})) {
        out.push({
          col: bot.col,
          colorIdx: bot.colorIdx % COLORS.length,
          dir: bot.dir,
          id: bot.id,
          isBot: true,
          isLocal: false,
          moving: bot.moving,
          order: -1,
          row: bot.row,
        });
      }
    }
    return out;
  }

  private syncGrid(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    for (let r = 0; r < GRID_ROWS; r += 1) {
      const objRow: (GameObjects.Image | null)[] = this.tileObjs[r] ?? [];
      const kindRow: (Cell["kind"] | null)[] = this.tileKind[r] ?? [];
      this.tileObjs[r] = objRow;
      this.tileKind[r] = kindRow;
      for (let c = 0; c < GRID_COLS; c += 1) {
        const kind = s.grid[r]?.[c]?.kind ?? "empty";
        if (kindRow[c] === kind) {
          continue;
        }
        const prev = objRow[c];
        if (kindRow[c] === "crate" && kind === "empty") {
          this.crateBreak(c, r);
        }
        if (prev) {
          prev.destroy();
          objRow[c] = null;
        }
        if (kind === "wall" || kind === "crate") {
          objRow[c] = this.add
            .image(colX(c), rowY(r), kind === "wall" ? "wall" : "crate")
            .setDisplaySize(TILE, TILE)
            .setDepth(1);
        }
        kindRow[c] = kind;
      }
    }
  }

  private syncBombs(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    const now = simNow();
    const seen = new Set<string>();
    for (const bomb of Object.values(s.bombs)) {
      seen.add(bomb.id);
      let sprite = this.bombSprites.get(bomb.id);
      if (!sprite) {
        sprite = this.add
          .image(colX(bomb.col), rowY(bomb.row), "bomb")
          .setDisplaySize(TILE * 0.92, TILE * 0.92)
          .setDepth(6);
        this.tweens.add({
          duration: 300,
          ease: "Sine.InOut",
          repeat: -1,
          scaleX: { from: sprite.scaleX, to: sprite.scaleX * 1.14 },
          scaleY: { from: sprite.scaleY, to: sprite.scaleY * 0.86 },
          targets: sprite,
          yoyo: true,
        });
        this.bombSprites.set(bomb.id, sprite);
      }
      const left = FUSE_MS - (now - bomb.placedAt);
      if (left < 700 && Math.floor(left / 110) % 2 === 0) {
        sprite.setTint(0xff_4d_4d);
      } else {
        sprite.clearTint();
      }
    }
    for (const [id, sprite] of this.bombSprites) {
      if (!seen.has(id)) {
        this.tweens.killTweensOf(sprite);
        sprite.destroy();
        this.bombSprites.delete(id);
      }
    }
  }

  private syncBlasts(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    const seen = new Set<string>();
    for (const blast of Object.values(s.blasts)) {
      seen.add(blast.id);
      if (this.blastSprites.has(blast.id)) {
        continue;
      }
      const sprites = blast.tiles.map((t) => {
        const sp = this.add
          .sprite(colX(t.col), rowY(t.row), "explosion", 0)
          .setDisplaySize(TILE * 1.35, TILE * 1.35)
          .setDepth(30)
          .setAngle(PhaserMath.Between(0, 3) * 90)
          .setBlendMode(BlendModes.ADD);
        sp.play({ key: "explode", startFrame: PhaserMath.Between(0, 2) });
        return sp;
      });
      this.blastSprites.set(blast.id, sprites);
      this.shakeIfNear(blast.tiles);
    }
    for (const [id, sprites] of this.blastSprites) {
      if (!seen.has(id)) {
        for (const sp of sprites) {
          sp.destroy();
        }
        this.blastSprites.delete(id);
      }
    }
  }

  private syncPowerups(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    const seen = new Set<string>();
    for (const [key, pu] of Object.entries(s.powerups)) {
      seen.add(key);
      if (this.powerupObjs.has(key)) {
        continue;
      }
      const glow = this.add
        .image(0, 0, "glow")
        .setDisplaySize(TILE * 1.5, TILE * 1.5)
        .setTint(POWERUP_GLOW[pu.kind])
        .setBlendMode(BlendModes.ADD);
      const icon = this.add
        .image(0, 0, POWERUP_TEX[pu.kind])
        .setDisplaySize(TILE * 0.7, TILE * 0.7);
      const container = this.add.container(colX(pu.col), rowY(pu.row), [glow, icon]).setDepth(4);
      this.tweens.add({
        duration: 760,
        ease: "Sine.InOut",
        repeat: -1,
        targets: icon,
        y: -6,
        yoyo: true,
      });
      this.tweens.add({
        alpha: { from: 0.5, to: 1 },
        duration: 900,
        ease: "Sine.InOut",
        repeat: -1,
        scale: { from: 0.92, to: 1.08 },
        targets: glow,
        yoyo: true,
      });
      this.powerupObjs.set(key, container);
      this.powerupKind.set(key, pu.kind);
    }
    for (const [key, container] of this.powerupObjs) {
      if (!seen.has(key)) {
        const kind = this.powerupKind.get(key);
        this.burst(container.x, container.y, kind ? POWERUP_GLOW[kind] : 0xff_ff_ff, 18);
        this.tweens.killTweensOf(container.list);
        container.destroy();
        this.powerupObjs.delete(key);
        this.powerupKind.delete(key);
      }
    }
  }

  private syncPlayers(): void {
    const seen = new Set<string>();
    for (const f of this.fighters()) {
      seen.add(f.id);
      const objs =
        this.players.get(f.id) ??
        this.createPlayer(f.id, f.col, f.row, f.colorIdx, f.isLocal, f.isBot);
      const dead = !this.isAlive(f.id);

      if (dead && !this.deathSeen.has(f.id)) {
        this.deathSeen.add(f.id);
        this.playDeath(objs);
      } else if (!dead && this.deathSeen.has(f.id)) {
        this.deathSeen.delete(f.id);
        this.reviveVisual(objs, f.col, f.row);
      }

      if (!dead) {
        GameScene.applyAnim(objs.sprite, f.dir, f.moving);
        // The local player is moved by input tweens; everyone else follows state.
        if (!f.isLocal && (objs.col !== f.col || objs.row !== f.row)) {
          this.tweenContainer(objs, f.col, f.row, f.isBot ? BOT_MOVE_MS : 150);
        }
      }
    }
    for (const [id, objs] of this.players) {
      if (!seen.has(id)) {
        this.tweens.killTweensOf(objs.container);
        this.tweens.killTweensOf(objs.container.list);
        objs.container.destroy();
        this.players.delete(id);
        this.deathSeen.delete(id);
      }
    }
  }

  private createPlayer(
    id: string,
    col: number,
    row: number,
    colorIdx: number,
    isMe: boolean,
    isBot: boolean,
  ): PlayerObjs {
    const tint = COLORS[colorIdx] ?? 0xff_ff_ff;

    const children: GameObjects.GameObject[] = [];
    const shadow = this.add.image(0, TILE * 0.34, "shadow").setDisplaySize(TILE * 0.7, TILE * 0.34);
    const ring = this.add.graphics();
    ring
      .lineStyle(isMe ? 4 : 3, tint, isMe ? 1 : 0.85)
      .strokeEllipse(0, TILE * 0.34, TILE * 0.62, TILE * 0.3);
    const sprite = this.add
      .sprite(0, -TILE * 0.06, "player-down", 0)
      .setDisplaySize(TILE * 0.95, TILE * 0.95);
    const label = this.add
      .text(0, -TILE * 0.62, this.labelFor(id), {
        backgroundColor: "rgba(8,10,26,0.55)",
        color: labelColor(isMe, isBot),
        fontFamily: "ui-monospace, monospace",
        fontSize: "13px",
        fontStyle: isMe ? "bold" : "normal",
        padding: { bottom: 1, left: 4, right: 4, top: 1 },
      })
      .setOrigin(0.5, 1);
    children.push(shadow, ring, sprite, label);

    // Bright bobbing marker over the local player so you can pick yourself out
    // among identical bots.
    let marker: GameObjects.Triangle | null = null;
    if (isMe) {
      marker = this.add
        .triangle(0, -TILE * 0.82, -9, -6, 9, -6, 0, 7, 0xff_e1_4a)
        .setStrokeStyle(2, 0x1a_14_30, 1);
      this.tweens.add({
        duration: 520,
        ease: "Sine.InOut",
        repeat: -1,
        targets: marker,
        y: -TILE * 0.92,
        yoyo: true,
      });
      children.push(marker);
    }

    const container = this.add.container(colX(col), rowY(row), children).setDepth(10);
    const objs: PlayerObjs = { col, container, label, marker, ring, row, sprite };
    this.players.set(id, objs);
    return objs;
  }

  private static applyAnim(sprite: GameObjects.Sprite, dir: Dir, moving: boolean): void {
    const tex = playerTexture(dir);
    sprite.setFlipX(dir === "left");
    if (moving) {
      const key = walkAnim(dir);
      if (sprite.anims.currentAnim?.key !== key || !sprite.anims.isPlaying) {
        sprite.anims.play(key, true);
      }
    } else {
      sprite.anims.stop();
      sprite.setTexture(tex, 0);
    }
  }

  // ---- host-only logic -----------------------------------------------------

  private hostTick(delta: number): void {
    this.hostTickAcc += delta;
    if (this.hostTickAcc < 70) {
      return;
    }
    this.hostTickAcc = 0;
    const s = this.shared();
    if (!s) {
      return;
    }
    const now = simNow();

    const next: SharedState = {
      blasts: { ...s.blasts },
      bombs: { ...s.bombs },
      bots: structuredCloneBots(s.bots ?? {}),
      deaths: { ...s.deaths },
      grid: s.grid,
      powerups: { ...s.powerups },
      startedAt: s.startedAt,
      stats: { ...s.stats },
      winner: s.winner,
    };
    // Track which top-level fields changed so we only send those (bot moves
    // fire every tick — re-sending the 285-cell grid each time is wasteful).
    const d: Dirty = {
      blasts: false,
      bombs: false,
      bots: false,
      deaths: false,
      grid: false,
      powerups: false,
      stats: false,
      winner: false,
    };

    this.reconcileBots(next, now, d);

    // Prune stats/deaths for fighters that no longer exist (departed humans or
    // removed bots) so the shared object can't grow unbounded over a session.
    const activeIds = new Set([...Object.keys(this.peers), ...Object.keys(next.bots)]);
    const stats = keepKeys(next.stats, (id) => activeIds.has(id));
    if (stats !== next.stats) {
      next.stats = stats;
      d.stats = true;
    }
    const deaths = keepKeys(next.deaths, (id) => activeIds.has(id));
    if (deaths !== next.deaths) {
      next.deaths = deaths;
      d.deaths = true;
    }

    GameScene.hostDetonate(s, next, d, now);

    // Expire spent blasts.
    const liveBlastRecord = keepKeys(next.blasts, (_id, b) => now - b.placedAt < EXPLOSION_MS);
    if (liveBlastRecord !== next.blasts) {
      next.blasts = liveBlastRecord;
      d.blasts = true;
    }

    // Bot AI moves bots and may place bot bombs (into next.bombs).
    if (this.tickBots(next, now)) {
      d.bots = true;
      d.bombs = true;
    }

    // Positions of every living fighter (humans from connections, bots from
    // the freshly-moved bot records), for pickups + death.
    const livePos = this.fighterPositions(next);

    this.hostResolveRound(next, d, now, livePos);

    const patch: Partial<SharedState> = {};
    if (d.grid) {
      patch.grid = next.grid;
    }
    if (d.bombs) {
      patch.bombs = next.bombs;
    }
    if (d.blasts) {
      patch.blasts = next.blasts;
    }
    if (d.powerups) {
      patch.powerups = next.powerups;
    }
    if (d.bots) {
      patch.bots = next.bots;
    }
    if (d.stats) {
      patch.stats = next.stats;
    }
    if (d.deaths) {
      patch.deaths = next.deaths;
    }
    if (d.winner) {
      patch.winner = next.winner;
    }
    if (Object.keys(patch).length > 0) {
      this.netPatchShared(patch);
    }
  }

  /** Detonate expired bombs, cascading through any bombs caught in a blast. */
  private static hostDetonate(s: SharedState, next: SharedState, d: Dirty, now: number): void {
    const expired = Object.values(next.bombs).filter((b) => now - b.placedAt >= FUSE_MS);
    if (expired.length > 0) {
      const detonated = new Set<string>();
      const queue: Bomb[] = [...expired];
      const cratesToClear = new Map<string, { col: number; row: number }>();
      const newBlastTiles = new Set<string>();
      let bomb: Bomb | undefined;
      while ((bomb = queue.shift()) !== undefined) {
        if (detonated.has(bomb.id)) {
          continue;
        }
        detonated.add(bomb.id);
        const { tiles, crates } = computeBlastTiles(s.grid, bomb);
        for (const t of tiles) {
          newBlastTiles.add(tileKey(t.col, t.row));
          for (const other of Object.values(next.bombs)) {
            if (!detonated.has(other.id) && other.col === t.col && other.row === t.row) {
              queue.push(other);
            }
          }
        }
        for (const cr of crates) {
          cratesToClear.set(tileKey(cr.col, cr.row), cr);
        }
        next.blasts[`x-${bomb.id}`] = { id: `x-${bomb.id}`, placedAt: now, tiles };
      }
      next.bombs = keepKeys(next.bombs, (id) => !detonated.has(id));

      if (cratesToClear.size > 0) {
        const grid = s.grid.map((row) => [...row]);
        for (const cr of cratesToClear.values()) {
          const row = grid[cr.row];
          if (row) {
            row[cr.col] = { kind: "empty" };
          }
        }
        next.grid = grid;
        d.grid = true;
      }
      const survived = keepKeys(next.powerups, (key) => !newBlastTiles.has(key));
      if (survived !== next.powerups) {
        next.powerups = survived;
        d.powerups = true;
      }
      for (const cr of cratesToClear.values()) {
        const key = tileKey(cr.col, cr.row);
        if (!next.powerups[key] && Math.random() < POWERUP_DROP_CHANCE) {
          next.powerups[key] = { col: cr.col, kind: randomKind(), row: cr.row };
          d.powerups = true;
        }
      }
      d.bombs = true;
      d.blasts = true;
    }
  }

  /** Pickups, deaths and the last-fighter-standing check. */
  private hostResolveRound(
    next: SharedState,
    d: Dirty,
    now: number,
    livePos: [string, number, number][],
  ): void {
    for (const [fid, col, row] of livePos) {
      const key = tileKey(col, row);
      const pu = next.powerups[key];
      if (!pu) {
        continue;
      }
      next.stats[fid] = grantPowerup(next.stats[fid] ?? baseStats(), pu.kind);
      next.powerups = keepKeys(next.powerups, (k) => k !== key);
      d.powerups = true;
      d.stats = true;
    }

    // Deaths from live blasts.
    const liveBlasts = Object.values(next.blasts);
    if (liveBlasts.length > 0) {
      for (const [fid, col, row] of livePos) {
        if (next.deaths[fid]) {
          continue;
        }
        if (liveBlasts.some((b) => b.tiles.some((t) => t.col === col && t.row === row))) {
          next.deaths[fid] = now;
          d.deaths = true;
        }
      }
    }

    // Last fighter standing wins (bots count — solo + bots still resolves).
    const fighterIds = [...Object.keys(this.peers), ...Object.keys(next.bots)];
    if (fighterIds.length >= 2 && !next.winner) {
      const alive = fighterIds.filter((id) => !next.deaths[id]);
      const [sole] = alive;
      if (alive.length === 1 && sole) {
        next.winner = sole;
        d.winner = true;
      } else if (alive.length === 0) {
        next.winner = "draw";
        d.winner = true;
      }
    }
  }

  /**
   * Keep bots filling the spawn corners humans don't occupy, up to
   * TARGET_FIGHTERS total. Humans take corners 0..n-1 (by join order), bots
   * take the rest. Bots are keyed by corner so join/leave stays stable.
   */
  private reconcileBots(
    next: SharedState,
    now: number,
    d: { bots: boolean; stats: boolean },
  ): void {
    const humanCount = Object.keys(this.peers).length;
    const want = new Set<number>();
    for (
      let c = humanCount;
      c <= 3 && c - humanCount < MAX_BOTS && want.size < TARGET_FIGHTERS - humanCount;
      c += 1
    ) {
      want.add(c);
    }
    // Dropped bots' stats/deaths get swept by the catch-all prune in hostTick.
    const kept = keepKeys(next.bots, (id) => want.has(Number(id.slice(4))));
    if (kept !== next.bots) {
      next.bots = kept;
      d.bots = true;
    }
    for (const corner of want) {
      const id = `bot-${corner}`;
      if (!next.bots[id]) {
        const spawn = SPAWN_POINTS[corner] ?? SPAWN_POINTS[0];
        next.bots[id] = {
          col: spawn.col,
          colorIdx: corner % COLORS.length,
          dir: "down",
          id,
          moving: false,
          nextMoveAt: now + 700,
          row: spawn.row,
        };
        next.stats[id] = baseStats();
        d.bots = true;
        d.stats = true;
      }
    }
  }

  /** Returns true if any bot moved or placed a bomb. */
  private tickBots(next: SharedState, now: number): boolean {
    const bots = Object.values(next.bots);
    if (bots.length === 0) {
      return false;
    }
    let changed = false;
    const danger = dangerSet(next);
    // [id,col,row] of living fighters
    const enemies = this.fighterPositions(next);

    for (const bot of bots) {
      if (next.deaths[bot.id]) {
        if (bot.moving) {
          bot.moving = false;
          changed = true;
        }
        continue;
      }
      if (now < bot.nextMoveAt) {
        continue;
      }
      const stats = next.stats[bot.id] ?? baseStats();
      const bombs = Object.values(next.bombs);
      const opts = botNeighbors(next, bot.col, bot.row);
      const inDanger = danger.has(tileKey(bot.col, bot.row));

      if (inDanger) {
        // Step toward the nearest safe tile (BFS) — a single safe neighbour
        // often doesn't exist next to one's own bomb, but a 2-3 step path does.
        const dir = fleeDir(next.grid, bombs, bot.col, bot.row, danger);
        moveBot(bot, dir ? neighborOf(bot.col, bot.row, dir) : null, now);
        changed = true;
        continue;
      }

      // Offense: bomb a crate or a fighter in line, but only if a flee path out
      // of the resulting blast exists (don't bomb yourself into a dead end).
      const activeBombs = bombs.filter((b) => b.ownerId === bot.id).length;
      if (
        activeBombs < stats.bombs &&
        (adjacentCrate(next.grid, bot.col, bot.row) ||
          enemyInLine(next.grid, bot, stats.range, enemies))
      ) {
        const blastKeys = new Set(
          computeBlastTiles(next.grid, {
            col: bot.col,
            id: "",
            ownerId: bot.id,
            placedAt: now,
            range: stats.range,
            row: bot.row,
          }).tiles.map((t) => tileKey(t.col, t.row)),
        );
        const unsafe = new Set([...danger, ...blastKeys]);
        const escape = fleeDir(
          next.grid,
          [
            ...bombs,
            {
              col: bot.col,
              id: "_",
              ownerId: bot.id,
              placedAt: now,
              range: stats.range,
              row: bot.row,
            },
          ],
          bot.col,
          bot.row,
          unsafe,
        );
        if (escape && Math.random() < BOT_BOMB_CHANCE) {
          // Drop the bomb AND immediately step onto the escape route in the same
          // tick — sitting on the bomb tile even one step is how bots blow
          // themselves up.
          addBomb(next, bot.id, bot.col, bot.row, stats);
          moveBot(bot, neighborOf(bot.col, bot.row, escape), now);
          changed = true;
          continue;
        }
      }

      // Wander toward the nearest enemy (fallback: nearest crate to dig
      // through). Only ever step onto a safe tile — if the sole neighbour is a
      // tile that's about to explode (e.g. waiting out our own bomb), hold.
      // Prefer tiles no other fighter is on so bots don't stack/clip; fall back
      // to any safe tile rather than freezing.
      const safeOpts = opts.filter((o) => !danger.has(o.key));
      const occupied = this.occupiedTiles(next, bot.id);
      const freeOpts = safeOpts.filter((o) => !occupied.has(o.key));
      const wanderOpts = freeOpts.length > 0 ? freeOpts : safeOpts;
      const target = nearestEnemy(bot, enemies) ?? nearestCrate(next.grid, bot.col, bot.row);
      let pick = wanderOpts[Math.floor(Math.random() * wanderOpts.length)] ?? null;
      if (target && wanderOpts.length > 0 && Math.random() > 0.25) {
        pick = closestTo(wanderOpts, target);
      }
      moveBot(bot, pick, now);
      changed = true;
    }
    return changed;
  }

  /** Tiles currently held by living fighters other than `exceptId` (bot tiles
   *  are read live, so bots already moved this tick are reflected). */
  private occupiedTiles(next: SharedState, exceptId: string): Set<string> {
    const occ = new Set<string>();
    for (const [pid, p] of Object.entries(this.peers)) {
      if (next.deaths[pid]) {
        continue;
      }
      const ps = readPlayerState(p);
      if (ps.col !== undefined && ps.row !== undefined) {
        occ.add(tileKey(ps.col, ps.row));
      }
    }
    for (const other of Object.values(next.bots)) {
      if (other.id === exceptId || next.deaths[other.id]) {
        continue;
      }
      occ.add(tileKey(other.col, other.row));
    }
    return occ;
  }

  /** [id, col, row] for every living fighter (humans + bots). */
  private fighterPositions(next: SharedState): [string, number, number][] {
    const out: [string, number, number][] = [];
    for (const [pid, player] of Object.entries(this.peers)) {
      if (next.deaths[pid]) {
        continue;
      }
      const ps = readPlayerState(player);
      if (ps.col === undefined || ps.row === undefined) {
        continue;
      }
      out.push([pid, ps.col, ps.row]);
    }
    for (const bot of Object.values(next.bots)) {
      if (next.deaths[bot.id]) {
        continue;
      }
      out.push([bot.id, bot.col, bot.row]);
    }
    return out;
  }

  private hostPlaceBomb(ownerId: string, col: number, row: number): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    if (!this.isAlive(ownerId)) {
      return;
    }
    if (bombOn(s.bombs, col, row)) {
      return;
    }
    const stats = s.stats[ownerId] ?? baseStats();
    const active = Object.values(s.bombs).filter((b) => b.ownerId === ownerId).length;
    if (active >= stats.bombs) {
      return;
    }
    const bomb = makeBomb(ownerId, col, row, stats.range);
    this.netPatchShared({ bombs: { ...s.bombs, [bomb.id]: bomb } });
  }

  // ---- visual effects ------------------------------------------------------

  private tweenPlayer(id: string | null, col: number, row: number, duration: number): void {
    if (!id) {
      return;
    }
    const objs = this.players.get(id);
    if (objs) {
      this.tweenContainer(objs, col, row, duration);
    }
  }

  private tweenContainer(objs: PlayerObjs, col: number, row: number, duration = 150): void {
    objs.col = col;
    objs.row = row;
    this.tweens.add({
      duration,
      ease: "Linear",
      targets: objs.container,
      x: colX(col),
      y: rowY(row),
    });
  }

  private playDeath(objs: PlayerObjs): void {
    objs.ring.setVisible(false);
    objs.marker?.setVisible(false);
    this.burst(objs.container.x, objs.container.y, 0xff_ff_ff, 22);
    this.tweens.add({
      alpha: 0.2,
      angle: 540,
      duration: 460,
      ease: "Cubic.In",
      scale: 0,
      targets: objs.sprite,
    });
  }

  private reviveVisual(objs: PlayerObjs, col: number, row: number): void {
    this.tweens.killTweensOf(objs.sprite);
    objs.sprite.setAngle(0).setAlpha(1).setScale(1);
    objs.sprite.setDisplaySize(TILE * 0.95, TILE * 0.95);
    objs.ring.setVisible(true);
    objs.marker?.setVisible(true);
    // Snap to the (likely new) spawn corner so we don't glide across the map.
    objs.container.setPosition(colX(col), rowY(row));
    objs.col = col;
    objs.row = row;
  }

  private crateBreak(col: number, row: number): void {
    this.burst(colX(col), rowY(row), 0xc7_8a_4a, 14);
  }

  private burst(x: number, y: number, tint: number, count: number): void {
    if (!this.sparkEmitter) {
      return;
    }
    this.sparkEmitter.setParticleTint(tint);
    this.sparkEmitter.explode(count, x, y);
  }

  private shakeIfNear(tiles: { col: number; row: number }[]): void {
    const near = tiles.some(
      (t) => Math.abs(t.col - this.myCol) + Math.abs(t.row - this.myRow) <= 3,
    );
    if (near) {
      this.cameras.main.shake(110, 0.005);
    }
  }

  // ---- helpers -------------------------------------------------------------

  private myStats(): PlayerStats {
    const id = this.myId;
    const s = this.shared();
    return (id && s?.stats[id]) || baseStats();
  }

  private myColorIdx(): number {
    const id = this.myId;
    if (!id) {
      return 0;
    }
    const ps = readPlayerState(this.peers[id]);
    if (ps.colorIdx !== undefined) {
      return ps.colorIdx % COLORS.length;
    }
    const idx = Object.keys(this.peers).indexOf(id);
    return Math.max(0, idx) % COLORS.length;
  }

  private ensureMySpawn(): void {
    const id = this.myId;
    if (!id) {
      return;
    }
    const ps = readPlayerState(this.peers[id]);
    if (ps.col !== undefined && ps.row !== undefined) {
      if (!this.moving) {
        this.myCol = ps.col;
        this.myRow = ps.row;
      }
      return;
    }
    const idx = Object.keys(this.peers).indexOf(id);
    if (idx === -1) {
      return;
    }
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0];
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.netUpdateMyState({
      col: spawn.col,
      colorIdx: idx % COLORS.length,
      dir: "down",
      moving: false,
      row: spawn.row,
    });
  }

  private bombAt(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) {
      return false;
    }
    return bombOn(s.bombs, col, row);
  }

  private passable(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) {
      return false;
    }
    if (s.grid[row]?.[col]?.kind !== "empty") {
      return false;
    }
    return !this.bombAt(col, row);
  }

  private isAlive(id: string | null): boolean {
    if (!id) {
      return false;
    }
    const s = this.shared();
    if (!s) {
      return true;
    }
    return !s.deaths[id];
  }

  private writeShared(next: SharedState): void {
    this.netDirty = true;
    if (this.offline) {
      this.offlineShared = next;
      return;
    }
    this.client.updateSharedState(next);
  }

  // ---- start screen --------------------------------------------------------

  /** The one place controls are taught. Dismissed on the first key/pointer
   *  RELEASE, not press: the keydown handlers below stay live behind the
   *  overlay, so starting on keydown would let the same SPACE also drop a bomb. */
  private buildStartScreen(): void {
    this.startEl = document.querySelector("#start");
    const controls = document.querySelector("#start-controls");
    const go = document.querySelector("#start-go");
    // Same grouped keycap rows the pause overlay renders — the two teaching
    // surfaces stay visually consistent by construction.
    ensureControlsStyle();
    const renderControls = (): void => {
      if (!controls) {
        return;
      }
      const card = buildControls(TOUCH_UI);
      controls.replaceChildren(...(card ? [card] : []));
    };
    renderControls();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.started) {
        renderControls();
      }
    });
    if (go) {
      go.textContent = TOUCH_UI ? "tap to start" : "press any key to start";
    }
    // Reveals the overlay now that the column is complete — see #start in index.html.
    this.startEl?.classList.add("ready");
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    // The overlay covers the canvas, so Phaser's pointer input never sees the
    // tap — listen on the overlay element itself.
    this.startEl?.addEventListener("pointerup", () => this.beginPlay(), { once: true });
  }

  private beginPlay(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unwatchControls?.();
    this.unwatchControls = null;
    // Escape is the only other way to pause, so a phone has none. Mounted here
    // rather than in create() because the button outranks the start screen's
    // z-index: offered before play begins it would pause a game that hasn't
    // started, over the one overlay that teaches the controls.
    this.touchControls = createTouchControls();
    notifyGameStarted();
    this.startEl?.classList.add("hide");
    // Drop it only after the fade, so it can't swallow taps on the way out.
    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  // ---- HUD -----------------------------------------------------------------

  private statusText(): string {
    if (!this.offline) {
      const cs = this.client.connectionStatus;
      if (cs !== "connected") {
        return `${cs}…`;
      }
    }
    const s = this.shared();
    const restart = TOUCH_UI ? "tap to restart" : "press R";
    if (s?.winner) {
      return `Round over — ${restart}`;
    }
    if (!this.isAlive(this.myId)) {
      return `💀 Out — bots fight on · ${restart}`;
    }
    // Live play: connection state only. Controls belong on the start screen.
    if (this.offline) {
      return "solo · offline";
    }
    return this.amHost ? "host" : "guest";
  }

  private playersListText(): string {
    const s = this.shared();
    const ids = [...Object.keys(this.peers), ...(s ? Object.keys(s.bots ?? {}) : [])];
    return ids
      .map((id) => {
        const dead = s?.deaths[id] ? "💀" : "";
        let me = "•";
        if (id === this.myId) {
          me = "★";
        } else if (id.startsWith("bot-")) {
          me = "🤖";
        }
        return `${me} ${this.labelFor(id)}${dead}`;
      })
      .join("   ");
  }

  private statsText(): string {
    if (!this.isAlive(this.myId)) {
      return "";
    }
    const st = this.myStats();
    const speedLvl = Math.round((BASE_MOVE_MS - st.speed) / SPEED_STEP_MS);
    return `💣 ${st.bombs}   🔥 ${st.range}   👟 ${speedLvl}`;
  }

  private setBanner(): void {
    if (!this.bannerEl) {
      return;
    }
    const s = this.shared();
    let text = "";
    if (s?.winner === "draw") {
      text = "Draw!";
    } else if (s?.winner) {
      text = s.winner === this.myId ? "🏆 You win!" : `${this.labelFor(s.winner)} wins!`;
    } else if (this.live && !this.isAlive(this.myId)) {
      text = "💥 Boom!";
    }
    if (text === this.lastBanner) {
      return;
    }
    this.lastBanner = text;
    this.bannerEl.textContent = text;
    this.bannerEl.style.opacity = text ? "1" : "0";
  }

  private labelFor(id: string): string {
    if (id === this.myId) {
      return "you";
    }
    if (id.startsWith("bot-")) {
      return `CPU ${id.slice(4)}`;
    }
    return id.slice(0, 4);
  }

  private setStatus(text: string): void {
    if (!this.statusEl || text === this.lastStatus) {
      return;
    }
    this.lastStatus = text;
    this.statusEl.textContent = text;
  }

  private setPlayersList(text: string): void {
    if (!this.playersEl || text === this.lastPlayers) {
      return;
    }
    this.lastPlayers = text;
    this.playersEl.textContent = text;
  }

  private setStats(text: string): void {
    if (!this.statsEl || text === this.lastStats) {
      return;
    }
    this.lastStats = text;
    this.statsEl.textContent = text;
  }
}
