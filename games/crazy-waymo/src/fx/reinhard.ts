// Max-channel chroma-preserving Reinhard shoulder for additive FX shaders.
// Dividing by the max channel (not luminance) means stacked additive quads
// asymptote toward their own hue instead of washing to white — the kart-racer
// "saturated glow" identity. Apply as the LAST op before writing gl_FragColor
// in any additive material; pre-shoulder intensities are then free to sit at
// 2-3.5 so they clear the day bloom gate.
export const REINHARD_CLIP = 0.13;

export const REINHARD_GLSL = /* glsl */ `
vec3 reinhardClip(vec3 c) {
  return c / (1.0 + max(c.r, max(c.g, c.b)) * ${REINHARD_CLIP});
}
`;
