import * as THREE from "three";

import { SKID_LIFT } from "../fx/skids";

export const SHADOW_LOBE_R = 0.56;
export const SHADOW_DROOP = 0.1;
export const SHADOW_LOAD = 0.09;
export const SHADOW_LOBE_MAX = 0.78;
export const SHADOW_BODY = 0.46;
export const SHADOW_TINT = 0x0c_16_1c;
export const SHADOW_LIFT = SKID_LIFT + 0.02;
const AIR_FADE_RATE = 9;
const BODY_RADIUS_X = 1.06;
const BODY_RADIUS_Z = 1.3;
const QUAD_MARGIN = 0.95;

const DEFAULT_LAYOUT: readonly { x: number; z: number }[] = [
  { x: -0.62, z: 1.28 },
  { x: 0.62, z: 1.28 },
  { x: -0.62, z: -1.28 },
  { x: 0.62, z: -1.28 },
];

const VERT = `
varying vec2 vP;
void main() {
	vP = position.xz;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAG = `
uniform vec3 uTint;
uniform float uBodyK;
uniform vec2 uBodyRadii;
uniform vec2 uHalf;
uniform vec4 uLobe[ 4 ]; // xy = centre, z = radius, w = strength
varying vec2 vP;

float lobe( vec2 c, float r, float k ) {
	float d = length( vP - c );
	float t = clamp( d / max( r, 1e-3 ), 0.0, 1.0 );
	float skirt = 1.0 - t * t * ( 3.0 - 2.0 * t ); // wide AO of a wheel-sized object
	float u = clamp( d / max( r * 0.40, 1e-3 ), 0.0, 1.0 );
	float core = 1.0 - u * u * ( 3.0 - 2.0 * u ); // the contact patch itself
	return k * clamp( 0.45 * skirt + 0.55 * core, 0.0, 1.0 );
}

void main() {
	float body = uBodyK * ( 1.0 - smoothstep( 0.55, 1.0, length( vP / uBodyRadii ) ) );
	float occ = body;
	for ( int i = 0; i < 4; i ++ ) {
		float l = lobe( uLobe[ i ].xy, uLobe[ i ].z, uLobe[ i ].w );
		occ = occ + l - occ * l; // screen blend: lobes can't stack to black
	}
	vec2 g = abs( vP ) / uHalf;
	occ *= ( 1.0 - smoothstep( 0.74, 0.98, g.x ) ) * ( 1.0 - smoothstep( 0.74, 0.98, g.y ) );
	if ( occ < 0.004 ) discard;
	gl_FragColor = vec4( uTint, occ );
}
`;

export class ContactShadow {
  readonly mesh: THREE.Mesh;
  private readonly uBodyK = { value: SHADOW_BODY };
  private readonly uBodyRadii = { value: new THREE.Vector2(1, 1) };
  private readonly uHalf = { value: new THREE.Vector2(1, 1) };
  private readonly uLobe = {
    value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()],
  };
  private travels = [0, 0, 0, 0];
  private airFade = 1;

  constructor() {
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      depthWrite: false,
      fragmentShader: FRAG,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -16,
      transparent: true,
      uniforms: {
        uBodyK: this.uBodyK,
        uBodyRadii: this.uBodyRadii,
        uHalf: this.uHalf,
        uLobe: this.uLobe,
        uTint: { value: new THREE.Color(SHADOW_TINT) },
      },
      vertexShader: VERT,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1;
    this.setLayout(DEFAULT_LAYOUT);
  }

  /** Wheel contact points in body space; falls back to a sedan footprint when
   *  a skin has no wheel nodes. Call again on skin swap. */
  setLayout(wheels: readonly { x: number; z: number }[]) {
    const pts = wheels.length >= 4 ? wheels : DEFAULT_LAYOUT;
    let maxX = 0;
    let maxZ = 0;

    for (let i = 0; i < 4; i += 1) {
      const p = pts[i];

      if (!p) {
        continue;
      }

      this.uLobe.value[i]?.set(p.x, p.z, SHADOW_LOBE_R, 0);
      maxX = Math.max(maxX, Math.abs(p.x));
      maxZ = Math.max(maxZ, Math.abs(p.z));
    }

    this.uBodyRadii.value.set(maxX * BODY_RADIUS_X, maxZ * BODY_RADIUS_Z);
    const hx = maxX + QUAD_MARGIN;
    const hz = maxZ + QUAD_MARGIN;
    this.uHalf.value.set(hx, hz);
    this.mesh.scale.set(hx, 1, hz);
  }

  setWheelTravel(i: number, travel: number) {
    if (i >= 0 && i < 4) {
      this.travels[i] = travel;
    }
  }

  update(dt: number, grounded: boolean) {
    const target = grounded ? 1 : 0;
    this.airFade += (target - this.airFade) * Math.min(1, dt * AIR_FADE_RATE);
    this.uBodyK.value = SHADOW_BODY * this.airFade;

    for (let i = 0; i < 4; i += 1) {
      const travel = this.travels[i] ?? 0;
      const planted = THREE.MathUtils.clamp((travel + SHADOW_DROOP) / SHADOW_DROOP, 0, 1);
      const load = THREE.MathUtils.clamp(travel / SHADOW_LOAD, 0, 1);
      const u = this.uLobe.value[i];

      if (!u) {
        continue;
      }

      u.z = SHADOW_LOBE_R * (1 + 0.3 * (1 - planted) - 0.22 * load);
      u.w = SHADOW_LOBE_MAX * planted * this.airFade;
    }
  }
}
