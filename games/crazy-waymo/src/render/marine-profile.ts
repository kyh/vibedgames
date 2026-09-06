import { WORLD_H, WORLD_W } from "../shared/constants";

/** Fixed coastal weather volume, shared by surface fog and the sky bank. */
const MARINE = {
  top: 66,
  softBase: 22,
  near: 26,
  nearFull: 80,
  extinction: 0.0044,
  maxOpacity: 0.84,
  westFull: (0.1 - 0.5) * WORLD_W,
  westNone: (0.4 - 0.5) * WORLD_W,
  gateX: (0.27 - 0.5) * WORLD_W,
  gateZ: (0.035 - 0.5) * WORLD_H,
  gateRx: 560,
  gateRz: 340,
  bayX: (0.46 - 0.5) * WORLD_W,
  bayZ: (0.06 - 0.5) * WORLD_H,
  bayRx: 590,
  bayRz: 290,
};

export type FogPoint = { readonly x: number; readonly y: number; readonly z: number };

const smooth = (a: number, b: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function ellipse(x: number, z: number, cx: number, cz: number, rx: number, rz: number) {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return 1 - smooth(0.02, 1.1, dx * dx + dz * dz);
}

/** Density has no hard footprint edge. Gate towers emerge above the low bank. */
export function marineDensity(x: number, y: number, z: number): number {
  const gate = ellipse(x, z, MARINE.gateX, MARINE.gateZ, MARINE.gateRx, MARINE.gateRz);
  const bay = ellipse(x, z, MARINE.bayX, MARINE.bayZ, MARINE.bayRx, MARINE.bayRz);
  const west = 1 - smooth(MARINE.westFull, MARINE.westNone, x);
  const coverage = Math.max(gate * 0.92, bay * 0.48, west * 0.82);
  const westTop = 48 + 18 * west;
  const top = westTop + (36 - westTop) * gate;
  return coverage * (1 - smooth(MARINE.softBase, top, y));
}

/**
 * Two-point quadrature over only the ray below the bank lid. Unlike endpoint
 * fog this also veils a clear building seen THROUGH coastal air. The near
 * exclusion is a gameplay contract: the car and first road markings stay clear.
 */
export function marineOpacity(camera: FogPoint, target: FogPoint): number {
  const dx = target.x - camera.x;
  const dy = target.y - camera.y;
  const dz = target.z - camera.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= MARINE.near) return 0;
  let start = MARINE.near / distance;
  let end = 1;
  if (Math.abs(dy) < 0.0001) {
    if (camera.y >= MARINE.top) return 0;
  } else {
    const crossing = (MARINE.top - camera.y) / dy;
    if (dy > 0) end = Math.min(end, crossing);
    else start = Math.max(start, crossing);
  }
  const span = Math.max(0, end - start);
  if (span === 0) return 0;
  // Keep the first interval local on long sky rays. Uniform samples across
  // several kilometres can both skip the bank surrounding the camera.
  const firstSpan = Math.min(220 / distance, span * 0.5);
  const a = start + firstSpan * 0.5;
  const b = start + firstSpan + (span - firstSpan) * 0.5;
  const optical =
    (marineDensity(camera.x + dx * a, camera.y + dy * a, camera.z + dz * a) * firstSpan +
      marineDensity(camera.x + dx * b, camera.y + dy * b, camera.z + dz * b) * (span - firstSpan)) *
    distance *
    MARINE.extinction;
  return Math.min(
    MARINE.maxOpacity,
    (1 - Math.exp(-optical)) * smooth(MARINE.near, MARINE.nearFull, distance),
  );
}

const f = (n: number): string => n.toFixed(6);

/** No texture reads, loops, noise or uniforms beyond built-in cameraPosition. */
export const MARINE_GLSL = /* glsl */ `
float sfMarineEllipse(vec2 p, vec2 c, vec2 radius) {
  vec2 q = (p - c) / radius;
  return 1.0 - smoothstep(0.02, 1.1, dot(q, q));
}
float sfMarineDensity(vec3 p) {
  float gate = sfMarineEllipse(p.xz, vec2(${f(MARINE.gateX)}, ${f(MARINE.gateZ)}), vec2(${f(MARINE.gateRx)}, ${f(MARINE.gateRz)}));
  float bay = sfMarineEllipse(p.xz, vec2(${f(MARINE.bayX)}, ${f(MARINE.bayZ)}), vec2(${f(MARINE.bayRx)}, ${f(MARINE.bayRz)}));
  float west = 1.0 - smoothstep(${f(MARINE.westFull)}, ${f(MARINE.westNone)}, p.x);
  float coverage = max(max(gate * 0.92, bay * 0.48), west * 0.82);
  float top = mix(48.0 + 18.0 * west, 36.0, gate);
  return coverage * (1.0 - smoothstep(${f(MARINE.softBase)}, top, p.y));
}
float sfMarineOpacity(vec3 camera, vec3 target) {
  vec3 ray = target - camera;
  float distance = length(ray);
  if (distance <= ${f(MARINE.near)}) return 0.0;
  float start = ${f(MARINE.near)} / distance;
  float end = 1.0;
  if (abs(ray.y) < 0.0001) {
    if (camera.y >= ${f(MARINE.top)}) return 0.0;
  } else {
    float crossing = (${f(MARINE.top)} - camera.y) / ray.y;
    if (ray.y > 0.0) end = min(end, crossing);
    else start = max(start, crossing);
  }
  float span = max(0.0, end - start);
  if (span <= 0.0) return 0.0;
  float firstSpan = min(220.0 / distance, span * 0.5);
  vec3 a = camera + ray * (start + firstSpan * 0.5);
  vec3 b = camera + ray * (start + firstSpan + (span - firstSpan) * 0.5);
  float optical = (sfMarineDensity(a) * firstSpan + sfMarineDensity(b) * (span - firstSpan)) * distance * ${f(MARINE.extinction)};
  return min(${f(MARINE.maxOpacity)}, (1.0 - exp(-optical)) * smoothstep(${f(MARINE.near)}, ${f(MARINE.nearFull)}, distance));
}
`;

// A fog tint, never an emissive floor. This stays blue at night and warms with
// sunset; neutral daylight lift vanishes with the source fog's luminance.
export const MARINE_COLOR_GLSL = /* glsl */ `
vec3 sfMarineColor(vec3 color) {
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return mix(color, vec3(lum), 0.76) * (1.0 + 0.5 * lum);
}
`;
