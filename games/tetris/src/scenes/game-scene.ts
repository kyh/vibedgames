import Phaser from "phaser";

import { PoseCamera } from "../input/camera";
import { PoseControls } from "../input/pose-control";
import {
  ARR_MS,
  BEST_KEY,
  BLOCK,
  BOARD_H,
  BOARD_W,
  CLEAR_MS,
  collides,
  COLS,
  DAS_MS,
  GRAVITY_MS,
  HARD_DROP_POINTS,
  LEVEL_SPEEDUP,
  LINE_SCORES,
  LINES_PER_LEVEL,
  MIN_GRAVITY_MS,
  newBag,
  newGrid,
  PANEL_GAP,
  PANEL_W,
  PIECES,
  ROWS,
  rotateCW,
  SOFT_DROP_MS,
  SOFT_DROP_POINTS,
  SPAWN_X,
  type Grid,
  GHOST_ALPHA,
  PANEL_H,
  PREVIEW_SCALE,
  type Matrix,
} from "../shared/constants";

type GameState = "playing" | "clearing" | "paused" | "over";

type ActivePiece = { idx: number; matrix: Matrix; x: number; y: number };

export class GameScene extends Phaser.Scene {
  // Board data (authoritative) + parallel display objects.
  private grid: Grid = newGrid();
  private cells: Array<Array<Phaser.GameObjects.Image | null>> = [];
  private piece: ActivePiece = { idx: 0, matrix: PIECES[0]!.matrix, x: SPAWN_X, y: 0 };
  private bag: number[] = [];
  private nextIdx = 0;

  private state: GameState = "playing";
  private score = 0;
  private lines = 0;
  private best = 0;

  // Delta-time accumulators (gravity / soft drop / sideways auto-repeat).
  private gravityAcc = 0;
  private softAcc = 0;
  private dasDir: -1 | 0 | 1 = 0;
  private dasTimer = 0;
  private clearEvent: Phaser.Time.TimerEvent | null = null;

  // Display containers: root is scaled/centered to fit the window.
  private root!: Phaser.GameObjects.Container;
  private boardC!: Phaser.GameObjects.Container;
  private previewC!: Phaser.GameObjects.Container;
  private activeSprites: Phaser.GameObjects.Image[] = [];
  private ghostSprites: Phaser.GameObjects.Image[] = [];
  private previewSprites: Phaser.GameObjects.Image[] = [];

  private heldKeys!: {
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
  };

  private poseCamera: PoseCamera | null = null;

  private statsEl: HTMLElement | null = null;
  private bestEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private bannerTitleEl: HTMLElement | null = null;
  private bannerSubEl: HTMLElement | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.statsEl = document.getElementById("stats");
    this.bestEl = document.getElementById("best");
    this.bannerEl = document.getElementById("banner");
    this.bannerTitleEl = document.getElementById("banner-title");
    this.bannerSubEl = document.getElementById("banner-sub");

    this.best = readBest();

    this.buildPlayfield();
    this.bindInput();
    this.layout();

    // Webcam pose control (signature mechanic): nose-x steers the piece,
    // full-body poses pin the next piece, turning sideways rotates. Keyboard
    // stays fully functional; pose only acts while a body is detected.
    this.poseCamera?.destroy();
    const poseControls = new PoseControls({
      setColumn: (x) => this.poseSetColumn(x),
      rotate: () => this.rotate(),
      chooseNext: (i) => this.chooseNext(i),
    });
    this.poseCamera = new PoseCamera(poseControls.handlePose);
    void this.poseCamera.start();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
      this.clearEvent?.remove(false);
      this.poseCamera?.destroy();
      this.poseCamera = null;
    });

    this.resetGame();

    if (import.meta.env.DEV) {
      // Reviewers can drive gestures synthetically:
      //   __tetris.pose.actions.setColumn(3) / .rotate() / .chooseNext(0)
      //   __tetris.pose.handlePose({ keypoints: [...] }, null)
      (window as unknown as { __tetris?: unknown }).__tetris = { scene: this, pose: poseControls };
    }
  }

  override update(_time: number, delta: number): void {
    if (this.state !== "playing") return;
    // Clamp: boot/tab-switch frames can deliver multi-second deltas, which
    // would flood the gravity/DAS while-loops and teleport the piece down.
    const dt = Math.min(delta, 100);
    this.updateDas(dt);
    this.updateSoftDrop(dt);
    this.updateGravity(dt);
  }

  // ---- input ---------------------------------------------------------------

  private bindInput(): void {
    const k = this.input.keyboard;
    if (!k) return;
    k.addCapture("SPACE,UP,DOWN,LEFT,RIGHT");

    // Taps fire immediately on keydown; held repeat is our own DAS in update()
    // (e.repeat = the OS repeat, which we ignore in favor of DAS_MS/ARR_MS).
    k.on("keydown-LEFT", (e: KeyboardEvent) => {
      if (!e.repeat) this.tapMove(-1);
    });
    k.on("keydown-RIGHT", (e: KeyboardEvent) => {
      if (!e.repeat) this.tapMove(1);
    });
    k.on("keydown-DOWN", (e: KeyboardEvent) => {
      if (e.repeat || this.state !== "playing") return;
      this.softAcc = 0;
      this.softStep();
    });
    k.on("keydown-UP", (e: KeyboardEvent) => {
      if (!e.repeat) this.rotate();
    });
    k.on("keydown-X", (e: KeyboardEvent) => {
      if (!e.repeat) this.rotate();
    });
    k.on("keydown-SPACE", (e: KeyboardEvent) => {
      if (!e.repeat) this.hardDrop();
    });
    k.on("keydown-P", (e: KeyboardEvent) => {
      if (!e.repeat) this.togglePause();
    });
    k.on("keydown-R", (e: KeyboardEvent) => {
      if (!e.repeat) this.resetGame();
    });

    // Signature mechanic: digits 1-7 set the NEXT piece (one press, one piece).
    const DIGITS = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN"];
    DIGITS.forEach((code, i) => {
      k.on(`keydown-${code}`, () => this.chooseNext(i));
    });

    this.heldKeys = {
      left: k.addKey("LEFT"),
      right: k.addKey("RIGHT"),
      down: k.addKey("DOWN"),
    };
  }

  private tapMove(dir: -1 | 1): void {
    if (this.state !== "playing") return;
    this.tryMove(dir);
    this.dasDir = dir;
    this.dasTimer = DAS_MS;
  }

  private updateDas(delta: number): void {
    if (this.dasDir === 0) return;
    const held = this.dasDir === -1 ? this.heldKeys.left.isDown : this.heldKeys.right.isDown;
    if (!held) {
      // Fall back to the other still-held direction (release the newer key
      // while the older one is down) instead of going dead until re-press.
      const other: -1 | 1 = this.dasDir === -1 ? 1 : -1;
      const otherHeld = other === -1 ? this.heldKeys.left.isDown : this.heldKeys.right.isDown;
      this.dasDir = otherHeld ? other : 0;
      this.dasTimer = DAS_MS;
      return;
    }
    this.dasTimer -= delta;
    while (this.dasTimer <= 0) {
      this.tryMove(this.dasDir);
      this.dasTimer += ARR_MS;
    }
  }

  private updateSoftDrop(delta: number): void {
    if (!this.heldKeys.down.isDown) {
      this.softAcc = 0;
      return;
    }
    this.softAcc += delta;
    while (this.softAcc >= SOFT_DROP_MS && this.state === "playing") {
      this.softAcc -= SOFT_DROP_MS;
      this.softStep();
    }
  }

  private updateGravity(delta: number): void {
    this.gravityAcc += delta;
    const interval = this.gravityMs();
    while (this.gravityAcc >= interval && this.state === "playing") {
      this.gravityAcc -= interval;
      this.gravityStep();
    }
  }

  private togglePause(): void {
    if (this.state === "playing") {
      this.state = "paused";
      this.setBanner("PAUSED", "press P to resume");
    } else if (this.state === "paused") {
      this.state = "playing";
      this.hideBanner();
    }
  }

  // ---- game flow -------------------------------------------------------------

  private gravityMs(): number {
    const level = Math.floor(this.lines / LINES_PER_LEVEL);
    return Math.max(MIN_GRAVITY_MS, GRAVITY_MS * Math.pow(LEVEL_SPEEDUP, level));
  }

  private tryMove(dx: -1 | 1): void {
    const p = this.piece;
    if (collides(this.grid, p.matrix, p.x + dx, p.y)) return;
    p.x += dx;
    this.syncActive();
  }

  /**
   * CW rotate with a simple wall nudge: try in place, then x-1, then x+1.
   * Returns whether it applied — the pose rotation gesture only restarts its
   * 600ms cooldown on success (legacy lastRotationTime semantics).
   */
  private rotate(): boolean {
    if (this.state !== "playing") return false;
    const p = this.piece;
    const rotated = rotateCW(p.matrix);
    for (const nudge of [0, -1, 1]) {
      if (collides(this.grid, rotated, p.x + nudge, p.y)) continue;
      p.matrix = rotated;
      p.x += nudge;
      this.syncActive();
      return true;
    }
    return false;
  }

  /**
   * Pose control: absolute column from nose-x, teleported each detected
   * frame. Bounds-clamped only — the legacy webcam path never collision-
   * checked horizontal teleports. Keyboard tapMove keeps its checks.
   */
  private poseSetColumn(targetX: number): void {
    if (this.state !== "playing") return;
    const p = this.piece;
    const maxX = COLS - (p.matrix[0]?.length ?? 0);
    const newX = Math.max(0, Math.min(targetX, maxX));
    if (newX === p.x) return;
    p.x = newX;
    this.syncActive();
  }

  private softStep(): void {
    const p = this.piece;
    if (collides(this.grid, p.matrix, p.x, p.y + 1)) {
      this.lockPiece();
      return;
    }
    p.y += 1;
    this.score += SOFT_DROP_POINTS;
    this.gravityAcc = 0;
    this.syncActive();
    this.updateHud();
  }

  private gravityStep(): void {
    const p = this.piece;
    if (collides(this.grid, p.matrix, p.x, p.y + 1)) {
      this.lockPiece();
      return;
    }
    p.y += 1;
    this.syncActive();
  }

  private hardDrop(): void {
    if (this.state !== "playing") return;
    const p = this.piece;
    const dist = this.dropDistance();
    if (dist > 0) {
      p.y += dist;
      this.score += dist * HARD_DROP_POINTS;
    }
    this.syncActive();
    this.cameras.main.shake(90, 0.004);
    this.dropDust();
    this.lockPiece();
    this.updateHud();
  }

  private dropDistance(): number {
    const p = this.piece;
    let d = 0;
    while (!collides(this.grid, p.matrix, p.x, p.y + d + 1)) d++;
    return d;
  }

  /**
   * The single lock path (gravity, soft drop, and hard drop all land here),
   * so the top-out check can't be skipped — the legacy ArrowDown lock missed it.
   */
  private lockPiece(): void {
    const p = this.piece;
    const v = p.idx + 1;
    for (const { c, r } of pieceCells(p.matrix, p.x, p.y)) {
      if (r < 0) continue;
      this.grid[r]![c] = v;
      this.addCellSprite(r, c, v);
      this.lockFlash(r, c);
    }
    this.hideActive();

    const full: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      if (this.grid[r]!.every((cell) => cell !== 0)) full.push(r);
    }
    if (full.length > 0) {
      this.startClear(full);
    } else if (this.topOut()) {
      this.gameOver();
    } else {
      this.spawnPiece();
    }
  }

  private topOut(): boolean {
    return this.grid[0]!.some((cell) => cell !== 0);
  }

  private spawnPiece(): void {
    const idx = this.nextIdx;
    this.nextIdx = this.pullBag();
    this.syncPreview(false);
    this.piece = { idx, matrix: PIECES[idx]!.matrix, x: SPAWN_X, y: 0 };
    if (collides(this.grid, this.piece.matrix, this.piece.x, this.piece.y)) {
      this.gameOver();
      return;
    }
    this.gravityAcc = 0;
    this.syncActive();
  }

  private pullBag(): number {
    if (this.bag.length === 0) this.bag = newBag();
    return this.bag.pop() ?? 0;
  }

  /**
   * Keys 1-7: one press sets the next piece once; the 7-bag resumes after it
   * spawns. The webcam path calls this every detected frame, so a HELD pose
   * keeps re-pinning the next piece (legacy continuous-pinning behavior) —
   * the same-index early-return just stops the preview pulse from spamming.
   */
  private chooseNext(idx: number): void {
    if (this.state === "over" || this.state === "paused") return;
    if (this.nextIdx === idx) return;
    this.nextIdx = idx;
    this.syncPreview(true);
  }

  private gameOver(): void {
    this.state = "over";
    this.hideActive();
    if (this.score > this.best) {
      this.best = this.score;
      writeBest(this.best);
    }
    this.cameras.main.shake(220, 0.006);
    this.tweens.add({ targets: this.boardC, alpha: 0.4, duration: 350, ease: "Quad.Out" });
    this.setBanner(
      "GAME OVER",
      `score ${this.score.toLocaleString("en-US")} · best ${this.best.toLocaleString("en-US")} — press R to restart`,
    );
    this.updateHud();
  }

  private resetGame(): void {
    this.clearEvent?.remove(false);
    this.clearEvent = null;
    for (const row of this.cells) {
      for (const img of row) {
        if (img) {
          this.tweens.killTweensOf(img);
          img.destroy();
        }
      }
    }
    this.cells = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    this.grid = newGrid();
    this.score = 0;
    this.lines = 0;
    this.gravityAcc = 0;
    this.softAcc = 0;
    this.dasDir = 0;
    this.bag = newBag();
    this.nextIdx = this.pullBag();
    this.tweens.killTweensOf(this.boardC);
    this.boardC.setAlpha(1);
    this.hideBanner();
    this.state = "playing";
    this.syncPreview(false);
    this.spawnPiece();
    this.updateHud();
  }

  // ---- line clears -----------------------------------------------------------

  private startClear(rows: number[]): void {
    this.state = "clearing";

    const level = Math.floor(this.lines / LINES_PER_LEVEL);
    const points = (LINE_SCORES[rows.length] ?? 0) * (level + 1);
    this.score += points;
    this.lines += rows.length;

    // Flash each cleared row, fade its blocks out.
    for (const r of rows) {
      this.rowFlash(r);
      for (let c = 0; c < COLS; c++) {
        const img = this.cells[r]![c];
        if (!img) continue;
        this.tweens.add({
          targets: img,
          alpha: 0,
          duration: CLEAR_MS * 0.7,
          ease: "Quad.In",
          onComplete: () => img.destroy(),
        });
        this.cells[r]![c] = null;
      }
    }

    // Collapse the data grid immediately (remove-filled + unshift-empty).
    this.grid = this.grid.filter((_, r) => !rows.includes(r));
    while (this.grid.length < ROWS) this.grid.unshift(new Array<number>(COLS).fill(0));

    // Collapse the visuals: move surviving sprites to their new rows.
    const next: Array<Array<Phaser.GameObjects.Image | null>> = Array.from({ length: ROWS }, () =>
      new Array(COLS).fill(null),
    );
    for (let r = ROWS - 1; r >= 0; r--) {
      if (rows.includes(r)) continue;
      const drop = rows.filter((cr) => cr > r).length;
      for (let c = 0; c < COLS; c++) {
        const img = this.cells[r]![c];
        if (!img) continue;
        next[r + drop]![c] = img;
        if (drop > 0) {
          this.tweens.add({
            targets: img,
            y: (r + drop) * BLOCK,
            duration: CLEAR_MS * 0.6,
            delay: CLEAR_MS * 0.35,
            ease: "Cubic.In",
          });
        }
      }
    }
    this.cells = next;

    const mid = rows.reduce((a, b) => a + b, 0) / rows.length;
    this.scorePopup(points, mid);
    this.clearSparks(rows);

    this.clearEvent = this.time.delayedCall(CLEAR_MS, () => {
      this.clearEvent = null;
      if (this.state !== "clearing") return;
      this.state = "playing";
      if (this.topOut()) this.gameOver();
      else this.spawnPiece();
    });
    this.updateHud();
  }

  // ---- rendering sync ----------------------------------------------------------

  private buildPlayfield(): void {
    this.root = this.add.container(0, 0);

    this.boardC = this.add.container(0, 0);
    this.root.add(this.boardC);

    // Board well: slightly recessed interior, #333 grid lines, framed edge.
    const bg = this.add.rectangle(0, 0, BOARD_W, BOARD_H, 0x000000, 0.4).setOrigin(0);
    this.boardC.add(bg);
    const gridLines = this.add.graphics();
    gridLines.lineStyle(1, 0x333333, 1);
    for (let c = 1; c < COLS; c++) {
      gridLines.lineBetween(c * BLOCK, 0, c * BLOCK, BOARD_H);
    }
    for (let r = 1; r < ROWS; r++) {
      gridLines.lineBetween(0, r * BLOCK, BOARD_W, r * BLOCK);
    }
    this.boardC.add(gridLines);
    const frame = this.add.rectangle(-2, -2, BOARD_W + 4, BOARD_H + 4).setOrigin(0);
    frame.setStrokeStyle(2, 0x444444);
    this.boardC.add(frame);

    // Ghost under active piece; both pools live in the board container.
    for (let i = 0; i < 4; i++) {
      const ghost = this.add.image(0, 0, "block").setOrigin(0).setAlpha(GHOST_ALPHA);
      ghost.setDisplaySize(BLOCK, BLOCK).setVisible(false);
      this.boardC.add(ghost);
      this.ghostSprites.push(ghost);
    }
    for (let i = 0; i < 4; i++) {
      const img = this.add.image(0, 0, "block").setOrigin(0);
      img.setDisplaySize(BLOCK, BLOCK).setVisible(false);
      this.boardC.add(img);
      this.activeSprites.push(img);
    }

    // Side HUD panel: NEXT preview (never drawn inside the playfield).
    const panel = this.add.container(BOARD_W + PANEL_GAP, 0);
    this.root.add(panel);
    const pbg = this.add.rectangle(0, 0, PANEL_W, PANEL_H, 0x000000, 0.4).setOrigin(0);
    pbg.setStrokeStyle(2, 0x444444);
    panel.add(pbg);
    const label = this.add
      .text(PANEL_W / 2, BLOCK * 0.8, "NEXT", {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: "32px",
        color: "#9aa0b4",
      })
      .setOrigin(0.5)
      .setScale(0.5);
    panel.add(label);
    this.previewC = this.add.container(PANEL_W / 2, (PANEL_H + BLOCK * 1.6) / 2);
    panel.add(this.previewC);
    for (let i = 0; i < 4; i++) {
      const img = this.add.image(0, 0, "block");
      img.setDisplaySize(BLOCK * PREVIEW_SCALE, BLOCK * PREVIEW_SCALE).setVisible(false);
      this.previewC.add(img);
      this.previewSprites.push(img);
    }
  }

  private addCellSprite(r: number, c: number, v: number): void {
    const old = this.cells[r]![c];
    if (old) old.destroy();
    const img = this.add.image(c * BLOCK, r * BLOCK, "block").setOrigin(0);
    img.setDisplaySize(BLOCK, BLOCK).setTint(PIECES[v - 1]!.color);
    this.boardC.add(img);
    this.cells[r]![c] = img;
  }

  private syncActive(): void {
    const p = this.piece;
    const color = PIECES[p.idx]!.color;
    const cells = pieceCells(p.matrix, p.x, p.y);
    const dist = this.dropDistance();
    for (let i = 0; i < 4; i++) {
      const cell = cells[i];
      const img = this.activeSprites[i]!;
      const ghost = this.ghostSprites[i]!;
      if (!cell) {
        img.setVisible(false);
        ghost.setVisible(false);
        continue;
      }
      img
        .setVisible(true)
        .setTint(color)
        .setPosition(cell.c * BLOCK, cell.r * BLOCK);
      ghost
        .setVisible(dist > 0)
        .setTint(color)
        .setPosition(cell.c * BLOCK, (cell.r + dist) * BLOCK);
    }
  }

  private hideActive(): void {
    for (const img of this.activeSprites) img.setVisible(false);
    for (const img of this.ghostSprites) img.setVisible(false);
  }

  private syncPreview(pulse: boolean): void {
    const def = PIECES[this.nextIdx]!;
    const m = def.matrix;
    const h = m.length;
    const w = m[0]?.length ?? 0;
    const size = BLOCK * PREVIEW_SCALE;
    const cells = pieceCells(m, 0, 0);
    for (let i = 0; i < 4; i++) {
      const cell = cells[i];
      const img = this.previewSprites[i]!;
      if (!cell) {
        img.setVisible(false);
        continue;
      }
      img
        .setVisible(true)
        .setTint(def.color)
        .setPosition((cell.c - (w - 1) / 2) * size, (cell.r - (h - 1) / 2) * size);
    }
    if (pulse) {
      this.previewC.setScale(0.65);
      this.tweens.add({
        targets: this.previewC,
        scale: 1,
        duration: 200,
        ease: "Back.Out",
      });
    }
  }

  // ---- visual effects ----------------------------------------------------------

  private lockFlash(r: number, c: number): void {
    const flash = this.add
      .rectangle(c * BLOCK, r * BLOCK, BLOCK, BLOCK, 0xffffff, 0.7)
      .setOrigin(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.boardC.add(flash);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 110,
      ease: "Quad.Out",
      onComplete: () => flash.destroy(),
    });
  }

  private rowFlash(r: number): void {
    const flash = this.add
      .rectangle(0, r * BLOCK, BOARD_W, BLOCK, 0xffffff, 0.85)
      .setOrigin(0)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.boardC.add(flash);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: CLEAR_MS,
      ease: "Quad.Out",
      onComplete: () => flash.destroy(),
    });
  }

  private dropDust(): void {
    const p = this.piece;
    const cells = pieceCells(p.matrix, p.x, p.y);
    const bottom = Math.max(...cells.map((c) => c.r));
    const minC = Math.min(...cells.map((c) => c.c));
    const maxC = Math.max(...cells.map((c) => c.c));
    const { x, y } = this.boardToWorld(((minC + maxC + 1) / 2) * BLOCK, (bottom + 1) * BLOCK);
    this.burst(x, y, PIECES[p.idx]!.color, 12);
  }

  private clearSparks(rows: number[]): void {
    for (const r of rows) {
      const { x, y } = this.boardToWorld(BOARD_W / 2, (r + 0.5) * BLOCK);
      this.burst(x, y, 0xffffff, 14);
    }
  }

  private burst(x: number, y: number, tint: number, count: number): void {
    const emitter = this.add.particles(x, y, "spark", {
      speed: { min: 40, max: 180 },
      angle: { min: 0, max: 360 },
      lifespan: { min: 250, max: 500 },
      scale: { start: 0.9 * this.root.scaleX, end: 0 },
      alpha: { start: 1, end: 0 },
      tint,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(40);
    emitter.explode(count);
    this.time.delayedCall(700, () => emitter.destroy());
  }

  private scorePopup(points: number, midRow: number): void {
    const { x, y } = this.boardToWorld(BOARD_W / 2, midRow * BLOCK);
    const text = this.add
      .text(x, y, `+${points.toLocaleString("en-US")}`, {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: "26px",
        fontStyle: "bold",
        color: "#ffffff",
      })
      .setOrigin(0.5)
      .setDepth(50)
      .setScale(0.6);
    this.tweens.add({ targets: text, scale: 1, duration: 160, ease: "Back.Out" });
    this.tweens.add({
      targets: text,
      y: y - 44,
      alpha: 0,
      delay: 180,
      duration: 600,
      ease: "Quad.In",
      onComplete: () => text.destroy(),
    });
  }

  // ---- layout --------------------------------------------------------------

  /** Scale the board + panel to fit the window height, centered. */
  private layout(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const totalW = BOARD_W + PANEL_GAP + PANEL_W;
    const s = Math.min((h * 0.88) / BOARD_H, (w * 0.94) / totalW);
    this.root.setScale(s);
    this.root.setPosition((w - totalW * s) / 2, (h - BOARD_H * s) / 2);
  }

  private boardToWorld(lx: number, ly: number): { x: number; y: number } {
    return { x: this.root.x + lx * this.root.scaleX, y: this.root.y + ly * this.root.scaleY };
  }

  // ---- HUD -----------------------------------------------------------------

  private updateHud(): void {
    const level = Math.floor(this.lines / LINES_PER_LEVEL);
    if (this.statsEl) {
      this.statsEl.textContent = `SCORE ${this.score.toLocaleString("en-US")} · LINES ${this.lines} · LVL ${level + 1}`;
    }
    if (this.bestEl) {
      this.bestEl.textContent = `BEST ${Math.max(this.best, this.score).toLocaleString("en-US")}`;
    }
  }

  private setBanner(title: string, sub: string): void {
    if (this.bannerTitleEl) this.bannerTitleEl.textContent = title;
    if (this.bannerSubEl) this.bannerSubEl.textContent = sub;
    if (this.bannerEl) this.bannerEl.style.opacity = "1";
  }

  private hideBanner(): void {
    if (this.bannerEl) this.bannerEl.style.opacity = "0";
  }
}

// ---- module helpers (pure) --------------------------------------------------

function pieceCells(m: Matrix, x: number, y: number): Array<{ c: number; r: number }> {
  const cells: Array<{ c: number; r: number }> = [];
  for (let r = 0; r < m.length; r++) {
    const row = m[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c]) cells.push({ c: x + c, r: y + r });
    }
  }
  return cells;
}

function readBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeBest(value: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // Storage unavailable (private mode / sandbox) — best just won't persist.
  }
}
