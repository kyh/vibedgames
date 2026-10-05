import { z } from "zod";

import { jsonValueSchema } from "../json";

// A `.` or `..` segment, spelled literally or as `%2e`, which the URL parser
// collapses.
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu;

// The one spelling of a queue path fal routes as written. It percent-decodes
// a path and finds an application whatever its case, while the ledger
// classifies and prices the path as sent: `/fal-ai/fl%75x/dev` runs
// `fal-ai/flux` priced as an endpoint no price list names, and
// `/fal-ai/flux/%72equests/<id>` fetches a result the ledger never settles.
// The other delimiters a path may hold (`;`, `,`, `:`, `@`, ...) are refused
// with them rather than trusted to reach fal unread. Nothing real needs any of
// it: every segment of every id in fal's public catalog matches
// `[a-z0-9._~-]`, and request ids are lowercase UUIDs.
const CANONICAL_QUEUE_PATH = /^\/[a-z0-9._~/-]*$/u;

export const forwardInput = z
  .object({
    body: z.unknown().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    // Must be a server-relative path. Empty bodies and trailing-only paths
    // are fine. We refuse anything that doesn't start with `/` so a caller
    // can't smuggle a full URL (which would change the host), and anything the
    // upstream URL (`new URL(base + path)`) would carry differently, so the path
    // the credit classifier sees is exactly the path the upstream URL gets. The
    // URL parser turns `\` into `/`, drops tabs, newlines and a trailing space,
    // collapses dot segments and percent-encodes what a path can't hold raw: so
    // `/owner\model` (or a `?`/`#`) would otherwise let a queue submit reach fal
    // while classifying (and billing) as nothing, and a `.` segment or a tab
    // would have the ledger price an endpoint other than the one fal runs. Only
    // characters the parser leaves alone are accepted; percent-encode the rest.
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(
        /^\/[\w.~!$&'()*+,;=:@%/-]*$/u,
        "path must start with `/` and hold only letters, digits and `-._~!$&'()*+,;=:@%/` (percent-encode anything else)",
      )
      .refine((path) => !DOT_SEGMENT.test(path), "path may not contain `.` or `..` segments"),
    query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    target: z.enum(["queue", "platform", "storage", "docs"]),
  })
  // A queue path is the one the ledger reads, so it must be the one fal
  // routes, byte for byte. Other targets keep percent-encoding and case.
  .refine((input) => input.target !== "queue" || CANONICAL_QUEUE_PATH.test(input.path), {
    message:
      "a queue path may hold only lowercase letters, digits and `-._~/`: spell the endpoint id as `vg generate models` lists it and the request id as the submit returned it",
    path: ["path"],
  });

// ---- The typed procedures ----------------------------------------------------
//
// The server builds each provider request from the ids below, and a queue path
// from an endpoint id and a request id, so an id is held to what
// `forwardInput` accepts of a queue path: lowercase letters, digits and
// `-._~`, and no dot segment for the URL parser to collapse. Every valid typed
// call then builds a canonical queue path, and the path a submit is priced and
// held under is, byte for byte, the path fal runs.

const endpointIdSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(
    /^\/*[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)+\/*$/u,
    "endpointId must be owner/model[/subpath] in lowercase letters, digits and `-._~`, spelled as the model search lists it",
  )
  .refine((id) => !DOT_SEGMENT.test(id), "endpointId may not contain `.` or `..` segments")
  .describe("Model endpoint id, e.g. fal-ai/flux/dev.");

const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9_-]+$/u,
    "requestId must be the request id generate.submit returned: lowercase letters, digits, `-` and `_`",
  )
  .describe("The request_id returned by generate.submit.");

/** One queued job: `generate.result` and `generate.cancel`. */
export const jobInput = z.object({ endpointId: endpointIdSchema, requestId: requestIdSchema });

export const statusInput = jobInput.extend({
  logs: z.boolean().default(false).describe("Include model logs."),
});

export const submitInput = z.object({
  endpointId: endpointIdSchema,
  input: z
    .record(z.string(), jsonValueSchema)
    .describe("The model's input, as described by generate.schema."),
});

export const modelsInput = z.object({
  category: z.string().max(64).optional().describe("Filter by category, e.g. text-to-image."),
  cursor: z.string().max(512).optional().describe("Pagination cursor from a prior response."),
  endpointIds: z
    .array(endpointIdSchema)
    .max(50)
    .optional()
    .describe("Look up specific endpoint ids."),
  expand: z
    .array(z.enum(["openapi-3.0", "enterprise_status"]))
    .optional()
    .describe("Extra fields to include."),
  limit: z.number().int().min(1).max(100).default(20),
  query: z.string().max(200).optional().describe("Free-text search."),
  status: z.enum(["active", "deprecated", "all"]).default("active"),
});

export const pricingInput = z.object({ endpointId: endpointIdSchema });

export const schemaInput = z.object({
  endpointId: endpointIdSchema,
  format: z.enum(["compact", "openapi"]).default("compact"),
});

export const docsInput = z.object({
  query: z.string().min(1).max(500).describe("What to look up."),
});

export const uploadSlotInput = z.object({
  contentType: z.string().min(1).max(127),
  fileName: z.string().min(1).max(255),
});
