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

// ── Ground cracks ────────────────────────────────────────────────────────────
// Cellular-noise fissures: dark charcoal fractures with a hot glowing seam
// that cools over the decal's life (the Diablo "the earth remembers the hit"
// language). Unit quad, scale the pivot (uniform = radial star; stretched =
// directional gash). uPulse > 0 re-heats the seam at ~2Hz (Vesper's bleed).
export function makeCrackMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: CLOCK as { value: number },
      uColor: { value: new THREE.Color(0xff8040) }, // hot seam
      uT: { value: 0 }, // life progress 0→1
      uSeed: { value: 0 },
      uPulse: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uT; uniform float uSeed; uniform float uPulse;
      varying vec2 vUv;
      vec2 hash22(vec2 p){
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }
      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        if (r > 1.0) discard;
        // cellular F2-F1: thin ridges along cell borders = the fissures
        vec2 q = p * 3.2 + uSeed;
        vec2 iq = floor(q); vec2 fq = fract(q);
        float f1 = 8.0; float f2 = 8.0;
        for (int yy = -1; yy <= 1; yy++)
        for (int xx = -1; xx <= 1; xx++){
          vec2 g = vec2(float(xx), float(yy));
          vec2 o = hash22(iq + g);
          float d = length(g + o - fq);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
        float ridge = 1.0 - smoothstep(0.0, 0.16, f2 - f1); // 1 on the fissure lines
        float fall = 1.0 - smoothstep(0.45, 1.0, r);        // fade toward the rim
        float lifeFade = 1.0 - smoothstep(0.55, 1.0, uT);
        // seam heat cools over life; optional re-heat pulse
        float heat = (1.0 - smoothstep(0.0, 0.6, uT)) + uPulse * (0.5 + 0.5 * sin(uTime * 12.6)) * 0.6;
        heat = clamp(heat, 0.0, 1.0);
        vec3 charcoal = vec3(0.05, 0.045, 0.05);
        vec3 c = mix(charcoal, uColor * 1.4, heat * ridge);
        float a = ridge * fall * lifeFade * 0.85;
        if (a < 0.01) discard;
        gl_FragColor = vec4(c, a);
      }`,
  });
}

// ── Rune circle ──────────────────────────────────────────────────────────────
// A rotating arcane ring: outer band, dashed inner band, tick glyphs. Used as
// an arming telegraph (smite / grand hex / trap) and as the persistent
// underfoot ring for buffs (Iron Stance / Bastion / Hunter's Focus).
export function makeRuneMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: CLOCK as { value: number },
      uColor: { value: new THREE.Color(color) },
      uAlpha: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uAlpha;
      varying vec2 vUv;
      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        if (r > 1.0) discard;
        float th = atan(p.y, p.x);
        // outer band (solid) + mid band (dashed, counter-rotating) + 4 ticks
        float outer = smoothstep(0.045, 0.02, abs(r - 0.93));
        float dash = step(0.5, fract((th + uTime * 0.9) * 2.5464)); // 16 dashes
        float mid = smoothstep(0.05, 0.02, abs(r - 0.74)) * dash;
        float tickA = cos((th - uTime * 0.45) * 4.0);
        float ticks = smoothstep(0.965, 0.995, tickA) * smoothstep(0.62, 0.5, abs(r - 0.45) / 0.45);
        float a = (outer * 0.85 + mid * 0.6 + ticks * 0.7) * uAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * 1.3, a);
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
