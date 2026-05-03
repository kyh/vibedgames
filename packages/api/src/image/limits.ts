export const MAX_INPUT_IMAGES = 4;
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_IMAGE_BYTES = 25 * 1024 * 1024;

// `params` should carry knobs, not image payloads. Input images now travel as
// presigned R2 upload refs, so keep tRPC JSON bodies small enough for Workers.
export const MAX_PARAMS_BYTES = 1 * 1024 * 1024;
export const MAX_TRPC_BODY_BYTES = 4 * 1024 * 1024;

// Base64 expands by ~4/3. Leave metadata headroom while bounding provider JSON.
export const MAX_PROVIDER_JSON_BYTES =
  Math.ceil((MAX_OUTPUT_IMAGE_BYTES * 4) / 3) + 1024 * 1024;
