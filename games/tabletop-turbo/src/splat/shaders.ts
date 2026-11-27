export const SPLAT_VERTEX = `
precision highp float;
precision highp int;

in vec2 position;
in vec3 aCenter;
in vec4 aNormal;
in vec4 aData;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// G-buffer width and height, pixels per world unit (or focal length in pixels), 1 when orthographic.
uniform vec4 uGrid;
// Disc scale, flatness, cut radius in sigmas, time.
uniform vec4 uSplat;

#ifndef SHADOW
uniform vec4 uSun;
// Shade steps, light steps, dither band, highlight.
uniform vec4 uShade;
uniform mat4 uLightVP;
uniform sampler2D uShadowMap;
// On, depth bias, normal offset.
uniform vec4 uShadow;
uniform sampler2D uPaint;
uniform sampler2D uLight;
// World units the paint and light maps span, centred on the origin.
uniform float uFloorSpan;
uniform float uSlotRamp[32];
flat out vec3 vTone;
#endif

out vec2 vD;
flat out vec3 vConic;

const int UNLIT = 1;
const int TWO_SIDED = 2;
const int PAINTABLE = 4;
const int NO_SHADOW = 8;
const int ROUND = 16;
const int PULSE = 32;
const int BRIGHT = 64;

vec2 hash2(vec3 p) {
  float a = fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float b = fract(sin(dot(p, vec3(39.346, 11.135, 83.155))) * 24634.6345);
  return vec2(a, b);
}

void main() {
  int flags = int(aData.w + 0.5);
  vec3 normal = normalize(aNormal.xyz);
  vec4 vp = viewMatrix * vec4(aCenter, 1.0);
  vec3 n = normalize(mat3(viewMatrix) * normal);
  bool ortho = uGrid.w > 0.5;
  float z = max(-vp.z, 0.05);

  float facing = ortho ? n.z : dot(n, normalize(-vp.xyz));
  bool hidden = false;
  if ((flags & TWO_SIDED) != 0 || (flags & ROUND) != 0) {
    if (facing < 0.0) { n = -n; }
  } else if (facing < -0.25) {
    hidden = true;
  }
#ifdef SHADOW
  if ((flags & UNLIT) != 0 || (flags & NO_SHADOW) != 0) { hidden = true; }
#endif

  float st = aData.x * 0.01 * uSplat.x;
  float sn = (flags & ROUND) != 0 ? st : st * uSplat.y;
  vec3 j0 = ortho ? vec3(uGrid.z, 0.0, 0.0) : vec3(uGrid.z / z, 0.0, uGrid.z * vp.x / (z * z));
  vec3 j1 = ortho ? vec3(0.0, uGrid.z, 0.0) : vec3(0.0, uGrid.z / z, uGrid.z * vp.y / (z * z));
  float t2 = st * st;
  float d2 = sn * sn - t2;
  float n0 = dot(j0, n);
  float n1 = dot(j1, n);
  // The low-pass keeps every disc at least a pixel wide.
  float a = t2 * dot(j0, j0) + d2 * n0 * n0 + 0.3;
  float b = t2 * dot(j0, j1) + d2 * n0 * n1;
  float c = t2 * dot(j1, j1) + d2 * n1 * n1 + 0.3;
  float det = max(a * c - b * b, 1e-6);
  vConic = vec3(c, -b, a) / det;
  vec2 half_ = min(sqrt(vec2(a, c)) * uSplat.z + 0.5, vec2(48.0));

  vD = position * half_;
  vec4 clip = projectionMatrix * vp;
  clip.xy += vD * 2.0 / uGrid.xy * clip.w;
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : clip;

#ifndef SHADOW
  float ramp = aData.y;
  float base = aData.z;
  vec2 noise = hash2(aCenter);
  bool unlit = (flags & UNLIT) != 0;

  vec2 floorUv = aCenter.xz / uFloorSpan + 0.5;
  // How lit this spot is: the light map in whole levels, dithered across the middle of each band.
  float lit = texture(uLight, floorUv).r * 3.0;
  float level = floor(lit) + (noise.x < clamp((fract(lit) - 0.5) / 0.3 + 0.5, 0.0, 1.0) ? 1.0 : 0.0);
  if ((flags & BRIGHT) != 0) { level = 2.0; }

  if ((flags & PAINTABLE) != 0) {
    vec2 coat = texture(uPaint, floorUv).rg;
    int slot = int(coat.r * 255.0 + 0.5);
    // A glow trail wears through in speckles before it is gone.
    if (slot > 0 && slot < 31 && coat.g > noise.y * 0.45) {
      ramp = uSlotRamp[slot];
      base = coat.g > 0.7 ? 3.0 : 2.0;
      level = max(level, coat.g > 0.4 ? 3.0 : 2.0);
    } else if (slot == 31 && coat.g > noise.y * 0.6) {
      // Tyre marks: the floor's own colour, one step down.
      base = max(base - 1.0, 0.0);
    }
  }
  if (unlit) { level = 3.0; }
  // Off the table the room swallows everything, a level at a time.
  if (aCenter.y < -1.5) { level = max(0.0, level - floor(-aCenter.y / 3.5)); }
  level = clamp(level, 0.0, 3.0);

  if ((flags & PULSE) != 0) {
    // A band of light running across the surface, in steps.
    float band = fract(floor(uSplat.w * 10.0) * 0.1 - dot(aCenter, vec3(0.09, 0.21, 0.06)));
    if (band < 0.3) { base += 1.0; }
  }

  float offset = 0.0;
  bool shaded = false;
  if (!unlit) {
    float direct = max(dot(normal, uSun.xyz), 0.0);
    if (uShadow.x > 0.5 && direct > 0.0) {
      vec4 lp = uLightVP * vec4(aCenter + normal * uShadow.z, 1.0);
      vec3 uvw = lp.xyz * 0.5 + 0.5;
      if (uvw.x > 0.0 && uvw.x < 1.0 && uvw.y > 0.0 && uvw.y < 1.0) {
        float seen = texture(uShadowMap, uvw.xy).r;
        if (uvw.z - uShadow.y > seen) { direct = 0.0; shaded = true; }
      }
    }
    float key = uSun.w;
    offset = direct < key
      ? -uShade.x * (1.0 - direct / key)
      : uShade.y * max(direct - uShade.w, 0.0) / (1.0 - uShade.w);
    // A cast shadow is a flat two steps down: chunky, and darker than a face turned from the sun.
    if (shaded) { offset = -2.0; }
  }
  float lo = floor(offset);
  float t = clamp((fract(offset) - 0.5) / uShade.z + 0.5, 0.0, 1.0);
  float step_ = clamp(base + lo + (noise.y < t ? 1.0 : 0.0), 0.0, 4.0);
  vTone = vec3(ramp, step_, level);
#endif
}
`;

export const SPLAT_FRAGMENT = `
precision highp float;

in vec2 vD;
flat in vec3 vConic;
#ifndef SHADOW
flat in vec3 vTone;
#endif
uniform vec4 uSplat;
out vec4 outColor;

void main() {
  float power = -0.5 * (vConic.x * vD.x * vD.x + 2.0 * vConic.y * vD.x * vD.y + vConic.z * vD.y * vD.y);
  if (power < -0.5 * uSplat.z * uSplat.z) { discard; }
#ifdef SHADOW
  outColor = vec4(1.0);
#else
  outColor = vec4(vTone.x / 255.0, vTone.y / 255.0, vTone.z / 255.0, 1.0);
#endif
}
`;

export const RESOLVE_VERTEX = `
precision highp float;
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const RESOLVE_FRAGMENT = `
precision highp float;
precision highp int;

uniform sampler2D uTones;
uniform sampler2D uDepth;
uniform sampler2D uRamps;
// Near, far, 1 when orthographic, depth step that counts as an edge.
uniform vec4 uDepthInfo;
// Sky ramp, top step, bottom step, horizon as a share of the height.
uniform vec4 uSky;
uniform float uRows;
out vec4 outColor;

float bayer(ivec2 p) {
  int x = p.x & 3;
  int y = p.y & 3;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[y * 4 + x]) + 0.5) / 16.0;
}

float metres(float d) {
  float near = uDepthInfo.x;
  float far = uDepthInfo.y;
  return uDepthInfo.z > 0.5 ? near + d * (far - near) : near * far / (far - d * (far - near));
}

// Covered samples of one art pixel, and the nearest of them.
vec2 reach(ivec2 p) {
  float cover = 0.0;
  float nearest = 1.0;
  for (int i = 0; i < 4; i += 1) {
    ivec2 q = p * 2 + ivec2(i & 1, i >> 1);
    if (texelFetch(uTones, q, 0).a > 0.5) {
      cover += 1.0;
      nearest = min(nearest, texelFetch(uDepth, q, 0).r);
    }
  }
  return vec2(cover, metres(nearest));
}

vec3 tone(float ramp, float step_, float level) {
  return texelFetch(uRamps, ivec2(int(level + 0.5) * 5 + int(step_ + 0.5), int(ramp + 0.5)), 0).rgb;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float keys[4];
  float depths[4];
  float cover = 0.0;
  for (int i = 0; i < 4; i += 1) {
    ivec2 q = p * 2 + ivec2(i & 1, i >> 1);
    vec4 s = texelFetch(uTones, q, 0);
    keys[i] = s.a > 0.5
      ? floor(s.r * 255.0 + 0.5) * 64.0 + floor(s.b * 255.0 + 0.5) * 8.0 + floor(s.g * 255.0 + 0.5)
      : -1.0;
    depths[i] = s.a > 0.5 ? texelFetch(uDepth, q, 0).r : 2.0;
    cover += s.a > 0.5 ? 1.0 : 0.0;
  }

  float height = float(p.y) / uRows;
  if (cover < 2.0) {
    float band = (height - (1.0 - uSky.w)) / 0.12 + 0.5;
    outColor = vec4(tone(uSky.x, bayer(p) < band ? uSky.y : uSky.z, 0.0), 1.0);
    return;
  }

  // The tone most samples agree on; a tie goes to the nearest.
  float best = -1.0;
  float bestVotes = 0.0;
  float bestDepth = 2.0;
  for (int i = 0; i < 4; i += 1) {
    if (keys[i] >= 0.0) {
      float votes = 0.0;
      for (int j = 0; j < 4; j += 1) {
        votes += keys[j] == keys[i] ? 1.0 : 0.0;
      }
      if (votes > bestVotes || (votes == bestVotes && depths[i] < bestDepth)) {
        best = keys[i];
        bestVotes = votes;
        bestDepth = depths[i];
      }
    }
  }
  float ramp = floor(best / 64.0);
  float level = floor((best - ramp * 64.0) / 8.0);
  float step_ = best - ramp * 64.0 - level * 8.0;
  float here = metres(bestDepth);

  // Ink: a rim one step down, in the material's own colour.
  bool edge = false;
  ivec2 around[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int i = 0; i < 4; i += 1) {
    vec2 next = reach(p + around[i]);
    if (next.x < 2.0 || next.y - here > uDepthInfo.w) { edge = true; }
  }
  if (edge) { step_ = max(step_ - 1.0, 0.0); }

  outColor = vec4(tone(ramp, step_, level), 1.0);
}
`;
