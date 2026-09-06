import type Phaser from "phaser";

export const FARMER_HURT_MS = 260;
export const SKELETON_CONTACT_MS = 250;

/** One authored completion per actor. Impact timers remain owned by the scene. */
export class CharacterAction {
  private owner: {
    sprite: Phaser.GameObjects.Sprite;
    event: string;
    complete: () => void;
  } | null = null;

  watch(sprite: Phaser.GameObjects.Sprite, key: string, finish: () => void): void {
    this.reset();
    const owner = {
      sprite,
      event: `animationcomplete-${key}`,
      complete: (): void => {
        if (this.owner !== owner) return;
        this.owner = null;
        if (sprite.anims.currentAnim?.key === key) finish();
      },
    };
    this.owner = owner;
    sprite.once(owner.event, owner.complete);
  }

  /** Safe after DisplayList destruction and on repeated scene shutdown. */
  reset(): void {
    const owner = this.owner;
    this.owner = null;
    if (owner?.sprite.scene) owner.sprite.off(owner.event, owner.complete);
  }
}
