import * as THREE from "three";

/** City geometry has fixed world transforms after loading. Editor roots remain
 * live. Streamed children compose their world matrices at attachment, before
 * adopting the same frozen flags (see ParcelStreamer.install).
 *
 * The root and its ancestors must stay fixed once sealed, just as with the
 * city's previous per-object freeze. Instance visibility and shader uniforms
 * remain live. Clones start unsealed; traversal state is never copied. */
export class StaticWorldGroup extends THREE.Group {
  private sealed = false;

  seal(): void {
    if (this.sealed) return;
    this.updateMatrixWorld(true);
    this.traverse((object) => {
      object.matrixAutoUpdate = false;
      object.matrixWorldAutoUpdate = false;
    });
    this.sealed = true;
  }

  override updateMatrixWorld(force?: boolean): void {
    // Three still recurses with both matrix auto-update flags disabled.
    // The live scene also forces children each frame; this boundary stops it.
    if (!this.sealed) super.updateMatrixWorld(force);
  }
}
