// Ground-truth ambient occlusion pass that also ignores objects flagged
// `userData.noAO` (blob shadows, super rings, other flat decals) when it
// renders its normal/depth pre-pass, so they neither occlude nor darken.
import type { Object3D } from "three";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";

// The pass hides points and lines around its pre-pass through these two
// members; the published typings leave them out.
declare module "three/addons/postprocessing/GTAOPass.js" {
  interface GTAOPass {
    // oxlint-disable-next-line typescript/method-signature-style -- SceneAoPass overrides this as a method, which a property signature would forbid
    _overrideVisibility(): void;
    _visibilityCache: Object3D[];
  }
}

export class SceneAoPass extends GTAOPass {
  override _overrideVisibility(): void {
    super._overrideVisibility();
    const cache = this._visibilityCache;
    this.scene.traverse((object) => {
      if (object.userData.noAO === true && object.visible) {
        object.visible = false;
        cache.push(object);
      }
    });
  }
}
