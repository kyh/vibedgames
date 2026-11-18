import { Scene } from "phaser";

import { SPELL_SHEETS } from "../render/fx-map";

const ICON = { frameHeight: 64, frameWidth: 64 };

const UNIT = 192;

const UNIT_KEYS = ["warrior", "pawn", "archer", "torch", "tnt", "barrel"] as const;
const COLORS = ["blue", "red"] as const;

export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload() {
    const f = { frameHeight: UNIT, frameWidth: UNIT };

    for (const u of UNIT_KEYS) {
      for (const c of COLORS) {
        this.load.spritesheet(
          `u-${u}-${c}`,
          `assets/units/${u}_${c}.webp`,
          u === "barrel" ? { frameHeight: 128, frameWidth: 128 } : f,
        );
      }
    }

    for (const sheet of ["warrior", "pawn", "archer"]) {
      for (const color of ["blue", "red"]) {
        this.load.image(`portrait-${sheet}-${color}`, `assets/ui/portraits/${sheet}-${color}.png`);
      }
    }

    this.load.image("portrait-torch", "assets/ui/portraits/torch.png");

    for (const c of COLORS) {
      this.load.image(`b-castle-${c}`, `assets/buildings/castle_${c}.webp`);
      this.load.image(`b-tower-${c}`, `assets/buildings/tower_${c}.webp`);
      this.load.image(`b-house-${c}`, `assets/buildings/house_${c}.webp`);
    }

    this.load.image("b-castle-destroyed", "assets/buildings/castle_destroyed.webp");
    this.load.image("b-tower-destroyed", "assets/buildings/tower_destroyed.webp");

    this.load.image("tiles-img", "assets/terrain/tiles.webp");
    this.load.spritesheet("tiles", "assets/terrain/tiles.webp", {
      frameHeight: 64,
      frameWidth: 64,
    });
    this.load.spritesheet("foam", "assets/terrain/foam.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.image("tshadow", "assets/terrain/shadow.webp");
    this.load.image("t-water", "assets/terrain/water.webp");
    this.load.spritesheet("t-bridge", "assets/terrain/bridge.webp", {
      frameHeight: 64,
      frameWidth: 64,
    });
    this.load.spritesheet("t-tree", "assets/terrain/tree.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });

    for (let i = 1; i <= 4; i += 1) {
      this.load.image(`deco-rock${i}`, `assets/deco/Rock${i}.webp`);
      this.load.spritesheet(`deco-bush${i}`, `assets/deco/Bushe${i}.webp`, {
        frameHeight: 128,
        frameWidth: 128,
      });
    }

    for (let i = 1; i <= 18; i += 1) {
      const n = String(i).padStart(2, "0");
      this.load.image(`deco-${n}`, `assets/deco/${n}.webp`);
    }

    this.load.spritesheet("clouds", "assets/deco/clouds.webp", {
      frameHeight: 256,
      frameWidth: 576,
    });

    for (let i = 1; i <= 4; i += 1) {
      this.load.spritesheet(`wrock${i}`, `assets/terrain/wrock${i}.webp`, {
        frameHeight: 128,
        frameWidth: 128,
      });
    }

    for (let i = 1; i <= 2; i += 1) {
      this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.webp`, {
        frameHeight: 256,
        frameWidth: 192,
      });
    }

    for (let i = 3; i <= 4; i += 1) {
      this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.webp`, {
        frameHeight: 192,
        frameWidth: 192,
      });
    }

    this.load.spritesheet("sheep", "assets/deco/sheep.webp", { frameHeight: 128, frameWidth: 128 });

    this.load.spritesheet("e-skull-idle", "assets/enemies/skull_idle.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("e-skull-run", "assets/enemies/skull_run.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("e-gnoll-idle", "assets/enemies/gnoll_idle.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("e-gnoll-walk", "assets/enemies/gnoll_walk.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("e-minotaur-idle", "assets/enemies/minotaur_idle.webp", {
      frameHeight: 320,
      frameWidth: 320,
    });
    this.load.spritesheet("e-minotaur-walk", "assets/enemies/minotaur_walk.webp", {
      frameHeight: 320,
      frameWidth: 320,
    });

    this.load.spritesheet("fx-explosion", "assets/fx/explosion.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("fx-fire", "assets/fx/fire.webp", { frameHeight: 128, frameWidth: 128 });
    this.load.spritesheet("fx-arrow", "assets/fx/arrow.webp", { frameHeight: 64, frameWidth: 64 });
    this.load.spritesheet("fx-dust1", "assets/fx/dust1.webp", { frameHeight: 64, frameWidth: 64 });
    this.load.spritesheet("fx-dust2", "assets/fx/dust2.webp", { frameHeight: 64, frameWidth: 64 });

    for (let i = 1; i <= 3; i += 1) {
      this.load.spritesheet(`fx-flame${i}`, `assets/fx/flame${i}.webp`, {
        frameHeight: 64,
        frameWidth: 64,
      });
    }

    this.load.spritesheet("fx-explode1", "assets/fx/explode1.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("fx-explode2", "assets/fx/explode2.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("fx-splash", "assets/fx/splash.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });

    this.load.image("ui-panel", "assets/ui/panel.webp");
    this.load.image("ui-carved9", "assets/ui/carved9.webp");
    this.load.image("ui-carved3", "assets/ui/carved3.webp");

    for (const c of ["blue", "red", "yellow"]) {
      this.load.image(`ui-ribbon-${c}`, `assets/ui/ribbon_${c}.webp`);
    }

    for (const c of ["blue", "red"]) {
      this.load.image(`ui-btn-${c}`, `assets/ui/btn_${c}.webp`);
      this.load.image(`ui-btn-${c}-pressed`, `assets/ui/btn_${c}_pressed.webp`);
    }

    this.load.spritesheet("ui-icons", "assets/ui/icons.webp", ICON);

    this.load.image("deco-goldmine", "assets/deco/goldmine.webp");
    this.load.spritesheet("skull-pop", "assets/units/dead.webp", {
      frameHeight: 128,
      frameWidth: 128,
    });

    for (const s of SPELL_SHEETS) {
      this.load.spritesheet(s.key, `assets/spell/${s.key}.webp`, {
        frameHeight: s.frame,
        frameWidth: s.frame,
      });
    }

    this.load.spritesheet("spell-icons", "assets/spell/icons.webp", ICON);
    this.load.image("cursor-target", "assets/ui/cursor_target.webp");
  }

  create() {
    this.makeUtilTextures();
    void this.route();
  }

  private async route() {
    const { registerAnims } = await import("../render/anims");
    registerAnims(this);
    const params = new URLSearchParams(window.location.search);

    if (params.has("trailer")) {
      const { launchTrailer } = await import("../trailer/trailer-director");
      launchTrailer(this.game);

      return;
    }

    if (params.has("gallery")) {
      const { gallerySection, startGallery } = await import("./dev-scenes");
      await startGallery(this, gallerySection(params.get("gallery")));
    } else if (params.has("viewer")) {
      const { startShowcase } = await import("./dev-scenes");
      await startShowcase(this);
    } else {
      this.scene.start("Menu");
    }
  }

  private makeUtilTextures() {
    const g = this.add.graphics();

    g.fillStyle(0x00_00_00, 0.34).fillEllipse(40, 18, 70, 30);
    g.generateTexture("shadow", 80, 36);
    g.clear();

    for (let i = 6; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.16).fillCircle(16, 16, (i / 6) * 14);
    }

    g.generateTexture("spark", 32, 32);
    g.clear();

    for (let i = 16; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.05).fillCircle(64, 64, (i / 16) * 62);
    }

    g.generateTexture("glow", 128, 128);
    g.clear();

    const bx = 24;

    for (let i = 7; i >= 1; i -= 1) {
      g.fillStyle(0xff_9a_3a, 0.07).fillCircle(bx, 26, (i / 7) * 22);
    }

    g.fillStyle(0x14_11_0e, 1).fillCircle(bx, 26, 13);
    g.fillStyle(0x33_30_2b, 1).fillCircle(bx, 26, 11);
    g.fillStyle(0x5a_55_4c, 1).fillCircle(bx, 26, 7);
    g.fillStyle(0xb8_b2_a4, 0.95).fillCircle(bx - 4, 21, 3.2);
    g.fillStyle(0x6a_4a_2a, 1).fillRect(bx - 1, 8, 3, 9);

    for (let i = 5; i >= 1; i -= 1) {
      g.fillStyle(0xff_b4_3a, 0.22).fillCircle(bx + 1, 7, i);
    }

    g.fillStyle(0xff_e0_66, 1).fillCircle(bx + 1, 7, 3);
    g.fillStyle(0xff_f6_d0, 1).fillCircle(bx + 1, 6, 1.6);
    g.generateTexture("bomb", 48, 48);
    g.clear();

    g.fillStyle(0xff_ff_ff, 1).fillRect(0, 5, 24, 3);
    g.fillStyle(0xff_ff_ff, 0.6).fillRect(0, 4, 16, 5);
    g.generateTexture("streak", 24, 12);
    g.clear();

    g.fillStyle(0xff_ff_ff, 1);
    g.fillTriangle(16, 1, 13, 16, 19, 16);
    g.fillTriangle(16, 31, 13, 16, 19, 16);
    g.fillTriangle(1, 16, 16, 13, 16, 19);
    g.fillTriangle(31, 16, 16, 13, 16, 19);
    g.fillStyle(0xff_ff_ff, 0.9).fillCircle(16, 16, 3.2);
    g.generateTexture("fx-star", 32, 32);
    g.clear();

    g.lineStyle(3, 0x1c_14_10, 1).strokeTriangle(3, 3, 21, 12, 3, 21);
    g.fillStyle(0xff_ff_ff, 1).fillTriangle(3, 3, 21, 12, 3, 21);
    g.generateTexture("fx-chevron", 24, 24);
    g.clear();

    g.lineStyle(4, 0xff_ff_ff, 1).strokeCircle(32, 32, 28);
    g.lineStyle(2, 0xff_ff_ff, 0.5).strokeCircle(32, 32, 24);
    g.generateTexture("fx-ring", 64, 64);
    g.clear();

    for (let i = 10; i >= 1; i -= 1) {
      g.fillStyle(0x12_0c_08, (1 - i / 10) * 0.5).fillEllipse(48, 32, (i / 10) * 92, (i / 10) * 62);
    }

    g.generateTexture("fx-scorch", 96, 64);
    g.destroy();

    const vig = this.textures.createCanvas("vignette", 256, 256);
    const vctx = vig?.getContext();

    if (vig && vctx) {
      const grd = vctx.createRadialGradient(128, 128, 70, 128, 128, 150);
      grd.addColorStop(0, "rgba(6,10,18,0)");
      grd.addColorStop(0.7, "rgba(6,10,18,0)");
      grd.addColorStop(1, "rgba(6,10,18,0.42)");
      vctx.fillStyle = grd;
      vctx.fillRect(0, 0, 256, 256);
      vig.refresh();
    }
  }
}
