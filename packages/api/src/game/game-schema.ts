import { z } from "zod";

export const listBuildsInput = z.object({
  limit: z.number().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

export const getBuildInput = z.object({
  buildId: z.string().min(1, "buildId is required"),
});
