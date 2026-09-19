import type * as THREE from "three";

export type PropShadowPolicy = "none" | "multi-draw";
const policies = new WeakMap<THREE.Material, PropShadowPolicy>();

export const setPropShadowPolicy = (material: THREE.Material, policy: PropShadowPolicy): void => {
  policies.set(material, policy);
};

/** Explicit authoring policy, independent of color, size or landmark placement. */
export const disablePropShadows = (material: THREE.Material): void => {
  setPropShadowPolicy(material, "none");
};

/** Serialize author intent, never the capabilities of the machine baking it. */
export const propShadowPolicy = (material: THREE.Material): PropShadowPolicy | undefined =>
  policies.get(material);

export const propShadowsDisabled = (material: THREE.Material, multiDraw: boolean): boolean => {
  const policy = policies.get(material);
  return policy === "none" || (policy === "multi-draw" && !multiDraw);
};
