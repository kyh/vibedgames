import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const geometryCache = new Map<string, THREE.BufferGeometry>();

const cached = (key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry => {
  const hit = geometryCache.get(key);
  if (hit) {
    return hit;
  }
  const geometry = build();
  geometryCache.set(key, geometry);
  return geometry;
};

export const sphere = (radius: number, width = 16, height = 12): THREE.BufferGeometry =>
  cached(
    `sphere:${radius}:${width}:${height}`,
    () => new THREE.SphereGeometry(radius, width, height),
  );

export const cylinder = (
  top: number,
  bottom: number,
  height: number,
  sides = 12,
): THREE.BufferGeometry =>
  cached(
    `cylinder:${top}:${bottom}:${height}:${sides}`,
    () => new THREE.CylinderGeometry(top, bottom, height, sides),
  );

export const roundedBox = (width: number, height: number, depth: number): THREE.BufferGeometry =>
  cached(
    `box:${width}:${height}:${depth}`,
    () => new RoundedBoxGeometry(width, height, depth, 2, Math.min(width, height, depth) * 0.23),
  );

export const torus = (radius: number, tube: number): THREE.BufferGeometry =>
  cached(`torus:${radius}:${tube}`, () => new THREE.TorusGeometry(radius, tube, 6, 20));

export const dome = (radius: number, fraction: number): THREE.BufferGeometry =>
  cached(
    `dome:${radius}:${fraction}`,
    () => new THREE.SphereGeometry(radius, 20, 12, 0, Math.PI * 2, 0, Math.PI * fraction),
  );

export type ProfileRing = [height: number, halfWidth: number, halfDepth: number, forward: number];

/** Authored cross sections give cheeks, waists and collars their own silhouette. */
export const profile = (key: string, rings: ProfileRing[], roundness = 1): THREE.BufferGeometry =>
  cached(`profile:${key}`, () => {
    const positions: number[] = [];
    const indices: number[] = [];
    const segments = 28;
    for (const [y, width, depth, forward] of rings) {
      for (let segment = 0; segment <= segments; segment += 1) {
        const angle = (segment / segments) * Math.PI * 2;
        const x = Math.cos(angle);
        const z = Math.sin(angle);
        positions.push(
          Math.sign(x) * Math.abs(x) ** roundness * width,
          y,
          Math.sign(z) * Math.abs(z) ** roundness * depth + forward,
        );
      }
    }
    for (let ring = 0; ring < rings.length - 1; ring += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const a = ring * (segments + 1) + segment;
        const b = a + segments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const [bottom] = rings;
    const top = rings.at(-1);
    if (bottom && top) {
      const lowerCenter = positions.length / 3;
      positions.push(0, bottom[0], bottom[3], 0, top[0], top[3]);
      const lastRing = (rings.length - 1) * (segments + 1);
      for (let segment = 0; segment < segments; segment += 1) {
        indices.push(
          lowerCenter,
          segment,
          segment + 1,
          lowerCenter + 1,
          lastRing + segment + 1,
          lastRing + segment,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const welded = mergeVertices(geometry);
    welded.computeVertexNormals();
    return welded;
  });

export type SculptPoint = [x: number, y: number, z: number, radius: number];

/** A tapered, elliptical sweep: locks of hair, roots, antlers and bent hat tips. */
export const sweep = (key: string, points: SculptPoint[], flatten = 1): THREE.BufferGeometry =>
  cached(`sweep:${key}`, () => {
    const path = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    const radii = new THREE.CatmullRomCurve3(
      points.map((point, index) => new THREE.Vector3(index, point[3], 0)),
    );
    const steps = 12;
    const sides = 12;
    const frames = path.computeFrenetFrames(steps, false);
    const length = path.getLength();
    const positions: number[] = [];
    const indices: number[] = [];
    for (let step = 0; step <= steps; step += 1) {
      const u = step / steps;
      // The radius belongs to the same authored knot as the curve position.
      const t = path.getUtoTmapping(u, u * length);
      const point = path.getPoint(t);
      const radius = Math.max(0.001, radii.getPoint(t).y);
      const normal = frames.normals[step];
      const binormal = frames.binormals[step];
      if (!normal || !binormal) {
        continue;
      }
      for (let side = 0; side <= sides; side += 1) {
        const angle = (side / sides) * Math.PI * 2;
        const vertex = point
          .clone()
          .addScaledVector(normal, Math.cos(angle) * radius)
          .addScaledVector(binormal, Math.sin(angle) * radius * flatten);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
    }
    for (let step = 0; step < steps; step += 1) {
      for (let side = 0; side < sides; side += 1) {
        const a = step * (sides + 1) + side;
        const b = a + sides + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const start = path.getPoint(0);
    const end = path.getPoint(1);
    const cap = positions.length / 3;
    positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
    const lastRing = steps * (sides + 1);
    for (let side = 0; side < sides; side += 1) {
      indices.push(cap, side + 1, side, cap + 1, lastRing + side, lastRing + side + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const welded = mergeVertices(geometry);
    welded.computeVertexNormals();
    return welded;
  });

export const plate = (
  key: string,
  outline: [number, number][],
  depth: number,
  bevel = 0.025,
): THREE.BufferGeometry =>
  cached(`plate:${key}`, () => {
    const drawing = new THREE.Shape();
    for (const [index, [x, y]] of outline.entries()) {
      if (index === 0) {
        drawing.moveTo(x, y);
      } else {
        drawing.lineTo(x, y);
      }
    }
    drawing.closePath();
    return new THREE.ExtrudeGeometry(drawing, {
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 6,
      depth,
      steps: 1,
    }).translate(0, 0, -depth / 2);
  });
