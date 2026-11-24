import { z } from "zod";

const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu;

const CANONICAL_QUEUE_PATH = /^\/[a-z0-9._~/-]*$/u;

export const forwardInput = z
  .object({
    body: z.unknown().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
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
  .refine((input) => input.target !== "queue" || CANONICAL_QUEUE_PATH.test(input.path), {
    message:
      "a queue path may hold only lowercase letters, digits and `-._~/`: spell the endpoint id as `vg generate models` lists it and the request id as the submit returned it",
    path: ["path"],
  });

/** A model input to upload: what its storage slot is opened for. */
export const uploadInput = z.object({
  contentType: z
    .string()
    .min(1)
    .max(127)
    .describe("The file's MIME type, e.g. `image/png`; PUT the bytes with this Content-Type"),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .describe("The file's name with its extension, e.g. `hero.png`, up to 255 characters"),
});

/** The longest a call may wait on a job server-side; a longer wait polls `generate.status`. */
export const MAX_WAIT_SECONDS = 25;

const endpointId = z
  .string()
  .min(1)
  .max(256)
  .describe("A model's endpoint id, as generate models lists it, e.g. `fal-ai/flux/dev`");

const requestId = z
  .string()
  .min(1)
  .max(128)
  .describe("The job's `request_id`, as generate returned it, with the endpoint_id it ran on");

/** A model to run, and how long to wait for its output before returning the request id. */
export const runInput = z.object({
  endpoint_id: endpointId,
  input: z.record(z.string(), z.json()).describe("The model's input, per generate schema"),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .default(20)
    .describe("How long to wait for the result before returning the request id"),
});

/** A queued job to follow: its status, its output, or a cancel. */
export const statusInput = z.object({
  action: z
    .enum(["status", "result", "cancel"])
    .default("status")
    .describe(
      "`status` (the default) reports where the job is; `result` fetches its output once COMPLETED, which settles the bill; `cancel` stops a job that is still queued or running",
    ),
  endpoint_id: endpointId,
  logs: z.boolean().default(false).describe("Include the job's logs with its status"),
  request_id: requestId,
});

/** A search of the models generate can run. */
export const modelsInput = z.object({
  category: z
    .string()
    .max(128)
    .optional()
    .describe("Only models in this category, e.g. `text-to-image`, `image-to-video`"),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe(
      "The `next_cursor` of a previous result, for the page after it; omit for the first page",
    ),
  endpoint_id: z
    .array(z.string().min(1).max(256))
    .max(50)
    .optional()
    .describe("Endpoint ids to look up directly instead of searching, e.g. `fal-ai/flux/dev`"),
  expand: z
    .array(z.enum(["openapi-3.0", "enterprise_status"]))
    .optional()
    .describe("Extra fields to include per model: `openapi-3.0`, `enterprise_status`"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("How many models to return per page, 1 to 100; default 20"),
  query: z.string().max(500).optional().describe("Free text, e.g. `pixel art sprite`"),
  status: z
    .enum(["active", "deprecated", "all"])
    .optional()
    .describe("`deprecated` or `all` to include models past their prime; omit for active models"),
});

/** One model's catalog entry, optionally with its full OpenAPI document. */
export const schemaInput = z.object({
  endpoint_id: endpointId,
  format: z
    .enum(["compact", "openapi"])
    .default("compact")
    .describe(
      "`compact` (the default) returns the model's catalog entry; `openapi` adds its full OpenAPI 3.0 document, with every input and output field",
    ),
});

/** One model's price. */
export const pricingInput = z.object({ endpoint_id: endpointId });

/** A search of the model documentation. */
export const docsInput = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "What to look up, in plain words and up to 500 characters, e.g. `how to prompt seedance camera moves`",
    ),
});
