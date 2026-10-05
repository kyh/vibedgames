import { z } from "zod";

import { publicBase } from "../base";
import { notMcpTool } from "../mcp";
import { documented } from "../openapi";
import { joinWaitlistInput } from "./waitlist-schema";

const waitlistEntry = z.object({
  email: z.string().nullable(),
  id: z.string(),
  source: z.string().nullable(),
  userId: z.string().nullable(),
});

export const waitlistContract = {
  join: publicBase
    .meta(notMcpTool("The public waitlist form."))
    .meta(
      documented({
        description:
          "Adds an email address to the waitlist. Public; attaches the signed-in user when a session is present.",
        summary: "Join the waitlist",
      }),
    )
    .input(joinWaitlistInput)
    .output(z.object({ waitlist: waitlistEntry.optional() })),
};
