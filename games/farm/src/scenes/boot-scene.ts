import type Phaser from "phaser";
import { Math as PhaserMath, Scene } from "phaser";
import { CROP_ORDER } from "../data/crops";
import { parseWorldMap } from "../world/worldmap";
import { setWorldMap, getWorldMap } from "../world/map-store";
import { FARMER_HURT_MS, SKELETON_CONTACT_MS, SKELETON_HURT_MS } from "../config";

const CHAR = { frameHeight: 64, frameWidth: 96 };

// action -> frame count (encoded in the source strip name)
export const CHAR_FRAMES = {
  attack: 10,
  axe: 10,
  casting: 15,
  caught: 10,
  death: 13,
  dig: 13,
  doing: 8,
  hurt: 8,
  idle: 9,
  mine: 10,
  reeling: 13,
  run: 8,
  walk: 8,
  water: 5,
} as const;
export type CharAction = keyof typeof CHAR_FRAMES;

const SKEL = {
  attack: 7,
  death: 10,
  hurt: 7,
  idle: 6,
  walk: 8,
} as const;

export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    // SAFETY: CHAR_FRAMES is a closed const record keyed by CharAction, so its
    // runtime keys are exactly that union.
    for (const a of Object.keys(CHAR_FRAMES) as CharAction[]) {
      this.load.spritesheet(`p-${a}`, `assets/char/${a}.webp`, CHAR);
    }
    for (const a of Object.keys(SKEL)) {
      this.load.spritesheet(`e-skel-${a}`, `assets/enemy/skel_${a}.webp`, CHAR);
    }

    // world map: tileset atlas (as tileset image AND frame sheet), the
    // packed deco sprite atlas, and the layout
    // One texture, used both as the tilemap's tileset and as a 16px frame
    // sheet — loading it under two keys fetched the game's biggest asset twice.
    this.load.spritesheet("atlas", "assets/tiles/atlas.webp", {
      frameHeight: 16,
      frameWidth: 16,
    });
    this.load.atlas("deco-atlas", "assets/deco-atlas.webp", "assets/deco-atlas.json");
    this.load.json("map", "assets/map.json");
    this.load.image("char-shadow-tex", "assets/obj/charactershadow.webp");

    // crops
    for (const c of CROP_ORDER) {
      this.load.spritesheet(`crop-${c}`, `assets/crops/${c}.webp`, {
        frameHeight: 16,
        frameWidth: 16,
      });
      this.load.image(`crop-${c}-icon`, `assets/crops/${c}_icon.webp`);
    }

    // objects still spawned by gameplay (mine nodes, soil, icons)
    this.load.image("obj-rock", "assets/obj/rock.webp");
    this.load.image("obj-ore-coal", "assets/obj/ore_coal.webp");
    this.load.image("obj-ore-copper", "assets/obj/ore_copper.webp");
    this.load.image("obj-ore-crystal", "assets/obj/ore_crystal.webp");
    this.load.image("obj-soil", "assets/obj/soil.webp");
    this.load.image("obj-seeds", "assets/obj/seeds.webp");
    this.load.image("obj-wood", "assets/obj/wood.webp");
    this.load.image("obj-stone", "assets/obj/stone.webp");
    this.load.image("obj-fish", "assets/obj/fish.webp");
    this.load.image("obj-egg", "assets/obj/egg.webp");
    this.load.image("obj-milk", "assets/obj/milk.webp");
    this.load.spritesheet("obj-mushroom-red", "assets/obj/mushroom_red.webp", {
      frameHeight: 16,
      frameWidth: 16,
    });
    this.load.spritesheet("obj-mushroom-blue", "assets/obj/mushroom_blue.webp", {
      frameHeight: 16,
      frameWidth: 16,
    });

    // animals
    this.load.spritesheet("obj-chicken", "assets/obj/chicken.webp", {
      frameHeight: 32,
      frameWidth: 32,
    });
    this.load.spritesheet("obj-cow", "assets/obj/cow.webp", { frameHeight: 32, frameWidth: 32 });
    this.load.spritesheet("obj-pig", "assets/obj/pig.webp", { frameHeight: 32, frameWidth: 32 });
    this.load.spritesheet("obj-sheep", "assets/obj/sheep.webp", {
      frameHeight: 32,
      frameWidth: 32,
    });
    this.load.spritesheet("obj-duck", "assets/obj/duck.webp", { frameHeight: 16, frameWidth: 16 });
    this.load.spritesheet("obj-bird", "assets/obj/bird.webp", { frameHeight: 16, frameWidth: 16 });

    // ui
    for (const n of ["axe", "pickaxe", "shovel", "water", "sword", "rod"]) {
      this.load.image(`ui-${n}`, `assets/ui/${n}.webp`);
    }
  }

  create(): void {
    setWorldMap(parseWorldMap(this.cache.json.get("map")));
    this.makeAnimsAndStart();
  }

  private makeAnimsAndStart(): void {
    const mk = (key: string, src: string, rate: number, repeat: number) =>
      this.anims.create({
        frameRate: rate,
        frames: this.anims.generateFrameNumbers(src, {}),
        key,
        repeat,
      });

    mk("p-idle", "p-idle", 7, -1);
    mk("p-walk", "p-walk", 12, -1);
    mk("p-run", "p-run", 14, -1);
    mk("p-dig", "p-dig", 18, 0);
    mk("p-water", "p-water", 9, 0);
    mk("p-axe", "p-axe", 16, 0);
    mk("p-mine", "p-mine", 16, 0);
    mk("p-doing", "p-doing", 14, 0);
    mk("p-attack", "p-attack", 20, 0);
    mk("p-casting", "p-casting", 18, 0);
    mk("p-reeling", "p-reeling", 12, -1);
    mk("p-caught", "p-caught", 12, 0);
    mk("p-death", "p-death", 10, 0);
    mk("p-hurt", "p-hurt", (8 * 1000) / FARMER_HURT_MS, 0);

    mk("e-skel-idle", "e-skel-idle", 6, -1);
    mk("e-skel-walk", "e-skel-walk", 10, -1);
    mk("e-skel-death", "e-skel-death", 12, 0);
    mk("e-skel-hurt", "e-skel-hurt", (7 * 1000) / SKELETON_HURT_MS, 0);
    // The original strip's arc/recovery follows accepted contact. Its windup
    // frames would imply a delay that this enemy's contact damage does not have.
    this.anims.create({
      frameRate: (3 * 1000) / SKELETON_CONTACT_MS,
      frames: this.anims.generateFrameNumbers("e-skel-attack", { end: 6, start: 4 }),
      key: "e-skel-contact",
      repeat: 0,
    });

    mk("chicken-walk", "obj-chicken", 6, -1);
    mk("cow-idle", "obj-cow", 4, -1);
    mk("pig-idle", "obj-pig", 4, -1);
    mk("sheep-idle", "obj-sheep", 4, -1);
    mk("duck-walk", "obj-duck", 6, -1);
    mk("bird-fly", "obj-bird", 8, -1);
    mk("mushroom-red-bob", "obj-mushroom-red", 4, -1);
    mk("mushroom-blue-bob", "obj-mushroom-blue", 4, -1);

    // every animated deco sprite referenced by the world map (frames live in
    // the packed deco-atlas as "<name>/<i>")
    const worldMap = getWorldMap();
    for (const [name, def] of Object.entries(worldMap.deco)) {
      if (def.frames > 1) {
        this.anims.create({
          frameRate: PhaserMath.Clamp(def.fps, 1, 30),
          frames: Array.from({ length: def.frames }, (_, i) => ({
            frame: `${name}/${i}`,
            key: "deco-atlas",
          })),
          key: `deco-${name}`,
          repeat: -1,
        });
      }
    }

    this.makeIcon("icon-wool", (g) => {
      g.fillStyle(0xf2_f2_f2, 1);
      g.fillRoundedRect(2, 3, 12, 10, 4);
      g.fillStyle(0xff_ff_ff, 1);
      g.fillCircle(5, 6, 3);
      g.fillCircle(10, 6, 3);
      g.fillCircle(8, 9, 3);
    });
    this.makeIcon("icon-truffle", (g) => {
      g.fillStyle(0x4a_33_20, 1);
      g.fillEllipse(8, 9, 12, 9);
      g.fillStyle(0x6b_4a_2c, 1);
      g.fillEllipse(7, 7, 8, 5);
    });
    this.makeIcon("t-cavefloor", (g) => {
      g.fillStyle(0x2c_2f_3a, 1);
      g.fillRect(0, 0, 16, 16);
      g.fillStyle(0x26_29_36, 1);
      g.fillRect(0, 0, 8, 8);
      g.fillRect(8, 8, 8, 8);
      g.fillStyle(0x3a_3f_4e, 0.5);
      g.fillRect(3, 11, 2, 2);
      g.fillRect(11, 4, 2, 2);
    });
    this.makeIcon("t-cavewall", (g) => {
      g.fillStyle(0x14_16_1e, 1);
      g.fillRect(0, 0, 16, 16);
      g.fillStyle(0x1e_22_30, 1);
      g.fillRect(1, 1, 14, 12);
      g.fillStyle(0x2a_2f_40, 1);
      g.fillRect(2, 2, 5, 4);
      g.fillRect(9, 7, 5, 4);
    });
    this.makeIcon("obj-ladder", (g) => {
      g.fillStyle(0x8a_5a_2c, 1);
      g.fillRect(2, 0, 2, 16);
      g.fillRect(12, 0, 2, 16);
      g.fillStyle(0xb5_80_3f, 1);
      for (let y = 2; y < 16; y += 4) {
        g.fillRect(2, y, 12, 2);
      }
    });

    const params = new URLSearchParams(window.location.search);
    // ?trailer=1 hands the boot over to the trailer director (lazy-loaded so
    // trailer code stays out of the normal play path entirely; presence-check
    // only — importing trailer-shell here would hoist it into the main chunk)
    if (params.has("trailer")) {
      void this.startTrailer();
      return;
    }
    // ?gallery opens the asset-inspection page instead of the game
    // (lazy-loaded so gallery code stays out of the main chunk)
    if (params.has("gallery")) {
      void this.startGallery();
      return;
    }
    this.scene.start("Title");
  }

  private async startTrailer(): Promise<void> {
    const { startTrailer } = await import("../trailer/trailer-director");
    startTrailer(this.game);
  }

  private async startGallery(): Promise<void> {
    const { GalleryScene } = await import("./gallery-scene");
    if (!this.scene.get("Gallery")) {
      this.scene.add("Gallery", GalleryScene);
    }
    this.scene.start("Gallery");
  }

  private makeIcon(
    key: string,
    draw: (g: Phaser.GameObjects.Graphics) => void,
    w = 16,
    h = 16,
  ): void {
    if (this.textures.exists(key)) {
      return;
    }
    const g = this.make.graphics({ x: 0, y: 0 });
    draw(g);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
