import * as THREE from "three";
import {
  compatiblePropBatch,
  InstancedProps,
  type PropBatch,
  type PropInstance,
} from "../src/world/instanced-props.ts";

type Check = (name: string, passed: boolean, detail?: string) => void;

function sourceBatch(
  items: readonly PropInstance[],
  material: THREE.Material,
  visible = true,
): THREE.BatchedMesh {
  const geometries = new Set(items.map((item) => item.geo));
  let vertices = 0;
  let indices = 0;
  for (const geometry of geometries) {
    vertices += geometry.getAttribute("position").count;
    indices += geometry.index?.count ?? 0;
  }
  const mesh = new THREE.BatchedMesh(items.length, vertices, indices, material);
  const ids = new Map<THREE.BufferGeometry, number>();
  for (const item of items) {
    let geometryId = ids.get(item.geo);
    if (geometryId === undefined) {
      geometryId = mesh.addGeometry(item.geo);
      ids.set(item.geo, geometryId);
    }
    const id = mesh.addInstance(geometryId);
    mesh.setMatrixAt(id, item.matrix);
    if (item.tint) mesh.setColorAt(id, item.tint);
    mesh.setVisibleAt(id, visible);
  }
  mesh.receiveShadow = true;
  mesh.position.set(8, 3, -5);
  mesh.rotation.y = 0.4;
  mesh.scale.set(0.8, 1.1, 1.3);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function signature(matrix: THREE.Matrix4, color: THREE.Color): string {
  return [...matrix.elements, color.r, color.g, color.b].map((v) => v.toFixed(4)).join(",");
}

function drawn(node: PropBatch): string[] {
  const rows: string[] = [];
  node.updateMatrixWorld(true);
  node.traverse((mesh) => {
    if (!(mesh instanceof THREE.InstancedMesh) && !(mesh instanceof THREE.BatchedMesh)) return;
    const count = mesh instanceof THREE.InstancedMesh ? mesh.count : mesh.instanceCount;
    for (let i = 0; i < count; i++) {
      if (mesh instanceof THREE.BatchedMesh && !mesh.getVisibleAt(i)) continue;
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      mesh.getMatrixAt(i, matrix);
      mesh.getColorAt(i, color);
      rows.push(signature(matrix.premultiply(mesh.matrixWorld), color));
    }
  });
  return rows.toSorted();
}

export function checkInstancedProps(check: Check): void {
  const box = new THREE.BoxGeometry(1, 2, 3);
  const wide = new THREE.BoxGeometry(2, 1, 1);
  const cone = new THREE.ConeGeometry(1, 2, 5);
  const material = new THREE.MeshStandardMaterial();
  const items: PropInstance[] = [box, box, box, wide, wide, cone].map((geo, id) => {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(id * 4, id * 0.3, -id * 3),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), id * 0.3),
      new THREE.Vector3(0.5 + id * 0.3, 0.8, 1.1 + id * 0.1),
    );
    return id % 2 === 0
      ? { geo, matrix, tint: new THREE.Color(0x8899bb + id * 110) }
      : { geo, matrix };
  });
  const native = sourceBatch(items, material);
  const expected = sourceBatch(items, material);
  check(
    "native multi-draw preserves the original batch",
    compatiblePropBatch(native, items, true) === native,
  );
  const casting = sourceBatch(items, material);
  casting.castShadow = true;
  check(
    "fallback preserves per-instance shadow culling",
    compatiblePropBatch(casting, items, false) === casting,
  );
  const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
  const transparent = sourceBatch(items, glass);
  check(
    "fallback preserves transparent batch sorting",
    compatiblePropBatch(transparent, items, false) === transparent,
  );
  const uniqueItems = items.filter((_, i) => i === 0 || i === 3 || i === 5);
  const unique = sourceBatch(uniqueItems, material);
  check(
    "unique geometry does not create extra scene nodes",
    compatiblePropBatch(unique, uniqueItems, false) === unique,
  );

  let sourceDisposals = 0;
  native.geometry.addEventListener("dispose", () => sourceDisposals++);
  const fallback = compatiblePropBatch(native, items, false);
  check(
    "repeated opaque props use native instancing without multi-draw",
    fallback instanceof InstancedProps &&
      fallback.children.filter((node) => node instanceof THREE.InstancedMesh).length === 2 &&
      fallback.children.filter((node) => node instanceof THREE.BatchedMesh).length === 1,
  );
  check("fallback releases replaced batch buffers", sourceDisposals === 1);
  check(
    "both paths draw identical transforms and colors",
    JSON.stringify(drawn(fallback)) === JSON.stringify(drawn(expected)),
  );
  let consistent = true;
  for (const [id, visible] of [
    [0, false],
    [1, false],
    [4, false],
    [5, false],
    [0, true],
    [2, false],
    [4, true],
    [1, true],
    [5, true],
    [2, true],
  ] satisfies readonly (readonly [number, boolean])[]) {
    fallback.setVisibleAt(id, visible);
    expected.setVisibleAt(id, visible);
    consistent &&= JSON.stringify(drawn(fallback)) === JSON.stringify(drawn(expected));
  }
  check("chunk transitions preserve stable IDs through swap compaction", consistent);
  const packed = fallback.children.find((node) => node instanceof THREE.InstancedMesh);
  if (!(packed instanceof THREE.InstancedMesh)) throw new Error("Missing instanced fixture");
  const version = packed.instanceMatrix.version;
  fallback.setVisibleAt(0, true);
  check(
    "unchanged visibility performs no GPU buffer update",
    packed.instanceMatrix.version === version,
  );
  fallback.setVisibleAt(0, false);
  check(
    "compaction marks only changed matrix and color slots",
    packed.instanceMatrix.updateRanges.every((range) => range.count === 16) &&
      (packed.instanceColor?.updateRanges.every((range) => range.count === 3) ?? false),
  );

  const hiddenSource = sourceBatch(items, material, false);
  const hidden = compatiblePropBatch(hiddenSource, items, false);
  check("imposters begin with no submitted instances", drawn(hidden).length === 0);
  check(
    "zero-active groups are excluded from the render list",
    hidden.children.every((node) => !node.visible),
  );
  hidden.setVisibleAt(0, true);
  const activeGroups = hidden.children.filter((node) => node.visible).length;
  hidden.setVisibleAt(0, false);
  hidden.setVisibleAt(5, true);
  const singletonGroups = hidden.children.filter((node) => node.visible).length;
  hidden.setVisibleAt(5, false);
  check(
    "first and last members toggle only their own render group",
    activeGroups === 1 &&
      singletonGroups === 1 &&
      hidden.children.every((node) => !node.visible) &&
      hidden.visible,
  );
  hidden.visible = false;
  hidden.setVisibleAt(0, true);
  check("instance visibility cannot override an externally hidden batch", !hidden.visible);
  hidden.setVisibleAt(0, false);
  hidden.visible = true;
  for (let i = items.length - 1; i >= 0; i--) hidden.setVisibleAt(i, true);
  const all = sourceBatch(items, material);
  check(
    "initially hidden imposters restore every original transform and color",
    JSON.stringify(drawn(hidden)) === JSON.stringify(drawn(all)),
  );
  let boundsValid = true;
  hidden.traverse((node) => {
    if (!(node instanceof THREE.InstancedMesh)) return;
    const bounds = node.boundingBox;
    const sphere = node.boundingSphere;
    for (let i = 0; i < node.count; i++) {
      const matrix = new THREE.Matrix4();
      node.getMatrixAt(i, matrix);
      const geometryBounds = node.geometry.boundingBox;
      if (!geometryBounds || !bounds || !sphere) {
        boundsValid = false;
        continue;
      }
      const transformed = geometryBounds.clone().applyMatrix4(matrix);
      boundsValid &&=
        bounds.containsBox(transformed) &&
        sphere.containsPoint(transformed.min) &&
        sphere.containsPoint(transformed.max);
    }
  });
  check("bounds contain all instances after an empty-to-visible transition", boundsValid);

  let assetDisposals = 0;
  for (const geometry of [box, wide, cone])
    geometry.addEventListener("dispose", () => assetDisposals++);
  material.addEventListener("dispose", () => assetDisposals++);
  let instanceDisposals = 0;
  hidden.traverse((node) => {
    if (node instanceof THREE.InstancedMesh)
      node.addEventListener("dispose", () => instanceDisposals++);
  });
  hidden.dispose();
  hidden.dispose();
  check(
    "fallback disposal is idempotent and preserves shared assets",
    instanceDisposals === 2 && assetDisposals === 0 && hidden.children.length === 0,
  );

  fallback.dispose();
  expected.dispose();
  casting.dispose();
  transparent.dispose();
  unique.dispose();
  all.dispose();
  box.dispose();
  wide.dispose();
  cone.dispose();
  material.dispose();
  glass.dispose();
}
