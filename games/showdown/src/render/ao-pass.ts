import type { Object3D } from "three";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";

declare module "three/addons/postprocessing/GTAOPass.js" {
  interface GTAOPass {
    // oxlint-disable-next-line typescript/method-signature-style -- SceneAoPass overrides this as a method, which a property signature would forbid
    _overrideVisibility(): void;
    _visibilityCache: Object3D[];
  }
}

export class SceneAoPass extends GTAOPass {
  override _overrideVisibility() {
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
