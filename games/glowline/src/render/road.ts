// The road: a lit asphalt ribbon whose shader also draws the markings, the
// kerbs, the start grid and — sampled by world position — everyone's paint.
// Paint is a material here, not a decal: glossy where the asphalt is rough,
// emissive, with a darker wet rim at the edge of every stroke.

import * as THREE from "three";

import { TRACK_STEP } from "../shared/constants";
import { pointAt, wrapIndex } from "../sim/track";
import type { Track } from "../sim/track";
import type { PaintLayer } from "./paint-layer";
import type { SurfaceMaps } from "./textures";

/** Share of the road ribbon's half width that is drivable; the rest is kerb. */
export const KERB_INSET = 0.9;
/** World units one repeat of a tiling surface covers. */
const TILE = 9;

/** Smooth value noise in world space: it never repeats, so it never stripes. */
const NOISE = `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
`;

const DECLARE_VERTEX = `
  attribute vec2 aRoad;
  varying vec2 vRoad;
  varying vec3 vWorldP;
`;
const SET_VERTEX = `
  vRoad = aRoad;
  vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const DECLARE_FRAGMENT = `
  uniform sampler2D uPaint;
  uniform sampler2D uPaintMask;
  uniform float uSpan;
  uniform float uLap;
  uniform vec3 uKerbA;
  uniform vec3 uKerbB;
  varying vec2 vRoad;
  varying vec3 vWorldP;
  float gCover;
  vec3 gPigment;
  float gWear;
  vec3 gSpill;

  ${NOISE}
`;
const SURFACE_FRAGMENT = `
  {
    float across = abs(vRoad.x);
    float along = vRoad.y;
    vec3 line = vec3(0.86, 0.86, 0.82);

    // Patches of newer and older tar, and the dark rubbered-in racing line.
    float tar = vnoise(vWorldP.xz * 0.07) * 0.6 + vnoise(vWorldP.xz * 0.23) * 0.4;
    gWear = vnoise(vWorldP.xz * 0.045 + 31.0);
    diffuseColor.rgb *= 0.8 + 0.34 * tar;
    float rubber = exp(-(vRoad.x / 0.42) * (vRoad.x / 0.42)) * (0.35 + 0.65 * vnoise(vec2(along * 0.05, 3.0)));
    diffuseColor.rgb *= 1.0 - 0.3 * rubber;
    // Skid marks: thin dark pairs that come and go along the lap.
    float skid = smoothstep(0.62, 0.8, vnoise(vec2(along * 0.035, 9.0)));
    float lane = (vnoise(vec2(along * 0.012, 17.0)) - 0.5) * 1.3;
    float left = (vRoad.x - lane - 0.09) / 0.022;
    float right = (vRoad.x - lane + 0.09) / 0.022;
    float tyre = exp(-left * left) + exp(-right * right);
    diffuseColor.rgb *= 1.0 - 0.55 * skid * clamp(tyre, 0.0, 1.0);

    // Solid edge lines and a dashed centre line, a little worn.
    float wear = 0.55 + 0.45 * diffuseColor.r / max(diffuseColor.r + 0.05, 0.001);
    float edge = smoothstep(0.855, 0.862, across) * (1.0 - smoothstep(0.878, 0.885, across));
    float dash = (1.0 - smoothstep(0.012, 0.018, across)) * step(0.45, fract(along / 9.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, line * wear, (edge + dash) * 0.82);

    // Start grid: staggered slot brackets behind the line.
    float back = uLap - along;
    if (back > 3.0 && back < 46.0) {
      float row = fract((back - 3.5) / 5.0);
      float lane = step(0.12, across) * (1.0 - step(0.72, across));
      float bar = (1.0 - step(0.05, row)) * lane;
      float side = lane * (1.0 - step(0.3, row)) * (step(0.69, across) + (1.0 - step(0.15, across)));
      diffuseColor.rgb = mix(diffuseColor.rgb, line * wear, clamp(bar + side, 0.0, 1.0) * 0.8);
    }

    // The line itself: three rows of checks.
    float fromLine = min(along, uLap - along);
    if (fromLine < 1.8 && across < 0.86) {
      float check = mod(floor(vRoad.x * 9.0) + floor(along / 0.6), 2.0);
      diffuseColor.rgb = vec3(check * 0.8 + 0.04);
    }

    // Kerbs: raised-looking blocks in two colours with a dark joint between.
    float kerb = smoothstep(${KERB_INSET.toFixed(3)}, ${(KERB_INSET + 0.006).toFixed(3)}, across);
    float block = fract(along / 3.2);
    vec3 kerbCol = mix(uKerbA, uKerbB, step(0.5, fract(along / 6.4)));
    kerbCol *= 0.78 + 0.22 * smoothstep(0.0, 0.08, block) * (1.0 - smoothstep(0.92, 1.0, block));
    diffuseColor.rgb = mix(diffuseColor.rgb, kerbCol * (0.7 + 0.3 * wear), kerb);

    // Paint. Thresholding the blurred coverage gives round-edged strokes.
    // Colour is nearest-sampled (hard lines between drivers); coverage is
    // bilinear and thresholded, which rounds the cells into brushed edges.
    // Wobble the lookup by a fraction of a metre: edges follow the noise, not the grid.
    vec2 wobble = vec2(vnoise(vWorldP.xz * 1.3), vnoise(vWorldP.zx * 1.3 + 7.0)) - 0.5;
    vec2 paintUv = (vWorldP.xz + wobble * 0.55) / uSpan + 0.5;
    float cover = texture2D(uPaintMask, paintUv).r;
    // A little noise on the threshold breaks the edge up like a dry brush.
    float fray = (texture2D(map, vMapUv * 3.0).r - 0.2) * 0.5;
    gCover = smoothstep(0.42, 0.5, cover + fray * 0.18) * (1.0 - kerb);
    gPigment = texture2D(uPaint, paintUv).rgb;
    // Paint throws its colour onto the kerb beside it: look a metre around
    // for the brightest stroke and let the kerb glow with it.
    gSpill = vec3(0.0);
    if (kerb > 0.5) {
      for (int i = 0; i < 4; i++) {
        vec2 off = (i == 0 ? vec2(1.3, 0.0) : i == 1 ? vec2(-1.3, 0.0) : i == 2 ? vec2(0.0, 1.3) : vec2(0.0, -1.3)) / uSpan;
        float nearby = smoothstep(0.3, 0.7, texture2D(uPaintMask, paintUv + off).r);
        gSpill = max(gSpill, texture2D(uPaint, paintUv + off).rgb * nearby);
      }
    }
    // Thicker in the middle of a stroke, thin and darker towards its edge.
    float body = smoothstep(0.45, 0.95, cover);
    // A wet film has ripples of its own: break the flat colour up a little.
    float film = 0.9 + 0.2 * vnoise(vWorldP.xz * 1.7);
    diffuseColor.rgb = mix(diffuseColor.rgb, gPigment * (0.5 + 0.3 * body) * film, gCover);
  }
`;
const ROUGH_FRAGMENT = `
  // Worn stretches are a little polished; paint is wet.
  roughnessFactor *= 0.82 + 0.18 * gWear;
  roughnessFactor = mix(roughnessFactor, 0.36, gCover);
`;
const EMISSIVE_FRAGMENT = `
  totalEmissiveRadiance += gPigment * gPigment * gCover * 0.55 + gSpill * 0.4;
`;

export const roadMaterial = (
  track: Track,
  paint: PaintLayer,
  maps: SurfaceMaps,
  kerbA: THREE.Color,
  kerbB: THREE.Color,
): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    ...maps,
    metalness: 0,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 1,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uKerbA: { value: kerbA },
      uKerbB: { value: kerbB },
      uLap: { value: track.n * TRACK_STEP },
      uPaint: { value: paint.color },
      uPaintMask: { value: paint.mask },
      uSpan: { value: paint.span },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${DECLARE_VERTEX}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SET_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${DECLARE_FRAGMENT}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${SURFACE_FRAGMENT}`)
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>\n${ROUGH_FRAGMENT}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${EMISSIVE_FRAGMENT}`,
      );
  };
  return material;
};

/**
 * A flat ribbon following the track between lateral offsets `latA` and `latB`
 * at height `y`. `uv` tiles in world units; `aRoad` is (-1 … 1 across, distance
 * along the lap) for the road shader.
 *
 * The ribbon is cut into columns across its width so that no triangle is a
 * sliver: a road-wide quad one metre long interpolates badly at a distance,
 * and shows as a light and a dark triangle.
 */
export const ribbon = (
  track: Track,
  latA: number,
  latB: number,
  y: number,
): THREE.BufferGeometry => {
  const { n } = track;
  const columns = Math.max(1, Math.round(Math.abs(latB - latA) / 2.6));
  const across = columns + 1;
  const count = (n + 1) * across;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const road = new Float32Array(count * 2);
  const indices: number[] = [];
  for (let k = 0; k <= n; k += 1) {
    const i = wrapIndex(k, n);
    for (let c = 0; c < across; c += 1) {
      const share = c / columns;
      const lat = latA + (latB - latA) * share;
      const p = pointAt(track, i, lat);
      const v = k * across + c;
      positions.set([p.x, y, p.z], v * 3);
      normals.set([0, 1, 0], v * 3);
      uvs.set([lat / TILE, (k * TRACK_STEP) / TILE], v * 2);
      road.set([share * 2 - 1, k * TRACK_STEP], v * 2);
      if (k < n && c < columns) {
        const next = v + across;
        // Wind so the face points up whichever way round the two edges were given.
        if (latA < latB) {
          indices.push(v, v + 1, next, v + 1, next + 1, next);
        } else {
          indices.push(v, next, v + 1, v + 1, next, next + 1);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("aRoad", new THREE.BufferAttribute(road, 2));
  geometry.setIndex(indices);
  return geometry;
};

/**
 * Let a material beside the road catch the colour of paint near it. Used on
 * the barriers: a stroke along the rail tints the blocks next to it, strongest
 * at their base.
 */
export const catchPaint = (material: THREE.MeshStandardMaterial, paint: PaintLayer): void => {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uPaint: { value: paint.color },
      uPaintMask: { value: paint.mask },
      uSpan: { value: paint.span },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCatchP;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vCatchP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vCatchP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uPaint;
        uniform sampler2D uPaintMask;
        uniform float uSpan;
        varying vec3 vCatchP;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          vec2 uv = vCatchP.xz / uSpan + 0.5;
          vec3 glow = vec3(0.0);
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7854;
            vec2 at = uv + vec2(cos(a), sin(a)) * (i < 4 ? 2.0 : 3.6) / uSpan;
            float near = smoothstep(0.3, 0.7, texture2D(uPaintMask, at).r);
            glow = max(glow, texture2D(uPaint, at).rgb * near * (i < 4 ? 1.0 : 0.6));
          }
          // Strongest low down, where the block faces the road surface.
          totalEmissiveRadiance += glow * glow * 0.55 * (1.0 - smoothstep(0.1, 1.3, vCatchP.y));
        }`,
      );
  };
};

/**
 * Mottle a ground material in world space: patches of lighter and darker tone
 * at two scales, so no stretch of grass or paving is one flat colour. `depth`
 * is how far the tone swings; `scale` is patches per metre.
 */
export const mottle = (
  material: THREE.MeshStandardMaterial,
  depth: number,
  scale: number,
): void => {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMottleP;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvMottleP = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vMottleP;\n${NOISE}`)
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          vec2 p = vMottleP.xz * ${scale.toFixed(4)};
          float tone = vnoise(p) * 0.55 + vnoise(p * 3.7 + 11.0) * 0.3 + vnoise(p * 13.0 + 5.0) * 0.15;
          diffuseColor.rgb *= 1.0 + (tone - 0.5) * ${(depth * 2).toFixed(3)};
          // Drier, yellower where the tone runs light.
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.05, 0.8), smoothstep(0.55, 0.8, tone) * ${depth.toFixed(3)});
        }`,
      );
  };
};
