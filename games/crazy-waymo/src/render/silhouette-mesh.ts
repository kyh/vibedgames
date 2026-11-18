import * as THREE from "three";

import { DETAIL_DISTANCE } from "../world/city";
import type { SilhouetteBar } from "../world/golden-gate";
import { HAZE_AMOUNT, HAZE_BASE, HAZE_SCALE } from "./aerial-fog";
import { liveQuality } from "./quality";

const LM_HOLD = DETAIL_DISTANCE;
const LM_FULL = 760;
const growRange: (scale: number) => [number, number] = (scale) => [
  LM_HOLD * scale,
  LM_FULL * scale,
];
const LM_MIN_HALF_NDC = 0.0075;
const LM_MAX_HALF = 6.5;
const LM_MAX_HAZE = 0.045;
const LM_SHELL = 1700;
const LM_PUSH = 2.6;
const LM_TINT = 0xd6_51_2e;
const LM_GAIN = 0.72;

const LM_VERT = `
  attribute vec3 aOther;
  // x = side, y = half-thickness here, z = +1 at a / -1 at b, w = min-width share
  attribute vec4 aEdge;
  uniform vec2 uGrow;
  uniform float uMinHalf;
  uniform float uShell;
  uniform vec2 uFogRange;
  uniform vec3 uFog;
  uniform vec3 uTint;
  uniform float uNight;
  varying vec3 vColor;
  void main() {
    vec3 toCam = cameraPosition - position;
    float dist = max( length( toCam ), 1.0 );
    vec3 view = toCam / dist;
    // The bar runs a -> b whichever end this vertex sits at, so both ends
    // offset to the SAME side of it (they bow-tie otherwise).
    vec3 dir = normalize( aOther - position ) * aEdge.z;
    vec3 side = cross( dir, view );
    float sl = length( side );
    side = sl > 1e-3 ? side / sl : vec3( 0.0, 1.0, 0.0 );
    // Screen-space floor on the thickness. projectionMatrix[1][1] is
    // 1/tan(fovY/2), so this is an angular size and survives any FOV.
    float grow = smoothstep( uGrow.x, uGrow.y, dist );
    float minHalf = min(
      uMinHalf * aEdge.w * dist / projectionMatrix[1][1],
      ${LM_MAX_HALF.toFixed(2)} * aEdge.w );
    // ('half' is a reserved word in GLSL — hw it is.)
    float hw = max( aEdge.y, minHalf * grow );
    // ...and the ends run on by their own width, so a thickened chain of them
    // has no daylight at the joints.
    vec3 world = position + side * ( aEdge.x * hw ) - dir * ( aEdge.z * hw );
    world += view * ( grow * max( ${LM_PUSH.toFixed(2)}, hw ) );
    vec3 rel = world - cameraPosition;
    float d3 = max( length( rel ), 1.0 );
    gl_Position = projectionMatrix * viewMatrix
      * vec4( cameraPosition + rel * min( 1.0, uShell / d3 ), 1.0 );
    // The scene's own aerial perspective, with a ceiling on it.
    float f = smoothstep( uFogRange.x, uFogRange.y, dist );
    float fragHaze = exp( - max( 0.0, world.y - ${HAZE_BASE.toFixed(2)} ) / ${HAZE_SCALE.toFixed(2)} );
    float camHaze = exp( - max( 0.0, cameraPosition.y - ${HAZE_BASE.toFixed(2)} ) / ${HAZE_SCALE.toFixed(2)} );
    f *= mix( 1.0, sqrt( fragHaze * camHaze ), ${HAZE_AMOUNT.toFixed(2)} );
    vColor = mix( uTint * ( 1.0 - 0.82 * uNight ), uFog, min( f, ${LM_MAX_HAZE.toFixed(2)} ) );
  }
`;

const LM_FRAG = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

/**
 * The long-range stand-in for one landmark: a set of camera-facing ribbons that
 * hold a minimum screen width. Drawn as ordinary opaque geometry so the world
 * in front of it occludes it correctly, but with no depth WRITE — a stand-in
 * should never own the depth buffer.
 */
export class SilhouetteMesh {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly uFog = { value: new THREE.Color(0xbf_dc_f2) };
  private readonly uTint = { value: new THREE.Color(LM_TINT).multiplyScalar(LM_GAIN) };
  private readonly uNight = { value: 0 };
  private readonly uFogRange = { value: new THREE.Vector2(400, 950) };
  private readonly uGrow = { value: new THREE.Vector2(...growRange(1)) };

  constructor(bars: readonly SilhouetteBar[]) {
    const positions = new Float32Array(bars.length * 4 * 3);
    const others = new Float32Array(bars.length * 4 * 3);
    const edges = new Float32Array(bars.length * 4 * 4);
    const indices = new Uint16Array(bars.length * 6);

    for (const [i, bar] of bars.entries()) {
      const v = i * 4;
      const ends = [bar.a, bar.b, bar.b, bar.a];
      const opp = [bar.b, bar.a, bar.a, bar.b];
      const half = [bar.halfA, bar.halfB, bar.halfB, bar.halfA];
      const side = [-1, -1, 1, 1];
      const end = [1, -1, -1, 1];

      for (let k = 0; k < 4; k += 1) {
        const p = ends[k];
        const o = opp[k];

        if (!p || !o) {
          continue;
        }

        positions.set([p.x, p.y, p.z], (v + k) * 3);
        others.set([o.x, o.y, o.z], (v + k) * 3);
        edges.set([side[k] ?? 0, half[k] ?? 0, end[k] ?? 0, bar.minScale], (v + k) * 4);
      }

      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aOther", new THREE.BufferAttribute(others, 3));
    geo.setAttribute("aEdge", new THREE.BufferAttribute(edges, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.ShaderMaterial({
      depthWrite: false,
      fog: false,
      fragmentShader: LM_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        uFog: this.uFog,
        uFogRange: this.uFogRange,
        uGrow: this.uGrow,
        uMinHalf: { value: LM_MIN_HALF_NDC },
        uNight: this.uNight,
        uShell: { value: LM_SHELL },
        uTint: this.uTint,
      },
      vertexShader: LM_VERT,
    });

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "landmark-silhouette";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  update(fogColor: THREE.Color, night: number, fog: THREE.Fog | null) {
    this.uFog.value.copy(fogColor);
    this.uNight.value = night;

    if (fog) {
      this.uFogRange.value.set(fog.near, fog.far);
    }

    this.uGrow.value.set(...growRange(liveQuality().detailScale));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
