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
    // barrel is the one 128px-grid sheet in the set (6×6); the rest are 192
    for (const u of UNIT_KEYS) {
      for (const c of COLORS) {
        this.load.spritesheet(`u-${u}-${c}`, `assets/units/${u}_${c}.png`, u === "barrel" ? { frameWidth: 128, frameHeight: 128 } : f);
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
    // The live map renders with the Free Pack tileset (flat + elevated autotile,
    // cliffs, stairs) — the same sheet the ?gallery=map reference rebuild verified
    // tile-by-tile against the promo art.
    this.load.image("tiles-img", "assets/fp/tiles3.png");
    this.load.spritesheet("tiles", "assets/fp/tiles3.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("foam", "assets/fp/foam.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.image("tshadow", "assets/fp/shadow.png");
    this.load.image("t-water", "assets/terrain/water.png");
    // Bridge_All: frames 0/1/2 = horizontal bridge left-cap/middle/right-cap,
    // frame 11 = the flat shadow square that goes on the water underneath.
    this.load.spritesheet("t-bridge", "assets/terrain/bridge.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("t-tree", "assets/terrain/tree.png", { frameWidth: UNIT, frameHeight: UNIT });
    // kept for the ?gallery=terrain showcase
    this.load.spritesheet("t-ground", "assets/terrain/ground_flat.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("t-elev", "assets/terrain/ground_elevation.png", { frameWidth: 64, frameHeight: 64 });

    // --- decorations (rocks / bushes / mushrooms) scattered over the field ---
    for (let i = 1; i <= 4; i++) {
      this.load.image(`deco-rock${i}`, `assets/deco/Rock${i}.png`);
      // bushes are 8-frame 128px sway strips, not single images
      this.load.spritesheet(`deco-bush${i}`, `assets/deco/Bushe${i}.png`, { frameWidth: 128, frameHeight: 128 });
    }
    for (let i = 1; i <= 18; i++) {
      const n = String(i).padStart(2, "0");
      this.load.image(`deco-${n}`, `assets/deco/${n}.png`);
    }

    // --- ambient + extra terrain (clouds, animated water rocks, swaying trees, sheep) ---
    for (let i = 1; i <= 8; i++) this.load.image(`cloud${i}`, `assets/deco/cloud${i}.png`);
    for (let i = 1; i <= 4; i++) this.load.spritesheet(`wrock${i}`, `assets/terrain/wrock${i}.png`, { frameWidth: 128, frameHeight: 128 });
    // all four ftree strips are 8 frames; 1/2 are 192×256 frames, 3/4 are 192×192
    // (cutting 1/2 at 256 wide made every frame straddle two trees — the old
    // "tree scrolls through the sheet" glitch).
    for (let i = 1; i <= 2; i++) this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.png`, { frameWidth: 192, frameHeight: 256 });
    for (let i = 3; i <= 4; i++) this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.png`, { frameWidth: 192, frameHeight: 192 });
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
    // Free Pack Particle FX: walk dust, building flames, cartoon explosions, splash
    this.load.spritesheet("fx-dust1", "assets/fx/dust1.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("fx-dust2", "assets/fx/dust2.png", { frameWidth: 64, frameHeight: 64 });
    for (let i = 1; i <= 3; i++) this.load.spritesheet(`fx-flame${i}`, `assets/fx/flame${i}.png`, { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("fx-explode1", "assets/fx/explode1.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("fx-explode2", "assets/fx/explode2.png", { frameWidth: UNIT, frameHeight: UNIT });
    this.load.spritesheet("fx-splash", "assets/fx/splash.png", { frameWidth: UNIT, frameHeight: UNIT });

    // --- ui (Tiny Swords UI pack: carved panels, ribbons, buttons) ---
    this.load.image("ui-bar-base", "assets/ui/bar_base.png");
    this.load.image("ui-bar-fill", "assets/ui/bar_fill.png");
    this.load.image("ui-panel", "assets/ui/panel.png");
    this.load.image("ui-banner", "assets/ui/banner.png");
    this.load.image("ui-carved9", "assets/ui/carved9.png");
    this.load.image("ui-carved3", "assets/ui/carved3.png");
    for (const c of ["blue", "red", "yellow"]) this.load.image(`ui-ribbon-${c}`, `assets/ui/ribbon_${c}.png`);
    for (const c of ["blue", "red"]) {
      this.load.image(`ui-btn-${c}`, `assets/ui/btn_${c}.png`);
      this.load.image(`ui-btn-${c}-pressed`, `assets/ui/btn_${c}_pressed.png`);
    }
    this.load.image("ui-btn-hover", "assets/ui/btn_hover.png");
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(2, "0");
      this.load.image(`ui-icon-${n}`, `assets/ui/icon_${n}.png`);
    }

    // gold mine prop (large jungle camps) + the shared skull death pop
    this.load.image("deco-goldmine", "assets/deco/goldmine.png");
    this.load.spritesheet("skull-pop", "assets/units/dead.png", { frameWidth: 128, frameHeight: 128 });

    // decorations: rocks/bushes/mushrooms — load whatever is present lazily by
    // numbering; missing files just warn. Handled in MapBuilder.
  }

  create(): void {
    this.makeUtilTextures();
    // AnimRegistry registers every unit/fx animation against the loaded sheets.
    // (imported lazily to keep BootScene's compile surface small)
    void import("../render/anims").then(({ registerAnims }) => {
      registerAnims(this);
      // ?gallery=units|terrain|fx opens an asset showcase instead of the menu
      const gallery = new URLSearchParams(window.location.search).get("gallery");
      this.scene.start(gallery ? "Gallery" : "Menu", { section: gallery });
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
