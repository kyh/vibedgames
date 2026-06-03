import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import {
  baseStats,
  BASE_MOVE_MS,
  COLORS,
  EXPLOSION_MS,
  FUSE_MS,
  GRID_COLS,
  GRID_ROWS,
  MAX_BOMBS,
  MAX_RANGE,
  MIN_MOVE_MS,
  newGrid,
  POWERUP_DROP_CHANCE,
  SPAWN_POINTS,
  SPEED_STEP_MS,
  TILE,
  tileKey,
  WORLD_H,
  WORLD_W,
  type Blast,
  type Bomb,
  type Cell,
  type Dir,
  type PlayerStats,
  type Powerup,
  type PowerupKind,
  type SharedState,
} from "../shared/constants";

type MyState = { col: number; row: number; colorIdx: number; dir: Dir; moving: boolean };

type PlayerObjs = {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  col: number;
  row: number;
};

const DIR_VECT: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const POWERUP_KINDS: PowerupKind[] = ["bomb", "fire", "speed"];
const POWERUP_TEX: Record<PowerupKind, string> = {
  bomb: "pow-bomb",
  fire: "pow-fire",
  speed: "pow-speed",
};
const POWERUP_GLOW: Record<PowerupKind, number> = {
  bomb: 0xffe14a,
  fire: 0xff7a2a,
  speed: 0x5db8ff,
};

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

const ROOM = "bomberman-default";

function emptyShared(): SharedState {
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over from the previous round.
  return {
    grid: newGrid(),
    bombs: {},
    blasts: {},
    powerups: {},
    stats: {},
    deaths: {},
    winner: null,
    startedAt: Date.now(),
  };
}

function isShared(v: unknown): v is SharedState {
  return typeof v === "object" && v !== null && Array.isArray((v as { grid?: unknown }).grid);
}

type PartialPS = { col?: number; row?: number; colorIdx?: number; dir?: Dir; moving?: boolean };

function readPlayerState(player: Player | undefined): PartialPS {
  const s = player?.state;
  if (!s) return {};
  const num = (k: string): number | undefined => {
    const v = s[k];
    return typeof v === "number" ? v : undefined;
  };
  const dv = s["dir"];
  const dir: Dir | undefined =
    dv === "up" || dv === "down" || dv === "left" || dv === "right" ? dv : undefined;
  const mv = s["moving"];
  return {
    col: num("col"),
    row: num("row"),
    colorIdx: num("colorIdx"),
    dir,
    moving: typeof mv === "boolean" ? mv : undefined,
  };
}

export class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;

  private tileObjs: Array<Array<Phaser.GameObjects.Image | null>> = [];
  private tileKind: Array<Array<Cell["kind"] | null>> = [];
  private bombSprites = new Map<string, Phaser.GameObjects.Image>();
  private blastSprites = new Map<string, Phaser.GameObjects.Sprite[]>();
  private powerupObjs = new Map<string, Phaser.GameObjects.Container>();
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
  private heldKeys!: {
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
  };

  private statusEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.statusEl = document.getElementById("status");
    this.playersEl = document.getElementById("players");
    this.statsEl = document.getElementById("stats");
    this.bannerEl = document.getElementById("banner");

    // Continuous grass ground beneath everything (tiles cover the rest).
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, "floor").setOrigin(0, 0).setDepth(-10);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0e1020");
    cam.roundPixels = true;
    this.applyZoom();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyZoom, this);

    // No `initialState`: the package re-applies it whenever a client becomes
    // host, which would wipe a live round on host migration. Instead the first
    // host seeds the world explicitly (see `ensureSeeded`) — a promoted guest
    // already has the shared state and won't reset it.
    this.client = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: "vg-server",
      room: ROOM,
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
    });
    this.client.subscribe(() => this.onUpdate());

    this.bindInput();

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.applyZoom, this);
      this.client.destroy();
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __bb?: unknown }).__bb = { scene: this, client: this.client };
    }
  }

  private applyZoom(): void {
    // Keep ~9.5 board rows on screen so the camera meaningfully follows the
    // player instead of framing the whole map; clamp for tiny/huge screens.
    const zoom = Phaser.Math.Clamp(this.scale.height / (9.5 * TILE), 1.0, 2.4);
    this.cameras.main.setZoom(zoom);
  }

  override update(_time: number, delta: number): void {
    if (this.client.connectionStatus !== "connected") return;
    this.handleInput(delta);
    this.settleMoving();
    this.updateCamera();
    if (this.client.isHost) this.hostTick(delta);
  }

  /**
   * Manual zoom-aware follow. Phaser's `startFollow` + `setBounds` clamps
   * against the camera's *unzoomed* width, which reveals out-of-world void
   * when the map is narrower than the raw canvas but wider than the zoomed
   * viewport. Clamping the centre point ourselves avoids that.
   */
  private updateCamera(): void {
    const id = this.client.playerId;
    if (!id) return;
    const me = this.players.get(id);
    if (!me) return;
    const cam = this.cameras.main;
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
    const cx = WORLD_W <= 2 * halfW ? WORLD_W / 2 : Phaser.Math.Clamp(me.container.x, halfW, WORLD_W - halfW);
    const cy = WORLD_H <= 2 * halfH ? WORLD_H / 2 : Phaser.Math.Clamp(me.container.y, halfH, WORLD_H - halfH);
    const tx = cx - halfW;
    const ty = cy - halfH;
    if (!this.followStarted) {
      cam.setScroll(tx, ty);
      this.followStarted = true;
    } else {
      cam.setScroll(Phaser.Math.Linear(cam.scrollX, tx, 0.16), Phaser.Math.Linear(cam.scrollY, ty, 0.16));
    }
  }

  // ---- input ---------------------------------------------------------------

  private bindInput(): void {
    const k = this.input.keyboard;
    if (!k) return;
    k.on("keydown-SPACE", () => this.requestBomb());
    k.on("keydown-B", () => this.requestBomb());
    k.on("keydown-R", () => this.requestRestart());

    const KEY_TO_DIR: Array<[string, Dir]> = [
      ["LEFT", "left"], ["A", "left"],
      ["RIGHT", "right"], ["D", "right"],
      ["UP", "up"], ["W", "up"],
      ["DOWN", "down"], ["S", "down"],
    ];
    for (const [code, dir] of KEY_TO_DIR) {
      k.on(`keydown-${code}`, () => {
        this.queuedDir = dir;
      });
    }
    this.heldKeys = {
      left: k.addKey("LEFT"),
      right: k.addKey("RIGHT"),
      up: k.addKey("UP"),
      down: k.addKey("DOWN"),
    };
    k.addKey("A");
    k.addKey("D");
    k.addKey("W");
    k.addKey("S");
  }

  private handleInput(delta: number): void {
    const id = this.client.playerId;
    if (!this.isAlive(id)) return;
    this.moveCooldown = Math.max(0, this.moveCooldown - delta);
    if (this.moveCooldown > 0) return;
    const dir = this.readDir();
    if (!dir) return;
    const [dc, dr] = DIR_VECT[dir];
    const nc = this.myCol + dc;
    const nr = this.myRow + dr;
    if (!this.passable(nc, nr)) return;
    this.myCol = nc;
    this.myRow = nr;
    this.myDir = dir;
    this.moving = true;
    this.moveCooldown = this.myStats().speed;
    this.lastMoveAt = this.time.now;
    this.client.updateMyState({
      col: nc,
      row: nr,
      dir,
      moving: true,
      colorIdx: this.myColorIdx(),
    });
    this.tweenPlayer(id, nc, nr, this.moveCooldown);
  }

  /** Drop back to the idle pose shortly after the last successful step. */
  private settleMoving(): void {
    if (!this.moving) return;
    if (this.time.now - this.lastMoveAt < this.myStats().speed + 70) return;
    this.moving = false;
    if (this.client.playerId) this.client.updateMyState({ moving: false });
  }

  private readDir(): Dir | null {
    if (this.queuedDir) {
      const d = this.queuedDir;
      this.queuedDir = null;
      return d;
    }
    if (!this.heldKeys) return null;
    if (this.heldKeys.left.isDown) return "left";
    if (this.heldKeys.right.isDown) return "right";
    if (this.heldKeys.up.isDown) return "up";
    if (this.heldKeys.down.isDown) return "down";
    return null;
  }

  private requestBomb(): void {
    const id = this.client.playerId;
    if (!this.isAlive(id)) return;
    if (this.bombAt(this.myCol, this.myRow)) return;
    this.client.sendEvent("place_bomb", { col: this.myCol, row: this.myRow, localId: this.localBombSeq++ });
  }

  private requestRestart(): void {
    if (this.client.isHost) {
      this.writeShared(emptyShared());
      this.client.sendEvent("round_restart", {});
      this.respawnSelf();
    } else {
      this.client.sendEvent("request_restart", {});
    }
  }

  private respawnSelf(): void {
    const id = this.client.playerId;
    if (!id) return;
    const idx = Object.keys(this.client.players).indexOf(id);
    if (idx < 0) return;
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0]!;
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
    this.client.updateMyState({
      col: spawn.col,
      row: spawn.row,
      colorIdx: idx % COLORS.length,
      dir: "down",
      moving: false,
    });
  }

  // ---- connection callbacks ------------------------------------------------

  private handleEvent(event: string, payload: unknown, from: string): void {
    if (event === "round_restart") {
      this.respawnSelf();
      return;
    }
    if (!this.client.isHost) return;
    if (event === "place_bomb") {
      const p = payload as { col?: unknown; row?: unknown };
      if (typeof p.col === "number" && typeof p.row === "number") {
        this.hostPlaceBomb(from, p.col, p.row);
      }
    } else if (event === "request_restart") {
      this.writeShared(emptyShared());
      this.client.sendEvent("round_restart", {});
    }
  }

  private onUpdate(): void {
    this.ensureSeeded();
    this.setStatus(this.statusText());
    this.setPlayersList(this.playersListText());
    this.setStats(this.statsText());
    this.setBanner();
    this.ensureMySpawn();
    this.syncGrid();
    this.syncBombs();
    this.syncBlasts();
    this.syncPowerups();
    this.syncPlayers();
  }

  // ---- shared-state rendering ----------------------------------------------

  private shared(): SharedState | null {
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
  }

  /**
   * The first host to connect seeds the world. Guests adopt the host's
   * existing state; a guest promoted to host after a migration keeps the
   * live round instead of resetting it.
   */
  private ensureSeeded(): void {
    if (this.client.isHost && this.client.connectionStatus === "connected" && !this.shared()) {
      this.writeShared(emptyShared());
    }
  }

  private syncGrid(): void {
    const s = this.shared();
    if (!s) return;
    for (let r = 0; r < GRID_ROWS; r++) {
      this.tileObjs[r] ??= [];
      this.tileKind[r] ??= [];
      for (let c = 0; c < GRID_COLS; c++) {
        const kind = s.grid[r]?.[c]?.kind ?? "empty";
        if (this.tileKind[r]![c] === kind) continue;
        const prev = this.tileObjs[r]![c];
        if (this.tileKind[r]![c] === "crate" && kind === "empty") this.crateBreak(c, r);
        if (prev) {
          prev.destroy();
          this.tileObjs[r]![c] = null;
        }
        if (kind === "wall" || kind === "crate") {
          this.tileObjs[r]![c] = this.add
            .image(colX(c), rowY(r), kind === "wall" ? "wall" : "crate")
            .setDisplaySize(TILE, TILE)
            .setDepth(1);
        }
        this.tileKind[r]![c] = kind;
      }
    }
  }

  private syncBombs(): void {
    const s = this.shared();
    if (!s) return;
    const now = Date.now();
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
          targets: sprite,
          scaleX: { from: sprite.scaleX, to: sprite.scaleX * 1.14 },
          scaleY: { from: sprite.scaleY, to: sprite.scaleY * 0.86 },
          duration: 300,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
        this.bombSprites.set(bomb.id, sprite);
      }
      // Flash red in the final stretch of the fuse.
      const left = FUSE_MS - (now - bomb.placedAt);
      if (left < 700 && Math.floor(left / 110) % 2 === 0) sprite.setTint(0xff4d4d);
      else sprite.clearTint();
    }
    for (const [id, sprite] of this.bombSprites)
      if (!seen.has(id)) {
        this.tweens.killTweensOf(sprite);
        sprite.destroy();
        this.bombSprites.delete(id);
      }
  }

  private syncBlasts(): void {
    const s = this.shared();
    if (!s) return;
    const seen = new Set<string>();
    for (const blast of Object.values(s.blasts)) {
      seen.add(blast.id);
      if (this.blastSprites.has(blast.id)) continue;
      const sprites = blast.tiles.map((t) => {
        const sp = this.add
          .sprite(colX(t.col), rowY(t.row), "explosion", 0)
          .setDisplaySize(TILE * 1.35, TILE * 1.35)
          .setDepth(30)
          .setAngle(Phaser.Math.Between(0, 3) * 90)
          .setBlendMode(Phaser.BlendModes.ADD);
        sp.play({ key: "explode", startFrame: Phaser.Math.Between(0, 2) });
        return sp;
      });
      this.blastSprites.set(blast.id, sprites);
      this.shakeIfNear(blast.tiles);
    }
    for (const [id, sprites] of this.blastSprites)
      if (!seen.has(id)) {
        for (const sp of sprites) sp.destroy();
        this.blastSprites.delete(id);
      }
  }

  private syncPowerups(): void {
    const s = this.shared();
    if (!s) return;
    const seen = new Set<string>();
    for (const [key, pu] of Object.entries(s.powerups)) {
      seen.add(key);
      if (this.powerupObjs.has(key)) continue;
      const x = colX(pu.col);
      const y = rowY(pu.row);
      const glow = this.add
        .image(0, 0, "glow")
        .setDisplaySize(TILE * 1.5, TILE * 1.5)
        .setTint(POWERUP_GLOW[pu.kind])
        .setBlendMode(Phaser.BlendModes.ADD);
      const icon = this.add.image(0, 0, POWERUP_TEX[pu.kind]).setDisplaySize(TILE * 0.7, TILE * 0.7);
      const container = this.add.container(x, y, [glow, icon]).setDepth(4);
      this.tweens.add({ targets: icon, y: -6, duration: 760, ease: "Sine.InOut", yoyo: true, repeat: -1 });
      this.tweens.add({ targets: glow, alpha: { from: 0.5, to: 1 }, scale: { from: 0.92, to: 1.08 }, duration: 900, ease: "Sine.InOut", yoyo: true, repeat: -1 });
      this.powerupObjs.set(key, container);
      this.powerupKind.set(key, pu.kind);
    }
    for (const [key, container] of this.powerupObjs)
      if (!seen.has(key)) {
        const kind = this.powerupKind.get(key);
        this.burst(container.x, container.y, kind ? POWERUP_GLOW[kind] : 0xffffff, 18);
        // Children carry repeat:-1 tweens; killing the container alone leaves
        // them running on destroyed targets.
        this.tweens.killTweensOf(container.list);
        container.destroy();
        this.powerupObjs.delete(key);
        this.powerupKind.delete(key);
      }
  }

  private syncPlayers(): void {
    const players = this.client.players;
    const seen = new Set<string>();
    let order = 0;
    for (const [id, player] of Object.entries(players)) {
      seen.add(id);
      const ps = readPlayerState(player);
      const fallback = SPAWN_POINTS[order] ?? SPAWN_POINTS[0]!;
      const col = ps.col ?? fallback.col;
      const row = ps.row ?? fallback.row;
      const colorIdx = (ps.colorIdx ?? order) % COLORS.length;
      const dir = ps.dir ?? "down";
      const moving = ps.moving ?? false;
      order++;

      const objs = this.players.get(id) ?? this.createPlayer(id, col, row, colorIdx);
      const dead = !this.isAlive(id);

      if (dead && !this.deathSeen.has(id)) {
        this.deathSeen.add(id);
        this.playDeath(objs);
      } else if (!dead && this.deathSeen.has(id)) {
        this.deathSeen.delete(id);
        this.reviveVisual(objs);
      }

      if (!dead) {
        this.applyAnim(objs.sprite, dir, moving);
        if (id !== this.client.playerId && (objs.col !== col || objs.row !== row)) {
          this.tweenContainer(objs, col, row);
        }
      }
    }
    for (const [id, objs] of this.players)
      if (!seen.has(id)) {
        this.tweens.killTweensOf(objs.container);
        this.tweens.killTweensOf(objs.container.list);
        objs.container.destroy();
        this.players.delete(id);
        this.deathSeen.delete(id);
      }
  }

  private createPlayer(id: string, col: number, row: number, colorIdx: number): PlayerObjs {
    const tint = COLORS[colorIdx]!;
    const isMe = id === this.client.playerId;

    const shadow = this.add.image(0, TILE * 0.34, "shadow").setDisplaySize(TILE * 0.7, TILE * 0.34);
    const ring = this.add.graphics();
    ring.lineStyle(isMe ? 4 : 3, tint, isMe ? 1 : 0.85).strokeEllipse(0, TILE * 0.34, TILE * 0.62, TILE * 0.3);
    const sprite = this.add.sprite(0, -TILE * 0.06, "player-down", 0).setDisplaySize(TILE * 0.95, TILE * 0.95);
    const label = this.add
      .text(0, -TILE * 0.62, this.labelFor(id), {
        fontSize: "13px",
        color: isMe ? "#ffffff" : "#dfe6ff",
        fontFamily: "ui-monospace, monospace",
        fontStyle: isMe ? "bold" : "normal",
        backgroundColor: "rgba(8,10,26,0.55)",
        padding: { left: 4, right: 4, top: 1, bottom: 1 },
      })
      .setOrigin(0.5, 1);

    const container = this.add.container(colX(col), rowY(row), [shadow, ring, sprite, label]).setDepth(10);
    const objs: PlayerObjs = { container, sprite, ring, label, col, row };
    this.players.set(id, objs);
    return objs;
  }

  private applyAnim(sprite: Phaser.GameObjects.Sprite, dir: Dir, moving: boolean): void {
    const tex = dir === "up" ? "player-up" : dir === "down" ? "player-down" : "player-side";
    sprite.setFlipX(dir === "left");
    if (moving) {
      const key = dir === "up" ? "walk-up" : dir === "down" ? "walk-down" : "walk-side";
      if (sprite.anims.currentAnim?.key !== key || !sprite.anims.isPlaying) sprite.anims.play(key, true);
    } else {
      sprite.anims.stop();
      sprite.setTexture(tex, 0);
    }
  }

  // ---- host-only logic -----------------------------------------------------

  private hostTick(delta: number): void {
    this.hostTickAcc += delta;
    if (this.hostTickAcc < 70) return;
    this.hostTickAcc = 0;
    const s = this.shared();
    if (!s) return;
    const now = Date.now();

    const next: SharedState = {
      grid: s.grid,
      bombs: { ...s.bombs },
      blasts: { ...s.blasts },
      powerups: { ...s.powerups },
      stats: { ...s.stats },
      deaths: { ...s.deaths },
      winner: s.winner,
      startedAt: s.startedAt,
    };
    let dirty = false;

    // Seed default stats for any player the host hasn't recorded yet.
    for (const pid of Object.keys(this.client.players)) {
      if (!next.stats[pid]) {
        next.stats[pid] = baseStats();
        dirty = true;
      }
    }
    // Prune stats/deaths for players who have left so the shared object can't
    // grow unbounded across a long session (only marks dirty when it removes
    // something, preserving the no-write-when-idle property).
    const active = new Set(Object.keys(this.client.players));
    for (const pid of Object.keys(next.stats))
      if (!active.has(pid)) {
        delete next.stats[pid];
        dirty = true;
      }
    for (const pid of Object.keys(next.deaths))
      if (!active.has(pid)) {
        delete next.deaths[pid];
        dirty = true;
      }

    // Detonate expired bombs, cascading through any bombs caught in a blast.
    const expired = Object.values(s.bombs).filter((b) => now - b.placedAt >= FUSE_MS);
    if (expired.length > 0) {
      const detonated = new Set<string>();
      const queue: Bomb[] = [...expired];
      const cratesToClear = new Map<string, { col: number; row: number }>();
      const newBlastTiles = new Set<string>();
      while (queue.length > 0) {
        const bomb = queue.shift()!;
        if (detonated.has(bomb.id)) continue;
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
        for (const cr of crates) cratesToClear.set(tileKey(cr.col, cr.row), cr);
        next.blasts[`x-${bomb.id}`] = { id: `x-${bomb.id}`, tiles, placedAt: now };
      }
      for (const id of detonated) delete next.bombs[id];

      if (cratesToClear.size > 0) {
        const grid = s.grid.map((row) => row.slice());
        for (const cr of cratesToClear.values()) grid[cr.row]![cr.col] = { kind: "empty" };
        next.grid = grid;
      }
      // Existing powerups caught in the blast are destroyed...
      for (const key of Object.keys(next.powerups)) {
        if (newBlastTiles.has(key)) delete next.powerups[key];
      }
      // ...then freshly-cleared crates may reveal a new one.
      for (const cr of cratesToClear.values()) {
        const key = tileKey(cr.col, cr.row);
        if (!next.powerups[key] && Math.random() < POWERUP_DROP_CHANCE) {
          next.powerups[key] = { col: cr.col, row: cr.row, kind: randomKind() };
        }
      }
      dirty = true;
    }

    // Expire spent blasts.
    for (const blast of Object.values(next.blasts)) {
      if (now - blast.placedAt >= EXPLOSION_MS) {
        delete next.blasts[blast.id];
        dirty = true;
      }
    }

    // Powerup pickups by living players.
    for (const [pid, player] of Object.entries(this.client.players)) {
      if (next.deaths[pid]) continue;
      const ps = readPlayerState(player);
      if (ps.col === undefined || ps.row === undefined) continue;
      const key = tileKey(ps.col, ps.row);
      const pu = next.powerups[key];
      if (!pu) continue;
      next.stats[pid] = grantPowerup(next.stats[pid] ?? baseStats(), pu.kind);
      delete next.powerups[key];
      dirty = true;
    }

    // Deaths from live blasts.
    const liveBlasts = Object.values(next.blasts);
    if (liveBlasts.length > 0) {
      for (const [pid, player] of Object.entries(this.client.players)) {
        if (next.deaths[pid]) continue;
        const ps = readPlayerState(player);
        if (ps.col === undefined || ps.row === undefined) continue;
        const hit = liveBlasts.some((b) => b.tiles.some((t) => t.col === ps.col && t.row === ps.row));
        if (hit) {
          next.deaths[pid] = now;
          dirty = true;
        }
      }
    }

    // Last player standing wins (only once 2+ players have joined).
    const playerIds = Object.keys(this.client.players);
    if (playerIds.length >= 2 && !next.winner) {
      const alive = playerIds.filter((id) => !next.deaths[id]);
      if (alive.length === 1) {
        next.winner = alive[0]!;
        dirty = true;
      } else if (alive.length === 0) {
        next.winner = "draw";
        dirty = true;
      }
    }

    if (dirty) this.writeShared(next);
  }

  private hostPlaceBomb(ownerId: string, col: number, row: number): void {
    const s = this.shared();
    if (!s) return;
    if (!this.isAlive(ownerId)) return;
    if (Object.values(s.bombs).some((b) => b.col === col && b.row === row)) return;
    const stats = s.stats[ownerId] ?? baseStats();
    const active = Object.values(s.bombs).filter((b) => b.ownerId === ownerId).length;
    if (active >= stats.bombs) return;
    const id = `b-${ownerId}-${Date.now()}-${col}-${row}`;
    const bomb: Bomb = { id, ownerId, col, row, placedAt: Date.now(), range: stats.range };
    this.writeShared({ ...s, bombs: { ...s.bombs, [id]: bomb } });
  }

  // ---- visual effects ------------------------------------------------------

  private tweenPlayer(id: string | null, col: number, row: number, duration: number): void {
    if (!id) return;
    const objs = this.players.get(id);
    if (objs) this.tweenContainer(objs, col, row, duration);
  }

  private tweenContainer(objs: PlayerObjs, col: number, row: number, duration = 150): void {
    objs.col = col;
    objs.row = row;
    this.tweens.add({ targets: objs.container, x: colX(col), y: rowY(row), duration, ease: "Linear" });
  }

  private playDeath(objs: PlayerObjs): void {
    objs.ring.setVisible(false);
    this.burst(objs.container.x, objs.container.y, 0xffffff, 22);
    this.tweens.add({
      targets: objs.sprite,
      angle: 540,
      scale: 0,
      alpha: 0.2,
      duration: 460,
      ease: "Cubic.In",
    });
  }

  private reviveVisual(objs: PlayerObjs): void {
    this.tweens.killTweensOf(objs.sprite);
    objs.sprite.setAngle(0).setAlpha(1).setScale(1);
    objs.sprite.setDisplaySize(TILE * 0.95, TILE * 0.95);
    objs.ring.setVisible(true);
  }

  private crateBreak(col: number, row: number): void {
    this.burst(colX(col), rowY(row), 0xc78a4a, 14);
  }

  private burst(x: number, y: number, tint: number, count: number): void {
    const emitter = this.add.particles(x, y, "spark", {
      speed: { min: 40, max: 190 },
      angle: { min: 0, max: 360 },
      lifespan: { min: 280, max: 560 },
      scale: { start: 1.1, end: 0 },
      alpha: { start: 1, end: 0 },
      tint,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(40);
    emitter.explode(count);
    this.time.delayedCall(700, () => emitter.destroy());
  }

  private shakeIfNear(tiles: Array<{ col: number; row: number }>): void {
    const near = tiles.some(
      (t) => Math.abs(t.col - this.myCol) + Math.abs(t.row - this.myRow) <= 3,
    );
    if (near) this.cameras.main.shake(110, 0.005);
  }

  // ---- helpers -------------------------------------------------------------

  private myStats(): PlayerStats {
    const id = this.client.playerId;
    const s = this.shared();
    return (id && s?.stats[id]) || baseStats();
  }

  private myColorIdx(): number {
    const id = this.client.playerId;
    if (!id) return 0;
    const ps = readPlayerState(this.client.players[id]);
    if (ps.colorIdx !== undefined) return ps.colorIdx % COLORS.length;
    const idx = Object.keys(this.client.players).indexOf(id);
    return (idx < 0 ? 0 : idx) % COLORS.length;
  }

  private ensureMySpawn(): void {
    const id = this.client.playerId;
    if (!id) return;
    const ps = readPlayerState(this.client.players[id]);
    if (ps.col !== undefined && ps.row !== undefined) {
      // Adopt the authoritative position unless we're mid-step locally.
      if (!this.moving) {
        this.myCol = ps.col;
        this.myRow = ps.row;
      }
      return;
    }
    const idx = Object.keys(this.client.players).indexOf(id);
    if (idx < 0) return;
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0]!;
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.client.updateMyState({
      col: spawn.col,
      row: spawn.row,
      colorIdx: idx % COLORS.length,
      dir: "down",
      moving: false,
    });
  }

  private bombAt(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) return false;
    return Object.values(s.bombs).some((b) => b.col === col && b.row === row);
  }

  private passable(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) return false;
    if (s.grid[row]?.[col]?.kind !== "empty") return false;
    return !this.bombAt(col, row);
  }

  private isAlive(id: string | null): boolean {
    if (!id) return false;
    const s = this.shared();
    if (!s) return true;
    return !s.deaths[id];
  }

  private writeShared(next: SharedState): void {
    // The client API takes an opaque record; SharedState is our typed view of it.
    this.client.updateSharedState(next as unknown as Record<string, unknown>);
  }

  // ---- HUD -----------------------------------------------------------------

  private statusText(): string {
    const cs = this.client.connectionStatus;
    if (cs !== "connected") return `${cs}…`;
    const s = this.shared();
    if (s?.winner) return s.winner === "draw" ? "Round over — press R" : "Round over — press R";
    if (!this.isAlive(this.client.playerId)) return "💀 Out — waiting for the round to end";
    return `WASD / arrows to move · SPACE to drop a bomb · R to restart · ${this.client.isHost ? "host" : "guest"}`;
  }

  private playersListText(): string {
    const s = this.shared();
    return Object.keys(this.client.players)
      .map((id) => {
        const dead = s?.deaths[id] ? "💀" : "";
        const me = id === this.client.playerId ? "★" : "•";
        return `${me} ${this.labelFor(id)}${dead}`;
      })
      .join("   ");
  }

  private statsText(): string {
    if (!this.isAlive(this.client.playerId)) return "";
    const st = this.myStats();
    const speedLvl = Math.round((BASE_MOVE_MS - st.speed) / SPEED_STEP_MS);
    return `💣 ${st.bombs}   🔥 ${st.range}   👟 ${speedLvl}`;
  }

  private setBanner(): void {
    if (!this.bannerEl) return;
    const s = this.shared();
    let text = "";
    if (s?.winner === "draw") text = "Draw!";
    else if (s?.winner) text = s.winner === this.client.playerId ? "🏆 You win!" : `${this.labelFor(s.winner)} wins!`;
    else if (this.client.connectionStatus === "connected" && !this.isAlive(this.client.playerId)) text = "💥 Boom!";
    this.bannerEl.textContent = text;
    this.bannerEl.style.opacity = text ? "1" : "0";
  }

  private labelFor(id: string): string {
    return id === this.client.playerId ? "you" : id.slice(0, 4);
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private setPlayersList(text: string): void {
    if (this.playersEl) this.playersEl.textContent = text;
  }

  private setStats(text: string): void {
    if (this.statsEl) this.statsEl.textContent = text;
  }
}

// ---- module helpers (pure) --------------------------------------------------

function colX(col: number): number {
  return col * TILE + TILE / 2;
}

function rowY(row: number): number {
  return row * TILE + TILE / 2;
}

function randomKind(): PowerupKind {
  return POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)]!;
}

function grantPowerup(stats: PlayerStats, kind: PowerupKind): PlayerStats {
  switch (kind) {
    case "bomb":
      return { ...stats, bombs: Math.min(MAX_BOMBS, stats.bombs + 1) };
    case "fire":
      return { ...stats, range: Math.min(MAX_RANGE, stats.range + 1) };
    case "speed":
      return { ...stats, speed: Math.max(MIN_MOVE_MS, stats.speed - SPEED_STEP_MS) };
  }
}

function computeBlastTiles(
  grid: Cell[][],
  bomb: Bomb,
): { tiles: Array<{ col: number; row: number }>; crates: Array<{ col: number; row: number }> } {
  const tiles: Array<{ col: number; row: number }> = [{ col: bomb.col, row: bomb.row }];
  const crates: Array<{ col: number; row: number }> = [];
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let step = 1; step <= bomb.range; step++) {
      const c = bomb.col + dc * step;
      const r = bomb.row + dr * step;
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === "wall") break;
      tiles.push({ col: c, row: r });
      if (cell.kind === "crate") {
        crates.push({ col: c, row: r });
        break;
      }
    }
  }
  return { tiles, crates };
}
