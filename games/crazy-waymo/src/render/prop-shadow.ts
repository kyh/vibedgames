import type * as THREE from "three";

export type PropShadowPolicy = "none" | "multi-draw";
const policies = new WeakMap<THREE.Material, PropShadowPolicy>();

/** Explicit authoring policy, independent of color, size or landmark placement. */
export function disablePropShadows(material: THREE.Material): void {
  setPropShadowPolicy(material, "none");
}

export function setPropShadowPolicy(material: THREE.Material, policy: PropShadowPolicy): void {
  policies.set(material, policy);
}

/** Serialize author intent, never the capabilities of the machine baking it. */
export function propShadowPolicy(material: THREE.Material): PropShadowPolicy | undefined {
  return policies.get(material);
}

export function propShadowsDisabled(material: THREE.Material, multiDraw: boolean): boolean {
  const policy = policies.get(material);
  return policy === "none" || (policy === "multi-draw" && !multiDraw);
}
