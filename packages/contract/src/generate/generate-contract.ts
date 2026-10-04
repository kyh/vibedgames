import { protectedBase } from "../base";
import { jsonValueSchema } from "../json";
import { documented } from "../openapi";
import { forwardInput } from "./generate-schema";

export const generateContract = {
  forward: protectedBase
    .meta(
      documented({
        description:
          "Forwards one request to the fal media-generation API with the server's key: `target` picks the host (queue, platform, storage, docs), `path`/`query`/`body` the rest. Returns the upstream JSON body. Queue submits need a positive credit balance (403 `insufficient_credits` otherwise) and are billed on the result fetch. Backs `vg generate`.",
        errors: [403, 412, 413, 429, 502],
        summary: "Proxy a media-generation request",
      }),
    )
    .input(forwardInput)
    .output(jsonValueSchema.describe("The upstream response body, or null when it had none.")),
};
