import type { OpenAPIV3_2 } from "@orpc/openapi";
import { openapi } from "@orpc/openapi";

/**
 * OpenAPI description shared by every procedure: the error body, the
 * credentials @repo/service's `createORPCContext` accepts, and the
 * per-procedure summary.
 * `apps/web` feeds `openAPIComponents` into the generator's base document, so
 * the `$ref`s below always resolve.
 */

const ERROR_SCHEMA_REF = "#/components/schemas/Error";

const ERROR_DESCRIPTIONS = {
  400: "The input failed validation or the request cannot be carried out as sent.",
  401: "No valid session cookie, bearer token or API key.",
  403: "The caller is authenticated but may not perform this action.",
  404: "The referenced resource does not exist.",
  409: "The request conflicts with existing state.",
  412: "A server-side dependency this procedure needs is not configured.",
  413: "The request body or a field in it is over its size limit.",
  429: "Rate limited; retry with backoff.",
  500: "Unexpected server error.",
  502: "An upstream provider failed or returned an unusable response.",
} as const;

type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

// The generator builds 3.2 and downgrades to the version apps/web asks for.
type Components = OpenAPIV3_2.ComponentsObject;
type OperationObject = OpenAPIV3_2.OperationObject;

const securitySchemes = {
  apiKeyHeader: {
    description: "An API key (`vg_…`) created with apiKeys.create or in the web app settings.",
    in: "header",
    name: "x-api-key",
    type: "apiKey",
  },
  bearerAuth: {
    description:
      "A session token from `vg login` (device-code flow), or an API key (`vg_…`). This is what `VG_TOKEN` holds.",
    scheme: "bearer",
    type: "http",
  },
  sessionCookie: {
    description: "better-auth session cookie, set by signing in at /auth/login.",
    in: "cookie",
    name: "__Secure-better-auth.session_token",
    type: "apiKey",
  },
} satisfies Components["securitySchemes"];

type SecurityScheme = keyof typeof securitySchemes;

export const openAPIComponents: Components = {
  schemas: {
    Error: {
      description:
        "Every non-2xx response. `code` is the stable, machine-readable part (e.g. UNAUTHORIZED, BAD_REQUEST); `message` is for humans.",
      properties: {
        code: { type: "string" },
        data: { description: "Code-specific detail, e.g. validation issues for BAD_REQUEST." },
        defined: { type: "boolean" },
        message: { type: "string" },
      },
      required: ["code", "message"],
      type: "object",
    },
  },
  securitySchemes,
};

const withErrors =
  (statuses: readonly ErrorStatus[]) =>
  (operation: OperationObject): OperationObject => ({
    ...operation,
    responses: {
      ...operation.responses,
      ...Object.fromEntries(
        statuses.map((status) => [
          status,
          {
            content: { "application/json": { schema: { $ref: ERROR_SCHEMA_REF } } },
            description: ERROR_DESCRIPTIONS[status],
          },
        ]),
      ),
    },
  });

const withSecurity =
  (schemes: readonly SecurityScheme[]) =>
  (operation: OperationObject): OperationObject => ({
    ...operation,
    security: schemes.map((scheme) => ({ [scheme]: [] })),
  });

/** Errors any procedure can answer with, before its own logic runs. */
export const publicProcedureSpec = openapi({ spec: withErrors([400, 500]) });

/** `protectedBase`: any of the three credentials. */
export const protectedProcedureSpec = openapi({
  spec: (operation) =>
    withErrors([401])(withSecurity(["sessionCookie", "bearerAuth", "apiKeyHeader"])(operation)),
});

/** `sessionOnlyBase` and up: a real session; an API key is refused with 403. */
export const sessionOnlyProcedureSpec = openapi({
  spec: (operation) => withErrors([403])(withSecurity(["sessionCookie", "bearerAuth"])(operation)),
});

interface ProcedureDoc {
  summary: string;
  description: string;
  /** Statuses this procedure answers beyond the ones its base procedure documents. */
  errors?: readonly ErrorStatus[];
}

export const documented = ({ summary, description, errors = [] }: ProcedureDoc) =>
  openapi({ description, spec: withErrors(errors), summary });
