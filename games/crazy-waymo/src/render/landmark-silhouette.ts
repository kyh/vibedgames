import * as THREE from "three";

import { DETAIL_DISTANCE } from "../world/city";
import type { GoldenGatePlan, SilhouetteBar } from "../world/golden-gate";
import { goldenGateSilhouette, goldenGateSolvedPlan } from "../world/golden-gate";
import { HAZE_AMOUNT, HAZE_BASE, HAZE_SCALE } from "./aerial-fog";
import { liveQuality } from "./quality";

// --- The Golden Gate at range ---------------------------------------------
//
// The bridge is the thing you orient by from across the map, and it was the one
// structure that vanished from it. Measured on the shipped build, noon, three
// bearings: at 300u it is the best frame in the game; at 700u it is four thin
// orange sticks with no deck, no cables and no form; at 1200u a grey smudge; at
// 2000u nothing at all. Three causes stack up, and only the first is obvious:
//
//  1. THE LOD KEEPS THE WRONG PARTS. Past the model band an instance survives
//     only as a box imposter, and only if it stands 13u or taller. On this
//     bridge that is the four tower legs and NOTHING else — the cables, the
//     truss, the deck boards and the portal bracing are all under the bar and
//     are simply culled. What is left is exactly the four sticks. (city.ts now
//     holds the WHOLE structure to LANDMARK_HOLD_DISTANCE instead — a landmark
//     is one object to the eye, so it is one object to the LOD — but the
//     members are still sub-pixel long before that band ends, which is what
//     the rest of this module is for.)
//  2. SUB-PIXEL MEMBERS. A 3.6u leg is 3.7px at 1200u and 2px at 2000u, thin
//     enough for MSAA and the haze to finish off.
//  3. THE HAZE OWNS THE COLOUR. Fog far is ~950u by day, so from street level
//     everything past it is 100% fog — International Orange included.
//
// The fix is a stand-in that is drawn at EVERY distance and only ever grows:
// ~70 camera-facing ribbons (world/golden-gate.ts goldenGateSilhouette) laid
// exactly on the towers, the bracing, the truss chords and the catenary. Each
// ribbon is INSET inside the member it stands for, so within the detail band
// the real bridge covers it completely and it cannot be seen; past that band it
// holds a minimum WIDTH ON SCREEN, so the form stops thinning away; and its
// haze is the scene's own curve with a ceiling, so the orange survives the
// distance the rest of the world is meant to dissolve into. Nothing switches
// on and nothing switches off — there is no LOD boundary to pop at, only a
// width that ramps in over the band where the members go sub-pixel.
//
// It also has to WIN the pixels its own leg imposters still hold out there, or
// each thickened leg would carry a washed-out fog-coloured stripe down its
// middle. Hence the small push toward the camera, ramped on the same curve: at
// close range it is zero (the stand-in stays hidden behind the real bridge),
// at range it is a couple of units (the stand-in covers its own imposter).
const LM_HOLD = DETAIL_DISTANCE; // last range every member is comfortably above a pixel
const LM_FULL = 760; // ...and where the stand-in has fully taken over
// ...but the real band is scaled by the perf governor's tier (city.ts, via
// quality.detailScale), so on a phone the members cull far earlier while an
// unscaled ramp is still holding the stand-in thin. Both ends track the tier,
// so the hand-off stays put wherever the LOD actually is. Desktop is scale 1
// and this is the identity.
const growRange = (scale: number): [number, number] => [LM_HOLD * scale, LM_FULL * scale];
// Minimum half-width a TOWER LEG holds, in NDC-Y units — a fixed fraction of
// the screen HEIGHT rather than a pixel count, because a beacon has to hold its
// angular size at any resolution. 0.0075 is ~2.7px of a 720p frame, so a leg
// bottoms out at ~5px wide and the two of them still read as a portal rather
// than fusing into a slab. Every other member holds a share of it (minScale).
const LM_MIN_HALF_NDC = 0.0075;
// ...but the screen floor is not allowed to run away in WORLD units. Held past
// ~1300u it takes a 3.6u tower leg to 8u and the two legs of a tower start to
// close the 15u portal between them: the crossing bloats into one orange lump
// with two bumps on it. Capped, the members thin out again at extreme range,
// which is what they should do — at 2000u a leg is still 2px.
const LM_MAX_HALF = 6.5;
// Ceiling on how far the landmark ages into the haze. It buys a real
// exemption and the number is small on purpose: the sky here is a bright
// blue-white, and sRGB is steep near black, so a mix that sounds harmless
// wrecks the HUE — International Orange's blue channel is a sixth of the fog's,
// so the weakest channel takes almost all of the lift and the bridge goes
// CORAL while it is still nominally "90% itself". Measured at 1200u on the
// shipped grade: 0.10 read (191,109,106) — green and blue level, i.e. pink,
// against the real paint's (141,75,60) at 300u. 0.045 lands (166,86,70): still
// visibly lighter and softer than the near bridge, so the distance reads, but
// with the orange ratio intact. The distance is carried by size, by the
// members simplifying, and by everything AROUND the bridge being hazier — not
// by bleaching the one colour the landmark is famous for choosing so it would
// survive fog.
const LM_MAX_HAZE = 0.045;
// Inside the 2000u far plane: past this the silhouette is rescaled along the
// view ray onto a shell, which leaves the projection pixel-identical (the same
// trick render/far-terrain.ts plays on its bands) and stops the far corner of
// the map clipping it away.
const LM_SHELL = 1700;
const LM_PUSH = 2.6; // depth bias, in world units, over its own imposters
const LM_TINT = 0xd6512e; // International Orange
// The stand-in is unlit, so this stands in for the sun on the real bridge's
// paint — and it is a calibration, not a free brightness knob. At 2.2 the red
// channel clips before the grade sees it, which costs the colour its ratio and
// the bridge goes pale pink (measured (228,136,130) at 1200u). RE-CALIBRATED
// against the shipped grade: the sun-blowout pass (render/post.ts, day bloom
// cut 3.0 -> 6.5, and the bounded sun disc) landed in the same session this was
// tuned in, and 0.9 measures (191,109,106) against it — a stand-in half a stop
// brighter than the bridge it stands in for, which is what made it read as a
// diagram drawn over the strait rather than as the bridge. 0.72 measures
// (166,86,70) at 1200u against the real paint's (141,75,60) at 300u.
const LM_GAIN = 0.72;

const LM_VERT = /* glsl */ `
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

const LM_FRAG = /* glsl */ `
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
class SilhouetteMesh {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly uFog = { value: new THREE.Color(0xbfdcf2) };
  private readonly uTint = { value: new THREE.Color(LM_TINT).multiplyScalar(LM_GAIN) };
  private readonly uNight = { value: 0 };
  private readonly uFogRange = { value: new THREE.Vector2(400, 950) };
  private readonly uGrow = { value: new THREE.Vector2(...growRange(1)) };

  constructor(bars: readonly SilhouetteBar[]) {
    const positions = new Float32Array(bars.length * 4 * 3);
    const others = new Float32Array(bars.length * 4 * 3);
    const edges = new Float32Array(bars.length * 4 * 4);
    const indices = new Uint16Array(bars.length * 6);
    bars.forEach((bar, i) => {
      const v = i * 4;
      // 0,3 sit at a; 1,2 sit at b; 0,1 offset one way, 2,3 the other.
      const ends = [bar.a, bar.b, bar.b, bar.a];
      const opp = [bar.b, bar.a, bar.a, bar.b];
      const half = [bar.halfA, bar.halfB, bar.halfB, bar.halfA];
      const side = [-1, -1, 1, 1];
      const end = [1, -1, -1, 1];
      for (let k = 0; k < 4; k++) {
        const p = ends[k];
        const o = opp[k];
        if (!p || !o) continue;
        positions.set([p.x, p.y, p.z], (v + k) * 3);
        others.set([o.x, o.y, o.z], (v + k) * 3);
        edges.set([side[k] ?? 0, half[k] ?? 0, end[k] ?? 0, bar.minScale], (v + k) * 4);
      }
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aOther", new THREE.BufferAttribute(others, 3));
    geo.setAttribute("aEdge", new THREE.BufferAttribute(edges, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uGrow: this.uGrow,
        uMinHalf: { value: LM_MIN_HALF_NDC },
        uShell: { value: LM_SHELL },
        uFogRange: this.uFogRange,
        uFog: this.uFog,
        uTint: this.uTint,
        uNight: this.uNight,
      },
      vertexShader: LM_VERT,
      fragmentShader: LM_FRAG,
      side: THREE.DoubleSide, // the ribbon is built around the bar, not wound
      depthWrite: false,
      fog: false,
    });

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "landmark-silhouette";
    this.mesh.frustumCulled = false; // the shader moves every vertex
    this.mesh.matrixAutoUpdate = false; // bar positions are already world-space
  }

  update(fogColor: THREE.Color, night: number, fog: THREE.Fog | null): void {
    this.uFog.value.copy(fogColor);
    this.uNight.value = night;
    if (fog) this.uFogRange.value.set(fog.near, fog.far);
    this.uGrow.value.set(...growRange(liveQuality().detailScale));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Every landmark stand-in the running world has, as one scene object with one
 * tick.
 *
 * The bridge's MESHES are baked (world/golden-gate.ts buildGoldenGate runs on
 * cold generation only), so nothing on the normal load path builds bridge
 * geometry at all — but BOTH paths solve the placement (city.ts
 * lightGoldenGate), so this picks the solved plan up on the frame after the
 * world lands, and rebuilds if the world is ever regenerated under it.
 *
 * The scene fog is a PARAMETER, not something to reach for: the stand-in has to
 * age on the same aerial-perspective curve as the geometry it stands in for,
 * and the day-night grade owns fogNear/fogFar. Passing it in is what let this
 * stop being a child of the far-terrain mesh (it used to read `mesh.parent` to
 * find the scene, and hung off the horizon band purely because that was the one
 * render-side object the scene already ticked).
 */
export class LandmarkSilhouettes {
  readonly object: THREE.Group = new THREE.Group();
  private goldenGate: SilhouetteMesh | null = null;
  private goldenGatePlan: GoldenGatePlan | null = null;

  constructor() {
    this.object.name = "landmark-silhouettes";
    this.object.matrixAutoUpdate = false; // bars are world-space; this never moves
  }

  update(fogColor: THREE.Color, night: number, fog: THREE.Fog | null): void {
    const plan = goldenGateSolvedPlan();
    if (plan !== this.goldenGatePlan) {
      this.goldenGatePlan = plan;
      if (this.goldenGate) {
        this.object.remove(this.goldenGate.mesh);
        this.goldenGate.dispose();
        this.goldenGate = null;
      }
      if (plan) {
        this.goldenGate = new SilhouetteMesh(goldenGateSilhouette(plan));
        this.object.add(this.goldenGate.mesh);
      }
    }
    this.goldenGate?.update(fogColor, night, fog);
  }

  dispose(): void {
    if (!this.goldenGate) return;
    this.object.remove(this.goldenGate.mesh);
    this.goldenGate.dispose();
    this.goldenGate = null;
    this.goldenGatePlan = null;
  }
}
