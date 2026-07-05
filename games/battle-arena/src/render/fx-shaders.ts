// Shared combat-FX shader materials. All animation reads ONE global clock
// uniform (tickFxShaders advances it on the hit-stop-scaled dt, so shader fx
// hang in the freeze like everything else). Materials are shared per kind —
// adding a projectile never compiles a new program.
import * as THREE from "three";

// one clock object referenced by every material — mutate, never reassign
const CLOCK = { value: 0 };

/** Advance the global shader clock (call once per frame with the fx dt). */
export function tickFxShaders(dt: number): void {
  CLOCK.value += dt;
}

// cheap value-ish noise, good enough for fire/energy wobble at game speed
const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p){ p = fract(p*vec2(234.34,435.345)); p += dot(p,p+34.23); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){ return 0.6*vnoise(p) + 0.4*vnoise(p*2.3 + 7.7); }`;

// ── Energy ball (fireball / hexbolt / bolt cores) ────────────────────────────
// A sphere whose surface boils (scrolling fbm emission) with a hot fresnel rim.
// HDR-bright (>1) so the bloom pass catches the core.
const ballCache = new Map<number, THREE.ShaderMaterial>();

/** Shared boiling-energy material for projectile cores, keyed by color. */
export function energyBallMaterial(color: number): THREE.ShaderMaterial {
  let mat = ballCache.get(color);
  if (mat) return mat;
  mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: CLOCK as { value: number },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){
        vUv = uv;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      ${NOISE_GLSL}
      void main(){
        // boiling surface: two scroll directions so it churns, not slides
        float boil = fbm(vUv*4.0 + vec2(uTime*1.4, -uTime*0.9));
        float fres = pow(1.0 - abs(dot(vN, vV)), 1.6);
        vec3 hot = mix(uColor, vec3(1.0), 0.5);        // white-hot center
        vec3 c = mix(uColor*0.7, hot, boil) * 1.25;    // just past 1 — a gentle bloom bite
        c += uColor * fres * 0.8;                      // rim glow
        float a = 0.5 + 0.4*boil;
        gl_FragColor = vec4(c, a);
      }`,
  });
  ballCache.set(color, mat);
  return mat;
}

// ── Shockwave ring ───────────────────────────────────────────────────────────
// Replaces the flat ring: a soft annulus with an angular-noise-broken rim and
// a hot inner edge. The pool animates uT 0→1 (expand handled by mesh scale).
export function makeRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uT: { value: 0 }, // life progress 0→1
      uAlpha: { value: 1 },
      uSeed: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uT; uniform float uAlpha; uniform float uSeed;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main(){
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;               // 0 center → 1 plane edge
        float ang = atan(p.y, p.x);
        // rim sits near the plane edge; trailing energy falls off inward
        float rim = smoothstep(0.22, 0.02, abs(r - 0.88));
        float trail = smoothstep(0.88, 0.30, r) * smoothstep(0.20, 0.55, r) * 0.14;
        // angular breakup so the circle reads as energy, not a vector stroke
        float n = 0.65 + 0.35 * vnoise(vec2(ang*2.2 + uSeed, uSeed + uT*2.0));
        float fade = 1.0 - uT;
        vec3 c = mix(uColor, vec3(1.0), rim*0.4) * 1.15;
        float a = (rim*n + trail) * fade * uAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(c, a);
      }`,
  });
}

// ── Crescent slash (anime sword arc) ─────────────────────────────────────────
// A pointed crescent that sweeps open, holds a hot leading edge, then erodes
// with noise — the classic "slash VFX" gradient arc, done procedurally.
// Unit quad; the arc opens along local +X, tips tapering toward ±uSpan.
// Animate uT 0→1 over the slash's life.
export function makeSlashMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uT: { value: 0 },
      uSpan: { value: 1.1 }, // angular half-width (radians)
      uSeed: { value: 0 },
      uDir: { value: 1 }, // sweep direction: 1 = CCW, -1 = CW (mirrored dual-wield)
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uT; uniform float uSpan; uniform float uSeed; uniform float uDir;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float th = atan(p.y, p.x) * uDir;
        float k = clamp(abs(th) / uSpan, 0.0, 1.0);   // 0 arc center → 1 tips
        if (k >= 1.0) discard;
        float tip = 1.0 - k * k;                      // thickness taper into points
        // crescent: circular outer (leading) edge, inner edge bows in mid-arc
        float outer = 0.92;
        float inner = outer - (0.42 * tip + 0.04);
        float band = smoothstep(outer, outer - 0.05, r) * smoothstep(inner, inner + 0.16, r);
        if (band < 0.004) discard;
        // sweep open across the first 35% of life (leading tip races ahead)
        float sw = clamp(uT / 0.35, 0.0, 1.0);
        float lead = mix(-uSpan - 0.3, uSpan, sw);
        float reveal = smoothstep(0.12, -0.08, th - lead);
        // noise erosion from the trailing side as it dies
        float n = vnoise(vec2(th * 2.6 + uSeed, r * 7.0 + uSeed));
        float diss = 1.0 - smoothstep(n + 0.05, n - 0.18, 1.0 - uT * 1.25);
        // hot white leading edge over the champ color
        float edge = pow(smoothstep(inner, outer, r), 3.0);
        vec3 c = mix(uColor, vec3(1.0), 0.3 + 0.5 * edge) * 1.3;
        float a = band * reveal * diss * (1.0 - smoothstep(0.72, 1.0, uT)) * 0.55;
        if (a < 0.004) discard;
        gl_FragColor = vec4(c, a);
      }`,
  });
}

// ── Vortex drum (whirlwind ult) / light pillar shell ─────────────────────────
// Open-ended cylinder with diagonal energy stripes racing around it, fading
// toward the top (uUp 0) or blooming upward from the ground (uUp 1).
export function makeVortexMaterial(color: number, upward = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: CLOCK as { value: number },
      uColor: { value: new THREE.Color(color) },
      uAlpha: { value: 1 },
      uUp: { value: upward ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uAlpha; uniform float uUp;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main(){
        // diagonal stripes racing around the drum
        float stripes = 0.5 + 0.5*sin((vUv.x*6.0 + vUv.y*2.0) * 6.2831 - uTime*9.0);
        float rough = 0.7 + 0.3*vnoise(vec2(vUv.x*8.0, vUv.y*3.0 - uTime*2.0));
        float hfade = mix(smoothstep(1.0, 0.15, vUv.y), smoothstep(0.0, 0.85, vUv.y), uUp);
        float band = stripes * rough;
        float a = band * hfade * uAlpha * 0.16;
        vec3 c = mix(uColor, vec3(1.0), band*0.25);
        if (a < 0.004) discard;
        gl_FragColor = vec4(c, a);
      }`,
  });
}
