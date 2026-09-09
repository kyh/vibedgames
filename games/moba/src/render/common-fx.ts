import Phaser from "phaser";
import { FONT } from "./font";

type Priority = "common" | "important";
type PointFx = { x: number; y: number; depth: number; priority?: Priority; radius?: number };
type ImageFx = PointFx & {
  texture: string;
  scale: number;
  scaleY?: number;
  endScale: number;
  endScaleY?: number;
  dx?: number;
  dy?: number;
  tint?: number;
  alpha?: number;
  rotation?: number;
  endRotation?: number;
  life: number;
  hold?: number;
  ease?: "quad" | "cubic";
};
type SpriteFx = PointFx & {
  sheet: string;
  anim?: string;
  scale: number;
  tint?: number;
  alpha?: number;
  flip?: boolean;
  delay?: number;
  additive?: boolean;
  startFrame?: number;
};
type LabelFx = PointFx & {
  group?: string;
  text: string;
  color: string;
  size: number;
  life: number;
  rise: number;
  crit?: boolean;
};
type PlacedLabelFx = LabelFx & {
  lane: number;
  anchorX: number;
  anchorY: number;
  cellWidth: number;
  cellHeight: number;
};
type Live<T> = { recipe: T; age: number; serial: number };
type Slot<Node, Recipe> = { node: Node; live: Live<Recipe> | null };

export type CommonFxCounts = {
  images: number;
  sprites: number;
  labels: number;
  capacity: { images: number; sprites: number; labels: number };
};

/** Common combat decoration only. Fixed pools reserve a quarter of their slots
 * for local/major feedback; those events may replace common decoration under load.
 * Gameplay zones, projectiles, unit reactions and targeting never enter this pool. */
export class CommonFx {
  private readonly images: Slot<Phaser.GameObjects.Image, ImageFx>[];
  private readonly sprites: Slot<Phaser.GameObjects.Sprite, SpriteFx>[];
  private readonly labels: Slot<Phaser.GameObjects.Text, PlacedLabelFx>[];
  private serial = 0;
  private focused = false;

  constructor(private readonly scene: Phaser.Scene) {
    if (!scene.textures.exists("fx-cleave")) {
      const blade = scene.add.graphics();
      blade.fillStyle(0xffffff, 1).beginPath();
      blade.moveTo(48 + Math.cos(-0.95) * 42, 48 + Math.sin(-0.95) * 42);
      for (let i = 1; i <= 24; i++) {
        const angle = -0.95 + (i / 24) * 1.9;
        blade.lineTo(48 + Math.cos(angle) * 42, 48 + Math.sin(angle) * 42);
      }
      for (let i = 24; i >= 0; i--) {
        const angle = -0.95 + (i / 24) * 1.9;
        const radius = 42 - Math.sin((i / 24) * Math.PI) * 15;
        blade.lineTo(48 + Math.cos(angle) * radius, 48 + Math.sin(angle) * radius);
      }
      blade.closePath().fillPath();
      blade.generateTexture("fx-cleave", 96, 96);
      blade.destroy();
    }
    this.images = Array.from({ length: 192 }, () => ({
      node: scene.add.image(0, 0, "spark").setVisible(false),
      live: null,
    }));
    this.sprites = Array.from({ length: 32 }, () => ({
      node: scene.add.sprite(0, 0, "spark").setActive(false).setVisible(false),
      live: null,
    }));
    this.labels = Array.from({ length: 32 }, () => ({
      node: scene.add
        .text(0, 0, "", { fontFamily: FONT, stroke: "#1c1410", strokeThickness: 4 })
        .setOrigin(0.5)
        .setVisible(false),
      live: null,
    }));
  }

  visible(x: number, y: number, radius = 160): boolean {
    const v = this.scene.cameras.main.worldView;
    return (
      x >= v.x - radius && x <= v.right + radius && y >= v.y - radius && y <= v.bottom + radius
    );
  }

  /** A lighter cosmetic budget. Important/local feedback keeps its reservation;
   * text, projectiles, ground zones and targeting retain their normal limits. */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (!focused) return;
    for (const slot of this.images) {
      if (!slot.live || slot.live.recipe.priority === "important") continue;
      slot.live = null;
      slot.node.setVisible(false);
    }
    for (const slot of this.sprites) {
      if (!slot.live || slot.live.recipe.priority === "important") continue;
      slot.live = null;
      slot.node.anims.stop();
      slot.node.setVisible(false);
    }
  }

  private take<N, R extends PointFx>(
    slots: Slot<N, R>[],
    recipe: R,
    commonScale = 1,
  ): Slot<N, R> | null {
    if (!this.visible(recipe.x, recipe.y, recipe.radius)) return null;
    const important = recipe.priority === "important";
    const limit = important ? slots.length : Math.floor(slots.length * 0.75 * commonScale);
    let oldest: Slot<N, R> | null = null;
    for (let i = 0; i < limit; i++) {
      const slot = slots[i];
      if (!slot) continue;
      if (!slot.live) return slot;
      if (
        slot.live.recipe.priority !== "important" &&
        (!oldest || slot.live.serial < (oldest.live?.serial ?? Infinity))
      )
        oldest = slot;
    }
    // Ordinary traffic cannot evict useful impacts. Important traffic can reuse
    // the oldest ordinary slot, but never removes another important event.
    return important ? oldest : null;
  }

  image(recipe: ImageFx): void {
    if (!this.scene.textures.exists(recipe.texture)) return;
    const slot = this.take(this.images, recipe, this.focused ? 0.45 : 1);
    if (!slot) return;
    slot.live = { recipe, age: 0, serial: this.serial++ };
    slot.node
      .setTexture(recipe.texture)
      .setPosition(recipe.x, recipe.y)
      .setDepth(recipe.depth)
      .setScale(recipe.scale, recipe.scaleY ?? recipe.scale)
      .setRotation(recipe.rotation ?? 0)
      .setTint(recipe.tint ?? 0xffffff)
      .setAlpha(recipe.alpha ?? 1)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(true);
  }

  sprite(recipe: SpriteFx): void {
    const anim = recipe.anim ?? recipe.sheet;
    if (!this.scene.anims.exists(anim)) return;
    const slot = this.take(this.sprites, recipe, this.focused ? 0.45 : 1);
    if (!slot) return;
    slot.node.anims.stop();
    slot.live = { recipe, age: -(recipe.delay ?? 0), serial: this.serial++ };
    slot.node
      .setTexture(recipe.sheet, 0)
      .setPosition(recipe.x, recipe.y)
      .setDepth(recipe.depth)
      .setScale(recipe.scale)
      .setRotation(0)
      .setTint(recipe.tint ?? 0xffffff)
      .setAlpha(recipe.alpha ?? 1)
      .setFlipX(recipe.flip ?? false)
      .setBlendMode(recipe.additive ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL)
      .setVisible((recipe.delay ?? 0) === 0);
    // Inactive sprites are advanced exactly once below, using the view's delta.
    // No completion listeners or scene timers can fire after a slot is reused.
    if ((recipe.delay ?? 0) === 0)
      slot.node.play({ key: anim, startFrame: recipe.startFrame ?? 0 });
    slot.node.setActive(false);
  }

  label(recipe: LabelFx): void {
    const occupied = new Set<number>();
    if (recipe.group) {
      for (const slot of this.labels)
        if (slot.live?.recipe.group === recipe.group) occupied.add(slot.live.recipe.lane);
    }
    let lane = 0;
    while (occupied.has(lane)) lane++;
    const placed = {
      ...recipe,
      lane,
      anchorX: recipe.x,
      anchorY: recipe.y,
      cellWidth: 0,
      cellHeight: 0,
    };
    const slot = this.take(this.labels, placed);
    if (!slot) return;
    slot.live = { recipe: placed, age: 0, serial: this.serial++ };
    slot.node
      .setText(recipe.text)
      .setFontSize(recipe.size)
      .setColor(recipe.color)
      .setStroke("#1c1410", recipe.crit ? 5 : 4)
      .setPosition(placed.x, placed.y)
      .setDepth(recipe.depth)
      .setScale(recipe.crit ? 0.4 : 1)
      .setAlpha(1)
      .setVisible(true);
    if (!recipe.group) return;
    // Measure the real glyphs including stroke and reserve their maximum crit
    // pop. A growing burst can widen its five-column grid; it never stacks text
    // in fixed cells too small for a three-digit critical hit.
    let width = slot.node.width * (recipe.crit ? 1.3 : 1) + 8;
    // Older labels rise toward the next row. Reserve the entire rise as well
    // as glyph height, so a later sixth hit cannot catch the first five.
    let height = slot.node.height * (recipe.crit ? 1.3 : 1) + recipe.rise + 8;
    for (const other of this.labels) {
      if (other.live?.recipe.group !== recipe.group) continue;
      width = Math.max(width, other.live.recipe.cellWidth);
      height = Math.max(height, other.live.recipe.cellHeight);
    }
    for (const other of this.labels) {
      const r = other.live?.recipe;
      if (!r || r.group !== recipe.group) continue;
      const column = [0, -1, 1, -2, 2][r.lane % 5] ?? 0;
      const nextY = r.anchorY - Math.floor(r.lane / 5) * height - Math.abs(column) * 6;
      other.node.setPosition(r.anchorX + column * width, other.node.y + nextY - r.y);
      r.x = other.node.x;
      r.y = nextY;
      r.cellWidth = width;
      r.cellHeight = height;
    }
  }

  update(dt: number): void {
    for (const slot of this.images) {
      const live = slot.live;
      if (!live) continue;
      live.age += dt;
      const r = live.recipe,
        t = Math.min(1, live.age / r.life);
      const eased = 1 - (1 - t) ** (r.ease === "cubic" ? 3 : 2);
      const fade = Phaser.Math.Clamp(
        (live.age - (r.hold ?? 0)) / Math.max(0.001, r.life - (r.hold ?? 0)),
        0,
        1,
      );
      slot.node
        .setPosition(r.x + (r.dx ?? 0) * eased, r.y + (r.dy ?? 0) * eased)
        .setScale(
          r.scale + (r.endScale - r.scale) * eased,
          (r.scaleY ?? r.scale) + ((r.endScaleY ?? r.endScale) - (r.scaleY ?? r.scale)) * eased,
        )
        .setRotation(
          (r.rotation ?? 0) + ((r.endRotation ?? r.rotation ?? 0) - (r.rotation ?? 0)) * eased,
        )
        .setAlpha((r.alpha ?? 1) * (r.hold === undefined ? 1 - eased : (1 - fade) ** 2));
      if (t >= 1) {
        slot.live = null;
        slot.node.setVisible(false);
      }
    }
    for (const slot of this.sprites) {
      const live = slot.live;
      if (!live) continue;
      const before = live.age;
      live.age += dt;
      if (live.age < 0) continue;
      if (before < 0) {
        slot.node.play({
          key: live.recipe.anim ?? live.recipe.sheet,
          startFrame: live.recipe.startFrame ?? 0,
        });
        slot.node.setVisible(true);
      }
      slot.node.anims.update(this.scene.time.now, (before < 0 ? live.age : dt) * 1000);
      if (!slot.node.anims.isPlaying) {
        slot.live = null;
        slot.node.setVisible(false);
      }
    }
    for (const slot of this.labels) {
      const live = slot.live;
      if (!live) continue;
      live.age += dt;
      const r = live.recipe,
        t = Math.min(1, live.age / r.life),
        eased = 1 - (1 - t) ** 3;
      const pop = Math.min(1, live.age / 0.2);
      const back = 1 + 2.70158 * (pop - 1) ** 3 + 1.70158 * (pop - 1) ** 2;
      slot.node
        .setY(r.y - r.rise * eased)
        .setAlpha(1 - eased)
        .setScale(r.crit ? 0.4 + back * 0.75 : 1);
      if (t >= 1) {
        slot.live = null;
        slot.node.setVisible(false);
      }
    }
  }

  reset(): void {
    for (const slot of this.images) {
      slot.live = null;
      slot.node.setVisible(false);
    }
    for (const slot of this.sprites) {
      slot.live = null;
      slot.node.anims.stop();
      slot.node.setVisible(false);
    }
    for (const slot of this.labels) {
      slot.live = null;
      slot.node.setVisible(false);
    }
  }

  counts(): CommonFxCounts {
    return {
      images: this.images.filter((s) => s.live).length,
      sprites: this.sprites.filter((s) => s.live).length,
      labels: this.labels.filter((s) => s.live).length,
      capacity: {
        images: this.images.length,
        sprites: this.sprites.length,
        labels: this.labels.length,
      },
    };
  }
}
