import * as THREE from "three";

/** `instanceof THREE.Mesh` narrows to `Mesh<any, any, any>`; this keeps three's default geometry and material types. */
export const isMesh = (o: THREE.Object3D): o is THREE.Mesh => o instanceof THREE.Mesh;
