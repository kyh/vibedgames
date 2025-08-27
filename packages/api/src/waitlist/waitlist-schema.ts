import type z from "zod";
import { waitlist } from "@repo/db/drizzle-schema";
import { createInsertSchema } from "drizzle-zod";

export const joinWaitlistInput = createInsertSchema(waitlist);

export type JoinWaitlistInput = z.infer<typeof joinWaitlistInput>;
