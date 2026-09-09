import type Phaser from "phaser";

import type { ActorPose } from "./actor-presentation";

/** Seek an existing authored frame. Paused AnimationState prevents its render
 * clock from racing the authoritative state clock (including through hit-stop).
 * No shared animation or texture is edited, and no delayed playback is owned.
 */
export const showActorPose = (
  sprite: Phaser.GameObjects.Sprite,
  atlas: string,
  pose: ActorPose,
): void => {
  const key = `${atlas}:${pose.clip}`;
  if (sprite.anims.currentAnim?.key !== key) {
    sprite.play(key);
  }
  sprite.anims.pause();
  const frame = sprite.anims.currentAnim?.frames[pose.frame];
  if (frame && sprite.anims.currentFrame !== frame) {
    sprite.anims.setCurrentFrame(frame);
  }
};
