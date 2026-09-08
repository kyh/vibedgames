import Phaser from "phaser";

type Landmark = {
  readonly at: number;
  readonly width: number;
  readonly image: Phaser.GameObjects.Image;
  readonly offset: number;
  readonly height: number;
};

const REPEAT_DISTANCE = 6400;
const PARALLAX = 0.45;

/** Seven complete tree silhouettes, behind every obstacle. No gameplay state or RNG. */
export class ForestLandmarks {
  private readonly trees: Landmark[] = [];

  constructor(scene: Phaser.Scene) {
    // Varied tree groups repeat well behind the course.
    for (const [at, offset, height, foreground] of [
      [900, -120, 410, true],
      [900, 120, 350, true],
      [2900, 0, 540, true],
      [2900, 210, 330, false],
      [4800, -150, 340, false],
      [4800, 0, 420, true],
      [4800, 150, 300, true],
    ] satisfies readonly (readonly [number, number, number, boolean])[]) {
      const image = scene.add
        .image(0, 0, "landmark-tree")
        .setOrigin(0.5, 1)
        .setDepth(-10)
        .setAlpha(foreground ? 0.48 : 0.3);
      this.trees.push({ at, offset, height, width: (height * image.width) / image.height, image });
    }
    // Phaser owns the display objects and destroys them before these external hooks.
    const release = (): void => {
      scene.events.off(Phaser.Scenes.Events.SHUTDOWN, release);
      scene.events.off(Phaser.Scenes.Events.DESTROY, release);
      this.trees.length = 0;
    };
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, release);
    scene.events.once(Phaser.Scenes.Events.DESTROY, release);
  }

  update(
    worldX: number,
    view: { readonly width: number; readonly top: number; readonly floor: number },
  ): void {
    const heightScale = (view.floor - view.top) / 720;
    for (const tree of this.trees) {
      const halfWidth = (tree.width * heightScale) / 2;
      const exitX = (halfWidth + tree.offset * heightScale) / PARALLAX;
      const cycle = Math.ceil((worldX - exitX - tree.at) / REPEAT_DISTANCE);
      const x = (tree.at + cycle * REPEAT_DISTANCE - worldX) * PARALLAX + tree.offset * heightScale;
      tree.image
        .setPosition(x, view.floor)
        .setScale((tree.height * heightScale) / tree.image.height)
        .setVisible(x + halfWidth >= 0 && x - halfWidth <= view.width);
    }
  }
}
