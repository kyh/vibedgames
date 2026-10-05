import { z } from "zod";

import { protectedBase } from "../base";
import { jsonValueSchema } from "../json";
import { notMcpTool } from "../mcp";
import { documented } from "../openapi";
import { decideInput } from "./playtest-schema";

export const playtestContract = {
  decide: protectedBase
    .meta(notMcpTool("Called by the in-page playtest agent, not by a model."))
    .meta(
      documented({
        description:
          "Asks the decision model typed questions (yes/no, choice, score) about a JSON game state and returns its answers verbatim. Backs `vg playtest run`.",
        errors: [412, 413, 429, 502],
        summary: "Ask the playtest decision model",
      }),
    )
    .input(decideInput)
    .output(
      jsonValueSchema.describe("The decision model's reply; `answers` is keyed by question label."),
    ),

  session: protectedBase
    .meta(notMcpTool("Mints a token for a local `vg playtest run` browser session."))
    .meta(
      documented({
        description:
          "Mints a short-lived token, bound to the caller, that an in-page playtester presents to /api/playtest/decide. It grants nothing else.",
        errors: [412],
        summary: "Mint a playtest token",
      }),
    )
    .output(
      z.object({
        expiresAt: z.number().int().describe("Unix epoch milliseconds."),
        token: z.string(),
      }),
    ),
};
