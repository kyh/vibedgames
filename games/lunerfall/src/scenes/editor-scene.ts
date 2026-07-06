import Phaser from "phaser";

import { BASE_H, BASE_W, COLORS } from "../config";
import {
  type ClipInfo,
  clipsFor,
  type EnemyName,
  ENEMY_NAMES,
  firstFrame,
  type HeroName,
  HERO_NAMES,
} from "../data/animations";
import { HEROES } from "../data/heroes";
import { clipGameMs } from "../entities/player";

// ?editor=1 — an animation gallery / debug view. Cycles every character and lays
// out ALL of its clips at once, each looping at the authored timing with a frame
// count + duration readout, so a broken/mis-timed clip is obvious at a glance.
// LEFT/RIGHT switch character; the selected character's spell is named up top.

type Char = { key: HeroName; hero: true } | { key: EnemyName; hero: false };
const CHARS: Char[] = [
  ...HERO_NAMES.map((key): Char => ({ key, hero: true })),
  ...ENEMY_NAMES.map((key): Char => ({ key, hero: false })),
];
const COLS = 4;

export class EditorScene extends Phaser.Scene {
  private index = 0;
  private grid?: Phaser.GameObjects.Container;
  private name!: Phaser.GameObjects.Text;
  private sub!: Phaser.GameObjects.Text;

  constructor() {
    super("editor");
  }

  create() {
    this.add.rectangle(0, 0, BASE_W, BASE_H, COLORS.bgDeep).setOrigin(0);
    this.add
      .image(0, 0, "env:backdrop")
      .setOrigin(0)
      .setDisplaySize(BASE_W, BASE_H)
      .setTint(0x4a5570)
      .setAlpha(0.25);
    this.name = this.add
      .text(BASE_W / 2, 12, "", { fontFamily: "monospace", fontSize: "13px", color: "#34e5c8" })
      .setOrigin(0.5)
      .setDepth(10);
    this.sub = this.add
      .text(BASE_W / 2, 26, "", { fontFamily: "monospace", fontSize: "7px", color: "#8b95a1" })
      .setOrigin(0.5)
      .setDepth(10);
    this.add
      .text(BASE_W / 2, BASE_H - 8, "◀ ▶  character      teal = looping", {
        fontFamily: "monospace",
        fontSize: "7px",
        color: "#59636f",
      })
      .setOrigin(0.5)
      .setDepth(10);

    const kb = this.input.keyboard;
    kb?.on("keydown-LEFT", () => this.cycle(-1));
    kb?.on("keydown-A", () => this.cycle(-1));
    kb?.on("keydown-RIGHT", () => this.cycle(1));
    kb?.on("keydown-D", () => this.cycle(1));

    // ?char=riven jumps straight to one for quick auditing.
    const want = new URLSearchParams(location.search).get("char");
    const at = want ? CHARS.findIndex((c) => c.key === want) : -1;
    if (at >= 0) this.index = at;

    this.render();
  }

  private cycle(d: number) {
    this.index = (this.index + d + CHARS.length) % CHARS.length;
    this.render();
  }

  private render() {
    this.grid?.destroy();
    const char = CHARS[this.index];
    if (!char) return;
    const clips = clipsFor(this, char.key);
    const hero = char.hero ? HEROES[char.key] : undefined;

    this.name.setText(`${char.key.toUpperCase()}   (${this.index + 1}/${CHARS.length})`);
    const spell = hero ? `spell: ${hero.kit.special.kind} · ${hero.kit.special.clip}` : "enemy";
    this.sub.setText(`${clips.length} clips    ${spell}`);

    const g = this.add.container(0, 0);
    const gridTop = 40;
    const gridH = BASE_H - gridTop - 16;
    const rows = Math.max(1, Math.ceil(clips.length / COLS));
    const rowH = Math.min(62, gridH / rows);
    const cellW = BASE_W / COLS;
    const scale = char.hero ? Math.min(0.4, (rowH - 16) / 120) : Math.min(0.7, (rowH - 16) / 62);
    const originY = firstFrame(this, char.key) ? 0.62 : 0.5;

    clips.forEach((info, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = col * cellW + cellW / 2;
      const cy = gridTop + row * rowH;
      // Preview true in-game timing: heroes re-time swings/special/dash/run.
      const gm = hero ? clipGameMs(hero, info.clip) : undefined;
      g.add(
        this.add
          .rectangle(cx, cy + rowH / 2, cellW - 4, rowH - 3, info.loop ? 0x0e2a2c : 0x14171d, 0.6)
          .setStrokeStyle(1, info.loop ? COLORS.teal : 0x2a3340, 0.5),
      );
      const spr = this.add
        .sprite(cx, cy + rowH * 0.5, char.key, firstFrame(this, char.key))
        .setOrigin(0.5, originY)
        .setScale(scale);
      const cfg: Phaser.Types.Animations.PlayAnimationConfig = {
        key: `${char.key}:${info.clip}`,
        repeat: -1,
      };
      if (gm !== undefined) cfg.duration = gm;
      spr.play(cfg); // force-loop for the gallery
      g.add(spr);
      g.add(this.clipLabel(cx, cy + rowH - 8, info, gm));
    });
    this.grid = g;
  }

  private clipLabel(
    x: number,
    y: number,
    info: ClipInfo,
    gameMs: number | undefined,
  ): Phaser.GameObjects.Text {
    const flag = info.frames <= 1 ? " ⚠1f" : "";
    // Show authored ms, and the re-timed in-game ms when it differs.
    const timing =
      gameMs !== undefined && gameMs !== info.ms ? `${info.ms}→${gameMs}ms` : `${info.ms}ms`;
    const retimed = gameMs !== undefined && gameMs !== info.ms;
    return this.add
      .text(x, y, `${info.clip}  ${info.frames}f ${timing}${flag}`, {
        fontFamily: "monospace",
        fontSize: "6px",
        color: info.frames <= 1 ? "#ff8a5c" : retimed ? "#ffd15c" : "#c7d0db",
      })
      .setOrigin(0.5);
  }
}
