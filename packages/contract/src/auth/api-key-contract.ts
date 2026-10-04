import { z } from "zod";

import { sessionOnlyBase } from "../base";
import { documented } from "../openapi";
import { createApiKeyInput, revokeApiKeyInput } from "./api-key-schema";

const apiKeySummary = z.object({
  createdAt: z.date(),
  expiresAt: z.date().nullable(),
  id: z.string(),
  keyPrefix: z.string(),
  name: z.string().nullable(),
});

export const apiKeyContract = {
  create: sessionOnlyBase
    .meta(
      documented({
        description:
          "Mints an API key (`vg_…`) for CI and headless agents. The raw `key` is returned only in this response. Needs a real session; an API key cannot mint keys.",
        summary: "Create an API key",
      }),
    )
    .input(createApiKeyInput)
    .output(apiKeySummary.extend({ key: z.string() })),

  list: sessionOnlyBase
    .meta(
      documented({
        description:
          "Lists the caller's API keys by prefix, never the raw key. Needs a real session.",
        summary: "List API keys",
      }),
    )
    .output(z.object({ keys: z.array(apiKeySummary.extend({ lastUsedAt: z.date().nullable() })) })),

  revoke: sessionOnlyBase
    .meta(
      documented({
        description: "Deletes one of the caller's API keys. Needs a real session.",
        errors: [404],
        summary: "Revoke an API key",
      }),
    )
    .input(revokeApiKeyInput)
    .output(z.object({ id: z.string() })),
};
