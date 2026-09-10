import type Phaser from "phaser";
import { Math as PhaserMath } from "phaser";
import { TILE, DEPTH } from "../config";
import type { World } from "../world/world";
import { store } from "../systems/store";
import { ANIMALS, isAnimalKind, randomAnimalName } from "../data/animals";
import type { AnimalKind, BuildingKind } from "../data/animals";
import type { AnimalSave } from "../systems/save";
import { floatText, burst } from "../render/fx";
import { Sound } from "../render/audio";
import type { GameScene } from "../scenes/game-scene";

interface Live {
  data: AnimalSave;
  spr: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  tx: number;
  // home building anchor
  ty: number;
  target: { x: number; y: number };
  rest: number;
}

export class AnimalManager {
  private scene: GameScene;
  private world: World;
  private live: Live[] = [];
  private pettedToday = new Set<number>();

  constructor(scene: GameScene, world: World) {
    this.scene = scene;
    this.world = world;
  }

  private homeOf(building: BuildingKind) {
    const o = this.world.objects.find((b) => b.type === building);
    if (o) {
      return { x: o.tx * TILE + 8, y: (o.ty + 2) * TILE };
    }
    return { x: 12 * TILE, y: 12 * TILE };
  }

  spawnAll(): void {
    for (const d of store.animals) {
      this.spawnOne(d);
    }
  }

  /** Trailer staging: add + spawn an animal at its saved x/y (real spawn path).
   *  Dead in normal play (gameplay animals arrive via buy/save). */
  stageSpawn(d: AnimalSave): void {
    store.animals.push(d);
    this.spawnOne(d);
  }

  /** Trailer staging: a live animal's feet tile — animals wander, so scripted
   *  approach/petting resolves the live position. Dead in normal play. */
  trailerTileOf(id: number): { tx: number; ty: number } | null {
    const l = this.live.find((a) => a.data.id === id);
    if (!l) {
      return null;
    }
    return { tx: Math.floor(l.spr.x / TILE), ty: Math.floor((l.spr.y - 1) / TILE) };
  }

  private spawnOne(d: AnimalSave): void {
    if (!isAnimalKind(d.kind)) {
      return;
    }
    const def = ANIMALS[d.kind];
    const home = this.homeOf(d.building);
    const x = d.x || home.x + PhaserMath.Between(-20, 20);
    const y = d.y || home.y + PhaserMath.Between(-12, 12);
    const shadow = this.scene.add
      .sprite(x, y, "char-shadow-tex")
      .setOrigin(0.5, 0.5)
      .setScale(def.shadowScale, 1)
      .setAlpha(0.3);
    const spr = this.scene.add
      .sprite(x, y, def.texture, 0)
      .setOrigin(0.5, def.originY)
      .play(def.anim);
    spr.setDepth(DEPTH.entityBase + y);
    shadow.setDepth(spr.depth - 1);
    spr.setInteractive({ useHandCursor: true });
    this.live.push({
      data: d,
      rest: PhaserMath.FloatBetween(0, 2),
      shadow,
      spr,
      target: { x, y },
      tx: x,
      ty: y,
    });
  }

  buy(kind: AnimalKind): boolean {
    const def = ANIMALS[kind];
    if (store.gold < def.price) {
      this.scene.toast("Not enough gold.", "#ffb0b0");
      return false;
    }
    store.gold -= def.price;
    const home = this.homeOf(def.building);
    const id = store.animalSeq;
    store.animalSeq += 1;
    const data: AnimalSave = {
      building: def.building,
      fed: true,
      friendship: 0,
      id,
      kind,
      name: randomAnimalName(store.animalSeq),
      producedToday: false,
      x: home.x + PhaserMath.Between(-18, 18),
      y: home.y + PhaserMath.Between(-10, 10),
    };
    store.animals.push(data);
    this.spawnOne(data);
    Sound.coins();
    this.scene.toast(`Welcome, ${data.name} the ${def.name.toLowerCase()}!`, "#ffe27a");
    this.scene.requestSave();
    return true;
  }

  tryPet(tx: number, ty: number): boolean {
    for (const l of this.live) {
      const ax = Math.floor(l.spr.x / TILE);
      const ay = Math.floor((l.spr.y - 1) / TILE);
      if (Math.abs(ax - tx) <= 1 && Math.abs(ay - ty) <= 1) {
        if (this.pettedToday.has(l.data.id)) {
          floatText(this.scene, l.spr.x, l.spr.y - 16, "♥", "#ffcdd8");
        } else {
          this.pettedToday.add(l.data.id);
          l.data.friendship = Math.min(100, l.data.friendship + 8);
          burst(this.scene, l.spr.x, l.spr.y - 14, {
            colors: [0xff_5d_7a, 0xff_9e_d2, 0xff_ff_ff],
            count: 7,
            speed: 40,
            up: true,
          });
          floatText(this.scene, l.spr.x, l.spr.y - 16, "♥", "#ff8aa8");
          Sound.plant();
          this.scene.tweens.add({ duration: 90, scaleY: 0.85, targets: l.spr, yoyo: true });
        }
        return true;
      }
    }
    return false;
  }

  update(dt: number): void {
    const day = this.scene.timeMin < 19 * 60 && this.scene.timeMin > 6.5 * 60;
    for (const l of this.live) {
      l.rest -= dt;
      if (l.rest <= 0 && day) {
        const home = this.homeOf(l.data.building);
        l.target = {
          x: home.x + PhaserMath.Between(-28, 28),
          y: home.y + PhaserMath.Between(-16, 16),
        };
        l.rest = PhaserMath.FloatBetween(1.2, 3.5);
      }
      const dx = l.target.x - l.spr.x;
      const dy = l.target.y - l.spr.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.5 && day) {
        const sp = 14 * dt;
        l.spr.x += (dx / dist) * sp;
        l.spr.y += (dy / dist) * sp;
        if (dx < -0.2) {
          l.spr.setFlipX(true);
        } else if (dx > 0.2) {
          l.spr.setFlipX(false);
        }
      }
      l.spr.setDepth(DEPTH.entityBase + l.spr.y);
      l.shadow.setPosition(l.spr.x, l.spr.y);
      l.shadow.setDepth(l.spr.depth - 1);
      l.data.x = l.spr.x;
      l.data.y = l.spr.y;
    }
  }

  // produce overnight; returns a short summary for the morning toast
  runOvernight(): void {
    this.pettedToday.clear();
    const counts = new Map<string, number>();
    for (const l of this.live) {
      if (!isAnimalKind(l.data.kind)) {
        continue;
      }
      const def = ANIMALS[l.data.kind];
      let qty = 1;
      if (l.data.friendship >= 60 && Math.random() < 0.5) {
        qty += 1;
      }
      store.inv.add({ kind: "animal_product", product: def.product }, qty);
      counts.set(def.product, (counts.get(def.product) ?? 0) + qty);
      l.data.producedToday = true;
      l.data.friendship = Math.min(100, l.data.friendship + 1);
    }
    if (counts.size > 0) {
      const parts = [...counts.entries()].map(([p, n]) => `${n} ${p}`);
      this.scene.time.delayedCall(900, () =>
        this.scene.toast(`Your animals gave you ${parts.join(", ")}.`, "#fff0c0"),
      );
    }
  }
}
