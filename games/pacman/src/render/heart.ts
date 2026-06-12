import * as THREE from "three";

// Plump extruded heart, built from the classic three.js bezier heart shape,
// centered at the origin, point-down, facing +z, ~1 world unit tall before
// scaling. Shared by the power pellets and the heart-burst particles.

export function buildHeartGeometry(size: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(2.5, 2.5);
  shape.bezierCurveTo(2.5, 2.5, 2, 0, 0, 0);
  shape.bezierCurveTo(-3, 0, -3, 3.5, -3, 3.5);
  shape.bezierCurveTo(-3, 5.5, -1, 7.7, 2.5, 9.5);
  shape.bezierCurveTo(6, 7.7, 8, 5.5, 8, 3.5);
  shape.bezierCurveTo(8, 3.5, 8, 0, 5, 0);
  shape.bezierCurveTo(3.5, 0, 2.5, 2.5, 2.5, 2.5);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 2.4,
    bevelEnabled: true,
    bevelThickness: 0.9,
    bevelSize: 0.9,
    bevelSegments: 3,
    curveSegments: 12,
  });
  // The bezier shape is drawn point-up in a y-down frame — flip it, then
  // normalize to `size` world units tall.
  geo.rotateZ(Math.PI);
  geo.center();
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const height = box === null ? 1 : box.max.y - box.min.y;
  const s = size / height;
  geo.scale(s, s, s);
  return geo;
}
