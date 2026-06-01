import { MultiplayerClient } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import {
  BOMB_RANGE,
  COLORS,
  EXPLOSION_MS,
  FUSE_MS,
  GRID_COLS,
  GRID_ROWS,
  MOVE_MS,
  newGrid,
  SPAWN_POINTS,
  TILE,
  type Bomb,
  type Blast,
  type Cell,
  type SharedState,
} from "../shared/constants";

type Dir = "up" | "down" | "left" | "right";
type MyState = { col: number; row: number; colorIdx: number };

const DIR_VECT: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

const ROOM = "bomberman-default";

function emptyShared(): SharedState {
  // Every field that should reset MUST be present here — the multiplayer
  // client merges shared-state patches via `{...prev, ...patch}`, so an
  // omitted field (e.g. `deaths`) carries over from the previous round.
  return {
    grid: newGrid(),
    bombs: {},
    blasts: {},
    deaths: {},
    winner: null,
    startedAt: Date.now(),
  };
}

function isShared(v: unknown): v is SharedState {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { grid?: unknown }).grid)
  );
}

export class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;

  private tileSprites: Phaser.GameObjects.Image[][] = [];
  private bombSprites = new Map<string, Phaser.GameObjects.Image>();
  private blastSprites = new Map<string, Phaser.GameObjects.Image[]>();
  private playerSprites = new Map<string, Phaser.GameObjects.Image>();
  private playerRings = new Map<string, Phaser.GameObjects.Graphics>();
  private labels = new Map<string, Phaser.GameObjects.Text>();

  private myCol = 0;
  private myRow = 0;
  private moveCooldown = 0;
  private hostTickAcc = 0;
  private localBombSeq = 1;
  // Direction queued by a keydown event but not yet consumed by the
  // movement tick. Lets a single keypress register reliably even when
  // an automation tool (Playwright, agent-browser) presses + releases
  // the key inside one frame, where polling `isDown`/`checkDown` would
  // miss it.
  private queuedDir: Dir | null = null;
  private heldKeys!: {
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
  };

  private statusEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.statusEl = document.getElementById("status");
    this.playersEl = document.getElementById("players");

    // Render an initial grid so the screen isn't empty before sync arrives.
    this.tileSprites = renderGrid(this, emptyShared().grid, []);

    this.client = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: "vg-server",
      room: ROOM,
      initialState: emptyShared(),
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
    });
    this.client.subscribe(() => this.onUpdate());

    const k = this.input.keyboard;
    if (k) {
      // SPACE is the canonical bomb key; B works too for "B for Bomb"
      // ergonomics and as an escape hatch for agent automation tools
      // that have known bugs around dispatching the Space code.
      k.on("keydown-SPACE", () => this.requestBomb());
      k.on("keydown-B", () => this.requestBomb());
      k.on("keydown-R", () => this.requestRestart());

      // Per-direction keydown listeners feed `queuedDir` so a single
      // press always lands at the next movement tick — even if the
      // key was already released by then.
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
      // Track held keys so holding a direction repeats the move at
      // the cooldown rate (human input ergonomics).
      this.heldKeys = {
        left: k.addKey("LEFT"),
        right: k.addKey("RIGHT"),
        up: k.addKey("UP"),
        down: k.addKey("DOWN"),
      };
      // WASD share the same Key slots — addKey deduplicates by code.
      k.addKey("A");
      k.addKey("D");
      k.addKey("W");
      k.addKey("S");
    }

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => this.client.destroy());

    // Dev-only handle for headless inspection from agent-browser / playwright.
    if (import.meta.env.DEV) {
      (window as unknown as { __bb?: { scene: GameScene; client: MultiplayerClient } }).__bb =
        { scene: this, client: this.client };
    }
  }

  override update(_time: number, delta: number): void {
    if (this.client.connectionStatus !== "connected") return;
    this.handleInput(delta);
    if (this.client.isHost) this.hostTick(delta);
  }

  // ---- input --------------------------------------------------------------

  private handleInput(delta: number): void {
    if (!this.isAlive(this.client.playerId)) return;
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
    this.moveCooldown = MOVE_MS;
    this.client.updateMyState({ col: nc, row: nr });
    this.tweenPlayer(this.client.playerId!, nc, nr);
  }

  private readDir(): Dir | null {
    // Consume a queued single-press first (registers reliably for any
    // press duration). Fall back to held-key state so holding a key
    // repeats at the cooldown rate.
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
    if (!this.isAlive(this.client.playerId)) return;
    if (this.bombAt(this.myCol, this.myRow)) return;
    this.client.sendEvent("place_bomb", {
      col: this.myCol,
      row: this.myRow,
      localId: this.localBombSeq++,
    });
  }

  private requestRestart(): void {
    if (this.client.isHost) {
      this.client.updateSharedState(emptyShared() as unknown as Record<string, unknown>);
      // Broadcast so every client (including this host) sends each
      // player back to their spawn — host can't write other players'
      // state directly, so this is event-driven.
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
    const colorIdx = idx % COLORS.length;
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.client.updateMyState({ col: spawn.col, row: spawn.row, colorIdx });
  }

  // ---- connection callbacks ------------------------------------------------

  private handleEvent(event: string, payload: unknown, _from: string): void {
    // All clients respect "round_restart" by sending themselves back
    // to spawn. Each player owns their own state, so the host can't do
    // it for them — it has to be an intent event.
    if (event === "round_restart") {
      this.respawnSelf();
      return;
    }
    if (!this.client.isHost) return;
    if (event === "place_bomb") {
      const p = payload as { col: number; row: number };
      this.hostPlaceBomb(_from, p.col, p.row);
    } else if (event === "request_restart") {
      this.client.updateSharedState(emptyShared() as unknown as Record<string, unknown>);
      this.client.sendEvent("round_restart", {});
    }
  }

  private onUpdate(): void {
    this.setStatus(this.statusText());
    this.setPlayers(this.playersText());
    this.ensureMySpawn();
    this.syncGrid();
    this.syncBombs();
    this.syncBlasts();
    this.syncPlayers();
  }

  // ---- shared-state rendering ---------------------------------------------

  private shared(): SharedState | null {
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
  }

  private syncGrid(): void {
    const s = this.shared();
    if (!s) return;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const sprite = this.tileSprites[r]?.[c];
        const cell = s.grid[r]?.[c];
        if (!sprite || !cell) continue;
        const key = textureFor(cell);
        if (sprite.texture.key !== key) sprite.setTexture(key);
      }
    }
  }

  private syncBombs(): void {
    const s = this.shared();
    if (!s) return;
    const seen = new Set<string>();
    for (const bomb of Object.values(s.bombs)) {
      seen.add(bomb.id);
      let sprite = this.bombSprites.get(bomb.id);
      if (!sprite) {
        sprite = this.add
          .image(colX(bomb.col), rowY(bomb.row), "bomb")
          .setDisplaySize(TILE, TILE)
          .setDepth(5);
        this.tweens.add({
          targets: sprite,
          scale: { from: 1, to: 1.12 },
          duration: 300,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
        this.bombSprites.set(bomb.id, sprite);
      }
    }
    for (const [id, sprite] of this.bombSprites)
      if (!seen.has(id)) {
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
      const sprites = blast.tiles.map((t) =>
        this.add.image(colX(t.col), rowY(t.row), "blast").setDepth(8),
      );
      this.blastSprites.set(blast.id, sprites);
    }
    for (const [id, sprites] of this.blastSprites)
      if (!seen.has(id)) {
        for (const sp of sprites) sp.destroy();
        this.blastSprites.delete(id);
      }
  }

  private syncPlayers(): void {
    const players = this.client.players;
    const seen = new Set<string>();
    let order = 0;
    for (const [id, player] of Object.entries(players)) {
      seen.add(id);
      const ms = (player.state as Partial<MyState>) ?? {};
      const col = typeof ms.col === "number" ? ms.col : SPAWN_POINTS[order]?.col ?? 1;
      const row = typeof ms.row === "number" ? ms.row : SPAWN_POINTS[order]?.row ?? 1;
      const colorIdx =
        typeof ms.colorIdx === "number" ? ms.colorIdx % COLORS.length : order % COLORS.length;
      order++;
      const tint = COLORS[colorIdx]!;
      let sprite = this.playerSprites.get(id);
      if (!sprite) {
        const ring = this.add.graphics().setDepth(9);
        ring.lineStyle(3, tint, 1).strokeCircle(0, 0, TILE / 2 - 3);
        ring.setPosition(colX(col), rowY(row));
        this.playerRings.set(id, ring);
        sprite = this.add
          .image(colX(col), rowY(row), "player")
          .setDisplaySize(TILE, TILE)
          .setDepth(10);
        this.playerSprites.set(id, sprite);
        const label = this.add
          .text(colX(col), rowY(row) - TILE / 2 - 4, this.labelFor(id), {
            fontSize: "10px",
            color: "#fff",
            fontFamily: "ui-monospace, monospace",
            backgroundColor: "rgba(0,0,0,0.5)",
            padding: { left: 3, right: 3, top: 1, bottom: 1 },
          })
          .setOrigin(0.5, 1)
          .setDepth(11);
        this.labels.set(id, label);
      }
      const alive = this.isAlive(id);
      sprite.setAlpha(alive ? 1 : 0.25);
    }
    for (const [id, sprite] of this.playerSprites)
      if (!seen.has(id)) {
        sprite.destroy();
        this.labels.get(id)?.destroy();
        this.playerRings.get(id)?.destroy();
        this.playerSprites.delete(id);
        this.labels.delete(id);
        this.playerRings.delete(id);
      }
  }

  // ---- host-only logic -----------------------------------------------------

  private hostTick(delta: number): void {
    this.hostTickAcc += delta;
    if (this.hostTickAcc < 80) return;
    this.hostTickAcc = 0;
    const s = this.shared();
    if (!s) return;
    const now = Date.now();
    const next: SharedState = {
      grid: s.grid,
      bombs: { ...s.bombs },
      blasts: { ...s.blasts },
      winner: s.winner,
      startedAt: s.startedAt,
    };
    let dirty = false;

    // Detonate expired bombs.
    for (const bomb of Object.values(s.bombs)) {
      if (now - bomb.placedAt < FUSE_MS) continue;
      const { tiles, newGrid } = computeExplosion(next.grid, bomb);
      next.grid = newGrid;
      delete next.bombs[bomb.id];
      const blast: Blast = {
        id: `x-${bomb.id}`,
        tiles,
        placedAt: now,
      };
      next.blasts[blast.id] = blast;
      dirty = true;
    }

    // Expire old blasts.
    for (const blast of Object.values(s.blasts)) {
      if (now - blast.placedAt >= EXPLOSION_MS) {
        delete next.blasts[blast.id];
        dirty = true;
      }
    }

    // Check player kills against live blasts.
    const liveBlasts = Object.values(next.blasts);
    if (liveBlasts.length > 0) {
      for (const [pid, player] of Object.entries(this.client.players)) {
        const ms = (player.state ?? {}) as Partial<MyState>;
        if (typeof ms.col !== "number" || typeof ms.row !== "number") continue;
        if (next.deaths?.[pid]) continue;
        const hit = liveBlasts.some((b) =>
          b.tiles.some((t) => t.col === ms.col && t.row === ms.row),
        );
        if (hit) {
          next.deaths = { ...(next.deaths ?? {}), [pid]: now };
          dirty = true;
        }
      }
    }

    // Winner check: last one alive (only if 2+ players ever).
    const playerIds = Object.keys(this.client.players);
    if (playerIds.length >= 2 && !next.winner) {
      const alive = playerIds.filter((id) => !next.deaths?.[id]);
      if (alive.length === 1) {
        next.winner = alive[0]!;
        dirty = true;
      } else if (alive.length === 0) {
        next.winner = "draw";
        dirty = true;
      }
    }

    if (dirty)
      this.client.updateSharedState(next as unknown as Record<string, unknown>);
  }

  private hostPlaceBomb(ownerId: string, col: number, row: number): void {
    const s = this.shared();
    if (!s) return;
    if (Object.values(s.bombs).some((b) => b.col === col && b.row === row)) return;
    if (!this.isAlive(ownerId)) return;
    const id = `b-${ownerId}-${Date.now()}`;
    const bomb: Bomb = {
      id,
      ownerId,
      col,
      row,
      placedAt: Date.now(),
      range: BOMB_RANGE,
    };
    const next: SharedState = {
      ...s,
      bombs: { ...s.bombs, [id]: bomb },
    };
    this.client.updateSharedState(next as unknown as Record<string, unknown>);
  }

  // ---- helpers -------------------------------------------------------------

  private ensureMySpawn(): void {
    const id = this.client.playerId;
    if (!id) return;
    const me = this.client.players[id];
    const ms = (me?.state ?? {}) as Partial<MyState>;
    if (typeof ms.col === "number" && typeof ms.row === "number") {
      this.myCol = ms.col;
      this.myRow = ms.row;
      return;
    }
    // Wait until the server has confirmed our presence so the index is stable.
    const idx = Object.keys(this.client.players).indexOf(id);
    if (idx < 0) return;
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0]!;
    const colorIdx = idx % COLORS.length;
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.client.updateMyState({ col: spawn.col, row: spawn.row, colorIdx });
  }

  private tweenPlayer(id: string, col: number, row: number): void {
    const sprite = this.playerSprites.get(id);
    if (!sprite) return;
    this.tweens.add({
      targets: sprite,
      x: colX(col),
      y: rowY(row),
      duration: MOVE_MS,
      ease: "Linear",
    });
    const label = this.labels.get(id);
    if (label) {
      this.tweens.add({
        targets: label,
        x: colX(col),
        y: rowY(row) - TILE / 2 - 4,
        duration: MOVE_MS,
        ease: "Linear",
      });
    }
    const ring = this.playerRings.get(id);
    if (ring) {
      this.tweens.add({
        targets: ring,
        x: colX(col),
        y: rowY(row),
        duration: MOVE_MS,
        ease: "Linear",
      });
    }
  }

  private bombAt(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) return false;
    return Object.values(s.bombs).some((b) => b.col === col && b.row === row);
  }

  private passable(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) return false;
    const cell = s.grid[row]?.[col];
    if (!cell || cell.kind !== "empty") return false;
    if (this.bombAt(col, row)) return false;
    return true;
  }

  private isAlive(id: string | null): boolean {
    if (!id) return false;
    const s = this.shared();
    if (!s) return true;
    return !s.deaths?.[id];
  }

  private statusText(): string {
    const cs = this.client.connectionStatus;
    if (cs !== "connected") return `${cs}…`;
    const s = this.shared();
    if (s?.winner === "draw") return "Draw — press R to restart";
    if (s?.winner)
      return s.winner === this.client.playerId
        ? "🏆 You won! Press R to restart"
        : `Winner: ${this.labelFor(s.winner)} · R to restart`;
    if (!this.isAlive(this.client.playerId)) return "💀 You exploded. Waiting…";
    return `WASD/Arrows move · SPACE/B bomb · R restart · ${this.client.isHost ? "host" : "guest"}`;
  }

  private playersText(): string {
    return Object.keys(this.client.players)
      .map((id) => `${id === this.client.playerId ? "★" : "•"} ${this.labelFor(id)}`)
      .join("  ");
  }

  private labelFor(id: string): string {
    return id === this.client.playerId ? "you" : id.slice(0, 4);
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private setPlayers(text: string): void {
    if (this.playersEl) this.playersEl.textContent = text;
  }
}

// ---- module helpers (pure) ---------------------------------------------------

function renderGrid(
  scene: Phaser.Scene,
  grid: Cell[][],
  _existing: Phaser.GameObjects.Image[][],
): Phaser.GameObjects.Image[][] {
  const tiles: Phaser.GameObjects.Image[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const row: Phaser.GameObjects.Image[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const cell = grid[r]?.[c] ?? { kind: "empty" as const };
      row.push(scene.add.image(colX(c), rowY(r), textureFor(cell)));
    }
    tiles.push(row);
  }
  return tiles;
}

function textureFor(cell: Cell): string {
  switch (cell.kind) {
    case "wall":
      return "wall";
    case "crate":
      return "crate";
    case "empty":
      return "floor";
  }
}

function colX(col: number): number {
  return col * TILE + TILE / 2;
}

function rowY(row: number): number {
  return row * TILE + TILE / 2;
}

function computeExplosion(
  grid: Cell[][],
  bomb: Bomb,
): { tiles: Array<{ col: number; row: number }>; newGrid: Cell[][] } {
  const tiles: Array<{ col: number; row: number }> = [
    { col: bomb.col, row: bomb.row },
  ];
  const nextGrid = grid.map((row) => row.slice());
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let step = 1; step <= bomb.range; step++) {
      const c = bomb.col + dc * step;
      const r = bomb.row + dr * step;
      const cell = nextGrid[r]?.[c];
      if (!cell || cell.kind === "wall") break;
      tiles.push({ col: c, row: r });
      if (cell.kind === "crate") {
        nextGrid[r]![c] = { kind: "empty" };
        break;
      }
    }
  }
  return { tiles, newGrid: nextGrid };
}
