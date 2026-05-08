// Input bytes never transit the worker — clients PUT directly to a
// fal-issued presigned URL. The server's only role is provisioning that
// URL, so the cap below is a sanity guard on the metadata before we
// hand out an upload slot.
export const MAX_INPUT_FILE_BYTES = 100 * 1024 * 1024;

export const MAX_PARAMS_BYTES = 1 * 1024 * 1024;
export const MAX_TRPC_BODY_BYTES = 4 * 1024 * 1024;

// Bound replies from fal's platform/queue APIs. fal model schemas in
// OpenAPI form can be sizable; pricing/models pages are smaller.
export const MAX_FAL_PLATFORM_JSON_BYTES = 8 * 1024 * 1024;
