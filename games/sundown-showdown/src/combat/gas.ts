import * as THREE from "three";
import { TUNING } from "../config";
import type { Game } from "../game";
import { clamp, lerp, smoothstep } from "../utils";

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const GAS_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4( position, 1.0 );
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const GAS_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uHalf;
  uniform float uRound;
  uniform float uLayer;
  uniform float uAlpha;
  uniform float uAmbient;
  uniform float uGlow;
  varying vec3 vWorld;

  float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
  float noise( vec2 p ) {
    vec2 i = floor( p ); vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
  float fbm( vec2 p ) {
    float v = 0.0; float a = 0.5;
    for ( int i = 0; i < 4; i ++ ) { v += a * noise( p ); p = p * 2.03 + 17.0; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 p = vWorld.xz;
    vec2 q = abs( p ) - vec2( uHalf - uRound );
    float sd = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - uRound; // < 0 inside the safe zone
    vec2 flow = vec2( uTime * 0.11, - uTime * 0.07 ) * ( 1.0 + uLayer * 0.35 );
    float n = fbm( p * 0.33 + flow + uLayer * 9.7 );
    float n2 = fbm( p * 0.9 - flow * 1.7 + uLayer * 3.1 );
    float edge = sd + ( n - 0.5 ) * 1.9;
    float body = smoothstep( 0.0, 2.2, edge );
    if ( body <= 0.001 ) discard;
    float dens = body * mix( 0.5, 1.0, n ) * mix( 0.7, 1.0, n2 );
    float rim = smoothstep( 0.0, 0.5, edge ) * ( 1.0 - smoothstep( 0.5, 2.4, edge ) );
    vec3 deep = vec3( 0.05, 0.42, 0.12 );
    vec3 light = vec3( 0.38, 0.95, 0.3 );
    vec3 col = mix( deep, light, n * n2 * 1.6 ) * uAmbient;
    // three sheets stack, so the rim must stay near 1.0 after blending: any hotter and
    // bloom turns the whole front line into a white wall (it did, at night)
    col += vec3( 0.28, 1.45, 0.4 ) * rim * uGlow;
    gl_FragColor = vec4( col, clamp( dens * uAlpha + rim * 0.25, 0.0, 0.95 ) );
  }`;

// Three translucent sheets at rising heights; the higher ones are fainter so
// the stack reads as a volume rather than three hard planes.
const LAYER_HEIGHTS = [0.3, 0.72, 1.12];
const LAYER_ALPHAS = [0.34, 0.3, 0.26];
// Seconds of warning before the gas starts to bite.
const WARNING = 6;
const START_ROUND = 5;
const END_ROUND = 2.2;

interface GasUniforms {
  uAlpha: THREE.IUniform<number>;
  uAmbient: THREE.IUniform<number>;
  uGlow: THREE.IUniform<number>;
  uHalf: THREE.IUniform<number>;
  uLayer: THREE.IUniform<number>;
  uRound: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

interface GasSheet {
  alpha: number;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  uniforms: GasUniforms;
}

/**
 * The shrinking poison zone. The safe area is a rounded square centred on the
 * map whose half-size closes from `gasStartHalf` to `gasEndHalf` over the match.
 */
export class Gas {
  game: Game;
  half: number;
  round: number;
  active: boolean;
  layers: THREE.Mesh[];
  tickT: number;
  ticks: number;
  private readonly sheets: GasSheet[];

  constructor(game: Game) {
    this.game = game;
    this.half = TUNING.gasStartHalf;
    this.round = START_ROUND;
    this.active = false;
    this.layers = [];
    this.sheets = [];
    this.tickT = 0;
    this.ticks = 0;
    const geometry = new THREE.PlaneGeometry(104, 104).rotateX(-Math.PI / 2);
    for (const [index, height] of LAYER_HEIGHTS.entries()) {
      const alpha = LAYER_ALPHAS[index] ?? 0;
      const uniforms = {
        uAlpha: { value: alpha },
        uAmbient: { value: 1 },
        uGlow: { value: 1 },
        uHalf: { value: this.half },
        uLayer: { value: index },
        uRound: { value: this.round },
        uTime: { value: 0 },
      };
      const material = new THREE.ShaderMaterial({
        depthWrite: false,
        fragmentShader: GAS_FRAG,
        transparent: true,
        uniforms,
        vertexShader: GAS_VERT,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = height;
      mesh.renderOrder = 4;
      mesh.userData.noAO = true;
      mesh.frustumCulled = false;
      game.scene.add(mesh);
      this.layers.push(mesh);
      this.sheets.push({ alpha, mesh, uniforms });
    }
    this.reset();
  }

  reset(): void {
    this.half = TUNING.gasStartHalf;
    this.tickT = 0;
    this.ticks = 0;
    this.active = false;
    for (const layer of this.layers) {
      layer.visible = false;
    }
  }

  /** Signed distance into the gas: negative inside the safe zone, positive once in the poison. */
  depthAt(x: number, z: number): number {
    const qx = Math.abs(x) - (this.half - this.round);
    const qz = Math.abs(z) - (this.half - this.round);
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - this.round
    );
  }

  /** `simulate` false (a guest mirroring the host) drives the sheets without dealing damage. */
  update(dt: number, matchTime: number, simulate = true): void {
    const progress = clamp((matchTime - TUNING.gasDelay) / TUNING.gasDuration, 0, 1);
    this.active = matchTime > TUNING.gasDelay - WARNING;
    this.half = lerp(TUNING.gasStartHalf, TUNING.gasEndHalf, progress);
    this.round = lerp(START_ROUND, END_ROUND, progress);
    // The sheets fade in over the warning window before the first tick lands.
    const fadeIn = smoothstep(TUNING.gasDelay - WARNING, TUNING.gasDelay, matchTime);
    this.updateSheets(fadeIn);
    if (!simulate || matchTime < TUNING.gasDelay) {
      return;
    }
    this.tickT += dt;
    if (this.tickT >= 1) {
      this.tickT -= 1;
      this.ticks += 1;
      this.tick();
    }
  }

  private updateSheets(fadeIn: number): void {
    const { elapsed, lighting } = this.game;
    for (const sheet of this.sheets) {
      sheet.mesh.visible = this.active;
      const { uniforms } = sheet;
      uniforms.uTime.value = elapsed;
      uniforms.uHalf.value = this.half;
      uniforms.uRound.value = this.round;
      // Dim the body with the scene so the gas does not glow like daylight at night.
      const daylight = clamp((lighting.ambientLevel - 0.36) / 0.64, 0, 1);
      uniforms.uAmbient.value = lerp(0.2, 1, daylight);
      uniforms.uGlow.value = (0.55 + lighting.night * 0.3) * fadeIn;
      uniforms.uAlpha.value = sheet.alpha * fadeIn;
    }
  }

  // Once a second, everyone standing in the gas takes a tick that ramps up
  // over the first minute so a late straggler cannot camp in it.
  private tick(): void {
    const { audio, brawlers } = this.game;
    const damage = 600 + Math.min(this.ticks, 60) * 25;
    for (const brawler of brawlers) {
      if (!brawler.alive || brawler.airborne || this.depthAt(brawler.x, brawler.z) <= 0.35) {
        continue;
      }
      brawler.takeDamage(damage, null, true);
      if (brawler.isPlayer) {
        audio.play("gas");
      }
    }
  }
}
