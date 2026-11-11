// The breach charge as a thing in the world: a squat case with a beacon that
// blinks faster as the fuse runs down, shown where it lies dropped or planted.
// Carried, it is invisible (the carrier's HUD says so instead).
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";

import type { StrikeforceGame } from "../core/types";
import type { Charge } from "./rules";

export class ChargeProp {
  private readonly root = new Group();
  private readonly beacon: MeshBasicMaterial;
  private beepAt = 0;

  constructor(game: StrikeforceGame) {
    const body = new Mesh(
      new BoxGeometry(0.36, 0.16, 0.26),
      new MeshStandardMaterial({ color: 0x2a_2f_33, metalness: 0.4, roughness: 0.55 }),
    );
    body.position.y = 0.08;
    body.castShadow = true;
    const strap = new Mesh(
      new BoxGeometry(0.38, 0.03, 0.06),
      new MeshStandardMaterial({ color: 0xff_b3_47 }),
    );
    strap.position.y = 0.15;
    this.beacon = new MeshBasicMaterial({ color: 0xff_3b_2a });
    const lamp = new Mesh(new SphereGeometry(0.035, 10, 8), this.beacon);
    lamp.position.set(0.1, 0.18, 0);
    this.root.add(body, strap, lamp);
    this.root.visible = false;
    this.root.name = "charge";
    game.scene.add(this.root);
  }

  /** `left`: seconds until detonation while planted. */
  update(charge: Charge, left: number, game: StrikeforceGame): void {
    const shown = charge.state === "dropped" || charge.state === "planted";
    this.root.visible = shown;
    if (!shown) {
      return;
    }
    this.root.position.set(charge.x, charge.y, charge.z);
    const planted = charge.state === "planted";
    const period = planted ? Math.max(0.12, Math.min(1, left / 40)) : 1.6;
    const { t } = game.time;
    const on = t % period < period * 0.35;
    this.beacon.color.setHex(on ? 0xff_3b_2a : 0x33_0a_08);
    if (planted && t >= this.beepAt) {
      this.beepAt = t + period;
      game.audio.play?.("ui_click", { gain: 0.9, pos: this.root.position.clone() });
    }
  }
}
