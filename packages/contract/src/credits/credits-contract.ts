import { z } from "zod";

import { protectedBase } from "../base";
import { mcpTool } from "../mcp";
import { documented } from "../openapi";

const creditEntry = z.object({
  createdAt: z.date(),
  deltaMicro: z.number().int().describe("Signed micro-USD: positive is a grant or refund."),
  endpointId: z.string().nullable(),
  id: z.string(),
  kind: z.enum([
    "signup_grant",
    "admin_grant",
    "generation_hold",
    "generation_settle",
    "generation_release",
  ]),
  note: z.string().nullable(),
  requestId: z.string().nullable(),
});

export const creditsContract = {
  me: protectedBase
    .meta(mcpTool({ access: "read", name: "credits", title: "Credit balance" }))
    .meta(
      documented({
        description:
          "Returns the caller's generation credit balance in micro-USD (1,000,000 = $1) and their 100 most recent ledger entries.",
        summary: "Get your credit balance",
      }),
    )
    .output(z.object({ balanceMicro: z.number().int(), entries: z.array(creditEntry) })),
};
