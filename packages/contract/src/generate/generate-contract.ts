import { protectedBase, requiresScope } from "../base";
import { jsonValueSchema } from "../json";
import { documented } from "../openapi";
import { z } from "zod";

import {
  docsInput,
  forwardInput,
  modelsInput,
  pricingInput,
  runInput,
  schemaInput,
  statusInput,
  uploadInput,
} from "./generate-schema";

const upstreamJson = jsonValueSchema.describe(
  "The upstream response body, or null when it had none.",
);

export const generateContract = {
  forward: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Forwards one request to the fal media-generation API with the server's key: `target` picks the host (queue, platform, storage, docs), `path`/`query`/`body` the rest; a queue path holds only lowercase letters, digits and `-._~/`, so the endpoint billed is the one fal runs. Returns the upstream JSON body. The typed generate procedures (run, status, models, schema, pricing, docs) are built on it and are the way in; forward stays for raw hops they do not cover. Queue submits are billed on the result fetch, and need a positive credit balance (403 `insufficient_credits` otherwise) and an endpoint with a published price (400 `unknown_endpoint` otherwise) unless the caller is an admin, whose submits are billed but never refused.",
        errors: [403, 412, 413, 502],
        summary: "Proxy a media-generation request",
      }),
    )
    .input(forwardInput)
    .output(upstreamJson),

  docs: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Searches the model documentation: how a model is prompted, what its inputs mean, which to pick for a task. Backs `vg generate docs`.",
        errors: [412, 502],
        summary: "Search model docs",
      }),
    )
    .input(docsInput)
    .output(upstreamJson),

  models: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Searches the models generate can run, by what they do (`query`), by category or by id, with a cursor for the next page. Backs `vg generate models`.",
        errors: [412, 502],
        summary: "Search models",
      }),
    )
    .input(modelsInput)
    .output(upstreamJson),

  pricing: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "A model's price per unit, which generate bills against your credits. Backs `vg generate pricing`.",
        errors: [412, 502],
        summary: "Model pricing",
      }),
    )
    .input(pricingInput)
    .output(upstreamJson),

  run: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Runs a model to generate an image, video, audio clip, 3D model or text, billed against your credits. Waits up to `wait_seconds` for the output; a job still running by then returns its `request_id` and status, to follow with generate.status. Needs a positive credit balance (403 `insufficient_credits`) and a priced model (400 `unknown_endpoint`) unless the caller is an admin. Backs `vg generate run`.",
        errors: [403, 412, 413, 502],
        summary: "Run a model",
      }),
    )
    .input(runInput)
    .output(
      z.object({
        endpoint_id: z.string(),
        request_id: z.string(),
        result: jsonValueSchema.describe("The model's output once COMPLETED, else null."),
        status: z
          .string()
          .describe("`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED` or `CANCELLED`"),
      }),
    ),

  schema: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "A model's input and output schema: what generate.run's `input` takes. `openapi` gives the full OpenAPI document. Backs `vg generate schema`.",
        errors: [412, 502],
        summary: "Model schema",
      }),
    )
    .input(schemaInput)
    .output(upstreamJson),

  status: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Follows a generate job: its status (`status`), its output once COMPLETED (`result`, which settles the bill), or `cancel`, which waits briefly for the queue to settle the job so its hold is refunded. Backs `vg generate status`.",
        errors: [412, 502],
        summary: "Follow a generation",
      }),
    )
    .input(statusInput)
    .output(upstreamJson),

  upload: protectedBase
    .meta(requiresScope("generate"))
    .meta(
      documented({
        description:
          "Opens an upload slot for a model input (a reference image, an audio clip to transform). PUT the bytes to `uploadUrl`, a 15-minute signed URL on this server, with the `headers` given; the server streams them on to generate's storage. Then pass `fileUrl` to the model. Backs `vg generate upload`.",
        errors: [412, 502],
        summary: "Upload a model input",
      }),
    )
    .input(uploadInput)
    .output(
      z.object({
        fileUrl: z.string(),
        headers: z.object({ "content-type": z.string() }),
        uploadUrl: z.string(),
      }),
    ),
};
