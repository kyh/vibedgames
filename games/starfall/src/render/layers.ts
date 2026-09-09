import type { Inset } from "@vibedgames/gamepad/phaser";
import { BlendModes } from "phaser";
import type Phaser from "phaser";
import { BattleBackdrop } from "./battle-backdrop";
import { EdgePips } from "./edge-pips";

/** The shared draw surfaces: one pooled Graphics per entity class, redrawn
 *  every frame by the view/hud collaborators (zero per-entity objects), plus
 *  the screen-space flash + minimap the scene keeps counter-rotated. */
export interface Layers {
  battleBackdrop: BattleBackdrop;
  beamGfx: Phaser.GameObjects.Graphics;
  shardGfx: Phaser.GameObjects.Graphics;
  enemyShotGfx: Phaser.GameObjects.Graphics;
  telegraphGfx: Phaser.GameObjects.Graphics;
  beaconGfx: Phaser.GameObjects.Graphics;
  edgePips: EdgePips;
  haloGfx: Phaser.GameObjects.Graphics;
  muzzleGfx: Phaser.GameObjects.Graphics;
  splinterGfx: Phaser.GameObjects.Graphics;
  minimapGfx: Phaser.GameObjects.Graphics;
  flashRect: Phaser.GameObjects.Rectangle;
  /** Device safe-area insets (home indicator/notch), re-read on resize; keeps
   *  the canvas-drawn minimap off the home indicator. */
  safeInset: Inset;
}

export const createLayers = (scene: Phaser.Scene): Layers => ({
  battleBackdrop: new BattleBackdrop(scene),
  // Beacon ring under ships (a zone on the floor), pips above everything
  // world-space (they're viewport furniture, still below the DOM HUD).
  beaconGfx: scene.add.graphics().setDepth(5).setBlendMode(BlendModes.ADD),
  beamGfx: scene.add.graphics().setDepth(12),
  edgePips: new EdgePips(scene, 40),
  enemyShotGfx: scene.add.graphics().setDepth(12),
  flashRect: scene.add
    .rectangle(0, 0, 4, 4, 0xff_ff_ff)
    .setOrigin(0)
    .setScrollFactor(0)
    .setDepth(90)
    .setAlpha(0),
  haloGfx: scene.add.graphics().setDepth(11).setBlendMode(BlendModes.ADD),
  minimapGfx: scene.add.graphics().setScrollFactor(0).setDepth(100),
  muzzleGfx: scene.add.graphics().setDepth(19).setBlendMode(BlendModes.ADD),
  safeInset: { bottom: 0, left: 0, right: 0, top: 0 },
  // Shards: one pooled Graphics redrawn per frame (zero per-shard objects).
  shardGfx: scene.add.graphics().setDepth(4).setBlendMode(BlendModes.ADD),
  splinterGfx: scene.add.graphics().setDepth(15),
  telegraphGfx: scene.add.graphics().setDepth(13).setBlendMode(BlendModes.ADD),
});
