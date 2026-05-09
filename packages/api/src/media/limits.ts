// The forward proc caps request bodies before forwarding to fal, and the
// trpc.$ route handler caps the overall request before tRPC even sees it.
// Input file bytes never transit the worker — clients PUT directly to a
// fal-issued presigned URL — so there's no per-file cap to enforce here.

export const MAX_PARAMS_BYTES = 1 * 1024 * 1024;
export const MAX_TRPC_BODY_BYTES = 4 * 1024 * 1024;

// Bound replies from fal's platform/queue APIs. fal model schemas in
// OpenAPI form can be sizable; pricing/models pages are smaller.
export const MAX_FAL_PLATFORM_JSON_BYTES = 8 * 1024 * 1024;
