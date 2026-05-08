// Inputs are uploaded to R2 first; the tRPC body only carries refs and params.
// Outputs (fal CDN URLs) are returned to the caller without proxying bytes,
// so the old MAX_OUTPUT_IMAGE_BYTES boundary doesn't apply here.

export const MAX_INPUT_FILES = 8;
export const MAX_INPUT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_INPUT_TOTAL_BYTES = 100 * 1024 * 1024;

export const MAX_PARAMS_BYTES = 1 * 1024 * 1024;
export const MAX_TRPC_BODY_BYTES = 4 * 1024 * 1024;

// Bound replies from fal's platform/queue APIs. fal model schemas in
// OpenAPI form can be sizable; pricing/models pages are smaller.
export const MAX_FAL_PLATFORM_JSON_BYTES = 8 * 1024 * 1024;
