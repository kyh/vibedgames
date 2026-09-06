import type Phaser from "phaser";

/** Release external owners on either exit path, once per scene visit. */
export function onSceneExit(scene: Phaser.Scene, release: () => void): void {
  const events = scene.events;
  const finish = (): void => {
    events.off("shutdown", finish);
    events.off("destroy", finish);
    release();
  };
  events.once("shutdown", finish);
  events.once("destroy", finish);
}
