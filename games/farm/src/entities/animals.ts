import Phaser from "phaser";
import { TILE, DEPTH } from "../config";
import { World } from "../world/world";
import { store } from "../systems/store";
import { ANIMALS, randomAnimalName, type AnimalKind, type BuildingKind } from "../data/animals";
import type { AnimalSave } from "../systems/save";
import { floatText, burst } from "../render/fx";
import { Sound } from "../render/audio";
import type { GameScene } from "../scenes/game-scene";

type Live = {
  data: AnimalSave;
  spr: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  tx: number;
  ty: number; // home building anchor
  target: { x: number; y: number };
  rest: number;
};

export class AnimalManager {
  private scene: GameScene;
  private world: World;
  private live: Live[] = [];
  private pettedToday = new Set<number>();

  constructor(scene: GameScene, world: World) {
    this.scene = scene;
    this.world = world;
  }

  private homeOf(building: BuildingKind): { x: number; y: number } {
    const o = this.world.objects.find((b) => b.type === building);
    if (o) return { x: o.tx * TILE + 8, y: (o.ty + 2) * TILE };
    return { x: 12 * TILE, y: 12 * TILE };
  }

  spawnAll(): void {
    for (const d of store.animals) this.spawnOne(d);
  }

  private spawnOne(d: AnimalSave): void {
    const def = ANIMALS[d.kind as AnimalKind];
    if (!def) return;
    const home = this.homeOf(d.building);
    const x = d.x || home.x + Phaser.Math.Between(-20, 20);
    const y = d.y || home.y + Phaser.Math.Between(-12, 12);
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
      spr,
      shadow,
      tx: x,
      ty: y,
      target: { x, y },
      rest: Phaser.Math.FloatBetween(0, 2),
    });
  }

  canBuy(kind: AnimalKind): boolean {
    return store.gold >= ANIMALS[kind].price;
  }

  buy(kind: AnimalKind): boolean {
    const def = ANIMALS[kind];
    if (store.gold < def.price) {
      this.scene.toast("Not enough gold.", "#ffb0b0");
      return false;
    }
    store.gold -= def.price;
    const home = this.homeOf(def.building);
    const data: AnimalSave = {
      id: store.animalSeq++,
      kind,
      building: def.building,
      name: randomAnimalName(store.animalSeq),
      friendship: 0,
      fed: true,
      producedToday: false,
      x: home.x + Phaser.Math.Between(-18, 18),
      y: home.y + Phaser.Math.Between(-10, 10),
    };
    store.animals.push(data);
    this.spawnOne(data);
    Sound.coins();
    this.scene.toast(`Welcome, ${data.name} the ${def.name.toLowerCase()}!`, "#ffe27a");
    this.scene.save();
    return true;
  }

  tryPet(tx: number, ty: number): boolean {
    for (const l of this.live) {
      const ax = Math.floor(l.spr.x / TILE),
        ay = Math.floor((l.spr.y - 1) / TILE);
      if (Math.abs(ax - tx) <= 1 && Math.abs(ay - ty) <= 1) {
        if (!this.pettedToday.has(l.data.id)) {
          this.pettedToday.add(l.data.id);
          l.data.friendship = Math.min(100, l.data.friendship + 8);
          burst(this.scene, l.spr.x, l.spr.y - 14, {
            colors: [0xff5d7a, 0xff9ed2, 0xffffff],
            count: 7,
            up: true,
            speed: 40,
          });
          floatText(this.scene, l.spr.x, l.spr.y - 16, "♥", "#ff8aa8");
          Sound.plant();
          this.scene.tweens.add({ targets: l.spr, scaleY: 0.85, duration: 90, yoyo: true });
        } else {
          floatText(this.scene, l.spr.x, l.spr.y - 16, "♥", "#ffcdd8");
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
          x: home.x + Phaser.Math.Between(-28, 28),
          y: home.y + Phaser.Math.Between(-16, 16),
        };
        l.rest = Phaser.Math.FloatBetween(1.2, 3.5);
      }
      const dx = l.target.x - l.spr.x,
        dy = l.target.y - l.spr.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.5 && day) {
        const sp = 14 * dt;
        l.spr.x += (dx / dist) * sp;
        l.spr.y += (dy / dist) * sp;
        if (dx < -0.2) l.spr.setFlipX(true);
        else if (dx > 0.2) l.spr.setFlipX(false);
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
      const def = ANIMALS[l.data.kind as AnimalKind];
      if (!def) continue;
      let qty = 1;
      if (l.data.friendship >= 60 && Math.random() < 0.5) qty += 1;
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

  count(): number {
    return this.live.length;
  }
}
