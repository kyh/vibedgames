import Phaser from "phaser";
import { CROP_ORDER } from "../data/crops";
import { parseTracedMap } from "../world/traced";
import { setTracedMap, getTracedMap } from "../world/map-store";

const CHAR = { frameWidth: 96, frameHeight: 64 };

// action -> frame count (encoded in the source strip name)
export const CHAR_FRAMES = {
  idle: 9,
  walk: 8,
  run: 8,
  dig: 13,
  water: 5,
  axe: 10,
  mine: 10,
  doing: 8,
  attack: 10,
  carry: 8,
  casting: 15,
  reeling: 13,
  caught: 10,
  hurt: 8,
  death: 13,
  roll: 10,
} as const;
export type CharAction = keyof typeof CHAR_FRAMES;

const SKEL = {
  idle: 6,
  walk: 8,
  attack: 7,
  hurt: 7,
  death: 10,
} as const;

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    for (const a of Object.keys(CHAR_FRAMES) as CharAction[]) {
      this.load.spritesheet(`p-${a}`, `assets/char/${a}.png`, CHAR);
    }
    for (const a of Object.keys(SKEL)) {
      this.load.spritesheet(`e-skel-${a}`, `assets/enemy/skel_${a}.png`, CHAR);
    }

    // traced world: tileset atlas (as tileset image AND frame sheet), the
    // packed deco sprite atlas, and the layout
    this.load.image("atlas", "assets/tiles/atlas.png");
    this.load.spritesheet("atlas-sheet", "assets/tiles/atlas.png", {
      frameWidth: 16,
      frameHeight: 16,
    });
    this.load.atlas("deco-atlas", "assets/deco-atlas.png", "assets/deco-atlas.json");
    this.load.json("map", "assets/map.json");
    this.load.image("char-shadow-tex", "assets/obj/charactershadow.png");

    // crops
    for (const c of CROP_ORDER) {
      this.load.spritesheet(`crop-${c}`, `assets/crops/${c}.png`, {
        frameWidth: 16,
        frameHeight: 16,
      });
      this.load.image(`crop-${c}-icon`, `assets/crops/${c}_icon.png`);
    }

    // objects still spawned by gameplay (mine nodes, soil, icons)
    this.load.image("obj-rock", "assets/obj/rock.png");
    this.load.image("obj-ore-coal", "assets/obj/ore_coal.png");
    this.load.image("obj-ore-copper", "assets/obj/ore_copper.png");
    this.load.image("obj-ore-crystal", "assets/obj/ore_crystal.png");
    this.load.image("obj-soil", "assets/obj/soil.png");
    this.load.image("obj-seeds", "assets/obj/seeds.png");
    this.load.image("obj-wood", "assets/obj/wood.png");
    this.load.image("obj-stone", "assets/obj/stone.png");
    this.load.image("obj-fish", "assets/obj/fish.png");
    this.load.image("obj-egg", "assets/obj/egg.png");
    this.load.image("obj-milk", "assets/obj/milk.png");
    this.load.spritesheet("obj-mushroom-red", "assets/obj/mushroom_red.png", {
      frameWidth: 16,
      frameHeight: 16,
    });
    this.load.spritesheet("obj-mushroom-blue", "assets/obj/mushroom_blue.png", {
      frameWidth: 16,
      frameHeight: 16,
    });

    // animals
    this.load.spritesheet("obj-chicken", "assets/obj/chicken.png", {
      frameWidth: 32,
      frameHeight: 32,
    });
    this.load.spritesheet("obj-cow", "assets/obj/cow.png", { frameWidth: 32, frameHeight: 32 });
    this.load.spritesheet("obj-pig", "assets/obj/pig.png", { frameWidth: 32, frameHeight: 32 });
    this.load.spritesheet("obj-sheep", "assets/obj/sheep.png", {
      frameWidth: 32,
      frameHeight: 32,
    });
    this.load.spritesheet("obj-duck", "assets/obj/duck.png", { frameWidth: 16, frameHeight: 16 });
    this.load.spritesheet("obj-bird", "assets/obj/bird.png", { frameWidth: 16, frameHeight: 16 });

    // ui
    for (const n of ["axe", "pickaxe", "shovel", "water", "hammer", "sword", "basket", "rod"])
      this.load.image(`ui-${n}`, `assets/ui/${n}.png`);
    this.load.image("ui-slot", "assets/ui/slot.png");
    this.load.image("ui-slot-sel", "assets/ui/slot_sel.png");
  }

  create(): void {
    setTracedMap(parseTracedMap(this.cache.json.get("map")));
    this.makeAnimsAndStart();
  }

  private makeAnimsAndStart(): void {
    const mk = (key: string, src: string, rate: number, repeat: number) =>
      this.anims.create({
        key,
        frames: this.anims.generateFrameNumbers(src, {}),
        frameRate: rate,
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
    mk("p-hurt", "p-hurt", 14, 0);
    mk("p-death", "p-death", 10, 0);
    mk("p-roll", "p-roll", 18, 0);

    mk("e-skel-idle", "e-skel-idle", 6, -1);
    mk("e-skel-walk", "e-skel-walk", 10, -1);
    mk("e-skel-attack", "e-skel-attack", 12, 0);
    mk("e-skel-hurt", "e-skel-hurt", 14, 0);
    mk("e-skel-death", "e-skel-death", 12, 0);

    mk("chicken-walk", "obj-chicken", 6, -1);
    mk("cow-idle", "obj-cow", 4, -1);
    mk("pig-idle", "obj-pig", 4, -1);
    mk("sheep-idle", "obj-sheep", 4, -1);
    mk("duck-walk", "obj-duck", 6, -1);
    mk("bird-fly", "obj-bird", 8, -1);
    mk("mushroom-red-bob", "obj-mushroom-red", 4, -1);
    mk("mushroom-blue-bob", "obj-mushroom-blue", 4, -1);

    // every animated deco sprite referenced by the traced map (frames live in
    // the packed deco-atlas as "<name>/<i>")
    const traced = getTracedMap();
    for (const [name, def] of Object.entries(traced.deco)) {
      if (def.frames > 1) {
        this.anims.create({
          key: `deco-${name}`,
          frames: Array.from({ length: def.frames }, (_, i) => ({
            key: "deco-atlas",
            frame: `${name}/${i}`,
          })),
          frameRate: Phaser.Math.Clamp(def.fps, 1, 30),
          repeat: -1,
        });
      }
    }

    this.makeIcon("icon-wool", (g) => {
      g.fillStyle(0xf2f2f2, 1);
      g.fillRoundedRect(2, 3, 12, 10, 4);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(5, 6, 3);
      g.fillCircle(10, 6, 3);
      g.fillCircle(8, 9, 3);
    });
    this.makeIcon("icon-truffle", (g) => {
      g.fillStyle(0x4a3320, 1);
      g.fillEllipse(8, 9, 12, 9);
      g.fillStyle(0x6b4a2c, 1);
      g.fillEllipse(7, 7, 8, 5);
    });
    this.makeIcon("icon-hay", (g) => {
      g.fillStyle(0xe0b94d, 1);
      g.fillRoundedRect(2, 4, 12, 9, 2);
      g.lineStyle(1, 0xb58a2c, 1);
      g.strokeRect(2, 7, 12, 0);
      g.fillStyle(0xc99a36, 1);
      g.fillRect(7, 4, 2, 9);
    });
    this.makeIcon("icon-heart", (g) => {
      g.fillStyle(0xff5d7a, 1);
      g.fillCircle(5, 6, 3);
      g.fillCircle(11, 6, 3);
      g.fillTriangle(2, 7, 14, 7, 8, 14);
    });
    this.makeIcon(
      "px-white",
      (g) => {
        g.fillStyle(0xffffff, 1);
        g.fillRect(0, 0, 4, 4);
      },
      4,
      4,
    );
    this.makeIcon("t-cavefloor", (g) => {
      g.fillStyle(0x2c2f3a, 1);
      g.fillRect(0, 0, 16, 16);
      g.fillStyle(0x262936, 1);
      g.fillRect(0, 0, 8, 8);
      g.fillRect(8, 8, 8, 8);
      g.fillStyle(0x3a3f4e, 0.5);
      g.fillRect(3, 11, 2, 2);
      g.fillRect(11, 4, 2, 2);
    });
    this.makeIcon("t-cavewall", (g) => {
      g.fillStyle(0x14161e, 1);
      g.fillRect(0, 0, 16, 16);
      g.fillStyle(0x1e2230, 1);
      g.fillRect(1, 1, 14, 12);
      g.fillStyle(0x2a2f40, 1);
      g.fillRect(2, 2, 5, 4);
      g.fillRect(9, 7, 5, 4);
    });
    this.makeIcon("obj-ladder", (g) => {
      g.fillStyle(0x8a5a2c, 1);
      g.fillRect(2, 0, 2, 16);
      g.fillRect(12, 0, 2, 16);
      g.fillStyle(0xb5803f, 1);
      for (let y = 2; y < 16; y += 4) g.fillRect(2, y, 12, 2);
    });

    this.scene.start("Title");
  }

  private makeIcon(
    key: string,
    draw: (g: Phaser.GameObjects.Graphics) => void,
    w = 16,
    h = 16,
  ): void {
    if (this.textures.exists(key)) return;
    const g = this.make.graphics({ x: 0, y: 0 });
    draw(g);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
