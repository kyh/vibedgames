import type Phaser from "phaser";

import type { HeroDef } from "../data/heroes";
import type { Player } from "../entities/player";
import type { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";

export interface SceneHooks {
  shake: (duration: number, intensity: number) => void;
  updateHud: () => void;
  spawnPlayer: (hero: HeroDef, grid: Grid, x: number, y: number) => Player;
  playerDie: () => void;
  simStep: (dt: number) => void;
  sampleInput: () => InputState;
  pinScale: () => number;
  trailerActive: () => boolean;
}

export interface SceneChrome {
  heartsText: Phaser.GameObjects.Text;
  infoText: Phaser.GameObjects.Text;
  comboText: Phaser.GameObjects.Text;
  fadeRect: Phaser.GameObjects.Rectangle;
}
