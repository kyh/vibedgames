export const REINHARD_CLIP = 0.13;

export const REINHARD_GLSL = `
vec3 reinhardClip(vec3 c) {
  return c / (1.0 + max(c.r, max(c.g, c.b)) * ${REINHARD_CLIP});
}
`;
