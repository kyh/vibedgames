import type Phaser from "phaser";

import type { HeroDef } from "../data/heroes";
import type { Player } from "../entities/player";
import type { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";

// The scene methods a collaborator may call back into. Everything else a
// collaborator touches is a state object or another collaborator it was
// handed in its constructor.
export interface SceneHooks {
  shake: (duration: number, intensity: number) => void;
  updateHud: () => void;
  spawnPlayer: (hero: HeroDef, grid: Grid, x: number, y: number) => Player;
  playerDie: () => void;
  simStep: (dt: number) => void;
  // this frame's raw local sample (demo script or live controls)
  sampleInput: () => InputState;
  // scale every screen-pinned object sits at (1/trailer zoom; 1 in normal play)
  pinScale: () => number;
  trailerActive: () => boolean;
}

// The scene's own screen-pinned text HUD and fade plate, handed to the
// collaborators that draw on them.
export interface SceneChrome {
  heartsText: Phaser.GameObjects.Text;
  infoText: Phaser.GameObjects.Text;
  comboText: Phaser.GameObjects.Text;
  fadeRect: Phaser.GameObjects.Rectangle;
}
