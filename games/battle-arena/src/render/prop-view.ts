import * as THREE from "three";
import type { PropSpec } from "../data/props";
import { terrainHeight } from "../data/terrain";
import type { Unit } from "../sim/types";
import type { Fx } from "./fx";
import { cloneMats } from "./instance-mats";
import type { ModelLibrary } from "./models";

/** A destructible prop (barrel/crate/keg): the sim unit is authoritative for
 *  alive/hp; this shows the model, a hit flash + squash bounce, and hides the
 *  body on break (the shatter itself is the propBreak fx event). */
export class PropView {
  readonly group = new THREE.Group();
  private mats: THREE.MeshStandardMaterial[];
  private baseScale: number;
  private wasAlive = true;
  private squash = 0;
  private lastHitShown = -1;

  constructor(scene: THREE.Scene, lib: ModelLibrary, u: Unit, spec: PropSpec | undefined) {
    const inst = lib.instance(spec?.model ?? u.champId);
    this.group.add(inst);
    this.mats = cloneMats(inst, null);
    this.baseScale = spec?.scale ?? 1;
    this.group.position.set(u.x, terrainHeight(u.x, u.y), u.y);
    this.group.rotation.y = spec?.rot ?? 0;
    this.group.scale.setScalar(this.baseScale);
    scene.add(this.group);
  }

  update(u: Unit, now: number, dt: number, fx: Fx | null): void {
    if (!this.wasAlive && u.alive) {
      // respawn pop
      fx?.dust(u.x, u.y, 4);
    }
    this.wasAlive = u.alive;
    this.group.visible = u.alive;
    if (!u.alive) {
      return;
    }
    if (u.lastHitAt !== this.lastHitShown) {
      this.lastHitShown = u.lastHitAt;
      if (now - u.lastHitAt < 150) {
        this.squash = 1;
      }
    }
    this.squash *= Math.max(0, 1 - 8 * dt);
    const bs = this.baseScale;
    this.group.scale.set(
      bs * (1 + 0.1 * this.squash),
      bs * (1 - 0.16 * this.squash),
      bs * (1 + 0.1 * this.squash),
    );
    const flash = Math.max(0, 1 - (now - u.lastHitAt) / 110);
    for (const m of this.mats) {
      m.emissive.setRGB(flash, flash * 0.85, flash * 0.6);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const m of this.mats) {
      m.dispose();
    }
  }
}
