import { Scene } from "phaser";

import { SPELL_SHEETS } from "../render/fx-map";

// The 64px icon sets and the cloud set are same-size families, so each ships as
// one packed grid instead of 36 separate requests. Frame order is row-major.
const ICON = { frameHeight: 64, frameWidth: 64 };

// Troop sheets are a uniform 192×192 grid. Terrain tiles are 64px.
// FX strips vary. Frame *ranges* (which rows are idle/walk/attack) are resolved
// in AnimRegistry, discovered/verified at runtime — see render/anims.ts.
const UNIT = 192;

const UNIT_KEYS = ["warrior", "pawn", "archer", "torch", "tnt", "barrel"] as const;
// The art pack ships four team paints; the game only ever renders radiant=blue
// and dire=red (render/sprites.teamColor), so the other two are not shipped.
const COLORS = ["blue", "red"] as const;

export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    const f = { frameHeight: UNIT, frameWidth: UNIT };

    // --- unit sheets (every color variant we might team-paint) ---
    // barrel is the one 128px-grid sheet in the set (6×6); the rest are 192
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

    // --- buildings (static) ---
    for (const c of COLORS) {
      this.load.image(`b-castle-${c}`, `assets/buildings/castle_${c}.webp`);
      this.load.image(`b-tower-${c}`, `assets/buildings/tower_${c}.webp`);
      this.load.image(`b-house-${c}`, `assets/buildings/house_${c}.webp`);
    }
    this.load.image("b-castle-destroyed", "assets/buildings/castle_destroyed.webp");
    this.load.image("b-tower-destroyed", "assets/buildings/tower_destroyed.webp");

    // --- terrain ---
    // The live map renders with the terrain tileset (flat + elevated autotile,
    // cliffs, stairs) — the same sheet the ?gallery=map showcase composes
    // tile-by-tile.
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
    // Bridge_All: frames 0/1/2 = horizontal bridge left-cap/middle/right-cap,
    // frame 11 = the flat shadow square that goes on the water underneath.
    this.load.spritesheet("t-bridge", "assets/terrain/bridge.webp", {
      frameHeight: 64,
      frameWidth: 64,
    });
    this.load.spritesheet("t-tree", "assets/terrain/tree.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });

    // --- decorations (rocks / bushes / mushrooms) scattered over the field ---
    for (let i = 1; i <= 4; i += 1) {
      this.load.image(`deco-rock${i}`, `assets/deco/Rock${i}.webp`);
      // bushes are 8-frame 128px sway strips, not single images
      this.load.spritesheet(`deco-bush${i}`, `assets/deco/Bushe${i}.webp`, {
        frameHeight: 128,
        frameWidth: 128,
      });
    }
    for (let i = 1; i <= 18; i += 1) {
      const n = String(i).padStart(2, "0");
      this.load.image(`deco-${n}`, `assets/deco/${n}.webp`);
    }

    // --- ambient + extra terrain (clouds, animated water rocks, swaying trees, sheep) ---
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
    // all four ftree strips are 8 frames; 1/2 are 192×256 frames, 3/4 are 192×192
    // (cutting 1/2 at 256 wide made every frame straddle two trees — the old
    // "tree scrolls through the sheet" glitch).
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

    // --- enemy-pack creatures for jungle neutrals + Roshan ---
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

    // --- fx ---
    this.load.spritesheet("fx-explosion", "assets/fx/explosion.webp", {
      frameHeight: UNIT,
      frameWidth: UNIT,
    });
    this.load.spritesheet("fx-fire", "assets/fx/fire.webp", { frameHeight: 128, frameWidth: 128 });
    // arrow.webp is a 64×64 2-frame strip (arrow + tail); frame 0 is the full
    // arrow, pointing EAST. Load as a sheet so we draw one clean arrow.
    this.load.spritesheet("fx-arrow", "assets/fx/arrow.webp", { frameHeight: 64, frameWidth: 64 });
    // particle FX: walk dust, building flames, cartoon explosions, splash
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

    // --- ui (ui sprites: carved panels, ribbons, buttons) ---
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

    // gold mine prop (large jungle camps) + the shared skull death pop
    this.load.image("deco-goldmine", "assets/deco/goldmine.webp");
    this.load.spritesheet("skull-pop", "assets/units/dead.webp", {
      frameHeight: 128,
      frameWidth: 128,
    });

    // --- spell effects + ability icons + target cursor ---
    // packed effect strips (one row each; frame size + count from SPELL_SHEETS)
    for (const s of SPELL_SHEETS) {
      this.load.spritesheet(s.key, `assets/spell/${s.key}.webp`, {
        frameHeight: s.frame,
        frameWidth: s.frame,
      });
    }
    this.load.spritesheet("spell-icons", "assets/spell/icons.webp", ICON);
    this.load.image("cursor-target", "assets/ui/cursor_target.webp");

    // decorations: rocks/bushes/mushrooms — load whatever is present lazily by
    // numbering; missing files just warn. Handled in MapBuilder.
  }

  create(): void {
    this.makeUtilTextures();
    void this.route();
  }

  /** Registers every unit/fx animation against the loaded sheets (AnimRegistry
   *  is imported lazily to keep BootScene's compile surface small), then picks
   *  the entry surface: ?trailer → the scripted trailer; ?viewer → the
   *  character/bot showcase; ?gallery=units|terrain|fx|map → that asset page
   *  (bare ?gallery = units); no param → the menu. Every dev chunk only loads on
   *  its own branch — dead code otherwise. */
  private async route(): Promise<void> {
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

  /** Soft procedural textures: shadows, glows, sparks, rings, selection. */
  private makeUtilTextures(): void {
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

    // a thrown bomb: dark sphere + highlight + a lit fuse spark (dynamite projectile)
    // thrown bomb (boomtinker dynamite): a round iron ball on a soft warm glow,
    // with a lit fuse — reads clearly + lively against the map at small size.
    const bx = 24;
    for (let i = 7; i >= 1; i -= 1) {
      g.fillStyle(0xff_9a_3a, 0.07).fillCircle(bx, 26, (i / 7) * 22);
      // glow halo
    }
    // dark rim
    g.fillStyle(0x14_11_0e, 1).fillCircle(bx, 26, 13);
    // body
    g.fillStyle(0x33_30_2b, 1).fillCircle(bx, 26, 11);
    // mid sheen
    g.fillStyle(0x5a_55_4c, 1).fillCircle(bx, 26, 7);
    // glossy highlight
    g.fillStyle(0xb8_b2_a4, 0.95).fillCircle(bx - 4, 21, 3.2);
    // fuse
    g.fillStyle(0x6a_4a_2a, 1).fillRect(bx - 1, 8, 3, 9);
    for (let i = 5; i >= 1; i -= 1) {
      g.fillStyle(0xff_b4_3a, 0.22).fillCircle(bx + 1, 7, i);
      // spark glow
    }
    g.fillStyle(0xff_e0_66, 1).fillCircle(bx + 1, 7, 3);
    // hot core
    g.fillStyle(0xff_f6_d0, 1).fillCircle(bx + 1, 6, 1.6);
    g.generateTexture("bomb", 48, 48);
    g.clear();

    // a sharp spark streak (4–6px), stretched along velocity for shard sprays
    g.fillStyle(0xff_ff_ff, 1).fillRect(0, 5, 24, 3);
    g.fillStyle(0xff_ff_ff, 0.6).fillRect(0, 4, 16, 5);
    g.generateTexture("streak", 24, 12);
    g.clear();

    // a 4-point sparkle star — stun orbits, level-up + pickup glints
    g.fillStyle(0xff_ff_ff, 1);
    g.fillTriangle(16, 1, 13, 16, 19, 16);
    g.fillTriangle(16, 31, 13, 16, 19, 16);
    g.fillTriangle(1, 16, 16, 13, 16, 19);
    g.fillTriangle(31, 16, 16, 13, 16, 19);
    g.fillStyle(0xff_ff_ff, 0.9).fillCircle(16, 16, 3.2);
    g.generateTexture("fx-star", 32, 32);
    g.clear();

    // aim chevron: rides the local hero's ground ring, points along cast aim
    g.lineStyle(3, 0x1c_14_10, 1).strokeTriangle(3, 3, 21, 12, 3, 21);
    g.fillStyle(0xff_ff_ff, 1).fillTriangle(3, 3, 21, 12, 3, 21);
    g.generateTexture("fx-chevron", 24, 24);
    g.clear();

    // a crisp thin ring — shockwaves on big impacts (scaled up + faded)
    g.lineStyle(4, 0xff_ff_ff, 1).strokeCircle(32, 32, 28);
    g.lineStyle(2, 0xff_ff_ff, 0.5).strokeCircle(32, 32, 24);
    g.generateTexture("fx-ring", 64, 64);
    g.clear();

    // a soft scorch decal stamped where AoE/explosions land (permanence — Vlambeer)
    for (let i = 10; i >= 1; i -= 1) {
      g.fillStyle(0x12_0c_08, (1 - i / 10) * 0.5).fillEllipse(48, 32, (i / 10) * 92, (i / 10) * 62);
    }
    g.generateTexture("fx-scorch", 96, 64);
    g.destroy();

    // radial vignette (canvas gradient) to frame the field — subtle so the pixel
    // art stays crisp; stretched over the viewport by GameScene.
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
