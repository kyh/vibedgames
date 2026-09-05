import * as THREE from "three";

import { ModelCache } from "../src/assets/loader.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

/** Cached source identity is the contract shared by live and baked trees. */
export async function checkTreeTemplates(check: Check): Promise<void> {
  const cache = new ModelCache();
  const templates = [
    { url: "/models/props/tree-large.glb", height: 0.7669999599456787 },
    { url: "/models/props/tree-small.glb", height: 0.5670000314712524 },
  ];
  for (const template of templates) {
    await cache.ensure(template.url);
    const mesh = cache.srcMesh(template.url, 0);
    check(
      `tree template retains one baked mesh index: ${template.url}`,
      mesh !== null && cache.srcMesh(template.url, 1) === null,
    );
    if (!mesh) continue;
    const bounds = cache.bounds(template.url);
    check(
      `tree template retains source ground and height: ${template.url}`,
      Math.abs(bounds.min.y) < 1e-7 && Math.abs(bounds.size.y - template.height) < 1e-6,
    );
    const triangles = (mesh.geometry.getIndex()?.count ?? 0) / 3;
    check(
      `tree template stays under 560 triangles: ${template.url}`,
      triangles > 0 && triangles <= 560,
      `${triangles} triangles`,
    );
    const first = cache.instance(template.url).children[0];
    const second = cache.instance(template.url).children[0];
    check(
      `tree instances share geometry and material: ${template.url}`,
      first instanceof THREE.Mesh &&
        second instanceof THREE.Mesh &&
        first.geometry === second.geometry &&
        first.material === second.material,
    );
    const material = mesh.material;
    check(
      `tree material has a restorable source: ${template.url}`,
      !Array.isArray(material) && cache.srcOfMaterial(material) !== null,
    );
  }
}
