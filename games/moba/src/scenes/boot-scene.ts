import Phaser from "phaser";

import { ABILITY_ICON, SPELL_SHEETS } from "../render/fx-map";

const SPELL_ICONS = [...new Set(Object.values(ABILITY_ICON))];

// Troop sheets are a uniform 192×192 grid. Terrain tiles are 64px.
// FX strips vary. Frame *ranges* (which rows are idle/walk/attack) are resolved
// in AnimRegistry, discovered/verified at runtime — see render/anims.ts.
const UNIT = 192;

const UNIT_KEYS = ["warrior", "pawn", "archer", "torch", "tnt", "barrel"] as const;
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
        this.load.spritesheet(
          `u-${u}-${c}`,
          `assets/units/${u}_${c}.png`,
          u === "barrel" ? { frameWidth: 128, frameHeight: 128 } : f,
        );
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
    // The live map renders with the terrain tileset (flat + elevated autotile,
    // cliffs, stairs) — the same sheet the ?ui=map showcase composes
    // tile-by-tile.
    this.load.image("tiles-img", "assets/terrain/tiles.png");
    this.load.spritesheet("tiles", "assets/terrain/tiles.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("foam", "assets/terrain/foam.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.image("tshadow", "assets/terrain/shadow.png");
    this.load.image("t-water", "assets/terrain/water.png");
    // Bridge_All: frames 0/1/2 = horizontal bridge left-cap/middle/right-cap,
    // frame 11 = the flat shadow square that goes on the water underneath.
    this.load.spritesheet("t-bridge", "assets/terrain/bridge.png", {
      frameWidth: 64,
      frameHeight: 64,
    });
    this.load.spritesheet("t-tree", "assets/terrain/tree.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    // kept for the ?ui=terrain showcase
    this.load.spritesheet("t-ground", "assets/terrain/ground_flat.png", {
      frameWidth: 64,
      frameHeight: 64,
    });
    this.load.spritesheet("t-elev", "assets/terrain/ground_elevation.png", {
      frameWidth: 64,
      frameHeight: 64,
    });

    // --- decorations (rocks / bushes / mushrooms) scattered over the field ---
    for (let i = 1; i <= 4; i++) {
      this.load.image(`deco-rock${i}`, `assets/deco/Rock${i}.png`);
      // bushes are 8-frame 128px sway strips, not single images
      this.load.spritesheet(`deco-bush${i}`, `assets/deco/Bushe${i}.png`, {
        frameWidth: 128,
        frameHeight: 128,
      });
    }
    for (let i = 1; i <= 18; i++) {
      const n = String(i).padStart(2, "0");
      this.load.image(`deco-${n}`, `assets/deco/${n}.png`);
    }

    // --- ambient + extra terrain (clouds, animated water rocks, swaying trees, sheep) ---
    for (let i = 1; i <= 8; i++) this.load.image(`cloud${i}`, `assets/deco/cloud${i}.png`);
    for (let i = 1; i <= 4; i++)
      this.load.spritesheet(`wrock${i}`, `assets/terrain/wrock${i}.png`, {
        frameWidth: 128,
        frameHeight: 128,
      });
    // all four ftree strips are 8 frames; 1/2 are 192×256 frames, 3/4 are 192×192
    // (cutting 1/2 at 256 wide made every frame straddle two trees — the old
    // "tree scrolls through the sheet" glitch).
    for (let i = 1; i <= 2; i++)
      this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.png`, {
        frameWidth: 192,
        frameHeight: 256,
      });
    for (let i = 3; i <= 4; i++)
      this.load.spritesheet(`ftree${i}`, `assets/deco/ftree${i}.png`, {
        frameWidth: 192,
        frameHeight: 192,
      });
    this.load.spritesheet("sheep", "assets/deco/sheep.png", { frameWidth: 128, frameHeight: 128 });

    // --- enemy-pack creatures for jungle neutrals + Roshan ---
    this.load.spritesheet("e-skull-idle", "assets/enemies/skull_idle.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("e-skull-run", "assets/enemies/skull_run.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("e-gnoll-idle", "assets/enemies/gnoll_idle.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("e-gnoll-walk", "assets/enemies/gnoll_walk.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("e-minotaur-idle", "assets/enemies/minotaur_idle.png", {
      frameWidth: 320,
      frameHeight: 320,
    });
    this.load.spritesheet("e-minotaur-walk", "assets/enemies/minotaur_walk.png", {
      frameWidth: 320,
      frameHeight: 320,
    });

    // --- fx ---
    this.load.spritesheet("fx-explosion", "assets/fx/explosion.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("fx-fire", "assets/fx/fire.png", { frameWidth: 128, frameHeight: 128 });
    // arrow.png is a 64×64 2-frame strip (arrow + tail); frame 0 is the full
    // arrow, pointing EAST. Load as a sheet so we draw one clean arrow.
    this.load.spritesheet("fx-arrow", "assets/fx/arrow.png", { frameWidth: 64, frameHeight: 64 });
    // particle FX: walk dust, building flames, cartoon explosions, splash
    this.load.spritesheet("fx-dust1", "assets/fx/dust1.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("fx-dust2", "assets/fx/dust2.png", { frameWidth: 64, frameHeight: 64 });
    for (let i = 1; i <= 3; i++)
      this.load.spritesheet(`fx-flame${i}`, `assets/fx/flame${i}.png`, {
        frameWidth: 64,
        frameHeight: 64,
      });
    this.load.spritesheet("fx-explode1", "assets/fx/explode1.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("fx-explode2", "assets/fx/explode2.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });
    this.load.spritesheet("fx-splash", "assets/fx/splash.png", {
      frameWidth: UNIT,
      frameHeight: UNIT,
    });

    // --- ui (ui sprites: carved panels, ribbons, buttons) ---
    this.load.image("ui-panel", "assets/ui/panel.png");
    this.load.image("ui-carved9", "assets/ui/carved9.png");
    this.load.image("ui-carved3", "assets/ui/carved3.png");
    for (const c of ["blue", "red", "yellow"])
      this.load.image(`ui-ribbon-${c}`, `assets/ui/ribbon_${c}.png`);
    for (const c of ["blue", "red"]) {
      this.load.image(`ui-btn-${c}`, `assets/ui/btn_${c}.png`);
      this.load.image(`ui-btn-${c}-pressed`, `assets/ui/btn_${c}_pressed.png`);
    }
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(2, "0");
      this.load.image(`ui-icon-${n}`, `assets/ui/icon_${n}.png`);
    }

    // gold mine prop (large jungle camps) + the shared skull death pop
    this.load.image("deco-goldmine", "assets/deco/goldmine.png");
    this.load.spritesheet("skull-pop", "assets/units/dead.png", {
      frameWidth: 128,
      frameHeight: 128,
    });

    // --- spell effects + ability icons + target cursor ---
    // packed effect strips (one row each; frame size + count from SPELL_SHEETS)
    for (const s of SPELL_SHEETS) {
      this.load.spritesheet(s.key, `assets/spell/${s.key}.png`, {
        frameWidth: s.frame,
        frameHeight: s.frame,
      });
    }
    for (const ic of SPELL_ICONS) this.load.image(ic, `assets/spell/icons/${ic}.png`);
    this.load.image("cursor-target", "assets/ui/cursor_target.png");

    // decorations: rocks/bushes/mushrooms — load whatever is present lazily by
    // numbering; missing files just warn. Handled in MapBuilder.
  }

  create(): void {
    this.makeUtilTextures();
    // AnimRegistry registers every unit/fx animation against the loaded sheets.
    // (imported lazily to keep BootScene's compile surface small)
    void import("../render/anims").then(({ registerAnims }) => {
      registerAnims(this);
      // Everything dev-facing is nested under ?ui: bare ?ui opens the UI hub (the
      // character/bot showcase); ?ui=units|terrain|fx|map opens that asset page.
      // No param → the menu.
      const params = new URLSearchParams(window.location.search);
      if (params.has("trailer")) {
        // TRAILER MODE (?trailer=1): a scripted, letterboxed gameplay trailer.
        // The director chunk only loads on this branch — dead code otherwise.
        void import("../trailer/trailer-director").then(({ launchTrailer }) =>
          launchTrailer(this.game),
        );
        return;
      }
      if (params.has("ui")) {
        const sub = params.get("ui") ?? "";
        const SECTIONS = ["units", "terrain", "fx", "map"];
        if (SECTIONS.includes(sub)) this.scene.start("Gallery", { section: sub });
        else this.scene.start("Showcase");
      } else {
        this.scene.start("Menu");
      }
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

    // a thrown bomb: dark sphere + highlight + a lit fuse spark (dynamite projectile)
    // thrown bomb (boomtinker dynamite): a round iron ball on a soft warm glow,
    // with a lit fuse — reads clearly + lively against the map at small size.
    const bx = 24;
    for (let i = 7; i >= 1; i--) g.fillStyle(0xff9a3a, 0.07).fillCircle(bx, 26, (i / 7) * 22); // glow halo
    g.fillStyle(0x14110e, 1).fillCircle(bx, 26, 13); // dark rim
    g.fillStyle(0x33302b, 1).fillCircle(bx, 26, 11); // body
    g.fillStyle(0x5a554c, 1).fillCircle(bx, 26, 7); // mid sheen
    g.fillStyle(0xb8b2a4, 0.95).fillCircle(bx - 4, 21, 3.2); // glossy highlight
    g.fillStyle(0x6a4a2a, 1).fillRect(bx - 1, 8, 3, 9); // fuse
    for (let i = 5; i >= 1; i--) g.fillStyle(0xffb43a, 0.22).fillCircle(bx + 1, 7, i); // spark glow
    g.fillStyle(0xffe066, 1).fillCircle(bx + 1, 7, 3);
    g.fillStyle(0xfff6d0, 1).fillCircle(bx + 1, 6, 1.6); // hot core
    g.generateTexture("bomb", 48, 48);
    g.clear();

    // a sharp spark streak (4–6px), stretched along velocity for shard sprays
    g.fillStyle(0xffffff, 1).fillRect(0, 5, 24, 3);
    g.fillStyle(0xffffff, 0.6).fillRect(0, 4, 16, 5);
    g.generateTexture("streak", 24, 12);
    g.clear();

    // a 4-point sparkle star — stun orbits, level-up + pickup glints
    g.fillStyle(0xffffff, 1);
    g.fillTriangle(16, 1, 13, 16, 19, 16);
    g.fillTriangle(16, 31, 13, 16, 19, 16);
    g.fillTriangle(1, 16, 16, 13, 16, 19);
    g.fillTriangle(31, 16, 16, 13, 16, 19);
    g.fillStyle(0xffffff, 0.9).fillCircle(16, 16, 3.2);
    g.generateTexture("fx-star", 32, 32);
    g.clear();

    // a crisp thin ring — shockwaves on big impacts (scaled up + faded)
    g.lineStyle(4, 0xffffff, 1).strokeCircle(32, 32, 28);
    g.lineStyle(2, 0xffffff, 0.5).strokeCircle(32, 32, 24);
    g.generateTexture("fx-ring", 64, 64);
    g.clear();

    // a soft scorch decal stamped where AoE/explosions land (permanence — Vlambeer)
    for (let i = 10; i >= 1; i--)
      g.fillStyle(0x120c08, (1 - i / 10) * 0.5).fillEllipse(48, 32, (i / 10) * 92, (i / 10) * 62);
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
