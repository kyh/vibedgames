const COMMON = `
precision highp float;
precision highp int;

const int UNLIT = 1;
const int FLOOR = 2;
const int NO_SHADOW = 4;
const int NO_OUTLINE = 16;
const int SOFT = 32;
const int FLAT = 64;

float bayer(vec2 at) {
  ivec2 p = ivec2(mod(at, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[p.y * 4 + p.x]) + 0.5) / 16.0;
}
`;

export const MESH_VERTEX = `${COMMON}
in vec3 position;
in vec3 normal;
in vec4 aTone;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

#ifdef SHADOW
out vec2 vGround;
flat out vec2 vPick;
#else
out vec3 vWorld;
out vec3 vNormal;
flat out vec4 vTone;
#endif

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
#ifdef SHADOW
  int flags = int(aTone.z + 0.5);
  if ((flags & NO_SHADOW) != 0 || (flags & UNLIT) != 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
  vGround = world.xz;
  vPick = aTone.xy;
#else
  vWorld = world.xyz;
  // Cars are stretched upwards, so a normal needs the inverse transpose to stay square to its face.
  vNormal = transpose(inverse(mat3(modelMatrix))) * normal;
  vTone = aTone;
#endif
}
`;

export const SHADOW_FRAGMENT = `
precision highp float;
in vec2 vGround;
flat in vec2 vPick;
uniform sampler2D uBoard;
uniform vec3 uBoardMap;
out vec4 outColor;
void main() {
  if (vPick.x > 254.0) {
    vec2 cell = (vGround - uBoardMap.xy) * uBoardMap.z;
    if (abs(texelFetch(uBoard, ivec2(floor(cell)), 0).a * 255.0 - vPick.y) > 0.5) { discard; }
  }
  outColor = vec4(1.0);
}
`;

export const MESH_FRAGMENT = `${COMMON}
in vec3 vWorld;
in vec3 vNormal;
flat in vec4 vTone;

// Direction to the sun, and how much of a step a face fully turned from it loses.
uniform vec4 uSun;
uniform mat4 uLightVP;
uniform sampler2D uShadowMap;
// On, depth bias, normal offset, texel.
uniform vec4 uShadow;
uniform sampler2D uPaint;
uniform sampler2D uLight;
uniform sampler2D uBoard;
// Board texture: origin x, origin z, texels per world unit.
uniform vec3 uBoardMap;
// World units the paint and light maps span, centred on the origin.
uniform float uFloorSpan;
uniform float uSlotRamp[32];
// This object's colour ramp, 1 to wear it all over, its id among everything on stage, 1 to draw every other pixel.
uniform vec4 uObject;
// The camera's place on the art grid.
uniform vec2 uPan;

layout(location = 0) out vec4 outTone;
layout(location = 1) out vec4 outSurface;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float cloud(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

float shadowAt(vec3 world, vec3 normal) {
  if (uShadow.x < 0.5) { return 0.0; }
  vec4 lp = uLightVP * vec4(world + normal * uShadow.z, 1.0);
  vec3 uvw = lp.xyz * 0.5 + 0.5;
  if (uvw.x <= 0.0 || uvw.x >= 1.0 || uvw.y <= 0.0 || uvw.y >= 1.0) { return 0.0; }
  float sum = 0.0;
  for (int i = 0; i < 4; i += 1) {
    vec2 off = (vec2(float(i & 1), float(i >> 1)) - 0.5) * uShadow.w;
    sum += uvw.z - uShadow.y > texture(uShadowMap, uvw.xy + off).r ? 0.25 : 0.0;
  }
  return sum;
}

void main() {
  vec2 pixel = floor(gl_FragCoord.xy) + uPan;
  float dither = bayer(pixel);
  if (uObject.w > 0.5 && mod(pixel.x + pixel.y, 2.0) < 0.5) { discard; }

  int flags = int(vTone.z + 0.5);
  float ramp = vTone.x;
  float base = vTone.y;
  float part = vTone.w;

  if (ramp > 254.0) {
    vec2 cell = (vWorld.xz - uBoardMap.xy) * uBoardMap.z;
    vec4 texel = texelFetch(uBoard, ivec2(floor(cell)), 0) * 255.0;
    if (abs(texel.a - base) > 0.5) { discard; }
    ramp = texel.r;
    base = texel.g;
    flags = int(texel.b + 0.5);
  }
  if (ramp > 30.5 || uObject.y > 0.5) { ramp = uObject.x; }

  bool unlit = (flags & UNLIT) != 0;
  bool floor_ = (flags & FLOOR) != 0;
  bool ground = floor_ || (flags & SOFT) != 0;
  vec3 normal = normalize(vNormal);
  float offset = 0.0;
  bool inked = false;

  if (!unlit) {
    float facing = dot(normal, uSun.xyz);
    // A face square to the sun gains a step; one turned away loses up to uSun.w.
    offset = facing > 0.55 ? (facing - 0.55) / 0.45 : -uSun.w * (0.55 - facing) / 1.1;
    // A face that barely catches the sun is left to its own shading: the map is too coarse to say.
    float shade = facing > 0.15 ? shadowAt(vWorld, normal) : 0.0;
    if (floor_) {
      // The board: a clean checker.
      inked = dither < shade * 0.5;
    } else if (ground) {
      // The desk: big shadows go down the ramp, with a dithered edge.
      offset -= shade * 2.0;
    } else {
      offset -= shade * 1.6;
      // Walls darken towards the ground they stand on.
      offset += clamp(vWorld.y * 0.22, -0.6, 0.5) * (1.0 - abs(normal.y));
    }
  }

  if (ground && (flags & FLAT) == 0) {
    float wash = floor_ ? 0.6 : 0.9;
    offset += (cloud(vWorld.xz * 0.07) + cloud(vWorld.xz * 0.19 + 7.3) - 1.0) * wash;
  }
  if (!floor_ && ground) {
    // The desk: a seam every so often and a tint a plank.
    float row = floor(vWorld.z / 9.0);
    float along = vWorld.x + row * 17.3;
    float plank = hash(vec2(row, floor(along / 44.0)));
    if (vWorld.z - row * 9.0 < 0.14 || along - floor(along / 44.0) * 44.0 < 0.14) { base -= 2.0; }
    offset += (plank - 0.5) * 0.8;
  }

  if (floor_) {
    vec2 uv = vWorld.xz / uFloorSpan + 0.5;
    vec2 coat = texture(uPaint, uv).rg;
    int slot = int(coat.r * 255.0 + 0.5);
    if (slot > 0 && slot < 31 && coat.g > dither * 0.5) {
      ramp = uSlotRamp[slot];
      base = coat.g > 0.7 ? 6.0 : 5.0;
      offset = 0.0;
      inked = false;
    } else if (slot == 31 && coat.g > dither * 0.7) {
      base -= 1.0;
    }
    offset += texture(uLight, uv).r * 3.0;
  }

  // Ground blends between tones with a dither band; everything else is flat clusters of tone.
  float low = floor(offset);
  float t = clamp((offset - low - 0.5) / (floor_ ? 0.14 : 0.4) + 0.5, 0.0, 1.0);
  float lift = ground ? low + (dither < t ? 1.0 : 0.0) : floor(offset + 0.5);
  float step_ = clamp(base + lift, 0.0, 7.0);
  float marks = (unlit ? 8.0 : 0.0) + (inked ? 4.0 : 0.0) + (ground ? 2.0 : 0.0)
    + ((flags & NO_OUTLINE) != 0 || uObject.w > 0.5 ? 1.0 : 0.0);

  outTone = vec4(ramp / 255.0, step_ / 255.0, uObject.z / 255.0, part / 255.0);
  outSurface = vec4(normal * 0.5 + 0.5, marks / 255.0);
}
`;

export const DAB_VERTEX = `${COMMON}
in vec2 position;
in vec3 aCenter;
in vec4 aData;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// Target width and height, art pixels per world unit, how much a disc lying flat is squashed.
uniform vec4 uGrid;
// Clip-space depth per world unit along the view.
uniform float uDepthPerUnit;

out vec2 vAt;
flat out vec4 vData;
flat out float vRadius;

void main() {
  int flags = int(aData.w + 0.5);
  vec4 clip = projectionMatrix * viewMatrix * vec4(aCenter, 1.0);
  float radius = max(0.5, floor(aData.x * 0.022 * uGrid.z + 0.5) * 0.5);
  vec2 squash = vec2(1.0, (flags & FLOOR) != 0 ? uGrid.w : 1.0);
  // Odd sizes centre on a pixel, even ones on a corner, so every disc is whole.
  vec2 centre = (clip.xy * 0.5 + 0.5) * uGrid.xy;
  float odd = mod(radius * 2.0, 2.0);
  centre = odd > 0.5 ? floor(centre) + 0.5 : floor(centre + 0.5);
  vAt = position;
  vData = aData;
  vRadius = radius;
  vec2 at = centre + position * radius * squash;
  // A disc lying on the floor runs away from the camera as it runs up the screen.
  float tilt = (flags & FLOOR) != 0 ? position.y * radius / uGrid.z * sqrt(1.0 - uGrid.w * uGrid.w) * uDepthPerUnit : 0.0;
  gl_Position = vec4(at / uGrid.xy * 2.0 - 1.0, clip.z - 0.0005 + tilt, 1.0);
}
`;

export const DAB_FRAGMENT = `${COMMON}
in vec2 vAt;
flat in vec4 vData;
flat in float vRadius;

layout(location = 0) out vec4 outTone;
layout(location = 1) out vec4 outSurface;

void main() {
  float d = length(vAt);
  if (vRadius > 1.2 && d > 1.0) { discard; }
  // A ball of two tones: a darker rim once it is big enough to carry one.
  float step_ = vData.z - (vRadius > 2.6 && d > 0.72 ? 1.0 : 0.0);
  outTone = vec4(vData.y / 255.0, max(step_, 0.0) / 255.0, 0.0, 1.0);
  // A rimmed disc big enough to carry a line is inked like any solid.
  bool rimmed = (int(vData.w + 0.5) & SOFT) != 0 && vRadius > 2.6;
  outSurface = vec4(0.5, 1.0, 0.5, (rimmed ? 8.0 : 9.0) / 255.0);
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
uniform sampler2D uSurface;
uniform sampler2D uDepth;
uniform sampler2D uRamps;
// Near, far, the depth gap that makes an outline, the gap that makes a line between parts.
uniform vec4 uDepthInfo;
uniform vec3 uSun;
// The ramp and step shown where nothing was drawn.
uniform vec2 uVoid;
out vec4 outColor;

const float INK = 8.0;
const float SHADE = 9.0;

float metres(ivec2 p) {
  return uDepthInfo.x + texelFetch(uDepth, p, 0).r * (uDepthInfo.y - uDepthInfo.x);
}

vec3 colour(float ramp, float column) {
  return texelFetch(uRamps, ivec2(int(column + 0.5), int(ramp + 0.5)), 0).rgb;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uTones, 0);
  vec4 here = texelFetch(uTones, p, 0);
  if (here.a * 255.0 < 0.5) {
    outColor = vec4(colour(uVoid.x, uVoid.y), 1.0);
    return;
  }

  vec4 surface = texelFetch(uSurface, p, 0);
  float ramp = floor(here.r * 255.0 + 0.5);
  float step_ = floor(here.g * 255.0 + 0.5);
  vec2 id = floor(here.ba * 255.0 + 0.5);
  int marks = int(surface.a * 255.0 + 0.5);
  bool plain = (marks & 1) != 0;
  bool floor_ = (marks & 2) != 0;
  bool shaded = (marks & 4) != 0;
  bool unlit = (marks & 8) != 0;
  vec3 normal = surface.xyz * 2.0 - 1.0;
  float depth = metres(p);
  float lit = dot(normal, uSun);

  float line = 0.0;
  bool rim = false;
  ivec2 around[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int i = 0; i < 4; i += 1) {
    ivec2 q = clamp(p + around[i], ivec2(0), size - 1);
    vec4 there = texelFetch(uTones, q, 0);
    if (there.a * 255.0 < 0.5) { line = 2.0; continue; }
    vec4 other = texelFetch(uSurface, q, 0);
    int theirs = int(other.a * 255.0 + 0.5);
    if ((theirs & 1) != 0) { continue; }
    float gap = metres(q) - depth;
    bool same = floor(there.ba * 255.0 + 0.5) == id;
    bool flatSeam = floor_ && (theirs & 2) != 0;
    if (!same && gap > uDepthInfo.z) {
      line = 2.0;
    } else if (!same && !floor_ && (theirs & 2) != 0 && gap > -uDepthInfo.z) {
      line = 2.0;
    } else if (!same && !flatSeam && gap > uDepthInfo.w) {
      line = max(line, 1.0);
    } else if (abs(gap) < uDepthInfo.z) {
      vec3 theirNormal = other.xyz * 2.0 - 1.0;
      if (dot(normal, theirNormal) < 0.8 && lit > dot(theirNormal, uSun) + 0.05) { rim = true; }
    }
  }

  float column = step_;
  if (plain) {
    column = step_;
  } else if (line > 1.5) {
    column = INK;
  } else if (line > 0.5) {
    column = max(step_ - 2.0, 0.0);
  } else if (shaded) {
    column = SHADE;
  } else if (rim && !unlit) {
    column = min(step_ + 1.0, 7.0);
  }

  outColor = vec4(colour(ramp, column), 1.0);
}
`;
