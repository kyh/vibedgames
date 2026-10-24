import { protectedBase } from "../base";
import { jsonValueSchema } from "../json";
import { documented } from "../openapi";
import { z } from "zod";

import { forwardInput, uploadInput } from "./generate-schema";

export const generateContract = {
  forward: protectedBase
    .meta(
      documented({
        description:
          "Forwards one request to the fal media-generation API with the server's key: `target` picks the host (queue, platform, storage, docs), `path`/`query`/`body` the rest; a queue path holds only lowercase letters, digits and `-._~/`, so the endpoint billed is the one fal runs. Returns the upstream JSON body. Queue submits are billed on the result fetch, and need a positive credit balance (403 `insufficient_credits` otherwise) and an endpoint with a published price (400 `unknown_endpoint` otherwise) unless the caller is an admin, whose submits are billed but never refused. Backs `vg generate`.",
        errors: [403, 412, 413, 502],
        summary: "Proxy a media-generation request",
      }),
    )
    .input(forwardInput)
    .output(jsonValueSchema.describe("The upstream response body, or null when it had none.")),

  upload: protectedBase
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
