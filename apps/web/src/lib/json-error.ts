/**
 * The error body oRPC itself sends (`code`, `message`, `defined`), so a caller
 * parses one shape whether the refusal came from a route boundary or from a
 * procedure. `defined: false` because no procedure declared it.
 */
export const jsonError = (status: number, code: string, message: string): Response =>
  Response.json({ code, defined: false, message }, { status });

/** Any `/api/*` path no route claims. */
export const apiNotFound = (): Response =>
  jsonError(404, "NOT_FOUND", "No API route at this path. The API is described at /openapi.json.");
