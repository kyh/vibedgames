import Phaser from "phaser";

// Tiny Swords troop sheets are a uniform 192×192 grid. Terrain tiles are 64px.
// FX strips vary. Frame *ranges* (which rows are idle/walk/attack) are resolved
// in AnimRegistry, discovered/verified at runtime — see render/anims.ts.
const UNIT = 192;

const UNIT_KEYS = [
  "warrior",
  "pawn",
  "archer",
  "torch",
  "tnt",
  "barrel",
] as const;
const COLORS = ["blue", "red", "purple", "yellow"] as const;

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    const f = { frameWidth: UNIT, frameHeight: UNIT };

    // --- unit sheets (every color variant we might team-paint) ---
    for (const u of UNIT_KEYS) {
      for (const c of COLORS) {
        this.load.spritesheet(`u-${u}-${c}`, `assets/units/${u}_${c}.png`, f);
      }
    }

    // --- buildings (static) ---
    for (const c of COLORS) {
      this.load.image(`b-castle-${c}`, `assets/buildings/castle_${c}.png`);
      this.load.image(`b-tower-${c}`, `assets/buildings/tower_${c}.png`);
      this.load.image(`b-house-${c}`, `assets/buildings/house_${c}.png`);
    }
    this.load.image("b-castle-destroyed", "assets/buildings/castle_destroyed.png");
    this.load.image("b-tower-destroyed", "assets/buildings/tower_destroyed.png");

    // --- terrain ---
    this.load.spritesheet("t-ground", "assets/terrain/ground_flat.png", {
      frameWidth: 64,
      frameHeight: 64,
    });
    this.load.image("t-water", "assets/terrain/water.png");
    this.load.image("t-ground-img", "assets/terrain/ground_flat.png"); // tileset source for the map layer
    this.load.spritesheet("t-elev", "assets/terrain/ground_elevation.png", { frameWidth: 64, frameHeight: 64 }); // cliff/plateau autotile
    this.load.spritesheet("t-foam", "assets/terrain/foam.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("t-bridge", "assets/terrain/bridge.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("t-tree", "assets/terrain/tree.png", { frameWidth: UNIT, frameHeight: UNIT });

    // --- decorations (rocks / bushes / mushrooms) scattered over the field ---
    for (let i = 1; i <= 4; i++) {
      this.load.image(`deco-rock${i}`, `assets/deco/Rock${i}.png`);
      this.load.image(`deco-bush${i}`, `assets/deco/Bushe${i}.png`);
    }
    for (let i = 1; i <= 18; i++) {
      const n = String(i).padStart(2, "0");
      this.load.image(`deco-${n}`, `assets/deco/${n}.png`);
    }

    // --- ambient + extra terrain (clouds, animated water rocks, swaying trees, sheep) ---
    for (let i = 1; i <= 8; i++) this.load.image(`cloud${i}`, `assets/deco/cloud${i}.png`);
    for (let i = 1; i <= 4; i++) this.load.spritesheet(`wrock${i}`, `assets/terrain/wrock${i}.png`, { frameWidth: 128, frameHeight: 128 });
    for (let i = 1; i <= 4; i++) this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.png`, { frameWidth: 256, frameHeight: 256 });
    this.load.spritesheet("sheep", "assets/deco/sheep.png", { frameWidth: 128, frameHeight: 128 });

    // --- enemy-pack creatures for jungle neutrals + Roshan ---
    this.load.spritesheet("e-skull-idle", "assets/enemies/skull_idle.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("e-skull-run", "assets/enemies/skull_run.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("e-gnoll-idle", "assets/enemies/gnoll_idle.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("e-gnoll-walk", "assets/enemies/gnoll_walk.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("e-minotaur-idle", "assets/enemies/minotaur_idle.png", { frameWidth: 320, frameHeight: 320 });
    this.load.spritesheet("e-minotaur-walk", "assets/enemies/minotaur_walk.png", { frameWidth: 320, frameHeight: 320 });

    // --- fx ---
    this.load.spritesheet("fx-explosion", "assets/fx/explosion.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("fx-fire", "assets/fx/fire.png", { frameWidth: 128, frameHeight: 128 });
    this.load.image("fx-arrow", "assets/fx/arrow.png");

    // --- ui ---
    this.load.image("ui-bar-base", "assets/ui/bar_base.png");
    this.load.image("ui-bar-fill", "assets/ui/bar_fill.png");
    this.load.image("ui-panel", "assets/ui/panel.png");
    this.load.image("ui-banner", "assets/ui/banner.png");
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(2, "0");
      this.load.image(`ui-icon-${n}`, `assets/ui/icon_${n}.png`);
    }

    // decorations: rocks/bushes/mushrooms — load whatever is present lazily by
    // numbering; missing files just warn. Handled in MapBuilder.
  }

  create(): void {
    this.makeUtilTextures();
    // AnimRegistry registers every unit/fx animation against the loaded sheets.
    // (imported lazily to keep BootScene's compile surface small)
    void import("../render/anims").then(({ registerAnims }) => {
      registerAnims(this);
      this.scene.start("Menu");
    });
  }

  /** Soft procedural textures: shadows, glows, sparks, rings, selection. */
  private makeUtilTextures(): void {
    const g = this.add.graphics();

    g.fillStyle(0x000000, 0.34).fillEllipse(40, 18, 70, 30);
    g.generateTexture("shadow", 80, 36);
    g.clear();

    for (let i = 6; i >= 1; i--) g.fillStyle(0xffffff, 0.16).fillCircle(16, 16, (i / 6) * 14);
    g.generateTexture("spark", 32, 32);
    g.clear();

    for (let i = 16; i >= 1; i--) g.fillStyle(0xffffff, 0.05).fillCircle(64, 64, (i / 16) * 62);
    g.generateTexture("glow", 128, 128);
    g.clear();

    // 1×1 white pixel for tints / bars / rect fills.
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 1, 1);
    g.generateTexture("px", 1, 1);
    g.destroy();
  }
}
